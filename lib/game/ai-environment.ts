import {
  compactBattleTraceForAuthority,
  getBattleRootSeed,
  getOrCreateDebugMetadata,
  hashBattleState,
  hashStable,
  readDebugMetadata,
  stableJson,
} from './battle-trace'
import { runBattleActionIsolated } from './battle-runner'
import { getSkillById } from './skill-repository'
import { loadCardById } from './skills'
import { getLegalNormalMoveTargetsForPlayer } from './spatial'
import {
  prepareAction,
  targetRefKey,
  validatePendingTargetSubmissions,
  type ActionPreparation,
  type TargetRef,
} from './targeting'
import type { BattleAction, BattleState } from './turn'
import {
  AI_ENVIRONMENT_PROTOCOL_VERSION,
  type AIEnvironment,
  type AIActionResourceCost,
  type AIEnvironmentCapabilities,
  type AIEnvironmentError,
  type AIObservation,
  type AIObservationScope,
  type AIObservedStatusTag,
  type AISimulationContext,
  type AIStateDiffEntry,
  type AITransitionTrace,
  type CandidateAction,
  type CandidateActionKind,
  type TransitionResult,
} from './ai-types'

const MAX_SELECTION_STEPS = 16

const CANDIDATE_KIND_RANK: Record<CandidateActionKind, number> = {
  'pending-option': 0,
  'pending-target': 1,
  'cancel-selection': 2,
  'deployment-choice': 10,
  'deployment-lock': 11,
  'phase-advance': 20,
  move: 30,
  'basic-skill': 40,
  'charge-skill': 41,
  card: 50,
  'end-turn': 90,
}

export const AI_ENVIRONMENT_CAPABILITIES: AIEnvironmentCapabilities = {
  protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
  supportedActionTypes: [
    'deploymentChoice',
    'deploymentLock',
    'beginPhase',
    'move',
    'useBasicSkill',
    'useChargeSkill',
    'playCard',
    'pendingOptionSelect',
    'pendingTargetSelect',
    'cancelPendingSelection',
    'endTurn',
  ],
  unsupportedActionTypes: [
    { type: 'deploymentTimeout', reason: 'Authority clock command; not a player decision.' },
    { type: 'grantChargePoints', reason: 'Administrative/debug command; not Demo player admission.' },
    { type: 'surrender', reason: 'Match-control command; excluded from tactical candidate search.' },
  ],
}

export class AIEnvironmentContractError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AIEnvironmentContractError'
    this.code = code
  }
}

function cloneSerializable<T>(value: T): T {
  const serialized = JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'function' ? undefined : candidate,
  )
  return serialized === undefined ? value : JSON.parse(serialized) as T
}

function samePlayer(left: unknown, right: unknown): boolean {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase()
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function observedStatusTag(tag: unknown): AIObservedStatusTag | undefined {
  if (!tag || typeof tag !== 'object') return undefined
  const source = tag as Record<string, unknown>
  if (source.visible === false || typeof source.id !== 'string' || typeof source.type !== 'string') {
    return undefined
  }
  const projected: AIObservedStatusTag = { id: source.id, type: source.type }
  const stringKeys = ['name'] as const
  const numberKeys = [
    'currentDuration', 'remainingDuration', 'currentUses', 'intensity', 'stacks',
    'value', 'extraValue', 'centerX', 'centerY', 'damage',
  ] as const
  for (const key of stringKeys) if (typeof source[key] === 'string') projected[key] = source[key]
  for (const key of numberKeys) if (typeof source[key] === 'number') projected[key] = source[key]
  if (typeof source.visible === 'boolean') projected.visible = source.visible
  return projected
}

function observedPiece(piece: BattleState['pieces'][number]) {
  return {
    instanceId: piece.instanceId,
    isCore: piece.isCore,
    templateId: piece.templateId,
    name: piece.name,
    ownerPlayerId: piece.ownerPlayerId,
    faction: piece.faction,
    currentHp: piece.currentHp,
    maxHp: piece.maxHp,
    attack: piece.attack,
    defense: piece.defense,
    x: piece.x,
    y: piece.y,
    moveRange: piece.moveRange,
    skills: cloneSerializable(piece.skills || []),
    displaySkills: cloneSerializable(piece.displaySkills),
    buffs: cloneSerializable(piece.buffs || []),
    debuffs: cloneSerializable(piece.debuffs || []),
    shield: piece.shield,
    statusTags: (piece.statusTags || []).map(observedStatusTag).filter(tag => tag !== undefined),
  }
}

export function observeBattleForAI(state: BattleState, playerId: string): AIObservation {
  if (!state.players.some(player => samePlayer(player.playerId, playerId))) {
    throw new AIEnvironmentContractError('AI_ENV_PLAYER_NOT_FOUND', `Player ${playerId} is not in this battle`)
  }

  const pendingOption = state.pendingOptionSelection
  const pendingTarget = state.pendingTargetSelection
  return {
    protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
    playerId,
    stateRevision: Number.isSafeInteger(state.targetingRevision) ? state.targetingRevision! : 0,
    map: cloneSerializable(state.map),
    pieces: state.pieces.map(observedPiece),
    graveyard: state.graveyard.map(observedPiece),
    players: state.players.map(player => ({
      playerId: player.playerId,
      name: player.name,
      mangekyoDeathCount: player.mangekyoDeathCount,
      chargePoints: player.chargePoints,
      actionPoints: player.actionPoints,
      maxActionPoints: player.maxActionPoints,
      handCount: player.hand.length,
      hand: samePlayer(player.playerId, playerId) ? cloneSerializable(player.hand) : undefined,
      discardPile: [...player.discardPile],
      statusTags: (player.statusTags || []).map(observedStatusTag).filter(tag => tag !== undefined),
      skills: cloneSerializable(player.skills || []),
    })),
    turn: cloneSerializable(state.turn),
    terminalResult: cloneSerializable(state.terminalResult),
    deployment: state.deployment ? {
      status: state.deployment.status,
      playerIds: [...state.deployment.playerIds],
      locks: Object.fromEntries(state.deployment.playerIds.map(id => [id, {
        locked: state.deployment?.locks[id]?.locked === true,
      }])),
      deadlineAt: state.deployment.deadlineAt,
      revision: state.deployment.revision,
      initialPositions: cloneSerializable(state.deployment.initialPositions),
      finalPositions: state.deployment.status === 'complete'
        ? cloneSerializable(state.deployment.finalPositions)
        : undefined,
    } : undefined,
    pendingOptionSelection: pendingOption && samePlayer(pendingOption.playerId, playerId) ? {
      playerId: pendingOption.playerId,
      title: pendingOption.title,
      options: cloneSerializable(pendingOption.options),
      selectionId: pendingOption.selectionId,
      stateRevision: pendingOption.stateRevision,
      canCancel: pendingOption.canCancel !== false,
      selectionMode: pendingOption.selectionMode,
      presentation: pendingOption.presentation,
      minSelections: pendingOption.minSelections,
      maxSelections: pendingOption.maxSelections,
    } : undefined,
    pendingTargetSelection: pendingTarget && samePlayer(
      pendingTarget.ownerPlayerId || pendingTarget.playerId,
      playerId,
    ) ? {
      playerId: pendingTarget.ownerPlayerId || pendingTarget.playerId,
      title: pendingTarget.title,
      targetType: pendingTarget.targetType,
      selectionId: pendingTarget.selectionId,
      stateRevision: pendingTarget.stateRevision,
      step: pendingTarget.step || 0,
      candidates: cloneSerializable(pendingTarget.candidates || []),
      selectedTargets: cloneSerializable(pendingTarget.selectedTargets || []),
      canCancel: pendingTarget.canCancel !== false,
      selectionMode: pendingTarget.selectionMode,
      minSelections: pendingTarget.minSelections,
      maxSelections: pendingTarget.maxSelections,
    } : undefined,
  }
}

function appendTarget(action: BattleAction, ref: TargetRef): BattleAction {
  const next = { ...action } as BattleAction & {
    targetPieceId?: string
    targetX?: number
    targetY?: number
    extraTargets?: Array<{ pieceId?: string; x?: number; y?: number }>
  }
  const hasPrimary = !!next.targetPieceId || (next.targetX !== undefined && next.targetY !== undefined)
  if (!hasPrimary) {
    if (ref.type === 'piece') next.targetPieceId = ref.pieceId
    else {
      next.targetX = ref.x
      next.targetY = ref.y
    }
    return next
  }
  next.extraTargets = [...(next.extraTargets || []), ref.type === 'piece'
    ? { pieceId: ref.pieceId }
    : { x: ref.x, y: ref.y }]
  return next
}

function completePreparedAction(
  state: BattleState,
  action: BattleAction,
  depth = 0,
): BattleAction[] {
  if (depth >= MAX_SELECTION_STEPS) {
    throw new AIEnvironmentContractError(
      'AI_ENV_SELECTION_DEPTH_EXCEEDED',
      `Action selection exceeded ${MAX_SELECTION_STEPS} steps`,
    )
  }
  const prepared: ActionPreparation = prepareAction(state, action)
  if (prepared.kind === 'invalid') return []
  if (prepared.kind === 'ready') return [action]
  if (prepared.kind === 'needOption') {
    return [...prepared.options]
      .sort((left, right) => compareStableText(stableJson(left.value), stableJson(right.value)))
      .flatMap(option => completePreparedAction(state, {
        ...action,
        selectionId: prepared.selectionId,
        stateRevision: prepared.stateRevision,
        selectedOption: option.value,
      } as BattleAction, depth + 1))
  }
  return [...prepared.candidates]
    .sort((left, right) => compareStableText(targetRefKey(left), targetRefKey(right)))
    .flatMap(target => completePreparedAction(state, appendTarget({
      ...action,
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    } as BattleAction, target), depth + 1))
}

function candidate(kind: CandidateActionKind, action: BattleAction): CandidateAction {
  return {
    protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
    id: `candidate-${hashStable({ protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION, action }).slice(0, 24)}`,
    kind,
    action,
  }
}

function sortCandidates(actions: CandidateAction[]): CandidateAction[] {
  return actions.sort((left, right) => {
    const rank = CANDIDATE_KIND_RANK[left.kind] - CANDIDATE_KIND_RANK[right.kind]
    return rank || compareStableText(stableJson(left.action), stableJson(right.action))
  })
}

function pendingCandidates(state: BattleState, playerId: string): CandidateAction[] | undefined {
  const pendingOption = state.pendingOptionSelection
  if (pendingOption) {
    if (!samePlayer(pendingOption.playerId, playerId)) return []
    const values = pendingOption.options.map(option => (
      option && typeof option === 'object' && 'value' in option
        ? (option as { value: unknown }).value
        : option
    ))
      .sort((left, right) => compareStableText(stableJson(left), stableJson(right)))
    const selections: unknown[] = pendingOption.selectionMode === 'multi'
      ? (() => {
          const minSelections = Number.isSafeInteger(pendingOption.minSelections)
            ? Math.max(0, pendingOption.minSelections!)
            : 1
          const maxSelections = Math.min(
            values.length,
            Number.isSafeInteger(pendingOption.maxSelections)
              ? Math.max(minSelections, pendingOption.maxSelections!)
              : values.length,
          )
          if (minSelections > maxSelections) return []
          const legal: unknown[] = minSelections === 0 ? [[]] : []
          if (minSelections <= 1) legal.push(...values.map(value => [value]))
          for (let count = Math.max(2, minSelections); count <= maxSelections; count += 1) {
            legal.push(values.slice(0, count))
          }
          return legal
        })()
      : values
    const options = selections.map(selectedOption => candidate('pending-option', {
        type: 'pendingOptionSelect',
        playerId,
        selectedOption,
        selectionId: pendingOption.selectionId,
        stateRevision: pendingOption.stateRevision,
      }))
    if (pendingOption.canCancel !== false) {
      options.push(candidate('cancel-selection', {
        type: 'cancelPendingSelection',
        playerId,
        selectionId: pendingOption.selectionId,
        stateRevision: pendingOption.stateRevision,
      }))
    }
    return sortCandidates(options)
  }

  const pendingTarget = state.pendingTargetSelection
  if (!pendingTarget) return undefined
  if (!samePlayer(pendingTarget.ownerPlayerId || pendingTarget.playerId, playerId)) return []
  const targetRefs = [...(pendingTarget.candidates || [])]
    .sort((left, right) => compareStableText(targetRefKey(left), targetRefKey(right)))
  const selections: TargetRef[][] = pendingTarget.selectionMode === 'multi'
    ? (() => {
        const minSelections = Number.isSafeInteger(pendingTarget.minSelections)
          ? Math.max(0, pendingTarget.minSelections!)
          : 1
        const maxSelections = Math.min(
          targetRefs.length,
          Number.isSafeInteger(pendingTarget.maxSelections)
            ? Math.max(minSelections, pendingTarget.maxSelections!)
            : targetRefs.length,
        )
        if (minSelections > maxSelections) return []
        const legal: TargetRef[][] = []
        if (minSelections <= 1) legal.push(...targetRefs.map(target => [target]))
        for (let count = Math.max(2, minSelections); count <= maxSelections; count += 1) {
          legal.push(targetRefs.slice(0, count))
        }
        return legal
      })()
    : targetRefs.map(target => [target])
  const candidates = selections.map(selection => {
      const action = selection.reduce((draft, target) => appendTarget(draft, target), {
        type: 'pendingTargetSelect',
        playerId,
        selectionId: pendingTarget.selectionId,
        stateRevision: pendingTarget.stateRevision,
      } as BattleAction)
      validatePendingTargetSubmissions(state, action as Extract<BattleAction, { type: 'pendingTargetSelect' }>)
      return candidate('pending-target', action)
    })
  if (pendingTarget.canCancel !== false) {
    candidates.push(candidate('cancel-selection', {
      type: 'cancelPendingSelection',
      playerId,
      selectionId: pendingTarget.selectionId,
      stateRevision: pendingTarget.stateRevision,
    }))
  }
  return sortCandidates(candidates)
}

export function listLegalAIActions(state: BattleState, playerId: string): CandidateAction[] {
  // Some terminal settlement snapshots omit the runtime skill cache. Restore only
  // the empty repository-fallback shape for read-only candidate preparation.
  state = state.skillsById ? state : { ...state, skillsById: {} }

  if (state.terminalResult) return []
  const player = state.players.find(meta => samePlayer(meta.playerId, playerId))
  if (!player) return []

  const pending = pendingCandidates(state, playerId)
  if (pending) return pending

  if (state.deployment?.status === 'awaiting-locks') {
    const stableId = state.deployment.playerIds.find(id => samePlayer(id, playerId))
    if (!stableId || state.deployment.locks[stableId]?.locked) return []
    const choices = state.pieces
      .filter(piece => samePlayer(piece.ownerPlayerId, playerId) && piece.isCore === true && piece.currentHp > 0 && piece.x != null && piece.y != null)
      .sort((left, right) => compareStableText(left.instanceId, right.instanceId))
      .map(piece => candidate('deployment-choice', {
        type: 'deploymentChoice', playerId: stableId, pieceId: piece.instanceId,
      }))
    choices.unshift(candidate('deployment-choice', {
      type: 'deploymentChoice', playerId: stableId, pieceId: null,
    }))
    choices.push(candidate('deployment-lock', { type: 'deploymentLock', playerId: stableId }))
    return sortCandidates(choices)
  }

  if (!samePlayer(state.turn.currentPlayerId, playerId)) return []
  if (state.turn.phase === 'start' || state.turn.phase === 'end') {
    return [candidate('phase-advance', { type: 'beginPhase' })]
  }

  const actions: CandidateAction[] = []
  const pieces = state.pieces
    .filter(piece => samePlayer(piece.ownerPlayerId, playerId) && piece.currentHp > 0)
    .sort((left, right) => compareStableText(left.instanceId, right.instanceId))

  for (const piece of pieces) {
    for (const target of getLegalNormalMoveTargetsForPlayer(state, playerId, piece.instanceId)) {
      actions.push(candidate('move', {
        type: 'move', playerId, pieceId: piece.instanceId, toX: target.x, toY: target.y,
      }))
    }
    for (const skill of [...(piece.skills || [])].sort((left, right) => compareStableText(left.skillId, right.skillId))) {
      const definition = state.skillsById?.[skill.skillId] || getSkillById(skill.skillId)
      if (!definition || definition.kind !== 'active') continue
      const kind: CandidateActionKind = (definition?.chargeCost || 0) > 0 ? 'charge-skill' : 'basic-skill'
      const type = kind === 'charge-skill' ? 'useChargeSkill' : 'useBasicSkill'
      for (const action of completePreparedAction(state, {
        type, playerId, pieceId: piece.instanceId, skillId: skill.skillId,
      })) actions.push(candidate(kind, action))
    }
  }

  for (const card of [...player.hand].sort((left, right) => compareStableText(left.instanceId, right.instanceId))) {
    for (const action of completePreparedAction(state, {
      type: 'playCard', playerId, cardInstanceId: card.instanceId,
    })) actions.push(candidate('card', action))
  }

  actions.push(candidate('end-turn', { type: 'endTurn', playerId }))
  return sortCandidates(actions)
}

const ZERO_RESOURCE_COST: AIActionResourceCost = Object.freeze({ actionPoints: 0, chargePoints: 0 })

function nonNegativeCost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Reads only the formal resource costs used by the authority runner. */
export function getAIActionResourceCost(
  state: BattleState,
  playerId: string,
  input: CandidateAction | BattleAction,
): AIActionResourceCost {
  const action = 'action' in input ? input.action : input
  if (action.type === 'move') return { actionPoints: 1, chargePoints: 0 }
  if (action.type === 'useBasicSkill' || action.type === 'useChargeSkill') {
    const definition = state.skillsById?.[action.skillId] || getSkillById(action.skillId)
    if (!definition) return { ...ZERO_RESOURCE_COST }
    return {
      actionPoints: nonNegativeCost(definition.actionPointCost),
      chargePoints: action.type === 'useChargeSkill' ? nonNegativeCost(definition.chargeCost) : 0,
    }
  }
  if (action.type === 'playCard') {
    const player = state.players.find(item => samePlayer(item.playerId, playerId))
    const card = player?.hand.find(item => item.instanceId === action.cardInstanceId)
    const definition = card ? loadCardById(card.cardId) ?? state.customCards?.[card.cardId] : undefined
    return {
      actionPoints: nonNegativeCost(card?.actionPointCost ?? definition?.actionPointCost),
      chargePoints: 0,
    }
  }
  return { ...ZERO_RESOURCE_COST }
}

function traceState(state: BattleState): Record<string, unknown> {
  const cloned = cloneSerializable(state) as unknown as Record<string, unknown>
  delete cloned.skillsById
  const extensions = cloned.extensions as Record<string, unknown> | undefined
  if (extensions) {
    delete extensions.debugBattle
    if (Object.keys(extensions).length === 0) delete cloned.extensions
  }
  return cloned
}

function stateDiff(before: unknown, after: unknown, path = '$'): AIStateDiffEntry[] {
  if (stableJson(before) === stableJson(after)) return []
  if (
    before === null || after === null ||
    typeof before !== 'object' || typeof after !== 'object' ||
    Array.isArray(before) !== Array.isArray(after)
  ) return [{ path, before, after }]

  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: AIStateDiffEntry[] = []
    const length = Math.max(before.length, after.length)
    for (let index = 0; index < length; index += 1) {
      changes.push(...stateDiff(before[index], after[index], `${path}[${index}]`))
    }
    return changes
  }

  const beforeRecord = before as Record<string, unknown>
  const afterRecord = after as Record<string, unknown>
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()
  return keys.flatMap(key => stateDiff(beforeRecord[key], afterRecord[key], `${path}.${key}`))
}

function transitionTrace(before: BattleState, after: BattleState, actionTrace?: AITransitionTrace['actionTrace']): AITransitionTrace {
  const actionLogStart = before.actions?.length || 0
  return {
    actionTrace,
    actionLog: cloneSerializable((after.actions || []).slice(actionLogStart)),
    stateChanges: stateDiff(traceState(before), traceState(after)),
  }
}

const PUBLICLY_BLOCKABLE_ACTION_TYPES = new Set<BattleAction['type']>([
  'move', 'useBasicSkill', 'useChargeSkill', 'playCard',
])

function publiclyBlockedTransition(before: BattleState, after: BattleState, action: BattleAction) {
  if (!PUBLICLY_BLOCKABLE_ACTION_TYPES.has(action.type)) return false
  const playerId = 'playerId' in action && typeof action.playerId === 'string'
    ? action.playerId
    : before.turn.currentPlayerId
  if (!playerId) return false
  const withoutTargetingRevision = (candidate: BattleState) => {
    const observation = observeBattleForAI(candidate, playerId)
    return { ...observation, stateRevision: 0 }
  }
  return stableJson(withoutTargetingRevision(before)) === stableJson(withoutTargetingRevision(after))
}

function stableError(error: unknown): AIEnvironmentError {
  const value = error as {
    code?: unknown
    name?: unknown
    message?: unknown
    determinism?: AIEnvironmentError['determinism']
  }
  return {
    code: typeof value?.code === 'string' && value.code
      ? value.code
      : value?.name === 'BattleRuleError' ? 'BATTLE_RULE_REJECTED' : 'AI_ENV_EXECUTION_ERROR',
    name: typeof value?.name === 'string' ? value.name : 'Error',
    message: typeof value?.message === 'string' ? value.message : String(error),
    determinism: value?.determinism,
  }
}

function evaluationSimulationState(state: BattleState): BattleState {
  const metadata = readDebugMetadata(state)
  const extensions = { ...(state.extensions ?? {}) }
  extensions.debugBattle = {
    appliedActionIds: [...metadata.appliedActionIds],
    actionLog: [...metadata.actionLog],
    commandLog: [...metadata.commandLog],
    authority: metadata.authority ? {
      ...metadata.authority,
      runtimeCursors: { ...metadata.authority.runtimeCursors },
    } : undefined,
  }
  const compacted = compactBattleTraceForAuthority({ ...state, extensions })
  const compactedMetadata = getOrCreateDebugMetadata(compacted)
  const actionCount = compactedMetadata.authority?.actionCount ?? metadata.actionLog.length
  const retainedInitializationTraces = [...compactedMetadata.actionLog]
  compactedMetadata.actionLog = Array.from({ length: actionCount }, (_, index) => (
    retainedInitializationTraces[index] ?? {}
  ))
  // Authority compaction normally clears duplicate-command history because
  // persisted commands are independently versioned. Speculative evaluation
  // must retain it so explicit action IDs behave exactly like the full path.
  // The rule reducer also uses actionLog.length when stamping terminal results,
  // so lightweight placeholders preserve the authoritative action index without
  // retaining the expensive historical trace payloads.
  compactedMetadata.appliedActionIds = [...metadata.appliedActionIds]
  return compacted
}

export function simulateAITransition(
  state: BattleState,
  input: CandidateAction | BattleAction,
  context: AISimulationContext = {},
): TransitionResult {
  const action = 'action' in input ? input.action : input
  const rootSeed = context.rootSeed ?? getBattleRootSeed(state)
  const evaluationMode = context.simulationMode === 'evaluation'
  const simulationState = evaluationMode
    ? evaluationSimulationState(state)
    : state
  let preStateHash = evaluationMode ? undefined : hashBattleState(simulationState)
  try {
    if (rootSeed === undefined) {
      throw new AIEnvironmentContractError(
        'AI_ENV_ROOT_SEED_REQUIRED',
        'A root seed or initialized battle trace is required for deterministic simulation',
      )
    }
    const result = runBattleActionIsolated(simulationState, action, { rootSeed })
    preStateHash ??= result.trace?.preStateHash ?? hashBattleState(simulationState)
    const trace: AITransitionTrace = evaluationMode
      ? { actionTrace: result.trace, actionLog: [], stateChanges: [] }
      : transitionTrace(simulationState, result.state, result.trace)
    if (publiclyBlockedTransition(simulationState, result.state, action)) trace.blocked = true
    const transitionHash = hashStable(evaluationMode ? {
      protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
      mode: 'evaluation',
      accepted: true,
      action,
      preStateHash,
      stateHash: result.stateHash,
      blocked: trace.blocked === true,
    } : {
      protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
      accepted: true,
      action,
      preStateHash,
      stateHash: result.stateHash,
      trace,
    })
    return {
      protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
      accepted: true,
      state: result.state,
      stateHash: result.stateHash,
      transitionHash,
      trace,
    }
  } catch (caught) {
    const error = stableError(caught)
    preStateHash ??= hashBattleState(simulationState)
    const trace = evaluationMode
      ? { actionLog: [], stateChanges: [] }
      : transitionTrace(simulationState, simulationState)
    const transitionHash = hashStable({
      protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
      ...(evaluationMode ? { mode: 'evaluation' } : {}),
      accepted: false,
      action,
      preStateHash,
      error,
      trace,
    })
    return {
      protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
      accepted: false,
      state: simulationState,
      stateHash: preStateHash,
      transitionHash,
      error,
      trace,
    }
  }
}

export function isAITerminal(state: BattleState): boolean {
  return state.terminalResult !== undefined
}

export function aiStateKey(state: BattleState, scope: AIObservationScope): string {
  return scope.kind === 'player'
    ? hashStable(observeBattleForAI(state, scope.playerId))
    : hashBattleState(state)
}

export const aiEnvironmentV1: AIEnvironment = Object.freeze({
  protocolVersion: AI_ENVIRONMENT_PROTOCOL_VERSION,
  capabilities: AI_ENVIRONMENT_CAPABILITIES,
  observe: observeBattleForAI,
  listLegalActions: listLegalAIActions,
  simulate: simulateAITransition,
  isTerminal: isAITerminal,
  stateKey: aiStateKey,
})
