import { NextRequest, NextResponse } from "next/server"
import type { BattleState } from "@/lib/game/turn"
import { getRoomStore, type Room } from "@/lib/game/room-store"

// 导出 Room 类型供其他文件使用
export type { Room }

// 导出存储实例供其他路由使用
export function getRoomsStore() {
  return getRoomStore()
}

export async function GET() {
  console.log('=== Lobby API GET Request ===')
  const roomStore = getRoomStore()

  const allRooms = await roomStore.getAllRooms()
  console.log('All rooms in store:', allRooms.map(r => ({ id: r.id, name: r.name, hostId: r.hostId })))

  const validRooms = allRooms.filter(room => room.id && room.name)
  const uniqueRooms = Array.from(new Map(validRooms.map(room => [room.id, room])).values())
  console.log('Unique rooms to return:', uniqueRooms.map(r => ({ id: r.id, name: r.name, hostId: r.hostId })))

  const formattedRooms = uniqueRooms.map((room) => ({
    id: room.id,
    name: room.name,
    status: room.status,
    createdAt: room.createdAt,
    maxPlayers: room.maxPlayers,
    playerCount: room.players?.length || 0,
    hostId: room.hostId,
    mapId: room.mapId,
    visibility: room.visibility,
  }))

  console.log('Lobby API returning', formattedRooms.length, 'rooms')
  return NextResponse.json({ rooms: formattedRooms })
}

export async function POST(req: NextRequest) {
  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      body = {}
    }

    const { name, hostId, mapId, visibility } = (body as { name?: string; hostId?: string; mapId?: string; visibility?: "private" | "public" }) ?? {}

    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let roomId = ''
    for (let i = 0; i < 5; i++) {
      roomId += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    const now = Date.now()
    const trimmedHostId = hostId?.trim() || ''
    const roomStore = getRoomStore()

    const room: Room = {
      id: roomId,
      name: name?.trim() || `Room ${roomId}`,
      status: "waiting",
      createdAt: now,
      maxPlayers: 2,
      players: [],
      hostId: trimmedHostId,
      mapId: mapId?.trim() || 'arena-8x6',
      visibility: visibility || "private",
      currentTurnIndex: 0,
      actions: [],
      battleState: undefined,
    }

    console.log('Creating room with:', { roomId, hostId: trimmedHostId, name: room.name })
    await roomStore.setRoom(roomId, room)
    console.log('Room created successfully')

    return NextResponse.json(room, { status: 201 })
  } catch (error) {
    console.error('[POST /api/lobby] Error creating room:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
