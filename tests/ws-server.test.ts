import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { startWsServer } from '../lib/ws-server'

const globalWithWsServer = globalThis as typeof globalThis & {
  __rvbWss?: WebSocketServer | null
}

let serverUrl: string
const activeClients = new Set<WebSocket>()
const eventTimeoutMs = 2_000

function rejectAfterTimeout(reject: (error: Error) => void, event: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${event}`)), eventTimeoutMs)
}

function waitForServerListening(server: WebSocketServer): Promise<void> {
  if (server.address()) return Promise.resolve()

  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
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
    process.env.WS_PORT = '0'
    startWsServer()

    const server = globalWithWsServer.__rvbWss
    if (!server) throw new Error('WebSocket server did not start')
    await waitForServerListening(server)

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('WebSocket server did not expose a TCP port')
    }
    serverUrl = `ws://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    delete process.env.WS_PORT
    const server = globalWithWsServer.__rvbWss
    globalWithWsServer.__rvbWss = null
    if (!server) return

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  })

  afterEach(() => {
    for (const client of activeClients) client.terminate()
    activeClients.clear()
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
