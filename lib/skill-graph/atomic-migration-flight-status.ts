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

/** Compatibility wrappers expanded into generic graph reads, records and bounded host writes. */
export const ATOMIC_FLIGHT_STATUS_MODULES = new Set([
  'tile.add-reservation',
  'tile.clear-flight-reservations',
  'effect.teleport-if-present',
  'status.remove-by-flight',
  'status.consume-counter',
  'status.refresh-temporary',
])
export const ATOMIC_FLIGHT_STATUS_MODULE_IDS = ATOMIC_FLIGHT_STATUS_MODULES

const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullableRecordListType: GameplayValueType = { kind: 'nullable', value: { kind: 'list', element: 'record' } }
const recordListType: GameplayValueType = { kind: 'list', element: 'record' }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
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

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, ...(parameters === undefined ? {} : { parameters }) }
}

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  valueType: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return generatedCall(id, 'compare.values', { left, right }, {
    valueType: valueTypeParameter(valueType), operator,
  })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.and', { left, right })
}

function readKey(id: string, record: GameplayValue, key: string, valueType: GameplayValueType): GameplayCallStatement {
  return generatedCall(id, 'data.read-key', { record }, {
    key,
    valueType: valueTypeParameter(valueType),
  })
}

function setField(
  id: string,
  record: GameplayValue,
  field: string,
  value: GameplayValue,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'record.set-field', { record, value }, {
    field, valueType: valueTypeParameter(valueType),
  })
}

function buildRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  fields: ReadonlyArray<readonly [string, GameplayValue, GameplayValueType]>,
  prefix: string,
): GameplayValue {
  const empty = fresh(prefix + '-empty')
  statements.push(generatedCall(empty, 'record.empty'))
  let record: GameplayValue = output(empty, 'record')
  for (const [field, value, type] of fields) {
    const next = fresh(prefix + '-' + field)
    statements.push(setField(next, record, field, value, type))
    record = output(next, 'record')
  }
  return record
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function filter(
  id: string,
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'filter', items, item: 'item',
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function foreach(id: string, items: GameplayValue, body: readonly GameplayStatement[]): GameplayStatement {
  return { kind: 'foreach', id, items, item: 'item', body }
}

function localCall(
  id: string,
  module: 'local.declare' | 'local.read' | 'local.write',
  inputs: Readonly<Record<string, GameplayValue>>,
): GameplayCallStatement {
  return generatedCall(id, module, inputs, { valueType: 'number' })
}

function booleanLocalCall(
  id: string,
  module: 'local.declare' | 'local.read' | 'local.write',
  inputs: Readonly<Record<string, GameplayValue>>,
): GameplayCallStatement {
  return generatedCall(id, module, inputs, { valueType: 'boolean' })
}

function replaceTileAdd(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cell = requiredInput(call, 'cell')
  const id = requiredInput(call, 'id')
  const flightId = requiredInput(call, 'flightId')
  const effectType = call.parameters?.effectType
  if (!cell || !id || !flightId || typeof effectType !== 'string') return undefined

  const statements: GameplayStatement[] = []
  const coordinates = fresh('reservation-coordinates')
  statements.push(generatedCall(coordinates, 'spatial.cell-coordinates', { cell }))
  const record = buildRecord(statements, fresh, [
    ['id', id, 'string'],
    ['type', literal(effectType), 'string'],
    ['x', output(coordinates, 'x'), 'number'],
    ['y', output(coordinates, 'y'), 'number'],
    ['flightId', flightId, 'string'],
  ], 'reservation-record')
  const records = fresh('reservation-records')
  statements.push(generatedCall(records, 'collection.singleton', { value: record }, { valueType: 'record' }))
  const commit = fresh('reservation-commit')
  statements.push(generatedCall(commit, 'tile.batch-records', { records: output(records, 'items') }))
  return { statements, outputs: { success: output(commit, 'success') } }
}

function replaceTileClear(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const flightId = requiredInput(call, 'flightId')
  const effectType = call.parameters?.effectType
  if (!flightId || typeof effectType !== 'string') return undefined

  const statements: GameplayStatement[] = []
  const extensions = fresh('extensions')
  const rawTiles = fresh('tile-effects-raw')
  const tiles = fresh('tile-effects')
  statements.push(
    generatedCall(extensions, 'battle.extensions'),
    readKey(rawTiles, output(extensions, 'record'), 'tileEffects', nullableRecordListType),
    generatedCall(tiles, 'value.coalesce', {
      value: output(rawTiles), defaultValue: literal([]),
    }, { valueType: valueTypeParameter(recordListType) }),
  )

  const matching = fresh('matching-flight-reservations')
  const body: GameplayStatement[] = []
  const typeField = fresh('tile-type')
  const flightField = fresh('tile-flight-id')
  const typeMatch = fresh('tile-type-match')
  const flightMatch = fresh('tile-flight-match')
  const both = fresh('tile-match')
  const keep = fresh('tile-keep')
  body.push(
    readKey(typeField, input('item'), 'type', nullableStringType),
    readKey(flightField, input('item'), 'flightId', nullableStringType),
    compare(typeMatch, output(typeField), literal(effectType), nullableStringType),
    compare(flightMatch, output(flightField), input('flightId'), nullableStringType),
    and(both, output(typeMatch), output(flightMatch)),
    generatedCall(keep, 'logic.not', { value: output(both) }),
    returnValue(fresh('tile-keep-return'), output(keep)),
  )
  statements.push(filter(matching, output(tiles), body, { flightId }))
  const commit = fresh('tile-effects-commit')
  statements.push(generatedCall(commit, 'tile.replace-effects', { effects: output(matching) }))
  return { statements, outputs: { success: output(commit, 'success') } }
}

function replaceTeleport(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const destination = requiredInput(call, 'destination')
  if (!piece || !destination) return undefined
  const required = fresh('teleport-piece')
  const moved = fresh('teleport')
  const statements: GameplayStatement[] = [
    generatedCall(required, 'piece.require', { piece }),
    generatedCall(moved, 'effect.teleport', {
      piece: output(required, 'piece'), destination,
    }, { kind: 'teleport' }),
  ]
  return { statements, outputs: { success: output(moved, 'success') } }
}

function statusIdMatch(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  status: GameplayValue,
  expected: GameplayValue,
  prefix: string,
): GameplayValue {
  const id = fresh(prefix + '-id')
  const definedMatch = fresh(prefix + '-defined-match')
  const idMatch = fresh(prefix + '-match')
  const result = fresh(prefix + '-result')
  statements.push(
    generatedCall(id, 'status.instance-field', { status }, { field: 'id' }),
    compare(definedMatch, output(id, 'defined'), literal(true), 'boolean'),
    compare(idMatch, output(id), expected, nullableStringType),
    and(result, output(definedMatch), output(idMatch)),
  )
  return output(result)
}

function replaceRemoveByFlight(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(call, 'target') ?? literal(null)
  const flightId = requiredInput(call, 'flightId')
  if (!flightId) return undefined

  const statements: GameplayStatement[] = []
  const requiredTarget = fresh('flight-target')
  const statuses = fresh('flight-statuses')
  statements.push(
    generatedCall(requiredTarget, 'piece.require', { piece: target }),
    generatedCall(statuses, 'status.instances', { piece: output(requiredTarget, 'piece') }),
  )

  const matching = fresh('flight-matching-statuses')
  const body: GameplayStatement[] = []
  const flightField = fresh('status-flight-id')
  const idField = fresh('status-flight-status-id')
  const definedMatch = fresh('status-flight-defined')
  const idDefined = fresh('status-flight-id-defined')
  const flightMatch = fresh('status-flight-match')
  const flightAndId = fresh('status-flight-match-with-id')
  const result = fresh('status-flight-match-result')
  body.push(
    generatedCall(flightField, 'status.instance-field', { status: input('item') }, { field: 'flightId' }),
    generatedCall(idField, 'status.instance-field', { status: input('item') }, { field: 'id' }),
    compare(definedMatch, output(flightField, 'defined'), literal(true), 'boolean'),
    compare(idDefined, output(idField, 'defined'), literal(true), 'boolean'),
    compare(flightMatch, output(flightField), input('flightId'), nullableStringType),
    and(flightAndId, output(definedMatch), output(idDefined)),
    and(result, output(flightAndId), output(flightMatch)),
    returnValue(fresh('status-flight-filter-return'), output(result)),
  )
  statements.push(filter(matching, output(statuses, 'statuses'), body, { flightId }))
  statements.push(foreach(fresh('remove-flight-statuses'), output(matching), [
    generatedCall(fresh('remove-flight-status'), 'status.remove-instance-lifecycle', { status: input('item') }),
  ]))

  // The legacy operation succeeds even when no status matches.  The status
  // collection's presence flag carries that result while still propagating a
  // missing/invalid target as an invalid graph dependency.
  return { statements, outputs: { success: output(statuses, 'present') } }
}

function replaceConsumeCounter(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const statusId = requiredInput(call, 'statusId')
  const field = call.parameters?.field
  const fallback = call.parameters?.fallback === undefined ? 1 : call.parameters.fallback
  if (!piece || !statusId || field !== 'remainingTurns' || typeof fallback !== 'number' || !Number.isFinite(fallback)) return undefined

  const statements: GameplayStatement[] = []
  const resultLocal = fresh('counter-result')
  statements.push(localCall(resultLocal, 'local.declare', {}))
  const statuses = fresh('counter-statuses')
  statements.push(generatedCall(statuses, 'status.instances', { piece }))
  const matching = fresh('counter-matching-statuses')
  const body: GameplayStatement[] = []
  const matches = statusIdMatch(body, fresh, input('item'), input('statusId'), 'counter-status')
  body.push(returnValue(fresh('counter-filter-return'), matches))
  statements.push(filter(matching, output(statuses, 'statuses'), body, { statusId }))
  const count = fresh('counter-matching-count')
  const selected = fresh('counter-selected-status')
  statements.push(
    generatedCall(count, 'collection.length', { items: output(matching) }),
    generatedCall(selected, 'collection.at', { items: output(matching), position: literal(1) }),
  )
  const present = fresh('counter-present')
  statements.push(generatedCall(present, 'compare.greater-than', { left: output(count), right: literal(0) }))

  const existing: GameplayStatement[] = []
  const current = fresh('counter-current')
  const rawCurrent = fresh('counter-raw-current')
  const next = fresh('counter-next')
  existing.push(
    generatedCall(rawCurrent, 'status.instance-field', { status: output(selected) }, { field: 'remainingTurns' }),
    generatedCall(current, 'value.coalesce', { value: output(rawCurrent), defaultValue: literal(fallback) }, { valueType: 'number' }),
    generatedCall(next, 'math.subtract', { left: output(current), right: literal(1) }),
    generatedCall(fresh('counter-write'), 'status.set-number-instance', { status: output(selected), value: output(next) }, { field: 'remainingTurns' }),
    localCall(fresh('counter-result-write'), 'local.write', { handle: output(resultLocal, 'handle'), value: output(next) }),
  )
  const missing: GameplayStatement[] = [
    localCall(fresh('counter-fallback-write'), 'local.write', { handle: output(resultLocal, 'handle'), value: literal(fallback) }),
  ]
  statements.push({ kind: 'if', id: fresh('counter-present-branch'), condition: output(present), then: existing, else: missing })
  const read = fresh('counter-result-read')
  statements.push(localCall(read, 'local.read', { handle: output(resultLocal, 'handle') }))
  return { statements, outputs: { value: output(read, 'value') } }
}

function numberParameter(call: GameplayCallStatement, name: string, fallback: number): number | undefined {
  const value = call.parameters?.[name]
  const selected = value === undefined ? fallback : value
  return typeof selected === 'number' && Number.isFinite(selected) ? selected : undefined
}

function replaceRefreshTemporary(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(call, 'target')
  const turn = requiredInput(call, 'turn')
  const statusType = call.parameters?.statusType
  const name = call.parameters?.name
  const idPrefix = call.parameters?.idPrefix
  const duration = numberParameter(call, 'duration', 1)
  const uses = numberParameter(call, 'uses', 1)
  const visible = call.parameters?.visible === undefined ? true : call.parameters.visible
  if (!target || !turn || typeof statusType !== 'string' || typeof name !== 'string' || typeof idPrefix !== 'string'
    || duration === undefined || uses === undefined || typeof visible !== 'boolean') return undefined

  const statements: GameplayStatement[] = []
  const resultLocal = fresh('temporary-result')
  statements.push(booleanLocalCall(resultLocal, 'local.declare', {}))
  const statuses = fresh('temporary-statuses')
  statements.push(generatedCall(statuses, 'status.instances', { piece: target }))
  const matching = fresh('temporary-matching-statuses')
  const body: GameplayStatement[] = []
  const typeField = fresh('temporary-status-type')
  const typeMatch = fresh('temporary-status-type-match')
  body.push(
    generatedCall(typeField, 'status.instance-field', { status: input('item') }, { field: 'type' }),
    compare(typeMatch, output(typeField), literal(statusType), nullableStringType),
    returnValue(fresh('temporary-filter-return'), output(typeMatch)),
  )
  statements.push(filter(matching, output(statuses, 'statuses'), body))
  const count = fresh('temporary-matching-count')
  const selected = fresh('temporary-selected-status')
  statements.push(
    generatedCall(count, 'collection.length', { items: output(matching) }),
    generatedCall(selected, 'collection.at', { items: output(matching), position: literal(1) }),
  )
  const present = fresh('temporary-present')
  statements.push(generatedCall(present, 'compare.greater-than', { left: output(count), right: literal(0) }))

  const existing: GameplayStatement[] = []
  const fieldNames: ReadonlyArray<readonly [string, GameplayValue]> = [
    ['grantedTurnNumber', turn],
    ['currentDuration', literal(duration)],
    ['currentUses', literal(uses)],
    ['remainingUses', literal(uses)],
    ['createdTurnNumber', turn],
  ]
  const successValues: GameplayValue[] = []
  for (const [fieldName, value] of fieldNames) {
    const set = fresh('temporary-set-' + fieldName)
    existing.push(generatedCall(set, 'status.set-number-instance', { status: output(selected), value }, { field: fieldName }))
    successValues.push(output(set, 'success'))
  }
  let existingResult = successValues[0]
  for (let index = 1; index < successValues.length; index += 1) {
    const combined = fresh('temporary-set-success-' + index)
    existing.push(and(combined, existingResult, successValues[index]))
    existingResult = output(combined)
  }
  existing.push(booleanLocalCall(fresh('temporary-existing-write'), 'local.write', {
    handle: output(resultLocal, 'handle'), value: existingResult,
  }))

  const targetId = fresh('temporary-target-id')
  const fullId = fresh('temporary-id')
  const newBranch: GameplayStatement[] = [
    generatedCall(targetId, 'piece.identifier', { piece: target }),
    generatedCall(fullId, 'text.concat', { left: literal(idPrefix), right: output(targetId, 'id') }),
  ]
  const record = buildRecord(newBranch, fresh, [
    ['id', output(fullId, 'text'), 'string'],
    ['type', literal(statusType), 'string'],
    ['name', literal(name), 'string'],
    ['visible', literal(visible), 'boolean'],
    ['grantedTurnNumber', turn, 'number'],
    ['currentDuration', literal(duration), 'number'],
    ['currentUses', literal(uses), 'number'],
    ['remainingUses', literal(uses), 'number'],
    ['createdTurnNumber', turn, 'number'],
  ], 'temporary-new-status')
  const appended = fresh('temporary-append')
  newBranch.push(generatedCall(appended, 'status.append-record', { target, record }))
  newBranch.push(booleanLocalCall(fresh('temporary-new-write'), 'local.write', {
    handle: output(resultLocal, 'handle'), value: output(appended, 'success'),
  }))

  statements.push({ kind: 'if', id: fresh('temporary-present-branch'), condition: output(present), then: existing, else: newBranch })
  const read = fresh('temporary-result-read')
  statements.push(booleanLocalCall(read, 'local.read', { handle: output(resultLocal, 'handle') }))
  return { statements, outputs: { success: output(read, 'value') } }
}

export const atomicFlightStatusRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  if (call.module === 'tile.add-reservation') return replaceTileAdd(call, fresh)
  if (call.module === 'tile.clear-flight-reservations') return replaceTileClear(call, fresh)
  if (call.module === 'effect.teleport-if-present') return replaceTeleport(call, fresh)
  if (call.module === 'status.remove-by-flight') return replaceRemoveByFlight(call, fresh)
  if (call.module === 'status.consume-counter') return replaceConsumeCounter(call, fresh)
  if (call.module === 'status.refresh-temporary') return replaceRefreshTemporary(call, fresh)
  return undefined
}

export function migrateFlightStatusModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicFlightStatusRecipe)
}

export const migrateAtomicFlightStatusGraph = migrateFlightStatusModules
