import type { BattleAction, BattleActionLog, BattleState } from './turn'
import { traceProjectile } from './spatial'

export type BattlePresentationEventKind =
  | 'move'
  | 'skill'
  | 'chargeSkill'
  | 'card'
  | 'passive'
  | 'shield'
  | 'damage'
  | 'heal'
  | 'statusAdded'
  | 'statusRemoved'
  | 'death'

export type BattlePresentationCue =
  | 'directional'
  | 'projectile'
  | 'area'
  | 'displacement'
  | 'summon'

export type BattlePresentationEndReason =
  | 'hit'
  | 'blocked'
  | 'boundary'
  | 'range-expired'
  | 'resolved'

export interface BattlePresentationPoint {
  x: number
  y: number
}

export interface BattlePresentationCollision extends BattlePresentationPoint {
  kind: 'piece' | 'terrain' | 'boundary'
  pieceId?: string
  terrainType?: string
  blocking: boolean
}

export interface BattlePresentationMotion {
  cue: BattlePresentationCue
  /** The player's chosen aim/target cell. It is never the projectile's implied terminal point. */
  selectedCell?: BattlePresentationPoint
  /** Ordered, authoritative in-bounds cells traversed by the visual effect. */
  pathCells?: BattlePresentationPoint[]
  /** The actual final in-bounds presentation position after collision/range resolution. */
  endPoint?: BattlePresentationPoint
  endReason?: BattlePresentationEndReason
  collisions?: BattlePresentationCollision[]
  /** Settled target cells for a low-intensity area flash. */
  areaCells?: BattlePresentationPoint[]
}

export interface BattlePresentationEvent {
  eventId: string
  rootEventId: string
  parentEventId?: string
  actionId: string
  sequence: number
  kind: BattlePresentationEventKind
  iconId: string
  actorPlayerId?: string
  sourcePieceId?: string
  skillId?: string
  cardId?: string
  ruleId?: string
  targetPieceIds?: string[]
  targetPlayerIds?: string[]
  targetCell?: { x: number; y: number }
  statusId?: string
  statusType?: string
  result?: Record<string, string | number | boolean>
  presentation?: BattlePresentationMotion
  priority: number
  skippable: boolean
}

export interface BattlePresentationProjectionInput {
  actionId: string
  command: BattleAction
  beforeState: BattleState
  afterState: BattleState
}

type EventDraft = Omit<BattlePresentationEvent, 'eventId' | 'rootEventId' | 'parentEventId' | 'actionId' | 'sequence'>

type StatusSnapshot = {
  entityKind: 'piece' | 'player'
  entityId: string
  statusId: string
  statusType: string
  status: Record<string, unknown>
}

const HIDDEN_STATUS_TYPES = new Set([
  'curse-ward-used',
  'hidan-undying-used',
  'shishio-cooldown-fired',
  'shishio-dmg-counter',
])

const ROOT_ACTIONS: Record<string, { kind: BattlePresentationEventKind; iconId: string; priority: number }> = {
  move: { kind: 'move', iconId: 'action-move', priority: 100 },
  useBasicSkill: { kind: 'skill', iconId: 'action-skill', priority: 100 },
  useChargeSkill: { kind: 'chargeSkill', iconId: 'action-charge-skill', priority: 110 },
  playCard: { kind: 'card', iconId: 'action-card', priority: 100 },
  deployReservePiece: { kind: 'move', iconId: 'action-move', priority: 90 },
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.flatMap(value => text(value) ? [String(value)] : []))]
}

function commandRecord(command: BattleAction): Record<string, unknown> {
  return command as unknown as Record<string, unknown>
}

function actionPayload(entry: BattleActionLog): Record<string, unknown> {
  return entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
    ? entry.payload
    : {}
}

function appendedActions(beforeState: BattleState, afterState: BattleState): BattleActionLog[] {
  const before = beforeState.actions ?? []
  const after = afterState.actions ?? []
  if (after.length < before.length) return []
  for (let index = 0; index < before.length; index += 1) {
    if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) return []
  }
  return after.slice(before.length)
}

function commandTargets(command: Record<string, unknown>): string[] {
  const extraTargets = Array.isArray(command.extraTargets) ? command.extraTargets : []
  return uniqueStrings([
    command.targetPieceId,
    ...extraTargets.map(entry => entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).pieceId
      : undefined),
  ])
}

function commandCell(command: Record<string, unknown>): { x: number; y: number } | undefined {
  const move = command.type === 'move' || command.type === 'deployReservePiece'
  const x = finite(move ? command.toX : command.targetX)
  const y = finite(move ? command.toY : command.targetY)
  return x === undefined || y === undefined ? undefined : { x, y }
}

export type ProjectilePresentationTravel = 'first-collision' | 'through-pieces' | 'selected-target'

/** Presentation-only declarations kept outside BattleState, hashes, patches, and persistence. */
const PROJECTILE_PRESENTATION_TRAVEL: Readonly<Record<string, ProjectilePresentationTravel>> = Object.freeze({
  'blackwidow-lethal-strike': 'first-collision',
  'hellfire-shotgun': 'first-collision',
  'ichigo-black-getsuga-tensho': 'through-pieces',
  'ichigo-getsuga-tensho': 'first-collision',
  'nano-boost': 'selected-target',
  'sleep-dart': 'first-collision',
  'venom-symbiote-drag': 'first-collision',
})

export function getProjectilePresentationTravel(skillId: string): ProjectilePresentationTravel | undefined {
  return PROJECTILE_PRESENTATION_TRAVEL[skillId]
}

function pieceCell(state: BattleState, pieceId: string | undefined): BattlePresentationPoint | undefined {
  if (!pieceId) return undefined
  const piece = state.pieces.find(entry => entry.instanceId === pieceId)
  const x = finite(piece?.x)
  const y = finite(piece?.y)
  return x === undefined || y === undefined ? undefined : { x, y }
}

function uniquePoints(points: Array<BattlePresentationPoint | undefined>): BattlePresentationPoint[] {
  const seen = new Set<string>()
  return points.flatMap(point => {
    if (!point) return []
    const key = `${point.x},${point.y}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ x: point.x, y: point.y }]
  })
}

function selectedCell(command: Record<string, unknown>, state: BattleState): BattlePresentationPoint | undefined {
  const direct = commandCell(command)
  if (direct) return direct
  return pieceCell(state, commandTargets(command)[0])
}

function projectileRange(skill: Record<string, unknown>): number | undefined {
  const targeting = skill.targeting && typeof skill.targeting === 'object'
    ? skill.targeting as Record<string, unknown>
    : null
  const steps = targeting && Array.isArray(targeting.steps) ? targeting.steps : []
  const range = steps
    .flatMap(step => step && typeof step === 'object' ? [finite((step as Record<string, unknown>).range)] : [])
    .find(value => value !== undefined)
  return range === undefined ? undefined : Math.max(0, Math.floor(range))
}

function projectilePresentation(
  command: Record<string, unknown>,
  state: BattleState,
  children: EventDraft[],
): BattlePresentationMotion | undefined {
  const skillId = text(command.skillId)
  const skill = skillId ? state.skillsById?.[skillId] as unknown as Record<string, unknown> | undefined : undefined
  if (!skill || skill.form !== 'projectile') return undefined
  const travel = getProjectilePresentationTravel(skillId)
  if (!travel) return undefined
  const selected = selectedCell(command, state)
  if (!selected) return undefined

  if (travel === 'selected-target') {
    return {
      cue: 'projectile',
      selectedCell: selected,
      pathCells: [selected],
      endPoint: selected,
      endReason: 'resolved',
      collisions: [],
    }
  }

  const sourcePieceId = text(command.pieceId)
  const source = pieceCell(state, sourcePieceId)
  if (!source) return undefined
  const dx = selected.x - source.x
  const dy = selected.y - source.y
  if ((dx !== 0 && dy !== 0) || (dx === 0 && dy === 0)) return undefined
  const direction = { x: dx === 0 ? 0 : Math.sign(dx), y: dy === 0 ? 0 : Math.sign(dy) }
  const maxDistance = projectileRange(skill)
  const facts = traceProjectile(state, source, direction, {
    excludePieceId: sourcePieceId,
    ...(maxDistance === undefined ? {} : { maxDistance }),
  })
  const affectedTargets = new Set(children.flatMap(child => child.targetPieceIds ?? []))
  const pathCells: BattlePresentationPoint[] = []
  const collisions: BattlePresentationCollision[] = []
  let endPoint: BattlePresentationPoint | undefined
  let endReason: BattlePresentationEndReason | undefined

  for (const fact of facts) {
    if (fact.type === 'cell') {
      pathCells.push({ x: fact.x, y: fact.y })
      endPoint = { x: fact.x, y: fact.y }
      continue
    }
    if (fact.type === 'piece') {
      const blocking = travel === 'first-collision'
      collisions.push({
        kind: 'piece', x: fact.x, y: fact.y, pieceId: fact.piece.instanceId, blocking,
      })
      if (blocking) {
        endPoint = { x: fact.x, y: fact.y }
        endReason = affectedTargets.has(fact.piece.instanceId) ? 'hit' : 'blocked'
        break
      }
      continue
    }
    if (fact.type === 'terrain' && fact.blocksProjectile) {
      collisions.push({
        kind: 'terrain', x: fact.x, y: fact.y,
        terrainType: String(fact.tile.props?.type || 'terrain'), blocking: true,
      })
      endPoint = { x: fact.x, y: fact.y }
      endReason = 'blocked'
      break
    }
    if (fact.type === 'boundary') {
      collisions.push({ kind: 'boundary', x: fact.x, y: fact.y, blocking: true })
      endReason = 'boundary'
      break
    }
  }

  if (!endPoint) endPoint = pathCells.at(-1)
  if (!endReason && endPoint) endReason = 'range-expired'
  return {
    cue: 'projectile',
    selectedCell: selected,
    pathCells,
    ...(endPoint ? { endPoint } : {}),
    ...(endReason ? { endReason } : {}),
    collisions,
  }
}

function nonProjectilePresentation(
  command: Record<string, unknown>,
  state: BattleState,
  children: EventDraft[],
): BattlePresentationMotion | undefined {
  const type = String(command.type || '')
  const selected = selectedCell(command, state)
  if (type === 'move' || type === 'deployReservePiece') {
    return selected ? {
      cue: type === 'deployReservePiece' ? 'summon' : 'displacement',
      selectedCell: selected,
      endPoint: selected,
      endReason: 'resolved',
    } : undefined
  }
  const skillId = text(command.skillId)
  const skill = skillId ? state.skillsById?.[skillId] as unknown as Record<string, unknown> | undefined : undefined
  const targetCells = uniquePoints([
    selected,
    ...children.flatMap(child => (child.targetPieceIds ?? []).map(pieceId => pieceCell(state, pieceId))),
  ])
  const isArea = skill?.form === 'area' || skill?.range === 'area' || targetCells.length > 1
  if (isArea && targetCells.length) {
    return {
      cue: 'area',
      ...(selected ? { selectedCell: selected } : {}),
      areaCells: targetCells,
      endPoint: selected ?? targetCells[0],
      endReason: 'resolved',
    }
  }
  return selected ? {
    cue: 'directional',
    selectedCell: selected,
    endPoint: selected,
    endReason: 'resolved',
  } : undefined
}

function presentationFor(
  command: Record<string, unknown>,
  state: BattleState,
  children: EventDraft[],
): BattlePresentationMotion | undefined {
  return projectilePresentation(command, state, children)
    ?? nonProjectilePresentation(command, state, children)
}

function commandCardId(command: Record<string, unknown>, beforeState: BattleState): string | undefined {
  const direct = text(command.cardId)
  if (direct) return direct
  const cardInstanceId = text(command.cardInstanceId)
  if (!cardInstanceId) return undefined
  const playerId = text(command.playerId)
  const player = beforeState.players.find(entry => !playerId || entry.playerId === playerId)
  const hand = Array.isArray(player?.hand) ? player.hand : []
  const card = hand.find(entry => entry && typeof entry === 'object'
    && text((entry as Record<string, unknown>).instanceId) === cardInstanceId)
  return card && typeof card === 'object'
    ? text((card as Record<string, unknown>).cardId)
    : undefined
}

function rootDraft(command: Record<string, unknown>, beforeState: BattleState, children: EventDraft[]): EventDraft | undefined {
  const config = ROOT_ACTIONS[String(command.type || '')]
  if (!config) return undefined
  const sourcePieceId = text(command.pieceId)
  const targetPieceIds = commandTargets(command)
  const targetCell = commandCell(command)
  const cardId = commandCardId(command, beforeState)
  const sourcePiece = sourcePieceId
    ? beforeState.pieces.find(piece => piece.instanceId === sourcePieceId)
    : undefined
  const result = command.type === 'move' && targetCell
    ? {
        ...(finite(sourcePiece?.x) !== undefined ? { fromX: finite(sourcePiece?.x)! } : {}),
        ...(finite(sourcePiece?.y) !== undefined ? { fromY: finite(sourcePiece?.y)! } : {}),
        toX: targetCell.x,
        toY: targetCell.y,
      }
    : undefined
  const presentation = presentationFor(command, beforeState, children)
  return {
    kind: config.kind,
    iconId: config.iconId,
    actorPlayerId: text(command.playerId) ?? text(beforeState.turn?.currentPlayerId),
    ...(sourcePieceId ? { sourcePieceId } : {}),
    ...(text(command.skillId) ? { skillId: text(command.skillId) } : {}),
    ...(cardId ? { cardId } : {}),
    ...(targetPieceIds.length > 0 ? { targetPieceIds } : {}),
    ...(targetCell ? { targetCell } : {}),
    ...(result ? { result } : {}),
    ...(presentation ? { presentation } : {}),
    priority: config.priority,
    skippable: true,
  }
}

function structuredActionDrafts(entries: BattleActionLog[]): EventDraft[] {
  const drafts: EventDraft[] = []
  for (const entry of entries) {
    const payload = actionPayload(entry)
    if (entry.type === 'triggerEffect') {
      const ruleId = text(payload.ruleId)
      if (!ruleId) continue
      const targetPieceIds = uniqueStrings([payload.targetId, ...(Array.isArray(payload.targetIds) ? payload.targetIds : [])])
      drafts.push({
        kind: 'passive',
        iconId: 'action-passive',
        actorPlayerId: text(entry.playerId),
        ...(text(payload.sourceId) ? { sourcePieceId: text(payload.sourceId) } : {}),
        ...(targetPieceIds.length > 0 ? { targetPieceIds } : {}),
        ruleId,
        priority: 80,
        skippable: true,
      })
      continue
    }
    if (entry.type !== 'damage') continue
    const targetId = text(payload.targetId)
    if (!targetId) continue
    const shieldAbsorbed = finite(payload.shieldAbsorbed) ?? 0
    const blocked = bool(payload.blocked) ?? false
    if (shieldAbsorbed > 0 || blocked) {
      drafts.push({
        kind: 'shield',
        iconId: 'shield',
        actorPlayerId: text(entry.playerId),
        ...(text(payload.sourceId) ? { sourcePieceId: text(payload.sourceId) } : {}),
        targetPieceIds: [targetId],
        ...(text(payload.skillId) ? { skillId: text(payload.skillId) } : {}),
        result: { absorbed: shieldAbsorbed, blocked },
        priority: 90,
        skippable: true,
      })
    }
    drafts.push({
      kind: 'damage',
      iconId: 'action-damage',
      actorPlayerId: text(entry.playerId),
      ...(text(payload.sourceId) ? { sourcePieceId: text(payload.sourceId) } : {}),
      targetPieceIds: [targetId],
      ...(text(payload.skillId) ? { skillId: text(payload.skillId) } : {}),
      result: {
        amount: finite(payload.finalDamage) ?? 0,
        blocked,
      },
      priority: 70,
      skippable: true,
    })
    if (payload.killed === true) {
      drafts.push({
        kind: 'death',
        iconId: 'action-death',
        actorPlayerId: text(entry.playerId),
        ...(text(payload.sourceId) ? { sourcePieceId: text(payload.sourceId) } : {}),
        targetPieceIds: [targetId],
        ...(text(payload.skillId) ? { skillId: text(payload.skillId) } : {}),
        priority: 120,
        skippable: false,
      })
    }
  }
  return drafts
}

function healDrafts(command: Record<string, unknown>, beforeState: BattleState, afterState: BattleState): EventDraft[] {
  const beforeById = new Map(beforeState.pieces.map(piece => [piece.instanceId, piece]))
  return afterState.pieces
    .flatMap(piece => {
      const previous = beforeById.get(piece.instanceId)
      if (!previous) return []
      const amount = Number(piece.currentHp) - Number(previous.currentHp)
      if (!Number.isFinite(amount) || amount <= 0) return []
      return [{
        kind: 'heal' as const,
        iconId: 'action-heal',
        actorPlayerId: text(command.playerId) ?? text(piece.ownerPlayerId),
        ...(text(command.pieceId) ? { sourcePieceId: text(command.pieceId) } : {}),
        targetPieceIds: [piece.instanceId],
        ...(text(command.skillId) ? { skillId: text(command.skillId) } : {}),
        result: { amount },
        priority: 60,
        skippable: true,
      }]
    })
    .sort((left, right) => left.targetPieceIds[0].localeCompare(right.targetPieceIds[0]))
}

function statusValues(entity: Record<string, unknown>): Record<string, unknown>[] {
  return ['statusTags', 'buffs', 'debuffs'].flatMap(key => (
    Array.isArray(entity[key]) ? entity[key] as Record<string, unknown>[] : []
  ))
}

function snapshotStatuses(state: BattleState): Map<string, StatusSnapshot> {
  const snapshots = new Map<string, StatusSnapshot>()
  const capture = (entityKind: StatusSnapshot['entityKind'], entityId: string, entity: Record<string, unknown>) => {
    for (const status of statusValues(entity)) {
      if (!status || status.visible === false) continue
      const statusType = text(status.type) ?? text(status.id) ?? text(status.name)
      if (!statusType || HIDDEN_STATUS_TYPES.has(statusType)) continue
      const statusId = text(status.id) ?? statusType
      const key = [entityKind, entityId, statusId, statusType].join(':')
      snapshots.set(key, { entityKind, entityId, statusId, statusType, status })
    }
  }
  for (const piece of state.pieces) capture('piece', piece.instanceId, piece as unknown as Record<string, unknown>)
  for (const player of state.players) capture('player', player.playerId, player as unknown as Record<string, unknown>)
  return snapshots
}

function statusResult(status: Record<string, unknown>): Record<string, number> | undefined {
  const values = {
    stacks: finite(status.stacks) ?? 0,
    duration: finite(status.remainingDuration ?? status.currentDuration ?? status.remainingTurns ?? status.duration) ?? 0,
    uses: finite(status.remainingUses ?? status.currentUses ?? status.uses) ?? 0,
    intensity: finite(status.intensity) ?? 0,
  }
  return Object.values(values).some(value => value !== 0) ? values : undefined
}

function statusDraft(snapshot: StatusSnapshot, added: boolean, command: Record<string, unknown>): EventDraft {
  const target = snapshot.entityKind === 'piece'
    ? { targetPieceIds: [snapshot.entityId] }
    : { targetPlayerIds: [snapshot.entityId] }
  const result = statusResult(snapshot.status)
  return {
    kind: added ? 'statusAdded' : 'statusRemoved',
    iconId: added ? 'status-add' : 'status-remove',
    actorPlayerId: text(command.playerId),
    ...(text(command.pieceId) ? { sourcePieceId: text(command.pieceId) } : {}),
    ...target,
    statusId: snapshot.statusId,
    statusType: snapshot.statusType,
    ...(result ? { result } : {}),
    priority: 50,
    skippable: true,
  }
}

function statusDrafts(command: Record<string, unknown>, beforeState: BattleState, afterState: BattleState): EventDraft[] {
  const before = snapshotStatuses(beforeState)
  const after = snapshotStatuses(afterState)
  const beforePieceIds = new Set(beforeState.pieces.map(piece => piece.instanceId))
  const afterPieceIds = new Set(afterState.pieces.map(piece => piece.instanceId))
  const existsAcrossTransition = (snapshot: StatusSnapshot) => snapshot.entityKind === 'player'
    || (beforePieceIds.has(snapshot.entityId) && afterPieceIds.has(snapshot.entityId))
  const removed = [...before.entries()]
    .filter(([key, snapshot]) => !after.has(key) && existsAcrossTransition(snapshot))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, snapshot]) => statusDraft(snapshot, false, command))
  const added = [...after.entries()]
    .filter(([key, snapshot]) => !before.has(key) && existsAcrossTransition(snapshot))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, snapshot]) => statusDraft(snapshot, true, command))
  return [...removed, ...added]
}

export function projectBattlePresentationEvents(
  input: BattlePresentationProjectionInput,
): BattlePresentationEvent[] {
  const actionId = text(input.actionId)
  if (!actionId) return []
  const command = commandRecord(input.command)
  const children = [
    ...structuredActionDrafts(appendedActions(input.beforeState, input.afterState)),
    ...healDrafts(command, input.beforeState, input.afterState),
    ...statusDrafts(command, input.beforeState, input.afterState),
  ]
  const root = rootDraft(command, input.beforeState, children) ?? (children.length > 0 ? {
    kind: 'passive' as const,
    iconId: 'action-passive',
    actorPlayerId: text(command.playerId) ?? text(input.beforeState.turn?.currentPlayerId),
    priority: 80,
    skippable: true,
  } : undefined)
  if (!root) return []
  const rootEventId = `${actionId}:0`
  return [root, ...children].map((draft, sequence) => ({
    eventId: `${actionId}:${sequence}`,
    rootEventId,
    ...(sequence > 0 ? { parentEventId: rootEventId } : {}),
    actionId,
    sequence,
    ...draft,
  }))
}
