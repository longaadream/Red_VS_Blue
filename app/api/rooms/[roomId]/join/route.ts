import { NextRequest, NextResponse } from "next/server"
import roomStore, { type Room } from "@/lib/game/room-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const { roomId } = await params
  const { playerId, playerName } = (body as { 
    playerId?: string
    playerName?: string
  }) ?? {}

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  const room = roomStore.getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  const existingPlayer = room.players.find(
    (p) => p.id === playerId.trim()
  )

  if (existingPlayer) {
    return NextResponse.json({ error: "Player already in room" }, { status: 400 })
  }

  const newPlayer = {
    id: playerId.trim(),
    name: playerName?.trim() || `Player ${playerId.slice(0, 8)}`,
    joinedAt: Date.now(),
    selectedPieces: [],
  }

  room.players.push(newPlayer)
  roomStore.setRoom(roomId, room)

  return NextResponse.json({ 
    success: true, 
    message: "Player joined room successfully",
    player: {
      id: newPlayer.id,
      name: newPlayer.name,
      faction: null
    },
    roomStatus: room.players.length === 2 ? "ready" : "waiting"
  }, { status: 201 })
}
