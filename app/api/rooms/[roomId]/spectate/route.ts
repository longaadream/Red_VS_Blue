import { NextRequest, NextResponse } from "next/server"
import { getRoomStore } from "@/lib/game/room-store"
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

// POST /api/rooms/[roomId]/spectate — 加入观战
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const roomStore = getRoomStore()
  const room = await roomStore.getRoom(roomId)

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  if (room.status !== "in-progress") {
    return NextResponse.json(
      { error: "只有正在进行中的房间才能观战" },
      { status: 400 },
    )
  }

  let body: { spectatorId: string; spectatorName?: string; profileIdentity?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  let profileIdentity
  try {
    profileIdentity = assertGameProfileCompatibleV1(body.profileIdentity)
    for (const participant of room.players) {
      assertGameProfileCompatibleV1(participant.profileIdentity)
    }
    for (const spectator of room.spectators ?? []) {
      assertGameProfileCompatibleV1(spectator.profileIdentity)
    }
  } catch (error) {
    return profileErrorResponse(error)
  }

  const spectatorId = body.spectatorId?.trim().toLowerCase()
  if (!spectatorId) {
    return NextResponse.json({ error: "spectatorId is required" }, { status: 400 })
  }

  // 如果是参战玩家则不允许重复注册为观战者
  const isPlayer = room.players.some(p => p.id === spectatorId)
  if (isPlayer) {
    return NextResponse.json({ error: "你已经是该房间的参战玩家" }, { status: 400 })
  }

  await roomStore.addSpectator(roomId, {
    id: spectatorId,
    name: body.spectatorName?.trim() || spectatorId.slice(0, 8),
    joinedAt: Date.now(),
    profileIdentity,
  })

  const updated = await roomStore.getRoom(roomId)
  return NextResponse.json({
    success: true,
    spectators: updated?.spectators ?? [],
    profileIdentity: getServerGameProfileIdentityV1(),
  })
}

// DELETE /api/rooms/[roomId]/spectate — 离开观战
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()

  let body: { spectatorId: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const spectatorId = body.spectatorId?.trim().toLowerCase()
  if (!spectatorId) {
    return NextResponse.json({ error: "spectatorId is required" }, { status: 400 })
  }

  const roomStore = getRoomStore()
  await roomStore.removeSpectator(roomId, spectatorId)
  return NextResponse.json({ success: true })
}
