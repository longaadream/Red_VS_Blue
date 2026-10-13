import { authorValueSchemas, requireAuthorValue } from './author-extension'
import type { GameplayRecordSchema, GameplayValueType } from '../skill-graph/module-types'

export type ExecutionLocalDeclaration = {
  readonly handle: object
  readonly success: boolean
}
export type ExecutionLocalReadResult = {
  readonly value: unknown
  readonly success: boolean
}

export type ExecutionLocalWriteResult = {
  readonly success: boolean
}

type LocalEntry = {
  readonly typeKey: string
  readonly schemaKey: string
  initialized: boolean
  value: unknown
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('flow: 局部变量类型无效')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error('flow: 局部变量类型无效')
  if (Object.getOwnPropertySymbols(value).length) throw new Error('flow: 局部变量类型包含Symbol属性')
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const entries = Object.keys(value).sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('flow: 局部变量类型包含不允许的属性')
    return JSON.stringify(key) + ':' + canonical(descriptor.value)
  })
  return '{' + entries.join(',') + '}'
}

function clone(value: unknown, seen = new Set<object>(), depth = 0, isOpaqueReference: (value: object) => boolean = () => false): unknown {
  if (depth > 40) throw new Error('flow: 局部变量嵌套过深')
  if (value === null) return value
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('flow: 局部变量仅允许有限JSON值')
    return value
  }
  if (typeof value !== 'object') throw new Error('flow: 局部变量仅允许有限JSON值')
  if (isOpaqueReference(value)) return value
  if (seen.has(value)) throw new Error('flow: 局部变量不允许循环引用')
  if (Object.getOwnPropertySymbols(value).length) throw new Error('flow: 局部变量不允许Symbol属性')
  const isArray = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('flow: 局部变量仅允许有限JSON值')
  seen.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (isArray) {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length') {
        if (!('value' in descriptor)) throw new Error('flow: 局部变量包含不允许的属性')
        continue
      }
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error('flow: 局部变量包含不允许的属性')
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error('flow: 局部变量不允许稀疏数组')
    }
    const result = value.map(item => clone(item, seen, depth + 1, isOpaqueReference))
    seen.delete(value)
    return result
  }
  const result: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('flow: 局部变量包含不允许的属性')
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('flow: 局部变量包含不允许的属性')
    result[key] = clone(descriptor.value, seen, depth + 1, isOpaqueReference)
  }
  seen.delete(value)
  return result
}

/**
 * Execution-local typed values. Handles are identity-only capabilities held
 * in this runtime instance; their shape carries no authority and cannot be
 * forged or reused by another execution.
 */
export function createExecutionLocalRuntime(isOpaqueReference: (value: object) => boolean = () => false) {
  const entries = new WeakMap<object, LocalEntry>()
  const isRegisteredOpaque = (value: object): boolean => entries.has(value) || isOpaqueReference(value)
  const safeClone = (value: unknown): unknown => clone(value, new Set<object>(), 0, isRegisteredOpaque)

  const selectedType = (type: GameplayValueType, schemas: readonly GameplayRecordSchema[]) => ({
    typeKey: canonical(type),
    schemaKey: canonical(authorValueSchemas(type, schemas)),
  })
  const entryFor = (handle: object, type: GameplayValueType, schemas: readonly GameplayRecordSchema[]): LocalEntry => {
    const entry = entries.get(handle)
    if (!entry) throw new Error('flow: 局部变量句柄不属于当前执行')
    const selected = selectedType(type, schemas)
    if (entry.typeKey !== selected.typeKey || entry.schemaKey !== selected.schemaKey) throw new Error('flow: 局部变量声明类型不一致')
    return entry
  }

  return {
    declare(type: GameplayValueType, schemas: readonly GameplayRecordSchema[], initial?: unknown): ExecutionLocalDeclaration {
      const selected = selectedType(type, schemas)
      const initialized = arguments.length >= 3
      const value = initialized ? requireAuthorValue(safeClone(initial), type, schemas) : undefined
      const handle = Object.freeze(Object.create(null)) as object
      entries.set(handle, { ...selected, initialized, value })
      return { handle, success: true }
    },
    read(handle: object, type: GameplayValueType, schemas: readonly GameplayRecordSchema[]): ExecutionLocalReadResult {
      const entry = entryFor(handle, type, schemas)
      if (!entry.initialized) throw new Error('flow: 局部变量尚未赋值')
      const copied = safeClone(entry.value)
      return { value: requireAuthorValue(copied, type, schemas), success: true }
    },
    write(handle: object, type: GameplayValueType, schemas: readonly GameplayRecordSchema[], value: unknown): ExecutionLocalWriteResult {
      const entry = entryFor(handle, type, schemas)
      const copied = safeClone(value)
      const checked = requireAuthorValue(copied, type, schemas)
      entry.value = checked
      entry.initialized = true
      return { success: true }
    },
  }
}
