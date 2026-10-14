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

const nullableString: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullableNumber: GameplayValueType = { kind: 'nullable', value: 'number' }
const nullableRecord: GameplayValueType = { kind: 'nullable', value: 'record' }

/** Compatibility module IDs lowered by this recipe. */
export const ATOMIC_CAPTURED_FIELD_MODULES = new Set([
  'piece.captured-name',
  'source.captured-owner',
  'source.captured-identifier',
  'source.captured-max-hp',
  'piece.name-or',
  'piece.display-name',
  'piece.momentum',
  'recall.source-owner',
  'recall.source-present',
  'piece.owner-id',
  'piece.owner-id-text',
])

export const ATOMIC_CAPTURED_FIELD_MODULE_IDS = ATOMIC_CAPTURED_FIELD_MODULES

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
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version: '1', inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

function replaceCall(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
): GameplayCallStatement {
  const next: Record<string, unknown> = { ...original, module, version: '1', inputs }
  if (parameters === undefined) delete next.parameters
  else next.parameters = parameters
  return next as GameplayCallStatement
}

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function sourceFields(id: string, source: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'source.fields', { source })
}

function strictDataField(
  original: GameplayCallStatement,
  record: GameplayValue,
  field: 'ownerPlayerId' | 'instanceId',
): GameplayCallStatement {
  return { ...original, module: 'data.field', version: '2', inputs: { record }, parameters: { field } }
}

function optionalField(id: string, record: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, 'data.optional-field', { record }, { field })
}

function pieceField(id: string, piece: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, 'piece.field', { piece }, { field })
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  type: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return generatedCall(id, 'compare.values', { left, right }, {
    valueType: valueTypeParameter(type), operator,
  })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.and', { left, right })
}

function select(
  id: string,
  condition: GameplayValue,
  whenTrue: GameplayValue,
  whenFalse: GameplayValue,
  type: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'logic.select', { condition, whenTrue, whenFalse }, { valueType: valueTypeParameter(type) })
}

function coalesce(
  id: string,
  value: GameplayValue,
  defaultValue: GameplayValue,
  type: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'value.coalesce', { value, defaultValue }, { valueType: valueTypeParameter(type) })
}

function fallbackParameter(call: GameplayCallStatement): 'none' | 'templateId' | undefined {
  const fallback = call.parameters?.fallback
  if (fallback === undefined) return 'none'
  return fallback === 'none' || fallback === 'templateId' ? fallback : undefined
}

function truthyText(
  ids: { readonly nonNull: string; readonly nonEmpty: string; readonly truthy: string },
  value: GameplayValue,
): GameplayStatement[] {
  return [
    compare(ids.nonNull, value, literal(null), nullableString, '!='),
    compare(ids.nonEmpty, value, literal(''), nullableString, '!='),
    and(ids.truthy, output(ids.nonNull), output(ids.nonEmpty)),
  ]
}

function capturedName(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const fallback = fallbackParameter(call)
  if (!source || !fallback) return undefined

  const snapshot = fresh('source-fields')
  const name = fresh('name')
  const statements: GameplayStatement[] = [sourceFields(snapshot, source), optionalField(name, output(snapshot, 'record'), 'name')]
  let selected = output(name)
  if (fallback === 'templateId') {
    const template = fresh('template-id')
    const nonNull = fresh('name-present')
    const nonEmpty = fresh('name-nonempty')
    const truthy = fresh('name-truthy')
    const selectedName = fresh('selected-name')
    statements.push(
      optionalField(template, output(snapshot, 'record'), 'templateId'),
      ...truthyText({ nonNull, nonEmpty, truthy }, output(name)),
      select(selectedName, output(truthy), output(name), output(template), nullableString),
    )
    selected = output(selectedName)
  }

  // `capturedFields` is a JSON snapshot, so an absent property is omitted but
  // an explicit null remains present.  Preserve the old String(undefined) vs
  // String(null) distinction using the optional reader's `defined` output.
  // Template fallback already turns a null/empty name into templateId, so the
  // distinction only applies to the no-fallback form.
  let normalized: GameplayValue
  if (fallback === 'none') {
    const isNull = fresh('name-null')
    const nullText = fresh('name-null-text')
    const nameDefault = fresh('name-default')
    statements.push(
      compare(isNull, selected, literal(null), nullableString),
      select(nullText, output(name, 'defined'), literal('null'), literal('undefined'), 'string'),
      select(nameDefault, output(isNull), output(nullText), selected, nullableString),
    )
    normalized = output(nameDefault)
  } else {
    const nameDefault = fresh('name-default')
    statements.push(coalesce(nameDefault, selected, literal('undefined'), nullableString))
    normalized = output(nameDefault)
  }
  const text = replaceCall(call, 'text.from-value', { value: normalized }, { valueType: 'string' })
  statements.push(text)
  return { statements, outputs: { value: output(call.id, 'text') } }
}

function capturedMaxHp(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const fallback = requiredInput(call, 'fallback')
  if (!source || !fallback) return undefined

  const snapshot = fresh('source-fields')
  const rawMax = fresh('max-hp')
  const stats = fresh('stats')
  const statsMax = fresh('stats-max-hp')
  const rawPresent = fresh('max-hp-present')
  const rawNonZero = fresh('max-hp-nonzero')
  const rawTruthy = fresh('max-hp-truthy')
  const statsPresent = fresh('stats-max-hp-present')
  const statsNonZero = fresh('stats-max-hp-nonzero')
  const statsTruthy = fresh('stats-max-hp-truthy')
  const statsOrFallback = fresh('stats-or-fallback')
  const statsDefault = fresh('stats-default')
  const selected = fresh('selected-max-hp')
  const result = replaceCall(call, 'value.coalesce', {
    value: output(selected), defaultValue: fallback,
  }, { valueType: 'number' })

  return {
    statements: [
      sourceFields(snapshot, source),
      optionalField(rawMax, output(snapshot, 'record'), 'maxHp'),
      optionalField(stats, output(snapshot, 'record'), 'stats'),
      optionalField(statsMax, output(stats), 'maxHp'),
      compare(rawPresent, output(rawMax), literal(null), nullableNumber, '!='),
      compare(rawNonZero, output(rawMax), literal(0), nullableNumber, '!='),
      and(rawTruthy, output(rawPresent), output(rawNonZero)),
      compare(statsPresent, output(statsMax), literal(null), nullableNumber, '!='),
      compare(statsNonZero, output(statsMax), literal(0), nullableNumber, '!='),
      and(statsTruthy, output(statsPresent), output(statsNonZero)),
      select(statsOrFallback, output(statsTruthy), output(statsMax), fallback, nullableNumber),
      coalesce(statsDefault, output(statsOrFallback), fallback, nullableNumber),
      select(selected, output(rawTruthy), output(rawMax), output(statsDefault), nullableNumber),
      result,
    ],
    outputs: { value: output(call.id) },
  }
}

function capturedField(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  field: 'ownerPlayerId' | 'instanceId',
  outputPort: 'player' | 'value',
): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  if (!source) return undefined
  const snapshot = fresh('source-fields')
  return {
    statements: [sourceFields(snapshot, source), strictDataField(call, output(snapshot, 'record'), field)],
    outputs: { [outputPort]: output(call.id) },
  }
}

function liveName(call: GameplayCallStatement): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const fallback = requiredInput(call, 'fallback')
  if (!piece || !fallback) return undefined
  return {
    // The new field reader owns the living-reference boundary.  An absent or
    // defeated piece becomes an invalid dependency instead of a fallback path.
    statements: [replaceCall(call, 'piece.field', { piece }, { field: 'name' })],
    outputs: { text: output(call.id) },
  }
}

function displayName(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const fallback = fallbackParameter(call)
  if (!piece || !fallback) return undefined
  if (fallback === 'none') {
    return { statements: [replaceCall(call, 'piece.field', { piece }, { field: 'name' })] }
  }

  const name = fresh('name')
  const template = fresh('template-id')
  const nonNull = fresh('name-present')
  const nonEmpty = fresh('name-nonempty')
  const truthy = fresh('name-truthy')
  const result = replaceCall(call, 'logic.select', {
    condition: output(truthy), whenTrue: output(name), whenFalse: output(template),
  }, { valueType: 'string' })
  return {
    statements: [
      pieceField(name, piece, 'name'),
      pieceField(template, piece, 'templateId'),
      ...truthyText({ nonNull, nonEmpty, truthy }, output(name)),
      result,
    ],
    outputs: { value: output(call.id) },
  }
}

function pieceOwnerText(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  if (!piece) return undefined
  const owner = fresh('owner')
  const text = replaceCall(call, 'text.from-value', { value: output(owner) }, { valueType: 'player' })
  return {
    statements: [pieceField(owner, piece, 'ownerPlayerId'), text],
    outputs: { playerId: output(call.id, 'text') },
  }
}

function recallSourceOwner(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const source = fresh('event-source')
  return {
    statements: [
      generatedCall(source, 'event.field', {}, { field: 'sourcePiece' }),
      replaceCall(call, 'data.optional-field', { record: output(source) }, { field: 'ownerPlayerId' }),
    ],
    outputs: { player: output(call.id) },
  }
}

function recallSourcePresent(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const source = fresh('event-source')
  return {
    statements: [
      generatedCall(source, 'event.field', {}, { field: 'sourcePiece' }),
      replaceCall(call, 'compare.values', { left: output(source), right: literal(null) }, {
        valueType: valueTypeParameter(nullableRecord), operator: '!=',
      }),
    ],
  }
}

/** Rewrite the captured/name compatibility adapters into field composition. */
export const atomicCapturedFieldRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  switch (call.module) {
    case 'piece.captured-name': return capturedName(call, fresh)
    case 'source.captured-owner': return capturedField(call, fresh, 'ownerPlayerId', 'player')
    case 'source.captured-identifier': return capturedField(call, fresh, 'instanceId', 'value')
    case 'source.captured-max-hp': return capturedMaxHp(call, fresh)
    case 'piece.name-or': return liveName(call)
    case 'piece.display-name': return displayName(call, fresh)
    case 'piece.momentum': {
      const piece = requiredInput(call, 'piece')
      return piece ? { statements: [replaceCall(call, 'piece.field', { piece }, { field: 'momentum' })] } : undefined
    }
    case 'recall.source-owner': return recallSourceOwner(call, fresh)
    case 'recall.source-present': return recallSourcePresent(call, fresh)
    case 'piece.owner-id':
    case 'piece.owner-id-text': return pieceOwnerText(call, fresh)
    default: return undefined
  }
}

export function createCapturedFieldMigrationRecipe(): AtomicRecipe {
  return atomicCapturedFieldRecipe
}

export function migrateCapturedFieldModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicCapturedFieldRecipe)
}

export const migrateAtomicCapturedFieldGraph = migrateCapturedFieldModules
