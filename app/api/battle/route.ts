import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getPieceById } from "@/lib/game/piece-repository"
import type { BattleState } from "@/lib/game/turn"
import roomStore, { type Room } from "@/lib/game/room-store"

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const { playerId, playerName, pieces } = (body as { 
    playerId?: string
    playerName?: string
    pieces?: Array<{ templateId: string; faction: string }>
  }) ?? {}

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  if (!pieces || pieces.length !== 2) {
    return NextResponse.json({ error: "Please select exactly 2 pieces (1 red, 1 blue)" }, { status: 400 })
  }

  const redPiece = pieces.find(p => p.faction === "red")
  const bluePiece = pieces.find(p => p.faction === "blue")

  if (!redPiece || !bluePiece) {
    return NextResponse.json({ error: "Must select 1 red and 1 blue piece" }, { status: 400 })
  }

  const roomId = crypto.randomUUID()
  const playerIds = [playerId.trim() + "-red", playerId.trim() + "-blue"]

  // 获取完整的PieceTemplate对象
  const pieceTemplates = pieces.map(piece => getPieceById(piece.templateId)).filter(Boolean)
  
  const battle = createInitialBattleForPlayers(playerIds, pieceTemplates)

  if (!battle) {
    return NextResponse.json({ error: "Failed to initialize battle state" }, { status: 500 })
  }

  const room: Room = {
    id: roomId,
    name: "对战房间",
    status: "in-progress",
    createdAt: Date.now(),
    maxPlayers: 2,
    players: playerIds.map((id, index) => ({
      id,
      name: index === 0 ? (playerName?.trim() || `Player ${playerId.slice(0, 8)}`) + " (红方)" : (playerName?.trim() || `Player ${playerId.slice(0, 8)}`) + " (蓝方)",
    })),
    currentTurnIndex: 0,
    actions: [],
    battleState: battle,
  }

  roomStore.setRoom(roomId, room)

  console.log('Battle room created with ID:', roomId)
  return NextResponse.json({ roomId, battle }, { status: 201 })
}
