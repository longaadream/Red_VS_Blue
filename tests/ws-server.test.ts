import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { hashBattleState } from '../lib/game/battle-runner'
import {
  createPublicBattleResyncSnapshot,
  type DispatchRoomBattleActionResult,
} from '../lib/game/room-battle-actions'
import { broadcastBattleTransition, startWsServer } from '../lib/ws-server'
import { getRoomStore, type Room } from '../lib/game/room-store'
import { makeState } from './helpers/minimal-state'

const globalWithWsServer = globalThis as typeof globalThis & {
  __rvbWss?: WebSocketServer | null
  __rvbWsUpgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  __rvbRoomClients?: Map<string, Set<WebSocket>>
  __rvbWsIdentities?: WeakMap<WebSocket, { roomId: string; playerId?: string }>
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
async function openClientPair(): Promise<{ client: WebSocket; server: WebSocket }> {
  const server = globalWithWsServer.__rvbWss
  if (!server) throw new Error('WebSocket server is unavailable')
  const accepted = new Promise<WebSocket>(resolve => server.once('connection', resolve))
  const client = await openClient()
  return { client, server: await accepted }
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
function waitForJsonMessages(client: WebSocket, count: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    const timeout = rejectAfterTimeout(reject, String(count) + ' messages')
    const onError = (error: Error) => {
      clearTimeout(timeout)
      client.off('message', onMessage)
      reject(error)
    }
    const onMessage = (raw: RawData) => {
      try {
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>)
        if (messages.length !== count) return
        clearTimeout(timeout)
        client.off('message', onMessage)
        client.off('error', onError)
        resolve(messages)
      } catch (error) {
        clearTimeout(timeout)
        client.off('message', onMessage)
        client.off('error', onError)
        reject(error)
      }
    }
    client.on('message', onMessage)
    client.once('error', onError)
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
  test('reports a failed room deletion instead of acknowledging success', async () => {
    const client = await openClient()
    const roomStore = getRoomStore()
    const room: Room = {
      id: 'delete-failure-room',
      name: 'Delete failure room',
      status: 'waiting',
      players: [{ id: 'host', name: 'Host' }],
      spectators: [],
      hostId: 'host',
      currentTurnIndex: 0,
      actions: [],
    }
    const getRoom = vi.spyOn(roomStore, 'getRoom').mockResolvedValue(room)
    const removeRoom = vi.spyOn(roomStore, 'removeRoom').mockResolvedValue(false)

    try {
      const response = waitForJsonMessage(client)
      client.send(JSON.stringify({
        type: 'rpc',
        requestId: 'delete-failure',
        method: 'rooms.delete',
        data: { roomId: room.id, playerId: 'host' },
      }))

      await expect(response).resolves.toEqual({
        type: 'rpcResult',
        requestId: 'delete-failure',
        ok: false,
        error: 'Room could not be deleted',
      })
      expect(removeRoom).toHaveBeenCalledWith(room.id)
    } finally {
      getRoom.mockRestore()
      removeRoom.mockRestore()
      await closeClient(client)
    }
  })


  test('isolates a committed transition projection failure per recipient and resyncs privately', async () => {
    const roomId = 'broadcast-isolation-' + Date.now()
    const actorPair = await openClientPair()
    const opponentPair = await openClientPair()
    const spectatorPair = await openClientPair()
    const actor = actorPair.client
    const opponent = opponentPair.client
    const spectator = spectatorPair.client
    const clients = [actor, opponent, spectator]
    const serverClients = [actorPair.server, opponentPair.server, spectatorPair.server]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const roomClients = globalWithWsServer.__rvbRoomClients
      const identities = globalWithWsServer.__rvbWsIdentities
      if (!roomClients || !identities) throw new Error('WebSocket recipient registries are unavailable')
      roomClients.set(roomId, new Set(serverClients))
      identities.set(actorPair.server, { roomId, playerId: 'actor' })
      identities.set(opponentPair.server, { roomId, playerId: 'opponent' })
      identities.set(spectatorPair.server, { roomId })
      expect(roomClients.get(roomId)?.size).toBe(3)
      const nextState = makeState()
      nextState.pendingTargetSelection = {
        playerId: 'actor',
        ownerPlayerId: 'actor',
        title: 'Choose an anchor',
        targetType: 'cell',
        selectionId: 'selection-2',
        stateRevision: 2,
        candidates: [{ type: 'cell', x: 4, y: 5 }],
      } as never
      const result = {
        kind: 'applied',
        snapshot: { state: nextState, seed: 77, stateHash: 'committed', authorityVersion: 2, serverNow: 100 },
        actionResult: { state: nextState },
        receipt: { clientActionId: 'actor-action-1', status: 'applied', authorityVersion: 2 },
        transition: { fromVersion: 1, toVersion: 2, playerId: 'actor' },
        previousAuthorityState: makeState(),
        nextAuthorityState: nextState,
      } as unknown as DispatchRoomBattleActionResult

      const actorMessagesPromise = waitForJsonMessages(actor, 2)
      const opponentMessagesPromise = waitForJsonMessages(opponent, 1)
      const spectatorMessagesPromise = waitForJsonMessages(spectator, 1)
      broadcastBattleTransition(roomId, result, {
        createTransitionUpdate: (_result, projectedRoomId, viewerPlayerId) => {
          if (viewerPlayerId !== 'opponent') throw new Error('forced recipient projection failure')
          return {
            type: 'battleTransition',
            protocolVersion: 2,
            roomId: projectedRoomId,
            fromVersion: 1,
            toVersion: 2,
            prePublicHash: 'pre',
            postPublicHash: 'post',
            patch: [],
            receipt: result.receipt,
            seed: 77,
            stateHash: 'opponent-transition',
            serverNow: 100,
          } as never
        },
      })

      const [actorMessages, opponentMessages, spectatorMessages] = await Promise.all([
        actorMessagesPromise,
        opponentMessagesPromise,
        spectatorMessagesPromise,
      ])
      const allMessages = [...actorMessages, ...opponentMessages, ...spectatorMessages]
      expect(allMessages.filter(message => message.type === 'actionError')).toHaveLength(0)
      expect(actorMessages.filter(message => message.type === 'battleReceipt')).toHaveLength(1)
      expect(opponentMessages).toHaveLength(1)
      expect(opponentMessages[0]).toMatchObject({ type: 'battleTransition', toVersion: 2 })

      const actorUpdate = actorMessages.find(message => message.type === 'stateUpdate')
      const spectatorUpdate = spectatorMessages.find(message => message.type === 'stateUpdate')
      expect(actorUpdate).toMatchObject({
        type: 'stateUpdate',
        authorityVersion: 2,
        reason: 'transition-projection-failed',
      })
      expect(spectatorUpdate).toMatchObject({
        type: 'stateUpdate',
        authorityVersion: 2,
        reason: 'transition-projection-failed',
      })
      const actorState = actorUpdate?.state as ReturnType<typeof makeState>
      const spectatorState = spectatorUpdate?.state as ReturnType<typeof makeState>
      expect(actorState.pendingTargetSelection?.candidates).toEqual([{ type: 'cell', x: 4, y: 5 }])
      expect(spectatorState.pendingTargetSelection?.candidates).toEqual([])
      expect(actorUpdate?.stateHash).toBe(hashBattleState(actorState))
      expect(spectatorUpdate?.stateHash).toBe(hashBattleState(spectatorState))

      const opponentSnapshot = createPublicBattleResyncSnapshot(result, roomId, 'opponent')
      expect(opponentSnapshot?.authorityVersion).toBe(2)
      expect(opponentSnapshot?.state.pendingTargetSelection?.candidates).toEqual([])
      expect(opponentSnapshot?.stateHash).toBe(hashBattleState(opponentSnapshot?.state as ReturnType<typeof makeState>))
      expect(errorSpy).toHaveBeenCalledTimes(2)
    } finally {
      errorSpy.mockRestore()
      globalWithWsServer.__rvbRoomClients?.delete(roomId)
      for (const serverClient of serverClients) globalWithWsServer.__rvbWsIdentities?.delete(serverClient)
      await Promise.all(clients.map(client => closeClient(client)))
    }
  })
})
