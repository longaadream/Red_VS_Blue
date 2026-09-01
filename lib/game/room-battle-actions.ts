import type { GameProfileIdentityV1 } from '../content-pipeline/runtime/profile-game-identity'
import {
  createServerBattleStateV1,
  getBattleStorage,
  SERVER_BATTLE_STORAGE_SCHEMA_V1,
  withoutServerSkills,
  type ServerBattleState,
} from './battle-storage'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
  createBattlePublicPatch,
} from './battle-public-patch'
import { hashBattleState, runBattleAction, type BattleActionResult } from './battle-runner'
import {
  systemDeploymentRuleClock,
  toPublicBattleState,
  type DeploymentRuleClock,
} from './deployment'
import {
  compactBattleTraceForAuthority,
  canonicalBattleStateForHash,
  createBattleStateHashIndex,
  hashStable,
  materializeBattleTraceForTerminal,
  pinBattleProfileIdentityV1,
  stampPendingDeploymentAuthorityVersion,
} from './battle-trace'
import {
  buildBattleAuthorityTransition,
  checkpointReasonForTransition,
  createBattleAuthorityReceipt,
  readBattleAuthorityTransitionPublicHashIndex,
  roomBattleAuthorityVersion,
  type BattleAuthorityCheckpointRecord,
  type BattleAuthorityReceipt,
  type BattleAuthorityTransitionRecord,
} from './battle-transition'
import {
  assertBattleStateHashIndex,
  buildBattleStateHashIndex,
  updateBattleStateHashIndex,
  type BattleStateHashIndex,
} from './battle-state-hash'
import { roomAuthorityQueue, type RoomAuthorityEventContext } from './room-authority-queue'
import { restoreRoomRuleRuntime, type RoomRuleRuntime } from './room-rule-runtime'
import type { Room } from './room-model'
import { assertActionPlayer } from './targeting'
import {
  getCurrentInputOwnerPlayerId,
  isAcceptedGameplayAction,
  isTurnTimerEnabled,
  projectPendingTimer,
  projectTurnTimer,
  type PendingTimerProjection,
  type TurnTimerProjection,
} from './turn-timer'
import type { BattleAction, BattleState } from './turn'

const MAX_ROOM_ACTION_ATTEMPTS = 5

function toTimerSafePublicBattleState(state: BattleState, viewerPlayerId?: string): BattleState {
  const projected = toPublicBattleState(state, viewerPlayerId)
  // The response timer has a dedicated projection. Its predeclared default is
  // server-private and must not ride inside the generic battle-state payload.
  if (projected.turnTimer?.pendingResponse) delete projected.turnTimer.pendingResponse
  return projected
}

interface VersionedBattleStateHashIndex {
  authorityVersion: number
  index: BattleStateHashIndex
}

const authorityStateHashIndexes = new Map<string, VersionedBattleStateHashIndex>()
const publicStateHashIndexes = new Map<string, VersionedBattleStateHashIndex>()

export interface DeploymentRoomStore {
  getRoom(roomId: string): Promise<Room | undefined>
  setRoom(roomId: string, room: Room): Promise<void>
  setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean>
  getBattleAuthorityReceipt?(roomId: string, clientActionId: string): Promise<BattleAuthorityReceipt | undefined>
  persistBattleAuthorityReceipt?(receipt: BattleAuthorityReceipt): Promise<void>
  commitBattleAuthorityTransition?(input: {
    roomId: string
    expectedVersion: number
    nextRoom: Room
    transition: BattleAuthorityTransitionRecord
    transitionPreStateHash: string
    runnerPreStateHash: string
    runnerPostStateHash: string
    baseCheckpoint?: BattleAuthorityCheckpointRecord
    checkpoint?: BattleAuthorityCheckpointRecord
  }): Promise<boolean>
  readBattleAuthorityHistory?(roomId: string): Promise<Array<{
    trace?: BattleAuthorityTransitionRecord['traces'][number]
    command?: Record<string, unknown>
    replayFrame?: BattleAuthorityTransitionRecord['replayFrames'][number]
  }>>
  inspectBattleAuthorityPersistence?(roomId: string): {
    status: 'durable' | 'pending' | 'degraded'
    durableAuthorityVersion: number
    authorityVersion: number
    pending: number
    lastError?: string
    lastErrorContext?: Record<string, unknown>
  }
  terminalAuthorityPersistencePolicy?: 'background' | 'durable-barrier'
  drainBattleAuthorityPersistence?(roomId?: string): Promise<void>
}

export interface PublicBattleSnapshot {
  protocolVersion: typeof BATTLE_AUTHORITY_PROTOCOL_VERSION
  authorityBuildId: typeof BATTLE_AUTHORITY_BUILD_ID
  state: BattleState
  seed: number
  rootSeed: number
  profileIdentity: GameProfileIdentityV1
  stateHash: string
  authorityVersion: number
  serverNow: number
  durableAuthorityVersion?: number
  persistenceStatus?: 'durable' | 'pending' | 'degraded'
  turnTimer?: TurnTimerProjection
  pendingTimer?: PendingTimerProjection
}

export interface DispatchRoomBattleActionResult {
  kind: 'applied' | 'duplicate' | 'expired' | 'resyncRequired'
  expiredReason?: 'deployment' | 'pending' | 'turn'
  snapshot: PublicBattleSnapshot
  /** Final authoritative result, including an internal timer sync when needed. */
  actionResult: BattleActionResult
  /** Result of the command submitted by the caller, before an internal timer sync. */
  submittedActionResult?: BattleActionResult
  /** True when the pre-resume transport callback already sent this exact snapshot. */
  finalSnapshotAlreadyDelivered?: boolean
  receipt?: BattleAuthorityReceipt
  transition?: BattleAuthorityTransitionRecord
  /** Internal states retained only until recipient-specific public patches are projected. */
  previousAuthorityState?: BattleState
  nextAuthorityState?: BattleState
  timings?: BattleAuthorityTimings
}

export interface BattleAuthorityTimings {
  queueMs: number
  rulesMs: number
  persistenceMs: number
  totalMs: number
}

export interface PublicBattleTransitionUpdate {
  type: 'battleTransition'
  protocolVersion: typeof BATTLE_AUTHORITY_PROTOCOL_VERSION
  authorityBuildId: typeof BATTLE_AUTHORITY_BUILD_ID
  roomId: string
  fromVersion: number
  toVersion: number
  prePublicHash: string
  postPublicHash: string
  patch: BattleAuthorityTransitionRecord['publicPatch']
  receipt: BattleAuthorityReceipt
  pending?: BattleAuthorityTransitionRecord['pending']
  seed: number
  stateHash: string
  serverNow: number
  durableAuthorityVersion?: number
  persistenceStatus?: 'durable' | 'pending' | 'degraded'
  turnTimer?: TurnTimerProjection
  pendingTimer?: PendingTimerProjection
  timings?: BattleAuthorityTimings
}

export interface PreResumeDeliveryContext {
  kind: 'applied' | 'expired'
  expiredReason?: 'deployment' | 'pending' | 'turn'
  actionHash?: string
}

export interface DispatchRoomBattleActionOptions {
  allowSystem?: boolean
  expectedAuthorityVersion?: number
  /** Candidate persistence checkpoint cadence; legacy callers retain the existing default. */
  checkpointInterval?: number
  clock?: DeploymentRuleClock
  /**
   * Runs after the single authoritative commit while the room clock is frozen.
   * The callback receives only the snapshot that was actually committed.
   */
  onCommittedBeforeTimerResume?: (
    snapshot: PublicBattleSnapshot,
    context: PreResumeDeliveryContext,
  ) => void | Promise<void>
}

export interface ScheduleBattleTimeoutOptions {
  clock?: DeploymentRuleClock
  onCommitted?: (snapshot: PublicBattleSnapshot) => void | Promise<void>
  onTransitionCommitted?: (result: DispatchRoomBattleActionResult) => void | Promise<void>
  onBotTurnReady?: (
    snapshot: PublicBattleSnapshot,
    authorityState: BattleState,
  ) => void | Promise<void>
}

export type ScheduleDeploymentTimeoutOptions = ScheduleBattleTimeoutOptions
type TurnTimeoutAction = Extract<BattleAction, { type: 'turnTimeout' }>
type PendingTimeoutAction = Extract<BattleAction, { type: 'pendingTimeout' }>

export class RoomBattleActionError extends Error {
  code: string
  context: Record<string, unknown>

  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RoomBattleActionError'
    this.code = code
    this.context = context
  }
}

type BattleAuthorityPersistenceInspection = ReturnType<
  NonNullable<DeploymentRoomStore['inspectBattleAuthorityPersistence']>
>

function battleAuthorityPersistenceDegradedError(
  roomId: string,
  persistence: BattleAuthorityPersistenceInspection,
): RoomBattleActionError {
  console.error('[battle-authority-persistence] action rejected while the journal is degraded', {
    roomId,
    authorityVersion: persistence.authorityVersion,
    durableAuthorityVersion: persistence.durableAuthorityVersion,
    pending: persistence.pending,
    lastError: persistence.lastError,
    lastErrorContext: persistence.lastErrorContext,
  })
  return new RoomBattleActionError(
    'BATTLE_AUTHORITY_PERSISTENCE_DEGRADED',
    'Battle authority persistence is degraded; the room is paused until the server recovers',
    {
      roomId,
      persistenceStatus: persistence.status,
      authorityVersion: persistence.authorityVersion,
      durableAuthorityVersion: persistence.durableAuthorityVersion,
      pendingPersistenceJobs: persistence.pending,
    },
  )
}

function startTerminalBattleAuthorityDrain(
  store: DeploymentRoomStore,
  roomId: string,
  authorityVersion: number,
  clientActionId?: string,
): void {
  if (!store.drainBattleAuthorityPersistence) return
  let drain: Promise<void>
  try {
    drain = store.drainBattleAuthorityPersistence(roomId)
  } catch (error) {
    drain = Promise.reject(error)
  }
  void drain.catch(error => {
    console.error('[battle-authority-persistence] terminal background drain failed', {
      roomId,
      authorityVersion,
      clientActionId,
      errorName: error instanceof Error ? error.name : 'Error',
      errorMessage: error instanceof Error ? error.message : String(error),
      errorCause: error instanceof Error && error.cause
        ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
        : undefined,
    })
  })
}

async function settleTerminalBattleAuthorityPersistence(
  store: DeploymentRoomStore,
  roomId: string,
  authorityVersion: number,
  clientActionId?: string,
): Promise<{ waitedForDurability: boolean; waitedMs: number }> {
  if (!store.drainBattleAuthorityPersistence) {
    return { waitedForDurability: false, waitedMs: 0 }
  }

  if (store.terminalAuthorityPersistencePolicy === 'durable-barrier') {
    const startedAt = monotonicNow()
    await store.drainBattleAuthorityPersistence(roomId)
    return {
      waitedForDurability: true,
      waitedMs: monotonicNow() - startedAt,
    }
  }

  startTerminalBattleAuthorityDrain(store, roomId, authorityVersion, clientActionId)
  return { waitedForDurability: false, waitedMs: 0 }
}

function assertBattleAuthorityPersistenceAvailable(
  store: DeploymentRoomStore,
  roomId: string,
): void {
  const persistence = store.inspectBattleAuthorityPersistence?.(roomId)
  if (persistence?.status === 'degraded') {
    throw battleAuthorityPersistenceDegradedError(roomId, persistence)
  }
}

type AuthorityTimer = ReturnType<typeof setTimeout>
interface RoomAuthorityClockState {
  excludedMs: number
  pausedAtWall?: number
  frozenNow?: number
}

const timerGlobal = globalThis as typeof globalThis & {
  __rvbDeploymentTimers?: Map<string, AuthorityTimer>
  __rvbRoomAuthorityClocks?: Map<string, RoomAuthorityClockState>
}
const authorityTimers = (timerGlobal.__rvbDeploymentTimers ??= new Map())
const roomAuthorityClocks = (timerGlobal.__rvbRoomAuthorityClocks ??= new Map())

export function createPublicBattleSnapshot(
  room: Room,
  viewerPlayerId?: string,
  clock: DeploymentRuleClock = systemDeploymentRuleClock,
): PublicBattleSnapshot {
  const storage = getBattleStorage(room)
  if (!storage) throw new RoomBattleActionError('BATTLE_NOT_STARTED', 'Battle not started')
  const state = toTimerSafePublicBattleState(storage.state as BattleState, viewerPlayerId)
  const serverNow = getRoomAuthorityNow(room.id, clock)
  const authorityVersion = roomBattleAuthorityVersion(room)
  const publicIndex = cachePublicStateHashIndex(
    room.id,
    viewerPlayerId,
    authorityVersion,
    state,
  )
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    state,
    seed: storage.rootSeed,
    rootSeed: storage.rootSeed,
    profileIdentity: storage.profileIdentity,
    stateHash: publicIndex.rootHash,
    authorityVersion,
    serverNow,
    durableAuthorityVersion: room.battleAuthorityDurableVersion,
    persistenceStatus: room.battleAuthorityPersistenceStatus,
    turnTimer: state.terminalResult || !isTurnTimerEnabled()
      ? undefined
      : projectTurnTimer((storage.state as BattleState).turnTimer, serverNow),
    pendingTimer: state.terminalResult || !isTurnTimerEnabled()
      ? undefined
      : projectPendingTimer((storage.state as BattleState).turnTimer, serverNow),
  }
}

export function createPublicBattleTransitionUpdate(
  result: DispatchRoomBattleActionResult,
  roomId: string,
  viewerPlayerId?: string,
  clock: DeploymentRuleClock = systemDeploymentRuleClock,
): PublicBattleTransitionUpdate | undefined {
  const transition = result.transition
  if (!transition || !result.previousAuthorityState || !result.nextAuthorityState || !result.receipt) {
    return undefined
  }
  const previous = toTimerSafePublicBattleState(result.previousAuthorityState, viewerPlayerId)
  const next = toTimerSafePublicBattleState(result.nextAuthorityState, viewerPlayerId)
  const serverNow = getRoomAuthorityNow(roomId, clock)
  const patch = createBattlePublicPatch(previous, next)
  const previousIndex = getPublicStateHashIndex(
    roomId,
    viewerPlayerId,
    transition.fromVersion,
    previous,
  )
  const nextIndex = updateBattleStateHashIndex(previousIndex, next, patch, hashStable).index
  publicStateHashIndexes.set(publicHashCacheKey(roomId, viewerPlayerId), {
    authorityVersion: transition.toVersion,
    index: nextIndex,
  })
  return {
    type: 'battleTransition',
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    roomId: roomId.trim().toLowerCase(),
    fromVersion: transition.fromVersion,
    toVersion: transition.toVersion,
    prePublicHash: previousIndex.rootHash,
    postPublicHash: nextIndex.rootHash,
    patch,
    receipt: result.receipt,
    pending: transition.pending,
    seed: result.snapshot.seed,
    stateHash: nextIndex.rootHash,
    serverNow,
    durableAuthorityVersion: result.snapshot.durableAuthorityVersion,
    persistenceStatus: result.snapshot.persistenceStatus,
    turnTimer: next.terminalResult || !isTurnTimerEnabled()
      ? undefined
      : projectTurnTimer(result.nextAuthorityState.turnTimer, serverNow),
    pendingTimer: next.terminalResult || !isTurnTimerEnabled()
      ? undefined
      : projectPendingTimer(result.nextAuthorityState.turnTimer, serverNow),
    timings: result.timings,
  }
}

export function createPublicBattleResyncSnapshot(
  result: DispatchRoomBattleActionResult,
  roomId: string,
  viewerPlayerId?: string,
  clock: DeploymentRuleClock = systemDeploymentRuleClock,
): PublicBattleSnapshot | undefined {
  if (!result.transition || !result.nextAuthorityState) return undefined
  const state = toTimerSafePublicBattleState(result.nextAuthorityState, viewerPlayerId)
  const serverNow = getRoomAuthorityNow(roomId, clock)
  const publicIndex = cachePublicStateHashIndex(
    roomId,
    viewerPlayerId,
    result.transition.toVersion,
    state,
  )
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    state,
    seed: result.snapshot.seed,
    rootSeed: result.snapshot.rootSeed,
    profileIdentity: result.snapshot.profileIdentity,
    stateHash: publicIndex.rootHash,
    authorityVersion: result.transition.toVersion,
    serverNow,
    durableAuthorityVersion: result.snapshot.durableAuthorityVersion,
    persistenceStatus: result.snapshot.persistenceStatus,
    turnTimer: state.terminalResult || !isTurnTimerEnabled()
      ? undefined
      : projectTurnTimer(result.nextAuthorityState.turnTimer, serverNow),
    pendingTimer: state.terminalResult || !isTurnTimerEnabled()
      ? undefined
      : projectPendingTimer(result.nextAuthorityState.turnTimer, serverNow),
  }
}

export function createPublicRoomSnapshot(room: Room): Room {
  const storage = getBattleStorage(room)
  if (!storage) return room
  const snapshot = createPublicBattleSnapshot(room)
  const publicStorage: ServerBattleState = {
    type: 'server-state',
    storageSchemaVersion: SERVER_BATTLE_STORAGE_SCHEMA_V1,
    profileIdentity: storage.profileIdentity,
    rootSeed: storage.rootSeed,
    state: snapshot.state,
  }
  return {
    ...room,
    status: snapshot.state.terminalResult?.status === 'finished' ? 'finished' : room.status,
    battleState: publicStorage as unknown as Room['battleState'],
  }
}

export async function dispatchRoomBattleAction(
  store: DeploymentRoomStore,
  roomId: string,
  viewerPlayerId: string | null | undefined,
  action: BattleAction,
  options: DispatchRoomBattleActionOptions = {},
): Promise<DispatchRoomBattleActionResult> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const clock = options.clock ?? systemDeploymentRuleClock
  const wallArrival = clock.now()
  const performanceStartedAt = monotonicNow()
  let queueMs = 0
  let rulesMs = 0
  let persistenceMs = 0
  // Commands queued behind another commit retain their original logical arrival
  // so queue/storage/transport work never becomes player thinking time.
  const receivedAt = projectRoomAuthorityNow(normalizedRoomId, wallArrival)
  const requestedClientActionId = actionClientActionId(action)
  const eventContext: RoomAuthorityEventContext = {
    kind: roomAuthorityEventKind(action, viewerPlayerId, options.allowSystem === true),
    actionId: requestedClientActionId,
    playerId: 'playerId' in action ? action.playerId : viewerPlayerId ?? undefined,
    authorityVersion: options.expectedAuthorityVersion,
  }

  return withPausedRoomAuthorityClock(normalizedRoomId, clock, async () => {
    queueMs = monotonicNow() - performanceStartedAt
    let roomRuleRuntime: RoomRuleRuntime | undefined
    for (let attempt = 0; attempt < MAX_ROOM_ACTION_ATTEMPTS; attempt += 1) {
      const room = await store.getRoom(normalizedRoomId)
      if (!room) throw new RoomBattleActionError('ROOM_NOT_FOUND', 'Room not found', { roomId: normalizedRoomId })
      const storage = getBattleStorage(room)
      if (!storage) throw new RoomBattleActionError('BATTLE_NOT_STARTED', 'Battle not started', { roomId: normalizedRoomId })
      roomRuleRuntime ??= restoreRoomRuleRuntime(normalizedRoomId)
      const state = storage.state as BattleState
      if (!Number.isSafeInteger(room.version) || Number(room.version) < 0) {
        throw new RoomBattleActionError(
          'ROOM_VERSION_MISSING',
          'Room metadata version is required for battle actions',
          roomActionContext(normalizedRoomId, room, storage, action, viewerPlayerId),
        )
      }
      const authorityVersion = roomBattleAuthorityVersion(room)

      if (
        !requestedClientActionId
        || !store.getBattleAuthorityReceipt
        || !store.persistBattleAuthorityReceipt
        || !store.commitBattleAuthorityTransition
      ) {
        throw new RoomBattleActionError(
          'AUTHORITY_STORE_UNAVAILABLE',
          'Battle authority requires a client action ID, receipts, transitions, and durable persistence',
          roomActionContext(normalizedRoomId, room, storage, action, viewerPlayerId),
        )
      }
      const previousTransitionStorage = cloneBattleAuthorityJson(storage)

      try {
        assertRoomActionViewer(room, viewerPlayerId, action, options.allowSystem === true)
      } catch (error) {
        const decorated = decorateRoomActionError(error, normalizedRoomId, room, storage, action, viewerPlayerId)
        const receipt = createBattleAuthorityReceipt({
          roomId: normalizedRoomId,
          clientActionId: requestedClientActionId,
          status: 'rejected',
          authorityVersion,
          code: (decorated as { code?: string }).code ?? 'BATTLE_ACTION_REJECTED',
          message: decorated.message,
        })
        await store.persistBattleAuthorityReceipt(receipt)
        Object.assign(decorated, { receipt })
        throw decorated
      }

      const existing = await store.getBattleAuthorityReceipt(normalizedRoomId, requestedClientActionId)
      if (existing) {
        const receipt = createBattleAuthorityReceipt({
          roomId: normalizedRoomId,
          clientActionId: requestedClientActionId,
          status: 'duplicate',
          authorityVersion: existing.authorityVersion,
          code: existing.code,
          message: existing.message,
        })
        return {
          kind: 'duplicate',
          snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined, clock),
          actionResult: duplicateResult(state),
          receipt,
        }
      }
      assertBattleAuthorityPersistenceAvailable(store, normalizedRoomId)
      if (
        options.expectedAuthorityVersion !== undefined
        && options.expectedAuthorityVersion !== authorityVersion
      ) {
        const receipt = createBattleAuthorityReceipt({
          roomId: normalizedRoomId,
          clientActionId: requestedClientActionId,
          status: 'resyncRequired',
          authorityVersion,
          code: 'AUTHORITY_VERSION_MISMATCH',
          message: `Expected authority version ${options.expectedAuthorityVersion}, current version is ${authorityVersion}`,
        })
        await store.persistBattleAuthorityReceipt(receipt)
        return {
          kind: 'resyncRequired',
          snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined, clock),
          actionResult: duplicateResult(state),
          receipt,
        }
      }

      if (isAlreadyCommittedSystemAction(state, action)) {
        return {
          kind: 'duplicate',
          snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined, clock),
          actionResult: duplicateResult(state),
          receipt: requestedClientActionId
            ? createBattleAuthorityReceipt({
                roomId: normalizedRoomId,
                clientActionId: requestedClientActionId,
                status: 'duplicate',
                authorityVersion,
              })
            : undefined,
        }
      }

      const timerEnabled = isTurnTimerEnabled()
      const continuesPendingInteraction =
        (action.type === 'pendingOptionSelect' && !!state.pendingOptionSelection)
        || (action.type === 'pendingTargetSelect' && !!state.pendingTargetSelection)
        || (action.type === 'cancelPendingSelection'
          && (!!state.pendingOptionSelection || !!state.pendingTargetSelection))
      const deploymentExpired = timerEnabled
        && action.type !== 'deploymentTimeout'
        && !continuesPendingInteraction
        && state.deployment?.status === 'awaiting-locks'
        && receivedAt >= state.deployment.deadlineAt
      const turnExpired = timerEnabled
        && !deploymentExpired
        && !state.turnTimer?.pendingResponse
        && action.type !== 'turnTimeout'
        && state.deployment?.status !== 'awaiting-locks'
        && state.turnTimer?.status === 'running'
        && receivedAt >= state.turnTimer.deadlineAt
      const pendingExpired = timerEnabled
        && !deploymentExpired
        && action.type !== 'pendingTimeout'
        && state.turnTimer?.pendingResponse?.status === 'running'
        && receivedAt >= state.turnTimer.pendingResponse.deadlineAt

      const actionToApply: BattleAction = deploymentExpired
        ? {
            type: 'deploymentTimeout',
            now: receivedAt,
            clientActionId: `system-deployment-timeout:${normalizedRoomId}:${state.deployment!.deadlineAt}`,
          }
        : pendingExpired
        ? createPendingTimeoutAction(
            state,
            receivedAt,
            `system-pending-timeout:${normalizedRoomId}:${state.turnTimer!.pendingResponse!.selectionId}:${state.turnTimer!.pendingResponse!.deadlineAt}`,
          )
        : turnExpired
        ? createTurnTimeoutAction(
            state,
            receivedAt,
            `system-turn-timeout:${normalizedRoomId}:${state.turnTimer!.turnNumber}:${state.turnTimer!.deadlineAt}`,
          )
        : normalizeSystemActionTime(action, receivedAt)

      const runtimeTransactionSnapshot = roomRuleRuntime.snapshotTransactionState()
      let retainRuntimeTransaction = false
      try {
      let submittedActionResult: BattleActionResult
      try {
        const rulesStartedAt = monotonicNow()
        submittedActionResult = runBattleAction(state, actionToApply, {
          rootSeed: storage.rootSeed,
          stateHashIndex: getAuthorityStateHashIndex(
            normalizedRoomId,
            authorityVersion,
            state,
          ),
          ruleExecutionContext: roomRuleRuntime.executionContext,
        })
        pinBattleProfileIdentityV1(
          submittedActionResult.state,
          storage.profileIdentity,
          storage.rootSeed,
        )
        rulesMs += monotonicNow() - rulesStartedAt
      } catch (error) {
        const decorated = decorateRoomActionError(error, normalizedRoomId, room, storage, actionToApply, viewerPlayerId)
        const receipt = createBattleAuthorityReceipt({
          roomId: normalizedRoomId,
          clientActionId: requestedClientActionId,
          status: 'rejected',
          authorityVersion,
          code: (decorated as { code?: string }).code ?? 'BATTLE_ACTION_REJECTED',
          message: decorated.message,
        })
        await store.persistBattleAuthorityReceipt(receipt)
        Object.assign(decorated, { receipt })
        throw decorated
      }

      if (submittedActionResult.duplicate) {
        return {
          kind: 'duplicate',
          snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined, clock),
          actionResult: submittedActionResult,
          receipt: requestedClientActionId
            ? createBattleAuthorityReceipt({
                roomId: normalizedRoomId,
                clientActionId: requestedClientActionId,
                status: 'duplicate',
                authorityVersion,
              })
            : undefined,
        }
      }

      let actionResult = submittedActionResult
      let syncAction: BattleAction | undefined
      if (timerEnabled && shouldSyncTurnTimer(state, submittedActionResult.state, actionToApply)) {
        const resumedAt = getRoomAuthorityNow(normalizedRoomId, clock)
        const actorPlayerId = 'playerId' in actionToApply ? actionToApply.playerId : undefined
        const acceptedActionType = isAcceptedGameplayAction(actionToApply)
          ? actionToApply.type
          : undefined
        syncAction = {
          type: 'turnTimerSync',
          receivedAt,
          now: resumedAt,
          actorPlayerId,
          acceptedActionType,
          clientActionId: `system-turn-timer-sync:${normalizedRoomId}:${authorityVersion}:${actionIdPart(actionToApply)}`,
        }
        try {
          const syncRulesStartedAt = monotonicNow()
        actionResult = runBattleAction(submittedActionResult.state, syncAction, {
          rootSeed: storage.rootSeed,
          stateHashIndex: submittedActionResult.stateHashIndex,
          ruleExecutionContext: roomRuleRuntime.executionContext,
        })
        pinBattleProfileIdentityV1(
          actionResult.state,
          storage.profileIdentity,
          storage.rootSeed,
        )
          rulesMs += monotonicNow() - syncRulesStartedAt
        } catch (error) {
          const decorated = decorateRoomActionError(error, normalizedRoomId, room, storage, syncAction, viewerPlayerId)
          const receipt = createBattleAuthorityReceipt({
            roomId: normalizedRoomId,
            clientActionId: requestedClientActionId,
            status: 'rejected',
            authorityVersion,
            code: (decorated as { code?: string }).code ?? 'BATTLE_ACTION_REJECTED',
            message: decorated.message,
          })
          await store.persistBattleAuthorityReceipt(receipt)
          Object.assign(decorated, { receipt })
          throw decorated
        }
      }

      const nextAuthorityVersion = authorityVersion + 1
      stampPendingDeploymentAuthorityVersion(actionResult.state, nextAuthorityVersion)
      const previousAuthorityState = state
      const commands = syncAction ? [actionToApply, syncAction] : [actionToApply]
      const traces = [submittedActionResult.trace, syncAction ? actionResult.trace : undefined]
        .filter((trace): trace is NonNullable<typeof trace> => !!trace)
      const replayFrames = [submittedActionResult.replayFrame, syncAction ? actionResult.replayFrame : undefined]
        .filter((frame): frame is NonNullable<typeof frame> => !!frame)
      let nextAuthorityState = actionResult.state
      nextAuthorityState = cloneBattleAuthorityJson(nextAuthorityState)
      actionResult = { ...actionResult, state: nextAuthorityState }
      const isTerminal = nextAuthorityState.terminalResult?.status === 'finished'
      if (isTerminal && store.readBattleAuthorityHistory) {
        const materializedState = structuredClone(compactBattleTraceForAuthority(nextAuthorityState))
        const existingHistory = await store.readBattleAuthorityHistory(normalizedRoomId)
        const currentHistory = commands.map((command, index) => ({
          command: command as unknown as Record<string, unknown>,
          trace: traces[index],
          replayFrame: replayFrames[index],
        }))
        materializeBattleTraceForTerminal(materializedState, [...existingHistory, ...currentHistory])
        const canonicalMaterializedState = cloneBattleAuthorityJson(materializedState)
        nextAuthorityState = canonicalMaterializedState
        actionResult = { ...actionResult, state: canonicalMaterializedState }
      }
      const previousPublicState = toTimerSafePublicBattleState(previousAuthorityState)
      const nextPublicState = toTimerSafePublicBattleState(nextAuthorityState)
      const committedState = !isTerminal
        ? compactBattleTraceForAuthority(nextAuthorityState)
        : nextAuthorityState
      const nextStorage = createServerBattleStateV1(
        storage.profileIdentity,
        storage.rootSeed,
        committedState,
      )
      const transitionPlayerId = 'playerId' in action
        ? action.playerId
        : viewerPlayerId ?? 'system'
      const runnerPreStateHash = submittedActionResult.trace?.preStateHash ?? hashBattleState(state)
      const transitionPreStateHash = Object.hasOwn(state, 'skillsById')
        ? hashBattleState(state)
        : runnerPreStateHash
      const transition = buildBattleAuthorityTransition({
            roomId: normalizedRoomId,
            fromVersion: authorityVersion,
            clientActionId: requestedClientActionId,
            playerId: transitionPlayerId,
            command: actionToApply,
            commands,
            previousStorage: previousTransitionStorage,
            nextStorage,
            previousPublicState,
            nextPublicState,
            preStateHash: transitionPreStateHash!,
            postStateHash: actionResult.stateHash,
            traces,
            replayFrames,
            previousTransitionHash: room.battleAuthorityTransitionHash,
            previousPublicHashIndex: getPublicStateHashIndex(
              normalizedRoomId,
              undefined,
              authorityVersion,
              previousPublicState,
            ),
            now: receivedAt,
          })
      const expired = deploymentExpired || pendingExpired || turnExpired
      if (transition && expired) {
        transition.receipt = createBattleAuthorityReceipt({
          roomId: normalizedRoomId,
          clientActionId: requestedClientActionId,
          status: 'rejected',
          authorityVersion: nextAuthorityVersion,
          code: pendingExpired ? 'PENDING_RESPONSE_EXPIRED' : turnExpired ? 'TURN_EXPIRED' : 'DEPLOYMENT_EXPIRED',
          message: pendingExpired
            ? 'Pending response deadline elapsed; the authoritative timeout was committed instead.'
            : turnExpired
            ? 'Turn deadline elapsed; the authoritative timeout was committed instead.'
            : 'Deployment deadline elapsed; the authoritative timeout was committed instead.',
        })
      }

      const baseCheckpoint: BattleAuthorityCheckpointRecord | undefined = transition && authorityVersion === 0
        ? {
            protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
            authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
            roomId: normalizedRoomId,
            authorityVersion,
            seed: storage.rootSeed,
            storage: previousTransitionStorage,
            stateHash: transition.preStateHash,
            publicHash: transition.prePublicHash,
            transitionHash: transition.previousTransitionHash,
            reason: 'initial',
            createdAt: receivedAt,
          }
        : undefined
      let checkpoint: BattleAuthorityCheckpointRecord | undefined
      if (transition) {
        const reason = checkpointReasonForTransition(
          state,
          nextAuthorityState,
          nextAuthorityVersion,
          options.checkpointInterval,
        )
        if (reason) {
          const checkpointStorage = nextStorage
          checkpoint = {
            protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
            authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
            roomId: normalizedRoomId,
            authorityVersion: nextAuthorityVersion,
            seed: storage.rootSeed,
            storage: checkpointStorage,
            stateHash: transition.postStateHash,
            publicHash: transition.postPublicHash,
            transitionHash: transition.transitionHash,
            reason,
            createdAt: receivedAt,
          }
          if (!actionResult.stateHashIndex) {
            throw new Error(
              `Battle authority state hash index missing in ${normalizedRoomId} at ${nextAuthorityVersion}`,
            )
          }
          assertBattleStateHashIndex(
            canonicalBattleStateForHash(withoutServerSkills(nextAuthorityState) as BattleState),
            actionResult.stateHashIndex,
            hashStable,
            `battle authority checkpoint ${normalizedRoomId}@${nextAuthorityVersion}`,
          )
          const transitionPublicIndex = readBattleAuthorityTransitionPublicHashIndex(transition)
          if (!transitionPublicIndex) {
            throw new Error(
              `Battle authority public hash index missing in ${normalizedRoomId} at ${nextAuthorityVersion}`,
            )
          }
          assertBattleStateHashIndex(
            nextPublicState,
            transitionPublicIndex,
            hashStable,
            `battle authority public checkpoint ${normalizedRoomId}@${nextAuthorityVersion}`,
          )
        }
      }

      const committedStorage = checkpoint?.storage ?? nextStorage
      const nextRoom: Room = {
        ...room,
        battleState: committedStorage as unknown as Room['battleState'],
        battleAuthorityTransitionHash: transition.transitionHash,
        ...(isTerminal ? { status: 'finished' as const } : {}),
      }
      const persistenceStartedAt = monotonicNow()
      const committed = await store.commitBattleAuthorityTransition({
            roomId: normalizedRoomId,
            expectedVersion: authorityVersion,
            nextRoom,
            transition,
            transitionPreStateHash: transitionPreStateHash!,
            runnerPreStateHash: runnerPreStateHash!,
            runnerPostStateHash: actionResult.stateHash,
            baseCheckpoint,
            checkpoint,
          })
      persistenceMs += monotonicNow() - persistenceStartedAt
      if (!committed) {
        assertBattleAuthorityPersistenceAvailable(store, normalizedRoomId)
        continue
      }
      retainRuntimeTransaction = true
      if (transition && actionResult.stateHashIndex) {
        authorityStateHashIndexes.set(normalizedRoomId, {
          authorityVersion: nextAuthorityVersion,
          index: actionResult.stateHashIndex,
        })
        const publicIndex = readBattleAuthorityTransitionPublicHashIndex(transition)
        if (publicIndex) {
          publicStateHashIndexes.set(publicHashCacheKey(normalizedRoomId, undefined), {
            authorityVersion: nextAuthorityVersion,
            index: publicIndex,
          })
        }
      }
      const persistence = transition
        ? store.inspectBattleAuthorityPersistence?.(normalizedRoomId)
        : undefined
      const committedRoom: Room = {
        ...nextRoom,
        battleAuthorityVersion: nextAuthorityVersion,
        battleAuthorityDurableVersion: persistence?.durableAuthorityVersion,
        battleAuthorityPersistenceStatus: persistence?.status,
      }
      let snapshotRoom = committedRoom
      if (isTerminal && transition) {
        const terminalPersistence = await settleTerminalBattleAuthorityPersistence(
          store,
          normalizedRoomId,
          nextAuthorityVersion,
          requestedClientActionId,
        )
        persistenceMs += terminalPersistence.waitedMs
        if (terminalPersistence.waitedForDurability) {
          snapshotRoom = await store.getRoom(normalizedRoomId) ?? committedRoom
        }
      }
      const snapshot = createPublicBattleSnapshot(snapshotRoom, viewerPlayerId ?? undefined, clock)
      if (isTerminal) clearRoomBattleTimeout(normalizedRoomId)
      let delivered = false
      if (options.onCommittedBeforeTimerResume) {
        await options.onCommittedBeforeTimerResume(snapshot, {
          kind: expired ? 'expired' : 'applied',
          ...(deploymentExpired ? { expiredReason: 'deployment' as const } : {}),
          ...(pendingExpired ? { expiredReason: 'pending' as const } : {}),
          ...(turnExpired ? { expiredReason: 'turn' as const } : {}),
          actionHash: submittedActionResult.actionHash,
        })
        delivered = true
      }
      return {
        kind: expired ? 'expired' : 'applied',
        ...(deploymentExpired ? { expiredReason: 'deployment' as const } : {}),
        ...(pendingExpired ? { expiredReason: 'pending' as const } : {}),
        ...(turnExpired ? { expiredReason: 'turn' as const } : {}),
        snapshot,
        actionResult,
        submittedActionResult,
        finalSnapshotAlreadyDelivered: delivered,
        receipt: transition.receipt,
        transition,
        previousAuthorityState,
        nextAuthorityState,
        timings: {
          queueMs: roundTiming(queueMs),
          rulesMs: roundTiming(rulesMs),
          persistenceMs: roundTiming(persistenceMs),
          totalMs: roundTiming(monotonicNow() - performanceStartedAt),
        },
      }
      } finally {
        if (!retainRuntimeTransaction) {
          roomRuleRuntime.restoreTransactionState(runtimeTransactionSnapshot)
        }
      }
    }

    assertBattleAuthorityPersistenceAvailable(store, normalizedRoomId)
    throw new RoomBattleActionError(
      'ROOM_VERSION_CONFLICT',
      'Battle action could not commit because the room changed concurrently',
      { roomId: normalizedRoomId },
    )
  }, eventContext)
}

export async function scheduleRoomBattleTimeout(
  store: DeploymentRoomStore,
  roomId: string,
  options: ScheduleBattleTimeoutOptions = {},
): Promise<void> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  clearRoomBattleTimeout(normalizedRoomId)
  if (!isTurnTimerEnabled()) return

  const room = await store.getRoom(normalizedRoomId)
  if (!room) return
  const storage = getBattleStorage(room)
  const state = storage?.state as BattleState | undefined
  if (!state || state.terminalResult) return

  const baseClock = options.clock ?? systemDeploymentRuleClock
  const authorityClock = getRoomAuthorityClock(normalizedRoomId, baseClock)
  const nextWake = nextAuthorityWake(state)
  if (!nextWake) return
  const delay = Math.max(0, nextWake.at - authorityClock.now())
  const timer = setTimeout(async () => {
    const firedAt = authorityClock.now()
    if (firedAt < nextWake.at) {
      await scheduleRoomBattleTimeout(store, normalizedRoomId, options)
      return
    }
    authorityTimers.delete(normalizedRoomId)
    try {
      const result = await dispatchRoomBattleAction(
        store,
        normalizedRoomId,
        undefined,
        nextWake.action(firedAt),
        {
          allowSystem: true,
          clock: baseClock,
          onCommittedBeforeTimerResume: options.onTransitionCommitted ? undefined : options.onCommitted,
        },
      )
      if (result.kind === 'applied') {
        if (result.transition) await options.onTransitionCommitted?.(result)
        if (!result.finalSnapshotAlreadyDelivered && !result.transition) {
          await options.onCommitted?.(result.snapshot)
        }
        if (getCurrentInputOwnerPlayerId(result.actionResult.state).trim().toLowerCase() === 'bot') {
          await options.onBotTurnReady?.(result.snapshot, result.actionResult.state)
        }
      }
      await scheduleRoomBattleTimeout(store, normalizedRoomId, options)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (code !== 'ROOM_NOT_FOUND' && code !== 'BATTLE_NOT_STARTED') {
        console.warn('[battle-timeout] failed', {
          roomId: normalizedRoomId,
          phase: state.deployment?.status ?? state.turn.phase,
          playerId: state.turnTimer?.ownerPlayerId,
          turn: state.turnTimer?.turnNumber,
          deadlineAt: state.deployment?.status === 'awaiting-locks'
            ? state.deployment.deadlineAt
            : state.turnTimer?.pendingResponse?.deadlineAt ?? state.turnTimer?.deadlineAt,
          pendingSelectionId: state.turnTimer?.pendingResponse?.selectionId,
          noAcceptedGameplayAction: state.turnTimer ? !state.turnTimer.acceptedGameplayAction : undefined,
          noOpStreak: state.turnTimer?.noOpStreaks[state.turnTimer.ownerPlayerId],
          code,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }, delay)
  ;(timer as AuthorityTimer & { unref?: () => void }).unref?.()
  authorityTimers.set(normalizedRoomId, timer)
}

/** Backward-compatible RED-31 name; it now schedules deployment or turn events. */
export const scheduleRoomDeploymentTimeout = scheduleRoomBattleTimeout

export function clearRoomBattleTimeout(roomId: string): void {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const timer = authorityTimers.get(normalizedRoomId)
  if (!timer) return
  clearTimeout(timer)
  authorityTimers.delete(normalizedRoomId)
}

export function resetRoomBattleAuthorityClock(roomId: string): void {
  const normalizedRoomId = roomId.trim().toLowerCase()
  roomAuthorityClocks.delete(normalizedRoomId)
}

/** Backward-compatible RED-31 name. */
export const clearRoomDeploymentTimeout = clearRoomBattleTimeout

export function getRoomBattleAuthorityNow(
  roomId: string,
  clock: DeploymentRuleClock = systemDeploymentRuleClock,
): number {
  return getRoomAuthorityNow(roomId, clock)
}

export async function runWithRoomBattleAuthorityPaused<T>(
  roomId: string,
  operation: () => Promise<T>,
  clock: DeploymentRuleClock = systemDeploymentRuleClock,
): Promise<T> {
  return withPausedRoomAuthorityClock(roomId, clock, operation, { kind: 'bot' })
}

function projectRoomAuthorityNow(roomId: string, wallNow: number): number {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const state = roomAuthorityClocks.get(normalizedRoomId)
  if (!state) return wallNow
  return state.frozenNow ?? wallNow - state.excludedMs
}

function getRoomAuthorityNow(roomId: string, clock: DeploymentRuleClock): number {
  return projectRoomAuthorityNow(roomId, clock.now())
}

function getRoomAuthorityClock(
  roomId: string,
  baseClock: DeploymentRuleClock,
): DeploymentRuleClock {
  return {
    now: () => getRoomAuthorityNow(roomId, baseClock),
  }
}

async function withPausedRoomAuthorityClock<T>(
  roomId: string,
  clock: DeploymentRuleClock,
  operation: () => Promise<T>,
  context: RoomAuthorityEventContext = { kind: 'system' },
): Promise<T> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  return roomAuthorityQueue.enqueue(normalizedRoomId, context, async () => {
    const pausedAtWall = clock.now()
    const state = roomAuthorityClocks.get(normalizedRoomId) ?? { excludedMs: 0 }
    state.pausedAtWall = pausedAtWall
    state.frozenNow = pausedAtWall - state.excludedMs
    roomAuthorityClocks.set(normalizedRoomId, state)

    try {
      return await operation()
    } finally {
      const resumedAtWall = clock.now()
      const activeState = roomAuthorityClocks.get(normalizedRoomId)
      if (activeState?.pausedAtWall !== undefined) {
        activeState.excludedMs += Math.max(0, resumedAtWall - activeState.pausedAtWall)
        delete activeState.pausedAtWall
        delete activeState.frozenNow
      }
    }
  })
}
function pendingTimeoutIdentity(state: BattleState) {
  const pending = state.pendingOptionSelection || state.pendingTargetSelection
  const pendingOwnerPlayerId = pending
    ? ('ownerPlayerId' in pending && pending.ownerPlayerId
        ? pending.ownerPlayerId
        : pending.playerId)
    : null
  return {
    pendingOwnerPlayerId,
    pendingSelectionId: pending?.selectionId ?? null,
    pendingStateRevision: pending?.stateRevision ?? null,
  }
}

function createTurnTimeoutAction(
  state: BattleState,
  now: number,
  clientActionId: string,
): TurnTimeoutAction {
  const timer = state.turnTimer
  if (!timer) {
    throw new RoomBattleActionError('TURN_TIMER_MISSING', 'Cannot schedule a turn timeout without a running timer')
  }
  const pending = pendingTimeoutIdentity(state)
  return {
    type: 'turnTimeout',
    now,
    clientActionId,
    expectedTurnNumber: timer.turnNumber,
    expectedDeadlineAt: timer.deadlineAt,
    expectedInputOwnerPlayerId: timer.ownerPlayerId,
    expectedPendingOwnerPlayerId: pending.pendingOwnerPlayerId,
    expectedPendingSelectionId: pending.pendingSelectionId,
    expectedPendingStateRevision: pending.pendingStateRevision,
  }
}

function createPendingTimeoutAction(
  state: BattleState,
  now: number,
  clientActionId: string,
): PendingTimeoutAction {
  const timer = state.turnTimer
  const response = timer?.pendingResponse
  if (!timer || !response) {
    throw new RoomBattleActionError(
      'PENDING_TIMER_MISSING',
      'Cannot schedule a pending timeout without a running response timer',
    )
  }
  return {
    type: 'pendingTimeout',
    now,
    clientActionId,
    expectedTurnNumber: timer.turnNumber,
    expectedDeadlineAt: response.deadlineAt,
    expectedInputOwnerPlayerId: response.ownerPlayerId,
    expectedPendingSelectionId: response.selectionId,
    expectedPendingStateRevision: response.stateRevision,
  }
}

function matchesTurnTimeoutExpectation(
  state: BattleState,
  action: TurnTimeoutAction,
): boolean {
  if (action.expectedTurnNumber === undefined) return true
  const timer = state.turnTimer
  if (!timer
    || timer.turnNumber !== action.expectedTurnNumber
    || timer.deadlineAt !== action.expectedDeadlineAt
    || normalizePlayerId(timer.ownerPlayerId) !== normalizePlayerId(action.expectedInputOwnerPlayerId)) {
    return false
  }
  const pending = pendingTimeoutIdentity(state)
  const expectedPendingOwner = action.expectedPendingOwnerPlayerId
    ? normalizePlayerId(action.expectedPendingOwnerPlayerId)
    : null
  const currentPendingOwner = pending.pendingOwnerPlayerId
    ? normalizePlayerId(pending.pendingOwnerPlayerId)
    : null
  return currentPendingOwner === expectedPendingOwner
    && pending.pendingSelectionId === action.expectedPendingSelectionId
    && pending.pendingStateRevision === action.expectedPendingStateRevision
}

function matchesPendingTimeoutExpectation(
  state: BattleState,
  action: PendingTimeoutAction,
): boolean {
  if (action.expectedTurnNumber === undefined) return true
  const timer = state.turnTimer
  const response = timer?.pendingResponse
  const pending = state.pendingOptionSelection ?? state.pendingTargetSelection
  return !!timer
    && !!response
    && !!pending
    && timer.turnNumber === action.expectedTurnNumber
    && response.deadlineAt === action.expectedDeadlineAt
    && normalizePlayerId(response.ownerPlayerId) === normalizePlayerId(action.expectedInputOwnerPlayerId)
    && response.selectionId === action.expectedPendingSelectionId
    && response.stateRevision === action.expectedPendingStateRevision
    && pending.selectionId === response.selectionId
    && pending.stateRevision === response.stateRevision
}

function nextAuthorityWake(state: BattleState): {
  at: number
  action: (now: number) => BattleAction
} | undefined {
  if (state.deployment?.status === 'awaiting-locks') {
    const deadlineAt = state.deployment.deadlineAt
    return {
      at: deadlineAt,
      action: now => ({
        type: 'deploymentTimeout',
        now,
        clientActionId: `system-deployment-timeout:scheduled:${deadlineAt}`,
      }),
    }
  }
  const timer = state.turnTimer
  if (!timer || timer.status !== 'running') return undefined
  if (timer.pendingResponse) {
    const response = timer.pendingResponse
    return {
      at: response.deadlineAt,
      action: now => createPendingTimeoutAction(
        state,
        now,
        `system-pending-timeout:scheduled:${response.selectionId}:${response.deadlineAt}`,
      ),
    }
  }
  if (timer.burnPhase !== 'burning') {
    return {
      at: timer.burnStartsAt,
      action: now => ({
        type: 'turnTimerBurn',
        now,
        clientActionId: `system-turn-burn:${timer.turnNumber}:${timer.deadlineAt}`,
      }),
    }
  }
  return {
    at: timer.deadlineAt,
    action: now => createTurnTimeoutAction(
      state, now, `system-turn-timeout:scheduled:${timer.turnNumber}:${timer.deadlineAt}`),
  }
}

function normalizeSystemActionTime(action: BattleAction, now: number): BattleAction {
  if (action.type === 'deploymentTimeout') return { ...action, now }
  if (action.type === 'turnTimerBurn') return { ...action, now }
  if (action.type === 'pendingTimeout') return { ...action, now }
  if (action.type === 'turnTimeout') return { ...action, now }
  return action
}

function shouldSyncTurnTimer(
  previousState: BattleState,
  nextState: BattleState,
  action: BattleAction,
): boolean {
  if (nextState.terminalResult || action.type === 'turnTimerBurn' || action.type === 'turnTimerSync') return false
  if (previousState.turnTimer || nextState.turnTimer) return true
  return nextState.deployment?.status !== 'awaiting-locks' && nextState.turn.phase === 'action'
}

function isAlreadyCommittedSystemAction(state: BattleState, action: BattleAction): boolean {
  if (action.type === 'deploymentTimeout') return state.deployment?.status !== 'awaiting-locks'
  if (action.type === 'turnTimerBurn') {
    return !state.turnTimer || state.turnTimer.status !== 'running' || state.turnTimer.burnPhase === 'burning'
  }
  if (action.type === 'turnTimeout') {
    return !!state.terminalResult
      || !state.turnTimer
      || state.turnTimer.status !== 'running'
      || !matchesTurnTimeoutExpectation(state, action)
  }
  if (action.type === 'pendingTimeout') {
    return !!state.terminalResult
      || !state.turnTimer?.pendingResponse
      || !matchesPendingTimeoutExpectation(state, action)
  }
  return false
}

function assertRoomActionViewer(
  room: Room,
  viewerPlayerId: string | null | undefined,
  action: BattleAction,
  allowSystem: boolean,
): void {
  if (isSystemTimerAction(action)) {
    if (!allowSystem) {
      const deployment = action.type === 'deploymentTimeout'
      throw new RoomBattleActionError(
        deployment ? 'DEPLOYMENT_SYSTEM_ACTION_FORBIDDEN' : 'TURN_TIMER_SYSTEM_ACTION_FORBIDDEN',
        deployment
          ? 'Deployment timeout may only be issued by the authoritative server clock'
          : 'Turn timer events may only be issued by the authoritative server clock',
      )
    }
    return
  }

  assertActionPlayer(viewerPlayerId, action)
  const normalizedViewer = normalizePlayerId(viewerPlayerId)
  if (!normalizedViewer || !room.players.some(player => normalizePlayerId(player.id) === normalizedViewer)) {
    throw new RoomBattleActionError(
      'VIEWER_FORBIDDEN',
      'Only a participating player may submit a battle command',
    )
  }
}

function isSystemTimerAction(action: BattleAction): boolean {
  return action.type === 'deploymentTimeout'
    || action.type === 'turnTimerSync'
    || action.type === 'turnTimerBurn'
    || action.type === 'pendingTimeout'
    || action.type === 'turnTimeout'
}

function roomAuthorityEventKind(
  action: BattleAction,
  viewerPlayerId: string | null | undefined,
  allowSystem: boolean,
): RoomAuthorityEventContext['kind'] {
  if (isSystemTimerAction(action)) return 'timer'
  if (
    action.type === 'pendingOptionSelect'
    || action.type === 'pendingTargetSelect'
    || action.type === 'cancelPendingSelection'
  ) return 'pending'
  const actorPlayerId = 'playerId' in action ? action.playerId : viewerPlayerId
  if (typeof actorPlayerId === 'string' && actorPlayerId.trim().toLowerCase() === 'bot') return 'bot'
  if (allowSystem && !viewerPlayerId) return 'system'
  return 'player'
}

function decorateRoomActionError(
  error: unknown,
  roomId: string,
  room: Room,
  storage: ServerBattleState,
  action: BattleAction,
  viewerPlayerId: string | null | undefined,
): Error {
  const decorated = error instanceof Error ? error : new Error(String(error))
  const candidateCode = (decorated as unknown as { code?: unknown }).code
  const code = typeof candidateCode === 'string'
    ? candidateCode
    : 'BATTLE_ACTION_REJECTED'
  const context = {
    ...roomActionContext(roomId, room, storage, action, viewerPlayerId),
    ...((decorated as { determinism?: Record<string, unknown> }).determinism ?? {}),
  }
  Object.assign(decorated, { code, context })
  console.warn('[battle-action] rejected', { code, ...context, error: decorated.message })
  return decorated
}

function roomActionContext(
  roomId: string,
  room: Room,
  storage: ServerBattleState,
  action: BattleAction,
  viewerPlayerId: string | null | undefined,
): Record<string, unknown> {
  const state = storage.state as BattleState
  const timer = state.turnTimer
  return {
    roomId,
    playerId: 'playerId' in action ? action.playerId : timer?.ownerPlayerId ?? 'system',
    viewerPlayerId: normalizePlayerId(viewerPlayerId) || undefined,
    phase: state.deployment?.status ?? state.turn?.phase ?? 'unknown',
    turn: state.turn?.turnNumber,
    fullRound: timer?.fullRound,
    deadlineAt: state.deployment?.status === 'awaiting-locks'
      ? state.deployment.deadlineAt
      : timer?.deadlineAt,
    acceptedGameplayAction: timer?.acceptedGameplayAction,
    noOpStreak: timer?.noOpStreaks[timer.ownerPlayerId],
    actionId: 'clientActionId' in action ? action.clientActionId : undefined,
    authorityVersion: roomBattleAuthorityVersion(room),
    seed: storage.rootSeed,
  }
}

function actionClientActionId(action: BattleAction): string | undefined {
  if (!('clientActionId' in action) || typeof action.clientActionId !== 'string') return undefined
  const normalized = action.clientActionId.trim()
  return normalized || undefined
}

function actionIdPart(action: BattleAction): string {
  return actionClientActionId(action) ?? action.type
}

function getAuthorityStateHashIndex(
  roomId: string,
  authorityVersion: number,
  state: BattleState,
): BattleStateHashIndex {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const cached = authorityStateHashIndexes.get(normalizedRoomId)
  if (cached?.authorityVersion === authorityVersion) return cached.index
  const index = createBattleStateHashIndex(withoutServerSkills(state) as BattleState)
  authorityStateHashIndexes.set(normalizedRoomId, { authorityVersion, index })
  return index
}

function getPublicStateHashIndex(
  roomId: string,
  viewerPlayerId: string | undefined,
  authorityVersion: number,
  state: BattleState,
): BattleStateHashIndex {
  const key = publicHashCacheKey(roomId, viewerPlayerId)
  const cached = publicStateHashIndexes.get(key)
  if (cached?.authorityVersion === authorityVersion) return cached.index
  return cachePublicStateHashIndex(roomId, viewerPlayerId, authorityVersion, state)
}

function cachePublicStateHashIndex(
  roomId: string,
  viewerPlayerId: string | undefined,
  authorityVersion: number,
  state: BattleState,
): BattleStateHashIndex {
  const key = publicHashCacheKey(roomId, viewerPlayerId)
  const index = buildBattleStateHashIndex(state, hashStable)
  publicStateHashIndexes.set(key, { authorityVersion, index })
  return index
}

function publicHashCacheKey(roomId: string, viewerPlayerId: string | undefined): string {
  return `${roomId.trim().toLowerCase()}::${normalizePlayerId(viewerPlayerId) || '*'}`
}

function duplicateResult(state: BattleState): BattleActionResult {
  return {
    state,
    stateHash: hashBattleState(state),
    actionHash: '',
    duplicate: true,
  }
}

function normalizePlayerId(playerId: unknown): string {
  return typeof playerId === 'string' ? playerId.trim().toLowerCase() : ''
}

function cloneBattleAuthorityJson<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new Error('Battle authority value has no JSON representation')
    }
    return JSON.parse(serialized) as T
  } catch (error) {
    throw new RoomBattleActionError(
      'BATTLE_AUTHORITY_SERIALIZATION_FAILED',
      error instanceof Error ? error.message : 'Battle authority state is not JSON serializable',
    )
  }
}

function monotonicNow(): number {
  return globalThis.performance.now()
}

function roundTiming(value: number): number {
  return Math.round(value * 1_000) / 1_000
}
