/* eslint-disable @typescript-eslint/no-explicit-any -- RED-59 validates legacy data-authored definitions and action envelopes at runtime. */
import type { PieceInstance } from './piece'
import { getSkillById } from './skill-repository'
import { loadCardById } from './skills'
import { manhattanDistance, traceProjectile } from './spatial'
import type { BattleAction, BattleState } from './turn'

export const TARGET_SELECTION_PROTOCOL_VERSION = 1

export type TargetRef =
  | { type: 'piece'; pieceId: string }
  | { type: 'cell'; x: number; y: number }

export type TargetFilter = 'enemy' | 'ally' | 'all' | 'self'

export interface ProjectileTargetingRequirement {
  requiredCollision: 'piece-before-blocker'
}

export interface TargetConstraint {
  type: 'piece' | 'cell'
  filter: TargetFilter
  range?: number
  ownerPlayerId: string
  sourcePieceId?: string
  sourceActionId?: string
  step?: number
  selectedTargets?: TargetRef[]
  selectedOption?: unknown
  requireWalkable?: boolean
  requireUnoccupied?: boolean
  sameRowOrColumn?: boolean
  excludeSourceCell?: boolean
  distanceMetric?: 'manhattan' | 'chebyshev'
  allowSourceOccupant?: boolean
  projectile?: ProjectileTargetingRequirement
}

export type TargetValidationCode =
  | 'TARGET_TYPE_MISMATCH'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_NOT_ALIVE'
  | 'TARGET_FILTER_MISMATCH'
  | 'TARGET_OUT_OF_RANGE'
  | 'TARGET_NOT_WALKABLE'
  | 'TARGET_OCCUPIED'
  | 'TARGET_SOURCE_MISSING'
  | 'TARGET_SOURCE_CELL_FORBIDDEN'
  | 'TARGET_NOT_ORTHOGONAL'
  | 'TARGET_SOURCE_CONSTRAINT_FAILED'
  | 'TARGET_REFERENCE_MISMATCH'

export interface TargetValidationIssue {
  code: TargetValidationCode
  message: string
}

export type TargetingErrorCode =
  | TargetValidationCode
  | 'ACTION_INVALID'
  | 'ACTION_PLAYER_MISMATCH'
  | 'TARGET_DECLARATION_MISSING'
  | 'OPTION_SELECTION_REQUIRED'
  | 'OPTION_SELECTION_INVALID'
  | 'TARGET_SELECTION_REQUIRED'
  | 'TARGET_SELECTION_STALE'
  | 'TARGET_SELECTION_ID_MISMATCH'
  | 'TARGET_SELECTION_PLAYER_MISMATCH'
  | 'TARGET_SELECTION_ALREADY_RESOLVED'
  | 'PENDING_SELECTION_ACTIVE'
  | 'PENDING_TARGET_SELECTION_NOT_FOUND'
  | 'PENDING_TARGET_CANCEL_FORBIDDEN'

export interface TargetQueryDiagnostics {
  candidatesScanned: number
  reducerExecutions: 0
}

export interface ReadyActionPreparation {
  kind: 'ready'
}

export interface InvalidActionPreparation {
  kind: 'invalid'
  code: TargetingErrorCode
  message?: string
}

export interface NeedTargetActionPreparation {
  kind: 'needTarget'
  protocolVersion: typeof TARGET_SELECTION_PROTOCOL_VERSION
  selectionId: string
  stateRevision: number
  step: number
  min: number
  max: number
  candidates: TargetRef[]
  canCancel: boolean
  targetType: 'piece' | 'cell'
  range?: number
  filter: TargetFilter
  diagnostics: TargetQueryDiagnostics
}

export interface NeedOptionActionPreparation {
  kind: 'needOption'
  protocolVersion: typeof TARGET_SELECTION_PROTOCOL_VERSION
  selectionId: string
  stateRevision: number
  step: number
  min: number
  max: number
  options: Array<{ label: string; value: unknown; description?: string }>
  title: string
  canCancel: boolean
}

export type ActionPreparation =
  | ReadyActionPreparation
  | InvalidActionPreparation
  | NeedTargetActionPreparation
  | NeedOptionActionPreparation

export interface TargetSelectionCredential {
  selectionId?: string
  stateRevision?: number
}

export interface PendingTargetStep {
  type: 'piece' | 'cell' | 'grid'
  filter?: TargetFilter
  range?: number
  distanceMetric?: 'manhattan' | 'chebyshev'
  requireWalkable?: boolean
  requireUnoccupied?: boolean
  allowSourceOccupant?: boolean
  canCancel?: boolean
  sameRowOrColumn?: boolean
  excludeSourceCell?: boolean
  projectile?: ProjectileTargetingRequirement
}

export interface PendingTargetSelectionSession {
  playerId: string
  ownerPlayerId?: string
  title?: string
  targetType: 'piece' | 'cell' | 'grid'
  range?: number
  filter?: string
  effectCode?: string
  payload?: any
  triggerContext?: any
  pendingQueue?: Array<{ ruleId: string; sourceId?: string }>
  source?: {
    type: 'skill' | 'card' | 'rule' | 'pending'
    id: string
    pieceId?: string
  }
  selectionId?: string
  stateRevision?: number
  steps?: PendingTargetStep[]
  step?: number
  min?: number
  max?: number
  selectedTargets?: TargetRef[]
  candidates?: TargetRef[]
  canCancel?: boolean
}

interface TargetSpec {
  kind: 'target'
  type: 'piece' | 'cell'
  filter: TargetFilter
  range?: number
  distanceMetric?: 'manhattan' | 'chebyshev'
  requireWalkable?: boolean
  requireUnoccupied?: boolean
  allowSourceOccupant?: boolean
  allowSourceOccupantOptions?: unknown[]
  sameRowOrColumn?: boolean
  excludeSourceCell?: boolean
  projectile?: ProjectileTargetingRequirement
}

interface OptionSpec {
  kind: 'option'
  title: string
  options: Array<{ label: string; value: unknown; description?: string }>
  canCancel?: boolean
}

type SelectionStepSpec = TargetSpec | OptionSpec

interface TargetSource {
  actionId: string
  ownerPlayerId: string
  sourcePieceId?: string
  steps: SelectionStepSpec[]
}

const EMPTY_DESTINATION_ACTIONS = new Set([
  'blackwidow-lethal-toxin',
  'blink',
  'earthshatter',
  'hashirama-edo-sage-buddha',
  'naruto-shadow-clone',
  'obito-space-time',
  'sasuke-chidori',
  'shadow-step',
])

const WALKABLE_TARGET_ACTIONS = new Set([
  'blackwidow-lethal-toxin',
  'blink',
  'hashirama-edo-sage-buddha',
  'minato-kunai-formula',
  'minato-spiral-barrage',
  'naruto-shadow-clone',
  'obito-space-time',
  'shadow-step',
  'demon-summon-5',
])

const ORTHOGONAL_ACTIONS = new Set([
  'illidan-blade-dash',
  'rocket-punch',
  'sasuke-chidori',
  'sasuke-indra-arrow',
  'shadow-bolt',
])

const SOURCE_CELL_FORBIDDEN_ACTIONS = new Set([
  'illidan-blade-dash',
  'rocket-punch',
  'sasuke-chidori',
  'sasuke-indra-arrow',
  'shadow-bolt',
])

function issue(code: TargetValidationCode, message: string): TargetValidationIssue {
  return { code, message }
}

function normalizeFilter(value: unknown, targetType: unknown): TargetFilter {
  const filter = String(value ?? '').toLowerCase()
  const type = String(targetType ?? '').toLowerCase()
  if (filter === 'enemy' || type === 'enemy' || type === 'enemies') return 'enemy'
  if (filter === 'ally' || filter === 'friendly' || type === 'ally' || type === 'allies') return 'ally'
  if (filter === 'self' || type === 'self') return 'self'
  return 'all'
}

function normalizeTargetType(value: unknown): 'piece' | 'cell' | undefined {
  const type = String(value ?? '').toLowerCase()
  if (['piece', 'character', 'enemy', 'enemies', 'ally', 'allies', 'self'].includes(type)) return 'piece'
  if (['grid', 'cell', 'tile', 'empty'].includes(type)) return 'cell'
  return undefined
}

function parseLiteralProperty(source: string, property: string): string | undefined {
  return source.match(new RegExp(`\\b${property}\\s*:\\s*['\"]([^'\"]+)['\"]`, 'i'))?.[1]
}

function parseNumericProperty(source: string, property: string): number | undefined {
  const raw = source.match(new RegExp(`\\b${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'))?.[1]
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Reads only literal selectTarget declarations. It never evaluates data code.
 * Demo admission coverage is locked by tests so dynamic declarations fail closed.
 */
export function extractTargetSpecsFromCode(code: string, kind: 'skill' | 'card'): TargetSpec[] {
  const specs: TargetSpec[] = []
  const matcher = /selectTarget\s*\(\s*(\{[\s\S]*?\})?\s*\)/g
  for (const match of String(code || '').matchAll(matcher)) {
    const objectSource = match[1] || ''
    const rawType = parseLiteralProperty(objectSource, 'type')
    const type = normalizeTargetType(rawType || 'piece') || 'piece'
    const filter = normalizeFilter(parseLiteralProperty(objectSource, 'filter'), rawType)
    const explicitRange = parseNumericProperty(objectSource, 'range')
    specs.push({
      kind: 'target',
      type,
      filter: filter === 'all' && kind === 'skill' && !objectSource ? 'enemy' : filter,
      range: explicitRange ?? (kind === 'skill' ? 5 : undefined),
    })
  }
  return specs
}

function getDeclaredSteps(definition: any, kind: 'skill' | 'card'): SelectionStepSpec[] | undefined {
  const configuredSteps = definition?.targeting?.steps
  if (Array.isArray(configuredSteps)) {
    const steps: SelectionStepSpec[] = []
    for (const raw of configuredSteps) {
      if (raw?.kind === 'option') {
        if (!Array.isArray(raw.options) || raw.options.length === 0) return undefined
        steps.push({
          kind: 'option',
          title: String(raw.title || '请选择'),
          options: raw.options.map((option: any) => ({
            label: String(option?.label ?? option?.value ?? ''),
            value: option?.value,
            description: option?.description == null ? undefined : String(option.description),
          })),
          canCancel: raw.canCancel !== false,
        })
        continue
      }
      const type = normalizeTargetType(raw?.type)
      if (!type) return undefined
      steps.push({
        kind: 'target',
        type,
        filter: normalizeFilter(raw.filter, raw.type),
        range: typeof raw.range === 'number' ? raw.range : undefined,
        distanceMetric: raw.distanceMetric === 'chebyshev' ? 'chebyshev' : 'manhattan',
        requireWalkable: raw.requireWalkable,
        requireUnoccupied: raw.requireUnoccupied,
        allowSourceOccupant: raw.allowSourceOccupant,
        allowSourceOccupantOptions: Array.isArray(raw.allowSourceOccupantOptions)
          ? raw.allowSourceOccupantOptions
          : undefined,
        sameRowOrColumn: raw.sameRowOrColumn === true,
        excludeSourceCell: raw.excludeSourceCell === true,
        projectile: raw.projectile?.requiredCollision === 'piece-before-blocker'
          ? { requiredCollision: 'piece-before-blocker' }
          : undefined,
      })
    }
    return steps
  }

  if (/\bselectOption\s*\(/.test(String(definition?.code || ''))) return undefined
  const fromCode = extractTargetSpecsFromCode(String(definition?.code || ''), kind)
  if (fromCode.length > 0) return fromCode

  const type = normalizeTargetType(definition?.targetType)
  if (type) {
    const numericRange = typeof definition.range === 'number' ? definition.range : undefined
    return [{
      kind: 'target',
      type,
      filter: normalizeFilter(definition.filter, definition.targetType),
      range: definition.targetType === 'self' ? 0 : numericRange,
    }]
  }
  if (definition?.requiresTarget === true) return undefined
  return []
}

function getDeclaredCardSourcePiece(
  state: BattleState,
  playerId: string,
  card: any,
  definition: any,
): PieceInstance | InvalidActionPreparation | undefined {
  const declaration = definition?.targeting?.source
  if (!declaration) return undefined
  const boundField = typeof declaration.boundInstanceField === 'string'
    ? declaration.boundInstanceField
    : undefined
  const boundId = boundField ? card?.[boundField] : undefined
  const templateId = typeof declaration.templateId === 'string' ? declaration.templateId : undefined
  const source = boundId
    ? state.pieces.find(piece => piece.instanceId === boundId && piece.currentHp > 0)
    : state.pieces.find(piece =>
        piece.currentHp > 0 &&
        normalizePlayerId(piece.ownerPlayerId) === normalizePlayerId(playerId) &&
        (!templateId || piece.templateId === templateId),
      )
  if (!source || normalizePlayerId(source.ownerPlayerId) !== normalizePlayerId(playerId)) {
    return { kind: 'invalid', code: 'ACTION_INVALID', message: 'The declared card target source is missing or defeated' }
  }
  return source
}

function hasStatus(piece: PieceInstance, type: string): boolean {
  return !!piece.statusTags?.some(tag => tag.type === type || tag.id === type)
}

function getSourceAvailabilityIssue(
  state: BattleState,
  sourcePiece: PieceInstance,
  actionId: string,
): InvalidActionPreparation | undefined {
  if (actionId === 'holy-blast' && !hasStatus(sourcePiece, 'divine-shield')) {
    return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Holy Blast requires divine shield' }
  }
  if (actionId === 'sasuke-kagutsuchi' && !Array.isArray(state.extensions?.amaterasuCells)) {
    return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Kagutsuchi requires an Amaterasu cell' }
  }
  if (actionId === 'sasuke-kagutsuchi' && state.extensions!.amaterasuCells.length === 0) {
    return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Kagutsuchi requires an Amaterasu cell' }
  }
  return undefined
}

function normalizePlayerId(playerId: unknown): string {
  return String(playerId ?? '').toLowerCase()
}

function getSource(state: BattleState, action: any): TargetSource | InvalidActionPreparation {
  const playerId = String(action?.playerId ?? '')
  if (!playerId) return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Targeted action requires playerId' }

  if (action.type === 'useBasicSkill' || action.type === 'useChargeSkill') {
    if (state.turn.phase !== 'action' || normalizePlayerId(state.turn.currentPlayerId) !== normalizePlayerId(playerId)) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: 'It is not this player\'s action phase' }
    }
    const sourcePiece = state.pieces.find(piece => piece.instanceId === action.pieceId)
    if (!sourcePiece || sourcePiece.currentHp <= 0) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Source piece was not found or is defeated' }
    }
    if (normalizePlayerId(sourcePiece.ownerPlayerId) !== normalizePlayerId(playerId)) {
      return { kind: 'invalid', code: 'TARGET_SELECTION_PLAYER_MISMATCH', message: 'Source piece belongs to another player' }
    }
    const definition = state.skillsById[action.skillId] || getSkillById(action.skillId)
    if (!definition) return { kind: 'invalid', code: 'ACTION_INVALID', message: `Skill ${action.skillId} not found` }
    const availabilityIssue = getSourceAvailabilityIssue(state, sourcePiece, action.skillId)
    if (availabilityIssue) return availabilityIssue
    const player = state.players.find(meta => normalizePlayerId(meta.playerId) === normalizePlayerId(playerId))
    if (!player || player.actionPoints < (definition.actionPointCost || 0)) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Not enough action points for this skill' }
    }
    if (action.type === 'useChargeSkill' && (definition.chargeCost || 0) > player.chargePoints) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Not enough charge points for this skill' }
    }
    const skillState = sourcePiece.skills?.find(skill => skill.skillId === action.skillId)
    if ((skillState?.currentCooldown || 0) > 0) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: `Skill ${action.skillId} is on cooldown` }
    }
    if (definition.type === 'ultimate' && (skillState?.usesRemaining ?? 0) <= 0) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: `Ultimate skill ${action.skillId} has already been used` }
    }
    const steps = getDeclaredSteps(definition, 'skill')
    if (!steps) {
      return { kind: 'invalid', code: 'TARGET_DECLARATION_MISSING', message: `Skill ${action.skillId} requires a declarative selection contract` }
    }
    return { actionId: action.skillId, ownerPlayerId: playerId, sourcePieceId: sourcePiece.instanceId, steps }
  }

  if (action.type === 'playCard') {
    if (state.turn.phase !== 'action' || normalizePlayerId(state.turn.currentPlayerId) !== normalizePlayerId(playerId)) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: 'It is not this player\'s action phase' }
    }
    const player = state.players.find(meta => normalizePlayerId(meta.playerId) === normalizePlayerId(playerId))
    const card = player?.hand?.find(item => item.instanceId === action.cardInstanceId)
    if (!player || !card) return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Card is not in the player hand' }
    const definition = loadCardById(card.cardId) ?? state.customCards?.[card.cardId]
    if (!definition) return { kind: 'invalid', code: 'ACTION_INVALID', message: `Card ${card.cardId} not found` }
    if (definition.type !== 'active' && definition.type !== 'reactive') {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Passive cards cannot be played manually' }
    }
    const cardCost = (card as any).actionPointCost ?? definition.actionPointCost ?? 0
    if (player.actionPoints < cardCost) {
      return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Not enough action points for this card' }
    }
    const declaredSteps = getDeclaredSteps(definition, 'card')
    if (!declaredSteps) {
      return { kind: 'invalid', code: 'TARGET_DECLARATION_MISSING', message: `Card ${card.cardId} requires a declarative selection contract` }
    }
    const sourcePiece = getDeclaredCardSourcePiece(state, playerId, card, definition)
    if (sourcePiece && 'kind' in sourcePiece) return sourcePiece
    if (card.cardId === 'demon-summon-5' && !state.extensions?.kiljaedanPiece) {
      const alreadySummoned = state.pieces.some(piece =>
        piece.currentHp > 0 && (piece.templateId === 'kiljaedan' || piece.instanceId === 'kiljaedan'),
      )
      if (alreadySummoned) {
        return { kind: 'invalid', code: 'ACTION_INVALID', message: 'Kiljaedan is already on the board' }
      }
    }
    // A player-owned card with no declared piece source has no coordinate
    // origin. Its target type/filter remain authoritative; range is global.
    const steps = sourcePiece
      ? declaredSteps
      : declaredSteps.map(step => step.kind === 'target' ? { ...step, range: undefined } : step)
    return {
      actionId: card.cardId,
      ownerPlayerId: playerId,
      sourcePieceId: sourcePiece?.instanceId,
      steps,
    }
  }

  return { actionId: action.type, ownerPlayerId: playerId, steps: [] }
}

function targetFromFields(
  state: BattleState,
  input: { pieceId?: string; x?: number; y?: number },
): TargetRef | TargetValidationIssue | undefined {
  if (input.pieceId) {
    const piece = state.pieces.find(candidate => candidate.instanceId === input.pieceId)
    if (piece && input.x !== undefined && input.y !== undefined && (piece.x !== input.x || piece.y !== input.y)) {
      return issue('TARGET_REFERENCE_MISMATCH', `Piece ${input.pieceId} is not at (${input.x},${input.y})`)
    }
    return { type: 'piece', pieceId: input.pieceId }
  }
  if (input.x !== undefined && input.y !== undefined) return { type: 'cell', x: input.x, y: input.y }
  return undefined
}

function getSelectedTargets(state: BattleState, action: any): TargetRef[] | TargetValidationIssue {
  const selected: TargetRef[] = []
  const primary = targetFromFields(state, {
    pieceId: action.targetPieceId,
    x: action.targetX,
    y: action.targetY,
  })
  if (primary && 'code' in primary) return primary
  if (primary) selected.push(primary)

  for (const extra of Array.isArray(action.extraTargets) ? action.extraTargets : []) {
    const ref = targetFromFields(state, { pieceId: extra.pieceId, x: extra.x, y: extra.y })
    if (ref && 'code' in ref) return ref
    if (ref) selected.push(ref)
  }
  return selected
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function getTargetingStateRevision(state: Pick<BattleState, 'targetingRevision'>): number {
  const revision = Number(state.targetingRevision)
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

function selectionIdForAction(state: BattleState, action: any, source: TargetSource): string {
  const revision = getTargetingStateRevision(state)
  const identity = [
    TARGET_SELECTION_PROTOCOL_VERSION,
    revision,
    action.type,
    normalizePlayerId(source.ownerPlayerId),
    source.sourcePieceId || '',
    source.actionId,
    action.cardInstanceId || '',
  ].join('|')
  return `sel-${TARGET_SELECTION_PROTOCOL_VERSION}-${revision.toString(36)}-${fnv1a(identity)}`
}

function constraintFor(
  source: TargetSource,
  spec: TargetSpec,
  step: number,
  selectedTargets: TargetRef[],
  selectedOption: unknown,
): TargetConstraint {
  const sourceId = source.actionId
  const constraint: TargetConstraint = {
    ...spec,
    ownerPlayerId: source.ownerPlayerId,
    sourcePieceId: source.sourcePieceId,
    sourceActionId: sourceId,
    step,
    selectedTargets,
    selectedOption,
    requireWalkable: spec.requireWalkable ?? (spec.type === 'cell' && WALKABLE_TARGET_ACTIONS.has(sourceId)),
    requireUnoccupied:
      spec.type === 'cell' && (spec.requireUnoccupied ??
      (EMPTY_DESTINATION_ACTIONS.has(sourceId) || (sourceId === 'demon-summon-5' && step === 1))),
    sameRowOrColumn: spec.sameRowOrColumn ?? ORTHOGONAL_ACTIONS.has(sourceId),
    excludeSourceCell: spec.type === 'cell' && (spec.excludeSourceCell ?? SOURCE_CELL_FORBIDDEN_ACTIONS.has(sourceId)),
    distanceMetric: spec.distanceMetric || 'manhattan',
    allowSourceOccupant: spec.allowSourceOccupant || spec.allowSourceOccupantOptions?.some(
      option => Object.is(option, selectedOption),
    ),
    projectile: spec.projectile,
  }
  return constraint
}

function getSourcePiece(state: BattleState, constraint: TargetConstraint): PieceInstance | undefined {
  return constraint.sourcePieceId
    ? state.pieces.find(piece => piece.instanceId === constraint.sourcePieceId && piece.currentHp > 0)
    : undefined
}

function validateSourceSpecificCell(
  state: BattleState,
  constraint: TargetConstraint,
  ref: Extract<TargetRef, { type: 'cell' }>,
): TargetValidationIssue | undefined {
  const sourceId = constraint.sourceActionId
  if (!sourceId) return undefined

  const sourcePiece = getSourcePiece(state, constraint)

  if (sourceId === 'shadow-bolt' && ref.x === 0) {
    return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Shadow Bolt cannot use the zero-column direction reference')
  }

  if (sourceId === 'illidan-blade-dash' && sourcePiece?.x != null && sourcePiece.y != null) {
    const dx = Math.sign(ref.x - sourcePiece.x)
    const dy = Math.sign(ref.y - sourcePiece.y)
    const nextX = sourcePiece.x + dx
    const nextY = sourcePiece.y + dy
    const tile = state.map.tiles.find(candidate => candidate.x === nextX && candidate.y === nextY)
    const blockingAlly = state.pieces.some(piece =>
      piece.currentHp > 0 &&
      piece.x === nextX &&
      piece.y === nextY &&
      normalizePlayerId(piece.ownerPlayerId) === normalizePlayerId(sourcePiece.ownerPlayerId),
    )
    if (!tile?.props?.walkable || blockingAlly) {
      return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Blade Dash is blocked before it can leave the source cell')
    }
  }

  if (sourceId === 'minato-kunai-formula' && constraint.step === 1) {
    const anchorExists = Array.isArray(state.extensions?.minatoAnchors) && state.extensions!.minatoAnchors.some(
      (anchor: any) => anchor.sourceId === constraint.sourcePieceId && anchor.x === ref.x && anchor.y === ref.y,
    )
    if (!anchorExists) return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Target cell is not a source Flying Raijin anchor')
    const selectedPieceId = constraint.selectedTargets?.[0]?.type === 'piece'
      ? constraint.selectedTargets[0].pieceId
      : undefined
    const occupant = state.pieces.find(piece =>
      piece.currentHp > 0 && piece.x === ref.x && piece.y === ref.y && piece.instanceId !== selectedPieceId,
    )
    if (occupant) return issue('TARGET_OCCUPIED', 'Target cell is occupied')
  }

  if (sourceId === 'minato-spiral-barrage') {
    const anchorExists = Array.isArray(state.extensions?.minatoAnchors) && state.extensions!.minatoAnchors.some(
      (anchor: any) => anchor.sourceId === constraint.sourcePieceId && anchor.x === ref.x && anchor.y === ref.y,
    )
    if (!anchorExists) return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Target cell is not a source Flying Raijin anchor')
    const hasEnemy = sourcePiece && state.pieces.some(piece =>
      piece.currentHp > 0 &&
      piece.ownerPlayerId !== sourcePiece.ownerPlayerId &&
      piece.x != null && piece.y != null &&
      manhattanDistance(piece, ref) <= 3,
    )
    if (!hasEnemy) return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'No living enemy is within three cells of the anchor')
  }

  return undefined
}

function hasOpenCardinalLanding(state: BattleState, target: PieceInstance, sourcePieceId?: string): boolean {
  if (target.x == null || target.y == null) return false
  const targetX = target.x
  const targetY = target.y
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
    const x = targetX + dx
    const y = targetY + dy
    const tile = state.map.tiles.find(candidate => candidate.x === x && candidate.y === y)
    if (!tile?.props?.walkable) return false
    return !state.pieces.some(piece =>
      piece.currentHp > 0 && piece.instanceId !== sourcePieceId && piece.x === x && piece.y === y,
    )
  })
}

function validateSourceSpecificPiece(
  state: BattleState,
  constraint: TargetConstraint,
  target: PieceInstance,
): TargetValidationIssue | undefined {
  const sourceId = constraint.sourceActionId
  const sourcePiece = getSourcePiece(state, constraint)
  if (!sourceId) return undefined

  if (sourceId === 'blackwidow-deadly-gaze' && sourcePiece && manhattanDistance(sourcePiece, target) <= 6) {
    return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Deadly Gaze requires an enemy more than six cells away')
  }
  if (sourceId === 'nano-boost' && target.instanceId === constraint.sourcePieceId) {
    return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Nano Boost cannot target its source')
  }
  if (sourceId === 'arthas-lich-covenant' && hasStatus(target, 'lich-covenant')) {
    return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Target already has Lich Covenant')
  }
  if (sourceId === 'hidan-blood-oath' && hasStatus(target, 'blood-oath')) {
    return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Target already has Blood Oath')
  }
  if (sourceId === 'light-extraction' && !hasStatus(target, 'divine-shield')) {
    return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Target must have divine shield')
  }
  if (sourceId === 'kenshin-ryutsuisen' && !hasOpenCardinalLanding(state, target, constraint.sourcePieceId)) {
    return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Target has no open cardinal landing cell')
  }
  return undefined
}

function validateProjectileRequirement(
  state: BattleState,
  constraint: TargetConstraint,
  ref: Extract<TargetRef, { type: 'cell' }>,
): TargetValidationIssue | undefined {
  if (constraint.projectile?.requiredCollision !== 'piece-before-blocker') return undefined
  const sourcePiece = getSourcePiece(state, constraint)
  if (!sourcePiece || sourcePiece.x == null || sourcePiece.y == null) {
    return issue('TARGET_SOURCE_MISSING', 'A positioned source is required for projectile targeting')
  }
  const direction = {
    x: Math.sign(ref.x - sourcePiece.x),
    y: Math.sign(ref.y - sourcePiece.y),
  }
  if (Math.abs(direction.x) + Math.abs(direction.y) !== 1) {
    return issue('TARGET_NOT_ORTHOGONAL', 'Projectile direction must be cardinal')
  }

  const events = traceProjectile(state, { x: sourcePiece.x, y: sourcePiece.y }, direction, {
    excludePieceId: sourcePiece.instanceId,
    maxDistance: constraint.range,
  })
  for (const event of events) {
    if (event.type === 'piece') return undefined
    if (event.type === 'terrain' && event.blocksProjectile) {
      return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'Blocking terrain appears before any living piece')
    }
  }
  return issue('TARGET_SOURCE_CONSTRAINT_FAILED', 'No living piece is in the selected projectile direction')
}

export function validateTargetRef(
  state: BattleState,
  constraint: TargetConstraint,
  ref: TargetRef,
): TargetValidationIssue | undefined {
  if (constraint.type !== ref.type) return issue('TARGET_TYPE_MISMATCH', `Expected ${constraint.type} target`)
  const sourcePiece = getSourcePiece(state, constraint)
  if (constraint.sourcePieceId && !sourcePiece) return issue('TARGET_SOURCE_MISSING', 'Target source is missing or defeated')

  if (ref.type === 'piece') {
    const target = state.pieces.find(piece => piece.instanceId === ref.pieceId)
    if (!target) return issue('TARGET_NOT_FOUND', `Piece ${ref.pieceId} was not found`)
    if (target.currentHp <= 0 || target.x == null || target.y == null) {
      return issue('TARGET_NOT_ALIVE', `Piece ${ref.pieceId} is not a living board target`)
    }
    const sameOwner = normalizePlayerId(target.ownerPlayerId) === normalizePlayerId(constraint.ownerPlayerId)
    if (constraint.filter === 'enemy' && sameOwner) return issue('TARGET_FILTER_MISMATCH', 'Target must be an enemy')
    if (constraint.filter === 'ally' && !sameOwner) return issue('TARGET_FILTER_MISMATCH', 'Target must be an ally')
    if (constraint.filter === 'self' && target.instanceId !== constraint.sourcePieceId) {
      return issue('TARGET_FILTER_MISMATCH', 'Target must be the source piece')
    }
    if (constraint.range !== undefined) {
      if (!sourcePiece || sourcePiece.x == null || sourcePiece.y == null) {
        return issue('TARGET_SOURCE_MISSING', 'A positioned source is required for ranged targeting')
      }
      const distance = constraint.distanceMetric === 'chebyshev'
        ? Math.max(Math.abs(sourcePiece.x - target.x), Math.abs(sourcePiece.y - target.y))
        : manhattanDistance(sourcePiece, target)
      if (distance > constraint.range) {
        return issue('TARGET_OUT_OF_RANGE', 'Target is out of range')
      }
    }
    if (constraint.sameRowOrColumn && sourcePiece && sourcePiece.x !== target.x && sourcePiece.y !== target.y) {
      return issue('TARGET_NOT_ORTHOGONAL', 'Target must be in the same row or column as the source')
    }
    return validateSourceSpecificPiece(state, constraint, target)
  }

  const tile = state.map.tiles.find(candidate => candidate.x === ref.x && candidate.y === ref.y)
  if (!tile) return issue('TARGET_NOT_FOUND', `Cell (${ref.x},${ref.y}) is outside the board`)
  if (constraint.requireWalkable && tile.props?.walkable !== true) {
    return issue('TARGET_NOT_WALKABLE', `Cell (${ref.x},${ref.y}) is not walkable`)
  }
  if (constraint.range !== undefined) {
    if (!sourcePiece || sourcePiece.x == null || sourcePiece.y == null) {
      return issue('TARGET_SOURCE_MISSING', 'A positioned source is required for ranged targeting')
    }
    const distance = constraint.distanceMetric === 'chebyshev'
      ? Math.max(Math.abs(sourcePiece.x - ref.x), Math.abs(sourcePiece.y - ref.y))
      : manhattanDistance(sourcePiece, ref)
    if (distance > constraint.range) {
      return issue('TARGET_OUT_OF_RANGE', 'Target is out of range')
    }
  }
  if (constraint.sameRowOrColumn && sourcePiece && sourcePiece.x !== ref.x && sourcePiece.y !== ref.y) {
    return issue('TARGET_NOT_ORTHOGONAL', 'Target must be in the same row or column as the source')
  }
  if (constraint.excludeSourceCell && sourcePiece && sourcePiece.x === ref.x && sourcePiece.y === ref.y) {
    return issue('TARGET_SOURCE_CELL_FORBIDDEN', 'The source cell cannot be targeted')
  }
  if (constraint.requireUnoccupied) {
    const occupied = state.pieces.some(piece =>
      piece.currentHp > 0 &&
      piece.x === ref.x &&
      piece.y === ref.y &&
      (!constraint.allowSourceOccupant || piece.instanceId !== constraint.sourcePieceId),
    )
    if (occupied) return issue('TARGET_OCCUPIED', `Cell (${ref.x},${ref.y}) is occupied`)
  }
  const projectileIssue = validateProjectileRequirement(state, constraint, ref)
  if (projectileIssue) return projectileIssue
  return validateSourceSpecificCell(state, constraint, ref)
}

function enumerateCandidates(
  state: BattleState,
  constraint: TargetConstraint,
): { candidates: TargetRef[]; diagnostics: TargetQueryDiagnostics } {
  const refs: TargetRef[] = constraint.type === 'piece'
    ? state.pieces.map(piece => ({ type: 'piece' as const, pieceId: piece.instanceId }))
    : state.map.tiles.map(tile => ({ type: 'cell' as const, x: tile.x, y: tile.y }))
  return {
    candidates: refs.filter(ref => validateTargetRef(state, constraint, ref) === undefined),
    diagnostics: { candidatesScanned: refs.length, reducerExecutions: 0 },
  }
}

function validateCredential(
  state: BattleState,
  action: any,
  source: TargetSource,
): InvalidActionPreparation | undefined {
  const expectedRevision = getTargetingStateRevision(state)
  if (action.stateRevision !== expectedRevision) {
    return { kind: 'invalid', code: 'TARGET_SELECTION_STALE', message: `Target selection revision ${action.stateRevision} does not match ${expectedRevision}` }
  }
  const expectedId = selectionIdForAction(state, action, source)
  if (action.selectionId !== expectedId) {
    return { kind: 'invalid', code: 'TARGET_SELECTION_ID_MISMATCH', message: 'Target selection ID does not match this action and state' }
  }
  return undefined
}

export function prepareAction(state: BattleState, draftCommand: BattleAction | any): ActionPreparation {
  if (state.pendingOptionSelection && draftCommand.type !== 'pendingOptionSelect' && draftCommand.type !== 'cancelPendingSelection') {
    return { kind: 'invalid', code: 'PENDING_SELECTION_ACTIVE', message: 'An option selection is pending' }
  }
  if (state.pendingTargetSelection && draftCommand.type !== 'pendingTargetSelect' && draftCommand.type !== 'cancelPendingSelection') {
    return { kind: 'invalid', code: 'PENDING_SELECTION_ACTIVE', message: 'A target selection is pending' }
  }
  if (!['useBasicSkill', 'useChargeSkill', 'playCard'].includes(draftCommand.type)) return { kind: 'ready' }

  const source = getSource(state, draftCommand)
  if ('kind' in source) return source
  if (source.steps.length === 0) return { kind: 'ready' }

  const selected = getSelectedTargets(state, draftCommand)
  if (!Array.isArray(selected)) return { kind: 'invalid', code: selected.code, message: selected.message }
  const targetStepCount = source.steps.filter(step => step.kind === 'target').length
  if (selected.length > targetStepCount) {
    return { kind: 'invalid', code: 'TARGET_TYPE_MISMATCH', message: 'Too many targets were submitted' }
  }

  const hasSelectedOption = draftCommand.selectedOption !== undefined
  if (selected.length > 0 || hasSelectedOption) {
    const credentialIssue = validateCredential(state, draftCommand, source)
    if (credentialIssue) return credentialIssue
  }

  let selectedTargetIndex = 0
  for (let stepIndex = 0; stepIndex < source.steps.length; stepIndex += 1) {
    const step = source.steps[stepIndex]
    if (step.kind === 'option') {
      if (!hasSelectedOption) {
        return {
          kind: 'needOption',
          protocolVersion: TARGET_SELECTION_PROTOCOL_VERSION,
          selectionId: selectionIdForAction(state, draftCommand, source),
          stateRevision: getTargetingStateRevision(state),
          step: stepIndex,
          min: 1,
          max: 1,
          options: step.options,
          title: step.title,
          canCancel: step.canCancel !== false,
        }
      }
      if (!step.options.some(option => Object.is(option.value, draftCommand.selectedOption))) {
        return { kind: 'invalid', code: 'OPTION_SELECTION_INVALID', message: 'Selected option is not declared for this action' }
      }
      continue
    }

    const submittedTarget = selected[selectedTargetIndex]
    const constraint = constraintFor(source, step, stepIndex, selected.slice(0, selectedTargetIndex), draftCommand.selectedOption)
    if (!submittedTarget) {
      const { candidates, diagnostics } = enumerateCandidates(state, constraint)
      return {
        kind: 'needTarget',
        protocolVersion: TARGET_SELECTION_PROTOCOL_VERSION,
        selectionId: selectionIdForAction(state, draftCommand, source),
        stateRevision: getTargetingStateRevision(state),
        step: stepIndex,
        min: 1,
        max: 1,
        candidates,
        canCancel: true,
        targetType: step.type,
        range: step.range,
        filter: step.filter,
        diagnostics,
      }
    }
    const validation = validateTargetRef(state, constraint, submittedTarget)
    if (validation) return { kind: 'invalid', code: validation.code, message: validation.message }
    selectedTargetIndex += 1
  }
  return { kind: 'ready' }
}

export class TargetingRuleError extends Error {
  readonly code: TargetingErrorCode
  readonly preparation?: NeedTargetActionPreparation | NeedOptionActionPreparation
  readonly needsTargetSelection?: true
  readonly needsOptionSelection?: true
  readonly targetType?: 'piece' | 'cell'
  readonly range?: number
  readonly filter?: TargetFilter
  readonly targetIndex?: number
  readonly title?: string
  readonly options?: Array<{ label: string; value: unknown; description?: string }>

  constructor(result: Exclude<ActionPreparation, ReadyActionPreparation>) {
    super(result.kind === 'invalid'
      ? (result.message || result.code)
      : result.kind === 'needOption' ? 'Option selection is required' : 'Target selection is required')
    this.name = 'TargetingRuleError'
    this.code = result.kind === 'invalid'
      ? result.code
      : result.kind === 'needOption' ? 'OPTION_SELECTION_REQUIRED' : 'TARGET_SELECTION_REQUIRED'
    if (result.kind === 'needTarget') {
      this.preparation = result
      this.needsTargetSelection = true
      this.targetType = result.targetType
      this.range = result.range
      this.filter = result.filter
      this.targetIndex = result.step
    }
    if (result.kind === 'needOption') {
      this.preparation = result
      this.needsOptionSelection = true
      this.title = result.title
      this.options = result.options
      this.targetIndex = result.step
    }
  }
}

export function assertActionTargetingReady(state: BattleState, action: BattleAction | any): void {
  const prepared = prepareAction(state, action)
  if (prepared.kind !== 'ready') throw new TargetingRuleError(prepared)
}

export function assertActionPlayer(expectedPlayerId: string | null | undefined, action: any): void {
  // System-only actions such as beginPhase intentionally have no playerId.
  if (!action?.playerId) return
  if (!expectedPlayerId) {
    throw new TargetingRuleError({
      kind: 'invalid',
      code: 'ACTION_PLAYER_MISMATCH',
      message: 'A player-scoped action requires an authenticated player',
    })
  }
  if (normalizePlayerId(expectedPlayerId) !== normalizePlayerId(action.playerId)) {
    throw new TargetingRuleError({
      kind: 'invalid',
      code: 'ACTION_PLAYER_MISMATCH',
      message: 'Authenticated player does not match the submitted action player',
    })
  }
}

function pendingSourcePieceId(pending: PendingTargetSelectionSession): string | undefined {
  return pending.source?.pieceId ||
    pending.triggerContext?.sourcePiece?.instanceId ||
    pending.triggerContext?.sourcePieceId ||
    pending.payload?.sourcePieceId
}

function pendingSourceId(pending: PendingTargetSelectionSession): string {
  return pending.source?.id ||
    pending.triggerContext?.pendingRuleId ||
    pending.triggerContext?.ruleId ||
    pending.payload?.skillId ||
    'pending-target'
}

function pendingConstraint(pending: PendingTargetSelectionSession): TargetConstraint {
  const activeStep = pending.steps?.[pending.step || 0]
  const declaredType = activeStep?.type || pending.targetType
  const type = declaredType === 'piece' ? 'piece' : 'cell'
  return {
    type,
    filter: normalizeFilter(activeStep?.filter ?? pending.filter, declaredType),
    range: activeStep?.range ?? pending.range,
    ownerPlayerId: pending.ownerPlayerId || pending.playerId,
    sourcePieceId: pendingSourcePieceId(pending),
    sourceActionId: pendingSourceId(pending),
    step: pending.step || 0,
    selectedTargets: pending.selectedTargets || [],
    requireWalkable: activeStep?.requireWalkable ?? (type === 'cell'),
    requireUnoccupied: activeStep?.requireUnoccupied,
    distanceMetric: activeStep?.distanceMetric || 'manhattan',
    allowSourceOccupant: activeStep?.allowSourceOccupant,
    sameRowOrColumn: activeStep?.sameRowOrColumn,
    excludeSourceCell: type === 'cell' && activeStep?.excludeSourceCell,
    projectile: activeStep?.projectile,
  }
}

function pendingSelectionId(
  revision: number,
  pending: PendingTargetSelectionSession,
): string {
  const identity = [
    TARGET_SELECTION_PROTOCOL_VERSION,
    revision,
    normalizePlayerId(pending.ownerPlayerId || pending.playerId),
    pendingSourceId(pending),
    pendingSourcePieceId(pending) || '',
    pending.step || 0,
  ].join('|')
  return `pending-${TARGET_SELECTION_PROTOCOL_VERSION}-${revision.toString(36)}-${fnv1a(identity)}`
}

export function finalizePendingTargetSession(
  state: BattleState,
  pending: PendingTargetSelectionSession,
  revision: number,
): PendingTargetSelectionSession {
  const sourcePieceId = pendingSourcePieceId(pending)
  const activeStep = pending.steps?.[pending.step || 0]
  const normalized: PendingTargetSelectionSession = {
    ...pending,
    ownerPlayerId: pending.ownerPlayerId || pending.playerId,
    source: pending.source || {
      type: pending.triggerContext ? 'rule' : 'pending',
      id: pendingSourceId(pending),
      pieceId: sourcePieceId,
    },
    // A global chooser has no coordinate origin. Preserve historical global
    // selectors by omitting source-relative range when no source piece exists.
    targetType: activeStep?.type || pending.targetType,
    filter: activeStep?.filter ?? pending.filter,
    range: sourcePieceId ? (activeStep?.range ?? pending.range) : undefined,
    step: pending.step || 0,
    min: pending.min ?? 1,
    max: pending.max ?? 1,
    selectedTargets: pending.selectedTargets || [],
    canCancel: activeStep?.canCancel ?? pending.canCancel !== false,
    stateRevision: revision,
  }
  normalized.selectionId = pendingSelectionId(revision, normalized)
  normalized.candidates = enumerateCandidates(state, pendingConstraint(normalized)).candidates
  return normalized
}

/** Advance a pending session without running its final effect. */
export function advancePendingTargetSession(
  pending: PendingTargetSelectionSession,
  target: TargetRef,
): PendingTargetSelectionSession | undefined {
  const selectedTargets = [...(pending.selectedTargets || []), target]
  const nextStep = (pending.step || 0) + 1
  if (!pending.steps || nextStep >= pending.steps.length) return undefined
  const activeStep = pending.steps[nextStep]
  return {
    ...pending,
    targetType: activeStep.type,
    filter: activeStep.filter,
    range: activeStep.range,
    step: nextStep,
    selectedTargets,
    min: 1,
    max: 1,
    canCancel: activeStep.canCancel ?? pending.canCancel,
    selectionId: undefined,
    stateRevision: undefined,
    candidates: undefined,
  }
}

export function stampTargetingRevision(previous: BattleState, next: BattleState): BattleState {
  const revision = getTargetingStateRevision(previous) + 1
  const stamped = { ...next, targetingRevision: revision }
  if (stamped.pendingTargetSelection) {
    stamped.pendingTargetSelection = finalizePendingTargetSession(stamped, stamped.pendingTargetSelection, revision)
  }
  return stamped
}

export function validatePendingTargetSubmission(
  state: BattleState,
  action: {
    playerId: string
    selectionId?: string
    stateRevision?: number
    targetPieceId?: string
    targetX?: number
    targetY?: number
  },
): TargetRef {
  const pending = state.pendingTargetSelection
  if (!pending) {
    throw new TargetingRuleError({
      kind: 'invalid',
      code: action.selectionId ? 'TARGET_SELECTION_ALREADY_RESOLVED' : 'PENDING_TARGET_SELECTION_NOT_FOUND',
      message: action.selectionId ? 'Target selection was already resolved' : 'No target selection is pending',
    })
  }
  if (normalizePlayerId(pending.ownerPlayerId || pending.playerId) !== normalizePlayerId(action.playerId)) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'TARGET_SELECTION_PLAYER_MISMATCH', message: 'Target selection belongs to another player' })
  }
  const currentRevision = getTargetingStateRevision(state)
  if (action.stateRevision !== currentRevision || pending.stateRevision !== currentRevision) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'TARGET_SELECTION_STALE', message: 'Target selection state revision is stale' })
  }
  if (!pending.selectionId || action.selectionId !== pending.selectionId) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'TARGET_SELECTION_ID_MISMATCH', message: 'Target selection ID does not match the pending session' })
  }
  const target = targetFromFields(state, {
    pieceId: action.targetPieceId,
    x: action.targetX,
    y: action.targetY,
  })
  if (!target) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'TARGET_NOT_FOUND', message: 'Target reference is missing' })
  }
  if ('code' in target) {
    throw new TargetingRuleError({ kind: 'invalid', code: target.code, message: target.message })
  }
  const validation = validateTargetRef(state, pendingConstraint(pending), target)
  if (validation) {
    throw new TargetingRuleError({ kind: 'invalid', code: validation.code, message: validation.message })
  }
  return target
}

export function assertPendingTargetCancellation(
  state: BattleState,
  action: { playerId: string; selectionId?: string; stateRevision?: number },
): void {
  const pending = state.pendingTargetSelection
  if (!pending) {
    throw new TargetingRuleError({
      kind: 'invalid',
      code: action.selectionId ? 'TARGET_SELECTION_ALREADY_RESOLVED' : 'PENDING_TARGET_SELECTION_NOT_FOUND',
      message: action.selectionId ? 'Target selection was already resolved' : 'No target selection is pending',
    })
  }
  if (pending.canCancel === false) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'PENDING_TARGET_CANCEL_FORBIDDEN', message: 'This target selection cannot be cancelled' })
  }
  if (normalizePlayerId(pending.ownerPlayerId || pending.playerId) !== normalizePlayerId(action.playerId)) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'TARGET_SELECTION_PLAYER_MISMATCH', message: 'Target selection belongs to another player' })
  }
  if (action.stateRevision !== getTargetingStateRevision(state) || pending.stateRevision !== getTargetingStateRevision(state)) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'TARGET_SELECTION_STALE', message: 'Cancellation target selection revision is stale' })
  }
  if (action.selectionId !== pending.selectionId) {
    throw new TargetingRuleError({ kind: 'invalid', code: 'TARGET_SELECTION_ID_MISMATCH', message: 'Cancellation does not match the pending target session' })
  }
}

export function targetRefKey(ref: TargetRef): string {
  return ref.type === 'piece' ? `piece:${ref.pieceId}` : `cell:${ref.x},${ref.y}`
}
