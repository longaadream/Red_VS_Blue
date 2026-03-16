import { NextRequest, NextResponse } from "next/server"
import type { BattleState } from "@/lib/game/turn"
import { getRoomStore, type Room } from "@/lib/game/room-store"

// 获取 RoomStore 实例
console.log('Getting RoomStore instance in lobby route')
const roomStore = getRoomStore()

// 导出 Room 类型供其他文件使用
export type { Room }

// 导出存储实例供其他路由使用
export function getRoomsStore() {
  return getRoomStore()
}

export async function GET() {
  console.log('=== Lobby API GET Request ===')
  
  // 先确保房间存储已初始化
  const allRooms = Array.from(roomStore.getRooms().values())
  console.log('All rooms in store:', allRooms.map(r => ({ id: r.id, name: r.name, hostId: r.hostId })))
  
  // 过滤出有效的房间（排除可能的空数据）
  const validRooms = allRooms.filter(room => room.id && room.name)
  console.log('Valid rooms:', validRooms.length)
  
  // 去重处理，确保每个房间ID只出现一次
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

    // 生成5位的数字和字母组合作为房间ID（强制小写）
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let roomId = ''
    for (let i = 0; i < 5; i++) {
      roomId += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    const now = Date.now()
    const trimmedHostId = hostId?.trim() || ''

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
      battleState: null,
    }

    console.log('Creating room with:', { roomId, hostId: trimmedHostId, name: room.name })
    roomStore.setRoom(roomId, room)
    console.log('Room created successfully')

    return NextResponse.json(room, { status: 201 })
  } catch (error) {
    console.error('[POST /api/lobby] Error creating room:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

