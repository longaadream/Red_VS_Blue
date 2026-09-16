import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it, vi } from 'vitest'
const script = readFileSync('data/pages/js/multiplayer.js', 'utf8')
type MockNode = { value:string; hidden:boolean; disabled:boolean; checked:boolean; textContent:string; children:MockNode[]; onclick:()=>void; onchange:()=>void; append(...items:MockNode[]):void; replaceChildren():void }
function setup() {
  const nodes = new Map<string, ReturnType<typeof node>>()
  function node(): MockNode { return { value: '', hidden: false, disabled: false, checked: true, textContent: '', children: [] as ReturnType<typeof node>[], onclick: () => {}, onchange: () => {}, append(...items: ReturnType<typeof node>[]) { this.children.push(...items) }, replaceChildren() { this.children = [] } } }
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id)! }
  get('serverKind').value = 'official'; get('gameMode').value = 'pve'
  const profile = { schemaVersion: 1, engineAbi: 'a', runnerRevision: 'b', resolvedProfileHash: 'c', authorityContentHash: 'd' }
  const location = { href: '', search: '' }, storage = { getItem: () => null, setItem: vi.fn() }
  const host = { ensureLocalAuthority: vi.fn(async () => ({ ok: true })), getMode: async () => ({ localUrl: 'http://127.0.0.1:2567', profileIdentity: profile, localAuthorityProfileIdentity: profile }), relayControl: vi.fn(async () => ({ ok: true, published: { url: 'https://play.redvsblue.top/hosts/ab', inviteCode: '12345678' } })), startHostBroadcast: vi.fn(async () => ({})) }
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/invites/') ? { url: 'https://play.redvsblue.top/hosts/ab' } : url.endsWith('/hosts') ? { hosts: [{ url: 'https://play.redvsblue.top/hosts/ab', name: 'A' }] } : url.endsWith('/rooms?mode=pve') ? { rooms: [{ id: 'pv', name: '旅途', players: 2, maxPlayers: 4, joinable: true }] } : url.endsWith('/rooms') ? { rooms: [{ id: 'full', mode: '1v1', players: [{}, {}], maxPlayers: 2, status: 'waiting' }] } : { ok: true, protocol: 'rvb-colyseus' } }))
  const utils = { readOfficialSession: () => ({ token: 'test', account: { id: 'test' } }), saveServerConfig: vi.fn(), appendServerParams: (p: URLSearchParams) => p }
  const context = createContext({ URL, URLSearchParams, AbortSignal, console, location, fetch, localStorage: storage, setInterval: () => {}, window: { RvBHost: host, RvBUtils: utils }, navigator: {}, document: { getElementById: get, createElement: node, querySelectorAll: (selector: string) => selector === '.modalError' ? [] : [...nodes.values()] }, RvBIdentity: { getIdentity: () => ({ displayName: '测试' }), ensureIdentity: async () => ({}) }, RvBColyseus: { requestCatalogIdentityAt: async () => ({ profileIdentity: profile }) }, RvBUtils: utils })
  new Script(script).runInContext(context)
  return { get, location, host, fetch }
}
async function finished() { await new Promise(resolve => setTimeout(resolve, 0)) }
it('publishes a player host then opens the local PVE preparation', async () => {
  const { get, location, host } = setup(); get('publish').onclick(); await finished()
  expect(host.relayControl).toHaveBeenCalledWith(expect.objectContaining({ action: 'publish', relayUrl: 'https://play.redvsblue.top' }))
  expect(location.href).toBe('adventure.html?server=http%3A%2F%2F127.0.0.1%3A2567')
})
it('lists both games, keeps full rooms disabled and routes PVE joining through the tunnel', async () => {
  const { get, location } = setup(); get('refresh').onclick(); await finished()
  const rows = get('hosts').children
  expect(rows[0].children[0].textContent).toContain('2/2')
  expect(rows[0].children[1].disabled).toBe(true)
  rows[1].children[1].onclick(); await finished()
  expect(location.href).toBe('adventure.html?server=https%3A%2F%2Fplay.redvsblue.top%2Fhosts%2Fab&joinRoom=pv')
  expect(rows[0].children[1].disabled).toBe(true)
  expect(rows[1].children[1].disabled).toBe(false)
})
it('uses the chosen nonofficial server', async () => {
  const { get, host } = setup(); get('serverKind').value='custom'; get('relayUrl').value='https://example.test'
  get('publish').onclick(); await finished()
  expect(host.relayControl).toHaveBeenCalledWith(expect.objectContaining({ action:'publish', relayUrl:'https://example.test' }))
})

it('opens an invited PVE host through the selected server', async () => {
  const { get, location } = setup(); get('inviteMode').value='pve'; get('invite').value='12345678'
  get('joinInvite').onclick(); await finished()
  expect(location.href).toBe('adventure.html?server=https%3A%2F%2Fplay.redvsblue.top%2Fhosts%2Fab')
})

it('keeps LAN and port-forwarding controls out of the server page', () => {
  const html = readFileSync('data/pages/multiplayer.html', 'utf8')
  for (const id of ['localLobby', 'showLocalAddress', 'directDialog', 'joinDirect']) {
    expect(html).not.toContain('id="' + id + '"')
    expect(script).not.toContain("byId('" + id + "')")
  }
  const create = html.split('id="hostDialog"')[1].split('</dialog>')[0]
  expect(create).not.toMatch(/局域网|frp|停止发布|转发发布设置|尚未发布/)
})

it('filters public PVE rooms in the unified lobby', async () => {
  const { get } = setup(); get('publicModeFilter').value='pve'
  get('publicModeFilter').onchange(); await finished()
  expect(get('hosts').children).toHaveLength(1)
  expect(get('hosts').children[0].children[0].textContent).toContain('PVE')
})
it('routes bare lobby navigation to the public directory, preserving explicit entries', () => {
  const source=readFileSync('data/pages/js/lobby-entry.js','utf8')
  for (const search of ['', '?v=123', '?server=lan&serverUrl=http%3A%2F%2F192.168.1.2', '?server=local&create=1', '?server=remote&joinRoom=room']) {
    const replace=vi.fn()
    new Script(source).runInContext(createContext({ URLSearchParams, location:{search,replace} }))
    expect(replace).toHaveBeenCalledTimes(search.includes('create=') || search.includes('joinRoom=') ? 0 : 1)
  }
})
it('has only room lobby and ranked navigation', () => {
  for (const page of ['multiplayer','lobby','official']) {
    const nav=readFileSync('data/pages/'+page+'.html','utf8').split('<nav')[1].split('</nav>')[0]
    expect(nav.match(/<a /g)).toHaveLength(2)
    expect(nav).not.toContain('>服务器</a>')
  }
})
it('opens the server lobby in PVE mode and requires its account for internet play', () => {
  const source=readFileSync('data/pages/js/multiplayer.js','utf8')
  expect(source).toContain("var entryMode = new URLSearchParams(location.search).get('mode')")
  expect(source).toMatch(/if \(entryMode === 'pve'\)[\s\S]*?byId\('gameMode'\)\.value = 'pve'[\s\S]*?byId\('inviteMode'\)\.value = 'pve'[\s\S]*?byId\('publicModeFilter'\)\.value = 'pve'/)
  expect(source).toContain('function requireServerAccount()')
  expect(source).toContain("location.href = 'official.html'")
  expect(source).toMatch(/async function enter[\s\S]*?if \(!local\) requireServerAccount\(\)/)
})
it('preserves a public host context through room, selection, battle and return', () => {
  const source=readFileSync('data/pages/js/server-utils.js','utf8')
  const fn=source.slice(source.indexOf('  function appendServerParams('),source.indexOf('  function clearServerUrl('))
  const context=createContext({URLSearchParams,window:{location:{search:'?server=local&lobbyContext=public'}},getActiveServerMode:()=> 'local',getServerUrl:()=> 'http://127.0.0.1:2567'})
  new Script(fn).runInContext(context)
  const query=new Script('appendServerParams(new URLSearchParams()).toString()').runInContext(context)
  expect(new URLSearchParams(query).get('lobbyContext')).toBe('public')
  const replace=vi.fn()
  new Script(readFileSync('data/pages/js/lobby-entry.js','utf8')).runInContext(createContext({URLSearchParams,location:{search:'?'+query,replace}}))
  expect(replace.mock.calls[0][0]).toMatch(/^multiplayer\.html/)
  for(const page of ['room','piece-selection','battle'])expect(readFileSync('data/pages/'+page+'.html','utf8')).toContain('RvBUtils.appendServerParams')
})
