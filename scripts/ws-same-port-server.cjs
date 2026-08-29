/* eslint-disable @typescript-eslint/no-require-imports */
'use strict'

// Loaded before Next.js creates its HTTP(S) server. It reserves /ws paths for
// the game WebSocket service while leaving Next's HMR upgrades untouched.
const { createHash } = require('node:crypto')
const modules = [require('node:http'), require('node:https')]
const marker = '__rvbSameOriginWsPreloaded'
const ingressMarker = '__rvbProfileHttpIngressV1'
const webSocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function isGameWebSocketPath(request) {
  const url = String((request && request.url) || '')
  return url === '/ws' || url === '/ws/' || url.startsWith('/ws/rooms/')
}

function isProfileHealthWebSocketPath(request) {
  const url = String((request && request.url) || '')
  return url.split('?')[0] === '/ws/rooms/__profile-health__'
}

function isProfileAdmissionPaused() {
  return Boolean(
    process.env.RVB_PROFILE_ACTIVATION_ID
    || process.env.RVB_PROFILE_ADMISSION_PAUSED,
  )
}

function isProfileControlPath(request) {
  const pathname = String((request && request.url) || '').split('?')[0]
  return pathname === '/api/ping'
    || pathname === '/api/content-profile'
    || pathname.startsWith('/api/content-profile/')
}

function profileHttpIngressTracker() {
  if (globalThis[ingressMarker]) return globalThis[ingressMarker]
  let active = 0
  const waiters = new Set()
  const notifyDrained = () => {
    if (active !== 0) return
    for (const waiter of waiters) waiter()
    waiters.clear()
  }
  globalThis[ingressMarker] = {
    activeCount: () => active,
    waitForDrain: (timeoutMs = 10_000) => {
      if (active === 0) return Promise.resolve(true)
      return new Promise(resolve => {
        let settled = false
        const finish = value => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          waiters.delete(onDrain)
          resolve(value)
        }
        const onDrain = () => finish(true)
        const timeout = setTimeout(() => finish(false), timeoutMs)
        waiters.add(onDrain)
      })
    },
    track: (request, response) => {
      if (isProfileControlPath(request) || isProfileAdmissionPaused()) return
      active += 1
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        active -= 1
        notifyDrained()
      }
      response.once('finish', finish)
      response.once('close', finish)
    },
  }
  return globalThis[ingressMarker]
}

function rejectUpgrade(socket, statusLine) {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`)
  } catch {}
  try { socket.destroy() } catch {}
}

function acceptProfileHealthUpgrade(request, socket) {
  const key = String(request && request.headers && request.headers['sec-websocket-key'] || '')
  const version = String(request && request.headers && request.headers['sec-websocket-version'] || '')
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || version !== '13') {
    rejectUpgrade(socket, '400 Invalid WebSocket Health Probe')
    return
  }
  const accept = createHash('sha1').update(key + webSocketGuid).digest('base64')
  try {
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + 'X-RVB-Profile-Health: 1\r\n'
      + '\r\n',
    )
  } catch {
    try { socket.destroy() } catch {}
  }
}

function routeGameUpgrade(request, socket, head) {
  if (request && request.__rvbGameWsHandled) return true
  if (!isGameWebSocketPath(request)) return false
  request.__rvbGameWsHandled = true

  // This path is a transport-only liveness probe. It never reaches the game
  // WebSocketServer, so it cannot subscribe or invoke any room RPC method.
  if (isProfileHealthWebSocketPath(request)) {
    acceptProfileHealthUpgrade(request, socket)
    return true
  }

  if (isProfileAdmissionPaused()) {
    rejectUpgrade(socket, '503 Profile Activation In Progress')
    return true
  }

  const handler = globalThis.__rvbWsUpgradeHandler
  if (typeof handler !== 'function') {
    rejectUpgrade(socket, '503 WebSocket Service Unavailable')
    return true
  }

  try {
    handler(request, socket, head)
  } catch (error) {
    console.error('[WS] Same-origin Upgrade failed', error)
    rejectUpgrade(socket, '500 WebSocket Upgrade Failed')
  }
  return true
}

function isLegacyPlayerApiPath(request) {
  const pathname = String((request && request.url) || '').split('?', 1)[0]
  return /^\/api\/(?:ping|lobby|maps|pieces|skills)(?:\/|$)/.test(pathname)
    || /^\/api\/(?:cards|rooms)(?:\/|$)/.test(pathname)
}

function rejectLegacyPlayerApi(request, response) {
  if (!isLegacyPlayerApiPath(request) || !response || response.headersSent) return false
  const body = JSON.stringify({
    error: 'Player REST protocol is disabled; connect through WebSocket RPC.',
    code: 'PLAYER_REST_DISABLED',
    transport: 'websocket',
  })
  response.writeHead(410, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
  return true
}

function wrapRequestListener(listener) {
  return function rejectPlayerRestBeforeNext(request, response) {
    if (rejectLegacyPlayerApi(request, response)) return
    return listener.apply(this, arguments)
  }
}

function patchCreateServer(nodeModule) {
  const originalCreateServer = nodeModule.createServer
  nodeModule.createServer = function createServerWithGameWebSocket() {
    const args = Array.from(arguments)
    for (let index = args.length - 1; index >= 0; index -= 1) {
      if (typeof args[index] !== 'function') continue
      args[index] = wrapRequestListener(args[index])
      break
    }
    const server = originalCreateServer.apply(this, args)
    server.prependListener('request', (request, response) => {
      profileHttpIngressTracker().track(request, response)
    })
    const originalOn = server.on.bind(server)

    // Register first so game paths are claimed before Next's own Upgrade
    // handlers. Later listeners are wrapped to avoid double-processing.
    originalOn('upgrade', routeGameUpgrade)
    server.on = function onWithGameWebSocket(eventName, listener) {
      if (eventName === 'upgrade' && typeof listener === 'function') {
        return originalOn(eventName, function routeUpgradeBeforeNext(request, socket, head) {
          if (routeGameUpgrade(request, socket, head)) return
          return listener(request, socket, head)
        })
      }
      if (eventName === 'request' && typeof listener === 'function') {
        return originalOn(eventName, wrapRequestListener(listener))
      }
      return originalOn(eventName, listener)
    }
    return server
  }
}

if (!globalThis[marker]) {
  globalThis[marker] = true
  for (const nodeModule of modules) patchCreateServer(nodeModule)
}
