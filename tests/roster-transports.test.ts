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
import { POST as battlePost } from '../app/api/rooms/[roomId]/battle/route'
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

async function receiveType(client: WebSocket, expectedType: string): Promise<JsonObject> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const message = await receiveJson(client)
    if (message.type === expectedType) return message
  }
  throw new Error(`Timed out waiting for WebSocket message ${expectedType}`)
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

async function httpBattleAction(roomId: string, playerId: string, action: JsonObject) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/battle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, action }),
  })
  const response = await battlePost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function wsBattleAction(roomId: string, playerId: string, action: JsonObject) {
  const client = await openClient()
  try {
    client.send(JSON.stringify({ type: 'subscribe', roomId, playerId }))
    await receiveType(client, 'subscribed')
    client.send(JSON.stringify({ type: 'action', action }))
    return await receiveType(client, 'stateUpdate')
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
    expect(memoryStore.snapshot(httpRoomId)?.mapId).toBe('large-hole-arena')

    memoryStore.reset()
    const ws = await wsCreate('large-battlefield')
    expect(ws).toMatchObject({ ok: true, data: { mapId: 'large-hole-arena' } })
    const wsRoomId = String((ws.data as JsonObject).id)
    expect(memoryStore.snapshot(wsRoomId)?.mapId).toBe('large-hole-arena')
  })

  it('submits a deterministic keep-all deployment choice for the PVE bot', async () => {
    const created = await httpCreate('large-battlefield')
    const roomId = String(created.body.id)

    expect(memoryStore.snapshot(roomId)?.players).toMatchObject([
      { id: 'alice', seat: 'red', alignment: 'light' },
      { id: 'bot', seat: 'blue', alignment: 'dark' },
    ])

    const selected = await httpSelect(roomId, 'alice', lightRoster)
    expect(selected.status).toBe(200)

    const started = memoryStore.snapshot(roomId)
    const awaitingState = (started?.battleState as unknown as {
      state: {
        deployment: { status: string; choices: Record<string, { pieceId: string | null }> }
        gameStartFired?: boolean
        extensions?: { playerAlignments?: Record<string, 'light' | 'dark'> }
      }
    })?.state
    expect(awaitingState.deployment).toMatchObject({
      status: 'awaiting-choices',
      choices: { bot: { pieceId: null } },
    })
    expect(awaitingState.gameStartFired).toBeFalsy()
    expect(awaitingState.extensions?.playerAlignments).toEqual({ alice: 'light', bot: 'dark' })

    const completed = await httpBattleAction(roomId, 'alice', {
      type: 'deploymentChoice',
      playerId: 'alice',
      pieceId: null,
      clientActionId: 'alice-pve-keep',
    })
    expect(completed.status).toBe(200)

    const completedState = (memoryStore.snapshot(roomId)?.battleState as unknown as {
      state: { deployment: { status: string }; gameStartFired?: boolean; turn: { phase: string } }
    }).state
    expect(completedState.deployment.status).toBe('complete')
    expect(completedState.gameStartFired).toBe(true)
    expect(completedState.turn.phase).toBe('action')
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
    expect(battleState.state.deployment.status).toBe('awaiting-choices')
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

  it('carries mixed alignments into battle independently of seat and turn order', async () => {
    memoryStore.seed(room('mixed-room'))

    await httpSelect('mixed-room', 'alice', lightRoster, 'light')
    await wsSelect('mixed-room', 'bob', darkRoster, 'dark')

    const started = memoryStore.snapshot('mixed-room')
    const state = (started?.battleState as unknown as {
      state: { extensions?: { playerAlignments?: Record<string, 'light' | 'dark'> } }
    }).state
    expect(started?.players).toMatchObject([
      { id: 'alice', seat: 'red', alignment: 'light' },
      { id: 'bob', seat: 'blue', alignment: 'dark' },
    ])
    expect(state.extensions?.playerAlignments).toEqual({ alice: 'light', bob: 'dark' })
    expect(['alice', 'bob']).toContain(started?.firstPlayerId)
  })

  it('applies the same deployment command through HTTP and WebSocket authority', async () => {
    memoryStore.seed(room('transport-source', 'light'))
    await httpSelect('transport-source', 'alice', lightRoster)
    await wsSelect('transport-source', 'bob', lightRoster)
    const source = memoryStore.snapshot('transport-source')
    if (!source?.battleState) throw new Error('Expected a started deployment battle')

    memoryStore.seed({ ...source, id: 'http-deployment', version: 1 })
    memoryStore.seed({ ...source, id: 'ws-deployment', version: 1 })
    const action = { type: 'deploymentChoice', playerId: 'alice', pieceId: null, clientActionId: 'alice-keep' }

    const http = await httpBattleAction('http-deployment', 'alice', action)
    const ws = await wsBattleAction('ws-deployment', 'alice', action)

    expect(http.status).toBe(200)
    expect(ws.stateHash).toBe(http.body.stateHash)
    const httpState = (memoryStore.snapshot('http-deployment')?.battleState as unknown as { state: unknown }).state
    const wsState = (memoryStore.snapshot('ws-deployment')?.battleState as unknown as { state: unknown }).state
    expect(wsState).toEqual(httpState)
  })
})
