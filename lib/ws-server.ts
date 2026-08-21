import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { assignNextSeat, getPlayerSeat, normalizePlayerAlignment, roomStore } from './game/room-store'
import { getBattleStorage, withServerSkills } from './game/battle-storage'
import { runBattleAction } from './game/battle-runner'
import {
  createPublicBattleSnapshot,
  createPublicRoomSnapshot,
  dispatchRoomBattleAction,
  getRoomBattleAuthorityNow,
  runWithRoomBattleAuthorityPaused,
  scheduleRoomBattleTimeout,
  type PublicBattleSnapshot,
} from './game/room-battle-actions'
import {
  BattleActionAuthError,
  derivePlayerId,
  verifyBattleActionAuth,
  verifyJoinAuth,
  verifyRecordSignature,
} from './game/identity-verify'
import { getClientTerminalSubmissionError } from './server/battle-terminal'
import { isBattleStateConflict, persistAuthoritativeBattleState } from './server/battle-command'
import {
  ensureRosterAlignmentMutable,
  getDemoRosterReadiness,
  getRosterErrorPayload,
  lockDefaultBotRosterInStore,
  lockDemoRosterInStore,
} from './game/roster-contract'
import { DEMO_FIXED_MAP_ID, startBattleFromLockedRosters } from './game/room-battle-start'

// HMR-safe: keep server + client maps on globalThis so Next.js hot reloads
// can tear down the old WebSocketServer (which holds stale handler closures)
// and start a new one without requiring a full dev-server restart.
const _g = globalThis as unknown as {
  __rvbWss?: WebSocketServer | null
  __rvbWsLifecycle?: Promise<void>
  __rvbRoomClients?: Map<string, Set<WebSocket>>
  __rvbPlayerWs?: Map<string, WebSocket>
  __rvbWsUpgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
}

const roomClients = (_g.__rvbRoomClients ??= new Map<string, Set<WebSocket>>())
const playerWs = (_g.__rvbPlayerWs ??= new Map<string, WebSocket>())
let _wss: WebSocketServer | null = _g.__rvbWss ?? null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function publicRoom(room: any): unknown {
  if (!room) return null
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    hostId: room.hostId,
    mapId: room.mapId,
    maxPlayers: room.maxPlayers || 2,
    authorityVersion: room.version ?? 0,
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
    id: room.id,
    name: room.name,
    status: room.status,
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
  broadcastToRoom('__lobby', { type: 'lobbyUpdate', rooms: rooms.map(publicRoomList) })
}

function broadcastBattleSnapshot(roomId: string, snapshot: PublicBattleSnapshot): void {
  broadcastToRoom(roomId, { type: 'stateUpdate', ...snapshot })
}

function startBattleWithDeploymentBroadcast(roomId: string) {
  return startBattleFromLockedRosters(roomStore, roomId, {
    onDeploymentUpdate: snapshot => broadcastBattleSnapshot(roomId, snapshot),
  })
}

function sendActionError(ws: WebSocket, payload: Record<string, unknown>): void {
  sendJson(ws, {
    type: 'actionError',
    ...payload,
  })
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

function checkPackMismatchWs(players: any[]): boolean {
  const hashes = players.map((p: any) => p.packMd5).filter(Boolean)
  return hashes.length === 2 && hashes[0] !== hashes[1]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function joinRoomViaWs(roomId: string, body: any): Promise<any> {
  let room = await roomStore.getRoom(roomId)
  if (!room) room = await roomStore.createRoom(roomId, `Room ${roomId}`)

  const normalizedPlayerId = String(body.playerId || '').trim().toLowerCase()
  const accountId = String(body.accountId || body.identityId || '').trim().toLowerCase() || undefined
  const playerName = String(body.playerName || '').trim()
  const packMd5 = String(body.packMd5 || '').trim() || undefined
  if (!normalizedPlayerId) throw new Error('playerId is required')

  if (body.payload || body.signature || body.publicKey) {
    const authErr = await verifyJoinAuth(body as Record<string, unknown>)
    if (authErr) throw new Error(authErr)
  }

  const requestedAlignment = normalizePlayerAlignment(body.alignment)

  let player = room.players.find(p => p.id.toLowerCase() === normalizedPlayerId)
  if (player) {
    if (accountId) player.accountId = accountId
    if (playerName) player.name = playerName
    if (!getPlayerSeat(player)) {
      const seat = nextFaction(room, normalizedPlayerId)
      player.seat = seat
      player.faction = seat
    }
    ensureRosterAlignmentMutable(player, requestedAlignment)
    if (requestedAlignment) player.alignment = requestedAlignment
    if (packMd5) player.packMd5 = packMd5
    await roomStore.setRoom(roomId, room)
    await broadcastRoom(roomId)
    return { ...createPublicRoomSnapshot(room), packMismatch: checkPackMismatchWs(room.players) }
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
    packMd5,
  }
  player.faction = player.seat
  room.players.push(player)
  if (!room.hostId) room.hostId = normalizedPlayerId
  await roomStore.setRoom(roomId, room)
  await broadcastRoom(roomId)
  return { ...createPublicRoomSnapshot(room), packMismatch: checkPackMismatchWs(room.players) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyRoomAction(roomId: string, body: any): Promise<any> {
  const action = body.action
  if (action === 'join') return joinRoomViaWs(roomId, body)

  let room = await roomStore.getRoom(roomId)
  if (!room) {
    if (action === 'claim-faction') room = await roomStore.createRoom(roomId, `Room ${roomId}`)
    else throw new Error('Room not found')
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
    if (finalRoom?.status === 'in-progress') {
      const clients = roomClients.get(roomId)
      if (clients) for (const client of clients) await sendBattleSnapshot(client, roomId)
    }
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
    if (room.players.length >= (room.maxPlayers ?? 2)) throw new Error('Room is full')
    player = {
      id: normalizedPlayerId,
      accountId,
      name: playerName || `Player ${normalizedPlayerId.slice(0, 8)}`,
      joinedAt: Date.now(),
      seat: nextFaction(room, normalizedPlayerId),
    }
    player.faction = player.seat
    room.players.push(player)
    if (!room.hostId) room.hostId = normalizedPlayerId
  }
  if (!player) throw new Error('Player not in room')
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
    const clients = roomClients.get(roomId)
    if (clients) for (const client of clients) await sendBattleSnapshot(client, roomId)
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

async function sendBattleSnapshot(ws: WebSocket, roomId: string, viewerPlayerId?: string | null): Promise<void> {
  const room = await ensureBattleReady(roomId)
  if (!room) {
    sendJson(ws, { type: 'battleUnavailable', reason: 'room-not-found', roomId })
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
    })
    return
  }
  const storage = getBattleStorage(room)
  if (storage) {
    sendJson(ws, { type: 'stateUpdate', ...createPublicBattleSnapshot(room, viewerPlayerId ?? undefined) })
    return
  }
  sendJson(ws, { type: 'battleUnavailable', reason: 'battle-not-started', room: publicRoom(room) })
}

async function restartWsServer(): Promise<void> {
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

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'rpc' && typeof msg.requestId === 'string') {
          const requestId = msg.requestId
          const method = String(msg.method || '')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = (msg.data || {}) as any
          ;(async () => {
            try {
              let result: unknown
              if (method === 'rooms.list' || method === 'lobby.list') {
                const rooms = await roomStore.getAllRooms()
                result = { rooms: rooms.map(publicRoomList) }
              } else if (method === 'rooms.create' || method === 'lobby.create') {
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
                  mapId: DEMO_FIXED_MAP_ID,
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
                result = createPublicRoomSnapshot(room)
              } else if (method === 'rooms.delete') {
                const targetRoomId = String(data.roomId || '').trim().toLowerCase()
                const player = String(data.playerId || '').trim().toLowerCase()
                const room = await roomStore.getRoom(targetRoomId)
                if (!room) throw new Error('Room not found')
                if (room.status === 'in-progress') throw new Error('Cannot delete room while game is in progress')
                if (room.hostId && room.hostId.toLowerCase() !== player) throw new Error('Unauthorized - only host can delete room')
                await roomStore.removeRoom(targetRoomId)
                await broadcastLobby()
                result = { success: true, deletedBy: 'host' }
              } else if (method === 'rooms.action') {
                const targetRoomId = String(data.roomId || roomId || '').trim().toLowerCase()
                if (!targetRoomId) throw new Error('roomId is required')
                result = await applyRoomAction(targetRoomId, data)
              } else if (method === 'rooms.spectate') {
                const targetRoomId = String(data.roomId || '').trim().toLowerCase()
                const spectatorId = String(data.spectatorId || '').trim().toLowerCase()
                const spectatorName = String(data.spectatorName || spectatorId.slice(0, 8)).trim()
                if (!targetRoomId || !spectatorId) throw new Error('roomId and spectatorId are required')
                const room = await roomStore.getRoom(targetRoomId)
                if (!room) throw new Error('Room not found')
                if (room.status !== 'in-progress') throw new Error('只有正在进行中的房间才能观战')
                if (room.players.some(p => p.id === spectatorId)) throw new Error('你已经是该房间的参战玩家')
                await roomStore.addSpectator(targetRoomId, { id: spectatorId, name: spectatorName, joinedAt: Date.now() })
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
              sendJson(ws, { type: 'rpcResult', requestId, ok: true, data: result })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const rosterError = getRosterErrorPayload(err)
              sendJson(ws, {
                type: 'rpcResult',
                requestId,
                ok: false,
                error: rosterError?.message ?? message,
                code: rosterError?.code,
                context: rosterError?.context,
              })
            }
          })()
        } else if (msg.type === 'subscribe' && typeof msg.roomId === 'string') {
          if (roomId) {
            roomClients.get(roomId)?.delete(ws)
            if (playerId) playerWs.delete(playerId)
          }
          const nextRoomId = msg.roomId.toLowerCase()
          roomId = nextRoomId
          playerId = typeof msg.playerId === 'string' ? msg.playerId.trim().toLowerCase() : null

          if (!roomClients.has(nextRoomId)) roomClients.set(nextRoomId, new Set())
          roomClients.get(nextRoomId)!.add(ws)
          if (playerId) playerWs.set(playerId, ws)

          // LAN mode: server is the game engine; all WS clients are guests.
          sendJson(ws, { type: 'subscribed', roomId: nextRoomId, role: 'guest' })

          ;(async () => {
            try {
              const room = await roomStore.getRoom(nextRoomId)
              if (room) sendJson(ws, { type: 'roomUpdate', room: publicRoom(room) })
              await sendBattleSnapshot(ws, nextRoomId, playerId)
            } catch {}
          })()
        } else if (msg.type === 'roomState' && roomId) {
          ;(async () => {
            const room = await roomStore.getRoom(roomId!)
            if (room) sendJson(ws, { type: 'roomUpdate', room: publicRoom(room) })
            await sendBattleSnapshot(ws, roomId!, playerId)
          })()
        } else if (msg.type === 'requestBattleSnapshot' && roomId) {
          ;(async () => { await sendBattleSnapshot(ws, roomId!, playerId) })()
        } else if (msg.type === 'roomAction' && roomId) {
          const _roomId = roomId
          const sender = ws
          ;(async () => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const body = msg as any
              const action = body.action
              const result = await applyRoomAction(_roomId, { ...body, playerId: body.playerId || playerId })
              sendJson(sender, { type: 'roomActionResult', action, success: true, ...(typeof result === 'object' && result ? result : { result }) })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const rosterError = getRosterErrorPayload(err)
              sendJson(sender, {
                type: 'roomActionResult',
                action: msg.action,
                success: false,
                error: rosterError?.message ?? message,
                code: rosterError?.code,
                context: rosterError?.context,
              })
            }
          })()
        } else if (msg.type === 'ping') {
          sendJson(ws, { type: 'pong' })
        } else if ((msg.type === 'action' || msg.type === 'gameOver') && roomId) {
          const _roomId = roomId
          const sender = ws
          ;(async () => {
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
                if (msg.action == null) return
                try {
                  const verified = await verifyBattleActionAuth(msg.auth, {
                    roomId: _roomId,
                    action: msg.action,
                  })
                  if (!playerId || playerId !== verified.playerId) {
                    throw new BattleActionAuthError(
                      'BATTLE_AUTH_INVALID',
                      'Signed battle player does not match the subscribed connection identity',
                    )
                  }
                  const result = await dispatchRoomBattleAction(
                    roomStore,
                    _roomId,
                    verified.playerId,
                    msg.action as any,
                    {
                      onCommittedBeforeTimerResume: snapshot => {
                        broadcastBattleSnapshot(_roomId, snapshot)
                      },
                    },
                  )
                  const stateUpdate = {
                    type: 'stateUpdate',
                    ...result.snapshot,
                    duplicate: result.kind === 'duplicate',
                  }
                  if (result.kind === 'duplicate') sendJson(sender, stateUpdate)
                  else if (!result.finalSnapshotAlreadyDelivered) {
                    broadcastToRoom(_roomId, stateUpdate)
                  }
                  await scheduleRoomBattleTimeout(roomStore, _roomId, {
                    onCommitted: snapshot => broadcastBattleSnapshot(_roomId, snapshot),
                    onBotTurnReady: snapshot => {
                      queueBotTurnIfReady(_roomId, snapshot.state)
                    },
                  })
                  if (result.kind === 'expired') {
                    const turnExpired = result.expiredReason === 'turn'
                    sendActionError(sender, {
                      error: turnExpired
                        ? 'Turn deadline elapsed; the authoritative timeout was committed instead.'
                        : 'Deployment deadline elapsed; the authoritative timeout was committed instead.',
                      code: turnExpired ? 'TURN_EXPIRED' : 'DEPLOYMENT_EXPIRED',
                      action: msg.action,
                      ...result.snapshot,
                    })
                    return
                  }
                  queueBotTurnIfReady(_roomId, result.actionResult.state)
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const errAny = err as any
                  console.warn(
                    '[WS] action failed:', _roomId, msg.action?.type,
                    errAny?.needsTargetSelection ? 'needsTargetSelection'
                      : errAny?.needsOptionSelection ? 'needsOptionSelection'
                      : message
                  )
                  sendActionError(sender, {
                    error: message,
                    code: errAny?.code ?? undefined,
                    action: msg.action,
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
                    context: errAny?.context ?? undefined,
                  })
                }
                return
              }
            } catch (e) {
              console.warn('[WS] handler error:', _roomId, e)
            }
          })()
        }
      } catch {}
    })

    ws.on('close', () => {
      if (roomId) roomClients.get(roomId)?.delete(ws)
      if (playerId) playerWs.delete(playerId)
    })
    ws.on('error', () => {
      if (roomId) roomClients.get(roomId)?.delete(ws)
      if (playerId) playerWs.delete(playerId)
    })
  })

}

export function startWsServer(): Promise<void> {
  const previous = _g.__rvbWsLifecycle ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => restartWsServer())
  _g.__rvbWsLifecycle = current
  return current
}

// ── PVE: run the bot's entire turn server-side ───────────────────────────────
export function queueBotTurnIfReady(
  roomId: string,
  state: PublicBattleSnapshot['state'],
  delayMs = 800,
): boolean {
  if (
    state.terminalResult
    || state.turn.phase !== 'action'
    || state.turn.currentPlayerId !== 'bot'
  ) {
    return false
  }
  setTimeout(() => {
    runBotTurn(roomId).catch(() => {})
  }, delayMs)
  return true
}

async function runBotTurn(roomId: string): Promise<void> {
  return runWithRoomBattleAuthorityPaused(roomId, () => runBotTurnWhilePaused(roomId))
}

async function runBotTurnWhilePaused(roomId: string): Promise<void> {
  try {
    const room = await roomStore.getRoom(roomId)
    if (!room) return
    const storage = getBattleStorage(room)
    if (!storage) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = storage.state as any
    if (st?.turn?.phase !== 'action' || st?.turn?.currentPlayerId !== 'bot') return

    const { generateBotActions, prepareBotAction } = await import('./game/ai')
    const hydratedState = withServerSkills(storage.state)
    const receivedAt = getRoomBattleAuthorityNow(roomId)
    let currentState: any = storage.state

    const actions = generateBotActions(hydratedState as any, 'bot')
    for (const action of actions) {
      try {
        const currentAction = action.type === 'useBasicSkill' || action.type === 'useChargeSkill'
          ? prepareBotAction(currentState, {
              type: action.type,
              playerId: action.playerId,
              pieceId: action.pieceId,
              skillId: action.skillId,
            }, 'bot')
          : action
        if (currentAction) currentState = runBattleAction(currentState, currentAction as any, { rootSeed: storage.seed }).state
      } catch {
        // Skip invalid bot action
      }
    }

    // After bot endTurn (phase="end"), advance to next player's action phase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((currentState as any)?.turn?.phase === 'end') {
      try { currentState = runBattleAction(currentState, { type: 'beginPhase' } as any, { rootSeed: storage.seed }).state } catch {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((currentState as any)?.turn?.phase === 'start') {
        try { currentState = runBattleAction(currentState, { type: 'beginPhase' } as any, { rootSeed: storage.seed }).state } catch {}
      }
    }
    if (
      !currentState?.terminalResult
      && (
        currentState?.turn?.turnNumber !== st?.turn?.turnNumber
        || currentState?.turn?.currentPlayerId !== st?.turn?.currentPlayerId
        || currentState?.turn?.phase !== st?.turn?.phase
      )
    ) {
      const now = getRoomBattleAuthorityNow(roomId)
      currentState = runBattleAction(currentState, {
        type: 'turnTimerSync',
        receivedAt,
        now,
        actorPlayerId: 'bot',
        acceptedActionType: 'endTurn',
        clientActionId: `system-bot-turn-timer-sync:${roomId}:${currentState.turn.turnNumber}`,
      }, { rootSeed: storage.seed }).state
    }

    storage.state = currentState
    try {
      const committedRoom = await persistAuthoritativeBattleState({ roomId, room, storage })
      broadcastBattleSnapshot(roomId, createPublicBattleSnapshot(committedRoom))
      await scheduleRoomBattleTimeout(roomStore, roomId, {
        onCommitted: snapshot => broadcastBattleSnapshot(roomId, snapshot),
        onBotTurnReady: snapshot => {
          queueBotTurnIfReady(roomId, snapshot.state)
        },
      })
    } catch (error) {
      // A player command won the room-version race; discard this stale bot turn.
      if (isBattleStateConflict(error)) return
      throw error
    }
  } catch (e) {
    console.warn('[WS] runBotTurn error:', e)
  }
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
