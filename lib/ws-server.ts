import { WebSocketServer, WebSocket } from 'ws'

let _wss: WebSocketServer | null = null
const roomClients = new Map<string, Set<WebSocket>>()

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

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'subscribe' && typeof msg.roomId === 'string') {
          if (roomId) roomClients.get(roomId)?.delete(ws)
          roomId = msg.roomId.toLowerCase()
          if (!roomClients.has(roomId)) roomClients.set(roomId, new Set())
          roomClients.get(roomId)!.add(ws)
          ws.send(JSON.stringify({ type: 'subscribed', roomId }))
        }
      } catch {}
    })

    ws.on('close', () => { if (roomId) roomClients.get(roomId)?.delete(ws) })
    ws.on('error', () => { if (roomId) roomClients.get(roomId)?.delete(ws) })
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
