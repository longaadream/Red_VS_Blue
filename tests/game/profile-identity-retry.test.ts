import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

type Outcome = 'timeout' | 'success' | 'rpc-error'

function loadWsClient(outcomes: Outcome[]) {
  const urls: string[] = []
  const warnings: unknown[][] = []
  const fetch = vi.fn(async (url: string) => {
    urls.push(url)
    const outcome = outcomes[urls.length - 1] ?? 'timeout'
    if (outcome === 'timeout') throw new Error('network timeout')
    if (outcome === 'success') {
      return {
        ok: true,
        json: async () => ({
          profileIdentity: { schemaVersion: 'rvb-game-profile-identity/v1' },
        }),
      }
    }
    return {
      ok: false,
      json: async () => ({ code: 'PROFILE_INVALID', error: 'invalid identity' }),
    }
  })

  const browserWindow: Record<string, unknown> = {}
  const context = createContext({
    window: browserWindow,
    fetch,
    AbortController,
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
      'http://127.0.0.1:38521/catalog/identity',
      'http://127.0.0.1:38521/catalog/identity',
    ])
    expect(fixture.warnings).toHaveLength(0)
  })

  it('does not retry a non-transient RPC failure', async () => {
    vi.useFakeTimers()
    const fixture = loadWsClient(['rpc-error', 'success'])

    const result = fixture.ws.requestCatalogIdentityAt('https://example.test', 'remote-server')
    const rejection = expect(result).rejects.toMatchObject({ code: 'PROFILE_INVALID' })
    await vi.runAllTimersAsync()

    await rejection
    expect(fixture.urls).toEqual(['https://example.test/catalog/identity'])
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
    expect(fixture.warnings).toHaveLength(0)
  })
})
