import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { startWsServer } from '../lib/ws-server'

const globalWithWsServer = globalThis as typeof globalThis & {
  __rvbWss?: WebSocketServer | null
  __rvbWsUpgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
}

let httpServer: Server
let serverUrl: string
const activeClients = new Set<WebSocket>()
const eventTimeoutMs = 2_000

function rejectAfterTimeout(reject: (error: Error) => void, event: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${event}`)), eventTimeoutMs)
}

function openClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(serverUrl)
    activeClients.add(client)
    client.once('close', () => activeClients.delete(client))

    const timeout = rejectAfterTimeout(reject, 'open')
    client.once('open', () => {
      clearTimeout(timeout)
      resolve(client)
    })
    client.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function waitForJsonMessage(client: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = rejectAfterTimeout(reject, 'message')
    client.once('message', (raw) => {
      clearTimeout(timeout)
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    client.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function closeClient(client: WebSocket): Promise<number> {
  if (client.readyState === WebSocket.CLOSED) return Promise.resolve(1000)

  return new Promise((resolve, reject) => {
    const timeout = rejectAfterTimeout(reject, 'close')
    client.once('close', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
    client.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    client.close(1000, 'test complete')
  })
}

describe('game WebSocket service', () => {
  beforeAll(async () => {
    await startWsServer()
    if (!globalWithWsServer.__rvbWss || !globalWithWsServer.__rvbWsUpgradeHandler) {
      throw new Error('WebSocket Upgrade handler did not start')
    }
    httpServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    httpServer.on('upgrade', (request, socket, head) => {
      const handler = globalWithWsServer.__rvbWsUpgradeHandler
      if (handler) handler(request, socket, head)
      else socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', resolve)
    })
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('HTTP server did not expose a port')
    serverUrl = `ws://127.0.0.1:${address.port}/ws/rooms/__lobby`
  })

  afterAll(async () => {
    const server = globalWithWsServer.__rvbWss
    globalWithWsServer.__rvbWss = null

    delete globalWithWsServer.__rvbWsUpgradeHandler
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
    await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))
  })

  afterEach(() => {
    for (const client of activeClients) client.terminate()
    activeClients.clear()
  })

  test('serializes a same-port restart while an existing client is connected', async () => {
    const originalServer = globalWithWsServer.__rvbWss
    if (!originalServer) throw new Error('Original WebSocket server is unavailable')
    const staleClient = await openClient()

    await startWsServer()

    const restartedServer = globalWithWsServer.__rvbWss
    if (!restartedServer) throw new Error('Restarted WebSocket server is unavailable')
    expect(restartedServer).not.toBe(originalServer)

    const replacementClient = await openClient()
    await expect(closeClient(replacementClient)).resolves.toBe(1000)
    expect(staleClient.readyState).not.toBe(WebSocket.OPEN)
  })

  test('connects, exchanges ping/pong messages, and closes normally', async () => {
    const client = await openClient()
    try {
      const response = waitForJsonMessage(client)
      client.send(JSON.stringify({ type: 'ping' }))

      await expect(response).resolves.toEqual({ type: 'pong' })
    } finally {
      await expect(closeClient(client)).resolves.toBe(1000)
    }
  })

  test('keeps the connection usable after malformed JSON', async () => {
    const client = await openClient()
    try {
      client.send('{not-json')
      const response = waitForJsonMessage(client)
      client.send(JSON.stringify({ type: 'ping' }))

      await expect(response).resolves.toEqual({ type: 'pong' })
    } finally {
      await closeClient(client)
    }
  })

  test('returns the existing RPC error envelope for an unsupported method', async () => {
    const client = await openClient()
    try {
      const response = waitForJsonMessage(client)
      client.send(JSON.stringify({
        type: 'rpc',
        requestId: 'unsupported-method',
        method: 'unsupported.method',
      }))

      await expect(response).resolves.toEqual({
        type: 'rpcResult',
        requestId: 'unsupported-method',
        ok: false,
        error: 'Unsupported RPC method: unsupported.method',
      })
    } finally {
      await closeClient(client)
    }
  })
})
