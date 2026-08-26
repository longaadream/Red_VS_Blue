import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  BATTLE_AUTHORITY_SHUTDOWN_REQUEST,
  BATTLE_AUTHORITY_SHUTDOWN_RESULT,
  installBattleAuthorityShutdownHandlers,
  runBattleAuthorityGracefulShutdown,
} from '@/lib/server/battle-authority-shutdown'

class FakeChildProcess extends EventEmitter {
  connected = true
  sent: unknown[] = []
  exit = vi.fn()

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }
}

describe('battle authority graceful shutdown', () => {
  it('quiesces command ingress, drains durability, and acknowledges the Electron parent once', async () => {
    const order: string[] = []
    const child = new FakeChildProcess()
    const dispose = installBattleAuthorityShutdownHandlers({
      processRef: child as unknown as NodeJS.Process,
      exitOnSignal: false,
      begin: () => { order.push('begin') },
      quiesce: async () => { order.push('quiesce') },
      drain: async () => { order.push('drain') },
      timeoutMs: 100,
      logger: { log: vi.fn(), error: vi.fn() },
    })

    child.emit('message', {
      type: BATTLE_AUTHORITY_SHUTDOWN_REQUEST,
      requestId: 'shutdown-1',
    })
    await vi.waitFor(() => expect(child.sent).toHaveLength(1))

    expect(order).toEqual(['begin', 'quiesce', 'drain'])
    expect(child.sent[0]).toEqual({
      type: BATTLE_AUTHORITY_SHUTDOWN_RESULT,
      requestId: 'shutdown-1',
      ok: true,
    })
    expect(child.exit).not.toHaveBeenCalled()
    dispose()
  })

  it('returns an explicit failed acknowledgement when graceful drain fails', async () => {
    const child = new FakeChildProcess()
    const dispose = installBattleAuthorityShutdownHandlers({
      processRef: child as unknown as NodeJS.Process,
      exitOnSignal: false,
      begin: vi.fn(),
      drain: async () => { throw new Error('durable lag remains') },
      timeoutMs: 100,
      logger: { log: vi.fn(), error: vi.fn() },
    })

    child.emit('message', {
      type: BATTLE_AUTHORITY_SHUTDOWN_REQUEST,
      requestId: 'shutdown-2',
    })
    await vi.waitFor(() => expect(child.sent).toHaveLength(1))

    expect(child.sent[0]).toEqual({
      type: BATTLE_AUTHORITY_SHUTDOWN_RESULT,
      requestId: 'shutdown-2',
      ok: false,
      error: 'durable lag remains',
    })
    dispose()
  })

  it('bounds the entire shutdown even when a drain promise never settles', async () => {
    await expect(runBattleAuthorityGracefulShutdown({
      begin: vi.fn(),
      drain: () => new Promise<void>(() => undefined),
      timeoutMs: 20,
    })).rejects.toThrow('graceful shutdown timed out after 20ms')
  })

  it('wires both packaged Electron launchers to IPC before their force-kill fallback', () => {
    for (const relativePath of ['electron/main.ts', 'electron-client/main.ts']) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
      expect(source).toContain("'rvb:battle-authority:shutdown'")
      expect(source).toContain("'rvb:battle-authority:shutdown-result'")
      expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe', 'ipc']")
      expect(source).toContain('await requestGracefulServerShutdown(proc)')
      expect(source.indexOf('await requestGracefulServerShutdown(proc)'))
        .toBeLessThan(source.indexOf('killProcessTree(proc)', source.indexOf('async function stopChildProcessGracefully')))
    }
  })
})
