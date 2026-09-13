import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Script, createContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it('replaces native UDP sockets and never routes old scan messages to the new session', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  class Socket extends EventEmitter {
    close = vi.fn()
    bind(_port: number, ready: () => void) { ready() }
    setBroadcast() {}
  }
  const sockets: Socket[] = []
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }
  const event = { sender }
  const source = readFileSync('electron-client/main.ts', 'utf8')
  const snippet = source.slice(source.indexOf('const discoverySessions ='), source.indexOf('// 资源包状态'))
  new Script(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInContext(createContext({
    handleTrusted: (channel: string, _roles: string[], handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    dgram: { createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket } },
    getLanIpList: () => ['10.0.0.2', '10.0.0.3'], getHostDiscovery: () => ({ serverId: 'self' }), hostDiscoveryFile: () => 'unused',
    DISCOVERY_PORT: 7877, setTimeout, clearTimeout,
  }))
  const start = handlers.get('start-discover-hosts')!, stop = handlers.get('stop-discover-hosts')!
  const message = (ip: string, serverId = 'peer') => Buffer.from(JSON.stringify({ magic: 'RVB_DISCOVER', ip, port: 2567, serverId, discoveryScanId: 'forged' }))
  start(event, 3000, 'scan-A')
  start(event, 3000, 'scan-B')
  try {
    expect(sockets[0].close).toHaveBeenCalledOnce()
    sockets[0].emit('message', message('10.0.0.9'))
    stop(event, 'scan-A')
    expect(sockets[1].close).not.toHaveBeenCalled()
    for (const ip of ['10.0.0.2', '10.0.0.3']) sockets[1].emit('message', message(ip))
    sockets[1].emit('message', message('10.0.0.8', 'self'))
    expect(sender.send).not.toHaveBeenCalled()
    sockets[1].emit('message', message('10.0.0.9'))
    expect(sender.send).toHaveBeenCalledWith('udp-host-found', expect.objectContaining({ ip: '10.0.0.9', discoveryScanId: 'scan-B' }))
    stop(event, 'scan-B')
    sockets[1].emit('message', message('10.0.0.10'))
    expect(sender.send).toHaveBeenCalledOnce()
  } finally { stop(event, 'scan-B') }
})
