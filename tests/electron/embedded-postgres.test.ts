import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import {
  EmbeddedPostgresController,
  EmbeddedPostgresHealthMonitor,
} from '../../electron-client/embedded-postgres'
import { findFreePort } from '../../electron-client/local-port'

const temporaryRoots: string[] = []
const activeControllers = new Set<EmbeddedPostgresController>()
const execFileAsync = promisify(execFile)

afterAll(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...activeControllers].map(controller => controller.stop().catch(() => {})))
  activeControllers.clear()
})

describe('RED-170 embedded PostgreSQL health monitor', () => {
  it('monitors the PostgreSQL owner without spawning runtime readiness probes', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../electron-client/embedded-postgres.ts'), 'utf8')
    const monitorSource = source.slice(
      source.indexOf('private startHealthMonitor()'),
      source.indexOf('async stop()'),
    )
    expect(source).toContain('const HEALTH_PROBE_INTERVAL_MS = 2_000')
    expect(source).toContain('const INITIALIZATION_TIMEOUT_MS = 90_000')
    expect(source).toContain('], this.commandEnv(), INITIALIZATION_TIMEOUT_MS)')
    expect(monitorSource).toContain('intervalMs: HEALTH_PROBE_INTERVAL_MS')
    expect(monitorSource).toContain('failureThreshold: 1')
    expect(monitorSource).toContain('await this.queryPostgresProcessRunning()')
    expect(monitorSource).toContain('process.kill(pid, 0)')
    expect(monitorSource).not.toContain("this.executable('pg_isready')")
  })

  it('runs probes single-flight and tolerates two transient failures', async () => {
    vi.useFakeTimers()
    let activeProbes = 0
    let maximumConcurrentProbes = 0
    let probeAttempts = 0
    let confirmedLosses = 0
    const states: string[] = []
    const monitor = new EmbeddedPostgresHealthMonitor({
      intervalMs: 10,
      failureThreshold: 3,
      probe: async () => {
        probeAttempts += 1
        activeProbes += 1
        maximumConcurrentProbes = Math.max(maximumConcurrentProbes, activeProbes)
        await new Promise(resolve => setTimeout(resolve, 50))
        activeProbes -= 1
        if (probeAttempts <= 2) throw new Error('transient pg_isready timeout')
      },
      confirmProcessRunning: async () => true,
      onStateChange: state => states.push(state.state),
      onConfirmedLoss: () => { confirmedLosses += 1 },
    })

    monitor.start()
    await vi.advanceTimersByTimeAsync(220)

    expect(probeAttempts).toBeGreaterThanOrEqual(3)
    expect(maximumConcurrentProbes).toBe(1)
    expect(confirmedLosses).toBe(0)
    expect(states).toContain('degraded')
    expect(states).toContain('healthy')
    monitor.stop()
  })

  it('reports one loss only after sustained readiness failures and a failed process check', async () => {
    vi.useFakeTimers()
    let confirmedLosses = 0
    let processChecks = 0
    let probeAttempts = 0
    const monitor = new EmbeddedPostgresHealthMonitor({
      intervalMs: 10,
      failureThreshold: 3,
      probe: async () => {
        probeAttempts += 1
        throw new Error('database unavailable')
      },
      confirmProcessRunning: async () => {
        processChecks += 1
        return false
      },
      onConfirmedLoss: () => { confirmedLosses += 1 },
    })

    monitor.start()
    await vi.advanceTimersByTimeAsync(200)

    expect(probeAttempts).toBe(3)
    expect(processChecks).toBe(1)
    expect(confirmedLosses).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(confirmedLosses).toBe(1)
  })
})

describe.skipIf(process.platform !== 'win32')('RED-161 embedded PostgreSQL LAN authority', () => {
  it('initializes once, enforces loopback/SCRAM, persists, and detects a database crash', async () => {
    const projectRoot = path.resolve(__dirname, '../..')
    const runtimeRoot = path.join(projectRoot, '_client-postgres', 'pgsql')
    expect(fs.existsSync(path.join(runtimeRoot, 'bin', 'postgres.exe'))).toBe(true)
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-embedded-pg-'))
    temporaryRoots.push(stateRoot)
    let reportUnexpectedExit: (() => void) | null = null
    const unexpectedExit = new Promise<void>(resolve => { reportUnexpectedExit = resolve })
    const controller = new EmbeddedPostgresController({
      runtimeRoot,
      stateRoot,
      findFreePort,
      portHint: 38721,
      // Electron production supplies safeStorage. The integration test uses a
      // deterministic reversible adapter so it can run under plain Node/Vitest.
      protectSecret: plaintext => Buffer.from(plaintext, 'utf8'),
      unprotectSecret: encrypted => encrypted.toString('utf8'),
      onUnexpectedExit: () => reportUnexpectedExit?.(),
    })
    activeControllers.add(controller)

    const first = await controller.start()
    expect(first.url).toMatch(/^postgresql:\/\/rvb:[^@]+@127\.0\.0\.1:\d+\/rvb_colyseus\?sslmode=disable$/)
    const firstPool = new Pool({ connectionString: first.url, max: 1 })
    const settings = await firstPool.query<{ listen_addresses: string; password_encryption: string; lc_ctype: string }>(
      `SELECT current_setting('listen_addresses') AS listen_addresses,
              current_setting('password_encryption') AS password_encryption,
              datctype AS lc_ctype
       FROM pg_database WHERE datname = current_database()`,
    )
    expect(settings.rows).toEqual([{
      listen_addresses: '127.0.0.1',
      password_encryption: 'scram-sha-256',
      lc_ctype: 'C',
    }])
    const activeHbaLines = fs.readFileSync(path.join(stateRoot, 'data', 'pg_hba.conf'), 'utf8')
      .split(/\r?\n/)
      .map(line => line.replace(/#.*/, '').trim())
      .filter(Boolean)
    expect(activeHbaLines.some(line => /\btrust\b/i.test(line))).toBe(false)
    expect(activeHbaLines.some(line => /\bscram-sha-256\b/i.test(line))).toBe(true)
    await firstPool.query('CREATE TABLE embedded_restart_probe (id integer PRIMARY KEY, value text NOT NULL)')
    await firstPool.query("INSERT INTO embedded_restart_probe (id, value) VALUES (1, 'persisted')")
    await firstPool.end()
    await new Promise(resolve => setTimeout(resolve, 4_500))
    expect(controller.isRunning).toBe(true)
    await controller.stop()
    expect(controller.isRunning).toBe(false)

    const second = await controller.start()
    const secondPool = new Pool({ connectionString: second.url, max: 1 })
    const restored = await secondPool.query<{ value: string }>('SELECT value FROM embedded_restart_probe WHERE id = 1')
    expect(restored.rows).toEqual([{ value: 'persisted' }])
    await secondPool.end()

    await execFileAsync(path.join(runtimeRoot, 'bin', 'pg_ctl.exe'), [
      'stop', '-D', path.join(stateRoot, 'data'), '-m', 'immediate', '-w', '-t', '5',
    ], { windowsHide: true, timeout: 8_000 })
    await Promise.race([
      unexpectedExit,
      new Promise((_, reject) => setTimeout(() => reject(new Error('database crash was not detected')), 8_000)),
    ])
    expect(controller.isRunning).toBe(false)

    expect(fs.existsSync(path.join(stateRoot, 'data', 'PG_VERSION'))).toBe(true)
    expect(fs.existsSync(path.join(stateRoot, 'credential.bin'))).toBe(true)
    expect(fs.readdirSync(stateRoot).some(entry => entry.startsWith('.init-password-'))).toBe(false)
  }, 180_000)

  it('fails closed before executing binaries when the runtime manifest is not the approved artifact', async () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-invalid-pg-runtime-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-invalid-pg-state-'))
    temporaryRoots.push(packageRoot, stateRoot)
    fs.mkdirSync(path.join(packageRoot, 'pgsql'), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'runtime-manifest.json'), JSON.stringify({
      formatVersion: 1,
      product: 'PostgreSQL',
      version: '16.15-2',
      platform: 'win32-x64',
      sourceUrl: 'https://example.invalid/postgresql.zip',
      archiveSha256: '0'.repeat(64),
      files: [],
    }))
    const controller = new EmbeddedPostgresController({
      runtimeRoot: path.join(packageRoot, 'pgsql'),
      stateRoot,
      findFreePort,
      protectSecret: plaintext => Buffer.from(plaintext, 'utf8'),
      unprotectSecret: encrypted => encrypted.toString('utf8'),
    })

    await expect(controller.start()).rejects.toThrow('runtime manifest SHA-256 mismatch')
    expect(fs.existsSync(path.join(stateRoot, 'credential.bin'))).toBe(false)
  })

  it('fails closed when a plaintext initialization credential cannot be deleted', async () => {
    const projectRoot = path.resolve(__dirname, '../..')
    const runtimeRoot = path.join(projectRoot, '_client-postgres', 'pgsql')
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-pg-cleanup-failure-'))
    temporaryRoots.push(stateRoot)
    const controller = new EmbeddedPostgresController({
      runtimeRoot,
      stateRoot,
      findFreePort,
      protectSecret: plaintext => Buffer.from(plaintext, 'utf8'),
      unprotectSecret: encrypted => encrypted.toString('utf8'),
      removeFile: target => {
        if (target.includes('.init-password-')) throw new Error('simulated credential file lock')
        fs.unlinkSync(target)
      },
    })

    try {
      await expect(controller.start()).rejects.toThrow('Temporary PostgreSQL credential cleanup failed')
      expect(controller.isRunning).toBe(false)
      expect(fs.readdirSync(stateRoot).some(entry => entry.startsWith('.init-password-'))).toBe(true)
    } finally {
      for (const entry of fs.readdirSync(stateRoot)) {
        if (entry.startsWith('.init-password-')) fs.unlinkSync(path.join(stateRoot, entry))
      }
    }
  }, 60_000)
})
