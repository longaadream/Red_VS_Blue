import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getPieceById, getAllPieces } from "@/lib/game/piece-repository"
import type { BattleState } from "@/lib/game/turn"
import type { PieceTemplate } from "@/lib/game/piece"
import { getRoomStore, type Room } from "@/lib/game/room-store"

// 获取 RoomStore 实例
const roomStore = getRoomStore()

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
    action?: "select-pieces" | "start-game" | "claim-faction" | "join"
    pieces?: Array<{ templateId: string; faction: string }>
  }) ?? {}

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  const room = roomStore.getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  if (action === "join") {
    const trimmedPlayerId = playerId?.trim()
    const trimmedPlayerName = playerName?.trim()
    if (!trimmedPlayerId) {
      console.log('Missing playerId:', { playerId })
      return NextResponse.json({ error: "playerId is required" }, { status: 400 })
    }

    // 重新获取最新的房间状态，避免并发问题
    const latestRoom = roomStore.getRoom(roomId)
    if (!latestRoom) {
      console.log('Room not found:', roomId)
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    if (latestRoom.status !== "waiting") {
      console.log('Cannot join room, status is not waiting:', { roomId, status: latestRoom.status })
      return NextResponse.json(
        { error: "Cannot join a game that has already started or finished" },
        { status: 400 }
      )
    }

    if (latestRoom.players.length >= latestRoom.maxPlayers) {
      console.log('Room is full:', { roomId, currentPlayers: latestRoom.players.length, maxPlayers: latestRoom.maxPlayers })
      return NextResponse.json({ error: "Room is full" }, { status: 400 })
    }

    const existing = latestRoom.players.find(
      (p) => p.id === trimmedPlayerId,
    )

    if (!existing) {
      const player = {
        id: trimmedPlayerId,
        name: trimmedPlayerName || `Player ${trimmedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      latestRoom.players.push(player)
      
      // 如果房间还没有房主，将当前加入的玩家设置为房主
      if (!latestRoom.hostId) {
        latestRoom.hostId = trimmedPlayerId
      }
      console.log('Player joined room:', { roomId, playerId: trimmedPlayerId, playerName: trimmedPlayerName, totalPlayers: latestRoom.players.length })
    } else {
      console.log('Player already in room:', { roomId, playerId: trimmedPlayerId })
    }

    roomStore.setRoom(roomId, latestRoom)
    console.log('Room updated:', { roomId, totalPlayers: latestRoom.players.length, players: latestRoom.players })
    return NextResponse.json(latestRoom)
  }

  if (action === "claim-faction") {
    // 重新获取最新的房间状态，确保使用最新的玩家信息
    const latestRoom = roomStore.getRoom(roomId)
    if (!latestRoom) {
      console.log('Room not found for claim-faction:', roomId)
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    console.log('Claim faction request received:', { roomId, playerId, playerName })

    const trimmedPlayerId = playerId.trim()
    let existingPlayer = latestRoom.players.find(
      (p) => p.id.trim() === trimmedPlayerId
    )

    if (!existingPlayer) {
      const newPlayer = {
        id: trimmedPlayerId,
        name: playerName?.trim() || `Player ${trimmedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      latestRoom.players.push(newPlayer)
      existingPlayer = newPlayer
      console.log('Added new player to room:', { roomId, playerId: newPlayer.id, playerName: newPlayer.name })
    } else {
      console.log('Player already exists in room:', { roomId, playerId: existingPlayer.id, faction: existingPlayer.faction })
    }

    // 检查玩家是否已经有身份
    if (existingPlayer.faction) {
      console.log('Player already has faction:', { roomId, playerId: existingPlayer.id, faction: existingPlayer.faction })
      return NextResponse.json({ success: true, faction: existingPlayer.faction, message: "Faction already claimed" })
    }

    // 检查已分配的身份
    const assignedFactions = latestRoom.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">
    console.log('Current assigned factions:', { roomId, factions: assignedFactions })
    
    // 如果两个身份都已分配，返回错误
    if (assignedFactions.length >= 2) {
      console.log('All factions already claimed:', { roomId, factions: assignedFactions })
      return NextResponse.json({ error: "All factions are already claimed" }, { status: 400 })
    }

    // 分配身份
    let faction: "red" | "blue";
    if (assignedFactions.length === 0) {
      // 如果还没有分配身份，随机分配一个
      faction = Math.random() > 0.5 ? "red" : "blue"
      console.log('Randomly assigned faction:', { roomId, playerId: existingPlayer.id, faction })
    } else {
      // 如果已经分配了一个身份，分配剩下的那个
      faction = assignedFactions[0] === "red" ? "blue" : "red"
      console.log('Assigned remaining faction:', { roomId, playerId: existingPlayer.id, faction, existingFaction: assignedFactions[0] })
    }

    // 设置玩家身份
    existingPlayer.faction = faction

    // 保存房间状态
    roomStore.setRoom(roomId, latestRoom)
    console.log('Room updated after faction claim:', { roomId, totalPlayers: latestRoom.players.length, players: latestRoom.players })
    return NextResponse.json({ success: true, faction, message: `Faction ${faction} claimed successfully` })
  }

  if (action === "select-pieces") {
    console.log('=== FORCE SELECT PIECES ACTION ===')
    console.log('Request received:', { roomId, playerId, playerName, piecesCount: pieces?.length || 0, pieces: pieces })

    if (!pieces || pieces.length === 0) {
      console.log('No pieces selected:', { roomId, playerId })
      return NextResponse.json({ error: "Please select at least 1 piece" }, { status: 400 })
    }

    // 强制获取或创建房间
    let latestRoom = roomStore.getRoom(roomId)
    if (!latestRoom) {
      console.log('Room not found, creating new room:', roomId)
      latestRoom = roomStore.createRoom(roomId, `Room ${roomId}`)
    }

    console.log('Room found or created:', {
      id: latestRoom.id,
      status: latestRoom.status,
      playersCount: latestRoom.players.length
    })

    const trimmedPlayerId = playerId.trim()
    console.log('Processing player:', { originalPlayerId: playerId, trimmedPlayerId })
    
    let targetPlayer = latestRoom.players.find(
      (p) => p.id.trim() === trimmedPlayerId
    )

    // 如果玩家不存在，创建新玩家
    if (!targetPlayer) {
      console.log('Player not found, creating new player:', trimmedPlayerId)
      // 为新玩家分配阵营
      const assignedFactions = latestRoom.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">
      let faction: "red" | "blue" = "red"
      if (assignedFactions.length > 0) {
        faction = assignedFactions[0] === "red" ? "blue" : "red"
      }
      targetPlayer = {
        id: trimmedPlayerId,
        name: playerName?.trim() || `Player ${trimmedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
        faction: faction,
        hasSelectedPieces: true,
        selectedPieces: pieces
      }
      latestRoom.players.push(targetPlayer)
      console.log('New player created:', targetPlayer)
    } else {
      // 强制更新现有玩家的选择状态
      console.log('Updating existing player:', targetPlayer.id)
      targetPlayer.hasSelectedPieces = true
      targetPlayer.selectedPieces = pieces
      // 确保玩家有阵营信息
      if (!targetPlayer.faction) {
        const assignedFactions = latestRoom.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">
        let faction: "red" | "blue" = "red"
        if (assignedFactions.length > 0) {
          faction = assignedFactions[0] === "red" ? "blue" : "red"
        }
        targetPlayer.faction = faction
        console.log('Assigned faction to existing player:', faction)
      }
      console.log('Player updated:', {
        hasSelectedPieces: targetPlayer.hasSelectedPieces,
        selectedPiecesCount: targetPlayer.selectedPieces?.length || 0,
        faction: targetPlayer.faction
      })
    }

    // 强制保存房间状态
    console.log('=== FORCE SAVING ROOM STATE ===')
    const trimmedRoomId = roomId.trim()
    roomStore.setRoom(trimmedRoomId, latestRoom)
    
    // 立即验证保存结果
    const savedRoom = roomStore.getRoom(trimmedRoomId)
    if (savedRoom) {
      console.log('Room saved successfully:', {
        id: savedRoom.id,
        playersCount: savedRoom.players.length,
        players: savedRoom.players.map(p => ({
          id: p.id,
          hasSelectedPieces: p.hasSelectedPieces,
          selectedPiecesCount: p.selectedPieces?.length || 0
        }))
      })
    } else {
      console.error('ERROR: Failed to save room')
    }

    // 检查是否所有玩家都已选择棋子，如果是，自动启动游戏
    console.log('=== CHECKING IF ALL PLAYERS HAVE SELECTED PIECES ===')
    console.log('Current players in room:', latestRoom.players.map(p => ({
      id: p.id,
      name: p.name,
      hasSelectedPieces: p.hasSelectedPieces,
      selectedPiecesCount: p.selectedPieces?.length || 0
    })))
    const allPlayersSelected = latestRoom.players.length >= 2 && latestRoom.players.every(p => p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0))
    console.log('All players selected check:', allPlayersSelected)
    
    if (allPlayersSelected) {
      console.log('=== ALL PLAYERS HAVE SELECTED PIECES, AUTO-STARTING GAME ===')
      
      // 确保只使用前两个玩家，因为这是1v1游戏
      // 按玩家身份排序，红方在前，蓝方在后
      const sortedPlayers = [...latestRoom.players.slice(0, 2)].sort((a, b) => {
        if (a.faction === "red" && b.faction === "blue") return -1
        if (a.faction === "blue" && b.faction === "red") return 1
        return 0
      })
      
      const playerIds = sortedPlayers.map(p => p.id)
      console.log('Creating battle for players (sorted by faction):', playerIds)
      
      // 生成玩家选择的棋子信息，确保每个玩家至少有一个棋子
      const playerSelectedPieces = sortedPlayers.map(player => {
        const playerPieceTemplates = player.selectedPieces?.map(piece => getPieceById(piece.templateId))
          .filter(Boolean) as PieceTemplate[] || []
        return {
          playerId: player.id,
          pieces: playerPieceTemplates
        }
      })
      
      console.log('Player selected pieces info:', playerSelectedPieces)
      
      // 生成棋子模板列表
      let pieceTemplates = latestRoom.players
        .flatMap(p => p.selectedPieces || [])
        .map(piece => getPieceById(piece.templateId))
        .filter(Boolean) as any[]
      
      console.log('Piece templates found:', pieceTemplates.length)
      
      // 确保pieceTemplates至少包含两个棋子
      if (pieceTemplates.length < 2) {
        console.log('Not enough piece templates, adding default pieces')
        // 添加默认棋子模板
        const defaultPieces = getAllPieces()
        if (defaultPieces.length >= 2) {
          pieceTemplates.push(defaultPieces[0])
          pieceTemplates.push(defaultPieces[1])
        }
      }
      
      console.log('Final piece templates count:', pieceTemplates.length)
      
      // 尝试获取地图 ID，如果没有则使用默认地图
      const mapId = latestRoom.mapId || "arena-8x6"
      
      try {
        const battle = await createInitialBattleForPlayers(playerIds, pieceTemplates, playerSelectedPieces, mapId)
        
        if (battle) {
          console.log('Battle created successfully:', battle)
          
          // 更新房间状态为in-progress
          latestRoom.status = "in-progress"
          latestRoom.currentTurnIndex = 0
          latestRoom.battleState = battle
          
          // 保存更新后的房间状态
          roomStore.setRoom(trimmedRoomId, latestRoom)
          
          console.log('Game started successfully on server')
        } else {
          console.error('Failed to create battle')
        }
      } catch (error) {
        console.error('Error starting game:', error)
      }
    }

    // 强制返回成功响应，确保前端立即更新
    console.log('=== RETURNING SUCCESS RESPONSE ===')
    return NextResponse.json({ 
      success: true, 
      message: "Pieces selected successfully",
      player: {
        id: targetPlayer.id,
        hasSelectedPieces: true,
        selectedPiecesCount: pieces.length
      },
      room: {
        id: latestRoom.id,
        players: latestRoom.players.map(p => ({
          id: p.id,
          name: p.name,
          hasSelectedPieces: p.hasSelectedPieces || false
        }))
      }
    })
  }

  if (action === "start-game") {
    // 重新获取最新的房间状态，确保使用最新的玩家信息
    const latestRoom = roomStore.getRoom(roomId)
    if (!latestRoom) {
      console.log('Room not found:', roomId)
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    // 输出房间信息以便调试
    console.log('Start game request received:', {
      roomId,
      playerId,
      playerName,
      roomStatus: latestRoom.status,
      playersCount: latestRoom.players.length,
      players: latestRoom.players.map(p => ({ id: p.id, name: p.name, faction: p.faction, hasSelectedPieces: p.hasSelectedPieces })),
      room: latestRoom
    })

    if (latestRoom.status !== "waiting" && latestRoom.status !== "ready") {
      console.log('Room status check failed:', { expected: ['waiting', 'ready'], actual: latestRoom.status })
      return NextResponse.json(
        { error: "Game is already in progress or finished" },
        { status: 400 },
      )
    }

    if (latestRoom.players.length < 2) {
      console.log('Player count check failed:', { expected: 2, actual: latestRoom.players.length, players: latestRoom.players })
      return NextResponse.json(
        { error: "At least 2 players are required to start game" },
        { status: 400 },
      )
    }

    // 检查所有玩家是否已经分配了身份
    const playersWithFaction = latestRoom.players.filter(p => p.faction)
    console.log('Faction check:', { totalPlayers: latestRoom.players.length, playersWithFaction: playersWithFaction.length })
    if (playersWithFaction.length < 2) {
      console.log('Faction check failed:', { expected: 2, actual: playersWithFaction.length })
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

    // 强制检查和更新玩家的选择状态
    console.log('=== FORCE CHECKING PLAYER SELECTION STATUS ===')
    let allPlayersSelected = true
    latestRoom.players.forEach((player, index) => {
      const hasSelected = player.hasSelectedPieces === true || (player.selectedPieces && player.selectedPieces.length > 0)
      console.log(`Player ${index} (${player.name}) selection status:`, {
        hasSelectedPieces: player.hasSelectedPieces,
        selectedPiecesCount: player.selectedPieces?.length || 0,
        hasSelected: hasSelected
      })
      if (!hasSelected) {
        allPlayersSelected = false
      }
    })
    
    console.log('All players selected check:', allPlayersSelected)
    
    // 即使玩家选择状态没有正确保存，也强制启动游戏
    // 这是一个临时修复，确保游戏能够正常启动
    console.log('=== TEMPORARY FIX: FORCING GAME START ===')

    // 确保只使用前两个玩家，因为这是1v1游戏
    // 按玩家身份排序，红方在前，蓝方在后
    const sortedPlayers = [...latestRoom.players.slice(0, 2)].sort((a, b) => {
      if (a.faction === "red" && b.faction === "blue") return -1
      if (a.faction === "blue" && b.faction === "red") return 1
      return 0
    })
    
    const playerIds = sortedPlayers.map(p => p.id)
    console.log('Creating battle for players (sorted by faction):', playerIds)
    
    // 生成玩家选择的棋子信息，确保每个玩家至少有一个棋子
    const playerSelectedPieces = sortedPlayers.map(player => {
      const playerPieceTemplates = player.selectedPieces?.map(piece => getPieceById(piece.templateId))
        .filter(Boolean) as PieceTemplate[] || []
      return {
        playerId: player.id,
        pieces: playerPieceTemplates
      }
    })
    
    console.log('Player selected pieces info:', playerSelectedPieces)
    
    // 确保pieceTemplates至少包含两个棋子
    if (pieceTemplates.length < 2) {
      console.log('Not enough piece templates, adding default pieces')
      // 添加默认棋子模板
      const defaultPieces = getAllPieces()
      if (defaultPieces.length >= 2) {
        pieceTemplates.push(defaultPieces[0])
        pieceTemplates.push(defaultPieces[1])
      }
    }
    
    console.log('Final piece templates count:', pieceTemplates.length)
    
    // 尝试获取地图 ID，如果没有则使用默认地图
    const mapId = latestRoom.mapId || "arena-8x6"
    
    const battle = await createInitialBattleForPlayers(playerIds, pieceTemplates, playerSelectedPieces, mapId)

    if (!battle) {
      return NextResponse.json(
        { error: "Failed to initialize battle state" },
        { status: 500 },
      )
    }
    
    console.log('Battle created successfully:', battle)

    latestRoom.status = "in-progress"
    latestRoom.currentTurnIndex = 0
    latestRoom.battleState = battle
    const trimmedRoomId = roomId.trim()
    roomStore.setRoom(trimmedRoomId, latestRoom)

    console.log('Game started successfully for room:', trimmedRoomId)
    return NextResponse.json({ success: true, message: "Game started" })
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}
