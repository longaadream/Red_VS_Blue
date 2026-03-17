import { NextRequest, NextResponse } from "next/server"
import fs from 'fs'
import path from 'path'

function writeLog(message: string) {
  const logDir = path.join(process.cwd(), 'logs')
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  const logFile = path.join(logDir, 'game.log')
  const timestamp = new Date().toISOString()
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`)
}

import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getPieceById, getAllPieces } from "@/lib/game/piece-repository"
import type { BattleState } from "@/lib/game/turn"
import { applyBattleAction } from "@/lib/game/turn"
import type { PieceTemplate } from "@/lib/game/piece"
import { getRoomStore } from "@/lib/game/room-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const { playerId, playerName, action, pieces } = (body as {
    playerId?: string
    playerName?: string
    action?: "select-pieces" | "start-game" | "claim-faction" | "join"
    pieces?: Array<{ templateId: string; faction: string }>
  }) ?? {}

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  const roomStore = getRoomStore()
  const room = await roomStore.getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  if (action === "join") {
    const normalizedPlayerId = playerId?.trim().toLowerCase()
    const trimmedPlayerName = playerName?.trim()
    if (!normalizedPlayerId) {
      console.log('Missing playerId:', { playerId })
      return NextResponse.json({ error: "playerId is required" }, { status: 400 })
    }

    const latestRoom = await roomStore.getRoom(roomId)
    if (!latestRoom) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    if (latestRoom.status !== "waiting") {
      return NextResponse.json(
        { error: "Cannot join a game that has already started or finished" },
        { status: 400 }
      )
    }

    if (latestRoom.players.length >= latestRoom.maxPlayers) {
      return NextResponse.json({ error: "Room is full" }, { status: 400 })
    }

    const existing = latestRoom.players.find(
      (p) => p.id.toLowerCase() === normalizedPlayerId,
    )

    if (!existing) {
      const player = {
        id: normalizedPlayerId,
        name: trimmedPlayerName || `Player ${normalizedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      latestRoom.players.push(player)

      if (!latestRoom.hostId) {
        latestRoom.hostId = normalizedPlayerId
      }
      console.log('Player joined room:', { roomId, playerId: normalizedPlayerId, totalPlayers: latestRoom.players.length })
    } else {
      console.log('Player already in room:', { roomId, playerId: normalizedPlayerId })
    }

    await roomStore.setRoom(roomId, latestRoom)
    return NextResponse.json(latestRoom)
  }

  if (action === "claim-faction") {
    const latestRoom = await roomStore.getRoom(roomId)
    if (!latestRoom) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    console.log('Claim faction request received:', { roomId, playerId, playerName })

    const normalizedPlayerId = playerId.trim().toLowerCase()
    let existingPlayer = latestRoom.players.find(
      (p) => p.id.toLowerCase() === normalizedPlayerId
    )

    if (!existingPlayer) {
      const newPlayer = {
        id: normalizedPlayerId,
        name: playerName?.trim() || `Player ${normalizedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      latestRoom.players.push(newPlayer)
      existingPlayer = newPlayer
    }

    if (existingPlayer.faction) {
      return NextResponse.json({ success: true, faction: existingPlayer.faction, message: "Faction already claimed" })
    }

    const assignedFactions = latestRoom.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">

    if (assignedFactions.length >= 2) {
      return NextResponse.json({ error: "All factions are already claimed" }, { status: 400 })
    }

    let faction: "red" | "blue";
    if (assignedFactions.length === 0) {
      faction = Math.random() > 0.5 ? "red" : "blue"
    } else {
      faction = assignedFactions[0] === "red" ? "blue" : "red"
    }

    existingPlayer.faction = faction

    await roomStore.setRoom(roomId, latestRoom)
    return NextResponse.json({ success: true, faction, message: `Faction ${faction} claimed successfully` })
  }

  if (action === "select-pieces") {
    console.log('=== FORCE SELECT PIECES ACTION ===')
    console.log('Request received:', { roomId, playerId, piecesCount: pieces?.length || 0 })

    if (!pieces || pieces.length === 0) {
      return NextResponse.json({ error: "Please select at least 1 piece" }, { status: 400 })
    }

    let latestRoom = await roomStore.getRoom(roomId)
    if (!latestRoom) {
      console.log('Room not found, creating new room:', roomId)
      latestRoom = await roomStore.createRoom(roomId, `Room ${roomId}`)
    }

    const normalizedPlayerId = playerId.trim().toLowerCase()
    let targetPlayer = latestRoom.players.find(
      (p) => p.id.toLowerCase() === normalizedPlayerId
    )

    if (!targetPlayer) {
      const assignedFactions = latestRoom.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">
      let faction: "red" | "blue" = "red"
      if (assignedFactions.length > 0) {
        faction = assignedFactions[0] === "red" ? "blue" : "red"
      }
      targetPlayer = {
        id: normalizedPlayerId,
        name: playerName?.trim() || `Player ${normalizedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
        faction,
        hasSelectedPieces: true,
        selectedPieces: pieces
      }
      latestRoom.players.push(targetPlayer)
    } else {
      targetPlayer.hasSelectedPieces = true
      targetPlayer.selectedPieces = pieces
      if (!targetPlayer.faction) {
        const assignedFactions = latestRoom.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">
        let faction: "red" | "blue" = "red"
        if (assignedFactions.length > 0) {
          faction = assignedFactions[0] === "red" ? "blue" : "red"
        }
        targetPlayer.faction = faction
      }
    }

    await roomStore.setRoom(roomId, latestRoom)

    const savedRoom = await roomStore.getRoom(roomId)
    if (!savedRoom) {
      console.error('ERROR: Failed to save room')
    }

    const allPlayersSelected = latestRoom.players.length >= 2 && latestRoom.players.every(p => p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0))

    if (allPlayersSelected) {
      console.log('=== ALL PLAYERS HAVE SELECTED PIECES, AUTO-STARTING GAME ===')

      const sortedPlayers = [...latestRoom.players.slice(0, 2)].sort((a, b) => {
        if (a.faction === "red" && b.faction === "blue") return -1
        if (a.faction === "blue" && b.faction === "red") return 1
        return 0
      })

      const playerIds = sortedPlayers.map(p => p.id)

      const playerSelectedPieces = sortedPlayers.map(player => {
        const playerPieceTemplates = player.selectedPieces?.map(piece => getPieceById(piece.templateId))
          .filter(Boolean) as PieceTemplate[] || []
        return { playerId: player.id, pieces: playerPieceTemplates }
      })

      let pieceTemplates = latestRoom.players
        .flatMap(p => p.selectedPieces || [])
        .map(piece => getPieceById(piece.templateId))
        .filter(Boolean) as any[]

      if (pieceTemplates.length < 2) {
        const defaultPieces = getAllPieces()
        if (defaultPieces.length >= 2) {
          pieceTemplates.push(defaultPieces[0])
          pieceTemplates.push(defaultPieces[1])
        }
      }

      const mapId = latestRoom.mapId || "arena-8x6"
      writeLog('[select-pieces] mapId from room: ' + mapId)

      try {
        const battle = await createInitialBattleForPlayers(playerIds, pieceTemplates, playerSelectedPieces, mapId)

        if (!battle) {
          return NextResponse.json({ error: "Failed to create battle: invalid player count or battle setup" }, { status: 500 })
        }

        writeLog('[select-pieces] Battle created, calling beginPhase')
        try {
          const battleWithRules = applyBattleAction(battle, { type: "beginPhase" })
          latestRoom.status = "in-progress"
          latestRoom.currentTurnIndex = 0
          latestRoom.battleState = battleWithRules
        } catch (beginPhaseError) {
          writeLog('[select-pieces] ERROR in beginPhase: ' + (beginPhaseError instanceof Error ? beginPhaseError.message : 'Unknown error'))
          latestRoom.status = "in-progress"
          latestRoom.currentTurnIndex = 0
          latestRoom.battleState = battle
        }

        await roomStore.setRoom(roomId, latestRoom)
      } catch (error) {
        console.error('Error starting game:', error)
        return NextResponse.json(
          { error: `Failed to start game: ${error instanceof Error ? error.message : 'Unknown error'}` },
          { status: 500 }
        )
      }
    }

    const finalRoom = await roomStore.getRoom(roomId)

    return NextResponse.json({
      success: true,
      message: "Pieces selected successfully",
      player: {
        id: targetPlayer.id,
        hasSelectedPieces: true,
        selectedPiecesCount: pieces.length
      },
      room: {
        id: finalRoom?.id,
        status: finalRoom?.status,
        players: finalRoom?.players.map(p => ({
          id: p.id,
          name: p.name,
          hasSelectedPieces: p.hasSelectedPieces || false
        }))
      }
    })
  }

  if (action === "start-game") {
    const latestRoom = await roomStore.getRoom(roomId)
    if (!latestRoom) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    console.log('Start game request received:', {
      roomId,
      playerId,
      roomStatus: latestRoom.status,
      playersCount: latestRoom.players.length,
    })

    if (latestRoom.status !== "waiting" && latestRoom.status !== "ready") {
      return NextResponse.json({ error: "Game is already in progress or finished" }, { status: 400 })
    }

    if (latestRoom.players.length < 2) {
      return NextResponse.json({ error: "At least 2 players are required to start game" }, { status: 400 })
    }

    const playersWithFaction = latestRoom.players.filter(p => p.faction)
    if (playersWithFaction.length < 2) {
      return NextResponse.json({ error: "All players must claim a faction before starting the game" }, { status: 400 })
    }

    let pieceTemplates = latestRoom.players
      .flatMap(p => p.selectedPieces || [])
      .map(piece => getPieceById(piece.templateId))
      .filter(Boolean) as any[]

    const sortedPlayers = [...latestRoom.players.slice(0, 2)].sort((a, b) => {
      if (a.faction === "red" && b.faction === "blue") return -1
      if (a.faction === "blue" && b.faction === "red") return 1
      return 0
    })

    const playerIds = sortedPlayers.map(p => p.id)

    const playerSelectedPieces = sortedPlayers.map(player => {
      const playerPieceTemplates = player.selectedPieces?.map(piece => getPieceById(piece.templateId))
        .filter(Boolean) as PieceTemplate[] || []
      return { playerId: player.id, pieces: playerPieceTemplates }
    })

    if (pieceTemplates.length < 2) {
      const defaultPieces = getAllPieces()
      if (defaultPieces.length >= 2) {
        pieceTemplates.push(defaultPieces[0])
        pieceTemplates.push(defaultPieces[1])
      }
    }

    const mapId = latestRoom.mapId || "arena-8x6"
    writeLog('[start-game] mapId from room: ' + mapId)

    const battle = await createInitialBattleForPlayers(playerIds, pieceTemplates, playerSelectedPieces, mapId)

    if (!battle) {
      return NextResponse.json({ error: "Failed to initialize battle state" }, { status: 500 })
    }

    latestRoom.status = "in-progress"
    latestRoom.currentTurnIndex = 0
    latestRoom.battleState = battle
    await roomStore.setRoom(roomId, latestRoom)

    console.log('Game started successfully for room:', roomId)
    return NextResponse.json({ success: true, message: "Game started" })
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}
