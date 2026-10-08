/* eslint-disable @typescript-eslint/no-explicit-any -- VM harness models browser lifecycle APIs. */
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const source = readFileSync('data/pages/js/server-utils.js', 'utf8')
const route = '/official/community/heartbeat'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
  removeItem(key: string) { this.values.delete(key) }
}

function answer(body: any = { ok: true }, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

function harness(localStorage = new MemoryStorage(), sessionStorage = new MemoryStorage()) {
  const documentListeners = new Map<string, Array<() => void>>()
  const windowListeners = new Map<string, Array<() => void>>()
  const intervals = new Map<number, () => void>()
  const calls: Array<{ url: string; init: any }> = []
  const events: any[] = []
  let nextTimer = 1
  let fetchImpl: (url: string, init: any) => Promise<any> = async () => answer()
  const document: any = {
    nodeType: 9,
    readyState: 'loading',
    documentElement: {},
    addEventListener(type: string, callback: () => void) {
      const list = documentListeners.get(type) || []
      list.push(callback)
      documentListeners.set(type, list)
    },
    dispatch(type: string) { (documentListeners.get(type) || []).slice().forEach(callback => callback()) },
  }
  const window: any = {
    localStorage,
    sessionStorage,
    location: { search: '' },
    addEventListener(type: string, callback: () => void) {
      const list = windowListeners.get(type) || []
      list.push(callback)
      windowListeners.set(type, list)
    },
    dispatchEvent(event: any) { events.push(event); return true },
    dispatch(type: string) { (windowListeners.get(type) || []).slice().forEach(callback => callback()) },
  }
  const context = createContext({
    window, document, localStorage, sessionStorage, URLSearchParams, URL, AbortController,
    CustomEvent: class TestCustomEvent { type: string; detail: any; constructor(type: string, init: any) { this.type = type; this.detail = init.detail } },
    fetch: async (url: string, init: any) => { calls.push({ url, init }); return fetchImpl(url, init) },
    setTimeout, clearTimeout,
    setInterval: (callback: () => void) => { const id = nextTimer++; intervals.set(id, callback); return id },
    clearInterval: (id: number) => { intervals.delete(id) },
  })
  new Script(source).runInContext(context)
  return {
    window, document, calls, intervals, events,
    setFetch: (next: (url: string, init: any) => Promise<any>) => { fetchImpl = next },
    triggerPage: () => document.dispatch('DOMContentLoaded'),
    triggerHeartbeat: () => { intervals.forEach(callback => callback()) },
    triggerPagehide: () => window.dispatch('pagehide'),
    flush: async () => { await new Promise(resolve => setTimeout(resolve, 0)); await Promise.resolve(); await Promise.resolve() },
  }
}

function saveSession(page: ReturnType<typeof harness>, origin: string, token: string) {
  page.window.RvBUtils.saveOfficialSession({ url: origin, token, account: { id: 'account-1', name: '玩家' } })
  page.window.localStorage.setItem('rvb_official_url', origin)
}

describe('shared official community presence', () => {
  it('starts on a real DOM lifecycle, avoids overlap, and stops on pagehide', async () => {
    const page = harness()
    const first = deferred<any>()
    page.setFetch(async () => page.calls.length === 1 ? first.promise : answer())
    saveSession(page, 'https://play.example', 'token-a')

    page.triggerPage()
    expect(page.calls).toHaveLength(1)
    expect(page.calls[0].url).toBe('https://play.example' + route)
    expect(page.calls[0].init.method).toBe('POST')
    expect(page.calls[0].init.headers.Authorization).toBe('Bearer token-a')
    expect(page.calls[0].init.body).toBe('{}')

    page.triggerHeartbeat()
    expect(page.calls).toHaveLength(1)
    first.resolve(answer())
    await page.flush()
    page.triggerHeartbeat()
    expect(page.calls).toHaveLength(2)
    page.triggerPagehide()
    expect(page.intervals.size).toBe(0)
    page.triggerHeartbeat()
    expect(page.calls).toHaveLength(2)
  })

  it('carries the same canonical session across pages and stops the old page', async () => {
    const local = new MemoryStorage()
    const session = new MemoryStorage()
    const battle = harness(local, session)
    saveSession(battle, 'https://play.example', 'token-a')
    battle.setFetch(async () => answer())
    battle.triggerPage()
    await battle.flush()
    battle.triggerPagehide()

    const lobby = harness(local, session)
    lobby.setFetch(async () => answer())
    lobby.triggerPage()
    await lobby.flush()
    expect(battle.calls).toHaveLength(1)
    expect(lobby.calls).toHaveLength(1)
    expect(lobby.calls[0].init.headers.Authorization).toBe('Bearer token-a')
  })

  it('starts presence when an already loaded page receives a new canonical login', async () => {
    const page = harness()
    const loginOrigin = 'https://login.example'
    page.window.localStorage.setItem('rvb_official_url', loginOrigin)
    page.setFetch(async () => answer())

    page.window.RvBUtils.saveOfficialSession({ url: loginOrigin, token: 'token-login', account: { id: 'account-login' } })
    await page.flush()

    expect(page.calls).toHaveLength(1)
    expect(page.calls[0].url).toBe(loginOrigin + route)
    expect(page.calls[0].init.headers.Authorization).toBe('Bearer token-login')
  })

  it('stops presence immediately when the active session is cleared', async () => {
    const page = harness()
    saveSession(page, 'https://play.example', 'token-a')
    page.setFetch(async () => answer())
    page.triggerPage()
    await page.flush()

    page.window.RvBUtils.clearOfficialSession('https://play.example')
    expect(page.intervals.size).toBe(0)
    page.triggerHeartbeat()
    expect(page.calls).toHaveLength(1)
  })

  it('does not clear a newer token when an older heartbeat returns 401', async () => {
    const page = harness()
    const first = deferred<any>()
    page.setFetch(async () => page.calls.length === 1 ? first.promise : answer())
    saveSession(page, 'https://play.example', 'old-token')
    page.triggerPage()
    page.window.RvBUtils.saveOfficialSession({ url: 'https://play.example', token: 'new-token', account: { id: 'account-2' } })
    first.resolve(answer({ error: 'expired' }, 401))
    await page.flush()

    expect(page.window.RvBUtils.readOfficialSession('https://play.example').token).toBe('new-token')
    page.triggerHeartbeat()
    await page.flush()
    expect(page.calls[1].init.headers.Authorization).toBe('Bearer new-token')
  })

  it('keeps offline use quiet on network failure and disables unsupported servers for the page', async () => {
    const offline = harness()
    saveSession(offline, 'https://offline.example', 'token-a')
    offline.setFetch(async () => { throw new TypeError('network down') })
    offline.triggerPage()
    await offline.flush()
    offline.triggerHeartbeat()
    expect(offline.calls).toHaveLength(1)
    expect(offline.window.RvBUtils.readOfficialSession('https://offline.example').token).toBe('token-a')
    expect(offline.events[0].detail.status).toBe('failure')

    const unsupported = harness()
    saveSession(unsupported, 'https://old.example', 'token-a')
    unsupported.setFetch(async () => answer({ error: 'missing' }, 404))
    unsupported.triggerPage()
    await unsupported.flush()
    unsupported.triggerHeartbeat()
    expect(unsupported.calls).toHaveLength(1)
    expect(unsupported.window.RvBUtils.readOfficialSession('https://old.example').token).toBe('token-a')
  })

  it('allows a new origin after an unsupported server is disabled', async () => {
    const page = harness()
    saveSession(page, 'https://old.example', 'token-a')
    page.setFetch(async url => url.startsWith('https://old.example') ? answer({ error: 'missing' }, 404) : answer())
    page.triggerPage()
    await page.flush()
    page.window.RvBUtils.saveOfficialSession({ url: 'https://new.example', token: 'token-b', account: { id: 'account-2' } })
    page.window.localStorage.setItem('rvb_official_url', 'https://new.example')
    expect(await page.window.RvBUtils.startOfficialPresence()).toBe(true)
    expect(page.calls[1].url).toBe('https://new.example' + route)
  })

  it('uses the explicitly selected origin when it differs from the saved default', async () => {
    const page = harness()
    saveSession(page, 'https://old.example', 'token-a')
    page.window.RvBUtils.saveOfficialSession({ url: 'https://selected.example', token: 'token-b', account: { id: 'account-2' } })
    page.setFetch(async () => answer())

    expect(await page.window.RvBUtils.startOfficialPresence('https://selected.example', 'token-b')).toBe(true)
    expect(page.calls).toHaveLength(1)
    expect(page.calls[0].url).toBe('https://selected.example' + route)
    expect(page.calls[0].init.headers.Authorization).toBe('Bearer token-b')

    page.window.RvBUtils.saveOfficialSession({ url: 'https://selected.example', token: 'token-c', account: { id: 'account-3' } })
    page.triggerHeartbeat()
    await page.flush()
    expect(page.calls[1].url).toBe('https://selected.example' + route)
    expect(page.calls[1].init.headers.Authorization).toBe('Bearer token-c')
  })

  it('never sends bearer credentials to an unsafe remote HTTP or credentialed origin', async () => {
    const remoteHttp = harness()
    saveSession(remoteHttp, 'http://remote.example', 'token-a')
    remoteHttp.triggerPage()
    expect(remoteHttp.calls).toHaveLength(0)

    const credentialed = harness()
    saveSession(credentialed, 'https://user:pass@example.com', 'token-a')
    credentialed.triggerPage()
    expect(credentialed.calls).toHaveLength(0)

    const loopback = harness()
    saveSession(loopback, 'http://127.0.0.1:38843', 'token-a')
    loopback.setFetch(async () => answer())
    loopback.triggerPage()
    await loopback.flush()
    expect(loopback.calls[0].url).toBe('http://127.0.0.1:38843' + route)
  })
})
