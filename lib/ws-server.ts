import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { assignNextSeat, getPlayerSeat, normalizePlayerAlignment, roomStore } from './game/room-store'
import { getBattleStorage, withServerSkills } from './game/battle-storage'
import {
  createPublicBattleSnapshot,
  createPublicBattleResyncSnapshot,
  createPublicBattleTransitionUpdate,
  createPublicRoomSnapshot,
  dispatchRoomBattleAction,
  scheduleRoomBattleTimeout,
  type DispatchRoomBattleActionResult,
  type PublicBattleSnapshot,
} from './game/room-battle-actions'
import { parseBattleAuthorityEnvelope, roomBattleAuthorityVersion } from './game/battle-transition'
import { buildBattleStateHashIndex } from './game/battle-state-hash'
import { hashStable } from './game/battle-trace'
import { toPublicBattleState } from './game/deployment'
import {
  getCurrentInputOwnerPlayerId,
  isTurnTimerEnabled,
  projectTurnTimer,
} from './game/turn-timer'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from './game/battle-public-patch'
import type { BattleAction, BattleState } from './game/turn'
import {
  BattleActionAuthError,
  derivePlayerId,
  verifyBattleActionAuth,
  verifyBattleSubscribeAuth,
  verifyJoinAuth,
  verifyRecordSignature,
} from './game/identity-verify'
import { loadCardById } from './game/skills'
import { getClientTerminalSubmissionError } from './server/battle-terminal'
import {
  ensureRosterAlignmentMutable,
  getDemoRosterReadiness,
  getRosterErrorPayload,
  lockDefaultBotRosterInStore,
  lockDemoRosterInStore,
} from './game/roster-contract'
import { startBattleFromLockedRosters } from './game/room-battle-start'
import { assertSelectableMapId, getMapSelectionErrorPayload, getSelectableMapCatalog } from './game/map-selection'
import { getAllPieces } from './game/piece-repository'
import { getAllSkills } from './game/skill-repository'
import { installBattleAuthorityShutdownHandlers } from './server/battle-authority-shutdown'
import { getProfileWsIngressTrackerV1 } from './content-pipeline/runtime/profile-ws-ingress'
import {
  assertGameProfileCompatibleV1,
  getGameProfileErrorPayloadV1,
  getServerGameProfileIdentityV1,
  type GameProfileIdentityV1,
} from './content-pipeline/runtime/profile-game-identity'

// HMR-safe: keep server + client maps on globalThis so Next.js hot reloads
// can tear down the old WebSocketServer (which holds stale handler closures)
// and start a new one without requiring a full dev-server restart.
const _g = globalThis as unknown as {
  __rvbWss?: WebSocketServer | null
  __rvbWsLifecycle?: Promise<void>
  __rvbRoomClients?: Map<string, Set<WebSocket>>
  __rvbPlayerWs?: Map<string, WebSocket>
  __rvbWsIdentities?: WeakMap<WebSocket, { roomId: string; playerId?: string }>
  __rvbWsUpgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  __rvbBattleAuthorityShutdownInstalled?: boolean
  __rvbBotTurnTimers?: Map<string, ReturnType<typeof setTimeout>>
  __rvbBotTurnsRunning?: Set<string>
}

const roomClients = (_g.__rvbRoomClients ??= new Map<string, Set<WebSocket>>())
const playerWs = (_g.__rvbPlayerWs ??= new Map<string, WebSocket>())
const wsIdentities = (_g.__rvbWsIdentities ??= new WeakMap<WebSocket, { roomId: string; playerId?: string }>())
const botTurnTimers = (_g.__rvbBotTurnTimers ??= new Map<string, ReturnType<typeof setTimeout>>())
const botTurnsRunning = (_g.__rvbBotTurnsRunning ??= new Set<string>())
let _wss: WebSocketServer | null = _g.__rvbWss ?? null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publicRoom(room: any): unknown {
  if (!room) return null
  return {
    profileIdentity: getServerGameProfileIdentityV1(),
    id: room.id,
    name: room.name,
    status: authoritativeRoomStatus(room),
    hostId: room.hostId,
    mapId: room.mapId,
    maxPlayers: room.maxPlayers || 2,
    authorityVersion: roomBattleAuthorityVersion(room),
    visibility: room.visibility || 'public',
    inviteCode: room.inviteCode,
    createdAt: room.createdAt,
    players: (room.players || []).map((p: any) => ({
      id: p.id,
      accountId: p.accountId,
      name: p.name,
      seat: getPlayerSeat(p),
      faction: p.faction,
      alignment: p.alignment,
      ready: p.ready,
      hasSelectedPieces: p.rosterLocked === true,
      selectedPiecesCount: p.selectedPieces ? p.selectedPieces.length : 0,
      rosterLocked: p.rosterLocked === true,
      rosterManifestVersion: p.rosterManifestVersion,
    })),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publicRoomList(room: any): unknown {
  return {
    profileIdentity: getServerGameProfileIdentityV1(),
    id: room.id,
    name: room.name,
    status: authoritativeRoomStatus(room),
    players: (room.players || []).map((p: any) => ({
      id: p.id,
      accountId: p.accountId,
      name: p.name,
      seat: getPlayerSeat(p),
      faction: p.faction,
      alignment: p.alignment,
      hasSelectedPieces: p.rosterLocked === true,
    })),
    playerCount: (room.players || []).length,
    playersCount: (room.players || []).length,
    maxPlayers: room.maxPlayers || 2,
    mapId: room.mapId,
    hostId: room.hostId,
    createdAt: room.createdAt,
    visibility: room.visibility || 'public',
    inviteCode: room.inviteCode,
  }
}

function authoritativeRoomStatus(room: any): string {
  const terminal = (getBattleStorage(room)?.state as BattleState | undefined)?.terminalResult
  return terminal?.status === 'finished' ? 'finished' : room.status
}

function hasConnectedBattlePlayer(room: any): boolean {
  const players = new Set(
    (room.players || [])
      .map((player: any) => String(player.id || '').trim().toLowerCase())
      .filter(Boolean),
  )
  const clients = roomClients.get(String(room.id || '').trim().toLowerCase())
  if (!clients || players.size === 0) return false
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    const identity = wsIdentities.get(client)
    if (identity?.playerId && players.has(identity.playerId)) return true
  }
  return false
}

function publicLobbyRoomList(rooms: any[]): unknown[] {
  return rooms
    .filter(room => {
      const status = authoritativeRoomStatus(room)
      if (status === 'finished') return false
      return status !== 'in-progress' || hasConnectedBattlePlayer(room)
    })
    .map(publicRoomList)
}

function makeRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let roomId = ''
  for (let i = 0; i < 5; i++) roomId += chars.charAt(Math.floor(Math.random() * chars.length))
  return roomId
}

function makeInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length))
  return code
}

async function broadcastLobby(): Promise<void> {
  const rooms = await roomStore.getAllRooms()
  broadcastToRoom('__lobby', { type: 'lobbyUpdate', rooms: publicLobbyRoomList(rooms) })
}

interface CommittedBattleSnapshotSource {
  snapshot: PublicBattleSnapshot
  state: BattleState
}

function projectCommittedBattleSnapshot(
  source: CommittedBattleSnapshotSource,
  viewerPlayerId?: string,
): PublicBattleSnapshot {
  const state = toPublicBattleState(source.state, viewerPlayerId)
  return {
    ...source.snapshot,
    state,
    stateHash: buildBattleStateHashIndex(state, hashStable).rootHash,
    turnTimer: state.terminalResult || !isTurnTimerEnabled()
      ? undefined
      : projectTurnTimer(state.turnTimer, source.snapshot.serverNow),
  }
}

/**
 * Full snapshots contain viewer-private deployment and pending-interaction data,
 * so they must never be serialized once and fanned out to the whole room.
 */
export async function broadcastBattleSnapshot(
  roomId: string,
  committed?: CommittedBattleSnapshotSource,
): Promise<void> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const clients = roomClients.get(normalizedRoomId)
  if (!clients || clients.size === 0) return
  const room = committed ? undefined : await roomStore.getRoom(normalizedRoomId)
  if (!committed && !room) return

  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    const identity = wsIdentities.get(client)
    try {
      const snapshot = committed
        ? projectCommittedBattleSnapshot(committed, identity?.playerId)
        : createPublicBattleSnapshot(room!, identity?.playerId)
      sendJson(client, { type: 'stateUpdate', ...snapshot })
    } catch (error) {
      console.error('[WS] battle snapshot projection failed', JSON.stringify({
        roomId: normalizedRoomId,
        playerId: identity?.playerId,
        authorityVersion: committed?.snapshot.authorityVersion,
        message: error instanceof Error ? error.message : String(error),
      }))
    }
  }
}

export interface BattleTransitionBroadcastDependencies {
  createTransitionUpdate?: typeof createPublicBattleTransitionUpdate
  createResyncSnapshot?: typeof createPublicBattleResyncSnapshot
}

export function broadcastBattleTransition(
  roomId: string,
  result: DispatchRoomBattleActionResult,
  dependencies: BattleTransitionBroadcastDependencies = {},
): void {
  const clients = roomClients.get(roomId.trim().toLowerCase())
  if (!clients || !result.transition) return
  const projectTransition = dependencies.createTransitionUpdate ?? createPublicBattleTransitionUpdate
  const projectResync = dependencies.createResyncSnapshot ?? createPublicBattleResyncSnapshot
  type Recipient = { client: WebSocket; identity?: { roomId: string; playerId?: string } }
  const actorRecipients: Recipient[] = []
  const otherRecipients: Recipient[] = []
  const actorPlayerId = result.transition.playerId
  const prioritizeActor = !!actorPlayerId && actorPlayerId !== 'system'
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    const recipient = { client, identity: wsIdentities.get(client) }
    if (prioritizeActor && recipient.identity?.playerId === actorPlayerId) {
      actorRecipients.push(recipient)
    } else {
      otherRecipients.push(recipient)
    }
  }

  for (const { client, identity } of [...actorRecipients, ...otherRecipients]) {
    try {
      const update = projectTransition(result, roomId, identity?.playerId)
      if (update) sendJson(client, update)
    } catch (error) {
      const details = error as { code?: unknown; message?: unknown; context?: unknown }
      console.error('[WS] battle transition projection failed', JSON.stringify({
        roomId: roomId.trim().toLowerCase(),
        playerId: identity?.playerId,
        fromVersion: result.transition.fromVersion,
        toVersion: result.transition.toVersion,
        code: details?.code,
        message: details?.message ?? String(error),
        context: details?.context,
      }))
      try {
        if (identity?.playerId === result.transition.playerId && result.receipt) {
          sendJson(client, { type: 'battleReceipt', receipt: result.receipt })
        }
        const snapshot = projectResync(result, roomId, identity?.playerId)
        if (snapshot) sendJson(client, { type: 'stateUpdate', ...snapshot, reason: 'transition-projection-failed' })
      } catch (fallbackError) {
        console.error('[WS] battle transition resync fallback failed', JSON.stringify({
          roomId: roomId.trim().toLowerCase(),
          playerId: identity?.playerId,
          toVersion: result.transition.toVersion,
          message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        }))
      }
    }
  }
}

function startBattleWithDeploymentBroadcast(roomId: string) {
  return startBattleFromLockedRosters(roomStore, roomId, {
    onDeploymentUpdate: () => broadcastBattleSnapshot(roomId),
  })
}

function sendActionError(ws: WebSocket, payload: Record<string, unknown>): void {
  sendJson(ws, {
    type: 'actionError',
    ...payload,
  })
}

function rejectWsMessageDuringProfileActivation(
  ws: WebSocket,
  msg: Record<string, unknown>,
): void {
  const error = 'Profile activation in progress'
  if (msg.type === 'rpc' && typeof msg.requestId === 'string') {
    sendJson(ws, {
      type: 'rpcResult',
      requestId: msg.requestId,
      ok: false,
      error,
      status: 503,
    })
    return
  }
  if (msg.type === 'roomAction') {
    sendJson(ws, {
      type: 'roomActionResult',
      action: msg.action,
      success: false,
      error,
      status: 503,
    })
    return
  }
  if (['action', 'gameOver'].includes(String(msg.type))) {
    sendActionError(ws, { error, action: msg.command ?? msg.action, status: 503 })
  }
}

async function broadcastRoom(roomId: string): Promise<void> {
  const room = await roomStore.getRoom(roomId)
  if (room) broadcastToRoom(roomId, { type: 'roomUpdate', room: publicRoom(room) })
  await broadcastLobby()
}

// Assign turn-order faction ensuring two players always get opposite colors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nextFaction(room: any, playerId?: string): 'red' | 'blue' {
  return assignNextSeat(room.players || [], playerId)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function joinRoomViaWs(roomId: string, body: any): Promise<any> {
  const profileIdentity = assertGameProfileCompatibleV1(body.profileIdentity)
  const room = await roomStore.getRoom(roomId)
  if (!room) throw new Error('Room not found')
  for (const participant of room.players) {
    assertGameProfileCompatibleV1(participant.profileIdentity)
  }
  if (room.status !== 'in-progress' || !room.battleState) {
    assertSelectableMapId(room.mapId)
  }

  const normalizedPlayerId = String(body.playerId || '').trim().toLowerCase()
  const accountId = String(body.accountId || body.identityId || '').trim().toLowerCase() || undefined
  const playerName = String(body.playerName || '').trim()
  if (!normalizedPlayerId) throw new Error('playerId is required')

  if (body.payload || body.signature || body.publicKey) {
    const authErr = await verifyJoinAuth(body as Record<string, unknown>)
    if (authErr) throw new Error(authErr)
  }

  const requestedAlignment = normalizePlayerAlignment(body.alignment)

  let player = room.players.find(p => p.id.toLowerCase() === normalizedPlayerId)
  if (player) {
    assertGameProfileCompatibleV1(player.profileIdentity)
    if (accountId) player.accountId = accountId
    if (playerName) player.name = playerName
    if (!getPlayerSeat(player)) {
      const seat = nextFaction(room, normalizedPlayerId)
      player.seat = seat
      player.faction = seat
    }
    ensureRosterAlignmentMutable(player, requestedAlignment)
    if (requestedAlignment) player.alignment = requestedAlignment
    player.profileIdentity = profileIdentity
    await roomStore.setRoom(roomId, room)
    await broadcastRoom(roomId)
    return createPublicRoomSnapshot(room)
  }

  if (room.status !== 'waiting') throw new Error('Cannot join a game that has already started or finished')
  if (room.players.length >= (room.maxPlayers ?? 2)) throw new Error('Room is full')

  player = {
    id: normalizedPlayerId,
    accountId,
    name: playerName || `Player ${normalizedPlayerId.slice(0, 8)}`,
    joinedAt: Date.now(),
    seat: nextFaction(room, normalizedPlayerId),
    ...(requestedAlignment ? { alignment: requestedAlignment } : {}),
    profileIdentity,
  }
  player.faction = player.seat
  room.players.push(player)
  if (!room.hostId) room.hostId = normalizedPlayerId
  await roomStore.setRoom(roomId, room)
  await broadcastRoom(roomId)
  return createPublicRoomSnapshot(room)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyRoomAction(roomId: string, body: any): Promise<any> {
  const action = body.action
  if (action === 'join') return joinRoomViaWs(roomId, body)
  const profileIdentity: GameProfileIdentityV1 | undefined = action === 'leave'
    ? undefined
    : assertGameProfileCompatibleV1(body.profileIdentity)

  const room = await roomStore.getRoom(roomId)
  if (!room) throw new Error('Room not found')
  if (room.status !== 'in-progress' || !room.battleState) {
    assertSelectableMapId(room.mapId)
  }

  if (profileIdentity) {
    for (const participant of room.players) {
      assertGameProfileCompatibleV1(participant.profileIdentity)
    }
  }

  const normalizedPlayerId = String(body.playerId || '').trim().toLowerCase()
  const accountId = String(body.accountId || body.identityId || '').trim().toLowerCase() || undefined
  const playerName = String(body.playerName || '').trim()
  if (!normalizedPlayerId) throw new Error('playerId is required')

  const requestedAlignment = normalizePlayerAlignment(body.alignment)

  if (action === 'select-pieces') {
    const locked = await lockDemoRosterInStore(roomStore, roomId, {
      playerId: normalizedPlayerId,
      alignment: requestedAlignment,
      pieces: body.pieces,
    })
    const afterBotLock = await lockDefaultBotRosterInStore(roomStore, roomId)
    const latest = afterBotLock ?? locked.room
    if (getDemoRosterReadiness(latest).ready && latest.status !== 'in-progress') {
      await startBattleWithDeploymentBroadcast(roomId)
    }

    const finalRoom = await roomStore.getRoom(roomId)
    await broadcastRoom(roomId)
    return {
      success: true,
      duplicate: locked.duplicate,
      locked: true,
      playerId: locked.playerId,
      selectedPiecesCount: locked.selectedPiecesCount,
      manifestVersion: locked.manifestVersion,
      room: publicRoom(finalRoom),
    }
  }

  let player = room.players.find(p => p.id.toLowerCase() === normalizedPlayerId)
  if (!player && action === 'claim-faction') {
    if (!profileIdentity) {
      throw new Error('Profile identity is required to claim a room seat')
    }
    if (room.players.length >= (room.maxPlayers ?? 2)) throw new Error('Room is full')
    player = {
      id: normalizedPlayerId,
      accountId,
      name: playerName || `Player ${normalizedPlayerId.slice(0, 8)}`,
      joinedAt: Date.now(),
      seat: nextFaction(room, normalizedPlayerId),
      profileIdentity,
    }
    player.faction = player.seat
    room.players.push(player)
    if (!room.hostId) room.hostId = normalizedPlayerId
  }
  if (!player) throw new Error('Player not in room')
  if (profileIdentity) player.profileIdentity = profileIdentity
  if (accountId) player.accountId = accountId
  if (playerName) player.name = playerName
  if (!getPlayerSeat(player)) {
    const seat = nextFaction(room, normalizedPlayerId)
    player.seat = seat
    player.faction = seat
  }
  if (action === 'claim-faction') {
    ensureRosterAlignmentMutable(player, requestedAlignment)
    if (requestedAlignment) player.alignment = requestedAlignment
    await roomStore.setRoom(roomId, room)
    await broadcastRoom(roomId)
    return { success: true, seat: getPlayerSeat(player), faction: player.faction, alignment: player.alignment, room: publicRoom(room) }
  }

  if (action === 'toggle-ready') {
    player.ready = !player.ready
    const allReady = room.players.length >= 2 && room.players.every(p => p.ready === true)
    if (allReady && room.status === 'waiting') room.status = 'ready'
    else if (!allReady && room.status === 'ready') room.status = 'waiting'
    await roomStore.setRoom(roomId, room)
    await broadcastRoom(roomId)
    return createPublicRoomSnapshot(room)
  }

  if (action === 'leave') {
    const before = room.players.length
    room.players = room.players.filter(p => p.id.toLowerCase() !== normalizedPlayerId)
    if (room.players.length < 2 && room.status === 'ready') room.status = 'waiting'
    room.players.forEach(p => { p.ready = false })
    if (room.hostId && room.hostId.toLowerCase() === normalizedPlayerId && room.players.length > 0) {
      room.hostId = room.players[0].id
    }
    await roomStore.setRoom(roomId, room)
    await broadcastRoom(roomId)
    return { success: true, left: before !== room.players.length, room: publicRoom(room) }
  }

  if (action === 'start-game') {
    await startBattleWithDeploymentBroadcast(roomId)
    await broadcastRoom(roomId)
    const started = await roomStore.getRoom(roomId)
    if (!started) throw new Error('Room not found')
    return createPublicRoomSnapshot(started)
  }

  throw new Error('Unsupported room action: ' + action)
}

function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
}

// Repair/complete the old HTTP room flow from inside WS. If both players already
// selected pieces but no battleState was created, battle subscribers can still
// enter the fight without relying on a final HTTP actions call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureBattleReady(roomId: string): Promise<any | null> {
  let room = await roomStore.getRoom(roomId)
  if (!room) return null
  if (getBattleStorage(room)) return room

  if (getDemoRosterReadiness(room).ready) {
    await startBattleWithDeploymentBroadcast(roomId)
    room = await roomStore.getRoom(roomId)
  }
  return room
}

async function sendBattleSnapshot(
  ws: WebSocket,
  roomId: string,
  viewerPlayerId?: string | null,
  requestId?: string,
): Promise<void> {
  const requestContext = requestId ? { requestId } : {}
  const room = await ensureBattleReady(roomId)
  if (!room) {
    sendJson(ws, { type: 'battleUnavailable', reason: 'room-not-found', roomId, ...requestContext })
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawBattleState = (room as any).battleState
  if (rawBattleState?.type === 'action-log' && Array.isArray(rawBattleState.actions)) {
    sendJson(ws, {
      type: 'battleSnapshot',
      actions: rawBattleState.actions,
      total: rawBattleState.actions.length,
      seed: rawBattleState.seed ?? 0,
      ...requestContext,
    })
    return
  }
  const storage = getBattleStorage(room)
  if (storage) {
    sendJson(ws, {
      type: 'stateUpdate',
      ...createPublicBattleSnapshot(room, viewerPlayerId ?? undefined),
      ...requestContext,
    })
    return
  }
  sendJson(ws, {
    type: 'battleUnavailable',
    reason: 'battle-not-started',
    room: publicRoom(room),
    ...requestContext,
  })
}

async function quiesceWsServer(): Promise<void> {
  for (const timer of botTurnTimers.values()) clearTimeout(timer)
  botTurnTimers.clear()
  const activeServer = _g.__rvbWss ?? _wss
  if (activeServer) {
    // HMR installs a fresh noServer router on the existing HTTP server.
    for (const client of activeServer.clients) client.terminate()
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => error ? reject(error) : resolve())
    })
    if (_wss === activeServer) _wss = null
    if (_g.__rvbWss === activeServer) _g.__rvbWss = null
    delete _g.__rvbWsUpgradeHandler
    roomClients.clear()
    playerWs.clear()
  }
}

async function restartWsServer(): Promise<void> {
  await quiesceWsServer()
  if (process.env.DISABLE_WS === '1') {
    console.log('[WS] WebSocket server disabled (DISABLE_WS=1)')
    return
  }

  const server = new WebSocketServer({ noServer: true })
  _wss = server
  _g.__rvbWss = server
  _g.__rvbWsUpgradeHandler = (request, socket, head) => {
    if (_g.__rvbWss !== server) {
      try { socket.destroy() } catch {}
      return
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      server.emit('connection', ws, request)
    })
  }
  console.log('[WS] WebSocket service attached to the public HTTP(S) origin at /ws')

  server.on('error', (err: Error) => {
    console.error('[WS] Same-origin WebSocket service failed:', err.message)
    if (_wss === server) _wss = null
    if (_g.__rvbWss === server) {
      _g.__rvbWss = null
      delete _g.__rvbWsUpgradeHandler
    }
  })

  server.on('connection', (ws: WebSocket) => {
    let roomId: string | null = null
    let playerId: string | null = null
    const rpcRequests = new Map<string, { fingerprint: string; response?: Record<string, unknown>; waiters: number }>()

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'ping') {
          sendJson(ws, { type: 'pong' })
          return
        }
        const finishIngress = getProfileWsIngressTrackerV1().tryEnter()
        if (!finishIngress) {
          rejectWsMessageDuringProfileActivation(ws, msg)
          return
        }
        let deferred = false
        const runAsync = (operation: () => Promise<void>) => {
          deferred = true
          void operation()
            .catch(error => console.warn('[WS] message task failed:', error))
            .finally(finishIngress)
        }
        try {
          if (msg.type === 'rpc' && typeof msg.requestId === 'string') {
            const requestId = msg.requestId
            const method = String(msg.method || '')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = (msg.data || {}) as any
            const fingerprint = JSON.stringify([method, data])
            const existing = rpcRequests.get(requestId)
            if (existing) {
              if (existing.fingerprint !== fingerprint) {
                sendJson(ws, {
                  type: 'rpcResult', requestId, ok: false,
                  error: 'requestId was already used for a different RPC payload',
                  code: 'RPC_REQUEST_ID_CONFLICT', status: 409,
                })
              } else if (existing.response) {
                sendJson(ws, existing.response)
              } else {
                existing.waiters += 1
              }
              return
            }
            if (rpcRequests.size >= 256) {
              const oldestRequestId = rpcRequests.keys().next().value
              if (oldestRequestId) rpcRequests.delete(oldestRequestId)
            }
            const rpcRecord = { fingerprint, waiters: 0 } as { fingerprint: string; response?: Record<string, unknown>; waiters: number }
            rpcRequests.set(requestId, rpcRecord)
            const sendRpcResponse = (response: Record<string, unknown>) => {
              rpcRecord.response = response
              sendJson(ws, response)
              while (rpcRecord.waiters > 0) { sendJson(ws, response); rpcRecord.waiters -= 1 }
            }
            runAsync(async () => {
            try {
              let result: unknown
              if (method === 'system.health') {
                result = {
                  ok: true,
                  protocol: 'rvb-ws',
                  protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
                  authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
                }
              } else if (method === 'catalog.identity') {
                result = { profileIdentity: getServerGameProfileIdentityV1() }
              } else if (method === 'catalog.maps') {
                result = { maps: getSelectableMapCatalog() }
              } else if (method === 'catalog.pieces') {
                result = { pieces: getAllPieces() }
              } else if (method === 'catalog.skills') {
                result = { skills: getAllSkills() }
              } else if (method === 'catalog.card') {
                const cardId = String(data.cardId || '')
                if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(cardId)) throw new Error('Invalid cardId')
                const card = loadCardById(cardId)
                if (!card) throw new Error('Card not found')
                result = card
              } else if (method === 'rooms.list' || method === 'lobby.list') {
                const rooms = await roomStore.getAllRooms()
                result = { rooms: publicLobbyRoomList(rooms) }
              } else if (method === 'rooms.create' || method === 'lobby.create') {
                assertGameProfileCompatibleV1(data.profileIdentity)
                const mapId = assertSelectableMapId(data.mapId)
                let roomId = makeRoomId()
                while (await roomStore.getRoom(roomId)) roomId = makeRoomId()
                const now = Date.now()
                const hostId = String(data.hostId || '').trim().toLowerCase()
                const isPve = data.mode === 'pve'
                const initialPlayers: any[] = []
                if (isPve) {
                  // Auto-add bot as blue player so room is immediately full
                  initialPlayers.push({
                    id: 'bot',
                    name: 'AI Bot',
                    joinedAt: now,
                    faction: 'blue' as const,
                    alignment: 'dark' as const,
                    isBot: true,
                    profileIdentity: getServerGameProfileIdentityV1(),
                    hasSelectedPieces: false,
                    selectedPieces: [],
                    ready: true,
                  })
                }
                const room = {
                  id: roomId,
                  name: String(data.name || `Room ${roomId}`).trim(),
                  status: 'waiting' as const,
                  createdAt: now,
                  maxPlayers: 2,
                  players: initialPlayers,
                  hostId,
                  mapId,
                  visibility: data.visibility === 'private' ? 'private' as const : 'public' as const,
                  inviteCode: makeInviteCode(),
                  spectators: [],
                  currentTurnIndex: 0,
                  actions: [],
                  battleState: undefined,
                }
                await roomStore.setRoom(roomId, room)
                await broadcastLobby()
                result = room
              } else if (method === 'rooms.get') {
                const targetRoomId = String(data.roomId || '').trim().toLowerCase()
                const room = await ensureBattleReady(targetRoomId)
                if (!room) throw new Error('Room not found')
                result = {
                  ...createPublicRoomSnapshot(room),
                  profileIdentity: getServerGameProfileIdentityV1(),
                }
              } else if (method === 'rooms.delete') {
                const targetRoomId = String(data.roomId || '').trim().toLowerCase()
                const player = String(data.playerId || '').trim().toLowerCase()
                const room = await roomStore.getRoom(targetRoomId)
                if (!room) throw new Error('Room not found')
                if (authoritativeRoomStatus(room) === 'in-progress') throw new Error('Cannot delete room while game is in progress')
                if (room.hostId && room.hostId.toLowerCase() !== player) throw new Error('Unauthorized - only host can delete room')
                const removed = await roomStore.removeRoom(targetRoomId)
                if (!removed) throw new Error('Room could not be deleted')
                await broadcastLobby()
                result = { success: true, deletedBy: 'host' }
              } else if (method === 'rooms.action') {
                const targetRoomId = String(data.roomId || roomId || '').trim().toLowerCase()
                if (!targetRoomId) throw new Error('roomId is required')
                result = await applyRoomAction(targetRoomId, data)
              } else if (method === 'rooms.spectate') {
                const profileIdentity = assertGameProfileCompatibleV1(data.profileIdentity)
                const targetRoomId = String(data.roomId || '').trim().toLowerCase()
                const spectatorId = String(data.spectatorId || '').trim().toLowerCase()
                const spectatorName = String(data.spectatorName || spectatorId.slice(0, 8)).trim()
                if (!targetRoomId || !spectatorId) throw new Error('roomId and spectatorId are required')
                const room = await roomStore.getRoom(targetRoomId)
                if (!room) throw new Error('Room not found')
                for (const participant of room.players) {
                  assertGameProfileCompatibleV1(participant.profileIdentity)
                }
                for (const existingSpectator of room.spectators ?? []) {
                  assertGameProfileCompatibleV1(existingSpectator.profileIdentity)
                }
                if (authoritativeRoomStatus(room) !== 'in-progress') throw new Error('只有正在进行中的房间才能观战')
                if (room.players.some(p => p.id === spectatorId)) throw new Error('你已经是该房间的参战玩家')
                await roomStore.addSpectator(targetRoomId, {
                  id: spectatorId,
                  name: spectatorName,
                  joinedAt: Date.now(),
                  profileIdentity,
                })
                const updated = await roomStore.getRoom(targetRoomId)
                result = { success: true, spectators: updated?.spectators ?? [] }
              } else if (method === 'gameRecord.get') {
                const targetRoomId = String(data.roomId || '').trim().toLowerCase()
                const room = await roomStore.getRoom(targetRoomId)
                if (!room) throw new Error('Room not found')
                if (!room.gameRecord) throw new Error('Game not finished')
                result = room.gameRecord
              } else if (method === 'gameRecord.sign') {
                const targetRoomId = String(data.roomId || '').trim().toLowerCase()
                const player = String(data.playerId || '').trim().toLowerCase()
                const publicKey = String(data.publicKey || '')
                const signature = String(data.signature || '')
                if (!player || !publicKey || !signature) throw new Error('Missing fields')
                const room = await roomStore.getRoom(targetRoomId)
                if (!room?.gameRecord) throw new Error('Game record not found')
                if (!room.players.find(p => p.id === player)) throw new Error('Player not in this game')
                if (await derivePlayerId(publicKey) !== player) throw new Error('Public key mismatch')
                const { signatures: _sig, ...recordToSign } = room.gameRecord as unknown as Record<string, unknown>
                void _sig
                if (!await verifyRecordSignature(recordToSign, signature, publicKey)) throw new Error('Invalid signature')
                room.gameRecord.signatures[player] = signature
                await roomStore.setRoom(targetRoomId, room)
                result = { success: true, signaturesCount: Object.keys(room.gameRecord.signatures).length }
              } else {
                throw new Error('Unsupported RPC method: ' + method)
              }
              sendRpcResponse({ type: 'rpcResult', requestId, ok: true, data: result })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const profileError = getGameProfileErrorPayloadV1(err)
              const rosterError = getRosterErrorPayload(err)
              const mapError = getMapSelectionErrorPayload(err)
              const status = profileError?.status ?? (mapError ? 400 : message === 'Room not found' ? 404 : undefined)
              sendRpcResponse({
                type: 'rpcResult',
                requestId,
                ok: false,
                error: profileError?.message ?? rosterError?.message ?? mapError?.message ?? message,
                code: profileError?.code ?? rosterError?.code ?? mapError?.code,
                context: profileError?.context ?? rosterError?.context ?? mapError?.context,
                status,
              })
            }
          })
        } else if (msg.type === 'subscribe' && typeof msg.roomId === 'string') {
          if (
            msg.protocolVersion !== BATTLE_AUTHORITY_PROTOCOL_VERSION
            || msg.authorityBuildId !== BATTLE_AUTHORITY_BUILD_ID
          ) {
            sendJson(ws, {
              type: 'battleProtocolUnsupported',
              code: 'BATTLE_PROTOCOL_UNSUPPORTED',
              expectedProtocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
              expectedAuthorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
              receivedProtocolVersion: msg.protocolVersion,
              receivedAuthorityBuildId: msg.authorityBuildId,
            })
            return
          }
          const nextRoomId = msg.roomId.toLowerCase()
          const requestedPlayerId = typeof msg.playerId === 'string'
            ? msg.playerId.trim().toLowerCase()
            : null
          runAsync(async () => {
            let nextPlayerId = requestedPlayerId
            try {
              const nextRoom = nextRoomId === '__lobby'
                ? undefined
                : await roomStore.getRoom(nextRoomId)
              if (nextRoomId !== '__lobby') {
                assertGameProfileCompatibleV1(msg.profileIdentity)
                if (!nextRoom) throw new Error('Room not found')
                const verifiedIdentity = await verifyBattleSubscribeAuth(msg, {
                  roomId: nextRoomId,
                  protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
                  authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
                })
                const participant = nextRoom.players.find(
                  item => item.id.toLowerCase() === verifiedIdentity.playerId,
                ) ?? nextRoom.spectators.find(
                  item => item.id.toLowerCase() === verifiedIdentity.playerId,
                )
                if (!participant) {
                  throw new Error('Signed battle subscriber is not a room participant or spectator')
                }
                assertGameProfileCompatibleV1(participant?.profileIdentity)
                if (nextRoom.battleState) getBattleStorage(nextRoom)
                nextPlayerId = verifiedIdentity.playerId
              }

              if (roomId) {
                roomClients.get(roomId)?.delete(ws)
                if (playerId && playerWs.get(playerId) === ws) playerWs.delete(playerId)
                wsIdentities.delete(ws)
              }
              roomId = nextRoomId
              playerId = nextPlayerId
              wsIdentities.set(ws, { roomId: nextRoomId, ...(playerId ? { playerId } : {}) })
              if (!roomClients.has(nextRoomId)) roomClients.set(nextRoomId, new Set())
              roomClients.get(nextRoomId)!.add(ws)
              if (playerId) playerWs.set(playerId, ws)

              sendJson(ws, {
                type: 'subscribed',
                roomId: nextRoomId,
                role: 'guest',
                protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
                authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
              })
              if (nextRoom) {
                sendJson(ws, { type: 'roomUpdate', room: publicRoom(nextRoom) })
                await sendBattleSnapshot(ws, nextRoomId, playerId)
              }
            } catch (error) {
              const profileError = getGameProfileErrorPayloadV1(error)
              const subscribeError = error as { code?: string; message?: string }
              const subscribeAuthFailure = subscribeError.code?.startsWith('SUBSCRIBE_AUTH_') === true
              sendJson(ws, {
                type: 'subscriptionError',
                roomId: nextRoomId,
                error: profileError?.message ?? subscribeError.message ?? String(error),
                code: profileError?.code ?? subscribeError.code,
                context: profileError?.context,
                status: profileError?.status ?? (subscribeAuthFailure ? 401 : undefined),
              })
            }
          })
        } else if (msg.type === 'roomState' && roomId) {
          runAsync(async () => {
            const room = await roomStore.getRoom(roomId!)
            if (room) sendJson(ws, { type: 'roomUpdate', room: publicRoom(room) })
            await sendBattleSnapshot(ws, roomId!, playerId)
          })
        } else if (msg.type === 'requestBattleSnapshot' && roomId) {
          const snapshotRequestId = typeof msg.requestId === 'string' ? msg.requestId : undefined
          runAsync(async () => { await sendBattleSnapshot(ws, roomId!, playerId, snapshotRequestId) })
        } else if (msg.type === 'roomAction' && roomId) {
          const _roomId = roomId
          const sender = ws
          runAsync(async () => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const body = msg as any
              const action = body.action
              const result = await applyRoomAction(_roomId, { ...body, playerId: body.playerId || playerId })
              sendJson(sender, { type: 'roomActionResult', action, success: true, ...(typeof result === 'object' && result ? result : { result }) })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const profileError = getGameProfileErrorPayloadV1(err)
              const rosterError = getRosterErrorPayload(err)
              const mapError = getMapSelectionErrorPayload(err)
              const status = profileError?.status ?? (mapError ? 400 : message === 'Room not found' ? 404 : undefined)
              sendJson(sender, {
                type: 'roomActionResult',
                action: msg.action,
                success: false,
                error: profileError?.message ?? rosterError?.message ?? mapError?.message ?? message,
                code: profileError?.code ?? rosterError?.code ?? mapError?.code,
                context: profileError?.context ?? rosterError?.context ?? mapError?.context,
                status,
              })
            }
          })
        } else if ((msg.type === 'action' || msg.type === 'gameOver') && roomId) {
          const _roomId = roomId
          const sender = ws
          runAsync(async () => {
            try {
              const terminalSubmissionError = getClientTerminalSubmissionError(msg)
              if (terminalSubmissionError) {
                sendActionError(sender, {
                  error: terminalSubmissionError.message,
                  code: terminalSubmissionError.code,
                })
                return
              }
              const room = await roomStore.getRoom(_roomId)
              if (!room) return
              if (msg.type === 'action') {
                const command = msg.command ?? msg.action
                if (command == null) return
                try {
                  const envelope = parseBattleAuthorityEnvelope({
                    protocolVersion: msg.protocolVersion,
                    authorityBuildId: msg.authorityBuildId,
                    roomId: _roomId,
                    clientActionId: msg.clientActionId ?? command.clientActionId,
                    expectedAuthorityVersion: Number.isSafeInteger(msg.expectedAuthorityVersion)
                      ? msg.expectedAuthorityVersion
                      : roomBattleAuthorityVersion(room),
                    playerId: msg.playerId ?? playerId,
                    command,
                    selectionId: msg.selectionId ?? command.selectionId,
                    stateRevision: msg.stateRevision ?? command.stateRevision,
                  }, _roomId)
                  const verified = await verifyBattleActionAuth(msg.auth, {
                    roomId: _roomId,
                    action: envelope.command,
                  })
                  if (!playerId || playerId !== verified.playerId || envelope.playerId !== verified.playerId) {
                    throw new BattleActionAuthError(
                      'BATTLE_AUTH_INVALID',
                      'Signed battle player does not match the subscribed connection identity',
                    )
                  }
                  const result = await dispatchRoomBattleAction(
                    roomStore,
                    _roomId,
                    verified.playerId,
                    envelope.command,
                    { expectedAuthorityVersion: envelope.expectedAuthorityVersion },
                  )
                  if (result.transition) {
                    broadcastBattleTransition(_roomId, result)
                  } else if (result.kind === 'applied' || result.kind === 'expired') {
                    await broadcastBattleSnapshot(_roomId, {
                      snapshot: result.snapshot,
                      state: result.actionResult.state,
                    })
                  } else if (result.receipt) {
                    sendJson(sender, { type: 'battleReceipt', receipt: result.receipt })
                  }
                  if (result.kind === 'resyncRequired') {
                    sendJson(sender, { type: 'stateUpdate', ...result.snapshot, reason: 'resync' })
                    return
                  }
                  await scheduleRoomBattleTimeout(roomStore, _roomId, {
                    onCommitted: () => broadcastBattleSnapshot(_roomId),
                    onTransitionCommitted: timerResult => broadcastBattleTransition(_roomId, timerResult),
                    onBotTurnReady: (_snapshot, authorityState) => {
                      queueBotTurnIfReady(_roomId, authorityState)
                    },
                  })
                  if (result.kind === 'expired') {
                    // The expired human command may have committed the timeout and
                    // handed the next structural/action input to the bot. Wake it
                    // before returning the expiry error to the stale sender.
                    queueBotTurnIfReady(_roomId, result.actionResult.state)
                    const turnExpired = result.expiredReason === 'turn'
                    sendActionError(sender, {
                      error: turnExpired
                        ? 'Turn deadline elapsed; the authoritative timeout was committed instead.'
                        : 'Deployment deadline elapsed; the authoritative timeout was committed instead.',
                      code: turnExpired ? 'TURN_EXPIRED' : 'DEPLOYMENT_EXPIRED',
                      action: envelope.command,
                      receipt: result.receipt,
                    })
                    return
                  }
                  queueBotTurnIfReady(_roomId, result.actionResult.state)
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  const profileError = getGameProfileErrorPayloadV1(err)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const errAny = err as any
                  console.warn(
                    '[WS] action failed:', _roomId, command?.type,
                    errAny?.needsTargetSelection ? 'needsTargetSelection'
                      : errAny?.needsOptionSelection ? 'needsOptionSelection'
                      : message
                  )
                  if (errAny?.receipt) sendJson(sender, { type: 'battleReceipt', receipt: errAny.receipt })
                  sendActionError(sender, {
                    error: profileError?.message ?? message,
                    code: profileError?.code ?? errAny?.code ?? undefined,
                    status: profileError?.status,
                    action: command,
                    receipt: errAny?.receipt ?? undefined,
                    preparation: errAny?.preparation ?? undefined,
                    needsTargetSelection: errAny?.needsTargetSelection || undefined,
                    targetType: errAny?.targetType ?? undefined,
                    range: errAny?.range ?? undefined,
                    filter: errAny?.filter ?? undefined,
                    targetIndex: errAny?.targetIndex ?? undefined,
                    needsOptionSelection: errAny?.needsOptionSelection || undefined,
                    title: errAny?.title ?? undefined,
                    options: errAny?.options ?? undefined,
                    determinism: errAny?.determinism ?? undefined,
                    context: profileError?.context ?? errAny?.context ?? undefined,
                  })
                }
                return
              }
            } catch (e) {
              console.warn('[WS] handler error:', _roomId, e)
            }
          })
          }
        } finally {
          if (!deferred) finishIngress()
        }
      } catch {}
    })

    ws.on('close', () => {
      if (roomId) roomClients.get(roomId)?.delete(ws)
      if (playerId && playerWs.get(playerId) === ws) playerWs.delete(playerId)
      wsIdentities.delete(ws)
      void broadcastLobby().catch(error => {
        console.warn('[WS] lobby refresh after disconnect failed:', error)
      })
    })
    ws.on('error', () => {
      if (roomId) roomClients.get(roomId)?.delete(ws)
      if (playerId && playerWs.get(playerId) === ws) playerWs.delete(playerId)
      wsIdentities.delete(ws)
      void broadcastLobby().catch(error => {
        console.warn('[WS] lobby refresh after socket error failed:', error)
      })
    })
  })

}

export function startWsServer(): Promise<void> {
  if (!_g.__rvbBattleAuthorityShutdownInstalled) {
    installBattleAuthorityShutdownHandlers({ quiesce: quiesceWsServer })
    _g.__rvbBattleAuthorityShutdownInstalled = true
  }
  const previous = _g.__rvbWsLifecycle ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => restartWsServer())
  _g.__rvbWsLifecycle = current
  return current
}

// ── PVE: run the bot's entire turn server-side ───────────────────────────────
const BOT_MAX_DECISION_STEPS = 64

export function isBotInputReady(state: PublicBattleSnapshot['state']): boolean {
  return !state.terminalResult
    && getCurrentInputOwnerPlayerId(state).trim().toLowerCase() === 'bot'
}

export function queueBotTurnIfReady(
  roomId: string,
  state: PublicBattleSnapshot['state'],
  delayMs = 800,
): boolean {
  const normalizedRoomId = roomId.trim().toLowerCase()
  if (!normalizedRoomId || !isBotInputReady(state)) return false
  if (botTurnTimers.has(normalizedRoomId) || botTurnsRunning.has(normalizedRoomId)) return false

  const timer = setTimeout(() => {
    botTurnTimers.delete(normalizedRoomId)
    void runBotTurn(normalizedRoomId)
  }, Math.max(0, delayMs))
  botTurnTimers.set(normalizedRoomId, timer)
  return true
}

async function runBotTurn(roomId: string): Promise<void> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  if (!normalizedRoomId || botTurnsRunning.has(normalizedRoomId)) return

  const scheduled = botTurnTimers.get(normalizedRoomId)
  if (scheduled) {
    clearTimeout(scheduled)
    botTurnTimers.delete(normalizedRoomId)
  }
  botTurnsRunning.add(normalizedRoomId)

  let actionBatch: BattleAction[] | undefined
  let actionBatchTurnKey: string | undefined
  let decisionStep = 0

  try {
    const { planBotActions, prepareLegalBotAction } = await import('./game/ai')

    for (; decisionStep < BOT_MAX_DECISION_STEPS; decisionStep += 1) {
      const latestRoom = await roomStore.getRoom(normalizedRoomId)
      const latestStorage = latestRoom && getBattleStorage(latestRoom)
      const storedState = latestStorage?.state as BattleState | undefined
      if (!latestRoom || !latestStorage || !storedState) break

      const latestState = withServerSkills(storedState) as BattleState
      if (!isBotInputReady(latestState)) break

      const hasPendingInput = !!(
        latestState.pendingOptionSelection
        || latestState.pendingTargetSelection
      )
      const actionTurnKey = latestState.turn.currentPlayerId.trim().toLowerCase()
        + ':'
        + String(latestState.turn.turnNumber)
      const usesActionBatch = latestState.turn.phase === 'action' && !hasPendingInput
      let draft: BattleAction | undefined

      if (usesActionBatch) {
        if (actionBatchTurnKey !== actionTurnKey) {
          const plan = planBotActions(latestState, 'bot')
          if (!plan || plan.kind !== 'action' || plan.actions.length === 0) {
            console.warn('[WS] bot action phase has no deterministic plan', {
              roomId: normalizedRoomId,
              turn: latestState.turn.turnNumber,
            })
            break
          }
          actionBatch = [...plan.actions]
          actionBatchTurnKey = actionTurnKey
        }
        draft = actionBatch?.shift()
        if (!draft) {
          console.warn('[WS] bot action batch ended before the authority phase advanced', {
            roomId: normalizedRoomId,
            turn: latestState.turn.turnNumber,
          })
          break
        }
      } else {
        const plan = planBotActions(latestState, 'bot')
        if (!plan || plan.kind !== 'structural' || plan.actions.length !== 1) {
          console.warn('[WS] bot structural input has no deterministic action', {
            roomId: normalizedRoomId,
            phase: latestState.deployment?.status ?? latestState.turn.phase,
            turn: latestState.turn.turnNumber,
          })
          break
        }
        draft = plan.actions[0]
      }

      const currentAction = prepareLegalBotAction(latestState, draft, 'bot')
      if (!currentAction) {
        console.warn('[WS] skipped stale bot plan action', {
          roomId: normalizedRoomId,
          actionType: draft.type,
          phase: latestState.deployment?.status ?? latestState.turn.phase,
          turn: latestState.turn.turnNumber,
        })
        if (usesActionBatch) continue
        break
      }

      const result = await dispatchBotAuthorityCommand(
        normalizedRoomId,
        roomBattleAuthorityVersion(latestRoom),
        currentAction,
        decisionStep,
      )
      if (!result) break
      if (result.kind === 'resyncRequired') {
        if (usesActionBatch) actionBatch?.unshift(draft)
        continue
      }
      if (result.actionResult.state.terminalResult) break
    }

    if (decisionStep >= BOT_MAX_DECISION_STEPS) {
      console.warn('[WS] bot decision step guard reached', {
        roomId: normalizedRoomId,
        maxSteps: BOT_MAX_DECISION_STEPS,
      })
    }
  } catch (error) {
    console.warn('[WS] runBotTurn error:', error)
  } finally {
    botTurnsRunning.delete(normalizedRoomId)
    try {
      await scheduleRoomBattleTimeout(roomStore, normalizedRoomId, {
        onCommitted: () => broadcastBattleSnapshot(normalizedRoomId),
        onTransitionCommitted: result => broadcastBattleTransition(normalizedRoomId, result),
        onBotTurnReady: (_snapshot, authorityState) => {
          void queueBotTurnIfReady(normalizedRoomId, authorityState)
        },
      })
    } catch (error) {
      console.warn('[WS] bot turn timer scheduling failed:', {
        roomId: normalizedRoomId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

async function dispatchBotAuthorityCommand(
  roomId: string,
  expectedAuthorityVersion: number,
  action: BattleAction,
  ordinal: number,
): Promise<DispatchRoomBattleActionResult | undefined> {
  const command = {
    ...action,
    clientActionId: `system-bot:${roomId}:${expectedAuthorityVersion}:${ordinal}:${action.type}`,
  } as BattleAction
  const result = await dispatchRoomBattleAction(roomStore, roomId, 'bot', command, {
    expectedAuthorityVersion,
  })
  if (result.transition) broadcastBattleTransition(roomId, result)
  else if (result.kind !== 'resyncRequired') {
    await broadcastBattleSnapshot(roomId, {
      snapshot: result.snapshot,
      state: result.actionResult.state,
    })
  }
  return result
}

export function broadcastToRoom(roomId: string, data: unknown): void {
  const clients = roomClients.get(roomId.toLowerCase())
  if (!clients || clients.size === 0) return
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg) } catch {}
    }
  }
}
