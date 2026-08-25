import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { NextRequest } from 'next/server'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { Room } from '../lib/game/room-store'

type JsonObject = Record<string, unknown>
type TestIdentity = { id: string; publicKey: string; privateKey: CryptoKey }

let firstIdentity: TestIdentity
let secondIdentity: TestIdentity

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function createTestIdentity(): Promise<TestIdentity> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const publicBytes = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  const publicKey = bytesToHex(publicBytes)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', publicBytes))
  return { id: bytesToHex(digest).slice(0, 8), publicKey, privateKey: pair.privateKey }
}

async function signBattleAction(identity: TestIdentity, roomId: string, action: JsonObject) {
  const payload = { type: 'battle-action', roomId, playerId: identity.id, action, timestamp: Date.now() }
  const signature = await globalThis.crypto.subtle.sign(
    'Ed25519',
    identity.privateKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  return { publicKey: identity.publicKey, payload, signature: bytesToHex(new Uint8Array(signature)) }
}

const memoryStore = vi.hoisted(() => {
  const rooms = new Map<string, Room>()
  let writes = 0
  let readBarrier: { remaining: number; promise: Promise<void>; release: () => void } | null = null


  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'function' ? undefined : candidate,
  )) as T
  const normalize = (roomId: string) => roomId.trim().toLowerCase()

  return {
    reset() {
      readBarrier?.release()
      readBarrier = null
      rooms.clear()
      writes = 0
    },
    armReadBarrier(participants: number) {
      let release = () => {}
      const promise = new Promise<void>(resolve => { release = resolve })
      readBarrier = { remaining: participants, promise, release }
    },
    seed(room: Room) {
      rooms.set(normalize(room.id), copy(room))
    },
    snapshot(roomId: string) {
      const room = rooms.get(normalize(roomId))
      return room ? copy(room) : undefined
    },
    writeCount() {
      return writes
    },
    async getRoom(roomId: string) {
      const room = rooms.get(normalize(roomId))
      const barrier = readBarrier
      if (barrier) {
        barrier.remaining -= 1
        if (barrier.remaining === 0) {
          readBarrier = null
          barrier.release()
        }
        await barrier.promise
      }
      return room ? copy(room) : undefined
    },
    async getAllRooms() {
      return [...rooms.values()].map(copy)
    },
    async createRoom(roomId: string, name: string) {
      const id = normalize(roomId)
      const created: Room = {
        id,
        name,
        status: 'waiting',
        players: [],
        spectators: [],
        currentTurnIndex: 0,
        actions: [],
      }
      rooms.set(id, copy(created))
      return copy(created)
    },
    async setRoom(roomId: string, room: Room) {
      const id = normalize(roomId)
      const current = rooms.get(id)
      rooms.set(id, { ...copy(room), id, version: (current?.version ?? 0) + 1 })
      writes += 1
    },
    async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number) {
      const id = normalize(roomId)
      const current = rooms.get(id)
      if (!current || current.version !== expectedVersion) return false
      rooms.set(id, { ...copy(room), id, version: expectedVersion + 1 })
      writes += 1
      return true
    },
  }
})

vi.mock('../lib/game/room-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/game/room-store')>()
  return { ...actual, roomStore: memoryStore, getRoomStore: () => memoryStore }
})

import { POST as roomActionPost } from '../app/api/rooms/[roomId]/actions/route'
import { GET as battleGet, POST as battlePost } from '../app/api/rooms/[roomId]/battle/route'
import { GET as roomGet, POST as roomPost } from '../app/api/rooms/[roomId]/route'
import { POST as roomsPost } from '../app/api/rooms/route'
import { startWsServer } from '../lib/ws-server'

const lightRoster = [
  'ana',
  'anduin',
  'blue-kenshin',
  'blue-minato',
  'blue-naruto',
  'blue-tirion-fordring',
  'blue-watcher',
  'hashirama-edo',
]

const darkRoster = [
  'arthas',
  'guldan',
  'kiljaedan',
  'reaper',
  'red-blackwidow',
  'red-doomsday-fist',
  'red-hidan',
  'red-illidan',
]

function pieces(templateIds: string[]) {
  return templateIds.map(templateId => ({ templateId, faction: 'client-value-is-ignored' }))
}

function room(id: string, secondAlignment: 'light' | 'dark' = 'dark'): Room {
  return {
    id,
    name: id,
    status: 'ready',
    players: [
      { id: 'alice', name: 'Alice', seat: 'red', faction: 'red', alignment: 'light' },
      { id: 'bob', name: 'Bob', seat: 'blue', faction: 'blue', alignment: secondAlignment },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    mapId: 'large-battlefield',
    version: 1,
  }
}

function signedRoom(id: string, secondAlignment: 'light' | 'dark' = 'dark'): Room {
  const next = room(id, secondAlignment)
  next.players = [
    { id: firstIdentity.id, name: 'Signed Alice', seat: 'red', faction: 'red', alignment: 'light' },
    { id: secondIdentity.id, name: 'Signed Bob', seat: 'blue', faction: 'blue', alignment: secondAlignment },
  ]
  return next
}

const globalWithWsServer = globalThis as typeof globalThis & {
  __rvbWss?: WebSocketServer | null
  __rvbWsUpgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
}
const wsMessageQueues = new WeakMap<WebSocket, JsonObject[]>()
const wsMessageWaiters = new WeakMap<WebSocket, {
  resolve: (message: JsonObject) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()

let serverUrl: string
let httpServer: Server


function openClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(serverUrl)
    wsMessageQueues.set(client, [])
    client.on('message', raw => {
      const message = JSON.parse(raw.toString()) as JsonObject
      const waiter = wsMessageWaiters.get(client)
      if (waiter) {
        clearTimeout(waiter.timeout)
        wsMessageWaiters.delete(client)
        waiter.resolve(message)
      } else {
        wsMessageQueues.get(client)?.push(message)
      }
    })
    client.once('open', () => resolve(client))
    client.once('error', reject)
  })
}

function receiveJson(client: WebSocket): Promise<JsonObject> {
  const queued = wsMessageQueues.get(client)?.shift()
  if (queued) return Promise.resolve(queued)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wsMessageWaiters.delete(client)
      reject(new Error('Timed out waiting for WebSocket response'))
    }, 10_000)
    wsMessageWaiters.set(client, { resolve, reject, timeout })
    client.once('error', error => {
      const waiter = wsMessageWaiters.get(client)
      if (!waiter) return
      clearTimeout(waiter.timeout)
      wsMessageWaiters.delete(client)
      waiter.reject(error)
    })
  })
}

async function receiveType(client: WebSocket, expectedType: string): Promise<JsonObject> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const message = await receiveJson(client)
    if (message.type === expectedType) return message
  }
  throw new Error(`Timed out waiting for WebSocket message ${expectedType}`)
}

function collectMessages(client: WebSocket) {
  const history = new Map<string, JsonObject>()
  const waiters = new Map<string, (message: JsonObject) => void>()
  const onMessage = (raw: RawData) => {
    const message = JSON.parse(raw.toString()) as JsonObject
    const type = String(message.type ?? '')
    const resolve = waiters.get(type)
    if (resolve) {
      waiters.delete(type)
      resolve(message)
    } else {
      history.set(type, message)
    }
  }
  client.on('message', onMessage)

  return {
    waitFor(type: string): Promise<JsonObject> {
      const existing = history.get(type)
      if (existing) {
        history.delete(type)
        return Promise.resolve(existing)
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(type)
          reject(new Error(`Timed out waiting for WebSocket message ${type}`))
        }, 10_000)
        waiters.set(type, message => {
          clearTimeout(timeout)
          resolve(message)
        })
      })
    },
    stop() { client.off('message', onMessage) },
  }
}

async function httpCreate(mapId: string, hostId = 'alice') {
  const request = new NextRequest('http://localhost/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'pve', hostId, playerName: 'Alice', mapId }),
  })
  const response = await roomsPost(request)
  return { status: response.status, body: await response.json() as JsonObject }
}

async function wsCreate(mapId: string) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: 'create-fixed-map',
      method: 'rooms.create',
      data: { hostId: 'alice', name: 'Fixed map room', mapId },
    }))
    return await response
  } finally {
    client.close()
  }
}

async function httpSelect(roomId: string, playerId: string, templateIds: string[], alignment: 'light' | 'dark' = 'light') {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'select-pieces', playerId, alignment, pieces: pieces(templateIds) }),
  })
  const response = await roomActionPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function httpStart(roomId: string, playerId: string) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start-game', playerId }),
  })
  const response = await roomActionPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function legacyHttpStart(roomId: string) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  })
  const response = await roomPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function legacyHttpJoin(roomId: string, playerId: string, alignment: 'light' | 'dark') {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'join', playerId, alignment }),
  })
  const response = await roomPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function wsSelect(roomId: string, playerId: string, templateIds: string[], alignment: 'light' | 'dark' = 'light') {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `${roomId}-${playerId}`,
      method: 'rooms.action',
      data: { roomId, action: 'select-pieces', playerId, alignment, pieces: pieces(templateIds) },
    }))
    return await response
  } finally {
    client.close()
  }
}

async function wsGet(roomId: string) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `${roomId}-reconnect`,
      method: 'rooms.get',
      data: { roomId },
    }))
    return await response
  } finally {
    client.close()
  }
}

async function wsRoomAction(roomId: string, playerId: string, action: string) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `${roomId}-${action}`,
      method: 'rooms.action',
      data: { roomId, playerId, action },
    }))
    return await response
  } finally {
    client.close()
  }
}

async function httpBattleAction(
  roomId: string,
  playerId: string,
  action: JsonObject,
  authenticatedViewer?: string,
  identity?: TestIdentity,
) {
  const auth = identity ? await signBattleAction(identity, roomId, action) : undefined
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/battle`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authenticatedViewer ? { 'x-player-id': authenticatedViewer } : {}),
    },
    body: JSON.stringify({ playerId, action, auth }),
  })
  const response = await battlePost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}
async function httpBattleSnapshot(roomId: string, viewerPlayerId: string) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/battle?viewerPlayerId=${viewerPlayerId}`)
  const response = await battleGet(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}
async function httpRoomSnapshot(roomId: string) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}`)
  const response = await roomGet(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}


async function wsBattleAction(roomId: string, playerId: string, action: JsonObject, identity?: TestIdentity, responseType = 'stateUpdate') {
  const client = await openClient()
  try {
    client.send(JSON.stringify({ type: 'subscribe', roomId, playerId }))
    await receiveType(client, 'subscribed')
    await receiveType(client, 'stateUpdate')
    const auth = identity ? await signBattleAction(identity, roomId, action) : undefined
    client.send(JSON.stringify({ type: 'action', action, auth }))
    return await receiveType(client, responseType)
  } finally {
    client.close()
  }
}

async function wsBattleSnapshot(roomId: string, viewerPlayerId: string) {
  const client = await openClient()
  try {
    client.send(JSON.stringify({ type: 'subscribe', roomId, playerId: viewerPlayerId }))
    await receiveType(client, 'subscribed')
    return await receiveType(client, 'stateUpdate')
  } finally {
    client.close()
  }
}

describe('Demo roster HTTP/WebSocket integration', () => {
  beforeAll(async () => {
    firstIdentity = await createTestIdentity()
    secondIdentity = await createTestIdentity()
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
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close(error => error ? reject(error) : resolve())
    })
  })

  beforeEach(() => memoryStore.reset())

  it('forces the Demo map at HTTP and WebSocket room creation boundaries', async () => {
    const http = await httpCreate('large-battlefield')
    expect(http.status).toBe(200)
    const httpRoomId = String(http.body.id)
    expect(memoryStore.snapshot(httpRoomId)?.mapId).toBe('large-hole-arena')

    memoryStore.reset()
    const ws = await wsCreate('large-battlefield')
    expect(ws).toMatchObject({ ok: true, data: { mapId: 'large-hole-arena' } })
    const wsRoomId = String((ws.data as JsonObject).id)
    expect(memoryStore.snapshot(wsRoomId)?.mapId).toBe('large-hole-arena')
  })

  it('locks a deterministic keep-all deployment for the PVE bot', async () => {
    const created = await httpCreate('large-battlefield', firstIdentity.id)
    const roomId = String(created.body.id)

    expect(memoryStore.snapshot(roomId)?.players).toMatchObject([
      { id: firstIdentity.id, seat: 'red', alignment: 'light' },
      { id: 'bot', seat: 'blue', alignment: 'dark' },
    ])

    const selected = await httpSelect(roomId, firstIdentity.id, lightRoster)
    expect(selected.status).toBe(200)

    const started = memoryStore.snapshot(roomId)
    const awaitingState = (started?.battleState as unknown as {
      state: {
        deployment: {
          status: string
          choices: Record<string, { pieceId: string | null }>
          locks: Record<string, { locked: boolean; reason?: string }>
        }
        gameStartFired?: boolean
        extensions?: { playerAlignments?: Record<string, 'light' | 'dark'> }
      }
    })?.state
    expect(awaitingState.deployment).toMatchObject({
      status: 'awaiting-locks',
      choices: {},
      locks: { bot: { locked: true, reason: 'player' } },
    })
    expect(awaitingState.gameStartFired).toBeFalsy()
    expect(awaitingState.extensions?.playerAlignments).toEqual({ [firstIdentity.id]: 'light', bot: 'dark' })

    const completed = await httpBattleAction(roomId, firstIdentity.id, {
      type: 'deploymentLock',
      playerId: firstIdentity.id,
      clientActionId: 'alice-pve-keep',
    }, firstIdentity.id, firstIdentity)
    expect(completed.status).toBe(200)

    const completedState = (memoryStore.snapshot(roomId)?.battleState as unknown as {
      state: {
        deployment: { status: string }
        gameStartFired?: boolean
        turn: { phase: string }
        pendingTargetSelection?: {
          playerId: string
          selectionId: string
          stateRevision: number
          source?: { id?: string }
        }
      }
    }).state
    expect(completedState.deployment.status).toBe('complete')
    expect(completedState.gameStartFired).toBe(true)
    expect(completedState.turn.phase).toBe('start')
    expect(completedState.pendingTargetSelection).toMatchObject({
      playerId: firstIdentity.id,
      source: { id: 'rule-minato-anchor-begin-turn' },
    })

    const minato = completedState.pendingTargetSelection!
    const cancelled = await httpBattleAction(roomId, firstIdentity.id, {
      type: 'cancelPendingSelection',
      playerId: firstIdentity.id,
      selectionId: minato.selectionId,
      stateRevision: minato.stateRevision,
      clientActionId: 'alice-pve-cancel-minato',
    }, firstIdentity.id, firstIdentity)
    expect(cancelled.status).toBe(200)

    const watcherState = (memoryStore.snapshot(roomId)?.battleState as unknown as {
      state: {
        turn: { phase: string }
        pendingOptionSelection?: {
          playerId: string
          selectionId: string
          stateRevision: number
          canCancel?: boolean
          source?: { id?: string }
        }
      }
    }).state
    expect(watcherState.turn.phase).toBe('start')
    expect(watcherState.pendingOptionSelection).toMatchObject({
      playerId: firstIdentity.id,
      canCancel: false,
      source: { id: 'rule-watcher-form' },
    })

    const watcher = watcherState.pendingOptionSelection!
    const resolved = await httpBattleAction(roomId, firstIdentity.id, {
      type: 'pendingOptionSelect',
      playerId: firstIdentity.id,
      selectedOption: 'calm',
      selectionId: watcher.selectionId,
      stateRevision: watcher.stateRevision,
      clientActionId: 'alice-pve-watcher-calm',
    }, firstIdentity.id, firstIdentity)
    expect(resolved.status).toBe(200)

    const actionState = (memoryStore.snapshot(roomId)?.battleState as unknown as {
      state: { turn: { phase: string }; pendingOptionSelection?: unknown; pendingTargetSelection?: unknown }
    }).state
    expect(actionState.turn.phase).toBe('action')
    expect(actionState.pendingOptionSelection).toBeUndefined()
    expect(actionState.pendingTargetSelection).toBeUndefined()
  })

  it('returns equivalent stable errors and leaves state untouched', async () => {
    memoryStore.seed(room('http-invalid'))
    const httpBefore = memoryStore.snapshot('http-invalid')
    const http = await httpSelect('http-invalid', 'alice', lightRoster.slice(0, 7))

    expect(http.status).toBe(400)
    expect(http.body).toMatchObject({ success: false, code: 'ROSTER_INVALID_COUNT' })
    expect(memoryStore.snapshot('http-invalid')).toEqual(httpBefore)
    expect(memoryStore.writeCount()).toBe(0)

    memoryStore.reset()
    memoryStore.seed(room('ws-invalid'))
    const wsBefore = memoryStore.snapshot('ws-invalid')
    const ws = await wsSelect('ws-invalid', 'alice', lightRoster.slice(0, 7))

    expect(ws).toMatchObject({ ok: false, code: 'ROSTER_INVALID_COUNT' })
    expect(ws.context).toEqual(http.body.context)
    expect(ws.error).toBe(http.body.error)
    expect(memoryStore.snapshot('ws-invalid')).toEqual(wsBefore)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it('returns equivalent success data and makes a repeated submit idempotent', async () => {
    memoryStore.seed(room('http-valid'))
    const http = await httpSelect('http-valid', 'alice', lightRoster)
    const writesAfterHttpLock = memoryStore.writeCount()
    const httpDuplicate = await httpSelect('http-valid', 'alice', [...lightRoster].reverse())
    const lockedBeforeAlignmentChange = memoryStore.snapshot('http-valid')
    const alignmentChange = await legacyHttpJoin('http-valid', 'alice', 'dark')

    expect(alignmentChange).toMatchObject({ status: 409, body: { success: false, code: 'ROSTER_LOCKED' } })
    expect(memoryStore.snapshot('http-valid')).toEqual(lockedBeforeAlignmentChange)
    expect(memoryStore.writeCount()).toBe(writesAfterHttpLock)

    memoryStore.reset()
    memoryStore.seed(room('ws-valid'))
    const ws = await wsSelect('ws-valid', 'alice', lightRoster)
    const writesAfterWsLock = memoryStore.writeCount()
    const wsDuplicate = await wsSelect('ws-valid', 'alice', [...lightRoster].reverse())

    const httpResult = {
      success: http.body.success,
      duplicate: http.body.duplicate,
      locked: http.body.locked,
      playerId: http.body.playerId,
      selectedPiecesCount: http.body.selectedPiecesCount,
      manifestVersion: http.body.manifestVersion,
    }
    expect(ws.data).toMatchObject(httpResult)
    expect(httpDuplicate.body.duplicate).toBe(true)
    expect((wsDuplicate.data as JsonObject).duplicate).toBe(true)
    expect(memoryStore.writeCount()).toBe(writesAfterWsLock)
    expect(writesAfterHttpLock).toBe(1)
  })

  it('starts only after both mirror rosters lock and creates one instance per owner', async () => {
    memoryStore.seed(room('mirror-room', 'light'))

    const first = await httpSelect('mirror-room', 'alice', lightRoster)
    expect(first.body.success).toBe(true)
    expect(memoryStore.snapshot('mirror-room')?.status).toBe('ready')
    expect(memoryStore.snapshot('mirror-room')?.battleState).toBeUndefined()

    const prematureStart = await httpStart('mirror-room', 'alice')
    expect(prematureStart).toMatchObject({
      status: 400,
      body: { success: false, code: 'ROSTER_NOT_ALL_LOCKED' },
    })
    expect(memoryStore.snapshot('mirror-room')?.battleState).toBeUndefined()

    const legacyPrematureStart = await legacyHttpStart('mirror-room')
    expect(legacyPrematureStart).toMatchObject({
      status: 400,
      body: { success: false, code: 'ROSTER_NOT_ALL_LOCKED' },
    })
    expect(memoryStore.snapshot('mirror-room')?.battleState).toBeUndefined()

    const second = await wsSelect('mirror-room', 'bob', lightRoster)
    expect(second).toMatchObject({ ok: true, data: { success: true } })

    const started = memoryStore.snapshot('mirror-room')
    if (!started) throw new Error('Expected mirror-room to remain in the store')
    expect(started.status).toBe('in-progress')
    expect(started.mapId).toBe('large-hole-arena')
    const battleState = started.battleState as unknown as {
      state: {
        map: { id: string }
        pieces: Array<{ templateId: string; ownerPlayerId: string; isCore?: boolean }>
        deployment: { status: string }
        gameStartFired?: boolean
        extensions?: {
          playerAlignments?: Record<string, 'light' | 'dark'>
        }
      }
    }
    expect(battleState.state.map.id).toBe('large-hole-arena')
    expect(battleState.state.deployment.status).toBe('awaiting-locks')
    expect(battleState.state.gameStartFired).toBeFalsy()
    const battlePieces = battleState.state.pieces
    expect(battlePieces).toHaveLength(16)
    expect(battlePieces.every(piece => piece.isCore === true)).toBe(true)
    expect(battlePieces.filter(piece => piece.templateId === lightRoster[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerPlayerId: 'alice' }),
      expect.objectContaining({ ownerPlayerId: 'bob' }),
    ]))
    expect(battlePieces.filter(piece => piece.templateId === lightRoster[0])).toHaveLength(2)
    expect(battleState.state.extensions?.playerAlignments).toEqual({
      alice: 'light',
      bob: 'light',
    })
  })

  it('preserves canonical alignments when players reconnect through a new WebSocket', async () => {
    memoryStore.seed(room('reconnect-room'))

    await legacyHttpJoin('reconnect-room', 'alice', 'light')
    await legacyHttpJoin('reconnect-room', 'bob', 'dark')
    const reconnected = await wsGet('reconnect-room')

    expect(reconnected).toMatchObject({
      ok: true,
      data: {
        players: [
          { id: 'alice', seat: 'red', faction: 'red', alignment: 'light' },
          { id: 'bob', seat: 'blue', faction: 'blue', alignment: 'dark' },
        ],
      },
    })
  })

  it('carries mixed alignments independently while deriving first turn from the red seat', async () => {
    memoryStore.seed(room('mixed-room'))

    await httpSelect('mixed-room', 'alice', lightRoster, 'light')
    await wsSelect('mixed-room', 'bob', darkRoster, 'dark')

    const started = memoryStore.snapshot('mixed-room')
    const state = (started?.battleState as unknown as {
      state: {
        turn: { currentPlayerId: string }
        extensions?: { playerAlignments?: Record<string, 'light' | 'dark'> }
      }
    }).state
    expect(started?.players).toMatchObject([
      { id: 'alice', seat: 'red', alignment: 'light' },
      { id: 'bob', seat: 'blue', alignment: 'dark' },
    ])
    expect(state.extensions?.playerAlignments).toEqual({ alice: 'light', bob: 'dark' })
    expect(started?.firstPlayerId).toBe('alice')
    expect(state.turn.currentPlayerId).toBe('alice')
  })

  it('rejects duplicate seats before writing a battle state', async () => {
    const invalidRoom = room('duplicate-seats')
    invalidRoom.players[1].seat = 'red'
    invalidRoom.players[1].faction = 'red'
    memoryStore.seed(invalidRoom)

    const first = await httpSelect('duplicate-seats', 'alice', lightRoster, 'light')
    const second = await httpSelect('duplicate-seats', 'bob', darkRoster, 'dark')

    expect(first.status).toBe(200)
    expect(second).toMatchObject({
      status: 500,
      body: { error: expect.stringContaining('exactly one red and one blue seat') },
    })
    expect(memoryStore.snapshot('duplicate-seats')).toMatchObject({ status: 'ready' })
    expect(memoryStore.snapshot('duplicate-seats')?.battleState).toBeUndefined()
  })

  it('publishes one identical public deployment snapshot to both players and spectators', async () => {
    memoryStore.seed(room('public-deployment', 'light'))
    await httpSelect('public-deployment', 'alice', lightRoster)
    await wsSelect('public-deployment', 'bob', lightRoster)

    const alice = await httpBattleSnapshot('public-deployment', 'alice')
    const bob = await httpBattleSnapshot('public-deployment', 'bob')
    const spectator = await wsBattleSnapshot('public-deployment', 'spectator')

    expect(alice.status).toBe(200)
    expect(bob.status).toBe(200)
    expect(bob.body.state).toEqual(alice.body.state)
    expect(spectator.state).toEqual(alice.body.state)
    expect(spectator.authorityVersion).toBe(alice.body.authorityVersion)

    const state = alice.body.state as {
      pieces: Array<{ isCore?: boolean }>
      deployment: {
        status: string
        choices: Record<string, unknown>
        locks: Record<string, { locked: boolean }>
      }
      extensions?: { debugBattle?: { actionLog?: Array<{ deployment?: { choices?: unknown } }> } }
    }
    expect(state.pieces.filter(piece => piece.isCore)).toHaveLength(16)
    expect(state.deployment).toMatchObject({
      status: 'awaiting-locks',
      choices: {},
      locks: { alice: { locked: false }, bob: { locked: false } },
    })
    expect(state.extensions?.debugBattle?.actionLog?.every(entry => entry.deployment?.choices === undefined)).toBe(true)
  })

  it('rejects same-ID HTTP and WebSocket impersonation without changing room state or version', async () => {
    memoryStore.seed(signedRoom('forged-deployment', 'light'))
    await httpSelect('forged-deployment', firstIdentity.id, lightRoster)
    await wsSelect('forged-deployment', secondIdentity.id, lightRoster)
    const before = memoryStore.snapshot('forged-deployment')
    const writesBefore = memoryStore.writeCount()
    const action = {
      type: 'deploymentLock',
      playerId: firstIdentity.id,
      clientActionId: 'forged-alice-lock',
    }

    const forgedHttp = await httpBattleAction(
      'forged-deployment',
      firstIdentity.id,
      action,
      firstIdentity.id,
    )
    const forgedWs = await wsBattleAction(
      'forged-deployment',
      firstIdentity.id,
      action,
      undefined,
      'actionError',
    )

    expect(forgedHttp).toMatchObject({ status: 401, body: { code: 'BATTLE_AUTH_REQUIRED' } })
    expect(forgedWs).toMatchObject({ type: 'actionError', code: 'BATTLE_AUTH_REQUIRED' })
    expect(memoryStore.snapshot('forged-deployment')).toEqual(before)
    expect(memoryStore.writeCount()).toBe(writesBefore)
  })

  it('projects pending choices out of room GET and repeated start responses', async () => {
    memoryStore.seed(signedRoom('room-projection', 'light'))
    await httpSelect('room-projection', firstIdentity.id, lightRoster)
    await wsSelect('room-projection', secondIdentity.id, lightRoster)
    const internal = memoryStore.snapshot('room-projection')
    const state = (internal?.battleState as unknown as {
      state: { pieces: Array<{ instanceId: string; ownerPlayerId: string; isCore?: boolean }> }
    }).state
    const selectedCore = state.pieces.find(piece => piece.ownerPlayerId === firstIdentity.id && piece.isCore)
    if (!selectedCore) throw new Error('Expected a selectable signed-player core piece')

    const choice = {
      type: 'deploymentChoice',
      playerId: firstIdentity.id,
      pieceId: selectedCore.instanceId,
      clientActionId: 'private-room-choice',
    }
    const chosen = await httpBattleAction(
      'room-projection', firstIdentity.id, choice, firstIdentity.id, firstIdentity,
    )
    expect(chosen.status).toBe(200)

    const roomResponse = await httpRoomSnapshot('room-projection')
    const startResponse = await httpStart('room-projection', firstIdentity.id)
    const wsRoomResponse = await wsGet('room-projection')
    const wsStartResponse = await wsRoomAction('room-projection', firstIdentity.id, 'start-game')
    expect(roomResponse.status).toBe(200)
    expect(startResponse.status).toBe(200)
    expect(wsRoomResponse.ok).toBe(true)
    expect(wsStartResponse.ok).toBe(true)
    const projectedStates = [
      (roomResponse.body.battleState as JsonObject).state as JsonObject,
      ((startResponse.body.room as JsonObject).battleState as JsonObject).state as JsonObject,
      (((wsRoomResponse.data as JsonObject).battleState as JsonObject).state as JsonObject),
      (((wsStartResponse.data as JsonObject).battleState as JsonObject).state as JsonObject),
    ]
    for (const projected of projectedStates) {
      expect((projected.deployment as JsonObject).choices).toEqual({})
      expect(((projected.extensions as JsonObject).debugBattle as JsonObject).actionLog).toEqual([])
    }
  })

  it('applies the same deployment command through HTTP and WebSocket authority', async () => {
    memoryStore.seed(signedRoom('transport-source', 'light'))
    await httpSelect('transport-source', firstIdentity.id, lightRoster)
    await wsSelect('transport-source', secondIdentity.id, lightRoster)
    const source = memoryStore.snapshot('transport-source')
    if (!source?.battleState) throw new Error('Expected a started deployment battle')

    memoryStore.seed({ ...source, id: 'http-deployment', version: 1 })
    memoryStore.seed({ ...source, id: 'ws-deployment', version: 1 })
    const action = { type: 'deploymentChoice', playerId: firstIdentity.id, pieceId: null, clientActionId: 'alice-keep' }

    const http = await httpBattleAction('http-deployment', firstIdentity.id, action, firstIdentity.id, firstIdentity)
    const ws = await wsBattleAction('ws-deployment', firstIdentity.id, action, firstIdentity)

    expect(http.status).toBe(200)
    expect(ws.authorityVersion).toBe(http.body.authorityVersion)
    expect(ws.stateHash).toBe(http.body.stateHash)
    const httpState = (memoryStore.snapshot('http-deployment')?.battleState as unknown as { state: unknown }).state
    const wsState = (memoryStore.snapshot('ws-deployment')?.battleState as unknown as { state: unknown }).state
    expect(wsState).toEqual(httpState)
  })

  it('commits exactly one terminal result across a concurrent HTTP and WebSocket surrender', async () => {
    memoryStore.seed(signedRoom('terminal-race', 'light'))
    await httpSelect('terminal-race', firstIdentity.id, lightRoster)
    await wsSelect('terminal-race', secondIdentity.id, lightRoster)
    const started = memoryStore.snapshot('terminal-race')
    if (!started?.battleState) throw new Error('Expected a started battle')

    const client = await openClient()
    const messages = collectMessages(client)
    try {
      client.send(JSON.stringify({ type: 'subscribe', roomId: 'terminal-race', playerId: secondIdentity.id }))
      await messages.waitFor('subscribed')
      await messages.waitFor('stateUpdate')

      const terminalUpdate = messages.waitFor('stateUpdate')
      const writesBeforeRace = memoryStore.writeCount()
      memoryStore.armReadBarrier(2)

      const httpAction = {
        type: 'surrender',
        playerId: firstIdentity.id,
        reason: 'voluntary',
        clientActionId: 'terminal-race-http',
      }
      const wsAction = {
        type: 'surrender',
        playerId: secondIdentity.id,
        reason: 'voluntary',
        clientActionId: 'terminal-race-ws',
      }
      const wsAuth = await signBattleAction(secondIdentity, 'terminal-race', wsAction)
      const httpResultPromise = httpBattleAction(
        'terminal-race',
        firstIdentity.id,
        httpAction,
        firstIdentity.id,
        firstIdentity,
      )
      client.send(JSON.stringify({ type: 'action', action: wsAction, auth: wsAuth }))

      const [httpResult, update] = await Promise.all([httpResultPromise, terminalUpdate])
      expect([200, 400]).toContain(httpResult.status)
      expect(update).toMatchObject({ type: 'stateUpdate' })

      if (httpResult.status === 200) {
        expect(await messages.waitFor('actionError')).toMatchObject({
          type: 'actionError',
          code: 'BATTLE_ALREADY_TERMINAL',
        })
      } else {
        expect(httpResult.body).toMatchObject({ code: 'BATTLE_ALREADY_TERMINAL' })
      }

      const finalRoom = memoryStore.snapshot('terminal-race')
      const finalStorage = finalRoom?.battleState as unknown as {
        state: {
          terminalResult?: { loserPlayerId?: string }
          actions?: Array<{ type?: string }>
        }
      }
      expect(memoryStore.writeCount() - writesBeforeRace).toBe(1)
      expect(finalRoom?.status).toBe('finished')
      expect(finalStorage.state.terminalResult?.loserPlayerId).toBe(
        httpResult.status === 200 ? firstIdentity.id : secondIdentity.id,
      )
      expect(finalStorage.state.actions?.filter(action => action.type === 'terminalResult')).toHaveLength(1)
    } finally {
      messages.stop()
      client.close()
    }
  }, 15_000)
})
