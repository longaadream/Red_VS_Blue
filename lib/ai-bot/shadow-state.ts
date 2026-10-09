import { getAllPieces, getPieceById } from '../game/piece-repository'
import { loadAllSkillsById, loadRuleById } from '../game/skills'
import type { BoardMap, TileProperties } from '../game/map'
import type { PieceInstance, PieceSkill, PieceStatusTag } from '../game/piece'
import type { BattleState } from '../game/turn'
import type { TargetRef } from '../game/targeting'

/**
 * The cloud bot receives a player projection, not an authoritative state.  A
 * projection is therefore copied through this adapter before it is handed to
 * the formal environment.  Keep this module deliberately boring: adding a
 * field here is a privacy and determinism decision, not a convenience copy.
 */

export interface ShadowStateResult {
  state: BattleState
  diagnostics: string[]
}

export type CreateShadowStateResult = ShadowStateResult

const samePlayer = (left: unknown, right: unknown): boolean => (
  String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
)

const finiteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
)

const safeInteger = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
)

const nonEmptyString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 ? value : undefined
)

const jsonClone = <T>(value: T): T | undefined => {
  try {
    const serialized = JSON.stringify(value, (_key, candidate) => (
      typeof candidate === 'function' || typeof candidate === 'symbol' || typeof candidate === 'bigint'
        ? undefined
        : candidate
    ))
    return serialized === undefined ? undefined : JSON.parse(serialized) as T
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function publicStatusTag(
  value: unknown,
  allowHidden: boolean,
  diagnostics?: Set<string>,
): PieceStatusTag | undefined {
  const source = asRecord(value)
  if (!source || typeof source.id !== 'string' || typeof source.type !== 'string') return undefined
  if (source.relatedRules !== undefined || source.statusOrigins !== undefined || source.statusAliases !== undefined
    || source.stacking !== undefined || source.lifetime !== undefined || source.appliedTurn !== undefined
    || source.expiresAfterTurn !== undefined || source.lastDurationTickTurn !== undefined) {
    diagnostics?.add('dropped dynamic status rule metadata')
  }
  if (!allowHidden && source.visible === false) return undefined

  const projected: Record<string, unknown> = {
    id: source.id,
    type: source.type,
  }
  const strings = ['name'] as const
  const numbers = [
    'currentDuration', 'remainingDuration', 'currentUses', 'intensity', 'stacks',
    'value', 'extraValue', 'centerX', 'centerY', 'damage',
  ] as const
  for (const key of strings) if (typeof source[key] === 'string') projected[key] = source[key]
  for (const key of numbers) if (finiteNumber(source[key]) !== undefined) projected[key] = source[key]
  if (typeof source.visible === 'boolean') projected.visible = source.visible
  return projected as PieceStatusTag
}

function publicStatuses(value: unknown, owner: boolean, diagnostics?: Set<string>): PieceStatusTag[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => publicStatusTag(entry, owner, diagnostics))
    .filter((entry): entry is PieceStatusTag => entry !== undefined)
}

function publicSkill(value: unknown): PieceSkill | undefined {
  const source = asRecord(value)
  const skillId = nonEmptyString(source?.skillId)
  if (!skillId) return undefined
  const projected: Record<string, unknown> = { skillId }
  for (const key of ['level', 'currentCooldown', 'currentCharges', 'usesRemaining'] as const) {
    const number = finiteNumber(source?.[key])
    if (number !== undefined) projected[key] = number
  }
  if (typeof source?.unlocked === 'boolean') projected.unlocked = source.unlocked
  return projected as unknown as PieceSkill
}

function publicSkills(value: unknown): PieceSkill[] {
  if (!Array.isArray(value)) return []
  return value
    .map(publicSkill)
    .filter((entry): entry is PieceSkill => entry !== undefined)
}

function publicModifier(value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value)
  if (!source) return undefined
  const effect = source.effect === 'damage' || source.effect === 'heal' || source.effect === 'statusIntensity'
    ? source.effect
    : undefined
  const operation = source.operation === 'add' || source.operation === 'multiply'
    ? source.operation
    : undefined
  const number = finiteNumber(source.value)
  if (!effect || !operation || number === undefined) return undefined
  return {
    effect,
    operation,
    value: number,
    ...(typeof source.statusType === 'string' ? { statusType: source.statusType } : {}),
  }
}

function publicCard(
  value: unknown,
  playerId: string,
  diagnostics: Set<string>,
): BattleState['players'][number]['hand'][number] | undefined {
  const source = asRecord(value)
  if (!source) return undefined
  const cardId = nonEmptyString(source.cardId)
  const instanceId = nonEmptyString(source.instanceId)
  const ownerPlayerId = nonEmptyString(source.ownerPlayerId) ?? playerId
  if (!cardId || !instanceId) return undefined

  const projected: Record<string, unknown> = {
    cardId,
    instanceId,
    ownerPlayerId,
  }
  for (const key of ['name', 'description', 'icon', 'type'] as const) {
    if (typeof source[key] === 'string') projected[key] = source[key]
  }
  for (const key of ['actionPointCost', 'baseActionPointCost', 'temporaryCostReductionTurnNumber'] as const) {
    const number = finiteNumber(source[key])
    if (number !== undefined) projected[key] = number
  }
  const presentation = asRecord(source.presentation)
  if (presentation) {
    const clean = Object.fromEntries(
      (['variant', 'badge', 'description'] as const)
        .filter(key => typeof presentation[key] === 'string')
        .map(key => [key, presentation[key]]),
    )
    if (Object.keys(clean).length > 0) projected.presentation = clean
  }
  if (Array.isArray(source.effectModifiers)) {
    const modifiers = source.effectModifiers.map(publicModifier).filter(Boolean)
    if (modifiers.length > 0) projected.effectModifiers = modifiers
  }
  // contentState is intentionally omitted.  It is a server continuation
  // channel even when the card belongs to the player requesting the snapshot.
  if (source.contentState !== undefined) diagnostics.add('dropped private card content state')
  return projected as BattleState['players'][number]['hand'][number]
}

function publicPiece(
  value: unknown,
  viewerPlayerId: string,
  diagnostics: Set<string>,
): PieceInstance | undefined {
  const source = asRecord(value)
  if (!source) return undefined
  const instanceId = nonEmptyString(source.instanceId)
  const templateId = nonEmptyString(source.templateId)
  const name = nonEmptyString(source.name)
  const ownerPlayerId = nonEmptyString(source.ownerPlayerId)
  const faction = nonEmptyString(source.faction)
  const allowedFactions = new Set(['red', 'blue', 'neutral', 'good', 'evil', 'light', 'dark'])
  if (!instanceId || !templateId || !name || !ownerPlayerId || !faction || !allowedFactions.has(faction)) return undefined

  const currentHp = finiteNumber(source.currentHp) ?? 0
  const maxHp = finiteNumber(source.maxHp) ?? Math.max(0, currentHp)
  const attack = finiteNumber(source.attack) ?? 0
  const defense = finiteNumber(source.defense) ?? 0
  const moveRange = finiteNumber(source.moveRange) ?? 0
  const x = source.x === null ? null : finiteNumber(source.x)
  const y = source.y === null ? null : finiteNumber(source.y)
  const owner = samePlayer(ownerPlayerId, viewerPlayerId)
  const skills = publicSkills(source.skills)

  const projected: PieceInstance = {
    instanceId,
    templateId,
    name,
    ownerPlayerId,
    faction: faction as PieceInstance['faction'],
    currentHp,
    maxHp,
    attack,
    defense,
    moveRange,
    x: x === undefined ? null : x,
    y: y === undefined ? null : y,
    skills,
    buffs: [],
    debuffs: [],
    ruleTags: [],
    statusTags: publicStatuses(source.statusTags, owner, diagnostics),
    rules: [],
  }
  if (typeof source.isCore === 'boolean') projected.isCore = source.isCore
  if (finiteNumber(source.shield) !== undefined) projected.shield = source.shield as number
  const displaySkills = publicSkills(source.displaySkills)
  if (displaySkills.length > 0) projected.displaySkills = displaySkills

  const buffs = Array.isArray(source.buffs) ? source.buffs : []
  projected.buffs = buffs.flatMap(entry => {
    const row = asRecord(entry)
    const type = nonEmptyString(row?.type)
    const valueNumber = finiteNumber(row?.value)
    const duration = finiteNumber(row?.duration)
    if (!type || valueNumber === undefined || duration === undefined) return []
    return [{ type, value: valueNumber, duration, source: '' }]
  })
  const debuffs = Array.isArray(source.debuffs) ? source.debuffs : []
  projected.debuffs = debuffs.flatMap(entry => {
    const row = asRecord(entry)
    const type = nonEmptyString(row?.type)
    const valueNumber = finiteNumber(row?.value)
    const duration = finiteNumber(row?.duration)
    if (!type || valueNumber === undefined || duration === undefined) return []
    return [{ type, value: valueNumber, duration, source: '' }]
  })

  if (source.rules !== undefined || source.ruleTags !== undefined) {
    diagnostics.add('dropped network piece rules; only local static rules are restored')
  }
  if (source.initialDefinition !== undefined || source.limitedSkillUses !== undefined || source.spentPassives !== undefined) {
    diagnostics.add('dropped private piece runtime metadata')
  }
  return projected
}

function publicTileProperties(value: unknown): TileProperties {
  const source = asRecord(value)
  const tileType = source?.type
  const allowedTypes = new Set(['floor', 'wall', 'spawn', 'cover', 'hole', 'lava', 'spring', 'chargepad'])
  const projected: TileProperties = {
    walkable: source?.walkable === true,
    bulletPassable: source?.bulletPassable === true,
    type: allowedTypes.has(tileType as string) ? tileType as TileProperties['type'] : 'floor',
  }
  for (const key of ['height', 'damagePerTurn', 'healPerTurn', 'chargePerTurn'] as const) {
    const number = finiteNumber(source?.[key])
    if (number !== undefined) projected[key] = number
  }
  for (const key of ['shadowStepTarget', 'bullet'] as const) {
    if (typeof source?.[key] === 'boolean') projected[key] = source[key] as boolean
  }
  return projected
}

function publicMap(value: unknown): BoardMap {
  const source = asRecord(value)
  const tiles = Array.isArray(source?.tiles) ? source.tiles.flatMap(entry => {
    const tile = asRecord(entry)
    const id = nonEmptyString(tile?.id)
    const x = finiteNumber(tile?.x)
    const y = finiteNumber(tile?.y)
    if (!id || x === undefined || y === undefined) return []
    return [{ id, x, y, props: publicTileProperties(tile?.props) }]
  }) : []
  return {
    id: nonEmptyString(source?.id) ?? 'shadow-map',
    name: nonEmptyString(source?.name) ?? 'Shadow map',
    width: finiteNumber(source?.width) ?? 0,
    height: finiteNumber(source?.height) ?? 0,
    tiles,
  }
}

function publicPositions(value: unknown): Record<string, { x: number; y: number }> {
  const source = asRecord(value)
  if (!source) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([id, raw]) => {
    const position = asRecord(raw)
    const x = finiteNumber(position?.x)
    const y = finiteNumber(position?.y)
    return x === undefined || y === undefined ? [] : [[id, { x, y }]]
  }))
}

function publicTarget(value: unknown): TargetRef | undefined {
  const source = asRecord(value)
  if (!source || (source.type !== 'piece' && source.type !== 'cell')) return undefined
  if (source.type === 'piece' && typeof source.pieceId === 'string' && source.pieceId.length > 0) {
    return { type: 'piece', pieceId: source.pieceId }
  }
  const x = finiteNumber(source.x)
  const y = finiteNumber(source.y)
  return source.type === 'cell' && x !== undefined && y !== undefined
    ? { type: 'cell', x, y }
    : undefined
}

/**
 * Keep option values useful to the authority while rejecting executable or
 * continuation-shaped data.  Values are deliberately a small public atom
 * vocabulary; malformed entries are omitted and diagnosed by the adapter.
 */
const PUBLIC_ATOM_KEYS = new Set([
  'id', 'value', 'type', 'templateId', 'pieceId', 'cardId', 'skillId',
  'x', 'y', 'label', 'name', 'description', 'amount', 'count', 'targetId',
  'optionId', 'mode', 'kind', 'index',
])

function publicAtom(value: unknown, diagnostics: Set<string>, depth = 0): unknown {
  if (depth > 4) {
    diagnostics.add('dropped deeply nested pending atom')
    return undefined
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    const result = value.map(entry => publicAtom(entry, diagnostics, depth + 1))
    return result.every(entry => entry !== undefined) ? result : undefined
  }
  const source = asRecord(value)
  if (!source) {
    diagnostics.add('dropped non-JSON pending atom')
    return undefined
  }
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (!PUBLIC_ATOM_KEYS.has(key)) {
      diagnostics.add('dropped private or unknown pending atom field')
      return undefined
    }
    const projected = publicAtom(entry, diagnostics, depth + 1)
    if (projected === undefined) return undefined
    result[key] = projected
  }
  return result
}

function publicPendingOption(
  value: unknown,
  playerId: string,
  diagnostics: Set<string>,
): BattleState['pendingOptionSelection'] | undefined {
  const source = asRecord(value)
  if (!source) return undefined
  const owner = nonEmptyString(source?.playerId)
  if (!owner) return undefined
  const options: unknown[] = []
  if (samePlayer(owner, playerId) && Array.isArray(source?.options)) {
    for (const raw of source.options) {
      const option = asRecord(raw)
      if (!option) {
        const atom = publicAtom(raw, diagnostics)
        if (atom !== undefined) options.push(atom)
        continue
      }
      const rawValue = 'value' in option ? option.value : option
      const atom = publicAtom(rawValue, diagnostics)
      if (atom === undefined) continue
      const projected: Record<string, unknown> = { value: atom }
      for (const key of ['label', 'description'] as const) {
        if (typeof option[key] === 'string') projected[key] = option[key]
      }
      options.push(projected)
    }
  } else if (Array.isArray(source?.options) && source.options.length > 0) {
    diagnostics.add('dropped another player pending option atoms')
  }

  const projected: Record<string, unknown> = {
    playerId: owner,
    title: nonEmptyString(source.title) ?? 'Pending selection',
    options,
    canCancel: source.canCancel !== false,
  }
  const selectionId = nonEmptyString(source.selectionId)
  const stateRevision = safeInteger(source.stateRevision)
  if (selectionId) projected.selectionId = selectionId
  if (stateRevision !== undefined && stateRevision >= 0) projected.stateRevision = stateRevision
  if (samePlayer(owner, playerId)) {
    if (source.selectionMode === 'single' || source.selectionMode === 'multi') projected.selectionMode = source.selectionMode
    if (source.presentation === 'picker' || source.presentation === 'hand') projected.presentation = source.presentation
    for (const key of ['minSelections', 'maxSelections'] as const) {
      const number = safeInteger(source[key])
      if (number !== undefined && number >= 0) projected[key] = number
    }
  }
  if (source.pendingAction !== undefined || source.continuationContext !== undefined || source.triggerContext !== undefined
    || source.pendingQueue !== undefined || source.pendingReactiveCards !== undefined || source.transaction !== undefined) {
    diagnostics.add('dropped pending option continuation and runtime payload')
  }
  return projected as unknown as BattleState['pendingOptionSelection']
}

function publicPendingTarget(
  value: unknown,
  playerId: string,
  diagnostics: Set<string>,
): BattleState['pendingTargetSelection'] | undefined {
  const source = asRecord(value)
  if (!source) return undefined
  const owner = nonEmptyString(source?.ownerPlayerId) ?? nonEmptyString(source?.playerId)
  const player = nonEmptyString(source?.playerId) ?? owner
  if (!owner || !player) return undefined
  const mine = samePlayer(owner, playerId)
  const candidates = mine && Array.isArray(source?.candidates)
    ? source.candidates.map(publicTarget).filter((entry): entry is TargetRef => entry !== undefined)
    : []
  const selectedTargets = mine && Array.isArray(source?.selectedTargets)
    ? source.selectedTargets.map(publicTarget).filter((entry): entry is TargetRef => entry !== undefined)
    : []
  if (!mine && Array.isArray(source?.candidates) && source.candidates.length > 0) {
    diagnostics.add('dropped another player pending target atoms')
  }
  const projected: Record<string, unknown> = {
    playerId: player,
    ownerPlayerId: owner,
    targetType: source.targetType === 'piece' || source.targetType === 'cell' || source.targetType === 'grid'
      ? source.targetType
      : 'piece',
    step: safeInteger(source.step) ?? 0,
    selectedTargets,
    candidates,
    canCancel: source.canCancel !== false,
  }
  if (mine) {
    for (const key of ['title', 'filter'] as const) if (typeof source[key] === 'string') projected[key] = source[key]
    for (const key of ['range', 'min', 'max', 'minSelections', 'maxSelections'] as const) {
      const number = finiteNumber(source[key])
      if (number !== undefined && number >= 0) projected[key] = number
    }
  }
  const selectionId = nonEmptyString(source.selectionId)
  const stateRevision = safeInteger(source.stateRevision)
  if (selectionId) projected.selectionId = selectionId
  if (stateRevision !== undefined && stateRevision >= 0) projected.stateRevision = stateRevision
  if (mine && (source.selectionMode === 'single' || source.selectionMode === 'multi')) projected.selectionMode = source.selectionMode
  if (mine && Array.isArray(source.rangeCells)) {
    projected.rangeCells = source.rangeCells.flatMap(entry => {
      const cell = asRecord(entry)
      const x = finiteNumber(cell?.x)
      const y = finiteNumber(cell?.y)
      return x === undefined || y === undefined ? [] : [{ x, y }]
    })
  }
  if (source.effectCode !== undefined || source.payload !== undefined || source.triggerContext !== undefined
    || source.continuationContext !== undefined || source.pendingQueue !== undefined || source.pendingAction !== undefined
    || source.steps !== undefined || source.candidateState !== undefined) {
    diagnostics.add('dropped pending target continuation and runtime payload')
  }
  return projected as unknown as BattleState['pendingTargetSelection']
}

function staticRulesForPiece(
  templateId: string,
  sourceRules: Set<string>,
): Array<NonNullable<ReturnType<typeof loadRuleById>>> {
  const template = getPieceById(templateId)
  const ids = new Set<string>([
    ...(template?.rules ?? []),
    ...sourceRules,
  ])
  return [...ids].sort().flatMap(ruleId => {
    try {
      const rule = loadRuleById(ruleId)
      if (!rule) return []
      return [rule]
    } catch {
      return []
    }
  })
}

function staticPieceStats(): Record<string, BattleState['pieceStatsByTemplateId'][string]> {
  return Object.fromEntries(getAllPieces().flatMap(template => {
    const stats = template.stats
    if (!stats || typeof stats !== 'object') return []
    return [[template.id, {
      maxHp: finiteNumber(stats.maxHp) ?? 0,
      attack: finiteNumber(stats.attack) ?? 0,
      defense: finiteNumber(stats.defense) ?? 0,
      moveRange: finiteNumber(stats.moveRange) ?? 0,
      ...(finiteNumber(stats.speed) !== undefined ? { speed: stats.speed } : {}),
      ...(finiteNumber(stats.criticalRate) !== undefined ? { criticalRate: stats.criticalRate } : {}),
    }]]
  }))
}

function staticSkills(): BattleState['skillsById'] {
  const skills = loadAllSkillsById()
  return Object.fromEntries(Object.entries(skills).flatMap(([id, definition]) => {
    const cloned = jsonClone(definition)
    return cloned === undefined ? [] : [[id, cloned]]
  })) as BattleState['skillsById']
}

function publicPlayer(
  value: unknown,
  playerId: string,
  visiblePieces: PieceInstance[],
  diagnostics: Set<string>,
): BattleState['players'][number] | undefined {
  const source = asRecord(value)
  if (!source) return undefined
  const owner = nonEmptyString(source?.playerId)
  if (!owner) return undefined
  const mine = samePlayer(owner, playerId)
  const hand = mine && Array.isArray(source?.hand)
    ? source.hand.map(card => publicCard(card, owner, diagnostics)).filter((card): card is BattleState['players'][number]['hand'][number] => card !== undefined)
    : []
  if (!mine && Array.isArray(source?.hand) && source.hand.length > 0) diagnostics.add('dropped opponent hand contents')
  const projected: Record<string, unknown> = {
    playerId: owner,
    chargePoints: finiteNumber(source.chargePoints) ?? 0,
    actionPoints: finiteNumber(source.actionPoints) ?? 0,
    maxActionPoints: finiteNumber(source.maxActionPoints) ?? 0,
    hand,
    discardPile: Array.isArray(source.discardPile)
      ? source.discardPile.filter((entry): entry is string => typeof entry === 'string')
      : [],
    skills: Array.isArray(source.skills) ? publicSkills(source.skills) : [],
  }
  if (typeof source.name === 'string') projected.name = source.name
  if (source.teamId === 'red' || source.teamId === 'blue') projected.teamId = source.teamId
  projected.statusTags = publicStatuses(source.statusTags, mine, diagnostics)

  const staticRuleIds = new Set<string>()
  for (const piece of visiblePieces.filter(piece => samePlayer(piece.ownerPlayerId, owner))) {
    for (const ruleId of getPieceById(piece.templateId)?.playerRules ?? []) staticRuleIds.add(ruleId)
  }
  projected.rules = [...staticRuleIds].sort().flatMap(ruleId => {
    try {
      const rule = loadRuleById(ruleId)
      return rule ? [rule] : []
    } catch {
      return []
    }
  })
  if (source.rules !== undefined || source.statusEffects !== undefined || source.perTurnFlags !== undefined) {
    diagnostics.add('dropped player runtime rules and private flags')
  }
  return projected as unknown as BattleState['players'][number]
}

function publicTerminal(value: unknown): BattleState['terminalResult'] | undefined {
  const source = asRecord(value)
  if (!source || source.status !== 'finished') return undefined
  const projected: Record<string, unknown> = { status: 'finished' }
  for (const key of ['winnerTeamId', 'winnerPlayerId', 'loserPlayerId', 'reason'] as const) {
    if (typeof source[key] === 'string' || source[key] === null) projected[key] = source[key]
  }
  for (const key of ['winnerPlayerIds', 'loserPlayerIds'] as const) {
    if (Array.isArray(source[key])) projected[key] = source[key].filter((entry): entry is string => typeof entry === 'string')
  }
  const settled = asRecord(source.settledAt)
  if (settled) {
    projected.settledAt = {
      actionIndex: safeInteger(settled.actionIndex) ?? 0,
      actionType: typeof settled.actionType === 'string' ? settled.actionType : 'unknown',
      actorPlayerId: typeof settled.actorPlayerId === 'string' || settled.actorPlayerId === null ? settled.actorPlayerId : null,
      turnNumber: safeInteger(settled.turnNumber) ?? 0,
      phase: settled.phase === 'start' || settled.phase === 'action' || settled.phase === 'end' ? settled.phase : 'action',
      completedRound: safeInteger(settled.completedRound) ?? 0,
    }
  }
  return projected as unknown as BattleState['terminalResult']
}

function publicDeployment(
  value: unknown,
  viewerPlayerId: string,
  diagnostics: Set<string>,
): BattleState['deployment'] | undefined {
  const source = asRecord(value)
  const status = source?.status === 'awaiting-locks'
    || source?.status === 'awaiting-reserve-deploy'
    || source?.status === 'turn-ready'
    || source?.status === 'complete'
    ? source.status
    : undefined
  if (!source || !status) {
    if (source) diagnostics.add('dropped invalid deployment descriptor status')
    return undefined
  }
  const playerIds = Array.isArray(source.playerIds)
    ? source.playerIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  const projected: Record<string, unknown> = {
    status,
    playerIds,
    choices: {},
    locks: {},
    startedAt: finiteNumber(source.startedAt) ?? 0,
    deadlineAt: finiteNumber(source.deadlineAt) ?? 0,
    revision: safeInteger(source.revision) ?? 0,
    initialPositions: publicPositions(source.initialPositions),
  }
  if (source.mode === 'legacy-reroll-v1' || source.mode === 'progressive-reserve-v1') projected.mode = source.mode
  if (asRecord(source.choices) && Object.keys(asRecord(source.choices) ?? {}).length > 0) {
    diagnostics.add('dropped legacy deployment choices; only public locks are retained')
  }
  const locks = asRecord(source.locks)
  if (locks) {
    projected.locks = Object.fromEntries(Object.entries(locks).map(([id, raw]) => [id, { locked: asRecord(raw)?.locked === true }]))
  }
  if (status === 'complete' && source.finalPositions !== undefined) projected.finalPositions = publicPositions(source.finalPositions)
  else if (source.finalPositions !== undefined) diagnostics.add('dropped incomplete deployment final positions')
  if (source.reserveCounts && typeof source.reserveCounts === 'object') {
    projected.reserveCounts = Object.fromEntries(Object.entries(asRecord(source.reserveCounts) ?? {}).flatMap(([id, raw]) => {
      const number = safeInteger(raw)
      return number === undefined || number < 0 ? [] : [[id, number]]
    }))
  }
  if (safeInteger(source.offerTurnNumber) !== undefined) projected.offerTurnNumber = source.offerTurnNumber
  if (typeof source.activePlayerId === 'string') projected.activePlayerId = source.activePlayerId
  const ownsOffer = typeof source.activePlayerId === 'string' && samePlayer(source.activePlayerId, viewerPlayerId)
  if (Array.isArray(source.offerPieces) && ownsOffer) {
    projected.offerPieces = source.offerPieces.flatMap(raw => {
      const offer = asRecord(raw)
      const instanceId = nonEmptyString(offer?.instanceId)
      const templateId = nonEmptyString(offer?.templateId)
      const name = nonEmptyString(offer?.name)
      return !instanceId || !templateId || !name ? [] : [{ instanceId, templateId, name }]
    })
  } else if (Array.isArray(source.offerPieces) && source.offerPieces.length > 0) {
    diagnostics.add('dropped another player deployment offers')
  }
  if (Array.isArray(source.legalPositions) && ownsOffer) {
    projected.legalPositions = source.legalPositions.flatMap(raw => {
      const position = asRecord(raw)
      const x = finiteNumber(position?.x)
      const y = finiteNumber(position?.y)
      return x === undefined || y === undefined ? [] : [{ x, y }]
    })
  } else if (Array.isArray(source.legalPositions) && source.legalPositions.length > 0) {
    diagnostics.add('dropped another player deployment legal cells')
  }
  // reserves and offerPieceIds are server-private even when a generic public
  // projection happened to retain them. The policy consumes offerPieces only.
  return projected as unknown as BattleState['deployment']
}

function publicTurn(value: unknown): BattleState['turn'] {
  const source = asRecord(value)
  const phase = source?.phase === 'start' || source?.phase === 'action' || source?.phase === 'end'
    ? source.phase
    : 'start'
  const actions = asRecord(source?.actions)
  const refreshedAtTurn = safeInteger(source?.refreshedAtTurn)
  return {
    currentPlayerId: nonEmptyString(source?.currentPlayerId) ?? '',
    turnNumber: safeInteger(source?.turnNumber) ?? 0,
    phase,
    actions: {
      hasMoved: actions?.hasMoved === true,
      hasUsedBasicSkill: actions?.hasUsedBasicSkill === true,
      hasUsedChargeSkill: actions?.hasUsedChargeSkill === true,
    },
    ...(refreshedAtTurn !== undefined ? { refreshedAtTurn } : {}),
  }
}

/**
 * Project a network snapshot into the fields accepted by the formal local
 * environment.  Every nested object above is constructed field by field.
 */
export function createShadowState(snapshotState: BattleState, playerId: string): ShadowStateResult {
  const diagnostics = new Set<string>()
  const source = asRecord(snapshotState) ?? {}
  const sourcePlayers = Array.isArray(source.players) ? source.players : []
  const visiblePieces = Array.isArray(source.pieces)
    ? source.pieces.map(piece => publicPiece(piece, playerId, diagnostics)).filter((piece): piece is PieceInstance => piece !== undefined)
    : []
  const graveyard = Array.isArray(source.graveyard)
    ? source.graveyard.map(piece => publicPiece(piece, playerId, diagnostics)).filter((piece): piece is PieceInstance => piece !== undefined)
    : []

  for (const piece of visiblePieces) {
    const ids = new Set<string>(getPieceById(piece.templateId)?.rules ?? [])
    piece.rules = staticRulesForPiece(piece.templateId, ids)
  }

  const players = sourcePlayers
    .map(value => publicPlayer(value, playerId, visiblePieces, diagnostics))
    .filter((value): value is BattleState['players'][number] => value !== undefined)
  const canonicalPlayerId = players.find(player => samePlayer(player.playerId, playerId))?.playerId ?? playerId
  const pendingOption = source.pendingOptionSelection
    ? publicPendingOption(source.pendingOptionSelection, canonicalPlayerId, diagnostics)
    : undefined
  const pendingTarget = source.pendingTargetSelection
    ? publicPendingTarget(source.pendingTargetSelection, canonicalPlayerId, diagnostics)
    : undefined
  const deployment = source.deployment
    ? publicDeployment(source.deployment, canonicalPlayerId, diagnostics)
    : undefined
  const terminal = publicTerminal(source.terminalResult)

  const targetingRevision = safeInteger(source.targetingRevision)
  const state: BattleState = {
    map: publicMap(source.map),
    pieces: visiblePieces,
    graveyard,
    pieceStatsByTemplateId: staticPieceStats(),
    skillsById: staticSkills(),
    players,
    turn: publicTurn(source.turn),
    ...(terminal ? { terminalResult: terminal } : {}),
    ...(deployment ? { deployment } : {}),
    ...(Array.isArray(source.toxins) ? {
      toxins: source.toxins.flatMap(raw => {
        const toxin = asRecord(raw)
        const x = finiteNumber(toxin?.x)
        const y = finiteNumber(toxin?.y)
        const damage = finiteNumber(toxin?.damage)
        const casterOwnerId = nonEmptyString(toxin?.casterOwnerId)
        return x === undefined || y === undefined || damage === undefined || !casterOwnerId
          ? []
          : [{ x, y, damage, casterOwnerId }]
      }),
    } : {}),
    ...(pendingOption ? { pendingOptionSelection: pendingOption } : {}),
    ...(pendingTarget ? { pendingTargetSelection: pendingTarget } : {}),
    ...(targetingRevision !== undefined && targetingRevision >= 0 ? { targetingRevision } : {}),
    ...(typeof source.gameStartFired === 'boolean' ? { gameStartFired: source.gameStartFired } : {}),
    _v: 1,
  }

  if (source.extensions !== undefined) diagnostics.add('dropped all network extensions, including debugBattle, seed and cursors')
  if (source.skillsById !== undefined) diagnostics.add('reloaded static skills from trusted local data')
  if (source.pieceStatsByTemplateId !== undefined) diagnostics.add('reloaded static piece stats from trusted local data')
  if (source.actions !== undefined) diagnostics.add('dropped battle action logs')
  if (source.customCards !== undefined) diagnostics.add('dropped network custom card definitions')
  if (source.turnTimer !== undefined) diagnostics.add('dropped server turn timer state')
  if (source.pendingBeforeSkillChoice !== undefined || source.pendingBeginTurnChoice !== undefined) {
    diagnostics.add('dropped legacy pending continuation state')
  }
  if (source.deployment && (asRecord(source.deployment)?.reserves !== undefined || asRecord(source.deployment)?.offerPieceIds !== undefined)) {
    diagnostics.add('dropped server-private deployment reserves and offer IDs')
  }
  if (sourcePlayers.some(value => asRecord(value)?.hand !== undefined)) {
    diagnostics.add('retained only the requesting player hand')
  }
  if (sourcePlayers.some(value => asRecord(value)?.rules !== undefined)) {
    diagnostics.add('restored player rules from trusted local templates only')
  }
  if (source.map && asRecord(source.map)?.rules !== undefined) diagnostics.add('dropped map runtime rules')
  if (source.pendingOptionSelection || source.pendingTargetSelection) {
    diagnostics.add('pending choices are public descriptors; continuation effects remain authority-owned')
  }
  if (snapshotState && typeof snapshotState === 'object') {
    // Keep this check explicit so future fields cannot silently become part of
    // the projection through object spreading.
    const droppedKeys = Object.keys(snapshotState as unknown as Record<string, unknown>)
      .filter(key => ![
        'map', 'pieces', 'graveyard', 'pieceStatsByTemplateId', 'skillsById', 'players', 'turn',
        'terminalResult', 'deployment', 'toxins', 'pendingOptionSelection', 'pendingTargetSelection',
        'targetingRevision', 'gameStartFired', 'extensions', 'actions', 'customCards', 'turnTimer',
        'pendingBeforeSkillChoice', 'pendingBeginTurnChoice', '_v',
      ].includes(key))
    if (droppedKeys.length > 0) diagnostics.add('dropped unknown BattleState fields')
  }

  return { state, diagnostics: [...diagnostics] }
}
