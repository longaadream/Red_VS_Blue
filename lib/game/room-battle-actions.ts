import { getBattleStorage, type ServerBattleState } from './battle-storage'
import { createBattlePublicPatch, hashPublicBattleState } from './battle-public-patch'
import { hashBattleState, runBattleAction, type BattleActionResult } from './battle-runner'
import {
  systemDeploymentRuleClock,
  toPublicBattleState,
  type DeploymentRuleClock,
} from './deployment'
import {
  compactBattleTraceForAuthority,
  materializeBattleTraceForTerminal,
  stampPendingDeploymentAuthorityVersion,
} from './battle-trace'
import {
  buildBattleAuthorityTransition,
  checkpointReasonForTransition,
  createBattleAuthorityReceipt,
  isBattleAuthorityV2Enabled,
  roomBattleAuthorityVersion,
  type BattleAuthorityCheckpointRecord,
  type BattleAuthorityReceipt,
  type BattleAuthorityTransitionRecord,
} from './battle-transition'
import { roomAuthorityQueue, type RoomAuthorityEventContext } from './room-authority-queue'
import type { Room } from './room-store'
import { assertActionPlayer } from './targeting'
import { isAcceptedGameplayAction, projectTurnTimer, type TurnTimerProjection } from './turn-timer'
import type { BattleAction, BattleState } from './turn'

const MAX_ROOM_ACTION_ATTEMPTS = 5

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
    baseCheckpoint?: BattleAuthorityCheckpointRecord
    checkpoint?: BattleAuthorityCheckpointRecord
  }): Promise<boolean>
  readBattleAuthorityHistory?(roomId: string): Promise<Array<{
    trace?: BattleAuthorityTransitionRecord['traces'][number]
    command?: Record<string, unknown>
    replayFrame?: BattleAuthorityTransitionRecord['replayFrames'][number]
  }>>
}

export interface PublicBattleSnapshot {
  state: BattleState
  seed: number
  stateHash: string
  authorityVersion: number
  serverNow: number
  turnTimer?: TurnTimerProjection
}

export interface DispatchRoomBattleActionResult {
  kind: 'applied' | 'duplicate' | 'expired' | 'resyncRequired'
  expiredReason?: 'deployment' | 'turn'
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
  protocolVersion: 2
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
  turnTimer?: TurnTimerProjection
  timings?: BattleAuthorityTimings
}

export interface PreResumeDeliveryContext {
  kind: 'applied' | 'expired'
  expiredReason?: 'deployment' | 'turn'
  actionHash?: string
}

export interface DispatchRoomBattleActionOptions {
  allowSystem?: boolean
  expectedAuthorityVersion?: number
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
  onBotTurnReady?: (snapshot: PublicBattleSnapshot) => void | Promise<void>
}

export type ScheduleDeploymentTimeoutOptions = ScheduleBattleTimeoutOptions
type TurnTimeoutAction = Extract<BattleAction, { type: 'turnTimeout' }>

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
  const state = toPublicBattleState(storage.state as BattleState, viewerPlayerId)
  const serverNow = getRoomAuthorityNow(room.id, clock)
  return {
    state,
    seed: storage.seed,
    stateHash: hashBattleState(state),
    authorityVersion: roomBattleAuthorityVersion(room),
    serverNow,
    turnTimer: state.terminalResult ? undefined : projectTurnTimer(state.turnTimer, serverNow),
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
  const previous = toPublicBattleState(result.previousAuthorityState, viewerPlayerId)
  const next = toPublicBattleState(result.nextAuthorityState, viewerPlayerId)
  const serverNow = getRoomAuthorityNow(roomId, clock)
  return {
    type: 'battleTransition',
    protocolVersion: 2,
    roomId: roomId.trim().toLowerCase(),
    fromVersion: transition.fromVersion,
    toVersion: transition.toVersion,
    prePublicHash: hashPublicBattleState(previous),
    postPublicHash: hashPublicBattleState(next),
    patch: createBattlePublicPatch(previous, next),
    receipt: result.receipt,
    pending: transition.pending,
    seed: result.snapshot.seed,
    stateHash: hashBattleState(next),
    serverNow,
    turnTimer: next.terminalResult ? undefined : projectTurnTimer(next.turnTimer, serverNow),
    timings: result.timings,
  }
}

export function createPublicRoomSnapshot(room: Room): Room {
  const storage = getBattleStorage(room)
  if (!storage) return room
  const snapshot = createPublicBattleSnapshot(room)
  const publicStorage: ServerBattleState = {
    type: 'server-state',
    seed: snapshot.seed,
    state: snapshot.state,
  }
  return {
    ...room,
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
    kind: isSystemTimerAction(action) ? 'timer' : 'player',
    actionId: requestedClientActionId,
    playerId: 'playerId' in action ? action.playerId : viewerPlayerId ?? undefined,
    authorityVersion: options.expectedAuthorityVersion,
  }

  return withPausedRoomAuthorityClock(normalizedRoomId, clock, async () => {
    queueMs = monotonicNow() - performanceStartedAt
    for (let attempt = 0; attempt < MAX_ROOM_ACTION_ATTEMPTS; attempt += 1) {
      const room = await store.getRoom(normalizedRoomId)
      if (!room) throw new RoomBattleActionError('ROOM_NOT_FOUND', 'Room not found', { roomId: normalizedRoomId })
      const storage = getBattleStorage(room)
      if (!storage) throw new RoomBattleActionError('BATTLE_NOT_STARTED', 'Battle not started', { roomId: normalizedRoomId })
      const state = storage.state as BattleState
      if (!Number.isSafeInteger(room.version) || Number(room.version) < 0) {
        throw new RoomBattleActionError(
          'ROOM_VERSION_MISSING',
          'Room metadata version is required for battle actions',
          roomActionContext(normalizedRoomId, room, storage, action, viewerPlayerId),
        )
      }
      const metadataVersion = Number(room.version)
      const authorityVersion = roomBattleAuthorityVersion(room)

      const authorityV2 = isBattleAuthorityV2Enabled()
        && !!requestedClientActionId
        && !!store.getBattleAuthorityReceipt
        && !!store.persistBattleAuthorityReceipt
        && !!store.commitBattleAuthorityTransition
      if (isBattleAuthorityV2Enabled() && process.env.NODE_ENV !== 'test' && !authorityV2) {
        throw new RoomBattleActionError(
          'AUTHORITY_V2_STORE_UNAVAILABLE',
          'Battle authority v2 requires receipt and transition persistence',
          roomActionContext(normalizedRoomId, room, storage, action, viewerPlayerId),
        )
      }

      try {
        assertRoomActionViewer(room, viewerPlayerId, action, options.allowSystem === true)
      } catch (error) {
        const decorated = decorateRoomActionError(error, normalizedRoomId, room, storage, action, viewerPlayerId)
        if (authorityV2) {
          const receipt = createBattleAuthorityReceipt({
            roomId: normalizedRoomId,
            clientActionId: requestedClientActionId!,
            status: 'rejected',
            authorityVersion,
            code: (decorated as { code?: string }).code ?? 'BATTLE_ACTION_REJECTED',
            message: decorated.message,
          })
          await store.persistBattleAuthorityReceipt!(receipt)
          Object.assign(decorated, { receipt })
        }
        throw decorated
      }

      if (authorityV2) {
        const existing = await store.getBattleAuthorityReceipt!(normalizedRoomId, requestedClientActionId!)
        if (existing) {
          const receipt = createBattleAuthorityReceipt({
            roomId: normalizedRoomId,
            clientActionId: requestedClientActionId!,
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
        if (
          options.expectedAuthorityVersion !== undefined
          && options.expectedAuthorityVersion !== authorityVersion
        ) {
          const receipt = createBattleAuthorityReceipt({
            roomId: normalizedRoomId,
            clientActionId: requestedClientActionId!,
            status: 'resyncRequired',
            authorityVersion,
            code: 'AUTHORITY_VERSION_MISMATCH',
            message: `Expected authority version ${options.expectedAuthorityVersion}, current version is ${authorityVersion}`,
          })
          await store.persistBattleAuthorityReceipt!(receipt)
          return {
            kind: 'resyncRequired',
            snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined, clock),
            actionResult: duplicateResult(state),
            receipt,
          }
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

      const deploymentExpired = action.type !== 'deploymentTimeout'
        && state.deployment?.status === 'awaiting-locks'
        && receivedAt >= state.deployment.deadlineAt
      const turnExpired = !deploymentExpired
        && action.type !== 'turnTimeout'
        && state.deployment?.status !== 'awaiting-locks'
        && state.turnTimer?.status === 'running'
        && receivedAt >= state.turnTimer.deadlineAt

      const actionToApply: BattleAction = deploymentExpired
        ? {
            type: 'deploymentTimeout',
            now: receivedAt,
            clientActionId: `system-deployment-timeout:${normalizedRoomId}:${state.deployment!.deadlineAt}`,
          }
        : turnExpired
        ? createTurnTimeoutAction(
            state,
            receivedAt,
            `system-turn-timeout:${normalizedRoomId}:${state.turnTimer!.turnNumber}:${state.turnTimer!.deadlineAt}`,
          )
        : normalizeSystemActionTime(action, receivedAt)

      let submittedActionResult: BattleActionResult
      try {
        const rulesStartedAt = monotonicNow()
        submittedActionResult = runBattleAction(state, actionToApply, { rootSeed: storage.seed })
        rulesMs += monotonicNow() - rulesStartedAt
      } catch (error) {
        const decorated = decorateRoomActionError(error, normalizedRoomId, room, storage, actionToApply, viewerPlayerId)
        if (authorityV2) {
          const receipt = createBattleAuthorityReceipt({
            roomId: normalizedRoomId,
            clientActionId: requestedClientActionId!,
            status: 'rejected',
            authorityVersion,
            code: (decorated as { code?: string }).code ?? 'BATTLE_ACTION_REJECTED',
            message: decorated.message,
          })
          await store.persistBattleAuthorityReceipt!(receipt)
          Object.assign(decorated, { receipt })
        }
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
      if (shouldSyncTurnTimer(state, submittedActionResult.state, actionToApply)) {
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
          actionResult = runBattleAction(submittedActionResult.state, syncAction, { rootSeed: storage.seed })
          rulesMs += monotonicNow() - syncRulesStartedAt
        } catch (error) {
          const decorated = decorateRoomActionError(error, normalizedRoomId, room, storage, syncAction, viewerPlayerId)
          if (authorityV2) {
            const receipt = createBattleAuthorityReceipt({
              roomId: normalizedRoomId,
              clientActionId: requestedClientActionId!,
              status: 'rejected',
              authorityVersion,
              code: (decorated as { code?: string }).code ?? 'BATTLE_ACTION_REJECTED',
              message: decorated.message,
            })
            await store.persistBattleAuthorityReceipt!(receipt)
            Object.assign(decorated, { receipt })
          }
          throw decorated
        }
      }

      const nextAuthorityVersion = authorityV2 ? authorityVersion + 1 : metadataVersion + 1
      stampPendingDeploymentAuthorityVersion(actionResult.state, nextAuthorityVersion)
      const previousAuthorityState = state
      const nextAuthorityState = actionResult.state
      const previousPublicState = toPublicBattleState(previousAuthorityState)
      const nextPublicState = toPublicBattleState(nextAuthorityState)
      const compactedState = authorityV2
        ? compactBattleTraceForAuthority(nextAuthorityState)
        : nextAuthorityState
      const nextStorage: ServerBattleState = {
        type: 'server-state',
        seed: storage.seed,
        state: compactedState,
      }
      const commands = syncAction ? [actionToApply, syncAction] : [actionToApply]
      const traces = [submittedActionResult.trace, syncAction ? actionResult.trace : undefined]
        .filter((trace): trace is NonNullable<typeof trace> => !!trace)
      const replayFrames = [submittedActionResult.replayFrame, syncAction ? actionResult.replayFrame : undefined]
        .filter((frame): frame is NonNullable<typeof frame> => !!frame)
      const transitionPlayerId = 'playerId' in action
        ? action.playerId
        : viewerPlayerId ?? 'system'
      const transition = authorityV2
        ? buildBattleAuthorityTransition({
            roomId: normalizedRoomId,
            fromVersion: authorityVersion,
            clientActionId: requestedClientActionId!,
            playerId: transitionPlayerId,
            command: actionToApply,
            commands,
            previousStorage: storage,
            nextStorage,
            previousPublicState,
            nextPublicState,
            preStateHash: hashBattleState(state),
            postStateHash: hashBattleState(compactedState),
            traces,
            replayFrames,
            now: receivedAt,
          })
        : undefined
      const expired = deploymentExpired || turnExpired
      if (transition && expired) {
        transition.receipt = createBattleAuthorityReceipt({
          roomId: normalizedRoomId,
          clientActionId: requestedClientActionId!,
          status: 'rejected',
          authorityVersion: nextAuthorityVersion,
          code: turnExpired ? 'TURN_EXPIRED' : 'DEPLOYMENT_EXPIRED',
          message: turnExpired
            ? 'Turn deadline elapsed; the authoritative timeout was committed instead.'
            : 'Deployment deadline elapsed; the authoritative timeout was committed instead.',
        })
      }

      const isTerminal = nextAuthorityState.terminalResult?.status === 'finished'
      const baseCheckpoint: BattleAuthorityCheckpointRecord | undefined = transition && authorityVersion === 0
        ? {
            protocolVersion: 2,
            roomId: normalizedRoomId,
            authorityVersion,
            seed: storage.seed,
            storage,
            stateHash: transition.preStateHash,
            publicHash: transition.prePublicHash,
            reason: 'initial',
            createdAt: receivedAt,
          }
        : undefined
      let checkpoint: BattleAuthorityCheckpointRecord | undefined
      if (transition) {
        const reason = checkpointReasonForTransition(state, nextAuthorityState, nextAuthorityVersion)
        if (reason) {
          let checkpointStorage = nextStorage
          if (reason === 'terminal' && store.readBattleAuthorityHistory) {
            const materializedState = structuredClone(compactedState)
            const existingHistory = await store.readBattleAuthorityHistory(normalizedRoomId)
            const currentHistory = commands.map((command, index) => ({
              command: command as unknown as Record<string, unknown>,
              trace: traces[index],
              replayFrame: replayFrames[index],
            }))
            materializeBattleTraceForTerminal(materializedState, [...existingHistory, ...currentHistory])
            checkpointStorage = {
              type: 'server-state',
              seed: storage.seed,
              state: materializedState,
            }
          }
          checkpoint = {
            protocolVersion: 2,
            roomId: normalizedRoomId,
            authorityVersion: nextAuthorityVersion,
            seed: storage.seed,
            storage: checkpointStorage,
            stateHash: hashBattleState(checkpointStorage.state as BattleState),
            publicHash: transition.postPublicHash,
            reason,
            createdAt: receivedAt,
          }
        }
      }

      const committedStorage = checkpoint?.storage ?? nextStorage
      const nextRoom: Room = {
        ...room,
        battleState: committedStorage as unknown as Room['battleState'],
        ...(isTerminal ? { status: 'finished' as const } : {}),
      }
      const persistenceStartedAt = monotonicNow()
      const committed = transition
        ? await store.commitBattleAuthorityTransition!({
            roomId: normalizedRoomId,
            expectedVersion: authorityVersion,
            nextRoom,
            transition,
            baseCheckpoint,
            checkpoint,
          })
        : await store.setRoomIfVersion(normalizedRoomId, nextRoom, metadataVersion)
      persistenceMs += monotonicNow() - persistenceStartedAt
      if (!committed) continue

      const committedRoom: Room = transition
        ? { ...nextRoom, battleAuthorityVersion: nextAuthorityVersion }
        : { ...nextRoom, version: nextAuthorityVersion }
      const snapshot = createPublicBattleSnapshot(committedRoom, viewerPlayerId ?? undefined, clock)
      if (isTerminal) clearRoomBattleTimeout(normalizedRoomId)
      let delivered = false
      if (options.onCommittedBeforeTimerResume) {
        await options.onCommittedBeforeTimerResume(snapshot, {
          kind: expired ? 'expired' : 'applied',
          ...(deploymentExpired ? { expiredReason: 'deployment' as const } : {}),
          ...(turnExpired ? { expiredReason: 'turn' as const } : {}),
          actionHash: submittedActionResult.actionHash,
        })
        delivered = true
      }
      return {
        kind: expired ? 'expired' : 'applied',
        ...(deploymentExpired ? { expiredReason: 'deployment' as const } : {}),
        ...(turnExpired ? { expiredReason: 'turn' as const } : {}),
        snapshot,
        actionResult,
        submittedActionResult,
        finalSnapshotAlreadyDelivered: delivered,
        receipt: transition?.receipt,
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
    }

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
        if (
          result.snapshot.state.turn.phase === 'action'
          && result.snapshot.state.turn.currentPlayerId === 'bot'
        ) {
          await options.onBotTurnReady?.(result.snapshot)
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
            : state.turnTimer?.deadlineAt,
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
    || action.type === 'turnTimeout'
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
    seed: storage.seed,
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
function monotonicNow(): number {
  return globalThis.performance.now()
}

function roundTiming(value: number): number {
  return Math.round(value * 1_000) / 1_000
}
