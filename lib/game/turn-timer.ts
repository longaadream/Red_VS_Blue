import type { BattleAction, BattleState, PlayerId } from './turn'

export const TURN_BURN_WINDOW_MS = 15_000
export const TURN_FAST_DURATION_MS = 20_000
export const TURN_TIMEOUT_FORFEIT_STREAK = 3

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
  /** Per-input-owner budgets retained while a pending response temporarily transfers control. */
  inputWindows: Record<PlayerId, TurnTimerInputWindowState>
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
    ?? state.pendingTargetSelection?.playerId
    ?? state.turn.currentPlayerId
}

export function createRunningTurnTimer(
  state: BattleState,
  now: number,
  noOpStreaks: Record<PlayerId, number> = state.turnTimer?.noOpStreaks ?? {},
): TurnTimerState {
  if (state.turn.phase !== 'action') {
    throw new Error('A turn timer may only start while the server is waiting in action phase')
  }
  const turnOwnerPlayerId = state.turn.currentPlayerId
  const ownerPlayerId = getCurrentInputOwnerPlayerId(state)
  const normalizedStreaks = normalizeNoOpStreaks(state, noOpStreaks)
  const inputWindow = createInputWindow(state, ownerPlayerId, normalizedStreaks)
  const { durationMs, fast } = inputWindow
  const deadlineAt = now + durationMs
  return {
    status: 'running',
    ownerPlayerId,
    turnOwnerPlayerId,
    inputOwnerPlayerId: ownerPlayerId,
    turnNumber: state.turn.turnNumber,
    fullRound: getFullRoundNumber(state.turn.turnNumber),
    durationMs,
    remainingMs: durationMs,
    startedAt: now,
    deadlineAt,
    burnStartsAt: deadlineAt - TURN_BURN_WINDOW_MS,
    burnPhase: 'normal',
    fast,
    acceptedGameplayAction: false,
    inputWindows: {
      [ownerPlayerId]: inputWindow,
    },
    noOpStreaks: normalizedStreaks,
    lastResumedAt: now,
  }
}

export function projectTurnTimer(
  timer: TurnTimerState | undefined,
  now: number,
): TurnTimerProjection | undefined {
  if (!timer) return undefined
  const remainingMs = timer.status === 'running'
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
    burning: timer.burnPhase === 'burning' || remainingMs <= TURN_BURN_WINDOW_MS,
    fast: timer.fast,
    status: timer.status,
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
      return true
    default:
      return false
  }
}

export function isTurnTimerSystemAction(action: BattleAction): boolean {
  return action.type === 'turnTimerSync'
    || action.type === 'turnTimerBurn'
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
    ? Math.min(
        previous.remainingMs,
        Math.max(0, previous.deadlineAt - input.receivedAt),
      )
    : 0
  const streaks = normalizeNoOpStreaks(state, previous?.noOpStreaks ?? {})
  const actorMatchesOwner = !!previous
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
  const sameTurn = !!previous
    && previous.status === 'running'
    && previous.turnNumber === state.turn.turnNumber
    && normalizePlayerId(previous.turnOwnerPlayerId) === normalizePlayerId(state.turn.currentPlayerId)
  if (!sameTurn) {
    return createRunningTurnTimer(state, input.resumedAt, streaks)
  }

  const sameInputOwner = normalizePlayerId(previous.ownerPlayerId) === normalizePlayerId(nextInputOwnerPlayerId)
  const nextWindow = inputWindows[nextInputOwnerPlayerId]
    ?? createInputWindow(state, nextInputOwnerPlayerId, streaks)
  const remainingMs = sameInputOwner ? currentRemainingMs : nextWindow.remainingMs
  inputWindows[nextInputOwnerPlayerId] = {
    ...nextWindow,
    remainingMs,
  }
  const deadlineAt = input.resumedAt + remainingMs
  return {
    ...previous,
    status: 'running',
    ownerPlayerId: nextInputOwnerPlayerId,
    inputOwnerPlayerId: nextInputOwnerPlayerId,
    durationMs: nextWindow.durationMs,
    remainingMs,
    startedAt: sameInputOwner ? previous.startedAt : input.resumedAt,
    deadlineAt,
    burnStartsAt: deadlineAt - TURN_BURN_WINDOW_MS,
    burnPhase: nextWindow.burnPhase,
    fast: nextWindow.fast,
    acceptedGameplayAction: nextWindow.acceptedGameplayAction,
    inputWindows,
    noOpStreaks: streaks,
    lastPausedAt: input.receivedAt,
    lastResumedAt: input.resumedAt,
    ...(acceptedGameplayAction ? { lastAcceptedActionType: input.acceptedActionType } : {}),
  }
}

export function markTurnTimerBurning(state: BattleState, now: number): TurnTimerState {
  const timer = requireRunningTimer(state)
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
  if (
    timer.turnNumber !== state.turn.turnNumber
    || normalizePlayerId(timer.turnOwnerPlayerId) !== normalizePlayerId(state.turn.currentPlayerId)
    || normalizePlayerId(timer.ownerPlayerId) !== normalizePlayerId(getCurrentInputOwnerPlayerId(state))
  ) {
    throw new Error('Turn timer does not match the current authoritative input owner')
  }
  return timer
}

function createInputWindow(
  state: BattleState,
  ownerPlayerId: PlayerId,
  streaks: Record<PlayerId, number>,
): TurnTimerInputWindowState {
  const isTurnOwner = normalizePlayerId(ownerPlayerId) === normalizePlayerId(state.turn.currentPlayerId)
  const fast = isTurnOwner && (streaks[ownerPlayerId] ?? 0) > 0
  const durationMs = fast ? TURN_FAST_DURATION_MS : getNormalTurnDurationMs(state.turn.turnNumber)
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
