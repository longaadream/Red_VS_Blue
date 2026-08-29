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
  __rvbPlayerWs?: Map<string, WebSocket>
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

function waitForJsonType(client: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = rejectAfterTimeout(reject, type)
    const onError = (error: Error) => {
      clearTimeout(timeout)
      client.off('message', onMessage)
      reject(error)
    }
    const onMessage = (raw: RawData) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>
        if (message.type !== type) return
        clearTimeout(timeout)
        client.off('message', onMessage)
        client.off('error', onError)
        resolve(message)
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

async function rpc(client: WebSocket, requestId: string, method: string, data: Record<string, unknown> = {}) {
  const response = waitForJsonMessage(client)
  client.send(JSON.stringify({ type: 'rpc', requestId, method, data }))
  return response
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

  test('keeps the replacement player socket registered when the stale socket closes', async () => {
    const roomId = 'reconnect-player-map-' + Date.now()
    const first = await openClientPair()
    const replacement = await openClientPair()
    try {
      const firstSubscribed = waitForJsonMessage(first.client)
      first.client.send(JSON.stringify({ type: 'subscribe', roomId, playerId: 'same-player' }))
      await expect(firstSubscribed).resolves.toMatchObject({ type: 'subscribed', roomId })

      const replacementSubscribed = waitForJsonMessage(replacement.client)
      replacement.client.send(JSON.stringify({ type: 'subscribe', roomId, playerId: 'same-player' }))
      await expect(replacementSubscribed).resolves.toMatchObject({ type: 'subscribed', roomId })
      expect(globalWithWsServer.__rvbPlayerWs?.get('same-player')).toBe(replacement.server)

      const staleServerClosed = new Promise(resolve => first.server.once('close', resolve))
      await closeClient(first.client)
      await staleServerClosed
      expect(globalWithWsServer.__rvbPlayerWs?.get('same-player')).toBe(replacement.server)
    } finally {
      if (replacement.client.readyState !== WebSocket.CLOSED) await closeClient(replacement.client)
    }
  })

  test('echoes the snapshot request id on the authoritative resync response', async () => {
    const roomId = 'correlated-resync-' + Date.now()
    const room: Room = {
      id: roomId,
      name: roomId,
      status: 'in-progress',
      players: [
        { id: 'player-red', name: 'Red' },
        { id: 'player-blue', name: 'Blue' },
      ],
      spectators: [],
      currentTurnIndex: 0,
      actions: [],
      version: 4,
      battleAuthorityVersion: 4,
      battleState: {
        type: 'server-state',
        seed: 77,
        state: makeState(),
      } as unknown as Room['battleState'],
    }
    const store = getRoomStore()
    const getRoom = vi.spyOn(store, 'getRoom').mockImplementation(async id =>
      id === roomId ? room : undefined)
    const client = await openClient()

    try {
      const initialSnapshot = waitForJsonType(client, 'stateUpdate')
      client.send(JSON.stringify({ type: 'subscribe', roomId, playerId: 'player-red' }))
      await expect(initialSnapshot).resolves.toMatchObject({
        type: 'stateUpdate',
        authorityVersion: 4,
      })

      const correlatedSnapshot = waitForJsonType(client, 'stateUpdate')
      client.send(JSON.stringify({
        type: 'requestBattleSnapshot',
        requestId: 'authority-sync-test-1',
      }))
      await expect(correlatedSnapshot).resolves.toMatchObject({
        type: 'stateUpdate',
        requestId: 'authority-sync-test-1',
        authorityVersion: 4,
      })
    } finally {
      await closeClient(client)
      getRoom.mockRestore()
    }
  })

  test('lists only live public battles while keeping dormant battles available for rejoin', async () => {
    const active = await openClientPair()
    const lobby = await openClient()
    const store = getRoomStore()
    const activeRoomId = 'active-public-' + Date.now()
    const dormantRoomId = 'dormant-rejoin-' + Date.now()
    const waitingRoomId = 'waiting-public-' + Date.now()
    const terminalRoomId = 'terminal-stale-status-' + Date.now()
    const room = (id: string, status: Room['status'], playerId: string): Room => ({
      id,
      name: id,
      status,
      players: [{ id: playerId, name: playerId }],
      spectators: [],
      currentTurnIndex: 0,
      actions: [],
      version: 1,
    })
    const activeRoom = room(activeRoomId, 'in-progress', 'active-player')
    const dormantRoom = room(dormantRoomId, 'in-progress', 'dormant-player')
    const waitingRoom = room(waitingRoomId, 'waiting', 'waiting-player')
    const terminalRoom = room(terminalRoomId, 'in-progress', 'terminal-player')
    terminalRoom.battleState = {
      type: 'server-state',
      seed: 1,
      state: {
        ...makeState(),
        terminalResult: { status: 'finished', winnerPlayerId: null, loserPlayerId: null, reason: 'round-limit' },
      },
    } as any
    const rooms = [activeRoom, dormantRoom, waitingRoom, terminalRoom]
    const getAllRooms = vi.spyOn(store, 'getAllRooms').mockResolvedValue(rooms)
    const getRoom = vi.spyOn(store, 'getRoom').mockImplementation(async id =>
      rooms.find(candidate => candidate.id === id))

    try {
      globalWithWsServer.__rvbRoomClients?.set(activeRoomId, new Set([active.server]))
      globalWithWsServer.__rvbWsIdentities?.set(active.server, {
        roomId: activeRoomId,
        playerId: 'active-player',
      })

      const listed = await rpc(lobby, 'live-room-list', 'rooms.list')
      const listedRooms = (listed.data as { rooms: Array<{ id: string }> }).rooms
      expect(listedRooms.map(candidate => candidate.id)).toEqual([activeRoomId, waitingRoomId])

      const rejoin = await rpc(lobby, 'dormant-room-get', 'rooms.get', { roomId: dormantRoomId })
      expect(rejoin).toMatchObject({
        ok: true,
        data: { id: dormantRoomId, status: 'in-progress' },
      })

      const terminal = await rpc(lobby, 'terminal-room-get', 'rooms.get', { roomId: terminalRoomId })
      expect(terminal).toMatchObject({
        ok: true,
        data: { id: terminalRoomId, status: 'finished' },
      })
    } finally {
      await Promise.all([closeClient(active.client), closeClient(lobby)])
      getAllRooms.mockRestore()
      getRoom.mockRestore()
      globalWithWsServer.__rvbRoomClients?.delete(activeRoomId)
      globalWithWsServer.__rvbWsIdentities?.delete(active.server)
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
  test('serves health and multiplayer catalogs over WebSocket RPC', async () => {
    const client = await openClient()
    try {
      await expect(rpc(client, 'health', 'system.health')).resolves.toMatchObject({
        type: 'rpcResult',
        requestId: 'health',
        ok: true,
        data: { ok: true, protocol: 'rvb-ws', protocolVersion: 2 },
      })
      const maps = await rpc(client, 'maps', 'catalog.maps')
      expect(maps).toMatchObject({ type: 'rpcResult', requestId: 'maps', ok: true })
      expect((maps.data as { maps: Array<{ id: string }> }).maps.map(map => map.id)).toEqual([
        'large-hole-arena',
        'open-expanse',
        'winding-pass',
        'narrow-corridors',
      ])
      const pieces = await rpc(client, 'pieces', 'catalog.pieces')
      expect((pieces.data as { pieces: unknown[] }).pieces.length).toBeGreaterThanOrEqual(16)
      const skills = await rpc(client, 'skills', 'catalog.skills')
      expect((skills.data as { skills: unknown[] }).skills.length).toBeGreaterThan(0)
      const card = await rpc(client, 'card', 'catalog.card', { cardId: 'holy-charge' })
      expect(card).toMatchObject({ type: 'rpcResult', requestId: 'card', ok: true })
      expect(card.data).toMatchObject({ id: 'holy-charge' })
      const getAllRooms = vi.spyOn(getRoomStore(), 'getAllRooms').mockResolvedValue([])
      const rooms = await rpc(client, 'rooms-list', 'rooms.list')
      expect(rooms).toMatchObject({ type: 'rpcResult', requestId: 'rooms-list', ok: true })
      expect(Array.isArray((rooms.data as { rooms: unknown[] }).rooms)).toBe(true)
      getAllRooms.mockRestore()
    } finally {
      await closeClient(client)
    }
  })

  test('replays duplicate RPC request ids without applying the mutation twice', async () => {
    const client = await openClient()
    const store = getRoomStore()
    const getRoom = vi.spyOn(store, 'getRoom').mockResolvedValue(undefined)
    const setRoom = vi.spyOn(store, 'setRoom').mockResolvedValue(undefined)
    const getAllRooms = vi.spyOn(store, 'getAllRooms').mockResolvedValue([])
    try {
      const responses = waitForJsonMessages(client, 2)
      const payload = JSON.stringify({
        type: 'rpc',
        requestId: 'duplicate-create',
        method: 'rooms.create',
        data: {
          hostId: 'host',
          hostName: 'Host',
          mapId: 'large-hole-arena',
        },
      })
      client.send(payload)
      client.send(payload)

      const received = await responses
      expect(received).toHaveLength(2)
      expect(received.every(message => message.ok === true)).toBe(true)
      expect(received[0].data).toEqual(received[1].data)
      expect(setRoom).toHaveBeenCalledTimes(1)
    } finally {
      getRoom.mockRestore()
      setRoom.mockRestore()
      getAllRooms.mockRestore()
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

  test('projects and sends the actor transition first without a standalone successful receipt', async () => {
    const roomId = 'actor-first-broadcast-' + Date.now()
    const opponentPair = await openClientPair()
    const spectatorPair = await openClientPair()
    const actorPair = await openClientPair()
    const clients = [opponentPair.client, spectatorPair.client, actorPair.client]
    const serverClients = [opponentPair.server, spectatorPair.server, actorPair.server]
    const actorSendSpy = vi.spyOn(actorPair.server, 'send')

    try {
      const roomClients = globalWithWsServer.__rvbRoomClients
      const identities = globalWithWsServer.__rvbWsIdentities
      if (!roomClients || !identities) throw new Error('WebSocket recipient registries are unavailable')
      roomClients.set(roomId, new Set(serverClients))
      identities.set(opponentPair.server, { roomId, playerId: 'opponent' })
      identities.set(spectatorPair.server, { roomId })
      identities.set(actorPair.server, { roomId, playerId: 'actor' })

      const state = makeState()
      const result = {
        kind: 'applied',
        snapshot: { state, seed: 77, stateHash: 'committed', authorityVersion: 2, serverNow: 100 },
        actionResult: { state },
        receipt: { clientActionId: 'actor-action-2', status: 'applied', authorityVersion: 2 },
        transition: { fromVersion: 1, toVersion: 2, playerId: 'actor' },
        previousAuthorityState: makeState(),
        nextAuthorityState: state,
      } as unknown as DispatchRoomBattleActionResult
      const projectionOrder: Array<string | undefined> = []
      const opponentMessagePromise = waitForJsonMessage(opponentPair.client)
      const spectatorMessagePromise = waitForJsonMessage(spectatorPair.client)
      const actorMessagePromise = waitForJsonMessage(actorPair.client)

      broadcastBattleTransition(roomId, result, {
        createTransitionUpdate: (_result, projectedRoomId, viewerPlayerId) => {
          projectionOrder.push(viewerPlayerId)
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
            stateHash: 'projected',
            serverNow: 100,
          } as never
        },
      })

      const [opponentMessage, spectatorMessage, actorMessage] = await Promise.all([
        opponentMessagePromise,
        spectatorMessagePromise,
        actorMessagePromise,
      ])
      expect(projectionOrder).toEqual(['actor', 'opponent', undefined])
      expect(opponentMessage).toMatchObject({ type: 'battleTransition', toVersion: 2 })
      expect(spectatorMessage).toMatchObject({ type: 'battleTransition', toVersion: 2 })
      expect(actorMessage).toMatchObject({
        type: 'battleTransition',
        toVersion: 2,
        receipt: result.receipt,
      })
      expect(actorMessage.type).not.toBe('battleReceipt')
      expect(actorSendSpy).toHaveBeenCalledTimes(1)
      const actorPayload = JSON.parse(String(actorSendSpy.mock.calls[0]?.[0])) as Record<string, unknown>
      expect(actorPayload).toMatchObject({ type: 'battleTransition', receipt: result.receipt })
    } finally {
      actorSendSpy.mockRestore()
      globalWithWsServer.__rvbRoomClients?.delete(roomId)
      for (const serverClient of serverClients) globalWithWsServer.__rvbWsIdentities?.delete(serverClient)
      await Promise.all(clients.map(client => closeClient(client)))
    }
  })
})
