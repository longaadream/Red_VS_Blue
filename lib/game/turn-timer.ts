import type { BattleAction, BattleState, PlayerId } from './turn'

export const TURN_BURN_WINDOW_MS = 15_000
export const TURN_FAST_DURATION_MS = 20_000
export const TURN_TIMEOUT_FORFEIT_STREAK = 3
export const PENDING_RESPONSE_DURATION_MS = 15_000

export function isTurnTimerEnabled(): boolean {
  const configured = String(process.env.RVB_TURN_TIMER_ENABLED ?? '').trim().toLowerCase()
  return configured === '1' || configured === 'true' || configured === 'on'
}

export interface AuthoritativeRuleClock {
  now(): number
}

export interface TurnTimeoutRecord {
  playerId: PlayerId
  turnNumber: number
  fullRound: number
  at: number
  noAcceptedGameplayAction: boolean
  countsTowardNoOpStreak: boolean
  streak: number
  reason: 'no-action-timeout' | 'action-timeout'
}

export interface TurnTimerInputWindowState {
  durationMs: number
  remainingMs: number
  burnPhase: 'normal' | 'burning'
  fast: boolean
  acceptedGameplayAction: boolean
}

export type PendingTimeoutResolution =
  | { kind: 'cancel' }
  | { kind: 'option'; selectedOption: unknown }
  | {
      kind: 'target'
      targetPieceId?: string
      targetX?: number
      targetY?: number
      extraTargets?: Array<{ pieceId?: string; x?: number; y?: number }>
    }

export interface PendingResponseTimerState {
  status: 'running'
  ownerPlayerId: PlayerId
  selectionId: string
  stateRevision: number
  durationMs: typeof PENDING_RESPONSE_DURATION_MS
  startedAt: number
  deadlineAt: number
  timeoutResolution: PendingTimeoutResolution
}

export interface TurnTimerState {
  status: 'running' | 'stopped'
  ownerPlayerId: PlayerId
  /** Active turn player; may differ while the opponent owns a pending input. */
  turnOwnerPlayerId: PlayerId
  inputOwnerPlayerId: PlayerId
  turnNumber: number
  fullRound: number
  durationMs: number
  remainingMs: number
  startedAt: number
  deadlineAt: number
  burnStartsAt: number
  burnPhase: 'normal' | 'burning'
  fast: boolean
  acceptedGameplayAction: boolean
  /** Ordinary turn budgets retained across pause/resume boundaries. */
  inputWindows: Record<PlayerId, TurnTimerInputWindowState>
  /** Independent response clock. While present, the ordinary turn budget is frozen. */
  pendingResponse?: PendingResponseTimerState
  noOpStreaks: Record<PlayerId, number>
  lastPausedAt?: number
  lastResumedAt?: number
  lastAcceptedActionType?: BattleAction['type']
  lastTimeout?: TurnTimeoutRecord
}

export interface TurnTimerProjection {
  ownerPlayerId: PlayerId
  turnOwnerPlayerId: PlayerId
  inputOwnerPlayerId: PlayerId
  turnNumber: number
  fullRound: number
  durationMs: number
  remainingMs: number
  remainingSeconds: number
  deadlineAt: number
  burnStartsAt: number
  burning: boolean
  fast: boolean
  status: TurnTimerState['status']
  paused: boolean
}

export interface PendingTimerProjection {
  ownerPlayerId: PlayerId
  selectionId: string
  stateRevision: number
  durationMs: number
  remainingMs: number
  remainingSeconds: number
  deadlineAt: number
  status: PendingResponseTimerState['status']
}

const monotonicGlobal = globalThis as typeof globalThis & {
  __rvbLastAuthoritativeNow?: number
}

/**
 * Epoch-shaped monotonic milliseconds. Rules receive this clock through their
 * server coordinator and tests replace it with a fake clock.
 */
export const systemAuthoritativeRuleClock: AuthoritativeRuleClock = {
  now(): number {
    const source = globalThis.performance
    if (!source || !Number.isFinite(source.timeOrigin)) {
      throw new Error('A monotonic Performance clock is required for authoritative timers')
    }
    const raw = source.timeOrigin + source.now()
    const sampled = Number.isFinite(raw) ? Math.floor(Math.max(0, raw)) : 0
    const previous = monotonicGlobal.__rvbLastAuthoritativeNow ?? sampled
    const next = Math.max(previous, sampled)
    monotonicGlobal.__rvbLastAuthoritativeNow = next
    return next
  },
}

export function getFullRoundNumber(turnNumber: number): number {
  const normalized = Number.isSafeInteger(turnNumber) ? Math.max(1, turnNumber) : 1
  return Math.floor((normalized - 1) / 2) + 1
}

export function getNormalTurnDurationMs(turnNumber: number): number {
  const fullRound = getFullRoundNumber(turnNumber)
  if (fullRound <= 2) return 45_000
  if (fullRound <= 4) return 60_000
  if (fullRound <= 6) return 75_000
  if (fullRound <= 8) return 90_000
  return 105_000
}

export function getCurrentInputOwnerPlayerId(state: BattleState): PlayerId {
  return state.pendingOptionSelection?.playerId
    ?? state.pendingTargetSelection?.ownerPlayerId
    ?? state.pendingTargetSelection?.playerId
    ?? (state.deployment?.mode === 'progressive-reserve-v1'
      && state.deployment.status === 'awaiting-reserve-deploy'
      ? state.deployment.activePlayerId
      : undefined)
    ?? state.turn.currentPlayerId
}
function getEffectiveTurn(state: BattleState): BattleState['turn'] {
  const suspendedTurn = state.pendingOptionSelection?.suspendedTurn
    ?? state.pendingTargetSelection?.suspendedTurn
  return suspendedTurn
    ? { ...state.turn, ...suspendedTurn } as BattleState['turn']
    : state.turn
}


export function createRunningTurnTimer(
  state: BattleState,
  now: number,
  noOpStreaks: Record<PlayerId, number> = state.turnTimer?.noOpStreaks ?? {},
): TurnTimerState {
  const hasPendingInput = !!state.pendingOptionSelection || !!state.pendingTargetSelection
  const hasProgressiveDeploymentInput = state.deployment?.mode === 'progressive-reserve-v1'
    && state.deployment.status === 'awaiting-reserve-deploy'
  if (state.turn.phase !== 'action' && !hasPendingInput && !hasProgressiveDeploymentInput) {
    throw new Error(
      'A turn timer may only start while the server is waiting in action phase or for pending input')
  }
  const effectiveTurn = getEffectiveTurn(state)
  const turnOwnerPlayerId = effectiveTurn.currentPlayerId
  const inputOwnerPlayerId = getCurrentInputOwnerPlayerId(state)
  const normalizedStreaks = normalizeNoOpStreaks(state, noOpStreaks)
  const inputWindow = createInputWindow(state, turnOwnerPlayerId, normalizedStreaks)
  const { durationMs, fast } = inputWindow
  const deadlineAt = now + durationMs
  const pendingResponse = createPendingResponseTimer(state, now)
  return {
    status: 'running',
    ownerPlayerId: turnOwnerPlayerId,
    turnOwnerPlayerId,
    inputOwnerPlayerId,
    turnNumber: effectiveTurn.turnNumber,
    fullRound: getFullRoundNumber(effectiveTurn.turnNumber),
    durationMs,
    remainingMs: durationMs,
    startedAt: now,
    deadlineAt,
    burnStartsAt: deadlineAt - TURN_BURN_WINDOW_MS,
    burnPhase: 'normal',
    fast,
    acceptedGameplayAction: false,
    inputWindows: {
      [turnOwnerPlayerId]: inputWindow,
    },
    ...(pendingResponse ? { pendingResponse } : {}),
    noOpStreaks: normalizedStreaks,
    lastResumedAt: now,
  }
}

export function projectTurnTimer(
  timer: TurnTimerState | undefined,
  now: number,
): TurnTimerProjection | undefined {
  if (!timer) return undefined
  const paused = !!timer.pendingResponse
  const remainingMs = timer.status === 'running' && !paused
    ? Math.max(0, timer.deadlineAt - now)
    : Math.max(0, timer.remainingMs)
  return {
    ownerPlayerId: timer.ownerPlayerId,
    turnOwnerPlayerId: timer.turnOwnerPlayerId,
    inputOwnerPlayerId: timer.inputOwnerPlayerId,
    turnNumber: timer.turnNumber,
    fullRound: timer.fullRound,
    durationMs: timer.durationMs,
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1_000),
    deadlineAt: timer.deadlineAt,
    burnStartsAt: timer.burnStartsAt,
    burning: !paused && (timer.burnPhase === 'burning' || remainingMs <= TURN_BURN_WINDOW_MS),
    fast: timer.fast,
    status: timer.status,
    paused,
  }
}

export function projectPendingTimer(
  timer: TurnTimerState | undefined,
  now: number,
): PendingTimerProjection | undefined {
  const pending = timer?.status === 'running' ? timer.pendingResponse : undefined
  if (!pending) return undefined
  const remainingMs = Math.max(0, pending.deadlineAt - now)
  return {
    ownerPlayerId: pending.ownerPlayerId,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
    durationMs: pending.durationMs,
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1_000),
    deadlineAt: pending.deadlineAt,
    status: pending.status,
  }
}

export function isAcceptedGameplayAction(action: BattleAction): boolean {
  switch (action.type) {
    case 'move':
    case 'useBasicSkill':
    case 'useChargeSkill':
    case 'endTurn':
    case 'playCard':
    case 'pendingOptionSelect':
    case 'pendingTargetSelect':
    case 'cancelPendingSelection':
    case 'deployReservePiece':
      return true
    default:
      return false
  }
}

export function isTurnTimerSystemAction(action: BattleAction): boolean {
  return action.type === 'turnTimerSync'
    || action.type === 'turnTimerBurn'
    || action.type === 'pendingTimeout'
    || action.type === 'turnTimeout'
}

export function syncTurnTimerAfterAcceptedAction(
  state: BattleState,
  input: {
    receivedAt: number
    resumedAt: number
    acceptedActionType?: BattleAction['type']
    actorPlayerId?: string
  },
): TurnTimerState | undefined {
  const previous = state.turnTimer
  const inputWindows = previous ? normalizeInputWindows(previous) : {}
  const currentRemainingMs = previous
    ? previous.pendingResponse
      ? previous.remainingMs
      : Math.min(
        previous.remainingMs,
        Math.max(0, previous.deadlineAt - input.receivedAt),
      )
    : 0
  const streaks = normalizeNoOpStreaks(state, previous?.noOpStreaks ?? {})
  const actorMatchesOwner = !!previous
    && !previous.pendingResponse
    && normalizePlayerId(input.actorPlayerId) === normalizePlayerId(previous.ownerPlayerId)
  const acceptedGameplayAction = !!input.acceptedActionType
    && actorMatchesOwner
    && isAcceptedGameplayAction({ type: input.acceptedActionType } as BattleAction)

  if (acceptedGameplayAction && previous) streaks[previous.ownerPlayerId] = 0
  if (previous) {
    const previousWindow = inputWindows[previous.ownerPlayerId] ?? inputWindowFromTimer(previous)
    inputWindows[previous.ownerPlayerId] = {
      ...previousWindow,
      remainingMs: currentRemainingMs,
      burnPhase: previous.burnPhase,
      acceptedGameplayAction:
        previousWindow.acceptedGameplayAction || previous.acceptedGameplayAction || acceptedGameplayAction,
    }
  }

  if (state.terminalResult) {
    if (!previous) return undefined
    return {
      ...previous,
      status: 'stopped',
      remainingMs: currentRemainingMs,
      acceptedGameplayAction: inputWindows[previous.ownerPlayerId]?.acceptedGameplayAction ?? false,
      inputWindows,
      noOpStreaks: streaks,
      lastPausedAt: input.receivedAt,
      lastResumedAt: input.resumedAt,
      ...(acceptedGameplayAction ? { lastAcceptedActionType: input.acceptedActionType } : {}),
    }
  }

  const nextInputOwnerPlayerId = getCurrentInputOwnerPlayerId(state)
  const effectiveTurn = getEffectiveTurn(state)
  const sameTurn = !!previous
    && previous.status === 'running'
    && previous.turnNumber === effectiveTurn.turnNumber
    && normalizePlayerId(previous.turnOwnerPlayerId) === normalizePlayerId(effectiveTurn.currentPlayerId)
  if (!sameTurn) {
    return createRunningTurnTimer(state, input.resumedAt, streaks)
  }

  const turnOwnerPlayerId = effectiveTurn.currentPlayerId
  const nextWindow = inputWindows[turnOwnerPlayerId]
    ?? createInputWindow(state, turnOwnerPlayerId, streaks)
  const remainingMs = normalizePlayerId(previous.turnOwnerPlayerId) === normalizePlayerId(turnOwnerPlayerId)
    ? currentRemainingMs
    : nextWindow.remainingMs
  inputWindows[turnOwnerPlayerId] = {
    ...nextWindow,
    remainingMs,
  }
  const nextPendingResponse = isOffTurnPending(state)
    ? samePendingResponse(previous.pendingResponse, state)
      ? previous.pendingResponse
      : createPendingResponseTimer(state, input.resumedAt)
    : undefined
  const deadlineAt = input.resumedAt + remainingMs
  return {
    ...previous,
    status: 'running',
    ownerPlayerId: turnOwnerPlayerId,
    turnOwnerPlayerId,
    inputOwnerPlayerId: nextInputOwnerPlayerId,
    durationMs: nextWindow.durationMs,
    remainingMs,
    startedAt: previous.startedAt,
    deadlineAt,
    burnStartsAt: deadlineAt - TURN_BURN_WINDOW_MS,
    burnPhase: nextWindow.burnPhase,
    fast: nextWindow.fast,
    acceptedGameplayAction: nextWindow.acceptedGameplayAction,
    inputWindows,
    ...(nextPendingResponse ? { pendingResponse: nextPendingResponse } : { pendingResponse: undefined }),
    noOpStreaks: streaks,
    lastPausedAt: input.receivedAt,
    lastResumedAt: input.resumedAt,
    ...(acceptedGameplayAction ? { lastAcceptedActionType: input.acceptedActionType } : {}),
  }
}

export function markTurnTimerBurning(state: BattleState, now: number): TurnTimerState {
  const timer = requireRunningTimer(state)
  if (timer.pendingResponse) throw new Error('Turn burn phase cannot advance while the turn clock is frozen')
  if (now < timer.burnStartsAt) throw new Error('Turn burn phase cannot start before its authoritative threshold')
  if (timer.burnPhase === 'burning') return timer
  const remainingMs = Math.max(0, timer.deadlineAt - now)
  const inputWindows = normalizeInputWindows(timer)
  inputWindows[timer.ownerPlayerId] = {
    ...inputWindowFromTimer(timer),
    remainingMs,
    burnPhase: 'burning',
  }
  return {
    ...timer,
    remainingMs,
    burnPhase: 'burning',
    inputWindows,
  }
}

export function recordTurnTimeout(state: BattleState, now: number): TurnTimerState {
  const timer = requireRunningTimer(state)
  if (timer.pendingResponse) throw new Error('Turn timeout cannot run while a pending response clock is active')
  if (now < timer.deadlineAt) throw new Error('Turn timeout cannot run before the authoritative deadline')
  const noAcceptedGameplayAction = !timer.acceptedGameplayAction
  const countsTowardNoOpStreak = noAcceptedGameplayAction
    && normalizePlayerId(timer.ownerPlayerId) === normalizePlayerId(timer.turnOwnerPlayerId)
  const streaks = normalizeNoOpStreaks(state, timer.noOpStreaks)
  const streak = noAcceptedGameplayAction
    ? (streaks[timer.ownerPlayerId] ?? 0) + (countsTowardNoOpStreak ? 1 : 0)
    : 0
  streaks[timer.ownerPlayerId] = streak
  const inputWindows = normalizeInputWindows(timer)
  inputWindows[timer.ownerPlayerId] = {
    ...inputWindowFromTimer(timer),
    remainingMs: 0,
  }
  return {
    ...timer,
    status: 'stopped',
    remainingMs: 0,
    inputWindows,
    noOpStreaks: streaks,
    lastTimeout: {
      playerId: timer.ownerPlayerId,
      turnNumber: timer.turnNumber,
      fullRound: timer.fullRound,
      at: now,
      noAcceptedGameplayAction,
      countsTowardNoOpStreak,
      streak,
      reason: noAcceptedGameplayAction ? 'no-action-timeout' : 'action-timeout',
    },
  }
}

function requireRunningTimer(state: BattleState): TurnTimerState {
  const timer = state.turnTimer
  if (!timer || timer.status !== 'running') throw new Error('No authoritative turn timer is running')
  const effectiveTurn = getEffectiveTurn(state)
  if (
    timer.turnNumber !== effectiveTurn.turnNumber
    || normalizePlayerId(timer.turnOwnerPlayerId) !== normalizePlayerId(effectiveTurn.currentPlayerId)
    || normalizePlayerId(timer.inputOwnerPlayerId) !== normalizePlayerId(getCurrentInputOwnerPlayerId(state))
  ) {
    throw new Error('Turn timer does not match the current authoritative input owner')
  }
  return timer
}

function isOffTurnPending(state: BattleState): boolean {
  const pending = state.pendingOptionSelection ?? state.pendingTargetSelection
  if (!pending) return false
  return normalizePlayerId(pendingOwnerPlayerId(pending)) !== normalizePlayerId(getEffectiveTurn(state).currentPlayerId)
}

function samePendingResponse(
  response: PendingResponseTimerState | undefined,
  state: BattleState,
): boolean {
  const pending = state.pendingOptionSelection ?? state.pendingTargetSelection
  return !!response
    && !!pending
    && response.selectionId === pending.selectionId
    && response.stateRevision === pending.stateRevision
    && normalizePlayerId(response.ownerPlayerId) === normalizePlayerId(pendingOwnerPlayerId(pending))
}

function createPendingResponseTimer(
  state: BattleState,
  now: number,
): PendingResponseTimerState | undefined {
  if (!isOffTurnPending(state)) return undefined
  const pending = state.pendingOptionSelection ?? state.pendingTargetSelection
  if (!pending || !pending.selectionId || !Number.isSafeInteger(pending.stateRevision)) {
    throw new Error('Off-turn pending response must be finalized before its timer starts')
  }
  return {
    status: 'running',
    ownerPlayerId: pendingOwnerPlayerId(pending),
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision!,
    durationMs: PENDING_RESPONSE_DURATION_MS,
    startedAt: now,
    deadlineAt: now + PENDING_RESPONSE_DURATION_MS,
    timeoutResolution: createPendingTimeoutResolution(state),
  }
}

function createPendingTimeoutResolution(state: BattleState): PendingTimeoutResolution {
  const option = state.pendingOptionSelection
  if (option) {
    if (option.canCancel !== false) return { kind: 'cancel' }
    const candidates = uniqueValues((option.options ?? []).map(candidateValue))
    const minimum = option.selectionMode === 'multi'
      ? Math.max(0, Number.isSafeInteger(option.minSelections) ? option.minSelections! : 1)
      : 1
    if (candidates.length < minimum) {
      throw new Error('Timed-out mandatory pending option has no legal deterministic default')
    }
    return {
      kind: 'option',
      selectedOption: option.selectionMode === 'multi' ? candidates.slice(0, minimum) : candidates[0],
    }
  }

  const target = state.pendingTargetSelection
  if (!target) throw new Error('Pending response timer requires an active pending session')
  if (target.canCancel !== false) return { kind: 'cancel' }
  const candidates = uniqueTargets(target.candidates ?? [])
  const selectionMode = target.selectionMode || ((target.maxSelections ?? target.max ?? 1) > 1 ? 'multi' : 'single')
  const minimum = selectionMode === 'multi'
    ? Math.max(1, target.minSelections ?? target.min ?? 1)
    : 1
  if (candidates.length < minimum) {
    throw new Error('Timed-out mandatory pending target has no legal deterministic default')
  }
  const selected = candidates.slice(0, minimum)
  const primary = selected[0]
  return {
    kind: 'target',
    ...(primary.type === 'piece'
      ? { targetPieceId: primary.pieceId }
      : { targetX: primary.x, targetY: primary.y }),
    ...(selected.length > 1
      ? {
          extraTargets: selected.slice(1).map(candidate => candidate.type === 'piece'
            ? { pieceId: candidate.pieceId }
            : { x: candidate.x, y: candidate.y }),
        }
      : {}),
  }
}

function candidateValue(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object') return candidate
  if ('value' in candidate) return (candidate as { value: unknown }).value
  if ('id' in candidate) return (candidate as { id: unknown }).id
  return candidate
}

function pendingOwnerPlayerId(
  pending: NonNullable<BattleState['pendingOptionSelection'] | BattleState['pendingTargetSelection']>,
): PlayerId {
  return 'ownerPlayerId' in pending && pending.ownerPlayerId
    ? pending.ownerPlayerId
    : pending.playerId
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = stableValue(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueTargets<T extends { type: 'piece'; pieceId: string } | { type: 'cell'; x: number; y: number }>(
  targets: T[],
): T[] {
  const seen = new Set<string>()
  return targets.filter(target => {
    const key = target.type === 'piece' ? `piece:${target.pieceId}` : `cell:${target.x}:${target.y}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stableValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => (
    `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`
  )).join(',')}}`
}

function createInputWindow(
  state: BattleState,
  ownerPlayerId: PlayerId,
  streaks: Record<PlayerId, number>,
): TurnTimerInputWindowState {
  const effectiveTurn = getEffectiveTurn(state)
  const isTurnOwner = normalizePlayerId(ownerPlayerId) === normalizePlayerId(effectiveTurn.currentPlayerId)
  const fast = isTurnOwner && (streaks[ownerPlayerId] ?? 0) > 0
  const durationMs = fast ? TURN_FAST_DURATION_MS : getNormalTurnDurationMs(effectiveTurn.turnNumber)
  return {
    durationMs,
    remainingMs: durationMs,
    burnPhase: 'normal',
    fast,
    acceptedGameplayAction: false,
  }
}

function inputWindowFromTimer(timer: TurnTimerState): TurnTimerInputWindowState {
  return {
    durationMs: timer.durationMs,
    remainingMs: timer.remainingMs,
    burnPhase: timer.burnPhase,
    fast: timer.fast,
    acceptedGameplayAction: timer.acceptedGameplayAction,
  }
}

function normalizeInputWindows(timer: TurnTimerState): Record<PlayerId, TurnTimerInputWindowState> {
  const windows = Object.fromEntries(
    Object.entries(timer.inputWindows ?? {}).map(([playerId, window]) => [playerId, { ...window }]),
  )
  windows[timer.ownerPlayerId] = {
    ...(windows[timer.ownerPlayerId] ?? inputWindowFromTimer(timer)),
    ...inputWindowFromTimer(timer),
  }
  return windows
}

function normalizeNoOpStreaks(
  state: BattleState,
  streaks: Record<PlayerId, number>,
): Record<PlayerId, number> {
  return Object.fromEntries(state.players.map(player => [
    player.playerId,
    Math.max(0, Number.isSafeInteger(streaks[player.playerId]) ? streaks[player.playerId] : 0),
  ]))
}

function normalizePlayerId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}
