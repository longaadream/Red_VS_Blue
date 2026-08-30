import { NextRequest, NextResponse } from "next/server"
import { assignNextSeat, getPlayerSeat, getRoomStore, normalizePlayerAlignment } from "@/lib/game/room-store"
import { ensureRosterAlignmentMutable, getRosterErrorPayload } from "@/lib/game/roster-contract"
import { assertSelectableMapId, getMapSelectionErrorPayload } from "@/lib/game/map-selection"
import { startBattleFromLockedRosters } from "@/lib/game/room-battle-start"
import { broadcastToRoom } from "@/lib/ws-server"
import { createPublicRoomSnapshot } from "@/lib/game/room-battle-actions"
import {
  assertGameProfileCompatibleV1,
  getGameProfileErrorPayloadV1,
  getServerGameProfileIdentityV1,
  type GameProfileIdentityV1,
} from "@/lib/content-pipeline/runtime/profile-game-identity"

function profileErrorResponse(error: unknown): NextResponse {
  const profileError = getGameProfileErrorPayloadV1(error)
  if (!profileError) throw error
  return NextResponse.json({
    success: false,
    error: profileError.message,
    code: profileError.code,
    context: profileError.context,
  }, { status: profileError.status })
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
  return NextResponse.json({
    ...createPublicRoomSnapshot(room),
    profileIdentity: getServerGameProfileIdentityV1(),
  })
}

type StartBody = {
  action: "start"
  profileIdentity: unknown
}

type JoinBody = {
  action: "join"
  playerId: string
  playerName?: string
  profileIdentity: unknown
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

  let profileIdentity: GameProfileIdentityV1
  try {
    profileIdentity = assertGameProfileCompatibleV1(body.profileIdentity)
  } catch (error) {
    return profileErrorResponse(error)
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

  const room = await roomStore.getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }
  try {
    for (const participant of room.players) {
      assertGameProfileCompatibleV1(participant.profileIdentity)
    }
  } catch (error) {
    return profileErrorResponse(error)
  }

  if (
    (body.action === "join" || body.action === "start")
    && (room.status !== 'in-progress' || !room.battleState)
  ) {
    try {
      assertSelectableMapId(room.mapId)
    } catch (error) {
      const mapError = getMapSelectionErrorPayload(error)
      if (mapError) {
        return NextResponse.json({ success: false, error: mapError.message, code: mapError.code, context: mapError.context }, { status: 400 })
      }
      throw error
    }
  }

  if (body.action === "join") {
    const normalizedPlayerId = body.playerId?.trim().toLowerCase()
    const playerName = body.playerName?.trim()
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
      try {
        ensureRosterAlignmentMutable(existing, requestedAlignment)
      } catch (error) {
        const rosterError = getRosterErrorPayload(error)
        return NextResponse.json({ success: false, error: rosterError?.message, code: rosterError?.code, context: rosterError?.context }, { status: 409 })
      }
      if (requestedAlignment) existing.alignment = requestedAlignment
      if (playerName) existing.name = playerName
      existing.profileIdentity = profileIdentity
      await roomStore.setRoom(room.id.trim(), room)
      return NextResponse.json({ ...createPublicRoomSnapshot(room), profileIdentity: getServerGameProfileIdentityV1() })
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
      profileIdentity,
    }
    room.players.push(player)

    if (!room.hostId) {
      room.hostId = normalizedPlayerId
    }

    await roomStore.setRoom(room.id.trim(), room)
    return NextResponse.json({ ...createPublicRoomSnapshot(room), profileIdentity: getServerGameProfileIdentityV1() })
  }

  if (body.action === "start") {
    try {
      const result = await startBattleFromLockedRosters(roomStore, roomId, {
        onDeploymentUpdate: snapshot => broadcastToRoom(roomId, { type: 'stateUpdate', ...snapshot }),
      })
      return NextResponse.json({ ...createPublicRoomSnapshot(result.room), profileIdentity: getServerGameProfileIdentityV1() })
    } catch (error) {
      if (getGameProfileErrorPayloadV1(error)) {
        return profileErrorResponse(error)
      }
      const rosterError = getRosterErrorPayload(error)
      if (rosterError) {
        return NextResponse.json({ success: false, error: rosterError.message, code: rosterError.code, context: rosterError.context }, { status: 400 })
      }
      const mapError = getMapSelectionErrorPayload(error)
      if (mapError) {
        return NextResponse.json({ success: false, error: mapError.message, code: mapError.code, context: mapError.context }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : String(error)
      return NextResponse.json({ success: false, error: message }, { status: 400 })
    }
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  } catch (error) {
    if (getGameProfileErrorPayloadV1(error)) {
      return profileErrorResponse(error)
    }
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
      const removed = await roomStore.removeRoom(roomId)
      if (!removed) {
        return NextResponse.json({ success: false, error: 'Room could not be deleted' }, { status: 500 })
      }
      return NextResponse.json({ success: true, deletedBy: 'admin' })
    }

    if (playerId && room.hostId?.toLowerCase() === playerId.toLowerCase()) {
      if (room.status === 'in-progress') {
        return NextResponse.json({ error: 'Cannot delete room while game is in progress' }, { status: 400 })
      }
      const removed = await roomStore.removeRoom(roomId)
      if (!removed) {
        return NextResponse.json({ success: false, error: 'Room could not be deleted' }, { status: 500 })
      }
      return NextResponse.json({ success: true, deletedBy: 'host' })
    }

    return NextResponse.json({ error: 'Unauthorized - only host can delete room' }, { status: 403 })
  } catch (error) {
    console.error('Unexpected error in DELETE handler:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 })
  }
}
