import { aiEnvironmentV1 } from '../game/ai-environment'
import type { AIEnvironment, CandidateAction } from '../game/ai-types'
import {
  searchGoalRoute,
  type GoalSearchBounds,
  type GoalSearchOptions,
  type GoalSearchResult,
} from '../game/ai-goal-search'
import type { BattleAction, BattleState } from '../game/turn'
import { createShadowState } from './shadow-state'

export type ShadowGoal =
  | { kind: 'summon'; templateId: string }
  | { kind: 'eliminate'; targetId: string }

export interface GoalPolicyOptions {
  /** A generic local goal. Content-specific strategy remains outside this adapter. */
  goal?: ShadowGoal
  goalKind?: ShadowGoal['kind']
  goalTemplateId?: string
  summonTemplateId?: string
  targetPieceId?: string
  eliminatePieceId?: string
  /** The seed used for hypothetical local simulations. Never read from snapshotState. */
  hypotheticalSeed?: number
  localSeed?: number
  /** Aliases for callers that already have a local search seed. */
  rootSeed?: number
  seed?: number
  environment?: AIEnvironment
  bounds?: Partial<GoalSearchBounds>
  search?: Partial<GoalSearchBounds>
  maxNodes?: number
  maxDepth?: number
  maxTimeMs?: number
  now?: () => number
}

export type GoalPolicyReason =
  | 'goal-route-found'
  | 'pending-option-selection'
  | 'pending-target-selection'
  | 'deployment-selection'
  | 'waiting-for-other-player'
  | 'fallback-budget-exhausted'
  | 'fallback-no-route'
  | 'fallback-search-invalid'
  | 'no-legal-actions'
  | 'terminal'
  | 'invalid-player'
  | 'invalid-shadow'
  | 'pending-credentials-missing'
  | 'pending-descriptor-invalid'
  | 'deployment-descriptor-missing'

export interface GoalSearchSummary {
  status: GoalSearchResult['status']
  kind: GoalSearchResult['kind']
  stats: GoalSearchResult['stats']
  bounds: GoalSearchResult['bounds']
  reason?: string
}

export interface GoalPolicyDecision {
  action?: BattleAction
  /** The formal candidate used for a normal-turn fallback or goal route. */
  candidate?: CandidateAction
  reason: GoalPolicyReason
  goal?: ShadowGoal
  diagnostics: string[]
  route?: BattleAction[]
  search?: GoalSearchSummary
}

export const DEFAULT_SHADOW_HYPOTHETICAL_SEED = 0x5348_444f

const samePlayer = (left: unknown, right: unknown): boolean => (
  String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
)

const safeInteger = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
)

function actualPlayerId(state: BattleState, playerId: string): string | undefined {
  return state.players.find(player => samePlayer(player.playerId, playerId))?.playerId
}

function pendingOwner(state: BattleState): string | undefined {
  return state.pendingOptionSelection?.playerId
    ?? state.pendingTargetSelection?.ownerPlayerId
    ?? state.pendingTargetSelection?.playerId
}

function aliveEnemyPieces(state: BattleState, playerId: string) {
  return state.pieces.filter(piece => (
    piece.currentHp > 0 && !samePlayer(piece.ownerPlayerId, playerId)
  ))
}

function weakestEnemy(state: BattleState, playerId: string) {
  return aliveEnemyPieces(state, playerId).sort((left, right) => (
    left.currentHp - right.currentHp
    || left.maxHp - right.maxHp
    || left.attack - right.attack
    || left.instanceId.localeCompare(right.instanceId)
  ))[0]
}

function resolveGoal(
  state: BattleState,
  playerId: string,
  options: GoalPolicyOptions,
  diagnostics: string[],
): ShadowGoal | undefined {
  const configured = options.goal
  const configuredKind = configured?.kind ?? options.goalKind
  const configuredTemplate = configured?.kind === 'summon'
    ? configured.templateId
    : options.goalTemplateId ?? options.summonTemplateId
  if (configuredKind === 'summon' || configuredTemplate) {
    const templateId = configuredTemplate?.trim()
    if (!templateId) {
      diagnostics.push('summon goal templateId is empty; using weakest visible enemy')
    } else if (state.pieces.some(piece => (
      piece.currentHp > 0
      && samePlayer(piece.ownerPlayerId, playerId)
      && piece.templateId === templateId
    ))) {
      diagnostics.push('configured summon goal already achieved; switching to default eliminate goal')
    } else {
      return { kind: 'summon', templateId }
    }
  }

  const configuredTarget = configured?.kind === 'eliminate'
    ? configured.targetId
    : options.targetPieceId ?? options.eliminatePieceId
  if (configuredTarget && state.pieces.some(piece => piece.instanceId === configuredTarget && piece.currentHp > 0
    && !samePlayer(piece.ownerPlayerId, playerId))) {
    return { kind: 'eliminate', targetId: configuredTarget }
  }
  if (configuredTarget) diagnostics.push('configured eliminate target is not a visible living enemy; using weakest visible enemy')
  const target = weakestEnemy(state, playerId)
  if (!target) {
    diagnostics.push('no visible living enemy is available for the default eliminate goal')
    return undefined
  }
  diagnostics.push(`default eliminate goal selected public target ${target.instanceId}`)
  return { kind: 'eliminate', targetId: target.instanceId }
}

function goalPredicate(goal: ShadowGoal, playerId: string) {
  return (state: BattleState): boolean => {
    if (goal.kind === 'summon') {
      return state.pieces.some(piece => (
        piece.currentHp > 0
        && samePlayer(piece.ownerPlayerId, playerId)
        && piece.templateId === goal.templateId
      ))
    }
    const target = state.pieces.find(piece => piece.instanceId === goal.targetId)
    return !target || target.currentHp <= 0
  }
}

function goalProgress(goal: ShadowGoal, playerId: string) {
  return (state: BattleState): number => {
    if (goal.kind === 'summon') {
      return state.pieces.some(piece => (
        piece.currentHp > 0
        && samePlayer(piece.ownerPlayerId, playerId)
        && piece.templateId === goal.templateId
      )) ? 1 : 0
    }
    const target = state.pieces.find(piece => piece.instanceId === goal.targetId)
    return target && target.currentHp > 0 ? -target.currentHp : 1
  }
}

function credentials(
  pending: { selectionId?: string; stateRevision?: number },
): { selectionId: string; stateRevision: number } | undefined {
  if (typeof pending.selectionId !== 'string' || pending.selectionId.length === 0) return undefined
  const stateRevision = safeInteger(pending.stateRevision)
  return stateRevision === undefined || stateRevision < 0
    ? undefined
    : { selectionId: pending.selectionId, stateRevision }
}

function pendingOptionAction(
  state: BattleState,
  playerId: string,
  diagnostics: string[],
): { action?: BattleAction; reason: GoalPolicyReason } {
  const pending = state.pendingOptionSelection
  if (!pending || !samePlayer(pending.playerId, playerId)) return { reason: 'waiting-for-other-player' }
  const credential = credentials(pending)
  if (!credential) {
    diagnostics.push('pending option descriptor has no usable selectionId/stateRevision')
    return { reason: 'pending-credentials-missing' }
  }
  const rawValues = (pending.options ?? []).map(option => (
    option && typeof option === 'object' && 'value' in option
      ? (option as { value: unknown }).value
      : option
  ))
  const multi = pending.selectionMode === 'multi'
    || (safeInteger(pending.maxSelections) ?? 1) > 1
  const minSelections = multi ? Math.max(0, safeInteger(pending.minSelections) ?? 1) : 1
  const maxSelections = multi
    ? Math.max(minSelections, safeInteger(pending.maxSelections) ?? rawValues.length)
    : 1
  if (minSelections > maxSelections || rawValues.length < minSelections) {
    diagnostics.push(`pending option descriptor cannot satisfy ${minSelections}-${maxSelections} selections`)
    if (pending.canCancel !== false) {
      return {
        reason: 'pending-option-selection',
        action: {
          type: 'cancelPendingSelection',
          playerId: pending.playerId,
          ...credential,
        },
      }
    }
    return { reason: 'pending-descriptor-invalid' }
  }
  const selected = rawValues.slice(0, minSelections)
  return {
    reason: 'pending-option-selection',
    action: {
      type: 'pendingOptionSelect',
      playerId: pending.playerId,
      selectedOption: multi ? selected : selected[0],
      ...credential,
    },
  }
}

function targetFields(target: { type: 'piece'; pieceId: string } | { type: 'cell'; x: number; y: number }) {
  return target.type === 'piece'
    ? { targetPieceId: target.pieceId }
    : { targetX: target.x, targetY: target.y }
}

function extraTargetFields(target: { type: 'piece'; pieceId: string } | { type: 'cell'; x: number; y: number }) {
  return target.type === 'piece'
    ? { pieceId: target.pieceId }
    : { x: target.x, y: target.y }
}

function pendingTargetAction(
  state: BattleState,
  playerId: string,
  diagnostics: string[],
): { action?: BattleAction; reason: GoalPolicyReason } {
  const pending = state.pendingTargetSelection
  const owner = pending?.ownerPlayerId || pending?.playerId
  if (!pending || !owner || !samePlayer(owner, playerId)) return { reason: 'waiting-for-other-player' }
  const credential = credentials(pending)
  if (!credential) {
    diagnostics.push('pending target descriptor has no usable selectionId/stateRevision')
    return { reason: 'pending-credentials-missing' }
  }
  const candidates = (pending.candidates ?? []).filter(candidate => (
    candidate.type === 'piece' && typeof candidate.pieceId === 'string'
      || candidate.type === 'cell' && typeof candidate.x === 'number' && typeof candidate.y === 'number'
  )).filter((candidate, index, all) => all.findIndex(previous => (
    candidate.type === 'piece' && previous.type === 'piece'
      ? candidate.pieceId === previous.pieceId
      : candidate.type === 'cell' && previous.type === 'cell'
        && candidate.x === previous.x && candidate.y === previous.y
  )) === index)
  const multi = pending.selectionMode === 'multi'
    || (safeInteger(pending.maxSelections) ?? 1) > 1
  const minSelections = multi ? Math.max(0, safeInteger(pending.minSelections ?? pending.min) ?? 1) : 1
  const maxSelections = multi
    ? Math.max(minSelections, safeInteger(pending.maxSelections ?? pending.max) ?? candidates.length)
    : 1
  if (minSelections > maxSelections || candidates.length < minSelections || minSelections === 0) {
    diagnostics.push(`pending target descriptor cannot satisfy ${minSelections}-${maxSelections} selections`)
    if (pending.canCancel !== false) {
      return {
        reason: 'pending-target-selection',
        action: {
          type: 'cancelPendingSelection',
          playerId: owner,
          ...credential,
        },
      }
    }
    return { reason: 'pending-descriptor-invalid' }
  }
  const selected = candidates.slice(0, minSelections)
  const [first, ...extra] = selected
  if (!first) return { reason: 'pending-descriptor-invalid' }
  const action: BattleAction = {
    type: 'pendingTargetSelect',
    playerId: owner,
    ...targetFields(first),
    ...(extra.length > 0 ? { extraTargets: extra.map(extraTargetFields) } : {}),
    ...credential,
  }
  return { reason: 'pending-target-selection', action }
}

function deploymentAction(
  state: BattleState,
  playerId: string,
  diagnostics: string[],
): { action?: BattleAction; reason: GoalPolicyReason } | undefined {
  const deployment = state.deployment
  if (!deployment) return undefined
  if (deployment.status === 'awaiting-reserve-deploy') {
    if (!samePlayer(deployment.activePlayerId, playerId)
      || !samePlayer(state.turn.currentPlayerId, playerId)) return { reason: 'waiting-for-other-player' }
    const expectedDeploymentRevision = safeInteger(deployment.revision)
    const offer = deployment.offerPieces?.[0]
    if (expectedDeploymentRevision === undefined || !offer?.instanceId) {
      diagnostics.push('progressive deployment descriptor has no public offer or revision')
      return { reason: 'deployment-descriptor-missing' }
    }
    const position = deployment.legalPositions?.[0]
    if (!position) diagnostics.push('deployment has no published safe cell; authority fallback placement remains unresolved')
    return {
      reason: 'deployment-selection',
      action: {
        type: 'deployReservePiece',
        playerId: deployment.activePlayerId || playerId,
        expectedDeploymentRevision,
        pieceId: offer.instanceId,
        ...(position ? { toX: position.x, toY: position.y } : {}),
      },
    }
  }
  if (deployment.status !== 'awaiting-locks') return undefined
  const stablePlayerId = deployment.playerIds.find(candidate => samePlayer(candidate, playerId)) ?? playerId
  const lock = deployment.locks?.[stablePlayerId]
  if (lock?.locked) return { reason: 'waiting-for-other-player' }
  const existingChoice = deployment.choices?.[stablePlayerId]
  if (existingChoice && existingChoice.pieceId !== undefined) {
    return {
      reason: 'deployment-selection',
      action: { type: 'deploymentLock', playerId: stablePlayerId },
    }
  }
  if (!existingChoice) {
    diagnostics.push('legacy deployment choice is not player-visible; locking without a reroll choice')
    return {
      reason: 'deployment-selection',
      action: { type: 'deploymentLock', playerId: stablePlayerId },
    }
  }
  const piece = state.pieces
    .filter(candidate => samePlayer(candidate.ownerPlayerId, playerId) && candidate.isCore === true && candidate.currentHp > 0)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId))[0]
  return {
    reason: 'deployment-selection',
    action: { type: 'deploymentChoice', playerId: stablePlayerId, pieceId: piece?.instanceId ?? null },
  }
}

function fallbackCandidate(
  candidates: CandidateAction[],
  state: BattleState,
  playerId: string,
  goal: ShadowGoal | undefined,
): CandidateAction | undefined {
  if (!candidates.length) return undefined
  const targetId = goal?.kind === 'eliminate' ? goal.targetId : undefined
  const sorted = candidates.slice().sort((left, right) => left.id.localeCompare(right.id))
  const direct = targetId && sorted.find(candidate => (
    'targetPieceId' in candidate.action && candidate.action.targetPieceId === targetId
  ))
  if (direct) return direct
  const actionable = sorted.filter(candidate => candidate.action.type !== 'endTurn')
  if (goal?.kind === 'summon') {
    const card = actionable.find(candidate => candidate.action.type === 'playCard')
    if (card) return card
  }
  if (goal?.kind === 'eliminate') {
    const move = actionable
      .filter(candidate => candidate.action.type === 'move')
      .sort((left, right) => {
        const target = state.pieces.find(piece => piece.instanceId === targetId)
        if (!target || target.x === null || target.y === null) return left.id.localeCompare(right.id)
        const distance = (candidate: CandidateAction) => {
          const action = candidate.action
          return action.type === 'move' ? Math.abs(action.toX - target.x!) + Math.abs(action.toY - target.y!) : Number.POSITIVE_INFINITY
        }
        return distance(left) - distance(right) || left.id.localeCompare(right.id)
      })[0]
    if (move) return move
  }
  return actionable[0] ?? sorted.find(candidate => candidate.action.type === 'endTurn')
}

function summary(result: GoalSearchResult): GoalSearchSummary {
  const reason = 'reason' in result ? result.reason : undefined
  return {
    status: result.status,
    kind: result.kind,
    stats: result.stats,
    bounds: result.bounds,
    ...(reason ? { reason } : {}),
  }
}

function searchOptions(
  options: GoalPolicyOptions,
  environment: AIEnvironment,
  playerId: string,
  goal: ShadowGoal,
): GoalSearchOptions {
  const configuredBounds = options.bounds ?? options.search
  const hypotheticalSeed = options.hypotheticalSeed
    ?? options.localSeed
    ?? options.rootSeed
    ?? options.seed
    ?? DEFAULT_SHADOW_HYPOTHETICAL_SEED
  return {
    environment,
    rootSeed: hypotheticalSeed,
    goal: goalPredicate(goal, playerId),
    progress: goalProgress(goal, playerId),
    bounds: configuredBounds,
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.maxTimeMs !== undefined ? { maxTimeMs: options.maxTimeMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  }
}

/**
 * Decide exactly one player action from a visible snapshot.  The returned
 * action is a proposal for the transport layer; only the server can settle
 * it. Callers should discard it after any authority revision or rejection.
 */
export function decideGoalAction(
  snapshotState: BattleState,
  playerId: string,
  options: GoalPolicyOptions = {},
): GoalPolicyDecision {
  const projected = createShadowState(snapshotState, playerId)
  const state = projected.state
  const diagnostics = [...projected.diagnostics]
  const owner = actualPlayerId(state, playerId)
  if (!owner) return { reason: 'invalid-player', diagnostics: [...diagnostics, 'player is absent from the public snapshot'] }
  if (state.terminalResult) return { reason: 'terminal', diagnostics }

  const pending = pendingOwner(state)
  if (state.pendingOptionSelection) {
    const result = pendingOptionAction(state, owner, diagnostics)
    if (result.action) return { action: result.action, reason: result.reason, diagnostics }
    return { reason: result.reason, diagnostics }
  }
  if (state.pendingTargetSelection) {
    const result = pendingTargetAction(state, owner, diagnostics)
    if (result.action) return { action: result.action, reason: result.reason, diagnostics }
    return { reason: result.reason, diagnostics }
  }
  if (pending && !samePlayer(pending, owner)) {
    return { reason: 'waiting-for-other-player', diagnostics: [...diagnostics, 'another player owns the pending public descriptor'] }
  }

  const deployment = deploymentAction(state, owner, diagnostics)
  if (deployment) {
    return deployment.action
      ? { action: deployment.action, reason: deployment.reason, diagnostics }
      : { reason: deployment.reason, diagnostics }
  }
  if (!samePlayer(state.turn.currentPlayerId, owner)) {
    return { reason: 'waiting-for-other-player', diagnostics }
  }

  const goalDiagnostics: string[] = []
  const goal = resolveGoal(state, owner, options, goalDiagnostics)
  diagnostics.push(...goalDiagnostics)
  if (!goal) {
    let legal: CandidateAction[] = []
    try {
      legal = (options.environment ?? aiEnvironmentV1).listLegalActions(state, owner)
    } catch (error) {
      diagnostics.push(`formal legal candidate enumeration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const candidate = fallbackCandidate(legal, state, owner, undefined)
    return candidate
      ? { action: candidate.action, candidate, reason: 'fallback-no-route', diagnostics }
      : { reason: 'no-legal-actions', diagnostics }
  }

  const environment = options.environment ?? aiEnvironmentV1
  let result: GoalSearchResult
  try {
    const request = searchOptions(options, environment, owner, goal)
    result = searchGoalRoute(state, owner, request)
  } catch (error) {
    diagnostics.push(`bounded goal search threw: ${error instanceof Error ? error.message : String(error)}`)
    return { reason: 'fallback-search-invalid', goal, diagnostics }
  }
  const search = summary(result)
  diagnostics.push(
    `goal search status=${search.status}`,
    `goal search budget nodes=${search.bounds.maxNodes} depth=${search.bounds.maxDepth} timeMs=${search.bounds.maxTimeMs}`,
    `goal search stats visited=${search.stats.nodesVisited} candidates=${search.stats.candidatesConsidered} accepted=${search.stats.transitionsAccepted} duplicates=${search.stats.stateDuplicates} elapsedMs=${search.stats.elapsedMs}`,
  )
  if (result.status === 'found' && result.firstAction) {
    return {
      action: result.firstAction.action,
      candidate: result.firstAction,
      reason: 'goal-route-found',
      goal,
      route: result.route.map(candidate => candidate.action),
      search,
      diagnostics,
    }
  }

  const rootProgress = goalProgress(goal, owner)(state)
  const frontier = result.bestProgress
  if (
    result.status === 'budget-exhausted'
    && frontier
    && frontier.route.length > 0
    && frontier.value > rootProgress
  ) {
    const first = frontier.route[0]
    diagnostics.push(
      `submitted first action from improved frontier after ${result.status}`,
      `frontier progress=${frontier.value} depth=${frontier.depth}`,
    )
    return {
      action: first.action,
      candidate: first,
      reason: 'fallback-budget-exhausted',
      goal,
      route: frontier.route.map(candidate => candidate.action),
      search,
      diagnostics,
    }
  }

  let legal: CandidateAction[] = []
  try {
    legal = environment.listLegalActions(state, owner)
  } catch (error) {
    diagnostics.push(`formal legal candidate enumeration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const candidate = fallbackCandidate(legal, state, owner, goal)
  if (!candidate) {
    return {
      reason: result.status === 'budget-exhausted' ? 'fallback-budget-exhausted' : result.status === 'invalid-input' ? 'fallback-search-invalid' : 'no-legal-actions',
      goal,
      search,
      diagnostics,
    }
  }
  const reason: GoalPolicyReason = result.status === 'budget-exhausted'
    ? 'fallback-budget-exhausted'
    : result.status === 'invalid-input'
      ? 'fallback-search-invalid'
      : 'fallback-no-route'
  diagnostics.push(`submitted one formal legal fallback candidate after ${result.status}`)
  return { action: candidate.action, candidate, reason, goal, search, diagnostics }
}
