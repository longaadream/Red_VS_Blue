import { getBattleStorage, type ServerBattleState } from './battle-storage'
import { hashBattleState, runBattleAction, type BattleActionResult } from './battle-runner'
import {
  systemDeploymentRuleClock,
  toPublicBattleState,
  type DeploymentRuleClock,
} from './deployment'
import { stampPendingDeploymentAuthorityVersion } from './battle-trace'
import type { Room } from './room-store'
import { assertActionPlayer } from './targeting'
import { isAcceptedGameplayAction, projectTurnTimer, type TurnTimerProjection } from './turn-timer'
import type { BattleAction, BattleState } from './turn'

const MAX_ROOM_ACTION_ATTEMPTS = 5

export interface DeploymentRoomStore {
  getRoom(roomId: string): Promise<Room | undefined>
  setRoom(roomId: string, room: Room): Promise<void>
  setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean>
}

export interface PublicBattleSnapshot {
  state: BattleState
  seed: number
  stateHash: string
  authorityVersion: number
  acceptedClientActionId?: string
  serverNow: number
  turnTimer?: TurnTimerProjection
}

export interface DispatchRoomBattleActionResult {
  kind: 'applied' | 'duplicate' | 'expired'
  expiredReason?: 'deployment' | 'turn'
  snapshot: PublicBattleSnapshot
  /** Final authoritative result, including an internal timer sync when needed. */
  actionResult: BattleActionResult
  /** Result of the command submitted by the caller, before an internal timer sync. */
  submittedActionResult?: BattleActionResult
  /** True when the pre-resume transport callback already sent this exact snapshot. */
  finalSnapshotAlreadyDelivered?: boolean
}

export interface PreResumeDeliveryContext {
  kind: 'applied' | 'expired'
  expiredReason?: 'deployment' | 'turn'
  actionHash?: string
}

export interface DispatchRoomBattleActionOptions {
  allowSystem?: boolean
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
  onBotTurnReady?: (snapshot: PublicBattleSnapshot) => void | Promise<void>
}

export type ScheduleDeploymentTimeoutOptions = ScheduleBattleTimeoutOptions

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
  __rvbRoomDispatchLocks?: Map<string, Promise<void>>
}
const authorityTimers = (timerGlobal.__rvbDeploymentTimers ??= new Map())
const roomAuthorityClocks = (timerGlobal.__rvbRoomAuthorityClocks ??= new Map())
const roomDispatchLocks = (timerGlobal.__rvbRoomDispatchLocks ??= new Map())

export function createPublicBattleSnapshot(
  room: Room,
  viewerPlayerId?: string,
  clock: DeploymentRuleClock = systemDeploymentRuleClock,
  acceptedClientActionId?: string,
): PublicBattleSnapshot {
  const storage = getBattleStorage(room)
  if (!storage) throw new RoomBattleActionError('BATTLE_NOT_STARTED', 'Battle not started')
  const state = toPublicBattleState(storage.state as BattleState, viewerPlayerId)
  const serverNow = getRoomAuthorityNow(room.id, clock)
  return {
    state,
    seed: storage.seed,
    stateHash: hashBattleState(state),
    authorityVersion: typeof room.version === 'number' ? room.version : 0,
    ...(acceptedClientActionId ? { acceptedClientActionId } : {}),
    serverNow,
    turnTimer: state.terminalResult ? undefined : projectTurnTimer(state.turnTimer, serverNow),
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
  // Commands queued behind another commit retain their original logical arrival
  // so lock/storage/transport work never becomes player thinking time.
  const receivedAt = projectRoomAuthorityNow(normalizedRoomId, wallArrival)

  return withPausedRoomAuthorityClock(normalizedRoomId, clock, async () => {
    for (let attempt = 0; attempt < MAX_ROOM_ACTION_ATTEMPTS; attempt += 1) {
    const room = await store.getRoom(normalizedRoomId)
    if (!room) throw new RoomBattleActionError('ROOM_NOT_FOUND', 'Room not found', { roomId: normalizedRoomId })
    const storage = getBattleStorage(room)
    if (!storage) throw new RoomBattleActionError('BATTLE_NOT_STARTED', 'Battle not started', { roomId: normalizedRoomId })
    const state = storage.state as BattleState

    try {
      assertRoomActionViewer(room, viewerPlayerId, action, options.allowSystem === true)
    } catch (error) {
      throw decorateRoomActionError(error, normalizedRoomId, room, storage, action, viewerPlayerId)
    }

    if (isAlreadyCommittedSystemAction(state, action)) {
      return {
        kind: 'duplicate',
        snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined, clock),
        actionResult: duplicateResult(state),
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
      ? {
          type: 'turnTimeout',
          now: receivedAt,
          clientActionId: `system-turn-timeout:${normalizedRoomId}:${state.turnTimer!.turnNumber}:${state.turnTimer!.deadlineAt}`,
        }
      : normalizeSystemActionTime(action, receivedAt)

    let submittedActionResult: BattleActionResult
    try {
      submittedActionResult = runBattleAction(state, actionToApply, { rootSeed: storage.seed })
    } catch (error) {
      throw decorateRoomActionError(error, normalizedRoomId, room, storage, actionToApply, viewerPlayerId)
    }

    if (submittedActionResult.duplicate) {
      return {
        kind: 'duplicate',
        snapshot: createPublicBattleSnapshot(
          room, viewerPlayerId ?? undefined, clock, acceptedClientActionId(actionToApply),
        ),
        actionResult: submittedActionResult,
      }
    }

    let actionResult = submittedActionResult
    if (shouldSyncTurnTimer(state, submittedActionResult.state, actionToApply)) {
      const resumedAt = getRoomAuthorityNow(normalizedRoomId, clock)
      const actorPlayerId = 'playerId' in actionToApply ? actionToApply.playerId : undefined
      const acceptedActionType = isAcceptedGameplayAction(actionToApply)
        ? actionToApply.type
        : undefined
      const syncAction: BattleAction = {
        type: 'turnTimerSync',
        receivedAt,
        now: resumedAt,
        actorPlayerId,
        acceptedActionType,
        clientActionId: `system-turn-timer-sync:${normalizedRoomId}:${room.version}:${actionIdPart(actionToApply)}`,
      }
      try {
        actionResult = runBattleAction(submittedActionResult.state, syncAction, { rootSeed: storage.seed })
      } catch (error) {
        throw decorateRoomActionError(error, normalizedRoomId, room, storage, syncAction, viewerPlayerId)
      }
    }

    if (typeof room.version !== 'number') {
      throw new RoomBattleActionError(
        'AUTHORITY_VERSION_MISSING',
        'Authoritative room version is required for battle actions',
        roomActionContext(normalizedRoomId, room, storage, actionToApply, viewerPlayerId),
      )
    }

    const nextAuthorityVersion = room.version + 1
    stampPendingDeploymentAuthorityVersion(actionResult.state, nextAuthorityVersion)
    const nextStorage: ServerBattleState = {
      type: 'server-state',
      seed: storage.seed,
      state: actionResult.state,
    }
    const isTerminal = actionResult.state.terminalResult?.status === 'finished'
    const nextRoom: Room = {
      ...room,
      battleState: nextStorage as unknown as Room['battleState'],
      ...(isTerminal ? { status: 'finished' as const } : {}),
    }
    if (!await store.setRoomIfVersion(normalizedRoomId, nextRoom, room.version)) continue
    const committedRoom: Room = { ...nextRoom, version: nextAuthorityVersion }
    const snapshot = createPublicBattleSnapshot(
      committedRoom,
      viewerPlayerId ?? undefined,
      clock,
      deploymentExpired || turnExpired ? undefined : acceptedClientActionId(actionToApply),
    )
    if (isTerminal) clearRoomBattleTimeout(normalizedRoomId)
    const expired = deploymentExpired || turnExpired
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
    }
  }

    throw new RoomBattleActionError(
      'ROOM_VERSION_CONFLICT',
      'Battle action could not commit because the room changed concurrently',
      { roomId: normalizedRoomId },
    )
  })
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
          onCommittedBeforeTimerResume: options.onCommitted,
        },
      )
      if (result.kind === 'applied') {
        if (!result.finalSnapshotAlreadyDelivered) {
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
  return withPausedRoomAuthorityClock(roomId, clock, operation)
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
): Promise<T> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const release = await acquireRoomDispatchLock(normalizedRoomId)
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
    release()
  }
}

async function acquireRoomDispatchLock(roomId: string): Promise<() => void> {
  let releaseCurrent!: () => void
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve
  })
  const previous = roomDispatchLocks.get(roomId) ?? Promise.resolve()
  const tail = previous.then(() => current)
  roomDispatchLocks.set(roomId, tail)
  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    releaseCurrent()
    if (roomDispatchLocks.get(roomId) === tail) {
      roomDispatchLocks.delete(roomId)
    }
  }
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
    action: now => ({
      type: 'turnTimeout',
      now,
      clientActionId: `system-turn-timeout:scheduled:${timer.turnNumber}:${timer.deadlineAt}`,
    }),
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
    return !!state.terminalResult || !state.turnTimer || state.turnTimer.status !== 'running'
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
    authorityVersion: room.version,
    seed: storage.seed,
  }
}

function acceptedClientActionId(action: BattleAction): string | undefined {
  if (isSystemTimerAction(action)) return undefined
  if (!('clientActionId' in action) || typeof action.clientActionId !== 'string') return undefined
  return action.clientActionId.trim() ? action.clientActionId : undefined
}

function actionIdPart(action: BattleAction): string {
  if ('clientActionId' in action && action.clientActionId) return action.clientActionId
  return action.type
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
