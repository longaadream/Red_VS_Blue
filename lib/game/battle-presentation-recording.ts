import type { BattleState } from './turn'
/** The engine records the movement meaning; presentation never guesses it from distance. */
export function recordedPositionKind(state: BattleState, pieceId: string, fromX: number, fromY: number, toX: number, toY: number): Record<string, string> {
  for (let i = (state.actions?.length ?? 0) - 1; i >= 0; i--) {
    const action = state.actions![i]
    const p = action.payload
    if (action.type === 'positionChanged' && p?.pieceId === pieceId && p.fromX === fromX && p.fromY === fromY && p.toX === toX && p.toY === toY
      && typeof p.movementKind === 'string') return { movementKind: p.movementKind }
  }
  return {}
}
import type { SkillDefinition } from './skills'
import type { BattlePresentationEvent } from './battle-presentation-events'
import { snapshotBattlePresentationStatuses, diffBattlePresentationStatuses, snapshotBattlePresentationTileEffects, diffBattlePresentationTileEffects } from './battle-presentation-events'
import type { GridPosition, ProjectileTraceEvent, ProjectileTraceOptions, SpatialPiece, SpatialTile } from './spatial'

type Draft = Omit<BattlePresentationEvent, 'eventId' | 'rootEventId' | 'parentEventId' | 'actionId' | 'sequence'>
type Source = Pick<Draft, 'sourcePieceId' | 'actorPlayerId' | 'skillId' | 'ruleId' | 'label' | 'causePath'>
type PieceFrame = { id: string; x?: number | null; y?: number | null; hp: number; appearance?: Draft['pieceSnapshot'] }
export type PresentationBatchKind = 'statusAdded' | 'statusRemoved' | 'tileEffectAdded' | 'tileEffectRemoved'
type PresentationBatch = { kind: PresentationBatchKind; id: string }
type SkillMetadata = Pick<SkillDefinition, 'name' | 'concealTargetInBattleLog'>
type MutableProjectilePath = { origin: GridPosition; direction: GridPosition; options: ProjectileTraceOptions; facts: ProjectileTraceEvent[] }
export type RecordedProjectilePath = Readonly<{
  origin: GridPosition
  direction: GridPosition
  options: ProjectileTraceOptions
  facts: readonly ProjectileTraceEvent[]
}>
export type BattlePresentationRecordingOptions = Readonly<{ observeProjectilePaths?: boolean }>
type Recording = { pieces: Map<string, PieceFrame>; statuses: ReturnType<typeof snapshotBattlePresentationStatuses>; tiles: ReturnType<typeof snapshotBattlePresentationTileEffects>; events: Draft[]; skills: Map<string, SkillMetadata>; source: Source; batch?: PresentationBatch; batchSequence: number; sourceSequence: number; observeProjectilePaths: boolean; projectilePaths: MutableProjectilePath[] }
let active: Recording | undefined
const recordings = new WeakMap<BattleState, Draft[]>()
const resolvedSkills = new WeakMap<BattleState, Map<string, SkillMetadata>>()
const projectileRecordings = new WeakMap<BattleState, readonly MutableProjectilePath[]>()

function pieces(state: BattleState): Map<string, PieceFrame> {
  return new Map(state.pieces.map(p => [p.instanceId, { id: p.instanceId, x: p.x, y: p.y, hp: p.currentHp,
    ...(p.x != null && p.y != null ? { appearance: { id: p.instanceId, templateId: p.templateId, name: p.name,
      ownerPlayerId: p.ownerPlayerId, faction: p.faction, x: p.x, y: p.y, hp: p.currentHp, maxHp: p.maxHp } } : {}) }]))
}

/** Synchronous, opt-in observation only. No state fields, RNG, logs or timers. */
export function recordBattlePresentation<T>(before: BattleState, run: () => T, stateOf: (result: T) => BattleState, options: BattlePresentationRecordingOptions = {}): T {
  const previous = active
  const recording: Recording = { pieces: pieces(before), statuses: snapshotBattlePresentationStatuses(before), tiles: snapshotBattlePresentationTileEffects(before), events: [], skills: new Map(), source: {}, batchSequence: 0, sourceSequence: 0,
    observeProjectilePaths: options.observeProjectilePaths === true, projectilePaths: [] }
  active = recording
  try {
    const result = run()
    const after = stateOf(result)
    checkpointBattlePresentation(after)
    // A suspended transaction returns the root prestate. Its speculative
    // effects are replayed only when the response actually commits them.
    const pending = after.pendingOptionSelection ?? after.pendingTargetSelection
    recordings.set(after, pending?.transaction ? [] : recording.events)
    resolvedSkills.set(after, recording.skills)
    if (recording.observeProjectilePaths) projectileRecordings.set(after, pending?.transaction ? [] : recording.projectilePaths)
    else projectileRecordings.delete(after)
    return result
  } finally {
    active = previous
  }
}

export function recordedBattlePresentation(state: BattleState): readonly Draft[] | undefined {
  return recordings.get(state)
}

/**
 * Return the facts actually read from each observed projectile query.
 * The result is a copy of the weakly-held recording so consumers cannot alter
 * the recording kept for later presentation projection.
 */
export function recordedProjectilePaths(state: BattleState): readonly RecordedProjectilePath[] | undefined {
  const paths = projectileRecordings.get(state)
  if (!paths) return undefined
  return paths.map(path => ({
    origin: { ...path.origin },
    direction: { ...path.direction },
    options: { ...path.options },
    facts: path.facts.map(snapshotProjectileFact),
  }))
}

function snapshotProjectileTile(tile: SpatialTile): SpatialTile {
  const props = tile.props
  const snapshotProps = props ? {
    ...(props.walkable === undefined ? {} : { walkable: props.walkable }),
    ...(props.bulletPassable === undefined ? {} : { bulletPassable: props.bulletPassable }),
    ...(props.bullet === undefined ? {} : { bullet: props.bullet }),
    ...(props.type === undefined ? {} : { type: props.type }),
  } : undefined
  return { x: tile.x, y: tile.y, ...(snapshotProps && Object.keys(snapshotProps).length ? { props: snapshotProps } : {}) }
}

function snapshotProjectilePiece(piece: SpatialPiece): SpatialPiece {
  return {
    currentHp: piece.currentHp,
    ...(piece.instanceId === undefined ? {} : { instanceId: piece.instanceId }),
    ...(piece.ownerPlayerId === undefined ? {} : { ownerPlayerId: piece.ownerPlayerId }),
    ...(piece.x === undefined ? {} : { x: piece.x }),
    ...(piece.y === undefined ? {} : { y: piece.y }),
    ...(piece.moveRange === undefined ? {} : { moveRange: piece.moveRange }),
  }
}

function isProjectileTraceEvent(value: unknown): value is ProjectileTraceEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fact = value as { type?: unknown; x?: unknown; y?: unknown; distance?: unknown; tile?: unknown; piece?: unknown }
  if (!['cell', 'piece', 'terrain', 'boundary'].includes(String(fact.type))
    || !Number.isFinite(fact.x) || !Number.isFinite(fact.y) || !Number.isFinite(fact.distance)) return false
  if (fact.type === 'boundary') return true
  if (fact.type === 'piece') return !!fact.piece && typeof fact.piece === 'object'
  return !!fact.tile && typeof fact.tile === 'object'
}

function snapshotProjectileFact(fact: ProjectileTraceEvent): ProjectileTraceEvent {
  if (fact.type === 'cell') return { ...fact, tile: snapshotProjectileTile(fact.tile) }
  if (fact.type === 'piece') return { ...fact, piece: snapshotProjectilePiece(fact.piece) }
  if (fact.type === 'terrain') return { ...fact, tile: snapshotProjectileTile(fact.tile) }
  return { ...fact }
}

function arrayIndex(property: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(property)) return undefined
  const index = Number(property)
  return Number.isSafeInteger(index) && index >= 0 && index < 0xffffffff ? index : undefined
}

/**
 * Preserve the normal array surface while observing only facts read by
 * SkillCode. Array methods and for-of naturally route numeric reads through
 * this proxy; length, iterator and other metadata reads do not create facts.
 */
export function observeProjectilePath<
  TTile extends SpatialTile,
  TPiece extends SpatialPiece,
>(
  origin: GridPosition,
  direction: GridPosition,
  options: ProjectileTraceOptions | undefined,
  facts: ProjectileTraceEvent<TTile, TPiece>[],
): ProjectileTraceEvent<TTile, TPiece>[] {
  const recording = active
  if (!recording?.observeProjectilePaths) return facts
  const path: MutableProjectilePath = {
    origin: { ...origin },
    direction: { ...direction },
    options: { ...(options ?? {}) },
    facts: [],
  }
  const seenIndexes = new Set<number>()
  return new Proxy(facts, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (active === recording && recording.observeProjectilePaths && typeof property === 'string') {
        const index = arrayIndex(property)
        if (index !== undefined && index < target.length && !seenIndexes.has(index) && isProjectileTraceEvent(value)) {
          seenIndexes.add(index)
          if (path.facts.length === 0) recording.projectilePaths.push(path)
          path.facts.push(snapshotProjectileFact(value))
        }
      }
      return value
    },
  })
}

/** Retain the executor's pinned definition even when a response suspends before logging. */
export function recordResolvedSkillPresentation(skill: SkillDefinition): void {
  active?.skills.set(skill.id, { name: skill.name, concealTargetInBattleLog: skill.concealTargetInBattleLog })
}

export function recordedSkillPresentation(state: BattleState, skillId: string): SkillMetadata | undefined {
  return resolvedSkills.get(state)?.get(skillId)
}

export function recordBattlePresentationBlock(source: Source, targetId: string, absorbed: number, blocked: boolean): void {
  if (!active || (!blocked && absorbed <= 0)) return
  active.events.push({ ...active.source, ...source, kind: 'block', iconId: 'action-block', targetPieceIds: [targetId],
    result: { absorbed, blocked }, complement: { kind: 'amount', amount: absorbed }, priority: 90, skippable: true })
}

export function presentationRecordingRollback(): () => void {
  if (!active) return () => {}
  const recording = active
  const frames = recording.pieces, statuses = recording.statuses, tiles = recording.tiles, length = recording.events.length, sequence = recording.batchSequence, projectilePaths = recording.projectilePaths, projectileLength = recording.projectilePaths.length
  return () => { recording.pieces = frames; recording.statuses = statuses; recording.tiles = tiles; recording.events.length = length; recording.batchSequence = sequence; recording.projectilePaths = projectilePaths; recording.projectilePaths.length = projectileLength }
}

/** FIFO presentation scopes. Applies existing synchronous content unchanged;
 * only matching observed facts gain a visual batch ID. Trigger consumers are
 * separate scopes, and intervening facts remain ordered barriers in playback. */
export function createBattlePresentationQueue(state: BattleState) {
  const pending: Array<{ kind: PresentationBatchKind; apply: () => void }> = []
  let draining = false
  return Object.freeze({
    push(kind: PresentationBatchKind, apply: () => void): void {
      if (!['statusAdded', 'statusRemoved', 'tileEffectAdded', 'tileEffectRemoved'].includes(kind) || typeof apply !== 'function') {
        throw new Error('Unsupported presentation batch')
      }
      pending.push({ kind, apply })
      if (draining) return
      draining = true
      try {
        while (pending.length) {
          const request = pending.shift()!
          checkpointBattlePresentation(state)
          const recording = active
          const previous = recording?.batch
          if (recording) recording.batch = { kind: request.kind, id: `presentation-batch-${++recording.batchSequence}` }
          try { request.apply(); checkpointBattlePresentation(state) }
          finally { if (recording) recording.batch = previous }
        }
      } finally { pending.length = 0; draining = false }
    },
  })
}

export function checkpointBattlePresentation(state: BattleState, batch?: { kind: 'damage' | 'heal'; id: string } & Source): void {
  if (!active) return
  const next = pieces(state)
  const source: Source = batch ? { ...active.source, sourcePieceId: batch.sourcePieceId, actorPlayerId: batch.actorPlayerId, skillId: batch.skillId } : active.source
  for (const p of next.values()) {
    const old = active.pieces.get(p.id)
    if (!old) {
      active.events.push({ ...source, kind: 'spawn', iconId: 'action-spawn', targetPieceIds: [p.id],
        pieceSnapshot: p.appearance,
        ...(p.x != null && p.y != null ? { targetCell: { x: p.x, y: p.y } } : {}), priority: 90, skippable: true })
      continue
    }
    if ((old.x !== p.x || old.y !== p.y) && old.x != null && old.y != null && p.x != null && p.y != null) {
      active.events.push({ ...active.source, kind: 'forceMove', iconId: 'action-force-move', targetPieceIds: [p.id],
        targetCell: { x: p.x, y: p.y }, result: { fromX: old.x, fromY: old.y, toX: p.x, toY: p.y,
          ...recordedPositionKind(state, p.id, old.x, old.y, p.x, p.y) }, priority: 75, skippable: true })
    }
    if (p.hp !== old.hp) {
      const kind = p.hp < old.hp ? 'damage' : 'heal'
      active.events.push({ ...source, kind, iconId: 'action-' + kind, targetPieceIds: [p.id],
        ...(batch && batch.kind === kind ? { batchId: batch.id } : {}),
        result: { amount: Math.abs(p.hp - old.hp), value: p.hp },
        ...(p.x != null && p.y != null ? { targetCell: { x: p.x, y: p.y } } : {}),
        complement: { kind: 'amount', amount: Math.abs(p.hp - old.hp), value: p.hp }, priority: 70, skippable: true })
    }
  }
  for (const old of active.pieces.values()) {
    if (next.has(old.id)) continue
    const kind = state.graveyard?.some(p => p.instanceId === old.id) ? 'death' : 'eliminated'
    active.events.push({ ...active.source, kind, iconId: 'action-' + kind, targetPieceIds: [old.id],
      ...(old.x != null && old.y != null ? { targetCell: { x: old.x, y: old.y } } : {}), priority: 120, skippable: false })
  }
  active.pieces = next
  const statuses = snapshotBattlePresentationStatuses(state)
  const tiles = snapshotBattlePresentationTileEffects(state)
  const changes = [...diffBattlePresentationStatuses(active.statuses, statuses), ...diffBattlePresentationTileEffects(active.tiles, tiles)]
  active.events.push(...changes.map(event => ({ ...active!.source, ...event,
    ...(active!.batch?.kind === event.kind ? { batchId: active!.batch.id } : {}) })))
  active.statuses = statuses
  active.tiles = tiles
}

/** Keep only triggered consumers with an observed effect; preserve nesting. */
export function withBattlePresentationSource<T>(state: BattleState, source: Source, run: () => T): T {
  if (!active) return run()
  checkpointBattlePresentation(state)
  const recording = active
  const previous = recording.source
  const previousBatch = recording.batch
  recording.batch = undefined
  const identity = { sourcePieceId: source.sourcePieceId, actorPlayerId: source.actorPlayerId, skillId: source.skillId, ruleId: source.ruleId, label: source.label }
  recording.source = { ...source, causePath: [...(previous.causePath ?? []), { ...identity, id: 'scope-' + (++recording.sourceSequence) }] }
  const index = recording.events.length
  recording.events.push({ ...recording.source, kind: 'passive', iconId: 'action-passive', priority: 80, skippable: true })
  try {
    const result = run()
    checkpointBattlePresentation(state)
    return result
  } finally {
    if (recording.events.length === index + 1) recording.events.splice(index, 1)
    recording.source = previous
    recording.batch = previousBatch
  }
}
