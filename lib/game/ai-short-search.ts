import type { AIEnvironment, AIObservation, CandidateAction } from './ai-types'
import type { BattleState } from './turn'

export interface ShortSearchConfig {
  depth: number
  beamWidth: number
  rootCandidates: number
  childCandidates: number
  nodesPerDecision: number
  deploymentNodesPerDecision: number
  nodesPerTurn: number
  maxActionsPerTurn: number
  /** Zero disables the wall-clock cutoff for reproducible node-budget runs. */
  turnTimeMs: number
  decisionTimeMs: number
  deploymentTimeMs: number
}

export const SHORT_SEARCH_DEFAULTS: Readonly<ShortSearchConfig> = Object.freeze({
  depth: 3, beamWidth: 6, rootCandidates: 24, childCandidates: 10,
  nodesPerDecision: 128, deploymentNodesPerDecision: 384, nodesPerTurn: 896, maxActionsPerTurn: 8,
  turnTimeMs: 4500, decisionTimeMs: 900, deploymentTimeMs: 2250,
})

/** Keep one continuation per battle/player; pass it back even if a command must be retried. */
export interface ShortSearchContinuation {
  turnKey: string
  nodes: number
  elapsedMs: number
}

export interface ShortSearchTrace {
  depth: number
  candidateId: string
  rootId: string
  score?: number
  reason: 'evaluated' | 'blocked' | 'rejected' | 'duplicate' | 'candidate-limit'
  error?: string
}

export interface ShortSearchOptions {
  environment: AIEnvironment
  /** Must read only the supplied public player observation. */
  evaluate: (observation: AIObservation) => number
  config?: Partial<ShortSearchConfig>
  continuation?: ShortSearchContinuation
  /** Number of authority-accepted ordinary actions, owned by the caller. */
  actionsTakenThisTurn?: number
  now?: () => number
}

export interface ShortSearchDecision {
  nextAction?: CandidateAction
  sequence: CandidateAction[]
  score?: number
  nodes: number
  considered: number
  elapsedMs: number
  overTurnBudget: boolean
  stopReason: 'selected' | 'terminal' | 'other-player' | 'no-actions' | 'time-budget' | 'node-budget' | 'action-budget' | 'random-boundary'
  continuation: ShortSearchContinuation
  trace: ShortSearchTrace[]
}

interface Node {
  state: BattleState
  observation: AIObservation
  sequence: CandidateAction[]
  score: number
  terminalRank: number
  closed: boolean
}

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const samePlayer = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const pendingOwner = (o: AIObservation) => o.pendingOptionSelection?.playerId ?? o.pendingTargetSelection?.playerId
const owner = (o: AIObservation) => pendingOwner(o)
  ?? (o.deployment?.status === 'awaiting-reserve-deploy' ? o.deployment.activePlayerId : undefined)
  ?? o.turn.currentPlayerId
const structural = (c: CandidateAction) => !['move', 'basic-skill', 'charge-skill', 'card', 'end-turn'].includes(c.kind)
const terminalRank = (o: AIObservation, playerId: string) => !o.terminalResult ? 2
  : o.terminalResult.winnerPlayerId === playerId ? 3 : o.terminalResult.winnerPlayerId ? 0 : 1

function compareNodes(a: Node, b: Node) {
  return b.terminalRank - a.terminalRank || b.score - a.score
    || Number(b.sequence[0]?.kind === 'end-turn') - Number(a.sequence[0]?.kind === 'end-turn')
    || a.sequence.length - b.sequence.length
    || compareText(a.sequence.map(c => c.id).join('\n'), b.sequence.map(c => c.id).join('\n'))
}

function actor(c: CandidateAction) {
  const a = c.action
  return 'pieceId' in a ? String(a.pieceId) : 'cardInstanceId' in a ? a.cardInstanceId : 'player'
}

function family(c: CandidateAction) {
  const a = c.action
  return `${c.kind}:${actor(c)}:${'skillId' in a ? a.skillId : ''}`
}

/** Cheap ordering uses public geometry only; actual legality and outcomes stay in the environment. */
function priority(c: CandidateAction, observation: AIObservation) {
  const a = c.action
  let rank = structural(c) ? -10000 : c.kind === 'move' ? 50 : 0
  if ('targetPieceId' in a) {
    const target = observation.pieces.find(p => p.instanceId === a.targetPieceId)
    if (target) rank += 10 * target.currentHp / Math.max(1, target.maxHp)
  }
  if (a.type === 'move') {
    const hostiles = observation.pieces.filter(p => p.currentHp > 0 && p.x !== null && p.y !== null
      && !samePlayer(p.ownerPlayerId, observation.playerId))
    if (hostiles.length) rank += Math.min(...hostiles.map(p => Math.abs(a.toX - p.x!) + Math.abs(a.toY - p.y!)))
  }
  return rank
}

/** Round-robin actor/skill families, then alternate directed and dispersed alternatives within each family. */
export function selectShortSearchCandidates(legal: CandidateAction[], observation: AIObservation, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid short-search candidate limit')
  const sorted = legal.slice().sort((a, b) => priority(a, observation) - priority(b, observation) || compareText(a.id, b.id))
  const selected = sorted.filter(c => c.kind === 'end-turn').slice(0, 1)
  const groups = new Map<string, CandidateAction[]>()
  for (const c of sorted) {
    if (c.kind === 'end-turn') continue
    const key = family(c)
    const group = groups.get(key) ?? []
    group.push(c)
    groups.set(key, group)
  }
  // Pick first, last, middle, then the remaining directed options. No score threshold excludes setup actions.
  const familyQueues = [...groups.values()].map(group => {
    const indices = [...new Set([0, group.length - 1, Math.floor(group.length / 2), ...group.map((_, i) => i)])]
    return indices.map(i => group[i])
  })
  const interleave = (queues: CandidateAction[][]) => {
    const result: CandidateAction[] = []
    for (let round = 0; queues.some(q => round < q.length); round++) {
      for (const queue of queues) if (queue[round]) result.push(queue[round])
    }
    return result
  }
  const actors = new Map<string, CandidateAction[][]>()
  for (const queue of familyQueues) {
    const key = `${queue[0].kind}:${actor(queue[0])}`
    actors.set(key, [...(actors.get(key) ?? []), queue])
  }
  const kinds = new Map<string, CandidateAction[][]>()
  for (const queues of actors.values()) {
    const queue = interleave(queues)
    kinds.set(queue[0].kind, [...(kinds.get(queue[0].kind) ?? []), queue])
  }
  const queues = [...kinds.values()].map(interleave)
  for (let round = 0; selected.length < limit && queues.some(q => round < q.length); round++) {
    for (const q of queues) {
      if (q[round] && selected.length < limit) selected.push(q[round])
    }
  }
  return selected
}

function diverseBeam(nodes: Node[], width: number) {
  const sorted = nodes.slice().sort(compareNodes)
  const result: Node[] = []
  const seen = new Set<string>()
  // Preserve all first-action kinds when capacity permits: basic/charge/card must not evict movement.
  for (const node of sorted) {
    const key = node.sequence[0].kind
    if (!seen.has(key)) { result.push(node); seen.add(key) }
    if (result.length >= width) break
  }
  for (const node of sorted) {
    if (result.length >= width) break
    if (!result.includes(node)) result.push(node)
  }
  return result
}

export function planShortSearchAction(state: BattleState, playerId: string, rootSeed: number, options: ShortSearchOptions): ShortSearchDecision {
  const now = options.now ?? (() => performance.now())
  const started = now()
  const config = { ...SHORT_SEARCH_DEFAULTS, ...options.config }
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < (key.endsWith('Ms') ? 0 : 1)) throw new Error(`Invalid short-search ${key}`)
  }
  const actionsTaken = options.actionsTakenThisTurn ?? 0
  let decisionTimeMs = config.decisionTimeMs
  let decisionNodeLimit = config.nodesPerDecision
  if (!Number.isSafeInteger(actionsTaken) || actionsTaken < 0) throw new Error('Invalid accepted action count')
  const environment = options.environment
  const observation = environment.observe(state, playerId)
  const turnKey = `${playerId}:${observation.turn.turnNumber}:${observation.turn.currentPlayerId}`
  const old = options.continuation?.turnKey === turnKey ? options.continuation : undefined
  if (old && (!Number.isSafeInteger(old.nodes) || old.nodes < 0 || !Number.isFinite(old.elapsedMs) || old.elapsedMs < 0)) {
    throw new Error('Invalid short-search continuation')
  }
  let nodes = 0
  let considered = 0
  const trace: ShortSearchTrace[] = []
  let best: Node | undefined
  let fallback: CandidateAction | undefined
  let stopReason: ShortSearchDecision['stopReason'] = 'selected'
  let lastTime = started
  const elapsed = () => {
    const value = now()
    if (!Number.isFinite(value) || value < lastTime) throw new Error('Non-monotonic search clock')
    lastTime = value
    return value - started
  }
  const finish = (): ShortSearchDecision => {
    const elapsedMs = elapsed()
    const total = (old?.elapsedMs ?? 0) + elapsedMs
    return {
      nextAction: best?.sequence[0] ?? fallback, sequence: best?.sequence ?? (fallback ? [fallback] : []),
      score: best?.score, nodes, considered, elapsedMs,
      overTurnBudget: config.turnTimeMs > 0 && total > config.turnTimeMs,
      stopReason, continuation: { turnKey, nodes: (old?.nodes ?? 0) + nodes, elapsedMs: total }, trace,
    }
  }
  const budgetStop = () => {
    const ms = elapsed()
    if ((config.turnTimeMs > 0 && (old?.elapsedMs ?? 0) + ms >= config.turnTimeMs)
      || (decisionTimeMs > 0 && ms >= decisionTimeMs)) return 'time-budget' as const
    if (nodes >= decisionNodeLimit || (old?.nodes ?? 0) + nodes >= config.nodesPerTurn) return 'node-budget' as const
    return undefined
  }
  if (environment.isTerminal(state)) { stopReason = 'terminal'; return finish() }
  if (!samePlayer(owner(observation), playerId)) { stopReason = 'other-player'; return finish() }
  const legal = environment.listLegalActions(state, playerId)
  if (!legal.length) { stopReason = 'no-actions'; return finish() }
  // A no-safe-cell deployment's actual random landing is not available to the player.
  // Use stable offer order, without simulating the hidden RNG stream or scoring its outcome.
  const hiddenLanding = legal.filter(c => c.kind === 'reserve-deployment'
    && c.action.type === 'deployReservePiece' && c.action.toX === undefined)
  if (hiddenLanding.length) {
    fallback = hiddenLanding.slice().sort((a, b) => compareText(a.id, b.id))[0]
    stopReason = 'random-boundary'; return finish()
  }
  // Deployment offers can contain hundreds of piece/location pairs. Spend this phase's budget
  // on broad one-step coverage instead of deepening an arbitrary 24-placement shortlist.
  // Tactical search resumes after the authority accepts the chosen placement.
  const deploymentDecision = legal.every(c => c.kind === 'reserve-deployment'
    && c.action.type === 'deployReservePiece' && c.action.toX !== undefined)
  if (deploymentDecision) {
    decisionTimeMs = config.deploymentTimeMs
    decisionNodeLimit = config.deploymentNodesPerDecision
  }
  fallback = legal.find(c => c.kind === 'end-turn')
    ?? selectShortSearchCandidates(legal.filter(structural), observation, 1)[0]
  if (actionsTaken >= config.maxActionsPerTurn - 1 && fallback?.kind === 'end-turn') {
    stopReason = 'action-budget'; return finish()
  }
  const evalScore = (o: AIObservation) => {
    const score = options.evaluate(o)
    if (!Number.isFinite(score)) throw new Error('Non-finite public evaluation')
    return score
  }
  let beam: Node[] = [{ state, observation, sequence: [], score: evalScore(observation), terminalRank: 2, closed: false }]
  // Full authoritative state equality is used only to deduplicate simulation states, never to score them.
  const visited = new Set<string>([environment.stateKey(state, { kind: 'full' })])
  const maxDepth = deploymentDecision ? 1 : Math.min(config.depth, Math.max(1, config.maxActionsPerTurn - 1 - actionsTaken))
  search: for (let depth = 0; depth < maxDepth && beam.length; depth++) {
    const frontier: Node[] = []
    // Allocate a per-parent quota so the first branch cannot consume the entire next depth.
    const quota = Math.max(1, Math.floor((decisionNodeLimit - nodes) / beam.length))
    for (const parent of beam) {
      const stop = budgetStop()
      if (stop) { stopReason = stop; break search }
      const candidates = depth === 0 ? legal : environment.listLegalActions(parent.state, playerId)
      considered += candidates.length
      const admitted = selectShortSearchCandidates(candidates, parent.observation,
        Math.min(quota, deploymentDecision ? config.deploymentNodesPerDecision
          : depth === 0 ? config.rootCandidates : config.childCandidates))
      const ids = new Set(admitted.map(c => c.id))
      for (const c of candidates) if (!ids.has(c.id)) trace.push({ depth, candidateId: c.id,
        rootId: parent.sequence[0]?.id ?? c.id, reason: 'candidate-limit' })
      for (const candidate of admitted) {
        if (candidate.kind === 'reserve-deployment' && candidate.action.type === 'deployReservePiece'
          && candidate.action.toX === undefined) continue
        const stop = budgetStop()
        if (stop) { stopReason = stop; break search }
        nodes++
        const row: ShortSearchTrace = { depth, candidateId: candidate.id,
          rootId: parent.sequence[0]?.id ?? candidate.id, reason: 'evaluated' }
        const transition = environment.simulate(parent.state, candidate, { rootSeed })
        if (!transition.accepted) { trace.push({ ...row, reason: 'rejected', error: transition.error.code }); continue }
        if ((transition.trace as { blocked?: boolean }).blocked) { trace.push({ ...row, reason: 'blocked' }); continue }
        const key = environment.stateKey(transition.state, { kind: 'full' })
        if (visited.has(key)) { trace.push({ ...row, reason: 'duplicate' }); continue }
        visited.add(key)
        const observed = environment.observe(transition.state, playerId)
        const score = evalScore(observed)
        trace.push({ ...row, score })
        const child: Node = {
          state: transition.state, observation: observed, sequence: [...parent.sequence, candidate], score,
          terminalRank: terminalRank(observed, playerId),
          closed: environment.isTerminal(transition.state) || candidate.kind === 'end-turn'
            || observed.turn.turnNumber !== observation.turn.turnNumber
            || !samePlayer(owner(observed), playerId),
        }
        if (!best || compareNodes(child, best) < 0) best = child
        if (!child.closed) frontier.push(child)
        if (child.terminalRank === 3) break search
      }
    }
    beam = diverseBeam(frontier, config.beamWidth)
  }
  return finish()
}
