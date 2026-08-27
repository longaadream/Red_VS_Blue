import {
  aiEnvironmentV1,
  aiPotentialEnvironmentV1,
  getAIActionResourceCost,
} from './ai-environment'
import { chooseAiTurnGoal, describeAiCandidate } from './ai-evaluator'
import { resolveZeroStageConfig } from './ai-profiles'
import { hashStable, stableJson } from './battle-trace'
import { combineZeroStagePotential, evaluateZeroStageState } from './ai-zero-stage-evaluator'
import type {
  AIEnvironment,
  AIPotentialEnvironment,
  AiCompatibility,
  CandidateAction,
  ZeroStageCandidateTrace,
  ZeroStageConfig,
  ZeroStageDecision,
  ZeroStageFollowUpTrace,
} from './ai-types'
import type { BattleState } from './turn'

type ZeroStageConfigOverrides = Partial<Omit<ZeroStageConfig, 'version' | 'weights' | 'terminal'>> & {
  weights?: Partial<ZeroStageConfig['weights']>
  terminal?: Partial<ZeroStageConfig['terminal']>
}

export interface ZeroStageAgentOptions {
  config?: ZeroStageConfigOverrides
  environment?: AIEnvironment
  potentialEnvironment?: AIPotentialEnvironment
}

type ScoredOuterCandidate = {
  candidate: CandidateAction
  staticValue: number
  potentialValue: number
  costTotal: number
  trace: ZeroStageCandidateTrace
}

const samePlayer = (left: unknown, right: unknown) => (
  String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
)
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

function errorCode(error: unknown) {
  const value = error as { code?: unknown; name?: unknown }
  return typeof value?.code === 'string'
    ? value.code
    : typeof value?.name === 'string' ? value.name : 'ZERO_STAGE_POTENTIAL_ERROR'
}

function compareOuter(left: ScoredOuterCandidate, right: ScoredOuterCandidate) {
  return right.potentialValue - left.potentialValue
    || right.staticValue - left.staticValue
    || left.costTotal - right.costTotal
    || compareText(stableJson(left.candidate.action), stableJson(right.candidate.action))
    || compareText(left.candidate.id, right.candidate.id)
}

function compatibility(
  state: BattleState,
  playerId: string,
  candidate: CandidateAction,
): { compatibility: AiCompatibility; diagnostics?: string } {
  const goal = chooseAiTurnGoal(state, playerId)
  const described = describeAiCandidate(state, playerId, goal, candidate)
  return {
    compatibility: described.features.compatibility,
    diagnostics: described.features.diagnostics,
  }
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
 * Selects exactly one authoritative action. Any diagnostic continuation is
 * discarded; callers invoke this function again after the accepted state update.
 */
export function planZeroStageAction(
  state: BattleState,
  playerId: string,
  rootSeed: number,
  options: ZeroStageAgentOptions = {},
): ZeroStageDecision {
  const environment = options.environment ?? aiEnvironmentV1
  const potentialEnvironment = options.potentialEnvironment ?? aiPotentialEnvironmentV1
  const config = resolveZeroStageConfig(options.config)
  if (environment.isTerminal(state)) return emptyDecision(state, playerId, environment, config, 'terminal')
  const legal = environment.listLegalActions(state, playerId)
  if (legal.length === 0) return emptyDecision(state, playerId, environment, config, 'no-legal-actions')

  const stateValue = evaluateZeroStageState(environment.observe(state, playerId), config).total
  const traces: ZeroStageCandidateTrace[] = []
  const scored: ScoredOuterCandidate[] = []
  let nodesVisited = 0
  let candidatesConsidered = legal.length
  let budgetExhausted = false

  for (let outerIndex = 0; outerIndex < legal.length; outerIndex += 1) {
    const outer = legal[outerIndex]
    const outerCost = getAIActionResourceCost(state, playerId, outer)
    const semantic = compatibility(state, playerId, outer)
    const outerTrace: ZeroStageCandidateTrace = {
      candidateId: outer.id,
      action: outer.action,
      topValues: [],
      outerCost,
      compatibility: semantic.compatibility,
      followUps: [],
    }
    if (semantic.compatibility !== 'automatic') {
      outerTrace.pruned = `${semantic.compatibility}:${semantic.diagnostics ?? 'RED-85-fail-closed'}`
      traces.push(outerTrace)
      continue
    }
    if (nodesVisited >= config.nodeBudget) {
      budgetExhausted = true
      outerTrace.pruned = 'node-budget'
      traces.push(outerTrace)
      continue
    }

    nodesVisited += 1
    const transition = environment.simulate(state, outer, { rootSeed })
    if (!transition.accepted) {
      outerTrace.rejected = transition.error.code
      traces.push(outerTrace)
      continue
    }
    const staticValue = evaluateZeroStageState(environment.observe(transition.state, playerId), config).total
    outerTrace.staticValue = staticValue
    const remainsOwnDecision = !environment.isTerminal(transition.state)
      && samePlayer(transition.state.turn.currentPlayerId, playerId)
    const followUpValues: number[] = []

    if (remainsOwnDecision) {
      const potentialCandidates = potentialEnvironment.listPotentialActions(transition.state, playerId)
      candidatesConsidered += potentialCandidates.length
      for (const item of potentialCandidates) {
        const followSemantic = compatibility(transition.state, playerId, item.candidate)
        const penalty = item.costBreakthrough ? config.lambda : 0
        const followTrace: ZeroStageFollowUpTrace = {
          candidateId: item.candidate.id,
          costBreakthrough: item.costBreakthrough,
          cost: item.cost,
          shortfall: item.shortfall,
          penalty,
          compatibility: followSemantic.compatibility,
        }
        if (followSemantic.compatibility !== 'automatic') {
          followTrace.pruned = `${followSemantic.compatibility}:${followSemantic.diagnostics ?? 'RED-85-fail-closed'}`
          outerTrace.followUps.push(followTrace)
          continue
        }
        const reservedOuterNodes = legal.length - outerIndex - 1
        if (nodesVisited >= config.nodeBudget - reservedOuterNodes) {
          budgetExhausted = true
          followTrace.pruned = 'node-budget'
          outerTrace.followUps.push(followTrace)
          continue
        }
        try {
          nodesVisited += 1
          const potentialTransition = potentialEnvironment.simulatePotential(
            transition.state,
            item,
            { rootSeed },
          )
          if (!potentialTransition.transition.accepted) {
            followTrace.rejected = potentialTransition.transition.error.code
            outerTrace.followUps.push(followTrace)
            continue
          }
          const followStatic = evaluateZeroStageState(
            environment.observe(potentialTransition.transition.state, playerId),
            config,
          ).total
          const value = followStatic - penalty
          followTrace.staticValue = followStatic
          followTrace.value = value
          followUpValues.push(value)
          outerTrace.followUps.push(followTrace)
        } catch (caught) {
          followTrace.rejected = errorCode(caught)
          outerTrace.followUps.push(followTrace)
        }
      }
    }

    outerTrace.followUps.sort((left, right) => (
      (right.value ?? Number.NEGATIVE_INFINITY) - (left.value ?? Number.NEGATIVE_INFINITY)
      || compareText(left.candidateId, right.candidateId)
    ))
    const potential = combineZeroStagePotential(followUpValues, config.topWeights, staticValue)
    outerTrace.topValues = potential.selected
    outerTrace.potentialValue = potential.value
    traces.push(outerTrace)
    scored.push({
      candidate: outer,
      staticValue,
      potentialValue: potential.value,
      costTotal: outerCost.actionPoints + outerCost.chargePoints,
      trace: outerTrace,
    })
  }

  scored.sort(compareOuter)
  const selected = scored[0]
  return {
    configVersion: config.version,
    playerId,
    stateValue,
    nextAction: selected?.candidate,
    nodesVisited,
    candidatesConsidered,
    budgetExhausted,
    stopReason: selected ? 'selected' : budgetExhausted ? 'budget-exhausted' : 'no-legal-actions',
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
    trace: decision.trace,
  })
}
