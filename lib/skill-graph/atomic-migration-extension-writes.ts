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
 * Compatibility writes for the remaining closed extension adapters.  The
 * generated graphs use the ordinary root extension API, so legacy helpers do
 * not remain a second source of battle state after migration.
 */
export const ATOMIC_EXTENSION_WRITE_MODULES = new Set([
  'projectile.zone-set',
  'extension.store-piece',
  'extension.append-cell-records',
  'extension.append-cell-records-ordered',
  'extension.remove-cell-records',
  'tile.remove-source-records',
  'tile.append-dedup-markers',
  'tile.batch-effect-markers',
  'followup.counter.increment-player',
  'state.read-piece-number',
  'state.write-piece-number',
  'state.read-player-number',
  'state.write-player-number',
])

const recordType: GameplayValueType = 'record'
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: 'number' }
const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: 'player' }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: recordType }
const nullableRecordListType: GameplayValueType = { kind: 'nullable', value: recordListType }
const nullableCellType: GameplayValueType = { kind: 'nullable', value: 'cell' }

const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const nullable = (value: string): string => JSON.stringify({ kind: 'nullable', value })
const typeParameter = (type: GameplayValueType): GameplayLiteral => typeof type === 'string' ? type : JSON.stringify(type)

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayLiteral>>,
  version = '1',
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

function setField(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  field: string,
  value: GameplayValue,
  valueType: GameplayLiteral,
  prefix: string,
): GameplayValue {
  const id = fresh(prefix + '-' + field)
  statements.push(call(id, 'record.set-field', { record, value }, { field, valueType }))
  return out(id, 'record')
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function filterCollection(
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

function mapCollection(
  id: string,
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'map', items, item: 'item',
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function findCollection(
  id: string,
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
  item = 'item',
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'find', items, item,
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function reduceCollection(
  id: string,
  items: GameplayValue,
  initial: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'reduce', items, item: 'item', accumulator: 'accumulator', initial,
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function readKey(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  key: string,
  valueType: GameplayValueType,
  prefix: string,
): GameplayValue {
  const id = fresh(prefix + '-' + key)
  statements.push(call(id, 'data.read-key', { record }, {
    key, valueType: typeParameter(valueType),
  }))
  return out(id)
}

function readDynamicKey(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  key: GameplayValue,
  valueType: GameplayValueType,
  prefix: string,
): GameplayValue {
  const id = fresh(prefix + '-key')
  statements.push(call(id, 'data.read-key', { record, key }, {
    valueType: typeParameter(valueType),
  }))
  return out(id)
}

/** Read the engine-owned tileEffects array without materialising it. */
function readTileEffects(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  prefix: string,
): { raw: GameplayValue; items: GameplayValue } {
  const extensions = fresh(prefix + '-extensions')
  statements.push(call(extensions, 'battle.extensions'))
  const raw = readKey(
    statements, fresh, out(extensions, 'record'), 'tileEffects', nullableRecordListType, prefix,
  )
  const normalized = fresh(prefix + '-normalized')
  statements.push(call(normalized, 'value.coalesce', {
    value: raw, defaultValue: literal([]),
  }, { valueType: typeParameter(recordListType) }))
  return { raw, items: out(normalized) }
}

/** Build a predicate that checks one record's coordinates against any selected cell. */
function matchesAnyCell(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  selected: GameplayValue,
  x: GameplayValue,
  y: GameplayValue,
  prefix: string,
): GameplayValue {
  const body: GameplayStatement[] = []
  const coordinates = cellCoordinates(body, fresh, { kind: 'input', name: 'candidateCell' }, prefix + '-candidate')
  const xMatch = fresh(prefix + '-x-match')
  const yMatch = fresh(prefix + '-y-match')
  const match = fresh(prefix + '-match')
  body.push(
    call(xMatch, 'compare.values', { left: coordinates.x, right: { kind: 'input', name: 'x' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
    call(yMatch, 'compare.values', { left: coordinates.y, right: { kind: 'input', name: 'y' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
    call(match, 'logic.and', { left: out(xMatch), right: out(yMatch) }),
    returnValue(fresh(prefix + '-return'), out(match)),
  )
  const found = fresh(prefix + '-found')
  statements.push(findCollection(found, selected, body, { x, y }, 'candidateCell'))
  const present = fresh(prefix + '-present')
  statements.push(call(present, 'compare.values', {
    left: out(found), right: literal(null),
  }, { valueType: typeParameter(nullableCellType), operator: '!=' }))
  return out(present)
}

function buildTileEffect(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  x: GameplayValue,
  y: GameplayValue,
  sourceId: GameplayValue,
  tileType: GameplayValue,
  icon: GameplayValue,
  iconPosition: GameplayValue,
  presentation: GameplayValue | undefined,
  presentationStep: GameplayValue | undefined,
  prefix: string,
): GameplayValue {
  const empty = fresh(prefix + '-empty')
  statements.push(call(empty, 'record.empty'))
  let record = out(empty, 'record')
  record = setField(statements, fresh, record, 'x', x, 'number', prefix)
  record = setField(statements, fresh, record, 'y', y, 'number', prefix)
  record = setField(statements, fresh, record, 'sourceId', sourceId, 'string', prefix)
  record = setField(statements, fresh, record, 'tileType', tileType, 'string', prefix)
  record = setField(statements, fresh, record, 'icon', icon, 'string', prefix)
  record = setField(statements, fresh, record, 'iconPosition', iconPosition, 'string', prefix)
  if (presentation) record = setField(statements, fresh, record, 'presentation', presentation, 'string', prefix)
  if (presentationStep) record = setField(statements, fresh, record, 'presentationStep', presentationStep, 'number', prefix)
  return record
}

function declareBattleRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  name: string,
  prefix: string,
): GameplayValue {
  const empty = fresh(prefix + '-empty')
  statements.push(call(empty, 'record.empty'))
  const declared = fresh(prefix + '-declared')
  statements.push(call(declared, 'extension.declare-battle', { value: out(empty, 'record') }, {
    namespace: '', name, valueType: 'record',
  }, '3'))
  return out(declared, 'value')
}

const MUZAN_COUNTER_NAMESPACE = 'muzan-flesh-regeneration'
const MUZAN_COUNTER_NAMES = new Set(['lastDamageTurn', 'lastCheckTurn', 'successfulHeals'])
const PLAYER_COUNTER_PATHS = new Set(['contentCounters', 'contentCounters.elPrimoChargeDiscount'])

function pieceCounterParameters(callNode: GameplayCallStatement): { namespace: string; name: string } | undefined {
  const namespace = callNode.parameters?.namespace
  const name = callNode.parameters?.name
  if (namespace !== MUZAN_COUNTER_NAMESPACE || typeof name !== 'string' || !MUZAN_COUNTER_NAMES.has(name)) return undefined
  return { namespace, name }
}

function playerCounterPath(callNode: GameplayCallStatement): string | undefined {
  const path = callNode.parameters?.path
  return typeof path === 'string' && PLAYER_COUNTER_PATHS.has(path) ? path : undefined
}

function playerCounterKey(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  player: GameplayValue,
  prefix: string,
): GameplayValue {
  const id = fresh(prefix + '-key')
  statements.push(call(id, 'text.from-value', { value: player }, { valueType: 'player' }))
  return out(id, 'text')
}

function migrateReadPieceNumber(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = callNode.inputs?.piece
  const fallback = callNode.inputs?.fallback
  const parameters = pieceCounterParameters(callNode)
  if (!piece || !fallback || !parameters) return undefined

  const statements: GameplayStatement[] = []
  const raw = fresh('state-piece-optional-read')
  statements.push(call(raw, 'extension.read-optional-piece', { owner: piece }, {
    namespace: parameters.namespace, name: parameters.name, path: '', valueType: 'number',
  }))
  statements.push(call(callNode.id, 'value.coalesce', { value: out(raw), defaultValue: fallback }, { valueType: 'number' }))
  return { statements, outputs: { value: out(callNode.id) } }
}

function migrateWritePieceNumber(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = callNode.inputs?.piece
  const value = callNode.inputs?.value
  const parameters = pieceCounterParameters(callNode)
  if (!piece || !value || !parameters) return undefined

  const statements: GameplayStatement[] = []
  const declared = fresh('state-piece-declared')
  statements.push(call(declared, 'extension.declare-piece', { owner: piece, value }, {
    namespace: parameters.namespace, name: parameters.name, valueType: 'number',
  }))
  statements.push(call(callNode.id, 'extension.write-piece', { owner: piece, value }, {
    namespace: parameters.namespace, name: parameters.name, valueType: 'number',
  }))
  // The legacy state setter only exposes a success boolean.  The generic
  // extension writer returns the written value, so preserve the old port
  // explicitly after the authoritative write has completed.
  return { statements, outputs: { success: literal(true) } }
}

function migrateReadPlayerNumber(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = callNode.inputs?.player
  const fallback = callNode.inputs?.fallback
  const path = playerCounterPath(callNode)
  if (!player || !fallback || !path) return undefined

  const statements: GameplayStatement[] = []
  const rootRead = fresh('state-player-optional-read')
  statements.push(call(rootRead, 'extension.read-optional-battle', {}, {
    namespace: '', name: 'contentCounters', path: '', valueType: 'record',
  }, '2'))
  const root = out(rootRead)
  const key = playerCounterKey(statements, fresh, player, 'state-player')
  const raw = path === 'contentCounters'
    ? readDynamicKey(statements, fresh, root, key, nullableNumberType, 'state-player-direct')
    : (() => {
      const nested = readKey(statements, fresh, root, 'elPrimoChargeDiscount', nullableRecordType, 'state-player-nested')
      return readDynamicKey(statements, fresh, nested, key, nullableNumberType, 'state-player-nested')
    })()
  statements.push(call(callNode.id, 'value.coalesce', { value: raw, defaultValue: fallback }, { valueType: 'number' }))
  return { statements, outputs: { value: out(callNode.id) } }
}

function migrateWritePlayerNumber(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = callNode.inputs?.player
  const value = callNode.inputs?.value
  const path = playerCounterPath(callNode)
  if (!player || !value || !path) return undefined

  const statements: GameplayStatement[] = []
  const root = declareBattleRecord(statements, fresh, 'contentCounters', 'state-player')
  const key = playerCounterKey(statements, fresh, player, 'state-player')
  let updatedRoot: GameplayValue
  if (path === 'contentCounters') {
    const updated = fresh('state-player-direct-updated')
    statements.push(call(updated, 'record.set-key', {
      record: root, key, value,
    }, { valueType: 'number' }))
    updatedRoot = out(updated, 'record')
  } else {
    const nested = readKey(statements, fresh, root, 'elPrimoChargeDiscount', nullableRecordType, 'state-player-nested')
    const emptyNested = fresh('state-player-nested-empty')
    statements.push(call(emptyNested, 'record.empty'))
    const existingNested = fresh('state-player-nested-existing')
    statements.push(call(existingNested, 'value.coalesce', {
      value: nested, defaultValue: out(emptyNested, 'record'),
    }, { valueType: 'record' }))
    const updatedNested = fresh('state-player-nested-updated')
    statements.push(call(updatedNested, 'record.set-key', {
      record: out(existingNested), key, value,
    }, { valueType: 'number' }))
    const updated = fresh('state-player-root-updated')
    statements.push(call(updated, 'record.set-key', {
      record: root, key: literal('elPrimoChargeDiscount'), value: out(updatedNested, 'record'),
    }, { valueType: 'record' }))
    updatedRoot = out(updated, 'record')
  }
  statements.push(call(callNode.id, 'extension.write-battle', { value: updatedRoot }, {
    namespace: '', name: 'contentCounters', valueType: 'record',
  }, '3'))
  return { statements, outputs: { success: out(callNode.id, 'success') } }
}

function cellCoordinates(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  cell: GameplayValue,
  prefix: string,
): { x: GameplayValue; y: GameplayValue } {
  const id = fresh(prefix + '-coordinates')
  statements.push(call(id, 'spatial.cell-coordinates', { cell }))
  return { x: out(id, 'x'), y: out(id, 'y') }
}

function buildCellRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  sourceId: GameplayValue,
  owner: GameplayValue,
  cell: GameplayValue,
  prefix: string,
): GameplayValue {
  const coordinates = cellCoordinates(statements, fresh, cell, prefix)
  const empty = fresh(prefix + '-empty')
  statements.push(call(empty, 'record.empty'))
  let record = out(empty, 'record')
  record = setField(statements, fresh, record, 'x', coordinates.x, 'number', prefix)
  record = setField(statements, fresh, record, 'y', coordinates.y, 'number', prefix)
  record = setField(statements, fresh, record, 'sourcePieceId', sourceId, 'string', prefix)
  record = setField(statements, fresh, record, 'ownerPlayerId', owner, typeParameter(nullablePlayerType), prefix)
  const ownerPresent = fresh(prefix + '-owner-present')
  statements.push(call(ownerPresent, 'compare.values', { left: owner, right: literal(null) }, {
    valueType: typeParameter(nullablePlayerType), operator: '!=',
  }))
  const withoutOwner = fresh(prefix + '-without-owner')
  statements.push(call(withoutOwner, 'data.omit-key', { record, key: literal('ownerPlayerId') }))
  const selected = fresh(prefix + '-selected')
  statements.push(call(selected, 'logic.select', {
    condition: out(ownerPresent), whenTrue: record, whenFalse: out(withoutOwner),
  }, { valueType: typeParameter(recordType) }, '2'))
  return out(selected)
}

function sourceFacts(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  source: GameplayValue,
): { sourceId: GameplayValue; owner: GameplayValue } {
  const sourceId = fresh('cell-source-id')
  const owner = fresh('cell-source-owner')
  statements.push(
    call(sourceId, 'piece.identifier', { piece: source }),
    call(owner, 'piece.field', { piece: source }, { field: 'ownerPlayerId' }, '2'),
  )
  return { sourceId: out(sourceId, 'id'), owner: out(owner) }
}

function buildZoneRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  sourceId: GameplayValue,
  dx: GameplayValue,
  dy: GameplayValue,
  kind: GameplayValue,
  turns: GameplayValue,
): GameplayValue {
  const empty = fresh('zone-record-empty')
  statements.push(call(empty, 'record.empty'))
  let record = out(empty, 'record')
  record = setField(statements, fresh, record, 'sourceId', sourceId, 'string', 'zone-record')
  record = setField(statements, fresh, record, 'kind', kind, 'string', 'zone-record')
  record = setField(statements, fresh, record, 'dx', dx, 'number', 'zone-record')
  record = setField(statements, fresh, record, 'dy', dy, 'number', 'zone-record')
  record = setField(statements, fresh, record, 'turns', turns, 'number', 'zone-record')
  return record
}

function migrateProjectileZoneSet(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = callNode.inputs?.source
  const dx = callNode.inputs?.dx
  const dy = callNode.inputs?.dy
  const storageKey = callNode.parameters?.storageKey
  if (!source || !dx || !dy || (storageKey !== undefined && storageKey !== 'coltZones')) return undefined

  const statements: GameplayStatement[] = []
  const sourceId = fresh('zone-source-id')
  statements.push(call(sourceId, 'piece.field', { piece: source }, { field: 'instanceId' }, '2'))

  const dxFinite = fresh('zone-dx-finite')
  const dyFinite = fresh('zone-dy-finite')
  const dxFloor = fresh('zone-dx-floor')
  const dyFloor = fresh('zone-dy-floor')
  const dxInteger = fresh('zone-dx-integer')
  const dyInteger = fresh('zone-dy-integer')
  const absDx = fresh('zone-abs-dx')
  const absDy = fresh('zone-abs-dy')
  const distance = fresh('zone-distance')
  const unit = fresh('zone-unit')
  const validDx = fresh('zone-valid-dx')
  const validDy = fresh('zone-valid-dy')
  const validCoordinates = fresh('zone-valid-coordinates')
  const valid = fresh('zone-valid')
  statements.push(
    call(dxFinite, 'value.is-finite', { value: dx }),
    call(dyFinite, 'value.is-finite', { value: dy }),
    call(dxFloor, 'math.floor', { value: dx }),
    call(dyFloor, 'math.floor', { value: dy }),
    call(dxInteger, 'compare.values', { left: dx, right: out(dxFloor) }, { valueType: 'number', operator: '==' }),
    call(dyInteger, 'compare.values', { left: dy, right: out(dyFloor) }, { valueType: 'number', operator: '==' }),
    call(absDx, 'math.abs', { value: dx }),
    call(absDy, 'math.abs', { value: dy }),
    call(distance, 'math.add', { left: out(absDx), right: out(absDy) }),
    call(unit, 'compare.values', { left: out(distance), right: literal(1) }, { valueType: 'number', operator: '==' }),
    call(validDx, 'logic.and', { left: out(dxFinite), right: out(dxInteger) }),
    call(validDy, 'logic.and', { left: out(dyFinite), right: out(dyInteger) }),
    call(validCoordinates, 'logic.and', { left: out(validDx), right: out(validDy) }),
    call(valid, 'logic.and', { left: out(validCoordinates), right: out(unit) }),
  )

  const resultHandle = fresh('zone-result')
  statements.push(call(resultHandle, 'local.declare', {}, { valueType: 'boolean' }))
  const thenBranch: GameplayStatement[] = []
  const emptyRoot = fresh('zone-empty-root')
  thenBranch.push(call(emptyRoot, 'record.empty'))
  const declared = fresh('zone-declared')
  thenBranch.push(call(declared, 'extension.declare-battle', { value: out(emptyRoot, 'record') }, {
    namespace: '', name: String(storageKey ?? 'coltZones'), valueType: 'record',
  }, '3'))
  const record = buildZoneRecord(thenBranch, fresh, out(sourceId), dx, dy,
    literal(typeof callNode.parameters?.kind === 'string' ? callNode.parameters.kind : 'revolver'),
    literal(typeof callNode.parameters?.turns === 'number' ? callNode.parameters.turns : 2))
  const updated = fresh('zone-updated')
  thenBranch.push(call(updated, 'record.set-key', {
    record: out(declared, 'value'), key: out(sourceId), value: record,
  }, { valueType: 'record' }))
  const written = fresh('zone-written')
  thenBranch.push(call(written, 'extension.write-battle', { value: out(updated, 'record') }, {
    namespace: '', name: String(storageKey ?? 'coltZones'), valueType: 'record',
  }, '3'))
  thenBranch.push(call(fresh('zone-result-write'), 'local.write', {
    handle: out(resultHandle, 'handle'), value: out(written, 'success'),
  }, { valueType: 'boolean' }))
  statements.push({ kind: 'if', id: fresh('zone-valid-if'), condition: out(valid), then: thenBranch, else: [
    call(fresh('zone-invalid-write'), 'local.write', {
      handle: out(resultHandle, 'handle'), value: literal(false),
    }, { valueType: 'boolean' }),
  ]})
  const result = fresh('zone-result-read')
  statements.push(call(result, 'local.read', { handle: out(resultHandle, 'handle') }, { valueType: 'boolean' }))
  return { statements, outputs: { success: out(result, 'value') } }
}

function extensionListDeclaration(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  name: string,
): GameplayValue {
  const declared = fresh(name + '-declared')
  statements.push(call(declared, 'extension.declare-battle', { value: literal([]) }, {
    namespace: '', name, valueType: typeParameter(recordListType),
  }, '3'))
  return out(declared, 'value')
}

function appendCellRecords(
  callNode: GameplayCallStatement,
  fresh: (suffix: string) => string,
  ordered: boolean,
): AtomicReplacement | undefined {
  const source = callNode.inputs?.source
  const cells = callNode.inputs?.cells
  if (!source || !cells) return undefined
  const key = ordered ? callNode.parameters?.key : callNode.parameters?.storageKey
  const expectedKey = ordered ? 'shishioBurnTiles' : 'amaterasuCells'
  if (key !== undefined && key !== expectedKey) return undefined

  const storageKey = expectedKey
  const statements: GameplayStatement[] = []
  const facts = sourceFacts(statements, fresh, source)
  const existing = extensionListDeclaration(statements, fresh, storageKey)

  const validCells = fresh('cell-records-valid-cells')
  const validBody: GameplayStatement[] = []
  const coordinates = cellCoordinates(validBody, fresh, { kind: 'input', name: 'item' }, 'cell-records-valid')
  const xFinite = fresh('cell-records-x-finite')
  const yFinite = fresh('cell-records-y-finite')
  validBody.push(
    call(xFinite, 'value.is-finite', { value: coordinates.x }),
    call(yFinite, 'value.is-finite', { value: coordinates.y }),
  )
  let valid: GameplayValue = out(xFinite)
  const finite = fresh('cell-records-finite')
  validBody.push(call(finite, 'logic.and', { left: out(xFinite), right: out(yFinite) }))
  valid = out(finite)
  if (!ordered) {
    const xFloor = fresh('cell-records-x-floor')
    const yFloor = fresh('cell-records-y-floor')
    const xInteger = fresh('cell-records-x-integer')
    const yInteger = fresh('cell-records-y-integer')
    const integer = fresh('cell-records-integer')
    validBody.push(
      call(xFloor, 'math.floor', { value: coordinates.x }),
      call(yFloor, 'math.floor', { value: coordinates.y }),
      call(xInteger, 'compare.values', { left: coordinates.x, right: out(xFloor) }, { valueType: 'number', operator: '==' }),
      call(yInteger, 'compare.values', { left: coordinates.y, right: out(yFloor) }, { valueType: 'number', operator: '==' }),
      call(integer, 'logic.and', { left: out(xInteger), right: out(yInteger) }),
    )
    const validInteger = fresh('cell-records-valid-integer')
    validBody.push(call(validInteger, 'logic.and', { left: valid, right: out(integer) }))
    valid = out(validInteger)
  }
  validBody.push(returnValue(fresh('cell-records-valid-return'), valid))
  statements.push(filterCollection(validCells, cells, validBody))

  let nextRecords: GameplayValue
  if (ordered) {
    const recordBody: GameplayStatement[] = []
    const record = buildCellRecord(
      recordBody, fresh, { kind: 'input', name: 'sourceId' }, { kind: 'input', name: 'owner' },
      { kind: 'input', name: 'item' }, 'ordered-cell-record',
    )
    recordBody.push(returnValue(fresh('ordered-cell-record-return'), record))
    const mapped = fresh('ordered-cell-records')
    statements.push(mapCollection(mapped, out(validCells), recordBody, {
      sourceId: facts.sourceId, owner: facts.owner,
    }))
    nextRecords = out(mapped)
  } else {
    const reduced = fresh('deduped-cell-records')
    const reduceBody: GameplayStatement[] = []
    const coordinates = cellCoordinates(reduceBody, fresh, { kind: 'input', name: 'item' }, 'dedup-cell')
    const existingBody: GameplayStatement[] = []
    const existingX = readKey(existingBody, fresh, { kind: 'input', name: 'candidate' }, 'x', nullableNumberType, 'dedup-existing')
    const existingY = readKey(existingBody, fresh, { kind: 'input', name: 'candidate' }, 'y', nullableNumberType, 'dedup-existing')
    const existingXMatch = fresh('dedup-existing-x-match')
    const existingYMatch = fresh('dedup-existing-y-match')
    const existingMatch = fresh('dedup-existing-match')
    existingBody.push(
      call(existingXMatch, 'compare.values', { left: existingX, right: { kind: 'input', name: 'x' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
      call(existingYMatch, 'compare.values', { left: existingY, right: { kind: 'input', name: 'y' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
      call(existingMatch, 'logic.and', { left: out(existingXMatch), right: out(existingYMatch) }),
      returnValue(fresh('dedup-existing-return'), out(existingMatch)),
    )
    const existingMatchId = fresh('dedup-existing')
    reduceBody.push(findCollection(existingMatchId, { kind: 'input', name: 'existing' }, existingBody, {
      x: coordinates.x, y: coordinates.y,
    }, 'candidate'))
    const existingPresent = fresh('dedup-existing-present')
    reduceBody.push(call(existingPresent, 'compare.values', {
      left: out(existingMatchId), right: literal(null),
    }, { valueType: typeParameter(nullableRecordType), operator: '!=' }))

    const accumulatorBody: GameplayStatement[] = []
    const accumulatorX = readKey(accumulatorBody, fresh, { kind: 'input', name: 'candidate' }, 'x', nullableNumberType, 'dedup-accumulator')
    const accumulatorY = readKey(accumulatorBody, fresh, { kind: 'input', name: 'candidate' }, 'y', nullableNumberType, 'dedup-accumulator')
    const accumulatorXMatch = fresh('dedup-accumulator-x-match')
    const accumulatorYMatch = fresh('dedup-accumulator-y-match')
    const accumulatorMatch = fresh('dedup-accumulator-match')
    accumulatorBody.push(
      call(accumulatorXMatch, 'compare.values', { left: accumulatorX, right: { kind: 'input', name: 'x' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
      call(accumulatorYMatch, 'compare.values', { left: accumulatorY, right: { kind: 'input', name: 'y' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
      call(accumulatorMatch, 'logic.and', { left: out(accumulatorXMatch), right: out(accumulatorYMatch) }),
      returnValue(fresh('dedup-accumulator-return'), out(accumulatorMatch)),
    )
    const accumulatorMatchId = fresh('dedup-accumulator')
    reduceBody.push(findCollection(accumulatorMatchId, { kind: 'input', name: 'accumulator' }, accumulatorBody, {
      x: coordinates.x, y: coordinates.y,
    }, 'candidate'))
    const accumulatorPresent = fresh('dedup-accumulator-present')
    reduceBody.push(call(accumulatorPresent, 'compare.values', {
      left: out(accumulatorMatchId), right: literal(null),
    }, { valueType: typeParameter(nullableRecordType), operator: '!=' }))
    const duplicate = fresh('dedup-duplicate')
    reduceBody.push(call(duplicate, 'logic.or', { left: out(existingPresent), right: out(accumulatorPresent) }))

    const record = buildCellRecord(
      reduceBody, fresh, { kind: 'input', name: 'sourceId' }, { kind: 'input', name: 'owner' },
      { kind: 'input', name: 'item' }, 'dedup-cell-record',
    )
    const singleton = fresh('dedup-singleton')
    const appended = fresh('dedup-appended')
    const selected = fresh('dedup-selected')
    reduceBody.push(
      call(singleton, 'collection.singleton', { value: record }, { valueType: typeParameter(recordType) }),
      call(appended, 'collection.concat', {
        left: { kind: 'input', name: 'accumulator' }, right: out(singleton, 'items'),
      }, { valueType: typeParameter(recordListType) }),
      call(selected, 'logic.select', {
        condition: out(duplicate), whenTrue: { kind: 'input', name: 'accumulator' }, whenFalse: out(appended, 'items'),
      }, { valueType: typeParameter(recordListType) }, '2'),
      returnValue(fresh('dedup-cell-record-return'), out(selected)),
    )
    const emptyInitial = fresh('dedup-empty-initial')
    statements.push(call(emptyInitial, 'collection.concat', {
      left: literal([]), right: literal([]),
    }, { valueType: typeParameter(recordListType) }))
    statements.push(reduceCollection(reduced, out(validCells), out(emptyInitial, 'items'), reduceBody, {
      sourceId: facts.sourceId, owner: facts.owner, existing,
    }))
    nextRecords = out(reduced)
  }

  const appended = fresh('cell-records-appended')
  statements.push(call(appended, 'collection.concat', {
    left: existing, right: nextRecords,
  }, { valueType: typeParameter(recordListType) }))
  const written = fresh('cell-records-written')
  statements.push(call(written, 'extension.write-battle', { value: out(appended, 'items') }, {
    namespace: '', name: storageKey, valueType: typeParameter(recordListType),
  }, '3'))
  const added = fresh('cell-records-added')
  statements.push(call(added, 'collection.length', { items: nextRecords }))
  return { statements, outputs: { added: out(added) } }
}

function migrateTileRemoveSourceRecords(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const sourceId = callNode.inputs?.sourceId
  if (!sourceId) return undefined

  const statements: GameplayStatement[] = []
  const tileEffects = readTileEffects(statements, fresh, 'remove-source-effects')
  const keptBody: GameplayStatement[] = []
  const storedSource = readKey(keptBody, fresh, { kind: 'input', name: 'item' }, 'sourceId', nullableStringType, 'remove-source-item')
  const matches = fresh('remove-source-match')
  const keep = fresh('remove-source-keep')
  keptBody.push(
    call(matches, 'compare.values', { left: storedSource, right: { kind: 'input', name: 'sourceId' } }, {
      valueType: typeParameter(nullableStringType), operator: '==',
    }),
    call(keep, 'logic.not', { value: out(matches) }),
    returnValue(fresh('remove-source-return'), out(keep)),
  )
  const kept = fresh('remove-source-kept')
  statements.push(filterCollection(kept, tileEffects.items, keptBody, { sourceId }))

  // The legacy adapter returned false when tileEffects had never existed.
  // Keep that observable result while still ensuring the read itself never
  // creates the engine-owned array.
  const resultHandle = fresh('remove-source-result')
  statements.push(call(resultHandle, 'local.declare', {}, { valueType: 'boolean' }))
  const present = fresh('remove-source-present')
  statements.push(call(present, 'compare.values', {
    left: tileEffects.raw, right: literal(null),
  }, { valueType: typeParameter(nullableRecordListType), operator: '!=' }))
  const thenBranch: GameplayStatement[] = []
  const replaced = fresh('remove-source-replaced')
  thenBranch.push(
    call(replaced, 'tile.replace-effects', { effects: out(kept) }),
    call(fresh('remove-source-result-write'), 'local.write', {
      handle: out(resultHandle, 'handle'), value: out(replaced, 'success'),
    }, { valueType: 'boolean' }),
  )
  const elseBranch: GameplayStatement[] = [call(fresh('remove-source-absent'), 'local.write', {
    handle: out(resultHandle, 'handle'), value: literal(false),
  }, { valueType: 'boolean' })]
  statements.push({ kind: 'if', id: fresh('remove-source-if'), condition: out(present), then: thenBranch, else: elseBranch })
  const result = fresh('remove-source-result-read')
  statements.push(call(result, 'local.read', { handle: out(resultHandle, 'handle') }, { valueType: 'boolean' }))
  return { statements, outputs: { success: out(result, 'value') } }
}

function migrateTileAppendDedupMarkers(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cells = callNode.inputs?.cells
  const origin = callNode.inputs?.origin
  if (!cells || !origin
    || (callNode.parameters?.tileType !== undefined && callNode.parameters.tileType !== 'amaterasu')
    || (callNode.parameters?.icon !== undefined && callNode.parameters.icon !== '🌑')
    || (callNode.parameters?.iconPosition !== undefined && callNode.parameters.iconPosition !== 'bottom-right')
    || (callNode.parameters?.presentation !== undefined && callNode.parameters.presentation !== 'expand')
    || (callNode.parameters?.presentationBatch !== undefined && !['queue', 'direct'].includes(String(callNode.parameters.presentationBatch)))) return undefined

  const statements: GameplayStatement[] = []
  const tileEffects = readTileEffects(statements, fresh, 'append-dedup-effects')
  const originCoordinates = cellCoordinates(statements, fresh, origin, 'append-dedup-origin')
  const validBody: GameplayStatement[] = []
  const validCoordinates = cellCoordinates(validBody, fresh, { kind: 'input', name: 'item' }, 'append-dedup-valid')
  const xFinite = fresh('append-dedup-x-finite')
  const yFinite = fresh('append-dedup-y-finite')
  const xFloor = fresh('append-dedup-x-floor')
  const yFloor = fresh('append-dedup-y-floor')
  const xInteger = fresh('append-dedup-x-integer')
  const yInteger = fresh('append-dedup-y-integer')
  const finite = fresh('append-dedup-finite')
  const integer = fresh('append-dedup-integer')
  const valid = fresh('append-dedup-valid')
  validBody.push(
    call(xFinite, 'value.is-finite', { value: validCoordinates.x }),
    call(yFinite, 'value.is-finite', { value: validCoordinates.y }),
    call(xFloor, 'math.floor', { value: validCoordinates.x }),
    call(yFloor, 'math.floor', { value: validCoordinates.y }),
    call(xInteger, 'compare.values', { left: validCoordinates.x, right: out(xFloor) }, { valueType: 'number', operator: '==' }),
    call(yInteger, 'compare.values', { left: validCoordinates.y, right: out(yFloor) }, { valueType: 'number', operator: '==' }),
    call(finite, 'logic.and', { left: out(xFinite), right: out(yFinite) }),
    call(integer, 'logic.and', { left: out(xInteger), right: out(yInteger) }),
    call(valid, 'logic.and', { left: out(finite), right: out(integer) }),
    returnValue(fresh('append-dedup-valid-return'), out(valid)),
  )
  const validCells = fresh('append-dedup-valid-cells')
  statements.push(filterCollection(validCells, cells, validBody))

  const reduced = fresh('append-dedup-reduced')
  const reduceBody: GameplayStatement[] = []
  const coordinates = cellCoordinates(reduceBody, fresh, { kind: 'input', name: 'item' }, 'append-dedup-cell')
  const existingBody: GameplayStatement[] = []
  const existingX = readKey(existingBody, fresh, { kind: 'input', name: 'candidate' }, 'x', nullableNumberType, 'append-dedup-existing')
  const existingY = readKey(existingBody, fresh, { kind: 'input', name: 'candidate' }, 'y', nullableNumberType, 'append-dedup-existing')
  const existingType = readKey(existingBody, fresh, { kind: 'input', name: 'candidate' }, 'tileType', nullableStringType, 'append-dedup-existing')
  const existingXMatch = fresh('append-dedup-existing-x-match')
  const existingYMatch = fresh('append-dedup-existing-y-match')
  const existingTypeMatch = fresh('append-dedup-existing-type-match')
  const existingCoordinatesMatch = fresh('append-dedup-existing-coordinates-match')
  const existingMatch = fresh('append-dedup-existing-match')
  existingBody.push(
    call(existingXMatch, 'compare.values', { left: existingX, right: { kind: 'input', name: 'x' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
    call(existingYMatch, 'compare.values', { left: existingY, right: { kind: 'input', name: 'y' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
    call(existingTypeMatch, 'compare.values', { left: existingType, right: literal('amaterasu') }, { valueType: typeParameter(nullableStringType), operator: '==' }),
    call(existingCoordinatesMatch, 'logic.and', { left: out(existingXMatch), right: out(existingYMatch) }),
    call(existingMatch, 'logic.and', { left: out(existingCoordinatesMatch), right: out(existingTypeMatch) }),
    returnValue(fresh('append-dedup-existing-return'), out(existingMatch)),
  )
  const existingMatchId = fresh('append-dedup-existing')
  reduceBody.push(findCollection(existingMatchId, { kind: 'input', name: 'existing' }, existingBody, {
    x: coordinates.x, y: coordinates.y,
  }, 'candidate'))
  const existingPresent = fresh('append-dedup-existing-present')
  reduceBody.push(call(existingPresent, 'compare.values', {
    left: out(existingMatchId), right: literal(null),
  }, { valueType: typeParameter(nullableRecordType), operator: '!=' }))

  const accumulatorBody: GameplayStatement[] = []
  const accumulatorX = readKey(accumulatorBody, fresh, { kind: 'input', name: 'candidate' }, 'x', nullableNumberType, 'append-dedup-accumulator')
  const accumulatorY = readKey(accumulatorBody, fresh, { kind: 'input', name: 'candidate' }, 'y', nullableNumberType, 'append-dedup-accumulator')
  const accumulatorXMatch = fresh('append-dedup-accumulator-x-match')
  const accumulatorYMatch = fresh('append-dedup-accumulator-y-match')
  const accumulatorMatch = fresh('append-dedup-accumulator-match')
  accumulatorBody.push(
    call(accumulatorXMatch, 'compare.values', { left: accumulatorX, right: { kind: 'input', name: 'x' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
    call(accumulatorYMatch, 'compare.values', { left: accumulatorY, right: { kind: 'input', name: 'y' } }, { valueType: typeParameter(nullableNumberType), operator: '==' }),
    call(accumulatorMatch, 'logic.and', { left: out(accumulatorXMatch), right: out(accumulatorYMatch) }),
    returnValue(fresh('append-dedup-accumulator-return'), out(accumulatorMatch)),
  )
  const accumulatorMatchId = fresh('append-dedup-accumulator')
  reduceBody.push(findCollection(accumulatorMatchId, { kind: 'input', name: 'accumulator' }, accumulatorBody, {
    x: coordinates.x, y: coordinates.y,
  }, 'candidate'))
  const accumulatorPresent = fresh('append-dedup-accumulator-present')
  reduceBody.push(call(accumulatorPresent, 'compare.values', {
    left: out(accumulatorMatchId), right: literal(null),
  }, { valueType: typeParameter(nullableRecordType), operator: '!=' }))
  const duplicate = fresh('append-dedup-duplicate')
  reduceBody.push(call(duplicate, 'logic.or', { left: out(existingPresent), right: out(accumulatorPresent) }))

  const dx = fresh('append-dedup-dx')
  const dy = fresh('append-dedup-dy')
  const absDx = fresh('append-dedup-abs-dx')
  const absDy = fresh('append-dedup-abs-dy')
  const step = fresh('append-dedup-step')
  reduceBody.push(
    call(dx, 'math.subtract', { left: coordinates.x, right: { kind: 'input', name: 'originX' } }),
    call(dy, 'math.subtract', { left: coordinates.y, right: { kind: 'input', name: 'originY' } }),
    call(absDx, 'math.abs', { value: out(dx) }),
    call(absDy, 'math.abs', { value: out(dy) }),
    call(step, 'math.max', { left: out(absDx), right: out(absDy) }),
  )
  const effect = buildTileEffect(
    reduceBody, fresh, coordinates.x, coordinates.y, literal('amaterasu'), literal('amaterasu'), literal('🌑'), literal('bottom-right'),
    literal('expand'), out(step), 'append-dedup-effect',
  )
  const singleton = fresh('append-dedup-singleton')
  const appended = fresh('append-dedup-appended')
  const selected = fresh('append-dedup-selected')
  reduceBody.push(
    call(singleton, 'collection.singleton', { value: effect }, { valueType: typeParameter(recordType) }),
    call(appended, 'collection.concat', {
      left: { kind: 'input', name: 'accumulator' }, right: out(singleton, 'items'),
    }, { valueType: typeParameter(recordListType) }),
    call(selected, 'logic.select', {
      condition: out(duplicate), whenTrue: { kind: 'input', name: 'accumulator' }, whenFalse: out(appended, 'items'),
    }, { valueType: typeParameter(recordListType) }, '2'),
    returnValue(fresh('append-dedup-return'), out(selected)),
  )
  const emptyInitial = fresh('append-dedup-empty-initial')
  statements.push(call(emptyInitial, 'collection.concat', { left: literal([]), right: literal([]) }, {
    valueType: typeParameter(recordListType),
  }))
  statements.push(reduceCollection(reduced, out(validCells), out(emptyInitial, 'items'), reduceBody, {
    existing: tileEffects.items, originX: originCoordinates.x, originY: originCoordinates.y,
  }))
  const submitted = fresh('append-dedup-submit')
  statements.push(call(submitted, 'tile.batch-records', { records: out(reduced) }, { presentationBatch: callNode.parameters?.presentationBatch === 'direct' ? 'direct' : 'queue' }, '2'))
  const added = fresh('append-dedup-added')
  statements.push(call(added, 'collection.length', { items: out(reduced) }))
  return { statements, outputs: { added: out(added) } }
}

function migrateTileBatchEffectMarkers(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cells = callNode.inputs?.cells
  if (!cells
    || callNode.parameters?.sourceId !== 'shishio-burn'
    || callNode.parameters?.tileType !== 'shishio-burn'
    || callNode.parameters?.icon !== '♨️'
    || callNode.parameters?.iconPosition !== 'bottom-right') return undefined

  const statements: GameplayStatement[] = []
  const mapBody: GameplayStatement[] = []
  const coordinates = cellCoordinates(mapBody, fresh, { kind: 'input', name: 'item' }, 'batch-effect-cell')
  const effect = buildTileEffect(
    mapBody, fresh, coordinates.x, coordinates.y, literal('shishio-burn'), literal('shishio-burn'), literal('♨️'), literal('bottom-right'),
    literal('simultaneous'), literal(0), 'batch-effect',
  )
  mapBody.push(returnValue(fresh('batch-effect-return'), effect))
  const effects = fresh('batch-effect-effects')
  statements.push(mapCollection(effects, cells, mapBody))
  const submitted = fresh('batch-effect-submit')
  statements.push(call(submitted, 'tile.batch-records', { records: out(effects) }))
  const count = fresh('batch-effect-count')
  statements.push(call(count, 'collection.length', { items: out(effects) }))
  return { statements, outputs: { count: out(count) } }
}

function migrateExtensionRemoveCellRecords(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cells = callNode.inputs?.cells
  if (!cells
    || (callNode.parameters?.storageKey !== undefined && callNode.parameters.storageKey !== 'amaterasuCells')
    || (callNode.parameters?.tileType !== undefined && callNode.parameters.tileType !== 'amaterasu')
    || (callNode.parameters?.presentationBatch !== undefined && !['queue', 'direct'].includes(String(callNode.parameters.presentationBatch)))) return undefined

  const statements: GameplayStatement[] = []
  const anchors = extensionListDeclaration(statements, fresh, 'amaterasuCells')
  const tileEffects = readTileEffects(statements, fresh, 'remove-cell-effects')

  const keptAnchorBody: GameplayStatement[] = []
  const anchorX = readKey(keptAnchorBody, fresh, { kind: 'input', name: 'item' }, 'x', nullableNumberType, 'remove-cell-anchor')
  const anchorY = readKey(keptAnchorBody, fresh, { kind: 'input', name: 'item' }, 'y', nullableNumberType, 'remove-cell-anchor')
  const anchorMatch = matchesAnyCell(keptAnchorBody, fresh, { kind: 'input', name: 'selected' }, anchorX, anchorY, 'remove-cell-anchor-match')
  const keepAnchor = fresh('remove-cell-keep-anchor')
  keptAnchorBody.push(call(keepAnchor, 'logic.not', { value: anchorMatch }), returnValue(fresh('remove-cell-anchor-return'), out(keepAnchor)))
  const keptAnchors = fresh('remove-cell-kept-anchors')
  statements.push(filterCollection(keptAnchors, anchors, keptAnchorBody, { selected: cells }))
  const anchorCount = fresh('remove-cell-anchor-count')
  const keptAnchorCount = fresh('remove-cell-kept-anchor-count')
  const removed = fresh('remove-cell-removed')
  statements.push(
    call(anchorCount, 'collection.length', { items: anchors }),
    call(keptAnchorCount, 'collection.length', { items: out(keptAnchors) }),
    call(removed, 'math.subtract', { left: out(anchorCount), right: out(keptAnchorCount) }),
  )

  const keptTileBody: GameplayStatement[] = []
  const tileType = readKey(keptTileBody, fresh, { kind: 'input', name: 'item' }, 'tileType', nullableStringType, 'remove-cell-tile')
  const tileX = readKey(keptTileBody, fresh, { kind: 'input', name: 'item' }, 'x', nullableNumberType, 'remove-cell-tile')
  const tileY = readKey(keptTileBody, fresh, { kind: 'input', name: 'item' }, 'y', nullableNumberType, 'remove-cell-tile')
  const tileTypeMatch = fresh('remove-cell-tile-type-match')
  keptTileBody.push(call(tileTypeMatch, 'compare.values', {
    left: tileType, right: literal('amaterasu'),
  }, { valueType: typeParameter(nullableStringType), operator: '==' }))
  const tileCellMatch = matchesAnyCell(keptTileBody, fresh, { kind: 'input', name: 'selected' }, tileX, tileY, 'remove-cell-tile-cell-match')
  const tileMatch = fresh('remove-cell-tile-match')
  const keepTile = fresh('remove-cell-keep-tile')
  keptTileBody.push(
    call(tileMatch, 'logic.and', { left: out(tileTypeMatch), right: tileCellMatch }),
    call(keepTile, 'logic.not', { value: out(tileMatch) }),
    returnValue(fresh('remove-cell-tile-return'), out(keepTile)),
  )
  const keptTiles = fresh('remove-cell-kept-tiles')
  statements.push(filterCollection(keptTiles, tileEffects.items, keptTileBody, { selected: cells }))

  const resultHandle = fresh('remove-cell-result')
  statements.push(call(resultHandle, 'local.declare', {}, { valueType: 'boolean' }))
  const tilePresent = fresh('remove-cell-tile-present')
  statements.push(call(tilePresent, 'compare.values', {
    left: tileEffects.raw, right: literal(null),
  }, { valueType: typeParameter(nullableRecordListType), operator: '!=' }))
  const withTiles: GameplayStatement[] = []
  const commit = fresh('remove-cell-commit')
  withTiles.push(
    call(commit, 'extension.commit-root-with-tiles', {
      root: out(keptAnchors), tiles: out(keptTiles),
    }, { storageKey: 'amaterasuCells', presentationBatch: callNode.parameters?.presentationBatch === 'direct' ? 'direct' : 'tileEffectRemoved' }, '2'),
    call(fresh('remove-cell-commit-result'), 'local.write', {
      handle: out(resultHandle, 'handle'), value: out(commit, 'success'),
    }, { valueType: 'boolean' }),
  )
  const withoutTiles: GameplayStatement[] = []
  const write = fresh('remove-cell-write-root')
  withoutTiles.push(
    call(write, 'extension.write-battle', { value: out(keptAnchors) }, {
      namespace: '', name: 'amaterasuCells', valueType: typeParameter(recordListType),
    }, '3'),
    call(fresh('remove-cell-write-result'), 'local.write', {
      handle: out(resultHandle, 'handle'), value: out(write, 'success'),
    }, { valueType: 'boolean' }),
  )
  statements.push({ kind: 'if', id: fresh('remove-cell-if'), condition: out(tilePresent), then: withTiles, else: withoutTiles })
  return { statements, outputs: { removed: out(removed) } }
}

function migrateFollowupCounterIncrementPlayer(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = callNode.inputs?.player
  if (!player || (callNode.parameters?.counter !== undefined && callNode.parameters.counter !== 'mangekyoDeaths')) return undefined
  if (callNode.parameters?.counter === undefined) return undefined

  const statements: GameplayStatement[] = []
  const root = declareBattleRecord(statements, fresh, 'contentCounters', 'counter-player')
  const counter = readKey(statements, fresh, root, 'mangekyoDeaths', nullableRecordType, 'counter-player')
  const emptyCounter = fresh('counter-player-empty')
  statements.push(call(emptyCounter, 'record.empty'))
  const existingCounter = fresh('counter-player-existing')
  statements.push(call(existingCounter, 'value.coalesce', {
    value: counter, defaultValue: out(emptyCounter, 'record'),
  }, { valueType: 'record' }))
  const playerKey = playerCounterKey(statements, fresh, player, 'counter-player')
  const current = readDynamicKey(statements, fresh, out(existingCounter), playerKey, nullableNumberType, 'counter-player')
  const currentValue = fresh('counter-player-current-value')
  statements.push(call(currentValue, 'value.coalesce', { value: current, defaultValue: literal(0) }, { valueType: 'number' }))
  const next = fresh('counter-player-next')
  statements.push(call(next, 'math.add', { left: out(currentValue), right: literal(1) }))
  const updatedCounter = fresh('counter-player-updated')
  statements.push(call(updatedCounter, 'record.set-key', {
    record: out(existingCounter), key: playerKey, value: out(next),
  }, { valueType: 'number' }))
  const updatedRoot = fresh('counter-player-root-updated')
  statements.push(call(updatedRoot, 'record.set-key', {
    record: root, key: literal('mangekyoDeaths'), value: out(updatedCounter, 'record'),
  }, { valueType: 'record' }))
  statements.push(call(callNode.id, 'extension.write-battle', { value: out(updatedRoot, 'record') }, {
    namespace: '', name: 'contentCounters', valueType: 'record',
  }, '3'))
  return { statements, outputs: { next: out(next) } }
}

function normalizedOwner(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  owner: GameplayValue,
): { value: GameplayValue; valid: GameplayValue } {
  const ownerPresent = fresh('stored-owner-present')
  const ownerText = fresh('stored-owner-text')
  const trimmed = fresh('stored-owner-trimmed')
  const normalized = fresh('stored-owner-normalized')
  const nonEmpty = fresh('stored-owner-non-empty')
  statements.push(
    call(ownerPresent, 'compare.values', { left: owner, right: literal(null) }, { valueType: nullable('string'), operator: '!=' }),
    call(ownerText, 'value.coalesce', { value: owner, defaultValue: literal('') }, { valueType: 'string' }),
    call(trimmed, 'text.trim', { text: out(ownerText) }),
    call(normalized, 'text.lowercase', { text: out(trimmed, 'text') }),
    call(nonEmpty, 'compare.values', { left: out(normalized, 'text'), right: literal('') }, { valueType: 'string', operator: '!=' }),
  )
  const safeProto = fresh('stored-owner-safe-proto')
  const safeConstructor = fresh('stored-owner-safe-constructor')
  const safePrototype = fresh('stored-owner-safe-prototype')
  const safeName = fresh('stored-owner-safe-name')
  const safeNameAll = fresh('stored-owner-safe-name-all')
  statements.push(
    call(safeProto, 'compare.values', { left: out(normalized, 'text'), right: literal('__proto__') }, { valueType: 'string', operator: '!=' }),
    call(safeConstructor, 'compare.values', { left: out(normalized, 'text'), right: literal('constructor') }, { valueType: 'string', operator: '!=' }),
    call(safePrototype, 'compare.values', { left: out(normalized, 'text'), right: literal('prototype') }, { valueType: 'string', operator: '!=' }),
    call(safeName, 'logic.and', { left: out(safeProto), right: out(safeConstructor) }),
    call(safeNameAll, 'logic.and', { left: out(safeName), right: out(safePrototype) }),
  )
  const ownerValid = fresh('stored-owner-valid-present')
  const ownerValidName = fresh('stored-owner-valid-name')
  const valid = fresh('stored-owner-valid')
  statements.push(
    call(ownerValid, 'logic.and', { left: out(ownerPresent), right: out(nonEmpty) }),
    call(ownerValidName, 'logic.and', { left: out(ownerValid), right: out(safeNameAll) }),
    call(valid, 'logic.and', { left: out(ownerValidName), right: out(safeNameAll) }),
  )
  return { value: out(normalized, 'text'), valid: out(valid) }
}

function migrateStorePiece(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const owner = callNode.inputs?.owner
  const piece = callNode.inputs?.piece
  const storageKey = callNode.parameters?.storageKey
  const ownerScopedStorageKey = callNode.parameters?.ownerScopedStorageKey
  if (!owner || !piece
    || (storageKey !== undefined && typeof storageKey !== 'string')
    || (ownerScopedStorageKey !== undefined && typeof ownerScopedStorageKey !== 'string')) return undefined
  const globalName = String(storageKey ?? 'kiljaedanPiece')
  const scopedName = String(ownerScopedStorageKey ?? 'kiljaedanPiecesByPlayerId')
  const statements: GameplayStatement[] = []
  const normalized = normalizedOwner(statements, fresh, owner)
  const resultHandle = fresh('stored-piece-result')
  statements.push(call(resultHandle, 'local.declare', {}, { valueType: 'boolean' }))
  const thenBranch: GameplayStatement[] = []
  const emptyScoped = fresh('stored-scoped-empty')
  thenBranch.push(call(emptyScoped, 'record.empty'))
  const declaredScoped = fresh('stored-scoped-declared')
  thenBranch.push(call(declaredScoped, 'extension.declare-battle', { value: out(emptyScoped, 'record') }, {
    namespace: '', name: scopedName, valueType: 'record',
  }, '3'))
  const updatedScoped = fresh('stored-scoped-updated')
  thenBranch.push(call(updatedScoped, 'record.set-key', {
    record: out(declaredScoped, 'value'), key: normalized.value, value: piece,
  }, { valueType: 'record' }))
  const writeScoped = fresh('stored-scoped-write')
  thenBranch.push(call(writeScoped, 'extension.write-battle', { value: out(updatedScoped, 'record') }, {
    namespace: '', name: scopedName, valueType: 'record',
  }, '3'))
  const declaredGlobal = fresh('stored-global-declared')
  thenBranch.push(call(declaredGlobal, 'extension.declare-battle', { value: piece }, {
    namespace: '', name: globalName, valueType: nullable('record'),
  }, '3'))
  const globalEmpty = fresh('stored-global-empty')
  thenBranch.push(call(globalEmpty, 'compare.values', {
    left: out(declaredGlobal, 'value'), right: literal(null),
  }, { valueType: nullable('record'), operator: '==' }))
  const globalWrite = fresh('stored-global-write')
  thenBranch.push({ kind: 'if', id: fresh('stored-global-if'), condition: out(globalEmpty), then: [
    call(globalWrite, 'extension.write-battle', { value: piece }, {
      namespace: '', name: globalName, valueType: nullable('record'),
    }, '3'),
    call(fresh('stored-global-result'), 'local.write', {
      handle: out(resultHandle, 'handle'), value: out(globalWrite, 'success'),
    }, { valueType: 'boolean' }),
  ], else: [
    call(fresh('stored-existing-result'), 'local.write', {
      handle: out(resultHandle, 'handle'), value: literal(true),
    }, { valueType: 'boolean' }),
  ]})
  statements.push({ kind: 'if', id: fresh('stored-owner-if'), condition: normalized.valid, then: thenBranch, else: [
    call(fresh('stored-invalid-owner'), 'local.write', {
      handle: out(resultHandle, 'handle'), value: literal(false),
    }, { valueType: 'boolean' }),
  ]})
  const result = fresh('stored-piece-result-read')
  statements.push(call(result, 'local.read', { handle: out(resultHandle, 'handle') }, { valueType: 'boolean' }))
  return { statements, outputs: { success: out(result, 'value') } }
}

export const atomicExtensionWriteRecipe: AtomicRecipe = (callNode, fresh): AtomicReplacement | undefined => {
  switch (callNode.module) {
    case 'projectile.zone-set': return migrateProjectileZoneSet(callNode, fresh)
    case 'extension.store-piece': return migrateStorePiece(callNode, fresh)
    case 'extension.append-cell-records': return appendCellRecords(callNode, fresh, false)
    case 'extension.append-cell-records-ordered': return appendCellRecords(callNode, fresh, true)
    case 'extension.remove-cell-records': return migrateExtensionRemoveCellRecords(callNode, fresh)
    case 'tile.remove-source-records': return migrateTileRemoveSourceRecords(callNode, fresh)
    case 'tile.append-dedup-markers': return migrateTileAppendDedupMarkers(callNode, fresh)
    case 'tile.batch-effect-markers': return migrateTileBatchEffectMarkers(callNode, fresh)
    case 'followup.counter.increment-player': return migrateFollowupCounterIncrementPlayer(callNode, fresh)
    case 'state.read-piece-number': return migrateReadPieceNumber(callNode, fresh)
    case 'state.write-piece-number': return migrateWritePieceNumber(callNode, fresh)
    case 'state.read-player-number': return migrateReadPlayerNumber(callNode, fresh)
    case 'state.write-player-number': return migrateWritePlayerNumber(callNode, fresh)
    default: return undefined
  }
}

export function migrateExtensionWriteModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicExtensionWriteRecipe)
}
