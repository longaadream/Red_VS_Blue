import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { createRelay } from '../../multiplayer-relay/relay.mjs'
import { allowedGamePath } from '../../multiplayer-relay/protocol.mjs'
import { openHostTunnel } from '@/lib/server/relay/host-tunnel'

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
}
function message(socket: WebSocket) {
  return new Promise<Buffer>((resolve, reject) => { socket.once('message', data => resolve(data as Buffer)); socket.once('error', reject) })
}

describe('player-host public relay', () => {
  it('forwards real HTTP and binary sockets to one host, denies admin/create paths and removes disconnected hosts', async () => {
    const authority = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ authority: 'player-computer' })) })
    const gameWs = new WebSocketServer({ server: authority })
    gameWs.on('connection', ws => { ws.send(Buffer.from('ready')); ws.on('message', data => ws.send(data)) })
    const localOrigin = await listen(authority)
    const relay = createRelay({ publicOrigin: 'http://127.0.0.1:1', publishKey: 'test-publish-key' })
    // Bind a known available port so the advertised URL is the actual relay.
    await listen(relay.server)
    const port = (relay.server.address() as AddressInfo).port
    await relay.close()
    const candidate = createRelay({ publicOrigin: `http://127.0.0.1:${port}`, publishKey: 'test-publish-key' })
    await new Promise<void>(resolve => candidate.server.listen(port, '127.0.0.1', resolve))
    const relayUrl = `http://127.0.0.1:${port}`
    const tunnel = await openHostTunnel({ relayUrl, localOrigin, name: 'Test player host', visible: true, publishKey: 'test-publish-key' })
    let guest: WebSocket | undefined
    try {
      const hosts = await fetch(relayUrl + '/hosts').then(r => r.json())
      expect(hosts.hosts).toHaveLength(1)
      expect(await fetch(tunnel.published.url + '/healthz').then(r => r.json())).toEqual({ authority: 'player-computer' })
      expect((await fetch(tunnel.published.url + '/api/admin/rooms')).status).toBe(403)
      expect((await fetch(tunnel.published.url + '/matchmake/create/battle', { method: 'POST' })).status).toBe(403)
      expect(await fetch(relayUrl + '/invites/' + tunnel.published.inviteCode).then(r => r.json())).toMatchObject({ url: tunnel.published.url })
      guest = new WebSocket(tunnel.published.url.replace('http:', 'ws:') + '/process/room')
      const ready = message(guest)
      await opened(guest)
      expect((await ready).toString()).toBe('ready')
      const echo = message(guest)
      guest.send(Buffer.from([0, 1, 128, 255]))
      expect(await echo).toEqual(Buffer.from([0, 1, 128, 255]))
      const closed = new Promise<void>(resolve => guest!.once('close', () => resolve()))
      tunnel.close()
      await closed
      expect(await fetch(relayUrl + '/hosts').then(r => r.json())).toEqual({ hosts: [] })
    } finally {
      guest?.terminate(); tunnel.close(); await candidate.close(); gameWs.close()
      await new Promise<void>(resolve => authority.close(() => resolve()))
    }
  }, 20000)

  it('does not accept arbitrary ports, URL traversal or insecure public tunnels', () => {
    for (const path of ['//evil/healthz', '/%2e%2e/admin', '/rooms/../../admin', '/api/admin', '/catalog/identity\\admin']) expect(allowedGamePath('GET', path)).toBe(false)
    expect(() => openHostTunnel({ relayUrl: 'http://example.com', localOrigin: 'http://127.0.0.1:2567', name: 'x' })).toThrow('HTTPS')
    expect(() => openHostTunnel({ relayUrl: 'https://example.com', localOrigin: 'http://192.168.0.1:80', name: 'x' })).toThrow('loopback')
  })
})
