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
  it('shows four-seat rooms and passes the chosen room to joining', async () => {
    function node(): { dataset:Record<string,string>; style:Record<string,string>; className:string; textContent:string; disabled:boolean; children:ReturnType<typeof node>[]; onclick:()=>void; querySelector:()=>null; appendChild(child:ReturnType<typeof node>):void; replaceChildren():void } {
      return { dataset: {}, style: {}, className: '', textContent: '', disabled: false, children: [] as ReturnType<typeof node>[],
        onclick: () => {}, querySelector: () => null,
        appendChild(child: ReturnType<typeof node>) { this.children.push(child) },
        replaceChildren() { this.children = [] },
      }
    }
    const list = node(), connect = vi.fn(), checkProfileAndGo = vi.fn()
    const context = createContext({ AbortSignal, fetch: async () => ({ ok: true, json: async () => ({rooms:[{ id:"pve", mode:"pve", name:"冒险", players:2, maxPlayers:4, joinable:true, status:"waiting" }]}) }), checkProfileAndGo, document: {
      getElementById: (id: string) => id === 'lanOverlay' ? { classList: { contains: () => true } } : list,
      createElement: node,
    }, RvBColyseus: { requestAt: async () => ({ rooms: [
      { id: 'duo', name: '双人小队', mode: '2v2', playerCount: 3, status: 'waiting' },
      { id: 'full', maxPlayers: 4, playerCount: 4, status: 'waiting' },
    ] }) }, _lanFound: [], filterLanRooms: vi.fn(), connectLanServer: connect })
    new Script(html.slice(html.indexOf('async function addLanServer'), html.indexOf('async function connectLanServer'))).runInContext(context)
    await new Script('addLanServer({url:"http://localhost:4567"})').runInContext(context)
    const rows = list.children[0].children
    expect(rows[0].textContent).toContain('2v2 · 3/4')
    expect(rows[1].disabled).toBe(true)
    rows[0].onclick()
    expect(connect).toHaveBeenCalledWith('http://localhost:4567', 'duo')
    expect(rows[2].textContent).toContain('pve · 2/4')
    rows[2].onclick()
    expect(checkProfileAndGo).toHaveBeenCalledWith('http://localhost:4567', 'lan', {adventure:true,joinRoom:'pve'})
  })
  it.each([true, false])('creates through native authority before navigating: ready=%s', async ready => {
    const caption = { textContent: '' }
    const button = { disabled: false, querySelector: () => caption }
    const checkProfileAndGo = vi.fn(), alert = vi.fn()
    const startHostBroadcast = vi.fn()
    const context = createContext({ window: { RvBHost: {
      ensureLocalAuthority: async () => ({ ok: ready, error: 'not ready' }),
      getMode: async () => ({ localUrl: 'http://localhost:4567' }), startHostBroadcast,
    } }, document: { getElementById: () => button }, checkProfileAndGo, alert })
    new Script(html.slice(html.indexOf('async function createLocalRoom'), html.indexOf('async function enterAsHost'))).runInContext(context)
    await new Script('createLocalRoom()').runInContext(context)
    expect(checkProfileAndGo).toHaveBeenCalledTimes(ready ? 1 : 0)
    if (ready) expect(checkProfileAndGo).toHaveBeenCalledWith('http://localhost:4567', 'local', { create: '1', matchMode: '1v1', adventure: false })
    expect(startHostBroadcast).toHaveBeenCalledTimes(ready ? 1 : 0)
    expect(button.disabled).toBe(false)
  })
  it('carries the selected LAN room through the lobby without forcing a match mode', () => {
    const window = { location: { href: '' } }
    const context = createContext({ window, URLSearchParams, RvBUtils: { saveServerConfig: vi.fn(), appendServerParams: (params: URLSearchParams) => params } })
    new Script(html.slice(html.indexOf('function goLobby('), html.indexOf('async function getLocalGameProfileIdentity'))).runInContext(context)
    new Script('goLobby("lan", "http://localhost:4567", {joinRoom:"team-room"})').runInContext(context)
    const query = new URL(window.location.href, 'http://localhost').searchParams
    expect(query.get('joinRoom')).toBe('team-room')
    expect(query.has('mode')).toBe(false)
  })
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

  it('delegates both discovery transports to the cancellable scanner', () => {
    const { context, startLanScan } = menu()
    expect(() => new Script('showJoinSheet()').runInContext(context)).not.toThrow()
    expect(startLanScan).toHaveBeenCalledOnce()

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
