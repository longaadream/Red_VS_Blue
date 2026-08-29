import { aiEnvironmentV1, getAIActionResourceCost } from './ai-environment'
import {
  chooseAiTurnGoal,
  compareAiCandidateDescriptions,
  describeAiCandidate,
} from './ai-evaluator'
import { resolveZeroStageConfig } from './ai-profiles'
import { hashStable, stableJson } from './battle-trace'
import { evaluateZeroStageState } from './ai-zero-stage-evaluator'
import type {
  AIEnvironment,
  CandidateAction,
  ZeroStageCandidateTrace,
  ZeroStageConfig,
  ZeroStageDecision,
  ZeroStageSelectionReason,
  ZeroStageStaticEvaluation,
} from './ai-types'
import type { BattleState } from './turn'

type ZeroStageConfigOverrides = Partial<Omit<ZeroStageConfig, 'version' | 'weights' | 'terminal'>> & {
  weights?: Partial<ZeroStageConfig['weights']>
  terminal?: Partial<ZeroStageConfig['terminal']>
}

export interface ZeroStageAgentOptions {
  config?: ZeroStageConfigOverrides
  environment?: AIEnvironment
  actionsTakenThisTurn?: number
}

type ScoredCandidate = {
  candidate: CandidateAction
  evaluation: ZeroStageStaticEvaluation
  costTotal: number
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const terminalRank = (evaluation: ZeroStageStaticEvaluation) => {
  if (evaluation.terminalOutcome === 'win') return 3
  if (evaluation.terminalOutcome === undefined) return 2
  if (evaluation.terminalOutcome === 'draw') return 1
  return 0
}

function compareScored(left: ScoredCandidate, right: ScoredCandidate) {
  return terminalRank(right.evaluation) - terminalRank(left.evaluation)
    || right.evaluation.total - left.evaluation.total
    || right.costTotal - left.costTotal
    || Number(right.candidate.kind === 'end-turn') - Number(left.candidate.kind === 'end-turn')
    || compareText(stableJson(left.candidate.action), stableJson(right.candidate.action))
    || compareText(left.candidate.id, right.candidate.id)
}

function selectionReason(selected: ScoredCandidate, runnerUp?: ScoredCandidate): ZeroStageSelectionReason {
  if (!runnerUp) return 'only-scored-candidate'
  if (terminalRank(selected.evaluation) !== terminalRank(runnerUp.evaluation)) return 'terminal-outcome'
  if (selected.evaluation.total !== runnerUp.evaluation.total) return 'static-value'
  if (selected.costTotal !== runnerUp.costTotal) return 'resource-cost'
  if (selected.candidate.kind !== runnerUp.candidate.kind
    && (selected.candidate.kind === 'end-turn' || runnerUp.candidate.kind === 'end-turn')) return 'end-turn'
  if (stableJson(selected.candidate.action) !== stableJson(runnerUp.candidate.action)) return 'stable-action'
  return 'candidate-id'
}

function emptyDecision(
  state: BattleState,
  playerId: string,
  environment: AIEnvironment,
  config: ZeroStageConfig,
  stopReason: ZeroStageDecision['stopReason'],
): ZeroStageDecision {
  return {
    configVersion: config.version,
    playerId,
    stateValue: evaluateZeroStageState(environment.observe(state, playerId), config).total,
    nextAction: undefined,
    nodesVisited: 0,
    candidatesConsidered: 0,
    budgetExhausted: false,
    stopReason,
    trace: [],
  }
}

/**
 * Scores every strict legal formal action after exactly one isolated transition and
 * returns only the best current action. Callers replan after authority accepts it.
 */
export function planZeroStageAction(
  state: BattleState,
  playerId: string,
  rootSeed: number,
  options: ZeroStageAgentOptions = {},
): ZeroStageDecision {
  const environment = options.environment ?? aiEnvironmentV1
  const config = resolveZeroStageConfig(options.config)
  if (environment.isTerminal(state)) return emptyDecision(state, playerId, environment, config, 'terminal')
  const legal = environment.listLegalActions(state, playerId)
  if (legal.length === 0) return emptyDecision(state, playerId, environment, config, 'no-legal-actions')

  const stateValue = evaluateZeroStageState(environment.observe(state, playerId), config).total
  const traces: ZeroStageCandidateTrace[] = []
  const scored: ScoredCandidate[] = []
  const goal = chooseAiTurnGoal(state, playerId)
  const ranked = legal.map(candidate => ({
    candidate,
    ...describeAiCandidate(state, playerId, goal, candidate),
  })).sort(compareAiCandidateDescriptions)
  const endTurn = ranked.find(item => item.candidate.kind === 'end-turn')
  const forceEndTurn = endTurn !== undefined
    && (options.actionsTakenThisTurn ?? 0) >= config.maxActionsPerTurn - 1
  let nodesVisited = 0
  const budgetExhausted = forceEndTurn && ranked.length > 1

  for (const described of ranked) {
    const { candidate } = described
    const actionCost = getAIActionResourceCost(state, playerId, candidate)
    const trace: ZeroStageCandidateTrace = {
      candidateId: candidate.id,
      action: candidate.action,
      actionCost,
      compatibility: described.features.compatibility,
    }
    if (forceEndTurn && candidate.id !== endTurn.candidate.id) {
      trace.pruned = 'turn-action-budget'
      traces.push(trace)
      continue
    }

    nodesVisited += 1
    const transition = environment.simulate(state, candidate, {
      rootSeed,
      simulationMode: 'evaluation',
    })
    if (!transition.accepted) {
      trace.rejected = transition.error.code
      traces.push(trace)
      continue
    }
    if (transition.trace.blocked === true) {
      trace.blocked = true
      traces.push(trace)
      continue
    }
    const evaluation = evaluateZeroStageState(environment.observe(transition.state, playerId), config)
    trace.staticValue = evaluation.total
    trace.evaluation = evaluation
    traces.push(trace)
    scored.push({
      candidate,
      evaluation,
      costTotal: actionCost.actionPoints + actionCost.chargePoints,
    })
  }

  scored.sort(compareScored)
  const selected = scored[0]
  const selectedBy = selected ? selectionReason(selected, scored[1]) : undefined
  return {
    configVersion: config.version,
    playerId,
    stateValue,
    nextAction: selected?.candidate,
    nodesVisited,
    candidatesConsidered: ranked.length,
    budgetExhausted,
    stopReason: selected ? 'selected' : budgetExhausted ? 'budget-exhausted' : 'no-legal-actions',
    selectionReason: selectedBy,
    trace: traces,
  }
}

export function zeroStageDecisionTraceHash(decision: ZeroStageDecision): string {
  return hashStable({
    configVersion: decision.configVersion,
    playerId: decision.playerId,
    stateValue: decision.stateValue,
    nextAction: decision.nextAction?.action,
    nodesVisited: decision.nodesVisited,
    candidatesConsidered: decision.candidatesConsidered,
    budgetExhausted: decision.budgetExhausted,
    stopReason: decision.stopReason,
    selectionReason: decision.selectionReason,
    trace: decision.trace,
  })
}
