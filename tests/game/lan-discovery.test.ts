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
  it('probes the saved VPN peer outside our /24 before subnet addresses', async () => {
    const requestAt = vi.fn(async (url: string) => url === 'http://26.200.7.9:38622' ? { ok: true, protocol: 'rvb-colyseus' } : null)
    const window = { localStorage: { getItem: (key: string) => key === 'rvb_lan_server_url' ? 'http://26.200.7.9:38622' : null }, electronAPI: {
      getLanIps: async () => ['26.111.123.250'],
      getRemoteUrl: async () => '',
    } } as unknown as { RvBLanDiscover: LanDiscoverApi }
    new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ AbortController, window, URL, RvBColyseus: { requestAt } }))
    const found = await new Promise<DiscoveredServer[]>(resolve => window.RvBLanDiscover.startLanScan({ onDone: resolve }))
    expect(found).toEqual([{ url: 'http://26.200.7.9:38622', ip: '26.200.7.9', port: 38622 }])
    expect(requestAt.mock.calls[0][0]).toBe('http://26.200.7.9:38622')
  })
  it('excludes every local interface while preserving a same-name peer', async () => {
    const requestAt = vi.fn(async () => ({ ok: true, protocol: 'rvb-colyseus', serverName: '同名主机', serverId: 'peer-id' }))
    const window = { electronAPI: {
      getLanIps: async () => ['192.168.1.24'],
      getHostInfo: async () => ({ ips: ['192.168.1.24', '192.168.1.25'], serverId: 'self-id' }),
    } } as unknown as { RvBLanDiscover: LanDiscoverApi }
    new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ AbortController, window, RvBColyseus: { requestAt } }))
    const found = await new Promise<DiscoveredServer[]>(resolve => window.RvBLanDiscover.startLanScan({ onDone: resolve }))
    expect(found.some(server => server.ip === '192.168.1.24' || server.ip === '192.168.1.25')).toBe(false)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]).toMatchObject({ name: '同名主机', serverId: 'peer-id' })
  })

  it('does not publish an old batch after cancelling a scan', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const onFound = vi.fn(), onProgress = vi.fn(), onDone = vi.fn()
    const requestAt = vi.fn(async () => { await waiting; return { ok: true, protocol: 'rvb-colyseus' } })
    const window = { electronAPI: { getLanIps: async () => ['10.41.179.205'] } } as { electronAPI: { getLanIps(): Promise<string[]> }; RvBLanDiscover: LanDiscoverApi }
    new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ AbortController, window, RvBColyseus: { requestAt }, setTimeout, clearTimeout }))
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
    const context = createContext({ AbortController, window, RvBColyseus: { requestAt }, setTimeout, clearTimeout })
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
    const context = createContext({ AbortController,
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

  it('filters UDP self IDs and loopback, preserves same-name peers, and ignores callbacks after cancel', async () => {
    let scanId = ''
    type Info = { discoveryScanId?: string; ip: string; port: number; serverId?: string; name?: string }
    let udp!: (info: Info) => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const onFound = vi.fn()
    const native = {
      getLanIps: async () => ['10.0.0.2'],
      getHostInfo: async () => { await waiting; return { serverId: 'self', localIps: ['10.0.0.3'] } },
      offUdpDiscovery: vi.fn(), onUdpHostFound: (callback: typeof udp) => { udp = info => callback({ discoveryScanId: scanId, ...info }) },
      startDiscoverHosts: vi.fn((_timeout: number, token: string) => { scanId = token; return undefined }),
    }
    const window = { electronAPI: native } as unknown as { RvBLanDiscover: LanDiscoverApi }
    let reachable = false
    new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ AbortController, window, RvBColyseus: { requestAt: async () => reachable ? { ok: true, protocol: 'rvb-colyseus' } : null } }))
    window.RvBLanDiscover.startLanScan({}).cancel()
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(native.startDiscoverHosts).not.toHaveBeenCalled()
    let scan!: { cancel(): void }
    await new Promise<void>(resolve => { scan = window.RvBLanDiscover.startLanScan({ onFound, onDone: () => resolve() }) })
    reachable = true
    for (const info of [
      { ip: '10.0.0.2', port: 2567 }, { ip: '10.0.0.3', port: 38621 },
      { ip: '127.0.0.1', port: 2567 }, { ip: '10.0.0.8', port: 2567, serverId: 'self' },
      { ip: 'evil.example', port: 2567 }, { ip: '10.0.0.8', port: -1 },
    ]) udp(info)
    expect(onFound).not.toHaveBeenCalled()
    udp({ ip: '10.0.0.8', port: 2567, serverId: 'peer-1', name: '同名' })
    udp({ ip: '10.0.0.9', port: 2567, serverId: 'peer-2', name: '同名' })
    udp({ ip: '10.0.0.10', port: 2567, serverId: 'peer-1', name: '同名' })
    await vi.waitFor(() => expect(onFound).toHaveBeenCalledTimes(2))
    udp({ ip: '10.0.0.11', port: 2567, discoveryScanId: 'previous-scan' })
    expect(onFound).toHaveBeenCalledTimes(2)
    scan.cancel()
    udp({ ip: '10.0.0.11', port: 2567 })
    expect(onFound).toHaveBeenCalledTimes(2)
  })

  it('continues HTTP discovery when UDP startup throws synchronously', async () => {
    const native = { getLanIps: async () => ['10.0.0.2'], onUdpHostFound: vi.fn(), startDiscoverHosts: () => { throw Error('UDP unavailable') } }
    const window = { electronAPI: native } as unknown as { RvBLanDiscover: LanDiscoverApi }
    new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ AbortController, window, RvBColyseus: { requestAt: async (url: string) => url === 'http://10.0.0.3:2567' ? { ok: true, protocol: 'rvb-colyseus' } : null } }))
    const found = await new Promise<DiscoveredServer[]>(resolve => window.RvBLanDiscover.startLanScan({ onDone: resolve }))
    expect(found).toEqual([{ ip: '10.0.0.3', port: 2567, url: 'http://10.0.0.3:2567' }])
  })
