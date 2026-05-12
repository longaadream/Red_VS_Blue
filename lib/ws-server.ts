import { WebSocketServer, WebSocket } from 'ws'
import { roomStore } from './game/room-store'

let _wss: WebSocketServer | null = null
const roomClients = new Map<string, Set<WebSocket>>()
const playerWs = new Map<string, WebSocket>()

export function startWsServer(): void {
  if (_wss) return
  if (process.env.DISABLE_WS === '1') {
    console.log('[WS] WebSocket server disabled (DISABLE_WS=1)')
    return
  }
  const port = getWsPort()

  _wss = new WebSocketServer({ port })

  _wss.on('error', (err: Error) => {
    console.error(`[WS] Failed to start on port ${port}:`, err.message)
    _wss = null
  })

  _wss.on('connection', (ws: WebSocket) => {
    let roomId: string | null = null
    let playerId: string | null = null

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'subscribe' && typeof msg.roomId === 'string') {
          if (roomId) {
            roomClients.get(roomId)?.delete(ws)
            if (playerId) playerWs.delete(playerId)
          }
          roomId = msg.roomId.toLowerCase()
          playerId = typeof msg.playerId === 'string' ? msg.playerId : null

          if (!roomClients.has(roomId)) roomClients.set(roomId, new Set())
          roomClients.get(roomId)!.add(ws)
          if (playerId) playerWs.set(playerId, ws)

          // LAN mode: server is the game engine; all WS clients are guests.
          ws.send(JSON.stringify({ type: 'subscribed', roomId, role: 'guest' }))
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
        } else if ((msg.type === 'action' || msg.type === 'gameOver') && roomId) {
          const _roomId = roomId
          const _playerId = playerId
          ;(async () => {
            try {
              const room = await roomStore.getRoom(_roomId)
              if (!room) return
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const log = room.battleState as any
              if (!log || log.type !== 'action-log') return
              const seq: number = log.actions.length
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const entry: Record<string, any> = { seq, type: msg.type, playerId: _playerId ?? undefined, timestamp: Date.now() }
              if (msg.type === 'action' && msg.action != null) entry.action = msg.action
              if (msg.type === 'gameOver' && msg.winner != null) entry.winner = msg.winner
              log.actions.push(entry)
              if (msg.type === 'gameOver' && !room.gameRecord) {
                room.status = 'finished'
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                room.gameRecord = { gameId: _roomId + '-' + Date.now(), timestamp: Date.now(), roomId: _roomId, players: (room.players as any[]).map(p => ({ id: p.id, name: p.name, publicKey: p.publicKey })), winner: msg.winner ?? null, signatures: {} }
              }
              await roomStore.setRoom(_roomId, room)
              broadcastToRoom(_roomId, { type: 'actionLog', entry })
            } catch {}
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
