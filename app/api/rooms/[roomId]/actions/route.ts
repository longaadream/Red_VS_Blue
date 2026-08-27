import { NextRequest, NextResponse } from "next/server"
import { assignNextSeat, getPlayerSeat, normalizePlayerAlignment, getRoomStore } from "@/lib/game/room-store"
import { verifyJoinAuth } from "@/lib/game/identity-verify"
import {
  ensureRosterAlignmentMutable,
  getDemoRosterReadiness,
  getRosterErrorPayload,
  lockDefaultBotRosterInStore,
  lockDemoRosterInStore,
} from "@/lib/game/roster-contract"
import { assertSelectableMapId, getMapSelectionErrorPayload } from "@/lib/game/map-selection"
import { startBattleFromLockedRosters } from "@/lib/game/room-battle-start"
import { broadcastToRoom } from "@/lib/ws-server"
import { createPublicRoomSnapshot } from "@/lib/game/room-battle-actions"

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

  if (!playerId?.trim()) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 })
  }

  const roomStore = getRoomStore()
  const room = await roomStore.getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  const mutatesPrebattleRoom = action === "join"
    || action === "claim-faction"
    || action === "toggle-ready"
    || action === "leave"
    || action === "select-pieces"
    || action === "start-game"
  if (
    mutatesPrebattleRoom
    && (room.status !== 'in-progress' || !room.battleState)
  ) {
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
      try {
        ensureRosterAlignmentMutable(existing, requestedAlignment)
      } catch (error) {
        const rosterError = getRosterErrorPayload(error)
        return NextResponse.json({ success: false, error: rosterError?.message, code: rosterError?.code, context: rosterError?.context }, { status: 409 })
      }
      if (requestedAlignment) existing.alignment = requestedAlignment
      if (trimmedPlayerName) existing.name = trimmedPlayerName
      await roomStore.setRoom(roomId, latestRoom)
      console.log('Player rejoined room:', { roomId, playerId: normalizedPlayerId, faction: existing.faction, alignment: existing.alignment })
      return NextResponse.json(createPublicRoomSnapshot(latestRoom))
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
    return NextResponse.json(createPublicRoomSnapshot(latestRoom))
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
    try {
      ensureRosterAlignmentMutable(existingPlayer, requestedAlignment)
    } catch (error) {
      const rosterError = getRosterErrorPayload(error)
      return NextResponse.json({ success: false, error: rosterError?.message, code: rosterError?.code, context: rosterError?.context }, { status: 409 })
    }
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
    return NextResponse.json(createPublicRoomSnapshot(latestRoom))
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
    return NextResponse.json({ success: true, left: before !== latestRoom.players.length, room: createPublicRoomSnapshot(latestRoom) })
  }

  if (action === "select-pieces") {
    const normalizedPlayerId = playerId.trim().toLowerCase()
    let locked
    try {
      locked = await lockDemoRosterInStore(roomStore, roomId, {
        playerId: normalizedPlayerId,
        alignment: requestedAlignment,
        pieces,
      })
      await lockDefaultBotRosterInStore(roomStore, roomId)
    } catch (error) {
      const rosterError = getRosterErrorPayload(error)
      if (rosterError) {
        const status = rosterError.code === 'ROSTER_LOCKED' || rosterError.code === 'ROSTER_WRITE_CONFLICT' ? 409 : 400
        return NextResponse.json({ success: false, error: rosterError.message, code: rosterError.code, context: rosterError.context }, { status })
      }
      throw error
    }

    const checkRoom = await roomStore.getRoom(roomId) ?? locked.room
    const allPlayersSelected = getDemoRosterReadiness(checkRoom).ready

    if (allPlayersSelected) {
      try {
        await startBattleFromLockedRosters(roomStore, roomId, {
          onDeploymentUpdate: snapshot => broadcastToRoom(roomId, { type: 'stateUpdate', ...snapshot }),
        })
      } catch (error) {
        const mapError = getMapSelectionErrorPayload(error)
        if (mapError) {
          return NextResponse.json({ success: false, error: mapError.message, code: mapError.code, context: mapError.context }, { status: 400 })
        }
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
      duplicate: locked.duplicate,
      locked: true,
      manifestVersion: locked.manifestVersion,
      playerId: locked.playerId,
      selectedPiecesCount: locked.selectedPiecesCount,
      message: "Pieces selected successfully",
      player: {
        id: locked.playerId,
        hasSelectedPieces: true,
        selectedPiecesCount: locked.selectedPiecesCount
      },
      room: {
        id: finalRoom?.id,
        status: finalRoom?.status,
        players: finalRoom?.players.map(p => ({
          id: p.id,
          name: p.name,
          hasSelectedPieces: p.rosterLocked === true
        }))
      }
    })
  }

  if (action === "start-game") {
    try {
      const result = await startBattleFromLockedRosters(roomStore, roomId, {
        onDeploymentUpdate: snapshot => broadcastToRoom(roomId, { type: 'stateUpdate', ...snapshot }),
      })
      return NextResponse.json({ success: true, started: result.started, message: "Game started", room: createPublicRoomSnapshot(result.room) })
    } catch (error) {
      const rosterError = getRosterErrorPayload(error)
      if (rosterError) {
        return NextResponse.json({ success: false, error: rosterError.message, code: rosterError.code, context: rosterError.context }, { status: 400 })
      }
      const mapError = getMapSelectionErrorPayload(error)
      if (mapError) {
        return NextResponse.json({ success: false, error: mapError.message, code: mapError.code, context: mapError.context }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : String(error)
      return NextResponse.json({ success: false, error: message }, { status: message === 'Room not found' ? 404 : 400 })
    }
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}
