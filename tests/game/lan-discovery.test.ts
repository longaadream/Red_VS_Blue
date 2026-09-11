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
    onProgress?: (done: number, total: number) => void
  }): { cancel(): void }
}

describe('LAN single-origin discovery', () => {
  it('does not publish an old batch after cancelling a scan', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const onFound = vi.fn(), onProgress = vi.fn(), onDone = vi.fn()
    const requestAt = vi.fn(async () => { await waiting; return { ok: true, protocol: 'rvb-colyseus' } })
    const window = { electronAPI: { getLanIps: async () => ['10.41.179.205'] } } as { electronAPI: { getLanIps(): Promise<string[]> }; RvBLanDiscover: LanDiscoverApi }
    new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ window, RvBColyseus: { requestAt }, setTimeout, clearTimeout }))
    const scan = window.RvBLanDiscover.startLanScan({ onFound, onProgress, onDone })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(requestAt).toHaveBeenCalled()
    scan.cancel(); release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onFound).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('finds Android on an arbitrary hotspot gateway using the new native bridge', async () => {
    const requestAt = vi.fn(async (url: string) => {
      if (url === 'http://10.41.179.82:2567') return { ok: true, protocol: 'rvb-colyseus' }
      throw Error('unreachable')
    })
    const window = { RvBHost: { getLanIps: async () => ['10.41.179.205'] } } as { RvBHost: { getLanIps(): Promise<string[]> }; RvBLanDiscover: LanDiscoverApi }
    const context = createContext({ window, RvBColyseus: { requestAt }, setTimeout, clearTimeout })
    new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(context)
    const found = await new Promise<DiscoveredServer[]>(resolve => window.RvBLanDiscover.startLanScan({ onDone: resolve }))
    expect(found.some((server: DiscoveredServer) => server.url === 'http://10.41.179.82:2567')).toBe(true)
  })

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
