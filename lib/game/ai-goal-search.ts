import { aiEnvironmentV1 } from './ai-environment'
import type {
  AIEnvironment,
  AIEnvironmentError,
  CandidateAction,
  TransitionResult,
} from './ai-types'
import { stableJson } from './battle-trace'
import type { BattleState } from './turn'

/**
 * A small, deliberately content agnostic search contract.  The environment is
 * still the source of truth for both candidate generation and transitions; the
 * searcher only supplies ordering, bounds, and route bookkeeping.
 */
export interface GoalSearchBounds {
  /** Maximum number of search nodes examined, including the root and transitions attempted. */
  maxNodes: number
  /** Maximum number of actions in a route. */
  maxDepth: number
  /** Wall clock budget.  A value of zero makes the search immediately bounded. */
  maxTimeMs: number
}

export const DEFAULT_GOAL_SEARCH_BOUNDS: Readonly<GoalSearchBounds> = Object.freeze({
  maxNodes: 256,
  maxDepth: 8,
  maxTimeMs: 2_000,
})

export interface GoalSearchContext {
  playerId: string
  depth: number
  route: readonly CandidateAction[]
  stateKey: string
}

export type GoalPredicate = (state: BattleState, context: GoalSearchContext) => boolean
export type GoalProgress = (state: BattleState, context: GoalSearchContext) => number

export interface GoalSearchOptions {
  /** Defaults to the official v1 environment. */
  environment?: AIEnvironment
  /** Root seed passed to every official isolated transition. */
  rootSeed?: number
  /** Goal callback. */
  goal?: GoalPredicate
  /** Higher finite progress is preferred for the returned frontier hint. */
  progress?: GoalProgress
  /** Bounds can be supplied as a group or as top-level overrides. */
  bounds?: Partial<GoalSearchBounds>
  maxNodes?: number
  maxDepth?: number
  maxTimeMs?: number
  /** Injectable monotonic clock for deterministic budget tests. */
  now?: () => number
}

export interface GoalSearchStats {
  nodesVisited: number
  candidatesEnumerated: number
  candidatesConsidered: number
  transitionsAttempted: number
  transitionsAccepted: number
  simulationRejects: number
  simulationErrors: number
  simulationErrorDetails: Array<{ code: string; message: string }>
  stateDuplicates: number
  maxDepthReached: number
  elapsedMs: number
}

export interface GoalSearchProgressResult {
  value: number
  depth: number
  route: CandidateAction[]
  state: BattleState
  stateKey: string
}

interface GoalSearchResultBase {
  stats: GoalSearchStats
  bounds: GoalSearchBounds
  bestProgress?: GoalSearchProgressResult
}

export interface GoalSearchFound extends GoalSearchResultBase {
  status: 'found'
  kind: 'found'
  route: CandidateAction[]
  firstAction?: CandidateAction
  state: BattleState
  stateKey: string
}

export interface GoalSearchNoRoute extends GoalSearchResultBase {
  status: 'no-route'
  kind: 'no-route'
  reason: 'exhausted' | 'wrong-player' | 'terminal' | 'no-legal-actions'
}

export interface GoalSearchBudgetExhausted extends GoalSearchResultBase {
  status: 'budget-exhausted'
  kind: 'budget-exhausted'
  reason: 'node' | 'depth' | 'time' | 'enumeration' | 'unknown'
}

export interface GoalSearchInvalidInput extends GoalSearchResultBase {
  status: 'invalid-input'
  kind: 'invalid-input'
  error: AIEnvironmentError
}

export type GoalSearchResult =
  | GoalSearchFound
  | GoalSearchNoRoute
  | GoalSearchBudgetExhausted
  | GoalSearchInvalidInput

interface SearchNode {
  state: BattleState
  stateKey: string
  route: CandidateAction[]
  depth: number
  progress?: number
}

const compareText = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
)

function stableActionText(candidate: CandidateAction): string {
  try {
    return stableJson(candidate.action)
  } catch {
    return String(candidate.action)
  }
}

function compareCandidates(left: CandidateAction, right: CandidateAction): number {
  return compareText(left.id, right.id) || compareText(stableActionText(left), stableActionText(right))
}

function samePlayer(left: unknown, right: unknown): boolean {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 0xffff_ffff
}

function validBound(value: unknown, allowZero = false): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && (allowZero ? value >= 0 : value >= 1)
}

function errorResult(
  bounds: GoalSearchBounds,
  stats: GoalSearchStats,
  error: AIEnvironmentError,
  bestProgress?: GoalSearchProgressResult,
): GoalSearchInvalidInput {
  return {
    status: 'invalid-input',
    kind: 'invalid-input',
    error,
    stats,
    bounds,
    bestProgress,
  }
}

function contractError(code: string, message: string): AIEnvironmentError {
  return { code, name: 'GoalSearchInputError', message }
}

function createStats(): GoalSearchStats {
  return {
    nodesVisited: 0,
    candidatesEnumerated: 0,
    candidatesConsidered: 0,
    transitionsAttempted: 0,
    transitionsAccepted: 0,
    simulationRejects: 0,
    simulationErrors: 0,
    simulationErrorDetails: [],
    stateDuplicates: 0,
    maxDepthReached: 0,
    elapsedMs: 0,
  }
}

function resolveBounds(options: GoalSearchOptions): GoalSearchBounds {
  const supplied = options.bounds ?? {}
  return {
    maxNodes: options.maxNodes ?? supplied.maxNodes ?? DEFAULT_GOAL_SEARCH_BOUNDS.maxNodes,
    maxDepth: options.maxDepth ?? supplied.maxDepth ?? DEFAULT_GOAL_SEARCH_BOUNDS.maxDepth,
    maxTimeMs: options.maxTimeMs ?? supplied.maxTimeMs ?? DEFAULT_GOAL_SEARCH_BOUNDS.maxTimeMs,
  }
}

function resolveClock(options: GoalSearchOptions): () => number {
  return options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
}

function safeElapsed(clock: () => number, startedAt: number, lastAt: { value: number }): number {
  const current = clock()
  if (!Number.isFinite(current) || current < lastAt.value) {
    throw new Error('Search clock must be finite and monotonic')
  }
  lastAt.value = current
  return Math.max(0, current - startedAt)
}

function goalContext(node: SearchNode): GoalSearchContext {
  return {
    playerId: '',
    depth: node.depth,
    route: node.route,
    stateKey: node.stateKey,
  }
}

function updateProgress(
  node: SearchNode,
  progress: GoalProgress | undefined,
  playerId: string,
  best: GoalSearchProgressResult | undefined,
): GoalSearchProgressResult | undefined {
  if (!progress) return best
  const value = progress(node.state, { ...goalContext(node), playerId })
  if (!Number.isFinite(value)) throw new Error('Goal progress must be a finite number')
  node.progress = value
  if (!best || value > best.value) {
    return {
      value,
      depth: node.depth,
      route: [...node.route],
      state: node.state,
      stateKey: node.stateKey,
    }
  }
  return best
}

function sameTurn(state: BattleState, playerId: string, turnNumber: number): boolean {
  return state.turn?.turnNumber === turnNumber && samePlayer(state.turn?.currentPlayerId, playerId)
}

function transitionAccepted(result: TransitionResult): result is Extract<TransitionResult, { accepted: true }> {
  return result.accepted
}

/**
 * Search the official environment for the shortest route satisfying a caller
 * supplied goal.  Every legal candidate is retained; progress only chooses a
 * useful frontier hint when the goal is not reached.
 */
export function searchGoalRoute(
  initialState: BattleState,
  playerId: string,
  options: GoalSearchOptions,
): GoalSearchResult {
  const bounds = resolveBounds(options)
  const stats = createStats()
  let clock: () => number
  let startedAt = 0
  const lastAt = { value: 0 }
  let bestProgress: GoalSearchProgressResult | undefined
  const finishStats = () => {
    try {
      stats.elapsedMs = safeElapsed(clock, startedAt, lastAt)
    } catch {
      // The clock error is converted by the caller at the point it is observed.
    }
  }

  try {
    if (!initialState || typeof initialState !== 'object') {
      return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_STATE_REQUIRED', 'A BattleState is required'))
    }
    if (typeof playerId !== 'string' || playerId.trim().length === 0) {
      return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_PLAYER_REQUIRED', 'A non-empty playerId is required'))
    }
    if (!initialState.turn || !Number.isSafeInteger(initialState.turn.turnNumber)) {
      return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_TURN_REQUIRED', 'BattleState.turn.turnNumber must be a safe integer'))
    }
    if (!initialState.players?.some(player => samePlayer(player.playerId, playerId))) {
      return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_PLAYER_NOT_FOUND', `Player ${playerId} is not in this battle`))
    }
    if (!validBound(bounds.maxNodes) || !validBound(bounds.maxDepth, true) || !validBound(bounds.maxTimeMs, true)) {
      return errorResult(bounds, stats, contractError(
        'AI_GOAL_SEARCH_BOUNDS_INVALID',
        'maxNodes and maxDepth must be safe integers (maxNodes >= 1, maxDepth >= 0); maxTimeMs must be a safe integer >= 0',
      ))
    }
    const rootSeed = options.rootSeed
    if (!isUint32(rootSeed)) {
      return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_SEED_INVALID', 'rootSeed must be a uint32 integer'))
    }
    const goal = options.goal
    if (typeof goal !== 'function') {
      return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_GOAL_REQUIRED', 'A goal predicate is required'))
    }

    clock = resolveClock(options)
    startedAt = clock()
    if (!Number.isFinite(startedAt)) throw new Error('Search clock must be finite')
    lastAt.value = startedAt
    const environment = options.environment ?? aiEnvironmentV1
    const progress = options.progress
    const rootKey = environment.stateKey(initialState, { kind: 'full' })
    if (typeof rootKey !== 'string' || rootKey.length === 0) {
      return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_STATE_KEY_INVALID', 'Environment returned an empty root state key'))
    }
    const root: SearchNode = { state: initialState, stateKey: rootKey, route: [], depth: 0 }
    bestProgress = updateProgress(root, progress, playerId, bestProgress)
    if (!samePlayer(initialState.turn.currentPlayerId, playerId)) {
      finishStats()
      return { status: 'no-route', kind: 'no-route', reason: 'wrong-player', stats, bounds, bestProgress }
    }
    if (goal(initialState, { ...goalContext(root), playerId })) {
      finishStats()
      return {
        status: 'found', kind: 'found', route: [], firstAction: undefined,
        state: initialState, stateKey: rootKey, stats, bounds, bestProgress,
      }
    }
    if (environment.isTerminal(initialState)) {
      finishStats()
      return { status: 'no-route', kind: 'no-route', reason: 'terminal', stats, bounds, bestProgress }
    }

    const queue: SearchNode[] = [root]
    stats.nodesVisited = 1
    const visited = new Set<string>([rootKey])
    let cursor = 0
    let budgetReason: GoalSearchBudgetExhausted['reason'] | undefined
    let sawLegalActions = false

    while (cursor < queue.length) {
      const node = queue[cursor++]
      const elapsedBefore = safeElapsed(clock, startedAt, lastAt)
      if (elapsedBefore >= bounds.maxTimeMs) {
        budgetReason = 'time'
        break
      }
      if (node.depth >= bounds.maxDepth) {
        budgetReason = 'depth'
        break
      }
      if (stats.nodesVisited >= bounds.maxNodes && cursor < queue.length) {
        budgetReason = 'node'
        break
      }

      stats.maxDepthReached = Math.max(stats.maxDepthReached, node.depth)
      let legal: CandidateAction[]
      try {
        legal = environment.listLegalActions(node.state, playerId)
      } catch (error) {
        finishStats()
        return errorResult(bounds, stats, contractError(
          'AI_GOAL_SEARCH_ENUMERATION_ERROR',
          error instanceof Error ? error.message : String(error),
        ), bestProgress)
      }
      const elapsedAfter = safeElapsed(clock, startedAt, lastAt)
      if (elapsedAfter >= bounds.maxTimeMs) {
        budgetReason = 'enumeration'
        break
      }
      if (!Array.isArray(legal)) {
        finishStats()
        return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_ACTIONS_INVALID', 'Environment returned a non-array action list'), bestProgress)
      }
      stats.candidatesEnumerated += legal.length
      if (legal.length > 0) sawLegalActions = true
      const candidates = legal.slice().sort(compareCandidates)
      for (const candidate of candidates) {
        const elapsed = safeElapsed(clock, startedAt, lastAt)
        if (elapsed >= bounds.maxTimeMs) {
          budgetReason = 'time'
          break
        }
        // maxNodes also bounds transition calls and therefore the number of
        // accepted child states retained in the queue.  Action enumeration is
        // a synchronous environment call and is measured before/after it.
        if (stats.nodesVisited >= bounds.maxNodes) {
          budgetReason = 'node'
          break
        }
        stats.candidatesConsidered += 1
        stats.transitionsAttempted += 1
        stats.nodesVisited += 1
        let transition: TransitionResult
        try {
          transition = environment.simulate(node.state, candidate, { rootSeed })
        } catch (error) {
          stats.simulationErrors += 1
          stats.simulationErrorDetails.push({
            code: 'AI_GOAL_SEARCH_SIMULATION_THROW',
            message: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (!transition || typeof transition !== 'object') {
          stats.simulationErrors += 1
          stats.simulationErrorDetails.push({
            code: 'AI_GOAL_SEARCH_SIMULATION_RESULT_INVALID',
            message: 'Environment returned a non-object transition result',
          })
          continue
        }
        if (!transitionAccepted(transition)) {
          stats.simulationRejects += 1
          continue
        }
        stats.transitionsAccepted += 1
        const nextState = transition.state
        if (!sameTurn(nextState, playerId, initialState.turn.turnNumber)) continue
        let nextKey: string
        try {
          nextKey = environment.stateKey(nextState, { kind: 'full' })
        } catch (error) {
          stats.simulationErrors += 1
          stats.simulationErrorDetails.push({
            code: 'AI_GOAL_SEARCH_STATE_KEY_ERROR',
            message: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (visited.has(nextKey)) {
          stats.stateDuplicates += 1
          continue
        }
        visited.add(nextKey)
        const next: SearchNode = {
          state: nextState,
          stateKey: nextKey,
          route: [...node.route, candidate],
          depth: node.depth + 1,
        }
        stats.maxDepthReached = Math.max(stats.maxDepthReached, next.depth)
        try {
          bestProgress = updateProgress(next, progress, playerId, bestProgress)
          if (goal(nextState, { ...goalContext(next), playerId })) {
            finishStats()
            return {
              status: 'found', kind: 'found', route: next.route,
              firstAction: next.route[0], state: nextState, stateKey: nextKey,
              stats, bounds, bestProgress,
            }
          }
        } catch (error) {
          finishStats()
          return errorResult(bounds, stats, contractError(
            'AI_GOAL_SEARCH_GOAL_ERROR',
            error instanceof Error ? error.message : String(error),
          ), bestProgress)
        }
        queue.push(next)
        const afterSimulation = safeElapsed(clock, startedAt, lastAt)
        if (afterSimulation >= bounds.maxTimeMs) {
          budgetReason = 'time'
          break
        }
      }
      if (budgetReason) break
    }

    finishStats()
    if (budgetReason) {
      return { status: 'budget-exhausted', kind: 'budget-exhausted', reason: budgetReason, stats, bounds, bestProgress }
    }
    if (stats.simulationErrors > 0) {
      return errorResult(bounds, stats, {
        code: stats.simulationErrorDetails[0]?.code ?? 'AI_GOAL_SEARCH_SIMULATION_ERROR',
        name: 'GoalSearchSimulationError',
        message: stats.simulationErrorDetails[0]?.message ?? 'Environment simulation failed',
      }, bestProgress)
    }
    if (!sawLegalActions) {
      return { status: 'no-route', kind: 'no-route', reason: 'no-legal-actions', stats, bounds, bestProgress }
    }
    return { status: 'no-route', kind: 'no-route', reason: 'exhausted', stats, bounds, bestProgress }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    finishStats()
    return errorResult(bounds, stats, contractError('AI_GOAL_SEARCH_INVALID_INPUT', message), bestProgress)
  }
}
