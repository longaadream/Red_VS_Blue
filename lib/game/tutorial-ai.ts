import {
  planShortSearchAction,
  type ShortSearchConfig,
  type ShortSearchContinuation,
  type ShortSearchDecision,
} from './ai-short-search'
import { practiceEnvironment } from '../practice/environment'
import { evaluateZeroStageState } from '../practice/evaluator'
import type { BattleState } from './turn'

/**
 * Tutorial search may run in a dedicated worker, but it keeps a small measured
 * wall-clock budget for responsive turn handoff. Node limits remain the
 * authority for deterministic search; the clocks are soft cutoffs, not hard
 * deadlines, and the decision records an overrun when one occurs.
 */
export const TUTORIAL_AI_DEFAULTS: Readonly<ShortSearchConfig> = Object.freeze({
  depth: 3,
  beamWidth: 6,
  rootCandidates: 24,
  childCandidates: 10,
  nodesPerDecision: 128,
  deploymentNodesPerDecision: 384,
  nodesPerTurn: 896,
  maxActionsPerTurn: 24,
  turnTimeMs: 2500,
  decisionTimeMs: 250,
  deploymentTimeMs: 500,
  minimumRootCoverage: 12,
})

export interface TutorialAiOptions {
  continuation?: ShortSearchContinuation
  actionsTakenThisTurn?: number
  now?: () => number
  config?: Partial<ShortSearchConfig>
}

/**
 * Plans one bounded tutorial action from the public practice AI view.
 * The caller owns authority submission and must pass the returned action back
 * through the current battle state before asking for the next action.
 */
export function planTutorialAiAction(
  state: BattleState,
  playerId: string,
  rootSeed: number,
  options: TutorialAiOptions = {},
): ShortSearchDecision {
  return planShortSearchAction(state, playerId, rootSeed, {
    environment: practiceEnvironment,
    evaluate: observation => evaluateZeroStageState(observation).total,
    continuation: options.continuation,
    actionsTakenThisTurn: options.actionsTakenThisTurn,
    now: options.now,
    config: { ...TUTORIAL_AI_DEFAULTS, ...options.config },
  })
}
