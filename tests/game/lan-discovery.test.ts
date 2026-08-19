import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

type DiscoveredServer = {
  url: string
  ip: string
  port: number
}

type LanDiscoverApi = {
  startLanScan(options: {
    onFound?: (server: DiscoveredServer) => void
    onDone?: (servers: DiscoveredServer[]) => void
  }): { cancel(): void }
}

function response(ok: boolean, body: unknown) {
  return { ok, json: async () => body }
}

describe('LAN single-origin discovery', () => {
  it('discovers one public server URL and never probes a WebSocket port API', async () => {
    const requests: string[] = []
    const fetch = vi.fn(async (input: string) => {
      requests.push(input)
      if (input === 'http://192.168.1.100:7878/api/ping') {
        return response(true, { name: 'RED vs BLUE Server' })
      }
      return response(false, {})
    })
    const browserWindow = {
      electronAPI: { getLanIps: async () => ['192.168.1.24'] },
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

    const found = await new Promise<DiscoveredServer[]>(resolveFound => {
      api.startLanScan({ onDone: resolveFound })
    })

    expect(found).toEqual([{
      url: 'http://192.168.1.100:7878',
      ip: '192.168.1.100',
      port: 7878,
    }])
    expect(requests).toContain('http://192.168.1.100:7878/api/ping')
    expect(requests.every(url => url.endsWith('/api/ping'))).toBe(true)
    expect(requests.some(url => url.includes('/api/ws-info'))).toBe(false)
    expect(found[0]).not.toHaveProperty('wsPort')
  })

  it('keeps desktop and Android discovery logic identical and free of split-port fallbacks', () => {
    const desktop = readFileSync(resolve(process.cwd(), 'data/pages/js/lan-discover.js'), 'utf8')
    const android = readFileSync(resolve(process.cwd(), 'android-client/www/js/lan-discover.js'), 'utf8')

    expect(android).toBe(desktop)
    expect(desktop).not.toContain('/api/ws-info')
    expect(desktop).not.toContain('resolveWsPort')
    expect(desktop).not.toContain('3001')
    expect(desktop).not.toContain('wsPort')
  })
})
