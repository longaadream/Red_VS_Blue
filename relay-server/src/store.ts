import type { ServerWebSocket } from 'bun'
import type { Room, WsData, ActionEntry } from './types'
import { db } from './db/client'

// In-memory for fast access; DB for persistence
const rooms = new Map<string, Room>()
const roomWsClients = new Map<string, Set<ServerWebSocket<WsData>>>()
const roomMutationTails = new Map<string, Promise<void>>()

// HOST disconnect timers: roomId -> timer handle
const hostTimeouts = new Map<string, Timer>()

const HOST_TIMEOUT_MS = 30 * 60 * 1000
function snapshotRoom(room: Room): Room {
  return structuredClone(room)
}

function upsertRoom(room: Room) {
  return db.room.upsert({
    where: { id: room.id },
    create: {
      id: room.id,
      hostId: room.hostId,
      name: room.name,
      mapId: room.mapId ?? null,
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
      mapId: room.mapId ?? null,
      players: room.players as any,
      lastStateBlob: room.lastStateBlob,
      actionLog: room.actionLog as any,
      hostDisconnectedAt: room.hostDisconnectedAt
        ? new Date(room.hostDisconnectedAt)
        : null,
    },
  })
}

function forgetRoom(id: string): void {
  const key = id.toLowerCase()
  rooms.delete(key)
  roomWsClients.delete(key)
  const timeout = hostTimeouts.get(key)
  if (timeout) clearTimeout(timeout)
  hostTimeouts.delete(key)
}


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
        mapId: room.mapId ?? null,
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
        mapId: room.mapId ?? null,
        players: room.players as any,
        lastStateBlob: room.lastStateBlob,
        actionLog: room.actionLog as any,
        hostDisconnectedAt: room.hostDisconnectedAt
          ? new Date(room.hostDisconnectedAt)
          : null,
      },
    }).catch(error => console.error(`[store] Failed to persist legacy room update ${room.id}`, error))
  },
  async persistRoom(room: Room): Promise<void> {
    const snapshot = snapshotRoom(room)
    await upsertRoom(snapshot)
    rooms.set(snapshot.id.toLowerCase(), snapshot)
  },

  async withRoomLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = id.toLowerCase()
    const previous = roomMutationTails.get(key) ?? Promise.resolve()
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    roomMutationTails.set(key, tail)

    await previous
    try {
      return await operation()
    } finally {
      release()
      if (roomMutationTails.get(key) === tail) roomMutationTails.delete(key)
    }
  },

  deleteRoom(id: string): void {
    rooms.delete(id.toLowerCase())
    roomWsClients.delete(id.toLowerCase())
    hostTimeouts.get(id.toLowerCase())?.let?.((t: Timer) => clearTimeout(t))
    hostTimeouts.delete(id.toLowerCase())
    db.room.delete({ where: { id } }).catch(error => console.error(`[store] Failed to persist legacy room deletion ${id}`, error))
  },
  async deleteRoomPersisted(id: string): Promise<void> {
    await db.room.delete({ where: { id } })
    forgetRoom(id)
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
    }).catch(error => console.error(`[store] Failed to persist action log for ${roomId}`, error))
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
        mapId: r.mapId ?? undefined,
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
