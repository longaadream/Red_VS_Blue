import type { BattleState } from './battle-types'
import { damageSourcePiece, getActiveEffectChain, type DamageSource } from './effect-batch'
import { createGameplayModuleDiagnosticHost } from './gameplay-module-diagnostics'
import type { PieceInstance } from './piece'

type EffectKind = 'damage' | 'heal'
type SourceKind = 'piece' | 'player' | 'card'
type Result = Record<string, unknown>
type Host = {
  prepare(kind: EffectKind, amount: number): number
  damage(source: DamageSource, targets: PieceInstance[], amount: number, damageType: 'physical' | 'true', skillId?: string, killerPlayerId?: string): { results: Result[] }
  heal(source: DamageSource, targets: PieceInstance[], amount: number, skillId?: string): { results: Result[] }
  enqueue(kind: EffectKind, source: DamageSource, targets: PieceInstance[], amount: number, damageType: 'physical' | 'true', skillId?: string, killerPlayerId?: string): void
}
type Context = { cardInstance?: { instanceId: string; cardId: string; ownerPlayerId: string; name?: string } | null }

/**
 * Author expressions can pass an effect result through record operations.
 * Those operations use the finite-JSON author value contract, while the
 * legacy damage host includes optional metadata as own properties whose value
 * is `undefined` for a root batch.  Drop only those absent optional fields at
 * this boundary; preserve every concrete result value and reject any other
 * non-author value instead of silently coercing it.
 */
function normalizeAuthorResult(value: unknown): Result {
  const seen = new Set<object>()
  const clone = (entry: unknown): unknown => {
    if (entry === undefined) return undefined
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('效果结果包含无效数值')
      return entry
    }
    if (typeof entry !== 'object') throw new Error('效果结果不是可序列化记录')
    if (seen.has(entry)) throw new Error('效果结果包含循环引用')
    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(entry)) {
      throw new Error('效果结果包含非记录对象')
    }
    seen.add(entry)
    try {
      if (Array.isArray(entry)) {
        const items = entry.map(item => clone(item))
        if (items.some(item => item === undefined)) throw new Error('效果结果数组包含未定义项')
        return items
      }
      const record: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(entry)) {
        const copied = clone(item)
        if (copied !== undefined) record[key] = copied
      }
      return record
    } finally {
      seen.delete(entry)
    }
  }

  const normalized = clone(value)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('效果结果必须是记录')
  }
  return normalized as Result
}

/** One author operation accepts one value or an ordered tuple; the host still
 * owns damage/heal event ordering, deaths, presentation and resource effects. */
export function createAuthorEffects(battle: BattleState, context: Context, host: Host) {
  function source(reference: string, kind: SourceKind): DamageSource {
    if (kind === 'piece') {
      const piece = battle.pieces.find(piece => piece.instanceId === reference && piece.currentHp > 0)
      if (!piece) throw new Error('效果来源棋子已失效')
      return piece
    }
    if (kind === 'player') {
      const player = battle.players.find(player => player.playerId === reference)
      if (!player) throw new Error('效果来源玩家不存在')
      return { kind: 'player', instanceId: player.playerId, ownerPlayerId: player.playerId, name: player.name || player.playerId }
    }
    const card = context.cardInstance?.instanceId === reference ? context.cardInstance : battle.players.flatMap(player => player.hand).find(card => card.instanceId === reference)
    if (!card) throw new Error('效果来源手牌实例已失效')
    return { kind: 'card', instanceId: card.instanceId, ownerPlayerId: card.ownerPlayerId, name: card.name || card.cardId }
  }
  return {
    apply(kind: EffectKind, reference: string, sourceKind: SourceKind, targets: string | readonly string[], amount: number | readonly number[], damageType: 'normal' | 'true', skillId?: string, killerPlayerId?: string | null): Result | Result[] {
      if (!['damage', 'heal'].includes(kind) || !['piece', 'player', 'card'].includes(sourceKind)) throw new Error('效果或来源类型不合法')
      if (killerPlayerId != null && (kind !== 'damage' || !battle.players.some(player => player.playerId === killerPlayerId))) throw new Error('击杀归属玩家不存在或此效果不支持击杀归属')
      const killer = killerPlayerId ?? undefined
      const actor = source(reference, sourceKind)
      const targetIds = Array.isArray(targets) ? targets : [targets]
      if (targetIds.length > 4096 || targetIds.some(id => typeof id !== 'string')) throw new Error('目标元组不合法')
      const values = typeof amount === 'number' ? targetIds.map(() => amount) : [...amount]
      if (values.length !== targetIds.length || values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('效果数值须与目标逐项对应，或填写一个统一数值')
      if (!['normal', 'true'].includes(damageType)) throw new Error('伤害类型不合法')
      const results: Result[] = targetIds.map(targetId => ({ success: false, targetId, damage: 0, heal: 0, isKilled: false, skipped: 'target-unavailable' }))
      const modified = values.map(value => host.prepare(kind, value))
      if (modified.some(value => !Number.isFinite(value) || value < 0)) throw new Error('效果修正产生了无效数值')
      const valid = targetIds.flatMap((targetId, index) => {
        const piece = battle.pieces.find(piece => piece.instanceId === targetId && piece.currentHp > 0)
        return piece ? [{ piece, index, amount: Math.floor(modified[index]) }] : []
      })
      // A single amount is one authoritative batch. Explicit per-target values
      // are separate, ordered settlements, exactly matching their tuple positions.
      const groups = typeof amount === 'number' && new Set(targetIds).size === targetIds.length ? [valid] : valid.map(item => [item])
      const sourcePiece = damageSourcePiece(actor)
      let sourceFailureReported = false
      for (const group of groups) {
        const live = group.filter(item => battle.pieces.includes(item.piece) && item.piece.currentHp > 0)
        if (!live.length) continue
        if (sourcePiece && (sourcePiece.currentHp <= 0 || !battle.pieces.includes(sourcePiece))) {
          live.forEach(item => { results[item.index] = { success: false, targetId: item.piece.instanceId, damage: 0, heal: 0, isKilled: false, skipped: 'source-unavailable' } })
          if (!sourceFailureReported) {
            const chain = getActiveEffectChain(battle)
            createGameplayModuleDiagnosticHost('authorEffect', {
              ...(skillId === undefined ? {} : { contentId: skillId }), actorPlayerId: actor.ownerPlayerId, turn: battle.turn.turnNumber, phase: battle.turn.phase,
              ...(chain ? { chainId: chain.chainId, actionId: chain.actionId, ...(chain.rootSeed != null ? { rootSeed: chain.rootSeed } : {}) } : {}),
            }).record('source', new Error('效果来源棋子已失效'), `author.effect.${kind}`)
            sourceFailureReported = true
          }
          continue
        }
        if (getActiveEffectChain(battle)?.state === 'processing') {
          host.enqueue(kind, actor, live.map(item => item.piece), live[0].amount, damageType === 'normal' ? 'physical' : 'true', skillId, killer)
          // A queued reaction has no settlement result yet. In particular it
          // must not invent success/damage/kills for downstream expressions.
          live.forEach(item => { results[item.index] = { queued: true, targetId: item.piece.instanceId } })
          continue
        }
        const applied = kind === 'damage'
          ? host.damage(actor, live.map(item => item.piece), live[0].amount, damageType === 'normal' ? 'physical' : 'true', skillId, killer)
          : host.heal(actor, live.map(item => item.piece), live[0].amount, skillId)
        if (!Array.isArray(applied?.results) || applied.results.length !== live.length) throw new Error('权威效果结果未与目标一一对应')
        live.forEach((item, index) => { results[item.index] = normalizeAuthorResult(applied.results[index]) })
      }
      return Array.isArray(targets) ? results : results[0]
    },
  }
}
