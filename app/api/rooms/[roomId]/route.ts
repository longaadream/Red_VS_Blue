import { NextRequest, NextResponse } from "next/server"
import { getRoomStore, type Room } from "@/lib/game/room-store"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getAllPieces } from "@/lib/game/piece-repository"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  console.log('[GET /api/rooms/:roomId] Fetching room:', roomId)
  const roomStore = getRoomStore()
  const room = await roomStore.getRoom(roomId)

  if (!room) {
    console.log('[GET /api/rooms/:roomId] Room not found:', roomId)
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  console.log('[GET /api/rooms/:roomId] Returning room:', {
    id: room.id,
    playersCount: room.players.length,
    players: room.players.map(p => ({
      id: p.id,
      hasSelectedPieces: p.hasSelectedPieces,
      selectedPiecesCount: p.selectedPieces?.length || 0
    }))
  })
  return NextResponse.json(room)
}

type StartBody = {
  action: "start"
}

type JoinBody = {
  action: "join"
  playerId: string
  playerName?: string
}

type RoomPostBody = StartBody | JoinBody


export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const roomStore = getRoomStore()
  let room = await roomStore.getRoom(roomId)

  // 如果房间不存在，创建一个新的房间
  if (!room) {
    console.log('Room not found, creating new room:', roomId)
    room = await roomStore.createRoom(roomId, `Room ${roomId}`)
    console.log('New room created:', room.id)
  }

  let body: RoomPostBody
  try {
    body = (await req.json()) as RoomPostBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (body.action === "join") {
    const normalizedPlayerId = body.playerId?.trim().toLowerCase()
    const playerName = body.playerName?.trim()
    if (!normalizedPlayerId) {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 })
    }

    if (room.status !== "waiting") {
      return NextResponse.json(
        { error: "Cannot join a game that has already started or finished" },
        { status: 400 },
      )
    }

    if (room.players.length >= room.maxPlayers) {
      return NextResponse.json({ error: "Room is full" }, { status: 400 })
    }

    const existing = room.players.find(
      (p) => p.id.toLowerCase() === normalizedPlayerId,
    )

    if (!existing) {
      const player = {
        id: normalizedPlayerId,
        name: playerName || `Player ${normalizedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      room.players.push(player)

      if (!room.hostId) {
        room.hostId = normalizedPlayerId
      }
    }

    await roomStore.setRoom(room.id.trim(), room)
    return NextResponse.json(room)
  }

  if (body.action === "start") {
    if (room.status !== "waiting") {
      return NextResponse.json(
        { error: "Game is already in progress or finished" },
        { status: 400 },
      )
    }

    if (room.players.length !== 2) {
      return NextResponse.json(
        { error: "Exactly two players are required to start a 1v1 game" },
        { status: 400 },
      )
    }

    const playerIds = room.players.map((p) => p.id)
    const defaultPieces = getAllPieces()
    const battle = await createInitialBattleForPlayers(playerIds, defaultPieces, undefined, room.mapId)
    if (!battle) {
      return NextResponse.json(
        { error: "Failed to initialize battle state" },
        { status: 500 }
      )
    }

    room.status = "in-progress"
    room.currentTurnIndex = 0
    room.battleState = battle
    await roomStore.setRoom(room.id.trim(), room)

    return NextResponse.json(room)
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  } catch (error) {
    console.error('[POST /api/rooms/:roomId] Unhandled error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  console.log('=== DELETE Request Started ===')

  try {
    const { roomId: originalRoomId } = await params
    const roomId = originalRoomId.trim().toLowerCase()
    console.log('Processing room deletion:', { original: originalRoomId, normalized: roomId })

    const roomStore = getRoomStore()
    const removed = await roomStore.removeRoom(roomId)
    console.log('Room removal result:', removed)

    console.log('Room deletion completed:', roomId)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Unexpected error in DELETE handler:', error)
    return NextResponse.json({ success: true })
  } finally {
    console.log('=== DELETE Request Completed ===')
  }
}
