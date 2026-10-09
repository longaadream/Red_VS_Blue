import { describe, expect, it, vi } from 'vitest'

import {
  httpEndpoint,
  readOfficialSession,
  resolveOfficialSession,
} from '@/lib/ai-bot/official-session'

describe('official session transport', () => {
  it('rejects insecure public endpoints and URL credential material before fetch', () => {
    expect(() => httpEndpoint('http://official.example.test', '/official/me')).toThrowError(expect.objectContaining({ code: 'SERVER_URL_INSECURE' }))
    expect(() => httpEndpoint('ws://official.example.test', '/official/me')).toThrowError(expect.objectContaining({ code: 'SERVER_URL_INSECURE' }))
    expect(() => httpEndpoint('https://user:password@official.example.test', '/official/me')).toThrowError(expect.objectContaining({ code: 'SERVER_URL_CREDENTIALS_FORBIDDEN' }))
    expect(() => httpEndpoint('https://official.example.test?token=secret', '/official/me')).toThrowError(expect.objectContaining({ code: 'SERVER_URL_CREDENTIALS_FORBIDDEN' }))
    expect(httpEndpoint('http://127.0.0.1:2567/base', '/official/me')).toBe('http://127.0.0.1:2567/base/official/me')
  })

  it('logs in with process supplied credentials without exposing the password in failures', async () => {
    const fetchFn: typeof fetch = vi.fn(async (_input, init) => {
      expect(init?.redirect).toBe('error')
      expect(String(init?.body)).toContain('dummy-bot@example.test')
      expect(String(init?.body)).toContain('dummy-password')
      return {
        ok: true, status: 200,
        json: async () => ({ token: 'opaque-session-token', account: { id: 'Account-1', name: 'AI Account', email: 'dummy-bot@example.test' } }),
      } as unknown as Response
    })
    const session = await resolveOfficialSession({
      serverUrl: 'http://127.0.0.1:2567', email: 'dummy-bot@example.test', password: 'dummy-password', fetchFn,
    })
    expect(session).toEqual({ token: 'opaque-session-token', accountId: 'account-1', accountName: 'AI Account', accountEmail: 'dummy-bot@example.test' })
  })

  it('reads account identity for a pre-created token with a redacted request surface', async () => {
    let request: RequestInit | undefined
    const fetchFn: typeof fetch = vi.fn(async (_input, init) => {
      request = init
      return { ok: true, status: 200, json: async () => ({ account: { id: 'account-2', name: 'Second AI' } }) } as unknown as Response
    })
    const session = await readOfficialSession({ serverUrl: 'http://127.0.0.1:2567', token: 'opaque-token', fetchFn })
    expect(session).toMatchObject({ token: 'opaque-token', accountId: 'account-2', accountName: 'Second AI' })
    expect(request?.redirect).toBe('error')
    expect(request?.headers).toMatchObject({ authorization: 'Bearer opaque-token' })
  })
})
