import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const script = readFileSync('scripts/server-admin/ui.js', 'utf8')

type FakeElement = {
  value: string
  textContent: string
  hidden: boolean
  checked: boolean
  disabled: boolean
  dataset: Record<string, string>
  lastChild?: { textContent: string }
  listeners: Record<string, () => unknown>
  addEventListener(type: string, callback: () => unknown): void
  focus(): void
}

function element(value = ''): FakeElement {
  const result: FakeElement = {
    value, textContent: '', hidden: false, checked: false, disabled: false, dataset: {}, listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback },
    focus() {},
  }
  result.lastChild = { textContent: '' }
  return result
}

describe('RED-248 server administration browser behavior', () => {
  it('restores only the safe connection fields from local status and local storage', async () => {
    const ids = ['host', 'port', 'user', 'key', 'service', 'database', 'directory', 'release', 'panelPort', 'panelToken', 'maintenance', 'state', 'tool-version', 'tool-connection', 'footer-service', 'notice', 'output', 'log-time', 'panel-link']
    const nodes = new Map(ids.map(id => [id, element()]))
    nodes.get('state')!.lastChild = { textContent: '' }
    const action = element('查看状态与版本'); action.dataset.action = 'status'
    const section = element(); section.dataset.opsSection = 'connection'
    const storage = new Map<string, string>()
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe('/api/local-status')
      return { ok: true, text: async () => JSON.stringify({ toolVersion: 'RED-248.1', connected: false, connection: { host: 'server.test', port: '22', user: 'admin', key: 'C:/key', service: 'rvb-game', database: 'rvb' } }) }
    })
    const context = {
      document: {
        getElementById: (id: string) => nodes.get(id),
        querySelectorAll: (selector: string) => selector === '[data-action]' ? [action] : selector === '[data-ops-section]' ? [section] : selector === 'button' ? [action] : [],
      },
      location: { hash: '#session-token', pathname: '/ops' },
      history: { replaceState: vi.fn() },
      sessionStorage: { getItem: () => null, setItem: vi.fn() },
      localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) },
      fetch, window: { confirm: () => true, location: { assign: vi.fn() } },
      AbortSignal, Date, JSON, Object, Error, String, Boolean, Map,
    }
    vm.runInNewContext(script, context)
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(nodes.get('host')!.value).toBe('server.test')
    expect(nodes.get('database')!.value).toBe('rvb')
    expect(nodes.get('tool-version')!.textContent).toBe('工具版本 RED-248.1')
    expect(storage.get('rvb-server-admin.connection.v1')).not.toContain('session-token')
    expect(storage.get('rvb-server-admin.connection.v1')).not.toContain('panelToken')
    expect(context).not.toHaveProperty('$')
    expect(context).not.toHaveProperty('token')
  })

  it('keeps the embedded script isolated and posts an operation through the current session', async () => {
    const ids = ['remote-ops', 'ops-host', 'ops-port', 'ops-user', 'ops-key', 'ops-service', 'ops-database', 'ops-directory', 'ops-release', 'ops-panelPort', 'ops-panelToken', 'ops-maintenance', 'ops-state', 'ops-tool-version', 'ops-notice', 'ops-output', 'ops-log-time']
    const nodes = new Map(ids.map(id => [id, element()]))
    const ops = nodes.get('remote-ops')!; ops.dataset.opsSection = 'remote-ops'
    const action = element('查看状态与版本'); action.dataset.action = 'status'
    delete action.dataset.action; action.dataset.opsAction = 'status'
    const storage = new Map<string, string>()
    const responses = [
      JSON.stringify({ toolVersion: 'RED-248.1', connected: false, connection: null }),
      JSON.stringify({ output: 'rvb-game active\nversion candidate-test' }),
    ]
    const fetch = vi.fn(async () => ({ ok: true, text: async () => responses.shift()! }))
    const context = {
      document: {
        getElementById: (id: string) => nodes.get(id),
        querySelectorAll: (selector: string) => selector === '[data-ops-action]' ? [action] : selector === '[data-view="remote-ops"]' ? [] : selector === '[data-ops-section]' ? [ops] : selector === 'button' ? [action] : [],
      },
      location: { hash: '#session-token', pathname: '/ops' },
      history: { replaceState: vi.fn() },
      sessionStorage: { getItem: () => null, setItem: vi.fn() },
      localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) },
      fetch, window: { confirm: () => true, location: { assign: vi.fn() } },
      AbortSignal, Date, JSON, Object, Error, String, Boolean, Map,
    }
    vm.runInNewContext(script, context)
    await new Promise(resolve => setTimeout(resolve, 0))
    await action.listeners.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).toHaveBeenCalledTimes(2)
    const secondCall = fetch.mock.calls[1] as unknown as [string, { body: string; headers: { Authorization: string } }]
    expect(JSON.parse(secondCall[1].body).action).toBe('status')
    expect(secondCall[1].headers.Authorization).toBe('Bearer session-token')
    expect(nodes.get('ops-output')!.textContent).toContain('rvb-game active')
  })
})
