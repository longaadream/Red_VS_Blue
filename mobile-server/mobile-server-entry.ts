/**
 * mobile-server-entry.ts
 *
 * Compiled by scripts/build-mobile-server.js into android/.../assets/mobile-server.js.
 * Runs inside a hidden Android WebView (GameEngineWebView).
 *
 * Java calls:
 *   window.RvBMobileServer.processRequest(reqId, method, path, bodyJson, headersJson)
 *
 * JS calls back:
 *   window.AndroidServerBridge.sendResponse(reqId, responseJson)
 *   window.AndroidServerBridge.onReady()
 */

import { applyBattleAction } from '../lib/game/turn'
import { createInitialBattleForPlayers } from '../lib/game/battle-setup'
import { runBattleAction } from '../lib/game/battle-runner'
import { createRootSeed } from '../lib/game/rule-runtime'
import { loadAllSkillsById, loadRuleById } from '../lib/game/skills'
import { DEFAULT_PIECES, getAllPieces } from '../lib/game/piece-repository'
import type { BattleState } from '../lib/game/turn'
import type { PieceTemplate } from '../lib/game/piece'

// Rehydrate battle rules so that skill effect functions are available after serialization
function rehydrateBattleRules(state: BattleState): void {
  for (const piece of state.pieces) {
    if (!piece.rules || piece.rules.length === 0) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    piece.rules = piece.rules.map((rule: any) => {
      if (typeof rule.effect !== 'function' && rule.id) {
        const rehydrated = loadRuleById(rule.id)
        if (rehydrated && typeof rehydrated.effect === 'function') return rehydrated
        return { ...rule, effect: () => ({ success: false, message: '' }) }
      }
      return rule
    })
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Player {
  id: string
  name: string
  publicKey?: string
  faction?: 'red' | 'blue'
  packMd5?: string
  selectedPieces?: Array<{ templateId: string; faction: string }>
  hasSelectedPieces?: boolean
  ready?: boolean
  joinedAt?: number
}

interface GameRecord {
  gameId: string
  timestamp: number
  roomId: string
  players: Array<{ id: string; name: string; publicKey?: string }>
  winner: string | null
  signatures: Record<string, string> // playerId → hex signature
}

interface ActionLogEntry {
  seq: number
  type: 'init' | 'action' | 'gameOver'
  playerId?: string
  payload?: unknown
  action?: unknown
  winner?: string
  timestamp: number
}

interface ActionLog {
  type: 'action-log'
  seed: number
  actions: ActionLogEntry[]
}

interface Room {
  id: string
  name: string
  status: 'waiting' | 'ready' | 'in-progress' | 'finished'
  players: Player[]
  hostId?: string
  maxPlayers: number
  mapId: string
  battleState?: ActionLog
  currentTurnIndex: number
  actions: unknown[]
  createdAt: number
  version: number
  visibility: 'public' | 'private'
  inviteCode?: string
  gameRecord?: GameRecord
}

// ── In-memory state ──────────────────────────────────────────────────────────

const rooms = new Map<string, Room>()
let _trainingState: Record<string, unknown> | null = null

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

// ── Response helpers ─────────────────────────────────────────────────────────

function ok(data: Record<string, unknown>, status = 200): string {
  return JSON.stringify({ ...data, _status: status })
}

function err(msg: string, status = 400): string {
  return JSON.stringify({ error: msg, _status: status })
}

// ── Identity verification ─────────────────────────────────────────────────────

function _hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2)
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return b
}

function _bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function _verifyPlayerId(publicKeyHex: string, playerId: string): Promise<boolean> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', _hexToBytes(publicKeyHex))
    return _bytesToHex(new Uint8Array(hash)).slice(0, 8) === playerId
  } catch { return false }
}

async function _verifySignature(payload: unknown, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', _hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify'])
    const msg = new TextEncoder().encode(JSON.stringify(payload))
    return crypto.subtle.verify('Ed25519', key, _hexToBytes(signatureHex), msg)
  } catch { return false }
}

// Returns null if valid (or auth fields absent), error string if invalid.
async function verifyBattleAuth(room: Room, body: Record<string, unknown>): Promise<string | null> {
  const auth = body._auth as { playerId?: string; publicKey?: string; payload?: Record<string, unknown>; signature?: string } | undefined
  if (!auth || !auth.publicKey || !auth.payload || !auth.signature) return null // no auth → allow
  const { playerId, publicKey, payload, signature } = auth
  if (!playerId) return 'Missing playerId in auth'
  if (!room.players.find(p => p.id === playerId)) return 'Player not in room'
  if (!await _verifyPlayerId(publicKey!, playerId)) return 'Public key does not match player ID'
  const ts = payload!.timestamp as number
  if (!ts || Math.abs(Date.now() - ts) > 60000) return 'Request expired'
  if (!await _verifySignature(payload!, signature!, publicKey!)) return 'Invalid signature'
  return null
}

async function verifyJoinAuth(body: Record<string, unknown>): Promise<string | null> {
  const { publicKey, payload, signature } = body as {
    publicKey?: string; payload?: Record<string, unknown>; signature?: string
  }
  if (!publicKey || !payload || !signature) return null // no auth fields → allow (legacy)
  const playerId = payload.playerId as string
  if (!await _verifyPlayerId(publicKey, playerId)) return 'Public key does not match player ID'
  const ts = payload.timestamp as number
  if (!ts || Math.abs(Date.now() - ts) > 60000) return 'Request expired'
  if (!await _verifySignature(payload, signature, publicKey)) return 'Invalid signature'
  return null
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handlePing(): string {
  return ok({ name: 'RED vs BLUE Server', version: '1.0.0-mobile', ok: true })
}

function handleGetRooms(): string {
  const roomList = Array.from(rooms.values()).map(r => ({
    id: r.id,
    name: r.name,
    status: r.status,
    players: r.players.map(p => ({
      id: p.id,
      name: p.name,
      faction: p.faction,
      hasSelectedPieces: p.hasSelectedPieces || false,
    })),
    playerCount: r.players.length,
    playersCount: r.players.length,
    maxPlayers: r.maxPlayers,
    mapId: r.mapId,
    hostId: r.hostId,
    createdAt: r.createdAt,
    visibility: r.visibility,
    inviteCode: r.inviteCode,
  }))
  return ok({ rooms: roomList })
}

function handleCreateRoom(body: Record<string, unknown>): string {
  const playerId = (body.hostId as string) || (body.playerId as string) || 'anon-' + genId()
  const playerName = (body.playerName as string) || '玩家'
  const roomId = 'room-' + genId()
  const room: Room = {
    id: roomId,
    name: (body.name as string) || `${playerName}的房间`,
    status: 'waiting',
    players: [{ id: playerId, name: playerName, faction: Math.random() < 0.5 ? 'red' : 'blue', joinedAt: Date.now(), hasSelectedPieces: false, selectedPieces: [] }],
    hostId: playerId,
    maxPlayers: 2,
    mapId: (body.mapId as string) || 'large-battlefield',
    battleState: undefined,
    currentTurnIndex: 0,
    actions: [],
    createdAt: Date.now(),
    version: 0,
    visibility: ((body.visibility as string) || 'public') as 'public' | 'private',
  }
  rooms.set(roomId, room)
  return ok(room as unknown as Record<string, unknown>, 201)
}

function handleGetRoom(roomId: string): string {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  return ok(room as unknown as Record<string, unknown>)
}

function handleDeleteRoom(roomId: string, body: Record<string, unknown>): string {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  const playerId = ((body.playerId as string) || '').toLowerCase()
  if ((room.hostId || '').toLowerCase() !== playerId) return err('Only host can delete', 403)
  rooms.delete(roomId.toLowerCase())
  return ok({ success: true })
}

async function handleRoomPost(roomId: string, body: Record<string, unknown>): Promise<string> {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  const playerId = (body.playerId as string) || ''
  const playerName = (body.playerName as string) || '玩家'

  if (body.action === 'join') {
    const normalizedPlayerId = playerId.trim().toLowerCase()
    const authErr = await verifyJoinAuth(body)
    if (authErr) return err(authErr, 401)
    const packMd5 = (body.packMd5 as string) || undefined
    const requestedFaction = (body.faction === 'red' || body.faction === 'blue') ? body.faction as 'red' | 'blue' : null
    const existing = room.players.find(p => p.id.toLowerCase() === normalizedPlayerId)
    if (existing) {
      if (requestedFaction) {
        existing.faction = requestedFaction
      } else if (!existing.faction) {
        existing.faction = nextFaction(room)
      }
      if (playerName) existing.name = playerName
      if (packMd5) existing.packMd5 = packMd5
      room.version++
      _broadcastRoomUpdate(room)
      return ok({ ...room, packMismatch: mobileCheckPackMismatch(room.players) } as unknown as Record<string, unknown>)
    }
    if (room.players.length >= room.maxPlayers) return err('Room is full', 400)
    const publicKey = (body.publicKey as string) || undefined
    let faction: 'red' | 'blue'
    if (requestedFaction) {
      faction = requestedFaction
    } else {
      faction = nextFaction(room)
    }
    room.players.push({ id: normalizedPlayerId, name: playerName, publicKey, faction, packMd5, joinedAt: Date.now(), hasSelectedPieces: false, selectedPieces: [] })
    room.version++
    _broadcastRoomUpdate(room)
    return ok({ ...room, packMismatch: mobileCheckPackMismatch(room.players) } as unknown as Record<string, unknown>)
  }

  if (body.action === 'toggle-ready') {
    const player = room.players.find(p => p.id.toLowerCase() === playerId.toLowerCase())
    if (!player) return err('Player not in room', 404)
    player.ready = !player.ready
    const allReady = room.players.length >= 2 && room.players.every(p => p.ready)
    room.status = allReady ? 'ready' : 'waiting'
    room.version++
    _broadcastRoomUpdate(room)
    return ok({ ...room } as unknown as Record<string, unknown>)
  }

  if (body.action === 'start') {
    if (playerId !== room.hostId) return err('Only host can start', 403)
    if (room.players.length < 2) return err('Need 2 players to start', 400)
    if (room.status !== 'waiting' && room.status !== 'ready') return err('Room not in waiting state', 400)
    const notReady = room.players.filter(p => !p.hasSelectedPieces || !p.selectedPieces?.length)
    if (notReady.length) return err('All players must select pieces first', 400)
    return _startGame(room)
  }

  return err('Unknown action', 400)
}

// ── Shared game-start helper ──────────────────────────────────────────────────

async function _startGame(room: Room): Promise<string> {
  try {
    const allPieces = getAllPieces()
    const roomPlayers = room.players.slice(0, 2)
    const playerIds = roomPlayers.map(p => p.id) as [string, string]
    const playerSelectedPieces = roomPlayers.map(p => ({
      playerId: p.id,
      faction: p.faction as 'red' | 'blue' | undefined,
      pieces: (p.selectedPieces || [])
        .map(sp => allPieces.find(t => t.id === sp.templateId))
        .filter((t): t is PieceTemplate => !!t),
    }))

    const seed = createRootSeed()
    const state = await createInitialBattleForPlayers(
      playerIds,
      [],
      playerSelectedPieces,
      room.mapId,
      { rootSeed: seed },
    )
    if (!state) return err('Failed to create battle state', 500)

    if (!state.skillsById || !Object.keys(state.skillsById).length) {
      state.skillsById = loadAllSkillsById() as typeof state.skillsById
    }

    // Apply beginPhase through the deterministic authority runner.
    const initState = runBattleAction(
      state,
      { type: 'beginPhase' } as Parameters<typeof applyBattleAction>[1],
      { rootSeed: seed },
    ).state

    const { skillsById: _sk, ...initPayload } = initState as unknown as Record<string, unknown>
    void _sk
    room.battleState = {
      type: 'action-log',
      seed,
      actions: [{ seq: 0, type: 'init', payload: initPayload, timestamp: Date.now() }],
    }
    room.status = 'in-progress'
    room.version++
    _broadcastBattleSnapshot(room)
    return ok({ success: true })
  } catch (e: unknown) {
    return err('Battle setup failed: ' + (e as Error).message, 500)
  }
}

function getAssignedFactions(room: Room): Array<'red' | 'blue'> {
  return room.players.map(p => p.faction).filter(Boolean) as Array<'red' | 'blue'>
}

function nextFaction(_room: Room): 'red' | 'blue' {
  return Math.random() < 0.5 ? 'red' : 'blue'
}

function mobileCheckPackMismatch(players: Player[]): boolean {
  const hashes = players.map(p => p.packMd5).filter(Boolean)
  return hashes.length === 2 && hashes[0] !== hashes[1]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _getBridge(): any {
  return (typeof window !== 'undefined' && (window as any).AndroidServerBridge) || null
}

function _broadcastRoomUpdate(room: Room): void {
  const bridge = _getBridge()
  if (!bridge?.broadcastToRoom) return
  try { bridge.broadcastToRoom(room.id, JSON.stringify({ type: 'roomUpdate', room })) } catch {}
}

function _broadcastBattleSnapshot(room: Room): void {
  if (!room.battleState) return
  const bridge = _getBridge()
  if (!bridge?.broadcastToRoom) return
  try {
    bridge.broadcastToRoom(room.id, JSON.stringify({
      type: 'battleSnapshot',
      actions: room.battleState.actions,
      total: room.battleState.actions.length,
      seed: room.battleState.seed,
    }))
  } catch {}
}

function handleLeaveRoom(roomId: string, body: Record<string, unknown>): string {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return ok({ success: true })
  const playerId = ((body.playerId as string) || '').trim().toLowerCase()
  if (!playerId) return ok({ success: true })
  const idx = room.players.findIndex(p => p.id.toLowerCase() === playerId)
  if (idx >= 0) {
    room.players.splice(idx, 1)
    // 重置房间到等待状态，不销毁，保留在 0/max 状态供再次加入
    room.status = 'waiting'
    room.battleState = undefined
    room.gameRecord = undefined
    if (room.hostId?.toLowerCase() === playerId) {
      room.hostId = room.players.length > 0 ? room.players[0].id : undefined
    }
    room.version++
    _broadcastRoomUpdate(room)
  }
  return ok({ success: true })
}

function handleClaimFaction(roomId: string, body: Record<string, unknown>): string {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  const playerId = ((body.playerId as string) || '').trim().toLowerCase()
  const playerName = ((body.playerName as string) || '').trim()
  if (!playerId) return err('playerId is required', 400)

  const requestedFaction = (body.faction === 'red' || body.faction === 'blue')
    ? body.faction as 'red' | 'blue'
    : null

  let player = room.players.find(p => p.id.toLowerCase() === playerId)
  if (!player) {
    if (room.players.length >= room.maxPlayers) return err('Room is full', 400)
    let faction: 'red' | 'blue'
    if (requestedFaction) {
      faction = requestedFaction
    } else {
      faction = nextFaction(room)
    }
    player = {
      id: playerId,
      name: playerName || `Player ${playerId.slice(0, 8)}`,
      faction,
      joinedAt: Date.now(),
      hasSelectedPieces: false,
      selectedPieces: [],
    }
    room.players.push(player)
    room.version++
  } else if (requestedFaction && player.faction !== requestedFaction) {
    player.faction = requestedFaction
    room.version++
  } else if (!player.faction) {
    player.faction = nextFaction(room)
    room.version++
  }

  _broadcastRoomUpdate(room)
  return ok({ success: true, faction: player.faction })
}

async function handleSelectPieces(roomId: string, body: Record<string, unknown>): Promise<string> {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  const playerId = ((body.playerId as string) || '').trim().toLowerCase()
  const playerName = ((body.playerName as string) || '').trim()
  if (!playerId) return err('playerId is required', 400)

  let player = room.players.find(p => p.id.toLowerCase() === playerId)
  if (!player) {
    if (room.players.length >= room.maxPlayers) return err('Room is full', 400)
    player = {
      id: playerId,
      name: playerName || `Player ${playerId.slice(0, 8)}`,
      faction: nextFaction(room),
      joinedAt: Date.now(),
      hasSelectedPieces: false,
      selectedPieces: [],
    }
    room.players.push(player)
  }
  if (!player.faction) player.faction = nextFaction(room)

  const pieces = body.pieces as Array<{ templateId: string; faction: string }> | undefined
  if (!pieces || pieces.length === 0) return err('Please select at least 1 piece', 400)
  player.selectedPieces = pieces || []
  player.hasSelectedPieces = player.selectedPieces.length > 0
  room.version++

  const allPlayersSelected = room.players.length >= 2 &&
    room.players.slice(0, 2).every(p => p.hasSelectedPieces && p.selectedPieces && p.selectedPieces.length > 0)

  if (allPlayersSelected && room.status !== 'in-progress') {
    return _startGame(room)
  }

  return ok({
    success: true,
    message: 'Pieces selected successfully',
    player: {
      id: player.id,
      hasSelectedPieces: true,
      selectedPiecesCount: player.selectedPieces.length,
    },
    room: {
      id: room.id,
      status: room.status,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        faction: p.faction,
        hasSelectedPieces: p.hasSelectedPieces || false,
      })),
    },
  })
}

// GET /api/rooms/:id/battle?since=N — return action log entries
function handleGetBattle(roomId: string, since: number): string {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  const log = room.battleState
  if (!log || log.type !== 'action-log') return err('Battle not started', 400)
  const actions = log.actions.slice(since + 1)
  return ok({ actions, total: log.actions.length, seed: log.seed } as unknown as Record<string, unknown>)
}

// POST /api/rooms/:id/battle — pure relay: append action to log
async function handleBattleAction(roomId: string, body: Record<string, unknown>): Promise<string> {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  const log = room.battleState
  if (!log || log.type !== 'action-log') return err('Battle not started', 400)

  const authErr = await verifyBattleAuth(room, body)
  if (authErr) return err(authErr, 401)

  const { type = 'action', playerId, action, winner } = body as {
    type?: string; playerId?: string; action?: unknown; winner?: string
  }
  const seq = log.actions.length
  const entry: ActionLogEntry = {
    seq,
    type: type as ActionLogEntry['type'],
    playerId: playerId as string | undefined,
    timestamp: Date.now(),
  }
  if (action !== undefined) entry.action = action
  if (winner !== undefined) entry.winner = winner

  log.actions.push(entry)
  room.version++

  // Notify Android WS clients (no-op on non-Android platforms)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _bridge = (typeof window !== 'undefined' && (window as any).AndroidServerBridge) || null
  if (_bridge?.broadcastToRoom) {
    try { _bridge.broadcastToRoom(room.id, JSON.stringify({ type: 'actionLog', entry })) } catch {}
  }

  if (type === 'gameOver' && !room.gameRecord) {
    room.status = 'finished'
    room.gameRecord = {
      gameId: room.id + '-' + Date.now(),
      timestamp: Date.now(),
      roomId: room.id,
      players: room.players.map(p => ({ id: p.id, name: p.name, publicKey: p.publicKey })),
      winner: winner ?? null,
      signatures: {},
    }
  }

  return ok({ seq })
}

function handleGetGameRecord(roomId: string): string {
  const room = rooms.get(roomId.toLowerCase())
  if (!room) return err('Room not found', 404)
  if (!room.gameRecord) return err('Game not finished', 404)
  return ok(room.gameRecord as unknown as Record<string, unknown>)
}

async function handleSubmitSignature(roomId: string, body: Record<string, unknown>): Promise<string> {
  const room = rooms.get(roomId.toLowerCase())
  if (!room || !room.gameRecord) return err('Game record not found', 404)
  const { playerId, publicKey, signature } = body as { playerId: string; publicKey: string; signature: string }
  if (!playerId || !publicKey || !signature) return err('Missing fields', 400)
  if (!room.players.find(p => p.id === playerId)) return err('Player not in this game', 403)
  if (!await _verifyPlayerId(publicKey, playerId)) return err('Public key mismatch', 401)
  // Verify signature is over the game record (without signatures field)
  const recordToSign = { ...room.gameRecord, signatures: undefined }
  if (!await _verifySignature(recordToSign, signature, publicKey)) return err('Invalid signature', 401)
  room.gameRecord.signatures[playerId] = signature
  return ok({ success: true, signaturesCount: Object.keys(room.gameRecord.signatures).length })
}

function handleGetPieces(): string {
  const allPieces = getAllPieces()
  // If piece-repository didn't load (empty DEFAULT_PIECES), try the directly imported data
  if (!allPieces.length && Object.keys(DEFAULT_PIECES).length) {
    return ok({ pieces: Object.values(DEFAULT_PIECES) })
  }
  return ok({ pieces: allPieces })
}

function handleGetMaps(): string {
  // Return basic map list; full map JSON available via /api/maps/:id if needed
  return ok({ maps: [{ id: 'large-battlefield', name: '大战场' }, { id: 'large-trap-arena', name: '陷阱战场' }] })
}

// ── Training handler ─────────────────────────────────────────────────────────

async function handleTraining(method: string, body: Record<string, unknown>): Promise<string> {
  if (method === 'POST') {
    // Create initial training battle
    try {
      const mapId = (body.mapId as string) || 'large-battlefield'
      const allPieces = getAllPieces()
      if (!allPieces.length) return err('No pieces available', 500)
      // Use first half as red, second half as blue
      const half = Math.min(Math.floor(allPieces.length / 2), 3)
      const redPieces = allPieces.slice(0, half)
      const bluePieces = allPieces.slice(half, half * 2)
      const playerIds: [string, string] = ['training-red', 'training-blue']
      const playerSelectedPieces = [
        { playerId: 'training-red', pieces: redPieces },
        { playerId: 'training-blue', pieces: bluePieces },
      ]
      const state = await createInitialBattleForPlayers(playerIds, [...redPieces, ...bluePieces], playerSelectedPieces, mapId)
      if (!state) return err('Failed to create training battle', 500)
      if (!state.skillsById || !Object.keys(state.skillsById).length) {
        state.skillsById = loadAllSkillsById() as typeof state.skillsById
      }
      _trainingState = state as unknown as Record<string, unknown>
      return ok(_trainingState)
    } catch (e: unknown) {
      return err('Training init failed: ' + (e as Error).message, 500)
    }
  }

  if (method === 'PUT') {
    // Apply action to training state
    if (!_trainingState) return err('No active training session', 400)
    const { action, battleState } = body as { action: unknown; battleState: Record<string, unknown> | undefined }
    const state = (battleState || _trainingState) as unknown
    try {
      rehydrateBattleRules(state as BattleState)
      const newState = applyBattleAction(state as BattleState, action as Parameters<typeof applyBattleAction>[1])
      _trainingState = newState as unknown as Record<string, unknown>
      return ok(_trainingState)
    } catch (e: unknown) {
      const err2 = e as Record<string, unknown>
      if (err2.needsTargetSelection) {
        return JSON.stringify({ needsTargetSelection: true, range: err2.range, targetType: err2.targetType, filter: err2.filter, targetIndex: err2.targetIndex, _status: 400 })
      }
      if (err2.needsOptionSelection) {
        return JSON.stringify({ needsOptionSelection: true, options: err2.options, title: err2.title, _status: 400 })
      }
      return err((e as Error).message, 400)
    }
  }

  if (method === 'PATCH') {
    // Direct state modification
    const { battleState } = body as { battleState?: Record<string, unknown> }
    if (battleState) {
      _trainingState = battleState
      return ok(_trainingState)
    }
    return err('Missing battleState', 400)
  }

  return err('Method not allowed', 405)
}

// POST /api/relay-battle-init — create initial state for relay mode host
async function handleRelayBattleInit(body: Record<string, unknown>): Promise<string> {
  const players = body.players as Array<{
    id: string
    faction: 'red' | 'blue'
    pieces: Array<{ templateId: string }>
  }> | undefined

  if (!Array.isArray(players) || players.length < 2) {
    return err('players array with at least 2 entries required', 400)
  }

  const playerIds = players.map(p => p.id)

  const playerSelectedPieces = players.map(player => {
    const pieces = (player.pieces ?? [])
      .map(p => {
        const templates = getAllPieces()
        const tpl = templates.find(t => t.id === p.templateId)
        if (!tpl) return null
        return { ...tpl, faction: player.faction } as PieceTemplate
      })
      .filter((p): p is PieceTemplate => p !== null)
    return { playerId: player.id, pieces }
  })

  const allPieces = playerSelectedPieces.flatMap(p => p.pieces)

  try {
    const seed = createRootSeed()
    const state = await createInitialBattleForPlayers(
      playerIds,
      allPieces,
      playerSelectedPieces,
      (body.mapId as string | undefined),
      { rootSeed: seed },
    )
    if (!state) return err('Failed to create battle state', 500)
    return ok({ state, seed } as unknown as Record<string, unknown>)
  } catch (e) {
    return err('createInitialBattleForPlayers failed: ' + String(e), 500)
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

async function route(method: string, rawPath: string, body: Record<string, unknown>): Promise<string> {
  if (method === 'OPTIONS') return ok({})
  const p = rawPath.split('?')[0].replace(/\/$/, '') || '/'

  if (p === '/api/ping') return handlePing()
  if ((p === '/api/rooms' || p === '/api/lobby') && method === 'GET')  return handleGetRooms()
  if ((p === '/api/rooms' || p === '/api/lobby') && method === 'POST') return handleCreateRoom(body)

  let m: RegExpMatchArray | null

  m = p.match(/^\/api\/rooms\/([^/]+)$/)
  if (m) {
    const id = m[1]
    if (method === 'GET')    return handleGetRoom(id)
    if (method === 'POST')   return handleRoomPost(id, body)
    if (method === 'DELETE') return handleDeleteRoom(id, body)
  }

  m = p.match(/^\/api\/rooms\/([^/]+)\/pieces$/)
  if (m && method === 'POST') return handleSelectPieces(m[1], body)

  m = p.match(/^\/api\/rooms\/([^/]+)\/actions$/)
  if (m && method === 'POST') {
    const action = body.action as string | undefined
    if (action === 'join') return handleRoomPost(m[1], body)
    if (action === 'toggle-ready') return handleRoomPost(m[1], body)
    if (action === 'leave') return handleLeaveRoom(m[1], body)
    if (action === 'claim-faction') return handleClaimFaction(m[1], body)
    if (action === 'select-pieces') return handleSelectPieces(m[1], body)
    if (action === 'start-game') return handleRoomPost(m[1], { ...body, action: 'start' })
    return handleBattleAction(m[1], body)
  }

  m = p.match(/^\/api\/rooms\/([^/]+)\/battle$/)
  if (m) {
    if (method === 'GET') {
      const since = parseInt(new URLSearchParams(rawPath.split('?')[1] || '').get('since') ?? '-1')
      return handleGetBattle(m[1], since)
    }
    if (method === 'POST') return handleBattleAction(m[1], body)
  }

  m = p.match(/^\/api\/rooms\/([^/]+)\/game-record$/)
  if (m) {
    if (method === 'GET')  return handleGetGameRecord(m[1])
    if (method === 'POST') return handleSubmitSignature(m[1], body)
  }

  if (p === '/api/pieces' && method === 'GET') return handleGetPieces()
  if (p === '/api/maps'   && method === 'GET') return handleGetMaps()
  if (p === '/api/admin/resource-pack' && method === 'GET') return ok({ meta: null })

  if (p === '/api/training' && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    return handleTraining(method, body)
  }

  if (p === '/api/relay-battle-init' && method === 'POST') {
    return handleRelayBattleInit(body)
  }

  return err('Not found', 404)
}

// ── Global interface exposed to Java (via evaluateJavascript) ─────────────────

interface AndroidBridge {
  sendResponse(reqId: string, responseJson: string): void
  sendResponseChunk?(reqId: string, chunk: string): void
  sendResponseComplete?(reqId: string): void
  getRequestChunkCount?(reqId: string): number
  getRequestChunk?(reqId: string, index: number): string
  onReady(): void
}

declare global {
  // window may not exist (typeof window === 'undefined' defined at build time)
  // but the actual WebView global IS accessible via globalThis
  // eslint-disable-next-line no-var
  var AndroidServerBridge: AndroidBridge | undefined
  // eslint-disable-next-line no-var
  var RvBMobileServer: {
    processRequest(reqId: string, method: string, path: string, bodyJson: string, headersJson?: string): void
    processRequestFromBridge(reqId: string): void
    beginBridgeRequest(reqId: string): void
    appendBridgeRequestChunk(reqId: string, chunk: string): void
    finishBridgeRequest(reqId: string): void
  }
}

const pendingBridgeRequestChunks: Record<string, string[]> = {}

function sendBridgeResponse(reqId: string, responseJson: string): void {
  const bridge = globalThis.AndroidServerBridge
  if (!bridge) return
  if (bridge.sendResponseChunk && bridge.sendResponseComplete && responseJson.length > 32000) {
    const chunkSize = 48 * 1024
    for (let i = 0; i < responseJson.length; i += chunkSize) {
      bridge.sendResponseChunk(reqId, responseJson.slice(i, i + chunkSize))
    }
    bridge.sendResponseComplete(reqId)
    return
  }
  bridge.sendResponse(reqId, responseJson)
}

function readBridgeRequest(reqId: string): { method: string; path: string; bodyJson: string; headersJson?: string } | null {
  const bridge = globalThis.AndroidServerBridge
  if (!bridge?.getRequestChunkCount || !bridge.getRequestChunk) return null
  const count = bridge.getRequestChunkCount(reqId)
  let payload = ''
  for (let i = 0; i < count; i++) payload += bridge.getRequestChunk(reqId, i)
  try {
    return JSON.parse(payload) as { method: string; path: string; bodyJson: string; headersJson?: string }
  } catch {
    return null
  }
}

globalThis.RvBMobileServer = {
  processRequest(reqId, method, path, bodyJson) {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(bodyJson || '{}') as Record<string, unknown> } catch {}

    Promise.resolve(route(method, path, body))
      .then(responseJson => sendBridgeResponse(reqId, responseJson))
      .catch((e: unknown) => {
        const errJson = JSON.stringify({ error: String(e), _status: 500 })
        sendBridgeResponse(reqId, errJson)
      })
  },
  processRequestFromBridge(reqId) {
    const request = readBridgeRequest(reqId)
    if (!request) {
      sendBridgeResponse(reqId, JSON.stringify({ error: 'Invalid bridge request', _status: 400 }))
      return
    }
    this.processRequest(reqId, request.method, request.path, request.bodyJson, request.headersJson)
  },
  beginBridgeRequest(reqId) {
    pendingBridgeRequestChunks[reqId] = []
  },
  appendBridgeRequestChunk(reqId, chunk) {
    if (!pendingBridgeRequestChunks[reqId]) pendingBridgeRequestChunks[reqId] = []
    pendingBridgeRequestChunks[reqId].push(chunk || '')
  },
  finishBridgeRequest(reqId) {
    const chunks = pendingBridgeRequestChunks[reqId] || []
    delete pendingBridgeRequestChunks[reqId]
    try {
      const request = JSON.parse(chunks.join('')) as { method: string; path: string; bodyJson: string; headersJson?: string }
      this.processRequest(reqId, request.method, request.path, request.bodyJson, request.headersJson)
    } catch {
      sendBridgeResponse(reqId, JSON.stringify({ error: 'Invalid pushed bridge request', _status: 400 }))
    }
  },
}

// Notify Java that the JS engine is ready to handle requests
setTimeout(() => {
  if (globalThis.AndroidServerBridge) {
    globalThis.AndroidServerBridge.onReady()
  }
}, 0)
