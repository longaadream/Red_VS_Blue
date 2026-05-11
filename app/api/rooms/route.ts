import { NextRequest, NextResponse } from 'next/server'
import { getRoomStore } from '@/lib/game/room-store'

export async function GET(req: NextRequest) {
  try {
    const roomStore = getRoomStore()
    const rooms = await roomStore.getAllRooms()

    const roomList = rooms.map(room => ({
      id: room.id,
      name: room.name,
      status: room.status,
      players: room.players.map(player => ({
        id: player.id,
        name: player.name,
        faction: player.faction,
        hasSelectedPieces: player.hasSelectedPieces || false,
      })),
      playerCount: room.players.length,
      playersCount: room.players.length,
      maxPlayers: room.maxPlayers || 2,
      mapId: room.mapId,
      hostId: room.hostId,
      createdAt: room.createdAt,
      visibility: room.visibility || 'public',
      inviteCode: room.inviteCode,
    }))

    return NextResponse.json({ rooms: roomList })
  } catch (error) {
    console.error('[GET /api/rooms] Error fetching rooms:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const roomId = searchParams.get('roomId')
    const adminKey = searchParams.get('adminKey')

    if (!roomId) {
      return NextResponse.json({ error: 'roomId is required' }, { status: 400 })
    }

    const expectedAdminKey = process.env.ROOM_ADMIN_KEY || 'admin-secret-key'
    if (adminKey !== expectedAdminKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const roomStore = getRoomStore()
    const removed = await roomStore.removeRoom(roomId)

    if (!removed) {
      return NextResponse.json({ error: 'Room not found or already deleted' }, { status: 404 })
    }

    return NextResponse.json({ success: true, deletedRoomId: roomId })
  } catch (error) {
    console.error('Error deleting room:', error)
    return NextResponse.json({ error: 'Failed to delete room' }, { status: 500 })
  }
}
