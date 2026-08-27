import { aiEnvironmentV1 } from './ai-environment'
import { hashStable, stableJson } from './battle-trace'
import {
  chooseAiTurnGoal,
  compareAiCandidateDescriptions,
  describeAiCandidate,
  evaluateAiTransition,
} from './ai-evaluator'
import { resolveAiPlannerConfig } from './ai-profiles'
import type {
  AIEnvironment,
  AiCompatibility,
  AiPlannerContinuation,
  AiPlannerConfig,
  AiPlannerScore,
  AiPlannerStopReason,
  AiPlannerTraceEntry,
  AiTurnGoal,
  AiTurnPlan,
  CandidateAction,
} from './ai-types'
import type { BattleState } from './turn'

type Node = {
  state: BattleState
  stateKey: string
  actions: CandidateAction[]
  score: number
}

type PlannerOptions = {
  config?: Partial<Omit<AiPlannerConfig, 'version' | 'weights'>> & { weights?: Record<string, number> }
  previousGoal?: AiTurnGoal
  continuation?: AiPlannerContinuation
  environment?: AIEnvironment
}

type RankedCandidate = ReturnType<typeof describeAiCandidate> & {
  candidate: CandidateAction
  candidateRank: number
}

const STRUCTURAL_KINDS = new Set<CandidateAction['kind']>([
  'pending-option',
  'pending-target',
  'cancel-selection',
  'deployment-choice',
  'deployment-lock',
  'phase-advance',
])

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const actionSequenceKey = (actions: CandidateAction[]) => stableJson(actions.map(action => action.action))
const zeroScore = (): AiPlannerScore => ({ total: 0, components: {} })

function compareNodes(left: Node, right: Node) {
  return right.score - left.score
    || left.actions.length - right.actions.length
    || compareText(actionSequenceKey(left.actions), actionSequenceKey(right.actions))
}

function betterNode(candidate: Node, current: Node | undefined) {
  return !current || compareNodes(candidate, current) < 0
}

function emptyPlan(
  config: AiPlannerConfig,
  goal: AiTurnGoal,
  goalChanged: boolean,
  stopReason: AiPlannerStopReason,
  continuation: AiPlannerContinuation,
): AiTurnPlan {
  return {
    configVersion: config.version,
    goal,
    goalChanged,
    continuation,
    actions: [],
    nextAction: undefined,
    nodesVisited: 0,
    candidatesConsidered: 0,
    stateDuplicates: 0,
    stopReason,
    trace: [],
  }
}

function traceEntry(
  ranked: RankedCandidate,
  depth: number,
  score: AiPlannerScore,
  extra: Partial<Pick<AiPlannerTraceEntry, 'pruned' | 'pruneDetail' | 'rejected'>> = {},
): AiPlannerTraceEntry {
  return {
    candidateId: ranked.candidate.id,
    action: ranked.candidate.action,
    score,
    depth,
    candidateRank: ranked.candidateRank,
    compatibility: ranked.features.compatibility,
    contentId: ranked.features.contentId,
    ...extra,
  }
}

function rankedCandidates(
  state: BattleState,
  playerId: string,
  goal: AiTurnGoal,
  candidates: CandidateAction[],
): RankedCandidate[] {
  const described = candidates.map(candidate => ({
    candidate,
    ...describeAiCandidate(state, playerId, goal, candidate),
    candidateRank: 0,
  }))
  described.sort(compareAiCandidateDescriptions)
  return described.map((item, candidateRank) => ({ ...item, candidateRank }))
}

function compatibilityPrune(compatibility: AiCompatibility): string | undefined {
  if (compatibility === 'unsupported') return 'unsupported'
  if (compatibility === 'metadata-required') return 'metadata-required'
  return undefined
}

/**
 * Generic, isolated beam planner. It never submits actions. Search sequences are
 * diagnostic only; authoritative callers must submit nextAction and replan.
 */
export function planAiTurn(
  state: BattleState,
  playerId: string,
  rootSeed: number,
  options: PlannerOptions = {},
): AiTurnPlan {
  const environment = options.environment || aiEnvironmentV1
  const config = resolveAiPlannerConfig(options.config)
  const goal = chooseAiTurnGoal(state, playerId, options.previousGoal)
  const goalChanged = !options.previousGoal
    || options.previousGoal.kind !== goal.kind
    || options.previousGoal.targetId !== goal.targetId
  const initialKey = environment.stateKey(state, { kind: 'full' })
  const incoming = options.continuation
  const continuesSameTurn = incoming?.version === 1
    && incoming.playerId.toLowerCase() === playerId.toLowerCase()
    && incoming.rootSeed === rootSeed
    && incoming.turnNumber === state.turn.turnNumber
    && Number.isSafeInteger(incoming.actionsTaken)
    && incoming.actionsTaken >= 0
  const historicalKeys = continuesSameTurn ? [...incoming.visitedStateKeys] : []
  const actionsTaken = continuesSameTurn ? incoming.actionsTaken : 0
  const continuationFor = (nextAction?: CandidateAction): AiPlannerContinuation => ({
    version: 1,
    playerId,
    rootSeed,
    turnNumber: state.turn.turnNumber,
    actionsTaken: actionsTaken + Number(nextAction !== undefined),
    visitedStateKeys: [...historicalKeys.filter(key => key !== initialKey), initialKey].slice(-config.maxActions),
  })
  const forcedSafetyReason = historicalKeys.includes(initialKey)
    ? 'repeated-authoritative-state'
    : actionsTaken >= config.maxActions - 1
      ? 'max-actions-reached'
      : undefined
  if (environment.isTerminal(state)) {
    return emptyPlan(config, goal, goalChanged, 'terminal', continuationFor())
  }

  const legalCache = new Map<string, CandidateAction[]>()
  const getLegal = (nodeState: BattleState, key: string) => {
    const cached = legalCache.get(key)
    if (cached) return cached
    const legal = environment.listLegalActions(nodeState, playerId)
    legalCache.set(key, legal)
    return legal
  }
  if (getLegal(state, initialKey).length === 0) {
    return emptyPlan(config, goal, goalChanged, 'no-legal-actions', continuationFor())
  }

  const traces: AiPlannerTraceEntry[] = []
  const bestScoreByState = new Map<string, number>(
    historicalKeys.map(key => [key, Number.POSITIVE_INFINITY]),
  )
  bestScoreByState.set(initialKey, 0)
  let stateDuplicates = 0
  let nodesVisited = 0
  let candidatesConsidered = 0
  let bestComplete: Node | undefined
  let bestPartial: Node | undefined
  let beam: Node[] = [{ state, stateKey: initialKey, actions: [], score: 0 }]
  const remainingActions = Math.max(1, config.maxActions - actionsTaken)

  for (let depth = 0; depth < remainingActions && beam.length && nodesVisited < config.nodeBudget; depth += 1) {
    const next: Node[] = []
    for (const node of beam) {
      if (nodesVisited >= config.nodeBudget) break
      const legal = getLegal(node.state, node.stateKey)
      candidatesConsidered += legal.length
      const ranked = rankedCandidates(node.state, playerId, goal, legal)
      const compatible: RankedCandidate[] = []

      for (const item of ranked) {
        const pruned = compatibilityPrune(item.features.compatibility)
        if (pruned) {
          traces.push(traceEntry(item, depth, zeroScore(), {
            pruned,
            pruneDetail: item.features.diagnostics,
          }))
        } else {
          compatible.push(item)
        }
      }

      const endTurn = compatible.filter(item => item.candidate.kind === 'end-turn')
      const optional = compatible.filter(item => item.candidate.kind !== 'end-turn')
      const searchable = forcedSafetyReason
        ? optional.filter(item => STRUCTURAL_KINDS.has(item.candidate.kind))
        : optional
      for (const skipped of optional.filter(item => !searchable.includes(item))) {
        traces.push(traceEntry(skipped, depth, zeroScore(), {
          pruned: 'turn-safety-limit',
          pruneDetail: forcedSafetyReason,
        }))
      }
      const admitted = searchable.slice(0, config.candidateLimit)
      for (const skipped of searchable.slice(config.candidateLimit)) {
        traces.push(traceEntry(skipped, depth, zeroScore(), {
          pruned: 'candidate-limit',
          pruneDetail: `rank=${skipped.candidateRank};${skipped.reasons.join(';')}`,
        }))
      }

      // Reserve budget for explicit endTurn before exploring optional actions.
      for (const rankedCandidate of [...endTurn, ...admitted]) {
        if (nodesVisited >= config.nodeBudget) break
        nodesVisited += 1
        const transition = environment.simulate(node.state, rankedCandidate.candidate, { rootSeed })
        if (!transition.accepted) {
          traces.push(traceEntry(rankedCandidate, depth, zeroScore(), { rejected: transition.error.code }))
          continue
        }

        const score = evaluateAiTransition(
          node.state,
          transition.state,
          playerId,
          goal,
          config,
          rankedCandidate.candidate.kind === 'end-turn',
          rankedCandidate.features.compatibility,
        )
        const key = environment.stateKey(transition.state, { kind: 'full' })
        if (rankedCandidate.candidate.kind !== 'end-turn' && key === node.stateKey) {
          stateDuplicates += 1
          traces.push(traceEntry(rankedCandidate, depth, score, {
            pruned: 'duplicate-state',
            pruneDetail: 'transition returned the parent state key',
          }))
          continue
        }
        if (
          rankedCandidate.candidate.kind !== 'end-turn'
          && !STRUCTURAL_KINDS.has(rankedCandidate.candidate.kind)
          && score.total <= config.minActionScore
        ) {
          traces.push(traceEntry(rankedCandidate, depth, score, {
            pruned: 'non-positive-action',
            pruneDetail: rankedCandidate.features.compatibility === 'evaluator-required'
              ? 'RED-85 fallback=neutral-value'
              : `score<=${config.minActionScore}`,
          }))
          continue
        }

        const child: Node = {
          state: transition.state,
          stateKey: key,
          actions: [...node.actions, rankedCandidate.candidate],
          score: node.score + score.total,
        }
        const completed = rankedCandidate.candidate.kind === 'end-turn'
          || environment.isTerminal(transition.state)
          || String(transition.state.turn.currentPlayerId).toLowerCase() !== playerId.toLowerCase()
        if (completed) {
          traces.push(traceEntry(rankedCandidate, depth, score))
          if (betterNode(child, bestComplete)) bestComplete = child
          continue
        }

        const previousScore = bestScoreByState.get(key)
        if (previousScore !== undefined && previousScore >= child.score) {
          stateDuplicates += 1
          traces.push(traceEntry(rankedCandidate, depth, score, {
            pruned: 'dominated-state',
            pruneDetail: `existingScore=${previousScore};candidateScore=${child.score}`,
          }))
          continue
        }
        bestScoreByState.set(key, child.score)
        traces.push(traceEntry(rankedCandidate, depth, score))
        next.push(child)
        if (betterNode(child, bestPartial)) bestPartial = child
      }
    }
    beam = next.sort(compareNodes).slice(0, config.beamWidth)
  }

  const selected = bestComplete ?? bestPartial
  if (!selected) {
    return {
      ...emptyPlan(config, goal, goalChanged, 'no-legal-actions', continuationFor()),
      nodesVisited,
      candidatesConsidered,
      stateDuplicates,
      trace: traces,
    }
  }
  const completed = bestComplete !== undefined
  const stopReason: AiPlannerStopReason = completed
    ? (environment.isTerminal(selected.state) ? 'terminal' : 'completed-turn')
    : nodesVisited >= config.nodeBudget ? 'budget-exhausted' : 'action-limit'
  return {
    configVersion: config.version,
    goal,
    goalChanged,
    continuation: continuationFor(selected.actions[0]),
    actions: selected.actions,
    nextAction: selected.actions[0],
    nodesVisited,
    candidatesConsidered,
    stateDuplicates,
    stopReason,
    trace: traces,
  }
}

/** Replanning boundary: pass the new authority state and previous plan, never its queued action list. */
export function planNextAiAction(
  state: BattleState,
  playerId: string,
  rootSeed: number,
  previousPlan?: Pick<AiTurnPlan, 'goal' | 'continuation'>,
  options: Omit<PlannerOptions, 'previousGoal' | 'continuation'> = {},
): AiTurnPlan {
  return planAiTurn(state, playerId, rootSeed, {
    ...options, previousGoal: previousPlan?.goal, continuation: previousPlan?.continuation,
  })
}

export function aiPlanTraceHash(plan: AiTurnPlan): string {
  return hashStable({
    configVersion: plan.configVersion,
    goal: plan.goal,
    goalChanged: plan.goalChanged,
    continuation: plan.continuation,
    actions: plan.actions.map(action => action.action),
    nodesVisited: plan.nodesVisited,
    candidatesConsidered: plan.candidatesConsidered,
    stateDuplicates: plan.stateDuplicates,
    stopReason: plan.stopReason,
    trace: plan.trace,
  })
}

// The zero-stage selector shares the same player-level planning boundary: one
// authoritative action is returned and callers replan after the accepted state.
export { planZeroStageAction, zeroStageDecisionTraceHash } from './ai-zero-stage-agent'
