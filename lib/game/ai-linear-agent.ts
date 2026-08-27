import { aiEnvironmentV1 } from './ai-environment'
import { AI_LINEAR_FEATURE_NAMES, encodeLinearObservation, linearFeatureRecord } from './ai-linear-features'
import { hashStable } from './battle-trace'
import type {
  AIEnvironment,
  AiLinearConfig,
  AiLinearDecision,
  AiLinearDecisionTraceEntry,
  CandidateAction,
} from './ai-types'
import type { BattleState } from './turn'

const STRUCTURAL_KINDS = new Set<CandidateAction['kind']>([
  'deployment-choice', 'deployment-lock', 'phase-advance',
  'pending-option', 'pending-target', 'cancel-selection',
])
const TERMINAL_SCORE = 1_000_000

export function resolveAiLinearConfig(config: AiLinearConfig): Required<AiLinearConfig> {
  if (config?.version !== 1 || config.featureSchemaVersion !== 1) {
    throw new RangeError('AI linear config version must be 1')
  }
  const unknown = Object.keys(config.weights).filter(name => !AI_LINEAR_FEATURE_NAMES.includes(name as never))
  const missing = AI_LINEAR_FEATURE_NAMES.filter(name => !Object.hasOwn(config.weights, name))
  if (unknown.length || missing.length) {
    throw new RangeError(`AI linear weights do not match feature schema; missing=${missing.join(',')};unknown=${unknown.join(',')}`)
  }
  for (const [name, value] of Object.entries(config.weights)) {
    if (!Number.isFinite(value)) throw new RangeError(`AI linear weight ${name} must be finite`)
  }
  const minImprovement = config.minImprovement ?? 0
  const maxCandidates = config.maxCandidates ?? 64
  if (!Number.isFinite(minImprovement)) throw new RangeError('AI linear minImprovement must be finite')
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
    throw new RangeError('AI linear maxCandidates must be a positive safe integer')
  }
  return { ...config, minImprovement, maxCandidates }
}

const OPTIONAL_KIND_ORDER: readonly CandidateAction['kind'][] = [
  'basic-skill', 'charge-skill', 'card', 'move',
]

function shortlistCandidates(
  legal: readonly CandidateAction[],
  maxCandidates: number,
  playerId: string,
  rootSeed: number,
) {
  if (legal.length <= maxCandidates) return { admitted: [...legal], pruned: [] as CandidateAction[] }
  const mandatory = legal.filter(candidate => candidate.kind === 'end-turn' || STRUCTURAL_KINDS.has(candidate.kind))
  if (mandatory.length > maxCandidates) {
    throw new RangeError(`AI_LINEAR_MANDATORY_CANDIDATE_LIMIT_EXCEEDED:${mandatory.length}>${maxCandidates}`)
  }
  const optional = legal.filter(candidate => !mandatory.includes(candidate))
  const byKind = new Map(OPTIONAL_KIND_ORDER.map(kind => [kind, optional
    .filter(candidate => candidate.kind === kind)
    .sort((left, right) => {
      const leftKey = hashStable({ stream: 'linear-candidate-budget', rootSeed, playerId, candidateId: left.id })
      const rightKey = hashStable({ stream: 'linear-candidate-budget', rootSeed, playerId, candidateId: right.id })
      return leftKey.localeCompare(rightKey) || left.id.localeCompare(right.id)
    })]))
  const admitted = [...mandatory]
  while (admitted.length < maxCandidates) {
    let added = false
    for (const kind of OPTIONAL_KIND_ORDER) {
      const next = byKind.get(kind)?.shift()
      if (!next) continue
      admitted.push(next)
      added = true
      if (admitted.length >= maxCandidates) break
    }
    if (!added) break
  }
  const admittedIds = new Set(admitted.map(candidate => candidate.id))
  return { admitted, pruned: legal.filter(candidate => !admittedIds.has(candidate.id)) }
}

function terminalOutcome(state: BattleState, playerId: string): 'win' | 'draw' | 'loss' | undefined {
  const result = state.terminalResult
  if (!result || result.status !== 'finished') return undefined
  if (!result.winnerPlayerId) return 'draw'
  return result.winnerPlayerId.toLowerCase() === playerId.toLowerCase() ? 'win' : 'loss'
}

function better(
  score: number,
  candidate: CandidateAction,
  selectedScore: number,
  selected: CandidateAction | undefined,
) {
  return score > selectedScore || (score === selectedScore && (!selected || candidate.id < selected.id))
}

/** One-ply, deterministic, public-observation-only linear decision. */
export function chooseLinearGreedyAction(
  state: BattleState,
  playerId: string,
  rootSeed: number,
  inputConfig: AiLinearConfig,
  environment: AIEnvironment = aiEnvironmentV1,
): AiLinearDecision {
  const config = resolveAiLinearConfig(inputConfig)
  const legal = environment.listLegalActions(state, playerId)
  const shortlisted = shortlistCandidates(legal, config.maxCandidates, playerId, rootSeed)
  const before = linearFeatureRecord(encodeLinearObservation(environment.observe(state, playerId)))
  const beforeKey = environment.stateKey(state, { kind: 'full' })
  const trace: AiLinearDecisionTraceEntry[] = []
  let selected: CandidateAction | undefined
  let selectedScore = Number.NEGATIVE_INFINITY
  let nodes = 0

  for (const candidate of shortlisted.pruned) {
    trace.push({ candidateId: candidate.id, kind: candidate.kind, accepted: false, pruned: 'candidate-budget' })
  }

  for (const candidate of shortlisted.admitted) {
    nodes += 1
    const transition = environment.simulate(state, candidate, { rootSeed })
    if (!transition.accepted) {
      trace.push({ candidateId: candidate.id, kind: candidate.kind, accepted: false, rejected: transition.error.code })
      continue
    }
    const stateKey = environment.stateKey(transition.state, { kind: 'full' })
    if (stateKey === beforeKey && candidate.kind !== 'end-turn' && !STRUCTURAL_KINDS.has(candidate.kind)) {
      trace.push({ candidateId: candidate.id, kind: candidate.kind, accepted: true, stateKey, pruned: 'duplicate-state' })
      continue
    }
    const outcome = terminalOutcome(transition.state, playerId)
    const after = linearFeatureRecord(encodeLinearObservation(environment.observe(transition.state, playerId)))
    const contributions = Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [
      name, (after[name] - before[name]) * config.weights[name],
    ]))
    let score = Object.values(contributions).reduce((total, value) => total + value, 0)
    if (outcome === 'win') score = TERMINAL_SCORE
    else if (outcome === 'loss') score = -TERMINAL_SCORE
    else if (outcome === 'draw') score = 0
    else if (candidate.kind === 'end-turn') score = 0
    else if (!STRUCTURAL_KINDS.has(candidate.kind) && score <= config.minImprovement) {
      trace.push({
        candidateId: candidate.id, kind: candidate.kind, accepted: true, score, stateKey,
        contributions, pruned: `score<=${config.minImprovement}`,
      })
      continue
    }
    trace.push({ candidateId: candidate.id, kind: candidate.kind, accepted: true, score, terminal: outcome, stateKey, contributions })
    if (better(score, candidate, selectedScore, selected)) {
      selected = candidate
      selectedScore = score
    }
  }

  const traceHash = hashStable({
    kind: 'linear-greedy', config, playerId, rootSeed, beforeKey,
    action: selected?.action, nodes, trace,
  })
  return { action: selected, nodes, traceHash, trace }
}
