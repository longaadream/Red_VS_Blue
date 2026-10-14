import type {
  PieceAbilityGroupInstance,
  PieceAbilityGroupOwnership,
  PieceInstance,
} from './piece'
import { cloneAuthorInitialValue } from './author-extension'
import { isEffectChainFatalError, isEffectChainPendingSignal } from './effect-batch'

/** A persisted author Cluster definition. */
export interface AuthorClusterDefinition {
  readonly id: string
  readonly skills: readonly string[]
  readonly rules: readonly string[]
  readonly extension?: Record<string, unknown>
}

export type AuthorClusterMemberKind = 'skill' | 'rule'

export interface AuthorClusterMemberContext {
  readonly clusterId: string
  readonly clusterInstanceId: string
  readonly memberKind: AuthorClusterMemberKind
  readonly memberId: string
}

/**
 * Resolve a member against the piece that owns the Cluster operation.
 *
 * The piece argument is required for new hosts so a resolver can scope
 * content to the source instance.  Existing one-argument resolvers remain
 * source-compatible: JavaScript simply ignores the additional arguments and
 * TypeScript permits a callback with fewer parameters here.
 */
export type AuthorClusterDefinitionResolver = (
  id: string,
  piece: PieceInstance,
  context?: AuthorClusterMemberContext,
) => unknown | null | undefined

export type AuthorClusterMemberMutation = (
  piece: PieceInstance,
  memberId: string,
  definition: unknown,
  context: AuthorClusterMemberContext,
) => unknown

/**
 * Host callbacks are deliberately injected. The Cluster service records
 * ownership and delegates actual Skill/Rule lifecycle work to the existing
 * authoritative host.
 *
 * The `add*`/`remove*` names are accepted as aliases so existing hosts can be
 * passed without an adapter. `nextInstanceId` is pure from this service's
 * perspective; callers should provide a deterministic implementation.
 */
export interface AuthorClusterRuntimeOptions {
  resolveSkill?: AuthorClusterDefinitionResolver
  resolveRule?: AuthorClusterDefinitionResolver
  skillResolver?: AuthorClusterDefinitionResolver
  ruleResolver?: AuthorClusterDefinitionResolver
  installSkill?: AuthorClusterMemberMutation
  installRule?: AuthorClusterMemberMutation
  removeSkill?: AuthorClusterMemberMutation
  removeRule?: AuthorClusterMemberMutation
  addSkill?: AuthorClusterMemberMutation
  addRule?: AuthorClusterMemberMutation
  nextInstanceId?: (definitionId: string, piece: PieceInstance) => string
  createInstanceId?: (definitionId: string, piece: PieceInstance) => string
}

export type AuthorClusterRuntimeErrorCode =
  | 'invalid-definition'
  | 'invalid-extension'
  | 'invalid-piece-state'
  | 'missing-definition'
  | 'missing-hook'
  | 'duplicate-instance-id'
  | 'mutation-failed'

export class AuthorClusterRuntimeError extends Error {
  readonly code: AuthorClusterRuntimeErrorCode
  readonly clusterId?: string
  readonly memberKind?: AuthorClusterMemberKind
  readonly memberId?: string

  constructor(
    code: AuthorClusterRuntimeErrorCode,
    message: string,
    context: Partial<Pick<AuthorClusterRuntimeError, 'clusterId' | 'memberKind' | 'memberId'>> = {},
  ) {
    super(message)
    this.name = 'AuthorClusterRuntimeError'
    this.code = code
    this.clusterId = context.clusterId
    this.memberKind = context.memberKind
    this.memberId = context.memberId
  }
}

type JsonRecord = Record<string, unknown>

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const isRecord = (value: unknown): value is JsonRecord => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
)

function ownString(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || !hasOwn(value, key) || typeof value[key] !== 'string') return undefined
  return value[key] as string
}

const MAX_EXTENSION_BYTES = 65536
const MAX_EXTENSION_COLLECTION_ITEMS = 4096
const FORBIDDEN_EXTENSION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const FORBIDDEN_MEMBER_IDS = new Set(['__proto__', 'prototype', 'constructor'])

function validateExtensionShape(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 40) throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension nesting exceeds the runtime limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || seen.has(value)) {
    throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension must contain finite, acyclic JSON values')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension does not support Symbol fields')
  }

  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if ((!array && prototype !== Object.prototype) || value === null) {
    throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension objects must be plain records')
  }
  if (array && value.length > MAX_EXTENSION_COLLECTION_ITEMS) {
    throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension lists exceed the runtime limit')
  }

  seen.add(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    if (array && key === 'length') continue
    if (FORBIDDEN_EXTENSION_KEYS.has(key)) {
      throw new AuthorClusterRuntimeError('invalid-extension', `Cluster extension field ${key} is not allowed`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension does not support accessor or hidden fields')
    }
    if (array && (!/^0$|^[1-9][0-9]*$/.test(key) || Number(key) >= value.length)) {
      throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension arrays must contain only dense indexed values')
    }
    validateExtensionShape(descriptor.value, seen, depth + 1)
  }
  if (array) {
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, String(index))) {
        throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension arrays cannot be sparse')
      }
    }
  }
  seen.delete(value)
}

function cloneExtension(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new AuthorClusterRuntimeError('invalid-extension', 'Cluster extension must be a record')
  try {
    validateExtensionShape(value)
    const cloned = cloneAuthorInitialValue({ type: 'record', schemas: [], value })
    if (!isRecord(cloned)) throw new Error('Cluster extension must be a record')
    const encoded = JSON.stringify(cloned)
    if (encoded === undefined || encoded.length > MAX_EXTENSION_BYTES) {
      throw new Error('Cluster extension exceeds the 64KB runtime limit')
    }
    return cloned
  } catch (error) {
    if (error instanceof AuthorClusterRuntimeError) throw error
    throw new AuthorClusterRuntimeError('invalid-extension', `Invalid Cluster extension: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type FieldSnapshot = { present: boolean; value: unknown }
type ObjectSnapshot = { target: object; descriptors: Map<PropertyKey, PropertyDescriptor> }
type PieceSnapshot = {
  fields: Record<'skills' | 'displaySkills' | 'rules' | 'abilityGroups' | 'abilityGroupOwnership', FieldSnapshot>
  objects: ObjectSnapshot[]
}

function isSnapshotObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Capture references and original descriptors, keeping host member identity. */
function captureObjectGraph(value: unknown, objects: ObjectSnapshot[], seen: Set<object>): void {
  if (!isSnapshotObject(value) || seen.has(value)) return
  seen.add(value)
  const snapshot: ObjectSnapshot = { target: value, descriptors: new Map() }
  objects.push(snapshot)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    snapshot.descriptors.set(key, descriptor)
    if ('value' in descriptor) captureObjectGraph(descriptor.value, objects, seen)
  }
}

function capturePieceSnapshot(piece: PieceInstance): PieceSnapshot {
  const objects: ObjectSnapshot[] = []
  const seen = new Set<object>()
  const fields = {} as PieceSnapshot['fields']
  for (const key of ['skills', 'displaySkills', 'rules', 'abilityGroups', 'abilityGroupOwnership'] as const) {
    const record = piece as unknown as JsonRecord
    const value = record[key]
    fields[key] = { present: hasOwn(piece, key), value }
    captureObjectGraph(value, objects, seen)
  }
  return { fields, objects }
}

function restoreObjectSnapshot(snapshot: ObjectSnapshot): void {
  const currentKeys = Reflect.ownKeys(snapshot.target)
  const originalKeys = new Set(snapshot.descriptors.keys())
  for (const key of currentKeys) {
    if (!originalKeys.has(key)) Reflect.deleteProperty(snapshot.target, key)
  }
  for (const [key, descriptor] of snapshot.descriptors) {
    Object.defineProperty(snapshot.target, key, descriptor)
  }
}

function restoreField(piece: PieceInstance, key: string, snapshot: FieldSnapshot): void {
  const record = piece as unknown as JsonRecord
  if (!snapshot.present) delete record[key]
  else record[key] = snapshot.value
}

function restorePieceSnapshot(piece: PieceInstance, snapshot: PieceSnapshot): void {
  // Restore object state in place before restoring piece roots. The original
  // references are then reattached even if a host replaced an array field.
  for (const object of snapshot.objects) restoreObjectSnapshot(object)
  for (const key of ['skills', 'displaySkills', 'rules', 'abilityGroups', 'abilityGroupOwnership'] as const) {
    restoreField(piece, key, snapshot.fields[key])
  }
}

function uniqueIds(value: readonly string[], kind: AuthorClusterMemberKind, clusterId: string): string[] {
  if (!Array.isArray(value)) {
    throw new AuthorClusterRuntimeError('invalid-definition', `Cluster ${clusterId} has invalid ${kind} member list`, { clusterId, memberKind: kind })
  }
  const seen = new Set<string>()
  const output: string[] = []
  for (const memberId of value) {
    if (typeof memberId !== 'string' || memberId.trim().length === 0) {
      throw new AuthorClusterRuntimeError('invalid-definition', `Cluster ${clusterId} has an invalid ${kind} ID`, { clusterId, memberKind: kind })
    }
    if (FORBIDDEN_MEMBER_IDS.has(memberId)) {
      throw new AuthorClusterRuntimeError('invalid-definition', `Cluster ${clusterId} uses a reserved ${kind} ID`, {
        clusterId,
        memberKind: kind,
        memberId,
      })
    }
    if (!seen.has(memberId)) {
      seen.add(memberId)
      output.push(memberId)
    }
  }
  return output
}

function validateDefinition(definition: AuthorClusterDefinition): { skills: string[]; rules: string[]; extension?: Record<string, unknown> } {
  if (!isRecord(definition) || typeof definition.id !== 'string' || definition.id.trim().length === 0) {
    throw new AuthorClusterRuntimeError('invalid-definition', 'Cluster definition must have a non-empty id')
  }
  const skills = uniqueIds(definition.skills, 'skill', definition.id)
  const rules = uniqueIds(definition.rules, 'rule', definition.id)
  const extension = cloneExtension(definition.extension)
  return { skills, rules, ...(extension === undefined ? {} : { extension }) }
}

function memberIdFromSkill(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  return ownString(value, 'skillId')
}

function memberIdFromRule(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  return ownString(value, 'id')
}

function hasMember(piece: PieceInstance, kind: AuthorClusterMemberKind, memberId: string): boolean {
  const values = kind === 'skill' ? piece.skills : piece.rules
  if (!Array.isArray(values)) return false
  return values.some(value => (kind === 'skill' ? memberIdFromSkill(value) : memberIdFromRule(value)) === memberId)
}

/**
 * Validate an adopt operation without changing the supplied PieceInstance.
 * Adoption is deliberately install-free: every listed member must already be
 * present on the piece before the first ownership field is written.
 */
function validateAdoptedMembers(piece: PieceInstance, kind: AuthorClusterMemberKind, memberIds: readonly string[], clusterId: string): void {
  if (memberIds.length === 0) return
  const values = kind === 'skill' ? piece.skills : piece.rules
  if (!Array.isArray(values)) {
    throw new AuthorClusterRuntimeError('invalid-piece-state', `Piece has no ${kind} member list for Cluster ${clusterId}`, {
      clusterId,
      memberKind: kind,
    })
  }
  for (const memberId of memberIds) {
    if (!hasMember(piece, kind, memberId)) {
      throw new AuthorClusterRuntimeError('missing-definition', `Cluster ${clusterId} cannot adopt missing ${kind} ${memberId}`, {
        clusterId,
        memberKind: kind,
        memberId,
      })
    }
  }
}

function ensureMemberArrays(piece: PieceInstance): void {
  if (!Array.isArray(piece.skills)) piece.skills = []
  if (!Array.isArray(piece.rules)) piece.rules = []
}

function validateOwnership(value: unknown): value is PieceAbilityGroupOwnership {
  if (!isRecord(value) || !isRecord(value.skills) || !isRecord(value.rules)) return false
  const validMap = (map: JsonRecord): boolean => Object.getPrototypeOf(map) === Object.prototype && Object.keys(map).every(key => {
    if (FORBIDDEN_MEMBER_IDS.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(map, key)
    return !!descriptor
      && 'value' in descriptor
      && Array.isArray(descriptor.value)
      && descriptor.value.every(id => typeof id === 'string' && id.length > 0)
  })
  return validMap(value.skills) && validMap(value.rules)
    && (value.protectedSkills === undefined || Array.isArray(value.protectedSkills) && value.protectedSkills.every(id => typeof id === 'string' && !FORBIDDEN_MEMBER_IDS.has(id)))
    && (value.protectedRules === undefined || Array.isArray(value.protectedRules) && value.protectedRules.every(id => typeof id === 'string' && !FORBIDDEN_MEMBER_IDS.has(id)))
}

function createOwnershipMap(): Record<string, string[]> {
  // Author snapshot values must use the same plain-object prototype as other
  // serializable piece fields. Reserved member IDs are rejected during
  // definition/direct-host validation, so ordinary own-property lookups are
  // safe here without carrying a null-prototype object into the gameplay ABI.
  return {}
}

function ensureOwnership(piece: PieceInstance): PieceAbilityGroupOwnership {
  if (piece.abilityGroupOwnership === undefined) {
    piece.abilityGroupOwnership = { skills: createOwnershipMap(), rules: createOwnershipMap() }
    return piece.abilityGroupOwnership
  }
  if (!validateOwnership(piece.abilityGroupOwnership)) {
    throw new AuthorClusterRuntimeError('invalid-piece-state', 'Piece ability-group ownership is malformed')
  }
  return piece.abilityGroupOwnership
}

function ensureGroups(piece: PieceInstance): PieceAbilityGroupInstance[] {
  if (piece.abilityGroups === undefined) {
    piece.abilityGroups = []
    return piece.abilityGroups
  }
  if (!Array.isArray(piece.abilityGroups)) {
    throw new AuthorClusterRuntimeError('invalid-piece-state', 'Piece abilityGroups must be an array')
  }
  for (const group of piece.abilityGroups) {
    if (!isRecord(group) || typeof group.id !== 'string' || typeof group.instanceId !== 'string'
      || !Array.isArray(group.skills) || !Array.isArray(group.rules)) {
      throw new AuthorClusterRuntimeError('invalid-piece-state', 'Piece contains a malformed ability group')
    }
  }
  return piece.abilityGroups
}

function groupOwners(ownership: PieceAbilityGroupOwnership, kind: AuthorClusterMemberKind, memberId: string): string[] {
  const map = kind === 'skill' ? ownership.skills : ownership.rules
  return hasOwn(map, memberId) && Array.isArray(map[memberId]) ? map[memberId] : []
}

function protectedMembers(ownership: PieceAbilityGroupOwnership, kind: AuthorClusterMemberKind): string[] {
  const key = kind === 'skill' ? 'protectedSkills' : 'protectedRules'
  const values = ownership[key]
  return values ?? []
}

function setOwners(ownership: PieceAbilityGroupOwnership, kind: AuthorClusterMemberKind, memberId: string, owners: readonly string[]): void {
  const map = kind === 'skill' ? ownership.skills : ownership.rules
  const deduped = [...new Set(owners)]
  if (deduped.length === 0) delete map[memberId]
  else Object.defineProperty(map, memberId, {
    value: deduped,
    configurable: true,
    enumerable: true,
    writable: true,
  })
}

function addOwner(ownership: PieceAbilityGroupOwnership, kind: AuthorClusterMemberKind, memberId: string, ownerId: string): void {
  setOwners(ownership, kind, memberId, [...groupOwners(ownership, kind, memberId), ownerId])
}

function setDirectProtection(ownership: PieceAbilityGroupOwnership, kind: AuthorClusterMemberKind, memberId: string): void {
  const values = protectedMembers(ownership, kind)
  if (values.includes(memberId)) return
  const next = [...values, memberId]
  if (kind === 'skill') ownership.protectedSkills = next
  else ownership.protectedRules = next
}

function clearDirectProtection(ownership: PieceAbilityGroupOwnership, kind: AuthorClusterMemberKind, memberId: string): void {
  const next = protectedMembers(ownership, kind).filter(id => id !== memberId)
  if (kind === 'skill') {
    if (next.length) ownership.protectedSkills = next
    else delete ownership.protectedSkills
  } else if (next.length) ownership.protectedRules = next
  else delete ownership.protectedRules
}

function syncSkillProvenance(piece: PieceInstance, ownership: PieceAbilityGroupOwnership, skillId: string): void {
  const owners = groupOwners(ownership, 'skill', skillId)
  for (const value of piece.skills ?? []) {
    if (!isRecord(value) || memberIdFromSkill(value) !== skillId) continue
    if (owners.length) value.abilityGroupIds = [...owners]
    else delete value.abilityGroupIds
  }
}

function syncRuleProvenance(piece: PieceInstance, ownership: PieceAbilityGroupOwnership, ruleId: string): void {
  const owners = groupOwners(ownership, 'rule', ruleId)
  for (const value of piece.rules ?? []) {
    if (!isRecord(value) || memberIdFromRule(value) !== ruleId) continue
    if (owners.length) value.abilityGroupIds = [...owners]
    else delete value.abilityGroupIds
  }
}

function syncProvenance(piece: PieceInstance, ownership: PieceAbilityGroupOwnership, kind: AuthorClusterMemberKind, memberId: string): void {
  if (kind === 'skill') syncSkillProvenance(piece, ownership, memberId)
  else syncRuleProvenance(piece, ownership, memberId)
}

function callbackFor(options: AuthorClusterRuntimeOptions, kind: AuthorClusterMemberKind, operation: 'install' | 'remove'): AuthorClusterMemberMutation | undefined {
  if (kind === 'skill') {
    return operation === 'install' ? options.installSkill ?? options.addSkill : options.removeSkill
  }
  return operation === 'install' ? options.installRule ?? options.addRule : options.removeRule
}

function resolverFor(options: AuthorClusterRuntimeOptions, kind: AuthorClusterMemberKind): AuthorClusterDefinitionResolver | undefined {
  return kind === 'skill' ? options.resolveSkill ?? options.skillResolver : options.resolveRule ?? options.ruleResolver
}

function rethrowEffectChainControlSignal(error: unknown): void {
  if (isEffectChainFatalError(error) || isEffectChainPendingSignal(error)) throw error
}

function resolveDefinitions(
  options: AuthorClusterRuntimeOptions,
  clusterId: string,
  kind: AuthorClusterMemberKind,
  memberIds: readonly string[],
  piece: PieceInstance,
): Map<string, unknown> {
  if (memberIds.length === 0) return new Map()
  const resolver = resolverFor(options, kind)
  if (!resolver) {
    throw new AuthorClusterRuntimeError('missing-hook', `Cluster ${clusterId} is missing its ${kind} resolver`, { clusterId, memberKind: kind })
  }
  const result = new Map<string, unknown>()
  for (const memberId of memberIds) {
    let definition: unknown
    try {
      // Acquire resolves before its deterministic instance ID is allocated,
      // so there is no member context yet.  The target piece is still passed
      // on every call to prevent a host resolver from accidentally using a
      // process-wide or unrelated piece scope.
      definition = resolver(memberId, piece)
    } catch (error) {
      rethrowEffectChainControlSignal(error)
      throw new AuthorClusterRuntimeError('missing-definition', `Unable to resolve ${kind} ${memberId} for Cluster ${clusterId}: ${error instanceof Error ? error.message : String(error)}`, { clusterId, memberKind: kind, memberId })
    }
    if (definition === undefined || definition === null || definition === false) {
      throw new AuthorClusterRuntimeError('missing-definition', `Missing ${kind} definition ${memberId} for Cluster ${clusterId}`, { clusterId, memberKind: kind, memberId })
    }
    result.set(memberId, definition)
  }
  return result
}

function allocateInstanceId(options: AuthorClusterRuntimeOptions, definitionId: string, piece: PieceInstance): string {
  const callback = options.nextInstanceId ?? options.createInstanceId
  let instanceId: string
  try {
    instanceId = callback
      ? callback(definitionId, piece)
      : `${piece.instanceId}:ability-group:${definitionId}`
  } catch (error) {
    rethrowEffectChainControlSignal(error)
    throw new AuthorClusterRuntimeError('mutation-failed', `Unable to allocate Cluster instance ID for ${definitionId}: ${error instanceof Error ? error.message : String(error)}`, { clusterId: definitionId })
  }
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw new AuthorClusterRuntimeError('mutation-failed', `Cluster instance ID for ${definitionId} must be a non-empty string`, { clusterId: definitionId })
  }
  return instanceId
}

function invokeMutation(
  callback: AuthorClusterMemberMutation | undefined,
  operation: 'install' | 'remove',
  piece: PieceInstance,
  memberId: string,
  definition: unknown,
  context: AuthorClusterMemberContext,
): void {
  if (!callback) {
    throw new AuthorClusterRuntimeError('missing-hook', `Cluster ${context.clusterId} is missing its ${operation} ${context.memberKind} hook`, context)
  }
  let result: unknown
  try {
    result = callback(piece, memberId, definition, context)
  } catch (error) {
    rethrowEffectChainControlSignal(error)
    throw new AuthorClusterRuntimeError('mutation-failed', `Cluster ${context.clusterId} failed to ${operation} ${context.memberKind} ${memberId}: ${error instanceof Error ? error.message : String(error)}`, context)
  }
  if (result === false) {
    throw new AuthorClusterRuntimeError('mutation-failed', `Cluster ${context.clusterId} host rejected ${operation} ${context.memberKind} ${memberId}`, context)
  }
}

function requireMutationHooks(
  options: AuthorClusterRuntimeOptions,
  clusterId: string,
  kind: AuthorClusterMemberKind,
  ids: readonly string[],
  operation: 'install' | 'remove',
): void {
  if (ids.length > 0 && !callbackFor(options, kind, operation)) {
    throw new AuthorClusterRuntimeError('missing-hook', `Cluster ${clusterId} is missing its ${operation} ${kind} hook`, {
      clusterId,
      memberKind: kind,
    })
  }
}

function mutationWithRollback<T>(piece: PieceInstance, operation: () => T): T {
  const snapshot = capturePieceSnapshot(piece)
  try {
    return operation()
  } catch (error) {
    restorePieceSnapshot(piece, snapshot)
    throw error
  }
}

function groupFor(piece: PieceInstance, groupOrId: string | PieceAbilityGroupInstance): PieceAbilityGroupInstance | undefined {
  const id = typeof groupOrId === 'string' ? groupOrId : groupOrId.instanceId
  const groups = piece.abilityGroups ?? []
  return groups.find(group => group.instanceId === id)
    ?? (typeof groupOrId === 'string' ? groups.find(group => group.id === groupOrId) : undefined)
}

function removeGroupOwner(
  ownership: PieceAbilityGroupOwnership,
  kind: AuthorClusterMemberKind,
  memberId: string,
  groupInstanceId: string,
): string[] {
  return groupOwners(ownership, kind, memberId).filter(owner => owner !== groupInstanceId)
}

/**
 * Install and remove runtime Cluster instances without owning a second global
 * registry. All mutable state is serialized on the supplied PieceInstance.
 */
export class AuthorClusterRuntime {
  constructor(readonly options: AuthorClusterRuntimeOptions) {}

  acquire(piece: PieceInstance, definition: AuthorClusterDefinition): PieceAbilityGroupInstance {
    const validated = validateDefinition(definition)
    // Resolve every member before looking at or mutating the piece. This keeps
    // a partially valid Cluster from installing only its first few members.
    const skillDefinitions = resolveDefinitions(this.options, definition.id, 'skill', validated.skills, piece)
    const ruleDefinitions = resolveDefinitions(this.options, definition.id, 'rule', validated.rules, piece)

    const groups = piece.abilityGroups ?? []
    const existing = groups.find(group => group.id === definition.id)
    if (existing) return existing

    // Check the complete mutation surface before the first host callback. A
    // missing Rule hook must not cause a Skill callback to run and be rolled
    // back as an avoidable partial attempt.
    requireMutationHooks(this.options, definition.id, 'skill', validated.skills, 'install')
    requireMutationHooks(this.options, definition.id, 'rule', validated.rules, 'install')

    const instanceId = allocateInstanceId(this.options, definition.id, piece)
    if (groups.some(group => group.instanceId === instanceId)) {
      throw new AuthorClusterRuntimeError('duplicate-instance-id', `Cluster instance ID ${instanceId} is already present on ${piece.instanceId}`, { clusterId: definition.id })
    }

    return mutationWithRollback(piece, () => {
      ensureMemberArrays(piece)
      const nextGroups = ensureGroups(piece)
      const ownership = ensureOwnership(piece)
      const installed: Array<{ kind: AuthorClusterMemberKind; id: string }> = []

      const install = (kind: AuthorClusterMemberKind, ids: readonly string[], definitions: Map<string, unknown>): void => {
        for (const memberId of ids) {
          const presentBefore = hasMember(piece, kind, memberId)
          if (!presentBefore) {
            const context: AuthorClusterMemberContext = {
              clusterId: definition.id,
              clusterInstanceId: instanceId,
              memberKind: kind,
              memberId,
            }
            invokeMutation(callbackFor(this.options, kind, 'install'), 'install', piece, memberId, definitions.get(memberId), context)
            if (!hasMember(piece, kind, memberId)) {
              throw new AuthorClusterRuntimeError('mutation-failed', `Cluster host did not install ${kind} ${memberId}`, context)
            }
            installed.push({ kind, id: memberId })
          }

          // An existing group-owned member is shared. A member with no
          // provenance is a base/direct member and must remain after removal.
          if (presentBefore && groupOwners(ownership, kind, memberId).length === 0) continue
          addOwner(ownership, kind, memberId, instanceId)
          syncProvenance(piece, ownership, kind, memberId)
        }
      }

      install('skill', validated.skills, skillDefinitions)
      install('rule', validated.rules, ruleDefinitions)

      const group: PieceAbilityGroupInstance = {
        id: definition.id,
        instanceId,
        skills: [...validated.skills],
        rules: [...validated.rules],
        ...(validated.extension === undefined ? {} : { extension: validated.extension }),
      }
      nextGroups.push(group)
      // Keep ownership serializable and independent from the input definition.
      piece.abilityGroupOwnership = ownership
      // `installed` is intentionally retained as a local audit point for the
      // host callback boundary; all ownership is derived from the piece map.
      void installed
      return group
    })
  }

  install(piece: PieceInstance, definition: AuthorClusterDefinition): PieceAbilityGroupInstance {
    return this.acquire(piece, definition)
  }

  /**
   * Record ownership for members already installed on a piece.
   *
   * This operation intentionally does not resolve, install, remove, reset,
   * or otherwise notify a Skill/Rule host. It is for bootstrapping a
   * serialized/static group whose exact members have already been applied by
   * the authoritative piece setup path.
   */
  adopt(piece: PieceInstance, definition: AuthorClusterDefinition): PieceAbilityGroupInstance {
    const validated = validateDefinition(definition)
    const groups = piece.abilityGroups === undefined ? [] : ensureGroups(piece)
    // Validate every member before allocating an ID or writing ownership so
    // one missing member cannot leave a partially adopted group behind.
    validateAdoptedMembers(piece, 'skill', validated.skills, definition.id)
    validateAdoptedMembers(piece, 'rule', validated.rules, definition.id)

    const existing = groups.find(group => group.id === definition.id)
    if (existing) return existing

    const instanceId = allocateInstanceId(this.options, definition.id, piece)
    if (groups.some(group => group.instanceId === instanceId)) {
      throw new AuthorClusterRuntimeError('duplicate-instance-id', `Cluster instance ID ${instanceId} is already present on ${piece.instanceId}`, { clusterId: definition.id })
    }

    return mutationWithRollback(piece, () => {
      const nextGroups = piece.abilityGroups === undefined ? (piece.abilityGroups = []) : ensureGroups(piece)
      const ownership = ensureOwnership(piece)

      // Unlike acquire(), an adopted member is owned even when it predates
      // this group. Members that predate adoption but are outside this
      // definition remain unowned and therefore remain on removal.
      for (const memberId of validated.skills) {
        addOwner(ownership, 'skill', memberId, instanceId)
        syncProvenance(piece, ownership, 'skill', memberId)
      }
      for (const memberId of validated.rules) {
        addOwner(ownership, 'rule', memberId, instanceId)
        syncProvenance(piece, ownership, 'rule', memberId)
      }

      const group: PieceAbilityGroupInstance = {
        id: definition.id,
        instanceId,
        skills: [...validated.skills],
        rules: [...validated.rules],
        ...(validated.extension === undefined ? {} : { extension: validated.extension }),
      }
      nextGroups.push(group)
      piece.abilityGroupOwnership = ownership
      return group
    })
  }

  remove(piece: PieceInstance, groupOrId: string | PieceAbilityGroupInstance): boolean {
    const group = groupFor(piece, groupOrId)
    if (!group) return false

    return mutationWithRollback(piece, () => {
      ensureMemberArrays(piece)
      const groups = ensureGroups(piece)
      const ownership = ensureOwnership(piece)
      const contextFor = (kind: AuthorClusterMemberKind, memberId: string): AuthorClusterMemberContext => ({
        clusterId: group.id,
        clusterInstanceId: group.instanceId,
        memberKind: kind,
        memberId,
      })
      const removals: Array<{ kind: AuthorClusterMemberKind; id: string }> = []
      const seen = new Set<string>()

      const plan = (kind: AuthorClusterMemberKind, ids: readonly string[]): void => {
        for (const memberId of ids) {
          const nextOwners = removeGroupOwner(ownership, kind, memberId, group.instanceId)
          if (nextOwners.length > 0 || protectedMembers(ownership, kind).includes(memberId)) continue
          // No ownership entry means this was a base/direct member. It is not
          // safe to remove merely because it appears in the group definition.
          if (groupOwners(ownership, kind, memberId).length === 0) continue
          // A direct host removal may have already made the member invalid;
          // clean its stale provenance below without asking the host to remove
          // an absent member again.
          if (!hasMember(piece, kind, memberId)) continue
          const key = `${kind}:${memberId}`
          if (!seen.has(key)) {
            seen.add(key)
            removals.push({ kind, id: memberId })
          }
        }
      }

      plan('skill', group.skills)
      plan('rule', group.rules)

      requireMutationHooks(this.options, group.id, 'skill', removals.filter(item => item.kind === 'skill').map(item => item.id), 'remove')
      requireMutationHooks(this.options, group.id, 'rule', removals.filter(item => item.kind === 'rule').map(item => item.id), 'remove')

      for (const removal of removals) {
        const context = contextFor(removal.kind, removal.id)
        const resolver = resolverFor(this.options, removal.kind)
        if (!resolver) throw new AuthorClusterRuntimeError('missing-hook', `Cluster ${group.id} is missing its ${removal.kind} resolver`, context)
        let memberDefinition: unknown
        try {
          memberDefinition = resolver(removal.id, piece, context)
        } catch (error) {
          rethrowEffectChainControlSignal(error)
          throw new AuthorClusterRuntimeError('missing-definition', `Unable to resolve ${removal.kind} ${removal.id} while removing Cluster ${group.id}: ${error instanceof Error ? error.message : String(error)}`, context)
        }
        if (memberDefinition === undefined || memberDefinition === null || memberDefinition === false) {
          throw new AuthorClusterRuntimeError('missing-definition', `Missing ${removal.kind} definition ${removal.id} while removing Cluster ${group.id}`, context)
        }
        invokeMutation(callbackFor(this.options, removal.kind, 'remove'), 'remove', piece, removal.id, memberDefinition, context)
        if (hasMember(piece, removal.kind, removal.id)) {
          throw new AuthorClusterRuntimeError('mutation-failed', `Cluster host did not remove ${removal.kind} ${removal.id}`, context)
        }
      }

      const index = groups.indexOf(group)
      if (index >= 0) groups.splice(index, 1)
      for (const kind of ['skill', 'rule'] as const) {
        for (const memberId of kind === 'skill' ? group.skills : group.rules) {
          const nextOwners = removeGroupOwner(ownership, kind, memberId, group.instanceId)
          setOwners(ownership, kind, memberId, nextOwners)
          syncProvenance(piece, ownership, kind, memberId)
        }
      }
      piece.abilityGroupOwnership = ownership
      return true
    })
  }

  uninstall(piece: PieceInstance, groupOrId: string | PieceAbilityGroupInstance): boolean {
    return this.remove(piece, groupOrId)
  }
}

export function createAuthorClusterRuntime(options: AuthorClusterRuntimeOptions): AuthorClusterRuntime {
  return new AuthorClusterRuntime(options)
}

export function acquireAuthorCluster(
  piece: PieceInstance,
  definition: AuthorClusterDefinition,
  options: AuthorClusterRuntimeOptions,
): PieceAbilityGroupInstance {
  return new AuthorClusterRuntime(options).acquire(piece, definition)
}

export const installAuthorCluster = acquireAuthorCluster

export function adoptAuthorCluster(
  piece: PieceInstance,
  definition: AuthorClusterDefinition,
  options: AuthorClusterRuntimeOptions,
): PieceAbilityGroupInstance {
  return new AuthorClusterRuntime(options).adopt(piece, definition)
}

export function removeAuthorCluster(
  piece: PieceInstance,
  groupOrId: string | PieceAbilityGroupInstance,
  options: AuthorClusterRuntimeOptions,
): boolean {
  return new AuthorClusterRuntime(options).remove(piece, groupOrId)
}

export const uninstallAuthorCluster = removeAuthorCluster

/**
 * Direct host additions must mark a member as protected before a Cluster is
 * removed. This keeps a direct member alive even when a Cluster also lists it.
 */
export function recordDirectMemberAdded(piece: PieceInstance, kind: AuthorClusterMemberKind, memberId: string): void {
  if (typeof memberId !== 'string' || memberId.length === 0) throw new AuthorClusterRuntimeError('invalid-piece-state', 'Direct member ID must be non-empty')
  if (FORBIDDEN_MEMBER_IDS.has(memberId)) throw new AuthorClusterRuntimeError('invalid-piece-state', 'Direct member ID is reserved')
  const ownership = ensureOwnership(piece)
  setDirectProtection(ownership, kind, memberId)
  syncProvenance(piece, ownership, kind, memberId)
}

export function recordDirectMemberRemoved(piece: PieceInstance, kind: AuthorClusterMemberKind, memberId: string): void {
  if (typeof memberId !== 'string' || memberId.length === 0) throw new AuthorClusterRuntimeError('invalid-piece-state', 'Direct member ID must be non-empty')
  if (FORBIDDEN_MEMBER_IDS.has(memberId)) throw new AuthorClusterRuntimeError('invalid-piece-state', 'Direct member ID is reserved')
  const ownership = ensureOwnership(piece)
  clearDirectProtection(ownership, kind, memberId)
  setOwners(ownership, kind, memberId, [])
  syncProvenance(piece, ownership, kind, memberId)
}

export const recordDirectSkillAdded = (piece: PieceInstance, skillId: string): void => recordDirectMemberAdded(piece, 'skill', skillId)
export const recordDirectRuleAdded = (piece: PieceInstance, ruleId: string): void => recordDirectMemberAdded(piece, 'rule', ruleId)
export const recordDirectSkillRemoved = (piece: PieceInstance, skillId: string): void => recordDirectMemberRemoved(piece, 'skill', skillId)
export const recordDirectRuleRemoved = (piece: PieceInstance, ruleId: string): void => recordDirectMemberRemoved(piece, 'rule', ruleId)
