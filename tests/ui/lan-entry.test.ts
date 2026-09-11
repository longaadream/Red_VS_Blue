import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const html = readFileSync('data/pages/index.html', 'utf8')
function menu() {
  const nodes = new Map<string, { style: Record<string, string>; classList: { add(): void; remove(): void }; textContent: string; innerHTML: string; value: string }>()
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, classList: { add() {}, remove() {} }, textContent: '', innerHTML: '', value: '' })
    return nodes.get(id)!
  }
  const startLanScan = vi.fn((options: { full: boolean; onProgress(done: number, total: number): void }) => { void options; return { cancel: vi.fn() } })
  const electronAPI = { offUdpDiscovery: vi.fn(), onUdpHostFound: vi.fn(), startDiscoverHosts: vi.fn(async () => ({ ok: true })) }
  const context = createContext({ window: { electronAPI }, document: { getElementById: get }, RvBLanDiscover: { startLanScan }, console })
  new Script(html.slice(html.indexOf('var _lanScanner'), html.indexOf('// ── Page loading'))).runInContext(context)
  return { context, startLanScan, electronAPI, get }
}
describe('main menu LAN entry', () => {
  it.each([true, false])('allows cosmetic-only profiles but rejects different rules: %s', async (cosmeticOnly) => {
    const local = { schemaVersion: 'rvb-game-profile-identity/v1', engineAbi: 'rvb-engine/v1', runnerRevision: 'rvb-battle-runner/v2', resolvedProfileHash: 'a'.repeat(64), authorityContentHash: 'b'.repeat(64) }
    const remote = { ...local, resolvedProfileHash: 'c'.repeat(64), authorityContentHash: cosmeticOnly ? local.authorityContentHash : 'd'.repeat(64) }
    const goLobby = vi.fn(), alert = vi.fn()
    const context = createContext({ getLocalGameProfileIdentity: async () => local, RvBColyseus: { requestCatalogIdentityAt: async () => ({ profileIdentity: remote }) }, localStorage: { setItem: vi.fn() }, goLobby, alert })
    new Script(html.slice(html.indexOf('async function checkProfileAndGo'), html.indexOf('function updatePackBadge'))).runInContext(context)
    const accepted = await new Script('checkProfileAndGo("http://10.41.179.82:2567", "lan")').runInContext(context)
    expect(accepted).toBe(cosmeticOnly)
    expect(goLobby).toHaveBeenCalledTimes(cosmeticOnly ? 1 : 0)
  })

  it('starts HTTP scanning even when desktop UDP returns no value', () => {
    const { context, startLanScan, electronAPI } = menu()
    expect(() => new Script('showJoinSheet()').runInContext(context)).not.toThrow()
    expect(startLanScan).toHaveBeenCalledOnce()
    expect(electronAPI.onUdpHostFound).toHaveBeenCalledOnce()
  })
  it('requests the real full scan and renders bounded progress', () => {
    const { context, startLanScan, get } = menu()
    new Script('startFullScan()').runInContext(context)
    const options = startLanScan.mock.calls[0][0]
    expect(options.full).toBe(true)
    options.onProgress(25, 100)
    expect(get('lanProgressFill').style.width).toBe('25%')
  })
  it('does not enter a lobby when remote profile validation fails', async () => {
    const goLobby = vi.fn(), alert = vi.fn()
    const context = createContext({ getLocalGameProfileIdentity: async () => ({}), RvBColyseus: { requestCatalogIdentityAt: async () => { throw Error('host unreachable') } }, goLobby, alert, console })
    new Script(html.slice(html.indexOf('async function checkProfileAndGo'), html.indexOf('function updatePackBadge'))).runInContext(context)
    await new Script('checkProfileAndGo("http://10.41.179.82:2567", "lan")').runInContext(context)
    expect(goLobby).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalled()
  })
})
