import { NextRequest, NextResponse } from "next/server"
import { assignNextSeat, getPlayerSeat, getRoomStore, normalizePlayerAlignment, type Room, type Player } from "@/lib/game/room-store"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getAllPieces } from "@/lib/game/piece-repository"
import { createRootSeed } from "@/lib/game/rule-runtime"

function checkPackMismatch(players: Player[]): boolean {
  const hashes = players.map(p => p.packMd5).filter(Boolean)
  return hashes.length === 2 && hashes[0] !== hashes[1]
}

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
  packMd5?: string
  alignment?: 'light' | 'dark' | 'good' | 'evil'
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

  let body: RoomPostBody
  try {
    body = (await req.json()) as RoomPostBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Reject malformed joins before reading or creating persistent room state.
  if (body.action === "join") {
    if (!body.playerId?.trim()) {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 })
    }
    if (!normalizePlayerAlignment(body.alignment)) {
      return NextResponse.json({ error: "alignment must be light or dark" }, { status: 400 })
    }
  }

  let room = await roomStore.getRoom(roomId)
  if (!room) {
    if (body.action !== "join") {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }
    console.log('Room not found, creating new room:', roomId)
    room = await roomStore.createRoom(roomId, `Room ${roomId}`)
    console.log('New room created:', room.id)
  }

  if (body.action === "join") {
    const normalizedPlayerId = body.playerId?.trim().toLowerCase()
    const playerName = body.playerName?.trim()
    const packMd5 = body.packMd5?.trim() || undefined
    if (!normalizedPlayerId) {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 })
    }

    const requestedAlignment = normalizePlayerAlignment(body.alignment)
    if (!requestedAlignment) {
      return NextResponse.json({ error: "alignment must be light or dark" }, { status: 400 })
    }

    const existing = room.players.find(
      (p) => p.id.toLowerCase() === normalizedPlayerId,
    )

    if (existing) {
      const seat = getPlayerSeat(existing) || assignNextSeat(room.players, normalizedPlayerId)
      existing.seat = seat
      existing.faction = seat
      existing.alignment = requestedAlignment
      if (playerName) existing.name = playerName
      if (packMd5) existing.packMd5 = packMd5
      await roomStore.setRoom(room.id.trim(), room)
      const packMismatch = checkPackMismatch(room.players)
      return NextResponse.json({ ...room, packMismatch })
    }

    if (room.status !== "waiting") {
      return NextResponse.json(
        { error: "Cannot join a game that has already started or finished" },
        { status: 400 },
      )
    }

    if (room.players.length >= (room.maxPlayers ?? 2)) {
      return NextResponse.json({ error: "Room is full" }, { status: 400 })
    }

    const seat = assignNextSeat(room.players, normalizedPlayerId)

    const player = {
      id: normalizedPlayerId,
      name: playerName || `Player ${normalizedPlayerId.slice(0, 8)}`,
      joinedAt: Date.now(),
      seat,
      faction: seat,
      alignment: requestedAlignment,
      packMd5,
    }
    room.players.push(player)

    if (!room.hostId) {
      room.hostId = normalizedPlayerId
    }

    await roomStore.setRoom(room.id.trim(), room)
    const packMismatch = checkPackMismatch(room.players)
    return NextResponse.json({ ...room, packMismatch })
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

    const playerIds = room.players.map((p: any) => p.id)
    if (room.players.some(player => !getPlayerSeat(player) || !player.alignment)) {
      return NextResponse.json({ error: "All players require a seat and alignment" }, { status: 400 })
    }
    const defaultPieces = getAllPieces()
    const playerFactions = room.players.map((p: any) => ({ playerId: p.id, faction: getPlayerSeat(p) as 'red' | 'blue', pieces: [] as any[] }))
    const firstPlayerId = room.firstPlayerId || room.players.find(player => getPlayerSeat(player) === 'red')?.id
    if (!firstPlayerId || !playerIds.includes(firstPlayerId)) {
      return NextResponse.json({ error: "firstPlayerId must identify a room player" }, { status: 400 })
    }
    const seed = createRootSeed()
    const battle = await createInitialBattleForPlayers(
      playerIds,
      defaultPieces,
      playerFactions,
      room.mapId,
      { firstPlayerId, rootSeed: seed },
    )
    if (!battle) {
      return NextResponse.json(
        { error: "Failed to initialize battle state" },
        { status: 500 }
      )
    }
    room.status = "in-progress"
    room.currentTurnIndex = 0
    room.battleState = {
      type: 'server-state',
      seed,
      state: battle,
    } as any
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
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId: originalRoomId } = await params
    const roomId = originalRoomId.trim().toLowerCase()

    const adminKey = req.headers.get('x-admin-key')
    const playerId = req.headers.get('x-player-id')

    const expectedAdminKey = process.env.ROOM_ADMIN_KEY || 'admin-secret-key'

    const roomStore = getRoomStore()
    const room = await roomStore.getRoom(roomId)

    if (!room) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 })
    }

    if (adminKey === expectedAdminKey) {
      await roomStore.removeRoom(roomId)
      return NextResponse.json({ success: true, deletedBy: 'admin' })
    }

    if (playerId && room.hostId?.toLowerCase() === playerId.toLowerCase()) {
      if (room.status === 'in-progress') {
        return NextResponse.json({ error: 'Cannot delete room while game is in progress' }, { status: 400 })
      }
      await roomStore.removeRoom(roomId)
      return NextResponse.json({ success: true, deletedBy: 'host' })
    }

    return NextResponse.json({ error: 'Unauthorized - only host can delete room' }, { status: 403 })
  } catch (error) {
    console.error('Unexpected error in DELETE handler:', error)
    return NextResponse.json({ success: true })
  }
}
