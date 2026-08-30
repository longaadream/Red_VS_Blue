import { NextRequest, NextResponse } from "next/server"
import { assignNextSeat, normalizePlayerAlignment, roomStore } from "@/lib/game/room-store"
import { assertSelectableMapId, getMapSelectionErrorPayload } from "@/lib/game/map-selection"
import {
  assertGameProfileCompatibleV1,
  getGameProfileErrorPayloadV1,
  getServerGameProfileIdentityV1,
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const { playerId, playerName } = (body as {
    playerId?: string
    playerName?: string
  }) ?? {}
  const accountId = String((body as { accountId?: unknown; identityId?: unknown })?.accountId || (body as { accountId?: unknown; identityId?: unknown })?.identityId || '').trim().toLowerCase() || undefined
  const requestedAlignment = normalizePlayerAlignment((body as { alignment?: unknown })?.alignment)

  let profileIdentity
  try {
    profileIdentity = assertGameProfileCompatibleV1((body as { profileIdentity?: unknown })?.profileIdentity)
  } catch (error) {
    return profileErrorResponse(error)
  }

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
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

  if (room.status !== 'in-progress' || !room.battleState) {
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

  const normalizedPlayerId = playerId.trim().toLowerCase()

  const existingPlayer = room.players.find(
    (p) => p.id.toLowerCase() === normalizedPlayerId
  )

  if (existingPlayer) {
    return NextResponse.json({ error: "Player already in room" }, { status: 400 })
  }

  const newPlayer = {
    id: normalizedPlayerId,
    accountId,
    name: playerName?.trim() || `Player ${normalizedPlayerId.slice(0, 8)}`,
    joinedAt: Date.now(),
    seat: assignNextSeat(room.players, normalizedPlayerId),
    selectedPieces: [],
    profileIdentity,
  }
  ;(newPlayer as any).faction = newPlayer.seat
  if (requestedAlignment) (newPlayer as any).alignment = requestedAlignment

  room.players.push(newPlayer)
  await roomStore.setRoom(roomId, room)

  return NextResponse.json({
    success: true,
    message: "Player joined room successfully",
    player: {
      id: newPlayer.id,
      name: newPlayer.name,
      seat: newPlayer.seat,
      faction: newPlayer.seat,
      alignment: requestedAlignment,
    },
    profileIdentity: getServerGameProfileIdentityV1(),
    roomStatus: room.players.length === 2 ? "ready" : "waiting"
  }, { status: 201 })
}
