/* Shared trusted SkillCode facade. Adapters retain authoritative engine semantics. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Legacy SkillCode contexts have distinct dynamic surfaces. */
import type { BattleState } from './turn'
import { changePiecePositions } from './position-change'
import { traceProjectile, manhattanDistance } from './spatial'
import { getRuleMath } from './rule-runtime'
import { areMatchAllies } from './match-teams'
import { createSkillPresentation } from './skill-presentation'
export type FlowSurface = 'skill' | 'rule' | 'triggerSkill' | 'pending'
type Delegate = Record<string, (...args: any[]) => any>
/** Called at formal removal; revival creates a new incarnation. */
export function clearRemovedPieceFlowState(battle: BattleState, ids: readonly string[]): void {
  if (Array.isArray(battle.extensions?.flowState)) battle.extensions!.flowState = battle.extensions!.flowState.filter(
    entry => !(entry?.schemaVersion === 1 && entry.scope === 'piece' && entry.lifetime === 'while-alive' && ids.includes(entry.entityId)),
  )
}
const numeric = (value: number) => { if (!Number.isFinite(value)) throw new Error('flow: 数值必须有限'); return Math.floor(value) }
const key = (value: string) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(value) || ['__proto__','prototype','constructor'].includes(value)) throw new Error('flow: 无效标识符'); return value }
function json(value: unknown): any {
  const seen = new Set<object>()
  const walk = (item: unknown, depth: number): void => {
    if (depth > 40) throw new Error('flow: extension嵌套过深')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || !item || seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw new Error('flow: extension仅允许有限JSON值')
    seen.add(item)
    if (Object.getOwnPropertySymbols(item).length) throw new Error('flow: extension不允许Symbol属性')
    for (const [name, property] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && name === 'length') continue
      if (!('value' in property) || ['__proto__','constructor','prototype'].includes(name)) throw new Error('flow: extension包含不允许的属性')
      walk(property.value, depth + 1)
    }
    seen.delete(item)
  }
  walk(value, 0)
  const encoded = JSON.stringify(value)
  if (encoded.length > 65536) throw new Error('flow: extension超过64KB')
  return JSON.parse(encoded)
}
export function createFlowRuntime(battle: BattleState, context: any, surface: FlowSurface, delegates: Delegate) {
  const piece = (id: string) => {
    const found = battle.pieces.find(p => p.instanceId === id)
    if (!found) throw new Error('flow: 棋子不存在 ' + id)
    return found
  }
  const player = (id: string) => {
    const found = battle.players.find(p => p.playerId === id)
    if (!found) throw new Error('flow: 玩家不存在 ' + id)
    return found
  }
  const holder = () => surface === 'skill' ? context.piece : context.rulePiece
  const call = (name: string, ...args: any[]) => {
    if (typeof delegates[name] !== 'function') throw new Error('flow: ' + surface + '入口未提供 ' + name + '，不得用空桩继续执行')
    return delegates[name](...args)
  }
  const resolveSource = (source: any) => typeof source === 'string' ? piece(source) : source
  const effectId = () => String(context.skill?.id || context.ruleId || 'flow')
  const stateOwner = (scope: 'piece' | 'player' | 'battle', id: string) => {
    if (scope === 'piece') {
      const owner = battle.pieces.find(p => p.instanceId === id) ?? battle.graveyard?.find(p => p.instanceId === id)
      if (!owner) throw new Error('flow: extension棋子归属不存在 ' + id)
      return owner.ownerPlayerId
    }
    if (scope === 'player') return player(id).playerId
    if (scope !== 'battle' || id !== 'battle') throw new Error('flow: extension归属无效')
    return undefined
  }
  const records = (): any[] => {
    const value = battle.extensions?.flowState
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some(e => !e || e.schemaVersion !== 1)) throw new Error('flow: extension格式版本不支持')
    return value
  }
  const expired = (entry: any) => entry.lifetime === 'while-alive' && !battle.pieces.some(p => p.instanceId === entry.entityId && p.currentHp > 0)
  let presentation: ReturnType<typeof createSkillPresentation> | undefined
  return {
    version: 'rvb-flow-runtime/v1',
    surface,
    capabilities: Object.keys(delegates).filter(name => typeof delegates[name] === 'function').sort(),
    get presentation() { return presentation ??= createSkillPresentation(battle, holder()?.ownerPlayerId ?? context.playerId, effectId(), holder()?.instanceId) },
    refs: {
      holder: () => holder()?.instanceId ?? null,
      source: () => context.sourcePiece?.instanceId ?? (surface === 'skill' ? context.piece?.instanceId : null),
      target: () => context.targetPiece?.instanceId ?? context.target?.instanceId ?? null,
      player: () => holder()?.ownerPlayerId ?? context.playerId ?? null,
      eventPlayer: () => context.triggerPlayerId ?? context.playerId ?? null,
    },
    query: {
      piece, player,
      pieces: (options: { ownerId?: string; relation?: 'ally' | 'enemy'; originId?: string; range?: number; includeDead?: boolean } = {}) => {
        const origin = options.originId ? piece(options.originId) : holder()
        const owner = options.ownerId || origin?.ownerPlayerId
        if (options.range !== undefined && (!origin || !Number.isFinite(options.range) || options.range < 0)) throw new Error('flow: 范围查询缺少有效中心')
        if (options.relation && !owner) throw new Error('flow: 敌我查询缺少所属玩家')
        return battle.pieces.filter(p => (options.includeDead || p.currentHp > 0)
          && (!options.ownerId || options.relation || p.ownerPlayerId === options.ownerId)
          && (!options.relation || (options.relation === 'ally' ? areMatchAllies(battle, p.ownerPlayerId, owner) : !areMatchAllies(battle, p.ownerPlayerId, owner)))
          && (options.range === undefined || (p.x != null && p.y != null && origin!.x != null && origin!.y != null && manhattanDistance(p as any, origin as any) <= options.range)))
          .map(p => p.instanceId)
      },
      distance: (a: string, b: string) => manhattanDistance(piece(a) as any, piece(b) as any),
      random: <T>(items: readonly T[]): T | null => items.length ? items[Math.floor(getRuleMath().random() * items.length)] : null,
      path: (origin: { x: number; y: number }, direction: { x: number; y: number }, options?: { maxDistance?: number; excludePieceId?: string }) => traceProjectile(battle, origin, direction, options),
    },
    event: {
      read: () => Object.fromEntries(['type','playerId','damage','actualDamage','heal','amount','targetX','targetY','turnNumber'].filter(k => context[k] !== undefined).map(k => [k, context[k]])),
      modify: (field: 'damage' | 'heal' | 'amount' | 'targetX' | 'targetY', value: number) => {
        if (!['damage','heal','amount','targetX','targetY'].includes(field) || typeof context.type !== 'string' || !context.type.startsWith('before')) throw new Error('flow: 只能在before事件修改允许的结果字段')
        context[field] = numeric(value)
      },
      block: (message = '') => ({ success: true, blocked: true, message }),
      emit: (name: string, payload: any) => call('fireEvent', name, payload),
    },
    choice: {
      target: (options: any) => call('selectTarget', options),
      option: (options: any) => call('selectOption', options),
      // Return this descriptor from a rule. The existing pending pipeline owns validation,
      // cancellation and continuation; no closures or runtime facade enter the saved state.
      deferTarget: (options: { playerId: string; title?: string; targetType: 'piece' | 'cell'; candidates: any[]; effectCode: string; payload?: unknown; canCancel?: boolean; selectionMode?: 'single' | 'multi'; minSelections?: number; maxSelections?: number }) => {
        player(options.playerId)
        if (!['piece','cell'].includes(options.targetType) || typeof options.effectCode !== 'string' || !options.effectCode.trim() || !Array.isArray(options.candidates)) throw new Error('flow: 延迟选择参数无效')
        const candidates = json(options.candidates).map((candidate: any) => candidate && typeof candidate === 'object' && candidate.type === undefined ? { ...candidate, type: options.targetType } : candidate), mode = options.selectionMode ?? 'single'
        const min = options.minSelections ?? 1, max = options.maxSelections ?? 1
        if (!['single','multi'].includes(mode) || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 64 || mode === 'single' && max !== 1 || candidates.length < min || candidates.length > 512) throw new Error('flow: 选择数量无效')
        const ids = candidates.map((candidate: any) => {
          if (options.targetType === 'piece' && candidate?.type === 'piece' && typeof candidate.pieceId === 'string' && Object.keys(candidate).every(k => ['type','pieceId'].includes(k))) {
            if (piece(candidate.pieceId).currentHp <= 0) throw new Error('flow: 选择目标已失效')
            return candidate.pieceId
          }
          if (options.targetType === 'cell' && candidate?.type === 'cell' && Number.isInteger(candidate.x) && Number.isInteger(candidate.y) && Object.keys(candidate).every(k => ['type','x','y'].includes(k)) && battle.map.tiles.some(t=>t.x===candidate.x&&t.y===candidate.y)) return candidate.x + ',' + candidate.y
          throw new Error('flow: 候选目标无效')
        })
        if (new Set(ids).size !== ids.length) throw new Error('flow: 候选目标重复')
        return { success: true, needsTargetSelection: true, playerId: options.playerId, title: options.title || '请选择目标',
          targetType: options.targetType, targetCandidates: candidates, effectCode: options.effectCode,
          payload: json(options.payload ?? null), canCancel: options.canCancel ?? true, selectionMode: mode, minSelections: min, maxSelections: max }
      },
    },
    effects: {
      damage: (source: any, targetId: string, amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId()) =>
        call('dealDamage', resolveSource(source), piece(targetId), Math.max(0, numeric(amount)), type, battle, skillId),
      heal: (source: any, targetId: string, amount: number, skillId = effectId()) =>
        call('healDamage', resolveSource(source), piece(targetId), Math.max(0, numeric(amount)), battle, skillId),
      move: (changes: Array<{ pieceId: string; x: number; y: number }>, kind: Parameters<typeof changePiecePositions>[2] = 'teleport') => changePiecePositions(battle, changes, kind),
    },
    status: {
      add: (targetId: string, status: any, scope: 'piece' | 'player' = 'piece') => {
        const definition = { ...json(status), sourceId: status.sourceId ?? holder()?.instanceId ?? context.playerId }
        const rules = Array.isArray(definition.relatedRules) ? definition.relatedRules : []
        // Resolve each rule before modifying state; installation then uses the existing host helpers.
        for (const id of rules) call('validateRule', id)
        const result = call(scope === 'piece' ? 'addStatusEffectById' : 'addPlayerStatusEffectById', targetId, definition)
        if (result !== false) for (const id of rules) call(scope === 'piece' ? 'addRuleById' : 'addPlayerRuleById', targetId, id)
        return result
      },
      remove: (targetId: string, statusId: string, scope: 'piece' | 'player' = 'piece') => call(scope === 'piece' ? 'removeStatusEffectById' : 'removePlayerStatusEffectById', targetId, statusId),
    },
    rules: {
      add: (targetId: string, ruleId: string, scope: 'piece' | 'player' = 'piece') => call(scope === 'piece' ? 'addRuleById' : 'addPlayerRuleById', targetId, ruleId),
      remove: (targetId: string, ruleId: string, scope: 'piece' | 'player' = 'piece') => call(scope === 'piece' ? 'removeRuleById' : 'removePlayerRuleById', targetId, ruleId),
    },
    resources: {
      add: (playerId: string, type: 'actionPoints' | 'chargePoints', amount: number) => {
        if (!['actionPoints','chargePoints'].includes(type)) throw new Error('flow: 无效资源')
        const target = player(playerId), next = target[type] + numeric(amount)
        if (!Number.isFinite(next) || next < 0) throw new Error('flow: 资源必须为非负有限数')
        target[type] = next; return next
      },
    },
    cards: {
      hand: (playerId: string) => player(playerId).hand,
      add: (playerId: string, cardId: string) => call('addCardToHand', cardId, playerId),
      discard: (instanceId: string) => call('discardCard', instanceId),
    },
    attributes: {
      add: (id: string, attribute: 'attack' | 'defense' | 'moveRange', amount: number) => {
        if (!['attack','defense','moveRange'].includes(attribute)) throw new Error('flow: 无效属性')
        const target = piece(id), next = target[attribute] + numeric(amount)
        if (!Number.isFinite(next)) throw new Error('flow: 属性无效')
        target[attribute] = next; return next
      },
      percent: (id: string, attribute: 'attack' | 'defense' | 'moveRange', percent: number) => {
        if (!['attack','defense','moveRange'].includes(attribute)) throw new Error('flow: 无效属性')
        return numeric(piece(id)[attribute] * percent / 100)
      },
    },
    skills: {
      add: (id: string, skillId: string) => call('addSkillById', id, skillId),
      remove: (id: string, skillId: string) => call('removeSkillById', id, skillId),
      resetCooldown: (id: string, skillIds?: string[]) => { for (const skill of piece(id).skills) if (!skillIds || skillIds.includes(skill.skillId)) skill.currentCooldown = 0 },
    },
    lifecycle: {
      summon: (request: any) => {
        if (!context.summonQueue) throw new Error('flow: 召唤需由当前内容声明summonCapability')
        return context.summonQueue.push(request)
      },
      reviveAfterDeath: (attackBonusMultiplier = 0, skillId = effectId()) => {
        const target = holder()
        if (context.type !== 'onPieceDied' || !target || target.currentHp !== 0 || context.sourcePiece?.instanceId !== target.instanceId) throw new Error('flow: 复活结果仅可在持有者正式死亡回调返回')
        if (!Number.isFinite(attackBonusMultiplier) || attackBonusMultiplier < 0) throw new Error('flow: 复活加成无效')
        return { success: true, message: '', summonAfterDeath: { revive: true, attackBonusMultiplier, skillId,
          maxHp: target.maxHp, currentHp: target.maxHp, attack: target.attack, defense: target.defense,
          moveRange: target.moveRange, skillIds: target.skills.map((s: any) => s.skillId) } }
      },
      removeEnemy: (id: string) => {
        if (surface !== 'skill') throw new Error('flow: 强制离场仅提供给主动技能入口')
        return call('forceRemoveEnemyPieceById', id)
      },
    },
    state: {
      get: (scope: 'piece' | 'player' | 'battle', entityId: string, namespace: string, name: string) => {
        stateOwner(scope, entityId); key(namespace); key(name)
        const record = records().find(e => e.scope === scope && e.entityId === entityId && e.namespace === namespace && e.name === name && !expired(e))
        return record ? json(record.value) : undefined
      },
      set: (scope: 'piece' | 'player' | 'battle', entityId: string, namespace: string, name: string, value: unknown, lifetime: 'battle' | 'while-alive' = 'battle') => {
        const ownerPlayerId = stateOwner(scope, entityId); key(namespace); key(name)
        if (!['battle','while-alive'].includes(lifetime) || lifetime === 'while-alive' && scope !== 'piece') throw new Error('flow: extension生命周期无效')
        const copy = json(value)
        const next = records().filter(e => !(e.scope === scope && e.entityId === entityId && e.namespace === namespace && e.name === name) && !expired(e))
        if (next.length >= 4096) throw new Error('flow: extension条目过多')
        next.push({ schemaVersion: 1, scope, entityId, ownerPlayerId, namespace, name, value: copy, lifetime, projectionVisibility: ownerPlayerId ? 'owner' : 'public' })
        battle.extensions ??= {}; battle.extensions.flowState = next
      },
      remove: (scope: 'piece' | 'player' | 'battle', entityId: string, namespace: string, name: string) => {
        stateOwner(scope, entityId); key(namespace); key(name)
        if (battle.extensions) battle.extensions.flowState = records().filter(e => !(e.scope === scope && e.entityId === entityId && e.namespace === namespace && e.name === name))
      },
      cleanup: () => { if (battle.extensions) battle.extensions.flowState = records().filter(e => !expired(e)) },
    },
  }
}
