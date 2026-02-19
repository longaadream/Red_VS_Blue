import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getPieceById } from "@/lib/game/piece-repository"
import type { BattleState } from "@/lib/game/turn"
import type { PieceTemplate } from "@/lib/game/piece"
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
    action?: "select-pieces" | "start-game" | "claim-faction"
    pieces?: Array<{ templateId: string; faction: string }>
  }) ?? {}

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  const room = roomStore.getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  if (action === "claim-faction") {
    // 重新获取最新的房间状态，确保使用最新的玩家信息
    const latestRoom = roomStore.getRoom(roomId)
    if (!latestRoom) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    let existingPlayer = latestRoom.players.find(
      (p) => p.id === playerId.trim()
    )

    if (!existingPlayer) {
      const newPlayer = {
        id: playerId.trim(),
        name: playerName?.trim() || `Player ${playerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      latestRoom.players.push(newPlayer)
      existingPlayer = newPlayer
    }

    // 检查玩家是否已经有身份
    if (existingPlayer.faction) {
      return NextResponse.json({ success: true, faction: existingPlayer.faction, message: "Faction already claimed" })
    }

    // 检查已分配的身份
    const assignedFactions = latestRoom.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">
    
    // 如果两个身份都已分配，返回错误
    if (assignedFactions.length >= 2) {
      return NextResponse.json({ error: "All factions are already claimed" }, { status: 400 })
    }

    // 分配身份
    let faction: "red" | "blue";
    if (assignedFactions.length === 0) {
      // 如果还没有分配身份，随机分配一个
      faction = Math.random() > 0.5 ? "red" : "blue"
    } else {
      // 如果已经分配了一个身份，分配剩下的那个
      faction = assignedFactions[0] === "red" ? "blue" : "red"
    }

    // 设置玩家身份
    existingPlayer.faction = faction

    // 保存房间状态
    roomStore.setRoom(roomId, latestRoom)
    return NextResponse.json({ success: true, faction, message: `Faction ${faction} claimed successfully` })
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
    // 重新获取最新的房间状态，确保使用最新的玩家信息
    const latestRoom = roomStore.getRoom(roomId)
    if (!latestRoom) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    if (latestRoom.status !== "waiting" && latestRoom.status !== "ready") {
      return NextResponse.json(
        { error: "Game is already in progress or finished" },
        { status: 400 },
      )
    }

    if (latestRoom.players.length < 2) {
      return NextResponse.json(
        { error: "At least 2 players are required to start game" },
        { status: 400 },
      )
    }

    // 检查所有玩家是否已经分配了身份
    const playersWithFaction = latestRoom.players.filter(p => p.faction)
    if (playersWithFaction.length < 2) {
      return NextResponse.json(
        { error: "All players must claim a faction before starting the game" },
        { status: 400 },
      )
    }

    // 总是使用房间中所有玩家的selectedPieces，确保包含所有玩家选择的棋子
    // 这样可以确保双方都有棋子进入游戏
    let pieceTemplates = latestRoom.players
      .flatMap(p => p.selectedPieces || [])
      .map(piece => getPieceById(piece.templateId))
      .filter(Boolean) as any[]
    
    console.log('Piece templates found:', pieceTemplates.length)
    console.log('Piece templates details:', pieceTemplates)
    
    console.log('All piece templates from players:', pieceTemplates.length)
    console.log('Players in room:', latestRoom.players.map(p => ({
      id: p.id,
      name: p.name,
      hasSelectedPieces: !!p.hasSelectedPieces,
      selectedPiecesCount: p.selectedPieces?.length || 0
    })))

    // 检查每个玩家是否至少选择了一个棋子
    const playersWithPieces = latestRoom.players.filter(p => p.selectedPieces && p.selectedPieces.length > 0)
    if (playersWithPieces.length < 2) {
      return NextResponse.json(
        { error: "Each player must select at least 1 piece" },
        { status: 400 },
      )
    }

    if (pieceTemplates.length < 2) {
      return NextResponse.json(
        { error: "At least 2 pieces are required to start game" },
        { status: 400 },
      )
    }

    // 确保只使用前两个玩家，因为这是1v1游戏
    // 按玩家身份排序，红方在前，蓝方在后
    const sortedPlayers = [...latestRoom.players.slice(0, 2)].sort((a, b) => {
      if (a.faction === "red" && b.faction === "blue") return -1
      if (a.faction === "blue" && b.faction === "red") return 1
      return 0
    })
    
    const playerIds = sortedPlayers.map(p => p.id)
    console.log('Creating battle for players (sorted by faction):', playerIds)
    
    const playerSelectedPieces = sortedPlayers.map(player => {
      const playerPieceTemplates = player.selectedPieces?.map(piece => getPieceById(piece.templateId))
        .filter(Boolean) as PieceTemplate[] || []
      return {
        playerId: player.id,
        pieces: playerPieceTemplates
      }
    }).filter(playerInfo => playerInfo.pieces.length > 0)
    
    console.log('Player selected pieces info:', playerSelectedPieces)
    
    const battle = createInitialBattleForPlayers(playerIds, pieceTemplates, playerSelectedPieces)

    if (!battle) {
      return NextResponse.json(
        { error: "Failed to initialize battle state" },
        { status: 500 },
      )
    }

    latestRoom.status = "in-progress"
    latestRoom.currentTurnIndex = 0
    latestRoom.battleState = battle
    roomStore.setRoom(roomId, latestRoom)

    return NextResponse.json({ success: true, message: "Game started" })
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}
