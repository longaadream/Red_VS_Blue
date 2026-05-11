import { NextRequest, NextResponse } from "next/server"
import type { BattleState } from "@/lib/game/turn"
import { getRoomStore, type Room } from "@/lib/game/room-store"
import { prisma } from "@/lib/db"

// 导出 Room 类型供其他文件使用
export type { Room }

// 导出存储实例供其他路由使用
export function getRoomsStore() {
  return getRoomStore()
}

export async function GET() {
  console.log('=== Lobby API GET Request ===')
  // 懒清理（异步，不阻塞响应）
  const now = Date.now()
  Promise.all([
    // 已结束的房间 24h 后删除
    prisma.room.deleteMany({
      where: { status: 'finished', updatedAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } }
    }),
    // 等待中但 48h 无人操作的房间直接删除
    prisma.room.deleteMany({
      where: { status: 'waiting', updatedAt: { lt: new Date(now - 48 * 60 * 60 * 1000) } }
    }),
    // in-progress 超过 6h 未更新：视为已放弃，清空 battleState 节省存储
    prisma.room.updateMany({
      where: { status: 'in-progress', updatedAt: { lt: new Date(now - 6 * 60 * 60 * 1000) } },
      data: { status: 'finished', battleState: null }
    }),
  ]).catch(() => {})

  try {
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
      inviteCode: room.inviteCode,
    }))

    console.log('Lobby API returning', formattedRooms.length, 'rooms')
    return NextResponse.json({ rooms: formattedRooms })
  } catch (error) {
    console.error('[GET /api/lobby] Error fetching rooms:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
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
    const inviteChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let inviteCode = ''
    for (let i = 0; i < 6; i++) {
      inviteCode += inviteChars.charAt(Math.floor(Math.random() * inviteChars.length))
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
      mapId: mapId?.trim() || 'large-battlefield',
      visibility: visibility || "public",
      inviteCode,
      spectators: [],
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
