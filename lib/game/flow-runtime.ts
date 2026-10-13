/* Shared trusted SkillCode facade. Adapters retain authoritative engine semantics. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Legacy SkillCode contexts have distinct dynamic surfaces. */
import type { BattleState } from './turn'
import { changePiecePositions, type PositionChangeOptions } from './position-change'
import { executeFreeMove } from './free-move-effect'
import { traceProjectile, manhattanDistance, traceMovementPath, getLegalSkillLandingCells, getLegalNormalMoveTargets, type MovementTraceOptions, type GridPosition } from './spatial'
import { getRuleMath, getRuleDate } from './rule-runtime'
import { areMatchAllies, getMatchFactionKey, nextMatchOpponent } from './match-teams'
import { createSkillPresentation } from './skill-presentation'
import { appendTileEffectsBatch, resolveTileEffectPresentation, type TileEffectPresentationMode } from './charge-crystals'
import { createBattlePresentationQueue, observeProjectilePath } from './battle-presentation-recording'
import { createAuthorExtensionRuntime, requireAuthorValue, type AuthorValueDeclaration } from './author-extension'
import {
  createAuthorEntityExtensionRuntime,
  type AuthorEntityExtensionTarget,
  type AuthorEntityKind,
} from './author-entity-extension'
import { capturePieceInstance, applyPieceInstance, preserveDepartingPiece } from './author-instance-state'
import { createAuthorChoiceRuntime } from './author-choice-runtime'
import { createAuthorEffects } from './author-effects'
import { getActiveEffectChain } from './effect-batch'
import { parseAuthoredSummonSpec, type AuthoredPieceTemplate, type AuthoredDisplaySpec } from './author-summon-schema'
import { ENGINE_EXTENSION_FIELDS } from './engine-extension-fields'
import { createExecutionLocalRuntime } from './execution-local-runtime'
import { recordDirectSkillAdded, recordDirectSkillRemoved, recordDirectRuleAdded, recordDirectRuleRemoved, type AuthorClusterDefinition } from './author-clusters'
import * as authorContainers from './author-containers'
import { findPieceSkillInstance, type PieceInstance, type PieceStatusIdentityLedger } from './piece'
export type FlowSurface = 'skill' | 'rule' | 'triggerSkill' | 'pending' | 'card'
type Delegate = Record<string, (...args: any[]) => any>

type RuleReference = { targetId: string; targetKind: 'piece' | 'player'; rule: any }
type CardReference = { ownerPlayerId: string; card: any }
type ClusterReference = { pieceId: string; group: any }
type TileEffectReference = { effect: any }
type StatusIdentityLedger = PieceStatusIdentityLedger
type StatusIdentityHolder = {
  statusTags?: any[]
  statusIdentityLedger?: StatusIdentityLedger
}

function statusIdentityLedger(
  holder: StatusIdentityHolder,
  create: boolean,
): StatusIdentityLedger | undefined {
  const existing = holder.statusIdentityLedger
  if (existing === undefined) {
    if (!create) return undefined
    const created: StatusIdentityLedger = { active: [], retired: [], next: 0 }
    holder.statusIdentityLedger = created
    return created
  }
  if (!existing || typeof existing !== 'object'
    || !Array.isArray(existing.active) || !Array.isArray(existing.retired)
    || !Number.isSafeInteger(existing.next) || existing.next < 0
    || existing.active.some(id => typeof id !== 'string' || id.length === 0)
    || existing.retired.some(id => typeof id !== 'string' || id.length === 0)) {
    throw new Error('flow: 状态实例身份记录无效')
  }
  const active = new Set(existing.active)
  const retired = new Set(existing.retired)
  if (active.size !== existing.active.length || retired.size !== existing.retired.length
    || existing.active.some(id => retired.has(id))) {
    throw new Error('flow: 状态实例身份记录重复')
  }
  return existing
}

function retireStatusIdentity(holder: StatusIdentityHolder, instanceId: string): void {
  const ledger = statusIdentityLedger(holder, false)
  if (!ledger) return
  if (!ledger.active.includes(instanceId)) return
  ledger.active = ledger.active.filter(id => id !== instanceId)
  if (!ledger.retired.includes(instanceId)) ledger.retired.push(instanceId)
}

/** Mark legacy IDs whose bound status disappeared before a new flow started. */
function reconcileStatusIdentityLedger(holder: StatusIdentityHolder): void {
  const ledger = statusIdentityLedger(holder, false)
  if (!ledger) return
  const current = new Set((holder.statusTags || []).flatMap(status => (
    status && typeof status.instanceId === 'string' ? [status.instanceId] : []
  )))
  const missing = ledger.active.filter(instanceId => !current.has(instanceId))
  if (missing.length === 0) return
  ledger.active = ledger.active.filter(instanceId => current.has(instanceId))
  for (const instanceId of missing) {
    if (!ledger.retired.includes(instanceId)) ledger.retired.push(instanceId)
  }
}

/** Called at formal removal; revival creates a new incarnation. */
export function clearRemovedPieceFlowState(battle: BattleState, ids: readonly string[]): void {
  if (Array.isArray(battle.extensions?.flowState)) battle.extensions!.flowState = battle.extensions!.flowState.filter(
    entry => !(entry?.schemaVersion === 1 && entry.scope === 'piece' && entry.lifetime === 'while-alive' && ids.includes(entry.entityId)),
  )
}
const numeric = (value: number) => { if (!Number.isFinite(value)) throw new Error('flow: 数值必须有限'); return Math.floor(value) }
const key = (value: string) => { if (typeof value !== 'string' || !/^[\p{L}\p{N}_.:-]{1,120}$/u.test(value) || ['__proto__','prototype','constructor'].includes(value)) throw new Error('flow: 无效标识符'); return value }
function json(value: unknown, maxBytes = 65536): any {
  const seen = new Set<object>()
  const walk = (item: unknown, depth: number): void => {
    if (depth > 40) throw new Error('flow: extension嵌套过深')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || !item || seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw new Error('flow: extension仅允许有限JSON值')
    seen.add(item)
    if (Object.getOwnPropertySymbols(item).length) throw new Error('flow: extension不允许Symbol属性')
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('flow: extension数组必须连续且不含额外属性')
    for (const [name, property] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && name === 'length') continue
      if (!('value' in property) || !property.enumerable || ['__proto__','constructor','prototype'].includes(name)
        || Array.isArray(item) && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= item.length)) throw new Error('flow: extension包含不允许的属性')
      walk(property.value, depth + 1)
    }
    seen.delete(item)
  }
  walk(value, 0)
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error(maxBytes === 65536 ? 'flow: extension超过64KB' : 'flow: 内容模板超过大小限制')
  return JSON.parse(encoded)
}

type StructuredLogSchemaField = {
  readonly name?: unknown
  readonly type?: unknown
  readonly optional?: unknown
  readonly nullable?: unknown
}
const RESERVED_STRUCTURED_LOG_TYPES = new Set([
  'damage',
  'damageDealt',
  'damageTaken',
  'damageResolved',
])

function structuredLogPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function structuredLogTypeMatches(value: unknown, type: unknown, depth = 0): boolean {
  if (depth > 16) return false
  if (typeof type === 'string') {
    if (type === 'string' || type === 'piece' || type === 'player' || type === 'card' || type === 'content' || type === 'event') return typeof value === 'string'
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (type === 'boolean') return typeof value === 'boolean'
    if (type === 'null') return value === null
    if (type === 'record') return structuredLogPlainRecord(value)
    return false
  }
  if (!structuredLogPlainRecord(type) || typeof type.kind !== 'string') return false
  if (type.kind === 'nullable') return value === null || structuredLogTypeMatches(value, type.value, depth + 1)
  if (type.kind === 'list' || type.kind === 'set') return Array.isArray(value) && value.every(item => structuredLogTypeMatches(item, type.element, depth + 1))
  if (type.kind === 'map') return structuredLogPlainRecord(value)
  if (type.kind === 'record') return structuredLogPlainRecord(value)
  return false
}

function validateStructuredLogPayload(value: unknown, schema: unknown): Record<string, unknown> {
  if (!structuredLogPlainRecord(schema)
    || typeof schema.id !== 'string' || schema.id.length === 0
    || typeof schema.version !== 'string' || schema.version.length === 0
    || !Array.isArray(schema.fields)) throw new Error('flow: 结构化日志载荷类型声明无效')
  if (!structuredLogPlainRecord(value)) throw new Error('flow: 结构化日志载荷必须为记录')
  const fields = schema.fields as readonly StructuredLogSchemaField[]
  const declared = new Map<string, StructuredLogSchemaField>()
  for (const field of fields) {
    if (typeof field?.name !== 'string' || field.name.length === 0
      || ['__proto__', 'prototype', 'constructor'].includes(field.name)
      || declared.has(field.name) || !Object.prototype.hasOwnProperty.call(field, 'type')) {
      throw new Error('flow: 结构化日志载荷字段声明无效')
    }
    declared.set(field.name, field)
  }
  for (const name of Object.keys(value)) {
    if (!declared.has(name)) throw new Error('flow: 结构化日志载荷包含未声明字段 ' + name)
  }
  for (const [name, field] of declared) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      if (field.optional !== true) throw new Error('flow: 结构化日志载荷缺少字段 ' + name)
      continue
    }
    const expected = field.nullable === true ? { kind: 'nullable', value: field.type } : field.type
    if (!structuredLogTypeMatches(value[name], expected)) throw new Error('flow: 结构化日志载荷字段类型错误 ' + name)
  }
  return json(value)
}

export function createFlowRuntime(battle: BattleState, context: any, surface: FlowSurface, delegates: Delegate) {
  // Local execution handles retain attribution for an effect already in progress.
  // They never reinsert an entity or permit that departed entity to act again.
  const capturedSources = new WeakMap<object, BattleState['pieces'][number]>()
  const executionCounters = new WeakMap<object, number>()
  // Status records often predate the id-based content API and therefore do
  // not carry an id. Keep a reference to the exact host object selected by a
  // graph execution instead of looking it up by type again on every read/write.
  // The handle remains an execution-local capability; its enumerable identity
  // fields only make JSON persistence of a captured reference possible.
  const statusReferences = new WeakMap<object, { pieceId: string; ownerKind?: 'piece' | 'player'; tag: any }>()
  // Keep the exact object claim local to this execution. The durable ledger
  // on the PieceInstance carries status identity across flow facades and save
  // restore, so no process-global identity store is needed.
  const statusIdentityClaims = new Map<string, object>()
  const statusClaimKey = (ownerKind: 'piece' | 'player', ownerId: string, instanceId: string) => (
    `${ownerKind}\u0000${ownerId}\u0000${instanceId}`
  )
  // Reconcile only an already-present ledger. Legacy execution-local reads
  // stay mutation-free; a ledger exists only after a serialized status capture
  // has established a durable identity boundary.
  for (const candidate of battle.pieces) reconcileStatusIdentityLedger(candidate)
  for (const candidate of battle.players) reconcileStatusIdentityLedger(candidate)
  // Skill instance handles are execution-local references to the exact entry
  // in a piece's runtime skill array.  Keeping the object identity prevents a
  // duplicate skill definition from being retargeted by id, and also rejects
  // forged or cross-execution handles before any field read/write.
  const skillReferences = new WeakMap<object, { pieceId: string; index: number; skill: any }>()
  // Other concrete instances use the same execution-local identity boundary.
  // Pending continuations re-create these handles from their serialized IDs.
  const ruleReferences = new WeakMap<object, RuleReference>()
  const cardReferences = new WeakMap<object, CardReference>()
  const clusterReferences = new WeakMap<object, ClusterReference>()
  const tileEffectReferences = new WeakMap<object, TileEffectReference>()
  const executionLocals = createExecutionLocalRuntime(value => capturedSources.has(value)
    || executionCounters.has(value)
    || statusReferences.has(value)
    || skillReferences.has(value)
    || ruleReferences.has(value)
    || cardReferences.has(value)
    || clusterReferences.has(value)
    || tileEffectReferences.has(value))
  const counterValue = (handle: object) => {
    if (!handle || !executionCounters.has(handle)) throw new Error('flow: 计数器不属于当前执行')
    return executionCounters.get(handle)!
  }
  const piece = (id: string) => {
    const found = battle.pieces.find(p => p.instanceId === id)
    if (!found) throw new Error('flow: 棋子不存在 ' + id)
    return found
  }
  const findPieceIncludingGraveyard = (id: string) => battle.pieces.find(p => p.instanceId === id)
    ?? battle.graveyard?.find(p => p.instanceId === id)
  const player = (id: string) => {
    const found = battle.players.find(p => p.playerId === id)
    if (!found) throw new Error('flow: 玩家不存在 ' + id)
    return found
  }
  const textField = (entity: { name?: unknown; ownerPlayerId?: unknown; playerId?: unknown }, field: unknown) => {
    if (field === 'name') return String(entity.name ?? '')
    if (field === 'faction') {
      const owner = entity.ownerPlayerId ?? entity.playerId
      if (typeof owner !== 'string') throw new Error('flow: 文本字段缺少所属玩家')
      return getMatchFactionKey(battle, owner)
    }
    throw new Error('flow: 无效文本字段')
  }
  const pieceText = (id: string, field: unknown) => textField(piece(id), field)
  const playerText = (id: string, field: unknown) => textField(player(id), field)
  const holder = () => surface === 'skill' ? context.piece : context.rulePiece
  const authorChoice = createAuthorChoiceRuntime(battle, context, surface, holder)
  const call = (name: string, ...args: any[]) => {
    if (typeof delegates[name] !== 'function') throw new Error('flow: ' + surface + '入口未提供 ' + name + '，不得用空桩继续执行')
    return delegates[name](...args)
  }
  const resolveSource = (source: any) => typeof source === 'string' ? piece(source) : source
  const authorEffects = createAuthorEffects(battle, context, {
    prepare: (kind, amount) => call('prepareAuthorEffect', kind, amount),
    damage: (source, targets, amount, type, skillId, killerPlayerId) => killerPlayerId === undefined
      ? call('authorDealDamage', source, targets, amount, type, battle, skillId)
      : call('authorDealDamage', source, targets, amount, type, battle, skillId, false, killerPlayerId),
    heal: (source, targets, amount, skillId) => call('authorHealDamage', source, targets, amount, battle, skillId),
    enqueue: (kind, source, targets, amount, damageType, skillId, killerPlayerId) => {
      const queue = kind === 'damage' ? context.damageQueue : context.healQueue
      const lifetime = 'currentHp' in source ? { sourceLifetime: 'active-piece' } : {}
      const request = kind === 'damage'
        ? { attacker: source, target: targets, damage: amount, damageType, skillId, ...lifetime, ...(killerPlayerId === undefined ? {} : { killerPlayerId }) }
        : { healer: source, target: targets, heal: amount, skillId, ...lifetime }
      if (typeof queue?.push === 'function') {
        queue.push(request)
        return
      }
      // Some host-forwarded trigger events intentionally carry only their
      // semantic payload and omit the transient queue writers.  The real
      // skill host can still bind this follow-up to the active EffectChain;
      // do not invent a local queue or fall back to direct settlement here.
      call('enqueueAuthorEffect', kind, source, targets, amount, damageType, skillId, killerPlayerId)
    },
  })
  const effectId = () => String(context.skill?.id || context.card?.id || context.ruleId || 'flow')
  const capturedSource = (handle: any) => {
    if (!handle || handle.scope !== 'execution-source' || typeof handle.id !== 'string' || Object.keys(handle).some(key => !['scope', 'id'].includes(key))) throw new Error('flow: 无效结算来源句柄')
    const source = capturedSources.get(handle)
    if (!source) throw new Error('flow: 结算来源不属于当前执行')
    return source
  }
  const statusReference = (handle: any) => {
    if (!handle || typeof handle !== 'object') return undefined
    const reference = statusReferences.get(handle)
    if (!reference) return undefined
    const target = reference.ownerKind === 'player'
      ? battle.players.find(candidate => candidate.playerId === reference.pieceId)
      : findPieceIncludingGraveyard(reference.pieceId)
    if (!target) return undefined
    const tag = (target.statusTags || []).find(candidate => candidate === reference.tag)
    return tag ? { target, tag, ownerKind: reference.ownerKind ?? 'piece', ownerId: reference.pieceId } : undefined
  }
  /**
   * Establish a durable identity only when a status handle crosses a
   * persistence boundary (JSON serialization or an explicit stable reference).
   * Ordinary status enumeration and opaque-handle field reads stay read-only
   * for legacy saves.
   */
  const ensureStatusIdentity = (
    target: StatusIdentityHolder,
    ownerKind: 'piece' | 'player',
    ownerId: string,
    tag: any,
  ): string => {
    if (!tag || typeof tag !== 'object') throw new Error('flow: 状态实例无效')
    const sameId = typeof tag.instanceId === 'string' && tag.instanceId.length > 0 ? tag.instanceId : undefined
    const tags = Array.isArray(target.statusTags) ? target.statusTags : []
    const ledger = statusIdentityLedger(target, true)!
    if (sameId) {
      const matches = tags.filter(candidate => candidate?.instanceId === sameId)
      if (matches.length > 1) throw new Error('flow: 状态实例标识不唯一')
      if (ledger.retired.includes(sameId)) throw new Error('flow: 状态实例已经失效')
      if (!ledger.active.includes(sameId)) ledger.active.push(sameId)
      statusIdentityClaims.set(statusClaimKey(ownerKind, ownerId, sameId), tag)
      return sameId
    }

    const used = new Set<string>([
      ...ledger.active,
      ...ledger.retired,
      ...tags.flatMap(candidate => (
        typeof candidate?.instanceId === 'string' && candidate.instanceId.length > 0
          ? [candidate.instanceId]
          : []
      )),
    ])
    let next = ledger.next
    let candidate = `${ownerId}:status:${next}`
    while (used.has(candidate)) {
      next += 1
      candidate = `${ownerId}:status:${next}`
    }
    ledger.next = next + 1
    tag.instanceId = candidate
    ledger.active.push(candidate)
    statusIdentityClaims.set(statusClaimKey(ownerKind, ownerId, candidate), tag)
    return candidate
  }
  const statusHandle = (
    statusTarget: StatusIdentityHolder,
    ownerId: string,
    ownerKind: 'piece' | 'player',
    tag: any,
  ): object => {
    const targetHandle: Record<string, unknown> = {
      scope: 'status-instance',
      ...(ownerKind === 'player'
        ? { ownerKind, playerId: ownerId }
        : { pieceId: ownerId }),
    }
    // Keep the opaque handle a plain finite-JSON record for execution-local
    // values. A virtual toJSON method is exposed only to JSON serialization;
    // it mints the durable identity at that boundary without mutating an
    // ordinary status.instances/queryInstances read.
    const handle = new Proxy(targetHandle, {
      get: (target, property, receiver) => {
        if (property === 'toJSON') {
          return () => ({
            ...target,
            instanceId: ensureStatusIdentity(statusTarget, ownerKind, ownerId, tag),
          })
        }
        return Reflect.get(target, property, receiver)
      },
    })
    Object.freeze(handle)
    statusReferences.set(handle, { pieceId: ownerId, ownerKind, tag })
    return handle
  }
  const statusLifecycleRemove = (handle: object | null) => {
    const reference = statusReference(handle)
    if (!reference) throw new Error('flow: 状态实例已经失效')
    const statusId = reference.tag?.id
    if (typeof statusId !== 'string') {
      throw new Error('flow: 状态实例缺少生命周期标识')
    }
    // The id based delegate is the existing authoritative lifecycle boundary:
    // it removes related rules and emits afterStatusRemoved.  Reject duplicate
    // ids before calling it so an opaque handle can never retarget a sibling.
    const duplicate = (reference.target.statusTags || []).some(tag => tag !== reference.tag && tag?.id === statusId)
    if (duplicate) throw new Error('flow: 状态实例标识不唯一')
    const removed = Boolean(call(reference.ownerKind === 'player' ? 'removePlayerStatusEffectById' : 'removeStatusEffectById', reference.ownerId, statusId))
    if (removed && typeof reference.tag.instanceId === 'string') {
      retireStatusIdentity(reference.target, reference.tag.instanceId)
    }
    return removed
  }
  const skillReference = (handle: any) => {
    if (!handle || typeof handle !== 'object') return undefined
    const reference = skillReferences.get(handle)
    if (!reference) return undefined
    const target = battle.pieces.find(candidate => candidate.instanceId === reference.pieceId)
    if (!target || !Array.isArray(target.skills)) return undefined
    const skill = target.skills.find(candidate => candidate === reference.skill)
    return skill ? { target, skill } : undefined
  }
  const ensureRuleInstanceIds = (target: { instanceId?: string; playerId?: string; rules?: any[] }, targetKind: 'piece' | 'player'): void => {
    if (!Array.isArray(target.rules)) return
    const owner = targetKind === 'piece' ? target.instanceId : target.playerId
    if (typeof owner !== 'string' || !owner) return
    const used = new Set<string>()
    target.rules.forEach((rule, index) => {
      if (!rule || typeof rule !== 'object') return
      const existing = typeof rule.instanceId === 'string' && rule.instanceId.length > 0 ? rule.instanceId : undefined
      if (existing && !used.has(existing)) {
        used.add(existing)
        return
      }
      const base = `${owner}:rule:${index}`
      let candidate = base
      let suffix = 1
      while (used.has(candidate)) {
        candidate = `${base}:${suffix}`
        suffix += 1
      }
      rule.instanceId = candidate
      used.add(candidate)
    })
  }
  const ruleReference = (handle: any) => {
    if (!handle || typeof handle !== 'object') return undefined
    const reference = ruleReferences.get(handle)
    if (!reference) return undefined
    const target = reference.targetKind === 'piece'
      ? battle.pieces.find(candidate => candidate.instanceId === reference.targetId)
      : battle.players.find(candidate => candidate.playerId === reference.targetId)
    if (!target || !Array.isArray(target.rules)) return undefined
    const rule = target.rules.find(candidate => candidate === reference.rule)
    return rule ? { target, rule, targetKind: reference.targetKind } : undefined
  }
  const cardReference = (handle: any) => {
    if (!handle || typeof handle !== 'object') return undefined
    const reference = cardReferences.get(handle)
    if (!reference) return undefined
    const owner = battle.players.find(candidate => candidate.playerId === reference.ownerPlayerId)
    const card = owner?.hand?.find(candidate => candidate === reference.card)
    return card ? { owner, card } : undefined
  }
  const clusterReference = (handle: any) => {
    if (!handle || typeof handle !== 'object') return undefined
    const reference = clusterReferences.get(handle)
    if (!reference) return undefined
    const target = battle.pieces.find(candidate => candidate.instanceId === reference.pieceId)
    const group = target?.abilityGroups?.find(candidate => candidate === reference.group)
    return target && group ? { target, group } : undefined
  }
  const tileEffectReference = (handle: any) => {
    if (!handle || typeof handle !== 'object') return undefined
    const reference = tileEffectReferences.get(handle)
    if (!reference) return undefined
    const effects = battle.extensions?.tileEffects
    if (!Array.isArray(effects)) return undefined
    const effect = effects.find(candidate => candidate === reference.effect)
    return effect && typeof effect === 'object' && !Array.isArray(effect) ? effect as Record<string, unknown> : undefined
  }
  const stablePiece = (id: unknown): PieceInstance | undefined => typeof id === 'string'
    ? battle.pieces.find(candidate => candidate.instanceId === id)
    : undefined
  const stableStatus = (reference: any): any | undefined => {
    const handleReference = statusReference(reference)
    if (handleReference) return handleReference.tag
    if (!reference || typeof reference !== 'object') return undefined
    const ownerKind: 'piece' | 'player' = reference.ownerKind === 'player' ? 'player' : 'piece'
    const ownerId = ownerKind === 'player'
      ? reference.playerId ?? reference.ownerPlayerId ?? reference.targetId
      : reference.pieceId ?? reference.ownerPieceId ?? reference.targetId
    const instanceId = reference.instanceId ?? reference.statusInstanceId
    if (typeof ownerId !== 'string' || typeof instanceId !== 'string' || instanceId.length === 0) return undefined
    const target = ownerKind === 'player'
      ? battle.players.find(candidate => candidate.playerId === ownerId)
      : findPieceIncludingGraveyard(ownerId)
    if (!target) return undefined
    reconcileStatusIdentityLedger(target)
    const ledger = statusIdentityLedger(target, false)
    if (ledger?.retired.includes(instanceId)) return undefined
    const existing = (target.statusTags || []).filter(tag => tag?.instanceId === instanceId)
    if (existing.length > 1) throw new Error('flow: 状态实例标识不唯一')
    const claimKey = statusClaimKey(ownerKind, ownerId, instanceId)
    const claimed = statusIdentityClaims.get(claimKey)
    // An id previously minted for a removed object is a tombstone. Do not
    // infer a new identity from the replacement's array position.
    if (claimed && !(target.statusTags || []).some(tag => tag === claimed)) {
      retireStatusIdentity(target, instanceId)
      return undefined
    }
    if (existing.length === 1) {
      if (claimed && claimed !== existing[0]) {
        retireStatusIdentity(target, instanceId)
        return undefined
      }
      const activeLedger = statusIdentityLedger(target, true)!
      if (!activeLedger.active.includes(instanceId)) activeLedger.active.push(instanceId)
      statusIdentityClaims.set(claimKey, existing[0])
      return existing[0]
    }
    // Compatibility for an old active execution that passed a deterministic
    // reference directly instead of retaining the opaque handle. It is only
    // allowed at the authoritative capture context, for a single legacy
    // status, and with the allocator's next ID. Resumed/pending JSON cannot
    // enter this branch, so an old reference cannot retarget a replacement.
    const captureOwner = ownerKind === 'player' ? context.playerId : context.piece?.instanceId
    const legacyTags = (target.statusTags || []).filter(tag => tag && typeof tag === 'object' && tag.instanceId === undefined)
    const expectedId = `${ownerId}:status:${ledger?.next ?? 0}`
    if (surface !== 'pending' && !claimed && captureOwner === ownerId
      && legacyTags.length === 1 && instanceId === expectedId
      && !(target.statusTags || []).some(tag => tag !== legacyTags[0] && tag?.instanceId === expectedId)) {
      const candidate = legacyTags[0]
      ensureStatusIdentity(target, ownerKind, ownerId, candidate)
      return candidate
    }
    // A serialized identity must have been persisted on the target status
    // itself. Never mint from an array position: after removal/replacement a
    // stale pending reference would otherwise retarget a different status.
    return undefined
  }
  const stableSkill = (reference: any): any | undefined => {
    const handleReference = skillReference(reference)
    if (handleReference) return handleReference.skill
    if (!reference || typeof reference !== 'object') return undefined
    const pieceId = reference.pieceId ?? reference.ownerPieceId
    const instanceId = reference.instanceId ?? reference.skillInstanceId
    if (typeof pieceId !== 'string' || typeof instanceId !== 'string') return undefined
    const target = stablePiece(pieceId)
    const existing = target?.skills?.filter(skill => skill?.instanceId === instanceId) ?? []
    if (existing.length > 1) throw new Error('flow: 技能实例标识不唯一')
    return target ? findPieceSkillInstance(target, instanceId, typeof reference.skillId === 'string' ? reference.skillId : undefined) : undefined
  }
  const stableRule = (reference: any): any | undefined => {
    const handleReference = ruleReference(reference)
    if (handleReference) return handleReference.rule
    if (!reference || typeof reference !== 'object') return undefined
    const pieceId = reference.pieceId ?? reference.ownerPieceId
    const playerId = reference.playerId ?? reference.ownerPlayerId
    const targetKind: 'piece' | 'player' = typeof pieceId === 'string' ? 'piece' : 'player'
    const target = targetKind === 'piece'
      ? stablePiece(pieceId)
      : typeof playerId === 'string' ? battle.players.find(candidate => candidate.playerId === playerId) : undefined
    if (!target) return undefined
    const instanceId = reference.instanceId ?? reference.ruleInstanceId
    const existing = typeof instanceId === 'string'
      ? (target.rules || []).filter(rule => rule?.instanceId === instanceId)
      : []
    if (existing.length > 1) throw new Error('flow: 规则实例标识不唯一')
    ensureRuleInstanceIds(target, targetKind)
    const ruleId = reference.ruleId ?? reference.id
    const matches = (target.rules || []).filter(rule => (
      (typeof instanceId === 'string' ? rule?.instanceId === instanceId : true)
      && (typeof ruleId === 'string' ? rule?.id === ruleId : true)
    ))
    return matches.length === 1 ? matches[0] : undefined
  }
  const stableCard = (reference: any): any | undefined => {
    const handleReference = cardReference(reference)
    if (handleReference) return handleReference.card
    if (context.cardInstance && reference === context.cardInstance) return context.cardInstance
    const instanceId = typeof reference === 'string' ? reference : reference?.instanceId
    const ownerPlayerId = typeof reference === 'object' ? reference?.ownerPlayerId : undefined
    if (typeof instanceId !== 'string' || !instanceId) return undefined
    const candidates = battle.players.flatMap(owner => owner.hand?.filter(card => (
      card?.instanceId === instanceId && (ownerPlayerId === undefined || owner.playerId === ownerPlayerId)
    )).map(card => ({ owner, card })) ?? [])
    if (candidates.length === 1) return candidates[0].card
    if (candidates.length === 0 && context.cardInstance?.instanceId === instanceId) return context.cardInstance
    if (candidates.length > 1) throw new Error('flow: 手牌实例标识不唯一')
    return undefined
  }
  const stableCluster = (reference: any): any | undefined => {
    const handleReference = clusterReference(reference)
    if (handleReference) return handleReference.group
    if (!reference || typeof reference !== 'object' || typeof reference.ownerPieceId !== 'string' || typeof reference.instanceId !== 'string') return undefined
    const target = stablePiece(reference.ownerPieceId)
    const matches = target?.abilityGroups?.filter(group => group.instanceId === reference.instanceId) ?? []
    return matches.length === 1 ? matches[0] : undefined
  }
  const stableTileEffect = (reference: any): Record<string, unknown> | undefined => {
    const handleReference = tileEffectReference(reference)
    if (handleReference) return handleReference
    const effects = battle.extensions?.tileEffects
    if (!Array.isArray(effects) || !reference || typeof reference !== 'object') return undefined
    const id = reference.instanceId ?? reference.id
    const candidates = effects.filter(effect => {
      if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return false
      if (typeof id === 'string' && id.length > 0) return (effect as any).id === id || (effect as any).instanceId === id
      return ['x', 'y', 'tileType', 'type', 'sourceId', 'ownerPlayerId'].every(key => (
        !Object.prototype.hasOwnProperty.call(reference, key) || Object.is((effect as any)[key], reference[key])
      ))
    })
    if (candidates.length > 1) throw new Error('flow: 地格效果实例标识不唯一')
    const effect = candidates[0]
    return effect && typeof effect === 'object' && !Array.isArray(effect) ? effect as Record<string, unknown> : undefined
  }
  const resolveEntity = (kind: AuthorEntityKind, reference: unknown): AuthorEntityExtensionTarget | undefined => {
    switch (kind) {
      case 'skill': return stableSkill(reference) as AuthorEntityExtensionTarget | undefined
      case 'status': return stableStatus(reference) as AuthorEntityExtensionTarget | undefined
      case 'rule': return stableRule(reference) as AuthorEntityExtensionTarget | undefined
      case 'card': return stableCard(reference) as AuthorEntityExtensionTarget | undefined
      case 'cluster': return stableCluster(reference) as AuthorEntityExtensionTarget | undefined
      case 'tile-effect': return stableTileEffect(reference) as AuthorEntityExtensionTarget | undefined
      default: return undefined
    }
  }
  const entityExtension = createAuthorEntityExtensionRuntime(resolveEntity)
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
  // The first author migration used player.buffs as its durable storage. Keep
  // that exact record authoritative behind a named extension view so generic
  // declaration/read/write modules can compose with it without creating a
  // second save field or a role-specific public module. Declarations and
  // default records are execution-local; only an explicit write materialises
  // the legacy player.buffs entry.
  const legacyPlayerBuffNamespace = 'legacy-player-buffs'
  const legacyBuffDeclarations = new Map<string, AuthorValueDeclaration>()
  const legacyBuffInitials = new Map<string, unknown>()
  const legacyBuffKey = (owner: string, name: string): string => `${owner}\u0000${name}`
  const isLegacyPlayerBuff = (scope: 'piece' | 'player' | 'battle', namespace: string): boolean => (
    scope === 'player' && namespace === legacyPlayerBuffNamespace
  )
  const validLegacyBuffUses = (value: Record<string, unknown>): boolean => {
    if (!Object.prototype.hasOwnProperty.call(value, 'uses')) return true
    const uses = value.uses
    return typeof uses === 'number' && Number.isSafeInteger(uses) && uses >= 0
  }
  const legacyBuffGet = (owner: string, name: string): unknown => {
    const safeName = key(name)
    const target = player(owner) as any
    const buffs = target.buffs
    if (buffs !== undefined) {
      if (!buffs || typeof buffs !== 'object' || Array.isArray(buffs)) throw new Error('flow: 玩家增益存储无效')
      if (Object.prototype.hasOwnProperty.call(buffs, safeName)) {
        const stored = buffs[safeName]
        return stored === undefined ? undefined : json(stored)
      }
    }
    const initial = legacyBuffInitials.get(legacyBuffKey(owner, safeName))
    return initial === undefined ? undefined : json(initial)
  }
  const legacyBuffSet = (owner: string, name: string, value: unknown, declaration?: AuthorValueDeclaration): void | false => {
    const safeName = key(name)
    const target = player(owner) as any
    if (target.buffs !== undefined) {
      if (!target.buffs || typeof target.buffs !== 'object' || Array.isArray(target.buffs)) throw new Error('flow: 玩家增益存储无效')
      // Validate the complete legacy container before changing one entry. This
      // rejects accessors, inherited data and prototype keys at the write
      // boundary instead of allowing a partial mutation.
      json(target.buffs)
    }
    const copy = json(value)
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('flow: 玩家增益必须为记录')
    // `legacy-player-buffs` is still the authoritative projection for the
    // migrated Elune records. Keep its numeric write boundary in the host so
    // every generic extension writer (including future collection paths) gets
    // the same finite/integer/non-negative/MAX_SAFE validation. The
    // `uses > 0` consumption rule remains in the author graph and is not
    // duplicated here.
    if (!validLegacyBuffUses(copy as Record<string, unknown>)) return false
    target.buffs ??= {}
    target.buffs[safeName] = copy
    legacyBuffInitials.delete(legacyBuffKey(owner, safeName))
    if (declaration !== undefined) legacyBuffDeclarations.set(legacyBuffKey(owner, safeName), json(declaration))
  }
  const legacyBuffRemove = (owner: string, name: string): void => {
    const safeName = key(name)
    const target = player(owner) as any
    if (target.buffs !== undefined) {
      if (!target.buffs || typeof target.buffs !== 'object' || Array.isArray(target.buffs)) throw new Error('flow: 玩家增益存储无效')
      if (Object.prototype.hasOwnProperty.call(target.buffs, safeName)) delete target.buffs[safeName]
    }
    legacyBuffInitials.delete(legacyBuffKey(owner, safeName))
    legacyBuffDeclarations.delete(legacyBuffKey(owner, safeName))
  }
  const getStateRecord = (scope: 'piece' | 'player' | 'battle', entityId: string, namespace: string, name: string) => {
    stateOwner(scope, entityId); key(namespace); key(name)
    return records().find(e => e.scope === scope && e.entityId === entityId && e.namespace === namespace && e.name === name && !expired(e))
  }
  const getState = (scope: 'piece' | 'player' | 'battle', entityId: string, namespace: string, name: string) => {
    const record = getStateRecord(scope, entityId, namespace, name)
    return record ? json(record.value) : undefined
  }
  const setState = (scope: 'piece' | 'player' | 'battle', entityId: string, namespace: string, name: string, value: unknown, lifetime: 'battle' | 'while-alive' = 'battle', declaration?: AuthorValueDeclaration) => {
    const ownerPlayerId = stateOwner(scope, entityId); key(namespace); key(name)
    if (!['battle','while-alive'].includes(lifetime) || lifetime === 'while-alive' && scope !== 'piece') throw new Error('flow: extension生命周期无效')
    const copy = json(value)
    const authorDeclaration = declaration === undefined ? undefined : json(declaration)
    const next = records().filter(e => !(e.scope === scope && e.entityId === entityId && e.namespace === namespace && e.name === name) && !expired(e))
    if (next.length >= 4096) throw new Error('flow: extension条目过多')
    next.push({ schemaVersion: 1, scope, entityId, ownerPlayerId, namespace, name, value: copy, lifetime, projectionVisibility: ownerPlayerId ? 'owner' : 'public', ...(authorDeclaration === undefined ? {} : { authorDeclaration }) })
    battle.extensions ??= {}; battle.extensions.flowState = next
  }
  const removeState = (scope: 'piece' | 'player' | 'battle', entityId: string, namespace: string, name: string) => {
    stateOwner(scope, entityId); key(namespace); key(name)
    if (battle.extensions) battle.extensions.flowState = records().filter(e => !(e.scope === scope && e.entityId === entityId && e.namespace === namespace && e.name === name))
  }
  let presentation: ReturnType<typeof createSkillPresentation> | undefined
  // Root-backed content variables retain the existing resource/save layout.
  // Their declarations are execution-local; every access still validates the
  // stored value, including after a pending continuation creates a new facade.
  const rootDeclarations = new Map<string, AuthorValueDeclaration>()
  const rootKey = (scope: string, namespace: string, name: string): string => {
    if (scope !== 'battle' || namespace !== '') throw new Error('extension：根字段仅用于全局扩展')
    key(name)
    if (ENGINE_EXTENSION_FIELDS.has(name)) throw new Error('extension：该字段由引擎管理')
    return name
  }
  const rootExtension = createAuthorExtensionRuntime({
    get: (scope, _owner, namespace, name) => {
      rootKey(scope, namespace, name)
      if (!battle.extensions || !Object.hasOwn(battle.extensions, name)) return undefined
      const property = Object.getOwnPropertyDescriptor(battle.extensions, name)
      if (!property || !('value' in property)) throw new Error('extension：不允许访问器字段')
      return json(property.value)
    },
    getDeclaration: (scope, _owner, namespace, name) => rootDeclarations.get(rootKey(scope, namespace, name)),
    set: (scope, _owner, namespace, name, value, declaration) => {
      rootKey(scope, namespace, name)
      const copy = json(value)
      const nextDeclaration = declaration === undefined ? undefined : json(declaration)
      battle.extensions ??= {}
      battle.extensions[name] = copy
      if (nextDeclaration) rootDeclarations.set(name, nextDeclaration)
    },
    remove: (scope, _owner, namespace, name) => {
      const rootName = rootKey(scope, namespace, name)
      if (battle.extensions && Object.hasOwn(battle.extensions, rootName)) delete battle.extensions[rootName]
      rootDeclarations.delete(rootName)
    },
  })
  // Marker migrations replace the two legacy root arrays as one transaction.
  // Validate and clone both candidates before touching battle.extensions so a
  // malformed tile record cannot leave the anchor array partially updated.
  const commitRootWithTiles = (name: string, rootValue: unknown, tileEffects: unknown, presentationBatch: 'direct' | 'tileEffectRemoved' | 'tileEffectAdded' = 'direct'): boolean => {
    if (!['direct', 'tileEffectRemoved', 'tileEffectAdded'].includes(presentationBatch)) throw new Error('flow: 地格表现批次无效')
    rootKey('battle', '', name)
    const nextRoot = json(rootValue)
    const nextTiles = json(tileEffects)
    const recordsOnly = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value)
      && value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))
    if (!recordsOnly(nextRoot) || !recordsOnly(nextTiles)) throw new Error('extension：原子提交需要两个记录集合')
    const apply = () => {
      battle.extensions ??= {}
      battle.extensions[name] = nextRoot
      battle.extensions.tileEffects = nextTiles
    }
    if (presentationBatch === 'direct') apply()
    else createBattlePresentationQueue(battle).push(presentationBatch, apply)
    return true
  }
  const hydrateLegacyRecallSnapshot = (pieceId: string, input: unknown): unknown => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input
    const raw = input as Record<string, unknown>
    if (raw.kind === 'author-piece-instance/v1'
      || (!Object.hasOwn(raw, 'hp') && !Object.hasOwn(raw, 'statusTags')
        && !Object.hasOwn(raw, 'buffs') && !Object.hasOwn(raw, 'debuffs'))) return input
    const target = battle.pieces?.find(piece => piece.instanceId === pieceId)
    if (!target) return input
    try {
      const captured = capturePieceInstance(battle, pieceId) as any
      const fields = captured.fields as Record<string, unknown>
      if (Number.isFinite(raw.hp)) fields.currentHp = raw.hp
      if (Object.hasOwn(raw, 'shield')) fields.shield = raw.shield
      else delete fields.shield
      for (const field of ['statusTags', 'buffs', 'debuffs'] as const) {
        if (Object.hasOwn(raw, field)) fields[field] = json(raw[field])
      }
      return captured
    } catch {
      return input
    }
  }
  // Recall was originally a public battle.extensions array.  Its migrated
  // graphs use the typed owner-private map API, but existing saves still only
  // contain that legacy array.  Keep that array authoritative until the map
  // is explicitly replaced by a future save migration: reads synthesize the
  // declared records without creating flowState, and map writes round-trip to
  // the same legacy root.  Other maps keep their normal declaration rules.
  const recallLegacyMap = {
    getLegacyMap: (owner: string, namespace: string, name: string, declaration: any) => {
      if (namespace !== 'content' || name !== 'recall-records') return undefined
      const raw = battle.extensions?.recallData
      if (raw !== undefined && !Array.isArray(raw)) throw new Error('flow: recallData格式无效')
      const items = (raw ?? []).filter((entry: any) => entry && typeof entry === 'object' && entry.ownerPlayerId === owner).map((entry: any) => {
        const rawSnapshot = entry.snapshot && typeof entry.snapshot === 'object' && !Array.isArray(entry.snapshot) ? json(entry.snapshot) : entry.snapshot
        const rawPosition = rawSnapshot && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot)
          && Number.isInteger((rawSnapshot as any).x) && Number.isInteger((rawSnapshot as any).y)
          ? { x: (rawSnapshot as any).x, y: (rawSnapshot as any).y }
          : null
        const snapshot = rawSnapshot
        const position = snapshot && typeof snapshot === 'object' && Number.isInteger(snapshot.x) && Number.isInteger(snapshot.y)
          ? { x: snapshot.x, y: snapshot.y }
          : (rawPosition ?? (Number.isInteger(entry.x) && Number.isInteger(entry.y) ? { x: entry.x, y: entry.y } : null))
        return {
          piece: typeof entry.pieceId === 'string' ? entry.pieceId : null,
          pieceKey: entry.pieceId,
          owner: entry.ownerPlayerId,
          position,
          targetCount: entry.targetCount,
          actionCount: entry.actionCount,
          snapshot,
        }
      })
      return { format: 'author-extension-map/v1' as const, declaration, items }
    },
    setLegacyMap: (owner: string, namespace: string, name: string, _declaration: any, items: any[]) => {
      if (namespace !== 'content' || name !== 'recall-records') return false
      const raw = battle.extensions?.recallData
      if (raw !== undefined && !Array.isArray(raw)) throw new Error('flow: recallData格式无效')
      const others = (raw ?? []).filter((entry: any) => !entry || typeof entry !== 'object' || entry.ownerPlayerId !== owner)
      const next = items.map((item: any) => {
        const snapshot = item.snapshot && typeof item.snapshot === 'object' && !Array.isArray(item.snapshot) ? json(item.snapshot) : item.snapshot
        const position = item.position && typeof item.position === 'object' && !Array.isArray(item.position) ? item.position : undefined
        const legacySnapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
          ? {
            ...snapshot,
            ...(position && Number.isInteger(position.x) && Number.isInteger(position.y) ? { x: position.x, y: position.y } : {}),
            // Keep the legacy projection observable to old readers while the
            // complete author snapshot remains available to the new apply
            // module.  The extra fields are ignored by snapshot validation.
            ...((snapshot as any).kind === 'author-piece-instance/v1' && (snapshot as any).fields
              ? {
                hp: (snapshot as any).fields.currentHp,
                ...((snapshot as any).fields.shield === undefined ? {} : { shield: (snapshot as any).fields.shield }),
                statusTags: (snapshot as any).fields.statusTags,
                buffs: (snapshot as any).fields.buffs,
                debuffs: (snapshot as any).fields.debuffs,
              }
              : {}),
          }
          : snapshot
        return {
          pieceId: item.pieceKey,
          ownerPlayerId: item.owner,
          targetCount: item.targetCount,
          actionCount: item.actionCount,
          snapshot: legacySnapshot,
        }
      })
      battle.extensions ??= {}
      battle.extensions.recallData = [...others, ...next]
      return true
    },
  }
  return {
    extensionRoot: Object.assign(rootExtension, { commitRootWithTiles }),
    extension: createAuthorExtensionRuntime({
      get: (scope, entityId, namespace, name) => isLegacyPlayerBuff(scope, namespace)
        ? legacyBuffGet(entityId, name)
        : getState(scope, entityId, namespace, name),
      getDeclaration: (scope, entityId, namespace, name) => {
        if (isLegacyPlayerBuff(scope, namespace)) {
          const declaration = legacyBuffDeclarations.get(legacyBuffKey(entityId, name))
          return declaration === undefined ? undefined : json(declaration)
        }
        const declaration = getStateRecord(scope, entityId, namespace, name)?.authorDeclaration
        return declaration === undefined ? undefined : json(declaration)
      },
      set: (scope, entityId, namespace, name, value, declaration) => {
        if (isLegacyPlayerBuff(scope, namespace)) {
          return legacyBuffSet(entityId, name, value, declaration)
        }
        const lifetime = getStateRecord(scope, entityId, namespace, name)?.lifetime ?? 'battle'
        setState(scope, entityId, namespace, name, value, lifetime, declaration)
      },
      declare: (scope, entityId, namespace, name, value, declaration) => {
        if (!isLegacyPlayerBuff(scope, namespace)) return undefined
        const copy = json(value)
        if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('flow: 玩家增益必须为记录')
        if (!validLegacyBuffUses(copy as Record<string, unknown>)) throw new Error('flow: 玩家增益次数必须为非负安全整数')
        const copiedDeclaration = json(declaration)
        const keyName = legacyBuffKey(entityId, name)
        legacyBuffDeclarations.set(keyName, copiedDeclaration)
        legacyBuffInitials.set(keyName, copy)
        return json(copy)
      },
      remove: (scope, entityId, namespace, name) => {
        if (isLegacyPlayerBuff(scope, namespace)) {
          legacyBuffRemove(entityId, name)
          return
        }
        removeState(scope, entityId, namespace, name)
      },
      ...recallLegacyMap,
    }),
    /** Direct extension storage for concrete Skill/Status/Rule/Card/Cluster/tile instances. */
    entityExtension,
    values: { require: requireAuthorValue },
    containers: authorContainers,
    instances: {
      copy: (pieceId: string) => capturePieceInstance(battle, pieceId),
      apply: (pieceId: string, snapshot: unknown) => {
        if (!applyPieceInstance(battle, pieceId, hydrateLegacyRecallSnapshot(pieceId, snapshot))) throw new Error('flow: 无法应用棋子实例信息 ' + pieceId)
        return true
      },
    },
    log: {
      triggerEffect: (playerId: string, message: string) => {
        player(playerId)
        if (typeof message !== 'string') throw new Error('flow: 日志消息必须为文本')
        battle.actions ??= []
        battle.actions.push({ type: 'triggerEffect', playerId, turn: battle.turn ? battle.turn.turnNumber : 0, payload: { message } })
        return true
      },
      appendStructured: (entry: { type?: unknown; playerId?: unknown; turn?: unknown; payload?: unknown }, schema: unknown) => {
        if (!entry || typeof entry.type !== 'string' || entry.type.length === 0 || entry.type.length > 120
          || /[\u0000-\u001f\u007f]/u.test(entry.type) || RESERVED_STRUCTURED_LOG_TYPES.has(entry.type)) {
          throw new Error('flow: 结构化日志类型无效或受权威动作保护')
        }
        if (typeof entry.playerId !== 'string') throw new Error('flow: 结构化日志归属玩家无效')
        player(entry.playerId)
        const turn = entry.turn
        if (!Number.isSafeInteger(turn) || (turn as number) < 0) throw new Error('flow: 结构化日志回合无效')
        const payload = validateStructuredLogPayload(entry.payload, schema)
        battle.actions ??= []
        if (!Array.isArray(battle.actions)) throw new Error('flow: 动作日志容器无效')
        // This API only appends a host-built entry.  It receives no index or
        // replacement operation, so authoritative damage entries cannot be
        // overwritten by authored follow-up content.
        battle.actions.push({ type: entry.type, playerId: entry.playerId, turn: turn as number, payload })
        return true
      },
    },
    execution: {
      declare: executionLocals.declare,
      read: executionLocals.read,
      write: executionLocals.write,
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
      card: (instance = context.cardInstance) => {
        const id = instance?.instanceId
        if (typeof id !== 'string' || !id.length) throw new Error('flow: 当前手牌实例不存在')
        const candidates = battle.players.flatMap(owner => owner.hand?.filter(card => card.instanceId === id) ?? [])
        if (candidates.length > 1) throw new Error('flow: 手牌实例标识不唯一')
        const card = context.cardInstance?.instanceId === id ? context.cardInstance : candidates[0]
        if (!card || card.cardId !== instance.cardId || card.ownerPlayerId !== instance.ownerPlayerId) throw new Error('flow: 手牌实例引用已失效')
        return id
      },
      holder: () => holder()?.instanceId ?? null,
      source: () => context.sourcePiece?.instanceId ?? (surface === 'skill' ? context.piece?.instanceId : null),
      target: () => context.targetPiece?.instanceId ?? context.target?.instanceId ?? null,
      player: () => holder()?.ownerPlayerId ?? context.playerId ?? null,
      // Trigger dispatch normally supplies triggerPlayerId/playerId.  Direct
      // skill execution used by legacy content and replay probes can omit
      // both while still carrying the event actor as sourcePiece; preserve
      // that actor as the event-player identity instead of making a valid
      // event look like a missing player.
      eventPlayer: () => context.triggerPlayerId ?? context.playerId ?? context.sourcePiece?.ownerPlayerId ?? null,
    },
    query: {
      players: () => battle.players.map(owner => owner.playerId),
      piece, player, pieceText, playerText,
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
      pieceFields: (field: 'sourcePiece' | 'targetPiece' | 'piece' | 'rulePiece') => {
        if (!['sourcePiece', 'targetPiece', 'piece', 'rulePiece'].includes(field)) throw new Error('flow: 无效事件棋子字段')
        const source = context[field]
        if (!source) return null
        return JSON.parse(JSON.stringify({
          instanceId: source.instanceId, ownerPlayerId: source.ownerPlayerId,
          name: source.name, templateId: source.templateId,
          currentHp: source.currentHp, maxHp: source.maxHp, attack: source.attack,
          defense: source.defense, moveRange: source.moveRange,
          stats: source.stats, statusTags: source.statusTags || [],
        }))
      },
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
      authorOption: authorChoice.option,
      authorTarget: authorChoice.target,
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
      deferTarget: (options: { playerId: string; title?: string; targetType: 'piece' | 'cell'; candidates: any[]; effectCode: string; payload?: unknown; canCancel?: boolean; selectionMode?: 'single' | 'multi'; minSelections?: number; maxSelections?: number; range?: number; filter?: 'enemy' | 'ally' | 'all' }) => {
        player(options.playerId)
        if (!['piece','cell'].includes(options.targetType) || typeof options.effectCode !== 'string' || !options.effectCode.trim() || !Array.isArray(options.candidates)) throw new Error('flow: 延迟选择参数无效')
        const candidates = json(options.candidates).map((candidate: any) => candidate && typeof candidate === 'object' && candidate.type === undefined ? { ...candidate, type: options.targetType } : candidate), mode = options.selectionMode ?? 'single'
        const min = options.minSelections ?? 1, max = options.maxSelections ?? 1
        if (!['single','multi'].includes(mode) || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 64 || mode === 'single' && max !== 1 || candidates.length < min || candidates.length > 512) throw new Error('flow: 选择数量无效')
        if (options.range !== undefined && (!Number.isFinite(options.range) || options.range < 0)) throw new Error('flow: 选择范围无效')
        if (options.filter !== undefined && !['enemy', 'ally', 'all'].includes(options.filter)) throw new Error('flow: 选择筛选无效')
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
          payload: json(options.payload ?? null), canCancel: options.canCancel ?? true, selectionMode: mode, minSelections: min, maxSelections: max,
          ...(options.range === undefined ? {} : { range: options.range }), ...(options.filter === undefined ? {} : { filter: options.filter }) }
      },
    },
    effects: {
      apply: authorEffects.apply,
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
      /**
       * Queue one captured-to-captured author damage request in the active
       * processing chain.  This is deliberately separate from the legacy
       * immediate `damageCaptured`/`damageManyCaptured` helpers: resolving
       * both WeakMap handles before writing the queue preserves exact
       * execution identity, while the queue itself owns delayed settlement,
       * departure handling and re-entry protection.
       */
      authorDamageCaptured: (
        sourceHandle: any,
        targetHandle: any,
        amount: number,
        type: 'physical' | 'magical' | 'true',
        skillId?: string,
        attribution: 'current' | 'unattributed' = 'current',
      ) => {
        if (!Number.isFinite(amount) || !['physical', 'magical', 'true'].includes(type)) throw new Error('flow: 无效队列伤害')
        if (!['current', 'unattributed'].includes(attribution)) throw new Error('flow: 伤害归属方式不合法')
        if (skillId !== undefined) key(skillId)
        const attacker = capturedSource(sourceHandle), target = capturedSource(targetHandle)
        if (!context.damageQueue || typeof context.damageQueue.push !== 'function') throw new Error('flow: 当前事件不支持伤害队列')
        context.damageQueue.push({
          attacker,
          target,
          damage: amount,
          damageType: type,
          skillId: attribution === 'unattributed' ? undefined : skillId,
        })
        return { queued: true, targetId: target.instanceId }
      },
      capturedOwner: (handle: any) => capturedSource(handle).ownerPlayerId,
      capturedNoKillCharge: (handle: any) => Boolean((capturedSource(handle) as { noKillCharge?: boolean }).noKillCharge),
      capturedMaxHp: (handle: any, fallback: number) => {
        if (!Number.isFinite(fallback)) throw new Error('flow: 无效生命上限回退')
        const source = capturedSource(handle) as any
        return Number(source.maxHp || (source.stats && source.stats.maxHp) || fallback)
      },
      capturedIdentifier: (handle: any) => capturedSource(handle).instanceId,
      capturedFields: (handle: any) => {
        const source = capturedSource(handle)
        return JSON.parse(JSON.stringify({
          instanceId: source.instanceId, ownerPlayerId: source.ownerPlayerId,
          name: source.name, templateId: source.templateId,
          currentHp: source.currentHp, maxHp: source.maxHp, attack: source.attack,
          defense: source.defense, moveRange: source.moveRange,
          noKillCharge: Boolean((source as { noKillCharge?: boolean }).noKillCharge),
          statusTags: source.statusTags || [],
          stats: (source as { stats?: unknown }).stats,
        }))
      },
      capturedHasStatus: (handle: any, statusType: string) => {
        if (typeof statusType !== 'string' || !statusType) throw new Error('flow: 无效状态类型')
        return capturedSource(handle).statusTags.some(tag => tag.type === statusType)
      },
      capturedNumber: (handle: any, field: 'attack' | 'defense' | 'moveRange' | 'currentHp' | 'maxHp') => {
        if (!['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'].includes(field)) throw new Error('flow: 无效来源数值字段')
        return Number(capturedSource(handle)[field])
      },
      damageCaptured: (source: any, target: any, amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId(), attribution?: 'current' | 'unattributed') => {
        if (!Number.isFinite(amount) || !['physical', 'magical', 'true'].includes(type)) throw new Error('flow: 无效伤害参数')
        return call('dealDamage', capturedSource(source), capturedSource(target), amount, type, battle, attribution === 'unattributed' ? undefined : skillId)
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
      setCapturedAttribute: (handle: any, attribute: 'attack' | 'defense' | 'moveRange', value: number) => {
        if (!['attack', 'defense', 'moveRange'].includes(attribute) || !Number.isFinite(value)) throw new Error('flow: 无效结算属性')
        const source = capturedSource(handle)
        source[attribute] = value
        return true
      },
      capturedName: (handle: any, fallback: 'none' | 'templateId' = 'none') => {
        if (!['none', 'templateId'].includes(fallback)) throw new Error('flow: 无效名称回退')
        const source = capturedSource(handle)
        return String(fallback === 'templateId' ? source.name || source.templateId : source.name)
      },
      damageManyCaptured: (handle: any, targetIds: string[], amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId(), attribution?: 'current' | 'unattributed') => {
        if (!Number.isFinite(amount) || !['physical', 'magical', 'true'].includes(type)) throw new Error('flow: 无效伤害参数')
        return call('dealDamage', capturedSource(handle), targetIds.map(piece), amount, type, battle, attribution === 'unattributed' ? undefined : skillId)
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
      // Closed rule boundary used by generated Rafaam curse effects.  Keep
      // this separate from the older damageWithKiller helper because the
      // legacy rule intentionally passes magical damage and a host-owned
      // amount without floor normalization.
      damageWithKillerTyped: (sourceId: string, targetId: string, amount: number, type: 'physical' | 'magical' | 'true' | 'toxin', skillId: string, killerPlayerId: string | null, inputPolicy: 'floor' | 'host' = 'floor') => {
        if (!['floor', 'host'].includes(inputPolicy) || !Number.isFinite(amount) || !['physical', 'magical', 'true', 'toxin'].includes(type)) throw new Error('flow: 无效伤害参数')
        if (killerPlayerId !== null) player(killerPlayerId)
        return call('dealDamage', piece(sourceId), piece(targetId), inputPolicy === 'host' ? amount : numeric(amount), type, battle, skillId, false, killerPlayerId)
      },
      // Generated curse cards resolve their source from the card definition;
      // a departed source falls back to the selected target exactly as the
      // legacy card did, while preserving its skip-before-trigger behavior.
      cardDamage: (cardId: string, targetId: string, amount: number, type: 'true', skillId: string) => {
        key(cardId)
        if (type !== 'true' || !Number.isFinite(amount)) throw new Error('flow: 无效卡牌伤害参数')
        const target = piece(targetId)
        const card = battle.customCards?.[cardId]
        const sourceId = card && typeof card.sourcePieceId === 'string' ? card.sourcePieceId : undefined
        const source = sourceId === undefined
          ? target
          : battle.pieces.find(item => item.instanceId === sourceId) ?? battle.graveyard?.find(item => item.instanceId === sourceId) ?? target
        return call('dealDamage', source, target, amount, type, battle, skillId, true)
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
      damage: (source: any, targetId: string, amount: number, type: 'physical' | 'magical' | 'true', skillId = effectId(), inputPolicy: 'floor' | 'host' = 'floor', skipBefore = false) => {
        if (inputPolicy !== 'floor' && inputPolicy !== 'host') throw new Error('flow: 无效伤害输入策略')
        if (!Number.isFinite(amount)) throw new Error('flow: 数值必须有限')
        // Legacy dealDamage content lets beforeDamageDealt observe the original
        // amount. Preserve that timing; the authoritative host validates and rounds.
        return call('dealDamage', resolveSource(source), piece(targetId), inputPolicy === 'host' ? amount : Math.max(0, numeric(amount)), type, battle, skillId, skipBefore)
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
      tileBatchRecords: (effects: readonly Record<string, unknown>[], presentationBatch: 'direct' | 'queue' = 'direct') => {
        if (!['direct', 'queue'].includes(presentationBatch)) throw new Error('flow: 地格表现批次无效')
        if (!Array.isArray(effects)) throw new Error('flow: 地格效果批次必须是数组')
        const payload = json(effects)
        if (!Array.isArray(payload) || payload.some(effect => !effect || typeof effect !== 'object' || Array.isArray(effect))) {
          throw new Error('flow: 地格效果必须是记录')
        }
        if (payload.some(effect => !Number.isFinite(Number(effect.x)) || !Number.isFinite(Number(effect.y)))) {
          throw new Error('flow: 地格效果坐标无效')
        }
        // Keep duplicate checks and the single state commit in the existing
        // tile-effect boundary; this path only omits presentation metadata.
        if (presentationBatch === 'queue') createBattlePresentationQueue(battle).push('tileEffectAdded', () => { appendTileEffectsBatch(battle, payload) })
        else appendTileEffectsBatch(battle, payload)
        return true
      },
      replaceTileEffects: (effects: readonly Record<string, unknown>[]) => {
        if (!Array.isArray(effects)) throw new Error('flow: 地格效果批次必须是数组')
        // The legacy cleanup is intentionally a no-op when extensions or the
        // tile-effect array is absent.  Do not materialize either container.
        if (!battle.extensions || !Array.isArray(battle.extensions.tileEffects)) return true
        const payload = json(effects)
        if (!Array.isArray(payload) || payload.some(effect => !effect || typeof effect !== 'object' || Array.isArray(effect))) {
          throw new Error('flow: 地格效果必须是记录')
        }
        battle.extensions.tileEffects = payload
        return true
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
      fields: (handle: object | null) => {
        const reference = statusReference(handle)
        if (!reference) throw new Error('flow: 状态实例已经失效')
        return JSON.parse(JSON.stringify(reference.tag))
      },
      queryInstances: (targetId: string, statusType: string, sourceId?: string) => {
        if (typeof statusType !== 'string' || !statusType || (sourceId !== undefined && typeof sourceId !== 'string')) throw new Error('flow: 无效状态查询条件')
        const target = piece(targetId)
        return (target.statusTags || []).filter(tag => tag && typeof tag === 'object'
          && tag.type === statusType && (sourceId === undefined || tag.sourceId === sourceId)).map(tag => {
          return statusHandle(target, targetId, 'piece', tag)
        })
      },
      instances: (targetId: string, ownerKind: 'piece' | 'player' = 'piece') => {
        if (ownerKind !== 'piece' && ownerKind !== 'player') throw new Error('flow: 无效状态所属类型')
        const target = ownerKind === 'player' ? player(targetId) : piece(targetId)
        if (!Array.isArray(target.statusTags)) return { statuses: [], present: true }
        const statuses = target.statusTags.filter(tag => tag && typeof tag === 'object').map(tag => {
          return statusHandle(target, targetId, ownerKind, tag)
        })
        return { statuses, present: true }
      },
      instancesById: (targetId: string) => {
        if (typeof targetId !== 'string' || targetId.length === 0) throw new Error('flow: 无效状态棋子标识')
        const target = findPieceIncludingGraveyard(targetId)
        if (!target) return { statuses: [], present: false }
        if (!Array.isArray(target.statusTags)) return { statuses: [], present: true }
        const statuses = target.statusTags.filter(tag => tag && typeof tag === 'object').map(tag => (
          statusHandle(target, targetId, 'piece', tag)
        ))
        return { statuses, present: true }
      },
      removeInstance: (handle: object) => {
        const reference = statusReference(handle)
        if (!reference) throw new Error('flow: 状态实例已经失效')
        const index = reference.target.statusTags!.indexOf(reference.tag)
        reference.target.statusTags!.splice(index, 1)
        if (typeof reference.tag.instanceId === 'string') {
          retireStatusIdentity(reference.target, reference.tag.instanceId)
        }
        return true
      },
      removeInstanceLifecycle: (handle: object | null) => statusLifecycleRemove(handle),
      findInstance: (targetId: string, statusType: string) => {
        if (typeof statusType !== 'string' || !statusType) throw new Error('flow: 无效状态类型')
        const target = piece(targetId)
        const tag = (target.statusTags || []).find(candidate => candidate && typeof candidate === 'object' && candidate.type === statusType)
        if (!tag) return null
        return statusHandle(target, targetId, 'piece', tag)
      },
      readNumberInstance: (handle: object | null, field: string, fallback: number) => {
        if (!['stacks', 'intensity', 'currentDuration', 'remainingDuration', 'currentUses', 'remainingUses', 'remainingTurns', 'grantedTurnNumber', 'createdTurnNumber', 'value'].includes(field) || !Number.isFinite(fallback)) {
          throw new Error('flow: 无效状态实例数值字段')
        }
        const reference = statusReference(handle)
        const value = reference?.tag?.[field]
        if (field === 'remainingTurns' && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
          throw new Error('flow: 无效状态计数值')
        }
        return value == null ? fallback : Number(value)
      },
      writeField: (handle: object | null, field: string, value: unknown) => {
        const textFields = ['type', 'sourceId', 'name', 'stacking']
        const numberFields = [
          'currentDuration', 'remainingDuration', 'currentUses', 'remainingUses', 'lastDamageTurn',
          'stacks', 'intensity', 'hitCount', 'readyCharges', 'remainingTurns', 'grantedTurnNumber',
          'createdTurnNumber', 'turnNumber', 'value',
        ]
        if (field === 'relatedRules') {
          if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('flow: 无效状态实例字段')
        } else if (textFields.includes(field)) {
          if (typeof value !== 'string') throw new Error('flow: 无效状态实例字段')
        } else if (field === 'visible') {
          if (typeof value !== 'boolean') throw new Error('flow: 无效状态实例字段')
        } else if (field === 'expiresAfterTurn') {
          if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('flow: 无效状态实例字段')
        } else if (numberFields.includes(field)) {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('flow: 无效状态实例字段')
        } else {
          throw new Error('flow: 无效状态实例字段')
        }
        const reference = statusReference(handle)
        if (!reference) return false
        reference.tag[field] = Array.isArray(value) ? value.slice() : value
        return true
      },
      setNumberInstance: (handle: object | null, field: string, value: number) => {
        const counter = ['currentDuration', 'remainingDuration', 'currentUses', 'remainingUses'].includes(field)
        if ((!counter && !['stacks', 'intensity', 'remainingTurns', 'grantedTurnNumber', 'createdTurnNumber', 'value'].includes(field)) || !Number.isFinite(value)
          || (counter && (!Number.isSafeInteger(value) || value < -1))) throw new Error('flow: 无效状态实例数值字段')
        const reference = statusReference(handle)
        if (!reference) return false
        reference.tag[field] = value
        return true
      },
      hasSkillInstance: (handle: object | null, skillId: string | null) => {
        if (skillId !== null && typeof skillId !== 'string') throw new Error('flow: 无效状态技能标识')
        const reference = statusReference(handle)
        return Boolean(reference && typeof skillId === 'string' && Array.isArray(reference.tag.skillIds) && reference.tag.skillIds.includes(skillId))
      },
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
      current: () => {
        const target = context.rulePiece ?? context.piece ?? context.sourcePiece
        const targetKind: 'piece' | 'player' = target && typeof target.instanceId === 'string' ? 'piece' : 'player'
        const targetId = targetKind === 'piece' ? target?.instanceId : context.playerId
        const owner = targetKind === 'piece'
          ? battle.pieces.find(candidate => candidate.instanceId === targetId)
          : battle.players.find(candidate => candidate.playerId === targetId)
        if (!owner || !Array.isArray(owner.rules)) throw new Error('flow: 当前上下文没有规则实例')
        const ruleId = context.ruleId ?? context.rule?.id
        const candidates = owner.rules.filter(rule => context.ruleInstance
          ? rule === context.ruleInstance
          : typeof context.ruleInstanceId === 'string'
            ? rule?.instanceId === context.ruleInstanceId && (ruleId === undefined || rule.id === ruleId)
            : typeof ruleId === 'string' ? rule.id === ruleId : false)
        if (candidates.length !== 1) throw new Error('flow: 当前规则实例缺失或不唯一')
        const handle = Object.freeze({ scope: 'rule-instance' })
        ruleReferences.set(handle, { targetId: targetId!, targetKind, rule: candidates[0] })
        return { instance: handle }
      },
      instances: (targetId: string, scope: 'piece' | 'player' = 'piece') => {
        const owner = scope === 'piece' ? piece(targetId) : player(targetId)
        const rules = Array.isArray(owner.rules) ? owner.rules : []
        const instances = rules.map(rule => {
          const handle = Object.freeze({ scope: 'rule-instance' })
          ruleReferences.set(handle, { targetId, targetKind: scope, rule })
          return handle
        })
        return { instances, present: true }
      },
      add: (targetId: string, ruleId: string, scope: 'piece' | 'player' = 'piece') => {
        const result = call(scope === 'piece' ? 'addRuleById' : 'addPlayerRuleById', targetId, ruleId)
        if (scope === 'piece' && piece(targetId).abilityGroupOwnership && piece(targetId).rules.some(rule => rule.id === ruleId)) recordDirectRuleAdded(piece(targetId), ruleId)
        return result
      },
      remove: (targetId: string, ruleId: string, scope: 'piece' | 'player' = 'piece') => {
        const result = call(scope === 'piece' ? 'removeRuleById' : 'removePlayerRuleById', targetId, ruleId)
        if (scope === 'piece' && piece(targetId).abilityGroupOwnership && !piece(targetId).rules.some(rule => rule.id === ruleId)) recordDirectRuleRemoved(piece(targetId), ruleId)
        return result
      },
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
      currentId: () => {
        const id = context.card?.id ?? context.cardInstance?.cardId
        return typeof id === 'string' ? id : ''
      },
      currentType: () => typeof context.type === 'string' ? context.type : '',
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
      removeField: (playerId: string, instanceId: string, field: string, subfield?: string) => {
        if (!['contentState', 'effectModifiers', 'presentation', 'boundPieceInstanceId'].includes(field)) throw new Error('flow: 手牌字段不可移除')
        if (subfield !== undefined) { if (field !== 'contentState') throw new Error('flow: 该手牌字段不支持子字段'); key(subfield) }
        const cards = (player(playerId).hand ?? []).filter(card => card.instanceId === instanceId)
        if (cards.length > 1) throw new Error('flow: 手牌实例标识不唯一')
        const target = subfield === undefined ? cards[0] : cards[0]?.contentState
        const selected = subfield ?? field
        if (!target || !Object.prototype.hasOwnProperty.call(target, selected)) return false
        delete (target as any)[selected]
        return true
      },
      writeField: (playerId: string, instanceId: string, field: string, value: unknown, subfield?: string) => {
        if (!['contentState', 'effectModifiers', 'presentation', 'boundPieceInstanceId'].includes(field)) throw new Error('flow: 手牌字段不可写')
        if (subfield !== undefined) {
          if (field !== 'contentState') throw new Error('flow: 该手牌字段不支持子字段')
          key(subfield)
        }
        const cards = (player(playerId).hand ?? []).filter(card => card.instanceId === instanceId)
        if (cards.length > 1) throw new Error('flow: 手牌实例标识不唯一')
        if (!cards.length) return false
        const copied = json(value)
        if (subfield === undefined && (field === 'boundPieceInstanceId' ? typeof copied !== 'string'
          : field === 'effectModifiers' ? !Array.isArray(copied)
          : !copied || typeof copied !== 'object' || Array.isArray(copied))) throw new Error('flow: 手牌字段值类型不匹配')
        if (field === 'effectModifiers' && copied.some((modifier: unknown) => {
          if (!modifier || typeof modifier !== 'object' || Array.isArray(modifier)) return true
          const entry = modifier as Record<string, unknown>
          return !['damage', 'heal', 'statusIntensity'].includes(entry.effect as string)
            || !['add', 'multiply'].includes(entry.operation as string)
            || typeof entry.value !== 'number' || !Number.isFinite(entry.value)
            || (entry.statusType !== undefined && typeof entry.statusType !== 'string')
        })) throw new Error('flow: 手牌效果修正字段无效')
        if (field === 'presentation' && Object.entries(copied).some(([name, entry]) =>
          !['variant', 'badge', 'description'].includes(name) || typeof entry !== 'string')) throw new Error('flow: 手牌显示字段无效')
        const card = cards[0] as any
        if (subfield === undefined) card[field] = copied
        else { card.contentState ??= {}; card.contentState[subfield] = copied }
        return true
      },
      add: (playerId: string, cardId: string) => call('addCardToHand', cardId, playerId),
      gain: (playerId: string, cardId: string, initialization?: import('./author-extension').AuthorInitialValue) => call('gainCardInstance', cardId, playerId, initialization),
      discard: (instanceId: string) => call('discardCard', instanceId),
    },
    content: {
      enemyPlayer: (ownerId: string | null) => ownerId == null ? null : nextMatchOpponent(battle, ownerId) ?? null,
      filterHand: (playerId: string | null, options: { nameContains?: string | null; cardIdPrefix?: string | null }) => {
        const owner = battle.players.find(item => item.playerId === playerId)
        if (!owner?.hand) return { cards: [], hasHand: false }
        return { cards: owner.hand.filter(card => (options.nameContains != null && card.name?.includes(options.nameContains)) || (options.cardIdPrefix != null && card.cardId?.startsWith(options.cardIdPrefix))).map(card => card.cardId), hasHand: true }
      },
      cardNumber: (cardId: string, field: 'damageAmount', fallback = 0) => {
        key(cardId)
        if (field !== 'damageAmount' || !Number.isFinite(fallback)) throw new Error('flow: 无效卡牌数值字段')
        const value = battle.customCards?.[cardId]?.damageAmount
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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
      materializeTemplate: (options: { kind: 'card'; templateId: string; cardId: string; name: string; description: string; owner?: string | null; extension?: Record<string, unknown>; fields?: Record<string, unknown>; omitFields?: string[] }) => {
        if (options.kind !== 'card') throw new Error('flow: 不支持的内容模板类型')
        key(options.templateId); key(options.cardId)
        const template = call('loadCardDefinition', options.templateId)
        if (!template?.gameplayModules?.entries?.code) throw new Error('flow: 卡牌模板必须提供已验证模块图')
        // A skill/rule definition may also carry a verified module graph, but
        // it is not a card template and must never be copied into customCards.
        // Keep the legacy fixture shape (which omits `type`) compatible while
        // rejecting explicitly non-card definitions before any mutation.
        if (template.type !== undefined && template.type !== 'active' && template.type !== 'reactive') throw new Error('flow: 卡牌模板类型无效')
        // Executable and identity fields are supplied only by the trusted
        // template. Data bindings cannot replace code or inject graph nodes.
        const fields = options.fields === undefined ? {} : json(options.fields)
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('flow: 卡牌字段绑定必须为记录')
        const writableFields = new Set(['damageAmount', 'powerMultiplier', 'actionPointCost', 'chargeCost', 'range', 'tags', 'trigger'])
        for (const name of Object.keys(fields)) {
          if (!writableFields.has(name)) throw new Error('flow: 卡牌字段不可绑定: ' + name)
          const invalid = name === 'tags' ? !Array.isArray(fields[name]) || fields[name].some((tag: unknown) => typeof tag !== 'string')
            : name === 'trigger' ? !fields[name] || typeof fields[name] !== 'object' || Array.isArray(fields[name]) || typeof fields[name].type !== 'string'
            : typeof fields[name] !== 'number' || !Number.isFinite(fields[name])
          if (invalid) throw new Error('flow: 卡牌字段绑定类型错误: ' + name)
        }
        const extension = options.extension === undefined ? undefined : json(options.extension)
        if (extension !== undefined && (!extension || typeof extension !== 'object' || Array.isArray(extension))) throw new Error('flow: 扩展变量须为记录')
        const omitted = options.omitFields ?? []
        if (!Array.isArray(omitted) || omitted.some(name => !['isSample', 'image', 'effectTags', 'targetText', 'keywords'].includes(name))) throw new Error('flow: 只能省略模板展示字段')
        const copiedTemplate = json(template, 16 * 1024 * 1024)
        for (const name of omitted) delete copiedTemplate[name]
        battle.customCards ??= {}
        // Validated content includes generated code and graph metadata, which
        // are larger than an extension value. Keep the data-binding limit above.
        battle.customCards[options.cardId] = { ...copiedTemplate, ...fields, ...(extension === undefined ? {} : { extension }), id: options.cardId, name: options.name, description: options.description }
        return { cardId: options.cardId, success: true }
      },
      materializeCurseTemplate: (options: { templateId: string; cardId: string; name: string; description: string; owner?: string | null; damageAmount: number; sourcePieceId?: string | null }) => {
        if (!Number.isFinite(options.damageAmount)) throw new Error('flow: 诅咒伤害值必须有限')
        if (options.owner !== undefined && options.owner !== null) player(options.owner)
        key(options.templateId); key(options.cardId)
        if (typeof options.name !== 'string' || typeof options.description !== 'string' || (options.sourcePieceId !== undefined && options.sourcePieceId !== null && typeof options.sourcePieceId !== 'string')) throw new Error('flow: 诅咒模板参数无效')
        const template = call('loadCardDefinition', options.templateId)
        if (!template?.gameplayModules?.entries?.code) throw new Error('flow: 卡牌模板必须提供已验证模块图')
        battle.customCards ??= {}
        // A generated curse keeps the executable from the verified semantic
        // template, while its persisted record follows the legacy generated
        // card shape.  Presentation-only sample metadata (and the sample
        // marker) must not leak into battle.customCards.
        battle.customCards[options.cardId] = {
          id: options.cardId,
          name: options.name,
          description: options.description,
          type: template.type ?? 'reactive',
          trigger: { type: 'endTurn' },
          icon: template.icon,
          actionPointCost: template.actionPointCost,
          damageAmount: options.damageAmount,
          sourcePieceId: options.sourcePieceId ?? undefined,
          code: template.code,
        }
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
      setMaxHp: (id: string, value: number) => {
        const target = piece(id)
        if (!Number.isFinite(value) || value <= 0 || value < target.currentHp) throw new Error('flow: 生命上限无效')
        target.maxHp = value
        return value
      },
      setMomentum: (id: string, value: number) => {
        if (!Number.isFinite(value)) throw new Error('flow: 动能无效')
        const target = piece(id) as any
        target.momentum = value
        return target.momentum
      },
      set: (id: string, attribute: 'attack' | 'defense' | 'moveRange', value: number) => {
        if (!['attack','defense','moveRange'].includes(attribute)) throw new Error('flow: 无效属性')
        if (!Number.isFinite(value)) throw new Error('flow: 属性无效')
        piece(id)[attribute] = value
        return value
      },
      setStored: (id: string, attribute: 'attack' | 'defense' | 'moveRange' | 'showFreezeEffect', value: number | boolean) => {
        if (!['attack', 'defense', 'moveRange', 'showFreezeEffect'].includes(attribute)) throw new Error('flow: 无效保存属性')
        if (attribute === 'showFreezeEffect' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value)) throw new Error('flow: 保存属性无效')
        const target = battle.pieces.find(candidate => candidate.instanceId === id)
          ?? battle.graveyard?.find(candidate => candidate.instanceId === id)
        if (!target) return false
        ;(target as any)[attribute] = value
        return true
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
      current: () => {
        if (!['skill', 'pending'].includes(surface)) throw new Error('flow: 当前上下文没有正在使用的技能实例')
        const owner = context.piece ?? context.sourcePiece
        const target = owner ? battle.pieces.find(candidate => candidate === owner || candidate.instanceId === owner.instanceId) : undefined
        const id = context.skill?.id ?? context.skillId
        const candidates = target?.skills.filter(candidate => context.skillInstance
          ? candidate === context.skillInstance
          : typeof context.skillInstanceId === 'string'
            ? candidate.instanceId === context.skillInstanceId && (id === undefined || candidate.skillId === id)
            : candidate.skillId === id) ?? []
        if (!target || candidates.length !== 1) throw new Error('flow: 当前技能实例缺失或不唯一')
        const handle = Object.freeze({ scope: 'skill-instance' })
        skillReferences.set(handle, { pieceId: target.instanceId, index: target.skills.indexOf(candidates[0]), skill: candidates[0] })
        return { instance: handle }
      },
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
      instances: (id: string) => {
        if (typeof id !== 'string' || !id) throw new Error('flow: 无效技能棋子标识')
        const target = battle.pieces.find(candidate => candidate.instanceId === id)
        if (!target || !Array.isArray(target.skills)) return { instances: [], present: false }
        const instances = target.skills.map((skill, index) => {
          if (!skill || typeof skill !== 'object') throw new Error('flow: 技能实例无效')
          const handle = Object.freeze({ scope: 'skill-instance' })
          skillReferences.set(handle, { pieceId: id, index, skill })
          return handle
        })
        return { instances, present: true }
      },
      field: (handle: object | null, field: 'skillId' | 'kind' | 'currentCooldown' | 'definitionExists' | 'usesRemaining' | 'level' | 'owner') => {
        if (!['skillId', 'kind', 'currentCooldown', 'definitionExists', 'usesRemaining', 'level', 'owner'].includes(field)) throw new Error('flow: 无效技能实例字段')
        const reference = skillReference(handle)
        if (!reference) throw new Error('flow: 技能实例已经失效')
        const skill = reference.skill
        const value = field === 'definitionExists'
          ? Boolean(battle.skillsById && Object.prototype.hasOwnProperty.call(battle.skillsById, skill.skillId))
          : field === 'owner' ? reference.target.instanceId : field === 'kind'
            ? battle.skillsById?.[skill.skillId]?.kind
            : skill[field]
        return { value: value === undefined ? null : value, defined: value !== undefined }
      },
      setInstanceCooldown: (handle: object | null, value: number) => {
        if (!Number.isFinite(value)) throw new Error('flow: 技能冷却值无效')
        const reference = skillReference(handle)
        if (!reference) throw new Error('flow: 技能实例已经失效')
        reference.skill.currentCooldown = numeric(value)
        return true
      },
      setInstanceField: (handle: object | null, field: 'usesRemaining' | 'level', value: number) => {
        if (!['usesRemaining', 'level'].includes(field)) throw new Error('flow: 此技能字段不可修改')
        const reference = skillReference(handle)
        if (!reference) throw new Error('flow: 技能实例已经失效')
        const next = numeric(value)
        if (field === 'usesRemaining' ? next < -1 : next < 0) throw new Error('flow: 技能字段数值无效')
        reference.skill[field] = next
        return true
      },
      definitionReference: (skillId: string) => {
        key(skillId)
        if (!battle.skillsById || !Object.hasOwn(battle.skillsById, skillId)) {
          // A live skill host can resolve a verified definition lazily.  Keep
          // direct flow facades strict when no resolver is supplied, while
          // allowing content references to retain the legacy add/remove
          // lifecycle in hosts whose registry starts empty.
          if (typeof delegates.loadSkillDefinition !== 'function') throw new Error('flow: 技能定义不存在')
          const definition = call('loadSkillDefinition', skillId)
          if (!definition || typeof definition !== 'object') throw new Error('flow: 技能定义不存在')
        }
        return skillId
      },
      add: (id: string, skillId: string, scope: 'piece' | 'player' = 'piece') => {
        if (scope !== 'piece' && scope !== 'player') throw new Error('flow: 无效技能持有者类型')
        key(skillId)
        if (scope === 'player') { player(id); return call('addPlayerSkillById', id, skillId) }
        const result = call('addSkillById', id, skillId)
        if (piece(id).abilityGroupOwnership && piece(id).skills.some(skill => skill.skillId === skillId)) recordDirectSkillAdded(piece(id), skillId)
        return result
      },
      remove: (id: string, skillId: string, scope: 'piece' | 'player' = 'piece') => {
        if (scope !== 'piece' && scope !== 'player') throw new Error('flow: 无效技能持有者类型')
        key(skillId)
        if (scope === 'player') { player(id); return call('removePlayerSkillById', id, skillId) }
        const result = call('removeSkillById', id, skillId)
        if (piece(id).abilityGroupOwnership && !piece(id).skills.some(skill => skill.skillId === skillId)) recordDirectSkillRemoved(piece(id), skillId)
        return result
      },
      resetCooldown: (id: string, skillIds?: string[]) => { for (const skill of piece(id).skills) if (!skillIds || skillIds.includes(skill.skillId)) skill.currentCooldown = 0 },
    },
    codeBlocks: {
      invoke: (block: unknown, argumentsValue: Record<string, unknown>, expected?: { type: import('../skill-graph/module-types').GameplayValueType; schemas: readonly import('../skill-graph/module-types').GameplayRecordSchema[] }) => call('invokeAuthorCodeBlock', block, argumentsValue, expected),
    },
    clusters: {
      acquire: (id: string, definition: AuthorClusterDefinition) => {
        piece(id)
        const group = call('acquireAuthorCluster', id, json(definition))
        return { ...json(group), ownerPieceId: id }
      },
      list: (id: string) => (piece(id).abilityGroups ?? []).map(group => ({ ...json(group), ownerPieceId: id })),
      remove: (group: { ownerPieceId: string; instanceId: string }) => {
        if (!group || typeof group.ownerPieceId !== 'string' || typeof group.instanceId !== 'string') throw new Error('flow: 无效能力组实例')
        piece(group.ownerPieceId)
        return call('removeAuthorCluster', group.ownerPieceId, group.instanceId)
      },
    },
    lifecycle: {
      destroy: (target: string | readonly string[], source?: string) => {
        if (source !== undefined) piece(source)
        return call('destroyAuthorPieces', Array.isArray(target) ? target : [target], source)
      },
      summonAuthored: (sourceRef: string | object, template: AuthoredPieceTemplate | readonly AuthoredPieceTemplate[] | string | readonly string[], destination: GridPosition | readonly GridPosition[], display: AuthoredDisplaySpec = {}, mode: 'new-instance' | 'return-instance' = 'new-instance', currentHp?: number) => {
        // A normal author graph supplies a live piece ID.  A graph that has
        // explicitly captured its source supplies the authenticated
        // execution handle instead.  Both paths pass sourceId to the existing
        // declaration queue; settlement resolves board/graveyard state through
        // the same authoritative resolver used by captured summons.
        const sourcePiece = typeof sourceRef === 'string' ? piece(sourceRef) : capturedSource(sourceRef)
        const sourceId = sourcePiece.instanceId
        const cells = Array.isArray(destination) ? destination : [destination]
        const templates = Array.isArray(template) ? template : cells.map(() => template)
        if (!cells.length || cells.length > 64 || cells.length !== templates.length) throw new Error('flow: 召唤棋子与落点须逐项对应')
        const summons = cells.map((cell, index) => parseAuthoredSummonSpec(mode === 'new-instance'
          ? { mode, x: cell.x, y: cell.y, template: templates[index], display }
          : { mode, x: cell.x, y: cell.y, instanceId: templates[index], ...(currentHp === undefined ? {} : { currentHp }) }))
        if (!context.summonQueue) throw new Error('flow: 召唤需由当前内容声明summonCapability')
        // The authoritative batch validator rejects occupied cells.  When an
        // author effect can already observe that invariant before enqueueing
        // (for example after a blocked displacement), expose the same
        // ordinary blocked-effect result and leave deferred/race validation
        // to that sealed host.  This applies to every active occupant and
        // does not depend on a particular skill or source identity.
        if (cells.some(cell => battle.pieces.some(piece => (
          piece.currentHp > 0
          && piece.x === cell.x
          && piece.y === cell.y
        )))) {
          return { success: false, blocked: true, message: '召唤落点已被占用' }
        }
        const chain = getActiveEffectChain(battle)
        context.summonQueue.push({ sourceId, summons })
        if (chain?.state === 'idle') return call('settleAuthorSummons', sourceId, effectId())
        return { queued: true }
      },
      summonDeclared: (sourceRef: string | object, destination: GridPosition | readonly GridPosition[]) => {
        // The declaration recipe is resolved by the authoritative summon
        // queue.  A captured source must first be authenticated against this
        // execution; the queue then keeps the same sourceId contract used by
        // lifecycle.summonCaptured and lets its existing resolver apply the
        // board/graveyard rules at settlement time.
        const sourceId = typeof sourceRef === 'string'
          ? (piece(sourceRef), sourceRef)
          : capturedSource(sourceRef).instanceId
        const cells = Array.isArray(destination) ? destination : [destination]
        if (!cells.length || cells.length > 64) throw new Error('flow: 召唤落点数量无效')
        for (const cell of cells) {
          if (!cell || !Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y)) throw new Error('flow: 无效召唤地格')
        }
        if (!context.summonQueue) throw new Error('flow: 召唤需由当前内容声明summonCapability')
        const queueCount = context.summonQueue.push({
          sourceId,
          summons: cells.map(cell => ({ x: cell.x, y: cell.y })),
        })
        return { queued: true, queueCount }
      },
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
      detachActive: (id: string, flowStatePolicy: 'cleanup' | 'preserve' = 'cleanup', detachMode: 'author' | 'data-owned' = 'author') => {
        if (typeof id !== 'string' || id.length === 0) return false
        if (flowStatePolicy !== 'cleanup' && flowStatePolicy !== 'preserve') throw new Error('flow: 无效离场状态策略')
        if (detachMode !== 'author' && detachMode !== 'data-owned') throw new Error('flow: 无效离场所有权策略')
        const index = battle.pieces.findIndex(item => item.instanceId === id)
        if (index < 0) return false
        // Historical data-owned descriptors already copy their detached record
        // into a content extension.  Keep that compatibility mode explicit so
        // future trigger-skill content still gets the generic author snapshot.
        if (detachMode === 'data-owned') {
          battle.pieces.splice(index, 1)
          return true
        }
        preserveDepartingPiece(battle, id, flowStatePolicy)
        const [removed] = battle.pieces.splice(index, 1)
        if (flowStatePolicy === 'cleanup' && removed?.instanceId) clearRemovedPieceFlowState(battle, [removed.instanceId])
        return true
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
      get: getState,
      set: setState,
      remove: removeState,
      cleanup: () => { if (battle.extensions) battle.extensions.flowState = records().filter(e => !expired(e)) },
    },
  }
}
