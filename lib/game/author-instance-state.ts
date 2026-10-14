import type { BattleState } from './battle-types'
import type { PieceInstance } from './piece'
import {
  assertSkillDefinition,
  loadRuleForBattle,
  loadSkillForBattle,
  restorePersistedRuleRuntime,
} from './skills'

/**
 * The authoring instance API stores a deliberately small, JSON-compatible
 * record.  Executable rules are omitted from the record and loaded again from
 * the battle's content registry when the record is applied.
 */
export const AUTHOR_PIECE_INSTANCE_SNAPSHOT_VERSION = 1 as const
export const AUTHOR_PIECE_INSTANCE_SNAPSHOT_KIND = 'author-piece-instance/v1' as const
export const AUTHOR_PIECE_INSTANCE_FLOW_NAMESPACE = 'instances' as const

const MAX_SNAPSHOT_LENGTH = 65_536
const MAX_DEPTH = 40
const REF_KEY = '$ref'
const LITERAL_KEY = '$literal'
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const PROTECTED_KEYS = new Set([
  'instanceId',
  'x',
  'y',
])
const RULE_RUNTIME_KEYS = new Set([
  'id',
  'name',
  'description',
  'trigger',
  'effect',
  'targetValidation',
  'limits',
])
const FLOW_KEY_PATTERN = /^[\p{L}\p{N}_.:-]{1,120}$/u

type JsonRecord = Record<string, unknown>
type PieceLike = PieceInstance & JsonRecord

class InvalidPieceInstanceSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPieceInstanceSnapshotError'
  }
}

type EntityReferenceKind = 'piece' | 'player'
type EntityReference = {
  kind: EntityReferenceKind
  id: string
}
type AuthorPieceIdentity = {
  templateId: string
  name: string
  faction: string
  ownerPlayerId: string
  isCore?: boolean
}

type AuthorPieceFlowStateRecord = {
  schemaVersion: 1
  scope: 'piece'
  entityId: string
  ownerPlayerId: string
  namespace: string
  name: string
  value: unknown
  lifetime: 'battle' | 'while-alive'
  projectionVisibility: 'owner' | 'public'
}

export interface AuthorPieceInstanceSnapshot {
  schemaVersion: typeof AUTHOR_PIECE_INSTANCE_SNAPSHOT_VERSION
  kind: typeof AUTHOR_PIECE_INSTANCE_SNAPSHOT_KIND
  sourcePieceId: string
  ownerPlayerId: string
  identity: AuthorPieceIdentity
  /** Mutable piece fields. `rules` contains de-hydrated descriptors. */
  fields: JsonRecord
  /** Piece-scoped flow state only; player and battle records never enter here. */
  flowState: AuthorPieceFlowStateRecord[]
}

type RefCatalog = {
  byObject: Map<object, EntityReference>
  resolve(reference: EntityReference): object | undefined
}

function isPlainObject(value: unknown): value is JsonRecord {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertSafePropertyName(name: string): void {
  if (DANGEROUS_KEYS.has(name)) throw new Error('instance snapshot contains a dangerous property')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function ownDataEntries(value: JsonRecord, omitted?: ReadonlySet<string>): Array<[string, unknown]> {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('instance snapshot does not allow symbol properties')
  }
  return Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([name]) => !omitted?.has(name)).map(([name, descriptor]) => {
    assertSafePropertyName(name)
    if (!('value' in descriptor)) throw new Error('instance snapshot does not allow accessors')
    return [name, descriptor.value]
  })
}

function isArrayIndex(name: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(name)) return false
  const index = Number(name)
  return Number.isSafeInteger(index)
}

function cloneJsonValue(
  value: unknown,
  catalog: RefCatalog | undefined,
  seen: Set<object> = new Set(),
  depth = 0,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('instance snapshot requires finite numbers')
    return value
  }
  if (typeof value !== 'object' || !value) {
    throw new Error('instance snapshot only accepts JSON values')
  }
  if (catalog) {
    const reference = catalog.byObject.get(value)
    if (reference) return { [REF_KEY]: { kind: reference.kind, id: reference.id } }
  }
  if (depth > MAX_DEPTH || seen.has(value)) {
    throw new Error('instance snapshot contains a cycle or is too deeply nested')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error('instance snapshot does not allow symbol properties')
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (name === 'length') continue
        if (!isArrayIndex(name) || !('value' in descriptor)) {
          throw new Error('instance snapshot arrays may only contain indexed values')
        }
      }
      const result: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) {
          throw new Error('instance snapshot does not allow sparse arrays')
        }
        result.push(cloneJsonValue(descriptor.value, catalog, seen, depth + 1))
      }
      return result
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('instance snapshot only accepts plain objects')
    }
    const result: JsonRecord = {}
    for (const [name, child] of ownDataEntries(value as JsonRecord)) {
      result[name] = cloneJsonValue(child, catalog, seen, depth + 1)
    }
    // User extension objects may contain the same spelling as an encoded
    // reference. Escape such objects only while capturing live values;
    // validation copies of an already encoded snapshot must preserve them.
    return catalog && (Object.hasOwn(result, REF_KEY) || Object.hasOwn(result, LITERAL_KEY)) ? { [LITERAL_KEY]: result } : result
  } finally {
    seen.delete(value)
  }
}
function serializedLength(value: unknown): number {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new Error('instance snapshot is not serializable')
  return encoded.length
}

function assertSnapshotSize(value: unknown): void {
  if (serializedLength(value) > MAX_SNAPSHOT_LENGTH) {
    throw new Error('instance snapshot exceeds 64KB')
  }
}

function addPieceReference(byObject: Map<object, EntityReference>, piece: PieceInstance | undefined): void {
  if (!piece || !isString(piece.instanceId)) return
  byObject.set(piece, { kind: 'piece', id: piece.instanceId })
}

function buildReferenceCatalog(battle: BattleState): RefCatalog {
  const byObject = new Map<object, EntityReference>()
  for (const piece of battle.pieces || []) addPieceReference(byObject, piece)
  for (const piece of battle.graveyard || []) addPieceReference(byObject, piece)
  for (const player of battle.players || []) {
    if (isString(player.playerId)) byObject.set(player, { kind: 'player', id: player.playerId })
  }
  for (const pieces of Object.values(battle.deployment?.reserves || {})) {
    if (Array.isArray(pieces)) for (const piece of pieces) addPieceReference(byObject, piece)
  }
  return {
    byObject,
    resolve(reference) {
      if (reference.kind === 'player') {
        return battle.players?.find(player => player.playerId === reference.id)
      }
      const active = battle.pieces?.find(piece => piece.instanceId === reference.id)
      if (active) return active
      const grave = battle.graveyard?.find(piece => piece.instanceId === reference.id)
      if (grave) return grave
      for (const pieces of Object.values(battle.deployment?.reserves || {})) {
        const found = Array.isArray(pieces) ? pieces.find(piece => piece.instanceId === reference.id) : undefined
        if (found) return found
      }
      return undefined
    },
  }
}

function parseReference(value: unknown): EntityReference | undefined {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !isPlainObject(value[REF_KEY])) return undefined
  const candidate = value[REF_KEY]
  if (Object.keys(candidate).some(key => key !== 'kind' && key !== 'id')) return undefined
  if ((candidate.kind !== 'piece' && candidate.kind !== 'player') || !isString(candidate.id)) return undefined
  return { kind: candidate.kind, id: candidate.id }
}

function decodeReferences(value: unknown, catalog: RefCatalog, seen: Set<object> = new Set(), depth = 0, literalObject = false): unknown {
  if (!literalObject && isPlainObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, LITERAL_KEY)) {
    if (!isPlainObject(value[LITERAL_KEY])) throw new InvalidPieceInstanceSnapshotError('instance snapshot literal object is invalid')
    return decodeReferences(value[LITERAL_KEY], catalog, seen, depth + 1, true)
  }
  const reference = literalObject ? undefined : parseReference(value)
  if (reference) {
    const resolved = catalog.resolve(reference)
    if (!resolved) throw new InvalidPieceInstanceSnapshotError('instance snapshot contains an unavailable entity reference')
    return resolved
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (!value || typeof value !== 'object') throw new InvalidPieceInstanceSnapshotError('instance snapshot contains an invalid value')
  if (depth > MAX_DEPTH || seen.has(value)) throw new InvalidPieceInstanceSnapshotError('instance snapshot contains a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => decodeReferences(item, catalog, seen, depth + 1))
    if (!isPlainObject(value)) throw new InvalidPieceInstanceSnapshotError('instance snapshot contains a non-plain value')
    const result: JsonRecord = {}
    for (const [name, child] of ownDataEntries(value)) result[name] = decodeReferences(child, catalog, seen, depth + 1)
    return result
  } finally {
    seen.delete(value)
  }
}

function dehydrateRule(rule: unknown, catalog: RefCatalog): JsonRecord {
  if (!isPlainObject(rule)) throw new Error('piece rule must be a plain object')
  const result: JsonRecord = {}
  for (const [name, value] of ownDataEntries(rule)) {
    if (name === 'effect') continue
    if (value === undefined) continue
    result[name] = cloneJsonValue(value, catalog)
  }
  return result
}

function snapshotIdentity(piece: PieceLike): AuthorPieceIdentity {
  if (!isString(piece.templateId) || !isString(piece.faction) || !isString(piece.ownerPlayerId)) {
    throw new Error('piece identity is incomplete')
  }
  const identity: AuthorPieceIdentity = {
    templateId: piece.templateId,
    // Some legacy/minimal pieces omit the presentation name even though the
    // template identity and gameplay attributes are complete.  Keep the
    // snapshot self-contained by using the stable template name only for
    // that compatibility case; an explicitly authored name is preserved.
    name: isString(piece.name) ? piece.name : piece.templateId,
    faction: piece.faction,
    ownerPlayerId: piece.ownerPlayerId,
  }
  if (piece.isCore !== undefined) {
    if (typeof piece.isCore !== 'boolean') throw new Error('piece identity has an invalid core flag')
    identity.isCore = piece.isCore
  }
  return identity
}

function activePiece(battle: BattleState, pieceId: string): PieceLike | undefined {
  if (!isString(pieceId)) return undefined
  const found = battle.pieces?.find(piece => piece.instanceId === pieceId)
  return found as PieceLike | undefined
}

function flowRecords(battle: BattleState): unknown[] {
  const value = battle.extensions?.flowState
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('flow state is not an array')
  return value
}

function validFlowRecord(value: unknown): value is AuthorPieceFlowStateRecord {
  if (!isPlainObject(value)) return false
  if (value.schemaVersion !== 1 || value.scope !== 'piece') return false
  if (!isString(value.entityId) || !isString(value.ownerPlayerId)) return false
  if (!isString(value.namespace) || !FLOW_KEY_PATTERN.test(value.namespace)) return false
  if (!isString(value.name) || !FLOW_KEY_PATTERN.test(value.name)) return false
  if (value.lifetime !== 'battle' && value.lifetime !== 'while-alive') return false
  if (value.projectionVisibility !== 'owner' && value.projectionVisibility !== 'public') return false
  return true
}

function captureFlowState(battle: BattleState, piece: PieceLike): AuthorPieceFlowStateRecord[] {
  const records = flowRecords(battle)
  const selected: AuthorPieceFlowStateRecord[] = []
  for (const record of records) {
    // Player and battle records belong to their own owners and are never
    // copied as part of a piece snapshot.
    if (!isPlainObject(record) || record.scope !== 'piece') continue
    if (!validFlowRecord(record)) throw new Error('flow state contains an invalid record')
    if (record.entityId !== piece.instanceId) continue
    if (record.ownerPlayerId !== piece.ownerPlayerId) throw new Error('flow state owner does not match piece')
    const cloned = cloneJsonValue(record, undefined)
    if (!isPlainObject(cloned)) throw new Error('flow state record is not serializable')
    selected.push({
      ...cloned,
    } as AuthorPieceFlowStateRecord)
  }
  return selected
}

function validateIdentity(battle: BattleState, target: PieceLike, snapshot: AuthorPieceInstanceSnapshot): boolean {
  const identity = snapshot.identity
  const fields = snapshot.fields
  const ownerExists = battle.players?.some(player => player.playerId === snapshot.ownerPlayerId) ?? false
  const targetOwnerExists = battle.players?.some(player => player.playerId === target.ownerPlayerId) ?? false
  return ownerExists
    && targetOwnerExists
    && fields.ownerPlayerId === snapshot.ownerPlayerId
    && fields.templateId === identity.templateId
    && fields.name === identity.name
    && fields.faction === identity.faction
    && identity.ownerPlayerId === snapshot.ownerPlayerId
    && (identity.isCore === undefined || fields.isCore === identity.isCore)
    && isString(target.ownerPlayerId)
}

function validateSkillState(value: unknown, battle: BattleState, sourceId: string): boolean {
  if (!Array.isArray(value)) return false
  for (const descriptor of value) {
    const skillId = typeof descriptor === 'string'
      ? descriptor
      : isPlainObject(descriptor) && typeof descriptor.skillId === 'string' ? descriptor.skillId : ''
    if (!isString(skillId)) return false
    if (isPlainObject(descriptor)) {
      if (descriptor.currentCooldown !== undefined
        && (!Number.isSafeInteger(descriptor.currentCooldown) || Number(descriptor.currentCooldown) < 0)) return false
      if (descriptor.usesRemaining !== undefined
        && (!Number.isSafeInteger(descriptor.usesRemaining) || Number(descriptor.usesRemaining) < -1)) return false
      if (descriptor.level !== undefined
        && (!Number.isSafeInteger(descriptor.level) || Number(descriptor.level) < 0)) return false
    }
    const definition = loadSkillForBattle(battle, skillId, battle.skillsById?.[skillId], {
      metadata: { sourceId, skillId },
    })
    if (!definition) return false
    if (definition.kind !== 'passive') assertSkillDefinition(skillId, definition, { requireExecutable: true })
  }
  return true
}

function validateStatusTags(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  for (const status of value) {
    if (!isPlainObject(status) || !isString(status.type) || (status.id !== undefined && !isString(status.id))) return false
    if (status.relatedRules !== undefined
      && (!Array.isArray(status.relatedRules) || status.relatedRules.some(ruleId => !isString(ruleId)))) return false
  }
  return true
}

function validateAttributes(fields: JsonRecord): boolean {
  const maxHp = fields.maxHp
  const currentHp = fields.currentHp
  if (!isFiniteNumber(maxHp) || maxHp <= 0 || !isFiniteNumber(currentHp) || currentHp <= 0 || currentHp > maxHp) return false
  for (const key of ['attack', 'defense', 'moveRange']) {
    if (!isFiniteNumber(fields[key])) return false
  }
  if (Number(fields.moveRange) < 0) return false
  if (fields.shield !== undefined && (!isFiniteNumber(fields.shield) || fields.shield < 0)) return false
  return true
}

function validateRequiredFields(fields: JsonRecord): boolean {
  const required = [
    'ownerPlayerId',
    'templateId',
    'name',
    'faction',
    'maxHp',
    'currentHp',
    'attack',
    'defense',
    'moveRange',
    'skills',
    'buffs',
    'debuffs',
    'ruleTags',
    'statusTags',
    'rules',
  ]
  return required.every(key => Object.prototype.hasOwnProperty.call(fields, key))
}

function validateRuleDescriptor(value: unknown): value is JsonRecord {
  if (!isPlainObject(value) || !isString(value.id) || Object.prototype.hasOwnProperty.call(value, 'effect')) return false
  if (value.limits !== undefined) {
    if (!isPlainObject(value.limits)) return false
    for (const key of ['uses', 'currentCooldown', 'remainingDuration'] as const) {
      if (value.limits[key] !== undefined) {
        const minimum = key === 'remainingDuration' ? -1 : 0
        if (!Number.isSafeInteger(value.limits[key]) || Number(value.limits[key]) < minimum) return false
      }
    }
  }
  return true
}

function hydrateRules(
  battle: BattleState,
  pieceId: string,
  descriptors: unknown,
  statuses: unknown,
): unknown[] | undefined {
  if (!Array.isArray(descriptors) || !validateStatusTags(statuses)) return undefined
  const byId = new Map<string, Record<string, unknown>>()
  const hydrate = (descriptor: JsonRecord, persisted: boolean): boolean => {
    const ruleId = typeof descriptor.id === 'string' ? descriptor.id : ''
    if (!ruleId) return false
    const loaded = loadRuleForBattle(battle, ruleId, { sourceId: pieceId })
    if (!loaded) return false
    let hydrated: Record<string, unknown> = loaded as unknown as Record<string, unknown>
    if (persisted) {
      hydrated = restorePersistedRuleRuntime(battle, loaded, descriptor, pieceId) as unknown as Record<string, unknown>
    }
    const copy = { ...hydrated }
    for (const [key, value] of Object.entries(descriptor)) {
      if (!RULE_RUNTIME_KEYS.has(key)) copy[key] = value
    }
    byId.set(ruleId, copy)
    return true
  }
  for (const descriptor of descriptors) {
    if (!validateRuleDescriptor(descriptor) || !hydrate(descriptor, true)) return undefined
  }
  return [...byId.values()]
}

function normalizeFlowStateForApply(
  snapshot: AuthorPieceInstanceSnapshot,
  target: PieceLike,
  restoredOwnerPlayerId: string,
): AuthorPieceFlowStateRecord[] | undefined {
  if (!Array.isArray(snapshot.flowState)) return undefined
  const normalized: AuthorPieceFlowStateRecord[] = []
  for (const record of snapshot.flowState) {
    if (!validFlowRecord(record) || record.entityId !== snapshot.sourcePieceId || record.ownerPlayerId !== snapshot.ownerPlayerId) return undefined
    normalized.push({
      ...record,
      entityId: target.instanceId,
      ownerPlayerId: restoredOwnerPlayerId,
      value: cloneJsonValue(record.value, undefined),
    })
  }
  return normalized
}

function canCommitPieceFields(target: PieceLike, fields: JsonRecord): boolean {
  // Commit deletes obsolete fields before restoring the captured set, so even
  // existing keys must be addable again. Reject before the first mutation.
  if (!Object.isExtensible(target)) return false
  for (const name of Object.keys(target)) {
    if (PROTECTED_KEYS.has(name)) continue
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    if (!descriptor || !descriptor.configurable || !('value' in descriptor) || descriptor.writable !== true) return false
  }
  for (const name of Object.keys(fields)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    if (descriptor && (!('value' in descriptor) || descriptor.writable !== true)) return false
  }
  return true
}

function parseSnapshot(value: unknown): AuthorPieceInstanceSnapshot | undefined {
  if (!isPlainObject(value)) return undefined
  let cloned: unknown
  try {
    cloned = cloneJsonValue(value, undefined)
    assertSnapshotSize(cloned)
  } catch {
    return undefined
  }
  if (!isPlainObject(cloned)) return undefined
  if (cloned.schemaVersion !== AUTHOR_PIECE_INSTANCE_SNAPSHOT_VERSION
    || cloned.kind !== AUTHOR_PIECE_INSTANCE_SNAPSHOT_KIND
    || !isString(cloned.sourcePieceId)
    || !isString(cloned.ownerPlayerId)
    || !isPlainObject(cloned.identity)
    || !isPlainObject(cloned.fields)
    || !Array.isArray(cloned.flowState)) return undefined
  const identity = cloned.identity
  if (!isString(identity.templateId) || !isString(identity.name) || !isString(identity.faction) || !isString(identity.ownerPlayerId)) return undefined
  if (identity.ownerPlayerId !== cloned.ownerPlayerId) return undefined
  if (identity.isCore !== undefined && typeof identity.isCore !== 'boolean') return undefined
  if (Object.keys(cloned.fields).some(key => PROTECTED_KEYS.has(key))) return undefined
  return cloned as unknown as AuthorPieceInstanceSnapshot
}

/**
 * Capture all mutable, serializable data attached directly to an active piece.
 * The piece identity and authoritative position are recorded for validation but
 * never become writable fields in a later apply.
 */
export function capturePieceInstance(battle: BattleState, pieceId: string): AuthorPieceInstanceSnapshot {
  const piece = activePiece(battle, pieceId)
  if (!piece) throw new Error('cannot capture a non-active piece')
  const catalog = buildReferenceCatalog(battle)
  const fields: JsonRecord = {}
  // Position authority installs x/y accessors while content executes. They
  // never belong to copied fields and must not be inspected or invoked here.
  for (const [name, value] of ownDataEntries(piece, PROTECTED_KEYS)) {
    if (name === 'rules' || value === undefined) continue
    fields[name] = cloneJsonValue(value, catalog)
  }
  // `name` is a required hydrated piece field.  Legacy callers can still
  // provide a complete gameplay piece without the optional presentation
  // field, so persist the identity fallback used above rather than rejecting
  // an otherwise valid instance at apply time.
  if (!Object.hasOwn(fields, 'name')) fields.name = snapshotIdentity(piece).name
  // These collections are part of the hydrated piece shape, but older
  // callers may omit an empty collection.  Persist the canonical empty value
  // so the strict apply validator can still restore the complete instance.
  for (const name of ['buffs', 'debuffs', 'ruleTags'] as const) {
    if (!Object.hasOwn(fields, name)) fields[name] = []
  }
  fields.rules = (Array.isArray(piece.rules) ? piece.rules : []).map(rule => dehydrateRule(rule, catalog))
  const snapshot: AuthorPieceInstanceSnapshot = {
    schemaVersion: AUTHOR_PIECE_INSTANCE_SNAPSHOT_VERSION,
    kind: AUTHOR_PIECE_INSTANCE_SNAPSHOT_KIND,
    sourcePieceId: piece.instanceId,
    ownerPlayerId: piece.ownerPlayerId,
    identity: snapshotIdentity(piece),
    fields,
    flowState: captureFlowState(battle, piece),
  }
  assertSnapshotSize(snapshot)
  return snapshot
}

/**
 * Apply a captured record to an existing live piece.  All validation,
 * reference resolution, skill checks, and rule hydration happen before any
 * target or flow-state mutation.  The return value is false for a stale,
 * malformed, inconsistent-owner, dead, or otherwise unavailable target/snapshot.
 */
export function applyPieceInstance(
  battle: BattleState,
  pieceId: string,
  input: unknown,
): boolean {
  try {
    const snapshot = parseSnapshot(input)
    const target = activePiece(battle, pieceId)
    if (!snapshot || !target || !isFiniteNumber(target.currentHp) || target.currentHp <= 0 || !validateIdentity(battle, target, snapshot)) return false
    if (!validateRequiredFields(snapshot.fields) || !validateAttributes(snapshot.fields)) return false
    if (!isString(snapshot.fields.ownerPlayerId)
      || !isString(snapshot.fields.templateId)
      || !isString(snapshot.fields.name)
      || !isString(snapshot.fields.faction)) return false
    if (snapshot.fields.isCore !== undefined && typeof snapshot.fields.isCore !== 'boolean') return false
    if (!validateSkillState(snapshot.fields.skills, battle, target.instanceId)) return false
    if (snapshot.fields.displaySkills !== undefined && !validateSkillState(snapshot.fields.displaySkills, battle, target.instanceId)) return false
    if (!validateStatusTags(snapshot.fields.statusTags)) return false
    if (!Array.isArray(snapshot.fields.buffs) || !Array.isArray(snapshot.fields.debuffs) || !Array.isArray(snapshot.fields.ruleTags)) return false
    const catalog = buildReferenceCatalog(battle)
    const decodedFields: JsonRecord = {}
    for (const [name, value] of Object.entries(snapshot.fields)) {
      if (PROTECTED_KEYS.has(name)) return false
      decodedFields[name] = decodeReferences(value, catalog)
    }
    const rules = hydrateRules(battle, target.instanceId, decodedFields.rules, decodedFields.statusTags)
    if (!rules) return false
    const flow = normalizeFlowStateForApply(snapshot, target, snapshot.fields.ownerPlayerId)
    if (!flow) return false
    decodedFields.rules = rules
    const existingFlow = flowRecords(battle)
    const unrelatedFlow = existingFlow.filter(record => !(isPlainObject(record) && record.scope === 'piece' && record.entityId === target.instanceId))
    if (unrelatedFlow.length + flow.length > 4096) return false
    if (!canCommitPieceFields(target, decodedFields)) return false

    for (const name of Object.keys(target)) {
      if (PROTECTED_KEYS.has(name)) continue
      delete target[name]
    }
    for (const [name, value] of Object.entries(decodedFields)) target[name] = value
    if (battle.extensions || flow.length > 0 || existingFlow.length > 0) {
      battle.extensions ??= {}
      battle.extensions.flowState = [...unrelatedFlow, ...flow]
    }
    return true
  } catch (error) {
    if (error instanceof InvalidPieceInstanceSnapshotError) return false
    // Preserve runtime/effect-chain failures for the host adapter to report
    // with its command and source context; do not silently turn them into a
    // normal authoring `false` result.
    throw error
  }
}

/** Prepare the canonical departed incarnation without exposing it on the board.
 * The lifecycle commits the resulting piece and flow records together. */
export function prepareReturningPieceInstance(battle: BattleState, input: unknown): {
  piece: PieceInstance
  flowState: AuthorPieceFlowStateRecord[]
} {
  const snapshot = parseSnapshot(input)
  if (!snapshot || battle.pieces.some(piece => piece.instanceId === snapshot.sourcePieceId)
    || battle.graveyard?.some(piece => piece.instanceId === snapshot.sourcePieceId)) throw new Error('原实例不在可回场的离场区')
  const piece = { ...snapshot.identity, instanceId: snapshot.sourcePieceId, currentHp: 1, x: null, y: null } as PieceInstance
  const isolated = { ...battle, pieces: [...battle.pieces, piece], extensions: { ...battle.extensions } }
  if (!applyPieceInstance(isolated, piece.instanceId, snapshot)) throw new Error('离场实例已失效或无法恢复')
  return { piece, flowState: (isolated.extensions.flowState || []).filter((record: AuthorPieceFlowStateRecord) => record.scope === 'piece' && record.entityId === piece.instanceId) as AuthorPieceFlowStateRecord[] }
}

export interface AuthorOutOfPlayStore {
  version: 1
  pieces: Record<string, AuthorPieceInstanceSnapshot>
}
export function authorOutOfPlayStore(battle: BattleState): AuthorOutOfPlayStore {
  const existing = battle.extensions?.authorOutOfPlay as AuthorOutOfPlayStore | undefined
  if (existing === undefined) return { version: 1, pieces: {} }
  if (existing.version !== 1 || !isPlainObject(existing.pieces)) throw new Error('离场实例记录不合法')
  return existing
}

export function preserveDepartingPiece(battle: BattleState, pieceId: string, flowStatePolicy: 'cleanup' | 'preserve' = 'preserve'): void {
  const snapshot = capturePieceInstance(battle, pieceId)
  if (flowStatePolicy === 'cleanup') snapshot.flowState = snapshot.flowState.filter(record => record.lifetime !== 'while-alive')
  const current = authorOutOfPlayStore(battle)
  if (Object.hasOwn(current.pieces, pieceId) || Object.keys(current.pieces).length >= 512) throw new Error('离场实例记录重复或已满')
  battle.extensions ??= {}
  battle.extensions.authorOutOfPlay = { version: 1, pieces: { ...current.pieces, [pieceId]: snapshot } }
}
