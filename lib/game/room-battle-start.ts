import { createInitialBattleForPlayers } from './battle-setup'
import { withoutServerSkills } from './battle-storage'
import { getPieceById } from './piece-repository'
import { assertDemoRostersReady, type RosterRoomStore } from './roster-contract'
import { getPlayerSeat, type Room } from './room-store'
import { applyBattleAction } from './turn'

export interface StartLockedRosterBattleOptions {
  firstPlayerId?: string
}

export interface StartLockedRosterBattleResult {
  room: Room
  started: boolean
}

export async function startBattleFromLockedRosters(
  store: RosterRoomStore,
  roomId: string,
  options: StartLockedRosterBattleOptions = {},
): Promise<StartLockedRosterBattleResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = await store.getRoom(roomId)
    if (!room) throw new Error('Room not found')
    if (room.status === 'in-progress' && room.battleState) return { room, started: false }

    assertDemoRostersReady(room)

    const roomPlayers = [...room.players.slice(0, 2)].sort((left, right) => {
      if (getPlayerSeat(left) === 'red' && getPlayerSeat(right) === 'blue') return -1
      if (getPlayerSeat(left) === 'blue' && getPlayerSeat(right) === 'red') return 1
      return 0
    })
    const playerIds = roomPlayers.map(player => player.id)
    const requestedFirstPlayerId = (options.firstPlayerId || room.firstPlayerId || '').trim().toLowerCase()
    const firstPlayerId = requestedFirstPlayerId ||
      (roomPlayers.find(player => getPlayerSeat(player) === 'red') || roomPlayers[0])?.id
    if (!firstPlayerId || !playerIds.includes(firstPlayerId)) {
      throw new Error('firstPlayerId must identify a room player')
    }

    const playerSelectedPieces = roomPlayers.map(player => ({
      playerId: player.id,
      pieces: (player.selectedPieces ?? []).map(piece => getPieceById(piece.templateId)!),
      faction: getPlayerSeat(player),
    }))
    const pieceTemplates = playerSelectedPieces.flatMap(player => player.pieces)
    const battle = await createInitialBattleForPlayers(
      playerIds,
      pieceTemplates,
      playerSelectedPieces,
      room.mapId || 'large-battlefield',
      { firstPlayerId },
    )
    if (!battle) throw new Error('Failed to initialize battle state')

    let initState = battle
    try {
      initState = applyBattleAction(battle, { type: 'beginPhase' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error('Failed to init battle phase: ' + message)
    }

    const nextRoom: Room = {
      ...room,
      firstPlayerId,
      status: 'in-progress',
      currentTurnIndex: 0,
      battleState: {
        type: 'server-state',
        seed: Math.floor(Math.random() * 4294967296),
        state: withoutServerSkills(initState),
      } as unknown as Room['battleState'],
    }

    if (typeof room.version === 'number') {
      if (!await store.setRoomIfVersion(roomId, nextRoom, room.version)) continue
    } else {
      await store.setRoom(roomId, nextRoom)
    }

    return { room: await store.getRoom(roomId) ?? nextRoom, started: true }
  }

  throw new Error('Battle could not start because the room changed concurrently')
}
