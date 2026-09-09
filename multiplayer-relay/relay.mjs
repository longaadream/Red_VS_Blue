import { isIP } from 'node:net'
import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { allowedGamePath, CHANNEL_TIMEOUT_MS, MAX_PAYLOAD, MAX_BUFFERED, readPacket, sendPacket } from './protocol.mjs'

/** A bounded opaque proxy. It never loads game rules or writes battle state. */
export function createRelay({ publicOrigin = 'http://127.0.0.1:8080', publishKey = '', maxHosts = 50, maxConnections = 120, trustedProxyAddresses = /** @type {string[]} */ ([]) } = {}) {
  const origin = new URL(publicOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.username || origin.password) throw new Error('Invalid public origin')
  const startedAt = Date.now()
  const stats = { requests: 0, capacityRejected: 0, denied: 0, published: 0, disconnected: 0 }
  const hosts = new Map()
  const channels = new Map()
  const publishers = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
  const guests = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
  let draining = false
  const requestBudget = new Map()
  function admit(request) {
    stats.requests++
    const peer = request.socket.remoteAddress || 'unknown'
    const forwarded = request.headers['x-real-ip']
    const ip = trustedProxyAddresses.includes(peer) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer
    const now = Date.now()
    if (requestBudget.size > 1024) for (const [key, value] of requestBudget) if (now - value.at > 60000) requestBudget.delete(key)
    let record = requestBudget.get(ip)
    if (!record || now - record.at > 60000) {
      if (requestBudget.size >= 2048) return false
      requestBudget.set(ip, record = { at: now, count: 0 })
    }
    return ++record.count <= 6000
  }
  function json(response, status, value) {
    if (status === 503) stats.capacityRejected++
    if (status === 401 || status === 403) stats.denied++
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
    response.end(JSON.stringify(value))
  }
  function removeChannel(id, notify = true) {
    const channel = channels.get(id)
    if (!channel) return
    channels.delete(id)
    clearTimeout(channel.timer)
    channel.host.channels.delete(id)
    if (notify) sendPacket(channel.host.socket, { type: 'close', id })
    if (channel.response && !channel.response.writableEnded) json(channel.response, 502, { error: 'HOST_UNAVAILABLE' })
    if (channel.socket) channel.socket.close(1012, 'Host connection closed')
  }
  function openChannel(host, extra) {
    if (channels.size >= maxConnections || host.channels.size >= 32) return undefined
    const id = randomUUID()
    const channel = { id, host, ...extra, timer: setTimeout(() => removeChannel(id), CHANNEL_TIMEOUT_MS) }
    channels.set(id, channel)
    host.channels.add(id)
    return channel
  }
  function route(raw) {
    const match = /^\/hosts\/([a-zA-Z0-9_-]+)(\/.*)$/.exec(raw || '')
    return match ? { host: hosts.get(match[1]), path: match[2] } : {}
  }
  const server = createServer(async (request, response) => {
    if (draining || !admit(request)) return json(response, 503, { error: 'RELAY_CAPACITY' })
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-RvB-Auth' }); return response.end()
    }
    if (request.method === 'GET' && request.url === '/healthz') return json(response, 200, { ok: true, protocol: 'rvb-host-relay-v1', hosts: hosts.size, connections: channels.size, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), limits: { maxHosts, maxConnections, maxPerHost: 32 }, stats })
    if (request.method === 'GET' && request.url === '/hosts') return json(response, 200, { hosts: [...hosts.values()].filter(h => h.visible).map(h => ({ id: h.id, name: h.name, inviteCode: h.code, url: h.url })) })
    const invite = /^\/invites\/([A-Z0-9]{8})$/.exec(request.url || '')
    if (request.method === 'GET' && invite) {
      const host = [...hosts.values()].find(h => h.code === invite[1])
      return host ? json(response, 200, { id: host.id, name: host.name, url: host.url }) : json(response, 404, { error: 'HOST_NOT_FOUND' })
    }
    const { host, path } = route(request.url)
    if (!host) return json(response, 404, { error: 'HOST_NOT_FOUND' })
    if (!allowedGamePath(request.method, path)) return json(response, 403, { error: 'PATH_FORBIDDEN' })
    const channel = openChannel(host, { response })
    if (!channel) return json(response, 503, { error: 'RELAY_CAPACITY' })
    response.on('close', () => removeChannel(channel.id))
    const chunks = []
    let length = 0
    try {
      for await (const chunk of request) {
        length += chunk.length
        if (length > MAX_PAYLOAD / 2) { json(response, 413, { error: 'BODY_TOO_LARGE' }); return removeChannel(channel.id) }
        chunks.push(chunk)
      }
      if (!channels.has(channel.id)) return
      const reportAuth = typeof request.headers['x-rvb-auth'] === 'string' ? request.headers['x-rvb-auth'] : ''
      if (reportAuth.length > 2048) { json(response, 413, { error: 'AUTH_TOO_LARGE' }); return removeChannel(channel.id) }
      sendPacket(host.socket, { type: 'http', id: channel.id, method: request.method, path, reportAuth, body: Buffer.concat(chunks).toString('base64') })
    } catch { removeChannel(channel.id) }
  })
  server.requestTimeout = CHANNEL_TIMEOUT_MS
  server.headersTimeout = CHANNEL_TIMEOUT_MS
  server.maxHeadersCount = 32
  server.on('upgrade', (request, socket, head) => {
    const reject = (code) => { if (code === 503) stats.capacityRejected++; if (code === 401 || code === 403) stats.denied++; socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`) }
    if (draining || !admit(request)) return reject(503)
    if (request.url === '/publish') {
      const provided = Buffer.from(String(request.headers.authorization || ''))
      const expected = Buffer.from(`Bearer ${publishKey}`)
      if (publishKey && (provided.length !== expected.length || !timingSafeEqual(provided, expected))) return reject(401)
      if (hosts.size + publishers.clients.size >= maxHosts * 2 || publishers.clients.size >= maxHosts) return reject(503)
      publishers.handleUpgrade(request, socket, head, ws => publishers.emit('connection', ws))
      return
    }
    const { host, path } = route(request.url)
    if (!host || !allowedGamePath('WS', path)) return reject(404)
    if (channels.size >= maxConnections || host.channels.size >= 32) return reject(503)
    guests.handleUpgrade(request, socket, head, ws => {
      const channel = openChannel(host, { socket: ws, opened: false })
      if (!channel) return ws.close(1013, 'Relay full')
      ws.on('error', () => removeChannel(channel.id))
      ws.on('close', () => removeChannel(channel.id))
      ws.on('message', (data, binary) => {
        if (!channel.opened) return ws.close(1008, 'Host not ready')
        sendPacket(host.socket, { type: 'data', id: channel.id, body: data.toString('base64'), binary })
      })
      sendPacket(host.socket, { type: 'open', id: channel.id, path })
    })
  })
  publishers.on('connection', ws => {
    let host
    let alive = true
    const registration = setTimeout(() => ws.close(1008, 'Registration timeout'), 5000)
    ws.on('error', () => ws.terminate())
    ws.on('pong', () => { alive = true })
    const heartbeat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping() }, 15000)
    ws.on('message', data => {
      try {
        const packet = readPacket(data)
        if (!host) {
          if (packet.type !== 'register' || typeof packet.name !== 'string' || !packet.name.trim() || packet.name.length > 60) return ws.close(1008, 'Invalid registration')
          const id = randomBytes(16).toString('hex')
          let code
          do { code = randomBytes(4).toString('hex').toUpperCase() } while ([...hosts.values()].some(h => h.code === code))
          host = { id, code, name: packet.name.trim(), visible: packet.visible === true, socket: ws, channels: new Set(), url: `${origin.origin}/hosts/${id}` }
          hosts.set(id, host)
          stats.published++
          console.info(JSON.stringify({ event: 'relay.host.published', hostId: id, visible: host.visible, hosts: hosts.size }))
          clearTimeout(registration)
          sendPacket(ws, { type: 'registered', id, inviteCode: code, url: host.url })
          return
        }
        const channel = channels.get(packet.id)
        if (!channel || channel.host !== host) return
        if (packet.type === 'response' && channel.response) {
          if (!Number.isInteger(packet.status) || packet.status < 200 || packet.status > 599 || typeof packet.body !== 'string') throw new Error('Invalid response')
          const body = Buffer.from(packet.body, 'base64')
          channel.response.writeHead(packet.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
          channel.response.end(body)
          removeChannel(channel.id)
        } else if (packet.type === 'opened' && channel.socket) {
          channel.opened = true; clearTimeout(channel.timer)
        } else if (packet.type === 'data' && channel.socket) {
          if (typeof packet.body !== 'string' || channel.socket.bufferedAmount > MAX_BUFFERED) return removeChannel(channel.id)
          const payload = Buffer.from(packet.body, 'base64')
          if (channel.socket.readyState === 1) channel.socket.send(payload, { binary: packet.binary === true })
        } else if (packet.type === 'close') removeChannel(channel.id, false)
      } catch { ws.close(1008, 'Invalid relay packet') }
    })
    ws.on('close', () => {
      clearTimeout(registration); clearInterval(heartbeat)
      if (!host) return
      hosts.delete(host.id)
      stats.disconnected++
      console.info(JSON.stringify({ event: 'relay.host.disconnected', hostId: host.id, closedConnections: host.channels.size, hosts: hosts.size }))
      for (const id of [...host.channels]) removeChannel(id, false)
    })
  })
  return {
    server,
    async close() {
      draining = true
      for (const id of [...channels.keys()]) removeChannel(id)
      for (const ws of publishers.clients) ws.terminate()
      for (const ws of guests.clients) ws.terminate()
      publishers.close(); guests.close()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
