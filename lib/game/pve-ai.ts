import { planBotActions, type BotActionPlan } from './ai'
import { planZeroStageAction } from './ai-zero-stage-agent'
import { getCurrentInputOwnerPlayerId } from './turn-timer'
import type { BattleState } from './turn'

export type PveDifficulty = 'easy' | 'normal'

export class PveDifficultyError extends Error {
  readonly code = 'PVE_DIFFICULTY_INVALID'
  constructor() {
    super('PVE_DIFFICULTY_INVALID: difficulty must be easy or normal')
  }
}

/** Only server-owned profiles may be selected; missing legacy metadata is easy. */
export function getPveAiProfile(value: unknown = 'easy') {
  if (value === 'easy') return { difficulty: value, agentId: 'simple-v1', name: '简单 · sample-v1' } as const
  if (value === 'normal') return { difficulty: value, agentId: 'rvb-ai-zimse-v1', name: '普通 · zimse-v1' } as const
  throw new PveDifficultyError()
}

export function pveBotTurnKey(state: BattleState, rootSeed: number): string {
  return `${rootSeed}:${state.turn.turnNumber}:${state.turn.currentPlayerId.trim().toLowerCase()}`
}

export function planPveBotAction(
  state: BattleState,
  playerId: string,
  rootSeed: number,
  difficulty: PveDifficulty,
  actionsTakenThisTurn: number,
): BotActionPlan | undefined {
  if (difficulty === 'easy') return planBotActions(state, playerId)
  if (state.terminalResult || getCurrentInputOwnerPlayerId(state).trim().toLowerCase() !== playerId.trim().toLowerCase()) return undefined
  const decision = planZeroStageAction(state, playerId, rootSeed, { actionsTakenThisTurn })
  if (!decision.nextAction) return undefined
  return {
    kind: state.turn.phase === 'action' && !state.pendingOptionSelection && !state.pendingTargetSelection
      && state.deployment?.status !== 'awaiting-reserve-deploy' ? 'action' : 'structural',
    actions: [decision.nextAction.action],
  }
}
