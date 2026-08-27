import { NextRequest, NextResponse } from 'next/server'
import { getPlayerSeat, getRoomStore, type Room } from '@/lib/game/room-store'
import { assertSelectableMapId, getMapSelectionErrorPayload } from '@/lib/game/map-selection'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { mode, hostId, playerName, mapId } = body

    if (mode !== 'pve') {
      return NextResponse.json({ error: 'Only mode=pve is supported via REST' }, { status: 400 })
    }
    if (!hostId) {
      return NextResponse.json({ error: 'hostId is required' }, { status: 400 })
    }
    const selectedMapId = assertSelectableMapId(mapId)

    const roomStore = getRoomStore()
    const roomId = 'pve-' + hostId.slice(0, 8) + '-' + Date.now().toString(36)
    const room: Room = {
      id: roomId,
      name: (playerName || hostId) + ' 的 PVE 练习',
      status: 'waiting',
      players: [],
      spectators: [],
      currentTurnIndex: 0,
      actions: [],
    }

    // Add human player (red)
    room.players = [{
      id: hostId,
      name: playerName || hostId,
      seat: 'red' as const,
      faction: 'red' as const,
      // PVE has no lobby alignment picker. Persist the default explicitly so
      // RED-67's roster lock can validate the human selection without
      // deriving content alignment from the red/blue seat.
      alignment: 'light' as const,
      joinedAt: Date.now(),
      ready: true,
      hasSelectedPieces: false,
      selectedPieces: [],
    }]
    // Add bot player (blue)
    room.players.push({
      id: 'bot',
      name: 'AI',
      seat: 'blue' as const,
      faction: 'blue' as const,
      alignment: 'dark' as const,
      joinedAt: Date.now(),
      ready: true,
      isBot: true,
      hasSelectedPieces: false,
      selectedPieces: [],
    })
    room.hostId = hostId
    room.mapId = selectedMapId
    room.visibility = 'private'
    room.maxPlayers = 2

    await roomStore.setRoom(roomId, room)
    return NextResponse.json({ id: roomId, status: room.status, mapId: selectedMapId })
  } catch (error) {
    const mapError = getMapSelectionErrorPayload(error)
    if (mapError) {
      return NextResponse.json({
        success: false,
        error: mapError.message,
        code: mapError.code,
        context: mapError.context,
      }, { status: 400 })
    }
    console.error('[POST /api/rooms] Error creating PVE room:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

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
        accountId: player.accountId,
        name: player.name,
        seat: getPlayerSeat(player),
        faction: player.faction,
        alignment: player.alignment,
        hasSelectedPieces: player.rosterLocked === true,
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
