import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

type DiscoveredServer = {
  url: string
  ip: string
  port: number
  wsPort?: number
}

type LanDiscoverApi = {
  startLanScan(options: {
    onFound?: (server: DiscoveredServer) => void
    onDone?: (servers: DiscoveredServer[]) => void
  }): { cancel(): void }
  resolveWsPort(server: DiscoveredServer): number
}

function response(ok: boolean, body: unknown) {
  return {
    ok,
    json: async () => body,
  }
}

describe('LAN server discovery', () => {
  it('discovers HTTP 3000 with its authoritative WebSocket 3001 port', async () => {
    const requests: string[] = []
    const fetch = vi.fn(async (input: string) => {
      requests.push(input)
      if (input === 'http://192.168.1.100:3000/api/ping') {
        return response(true, { name: 'RED vs BLUE Server' })
      }
      if (input === 'http://192.168.1.100:3000/api/ws-info') {
        return response(true, { wsPort: 3001 })
      }
      return response(false, {})
    })
    const browserWindow = {
      electronAPI: {
        getLanIps: async () => ['192.168.1.100'],
      },
    }
    const context = createContext({
      window: browserWindow,
      fetch,
      AbortController,
      setTimeout,
      clearTimeout,
    })
    const source = readFileSync(resolve(process.cwd(), 'data/pages/js/lan-discover.js'), 'utf8')
    new Script(source, { filename: 'lan-discover.js' }).runInContext(context)
    const api = (browserWindow as typeof browserWindow & { RvBLanDiscover: LanDiscoverApi }).RvBLanDiscover

    const found = await new Promise<DiscoveredServer[]>((resolveFound) => {
      api.startLanScan({ onDone: resolveFound })
    })

    expect(requests).toContain('http://192.168.1.100:3000/api/ws-info')
    expect(found).toContainEqual({
      url: 'http://192.168.1.100:3000',
      ip: '192.168.1.100',
      port: 3000,
      wsPort: 3001,
    })
  })

  it('keeps explicit ports and uses the desktop 3000/3001 compatibility fallback', () => {
    const browserWindow: Record<string, unknown> = {}
    const context = createContext({ window: browserWindow })
    const source = readFileSync(resolve(process.cwd(), 'data/pages/js/lan-discover.js'), 'utf8')
    new Script(source, { filename: 'lan-discover.js' }).runInContext(context)
    const api = browserWindow.RvBLanDiscover as LanDiscoverApi

    expect(api.resolveWsPort({ url: 'http://host:3000', ip: 'host', port: 3000, wsPort: 3007 })).toBe(3007)
    expect(api.resolveWsPort({ url: 'http://host:3000', ip: 'host', port: 3000 })).toBe(3001)
    expect(api.resolveWsPort({ url: 'http://host:8080', ip: 'host', port: 8080 })).toBe(8080)
  })

  it('persists the discovered WS port across reload and connects to the final 3001 URL', () => {
    const persisted = new Map<string, string>()
    const localStorage = {
      getItem(key: string) { return persisted.get(key) ?? null },
      setItem(key: string, value: string) { persisted.set(key, String(value)) },
      removeItem(key: string) { persisted.delete(key) },
    }
    const serverUtilsSource = readFileSync(resolve(process.cwd(), 'data/pages/js/server-utils.js'), 'utf8')
    const lanDiscoverSource = readFileSync(resolve(process.cwd(), 'data/pages/js/lan-discover.js'), 'utf8')
    const wsClientSource = readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8')

    const initialWindow: Record<string, unknown> = { location: { search: '' } }
    const initialContext = createContext({
      window: initialWindow,
      localStorage,
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
    })
    new Script(serverUtilsSource, { filename: 'server-utils.js' }).runInContext(initialContext)
    new Script(lanDiscoverSource, { filename: 'lan-discover.js' }).runInContext(initialContext)
    const utils = initialWindow.RvBUtils as {
      saveServerConfig(config: { mode: string; url: string; wsPort: number }): boolean
    }
    const discover = initialWindow.RvBLanDiscover as LanDiscoverApi
    const wsPort = discover.resolveWsPort({
      url: 'http://192.168.1.100:3000',
      ip: '192.168.1.100',
      port: 3000,
      wsPort: 3001,
    })
    expect(utils.saveServerConfig({ mode: 'lan', url: 'http://192.168.1.100:3000', wsPort })).toBe(true)
    expect(persisted.get('rvb_ws_port')).toBe('3001')

    const urls: string[] = []
    class FakeWebSocket {
      readyState = 0
      constructor(url: string) { urls.push(url) }
      close() {}
      send() {}
    }
    const reloadedWindow: Record<string, unknown> = { location: { search: '' } }
    const reloadedContext = createContext({
      window: reloadedWindow,
      localStorage,
      URLSearchParams,
      WebSocket: FakeWebSocket,
      setTimeout,
      clearTimeout,
      console,
    })
    new Script(serverUtilsSource, { filename: 'server-utils-reloaded.js' }).runInContext(reloadedContext)
    new Script(wsClientSource, { filename: 'ws-client.js' }).runInContext(reloadedContext)
    const ws = reloadedWindow.RvBWs as {
      connect(roomId: string, playerId: string, mode: string): void
      disconnect(): void
    }
    ws.connect('room-1', 'alice', 'lan')

    expect(urls[0]).toBe('ws://192.168.1.100:3001/ws/rooms/room-1')
    ws.disconnect()
  })

  it('probes ws-info before a direct local connection and repairs a stale HTTP port', async () => {
    const persisted = new Map<string, string>()
    const localStorage = {
      getItem(key: string) { return persisted.get(key) ?? null },
      setItem(key: string, value: string) { persisted.set(key, String(value)) },
      removeItem(key: string) { persisted.delete(key) },
    }
    const fetch = vi.fn(async (input: string) => {
      if (input === 'http://127.0.0.1:3000/api/ws-info') {
        return response(true, { wsPort: 3001 })
      }
      return response(false, {})
    })
    const urls: string[] = []
    class FakeWebSocket {
      readyState = 0
      constructor(url: string) { urls.push(url) }
      close() {}
      send() {}
    }
    const browserWindow: Record<string, unknown> = { location: { search: '' } }
    const context = createContext({
      window: browserWindow,
      localStorage,
      URLSearchParams,
      WebSocket: FakeWebSocket,
      fetch,
      AbortController,
      setTimeout,
      clearTimeout,
      console,
    })
    const serverUtilsSource = readFileSync(resolve(process.cwd(), 'data/pages/js/server-utils.js'), 'utf8')
    const wsClientSource = readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8')
    new Script(serverUtilsSource, { filename: 'server-utils.js' }).runInContext(context)
    const utils = browserWindow.RvBUtils as {
      saveServerConfig(config: { mode: string; url: string }): boolean
    }
    expect(utils.saveServerConfig({ mode: 'local', url: 'http://127.0.0.1:3000' })).toBe(true)
    expect(persisted.has('rvb_ws_port')).toBe(false)
    persisted.set('rvb_ws_port', '3000')

    new Script(wsClientSource, { filename: 'ws-client.js' }).runInContext(context)
    const ws = browserWindow.RvBWs as {
      connect(roomId: string, playerId: string, mode: string): void
      disconnect(): void
    }
    ws.connect('__lobby', 'alice', 'lan')

    await vi.waitFor(() => expect(urls[0]).toBe('ws://127.0.0.1:3001/ws/rooms/__lobby'))
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3000/api/ws-info', expect.any(Object))
    expect(persisted.get('rvb_ws_port')).toBe('3001')
    ws.disconnect()
  })
})
