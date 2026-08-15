import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { WebSocket, WebSocketServer } from 'ws'
import type { Room } from '../lib/game/room-store'

type JsonObject = Record<string, unknown>

const memoryStore = vi.hoisted(() => {
  const rooms = new Map<string, Room>()
  let writes = 0

  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'function' ? undefined : candidate,
  )) as T
  const normalize = (roomId: string) => roomId.trim().toLowerCase()

  return {
    reset() {
      rooms.clear()
      writes = 0
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
import { POST as roomPost } from '../app/api/rooms/[roomId]/route'
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

const globalWithWsServer = globalThis as typeof globalThis & { __rvbWss?: WebSocketServer | null }
let serverUrl: string

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
    client.once('open', () => resolve(client))
    client.once('error', reject)
  })
}

function receiveJson(client: WebSocket): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket response')), 10_000)
    client.once('message', raw => {
      clearTimeout(timeout)
      resolve(JSON.parse(raw.toString()))
    })
    client.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function httpCreate(mapId: string) {
  const request = new NextRequest('http://localhost/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'pve', hostId: 'alice', playerName: 'Alice', mapId }),
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

async function httpSelect(roomId: string, playerId: string, templateIds: string[]) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'select-pieces', playerId, alignment: 'light', pieces: pieces(templateIds) }),
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

async function wsSelect(roomId: string, playerId: string, templateIds: string[]) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `${roomId}-${playerId}`,
      method: 'rooms.action',
      data: { roomId, action: 'select-pieces', playerId, alignment: 'light', pieces: pieces(templateIds) },
    }))
    return await response
  } finally {
    client.close()
  }
}

describe('Demo roster HTTP/WebSocket integration', () => {
  beforeAll(async () => {
    process.env.WS_PORT = '0'
    startWsServer()
    const server = globalWithWsServer.__rvbWss
    if (!server) throw new Error('WebSocket server did not start')
    await waitForServerListening(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('WebSocket server did not expose a port')
    serverUrl = `ws://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    delete process.env.WS_PORT
    const server = globalWithWsServer.__rvbWss
    globalWithWsServer.__rvbWss = null
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  beforeEach(() => memoryStore.reset())

  it('forces the Demo map at HTTP and WebSocket room creation boundaries', async () => {
    const http = await httpCreate('large-battlefield')
    expect(http.status).toBe(200)
    const httpRoomId = String(http.body.id)
    expect(memoryStore.snapshot(httpRoomId)?.mapId).toBe('large-trap-arena')

    memoryStore.reset()
    const ws = await wsCreate('large-battlefield')
    expect(ws).toMatchObject({ ok: true, data: { mapId: 'large-trap-arena' } })
    const wsRoomId = String((ws.data as JsonObject).id)
    expect(memoryStore.snapshot(wsRoomId)?.mapId).toBe('large-trap-arena')
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
    expect(started.mapId).toBe('large-trap-arena')
    const battleState = started.battleState as unknown as {
      state: {
        map: { id: string }
        pieces: Array<{ templateId: string; ownerPlayerId: string }>
      }
    }
    expect(battleState.state.map.id).toBe('large-trap-arena')
    const battlePieces = battleState.state.pieces
    expect(battlePieces).toHaveLength(16)
    expect(battlePieces.filter(piece => piece.templateId === lightRoster[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerPlayerId: 'alice' }),
      expect.objectContaining({ ownerPlayerId: 'bob' }),
    ]))
    expect(battlePieces.filter(piece => piece.templateId === lightRoster[0])).toHaveLength(2)
  })
})
