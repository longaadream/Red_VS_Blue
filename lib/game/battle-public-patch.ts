import { hashStable } from './battle-trace'

export const BATTLE_AUTHORITY_PROTOCOL_VERSION = 2 as const

export type BattlePatchPath = Array<string | number>

export type BattlePatchOperation =
  | { op: 'set'; path: BattlePatchPath; value: unknown }
  | { op: 'remove'; path: BattlePatchPath }

export interface BattlePublicPatchEnvelope {
  protocolVersion: typeof BATTLE_AUTHORITY_PROTOCOL_VERSION
  roomId: string
  fromVersion: number
  toVersion: number
  prePublicHash: string
  postPublicHash: string
  patch: BattlePatchOperation[]
}

export class BattlePublicPatchError extends Error {
  code: 'BATTLE_PATCH_VERSION_GAP' | 'BATTLE_PATCH_PRE_HASH_MISMATCH' | 'BATTLE_PATCH_POST_HASH_MISMATCH' | 'BATTLE_PATCH_INVALID'
  context: Record<string, unknown>

  constructor(
    code: BattlePublicPatchError['code'],
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'BattlePublicPatchError'
    this.code = code
    this.context = context
  }
}

export function hashPublicBattleState(state: unknown): string {
  return hashStable(state)
}

export function createBattlePublicPatch(before: unknown, after: unknown): BattlePatchOperation[] {
  const patch: BattlePatchOperation[] = []
  diffValue(before, after, [], patch)
  return patch
}

export function applyBattlePublicPatch<T>(
  source: T,
  patchOrEnvelope: BattlePatchOperation[] | BattlePublicPatchEnvelope,
  options: { authorityVersion?: number } = {},
): T {
  const envelope = Array.isArray(patchOrEnvelope) ? undefined : patchOrEnvelope as BattlePublicPatchEnvelope
  const patch: BattlePatchOperation[] = envelope ? envelope.patch : patchOrEnvelope as BattlePatchOperation[]
  if (envelope) {
    if (envelope.protocolVersion !== BATTLE_AUTHORITY_PROTOCOL_VERSION) {
      throw invalidPatch('Unsupported battle authority protocol version', {
        protocolVersion: envelope.protocolVersion,
      })
    }
    if (options.authorityVersion !== undefined && options.authorityVersion !== envelope.fromVersion) {
      throw new BattlePublicPatchError(
        'BATTLE_PATCH_VERSION_GAP',
        `Battle patch version gap: local ${options.authorityVersion}, patch starts at ${envelope.fromVersion}`,
        { authorityVersion: options.authorityVersion, fromVersion: envelope.fromVersion, toVersion: envelope.toVersion },
      )
    }
    const actualPreHash = hashPublicBattleState(source)
    if (actualPreHash !== envelope.prePublicHash) {
      throw new BattlePublicPatchError(
        'BATTLE_PATCH_PRE_HASH_MISMATCH',
        'Battle patch pre-public hash mismatch',
        { expected: envelope.prePublicHash, actual: actualPreHash },
      )
    }
  }

  let target = cloneJson(source) as unknown
  for (const operation of patch) target = applyOperation(target, operation)

  if (envelope) {
    const actualPostHash = hashPublicBattleState(target)
    if (actualPostHash !== envelope.postPublicHash) {
      throw new BattlePublicPatchError(
        'BATTLE_PATCH_POST_HASH_MISMATCH',
        'Battle patch post-public hash mismatch',
        { expected: envelope.postPublicHash, actual: actualPostHash },
      )
    }
  }
  return target as T
}

function diffValue(
  before: unknown,
  after: unknown,
  path: BattlePatchPath,
  patch: BattlePatchOperation[],
): void {
  if (Object.is(before, after)) return
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      patch.push({ op: 'set', path, value: cloneJson(after) })
      return
    }
    for (let index = 0; index < after.length; index += 1) {
      diffValue(before[index], after[index], [...path, index], patch)
    }
    return
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const beforeKeys = Object.keys(before).sort()
    const afterKeys = Object.keys(after).sort()
    const afterSet = new Set(afterKeys)
    for (const key of beforeKeys) {
      if (!afterSet.has(key)) patch.push({ op: 'remove', path: [...path, key] })
    }
    const beforeSet = new Set(beforeKeys)
    for (const key of afterKeys) {
      if (!beforeSet.has(key)) {
        patch.push({ op: 'set', path: [...path, key], value: cloneJson(after[key]) })
      } else {
        diffValue(before[key], after[key], [...path, key], patch)
      }
    }
    return
  }
  patch.push({ op: 'set', path, value: cloneJson(after) })
}

function applyOperation(root: unknown, operation: BattlePatchOperation): unknown {
  if (!operation || (operation.op !== 'set' && operation.op !== 'remove') || !Array.isArray(operation.path)) {
    throw invalidPatch('Malformed battle patch operation')
  }
  assertSafePath(operation.path)
  if (operation.path.length === 0) {
    if (operation.op === 'remove') throw invalidPatch('Cannot remove the battle patch root')
    return cloneJson(operation.value)
  }

  let parent = root as Record<string | number, unknown> | unknown[]
  for (let index = 0; index < operation.path.length - 1; index += 1) {
    const segment = operation.path[index]
    if (!parent || typeof parent !== 'object' || !(segment in parent)) {
      throw invalidPatch('Battle patch path does not exist', { path: operation.path })
    }
    parent = parent[segment as keyof typeof parent] as typeof parent
  }
  if (!parent || typeof parent !== 'object') {
    throw invalidPatch('Battle patch parent is not an object', { path: operation.path })
  }
  const key = operation.path.at(-1)!
  if (Array.isArray(parent)) {
    if (!Number.isSafeInteger(key) || Number(key) < 0 || Number(key) >= parent.length) {
      throw invalidPatch('Battle patch array index is invalid', { path: operation.path })
    }
    if (operation.op === 'remove') parent.splice(Number(key), 1)
    else parent[Number(key)] = cloneJson(operation.value)
    return root
  }
  if (typeof key !== 'string') throw invalidPatch('Battle patch object key must be a string', { path: operation.path })
  if (operation.op === 'remove') delete parent[key]
  else parent[key] = cloneJson(operation.value)
  return root
}

function assertSafePath(path: BattlePatchPath): void {
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Number.isSafeInteger(segment) || segment < 0) throw invalidPatch('Unsafe patch path', { path })
      continue
    }
    if (typeof segment !== 'string' || segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
      throw invalidPatch('Unsafe patch path', { path })
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw invalidPatch('Battle patch contains a non-JSON value', { valueType: typeof value })
  }
  return JSON.parse(serialized) as T
}

function invalidPatch(message: string, context: Record<string, unknown> = {}): BattlePublicPatchError {
  return new BattlePublicPatchError('BATTLE_PATCH_INVALID', message, context)
}
