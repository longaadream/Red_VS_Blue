import { WebSocketServer, WebSocket } from 'ws'
import { assignNextSeat, getPlayerSeat, normalizePlayerAlignment, roomStore } from './game/room-store'
import { applyBattleAction } from './game/turn'
import { getBattleStorage, withServerSkills, withoutServerSkills } from './game/battle-storage'
import { hashStable, runBattleAction } from './game/battle-runner'
import { verifyJoinAuth, verifyRecordSignature, derivePlayerId } from './game/identity-verify'
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
  __rvbRoomClients?: Map<string, Set<WebSocket>>
  __rvbPlayerWs?: Map<string, WebSocket>
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
    return { ...room, packMismatch: checkPackMismatchWs(room.players) }
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
  return { ...room, packMismatch: checkPackMismatchWs(room.players) }
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
      await startBattleFromLockedRosters(roomStore, roomId)
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
    return room
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
    const requestedFirstPlayerId = String(body.firstPlayerId || '').trim().toLowerCase()
    await startBattleFromLockedRosters(roomStore, roomId, { firstPlayerId: requestedFirstPlayerId || undefined })
    await broadcastRoom(roomId)
    const clients = roomClients.get(roomId)
    if (clients) for (const client of clients) await sendBattleSnapshot(client, roomId)
    return await roomStore.getRoom(roomId)
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
    await startBattleFromLockedRosters(roomStore, roomId)
    room = await roomStore.getRoom(roomId)
  }
  return room
}

async function sendBattleSnapshot(ws: WebSocket, roomId: string): Promise<void> {
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
    sendJson(ws, { type: 'stateUpdate', state: storage.state, seed: storage.seed, stateHash: hashStable(storage.state) })
    return
  }
  sendJson(ws, { type: 'battleUnavailable', reason: 'battle-not-started', room: publicRoom(room) })
}

export function startWsServer(): void {
  if (_wss) {
    // Module reloaded (HMR) but server is still bound — close it so new code's
    // handlers replace the stale ones.
    try { _wss.close() } catch {}
    _wss = null
    _g.__rvbWss = null
    roomClients.clear()
    playerWs.clear()
  }
  if (process.env.DISABLE_WS === '1') {
    console.log('[WS] WebSocket server disabled (DISABLE_WS=1)')
    return
  }
  const port = getWsPort()

  _wss = new WebSocketServer({ port })
  _g.__rvbWss = _wss

  _wss.on('error', (err: Error) => {
    console.error(`[WS] Failed to start on port ${port}:`, err.message)
    _wss = null
    _g.__rvbWss = null
  })

  _wss.on('connection', (ws: WebSocket) => {
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
                result = room
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
          playerId = typeof msg.playerId === 'string' ? msg.playerId : null

          if (!roomClients.has(nextRoomId)) roomClients.set(nextRoomId, new Set())
          roomClients.get(nextRoomId)!.add(ws)
          if (playerId) playerWs.set(playerId, ws)

          // LAN mode: server is the game engine; all WS clients are guests.
          sendJson(ws, { type: 'subscribed', roomId: nextRoomId, role: 'guest' })

          ;(async () => {
            try {
              const room = await roomStore.getRoom(nextRoomId)
              if (room) sendJson(ws, { type: 'roomUpdate', room: publicRoom(room) })
              await sendBattleSnapshot(ws, nextRoomId)
            } catch {}
          })()
        } else if (msg.type === 'roomState' && roomId) {
          ;(async () => {
            const room = await roomStore.getRoom(roomId!)
            if (room) sendJson(ws, { type: 'roomUpdate', room: publicRoom(room) })
            await sendBattleSnapshot(ws, roomId!)
          })()
        } else if (msg.type === 'requestBattleSnapshot' && roomId) {
          ;(async () => { await sendBattleSnapshot(ws, roomId!) })()
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
              const room = await roomStore.getRoom(_roomId)
              if (!room) return
              const storage = getBattleStorage(room)
              if (!storage) {
                console.warn('[WS] no battle storage for room', _roomId, 'msg.type=', msg.type)
                return
              }

              if (msg.type === 'action') {
                if (msg.action == null) return
                try {
                  const result = runBattleAction(storage.state as any, msg.action as any)
                  storage.state = result.state
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ;(room as any).battleState = storage
                  await roomStore.setRoom(_roomId, room)
                  broadcastToRoom(_roomId, { type: 'stateUpdate', state: storage.state, seed: storage.seed, stateHash: result.stateHash, duplicate: result.duplicate })
                  // PVE: if it's now the bot's action phase, run AI after a short delay
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const st = storage.state as any
                  const hasBotPlayer = (room.players as any[]).some(p => p.isBot === true || p.id === 'bot')
                  if (hasBotPlayer && st?.turn?.phase === 'action' && st?.turn?.currentPlayerId === 'bot') {
                    setTimeout(() => { runBotTurn(_roomId).catch(() => {}) }, 800)
                  }
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
                  if (sender.readyState === WebSocket.OPEN) {
                    sender.send(JSON.stringify({
                      type: 'actionError',
                      error: message,
                      action: msg.action,
                      needsTargetSelection: errAny?.needsTargetSelection || undefined,
                      targetType: errAny?.targetType ?? undefined,
                      range: errAny?.range ?? undefined,
                      filter: errAny?.filter ?? undefined,
                      targetIndex: errAny?.targetIndex ?? undefined,
                      needsOptionSelection: errAny?.needsOptionSelection || undefined,
                      title: errAny?.title ?? undefined,
                      options: errAny?.options ?? undefined,
                    }))
                  }
                }
                return
              }

              if (msg.type === 'gameOver') {
                if (!room.gameRecord) {
                  room.status = 'finished'
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  room.gameRecord = {
                    gameId: _roomId + '-' + Date.now(),
                    timestamp: Date.now(),
                    roomId: _roomId,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    players: (room.players as any[]).map(p => ({ id: p.id, name: p.name, publicKey: p.publicKey })),
                    winner: msg.winner ?? null,
                    signatures: {},
                  }
                  await roomStore.setRoom(_roomId, room)
                }
                broadcastToRoom(_roomId, { type: 'gameOver', winner: msg.winner })
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

  console.log(`[WS] WebSocket server listening on port ${port}`)
}

// ── PVE: run the bot's entire turn server-side ───────────────────────────────
async function runBotTurn(roomId: string): Promise<void> {
  try {
    const room = await roomStore.getRoom(roomId)
    if (!room) return
    const storage = getBattleStorage(room)
    if (!storage) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = storage.state as any
    if (st?.turn?.phase !== 'action' || st?.turn?.currentPlayerId !== 'bot') return

    const { generateBotActions } = await import('./game/ai')
    const hydratedState = withServerSkills(storage.state)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let currentState: any = hydratedState

    const actions = generateBotActions(currentState as any, 'bot')
    for (const action of actions) {
      try {
        currentState = applyBattleAction(currentState, action)
      } catch {
        // Skip invalid bot action
      }
    }

    // After bot endTurn (phase="end"), advance to next player's action phase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((currentState as any)?.turn?.phase === 'end') {
      try { currentState = applyBattleAction(currentState, { type: 'beginPhase' } as any) } catch {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((currentState as any)?.turn?.phase === 'start') {
        try { currentState = applyBattleAction(currentState, { type: 'beginPhase' } as any) } catch {}
      }
    }

    storage.state = withoutServerSkills(currentState)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(room as any).battleState = storage
    await roomStore.setRoom(roomId, room)
    broadcastToRoom(roomId, { type: 'stateUpdate', state: storage.state, seed: storage.seed, stateHash: hashStable(storage.state) })
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

export function getWsPort(): number {
  return parseInt(process.env.WS_PORT || '3001', 10)
}
