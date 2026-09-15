import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync('data/pages/js/official.js', 'utf8')
const fresh = { schemaVersion: 'rvb-game-profile-identity/v1', authorityContentHash: 'current' }
function page(protocol: string, android = false, available = true) {
  const nodes = new Map<string, { value: string; style: Record<string, string>; close(): void; replaceChildren(): void; appendChild(): void; onclick?: () => Promise<void>; textContent?: string }>()
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, close() {}, replaceChildren() {}, appendChild() {} })
    return nodes.get(id)!
  }
  const values = new Map([['rvb_game_profile_identity', JSON.stringify({ authorityContentHash: 'stale' })]])
  const calls: { url: string; options?: RequestInit }[] = []
  vm.runInNewContext(source, {
    window: { Capacitor: android ? { isNativePlatform: () => true } : undefined },
    location: { protocol, origin: protocol === 'rvb-client:' ? 'rvb-client://app' : 'https://localhost' },
    document: { hidden: true, getElementById: node, querySelector: node, querySelectorAll: () => [] },
    localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
    sessionStorage: { getItem: () => null }, URL, AbortSignal, setInterval() {},
    fetch: async (url: string, options?: RequestInit) => {
      calls.push({ url, options })
      return { ok: url !== '__tutorial-profile.json' || available, headers: { get: () => 'application/json' }, json: async () => url === '__tutorial-profile.json' ? fresh : { kind: 'rvb-official-v1' } }
    },
  })
  return { node, calls, values }
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
