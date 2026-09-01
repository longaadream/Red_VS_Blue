import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { NextRequest } from 'next/server'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { Room, Spectator } from '../lib/game/room-store'
import { SELECTABLE_MAP_IDS } from '../lib/game/map-selection'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '../lib/game/battle-public-patch'
import { createInitialBattleForPlayers } from '../lib/game/battle-setup'
import type { PieceTemplate } from '../lib/game/piece'
import { getServerGameProfileIdentityV1 } from '../lib/content-pipeline/runtime/profile-game-identity'
import { createTestServerBattleState } from './game/profile-test-identity'

type JsonObject = Record<string, unknown>
type TestIdentity = { id: string; publicKey: string; privateKey: CryptoKey }
type BattleSubscribePayloadOverrides = Partial<{
  protocolVersion: number
  authorityBuildId: string
}>

let firstIdentity: TestIdentity
let secondIdentity: TestIdentity
let spectatorIdentity: TestIdentity
let unregisteredIdentity: TestIdentity

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

async function signBattleSubscribe(
  identity: TestIdentity,
  roomId: string,
  overrides: BattleSubscribePayloadOverrides = {},
) {
  const payload = {
    type: 'battle-subscribe',
    roomId,
    playerId: identity.id,
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    timestamp: Date.now(),
    ...overrides,
  }
  const signature = await globalThis.crypto.subtle.sign(
    'Ed25519',
    identity.privateKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  return { publicKey: identity.publicKey, payload, signature: bytesToHex(new Uint8Array(signature)) }
}

async function createBattleSubscribeMessage(
  identity: TestIdentity,
  roomId: string,
  options: {
    payloadOverrides?: BattleSubscribePayloadOverrides
    topLevelOverrides?: JsonObject
  } = {},
): Promise<JsonObject> {
  const auth = await signBattleSubscribe(identity, roomId, options.payloadOverrides)
  return {
    type: 'subscribe',
    roomId,
    playerId: identity.id,
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    profileIdentity,
    ...auth,
    ...options.topLevelOverrides,
  }
}

async function sendBattleSubscribe(
  client: WebSocket,
  identity: TestIdentity,
  roomId: string,
  options?: Parameters<typeof createBattleSubscribeMessage>[2],
): Promise<void> {
  client.send(JSON.stringify(await createBattleSubscribeMessage(identity, roomId, options)))
}

const memoryStore = vi.hoisted(() => {
  const rooms = new Map<string, Room>()
  let writes = 0
  let casAttempts = 0
  let casCommits = 0
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
      casAttempts = 0
      casCommits = 0
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
    casStats() {
      return { attempts: casAttempts, commits: casCommits }
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
      writes += 1
      return copy(created)
    },
    async setRoom(roomId: string, room: Room) {
      const id = normalize(roomId)
      const current = rooms.get(id)
      rooms.set(id, { ...copy(room), id, version: (current?.version ?? 0) + 1 })
      writes += 1
    },
    async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number) {
      casAttempts += 1
      const id = normalize(roomId)
      const current = rooms.get(id)
      if (!current || current.version !== expectedVersion) return false
      rooms.set(id, { ...copy(room), id, version: expectedVersion + 1 })
      writes += 1
      casCommits += 1
      return true
    },
    async addSpectator(roomId: string, spectator: Spectator) {
      const id = normalize(roomId)
      const current = rooms.get(id)
      if (!current) return
      const spectators = (current.spectators ?? []).filter(item => item.id !== spectator.id)
      spectators.push(copy(spectator))
      rooms.set(id, { ...current, spectators })
      writes += 1
    },
  }
})

vi.mock('../lib/game/room-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/game/room-store')>()
  return { ...actual, roomStore: memoryStore, getRoomStore: () => memoryStore }
})

import { POST as roomActionPost } from '../app/api/rooms/[roomId]/actions/route'
import { POST as publicRoomJoinPost } from '../app/api/rooms/[roomId]/join/route'
import { GET as battleGet, POST as battlePost } from '../app/api/rooms/[roomId]/battle/route'
import { GET as roomGet, POST as roomPost } from '../app/api/rooms/[roomId]/route'
import { GET as roomsGet, POST as roomsPost } from '../app/api/rooms/route'
import { broadcastBattleSnapshot, startWsServer } from '../lib/ws-server'
import {
  clearRoomBattleTimeout,
  createPublicBattleSnapshot,
  scheduleRoomBattleTimeout,
} from '../lib/game/room-battle-actions'

const profileIdentity = getServerGameProfileIdentityV1()

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

const privateProjectionRoster = lightRoster.map(templateId =>
  templateId === 'blue-watcher' ? 'tracer' : templateId)

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

function room(
  id: string,
  secondAlignment: 'light' | 'dark' = 'dark',
  mapId = 'large-hole-arena',
): Room {
  return {
    id,
    name: id,
    status: 'ready',
    players: [
      { id: 'alice', name: 'Alice', seat: 'red', faction: 'red', alignment: 'light', profileIdentity },
      { id: 'bob', name: 'Bob', seat: 'blue', faction: 'blue', alignment: secondAlignment, profileIdentity },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    mapId,
    version: 1,
  }
}

function signedRoom(id: string, secondAlignment: 'light' | 'dark' = 'dark'): Room {
  const next = room(id, secondAlignment)
  next.players = [
    { id: firstIdentity.id, name: 'Signed Alice', seat: 'red', faction: 'red', alignment: 'light', profileIdentity },
    { id: secondIdentity.id, name: 'Signed Bob', seat: 'blue', faction: 'blue', alignment: secondAlignment, profileIdentity },
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

function waitForTypeMatching(
  client: WebSocket,
  expectedType: string,
  predicate: (message: JsonObject) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const observed: Array<{
      type: unknown
      authorityVersion: unknown
      lastDeployedPieceId: unknown
      reason: unknown
      code: unknown
      deploymentStatus: unknown
      deploymentRevision: unknown
      offerPieceIds: unknown
      pieceCount: number | undefined
      lastActionType: unknown
    }> = []
    const cleanup = () => {
      clearTimeout(timeout)
      client.off('message', onMessage)
      client.off('error', onError)
    }
    const onMessage = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as JsonObject
      const state = message.state as JsonObject | undefined
      const deployment = state?.deployment as JsonObject | undefined
      const actions = state?.actions as JsonObject[] | undefined
      observed.push({
        type: message.type,
        authorityVersion: message.authorityVersion,
        lastDeployedPieceId: deployment?.lastDeployedPieceId,
        reason: message.reason,
        code: message.code,
        deploymentStatus: deployment?.status,
        deploymentRevision: deployment?.revision,
        offerPieceIds: deployment?.offerPieceIds,
        pieceCount: (state?.pieces as unknown[] | undefined)?.length,
        lastActionType: actions?.at(-1)?.type,
      })
      if (message.type !== expectedType || !predicate(message)) return
      cleanup()
      resolve(message)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(
        `Timed out waiting for matching WebSocket message ${expectedType} (${label}); observed ${JSON.stringify(observed)}`,
      ))
    }, timeoutMs)
    client.on('message', onMessage)
    client.once('error', onError)
  })
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

async function httpCreate(mapId: unknown, hostId = 'alice') {
  const request = new NextRequest('http://localhost/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'pve', hostId, playerName: 'Alice', mapId, profileIdentity }),
  })
  const response = await roomsPost(request)
  return { status: response.status, body: await response.json() as JsonObject }
}

async function wsCreate(mapId: unknown, submittedProfile: unknown = profileIdentity) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: 'create-fixed-map',
      method: 'rooms.create',
      data: { hostId: 'alice', name: 'Fixed map room', mapId, profileIdentity: submittedProfile },
    }))
    return await response
  } finally {
    client.close()
  }
}

async function httpSelect(roomId: string, playerId: string, templateIds: string[], alignment: 'light' | 'dark' = 'light', payloadMapId?: unknown) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'select-pieces', playerId, alignment, pieces: pieces(templateIds), mapId: payloadMapId, profileIdentity }),
  })
  const response = await roomActionPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function httpDynamicRoomAction(
  roomId: string,
  action: 'join' | 'claim-faction' | 'toggle-ready' | 'select-pieces',
  payloadMapId?: unknown,
  submittedProfile: unknown = profileIdentity,
) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      playerId: 'alice',
      playerName: 'Alice',
      alignment: 'light',
      mapId: payloadMapId,
      profileIdentity: submittedProfile,
      ...(action === 'select-pieces' ? { pieces: pieces(lightRoster) } : {}),
    }),
  })
  const response = await roomActionPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function publicHttpJoin(roomId: string, playerId = 'charlie') {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, playerName: 'Charlie', alignment: 'light', profileIdentity }),
  })
  const response = await publicRoomJoinPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function httpStart(roomId: string, playerId: string, payloadMapId?: unknown) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start-game', playerId, mapId: payloadMapId, profileIdentity }),
  })
  const response = await roomActionPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function legacyHttpStart(roomId: string) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start', profileIdentity }),
  })
  const response = await roomPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function legacyHttpJoin(roomId: string, playerId: string, alignment: 'light' | 'dark') {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'join', playerId, alignment, profileIdentity }),
  })
  const response = await roomPost(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function wsSelect(roomId: string, playerId: string, templateIds: string[], alignment: 'light' | 'dark' = 'light', payloadMapId?: unknown) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `${roomId}-${playerId}`,
      method: 'rooms.action',
      data: { roomId, action: 'select-pieces', playerId, alignment, pieces: pieces(templateIds), mapId: payloadMapId, profileIdentity },
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

async function httpRoomDetail(roomId: string) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}`)
  const response = await roomGet(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function httpRoomsList() {
  const request = new NextRequest('http://localhost/api/rooms')
  const response = await roomsGet(request)
  return { status: response.status, body: await response.json() as JsonObject }
}

async function wsRpc(method: string, data: JsonObject = {}) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `public-${method}`,
      method,
      data,
    }))
    return await response
  } finally {
    client.close()
  }
}

async function wsRoomAction(
  roomId: string,
  playerId: string,
  action: string,
  payload: JsonObject = {},
  submittedProfile: unknown = profileIdentity,
) {
  const client = await openClient()
  try {
    const response = receiveJson(client)
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `${roomId}-${action}`,
      method: 'rooms.action',
      data: { ...payload, roomId, playerId, action, profileIdentity: submittedProfile },
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
async function httpBattleSnapshot(
  roomId: string,
  options: {
    viewerPlayerId?: string
    headerViewerPlayerId?: string
    identity?: TestIdentity
    authHeader?: string
  } = {},
) {
  const auth = options.identity ? await signBattleSubscribe(options.identity, roomId) : undefined
  const query = options.viewerPlayerId
    ? `?viewerPlayerId=${encodeURIComponent(options.viewerPlayerId)}`
    : ''
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}/battle${query}`, {
    headers: {
      ...(options.headerViewerPlayerId ? { 'x-player-id': options.headerViewerPlayerId } : {}),
      ...(options.authHeader || auth
        ? { 'x-battle-subscribe-auth': options.authHeader ?? JSON.stringify(auth) }
        : {}),
    },
  })
  const response = await battleGet(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}
async function httpRoomSnapshot(roomId: string) {
  const request = new NextRequest(`http://localhost/api/rooms/${roomId}`)
  const response = await roomGet(request, { params: Promise.resolve({ roomId }) })
  return { status: response.status, body: await response.json() as JsonObject }
}


async function wsBattleAction(
  roomId: string,
  playerId: string,
  action: JsonObject,
  identity: TestIdentity,
  responseType = 'stateUpdate',
  signAction = true,
) {
  const client = await openClient()
  try {
    await sendBattleSubscribe(client, identity, roomId, {
      topLevelOverrides: { playerId },
    })
    await receiveType(client, 'subscribed')
    await receiveType(client, 'stateUpdate')
    const auth = signAction ? await signBattleAction(identity, roomId, action) : undefined
    client.send(JSON.stringify({
      type: 'action',
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      action,
      auth,
    }))
    return await receiveType(client, responseType)
  } finally {
    client.close()
  }
}

async function wsBattleSnapshot(roomId: string, identity: TestIdentity) {
  const client = await openClient()
  try {
    client.send(JSON.stringify({
      type: 'rpc',
      requestId: `${roomId}-${identity.id}-spectate`,
      method: 'rooms.spectate',
      data: {
        roomId,
        spectatorId: identity.id,
        spectatorName: 'Spectator',
        profileIdentity,
      },
    }))
    const registration = await receiveJson(client)
    if (registration.ok !== true) throw new Error(`Spectator registration failed: ${JSON.stringify(registration)}`)
    await sendBattleSubscribe(client, identity, roomId)
    await receiveType(client, 'subscribed')
    return await receiveType(client, 'stateUpdate')
  } finally {
    client.close()
  }
}

async function registerSpectator(client: WebSocket, roomId: string, identity: TestIdentity): Promise<void> {
  client.send(JSON.stringify({
    type: 'rpc',
    requestId: `${roomId}-${identity.id}-register`,
    method: 'rooms.spectate',
    data: {
      roomId,
      spectatorId: identity.id,
      spectatorName: 'Spectator',
      profileIdentity,
    },
  }))
  const registration = await receiveType(client, 'rpcResult')
  if (registration.ok !== true) throw new Error(`Spectator registration failed: ${JSON.stringify(registration)}`)
}

async function subscribeBattleClient(
  client: WebSocket,
  roomId: string,
  identity: TestIdentity,
  expectedInitialType: 'stateUpdate' | 'battleUnavailable',
): Promise<JsonObject> {
  await sendBattleSubscribe(client, identity, roomId)
  await receiveType(client, 'subscribed')
  return receiveType(client, expectedInitialType)
}

async function sendSubscribedBattleAction(
  client: WebSocket,
  identity: TestIdentity,
  roomId: string,
  expectedAuthorityVersion: number,
  action: JsonObject,
): Promise<void> {
  const auth = await signBattleAction(identity, roomId, action)
  client.send(JSON.stringify({
    type: 'action',
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    expectedAuthorityVersion,
    action,
    auth,
  }))
}

describe('Demo roster HTTP/WebSocket integration', () => {
  beforeAll(async () => {
    firstIdentity = await createTestIdentity()
    secondIdentity = await createTestIdentity()
    spectatorIdentity = await createTestIdentity()
    unregisteredIdentity = await createTestIdentity()
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

  it('rejects WebSocket room creation without a profile before store mutation', async () => {
    const result = await wsCreate('winding-pass', null)

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: 'PROFILE_REQUIRED',
    })
    expect(memoryStore.writeCount()).toBe(0)
  })

  it('rejects WebSocket join when an existing player has no confirmed profile', async () => {
    const legacyRoom = room('profile-ws-legacy-join')
    legacyRoom.status = 'waiting'
    legacyRoom.players = [legacyRoom.players[0]]
    delete legacyRoom.players[0].profileIdentity
    memoryStore.seed(legacyRoom)
    const before = memoryStore.snapshot(legacyRoom.id)

    const result = await wsRoomAction(legacyRoom.id, 'charlie', 'join', { playerName: 'Charlie' })

    expect(result).toMatchObject({ ok: false, status: 409, code: 'PROFILE_REQUIRED' })
    expect(memoryStore.snapshot(legacyRoom.id)).toEqual(before)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it('reports one server identity across HTTP room list/detail and WebSocket catalog/list/detail', async () => {
    memoryStore.seed(room('profile-public'))

    const httpList = await httpRoomsList()
    const httpDetail = await httpRoomDetail('profile-public')
    const wsCatalog = await wsRpc('catalog.identity')
    const wsList = await wsRpc('rooms.list')
    const wsDetail = await wsGet('profile-public')

    expect(httpList).toMatchObject({
      status: 200,
      body: { profileIdentity },
    })
    expect((httpList.body.rooms as JsonObject[]).find(item => item.id === 'profile-public')).toMatchObject({
      profileIdentity,
    })
    expect(httpDetail).toMatchObject({
      status: 200,
      body: { profileIdentity },
    })
    expect(wsCatalog).toMatchObject({
      ok: true,
      data: { profileIdentity },
    })
    expect(((wsList.data as JsonObject).rooms as JsonObject[]).find(item => item.id === 'profile-public')).toMatchObject({
      profileIdentity,
    })
    expect(wsDetail).toMatchObject({
      ok: true,
      data: { profileIdentity },
    })
  })

  it.each([
    ['missing', null, 'PROFILE_REQUIRED'],
    ['malformed', 'invalid', 'PROFILE_INVALID'],
    ['engine', { ...profileIdentity, engineAbi: `${profileIdentity.engineAbi}-other` }, 'ENGINE_ABI_MISMATCH'],
    ['runner', { ...profileIdentity, runnerRevision: `${profileIdentity.runnerRevision}-other` }, 'RUNNER_REVISION_MISMATCH'],
    [
      'authority-content',
      {
        ...profileIdentity,
        authorityContentHash: `${profileIdentity.authorityContentHash[0] === '0' ? '1' : '0'}${profileIdentity.authorityContentHash.slice(1)}`,
      },
      'PROFILE_HASH_MISMATCH',
    ],
  ] as const)('rejects %s profile identity consistently before HTTP or WebSocket mutation', async (
    label,
    submittedProfile,
    expectedCode,
  ) => {
    const httpRoomId = `profile-http-${label}`
    memoryStore.seed(room(httpRoomId))
    const beforeHttp = memoryStore.snapshot(httpRoomId)
    const http = await httpDynamicRoomAction(
      httpRoomId,
      'toggle-ready',
      undefined,
      submittedProfile,
    )

    expect(http).toMatchObject({
      status: 409,
      body: { success: false, code: expectedCode },
    })
    expect(memoryStore.snapshot(httpRoomId)).toEqual(beforeHttp)
    expect(memoryStore.writeCount()).toBe(0)

    memoryStore.reset()
    const wsRoomId = `profile-ws-${label}`
    memoryStore.seed(room(wsRoomId))
    const beforeWs = memoryStore.snapshot(wsRoomId)
    const ws = await wsRoomAction(
      wsRoomId,
      'alice',
      'toggle-ready',
      {},
      submittedProfile,
    )

    expect(ws).toMatchObject({
      ok: false,
      status: 409,
      code: expectedCode,
    })
    expect(ws.context).toEqual(http.body.context)
    expect(memoryStore.snapshot(wsRoomId)).toEqual(beforeWs)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it.each(SELECTABLE_MAP_IDS)('persists selectable map %s at HTTP and WebSocket room creation boundaries', async mapId => {
    const http = await httpCreate(mapId)
    expect(http.status).toBe(200)
    const httpRoomId = String(http.body.id)
    expect(memoryStore.snapshot(httpRoomId)?.mapId).toBe(mapId)
    expect(memoryStore.writeCount()).toBe(1)

    memoryStore.reset()
    const ws = await wsCreate(mapId)
    expect(ws).toMatchObject({ ok: true, data: { mapId } })
    const wsRoomId = String((ws.data as JsonObject).id)
    expect(memoryStore.snapshot(wsRoomId)?.mapId).toBe(mapId)
    expect(memoryStore.writeCount()).toBe(1)
  })

  it('ignores forged mapId fields throughout the HTTP room flow', async () => {
    const created = await httpCreate('winding-pass')
    expect(created.status).toBe(200)
    const roomId = String(created.body.id)
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const joined = await httpDynamicRoomAction(roomId, 'join', 'open-expanse')
    expect(joined.status).toBe(200)
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const claimed = await httpDynamicRoomAction(roomId, 'claim-faction', 'large-battlefield')
    expect(claimed.status).toBe(200)
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const selected = await httpSelect(roomId, 'alice', lightRoster, 'light', 'open-expanse')
    expect(selected.status).toBe(200)
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const resumed = await httpStart(roomId, 'alice', 'large-battlefield')
    expect(resumed).toMatchObject({ status: 200, body: { success: true, started: false } })

    const finalRoom = memoryStore.snapshot(roomId)
    const finalStorage = finalRoom?.battleState as unknown as { state: { map: { id: string } } }
    expect(finalRoom?.mapId).toBe('winding-pass')
    expect(finalRoom?.status).toBe('in-progress')
    expect(finalStorage.state.map.id).toBe('winding-pass')
  })

  it('ignores forged mapId fields throughout the LAN WebSocket room flow', async () => {
    const created = await wsCreate('winding-pass')
    expect(created).toMatchObject({ ok: true, data: { mapId: 'winding-pass' } })
    const roomId = String((created.data as JsonObject).id)

    const joined = await wsRoomAction(roomId, 'alice', 'join', {
      playerName: 'Alice',
      alignment: 'light',
      mapId: 'open-expanse',
    })
    expect(joined).toMatchObject({ ok: true })
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const claimed = await wsRoomAction(roomId, 'alice', 'claim-faction', {
      alignment: 'light',
      mapId: 'large-battlefield',
    })
    expect(claimed).toMatchObject({ ok: true })
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const bobJoined = await wsRoomAction(roomId, 'bob', 'join', {
      playerName: 'Bob',
      alignment: 'dark',
    })
    expect(bobJoined).toMatchObject({ ok: true })

    const aliceSelected = await wsSelect(roomId, 'alice', lightRoster, 'light', 'open-expanse')
    expect(aliceSelected).toMatchObject({ ok: true })
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const bobSelected = await wsSelect(roomId, 'bob', darkRoster, 'dark', 'large-battlefield')
    expect(bobSelected).toMatchObject({ ok: true })
    expect(memoryStore.snapshot(roomId)?.mapId).toBe('winding-pass')

    const resumed = await wsRoomAction(roomId, 'alice', 'start-game', { mapId: 'open-expanse' })
    expect(resumed).toMatchObject({ ok: true })

    const finalRoom = memoryStore.snapshot(roomId)
    const finalStorage = finalRoom?.battleState as unknown as { state: { map: { id: string } } }
    expect(finalRoom?.mapId).toBe('winding-pass')
    expect(finalRoom?.status).toBe('in-progress')
    expect(finalStorage.state.map.id).toBe('winding-pass')
  })

  it.each([
    [undefined, 'MAP_ID_REQUIRED'],
    ['large-battlefield', 'MAP_NOT_SELECTABLE'],
    ['../large-hole-arena', 'MAP_NOT_SELECTABLE'],
    ['large-trap-arena.json', 'MAP_NOT_SELECTABLE'],
  ])('rejects invalid map %j before HTTP or WebSocket room writes', async (mapId, code) => {
    const http = await httpCreate(mapId)
    expect(http).toMatchObject({ status: 400, body: { success: false, code } })
    expect(await memoryStore.getAllRooms()).toHaveLength(0)
    expect(memoryStore.writeCount()).toBe(0)

    memoryStore.reset()
    const ws = await wsCreate(mapId)
    expect(ws).toMatchObject({ type: 'rpcResult', ok: false, code })
    expect(await memoryStore.getAllRooms()).toHaveLength(0)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it.each(['join', 'claim-faction', 'toggle-ready', 'select-pieces'] as const)('returns 404 for %s against a missing room without creating it', async action => {
    const roomId = `missing-${action}`
    const http = await httpDynamicRoomAction(roomId, action)

    expect(http).toMatchObject({ status: 404, body: { error: 'Room not found' } })
    expect(await memoryStore.getAllRooms()).toHaveLength(0)
    expect(memoryStore.writeCount()).toBe(0)

    if (action === 'join') {
      const legacy = await legacyHttpJoin(roomId, 'alice', 'light')
      const publicJoin = await publicHttpJoin(roomId)
      expect(legacy).toMatchObject({ status: 404, body: { error: 'Room not found' } })
      expect(publicJoin).toMatchObject({ status: 404, body: { error: 'Room not found' } })
      expect(await memoryStore.getAllRooms()).toHaveLength(0)
      expect(memoryStore.writeCount()).toBe(0)
    }

    memoryStore.reset()
    const ws = await wsRoomAction(roomId, 'alice', action)

    expect(ws).toMatchObject({
      type: 'rpcResult',
      ok: false,
      error: 'Room not found',
      status: 404,
    })
    expect(await memoryStore.getAllRooms()).toHaveLength(0)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it.each([
    [undefined, 'MAP_ID_REQUIRED', 'join'],
    [undefined, 'MAP_ID_REQUIRED', 'claim-faction'],
    [undefined, 'MAP_ID_REQUIRED', 'toggle-ready'],
    [undefined, 'MAP_ID_REQUIRED', 'select-pieces'],
    ['large-battlefield', 'MAP_NOT_SELECTABLE', 'join'],
    ['large-battlefield', 'MAP_NOT_SELECTABLE', 'claim-faction'],
    ['large-battlefield', 'MAP_NOT_SELECTABLE', 'toggle-ready'],
    ['large-battlefield', 'MAP_NOT_SELECTABLE', 'select-pieces'],
  ] as const)('rejects %s before %s can mutate actions HTTP or LAN WebSocket state', async (mapId, code, action) => {
    const legacyRoom = room(`prebattle-${action}-${code}`)
    legacyRoom.mapId = mapId
    memoryStore.seed(legacyRoom)
    const before = memoryStore.snapshot(legacyRoom.id)

    const http = await httpDynamicRoomAction(legacyRoom.id, action)

    expect(http).toMatchObject({ status: 400, body: { success: false, code } })
    expect(memoryStore.snapshot(legacyRoom.id)).toEqual(before)
    expect(memoryStore.writeCount()).toBe(0)

    memoryStore.reset()
    memoryStore.seed(legacyRoom)
    const beforeWs = memoryStore.snapshot(legacyRoom.id)
    const ws = await wsRoomAction(legacyRoom.id, 'alice', action)

    expect(ws).toMatchObject({
      type: 'rpcResult',
      ok: false,
      status: 400,
      code,
    })
    expect(memoryStore.snapshot(legacyRoom.id)).toEqual(beforeWs)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it.each([
    [undefined, 'MAP_ID_REQUIRED'],
    ['large-battlefield', 'MAP_NOT_SELECTABLE'],
  ] as const)('rejects %s before legacy or public HTTP join state writes', async (mapId, code) => {
    const legacyRoom = room(`legacy-join-${code}`)
    legacyRoom.mapId = mapId
    memoryStore.seed(legacyRoom)
    const beforeLegacy = memoryStore.snapshot(legacyRoom.id)
    const legacy = await legacyHttpJoin(legacyRoom.id, 'alice', 'light')
    expect(legacy).toMatchObject({ status: 400, body: { success: false, code } })
    expect(memoryStore.snapshot(legacyRoom.id)).toEqual(beforeLegacy)
    expect(memoryStore.writeCount()).toBe(0)

    memoryStore.reset()
    const publicRoom = room(`public-join-${code}`)
    publicRoom.mapId = mapId
    memoryStore.seed(publicRoom)
    const beforePublic = memoryStore.snapshot(publicRoom.id)
    const publicJoin = await publicHttpJoin(publicRoom.id)
    expect(publicJoin).toMatchObject({ status: 400, body: { success: false, code } })
    expect(memoryStore.snapshot(publicRoom.id)).toEqual(beforePublic)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it.each([
    [undefined, 'MAP_ID_REQUIRED'],
    ['large-battlefield', 'MAP_NOT_SELECTABLE'],
  ])('rejects legacy room map %j before battle state or version writes', async (mapId, code) => {
    const legacyRoom = room('legacy-map-room')
    legacyRoom.mapId = mapId
    memoryStore.seed(legacyRoom)
    const before = memoryStore.snapshot(legacyRoom.id)

    const actionsHttp = await httpStart(legacyRoom.id, 'alice')
    const legacyHttp = await legacyHttpStart(legacyRoom.id)
    const ws = await wsRoomAction(legacyRoom.id, 'alice', 'start-game')

    expect(actionsHttp).toMatchObject({ status: 400, body: { success: false, code } })
    expect(legacyHttp).toMatchObject({ status: 400, body: { success: false, code } })
    expect(ws).toMatchObject({ ok: false, code })
    expect(memoryStore.snapshot(legacyRoom.id)).toEqual(before)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it.each([
    [undefined, 'missing'],
    ['large-battlefield', 'retired'],
  ] as const)('resumes an embedded battle across HTTP and LAN when room map metadata is %s', async (mapId, label) => {
    const sourceId = `resume-source-${label}`
    memoryStore.seed(room(sourceId, 'light', 'winding-pass'))
    await httpSelect(sourceId, 'alice', lightRoster)
    await wsSelect(sourceId, 'bob', lightRoster)

    const started = memoryStore.snapshot(sourceId)
    if (!started?.battleState) throw new Error('Expected an embedded battle state')
    expect(started.status).toBe('in-progress')

    const existingStorage = started.battleState as unknown as {
      rootSeed: number
      state: { map: { id: string } }
    }
    const resumable: Room = {
      ...started,
      id: `resume-http-${label}`,
      status: 'in-progress',
      mapId,
      battleAuthorityVersion: Math.max(started.battleAuthorityVersion ?? 0, 1),
    }

    memoryStore.reset()
    memoryStore.seed(resumable)
    const beforeHttp = memoryStore.snapshot(resumable.id)
    const actionsHttp = await httpStart(resumable.id, 'alice')
    const legacyHttp = await legacyHttpStart(resumable.id)
    const afterHttp = memoryStore.snapshot(resumable.id)

    expect(actionsHttp).toMatchObject({
      status: 200,
      body: {
        success: true,
        started: false,
        room: { battleState: { rootSeed: existingStorage.rootSeed, state: { map: { id: 'winding-pass' } } } },
      },
    })
    expect(legacyHttp).toMatchObject({
      status: 200,
      body: { battleState: { rootSeed: existingStorage.rootSeed, state: { map: { id: 'winding-pass' } } } },
    })
    expect(afterHttp).toEqual(beforeHttp)
    expect(afterHttp?.mapId).toBe(mapId)
    expect(afterHttp?.version).toBe(beforeHttp?.version)
    expect(memoryStore.writeCount()).toBe(0)

    memoryStore.reset()
    const wsRoom = { ...resumable, id: `resume-ws-${label}` }
    memoryStore.seed(wsRoom)
    const beforeWs = memoryStore.snapshot(wsRoom.id)
    const ws = await wsRoomAction(wsRoom.id, 'alice', 'start-game')
    const afterWs = memoryStore.snapshot(wsRoom.id)

    expect(ws).toMatchObject({
      ok: true,
      data: {
        status: 'in-progress',
        battleState: { rootSeed: existingStorage.rootSeed, state: { map: { id: 'winding-pass' } } },
      },
    })
    expect(afterWs).toEqual(beforeWs)
    expect(afterWs?.mapId).toBe(mapId)
    expect(afterWs?.version).toBe(beforeWs?.version)
    expect(memoryStore.writeCount()).toBe(0)
  })

  it('starts PVE bot rooms with two vanguards and only the active human offer', async () => {
    const created = await httpCreate('large-hole-arena', firstIdentity.id)
    const roomId = String(created.body.id)

    expect(memoryStore.snapshot(roomId)?.players).toMatchObject([
      { id: firstIdentity.id, seat: 'red', alignment: 'light' },
      { id: 'bot', seat: 'blue', alignment: 'dark' },
    ])

    const selected = await httpSelect(roomId, firstIdentity.id, lightRoster)
    expect(selected.status).toBe(200)

    const started = memoryStore.snapshot(roomId)
    const state = (started?.battleState as unknown as {
      state: {
        pieces: Array<{
          instanceId: string
          templateId: string
          ownerPlayerId: string
          isCore?: boolean
          x: number | null
          y: number | null
        }>
        deployment: {
          mode?: string
          status: string
          activePlayerId?: string
          offerPieceIds?: string[]
          reserves?: Record<string, Array<{ instanceId: string; templateId: string }>>
          reserveCounts?: Record<string, number>
          choices: Record<string, { pieceId: string | null }>
          locks: Record<string, { locked: boolean; reason?: string }>
          initialPositions: Record<string, { x: number; y: number }>
        }
        gameStartFired?: boolean
        extensions?: { playerAlignments?: Record<string, 'light' | 'dark'> }
      }
    })?.state

    expect(state.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      activePlayerId: firstIdentity.id,
      choices: {},
      locks: {},
      reserveCounts: { [firstIdentity.id]: 7, bot: 6 },
    })
    expect(state.deployment.offerPieceIds).toHaveLength(3)
    expect(Object.keys(state.deployment.initialPositions)).toHaveLength(2)
    expect(state.pieces).toHaveLength(2)
    expect(state.pieces.every(piece => piece.isCore === true)).toBe(true)
    expect(state.pieces.map(piece => piece.ownerPlayerId).sort()).toEqual([firstIdentity.id, 'bot'].sort())
    expect(state.pieces.every(piece => Number.isInteger(piece.x) && Number.isInteger(piece.y))).toBe(true)
    expect(new Set(state.pieces.map(piece => `${piece.x},${piece.y}`)).size).toBe(2)
    expect(state.gameStartFired).toBe(true)
    expect(state.extensions?.playerAlignments).toEqual({ [firstIdentity.id]: 'light', bot: 'dark' })

    const ownerDeployment = createPublicBattleSnapshot(started!, firstIdentity.id).state.deployment
    const botDeployment = createPublicBattleSnapshot(started!, 'bot').state.deployment
    expect(ownerDeployment?.offerPieceIds).toHaveLength(3)
    expect(ownerDeployment?.legalPositions?.length).toBeGreaterThan(0)
    expect(botDeployment?.offerPieceIds).toEqual([])
    expect(botDeployment?.legalPositions).toEqual([])
  })

  it('drives three bot turns through the WebSocket queue and RoomStore CAS authority', async () => {
    const previousAuthorityV2 = process.env.RVB_BATTLE_AUTHORITY_V2
    const previousTurnTimer = process.env.RVB_TURN_TIMER_ENABLED
    process.env.RVB_BATTLE_AUTHORITY_V2 = 'false'
    process.env.RVB_TURN_TIMER_ENABLED = 'false'
    const roomId = 'fixed-seed-live-bot-cas'
    const rootSeed = 0x138b07
    const client = await openClient()
    const warningSpy = vi.spyOn(console, 'warn')

    const inertRoster = (prefix: 'human' | 'bot'): PieceTemplate[] =>
      Array.from({ length: 8 }, (_, index) => ({
        id: `${prefix}-ws-piece-${index + 1}`,
        name: `${prefix} ws piece ${index + 1}`,
        faction: prefix === 'human' ? 'good' : 'evil',
        rarity: 'common',
        stats: { maxHp: 100, attack: 0, defense: 0, moveRange: 0 },
        skills: [],
      }))

    try {
      const humanRoster = inertRoster('human')
      const botRoster = inertRoster('bot')
      const initial = await createInitialBattleForPlayers(
        [firstIdentity.id, 'bot'],
        [...humanRoster, ...botRoster],
        [
          { playerId: firstIdentity.id, pieces: humanRoster, faction: 'red', alignment: 'light' },
          { playerId: 'bot', pieces: botRoster, faction: 'blue', alignment: 'dark' },
        ],
        'large-hole-arena',
        {
          firstPlayerId: firstIdentity.id,
          rootSeed,
          deploymentEnabled: true,
          deploymentMode: 'progressive-reserve-v1',
          deploymentStartedAt: 1_750_000_000_000,
        },
      )
      if (!initial) throw new Error('Expected a fixed-seed progressive bot fixture')
      memoryStore.seed({
        id: roomId,
        name: roomId,
        status: 'in-progress',
        players: [
          {
            id: firstIdentity.id,
            name: 'Human',
            seat: 'red',
            faction: 'red',
            alignment: 'light',
            profileIdentity,
          },
          {
            id: 'bot',
            name: 'Bot',
            seat: 'blue',
            faction: 'blue',
            alignment: 'dark',
            isBot: true,
            profileIdentity,
          },
        ],
        spectators: [],
        currentTurnIndex: 0,
        actions: [],
        mapId: 'large-hole-arena',
        version: 1,
        firstPlayerId: firstIdentity.id,
        battleState: createTestServerBattleState(
          initial as unknown as Record<string, unknown>,
          rootSeed,
        ),
      })

      let ownerSnapshot = await subscribeBattleClient(
        client,
        roomId,
        firstIdentity,
        'stateUpdate',
      )
      const casBaseline = memoryStore.casStats()
      const completedBotTurns: number[] = []

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const beforeState = ownerSnapshot.state as JsonObject
        const beforeTurn = beforeState.turn as JsonObject
        const beforeDeployment = beforeState.deployment as JsonObject
        const humanTurnNumber = Number(beforeTurn.turnNumber)
        const offeredPieceId = (beforeDeployment.offerPieceIds as string[] | undefined)?.[0]
        const safePosition = (
          beforeDeployment.legalPositions as Array<{ x: number; y: number }> | undefined
        )?.[0]
        if (!offeredPieceId) throw new Error(`Missing human reserve offer in cycle ${cycle + 1}`)

        expect(beforeTurn).toMatchObject({
          currentPlayerId: firstIdentity.id,
          phase: 'start',
        })
        expect(beforeDeployment).toMatchObject({
          status: 'awaiting-reserve-deploy',
          activePlayerId: firstIdentity.id,
        })

        const humanDeployment = {
          type: 'deployReservePiece',
          playerId: firstIdentity.id,
          expectedDeploymentRevision: beforeDeployment.revision,
          pieceId: offeredPieceId,
          ...(safePosition ? { toX: safePosition.x, toY: safePosition.y } : {}),
          clientActionId: `human-deploy-${cycle + 1}`,
        }
        const deployedPromise = waitForTypeMatching(
          client,
          'stateUpdate',
          message => {
            const state = message.state as JsonObject | undefined
            const deployment = state?.deployment as JsonObject | undefined
            const turn = state?.turn as JsonObject | undefined
            return Number(message.authorityVersion) > Number(ownerSnapshot.authorityVersion)
              && deployment?.lastDeployedPieceId === offeredPieceId
              && turn?.currentPlayerId === firstIdentity.id
              && turn?.phase === 'action'
          },
          `human deployment ${cycle + 1}`,
          12_000,
        )
        await sendSubscribedBattleAction(
          client,
          firstIdentity,
          roomId,
          Number(ownerSnapshot.authorityVersion),
          humanDeployment,
        )
        const humanActionSnapshot = await deployedPromise
        const humanActionState = humanActionSnapshot.state as JsonObject
        const humanPiece = (humanActionState.pieces as JsonObject[]).find(
          piece => piece.instanceId === offeredPieceId,
        )
        expect(humanPiece?.statusTags).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'deployment-first-move-free',
            grantedTurnNumber: humanTurnNumber,
          }),
        ]))

        const humanEndPromise = waitForTypeMatching(
          client,
          'stateUpdate',
          message => {
            const state = message.state as JsonObject | undefined
            const turn = state?.turn as JsonObject | undefined
            return Number(message.authorityVersion) > Number(humanActionSnapshot.authorityVersion)
              && turn?.currentPlayerId === firstIdentity.id
              && turn?.turnNumber === humanTurnNumber
              && turn?.phase === 'end'
          },
          `human end phase ${cycle + 1}`,
          12_000,
        )
        const endTurnAction = {
          type: 'endTurn',
          playerId: firstIdentity.id,
          clientActionId: `human-end-${cycle + 1}`,
        }
        await sendSubscribedBattleAction(
          client,
          firstIdentity,
          roomId,
          Number(humanActionSnapshot.authorityVersion),
          endTurnAction,
        )
        const humanEndSnapshot = await humanEndPromise

        const expectedBotTurn = humanTurnNumber + 1
        const expectedNextHumanTurn = humanTurnNumber + 2
        const botActionPromise = waitForTypeMatching(
          client,
          'stateUpdate',
          message => {
            const state = message.state as JsonObject | undefined
            const turn = state?.turn as JsonObject | undefined
            const actions = state?.actions as JsonObject[] | undefined
            return turn?.currentPlayerId === 'bot'
              && turn?.phase === 'action'
              && turn?.turnNumber === expectedBotTurn
              && actions?.some(action =>
                action.type === 'deployReservePiece'
                && action.playerId === 'bot'
                && action.turn === expectedBotTurn) === true
          },
          `bot action phase ${cycle + 1}`,
          12_000,
        )
        const nextHumanPromise = waitForTypeMatching(
          client,
          'stateUpdate',
          message => {
            const state = message.state as JsonObject | undefined
            const turn = state?.turn as JsonObject | undefined
            const deployment = state?.deployment as JsonObject | undefined
            return turn?.currentPlayerId === firstIdentity.id
              && turn?.turnNumber === expectedNextHumanTurn
              && deployment?.status === 'awaiting-reserve-deploy'
              && deployment?.activePlayerId === firstIdentity.id
          },
          `next human turn ${cycle + 1}`,
          12_000,
        )
        await sendSubscribedBattleAction(
          client,
          firstIdentity,
          roomId,
          Number(humanEndSnapshot.authorityVersion),
          {
            type: 'beginPhase',
            clientActionId: `human-begin-${cycle + 1}`,
          },
        )

        const [botActionSnapshot, nextHumanSnapshot] = await Promise.all([
          botActionPromise,
          nextHumanPromise,
        ])
        const botActionState = botActionSnapshot.state as JsonObject
        const botDeployment = botActionState.deployment as JsonObject
        const botDeployedPieceId = String(botDeployment.lastDeployedPieceId ?? '')
        const botDeployedPiece = (botActionState.pieces as JsonObject[]).find(
          piece => piece.instanceId === botDeployedPieceId,
        )
        expect(botDeployedPieceId).not.toBe('')
        expect(botDeployedPiece?.statusTags).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'deployment-first-move-free',
            grantedTurnNumber: expectedBotTurn,
          }),
        ]))

        ownerSnapshot = nextHumanSnapshot
        const committedRoom = memoryStore.snapshot(roomId)
        const committedState = (
          committedRoom?.battleState as unknown as { state?: JsonObject } | undefined
        )?.state
        if (!committedState) throw new Error('Missing committed authority state after bot turn')
        const actions = committedState.actions as JsonObject[] | undefined
        expect(actions?.filter(action =>
          action.type === 'deployReservePiece'
          && action.playerId === 'bot'
          && action.turn === expectedBotTurn)).toHaveLength(1)
        expect(actions?.map(action => action.type)).not.toContain('deploymentFreeMove')
        expect(actions?.map(action => action.type)).not.toContain('deploymentSkipFreeMove')
        expect((committedState.pieces as JsonObject[]).every(piece =>
          !(piece.statusTags as JsonObject[] | undefined)?.some(
            tag => tag.type === 'deployment-first-move-free',
          ))).toBe(true)
        expect(committedRoom?.version).toBe(Number(ownerSnapshot.authorityVersion))
        completedBotTurns.push(expectedBotTurn)
      }

      expect(completedBotTurns).toEqual([2, 4, 6])
      const casAfter = memoryStore.casStats()
      expect(casAfter.commits - casBaseline.commits).toBeGreaterThanOrEqual(18)
      expect(casAfter.attempts - casBaseline.attempts).toBe(
        casAfter.commits - casBaseline.commits,
      )
      const fatalBotWarnings = warningSpy.mock.calls
        .map(parts => parts.map(String).join(' '))
        .filter(message =>
          message.includes('bot action phase has no deterministic plan')
          || message.includes('bot structural input has no deterministic action')
          || message.includes('bot action batch ended before the authority phase advanced')
          || message.includes('bot decision step guard reached')
          || message.includes('[WS] runBotTurn error'))
      expect(fatalBotWarnings).toEqual([])
    } finally {
      warningSpy.mockRestore()
      client.close()
      if (previousAuthorityV2 === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousAuthorityV2
      if (previousTurnTimer === undefined) delete process.env.RVB_TURN_TIMER_ENABLED
      else process.env.RVB_TURN_TIMER_ENABLED = previousTurnTimer
    }
  }, 45_000)

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

  it('starts on the persisted non-default map only after both mirror rosters lock', async () => {
    memoryStore.seed(room('mirror-room', 'light', 'winding-pass'))

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
    expect(started.mapId).toBe('winding-pass')
    const battleState = started.battleState as unknown as {
      state: {
        map: { id: string }
        pieces: Array<{
          templateId: string
          ownerPlayerId: string
          isCore?: boolean
          x: number | null
          y: number | null
        }>
        deployment: {
          mode?: string
          status: string
          activePlayerId?: string
          offerPieceIds?: string[]
          reserves?: Record<string, unknown[]>
          reserveCounts?: Record<string, number>
        }
        gameStartFired?: boolean
        extensions?: {
          playerAlignments?: Record<string, 'light' | 'dark'>
        }
      }
    }
    expect(battleState.state.map.id).toBe('winding-pass')
    expect(battleState.state.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      activePlayerId: 'alice',
      reserveCounts: { alice: 7, bob: 7 },
    })
    expect(battleState.state.deployment.offerPieceIds).toHaveLength(3)
    expect(battleState.state.gameStartFired).toBe(true)
    const battlePieces = battleState.state.pieces
    expect(battlePieces).toHaveLength(2)
    expect(battlePieces.every(piece => piece.isCore === true)).toBe(true)
    expect(battlePieces.map(piece => piece.ownerPlayerId).sort()).toEqual(['alice', 'bob'])
    expect(battlePieces.every(piece => lightRoster.includes(piece.templateId))).toBe(true)
    expect(battlePieces.every(piece => Number.isInteger(piece.x) && Number.isInteger(piece.y))).toBe(true)
    expect(new Set(battlePieces.map(piece => `${piece.x},${piece.y}`)).size).toBe(2)
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

  it('projects progressive deployment choices only to the active owner across HTTP and reconnect', async () => {
    memoryStore.seed(signedRoom('public-deployment', 'light'))
    await httpSelect('public-deployment', firstIdentity.id, lightRoster)
    await wsSelect('public-deployment', secondIdentity.id, lightRoster)

    const alice = await httpBattleSnapshot('public-deployment', {
      identity: firstIdentity,
      viewerPlayerId: secondIdentity.id,
      headerViewerPlayerId: secondIdentity.id,
    })
    const bob = await httpBattleSnapshot('public-deployment', { identity: secondIdentity })
    const httpSpectator = await httpBattleSnapshot('public-deployment')
    const forgedAlice = await httpBattleSnapshot('public-deployment', {
      viewerPlayerId: firstIdentity.id,
      headerViewerPlayerId: firstIdentity.id,
    })
    const signedBobClaimingAlice = await httpBattleSnapshot('public-deployment', {
      identity: secondIdentity,
      viewerPlayerId: firstIdentity.id,
      headerViewerPlayerId: firstIdentity.id,
    })
    const spectator = await wsBattleSnapshot('public-deployment', spectatorIdentity)

    expect(alice.status).toBe(200)
    expect(bob.status).toBe(200)
    expect(httpSpectator.status).toBe(200)
    expect(forgedAlice.status).toBe(200)
    expect(signedBobClaimingAlice.status).toBe(200)
    expect(spectator.state).toEqual(bob.body.state)
    expect(spectator.authorityVersion).toBe(alice.body.authorityVersion)
    expect(bob.body.authorityVersion).toBe(alice.body.authorityVersion)

    const state = alice.body.state as {
      pieces: Array<{ isCore?: boolean }>
      deployment: {
        mode?: string
        status: string
        choices: Record<string, unknown>
        locks: Record<string, { locked: boolean }>
        reserveCounts?: Record<string, number>
        reserves?: Record<string, unknown[]>
        offerPieceIds?: string[]
        offerPieces?: unknown[]
        legalPositions?: Array<{ x: number; y: number }>
      }
      extensions?: { debugBattle?: { actionLog?: Array<{ deployment?: { choices?: unknown } }> } }
    }
    const hiddenStates = [
      bob.body.state,
      httpSpectator.body.state,
      forgedAlice.body.state,
      signedBobClaimingAlice.body.state,
      spectator.state,
    ] as typeof state[]
    expect(state.pieces.filter(piece => piece.isCore)).toHaveLength(2)
    expect(state.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      choices: {},
      locks: {},
      reserveCounts: { [firstIdentity.id]: 7, [secondIdentity.id]: 7 },
      reserves: {},
    })
    expect(state.deployment.offerPieceIds).toHaveLength(3)
    expect(state.deployment.offerPieces).toHaveLength(3)
    expect(state.deployment.legalPositions?.length).toBeGreaterThan(0)
    for (const projected of hiddenStates) {
      expect(projected.deployment.offerPieceIds).toEqual([])
      expect(projected.deployment.offerPieces).toEqual([])
      expect(projected.deployment.legalPositions).toEqual([])
      expect(projected.deployment).not.toHaveProperty('freeMovePositions')
      expect(projected.deployment).not.toHaveProperty('freeMovePieceId')
      expect(projected.deployment.reserves).toEqual({})
      expect(projected.deployment.reserveCounts).toEqual(state.deployment.reserveCounts)
    }

    const invalidAuth = await signBattleSubscribe(firstIdentity, 'public-deployment')
    invalidAuth.signature = `${invalidAuth.signature[0] === '0' ? '1' : '0'}${invalidAuth.signature.slice(1)}`
    const invalidSignature = await httpBattleSnapshot('public-deployment', {
      authHeader: JSON.stringify(invalidAuth),
    })
    const malformedAuth = await httpBattleSnapshot('public-deployment', {
      authHeader: '{not-json',
    })
    const mismatchedProtocolAuth = await signBattleSubscribe(firstIdentity, 'public-deployment', {
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION + 1,
    })
    const mismatchedBuildAuth = await signBattleSubscribe(firstIdentity, 'public-deployment', {
      authorityBuildId: `${BATTLE_AUTHORITY_BUILD_ID}-mismatch`,
    })
    const mismatchedProtocol = await httpBattleSnapshot('public-deployment', {
      authHeader: JSON.stringify(mismatchedProtocolAuth),
    })
    const mismatchedBuild = await httpBattleSnapshot('public-deployment', {
      authHeader: JSON.stringify(mismatchedBuildAuth),
    })
    expect(invalidSignature).toMatchObject({
      status: 401,
      body: { code: 'SUBSCRIBE_AUTH_INVALID' },
    })
    expect(malformedAuth).toMatchObject({
      status: 401,
      body: { code: 'SUBSCRIBE_AUTH_INVALID' },
    })
    for (const rejected of [mismatchedProtocol, mismatchedBuild]) {
      expect(rejected).toMatchObject({
        status: 401,
        body: { code: 'SUBSCRIBE_AUTH_INVALID' },
      })
      expect(rejected.body.state).toBeUndefined()
      expect(JSON.stringify(rejected.body)).not.toContain('offerPieceIds')
      expect(JSON.stringify(rejected.body)).not.toContain('offerPieces')
    }

    expect(state.extensions?.debugBattle?.actionLog?.every(entry => entry.deployment?.choices === undefined)).toBe(true)
    const wrongProfile = {
      ...profileIdentity,
      authorityContentHash: `${profileIdentity.authorityContentHash[0] === '0' ? '1' : '0'}${profileIdentity.authorityContentHash.slice(1)}`,
    }
    const beforeRejectedSpectator = memoryStore.snapshot('public-deployment')
    const writesBeforeRejectedSpectator = memoryStore.writeCount()
    const rejectedSpectator = await wsRpc('rooms.spectate', {
      roomId: 'public-deployment',
      spectatorId: 'wrong-profile-spectator',
      spectatorName: 'Wrong profile',
      profileIdentity: wrongProfile,
    })

    expect(rejectedSpectator).toMatchObject({
      ok: false,
      status: 409,
      code: 'PROFILE_HASH_MISMATCH',
    })
    expect(memoryStore.snapshot('public-deployment')).toEqual(beforeRejectedSpectator)
    expect(memoryStore.writeCount()).toBe(writesBeforeRejectedSpectator)

    const impersonatingClient = await openClient()
    try {
      await sendBattleSubscribe(impersonatingClient, firstIdentity, 'public-deployment', {
        topLevelOverrides: { profileIdentity: wrongProfile },
      })
      const subscriptionError = await receiveType(impersonatingClient, 'subscriptionError')
      expect(subscriptionError).toMatchObject({
        status: 409,
        code: 'PROFILE_HASH_MISMATCH',
      })
    } finally {
      impersonatingClient.close()
    }

    const unregisteredClient = await openClient()
    try {
      await sendBattleSubscribe(unregisteredClient, unregisteredIdentity, 'public-deployment')
      const subscriptionError = await receiveType(unregisteredClient, 'subscriptionError')
      expect(subscriptionError).toMatchObject({
        error: 'Signed battle subscriber is not a room participant or spectator',
      })
    } finally {
      unregisteredClient.close()
    }

  })

  it('requires signed WebSocket subscriptions and trusts only the verified payload identity and compatibility', async () => {
    const roomId = 'signed-subscribe-matrix'
    memoryStore.seed(signedRoom(roomId, 'light'))
    await httpSelect(roomId, firstIdentity.id, lightRoster)
    await wsSelect(roomId, secondIdentity.id, lightRoster)

    const ownerSnapshot = await httpBattleSnapshot(roomId, { identity: firstIdentity })
    const opponentSnapshot = await httpBattleSnapshot(roomId, { identity: secondIdentity })
    expect(ownerSnapshot.status).toBe(200)
    expect(opponentSnapshot.status).toBe(200)
    const receiveScenarioType = async (client: WebSocket, type: string, scenario: string) => {
      try {
        return await receiveType(client, type)
      } catch (error) {
        throw new Error(`${scenario}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const unsignedClient = await openClient()
    try {
      unsignedClient.send(JSON.stringify({
        type: 'subscribe',
        roomId,
        playerId: firstIdentity.id,
        protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
        authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
        profileIdentity,
      }))
      const error = await receiveScenarioType(unsignedClient, 'subscriptionError', 'unsigned subscribe')
      expect(error).toMatchObject({
        status: 401,
        code: 'SUBSCRIBE_AUTH_REQUIRED',
      })
      expect(error.state).toBeUndefined()
    } finally {
      unsignedClient.close()
    }

    const invalidSignatureClient = await openClient()
    try {
      const invalidMessage = await createBattleSubscribeMessage(firstIdentity, roomId)
      const signature = invalidMessage.signature
      if (typeof signature !== 'string') throw new Error('Expected signed subscription message')
      invalidMessage.signature = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
      invalidSignatureClient.send(JSON.stringify(invalidMessage))
      const error = await receiveScenarioType(invalidSignatureClient, 'subscriptionError', 'invalid signature')
      expect(error).toMatchObject({
        status: 401,
        code: 'SUBSCRIBE_AUTH_INVALID',
      })
      expect(error.state).toBeUndefined()
    } finally {
      invalidSignatureClient.close()
    }

    const forgedClaimClient = await openClient()
    try {
      await sendBattleSubscribe(forgedClaimClient, secondIdentity, roomId, {
        topLevelOverrides: { playerId: firstIdentity.id },
      })
      await receiveScenarioType(forgedClaimClient, 'subscribed', 'forged top-level player claim')
      const update = await receiveScenarioType(forgedClaimClient, 'stateUpdate', 'forged top-level player projection')
      expect(update.state).toEqual(opponentSnapshot.body.state)
      const deployment = (update.state as JsonObject).deployment as JsonObject
      expect(deployment.offerPieceIds).toEqual([])
      expect(deployment.offerPieces).toEqual([])
      expect(deployment.legalPositions).toEqual([])
      expect(deployment).not.toHaveProperty('freeMovePositions')
      expect(deployment).not.toHaveProperty('freeMovePieceId')
    } finally {
      forgedClaimClient.close()
    }

    const topLevelMismatches: JsonObject[] = [
      { protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION + 1 },
      { authorityBuildId: BATTLE_AUTHORITY_BUILD_ID + '-mismatch' },
    ]
    for (const topLevelOverrides of topLevelMismatches) {
      const client = await openClient()
      try {
        await sendBattleSubscribe(client, firstIdentity, roomId, { topLevelOverrides })
        const error = await receiveScenarioType(client, 'battleProtocolUnsupported', 'top-level compatibility mismatch')
        expect(error).toMatchObject({
          code: 'BATTLE_PROTOCOL_UNSUPPORTED',
          expectedProtocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
          expectedAuthorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
          receivedProtocolVersion: topLevelOverrides.protocolVersion ?? BATTLE_AUTHORITY_PROTOCOL_VERSION,
          receivedAuthorityBuildId: topLevelOverrides.authorityBuildId ?? BATTLE_AUTHORITY_BUILD_ID,
        })
        expect(error.state).toBeUndefined()
        expect(JSON.stringify(error)).not.toContain('offerPieceIds')
        expect(JSON.stringify(error)).not.toContain('offerPieces')
      } finally {
        client.close()
      }
    }

    const incompatiblePayloads: BattleSubscribePayloadOverrides[] = [
      { protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION + 1 },
      { authorityBuildId: BATTLE_AUTHORITY_BUILD_ID + '-mismatch' },
    ]
    for (const payloadOverrides of incompatiblePayloads) {
      const client = await openClient()
      try {
        await sendBattleSubscribe(client, firstIdentity, roomId, { payloadOverrides })
        const scenario = payloadOverrides.protocolVersion === undefined
          ? 'signed payload build mismatch'
          : 'signed payload protocol mismatch'
        const error = await receiveScenarioType(client, 'subscriptionError', scenario)
        expect(error).toMatchObject({
          status: 401,
          code: 'SUBSCRIBE_AUTH_INVALID',
        })
        expect(error.state).toBeUndefined()
        expect(JSON.stringify(error)).not.toContain('offerPieceIds')
        expect(JSON.stringify(error)).not.toContain('offerPieces')
      } finally {
        client.close()
      }
    }
  }, 15_000)

  it('keeps the last initial battle snapshot at one authority version projected per recipient', async () => {
    const previousAuthorityV2 = process.env.RVB_BATTLE_AUTHORITY_V2
    process.env.RVB_BATTLE_AUTHORITY_V2 = 'false'
    const roomId = 'start-private-projection'
    const ownerClient = await openClient()
    const opponentClient = await openClient()
    const spectatorClient = await openClient()
    try {
      const preStartRoom = signedRoom(roomId, 'light')
      preStartRoom.spectators = [{
        id: spectatorIdentity.id,
        name: 'Spectator',
        joinedAt: 0,
        profileIdentity,
      }]
      memoryStore.seed(preStartRoom)
      await httpSelect(roomId, firstIdentity.id, privateProjectionRoster)
      await subscribeBattleClient(ownerClient, roomId, firstIdentity, 'battleUnavailable')
      await subscribeBattleClient(opponentClient, roomId, secondIdentity, 'battleUnavailable')
      await subscribeBattleClient(spectatorClient, roomId, spectatorIdentity, 'battleUnavailable')
      const ownerMessages = collectMessages(ownerClient)
      const opponentMessages = collectMessages(opponentClient)
      const spectatorMessages = collectMessages(spectatorClient)

      const started = await wsSelect(roomId, secondIdentity.id, privateProjectionRoster)
      expect(started).toMatchObject({ ok: true, data: { success: true } })
      const [ownerUpdate, opponentUpdate, spectatorUpdate] = await Promise.all([
        ownerMessages.waitFor('stateUpdate'),
        opponentMessages.waitFor('stateUpdate'),
        spectatorMessages.waitFor('stateUpdate'),
      ])
      const ownerDeployment = (ownerUpdate.state as JsonObject).deployment as JsonObject
      const opponentDeployment = (opponentUpdate.state as JsonObject).deployment as JsonObject
      const spectatorDeployment = (spectatorUpdate.state as JsonObject).deployment as JsonObject

      expect(ownerDeployment.offerPieceIds).toHaveLength(3)
      expect((ownerDeployment.legalPositions as unknown[]).length).toBeGreaterThan(0)
      for (const hidden of [opponentDeployment, spectatorDeployment]) {
        expect(hidden.offerPieceIds).toEqual([])
        expect(hidden.offerPieces).toEqual([])
        expect(hidden.legalPositions).toEqual([])
        expect(hidden).not.toHaveProperty('freeMovePositions')
        expect(hidden).not.toHaveProperty('freeMovePieceId')
      }
      expect(opponentUpdate.authorityVersion).toBe(ownerUpdate.authorityVersion)
      expect(spectatorUpdate.authorityVersion).toBe(ownerUpdate.authorityVersion)
      ownerMessages.stop()
      opponentMessages.stop()
      spectatorMessages.stop()
    } finally {
      ownerClient.close()
      opponentClient.close()
      spectatorClient.close()
      if (previousAuthorityV2 === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousAuthorityV2
    }
  })

  it('projects an applied reserve deployment broadcast separately to every live recipient', async () => {
    const previousAuthorityV2 = process.env.RVB_BATTLE_AUTHORITY_V2
    process.env.RVB_BATTLE_AUTHORITY_V2 = 'false'
    const roomId = 'action-private-projection'
    const ownerClient = await openClient()
    const opponentClient = await openClient()
    const spectatorClient = await openClient()
    try {
      memoryStore.seed(signedRoom(roomId, 'light'))
      await httpSelect(roomId, firstIdentity.id, privateProjectionRoster)
      await wsSelect(roomId, secondIdentity.id, privateProjectionRoster)
      await registerSpectator(spectatorClient, roomId, spectatorIdentity)
      const [ownerInitial] = await Promise.all([
        subscribeBattleClient(ownerClient, roomId, firstIdentity, 'stateUpdate'),
        subscribeBattleClient(opponentClient, roomId, secondIdentity, 'stateUpdate'),
        subscribeBattleClient(spectatorClient, roomId, spectatorIdentity, 'stateUpdate'),
      ])
      const initialDeployment = (ownerInitial.state as JsonObject).deployment as JsonObject
      const initialAuthorityVersion = Number(ownerInitial.authorityVersion)
      const pieceId = (initialDeployment.offerPieceIds as string[])[0]
      const position = (initialDeployment.legalPositions as Array<{ x: number; y: number }>)[0]
      if (!pieceId || !position) throw new Error('Expected owner-only reserve offer and safe position')

      const isAppliedDeployment = (message: JsonObject) => {
        const state = message.state as JsonObject | undefined
        const deployment = state?.deployment as JsonObject | undefined
        return Number(message.authorityVersion) > initialAuthorityVersion
          && deployment?.lastDeployedPieceId === pieceId
      }
      const updatesPromise = Promise.all([
        waitForTypeMatching(ownerClient, 'stateUpdate', isAppliedDeployment, 'owner'),
        waitForTypeMatching(opponentClient, 'stateUpdate', isAppliedDeployment, 'opponent'),
        waitForTypeMatching(spectatorClient, 'stateUpdate', isAppliedDeployment, 'spectator'),
      ])
      const response = await httpBattleAction(roomId, firstIdentity.id, {
        type: 'deployReservePiece',
        playerId: firstIdentity.id,
        expectedDeploymentRevision: initialDeployment.revision as number,
        pieceId,
        toX: position.x,
        toY: position.y,
        clientActionId: 'broadcast-private-deploy',
      }, firstIdentity.id, firstIdentity)
      const [ownerUpdate, opponentUpdate, spectatorUpdate] = await updatesPromise
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ ok: true, duplicate: false })
      expect(response.body).toHaveProperty('state')
      const responseDeployment = ((response.body.state as JsonObject | undefined)?.deployment as JsonObject | undefined)
      expect(responseDeployment?.lastDeployedPieceId).toBe(pieceId)
      expect(ownerUpdate.authorityVersion).toBe(response.body.authorityVersion)
      expect(ownerUpdate.state).toEqual(response.body.state)
      const ownerDeployment = (ownerUpdate.state as JsonObject).deployment as JsonObject
      expect(ownerDeployment.lastDeployedPieceId).toBe(pieceId)
      expect(ownerDeployment.offerPieceIds).toEqual([])
      expect(ownerDeployment.legalPositions).toEqual([])
      expect(ownerDeployment).not.toHaveProperty('freeMovePieceId')
      for (const update of [opponentUpdate, spectatorUpdate]) {
        const hidden = (update.state as JsonObject).deployment as JsonObject
        expect(hidden.lastDeployedPieceId).toBe(pieceId)
        expect(hidden.offerPieceIds).toEqual([])
        expect(hidden.offerPieces).toEqual([])
        expect(hidden.legalPositions).toEqual([])
        expect(hidden).not.toHaveProperty('freeMovePositions')
        expect(hidden.freeMovePieceId).toBeUndefined()
      }
    } finally {
      ownerClient.close()
      opponentClient.close()
      spectatorClient.close()
      if (previousAuthorityV2 === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousAuthorityV2
    }
  }, 15_000)

  it('keeps reserve deployment private when the applied action enters through WebSocket', async () => {
    const previousAuthorityV2 = process.env.RVB_BATTLE_AUTHORITY_V2
    process.env.RVB_BATTLE_AUTHORITY_V2 = 'false'
    const roomId = 'ws-action-private-projection'
    const ownerClient = await openClient()
    const opponentClient = await openClient()
    const spectatorClient = await openClient()
    try {
      memoryStore.seed(signedRoom(roomId, 'light'))
      await httpSelect(roomId, firstIdentity.id, privateProjectionRoster)
      await wsSelect(roomId, secondIdentity.id, privateProjectionRoster)
      await registerSpectator(spectatorClient, roomId, spectatorIdentity)
      const [ownerInitial] = await Promise.all([
        subscribeBattleClient(ownerClient, roomId, firstIdentity, 'stateUpdate'),
        subscribeBattleClient(opponentClient, roomId, secondIdentity, 'stateUpdate'),
        subscribeBattleClient(spectatorClient, roomId, spectatorIdentity, 'stateUpdate'),
      ])
      const initialDeployment = (ownerInitial.state as JsonObject).deployment as JsonObject
      const initialAuthorityVersion = Number(ownerInitial.authorityVersion)
      const pieceId = (initialDeployment.offerPieceIds as string[])[0]
      const position = (initialDeployment.legalPositions as Array<{ x: number; y: number }>)[0]
      if (!pieceId || !position) throw new Error('Expected owner-only reserve offer and safe position')
      const action = {
        type: 'deployReservePiece',
        playerId: firstIdentity.id,
        expectedDeploymentRevision: initialDeployment.revision as number,
        pieceId,
        toX: position.x,
        toY: position.y,
        clientActionId: 'ws-broadcast-private-deploy',
      }
      const auth = await signBattleAction(firstIdentity, roomId, action)
      const isAppliedDeployment = (message: JsonObject) => {
        const state = message.state as JsonObject | undefined
        const deployment = state?.deployment as JsonObject | undefined
        return Number(message.authorityVersion) > initialAuthorityVersion
          && deployment?.lastDeployedPieceId === pieceId
      }
      const updatesPromise = Promise.all([
        waitForTypeMatching(ownerClient, 'stateUpdate', isAppliedDeployment, 'owner', 12_000),
        waitForTypeMatching(opponentClient, 'stateUpdate', isAppliedDeployment, 'opponent', 12_000),
        waitForTypeMatching(spectatorClient, 'stateUpdate', isAppliedDeployment, 'spectator', 12_000),
      ])
      ownerClient.send(JSON.stringify({
        type: 'action',
        protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
        authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
        expectedAuthorityVersion: initialAuthorityVersion,
        action,
        auth,
      }))
      const [ownerUpdate, opponentUpdate, spectatorUpdate] = await updatesPromise
      const ownerDeployment = (ownerUpdate.state as JsonObject).deployment as JsonObject
      expect(ownerDeployment.lastDeployedPieceId).toBe(pieceId)
      expect(ownerDeployment.offerPieceIds).toEqual([])
      expect(ownerDeployment.legalPositions).toEqual([])
      expect(ownerDeployment).not.toHaveProperty('freeMovePieceId')
      for (const update of [opponentUpdate, spectatorUpdate]) {
        const hidden = (update.state as JsonObject).deployment as JsonObject
        expect(hidden.lastDeployedPieceId).toBe(pieceId)
        expect(hidden.offerPieceIds).toEqual([])
        expect(hidden.offerPieces).toEqual([])
        expect(hidden.legalPositions).toEqual([])
        expect(hidden).not.toHaveProperty('freeMovePositions')
        expect(hidden.freeMovePieceId).toBeUndefined()
      }
    } finally {
      ownerClient.close()
      opponentClient.close()
      spectatorClient.close()
      if (previousAuthorityV2 === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousAuthorityV2
    }
  }, 15_000)

  it('projects the timeout-generated next-player offer only to that player', async () => {
    const previousAuthorityV2 = process.env.RVB_BATTLE_AUTHORITY_V2
    const previousTimerFlag = process.env.RVB_TURN_TIMER_ENABLED
    process.env.RVB_BATTLE_AUTHORITY_V2 = 'false'
    process.env.RVB_TURN_TIMER_ENABLED = 'true'
    const roomId = 'timeout-private-projection'
    const ownerClient = await openClient()
    const nextPlayerClient = await openClient()
    const spectatorClient = await openClient()
    try {
      memoryStore.seed(signedRoom(roomId, 'light'))
      await httpSelect(roomId, firstIdentity.id, lightRoster)
      await wsSelect(roomId, secondIdentity.id, lightRoster)
      await registerSpectator(spectatorClient, roomId, spectatorIdentity)
      await Promise.all([
        subscribeBattleClient(ownerClient, roomId, firstIdentity, 'stateUpdate'),
        subscribeBattleClient(nextPlayerClient, roomId, secondIdentity, 'stateUpdate'),
        subscribeBattleClient(spectatorClient, roomId, spectatorIdentity, 'stateUpdate'),
      ])

      const expiredRoom = memoryStore.snapshot(roomId)
      if (!expiredRoom?.battleState) throw new Error('Expected a started timed battle')
      const authorityState = (expiredRoom.battleState as unknown as {
        state: {
          turnTimer?: {
            deadlineAt: number
            burnStartsAt: number
            burnPhase: 'normal' | 'burning'
          }
        }
      }).state
      if (!authorityState.turnTimer) throw new Error('Expected an authoritative turn timer')
      authorityState.turnTimer.deadlineAt = 0
      authorityState.turnTimer.burnStartsAt = 0
      authorityState.turnTimer.burnPhase = 'burning'
      memoryStore.seed(expiredRoom)

      const updates = Promise.all([
        receiveType(ownerClient, 'stateUpdate'),
        receiveType(nextPlayerClient, 'stateUpdate'),
        receiveType(spectatorClient, 'stateUpdate'),
      ])
      await scheduleRoomBattleTimeout(memoryStore, roomId, {
        onCommitted: () => broadcastBattleSnapshot(roomId),
      })
      const [expiredOwner, nextPlayer, spectator] = await updates
      const ownerDeployment = (expiredOwner.state as JsonObject).deployment as JsonObject
      const nextDeployment = (nextPlayer.state as JsonObject).deployment as JsonObject
      const spectatorDeployment = (spectator.state as JsonObject).deployment as JsonObject

      expect(nextDeployment).toMatchObject({
        status: 'awaiting-reserve-deploy',
        activePlayerId: secondIdentity.id,
      })
      expect(nextDeployment.offerPieceIds).toHaveLength(3)
      expect((nextDeployment.legalPositions as unknown[]).length).toBeGreaterThan(0)
      for (const hidden of [ownerDeployment, spectatorDeployment]) {
        expect(hidden.offerPieceIds).toEqual([])
        expect(hidden.offerPieces).toEqual([])
        expect(hidden.legalPositions).toEqual([])
        expect(hidden).not.toHaveProperty('freeMovePositions')
        expect(hidden).not.toHaveProperty('freeMovePieceId')
      }
    } finally {
      clearRoomBattleTimeout(roomId)
      ownerClient.close()
      nextPlayerClient.close()
      spectatorClient.close()
      if (previousAuthorityV2 === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousAuthorityV2
      if (previousTimerFlag === undefined) delete process.env.RVB_TURN_TIMER_ENABLED
      else process.env.RVB_TURN_TIMER_ENABLED = previousTimerFlag
    }
  }, 15_000)

  it('reports pinned battle corruption consistently across HTTP and WebSocket transports', async () => {
    const roomId = 'pinned-transport'
    memoryStore.seed(signedRoom(roomId, 'light'))
    await httpSelect(roomId, firstIdentity.id, lightRoster)
    await wsSelect(roomId, secondIdentity.id, lightRoster)
    const validRoom = memoryStore.snapshot(roomId)
    if (!validRoom?.battleState) throw new Error('Expected a started battle')

    const withoutTrace = (input: Room): Room => {
      const next = JSON.parse(JSON.stringify(input)) as Room
      const storage = next.battleState as unknown as {
        state: { extensions?: { debugBattle?: unknown } }
      }
      if (storage.state.extensions) delete storage.state.extensions.debugBattle
      return next
    }

    memoryStore.reset()
    memoryStore.seed(withoutTrace(validRoom))
    const command = {
      type: 'deploymentLock',
      playerId: firstIdentity.id,
      clientActionId: 'pinned-http-action',
    }
    const httpSnapshot = await httpBattleSnapshot(roomId, { identity: firstIdentity })
    const httpAction = await httpBattleAction(
      roomId,
      firstIdentity.id,
      command,
      firstIdentity.id,
      firstIdentity,
    )
    expect(httpSnapshot).toMatchObject({
      status: 409,
      body: { code: 'PINNED_PROFILE_UNAVAILABLE', context: expect.any(Object) },
    })
    expect(httpAction).toMatchObject({
      status: 409,
      body: { code: 'PINNED_PROFILE_UNAVAILABLE', context: expect.any(Object) },
    })

    const snapshotClient = await openClient()
    try {
      await sendBattleSubscribe(snapshotClient, firstIdentity, roomId)
      expect(await receiveType(snapshotClient, 'subscriptionError')).toMatchObject({
        status: 409,
        code: 'PINNED_PROFILE_UNAVAILABLE',
        context: expect.any(Object),
      })
    } finally {
      snapshotClient.close()
    }
    expect(memoryStore.writeCount()).toBe(0)

    memoryStore.reset()
    memoryStore.seed(validRoom)
    const actionClient = await openClient()
    try {
      await sendBattleSubscribe(actionClient, firstIdentity, roomId)
      await receiveType(actionClient, 'subscribed')
      await receiveType(actionClient, 'stateUpdate')
      memoryStore.seed(withoutTrace(validRoom))
      const auth = await signBattleAction(firstIdentity, roomId, command)
      actionClient.send(JSON.stringify({
        type: 'action',
        protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
        authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
        action: command,
        auth,
      }))
      expect(await receiveType(actionClient, 'actionError')).toMatchObject({
        status: 409,
        code: 'PINNED_PROFILE_UNAVAILABLE',
        context: expect.any(Object),
      })
    } finally {
      actionClient.close()
    }
    expect(memoryStore.writeCount()).toBe(0)
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
      firstIdentity,
      'actionError',
      false,
    )

    expect(forgedHttp).toMatchObject({ status: 401, body: { code: 'BATTLE_AUTH_REQUIRED' } })
    expect(forgedWs).toMatchObject({ type: 'actionError', code: 'BATTLE_AUTH_REQUIRED' })
    expect(memoryStore.snapshot('forged-deployment')).toEqual(before)
    expect(memoryStore.writeCount()).toBe(writesBefore)
  })

  it('projects reserve instances and active offers out of room GET and repeated start responses', async () => {
    memoryStore.seed(signedRoom('room-projection', 'light'))
    await httpSelect('room-projection', firstIdentity.id, lightRoster)
    await wsSelect('room-projection', secondIdentity.id, lightRoster)
    const internal = memoryStore.snapshot('room-projection')
    const state = (internal?.battleState as unknown as {
      state: {
        deployment: {
          offerPieceIds?: string[]
          legalPositions?: Array<{ x: number; y: number }>
          reserves?: Record<string, unknown[]>
        }
      }
    }).state
    expect(state.deployment.offerPieceIds).toHaveLength(3)
    expect(state.deployment.legalPositions?.length).toBeGreaterThan(0)
    expect(state.deployment.reserves?.[firstIdentity.id]?.length).toBe(7)

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
      const deployment = projected.deployment as JsonObject
      expect(deployment.choices).toEqual({})
      expect(deployment.reserves).toEqual({})
      expect(deployment.offerPieceIds).toEqual([])
      expect(deployment.offerPieces).toEqual([])
      expect(deployment.legalPositions).toEqual([])
      expect(deployment).not.toHaveProperty('freeMovePositions')
      expect(deployment).not.toHaveProperty('freeMovePieceId')
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
    const sourceState = (source.battleState as unknown as {
      state: {
        deployment: {
          revision: number
          offerPieceIds?: string[]
          legalPositions?: Array<{ x: number; y: number }>
        }
      }
    }).state
    const pieceId = sourceState.deployment.offerPieceIds?.[0]
    const position = sourceState.deployment.legalPositions?.[0]
    if (!pieceId || !position) throw new Error('Expected an authoritative reserve offer and safe position')
    const action = {
      type: 'deployReservePiece',
      playerId: firstIdentity.id,
      expectedDeploymentRevision: sourceState.deployment.revision,
      pieceId,
      toX: position.x,
      toY: position.y,
      clientActionId: 'alice-deploy-reserve',
    }

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
      await sendBattleSubscribe(client, secondIdentity, 'terminal-race')
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
      client.send(JSON.stringify({
        type: 'action',
        protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
        authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
        action: wsAction,
        auth: wsAuth,
      }))

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
