import type { BattleAction, BattleState } from './turn'
import { TURN_TIMEOUT_FORFEIT_STREAK } from './turn-timer'

export const BATTLE_ROUND_LIMIT = 40

export type TerminalReason =
  | 'core-eliminated'
  | 'mutual-core-elimination'
  | 'round-limit'
  | 'surrender'
  | 'timeout-surrender'

export interface TerminalSettlementPosition {
  actionIndex: number
  actionType: BattleAction['type']
  actorPlayerId: string | null
  turnNumber: number
  phase: BattleState['turn']['phase']
  completedRound: number
}

export interface TerminalResult {
  status: 'finished'
  winnerPlayerId: string | null
  loserPlayerId: string | null
  reason: TerminalReason
  settledAt: TerminalSettlementPosition
}

export interface FinalizeBattleTerminalOptions {
  actionIndex?: number
}

const normalizePlayerId = (playerId: unknown) =>
  typeof playerId === 'string' ? playerId.trim().toLowerCase() : ''

function completedRounds(state: BattleState): number {
  const turnNumber = Number.isSafeInteger(state.turn?.turnNumber)
    ? Math.max(1, state.turn.turnNumber)
    : 1
  return state.turn?.phase === 'end'
    ? Math.floor(turnNumber / 2)
    : Math.floor((turnNumber - 1) / 2)
}

function settlementPosition(
  state: BattleState,
  action: BattleAction,
  options: FinalizeBattleTerminalOptions,
): TerminalSettlementPosition {
  const playerId = (action as { playerId?: unknown }).playerId
  const trace = state.extensions?.debugBattle?.actionLog
  return {
    actionIndex: options.actionIndex ?? (Array.isArray(trace) ? trace.length : 0),
    actionType: action.type,
    actorPlayerId: typeof playerId === 'string' && playerId.trim() ? playerId.trim() : null,
    turnNumber: state.turn.turnNumber,
    phase: state.turn.phase,
    completedRound: completedRounds(state),
  }
}

function surrenderResult(
  state: BattleState,
  action: Extract<BattleAction, { type: 'surrender' }>,
  settledAt: TerminalSettlementPosition,
): TerminalResult | null {
  const loser = state.players.find(player =>
    normalizePlayerId(player.playerId) === normalizePlayerId(action.playerId))
  const winner = state.players.find(player =>
    normalizePlayerId(player.playerId) !== normalizePlayerId(action.playerId))
  if (!loser || !winner) return null
  return {
    status: 'finished',
    winnerPlayerId: winner.playerId,
    loserPlayerId: loser.playerId,
    reason: action.reason === 'timeout' ? 'timeout-surrender' : 'surrender',
    settledAt,
  }
}

function coreEliminationResult(
  state: BattleState,
  settledAt: TerminalSettlementPosition,
): TerminalResult | null {
  if (state.players.length !== 2) return null

  const removedPieces = Array.isArray(state.extensions?.removedPieces)
    ? state.extensions.removedPieces
    : []
  const coreOwners = new Set(
    [...state.pieces, ...state.graveyard, ...removedPieces]
      .filter(piece => piece.isCore === true)
      .map(piece => normalizePlayerId(piece.ownerPlayerId)),
  )
  const players = state.players.map(player => ({
    playerId: player.playerId,
    normalizedId: normalizePlayerId(player.playerId),
  }))
  if (!players.every(player => coreOwners.has(player.normalizedId))) return null

  const livingCoreOwners = new Set(
    state.pieces
      .filter(piece => piece.isCore === true && piece.currentHp > 0)
      .map(piece => normalizePlayerId(piece.ownerPlayerId)),
  )
  const defeated = players.filter(player => !livingCoreOwners.has(player.normalizedId))
  if (defeated.length === 0) return null
  if (defeated.length === 2) {
    return {
      status: 'finished',
      winnerPlayerId: null,
      loserPlayerId: null,
      reason: 'mutual-core-elimination',
      settledAt,
    }
  }

  const loser = defeated[0]
  const winner = players.find(player => player.normalizedId !== loser.normalizedId)
  if (!winner) return null
  return {
    status: 'finished',
    winnerPlayerId: winner.playerId,
    loserPlayerId: loser.playerId,
    reason: 'core-eliminated',
    settledAt,
  }
}

function roundLimitResult(
  state: BattleState,
  settledAt: TerminalSettlementPosition,
): TerminalResult | null {
  if (state.turn.phase !== 'end' || settledAt.completedRound < BATTLE_ROUND_LIMIT) return null
  return {
    status: 'finished',
    winnerPlayerId: null,
    loserPlayerId: null,
    reason: 'round-limit',
    settledAt,
  }
}

function resultMessage(reason: TerminalReason): string {
  switch (reason) {
    case 'core-eliminated': return 'Battle finished: all opposing core pieces were eliminated'
    case 'mutual-core-elimination': return 'Battle finished in a draw: both core rosters were eliminated'
    case 'round-limit': return 'Battle finished in a draw after 40 complete rounds'
    case 'timeout-surrender': return 'Battle finished by timeout surrender'
    case 'surrender': return 'Battle finished by surrender'
  }
}

export function finalizeBattleTerminal(
  state: BattleState,
  action: BattleAction,
  options: FinalizeBattleTerminalOptions = {},
): TerminalResult | null {
  if (state.terminalResult) return state.terminalResult

  const settledAt = settlementPosition(state, action, options)
  const timeoutForfeit = action.type === 'turnTimeout'
    && !!state.turnTimer?.lastTimeout?.countsTowardNoOpStreak
    && state.turnTimer.lastTimeout.streak >= TURN_TIMEOUT_FORFEIT_STREAK
      ? surrenderResult(state, {
          type: 'surrender',
          playerId: state.turnTimer.lastTimeout.playerId,
          reason: 'timeout',
        }, settledAt)
      : null
  const result = action.type === 'surrender'
    ? surrenderResult(state, action, settledAt)
    : timeoutForfeit ?? (state.pendingOptionSelection || state.pendingTargetSelection
      ? null
      : coreEliminationResult(state, settledAt) ?? roundLimitResult(state, settledAt))
  if (!result) return null

  state.terminalResult = result
  state.pendingOptionSelection = undefined
  state.pendingTargetSelection = undefined
  if (state.turnTimer) {
    state.turnTimer.status = 'stopped'
    state.turnTimer.remainingMs = 0
    state.turnTimer.deadlineAt = state.turnTimer.lastTimeout?.at ?? state.turnTimer.deadlineAt
  }
  if (!state.actions) state.actions = []
  state.actions.push({
    type: 'terminalResult',
    playerId: result.winnerPlayerId ?? result.loserPlayerId ?? 'system',
    turn: state.turn.turnNumber,
    payload: {
      message: resultMessage(result.reason),
      terminalResult: result,
    },
  })
  return result
}
