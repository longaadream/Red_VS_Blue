import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any -- the VM intentionally exposes the browser global without DOM typings. */

const root = 'data/pages'
const source = readFileSync(`${root}/js/player-profile.js`, 'utf8')
const styleSource = readFileSync(`${root}/css/tabletop/player-profile.css`, 'utf8')

class FakeElement {
  readonly tagName: string
  readonly ownerDocument: FakeDocument
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly listeners = new Map<string, ((event: any) => void)[]>()
  className = ''
  id = ''
  hidden = false
  open = false
  disabled = false
  tabIndex = 0
  value = ''
  type = ''
  name = ''
  maxLength = 0
  autocomplete = ''
  alt = ''
  src = ''
  isConnected = true
  private _textContent = ''
  parentNode: FakeElement | null = null

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument
    this.tagName = tagName.toUpperCase()
  }

  get textContent() { return this._textContent }
  set textContent(value: string) { this._textContent = String(value ?? '') }
  get firstChild() { return this.children[0] || null }
  get lastChild() { return this.children[this.children.length - 1] || null }
  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null
    const index = this.parentNode.children.indexOf(this)
    return index >= 0 ? this.parentNode.children[index + 1] || null : null
  }
  get classList() {
    return {
      add: (...names: string[]) => { this.className = Array.from(new Set(this.className.split(/\s+/).filter(Boolean).concat(names))).join(' ') },
      toggle: (name: string, force?: boolean) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean))
        const enabled = force === undefined ? !names.has(name) : force
        if (enabled) names.add(name); else names.delete(name)
        this.className = Array.from(names).join(' ')
        return enabled
      },
    }
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this; child.isConnected = true; this.children.push(child)
    return child
  }
  insertBefore(child: FakeElement, before: FakeElement | null) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this; child.isConnected = true
    const index = before ? this.children.indexOf(before) : -1
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child)
    return child
  }
  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child)
    if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; child.isConnected = false }
    return child
  }
  replaceChildren(...children: FakeElement[]) {
    this.children.slice().forEach(child => this.removeChild(child))
    children.forEach(child => this.appendChild(child))
  }
  setAttribute(name: string, value: string) {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'id') this.id = text
    if (name === 'class') this.className = text
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = text
    if (name === 'open') this.open = true
  }
  getAttribute(name: string) {
    if (this.attributes.has(name)) return this.attributes.get(name) || ''
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] ?? null
    return null
  }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'open') this.open = false }
  addEventListener(type: string, listener: (event: any) => void) {
    const entries = this.listeners.get(type) || []; entries.push(listener); this.listeners.set(type, entries)
  }
  dispatch(type: string, event: any = {}) {
    event.target = event.target || this
    event.preventDefault = event.preventDefault || (() => {})
    event.stopPropagation = event.stopPropagation || (() => {})
    ;(this.listeners.get(type) || []).forEach(listener => listener(event))
  }
  focus() { this.ownerDocument.activeElement = this }
  showModal() { this.open = true }
  close() { this.open = false; this.dispatch('close') }
  matches(selector: string) {
    const tab = selector.match(/^\[data-profile-tab(?:="([^"]+)")?\]$/)
    if (tab) return Object.prototype.hasOwnProperty.call(this.dataset, 'profileTab') && (!tab[1] || this.dataset.profileTab === tab[1])
    if (selector === '[data-avatar-character-id]') return Object.prototype.hasOwnProperty.call(this.dataset, 'avatarCharacterId')
    if (selector === '[data-rvb-identity-avatar]') return this.attributes.has('data-rvb-identity-avatar')
    if (selector === '[data-rvb-identity-label]') return this.attributes.has('data-rvb-identity-label')
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1))
    return false
  }
  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = []
    const walk = (node: FakeElement) => { if (node.matches(selector)) result.push(node); node.children.forEach(walk) }
    this.children.forEach(walk)
    return result
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null }
  closest(selector: string) {
    if (this.matches(selector)) return this
    let parent = this.parentNode
    while (parent) { if (parent.matches(selector)) return parent; parent = parent.parentNode }
    return null
  }
}

class FakeDocument {
  readonly body: FakeElement
  activeElement: FakeElement | null = null
  constructor() { this.body = new FakeElement(this, 'body') }
  createElement(tagName: string) { return new FakeElement(this, tagName) }
  getElementById(id: string) {
    if (this.body.id === id) return this.body
    return this.body.querySelector('#' + id)
  }
  querySelector(selector: string) { return this.body.querySelector(selector) }
}

function createProfileVm(options: { rotateSessionBeforeRequest?: boolean; history?: unknown; deferCards?: boolean; failProfileIds?: string[]; profile?: Record<string, unknown> } = {}) {
  const document = new FakeDocument()
  const session = { token: 'old-token', account: { id: 'a1', name: 'Old name' } }
  const calls: { url: string; options?: RequestInit }[] = []
  let readCount = 0
  const profile = {
    id: 'a1', name: 'Old name', avatar: null, totalGames: 0, wins: 0, draws: 0,
    season: { rating: 1000, games: 0, wins: 0 }, favoriteRosters: { light: null, dark: null }, recentMatches: [],
    ...(options.profile || {}),
  }
  let releaseCards: (() => void) | null = null
  const window = {
    addEventListener() {},
    location: { href: '' },
    RvBUtils: {
      readOfficialSession: () => {
        readCount += 1
        if (options.rotateSessionBeforeRequest && readCount === 2) session.token = 'new-token'
        return session
      },
      saveOfficialSession() { return true },
    },
  }
  const localStorage = { getItem: (key: string) => key === 'rvb_official_url' ? 'http://127.0.0.1:38844' : null }
  const fetch = async (url: string, requestOptions?: RequestInit) => {
    calls.push({ url, options: requestOptions })
    let result: unknown = { characters: [] }
    if (url.endsWith('/official/players/a1')) result = { profile }
    if (url.endsWith('/official/players/me')) result = { profile: { ...profile, name: 'New name' } }
    if (url.includes('/official/players/a1/history')) result = options.history ?? { matches: [] }
    if (url.includes('/official/players/cards?ids=opponent')) {
      result = { players: [{ id: 'opponent', name: 'Current name', avatar: { id: 'piece', name: 'Piece', image: 'piece.png' } }] }
      if (options.deferCards) await new Promise<void>(resolve => { releaseCards = resolve })
    }
    const failedProfile = options.failProfileIds?.some(id => url.endsWith(`/official/players/${id}`))
    if (failedProfile) return { ok: false, status: 404, json: async () => ({ error: '玩家资料读取失败' }) }
    return { ok: true, json: async () => result }
  }
  const context = vm.createContext({ window, document, localStorage, fetch, URL, AbortController, setTimeout, clearTimeout })
  vm.runInContext(source, context)
  return { document, window, session, calls, profile: (window as any).RvBPlayerProfile, releaseCards: () => { releaseCards?.() } }
}

describe('RED-244 player profile UI contract', () => {
  it('exposes one profile entry point and batches lightweight cards', () => {
    expect(source).toContain('global.RvBPlayerProfile')
    expect(source).toContain('open: open')
    expect(source).toContain('decoratePlayer: decoratePlayer')
    expect(source).toContain('bindAvatar: bindAvatar')
    expect(source).toContain('renderIdentity: renderIdentity')
    expect(source).toContain('loadHistoryInto: loadHistoryInto')
    expect(source).toContain("element.setAttribute('data-rvb-player-avatar', '')")
    expect(source).toContain("var interactive = !ownerButton || ownerButton === element")
    expect(source).toContain('attachPlayerEvents(element, id)')
    expect(source).toContain("if (event.key !== 'Escape') return")
    expect(source).toContain('ArrowRight: 1')
    expect(source).toContain('event.key === \'Home\'')
    expect(source).toContain('event.key === \'End\'')
    expect(source).toContain('button.hidden')
    expect(source).toContain('preserveName: true')
    expect(source).toContain("if (!currentContext(context)) return Promise.reject")
    expect(source).toContain("'/official/players/cards?ids='")
    expect(source).toContain('MAX_CARD_IDS = 50')
    expect(source).toContain('pendingCardRequests')
    expect(source).toContain("'/official/players/' + encodeURIComponent(accountId)")
    expect(source).toContain("'/official/players/me'")
    expect(source).toContain("request(context, '/official/players/me', { body: { name: name")
    expect(source).toContain("avatarCharacterId: state.pendingAvatarId || null")
    expect(source).toContain("'/official/players/catalog'")
    expect(source).not.toContain('.innerHTML')
    expect(source).toContain("surrender: '投降'")
    expect(source).toContain("core_destroyed: '核心被消灭'")
    expect(source).toContain("var download = make('button', 'button', '下载回放')")
    expect(source).toContain('setLogoutHandler: setLogoutHandler')
    expect(source).toContain('rvbPlayerProfileLogout')
  })

  it('keeps avatar rendering on the local images root', () => {
    const window = { addEventListener() {} }
    const context = vm.createContext({ window, URL, setTimeout, clearTimeout })
    vm.runInContext(source, context)
    const profile = (window as any).RvBPlayerProfile
    expect(profile.localImage('adventure/aizen.jpg')).toBe('images/adventure/aizen.jpg')
    expect(profile.localImage('images/tabletop/avatar-placeholder.svg')).toBe('images/tabletop/avatar-placeholder.svg')
    expect(profile.localImage('https://example.com/avatar.png')).toBe('')
    expect(profile.localImage('../avatar.png')).toBe('')
    expect(profile.localImage('/avatar.png')).toBe('')
    expect(profile.localImage('images//avatar.png')).toBe('')
    expect(profile.localImage('data:image/png;base64,AAAA')).toBe('')
  })

  it('keeps inactive profile tabs hidden despite global fantasy dialog styles', () => {
    expect(styleSource).toContain('.rvb-player-profile-dialog [hidden]')
    expect(styleSource).toContain('display: none !important')
    expect(source).toContain("state.refs.panels[key].hidden = key !== name")
    expect(source).toContain('if (!ownProfile) refs.panels.edit.hidden = true')
  })

  it('sends self edits as an authenticated POST with the JSON body', async () => {
    const testVm = createProfileVm()
    await testVm.profile.open('a1')
    await new Promise(resolve => setTimeout(resolve, 0))
    const form = testVm.document.getElementById('rvbPlayerProfileForm')!
    const input = testVm.document.getElementById('rvbPlayerProfileName')!
    input.value = 'New name'
    form.dispatch('submit')
    await new Promise(resolve => setTimeout(resolve, 0))
    const save = testVm.calls.find(call => call.url.endsWith('/official/players/me'))
    expect(save?.options?.method).toBe('POST')
    expect(JSON.parse(save?.options?.body as string)).toEqual({ name: 'New name', avatarCharacterId: null })
    expect((save?.options?.headers as Record<string, string>).Authorization).toBe('Bearer old-token')
  })

  it('clears the previous profile before a second profile fails to load', async () => {
    const testVm = createProfileVm({
      failProfileIds: ['b1'],
      profile: {
        avatar: { image: 'a.png' }, totalGames: 7,
        favoriteRosters: { light: { pieces: [{ id: 'piece', name: '角色', image: 'piece.png' }], games: 2, wins: 1 }, dark: null },
      },
    })
    await testVm.profile.open('a1')
    const dialog = testVm.document.getElementById('rvbPlayerProfileDialog')!
    expect(dialog.querySelectorAll('.rvb-profile-metric')).toHaveLength(4)
    expect(dialog.querySelectorAll('.rvb-roster-card')).toHaveLength(2)
    expect(dialog.querySelector('#rvbPlayerProfileAvatar')?.src).toBe('images/a.png')
    await testVm.profile.open('b1')
    expect(dialog.querySelectorAll('.rvb-profile-metric')).toHaveLength(0)
    expect(dialog.querySelectorAll('.rvb-roster-card')).toHaveLength(0)
    expect(dialog.querySelector('#rvbPlayerProfileAvatar')?.src).toBe('images/tabletop/avatar-placeholder.svg')
    expect(dialog.querySelector('#rvbPlayerProfileTitle')?.textContent).toBe('读取玩家资料…')
    expect(dialog.querySelector('.rvb-profile-status')?.textContent).toContain('玩家资料读取失败')
  })

  it('clears profile content on logout before an unauthenticated open', async () => {
    const testVm = createProfileVm({ profile: { totalGames: 3, avatar: { image: 'a.png' } } })
    await testVm.profile.open('a1')
    const dialog = testVm.document.getElementById('rvbPlayerProfileDialog')!
    testVm.profile.close()
    expect(dialog.querySelectorAll('.rvb-profile-metric')).toHaveLength(0)
    expect(dialog.querySelectorAll('.rvb-roster-card')).toHaveLength(0)
    testVm.session.token = ''
    await expect(testVm.profile.open('a1')).resolves.toBe(false)
    expect(dialog.querySelectorAll('.rvb-profile-metric')).toHaveLength(0)
    expect(dialog.querySelectorAll('.rvb-roster-card')).toHaveLength(0)
    expect(dialog.querySelector('.rvb-profile-status')?.textContent).toContain('请先登录官方账号')
  })

  it('delegates self logout from the profile even when loading the profile fails', async () => {
    const testVm = createProfileVm({ failProfileIds: ['a1'] })
    let logoutCalls = 0
    testVm.profile.setLogoutHandler(() => { logoutCalls += 1 })
    await testVm.profile.open('a1')

    const dialog = testVm.document.getElementById('rvbPlayerProfileDialog')!
    const logout = testVm.document.getElementById('rvbPlayerProfileLogout')!
    expect(logout.hidden).toBe(false)
    expect(dialog.querySelector('.rvb-profile-status')?.textContent).toContain('玩家资料读取失败')

    logout.dispatch('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(logoutCalls).toBe(1)
    expect(dialog.open).toBe(false)
  })

  it('does not offer profile logout for another account or without a host callback', async () => {
    const testVm = createProfileVm()
    await testVm.profile.open('opponent')
    expect(testVm.document.getElementById('rvbPlayerProfileLogout')?.hidden).toBe(true)

    await testVm.profile.open('a1')
    expect(testVm.document.getElementById('rvbPlayerProfileLogout')?.hidden).toBe(true)
  })

  it('does not let a late logout close a replacement profile or run twice', async () => {
    let releaseLogout: (() => void) | null = null
    let logoutCalls = 0
    const testVm = createProfileVm()
    testVm.profile.setLogoutHandler(() => {
      logoutCalls += 1
      return new Promise<void>(resolve => { releaseLogout = resolve })
    })
    await testVm.profile.open('a1')
    const dialog = testVm.document.getElementById('rvbPlayerProfileDialog')!
    const logout = testVm.document.getElementById('rvbPlayerProfileLogout')!
    logout.dispatch('click')
    await Promise.resolve()
    logout.dispatch('click')
    expect(logoutCalls).toBe(1)
    expect(logout.disabled).toBe(true)

    await testVm.profile.open('opponent')
    releaseLogout!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dialog.open).toBe(true)
    expect(logout.hidden).toBe(true)
  })

  it('closes the dialog when the close button receives a click event', async () => {
    const testVm = createProfileVm()
    await testVm.profile.open('a1')
    const dialog = testVm.document.getElementById('rvbPlayerProfileDialog')!
    dialog.querySelector('.dialog-close')?.dispatch('click')
    expect(dialog.open).toBe(false)
    expect(dialog.querySelectorAll('.rvb-profile-metric')).toHaveLength(0)
  })

  it('does not send a request after the session rotates during preflight', async () => {
    const testVm = createProfileVm({ rotateSessionBeforeRequest: true })
    await testVm.profile.open('a1')
    expect(testVm.calls).toHaveLength(0)
  })

  it('keeps recorded history names while cards only fill the avatar', async () => {
    const testVm = createProfileVm()
    const player = testVm.document.createElement('span')
    player.textContent = 'Recorded name'
    testVm.document.body.appendChild(player)
    testVm.profile.decoratePlayer(player, { id: 'opponent', name: 'Recorded name', preserveName: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(player.querySelector('.rvb-player-label')?.textContent).toBe('Recorded name')
    expect(player.querySelector('.rvb-player-avatar')?.src).toBe('images/piece.png')
  })

  it('coalesces slow in-flight card decoration requests by context and account', async () => {
    const testVm = createProfileVm({ deferCards: true })
    const first = testVm.document.createElement('span')
    const second = testVm.document.createElement('span')
    testVm.document.body.appendChild(first)
    testVm.document.body.appendChild(second)
    testVm.profile.decoratePlayer(first, { id: 'opponent', name: '对手' })
    await new Promise(resolve => setTimeout(resolve, 0))
    testVm.profile.decoratePlayer(second, { id: 'opponent', name: '对手' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(testVm.calls.filter(call => call.url.includes('/official/players/cards?ids=opponent'))).toHaveLength(1)
    testVm.releaseCards()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.querySelector('.rvb-player-avatar')?.src).toBe('images/piece.png')
  })

  it('renders the official history DTO with outcome reason and after/delta Elo', async () => {
    const testVm = createProfileVm({ history: {
      matches: [{
        id: 'match-1', createdAt: '2026-10-08T12:00:00.000Z', finishedAt: '2026-10-08T12:05:00.000Z', status: 'settled',
        map: { id: 'map-1', name: '雾岭' }, winnerId: 'a1', reason: 'surrender', replayAvailable: true,
        players: [
          { id: 'a1', name: '记录时的我', avatar: null, alignment: 'light', pieces: [], ratingBefore: 1000, ratingAfter: 984, delta: -16 },
          { id: 'opponent', name: '对手', avatar: null, alignment: 'dark', pieces: [], ratingBefore: 1000, ratingAfter: 1016, delta: 16 },
        ],
      }],
    } })
    const container = testVm.document.createElement('section')
    testVm.document.body.appendChild(container)
    await expect(testVm.profile.loadHistoryInto(container, 'a1')).resolves.toBe(true)
    const view = (container as any).__rvbProfileHistoryView
    expect(view.list.querySelector('.rvb-match-meta')?.textContent).toContain('投降')
    expect(view.list.querySelector('.rvb-match-delta')?.textContent).toBe('Elo 984(-16)')
    expect(view.list.querySelector('.rvb-match-actions')?.children[1]?.textContent).toBe('下载回放')
  })

  it('validates and stores a replay before navigating, and exposes stats definitions', () => {
    expect(source).toContain("'/official/matches/' + encodeURIComponent(match.id) + '/replay'")
    expect(source).toContain('tools.assertTraceRecord')
    expect(source).toContain('tools.storeCompletedTrace')
    expect(source).toContain('tools.downloadTrace')
    expect(source).toContain("'/official/character-stats'")
    expect(source).toContain('当前资源包')
    expect(source).toContain('authorityContentHash')
    expect(source).toContain('套参赛阵容')
    expect(source).toContain('选择率 = 携带该角色的参赛阵容数 / 参赛阵容总数')
    expect(source).toContain('胜率 = 获胜携带阵容数 / 携带阵容数')
  })

  it('hooks the shared dialog into online pages and the official stats tab', () => {
    const pages = ['official.html', 'community.html', 'multiplayer.html', 'index.html', 'lobby.html', 'ranked-match.html']
    pages.forEach(page => {
      const html = readFileSync(`${root}/${page}`, 'utf8')
      expect(html).toContain('css/tabletop/player-profile.css')
      expect(html).toContain('js/player-profile.js')
      expect(html).toContain('js/developer-tools/match-trace.js')
    })
    expect(readFileSync(`${root}/community.html`, 'utf8')).not.toContain('id="communityLogout"')
    expect(readFileSync(`${root}/official.html`, 'utf8')).not.toContain('id="logout"')
    const officialScript = readFileSync(`${root}/js/official.js`, 'utf8')
    expect(officialScript).toContain("tab.setAttribute('data-rank-tab', 'stats')")
    expect(officialScript).toContain("target.setAttribute('data-profile-stats', '')")
    expect(officialScript).toContain('loadCharacterStats')
    expect(officialScript).toContain("initialQuery.get('tab') === 'history'")
    expect(officialScript).toContain("selectRankTab('history')")
    expect(readFileSync(`${root}/js/community.js`, 'utf8')).toContain('decoratePlayer')
    expect(readFileSync(`${root}/js/community.js`, 'utf8')).toContain('setLogoutHandler(logout)')
    expect(officialScript).toContain('setLogoutHandler(window.RvBOfficial.logout)')
    expect(readFileSync(`${root}/js/home-account.js`, 'utf8')).toContain('RvBPlayerProfile.renderIdentity')
  })
})
