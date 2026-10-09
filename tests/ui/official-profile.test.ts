import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync('data/pages/js/official.js', 'utf8')
const fresh = { schemaVersion: 'rvb-game-profile-identity/v1', authorityContentHash: 'current' }
type MockResponse = { ok: boolean; headers: { get(name: string): string }; json(): Promise<unknown> }
function page(protocol: string, android = false, available = true) {
  const nodes = new Map<string, { value: string; style: Record<string, string>; close(): void; replaceChildren(): void; appendChild(): void; onclick?: () => Promise<void>; textContent?: string }>()
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, close() {}, replaceChildren() {}, appendChild() {} })
    return nodes.get(id)!
  }
  const values = new Map([['rvb_game_profile_identity', JSON.stringify({ authorityContentHash: 'stale' })]])
  const calls: { url: string; options?: RequestInit }[] = []
  const sessions = new Map<string, { url: string; token: string }>()
  const window = {
    Capacitor: android ? { isNativePlatform: () => true } : undefined,
    RvBUtils: {
      readOfficialSession: (url: string) => sessions.get(url) || null,
      clearOfficialSession: (url: string) => sessions.delete(url),
      saveOfficialSession: (session: { url: string; token: string }) => { sessions.set(session.url, session); return true },
      saveRemoteServerUrl() {}, switchServerMode() {},
    },
  }
  let fetchImpl: (url: string, options?: RequestInit) => Promise<MockResponse> = async (url: string) => ({ ok: url !== '__tutorial-profile.json' || available, headers: { get: () => 'application/json' }, json: async () => url === '__tutorial-profile.json' ? fresh : { kind: 'rvb-official-v1' } })
  vm.runInNewContext(source, {
    window,
    location: { protocol, origin: protocol === 'rvb-client:' ? 'rvb-client://app' : 'https://localhost', search: '' },
    document: { hidden: true, getElementById: node, querySelector: node, querySelectorAll: () => [] },
    localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
    sessionStorage: { getItem: () => null }, URL, URLSearchParams, AbortSignal, setInterval() {},
    fetch: async (url: string, options?: RequestInit) => {
      calls.push({ url, options })
      return fetchImpl(url, options)
    },
  })
  return { node, calls, values, window, sessions, setFetch: (next: typeof fetchImpl) => { fetchImpl = next } }
}
for (const [name, protocol, android] of [['Windows', 'rvb-client:', false], ['Android', 'https:', true]] as const) {
  it(`${name} submits current local identity instead of stale storage`, async () => {
    const p = page(protocol, android)
    await p.node('join').onclick!()
    const request = p.calls.find(c => c.url.endsWith('/official/queue/join'))
    expect(JSON.parse(request!.options!.body as string).profileIdentity).toEqual(fresh)
    expect(p.calls.some(c => c.url.endsWith('/catalog/identity'))).toBe(false)
  })
  it(`${name} does not fall back to stale identity when local profile fails`, async () => {
    const p = page(protocol, android, false)
    await p.node('join').onclick!()
    expect(p.calls.some(c => c.url.endsWith('/official/queue/join'))).toBe(false)
    expect(p.node('message').textContent).toContain('本地资源不可用')
  })
}

it('keeps the old ranked logout token through queue cancellation', async () => {
  const p = page('rvb-client:')
  const origin = 'https://play.redvsblue.top'
  p.sessions.set(origin, { url: origin, token: 'old-token' })
  let releaseQueue: (() => void) | undefined
  p.setFetch(async url => {
    if (url.endsWith('/official/queue/cancel')) return new Promise(resolve => { releaseQueue = () => resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) }) })
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) }
  })

  const official = p.window as typeof p.window & { RvBOfficial: { logout(): Promise<unknown> } }
  const logout = official.RvBOfficial.logout()
  await new Promise(resolve => setTimeout(resolve, 0))
  p.sessions.set(origin, { url: origin, token: 'new-token' })
  releaseQueue?.()
  await logout

  const logoutCalls = p.calls.filter(call => call.url.endsWith('/official/queue/cancel') || call.url.endsWith('/official/auth/logout'))
  expect(logoutCalls).toHaveLength(2)
  expect((logoutCalls[0].options?.headers as Record<string, string>).Authorization).toBe('Bearer old-token')
  expect((logoutCalls[1].options?.headers as Record<string, string>).Authorization).toBe('Bearer old-token')
  expect(p.sessions.get(origin)?.token).toBe('new-token')
})

it('clears the current ranked session and reports a successful logout', async () => {
  const p = page('rvb-client:')
  const origin = 'https://play.redvsblue.top'
  p.sessions.set(origin, { url: origin, token: 'current-token' })
  p.setFetch(async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) }))

  const official = p.window as typeof p.window & { RvBOfficial: { logout(): Promise<unknown> } }
  await official.RvBOfficial.logout()
  expect(p.sessions.has(origin)).toBe(false)
  expect(p.node('message').textContent).toBe('已退出账号。')
})
