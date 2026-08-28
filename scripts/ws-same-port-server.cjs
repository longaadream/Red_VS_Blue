/* eslint-disable @typescript-eslint/no-require-imports */
'use strict'

// Loaded before Next.js creates its HTTP(S) server. It reserves /ws paths for
// the game WebSocket service while leaving Next's HMR upgrades untouched.
const modules = [require('node:http'), require('node:https')]
const marker = '__rvbSameOriginWsPreloaded'

function isGameWebSocketPath(request) {
  const url = String((request && request.url) || '')
  return url === '/ws' || url === '/ws/' || url.startsWith('/ws/rooms/')
}

function rejectUpgrade(socket, statusLine) {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`)
  } catch {}
  try { socket.destroy() } catch {}
}

function routeGameUpgrade(request, socket, head) {
  if (request && request.__rvbGameWsHandled) return true
  if (!isGameWebSocketPath(request)) return false
  request.__rvbGameWsHandled = true

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
