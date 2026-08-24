import type { ServerWebSocket } from 'bun'
import type { WsData, WsInbound } from '../types'
import { store } from '../store'
import { BattleSubscribeAuthError, verifyBattleSubscribeAuth } from '../../../lib/game/identity-verify'

function send(ws: ServerWebSocket<WsData>, msg: object) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function err(ws: ServerWebSocket<WsData>, message: string, code?: string) {
  send(ws, { type: 'error', message, ...(code ? { code } : {}) })
}

// ── Subscribe ──────────────────────────────────────────────────────────────

async function handleSubscribe(
  ws: ServerWebSocket<WsData>,
  roomId: string,
  msg: Extract<WsInbound, { type: 'subscribe' }>
) {
  const room = store.getRoom(roomId)
  if (!room) return err(ws, 'room not found')

  let verified: Awaited<ReturnType<typeof verifyBattleSubscribeAuth>>
  try {
    verified = await verifyBattleSubscribeAuth(msg, { roomId, playerId: msg.playerId })
  } catch (error) {
    const authError = error instanceof BattleSubscribeAuthError ? error : null
    return err(ws, authError?.message ?? 'Invalid WebSocket subscription identity', authError?.code ?? 'SUBSCRIBE_AUTH_INVALID')
  }

  const player = room.players.find(p => p.id.toLowerCase() === verified.playerId)
  if (player?.publicKey && player.publicKey.toLowerCase() !== verified.publicKey) {
    return err(ws, 'Signed WebSocket identity does not match the registered player key', 'SUBSCRIBE_AUTH_INVALID')
  }
  // Allow spectators even if not in players list yet
  const role = verified.playerId === room.hostId.toLowerCase() ? 'host' : player ? 'guest' : 'spectator'

  ws.data.roomId = roomId
  ws.data.playerId = verified.playerId
  ws.data.role = role

  store.addWsClient(roomId, ws)
  send(ws, { type: 'subscribed', role })

  // If host reconnects during waiting_host, resume
  if (role === 'host' && room.status === 'waiting_host') {
    store.cancelHostTimeout(roomId)
    room.status = 'battle'
    store.setRoom(room)
    if (room.lastStateBlob) {
      const saved = JSON.parse(room.lastStateBlob) as { type?: string; state?: unknown; authorityVersion?: number; seed?: number; stateHash?: string }
      send(ws, saved?.type === 'stateUpdate'
        ? { type: 'hostResume', state: saved.state, authorityVersion: saved.authorityVersion, seed: saved.seed, stateHash: saved.stateHash }
        : { type: 'hostResume', state: saved })
    }
    store.broadcastToRoom(roomId, { type: 'roomUpdate', room: publicRoom(room) }, ws)
  }
}

// ── Action (guest → relay → host) ─────────────────────────────────────────

function handleAction(
  ws: ServerWebSocket<WsData>,
  msg: Extract<WsInbound, { type: 'action' }>
) {
  const { roomId, playerId } = ws.data
  if (!roomId || !playerId) return err(ws, 'not subscribed')

  const room = store.getRoom(roomId)
  if (!room) return err(ws, 'room not found')
  if (room.status !== 'battle') return err(ws, 'battle not active')
  if (ws.data.role === 'host') return err(ws, 'host should not submit actions here')

  // Persist action entry for later verification
  store.appendAction(roomId, {
    seq: msg.seq,
    playerId,
    action: msg.action,
    prevStateHash: msg.prevStateHash,
    timestamp: Date.now(),
    signature: msg.signature ?? String((msg.auth as { signature?: unknown } | undefined)?.signature ?? ''),
  })

  // Forward to host
  store.sendToHost(roomId, {
    type: 'pendingAction',
    seq: msg.seq,
    action: msg.action,
    auth: msg.auth,
    from: playerId,
  })
}

// ── State update (host → relay → guests) ──────────────────────────────────

function handleStateUpdate(
  ws: ServerWebSocket<WsData>,
  msg: Extract<WsInbound, { type: 'stateUpdate' }>
) {
  const { roomId } = ws.data
  if (!roomId) return err(ws, 'not subscribed')
  if (ws.data.role !== 'host') return err(ws, 'only host can push state')

  const room = store.getRoom(roomId)
  if (!room) return err(ws, 'room not found')

  // Persist blob for reconnect
  room.lastStateBlob = JSON.stringify({
    type: 'stateUpdate',
    state: msg.state,
    authorityVersion: msg.authorityVersion,
    seed: msg.seed,
    stateHash: msg.stateHash,
  })
  store.setRoom(room)

  // Relay to all guests
  store.broadcastToRoom(
    roomId,
    {
      type: 'stateUpdate',
      seq: msg.seq,
      authorityVersion: msg.authorityVersion,
      acceptedClientActionId: msg.acceptedClientActionId,
      state: msg.state,
      seed: msg.seed,
      stateHash: msg.stateHash,
    },
    ws // exclude host
  )
}

// ── Action error (host → relay → addressed guest) ─────────────────────────

function handleActionError(
  ws: ServerWebSocket<WsData>,
  msg: Extract<WsInbound, { type: 'actionError' }>
) {
  const { roomId, playerId, role } = ws.data
  if (!roomId || !playerId) return err(ws, 'not subscribed')
  if (role !== 'host') return err(ws, 'only host can return action errors', 'ACTION_ERROR_FORBIDDEN')

  const room = store.getRoom(roomId)
  if (!room) return err(ws, 'room not found')
  if (room.status !== 'battle') return err(ws, 'battle not active')

  const targetId = String(msg.to ?? '').trim().toLowerCase()
  const target = room.players.find(player => player.id.toLowerCase() === targetId)
  if (!target || targetId === room.hostId.toLowerCase()) {
    return err(ws, 'invalid action error recipient', 'ACTION_ERROR_TARGET_INVALID')
  }

  const outbound = {
    type: 'actionError',
    from: playerId,
    action: msg.action,
    error: msg.error,
    code: msg.code,
    acceptedClientActionId: msg.acceptedClientActionId,
    preparation: msg.preparation,
    needsTargetSelection: msg.needsTargetSelection,
    targetType: msg.targetType,
    range: msg.range,
    filter: msg.filter,
    targetIndex: msg.targetIndex,
    needsOptionSelection: msg.needsOptionSelection,
    title: msg.title,
    options: msg.options,
  }

  let delivered = false
  for (const candidate of store.getWsClients(roomId)) {
    if (
      candidate.data.playerId?.toLowerCase() === targetId
      && candidate.data.role === 'guest'
      && candidate.readyState === 1
    ) {
      send(candidate, outbound)
      delivered = true
    }
  }
  if (!delivered) return err(ws, 'action error recipient is not connected', 'ACTION_ERROR_TARGET_UNAVAILABLE')
}

// ── Disconnect ─────────────────────────────────────────────────────────────

function handleClose(ws: ServerWebSocket<WsData>) {
  const { roomId, playerId, role } = ws.data
  if (!roomId) return
  store.removeWsClient(roomId, ws)

  if (role !== 'host') return

  const room = store.getRoom(roomId)
  if (!room || room.status === 'finished') return

  room.status = 'waiting_host'
  room.hostDisconnectedAt = Date.now()
  store.setRoom(room)

  store.broadcastToRoom(roomId, {
    type: 'roomUpdate',
    room: publicRoom(room),
  })

  store.startHostTimeout(roomId, () => {
    const r = store.getRoom(roomId)
    if (!r || r.status !== 'waiting_host') return
    r.status = 'finished'
    store.setRoom(r)
    store.broadcastToRoom(roomId, { type: 'gameOver', winner: 'guest_by_timeout' })
    console.log(`[ws] Room ${roomId} closed — host timeout`)
  })

  console.log(`[ws] Host ${playerId} disconnected from ${roomId}, 30min timeout started`)
}

// ── Public room shape (strip sensitive blobs) ──────────────────────────────

function publicRoom(room: ReturnType<typeof store.getRoom>) {
  if (!room) return null
  const { lastStateBlob: _s, actionLog: _a, ...pub } = room
  return pub
}

// ── Exported handler ───────────────────────────────────────────────────────

export const wsHandler = {
  open(_ws: ServerWebSocket<WsData>) {},

  async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let msg: WsInbound
    try {
      msg = JSON.parse(raw.toString()) as WsInbound
    } catch {
      return
    }

    const roomId = ws.data.roomId ?? new URL(ws.url ?? 'ws://x/').pathname.split('/').at(-1) ?? ''

    switch (msg.type) {
      case 'subscribe':
        await handleSubscribe(ws, roomId, msg)
        break
      case 'action':
        handleAction(ws, msg)
        break
      case 'stateUpdate':
        handleStateUpdate(ws, msg)
        break
      case 'actionError':
        handleActionError(ws, msg)
        break
      case 'ping':
        send(ws, { type: 'pong' })
        break
    }
  },

  close(ws: ServerWebSocket<WsData>) {
    handleClose(ws)
  },
}
