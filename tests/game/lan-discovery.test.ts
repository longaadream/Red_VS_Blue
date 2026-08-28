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

describe('LAN single-origin discovery', () => {
  it('discovers one public server URL through WebSocket health only', async () => {
    const requests: { url: string; method: string }[] = []
    const requestAt = vi.fn(async (url: string, method: string) => {
      requests.push({ url, method })
      if (url === 'http://192.168.1.100:7878' && method === 'system.health') {
        return { protocol: 'rvb-ws' }
      }
      throw new Error('unreachable')
    })
    const browserWindow = {
      electronAPI: { getLanIps: async () => ['192.168.1.24'] },
    }
    const context = createContext({
      window: browserWindow,
      RvBWs: { requestAt },
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
    expect(requests).toContainEqual({
      url: 'http://192.168.1.100:7878',
      method: 'system.health',
    })
    expect(requests.every(request => request.method === 'system.health')).toBe(true)
    expect(requestAt).toHaveBeenCalled()
    expect(found[0]).not.toHaveProperty('wsPort')
  })

  it('keeps Windows discovery free of HTTP and split-port fallbacks', () => {
    const desktop = readFileSync(resolve(process.cwd(), 'data/pages/js/lan-discover.js'), 'utf8')

    expect(desktop).toContain("RvBWs.requestAt(url, 'system.health'")
    expect(desktop).not.toContain('/api/ws-info')
    expect(desktop).not.toContain('resolveWsPort')
    expect(desktop).not.toContain('3001')
    expect(desktop).not.toContain('wsPort')
    expect(desktop).not.toContain('fetch(')
  })
})
