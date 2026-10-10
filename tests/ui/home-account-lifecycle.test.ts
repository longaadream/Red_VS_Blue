/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type -- browser VM harness. */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

import { expect, it } from 'vitest'

const source = readFileSync('data/pages/js/home-account.js', 'utf8')
const origin = 'https://play.redvsblue.top'

function storage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial || {}))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    has: (key: string) => values.has(key),
  }
}

function harness(options: { marker?: string; session?: any; local?: any; sessionStorage?: any; updateOpen?: boolean; delayedUpdate?: boolean; fetch?: (url: string, init: any) => Promise<any> } = {}) {
  const ids = ['userName', 'userDot', 'communityStatus', 'homeAccountServer', 'homeAccountStatus', 'homeLoginFields', 'homeLogout', 'homeCommunityRetry', 'homeAccountEmail', 'homeAccountPassword', 'homeLoginSubmit', 'homeAccountManage', 'homeGuestName', 'homeGuestSave', 'homeAccountClose', 'homeLoginForm', 'accountDialog']
  const nodes = new Map<string, any>()
  const documentListeners = new Map<string, Function[]>()
  const makeNode = (id: string) => {
    const listeners = new Map<string, Function[]>()
    const value: any = { id, value: '', hidden: false, required: false, disabled: false, textContent: '', style: {}, open: false, showCount: 0, addEventListener(type: string, callback: Function) { const list = listeners.get(type) || []; list.push(callback); listeners.set(type, list) }, showModal() { value.open = true; value.showCount += 1 }, close() { value.open = false; (listeners.get('close') || []).forEach(callback => callback()) }, focus() {} }
    nodes.set(id, value)
    return value
  }
  ids.forEach(makeNode)
  nodes.get('homeAccountServer').value = origin
  const updateDialog = makeNode('officialUpdate')
  updateDialog.open = options.updateOpen === true
  const local = options.local || storage()
  const tab = options.sessionStorage || storage()
  const sessions = new Map<string, any>()
  if (options.session) sessions.set(origin, options.session)
  const calls: Array<{ url: string; init: any }> = []
  const timers: Function[] = []
  const fetchImpl = options.fetch || (async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith('/official/me') ? { account: { id: 'account-1', name: '服务器玩家' } } : { ok: true } }))
  const document: any = {
    getElementById: (id: string) => nodes.get(id) || makeNode(id),
    querySelector: (selector: string) => selector === 'dialog[open]' ? (updateDialog.open ? updateDialog : [...nodes.values()].find(node => node.open) || null) : null,
    addEventListener: (type: string, callback: Function) => { const list = documentListeners.get(type) || []; list.push(callback); documentListeners.set(type, list) },
  }
  let releaseUpdate: ((value: any) => void) | undefined
  const window: any = {
    location: {},
    sessionStorage: tab,
    electronAPI: {
      getCommunityLaunchId: () => options.marker || 'a'.repeat(32),
      ...(options.delayedUpdate ? { getOfficialUpdateStatus: () => new Promise(resolve => { releaseUpdate = resolve }) } : {}),
    },
    addEventListener() {},
    RvBIdentity: { getIdentity: () => ({ displayName: '游客' }), setDisplayName() {} },
    RvBUtils: {
      readOfficialSession: (url: string) => sessions.get(url) || null,
      saveOfficialSession: (session: any) => { sessions.set(session.url, session); return true },
      clearOfficialSession: (url: string) => sessions.delete(url),
      saveRemoteServerUrl() {},
    },
  }
  const context = createContext({ window, document, localStorage: local, sessionStorage: tab, URL, AbortSignal, setTimeout, clearTimeout, setInterval: (callback: Function) => { timers.push(callback); return timers.length }, clearInterval() {}, fetch: async (url: string, init: any) => { calls.push({ url, init }); return fetchImpl(url, init) }, location: { protocol: 'file:', hostname: '', origin: '' } })
  runInContext(source, context)
  return {
    context, nodes, sessions, calls, local, tab, updateDialog,
    releaseUpdate: (value: any) => releaseUpdate?.(value),
    fireClose: () => (documentListeners.get('close') || []).forEach(callback => callback()),
    flush: async () => { await new Promise(resolve => setTimeout(resolve, 0)); await Promise.resolve() },
  }
}

it('prompts once per launch marker, survives same-launch reload, and prompts on a new launch', async () => {
  const local = storage()
  const first = harness({ marker: 'a'.repeat(32), local })
  await first.flush()
  expect(first.nodes.get('accountDialog').showCount).toBe(1)

  const reload = harness({ marker: 'a'.repeat(32), local })
  await reload.flush()
  expect(reload.nodes.get('accountDialog').showCount).toBe(0)

  const next = harness({ marker: 'b'.repeat(32), local })
  await next.flush()
  expect(next.nodes.get('accountDialog').showCount).toBe(1)
})

it('waits for the update dialog before opening the closable login prompt', async () => {
  const page = harness({ marker: 'c'.repeat(32), updateOpen: true })
  await page.flush()
  expect(page.nodes.get('accountDialog').showCount).toBe(0)
  page.updateDialog.open = false
  page.fireClose()
  await page.flush()
  expect(page.nodes.get('accountDialog').showCount).toBe(1)
})

it('waits for delayed update status before deciding whether to prompt', async () => {
  const page = harness({ marker: 'i'.repeat(32), delayedUpdate: true })
  await page.flush()
  expect(page.nodes.get('accountDialog').showCount).toBe(0)
  page.updateDialog.open = true
  page.releaseUpdate({ startupPending: true })
  await page.flush()
  expect(page.nodes.get('accountDialog').showCount).toBe(0)
  page.updateDialog.open = false
  page.fireClose()
  await page.flush()
  expect(page.nodes.get('accountDialog').showCount).toBe(1)
})

it('authenticates a stored session once and heartbeats the community endpoint', async () => {
  const page = harness({ marker: 'd'.repeat(32), session: { url: origin, token: 'valid', account: { id: 'account-1', name: '旧名字' } } })
  await page.flush()
  expect(page.calls.map(call => call.url)).toEqual([origin + '/official/me', origin + '/official/community/heartbeat'])
  expect(page.nodes.get('userName').textContent).toBe('服务器玩家')
})

it('clears only the current session after a 401 and keeps it on network failure', async () => {
  const expired = harness({ marker: 'e'.repeat(32), session: { url: origin, token: 'expired', account: { id: 'account-1', name: '过期账号' } }, fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: 'expired' }) }) })
  await expired.flush()
  expect(expired.sessions.has(origin)).toBe(false)
  const offline = harness({ marker: 'f'.repeat(32), session: { url: origin, token: 'offline', account: { id: 'account-1', name: '离线账号' } }, fetch: async () => { throw new Error('network down') } })
  await offline.flush()
  expect(offline.sessions.has(origin)).toBe(true)
  expect(offline.nodes.get('communityStatus').textContent).toContain('服务器暂时不可用')
})

it('does not clear or overwrite a newer session when logout returns late', async () => {
  let releaseLogout: ((value: any) => void) | undefined
  const page = harness({
    marker: 'g'.repeat(32),
    session: { url: origin, token: 'old-token', account: { id: 'account-1', name: '旧账号' } },
    fetch: async (url: string) => url.endsWith('/official/auth/logout')
      ? new Promise(resolve => { releaseLogout = resolve })
      : { ok: true, status: 200, json: async () => url.endsWith('/official/me') ? { account: { id: 'account-1', name: '旧账号' } } : { ok: true } },
  })
  await page.flush()
  runInContext('window.RvBHomeAccount.logout()', page.context)
  await page.flush()
  page.sessions.set(origin, { url: origin, token: 'new-token', account: { id: 'account-2', name: '新账号' } })
  releaseLogout?.({ ok: true, status: 200, json: async () => ({ ok: true }) })
  await page.flush()

  expect(page.sessions.get(origin).token).toBe('new-token')
  expect(page.nodes.get('userName').textContent).toBe('新账号')
  expect(page.nodes.get('homeAccountStatus').textContent).not.toBe('已退出，可继续离线游玩')
})

it('offers an explicit reconnect after stored-session auto-connect fails', async () => {
  const page = harness({ marker: 'h'.repeat(32), session: { url: origin, token: 'offline', account: { id: 'account-1', name: '离线账号' } }, fetch: async () => { throw new Error('network down') } })
  await page.flush()
  expect(page.nodes.get('homeCommunityRetry').hidden).toBe(false)
  expect(page.calls).toHaveLength(1)
  page.nodes.get('homeCommunityRetry').onclick()
  await page.flush()
  expect(page.calls).toHaveLength(2)
  expect(page.sessions.has(origin)).toBe(true)
})

it('keeps an explicit reconnect on the selected server', async () => {
  const selected = 'https://selected.example'
  const page = harness({
    marker: 'j'.repeat(32),
    session: { url: origin, token: 'token-a', account: { id: 'account-1', name: '账号 A' } },
    fetch: async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url.startsWith(selected) ? { account: { id: 'account-2', name: '账号 B' } } : { account: { id: 'account-1', name: '账号 A' } },
    }),
  })
  await page.flush()
  page.local.setItem('rvb_official_url', origin)
  page.sessions.set(selected, { url: selected, token: 'token-b', account: { id: 'account-2', name: '账号 B' } })
  page.nodes.get('homeAccountServer').value = selected
  page.nodes.get('homeAccountServer').onchange()
  page.nodes.get('homeCommunityRetry').onclick()
  await page.flush()

  expect(page.local.getItem('rvb_official_url')).toBe(selected)
  expect(page.calls.some(call => call.url === selected + '/official/me')).toBe(true)
  expect(page.calls.some(call => call.url === selected + '/official/community/heartbeat')).toBe(true)
  expect(page.nodes.get('userName').textContent).toBe('账号 B')
})
