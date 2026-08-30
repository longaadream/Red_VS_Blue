import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

type Outcome = 'timeout' | 'success' | 'rpc-error'

function loadWsClient(outcomes: Outcome[]) {
  const urls: string[] = []
  const warnings: unknown[][] = []

  class FakeWebSocket {
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    private readonly outcome: Outcome

    constructor(url: string) {
      urls.push(url)
      this.outcome = outcomes[urls.length - 1] ?? 'timeout'
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.()
      }, 0)
    }

    send(raw: string) {
      const request = JSON.parse(raw) as { requestId: string }
      if (this.outcome === 'timeout') return
      const response = this.outcome === 'success'
        ? {
            type: 'rpcResult',
            requestId: request.requestId,
            ok: true,
            data: { profileIdentity: { schemaVersion: 'rvb-game-profile-identity/v1' } },
          }
        : {
            type: 'rpcResult',
            requestId: request.requestId,
            ok: false,
            code: 'PROFILE_INVALID',
            error: 'invalid identity',
          }
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(response) }), 0)
    }

    close() {
      this.readyState = 3
      setTimeout(() => this.onclose?.(), 0)
    }
  }

  const browserWindow: Record<string, unknown> = {}
  const context = createContext({
    window: browserWindow,
    WebSocket: FakeWebSocket,
    setTimeout,
    clearTimeout,
    URL,
    console: { ...console, warn: (...args: unknown[]) => warnings.push(args) },
  })
  new Script(
    readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8'),
    { filename: 'ws-client.js' },
  ).runInContext(context)

  return {
    urls,
    warnings,
    ws: browserWindow.RvBWs as {
      requestCatalogIdentityAt(
        baseUrl: string,
        scope: string,
      ): Promise<{ profileIdentity: { schemaVersion: string } }>
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RED-116 Profile identity probe stability', () => {
  it('retries one transient read-only catalog.identity timeout and then succeeds', async () => {
    vi.useFakeTimers()
    const fixture = loadWsClient(['timeout', 'success'])

    const result = fixture.ws.requestCatalogIdentityAt('http://127.0.0.1:38521', 'local-profile')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual({
      profileIdentity: { schemaVersion: 'rvb-game-profile-identity/v1' },
    })
    expect(fixture.urls).toEqual([
      'ws://127.0.0.1:38521/ws/rooms/__lobby',
      'ws://127.0.0.1:38521/ws/rooms/__lobby',
    ])
    expect(fixture.warnings).toHaveLength(1)
  })

  it('does not retry a non-transient RPC failure', async () => {
    vi.useFakeTimers()
    const fixture = loadWsClient(['rpc-error', 'success'])

    const result = fixture.ws.requestCatalogIdentityAt('https://example.test', 'remote-server')
    const rejection = expect(result).rejects.toMatchObject({ code: 'PROFILE_INVALID' })
    await vi.runAllTimersAsync()

    await rejection
    expect(fixture.urls).toEqual(['wss://example.test/ws/rooms/__lobby'])
    expect(fixture.warnings).toHaveLength(0)
  })

  it('reports the stage and redacted origin after both transient attempts fail', async () => {
    vi.useFakeTimers()
    const fixture = loadWsClient(['timeout', 'timeout'])

    const result = fixture.ws.requestCatalogIdentityAt(
      'https://user:secret@example.test:8443/path?token=hidden',
      'local-profile-runtime',
    ).catch(error => error)
    await vi.runAllTimersAsync()

    const error = await result
    expect(error).toMatchObject({
      code: 'PROFILE_IDENTITY_TRANSPORT_FAILED',
      context: {
        scope: 'local-profile-runtime',
        origin: 'https://example.test:8443',
        attempt: 2,
        maxAttempts: 2,
      },
    })
    expect(error.message).toContain('[local-profile-runtime] https://example.test:8443')
    expect(error.message).not.toContain('secret')
    expect(error.message).not.toContain('token=hidden')
    expect(fixture.urls).toHaveLength(2)
    expect(fixture.warnings).toHaveLength(1)
  })
})
