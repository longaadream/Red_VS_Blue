import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres'
import { findFreePort } from '../../electron-client/local-port'

const temporaryRoots: string[] = []
const execFileAsync = promisify(execFile)

afterAll(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
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

    const first = await controller.start()
    expect(first.url).toMatch(/^postgresql:\/\/rvb:[^@]+@127\.0\.0\.1:\d+\/rvb_colyseus\?sslmode=disable$/)
    const firstPool = new Pool({ connectionString: first.url, max: 1 })
    const settings = await firstPool.query<{ listen_addresses: string; password_encryption: string }>(
      'SELECT current_setting(\'listen_addresses\') AS listen_addresses, current_setting(\'password_encryption\') AS password_encryption',
    )
    expect(settings.rows).toEqual([{ listen_addresses: '127.0.0.1', password_encryption: 'scram-sha-256' }])
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
  }, 60_000)

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
