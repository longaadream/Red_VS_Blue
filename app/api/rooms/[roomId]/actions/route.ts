import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getPieceById } from "@/lib/game/piece-repository"
import type { BattleState } from "@/lib/game/turn"
import roomStore, { type Room } from "@/lib/game/room-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const { roomId } = await params
  const { playerId, playerName, action, pieces } = (body as { 
    playerId?: string
    playerName?: string
    action?: "select-pieces" | "start-game"
    pieces?: Array<{ templateId: string; faction: string }>
  }) ?? {}

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  const room = roomStore.getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  if (action === "select-pieces") {
    if (!pieces || pieces.length === 0) {
      return NextResponse.json({ error: "Please select at least 1 piece" }, { status: 400 })
    }

    const existingPlayer = room.players.find(
      (p) => p.id === playerId.trim()
    )

    if (existingPlayer) {
      existingPlayer.selectedPieces = pieces
      existingPlayer.hasSelectedPieces = true
      roomStore.setRoom(roomId, room)
      return NextResponse.json({ success: true, message: "Pieces selected successfully" })
    }

    const newPlayer = {
      id: playerId.trim(),
      name: playerName?.trim() || `Player ${playerId.slice(0, 8)}`,
      joinedAt: Date.now(),
      selectedPieces: pieces,
      hasSelectedPieces: true,
    }

    room.players.push(newPlayer)
    roomStore.setRoom(roomId, room)

    return NextResponse.json({ success: true, message: "Player joined and pieces selected" })
  }

  if (action === "start-game") {
    if (room.status !== "waiting" && room.status !== "ready") {
      return NextResponse.json(
        { error: "Game is already in progress or finished" },
        { status: 400 },
      )
    }

    if (room.players.length < 2) {
      return NextResponse.json(
        { error: "At least 2 players are required to start game" },
        { status: 400 },
      )
    }

    // 总是使用房间中所有玩家的selectedPieces，确保包含所有玩家选择的棋子
    // 这样可以确保双方都有棋子进入游戏
    let pieceTemplates = room.players
      .flatMap(p => p.selectedPieces || [])
      .map(piece => getPieceById(piece.templateId))
      .filter(Boolean)
    
    console.log('All piece templates from players:', pieceTemplates.length)
    console.log('Players in room:', room.players.map(p => ({
      id: p.id,
      name: p.name,
      hasSelectedPieces: !!p.hasSelectedPieces,
      selectedPiecesCount: p.selectedPieces?.length || 0
    })))

    if (pieceTemplates.length < 2) {
      return NextResponse.json(
        { error: "Each player must select at least 1 piece" },
        { status: 400 },
      )
    }

    // 确保只使用前两个玩家，因为这是1v1游戏
    const playerIds = room.players.slice(0, 2).map(p => p.id)
    console.log('Creating battle for players:', playerIds)
    console.log('With piece templates:', pieceTemplates.length)
    const battle = createInitialBattleForPlayers(playerIds, pieceTemplates)

    if (!battle) {
      return NextResponse.json(
        { error: "Failed to initialize battle state" },
        { status: 500 },
      )
    }

    room.status = "in-progress"
    room.currentTurnIndex = 0
    room.battleState = battle
    roomStore.setRoom(roomId, room)

    return NextResponse.json({ success: true, message: "Game started" })
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}
