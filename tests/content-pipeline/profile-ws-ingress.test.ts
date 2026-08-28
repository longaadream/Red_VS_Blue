import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { getProfileWsIngressTrackerV1 } from '@/lib/content-pipeline/runtime/profile-ws-ingress'
import { roomStore, type Room } from '@/lib/game/room-store'
import { startWsServer } from '@/lib/ws-server'

const runtimeGlobals = globalThis as typeof globalThis & {
  __rvbWss?: WebSocketServer | null
  __rvbWsUpgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
}
const originalAdmissionPause = process.env.RVB_PROFILE_ADMISSION_PAUSED
let httpServer: Server
let serverUrl: string

function openClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(serverUrl)
    client.once('open', () => resolve(client))
    client.once('error', reject)
  })
}

function waitForJsonMessage(client: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    client.once('message', raw => {
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    client.once('error', reject)
  })
}

function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise(resolve => {
    client.once('close', () => resolve())
    client.close(1000, 'test complete')
  })
}

describe('RED-115 WebSocket Profile ingress barrier', () => {
  beforeAll(async () => {
    delete process.env.RVB_PROFILE_ADMISSION_PAUSED
    await startWsServer()
    httpServer = createServer((_request, response) => response.end('ok'))
    httpServer.on('upgrade', (request, socket, head) => {
      runtimeGlobals.__rvbWsUpgradeHandler?.(request, socket, head)
    })
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', resolve)
    })
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server port')
    serverUrl = `ws://127.0.0.1:${address.port}/ws/rooms/__lobby`
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalAdmissionPause === undefined) delete process.env.RVB_PROFILE_ADMISSION_PAUSED
    else process.env.RVB_PROFILE_ADMISSION_PAUSED = originalAdmissionPause
  })

  afterAll(async () => {
    const server = runtimeGlobals.__rvbWss
    runtimeGlobals.__rvbWss = null
    delete runtimeGlobals.__rvbWsUpgradeHandler
    if (server) {
      for (const client of server.clients) client.terminate()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close(error => error ? reject(error) : resolve())
    })
  })

  test('counts an accepted async RPC until its handler finishes', async () => {
    const client = await openClient()
    try {
      let finishRoomRead!: (rooms: Room[]) => void
      const pendingRooms = new Promise<Room[]>(resolve => {
        finishRoomRead = resolve
      })
      vi.spyOn(roomStore, 'getAllRooms').mockImplementationOnce(() => pendingRooms)

      const response = waitForJsonMessage(client)
      client.send(JSON.stringify({
        type: 'rpc',
        requestId: 'drain-rpc',
        method: 'rooms.list',
      }))

      const ingress = getProfileWsIngressTrackerV1()
      await vi.waitFor(() => expect(ingress.activeCount()).toBe(1))
      process.env.RVB_PROFILE_ADMISSION_PAUSED = 'activation-plan-test'
      let drained = false
      const drain = ingress.waitForDrain().then(result => {
        drained = result
        return result
      })
      await Promise.resolve()
      expect(drained).toBe(false)

      finishRoomRead([])
      await expect(response).resolves.toEqual({
        type: 'rpcResult',
        requestId: 'drain-rpc',
        ok: true,
        data: { rooms: [] },
      })
      await expect(drain).resolves.toBe(true)
      expect(ingress.activeCount()).toBe(0)
    } finally {
      await closeClient(client)
    }
  })

  test('rejects a command received after the activation fence', async () => {
    const client = await openClient()
    try {
      process.env.RVB_PROFILE_ADMISSION_PAUSED = 'activation-plan-test'
      const response = waitForJsonMessage(client)
      client.send(JSON.stringify({
        type: 'rpc',
        requestId: 'blocked-rpc',
        method: 'rooms.list',
      }))

      await expect(response).resolves.toEqual({
        type: 'rpcResult',
        requestId: 'blocked-rpc',
        ok: false,
        error: 'Profile activation in progress',
        status: 503,
      })
      expect(getProfileWsIngressTrackerV1().activeCount()).toBe(0)
    } finally {
      await closeClient(client)
    }
  })
})
