import WebSocket from 'ws'
import { allowedGamePath, CHANNEL_TIMEOUT_MS, MAX_PAYLOAD, MAX_BUFFERED, readPacket, sendPacket } from '../../../multiplayer-relay/protocol.mjs'

export interface HostTunnelOptions {
  relayUrl: string
  localOrigin: string
  name: string
  visible?: boolean
  publishKey?: string
  onClosed?: () => void
}

export interface PublishedHost {
  id: string
  inviteCode: string
  url: string
}

export function openHostTunnel(options: HostTunnelOptions): Promise<{ published: PublishedHost; close(): void }> {
  const relay = new URL(options.relayUrl)
  const local = new URL(options.localOrigin)
  if (!['http:', 'https:'].includes(relay.protocol) || relay.username || relay.password || relay.pathname !== '/' || relay.search || relay.hash) throw new Error('请输入转发服务器根地址')
  if (relay.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(relay.hostname)) throw new Error('公网转发必须使用 HTTPS')
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/' || !local.port || local.username || local.password) throw new Error('Tunnel authority must be a fixed loopback origin')
  relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:'
  relay.pathname = '/publish'
  const socket = new WebSocket(relay, { headers: options.publishKey ? { Authorization: `Bearer ${options.publishKey}` } : {}, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: 10000 })
  const connections = new Map<string, WebSocket>()
  const requests = new Map<string, AbortController>()
  let closed = false
  let settled = false
  function closeChannel(id: string) {
    const connection = connections.get(id)
    connections.delete(id)
    if (connection) connection.terminate()
    requests.get(id)?.abort()
    requests.delete(id)
  }
  function close() {
    if (closed) return
    closed = true
    for (const id of [...connections.keys(), ...requests.keys()]) closeChannel(id)
    socket.terminate()
  }
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error('转发服务器连接超时')); close() }, 10000)
    socket.on('open', () => sendPacket(socket, { type: 'register', name: options.name, visible: options.visible === true }))
    socket.on('error', () => { if (!settled) reject(new Error('无法连接转发服务器，请检查地址和发布密钥')); close() })
    socket.on('close', () => {
      clearTimeout(deadline)
      if (!settled) reject(new Error('转发服务器拒绝或关闭连接'))
      close()
      options.onClosed?.()
    })
    socket.on('message', async raw => {
      try {
        const packet = readPacket(raw)
        if (packet.type === 'registered' && !settled) {
          const publishedUrl = new URL(packet.url)
          if (typeof packet.id !== 'string' || !/^[A-F0-9]{8}$/.test(packet.inviteCode)
            || publishedUrl.origin !== new URL(options.relayUrl).origin || publishedUrl.pathname !== `/hosts/${packet.id}`) throw new Error('Invalid publication')
          settled = true; clearTimeout(deadline)
          resolve({ published: { id: packet.id, inviteCode: packet.inviteCode, url: packet.url }, close })
          return
        }
        const id = packet.id
        if (!settled || typeof id !== 'string' || id.length > 64) throw new Error('Invalid relay channel')
        if (packet.type === 'close') return closeChannel(id)
        if (packet.type === 'data') {
          const connection = connections.get(id)
          if (!connection || connection.readyState !== WebSocket.OPEN || typeof packet.body !== 'string') return
          if (connection.bufferedAmount > MAX_BUFFERED) { closeChannel(id); sendPacket(socket, { type: 'close', id }); return }
          connection.send(Buffer.from(packet.body, 'base64'), { binary: packet.binary === true })
          return
        }
        if (connections.has(id) || requests.has(id) || connections.size + requests.size >= 32) throw new Error('Relay channel limit')
        if (packet.type === 'open') {
          if (!allowedGamePath('WS', packet.path)) throw new Error('Forbidden WebSocket path')
          const target = `ws://${local.host}${packet.path}`
          const connection = new WebSocket(target, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: CHANNEL_TIMEOUT_MS })
          connections.set(id, connection)
          connection.on('open', () => sendPacket(socket, { type: 'opened', id }))
          connection.on('message', (data, binary) => sendPacket(socket, { type: 'data', id, body: data.toString('base64'), binary }))
          connection.on('error', () => { closeChannel(id); sendPacket(socket, { type: 'close', id }) })
          connection.on('close', () => { connections.delete(id); sendPacket(socket, { type: 'close', id }) })
          return
        }
        if (packet.type === 'http') {
          if (!allowedGamePath(packet.method, packet.path) || typeof packet.body !== 'string') throw new Error('Forbidden HTTP path')
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), CHANNEL_TIMEOUT_MS)
          requests.set(id, controller)
          try {
            const response = await fetch(`${local.origin}${packet.path}`, {
              method: packet.method, headers: { 'Content-Type': 'application/json', ...(typeof packet.reportAuth === 'string' && packet.reportAuth.length <= 2048 ? { 'X-RvB-Auth': packet.reportAuth } : {}) },
              body: packet.method === 'POST' ? Buffer.from(packet.body, 'base64') : undefined,
              signal: controller.signal, redirect: 'error',
            })
            const reader = response.body?.getReader()
            const chunks: Uint8Array[] = []
            let size = 0
            if (reader) while (true) {
              const { done, value } = await reader.read()
              if (done) break
              size += value.length
              if (size > MAX_PAYLOAD / 2) { await reader.cancel(); throw new Error('Authority response too large') }
              chunks.push(value)
            }
            if (!controller.signal.aborted) sendPacket(socket, { type: 'response', id, status: response.status, body: Buffer.concat(chunks).toString('base64') })
          } catch {
            sendPacket(socket, { type: 'response', id, status: 502, body: Buffer.from(JSON.stringify({ error: 'HOST_REQUEST_FAILED' })).toString('base64') })
          } finally { clearTimeout(timeout); requests.delete(id) }
          return
        }
        throw new Error('Unknown relay packet')
      } catch { close() }
    })
  })
}
