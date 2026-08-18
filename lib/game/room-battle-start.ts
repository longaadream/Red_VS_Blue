import { createInitialBattleForPlayers, DEMO_FIXED_MAP_ID } from './battle-setup'
export { DEMO_FIXED_MAP_ID } from './battle-setup'
import { runBattleAction } from './battle-runner'
import { stampPendingDeploymentAuthorityVersion } from './battle-trace'
import { withoutServerSkills } from './battle-storage'
import { getPieceById } from './piece-repository'
import { assertDemoRostersReady, type RosterRoomStore } from './roster-contract'
import { getPlayerSeat, type Room } from './room-store'
import { createRootSeed } from './rule-runtime'
import {
  systemDeploymentRuleClock,
  type DeploymentRuleClock,
} from './deployment'
import {
  scheduleRoomDeploymentTimeout,
  createPublicBattleSnapshot,
  type PublicBattleSnapshot,
} from './room-battle-actions'

export interface StartLockedRosterBattleResult {
  room: Room
  started: boolean
}

export interface StartLockedRosterBattleOptions {
  clock?: DeploymentRuleClock
  onDeploymentUpdate?: (snapshot: PublicBattleSnapshot) => void | Promise<void>
}

export async function startBattleFromLockedRosters(
  store: RosterRoomStore,
  roomId: string,
  options: StartLockedRosterBattleOptions = {},
): Promise<StartLockedRosterBattleResult> {
  const clock = options.clock ?? systemDeploymentRuleClock

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = await store.getRoom(roomId)
    if (!room) throw new Error('Room not found')
    if (room.status === 'in-progress' && room.battleState) {
      await scheduleRoomDeploymentTimeout(store, roomId, {
        clock,
        onCommitted: options.onDeploymentUpdate,
      })
      return { room, started: false }
    }

    assertDemoRostersReady(room)

    const roomPlayers = [...room.players.slice(0, 2)].sort((left, right) => {
      if (getPlayerSeat(left) === 'red' && getPlayerSeat(right) === 'blue') return -1
      if (getPlayerSeat(left) === 'blue' && getPlayerSeat(right) === 'red') return 1
      return 0
    })
    const redPlayers = roomPlayers.filter(player => getPlayerSeat(player) === 'red')
    const bluePlayers = roomPlayers.filter(player => getPlayerSeat(player) === 'blue')
    if (redPlayers.length !== 1 || bluePlayers.length !== 1) {
      throw new Error('Cannot start battle without exactly one red and one blue seat')
    }
    const firstPlayerId = redPlayers[0].id

    const playerIds = roomPlayers.map(player => player.id)
    const playerSelectedPieces = roomPlayers.map(player => ({
      playerId: player.id,
      pieces: (player.selectedPieces ?? []).map(piece => getPieceById(piece.templateId)!),
      faction: getPlayerSeat(player),
      alignment: player.alignment,
    }))
    const pieceTemplates = playerSelectedPieces.flatMap(player => player.pieces)
    const seed = createRootSeed()
    const battle = await createInitialBattleForPlayers(
      playerIds,
      pieceTemplates,
      playerSelectedPieces,
      DEMO_FIXED_MAP_ID,
      {
        firstPlayerId,
        rootSeed: seed,
        deploymentEnabled: true,
        deploymentStartedAt: clock.now(),
      },
    )
    if (!battle) throw new Error('Failed to initialize battle state')

    // Bots have no deployment UI. Lock the default keep-all choice through the
    // same authoritative deployment state machine used by human clients.
    let initialState = battle
    for (const bot of roomPlayers
      .filter(player => player.isBot === true || player.id === 'bot')
      .sort((left, right) => left.id.localeCompare(right.id))) {
      initialState = runBattleAction(initialState, {
        type: 'deploymentLock',
        playerId: bot.id,
        clientActionId: `system-deployment-keep:${bot.id}`,
      }, { rootSeed: seed }).state
    }

    if (typeof room.version === 'number') {
      stampPendingDeploymentAuthorityVersion(initialState, room.version + 1)
    }

    const nextRoom: Room = {
      ...room,
      firstPlayerId,
      mapId: DEMO_FIXED_MAP_ID,
      status: 'in-progress',
      currentTurnIndex: 0,
      battleState: {
        type: 'server-state',
        seed,
        state: withoutServerSkills(initialState),
      } as unknown as Room['battleState'],
    }

    if (typeof room.version === 'number') {
      if (!await store.setRoomIfVersion(roomId, nextRoom, room.version)) continue
    } else {
      await store.setRoom(roomId, nextRoom)
    }
    const committedRoom = await store.getRoom(roomId) ?? nextRoom
    await options.onDeploymentUpdate?.(createPublicBattleSnapshot(committedRoom))
    await scheduleRoomDeploymentTimeout(store, roomId, {
      clock,
      onCommitted: options.onDeploymentUpdate,
    })
    return { room: committedRoom, started: true }
  }

  throw new Error('Battle could not start because the room changed concurrently')
}
