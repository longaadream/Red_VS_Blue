import type { PieceInstance, PieceStatusTag } from './piece'
import type { BattleState } from './turn'

export type StatusStacking = 'none' | 'duration' | 'intensity' | 'independent'
export interface StatusDefinition { stacking: StatusStacking; description: string }

/** Rule semantics, not UI order. Content with different mechanics must use different types. */
export const STATUS_DEFINITIONS: Readonly<Record<string, StatusDefinition>> = {
  // Independent records carry source-specific payloads or a skill-owned event lifetime.
  ...Object.fromEntries([
    'aizen-kyoka-secret', 'flying-raijin-mark', 'lethal-toxin', 'rafaam-temporal-distortion',
    'chaos-spear-theft', 'shadow-ride-sweep-side', 'shadow-step', 'tails-flight-reservation',
    'immune', 'inoperable', 'venom-corrosion-immobile', 'arthas-slow', 'hardy-block',
    'damage-multiplier', 'preserve-momentum', 'amaterasu-burn', 'buff',
  ].map(type => [type, { stacking: 'independent' as const, description: '保留独立实例；来源、载荷和专属进度由对应规则维护。' }])),
  // Unique progress counters / forms are updated in place by their named rules.
  ...Object.fromEntries([
    'aizen-kyoka-active', 'ichigo-bankai', 'demon-strike-charges', 'itachi-tsukuyomi',
    'kamui-shield', 'susanoo-active', 'velen-fate-shelter', 'undead-body', 'resurreccion',
    'hidan-dying', 'hidan-undying-used', 'obito-grudge', 'curse-ward-used', 'shishio-dmg-counter',
    'shishio-cooldown-fired', 'shishio-kills', 'ulquiorra-resurreccion-progress',
    'calm-shield', 'calm-stance', 'rage-stance', 'momentum-core', 'naruto-clone',
    'deployment-first-move-free', 'elune-protection', 'sage-mode-shield',
  ].map(type => [type, { stacking: 'none' as const, description: '唯一标记或进度；重复添加不产生第二份，进度由对应规则更新。' }])),
  'divine-shield': { stacking: 'none', description: '抵挡一次伤害，不叠加。' },
  silence: { stacking: 'duration', description: '不能主动使用技能，重复施加累加时长。' },
  silenced: { stacking: 'duration', description: '沉默的现有内容标识，重复施加累加时长。' },
  freeze: { stacking: 'duration', description: '不能主动走格或使用技能，重复施加累加时长。' },
  root: { stacking: 'duration', description: '只禁止主动走格，允许其他位移。' },
  'chidori-immobile': { stacking: 'duration', description: '旧定身标识，重复施加累加时长。' },
  'anti-heal': { stacking: 'duration', description: '不能接受治疗，同效果重复施加累加时长。' },
  sleep: { stacking: 'duration', description: '不能主动走格或使用技能，受到实际伤害解除。' },
  imprisoned: { stacking: 'duration', description: '禁止棋盘位移，不阻止死亡或离场。' },
  'sage-mode': { stacking: 'none', description: '独立准备进度，在所有者回合开始时结算。' },
  'damage-buff': { stacking: 'intensity', description: '强化数值相加，在下一次正伤害时一并消耗。' },
  'nano-boost': { stacking: 'intensity', description: '每份防御+3、移动力+1、伤害+1，分别相加。' },
  'blood-oath': { stacking: 'none', description: '血誓不可重复施加，按持有者回合结束计时。' },
  'icebound-fortitude': { stacking: 'none', description: '寒冰坚忍激活期间不可重复施加。' },
  'lich-covenant': { stacking: 'none', description: '死亡后复活一次，不叠加。' },
  'aizen-black-coffin': { stacking: 'independent', description: '每份黑棺分别记录来源和延迟伤害。' },
}

export type StatusEventSink = (piece: PieceInstance, status: PieceStatusTag, event: 'applied' | 'removed') => void
export type StatusHolder = Pick<PieceInstance, 'ownerPlayerId' | 'statusTags' | 'rules'>
type HolderEventSink<T> = (holder: T, status: PieceStatusTag, event: 'applied' | 'removed') => void
const durationOf = (tag: PieceStatusTag): number => Number(tag.remainingDuration ?? tag.currentDuration ?? -1)
const sameOwner = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

function expiryTurn(battle: BattleState, owner: string, duration: number): number | null {
  if (duration < 0) return null
  const order = battle.players.map(player => player.playerId)
  const current = order.findIndex(id => sameOwner(id, battle.turn.currentPlayerId))
  const holder = order.findIndex(id => sameOwner(id, owner))
  const cycle = Math.max(1, order.length)
  const distance = (holder - current + cycle) % cycle || cycle
  return battle.turn.turnNumber + distance + Math.max(0, duration - 1) * cycle
}

export function addPieceStatus<T extends StatusHolder>(
  battle: BattleState, piece: T, input: PieceStatusTag, emit?: HolderEventSink<T>,
): boolean {
  piece.statusTags ??= []
  const duration = durationOf(input)
  if (!Number.isFinite(duration) || duration < -1 || !Number.isInteger(duration)) throw new Error('Invalid status duration')
  if (duration === 0 && input.lifetime !== 'event') return false
  const stacking = (input.stacking as StatusStacking | undefined) ?? STATUS_DEFINITIONS[input.type]?.stacking ?? 'independent'
  if (!['none', 'duration', 'intensity', 'independent'].includes(stacking)) throw new Error('Invalid status stacking')
  const incoming: PieceStatusTag = {
    ...input, name: input.name ?? input.type, remainingDuration: duration, currentDuration: duration,
    stacking, appliedTurn: battle.turn.turnNumber, expiresAfterTurn: expiryTurn(battle, piece.ownerPlayerId, duration),
    ownerTurnCycle: battle.players.length,
    remainingUses: input.remainingUses ?? input.currentUses ?? -1,
    relatedRules: [...(input.relatedRules ?? [])],
    statusOrigins: [{ ...input, remainingDuration: duration, appliedTurn: battle.turn.turnNumber,
      expiresAfterTurn: expiryTurn(battle, piece.ownerPlayerId, duration) }],
  }
  const existing = piece.statusTags.find(tag => tag.type === input.type
    && (stacking === 'none' || (stacking === 'duration' && (durationOf(tag) < 0) === (duration < 0) && sameEffect(tag, input))
      || (stacking === 'intensity' && sameEffect(tag, input, true) && tag.expiresAfterTurn === incoming.expiresAfterTurn)))
  if (existing && stacking === 'none') return true
  if (existing && stacking !== 'independent') {
    existing.relatedRules = [...new Set([...(existing.relatedRules ?? []), ...(incoming.relatedRules ?? [])])]
    existing.statusOrigins = [...(existing.statusOrigins ?? [{ ...existing }]), ...incoming.statusOrigins!]
    existing.statusAliases = [...new Set([...(existing.statusAliases as string[] ?? []), input.id])]
    if (stacking === 'duration') {
      const previous = durationOf(existing)
      const total = previous < 0 || duration < 0 ? -1 : previous + duration
      existing.remainingDuration = total
      existing.currentDuration = total
      existing.expiresAfterTurn = total < 0 ? null
        : Number(existing.expiresAfterTurn ?? expiryTurn(battle, piece.ownerPlayerId, previous)) + duration * battle.players.length
    } else {
      existing.intensity = Math.floor(Number(existing.intensity ?? 1) + Number(incoming.intensity ?? 1))
    }
    emit?.(piece, existing, 'applied')
    return true
  }
  piece.statusTags.push(incoming)
  emit?.(piece, incoming, 'applied')
  return true
}

function sameEffect(left: PieceStatusTag, right: PieceStatusTag, ignoreIntensity = false): boolean {
  // Custom payload may change mechanics (e.g. delayed damage or a destination).
  const metadata = new Set(['id', 'name', 'description', 'icon', 'visible', 'relatedRules', 'sourceId', 'sourcePlayerId',
    'remainingDuration', 'currentDuration', 'appliedTurn', 'expiresAfterTurn', 'lastDurationTickTurn',
    'statusOrigins', 'statusAliases', 'stacking', 'remainingUses', 'currentUses', 'ownerTurnCycle'])
  if (ignoreIntensity) metadata.add('intensity')
  const effect = (tag: PieceStatusTag) => Object.entries({ intensity: 1, stacks: 1, ...tag })
    .filter(([key]) => !metadata.has(key)).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(effect(left)) === JSON.stringify(effect(right))
}

export function removePieceStatus<T extends StatusHolder>(piece: T, id: string, emit?: HolderEventSink<T>): boolean {
  const index = piece.statusTags?.findIndex(tag => tag.id === id || (tag.statusAliases as string[] | undefined)?.includes(id)) ?? -1
  if (index < 0) return false
  const tag = piece.statusTags[index]
  if (id !== tag.id && tag.statusOrigins?.some(origin => origin.id === id)) {
    revokeOrigins(piece, origin => origin.id === id, emit)
    return true
  }
  const [removed] = piece.statusTags.splice(index, 1)
  for (const ruleId of removed.relatedRules ?? []) {
    if (!piece.statusTags.some(tag => tag.relatedRules?.includes(ruleId))) {
      piece.rules = piece.rules.filter(rule => rule.id !== ruleId)
    }
  }
  emit?.(piece, removed, 'removed')
  return true
}

/** Revoke a source without dispelling contributions granted by other sources. */
export function removePieceStatusSource<T extends StatusHolder>(piece: T, sourceId: string, emit?: HolderEventSink<T>): void {
  revokeOrigins(piece, origin => origin.sourceId === sourceId, emit)
}

function revokeOrigins<T extends StatusHolder>(piece: T, matches: (origin: PieceStatusTag) => boolean, emit?: HolderEventSink<T>): void {
  for (const tag of [...(piece.statusTags ?? [])]) {
    const origins = tag.statusOrigins ?? [tag]
    const removed = origins.filter(matches)
    if (!removed.length) continue
    const retained = origins.filter(origin => !matches(origin))
    if (!retained.length) { removePieceStatus(piece, tag.id, emit); continue }
    const previousRules = tag.relatedRules ?? []
    tag.statusOrigins = retained
    tag.relatedRules = [...new Set(retained.flatMap(origin => origin.relatedRules ?? []))]
    tag.statusAliases = retained.map(origin => origin.id)
    if (tag.stacking === 'intensity') {
      tag.intensity = retained.reduce((total, origin) => total + Number(origin.intensity ?? 1), 0)
    } else if (tag.stacking === 'duration') {
      const durations = retained.map(durationOf)
      const previous = durationOf(tag)
      const duration = durations.includes(-1) ? -1 : durations.reduce((sum, n) => sum + n, 0)
      tag.remainingDuration = tag.currentDuration = duration
      if (duration === 0) { removePieceStatus(piece, tag.id, emit); continue }
      // Cycle length is fixed by the battle and captured when the effect was granted.
      if (duration >= 0 && tag.expiresAfterTurn != null) {
        tag.expiresAfterTurn -= (previous - duration) * Number(tag.ownerTurnCycle ?? 2)
        const activeOrigins = retained.filter(origin => durationOf(origin) > 0)
        tag.appliedTurn = Math.min(...activeOrigins.map(origin => Number(origin.appliedTurn ?? tag.appliedTurn)))
        tag.expiresAfterTurn = Math.max(tag.expiresAfterTurn,
          ...activeOrigins.map(origin => Number(origin.expiresAfterTurn ?? tag.expiresAfterTurn)))
      }
    }
    for (const ruleId of previousRules) {
      if (!piece.statusTags.some(other => other.relatedRules?.includes(ruleId))) {
        piece.rules = piece.rules.filter(rule => rule.id !== ruleId)
      }
    }
  }
}

/** Only owner end phases tick. New effects never consume the already-started turn. */
export function expireOwnerStatuses(battle: BattleState, playerId: string, emit?: StatusEventSink): void {
  for (const piece of [...battle.pieces]) {
    if (!sameOwner(piece.ownerPlayerId, playerId)) continue
    expireHolderStatuses(battle, piece, emit)
  }
}

export function expireHolderStatuses<T extends StatusHolder>(battle: BattleState, piece: T, emit?: HolderEventSink<T>): void {
    for (const tag of [...(piece.statusTags ?? [])]) {
      if (tag.expiresAtTurnEnd === battle.turn.turnNumber) {
        removePieceStatus(piece, tag.id, emit)
        continue
      }
      const duration = durationOf(tag)
      if (duration <= 0 || tag.appliedTurn === battle.turn.turnNumber) continue
      if (tag.lastDurationTickTurn === battle.turn.turnNumber) continue
      tag.lastDurationTickTurn = battle.turn.turnNumber
      tag.remainingDuration = duration - 1
      tag.currentDuration = duration - 1
      if (tag.stacking === 'duration' && tag.statusOrigins) {
        const origin = tag.statusOrigins.find(item => durationOf(item) > 0)
        if (origin) origin.remainingDuration = durationOf(origin) - 1
      }
      if (duration === 1) removePieceStatus(piece, tag.id, emit)
    }
}
