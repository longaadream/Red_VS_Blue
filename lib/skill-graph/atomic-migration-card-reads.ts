import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayLiteral,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

const numberType: GameplayValueType = 'number'
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: 'record' }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function isValue(value: unknown): value is GameplayValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value')
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0
  return record.kind === 'output' && typeof record.node === 'string' && typeof record.port === 'string'
}

function requiredInput(call: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = call.inputs?.[name]
  return isValue(value) ? value : undefined
}

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function replaceCall(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters: Readonly<Record<string, GameplayJsonValue>>,
): GameplayCallStatement {
  return { ...original, module, version: '1', inputs, parameters }
}

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function cardNumber(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cardId = requiredInput(call, 'cardId')
  if (!cardId || call.parameters?.field !== 'damageAmount') return undefined
  const fallback = call.parameters?.fallback === undefined ? 0 : call.parameters.fallback
  if (typeof fallback !== 'number' || !Number.isFinite(fallback)) return undefined

  const customCards = fresh('custom-cards')
  const definition = fresh('card-definition')
  const damage = fresh('damage-amount')
  const content = generatedCall(customCards, 'content.field', {}, { field: 'customCards' })
  const definitionRead = generatedCall(definition, 'data.read-key', {
    record: output(customCards), key: cardId,
  }, { key: '', valueType: valueTypeParameter(nullableRecordType) })
  const damageRead = generatedCall(damage, 'data.read-key', {
    record: output(definition),
  }, { key: 'damageAmount', valueType: valueTypeParameter(nullableNumberType) })
  const result = replaceCall(call, 'value.coalesce', {
    value: output(damage), defaultValue: literal(fallback),
  }, { valueType: valueTypeParameter(numberType) })
  const statements: GameplayStatement[] = [content, definitionRead, damageRead, result]
  return { statements, outputs: { value: output(call.id) } }
}

export const ATOMIC_CARD_READ_MODULES = new Set(['content.card-number'])
export const ATOMIC_CARD_READ_MODULE_IDS = ATOMIC_CARD_READ_MODULES

export const atomicCardReadRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  if (call.module === 'content.card-number') return cardNumber(call, fresh)
  return undefined
}

export function migrateCardReadModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicCardReadRecipe)
}

export const migrateAtomicCardReadGraph = migrateCardReadModules
