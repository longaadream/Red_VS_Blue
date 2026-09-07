import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { createRelay } from '../../multiplayer-relay/relay.mjs'
import { openHostTunnel } from '@/lib/server/relay/host-tunnel'

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function echo(socket: WebSocket, body: Buffer) {
  return new Promise<number>((resolve, reject) => {
    const started = performance.now(), timer = setTimeout(() => reject(new Error('Echo timeout')), 5000)
    socket.once('message', data => { clearTimeout(timer); expect(Buffer.from(data as Buffer)).toEqual(body); resolve(performance.now() - started) })
    socket.send(body)
  })
}
it('holds 100 real relayed sockets, enforces the cap and removes every connection at shutdown', async () => {
  const authority = createServer((_request, response) => response.end('{}'))
  const echoServer = new WebSocketServer({ server: authority })
  echoServer.on('connection', socket => { socket.send('ready'); socket.on('message', data => socket.send(data)) })
  const localOrigin = await listen(authority)
  const reservation = createServer(); const relayUrl = await listen(reservation)
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const relay = createRelay({ publicOrigin: relayUrl, maxConnections: 100, trustedProxyAddresses: ['127.0.0.1'] })
  await new Promise<void>(resolve => relay.server.listen(Number(new URL(relayUrl).port), '127.0.0.1', resolve))
  const tunnels: Awaited<ReturnType<typeof openHostTunnel>>[] = [], sockets: WebSocket[] = []
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable()
  try {
    for (let host = 0; host < 4; host++) tunnels.push(await openHostTunnel({ relayUrl, localOrigin, name: `capacity-${host}`, visible: true }))
    for (let index = 0; index < 100; index++) {
      const socket = new WebSocket(tunnels[Math.floor(index / 25)].published.url.replace('http:', 'ws:') + '/process/room')
      sockets.push(socket)
      await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject) })
    }
    expect(await fetch(relayUrl + '/healthz').then(r => r.json())).toMatchObject({ hosts: 4, connections: 100 })
    const overflow = new WebSocket(tunnels[0].published.url.replace('http:', 'ws:') + '/process/room')
    await new Promise<void>((resolve, reject) => { overflow.once('open', () => reject(new Error('Capacity exceeded'))); overflow.once('unexpected-response', (_request, response) => { expect(response.statusCode).toBe(503); response.resume(); overflow.terminate(); resolve() }); overflow.on('error', () => {}) })
    const latencies: number[] = []
    for (let round = 0; round < 20; round++) latencies.push(...await Promise.all(sockets.map((socket, index) => echo(socket, Buffer.alloc(1024, (round + index) % 256)))))
    // 100 lobby clients polling every two seconds generate 3000 directory requests/minute.
    for (let batch = 0; batch < 30; batch++) {
      const statuses = await Promise.all(Array.from({ length: 100 }, (_, i) => fetch(relayUrl + '/hosts', { headers: { 'X-Real-IP': `192.0.2.${i + 1}` } }).then(async r => { await r.arrayBuffer(); return r.status })))
      expect(statuses.every(status => status === 200)).toBe(true)
    }
    latencies.sort((a, b) => a - b)
    mkdirSync('dist/multiplayer-qa', { recursive: true })
    writeFileSync('dist/multiplayer-qa/relay-capacity.json', JSON.stringify({ at: new Date().toISOString(), platform: process.platform, node: process.version, hosts: 4, connections: 100, roundTrips: latencies.length, payloadBytes: 1024, lobbyRequests: 3000, p50Ms: latencies[Math.floor(latencies.length * .5)], p95Ms: latencies[Math.floor(latencies.length * .95)], maxMs: latencies.at(-1), eventLoopP99Ms: loop.percentile(99) / 1e6, processRssBytes: process.memoryUsage().rss, scope: 'loopback opaque relay; not 100 game simulations or China WAN' }, null, 2))
    const closed = sockets.map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())))
    tunnels.forEach(tunnel => tunnel.close())
    await Promise.all(closed)
    expect(await fetch(relayUrl + '/healthz').then(r => r.json())).toMatchObject({ hosts: 0, connections: 0 })
  } finally {
    loop.disable(); sockets.forEach(socket => socket.terminate()); tunnels.forEach(tunnel => tunnel.close())
    await relay.close(); echoServer.close()
    await new Promise<void>(resolve => authority.close(() => resolve()))
  }
}, 60000)
