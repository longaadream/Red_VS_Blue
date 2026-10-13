import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayLiteral,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * Lower the small compatibility-only value and collection helpers into the
 * generic author primitives.  This module only rewrites pure convenience
 * calls; effectful queries and host-backed rules remain untouched.
 *
 * The replacement keeps the source call id on the final value-producing
 * statement.  `rewriteAtomicGraph` then maps every old output port to that
 * statement (or to an intermediate port), so references in later lexical
 * scopes continue to resolve without retaining the compatibility module.
 */

const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
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

function callLike(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayLiteral>>,
): GameplayCallStatement {
  const next: Record<string, unknown> = { ...original, module, version: module === 'logic.select' ? '2' : '1', inputs }
  if (parameters === undefined) delete next.parameters
  else next.parameters = parameters
  return next as GameplayCallStatement
}

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayLiteral>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version: module === 'logic.select' ? '2' : '1', inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function nullableType(type: GameplayValueType): GameplayValueType {
  return { kind: 'nullable', value: type }
}

function genericCompare(
  call: GameplayCallStatement,
  left: GameplayValue,
  right: GameplayValue,
  type: GameplayValueType,
  operator: '==' | '!=',
  outputPort = 'value',
): AtomicReplacement {
  const compare = callLike(call, 'compare.values', { left, right }, {
    valueType: valueTypeParameter(type),
    operator,
  })
  return { statements: [compare], outputs: { [outputPort]: output(call.id, 'value') } }
}

function genericSelect(
  call: GameplayCallStatement,
  condition: GameplayValue,
  whenTrue: GameplayValue,
  whenFalse: GameplayValue,
  type: GameplayValueType,
  outputPort: string,
): AtomicReplacement {
  const select = callLike(call, 'logic.select', { condition, whenTrue, whenFalse }, {
    valueType: valueTypeParameter(type),
  })
  return { statements: [select], outputs: { [outputPort]: output(call.id, 'value') } }
}

function directLength(
  call: GameplayCallStatement,
  sourceName: string,
  outputPort: string,
): AtomicReplacement | undefined {
  const items = requiredInput(call, sourceName)
  if (!items) return undefined
  const length = callLike(call, 'collection.length', { items })
  return { statements: [length], outputs: { [outputPort]: output(call.id, 'value') } }
}

function directJoin(call: GameplayCallStatement): AtomicReplacement | undefined {
  const items = requiredInput(call, 'items')
  if (!items) return undefined
  const hasSeparator = Object.prototype.hasOwnProperty.call(call.parameters ?? {}, 'separator')
  const separator = hasSeparator ? call.parameters?.separator : ','
  // The source descriptor rejects non-text separators.  Leave malformed
  // calls untouched so this rewrite cannot turn a diagnostic into a valid
  // graph with a different default.
  if (typeof separator !== 'string') return undefined
  const join = callLike(call, 'text.join-list', { items }, { separator })
  return { statements: [join], outputs: { text: output(call.id, 'text') } }
}

function directSelectNumber(call: GameplayCallStatement): AtomicReplacement | undefined {
  const condition = requiredInput(call, 'condition')
  const whenTrue = requiredInput(call, 'whenTrue')
  const whenFalse = requiredInput(call, 'whenFalse')
  if (!condition || !whenTrue || !whenFalse) return undefined
  return genericSelect(call, condition, whenTrue, whenFalse, 'number', 'value')
}

function directSelectText(call: GameplayCallStatement): AtomicReplacement | undefined {
  const condition = requiredInput(call, 'condition')
  const whenTrue = requiredInput(call, 'whenTrue')
  const whenFalse = requiredInput(call, 'whenFalse')
  if (!condition || !whenTrue || !whenFalse) return undefined
  return genericSelect(call, condition, whenTrue, whenFalse, 'string', 'text')
}

function filterLength(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  items: GameplayValue,
  capturedName: string,
  captured: GameplayValue,
  comparisonType: GameplayValueType,
): AtomicReplacement {
  const filterId = fresh('filter')
  const comparisonId = fresh('compare')
  const returnId = fresh('filter-return')
  const lengthId = fresh('length')
  const filter: GameplayStatement = {
    kind: 'collection',
    id: filterId,
    method: 'filter',
    items,
    item: 'item',
    inputs: { [capturedName]: captured },
    body: [
      generatedCall(comparisonId, 'compare.values', {
        left: input('item'),
        right: input(capturedName),
      }, { valueType: valueTypeParameter(comparisonType), operator: '==' }),
      { kind: 'return', id: returnId, value: output(comparisonId, 'value') },
    ],
  }
  const length = generatedCall(lengthId, 'collection.length', { items: output(filterId, 'value') })
  const hasMatch = callLike(call, 'compare.greater-than', {
    left: output(lengthId, 'value'),
    right: literal(0),
  })
  return {
    statements: [filter, length, hasMatch],
    outputs: { contains: output(call.id, 'value') },
  }
}

function contains(call: GameplayCallStatement, fresh: (suffix: string) => string, comparisonType: GameplayValueType): AtomicReplacement | undefined {
  const items = requiredInput(call, 'items')
  const value = requiredInput(call, 'value')
  if (!items || !value) return undefined
  return filterLength(call, fresh, items, 'needle', value, comparisonType)
}

function duplicate(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const items = requiredInput(call, 'items')
  if (!items) return undefined
  const distinctId = fresh('distinct')
  const sourceLengthId = fresh('source-length')
  const distinctLengthId = fresh('distinct-length')
  const distinct = generatedCall(distinctId, 'collection.distinct', { items }, {
    valueType: JSON.stringify({ kind: 'list', element: 'string' }),
  })
  const sourceLength = generatedCall(sourceLengthId, 'collection.length', { items })
  const distinctLength = generatedCall(distinctLengthId, 'collection.length', { items: output(distinctId, 'value') })
  const comparison = callLike(call, 'compare.values', {
    left: output(sourceLengthId, 'value'),
    right: output(distinctLengthId, 'value'),
  }, { valueType: 'number', operator: '!=' })
  return {
    statements: [distinct, sourceLength, distinctLength, comparison],
    outputs: { duplicate: output(call.id, 'value') },
  }
}

function allIn(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const items = requiredInput(call, 'items')
  if (!items) return undefined
  let allowed: GameplayValue
  if (call.module === 'list.all-in') {
    const raw = call.parameters?.allowed
    if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) return undefined
    allowed = literal(raw)
  } else {
    const captured = requiredInput(call, 'allowed')
    if (!captured) return undefined
    allowed = captured
  }

  const matchesId = fresh('allowed-matches')
  const matchId = fresh('allowed-match')
  const matchReturnId = fresh('allowed-match-return')
  const matchCountId = fresh('allowed-match-count')
  const matchExistsId = fresh('allowed-match-exists')
  const allItemsId = fresh('all-items')
  const allCountId = fresh('all-count')
  const sourceCountId = fresh('source-count')

  const matches: GameplayStatement = {
    kind: 'collection',
    id: matchesId,
    method: 'filter',
    items: input('allowed'),
    item: 'allowedItem',
    inputs: { candidate: input('item') },
    body: [
      generatedCall(matchId, 'compare.values', {
        left: input('candidate'),
        right: input('allowedItem'),
      }, { valueType: 'string', operator: '==' }),
      { kind: 'return', id: matchReturnId, value: output(matchId, 'value') },
    ],
  }
  const matchCount = generatedCall(matchCountId, 'collection.length', { items: output(matchesId, 'value') })
  const matchExists = generatedCall(matchExistsId, 'compare.greater-than', {
    left: output(matchCountId, 'value'),
    right: literal(0),
  })
  const allItems: GameplayStatement = {
    kind: 'collection',
    id: allItemsId,
    method: 'filter',
    items,
    item: 'item',
    inputs: { allowed },
    body: [matches, matchCount, matchExists, { kind: 'return', id: fresh('all-item-return'), value: output(matchExistsId, 'value') }],
  }
  const allCount = generatedCall(allCountId, 'collection.length', { items: output(allItemsId, 'value') })
  const sourceCount = generatedCall(sourceCountId, 'collection.length', { items })
  const comparison = callLike(call, 'compare.values', {
    left: output(allCountId, 'value'),
    right: output(sourceCountId, 'value'),
  }, { valueType: 'number', operator: '==' })
  return {
    statements: [allItems, allCount, sourceCount, comparison],
    outputs: { valid: output(call.id, 'value') },
  }
}

function optionalFragment(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const condition = requiredInput(call, 'condition')
  const value = requiredInput(call, 'value')
  if (!condition || !value) return undefined
  const parameters = call.parameters ?? {}
  const prefix = Object.prototype.hasOwnProperty.call(parameters, 'prefix') ? parameters.prefix : ''
  const suffix = Object.prototype.hasOwnProperty.call(parameters, 'suffix') ? parameters.suffix : ''
  if (typeof prefix !== 'string' || typeof suffix !== 'string') return undefined
  const prefixId = fresh('prefix-value')
  const fullId = fresh('full-value')
  const prefixValue = generatedCall(prefixId, 'text.concat', { left: literal(prefix), right: value })
  const fullValue = generatedCall(fullId, 'text.concat', { left: output(prefixId, 'text'), right: literal(suffix) })
  const selected = callLike(call, 'logic.select', {
    condition,
    whenTrue: output(fullId, 'text'),
    whenFalse: literal(''),
  }, { valueType: 'string' })
  return {
    statements: [prefixValue, fullValue, selected],
    outputs: { text: output(call.id, 'value') },
  }
}

function typedComparison(call: GameplayCallStatement): AtomicReplacement | undefined {
  const left = requiredInput(call, 'left')
  const right = requiredInput(call, 'right')
  if (!left || !right) return undefined
  const baseTypes: Readonly<Record<string, GameplayValueType>> = {
    'compare.equal': 'number',
    'compare.not-equal': 'number',
    'compare.equal-string': 'string',
    'compare.not-equal-string': 'string',
    'compare.equal-boolean': 'boolean',
    'compare.not-equal-boolean': 'boolean',
    'compare.equal-piece': 'piece',
    'compare.not-equal-piece': 'piece',
    'compare.equal-player': 'player',
    'compare.not-equal-player': 'player',
    'compare.equal-string-nullable': nullableType('string'),
    'compare.text': nullableType('string'),
    'compare.equal-piece-nullable': nullableType('piece'),
    'compare.player-reference': nullableType('player'),
  }
  const baseType = baseTypes[call.module]
  if (!baseType) return undefined
  const operator: '==' | '!=' = call.module.includes('not-equal') ? '!=' : '=='
  return genericCompare(call, left, right, baseType, operator)
}

function valuePresent(call: GameplayCallStatement, inputName: string, outputPort: string, type: GameplayValueType): AtomicReplacement | undefined {
  const value = requiredInput(call, inputName)
  if (!value) return undefined
  return genericCompare(call, value, literal(null), nullableType(type), '!=', outputPort)
}

/**
 * `spatial.cell-in-list` is also a pure membership convenience.  It cannot
 * use the compatibility `spatial.cell-equal` call inside the filter because
 * generated bodies are not recursively rewritten, so compose its coordinate
 * reads and ordinary numeric comparisons inline.
 */
function cellInList(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cell = requiredInput(call, 'cell')
  const cells = requiredInput(call, 'cells')
  if (!cell || !cells) return undefined

  const filterId = fresh('filter')
  const needleCoordinatesId = fresh('needle-coordinates')
  const itemCoordinatesId = fresh('item-coordinates')
  const xEqualId = fresh('x-equal')
  const yEqualId = fresh('y-equal')
  const bothEqualId = fresh('coordinates-equal')
  const returnId = fresh('filter-return')
  const lengthId = fresh('length')
  const length = generatedCall(lengthId, 'collection.length', { items: output(filterId, 'value') })
  const hasMatch = callLike(call, 'compare.greater-than', {
    left: output(lengthId, 'value'),
    right: literal(0),
  })
  const filter: GameplayStatement = {
    kind: 'collection',
    id: filterId,
    method: 'filter',
    items: cells,
    item: 'item',
    inputs: { needle: cell },
    body: [
      generatedCall(needleCoordinatesId, 'spatial.cell-coordinates', { cell: input('needle') }),
      generatedCall(itemCoordinatesId, 'spatial.cell-coordinates', { cell: input('item') }),
      generatedCall(xEqualId, 'compare.values', {
        left: output(needleCoordinatesId, 'x'),
        right: output(itemCoordinatesId, 'x'),
      }, { valueType: 'number', operator: '==' }),
      generatedCall(yEqualId, 'compare.values', {
        left: output(needleCoordinatesId, 'y'),
        right: output(itemCoordinatesId, 'y'),
      }, { valueType: 'number', operator: '==' }),
      generatedCall(bothEqualId, 'logic.and', {
        left: output(xEqualId, 'value'),
        right: output(yEqualId, 'value'),
      }),
      { kind: 'return', id: returnId, value: output(bothEqualId, 'value') },
    ],
  }
  return { statements: [filter, length, hasMatch], outputs: { value: output(call.id, 'value') } }
}

function cellAdjacent(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const left = requiredInput(call, 'left')
  const right = requiredInput(call, 'right')
  if (!left || !right) return undefined
  const distanceId = fresh('distance')
  const distance = generatedCall(distanceId, 'spatial.cell-distance', { from: left, to: right })
  const compare = callLike(call, 'compare.values', {
    left: output(distanceId, 'distance'),
    right: literal(1),
  }, { valueType: 'number', operator: '==' })
  return { statements: [distance, compare], outputs: { value: output(call.id, 'value') } }
}

// The legacy descriptor accepts nullable cells and returns `false` when one is
// absent.  The generic coordinate primitive intentionally uses the engine's
// invalid-dependency propagation for that branch; callers receive an omitted
// optional result instead of a fabricated coordinate or a hidden fallback.
function cellEqual(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const left = requiredInput(call, 'left')
  const right = requiredInput(call, 'right')
  if (!left || !right) return undefined
  const leftCoordinatesId = fresh('left-coordinates')
  const rightCoordinatesId = fresh('right-coordinates')
  const xEqualId = fresh('x-equal')
  const yEqualId = fresh('y-equal')
  const leftCoordinates = generatedCall(leftCoordinatesId, 'spatial.cell-coordinates', { cell: left })
  const rightCoordinates = generatedCall(rightCoordinatesId, 'spatial.cell-coordinates', { cell: right })
  const xEqual = generatedCall(xEqualId, 'compare.values', {
    left: output(leftCoordinatesId, 'x'),
    right: output(rightCoordinatesId, 'x'),
  }, { valueType: 'number', operator: '==' })
  const yEqual = generatedCall(yEqualId, 'compare.values', {
    left: output(leftCoordinatesId, 'y'),
    right: output(rightCoordinatesId, 'y'),
  }, { valueType: 'number', operator: '==' })
  const bothEqual = callLike(call, 'logic.and', {
    left: output(xEqualId, 'value'),
    right: output(yEqualId, 'value'),
  })
  return {
    statements: [leftCoordinates, rightCoordinates, xEqual, yEqual, bothEqual],
    outputs: { value: output(call.id, 'value') },
  }
}

function cellDelta(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const from = requiredInput(call, 'from')
  const to = requiredInput(call, 'to')
  if (!from || !to) return undefined

  const fromCoordinatesId = fresh('from-coordinates')
  const toCoordinatesId = fresh('to-coordinates')
  const dxId = fresh('dx')
  const dyId = fresh('dy')
  const absDxId = fresh('abs-dx')
  const absDyId = fresh('abs-dy')
  const chebyshevId = fresh('chebyshev')
  const xZeroId = fresh('x-zero')
  const yZeroId = fresh('y-zero')
  const fromCoordinates = generatedCall(fromCoordinatesId, 'spatial.cell-coordinates', { cell: from })
  const toCoordinates = generatedCall(toCoordinatesId, 'spatial.cell-coordinates', { cell: to })
  const dx = generatedCall(dxId, 'math.subtract', {
    left: output(toCoordinatesId, 'x'),
    right: output(fromCoordinatesId, 'x'),
  })
  const dy = generatedCall(dyId, 'math.subtract', {
    left: output(toCoordinatesId, 'y'),
    right: output(fromCoordinatesId, 'y'),
  })
  const absDx = generatedCall(absDxId, 'math.abs', { value: output(dxId, 'value') })
  const absDy = generatedCall(absDyId, 'math.abs', { value: output(dyId, 'value') })
  const chebyshev = generatedCall(chebyshevId, 'math.max', {
    left: output(absDxId, 'value'),
    right: output(absDyId, 'value'),
  })
  const xZero = generatedCall(xZeroId, 'compare.values', { left: output(dxId, 'value'), right: literal(0) }, { valueType: 'number', operator: '==' })
  const yZero = generatedCall(yZeroId, 'compare.values', { left: output(dyId, 'value'), right: literal(0) }, { valueType: 'number', operator: '==' })
  // The old expression is (dx === 0) !== (dy === 0).  Comparing the two
  // boolean results keeps the XOR explicit and uses the normal infix logic
  // descriptor rather than introducing another spatial predicate.
  const orthogonal = callLike(call, 'compare.values', {
    left: output(xZeroId, 'value'),
    right: output(yZeroId, 'value'),
  }, { valueType: 'boolean', operator: '!=' })
  return {
    statements: [fromCoordinates, toCoordinates, dx, dy, absDx, absDy, chebyshev, xZero, yZero, orthogonal],
    outputs: {
      dx: output(dxId, 'value'),
      dy: output(dyId, 'value'),
      chebyshev: output(chebyshevId, 'value'),
      orthogonal: output(call.id, 'value'),
    },
  }
}

function firstAt(call: GameplayCallStatement, fresh: (suffix: string) => string, sourceName: string, outputPort: string): AtomicReplacement | undefined {
  const items = requiredInput(call, sourceName)
  if (!items) return undefined
  const at: GameplayStatement = {
    kind: 'collection', id: call.id, method: 'find', items, item: 'item',
    body: [{ kind: 'return', id: fresh('first-return'), value: literal(true) }],
  }
  return { statements: [at], outputs: { [outputPort]: output(call.id, 'value') } }
}

function pieceAt(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const items = requiredInput(call, 'items')
  const index = requiredInput(call, 'index')
  if (!items || !index) return undefined
  const compareId = fresh('index-equals')
  const at: GameplayStatement = {
    kind: 'collection', id: call.id, method: 'find', items, item: 'item', index: 'index',
    inputs: { requestedIndex: index },
    body: [
      generatedCall(compareId, 'compare.values', { left: input('index'), right: input('requestedIndex') }, { valueType: 'number', operator: '==' }),
      { kind: 'return', id: fresh('index-return'), value: output(compareId, 'value') },
    ],
  }
  return { statements: [at], outputs: { piece: output(call.id, 'value') } }
}

/** Recipe consumed by `rewriteAtomicGraph` for generic value migrations. */
export const atomicValuesRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  if (call.module === 'logic.select' && call.version === '1') return { statements: [{ ...call, version: '2' }] }
  if (call.module === 'text.from-number') return { statements: [callLike(call, 'text.from-value', call.inputs ?? {}, { valueType: 'number' })] }
  const comparison = typedComparison(call)
  if (comparison) return comparison
  switch (call.module) {
    case 'list.count': return directLength(call, 'items', 'count')
    case 'list.count-pieces':
    case 'list.count-cells':
    case 'list.count-choices': return directLength(call, 'items', 'value')
    case 'collection.piece-count': return directLength(call, 'pieces', 'value')
    case 'list.join': return directJoin(call)
    case 'value.select-number':
    case 'logic.select-number': return directSelectNumber(call)
    case 'value.select-text': return directSelectText(call)
    case 'text.optional-fragment': return optionalFragment(call, fresh)
    case 'collection.contains-piece': return contains(call, fresh, 'piece')
    case 'collection.contains-string': return contains(call, fresh, 'string')
    case 'list.has-duplicate': return duplicate(call, fresh)
    case 'list.all-in':
    case 'collection.all-in-strings': return allIn(call, fresh)
    case 'value.present-string': return valuePresent(call, 'value', 'present', 'string')
    case 'value.present-cell': return valuePresent(call, 'value', 'present', 'cell')
    case 'piece.reference-present': return valuePresent(call, 'piece', 'value', 'piece')
    case 'source.is-present': return valuePresent(call, 'source', 'value', 'record')
    case 'card.piece-present': return valuePresent(call, 'value', 'present', 'piece')
    case 'card.string-present': return valuePresent(call, 'value', 'present', 'string')
    case 'spatial.cell-in-list': return cellInList(call, fresh)
    case 'spatial.cell-adjacent': return cellAdjacent(call, fresh)
    case 'spatial.cell-equal': return cellEqual(call, fresh)
    case 'spatial.cell-delta': return cellDelta(call, fresh)
    case 'list.first-piece': return firstAt(call, fresh, 'items', 'piece')
    case 'collection.first-cell': return firstAt(call, fresh, 'cells', 'cell')
    case 'collection.piece-at': return pieceAt(call, fresh)
    default: return undefined
  }
}

/** Backwards-compatible factory form for callers composing multiple recipes. */
export function createValueMigrationRecipe(): AtomicRecipe {
  return atomicValuesRecipe
}

/** Rewrite every graph scope, including branches, composites, and continuations. */
export function migrateValueModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicValuesRecipe)
}

export const migrateAtomicValueGraph = migrateValueModules

export { ATOMIC_VALUE_MODULES, ATOMIC_VALUE_MODULE_IDS } from './module-registry-generic-values'
