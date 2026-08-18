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
})
