/* eslint-disable @typescript-eslint/no-explicit-any -- VM harness models dynamically populated browser elements and callbacks. */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'

function harness() {
  const nodes: Record<string, any> = {}
  const values = new Map<string, string>()
  const sessions = new Map<string, any>()
  const requests: any[] = []
  const node = (id: string) => nodes[id] ||= { value: '', addEventListener() {}, showModal() {}, close() {}, style: {} }
  const context = createContext({
    document: { getElementById: node }, URL, URLSearchParams, AbortSignal,
    localStorage: { getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v) },
    fetch: async (url: string, options: any) => {
      requests.push({ url, ...options })
      return { ok: true, json: async () => ({ token: 'server-token', account: { id: 'account-1', name: '服务器玩家' } }) }
    },
    window: {
      addEventListener() {}, location: {},
      RvBIdentity: { getIdentity: () => ({ displayName: '游客' }), setDisplayName() {} },
      RvBUtils: {
        readOfficialSession: (url: string) => sessions.get(url),
        saveOfficialSession: (s: any) => { sessions.set(s.url, s); return true },
        clearOfficialSession: (url: string) => sessions.delete(url), saveRemoteServerUrl() {},
      },
    },
  })
  runInContext(readFileSync('data/pages/js/home-account.js', 'utf8'), context)
  return { context, node, sessions, requests }
}

it('opens server login instead of exposing mnemonic accounts', () => {
  const { context, node } = harness()
  runInContext('window.RvBHomeAccount.open()', context)
  expect(node('userName').textContent).toBe('登录账号')
  expect(node('homeAccountServer').value).toBe('https://play.redvsblue.top')
  expect(node('homeGuestName').value).toBe('游客')
  const page = readFileSync('data/pages/index.html', 'utf8')
  expect(page).not.toMatch(/查看助记词|导入玩家|新建玩家|importFromMnemonic|getMnemonic/)
})

it('logs in with the shared server session and isolates a different server', async () => {
  const { context, node, sessions, requests } = harness()
  runInContext('window.RvBHomeAccount.open()', context)
  node('homeAccountEmail').value = 'player@example.com'
  node('homeAccountPassword').value = 'password'
  node('homeLoginForm').onsubmit({ preventDefault() {} })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(requests[0].url).toBe('https://play.redvsblue.top/official/auth/login')
  expect(sessions.get('https://play.redvsblue.top').account.id).toBe('account-1')
  expect(node('userName').textContent).toBe('服务器玩家')
  expect(node('homeAccountPassword').value).toBe('')
  node('homeAccountServer').value = 'https://other.example'
  node('homeAccountServer').onchange()
  expect(node('homeLoginFields').hidden).toBe(false)
})

it('rejects insecure remote login before sending credentials', async () => {
  const { node, requests } = harness()
  node('homeAccountServer').value = 'http://remote.example'
  node('homeLoginForm').onsubmit({ preventDefault() {} })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(requests).toHaveLength(0)
  expect(node('homeAccountStatus').textContent).toContain('HTTPS')
})

it('allows local logout and another login even when the server is unreachable', async () => {
  const { context, node, sessions } = harness()
  sessions.set('https://play.redvsblue.top', { token: 'expired', account: { name: '旧账号' } })
  runInContext('window.RvBHomeAccount.open(); fetch = async function () { throw new Error("网络不可用") }', context)
  node('homeLogout').onclick()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sessions.has('https://play.redvsblue.top')).toBe(false)
  expect(node('homeLoginFields').hidden).toBe(false)
  expect(node('userName').textContent).toBe('登录账号')
})
