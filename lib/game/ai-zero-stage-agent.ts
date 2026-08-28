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
const samePlayer = (left: unknown, right: unknown) => (
  String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
)
const MANDATORY_KINDS = new Set<CandidateAction['kind']>([
  'pending-option',
  'pending-target',
  'cancel-selection',
  'deployment-lock',
  'phase-advance',
])
const AGGRESSIVE_KIND_PRIORITY: Readonly<Record<CandidateAction['kind'], number>> = Object.freeze({
  'charge-skill': 4,
  'basic-skill': 4,
  card: 3,
  move: 2,
  'deployment-choice': 1,
  'deployment-lock': 0,
  'phase-advance': 0,
  'pending-option': 0,
  'pending-target': 0,
  'cancel-selection': 0,
  'end-turn': 0,
})

function enemyTargetPriority(state: BattleState, playerId: string, candidate: CandidateAction) {
  const action = candidate.action
  const targetPieceId = 'targetPieceId' in action && typeof action.targetPieceId === 'string'
    ? action.targetPieceId
    : undefined
  const target = targetPieceId
    ? state.pieces.find(piece => piece.instanceId === targetPieceId)
    : undefined
  if (target && target.currentHp > 0 && !samePlayer(target.ownerPlayerId, playerId)) return 2
  const targetX = 'targetX' in action && typeof action.targetX === 'number' ? action.targetX : undefined
  const targetY = 'targetY' in action && typeof action.targetY === 'number' ? action.targetY : undefined
  if (targetX === undefined || targetY === undefined) return 0
  return state.pieces.some(piece => (
    piece.currentHp > 0
    && !samePlayer(piece.ownerPlayerId, playerId)
    && piece.x === targetX
    && piece.y === targetY
  )) ? 1 : 0
}

const gridDistance = (left: { x: number; y: number }, right: { x: number; y: number }) => (
  Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
)

function offensiveMoveProgress(state: BattleState, playerId: string, candidate: CandidateAction) {
  const action = candidate.action
  if (action.type !== 'move') return { pursuit: 0, center: 0 }
  const mover = state.pieces.find(piece => (
    piece.instanceId === action.pieceId
    && piece.currentHp > 0
    && piece.x != null
    && piece.y != null
  ))
  if (!mover) return { pursuit: 0, center: 0 }
  const hostile = state.pieces.filter(piece => (
    piece.currentHp > 0
    && !samePlayer(piece.ownerPlayerId, playerId)
    && piece.x != null
    && piece.y != null
  ))
  const hostileObjectives = hostile.filter(piece => piece.isCore)
  const targets = hostileObjectives.length > 0 ? hostileObjectives : hostile
  if (targets.length === 0) return { pursuit: 0, center: 0 }

  const start = { x: mover.x!, y: mover.y! }
  const destination = { x: action.toX, y: action.toY }
  const nearest = (point: { x: number; y: number }) => Math.min(
    ...targets.map(target => gridDistance(point, { x: target.x!, y: target.y! })),
  )
  const pursuit = Math.max(0, nearest(start) - nearest(destination))
  if (pursuit === 0) return { pursuit, center: 0 }
  const mapCenter = { x: (state.map.width - 1) / 2, y: (state.map.height - 1) / 2 }
  const center = Math.max(0, gridDistance(start, mapCenter) - gridDistance(destination, mapCenter))
  return { pursuit, center }
}

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
 * Scores every admitted formal action after exactly one isolated transition and
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
  const admissionRanked = ranked.map((item, semanticRank) => {
    const cost = getAIActionResourceCost(state, playerId, item.candidate)
    const moveProgress = offensiveMoveProgress(state, playerId, item.candidate)
    return {
      item,
      semanticRank,
      costTotal: cost.actionPoints + cost.chargePoints,
      enemyTarget: enemyTargetPriority(state, playerId, item.candidate),
      pursuitProgress: moveProgress.pursuit,
      centerProgress: moveProgress.center,
      aggressiveKind: AGGRESSIVE_KIND_PRIORITY[item.candidate.kind],
    }
  }).sort((left, right) => (
    right.enemyTarget - left.enemyTarget
    || right.pursuitProgress - left.pursuitProgress
    || right.centerProgress - left.centerProgress
    || right.costTotal - left.costTotal
    || right.aggressiveKind - left.aggressiveKind
    || left.semanticRank - right.semanticRank
  )).map(entry => entry.item)
  const required = ranked.filter(item => MANDATORY_KINDS.has(item.candidate.kind))
  const endTurn = ranked.find(item => item.candidate.kind === 'end-turn')
  const admitted = new Set<string>()
  const forceEndTurn = endTurn !== undefined
    && (options.actionsTakenThisTurn ?? 0) >= config.maxActionsPerTurn - 1
  if (forceEndTurn) {
    admitted.add(endTurn.candidate.id)
  } else {
    for (const item of required.slice(0, config.nodeBudget)) admitted.add(item.candidate.id)
    if (endTurn && admitted.size < config.nodeBudget) admitted.add(endTurn.candidate.id)
    for (const item of admissionRanked) {
      if (admitted.size >= config.nodeBudget) break
      admitted.add(item.candidate.id)
    }
  }
  let nodesVisited = 0
  const budgetExhausted = admitted.size < ranked.length

  for (const described of ranked) {
    const { candidate } = described
    const actionCost = getAIActionResourceCost(state, playerId, candidate)
    const trace: ZeroStageCandidateTrace = {
      candidateId: candidate.id,
      action: candidate.action,
      actionCost,
      compatibility: described.features.compatibility,
    }
    if (!admitted.has(candidate.id)) {
      trace.pruned = forceEndTurn ? 'turn-action-budget' : 'candidate-budget'
      traces.push(trace)
      continue
    }

    nodesVisited += 1
    const transition = environment.simulate(state, candidate, { rootSeed })
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
