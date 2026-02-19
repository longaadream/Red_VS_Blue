import { NextRequest, NextResponse } from "next/server"
import roomStore, { type Room } from "@/lib/game/room-store"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getAllPieces } from "@/lib/game/piece-repository"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params
  const room = roomStore.getRoom(roomId)

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

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



export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params
  const room = roomStore.getRoom(roomId)

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  let body: RoomPostBody
  try {
    body = (await req.json()) as RoomPostBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (body.action === "join") {
    const playerId = body.playerId?.trim()
    const playerName = body.playerName?.trim()
    if (!playerId) {
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
      (p) => p.id === playerId,
    )

    if (!existing) {
      const player = {
        id: playerId,
        name: playerName || `Player ${playerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      room.players.push(player)
      
      // 如果房间还没有房主，将当前加入的玩家设置为房主
      if (!room.hostId) {
        room.hostId = playerId
      }
    }

    roomStore.setRoom(room.id, room)
    return NextResponse.json(room)
  }

  if (body.action === "start") {
    if (room.status !== "waiting") {
      return NextResponse.json(
        { error: "Game is already in progress or finished" },
        { status: 400 },
      )
    }

    // 1v1：必须刚好 2 人才能开始
    if (room.players.length !== 2) {
      return NextResponse.json(
        { error: "Exactly two players are required to start a 1v1 game" },
        { status: 400 },
      )
    }

    const playerIds = room.players.map((p) => p.id)
    const defaultPieces = getAllPieces()
    const battle = createInitialBattleForPlayers(playerIds, defaultPieces, undefined, room.mapId)
    if (!battle) {
      return NextResponse.json(
        { error: "Failed to initialize battle state" },
        { status: 500 }
      )
    }

    room.status = "in-progress"
    room.currentTurnIndex = 0
    room.battleState = battle
    roomStore.setRoom(room.id, room)

    return NextResponse.json(room)
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params
  const existed = roomStore.deleteRoom(roomId)

  if (!existed) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}


