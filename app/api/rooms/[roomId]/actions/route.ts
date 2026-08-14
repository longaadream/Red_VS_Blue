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
import { alignmentToPieceFaction, assignNextSeat, getPlayerSeat, normalizePlayerAlignment, getRoomStore } from "@/lib/game/room-store"
import { verifyJoinAuth } from "@/lib/game/identity-verify"
import { isMatchPlayerId } from "@/lib/game/match-identity"

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
    action?: "select-pieces" | "start-game" | "claim-faction" | "join" | "toggle-ready" | "leave"
    pieces?: Array<{ templateId: string; faction: string }>
  }) ?? {}
  const accountId = String((body as { accountId?: unknown; identityId?: unknown })?.accountId || (body as { accountId?: unknown; identityId?: unknown })?.identityId || '').trim().toLowerCase() || undefined
  const requestedAlignment = normalizePlayerAlignment((body as { alignment?: unknown })?.alignment)
  const requestedFirstPlayerId = String((body as { firstPlayerId?: unknown })?.firstPlayerId || '').trim().toLowerCase() || undefined

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  const roomStore = getRoomStore()
  let room = await roomStore.getRoom(roomId)
  if (!room) {
    if (action === "claim-faction" || action === "select-pieces") {
      room = await roomStore.createRoom(roomId, `Room ${roomId}`)
    } else {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }
  }

  if (action === "join") {
    const normalizedPlayerId = playerId?.trim().toLowerCase()
    const trimmedPlayerName = playerName?.trim()
    if (!normalizedPlayerId) {
      console.log('Missing playerId:', { playerId })
      return NextResponse.json({ error: "playerId is required" }, { status: 400 })
    }

    const authErr = await verifyJoinAuth(body as Record<string, unknown>)
    if (authErr) return NextResponse.json({ error: authErr }, { status: 401 })

    const latestRoom = await roomStore.getRoom(roomId)
    if (!latestRoom) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 })
    }

    const existing = latestRoom.players.find(
      (p) => p.id.toLowerCase() === normalizedPlayerId,
    )

    if (existing) {
      if (!getPlayerSeat(existing)) {
        const seat = assignNextSeat(latestRoom.players, normalizedPlayerId)
        existing.seat = seat
        existing.faction = seat
      }
      if (requestedAlignment) existing.alignment = requestedAlignment
      if (trimmedPlayerName) existing.name = trimmedPlayerName
      await roomStore.setRoom(roomId, latestRoom)
      console.log('Player rejoined room:', { roomId, playerId: normalizedPlayerId, faction: existing.faction, alignment: existing.alignment })
      return NextResponse.json(latestRoom)
    }

    if (latestRoom.status !== "waiting") {
      return NextResponse.json(
        { error: "Cannot join a game that has already started or finished" },
        { status: 400 }
      )
    }

    if (latestRoom.players.length >= (latestRoom.maxPlayers ?? 2)) {
      return NextResponse.json({ error: "Room is full" }, { status: 400 })
    }

    // Turn order (red/blue) is randomly assigned; ensure two players get opposite factions
    const seat = assignNextSeat(latestRoom.players, normalizedPlayerId)

    const player: Record<string, unknown> = {
      id: normalizedPlayerId,
      accountId,
      name: trimmedPlayerName || `Player ${normalizedPlayerId.slice(0, 8)}`,
      joinedAt: Date.now(),
      seat,
      faction: seat,
    }
    if (requestedAlignment) player.alignment = requestedAlignment
    if (accountId) player.accountId = accountId

    latestRoom.players.push(player as any)

    if (!latestRoom.hostId) {
      latestRoom.hostId = normalizedPlayerId
    }
    console.log('Player joined room:', { roomId, playerId: normalizedPlayerId, seat, alignment: player.alignment, totalPlayers: latestRoom.players.length })

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
        accountId,
        name: playerName?.trim() || `Player ${normalizedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
      }
      latestRoom.players.push(newPlayer)
      existingPlayer = newPlayer
    }

    if (accountId) existingPlayer.accountId = accountId
    if (requestedAlignment) existingPlayer.alignment = requestedAlignment

    if (getPlayerSeat(existingPlayer)) {
      await roomStore.setRoom(roomId, latestRoom)
      return NextResponse.json({ success: true, seat: getPlayerSeat(existingPlayer), faction: existingPlayer.faction, alignment: existingPlayer.alignment, message: "Seat already claimed" })
    }

    const seat = assignNextSeat(latestRoom.players, normalizedPlayerId)
    existingPlayer.seat = seat
    existingPlayer.faction = seat

    await roomStore.setRoom(roomId, latestRoom)
    return NextResponse.json({ success: true, seat, faction: seat, alignment: existingPlayer.alignment, message: `Seat ${seat} claimed successfully` })
  }

  if (action === "toggle-ready") {
    const latestRoom = await roomStore.getRoom(roomId)
    if (!latestRoom) return NextResponse.json({ error: "Room not found" }, { status: 404 })

    const normalizedPlayerId = playerId.trim().toLowerCase()
    const me = latestRoom.players.find(p => p.id.toLowerCase() === normalizedPlayerId)
    if (!me) return NextResponse.json({ error: "Player not in room" }, { status: 400 })

    me.ready = !me.ready
    // 当两人都准备就绪时切换为 'ready' 状态，让客户端轮询时检测到并跳转选人
    const allReady = latestRoom.players.length >= 2 && latestRoom.players.every(p => p.ready === true)
    if (allReady && latestRoom.status === "waiting") {
      latestRoom.status = "ready"
    } else if (!allReady && latestRoom.status === "ready") {
      latestRoom.status = "waiting"
    }
    await roomStore.setRoom(roomId, latestRoom)
    return NextResponse.json(latestRoom)
  }

  if (action === "leave") {
    const latestRoom = await roomStore.getRoom(roomId)
    if (!latestRoom) return NextResponse.json({ error: "Room not found" }, { status: 404 })

    const normalizedPlayerId = playerId.trim().toLowerCase()
    const before = latestRoom.players.length
    latestRoom.players = latestRoom.players.filter(p => p.id.toLowerCase() !== normalizedPlayerId)
    // 离开后房间剩 <2 人，回到 waiting，并清空其他人的 ready 状态
    if (latestRoom.players.length < 2 && latestRoom.status === "ready") {
      latestRoom.status = "waiting"
    }
    latestRoom.players.forEach(p => { p.ready = false })
    // 若离开的是主机，转移主机
    if (latestRoom.hostId && latestRoom.hostId.toLowerCase() === normalizedPlayerId && latestRoom.players.length > 0) {
      latestRoom.hostId = latestRoom.players[0].id
    }
    await roomStore.setRoom(roomId, latestRoom)
    return NextResponse.json({ success: true, left: before !== latestRoom.players.length, room: latestRoom })
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

    // Validate before mutating or persisting a player's selection.  A rejected
    // first-player choice must leave the room exactly as it was.
    if (requestedFirstPlayerId && !isMatchPlayerId(latestRoom.players.map(player => player.id), requestedFirstPlayerId)) {
      return NextResponse.json({ error: "firstPlayerId must identify a room player" }, { status: 400 })
    }

    const normalizedPlayerId = playerId.trim().toLowerCase()
    let targetPlayer = latestRoom.players.find(
      (p) => p.id.toLowerCase() === normalizedPlayerId
    )

    if (!targetPlayer) {
      const seat = assignNextSeat(latestRoom.players, normalizedPlayerId)
      targetPlayer = {
        id: normalizedPlayerId,
        accountId,
        name: playerName?.trim() || `Player ${normalizedPlayerId.slice(0, 8)}`,
        joinedAt: Date.now(),
        seat,
        faction: seat,
        ...(requestedAlignment ? { alignment: requestedAlignment } : {}),
        hasSelectedPieces: true,
        selectedPieces: pieces
      }
      latestRoom.players.push(targetPlayer)
    } else {
      if (accountId) targetPlayer.accountId = accountId
      targetPlayer.hasSelectedPieces = true
      targetPlayer.selectedPieces = pieces
      if (requestedAlignment) targetPlayer.alignment = requestedAlignment
      if (!getPlayerSeat(targetPlayer)) {
        const seat = assignNextSeat(latestRoom.players, normalizedPlayerId)
        targetPlayer.seat = seat
        targetPlayer.faction = seat
      }
    }

    if (!targetPlayer.alignment) {
      return NextResponse.json({ error: "alignment is required before selecting pieces" }, { status: 400 })
    }
    const requiredPieceFaction = alignmentToPieceFaction(targetPlayer.alignment)
    const hasWrongAlignmentPiece = pieces.some(piece => getPieceById(piece.templateId)?.faction !== requiredPieceFaction)
    if (hasWrongAlignmentPiece) {
      return NextResponse.json({ error: "Selected pieces must belong to the player's alignment" }, { status: 400 })
    }

    // PVE: auto-assign default pieces to the bot player
    const botPlayer = latestRoom.players.find((p: any) => p.isBot === true || p.id === 'bot')
    if (botPlayer && !botPlayer.hasSelectedPieces) {
      const humanIds = new Set(pieces.map(p => p.templateId))
      const allAvailable = getAllPieces()
      const botPieces = allAvailable
        .filter(p => !humanIds.has(p.id))
        .slice(0, pieces.length)
        .map(p => ({ templateId: p.id, faction: botPlayer.faction || 'blue' }))
      botPlayer.selectedPieces = botPieces.length > 0
        ? botPieces
        : allAvailable.slice(0, 3).map(p => ({ templateId: p.id, faction: 'blue' }))
      botPlayer.hasSelectedPieces = true
    }

    await roomStore.setRoom(roomId, latestRoom)

    const savedRoom = await roomStore.getRoom(roomId)
    if (!savedRoom) {
      console.error('ERROR: Failed to save room')
    }

    // Use DB-fresh savedRoom so we can see ALL players' piece selections, not just the current player's
    const checkRoom = savedRoom || latestRoom
    const allPlayersSelected = checkRoom.players.length >= 2 && checkRoom.players.every(p => p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0))

    if (allPlayersSelected) {
      console.log('=== ALL PLAYERS HAVE SELECTED PIECES, AUTO-STARTING GAME ===')

      const sortedPlayers = [...checkRoom.players.slice(0, 2)].sort((a, b) => {
        if (getPlayerSeat(a) === "red" && getPlayerSeat(b) === "blue") return -1
        if (getPlayerSeat(a) === "blue" && getPlayerSeat(b) === "red") return 1
        return 0
      })

      const playerIds = sortedPlayers.map(p => p.id)

      const playerSelectedPieces = sortedPlayers.map(player => {
        const playerPieceTemplates = player.selectedPieces?.map(piece => getPieceById(piece.templateId))
          .filter(Boolean) as PieceTemplate[] || []
        return { playerId: player.id, pieces: playerPieceTemplates, faction: getPlayerSeat(player) as 'red' | 'blue' | undefined }
      })

      let pieceTemplates = checkRoom.players
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

      const mapId = checkRoom.mapId || "large-battlefield"
      writeLog('[select-pieces] mapId from room: ' + mapId)

      try {
        if (requestedFirstPlayerId) checkRoom.firstPlayerId = requestedFirstPlayerId
        const firstPlayerId = checkRoom.firstPlayerId || (sortedPlayers.find(player => getPlayerSeat(player) === 'red') || sortedPlayers[0])?.id
        if (!firstPlayerId || !isMatchPlayerId(playerIds, firstPlayerId)) {
          return NextResponse.json({ error: "firstPlayerId must identify a room player" }, { status: 400 })
        }
        const battle = await createInitialBattleForPlayers(playerIds, pieceTemplates, playerSelectedPieces, mapId, { firstPlayerId })

        if (!battle) {
          return NextResponse.json({ error: "Failed to create battle: invalid player count or battle setup" }, { status: 500 })
        }

        // Apply beginPhase on server (triggers BATTLE_START, initialEffects 等)
        let initState = battle
        try {
          initState = applyBattleAction(battle, { type: "beginPhase" })
          console.log('[select-pieces] beginPhase applied successfully')
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error('[select-pieces] beginPhase failed:', msg)
          return NextResponse.json({ error: 'Failed to init battle phase: ' + msg }, { status: 500 })
        }

        // Strip skillsById (large static data, clients reload locally)
        const { skillsById: _sk, ...initPayload } = initState as any

        const seed = Math.floor(Math.random() * 4294967296)

        checkRoom.status = "in-progress"
        checkRoom.currentTurnIndex = 0
        checkRoom.battleState = {
          type: 'server-state',
          seed,
          state: initPayload,
        } as any

        await roomStore.setRoom(roomId, checkRoom)
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

    const playersWithFaction = latestRoom.players.filter(p => getPlayerSeat(p))
    if (playersWithFaction.length < 2) {
      return NextResponse.json({ error: "All players must claim a seat before starting the game" }, { status: 400 })
    }

    let pieceTemplates = latestRoom.players
      .flatMap(p => p.selectedPieces || [])
      .map(piece => getPieceById(piece.templateId))
      .filter(Boolean) as any[]

    const sortedPlayers = [...latestRoom.players.slice(0, 2)].sort((a, b) => {
      if (getPlayerSeat(a) === "red" && getPlayerSeat(b) === "blue") return -1
      if (getPlayerSeat(a) === "blue" && getPlayerSeat(b) === "red") return 1
      return 0
    })

    const playerIds = sortedPlayers.map(p => p.id)

    const playerSelectedPieces = sortedPlayers.map(player => {
      const playerPieceTemplates = player.selectedPieces?.map(piece => getPieceById(piece.templateId))
        .filter(Boolean) as PieceTemplate[] || []
      return { playerId: player.id, pieces: playerPieceTemplates, faction: getPlayerSeat(player) as 'red' | 'blue' | undefined }
    })

    if (pieceTemplates.length < 2) {
      const defaultPieces = getAllPieces()
      if (defaultPieces.length >= 2) {
        pieceTemplates.push(defaultPieces[0])
        pieceTemplates.push(defaultPieces[1])
      }
    }

    const mapId = latestRoom.mapId || "large-battlefield"
    writeLog('[start-game] mapId from room: ' + mapId)

    if (requestedFirstPlayerId) latestRoom.firstPlayerId = requestedFirstPlayerId
    const firstPlayerId = latestRoom.firstPlayerId || (sortedPlayers.find(player => getPlayerSeat(player) === 'red') || sortedPlayers[0])?.id
    if (!firstPlayerId || !playerIds.includes(firstPlayerId)) {
      return NextResponse.json({ error: "firstPlayerId must identify a room player" }, { status: 400 })
    }
    const battle = await createInitialBattleForPlayers(playerIds, pieceTemplates, playerSelectedPieces, mapId, { firstPlayerId })

    if (!battle) {
      return NextResponse.json({ error: "Failed to initialize battle state" }, { status: 500 })
    }

    let initState = battle
    try {
      initState = applyBattleAction(battle, { type: "beginPhase" })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[start-game] beginPhase failed:', msg)
      return NextResponse.json({ error: 'Failed to init battle phase: ' + msg }, { status: 500 })
    }
    const { skillsById: _sk2, ...initPayload2 } = initState as any
    const seed2 = Math.floor(Math.random() * 4294967296)

    latestRoom.status = "in-progress"
    latestRoom.currentTurnIndex = 0
    latestRoom.battleState = {
      type: 'server-state',
      seed: seed2,
      state: initPayload2,
    } as any
    await roomStore.setRoom(roomId, latestRoom)

    console.log('Game started successfully for room:', roomId)
    return NextResponse.json({ success: true, message: "Game started" })
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}
