import {
  assertGameProfileCompatibleV1,
  getServerGameProfileIdentityV1,
} from '../content-pipeline/runtime/profile-game-identity'
import { createInitialBattleForPlayers } from './battle-setup'
import { assertSelectableMapId } from './map-selection'
import { hashPublicBattleState } from './battle-public-patch'
import { hashBattleState, runBattleAction } from './battle-runner'
import {
  pinBattleProfileIdentityV1,
  rebaseBattleReplayForAuthorityCheckpoint,
  stampPendingDeploymentAuthorityVersion,
} from './battle-trace'
import {
  createServerBattleStateV1,
  getBattleStorage,
  withoutServerSkills,
  type ServerBattleState,
} from './battle-storage'
import { getPieceById } from './piece-repository'
import { assertDemoRostersReady, type RosterRoomStore } from './roster-contract'
import { isPlayerSeat, type PlayerSeat } from './match-identity'
import type { Room } from './room-model'
import { createRootSeed } from './rule-runtime'
import {
  systemDeploymentRuleClock,
  type DeploymentRuleClock,
} from './deployment'
import { isTurnTimerEnabled } from './turn-timer'
import {
  scheduleRoomDeploymentTimeout,
  createPublicBattleSnapshot,
  resetRoomBattleAuthorityClock,
  type PublicBattleSnapshot,
} from './room-battle-actions'
import { roomAuthorityQueue } from './room-authority-queue'
import { createRoomRuleRuntime, restoreRoomRuleRuntime } from './room-rule-runtime'

export interface StartLockedRosterBattleResult {
  room: Room
  started: boolean
}

function getPlayerSeat(player: { seat?: PlayerSeat; faction?: PlayerSeat }): PlayerSeat | undefined {
  return isPlayerSeat(player.seat) ? player.seat : isPlayerSeat(player.faction) ? player.faction : undefined
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
  const normalizedRoomId = roomId.trim().toLowerCase()
  return roomAuthorityQueue.enqueue(
    normalizedRoomId,
    { kind: 'system', actionId: `battle-start:${normalizedRoomId}` },
    () => startBattleFromLockedRostersQueued(store, normalizedRoomId, options),
  )
}

async function startBattleFromLockedRostersQueued(
  store: RosterRoomStore,
  roomId: string,
  options: StartLockedRosterBattleOptions,
): Promise<StartLockedRosterBattleResult> {
  const clock = options.clock ?? systemDeploymentRuleClock

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = await store.getRoom(roomId)
    if (!room) throw new Error('Room not found')
    if (room.status === 'finished' && room.battleState) {
      return { room, started: false }
    }
    const roomRuleRuntime = room.status === 'in-progress'
      ? restoreRoomRuleRuntime(roomId)
      : createRoomRuleRuntime(roomId)
    if (room.status === 'in-progress' && room.battleState) {
      const authorityReadyRoom = await ensureInitialAuthorityCheckpoint(store, room, clock)
      await scheduleRoomDeploymentTimeout(store, roomId, {
        clock,
        onCommitted: options.onDeploymentUpdate,
      })
      return { room: authorityReadyRoom, started: false }
    }

    const mapId = assertSelectableMapId(room.mapId)
    resetRoomBattleAuthorityClock(roomId)
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
    const profileIdentity = getServerGameProfileIdentityV1()
    for (const player of roomPlayers) {
      if (player.isBot === true || player.id === 'bot') {
        player.profileIdentity = profileIdentity
      } else {
        player.profileIdentity = assertGameProfileCompatibleV1(
          player.profileIdentity,
          profileIdentity,
        )
      }
    }
    const seed = createRootSeed()
    const battle = await createInitialBattleForPlayers(
      playerIds,
      pieceTemplates,
      playerSelectedPieces,
      mapId,
      {
        firstPlayerId,
        rootSeed: seed,
        profileIdentity,
        deploymentEnabled: true,
        deploymentMode: 'progressive-reserve-v1',
        deploymentStartedAt: clock.now(),
        ruleExecutionContext: roomRuleRuntime.executionContext,
      },
    )
    if (!battle) throw new Error('Failed to initialize battle state')

    let initialState = battle
    if (
      !initialState.terminalResult
      && initialState.deployment?.mode === 'progressive-reserve-v1'
      && isTurnTimerEnabled()
    ) {
      const timerStartedAt = clock.now()
      initialState = runBattleAction(initialState, {
        type: 'turnTimerSync',
        receivedAt: timerStartedAt,
        now: timerStartedAt,
      }, {
        rootSeed: seed,
        ruleExecutionContext: roomRuleRuntime.executionContext,
      }).state
      pinBattleProfileIdentityV1(
        initialState,
        profileIdentity,
        seed,
      )
    }
    const initialAuthorityVersion = room.battleAuthorityVersion ?? 0
    if (!Number.isSafeInteger(initialAuthorityVersion) || initialAuthorityVersion < 0) {
      throw new Error(`Invalid initial battle authority version: ${String(initialAuthorityVersion)}`)
    }
    stampPendingDeploymentAuthorityVersion(initialState, initialAuthorityVersion)
    rebaseBattleReplayForAuthorityCheckpoint(initialState)

    const nextRoom: Room = {
      ...room,
      firstPlayerId,
      mapId,
      status: initialState.terminalResult ? 'finished' : 'in-progress',
      currentTurnIndex: 0,
      battleAuthorityVersion: initialAuthorityVersion,
      battleState: createServerBattleStateV1(
        profileIdentity,
        seed,
        withoutServerSkills(initialState) as typeof initialState,
      ) as unknown as Room['battleState'],
    }

    if (typeof room.version === 'number') {
      if (!await store.setRoomIfVersion(roomId, nextRoom, room.version)) continue
    } else {
      await store.setRoom(roomId, nextRoom)
    }
    let committedRoom = await store.getRoom(roomId) ?? nextRoom
    const committedMetadataVersion = committedRoom.version
    let initialSnapshot = createPublicBattleSnapshot(committedRoom, undefined, clock)
    const authorityStore = store as RosterRoomStore & {
      initializeBattleAuthorityCheckpoint?: (input: {
        room: Room
        storage: ServerBattleState
        stateHash: string
        publicHash: string
      }) => Promise<void>
    }
    const committedStorage = getBattleStorage(committedRoom)
    try {
      if (!committedStorage || !authorityStore.initializeBattleAuthorityCheckpoint) {
        throw new Error(`Battle authority initial checkpoint is unavailable in ${roomId}`)
      }
      await authorityStore.initializeBattleAuthorityCheckpoint({
        room: committedRoom,
        storage: committedStorage,
        stateHash: hashBattleState(committedStorage.state as typeof initialState),
        publicHash: hashPublicBattleState(initialSnapshot.state),
      })
      committedRoom = await store.getRoom(roomId) ?? committedRoom
      initialSnapshot = createPublicBattleSnapshot(committedRoom, undefined, clock)
    } catch (checkpointError) {
      const rolledBack = typeof committedMetadataVersion === 'number'
        ? await store.setRoomIfVersion(roomId, room, committedMetadataVersion)
        : (await store.setRoom(roomId, room), true)
      if (!rolledBack) {
        throw new Error(
          `Initial battle checkpoint failed and room rollback conflicted: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`,
        )
      }
      throw checkpointError
    }
    await options.onDeploymentUpdate?.(initialSnapshot)
    if (committedRoom.status === 'in-progress') {
      await scheduleRoomDeploymentTimeout(store, roomId, {
        clock,
        onCommitted: options.onDeploymentUpdate,
      })
    }
    return { room: committedRoom, started: true }
  }

  throw new Error('Battle could not start because the room changed concurrently')
}

async function ensureInitialAuthorityCheckpoint(
  store: RosterRoomStore,
  room: Room,
  clock: DeploymentRuleClock,
): Promise<Room> {
  const authorityVersion = room.battleAuthorityVersion ?? 0
  if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 0) throw new Error('Invalid battle authority version')
  if (authorityVersion > 0) return room
  const authorityStore = store as RosterRoomStore & {
    initializeBattleAuthorityCheckpoint?: (input: {
      room: Room
      storage: ServerBattleState
      stateHash: string
      publicHash: string
    }) => Promise<void>
  }
  const storage = getBattleStorage(room)
  if (!storage || !authorityStore.initializeBattleAuthorityCheckpoint) {
    throw new Error(`Battle authority initial checkpoint is unavailable in ${room.id}`)
  }
  const snapshot = createPublicBattleSnapshot(room, undefined, clock)
  await authorityStore.initializeBattleAuthorityCheckpoint({
    room,
    storage,
    stateHash: hashBattleState(storage.state as Parameters<typeof hashBattleState>[0]),
    publicHash: hashPublicBattleState(snapshot.state),
  })
  return await store.getRoom(room.id) ?? room
}
