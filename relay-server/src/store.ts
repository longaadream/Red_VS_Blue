import type { ServerWebSocket } from 'bun'
import type { Room, WsData, ActionEntry } from './types'
import { db } from './db/client'

// In-memory for fast access; DB for persistence
const rooms = new Map<string, Room>()
const roomWsClients = new Map<string, Set<ServerWebSocket<WsData>>>()

// HOST disconnect timers: roomId -> timer handle
const hostTimeouts = new Map<string, Timer>()

const HOST_TIMEOUT_MS = 30 * 60 * 1000

export const store = {
  // ── Room CRUD ──────────────────────────────────────────────────────────────

  getRoom(id: string): Room | undefined {
    return rooms.get(id.toLowerCase())
  },

  setRoom(room: Room): void {
    rooms.set(room.id.toLowerCase(), room)
    db.room.upsert({
      where: { id: room.id },
      create: {
        id: room.id,
        hostId: room.hostId,
        name: room.name,
        status: room.status,
        players: room.players as any,
        inviteCode: room.inviteCode,
        lastStateBlob: room.lastStateBlob,
        actionLog: room.actionLog as any,
        hostDisconnectedAt: room.hostDisconnectedAt
          ? new Date(room.hostDisconnectedAt)
          : null,
      },
      update: {
        status: room.status,
        players: room.players as any,
        lastStateBlob: room.lastStateBlob,
        actionLog: room.actionLog as any,
        hostDisconnectedAt: room.hostDisconnectedAt
          ? new Date(room.hostDisconnectedAt)
          : null,
      },
    }).catch(() => {})
  },

  deleteRoom(id: string): void {
    rooms.delete(id.toLowerCase())
    roomWsClients.delete(id.toLowerCase())
    hostTimeouts.get(id.toLowerCase())?.let?.((t: Timer) => clearTimeout(t))
    hostTimeouts.delete(id.toLowerCase())
    db.room.delete({ where: { id } }).catch(() => {})
  },

  listRooms(): Room[] {
    return [...rooms.values()]
  },

  appendAction(roomId: string, entry: ActionEntry): void {
    const room = rooms.get(roomId.toLowerCase())
    if (!room) return
    room.actionLog.push(entry)
    // Persist only the action log update
    db.room.update({
      where: { id: roomId },
      data: { actionLog: room.actionLog as any },
    }).catch(() => {})
  },

  // ── WebSocket client management ───────────────────────────────────────────

  addWsClient(roomId: string, ws: ServerWebSocket<WsData>): void {
    const key = roomId.toLowerCase()
    if (!roomWsClients.has(key)) roomWsClients.set(key, new Set())
    roomWsClients.get(key)!.add(ws)
  },

  removeWsClient(roomId: string, ws: ServerWebSocket<WsData>): void {
    roomWsClients.get(roomId.toLowerCase())?.delete(ws)
  },

  getWsClients(roomId: string): Set<ServerWebSocket<WsData>> {
    return roomWsClients.get(roomId.toLowerCase()) ?? new Set()
  },

  // ── Broadcast helpers ─────────────────────────────────────────────────────

  broadcastToRoom(roomId: string, msg: object, excludeWs?: ServerWebSocket<WsData>): void {
    const payload = JSON.stringify(msg)
    for (const ws of this.getWsClients(roomId)) {
      if (ws === excludeWs) continue
      if (ws.readyState === 1) ws.send(payload)
    }
  },

  sendToHost(roomId: string, msg: object): void {
    for (const ws of this.getWsClients(roomId)) {
      if (ws.data.role === 'host' && ws.readyState === 1) {
        ws.send(JSON.stringify(msg))
        return
      }
    }
  },

  // ── Host disconnect / reconnect ───────────────────────────────────────────

  startHostTimeout(roomId: string, onExpire: () => void): void {
    const key = roomId.toLowerCase()
    hostTimeouts.get(key) && clearTimeout(hostTimeouts.get(key)!)
    hostTimeouts.set(key, setTimeout(onExpire, HOST_TIMEOUT_MS))
  },

  cancelHostTimeout(roomId: string): void {
    const key = roomId.toLowerCase()
    if (hostTimeouts.has(key)) {
      clearTimeout(hostTimeouts.get(key)!)
      hostTimeouts.delete(key)
    }
  },

  // ── Load from DB on startup ───────────────────────────────────────────────

  async loadFromDb(): Promise<void> {
    const dbRooms = await db.room.findMany({
      where: {
        status: { not: 'finished' },
        // Drop rooms older than 2 hours
        updatedAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      },
    })
    for (const r of dbRooms) {
      rooms.set(r.id.toLowerCase(), {
        id: r.id,
        hostId: r.hostId,
        name: r.name,
        status: r.status as any,
        players: (r.players as any) ?? [],
        inviteCode: r.inviteCode ?? undefined,
        lastStateBlob: r.lastStateBlob ?? undefined,
        actionLog: (r.actionLog as any) ?? [],
        hostDisconnectedAt: r.hostDisconnectedAt?.getTime(),
        createdAt: r.createdAt.getTime(),
      })
    }
    console.log(`[store] Loaded ${dbRooms.length} active rooms from DB`)
  },
}
