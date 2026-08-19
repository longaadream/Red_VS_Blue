import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

function loadBrowserNetworking(options: {
  search?: string
  stored?: Record<string, string>
  serverUrl: string
}) {
  const persisted = new Map<string, string>(Object.entries(options.stored || {}))
  const localStorage = {
    getItem(key: string) { return persisted.get(key) ?? null },
    setItem(key: string, value: string) { persisted.set(key, String(value)) },
    removeItem(key: string) { persisted.delete(key) },
  }
  const urls: string[] = []
  class FakeWebSocket {
    readyState = 0
    constructor(url: string) { urls.push(url) }
    close() {}
    send() {}
  }
  const browserWindow: Record<string, unknown> = {
    location: { search: options.search || '' },
  }
  const context = createContext({
    window: browserWindow,
    localStorage,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    fetch: vi.fn(() => { throw new Error('single-port clients must not probe ws-info') }),
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  })
  new Script(
    readFileSync(resolve(process.cwd(), 'data/pages/js/server-utils.js'), 'utf8'),
    { filename: 'server-utils.js' },
  ).runInContext(context)
  const utils = browserWindow.RvBUtils as {
    saveServerConfig(config: Record<string, unknown>): boolean
    getConnectionConfig(): Record<string, unknown>
    appendServerParams(params: URLSearchParams): URLSearchParams
  }
  expect(utils.saveServerConfig({
    mode: 'lan',
    url: options.serverUrl,
    wsPort: 6553,
  })).toBe(true)
  new Script(
    readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8'),
    { filename: 'ws-client.js' },
  ).runInContext(context)
  const ws = browserWindow.RvBWs as {
    connect(roomId: string, playerId: string, mode: string): void
    disconnect(): void
  }
  return { persisted, urls, utils, ws }
}

describe('public single-port networking contract', () => {
  it.each([
    { serverUrl: 'http://127.0.0.1:4200', expected: 'ws://127.0.0.1:4200/ws/rooms/__lobby' },
    { serverUrl: 'http://192.168.1.20:8080', expected: 'ws://192.168.1.20:8080/ws/rooms/__lobby' },
    { serverUrl: 'https://relay.example:8443', expected: 'wss://relay.example:8443/ws/rooms/__lobby' },
  ])('derives the only WebSocket target from $serverUrl', ({ serverUrl, expected }) => {
    const fixture = loadBrowserNetworking({
      serverUrl,
      search: '?wsPort=6554&ws_port=6555',
      stored: {
        rvb_ws_port: '6556',
        rvb_ws_port_server_url: serverUrl,
        rvb_ws_port_source: 'legacy',
      },
    })

    fixture.ws.connect('__lobby', 'alice', serverUrl.includes('relay') ? 'relay' : 'lan')

    expect(fixture.urls).toEqual([expected])
    expect(fixture.utils.getConnectionConfig()).not.toHaveProperty('wsPort')
    expect(fixture.utils.appendServerParams(new URLSearchParams()).has('wsPort')).toBe(false)
    expect(fixture.persisted.has('rvb_ws_port')).toBe(false)
    expect(fixture.persisted.has('rvb_ws_port_server_url')).toBe(false)
    expect(fixture.persisted.has('rvb_ws_port_source')).toBe(false)
    fixture.ws.disconnect()
  })

  it('contains no runtime second-port discovery or fallback path', () => {
    const source = readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8')
    expect(source).not.toContain('/api/ws-info')
    expect(source).not.toContain('basePort + 1')
    expect(source).not.toContain("var _wsPort = 3001")
    expect(source).not.toContain('readConfiguredWsPort')
    expect(source).not.toContain('setWsPort')
  })
})
