/* eslint-disable @typescript-eslint/no-explicit-any -- browser VM harness. */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const source = readFileSync('data/pages/js/community.js', 'utf8')
const origin = 'https://play.redvsblue.top'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  }
}

function response(body: any, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function harness(options: { officialUrl?: string | null } = {}) {
  const ids = [
    'communityConnection', 'communityAccountButton', 'communityLogout', 'communityAuth', 'communityContent',
    'communityAuthStatus', 'communityFooterStatus', 'communityServer', 'communityEmail', 'communityPassword',
    'communityLoginForm', 'communityLoginSubmit', 'communityRefresh', 'friendsRefresh', 'friendSearchForm',
    'friendSearch', 'friendStatus', 'searchResults', 'friendsList', 'incomingList', 'outgoingList', 'blockedList',
    'boardRefresh', 'officialAnnouncement', 'announcementTitle', 'announcementBody', 'postForm', 'postKind',
    'postTitle', 'postBody', 'postRoomCode', 'postSubmit', 'boardStatus', 'boardPosts', 'boardMore',
  ]
  type Callback = (event: any) => void
  const elements = new Map<string, any>()
  const makeElement = (tagName: string, id?: string): any => {
    const listeners = new Map<string, Callback[]>()
    const element: any = {
      tagName: tagName.toUpperCase(), id: id || '', value: '', hidden: false, disabled: false, required: false,
      textContent: '', className: '', style: {}, dataset: {}, attributes: {}, children: [], parentNode: null,
      addEventListener(type: string, callback: Callback) {
        const list = listeners.get(type) || []
        list.push(callback)
        listeners.set(type, list)
      },
      dispatch(type: string, event: any = {}) {
        const next = { ...event, target: event.target || element, currentTarget: element }
        ;(listeners.get(type) || []).forEach(callback => callback(next))
      },
      appendChild(child: any) { child.parentNode = element; element.children.push(child); return child },
      removeChild(child: any) { element.children = element.children.filter((entry: any) => entry !== child); return child },
      replaceChildren(...children: any[]) { element.children = children; children.forEach(child => { child.parentNode = element }) },
      setAttribute(name: string, value: string) { element.attributes[name] = String(value) },
      getAttribute(name: string) { return element.attributes[name] ?? null },
      querySelector(selector: string): any {
        if (selector === 'button') {
          for (const child of element.children) {
            if (child.tagName === 'BUTTON') return child
            const nested = child.querySelector ? child.querySelector(selector) : null
            if (nested) return nested
          }
        }
        return null
      },
      focus() {},
      scrollIntoView() {},
      select() {},
      remove() { if (element.parentNode) element.parentNode.removeChild(element) },
    }
    if (id) elements.set(id, element)
    return element
  }
  ids.forEach(id => makeElement('div', id))
  ;['communityLoginForm', 'friendSearchForm', 'postForm'].forEach(id => { elements.get(id).tagName = 'FORM' })
  ;['communityLogout', 'communityRefresh', 'friendsRefresh', 'boardRefresh', 'postSubmit', 'boardMore', 'communityLoginSubmit'].forEach(id => { elements.get(id).tagName = 'BUTTON' })
  elements.get('friendSearch').tagName = 'INPUT'
  elements.get('postKind').value = 'meetup'
  elements.get('communityServer').value = origin

  let fetchImpl: (url: string, init: any) => Promise<any> = async () => response({})
  const calls: Array<{ url: string; init: any }> = []
  const sessions = new Map<string, any>()
  const local = options.officialUrl === null ? storage() : storage({ rvb_official_url: options.officialUrl || origin })
  const document: any = {
    body: makeElement('body'),
    getElementById: (id: string) => elements.get(id) || makeElement('div', id),
    createElement: (tagName: string) => makeElement(tagName),
    execCommand: () => true,
  }
  const window: any = {
    location: { origin, protocol: 'https:', hostname: 'play.redvsblue.top' },
    addEventListener() {},
    RvBUtils: {
      readOfficialSession: (url: string) => sessions.get(url) || null,
      saveOfficialSession: (session: any) => { sessions.set(session.url, session); return true },
      clearOfficialSession: (url: string) => sessions.delete(url),
      saveRemoteServerUrl() {},
    },
  }
  const context = createContext({
    window, document, localStorage: local, location: window.location, URL, AbortSignal,
    fetch: async (url: string, init: any) => { calls.push({ url, init }); return fetchImpl(url, init) },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval,
  })
  runInContext(source, context)
  return {
    window, elements, calls, sessions,
    setFetch: (next: (url: string, init: any) => Promise<any>) => { fetchImpl = next },
    flush: async () => { await new Promise(resolve => setTimeout(resolve, 0)); await Promise.resolve() },
  }
}

function authenticate(page: ReturnType<typeof harness>, token = 'token-a') {
  page.window.RvBUtils.saveOfficialSession({ url: origin, token, account: { id: 'account-a', name: '玩家 A' } })
  page.window.RvBCommunity.state.origin = origin
  page.window.RvBCommunity.state.token = token
  page.window.RvBCommunity.state.account = { id: 'account-a', name: '玩家 A' }
}

describe('RED-242 community async lifecycle', () => {
  it('opens with the official HTTPS fallback when no server URL is saved', () => {
    const page = harness({ officialUrl: null })
    expect(page.window.RvBCommunity.state.origin).toBe(origin)
    expect(page.elements.get('communityServer').value).toBe(origin)
  })

  it('retains the composer draft when publishing fails', async () => {
    const page = harness()
    authenticate(page)
    page.setFetch(async url => url.endsWith('/posts') ? response({ error: 'offline' }, 503) : response({}))
    page.elements.get('postTitle').value = '约桌标题'
    page.elements.get('postBody').value = '周末来一局'
    page.elements.get('postRoomCode').value = 'room-123'

    page.elements.get('postForm').dispatch('submit', { preventDefault() {} })
    await page.flush()

    expect(page.elements.get('postTitle').value).toBe('约桌标题')
    expect(page.elements.get('postBody').value).toBe('周末来一局')
    expect(page.elements.get('postRoomCode').value).toBe('room-123')
    expect(page.elements.get('boardStatus').textContent).toContain('offline')
  })

  it('does not render a board response that arrives after logout', async () => {
    const page = harness()
    authenticate(page)
    let resolveBoard!: (value: any) => void
    const pendingBoard = new Promise<any>(resolve => { resolveBoard = resolve })
    page.setFetch(async url => {
      if (url.includes('/board?')) return pendingBoard
      if (url.endsWith('/auth/logout')) return response({ ok: true })
      return response({})
    })

    const boardRequest = page.window.RvBCommunity.loadBoard(false)
    await page.flush()
    const logoutRequest = page.window.RvBCommunity.logout()
    await page.flush()
    resolveBoard(response({ announcement: '迟到的公告', posts: [{ id: 'late', author: { id: 'other', name: '晚到玩家' }, title: '迟到帖子', body: '不应显示' }] }))
    await Promise.all([boardRequest, logoutRequest])

    expect(page.window.RvBCommunity.state.posts).toHaveLength(0)
    expect(page.elements.get('boardPosts').children.some((child: any) => child.dataset.postId === 'late')).toBe(false)
  })

  it('keeps the newer session when an older search request returns 401', async () => {
    const page = harness()
    authenticate(page, 'token-a')
    let rejectSearch!: (value: any) => void
    const pendingSearch = new Promise<any>(resolve => { rejectSearch = resolve })
    page.setFetch(async url => url.includes('/accounts?') ? pendingSearch : response({}))
    page.elements.get('friendSearch').value = '玩家'

    const searchRequest = page.window.RvBCommunity.searchAccounts()
    await page.flush()
    page.window.RvBUtils.saveOfficialSession({ url: origin, token: 'token-b', account: { id: 'account-b', name: '玩家 B' } })
    page.window.RvBCommunity.state.token = 'token-b'
    page.window.RvBCommunity.state.account = { id: 'account-b', name: '玩家 B' }
    rejectSearch(response({ error: 'expired' }, 401))
    await searchRequest

    expect(page.sessions.get(origin).token).toBe('token-b')
    expect(page.window.RvBCommunity.state.token).toBe('token-b')
    expect(page.window.RvBCommunity.state.search).toHaveLength(0)
  })

  it('clears account-owned board and friend data before a new login', async () => {
    const page = harness()
    authenticate(page, 'token-a')
    page.window.RvBCommunity.state.friends = { friends: [{ id: 'friend-a', name: 'A 的好友' }], incoming: [], outgoing: [], blocked: [{ id: 'blocked-a', name: 'A 的屏蔽' }] }
    page.window.RvBCommunity.state.search = [{ id: 'search-a', name: 'A 的搜索' }]
    page.window.RvBCommunity.state.posts = [{ id: 'post-a', author: { id: 'account-a', name: '玩家 A' }, title: 'A 的帖子', body: '私有内容' }]
    page.window.RvBCommunity.state.replyDrafts = { 'post-a': 'A 的草稿' }
    page.elements.get('postTitle').value = 'A 的未提交标题'
    page.elements.get('postBody').value = 'A 的未提交内容'
    page.elements.get('postRoomCode').value = 'A-room'
    page.setFetch(async url => url.endsWith('/auth/logout') ? response({ ok: true }) : response({}))
    await page.window.RvBCommunity.logout()

    expect(page.window.RvBCommunity.state.friends.friends).toHaveLength(0)
    expect(page.window.RvBCommunity.state.friends.blocked).toHaveLength(0)
    expect(page.window.RvBCommunity.state.search).toHaveLength(0)
    expect(page.window.RvBCommunity.state.posts).toHaveLength(0)
    expect(Object.keys(page.window.RvBCommunity.state.replyDrafts)).toHaveLength(0)

    page.elements.get('communityEmail').value = 'b@example.com'
    page.elements.get('communityPassword').value = 'secret'
    page.setFetch(async url => {
      if (url.endsWith('/auth/login')) return response({ token: 'token-b', account: { id: 'account-b', name: '玩家 B' } })
      if (url.endsWith('/official/me')) return response({ account: { id: 'account-b', name: '玩家 B' } })
      if (url.endsWith('/official/community/heartbeat')) return response({ ok: true })
      return response({ error: 'B data unavailable' }, 503)
    })
    await page.window.RvBCommunity.login()

    expect(page.window.RvBCommunity.state.account.id).toBe('account-b')
    expect(page.window.RvBCommunity.state.friends.friends).toHaveLength(0)
    expect(page.window.RvBCommunity.state.posts).toHaveLength(0)
    expect(page.window.RvBCommunity.state.replyDrafts).toEqual({})
    expect(page.elements.get('postTitle').value).toBe('')
    expect(page.elements.get('postBody').value).toBe('')
    expect(page.elements.get('postRoomCode').value).toBe('')
  })
})
