import { createInitialBattleForPlayers } from './battle-setup'
import { runBattleAction } from './battle-runner'
import { withoutServerSkills } from './battle-storage'
import { getPieceById } from './piece-repository'
import { assertDemoRostersReady, type RosterRoomStore } from './roster-contract'
import { getPlayerSeat, type Room } from './room-store'
import { createRootSeed } from './rule-runtime'

export const DEMO_FIXED_MAP_ID = 'large-trap-arena'

export interface StartLockedRosterBattleResult {
  room: Room
  started: boolean
}

export async function startBattleFromLockedRosters(
  store: RosterRoomStore,
  roomId: string,
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
    const playerSelectedPieces = roomPlayers.map(player => ({
      playerId: player.id,
      pieces: (player.selectedPieces ?? []).map(piece => getPieceById(piece.templateId)!),
      faction: getPlayerSeat(player),
    }))
    const pieceTemplates = playerSelectedPieces.flatMap(player => player.pieces)
    const seed = createRootSeed()
    const battle = await createInitialBattleForPlayers(
      playerIds,
      pieceTemplates,
      playerSelectedPieces,
      DEMO_FIXED_MAP_ID,
      { rootSeed: seed },
    )
    if (!battle) throw new Error('Failed to initialize battle state')

    let initState = battle
    try {
      initState = runBattleAction(battle, { type: 'beginPhase' }, { rootSeed: seed }).state
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error('Failed to init battle phase: ' + message)
    }

    // The battle setup is the sole authority for turn order.  It draws from
    // the root seed's turn-order stream, so neither seat, join order, nor a
    // client request can choose the first player.
    const firstPlayerId = initState.turn.currentPlayerId

    const nextRoom: Room = {
      ...room,
      firstPlayerId,
      mapId: DEMO_FIXED_MAP_ID,
      status: 'in-progress',
      currentTurnIndex: 0,
      battleState: {
        type: 'server-state',
        seed,
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
