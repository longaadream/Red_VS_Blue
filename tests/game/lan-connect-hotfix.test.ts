import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it, vi } from 'vitest'

it.each([false, true])('keeps the reachable Radmin address after WLAN (combined announcement: %s)', async (combined) => {
  let udp!: (info: unknown) => void
  let scanId = ''
  const onFound = vi.fn()
  const window = { electronAPI: {
    getLanIps: async () => ['26.1.1.2'],
    onUdpHostFound: (callback: typeof udp) => { udp = callback },
    startDiscoverHosts: (_ms: number, id: string) => { scanId = id },
  } } as unknown as { RvBLanDiscover: { startLanScan(options: unknown): { cancel(): void } } }
  const requestAt = vi.fn(async (url: string) => {
    if (url === 'http://26.200.7.9:38621') return { ok: true, protocol: 'rvb-colyseus', serverId: 'peer' }
    throw Error('unreachable')
  })
  new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ window, URL, AbortController, RvBColyseus: { requestAt } }))
  const scan = window.RvBLanDiscover.startLanScan({ onFound })
  await vi.waitFor(() => expect(udp).toBeTypeOf('function'))
  udp({ ip: '192.168.44.7', ips: combined ? ['26.200.7.9'] : [], port: 38621, serverId: 'peer', discoveryScanId: scanId })
  if (!combined) udp({ ip: '26.200.7.9', port: 38621, serverId: 'peer', discoveryScanId: scanId })
  await vi.waitFor(() => expect(onFound).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://26.200.7.9:38621' })))
  expect(onFound).toHaveBeenCalledOnce()
  scan.cancel()
})

it('shares the probe limit between UDP and subnet scans and drops queued work on cancel', async () => {
  let udp!: (info: unknown) => void, scanId = ''
  const requestAt = vi.fn((_url: string, _method: string, _data: unknown, _ms: number, signal: AbortSignal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve(null), { once: true })
  }))
  const window = { electronAPI: {
    getLanIps: async () => ['26.1.1.2'], onUdpHostFound: (callback: typeof udp) => { udp = callback },
    startDiscoverHosts: (_ms: number, id: string) => { scanId = id },
  } } as unknown as { RvBLanDiscover: { startLanScan(options: unknown): { cancel(): void } } }
  new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ window, URL, AbortController, RvBColyseus: { requestAt } }))
  const scan = window.RvBLanDiscover.startLanScan({})
  await vi.waitFor(() => expect(requestAt).toHaveBeenCalledTimes(16))
  for (let i = 1; i <= 70; i++) udp({ ip: '26.200.7.' + i, port: 38621, discoveryScanId: scanId })
  expect(requestAt).toHaveBeenCalledTimes(16)
  scan.cancel()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(requestAt).toHaveBeenCalledTimes(16)
})

it('aborts in-flight HTTP probes when cancelling, without waiting for their timeout', async () => {
  const signals: AbortSignal[] = []
  const window = { electronAPI: { getLanIps: async () => ['26.1.1.2'] } } as unknown as { RvBLanDiscover: { startLanScan(options: unknown): { cancel(): void } } }
  const requestAt = vi.fn((_url: string, _method: string, _data: unknown, _ms: number, signal?: AbortSignal) => {
    if (signal) signals.push(signal)
    return new Promise(resolve => signal?.addEventListener('abort', () => resolve(null), { once: true }))
  })
  new Script(readFileSync('data/pages/js/lan-discover.js', 'utf8')).runInContext(createContext({ window, URL, AbortController, RvBColyseus: { requestAt } }))
  const scan = window.RvBLanDiscover.startLanScan({})
  await vi.waitFor(() => expect(requestAt).toHaveBeenCalled())
  scan.cancel()
  expect(signals.length).toBeGreaterThan(0)
  expect(signals.every(signal => signal.aborted)).toBe(true)
})

it('cancels background scanning before connecting to the selected server', async () => {
  const cancel = vi.fn(), requestAt = vi.fn(async () => {
    expect(cancel).toHaveBeenCalledOnce()
    return { ok: true, protocol: 'rvb-colyseus' }
  })
  const nodes = new Map<string, { style: Record<string, string>; textContent: string }>()
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '' }); return nodes.get(id) }
  const html = readFileSync('data/pages/index.html', 'utf8')
  const context = createContext({ URL, document: { getElementById: get }, RvBColyseus: { requestAt }, RvBUtils: { saveServerConfig: vi.fn() }, checkProfileAndGo: async () => false, _lanScanner: { cancel } })
  new Script(html.slice(html.indexOf('async function connectLanServer'), html.indexOf('// ── Page loading'))).runInContext(context)
  await new Script('connectLanServer("26.200.7.9:38621")').runInContext(context)
  expect(requestAt).toHaveBeenCalledOnce()
  expect(get('lanConnectError')!.textContent).toBe('未进入大厅，请检查刚才的资源版本提示。')
})

it('forwards health cancellation to the actual fetch and clears its timeout', async () => {
  const window = {} as { RvBColyseus: { requestAt(url: string, method: string, data: unknown, timeout: number, signal: AbortSignal): Promise<unknown> } }
  let requestSignal!: AbortSignal
  const fetch = vi.fn((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    requestSignal = options.signal
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  const clear = vi.fn(clearTimeout)
  new Script(readFileSync('data/pages/js/colyseus-client.js', 'utf8')).runInContext(createContext({ window, URL, AbortController, fetch, setTimeout, clearTimeout: clear }))
  const controller = new AbortController()
  const request = window.RvBColyseus.requestAt('http://26.200.7.9:38621', 'system.health', {}, 8000, controller.signal)
  controller.abort()
  await expect(request).rejects.toMatchObject({ code: 'COLYSEUS_HTTP_CANCELLED' })
  expect(requestSignal.aborted).toBe(true)
  expect(clear).toHaveBeenCalledOnce()
})
