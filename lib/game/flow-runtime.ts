/* Shared trusted SkillCode facade. Adapters retain authoritative engine semantics. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Legacy SkillCode contexts have distinct dynamic surfaces. */
import type { BattleState } from './turn'
import { changePiecePositions, type PositionChangeOptions } from './position-change'
import { executeFreeMove } from './free-move-effect'
import { traceProjectile, manhattanDistance, traceMovementPath, getLegalSkillLandingCells, getLegalNormalMoveTargets, type MovementTraceOptions, type GridPosition } from './spatial'
import { getRuleMath, getRuleDate } from './rule-runtime'
import { areMatchAllies, nextMatchOpponent } from './match-teams'
import { createSkillPresentation } from './skill-presentation'
import { appendTileEffectsBatch, resolveTileEffectPresentation, type TileEffectPresentationMode } from './charge-crystals'
import { observeProjectilePath } from './battle-presentation-recording'
export type FlowSurface = 'skill' | 'rule' | 'triggerSkill' | 'pending' | 'card'
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
  // Local execution handles retain attribution for an effect already in progress.
  // They never reinsert an entity or permit that departed entity to act again.
  const capturedSources = new WeakMap<object, BattleState['pieces'][number]>()
  const executionCounters = new WeakMap<object, number>()
  const counterValue = (handle: object) => {
    if (!handle || !executionCounters.has(handle)) throw new Error('flow: 计数器不属于当前执行')
    return executionCounters.get(handle)!
  }
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
  const capturedSource = (handle: any) => {
    if (!handle || handle.scope !== 'execution-source' || typeof handle.id !== 'string' || Object.keys(handle).some(key => !['scope', 'id'].includes(key))) throw new Error('flow: 无效结算来源句柄')
    const source = capturedSources.get(handle)
    if (!source) throw new Error('flow: 结算来源不属于当前执行')
    return source
  }
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
    log: {
      triggerEffect: (playerId: string, message: string) => {
        player(playerId)
        if (typeof message !== 'string') throw new Error('flow: 日志消息必须为文本')
        battle.actions ??= []
        battle.actions.push({ type: 'triggerEffect', playerId, turn: battle.turn ? battle.turn.turnNumber : 0, payload: { message } })
        return true
      },
    },
    execution: {
      counter: (initial: number) => {
        if (!Number.isFinite(initial)) throw new Error('flow: 数值必须有限')
        const handle = { scope: 'execution-counter' }
        executionCounters.set(handle, initial)
        return handle
      },
      readCounter: counterValue,
      addCounter: (handle: object, amount: number) => {
        const next = counterValue(handle) + amount
        if (!Number.isFinite(amount) || !Number.isFinite(next)) throw new Error('flow: 数值必须有限')
        executionCounters.set(handle, next)
        return next
      },
    },
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
      players: () => battle.players.map(owner => owner.playerId),
      piece, player,
      alliedPlayers: (left: string, right: string) => areMatchAllies(battle, left, right),
      // Module execution can invalidate one dependency without aborting later,
      // independent nodes. These probes never expose mutable entities.
      hasPiece: (id: unknown) => typeof id === 'string' && battle.pieces.some(p => p.instanceId === id),
      hasPlayer: (id: unknown) => typeof id === 'string' && battle.players.some(p => p.playerId === id),
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
      path: (origin: { x: number; y: number }, direction: { x: number; y: number }, options?: { maxDistance?: number; excludePieceId?: string }) => observeProjectilePath(origin, direction, options, traceProjectile(battle, origin, direction, options)),
      normalMoveTargets: (pieceId: string) => getLegalNormalMoveTargets(battle, piece(pieceId)),
      tracePath: (origin: GridPosition, direction: GridPosition, options: MovementTraceOptions) => traceMovementPath(battle, origin, direction, options),
      landingCells: (candidates: GridPosition[], movingPieceIds: string[] = []) => getLegalSkillLandingCells(battle, candidates, {
        movingPieceIds, reservedCells: surface === 'skill' ? [] : context.reservedCells ?? [],
      }),
    },
    event: {
      read: () => Object.fromEntries(['type','playerId','damage','actualDamage','heal','amount','targetX','targetY','turnNumber',
        'movementKind','fromX','fromY','pathCells','contactCells'].filter(k => context[k] !== undefined).map(k => [k, json(context[k])])),
      modify: (field: 'damage' | 'heal' | 'amount' | 'targetX' | 'targetY', value: number, inputPolicy: 'floor' | 'host' = 'floor') => {
        if (!['damage','heal','amount','targetX','targetY'].includes(field) || typeof context.type !== 'string' || !context.type.startsWith('before')) throw new Error('flow: 只能在before事件修改允许的结果字段')
        const permissions: Record<string, readonly string[]> = {
          damage: ['beforeDamageDealt', 'beforeDamageTaken', 'beforeDamageRedirect', 'beforeDamageShield', 'beforeDamageApplied'],
          heal: ['beforeHealDealt', 'beforeHealTaken'],
          targetX: ['beforeMove', 'beforeSkillUse', 'beforePiecePositionChange'],
          targetY: ['beforeMove', 'beforeSkillUse', 'beforePiecePositionChange'],
          amount: [],
        }
        if (!permissions[field].includes(context.type)) throw new Error('flow: 当前事件不允许改写该结果字段')
        if (!['floor', 'host'].includes(inputPolicy) || !Number.isFinite(value)) throw new Error('flow: 无效事件数值策略')
        context[field] = inputPolicy === 'host' ? value : numeric(value)
      },
      block: (message = '') => ({ success: true, blocked: true, message }),
      emit: (name: string, payload: any) => call('fireEvent', name, payload),
    },
    choice: {
      statusTags: (targetId: string, title?: string) => {
        const tags = piece(targetId).statusTags || []
        const options = tags.map((tag, index) => ({ label: (tag.name || tag.type || '效果') + '（' + (index + 1) + '）', value: String(index) }))
        options.push({ label: '不移除效果', value: 'none' })
        return call('selectOption', { ...(title === undefined ? {} : { title }), options, canCancel: true, cancelValue: 'none' })
      },
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
      captureEventPiece: (field: 'sourcePiece' | 'targetPiece' | 'piece' | 'rulePiece') => {
        if (!['sourcePiece', 'targetPiece', 'piece', 'rulePiece'].includes(field)) throw new Error('flow: 无效事件棋子字段')
        const source = context[field]
        if (!source) return null
        if (typeof source.instanceId !== 'string') throw new Error('flow: 无效事件棋子')
        const handle = { scope: 'execution-source', id: source.instanceId }
        capturedSources.set(handle, source)
        return handle
      },
      removeCapturedRule: (handle: any, ruleId: string) => {
        key(ruleId)
        const source = capturedSource(handle)
        source.rules = (source.rules || []).filter(rule => rule.id !== ruleId)
        return true
      },
      queueDamageCaptured: (sourceHandle: any, targetHandle: any, amount: number, type: 'physical' | 'magical' | 'true', skillId: string) => {
        if (!Number.isFinite(amount) || !['physical', 'magical', 'true'].includes(type)) throw new Error('flow: 无效队列伤害')
        key(skillId)
        const attacker = capturedSource(sourceHandle), target = capturedSource(targetHandle)
        if (!context.damageQueue || typeof context.damageQueue.push !== 'function') throw new Error('flow: 当前事件不支持伤害队列')
        context.damageQueue.push({ attacker, target, damage: amount, damageType: type, skillId })
        return true
      },
      capturedOwner: (handle: any) => capturedSource(handle).ownerPlayerId,
      capturedNoKillCharge: (handle: any) => Boolean((capturedSource(handle) as { noKillCharge?: boolean }).noKillCharge),
      capturedMaxHp: (handle: any, fallback: number) => {
        if (!Number.isFinite(fallback)) throw new Error('flow: 无效生命上限回退')
        const source = capturedSource(handle) as any
        return Number(source.maxHp || (source.stats && source.stats.maxHp) || fallback)
      },
      capturedIdentifier: (handle: any) => capturedSource(handle).instanceId,
      capturedHasStatus: (handle: any, statusType: string) => {
        if (typeof statusType !== 'string' || !statusType) throw new Error('flow: 无效状态类型')
        return capturedSource(handle).statusTags.some(tag => tag.type === statusType)
      },
      capturedNumber: (handle: any, field: 'attack' | 'defense' | 'moveRange' | 'currentHp' | 'maxHp') => {
        if (!['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'].includes(field)) throw new Error('flow: 无效来源数值字段')
        return Number(capturedSource(handle)[field])
      },
      damageCaptured: (source: any, target: any, amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId()) => {
        if (!Number.isFinite(amount) || !['physical', 'magical', 'true'].includes(type)) throw new Error('flow: 无效伤害参数')
        return call('dealDamage', capturedSource(source), capturedSource(target), amount, type, battle, skillId)
      },
      captureSource: (sourceId: string) => {
        const source = piece(sourceId)
        const handle = { scope: 'execution-source', id: sourceId }
        capturedSources.set(handle, source)
        return handle
      },
      capturedAttribute: (handle: any, attribute: 'attack' | 'defense' | 'moveRange', amount: number) => {
        if (!['attack', 'defense', 'moveRange'].includes(attribute) || !Number.isFinite(amount)) throw new Error('flow: 无效结算属性')
        const source = capturedSource(handle)
        source[attribute] += amount
        return source[attribute]
      },
      capturedName: (handle: any, fallback: 'none' | 'templateId' = 'none') => {
        if (!['none', 'templateId'].includes(fallback)) throw new Error('flow: 无效名称回退')
        const source = capturedSource(handle)
        return String(fallback === 'templateId' ? source.name || source.templateId : source.name)
      },
      damageManyCaptured: (handle: any, targetIds: string[], amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId()) => {
        if (!Number.isFinite(amount) || !['physical', 'magical', 'true'].includes(type)) throw new Error('flow: 无效伤害参数')
        return call('dealDamage', capturedSource(handle), targetIds.map(piece), amount, type, battle, skillId)
      },
      healManyCaptured: (handle: any, targetIds: string[], amount: number, skillId = effectId()) => {
        if (!Number.isFinite(amount)) throw new Error('flow: 数值必须有限')
        return call('healDamage', capturedSource(handle), targetIds.map(piece), amount, battle, skillId)
      },
      damageWithKiller: (sourceId: string, targetId: string, amount: number, type: 'physical' | 'true' | 'toxin', skillId: string, killerPlayerId: string | null, inputPolicy: 'floor' | 'host' = 'floor') => {
        if (!['floor', 'host'].includes(inputPolicy) || !Number.isFinite(amount) || !['physical', 'true', 'toxin'].includes(type)) throw new Error('flow: 无效伤害参数')
        if (killerPlayerId !== null) player(killerPlayerId)
        return call('dealDamage', piece(sourceId), piece(targetId), inputPolicy === 'host' ? amount : numeric(amount), type, battle, skillId, false, killerPlayerId)
      },
      damageMany: (sourceId: string, targetIds: string[], amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId()) => {
        if (!Number.isFinite(amount)) throw new Error('flow: 数值必须有限')
        return call('dealDamage', piece(sourceId), targetIds.map(piece), amount, type, battle, skillId)
      },
      healMany: (sourceId: string, targetIds: string[], amount: number, skillId = effectId()) => {
        if (!Number.isFinite(amount)) throw new Error('flow: 数值必须有限')
        return call('healDamage', piece(sourceId), targetIds.map(piece), amount, battle, skillId)
      },
      freeMove: (pieceId: string, destination: GridPosition) => executeFreeMove(battle, pieceId, destination,
        surface === 'skill' ? [] : context.reservedCells ?? []),
      damage: (source: any, targetId: string, amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId(), inputPolicy: 'floor' | 'host' = 'floor') => {
        if (inputPolicy !== 'floor' && inputPolicy !== 'host') throw new Error('flow: 无效伤害输入策略')
        if (!Number.isFinite(amount)) throw new Error('flow: 数值必须有限')
        // Legacy dealDamage content lets beforeDamageDealt observe the original
        // amount. Preserve that timing; the authoritative host validates and rounds.
        return call('dealDamage', resolveSource(source), piece(targetId), inputPolicy === 'host' ? amount : Math.max(0, numeric(amount)), type, battle, skillId)
      },
      heal: (source: any, targetId: string, amount: number, skillId = effectId()) =>
        call('healDamage', resolveSource(source), piece(targetId), Math.max(0, numeric(amount)), battle, skillId),
      move: (changes: Array<{ pieceId: string; x: number; y: number }>, kind: Parameters<typeof changePiecePositions>[2] = 'teleport', path?: PositionChangeOptions['path']) => {
        return changePiecePositions(battle, changes, kind, { path,
          reservedCells: surface === 'skill' ? [] : context.reservedCells ?? [] })
      },
      // Explicit skill displacement. Unlike the legacy `move` facade this name
      // makes it clear that the action is a position change, not a normal move.
      displace: (changes: Array<{ pieceId: string; x: number; y: number }>, kind: Parameters<typeof changePiecePositions>[2] = 'dash', path?: PositionChangeOptions['path']) => {
        return changePiecePositions(battle, changes, kind, { path,
          reservedCells: surface === 'skill' ? [] : context.reservedCells ?? [] })
      },
      tileBatch: (effects: readonly Record<string, unknown>[], presentationOrOptions?: TileEffectPresentationMode | { presentation?: TileEffectPresentationMode; origin?: { x: number; y: number } }) => {
        if (!Array.isArray(effects)) throw new Error('flow: 地格效果批次必须是数组')
        const options = typeof presentationOrOptions === 'object' && presentationOrOptions !== null ? presentationOrOptions : { presentation: presentationOrOptions }
        const mode = resolveTileEffectPresentation(options.presentation)
        const xs = effects.map(effect => Number(effect?.x)), ys = effects.map(effect => Number(effect?.y))
        if (effects.length && (xs.some(value => !Number.isFinite(value)) || ys.some(value => !Number.isFinite(value)))) throw new Error('flow: 地格效果坐标无效')
        const centerX = options.origin && Number.isFinite(options.origin.x) ? options.origin.x : (Math.min(...xs) + Math.max(...xs)) / 2
        const centerY = options.origin && Number.isFinite(options.origin.y) ? options.origin.y : (Math.min(...ys) + Math.max(...ys)) / 2
        const normalized = effects.map(effect => {
          if (!effect || typeof effect !== 'object') throw new Error('flow: 地格效果无效')
          return { ...json(effect), presentation: mode,
            presentationStep: mode === 'expand' ? Math.max(Math.abs(Number(effect.x) - centerX), Math.abs(Number(effect.y) - centerY)) : 0 }
        })
        return appendTileEffectsBatch(battle, normalized)
      },
      clearTileMarkers: (tileType: string, sourceId: string) => {
        if (typeof tileType !== 'string' || typeof sourceId !== 'string') throw new Error('flow: 地格标记条件无效')
        if (battle.extensions && Array.isArray(battle.extensions.tileEffects)) {
          battle.extensions.tileEffects = battle.extensions.tileEffects.filter(effect => !(
            effect && effect.tileType === tileType && effect.sourceId === sourceId
          ))
        }
        return true
      },
      destroyWalls: (cells: readonly { x: number; y: number }[], options: { includeCover?: boolean } = {}) => {
        if (!Array.isArray(cells)) throw new Error('flow: 破墙目标必须是数组')
        const includeCover = options.includeCover !== false
        const changedCells: Array<{ x: number; y: number }> = []
        const seen = new Set<string>()
        for (const cell of cells) {
          if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) throw new Error('flow: 破墙坐标无效')
          const id = `${cell.x},${cell.y}`
          if (seen.has(id)) continue
          seen.add(id)
          const tile = battle.map.tiles.find(candidate => candidate.x === cell.x && candidate.y === cell.y)
          if (!tile) continue
          const type = tile.props?.type
          if (type !== 'wall' && !(includeCover && type === 'cover')) continue
          tile.props = { type: 'floor', walkable: true, bulletPassable: true }
          changedCells.push({ x: tile.x, y: tile.y })
        }
        return { success: true, changedCells }
      },
    },
    status: {
      removePlayerRecords: (playerId: string, statusType: string) => {
        const owner = player(playerId)
        const previous = owner.statusTags ?? []
        owner.statusTags = previous.filter(tag => tag.type !== statusType)
        return previous.length - owner.statusTags.length
      },
      removeRaw: (targetId: string, selector: 'id' | 'type', value: string) => {
        if (!['id', 'type'].includes(selector) || typeof value !== 'string') throw new Error('flow: 无效状态移除条件')
        const tags = piece(targetId).statusTags
        const index = tags?.findIndex(tag => tag && typeof tag === 'object' && tag[selector] === value) ?? -1
        if (index < 0) return false
        tags!.splice(index, 1)
        return true
      },
      count: (targetId: string) => (piece(targetId).statusTags || []).length,
      generatedId: (targetId: string, prefix: string) => prefix + piece(targetId).instanceId + '-' + getRuleDate().now(),
      appendRaw: (targetId: string, record: any) => {
        const payload = json(record)
        if (!payload || Array.isArray(payload) || typeof payload !== 'object' || typeof payload.id !== 'string' || typeof payload.type !== 'string') throw new Error('flow: 无效状态记录')
        const target = piece(targetId); target.statusTags ??= []; target.statusTags.push(payload)
        return true
      },
      removeChoice: (targetId: string, choice: unknown) => {
        const target = piece(targetId); target.statusTags ??= []
        if (choice === 'none' || choice === undefined) return { valid: true, removed: false, name: '' }
        const index = Number(choice)
        if (!Number.isInteger(index) || index < 0 || index >= target.statusTags.length) return { valid: false, removed: false, name: '' }
        const [removed] = target.statusTags.splice(index, 1)
        return { valid: true, removed: true, name: removed.name || removed.type || '一个效果' }
      },
      refreshTemporary: (targetId: string, options: { type: string; name: string; idPrefix: string; turn: number; duration: number; uses: number; visible: boolean }) => {
        if (![options.turn, options.duration, options.uses].every(Number.isFinite)) throw new Error('flow: 临时状态计数无效')
        const target = piece(targetId); target.statusTags ??= []
        let tag = target.statusTags.find(tag => tag.type === options.type)
        if (!tag) {
          tag = { id: options.idPrefix + target.instanceId, type: options.type, name: options.name, visible: options.visible }
          target.statusTags.push(tag)
        }
        Object.assign(tag, { grantedTurnNumber: options.turn, currentDuration: options.duration, currentUses: options.uses, remainingUses: options.uses, createdTurnNumber: options.turn })
        return true
      },
      refreshPosition: (targetId: string, statusType: string, x: number, y: number, duration: number) => {
        if (typeof statusType !== 'string' || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(duration) || duration < -1) {
          throw new Error('flow: 位置状态参数无效')
        }
        const tag = piece(targetId).statusTags?.find(item => item.type === statusType)
        if (!tag) return false
        tag.value = x
        tag.intensity = y
        tag.remainingDuration = duration
        return true
      },
      consumeCounter: (targetId: string, statusId: string | null, field: 'remainingTurns', fallback = 1) => {
        if (field !== 'remainingTurns' || !Number.isFinite(fallback)) throw new Error('flow: 无效状态计数器')
        const tag = piece(targetId).statusTags?.find(tag => tag.id === statusId)
        if (!tag) return fallback
        const current = tag[field] === undefined ? fallback : tag[field]
        if (typeof current !== 'number' || !Number.isFinite(current)) throw new Error('flow: 无效状态计数值')
        tag[field] = current - 1
        return tag[field]
      },
      setNumber: (targetId: string, statusId: string, field: string, value: number) => {
        if (!['stacks','intensity','value'].includes(field) || !Number.isFinite(value)) throw new Error('flow: 无效状态数值字段')
        const tag = piece(targetId).statusTags?.find(tag => tag.id === statusId)
        if (!tag) return false
        ;(tag as any)[field] = value
        return true
      },
      add: (targetId: string, status: any, scope: 'piece' | 'player' = 'piece', inputPolicy: 'flow' | 'host' = 'flow') => {
        if (!['flow', 'host'].includes(inputPolicy)) throw new Error('flow: 无效状态输入策略')
        // Legacy helper calls retain their exact origin fields and explicit rule-install order.
        if (inputPolicy === 'host') return call(scope === 'piece' ? 'addStatusEffectById' : 'addPlayerStatusEffectById', targetId, json(status))
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
      setPlayerBuff: (playerId: string, buffId: string, record: Record<string, unknown>) => {
        const owner = player(playerId) as any
        key(buffId)
        const copy = json(record)
        if (!copy || Array.isArray(copy) || typeof copy !== 'object') throw new Error('flow: 玩家增益必须为记录')
        owner.buffs ??= {}
        owner.buffs[buffId] = copy
        return true
      },
      hand: (playerId: string) => player(playerId).hand,
      add: (playerId: string, cardId: string) => call('addCardToHand', cardId, playerId),
      discard: (instanceId: string) => call('discardCard', instanceId),
    },
    content: {
      enemyPlayer: (ownerId: string | null) => ownerId == null ? null : nextMatchOpponent(battle, ownerId) ?? null,
      filterHand: (playerId: string | null, options: { nameContains?: string | null; cardIdPrefix?: string | null }) => {
        const owner = battle.players.find(item => item.playerId === playerId)
        if (!owner?.hand) return { cards: [], hasHand: false }
        return { cards: owner.hand.filter(card => (options.nameContains != null && card.name?.includes(options.nameContains)) || (options.cardIdPrefix != null && card.cardId?.startsWith(options.cardIdPrefix))).map(card => card.cardId), hasHand: true }
      },
      copyCard: (sourceId: string, prefix: string, index: number) => {
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('flow: 无效卡牌复制序号')
        battle.customCards ??= {}
        const source = battle.customCards[sourceId]
        if (!source) return { cardId: sourceId, copied: false }
        const cardId = prefix + getRuleDate().now() + '-' + index
        battle.customCards[cardId] = { ...json(source), id: cardId }
        return { cardId, copied: true }
      },
      materializeTemplate: (options: { kind: 'card'; templateId: string; cardId: string; name: string; description: string; owner?: string | null }) => {
        if (options.kind !== 'card') throw new Error('flow: 不支持的内容模板类型')
        key(options.templateId); key(options.cardId)
        const template = call('loadCardDefinition', options.templateId)
        if (!template?.gameplayModules?.entries?.code) throw new Error('flow: 卡牌模板必须提供已验证模块图')
        battle.customCards ??= {}
        battle.customCards[options.cardId] = { ...json(template), id: options.cardId, name: options.name, description: options.description }
        return { cardId: options.cardId, success: true }
      },
    },
    attributes: {
      setCurrentHp: (id: string, value: number) => {
        const target = piece(id)
        if (!Number.isFinite(value) || value <= 0 || target.currentHp <= 0) throw new Error('flow: 无事件生命写入不能执行死亡或复活')
        target.currentHp = value
        return value
      },
      set: (id: string, attribute: 'attack' | 'defense' | 'moveRange', value: number) => {
        if (!['attack','defense','moveRange'].includes(attribute)) throw new Error('flow: 无效属性')
        if (!Number.isFinite(value)) throw new Error('flow: 属性无效')
        piece(id)[attribute] = value
        return value
      },
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
      wasSpent: (id: string, abilityId: string) => (piece(id).spentPassives || []).includes(abilityId),
      markSpent: (id: string, abilityId: string) => {
        key(abilityId)
        const target = piece(id)
        target.spentPassives = (target.spentPassives || []).concat([abilityId])
      },
      adjustCooldown: (id: string, skillId: string | null, amount: number, mode: 'add' | 'atLeast') => {
        if (!['add', 'atLeast'].includes(mode) || !Number.isFinite(amount)) throw new Error('flow: 无效冷却调整')
        const skill = piece(id).skills?.find(skill => skill.skillId === skillId)
        if (!skill) return false
        const current = skill.currentCooldown || 0
        skill.currentCooldown = mode === 'add' ? current + amount : Math.max(current, amount)
        return true
      },
      add: (id: string, skillId: string) => call('addSkillById', id, skillId),
      remove: (id: string, skillId: string) => call('removeSkillById', id, skillId),
      resetCooldown: (id: string, skillIds?: string[]) => { for (const skill of piece(id).skills) if (!skillIds || skillIds.includes(skill.skillId)) skill.currentCooldown = 0 },
    },
    lifecycle: {
      summonCaptured: (handle: any, cell: GridPosition) => {
        const source = capturedSource(handle)
        if (!context.summonQueue) throw new Error('flow: 召唤需由当前内容声明summonCapability')
        if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) throw new Error('flow: 无效召唤地格')
        return context.summonQueue.push({ sourceId: source.instanceId, summons: [{ x: cell.x, y: cell.y }] })
      },
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
      getPlayerNumber: (path: string, playerId: string) => {
        player(playerId); key(playerId)
        if (!['contentCounters', 'contentCounters.elPrimoChargeDiscount'].includes(path)) throw new Error('flow: 未注册玩家计数路径')
        const counters = battle.extensions?.contentCounters as Record<string, any> | undefined
        return Number((path === 'contentCounters' ? counters?.[playerId] : counters?.elPrimoChargeDiscount?.[playerId]) || 0)
      },
      setPlayerNumber: (path: string, playerId: string, value: number) => {
        player(playerId); key(playerId)
        if (!['contentCounters', 'contentCounters.elPrimoChargeDiscount'].includes(path)) throw new Error('flow: 未注册玩家计数路径')
        if (!Number.isFinite(value)) throw new Error('flow: 数值必须有限')
        battle.extensions ??= {}
        const counters = (battle.extensions.contentCounters ??= {}) as Record<string, any>
        if (path === 'contentCounters') counters[playerId] = value
        else (counters.elPrimoChargeDiscount ??= {})[playerId] = value
        return true
      },
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
