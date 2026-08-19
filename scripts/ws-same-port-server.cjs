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

function patchCreateServer(nodeModule) {
  const originalCreateServer = nodeModule.createServer
  nodeModule.createServer = function createServerWithGameWebSocket() {
    const server = originalCreateServer.apply(this, arguments)
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
      return originalOn(eventName, listener)
    }
    return server
  }
}

if (!globalThis[marker]) {
  globalThis[marker] = true
  for (const nodeModule of modules) patchCreateServer(nodeModule)
}
