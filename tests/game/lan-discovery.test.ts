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
  it('discovers one public Colyseus server URL through HTTP health', async () => {
    const requests: { url: string; method: string }[] = []
    const requestAt = vi.fn(async (url: string, method: string) => {
      requests.push({ url, method })
      if (url === 'http://192.168.1.100:38621' && method === 'system.health') {
        return { ok: true, protocol: 'rvb-colyseus' }
      }
      throw new Error('unreachable')
    })
    const browserWindow = {
      electronAPI: { getLanIps: async () => ['192.168.1.24'] },
    }
    const context = createContext({
      window: browserWindow,
      RvBColyseus: { requestAt },
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
      url: 'http://192.168.1.100:38621',
      ip: '192.168.1.100',
      port: 38621,
    }])
    expect(requests).toContainEqual({
      url: 'http://192.168.1.100:38621',
      method: 'system.health',
    })
    expect(requests.every(request => request.method === 'system.health')).toBe(true)
    expect(requestAt).toHaveBeenCalled()
    expect(found[0]).not.toHaveProperty('wsPort')
  })

  it('uses only the Colyseus HTTP health origin without legacy split-port fallbacks', () => {
    const desktop = readFileSync(resolve(process.cwd(), 'data/pages/js/lan-discover.js'), 'utf8')

    expect(desktop).toContain("RvBColyseus.requestAt(url, 'system.health'")
    expect(desktop).not.toContain('/api/ws-info')
    expect(desktop).not.toContain('resolveWsPort')
    expect(desktop).not.toContain('3001')
    expect(desktop).not.toContain('wsPort')
    expect(desktop).not.toContain("protocol !== 'rvb-ws'")
  })
})
