import type { ServerWebSocket } from 'bun'
import type { WsData, WsInbound } from '../types'
import { store } from '../store'

function send(ws: ServerWebSocket<WsData>, msg: object) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function err(ws: ServerWebSocket<WsData>, message: string) {
  send(ws, { type: 'error', message })
}

// ── Subscribe ──────────────────────────────────────────────────────────────

function handleSubscribe(
  ws: ServerWebSocket<WsData>,
  roomId: string,
  msg: Extract<WsInbound, { type: 'subscribe' }>
) {
  const room = store.getRoom(roomId)
  if (!room) return err(ws, 'room not found')

  const player = room.players.find(p => p.id === msg.playerId)
  // Allow spectators even if not in players list yet
  const role = msg.playerId === room.hostId ? 'host' : player ? 'guest' : 'spectator'

  ws.data.roomId = roomId
  ws.data.playerId = msg.playerId
  ws.data.role = role

  store.addWsClient(roomId, ws)
  send(ws, { type: 'subscribed', role })

  // If host reconnects during waiting_host, resume
  if (role === 'host' && room.status === 'waiting_host') {
    store.cancelHostTimeout(roomId)
    room.status = 'battle'
    store.setRoom(room)
    if (room.lastStateBlob) {
      send(ws, { type: 'hostResume', state: JSON.parse(room.lastStateBlob) })
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
    signature: msg.signature,
  })

  // Forward to host
  store.sendToHost(roomId, {
    type: 'pendingAction',
    seq: msg.seq,
    action: msg.action,
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
  room.lastStateBlob = JSON.stringify(msg.state)
  store.setRoom(room)

  // Relay to all guests
  store.broadcastToRoom(
    roomId,
    { type: 'stateUpdate', seq: msg.seq, state: msg.state },
    ws // exclude host
  )
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

  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let msg: WsInbound
    try {
      msg = JSON.parse(raw.toString()) as WsInbound
    } catch {
      return
    }

    const roomId = ws.data.roomId ?? new URL(ws.url ?? 'ws://x/').pathname.split('/').at(-1) ?? ''

    switch (msg.type) {
      case 'subscribe':
        handleSubscribe(ws, roomId, msg)
        break
      case 'action':
        handleAction(ws, msg)
        break
      case 'stateUpdate':
        handleStateUpdate(ws, msg)
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
