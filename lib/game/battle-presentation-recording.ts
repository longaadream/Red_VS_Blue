import type { BattleState } from './turn'
import type { BattlePresentationEvent } from './battle-presentation-events'
import { snapshotBattlePresentationStatuses, diffBattlePresentationStatuses, snapshotBattlePresentationTileEffects, diffBattlePresentationTileEffects } from './battle-presentation-events'

type Draft = Omit<BattlePresentationEvent, 'eventId' | 'rootEventId' | 'parentEventId' | 'actionId' | 'sequence'>
type Source = Pick<Draft, 'sourcePieceId' | 'actorPlayerId' | 'skillId' | 'ruleId' | 'label'>
type PieceFrame = { id: string; x?: number | null; y?: number | null; hp: number; appearance?: Draft['pieceSnapshot'] }
export type PresentationBatchKind = 'statusAdded' | 'statusRemoved' | 'tileEffectAdded' | 'tileEffectRemoved'
type PresentationBatch = { kind: PresentationBatchKind; id: string }
type Recording = { pieces: Map<string, PieceFrame>; statuses: ReturnType<typeof snapshotBattlePresentationStatuses>; tiles: ReturnType<typeof snapshotBattlePresentationTileEffects>; events: Draft[]; source: Source; batch?: PresentationBatch; batchSequence: number }
let active: Recording | undefined
const recordings = new WeakMap<BattleState, Draft[]>()

function pieces(state: BattleState): Map<string, PieceFrame> {
  return new Map(state.pieces.map(p => [p.instanceId, { id: p.instanceId, x: p.x, y: p.y, hp: p.currentHp,
    ...(p.x != null && p.y != null ? { appearance: { id: p.instanceId, templateId: p.templateId, name: p.name,
      ownerPlayerId: p.ownerPlayerId, faction: p.faction, x: p.x, y: p.y, hp: p.currentHp, maxHp: p.maxHp } } : {}) }]))
}

/** Synchronous, opt-in observation only. No state fields, RNG, logs or timers. */
export function recordBattlePresentation<T>(before: BattleState, run: () => T, stateOf: (result: T) => BattleState): T {
  const previous = active
  const recording: Recording = { pieces: pieces(before), statuses: snapshotBattlePresentationStatuses(before), tiles: snapshotBattlePresentationTileEffects(before), events: [], source: {}, batchSequence: 0 }
  active = recording
  try {
    const result = run()
    const after = stateOf(result)
    checkpointBattlePresentation(after)
    // A suspended transaction returns the root prestate. Its speculative
    // effects are replayed only when the response actually commits them.
    const pending = after.pendingOptionSelection ?? after.pendingTargetSelection
    recordings.set(after, pending?.transaction ? [] : recording.events)
    return result
  } finally {
    active = previous
  }
}

export function recordedBattlePresentation(state: BattleState): readonly Draft[] | undefined {
  return recordings.get(state)
}

export function recordBattlePresentationBlock(source: Source, targetId: string, absorbed: number, blocked: boolean): void {
  if (!active || (!blocked && absorbed <= 0)) return
  active.events.push({ ...source, kind: 'block', iconId: 'action-block', targetPieceIds: [targetId],
    result: { absorbed, blocked }, complement: { kind: 'amount', amount: absorbed }, priority: 90, skippable: true })
}

export function presentationRecordingRollback(): () => void {
  if (!active) return () => {}
  const recording = active
  const frames = recording.pieces, statuses = recording.statuses, tiles = recording.tiles, length = recording.events.length, sequence = recording.batchSequence
  return () => { recording.pieces = frames; recording.statuses = statuses; recording.tiles = tiles; recording.events.length = length; recording.batchSequence = sequence }
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
  const source: Source = batch ? { sourcePieceId: batch.sourcePieceId, actorPlayerId: batch.actorPlayerId, skillId: batch.skillId } : active.source
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
        targetCell: { x: p.x, y: p.y }, result: { fromX: old.x, fromY: old.y, toX: p.x, toY: p.y }, priority: 75, skippable: true })
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
  recording.source = source
  const index = recording.events.length
  recording.events.push({ ...source, kind: 'passive', iconId: 'action-passive', priority: 80, skippable: true })
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
