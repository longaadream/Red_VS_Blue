import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayLiteral,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'
import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayModuleGraph } from './module-types'

const numberType: GameplayValueType = 'number'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const cellType: GameplayValueType = 'cell'
const recordType: GameplayValueType = 'record'
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: playerType }
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: pieceType }
const nullableCellType: GameplayValueType = { kind: 'nullable', value: cellType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: recordType }
const nullableRecordListType: GameplayValueType = { kind: 'nullable', value: recordListType }

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

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

function replaceCall(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  const next: Record<string, unknown> = { ...original, module, version, inputs }
  if (parameters === undefined) delete next.parameters
  else next.parameters = parameters
  return next as GameplayCallStatement
}

function readKey(
  id: string,
  record: GameplayValue,
  key: string,
  valueType: GameplayValueType,
): GameplayCallStatement {
  // data.read-key is deliberately a direct-key reader.  The value type keeps
  // the host record opaque while still giving the structural compiler enough
  // information to type comparisons and collection outputs.
  return generatedCall(id, 'data.read-key', { record }, {
    key,
    valueType: valueTypeParameter(valueType),
  })
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

function or(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.or', { left, right })
}

function coalesce(
  id: string,
  value: GameplayValue,
  defaultValue: GameplayValue,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'value.coalesce', { value, defaultValue }, {
    valueType: valueTypeParameter(valueType),
  })
}

function select(
  id: string,
  condition: GameplayValue,
  whenTrue: GameplayValue,
  whenFalse: GameplayValue,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'logic.select', { condition, whenTrue, whenFalse }, {
    valueType: valueTypeParameter(valueType),
  }, '2')
}

function extensionRecords(
  fresh: (suffix: string) => string,
  storageKey: string,
): { statements: GameplayStatement[]; records: GameplayValue } {
  // Read the extension container as a record, then use the record-key reader
  // for the typed list.  battle.field@4 intentionally accepts scalar values
  // only; using it for extension record lists makes otherwise valid graphs
  // fail parameter validation before the migration can run.
  const extensionsId = fresh('extensions')
  const rawId = fresh('extension-records-raw')
  const recordsId = fresh('extension-records')
  const extensions = generatedCall(extensionsId, 'battle.extensions')
  const raw = readKey(rawId, output(extensionsId, 'record'), storageKey, nullableRecordListType)
  const normalized = coalesce(recordsId, output(rawId), literal([]), recordListType)
  return { statements: [extensions, raw, normalized], records: output(recordsId) }
}

function coordinateMatch(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  leftRecord: GameplayValue,
  rightX: GameplayValue,
  rightY: GameplayValue,
  prefix: string,
): GameplayValue {
  const leftXId = fresh(prefix + '-x')
  const leftYId = fresh(prefix + '-y')
  const xMatchId = fresh(prefix + '-x-match')
  const yMatchId = fresh(prefix + '-y-match')
  const bothId = fresh(prefix + '-match')
  statements.push(
    readKey(leftXId, leftRecord, 'x', nullableNumberType),
    readKey(leftYId, leftRecord, 'y', nullableNumberType),
    compare(xMatchId, output(leftXId), rightX, nullableNumberType),
    compare(yMatchId, output(leftYId), rightY, nullableNumberType),
    and(bothId, output(xMatchId), output(yMatchId)),
  )
  return output(bothId)
}

function coordinateValidity(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  prefix: string,
): { x: GameplayValue; y: GameplayValue; valid: GameplayValue } {
  const xId = fresh(prefix + '-x')
  const yId = fresh(prefix + '-y')
  const xPresentId = fresh(prefix + '-x-present')
  const yPresentId = fresh(prefix + '-y-present')
  const xValueId = fresh(prefix + '-x-value')
  const yValueId = fresh(prefix + '-y-value')
  const xFloorId = fresh(prefix + '-x-floor')
  const yFloorId = fresh(prefix + '-y-floor')
  const xIntegerId = fresh(prefix + '-x-integer')
  const yIntegerId = fresh(prefix + '-y-integer')
  const xValidId = fresh(prefix + '-x-valid')
  const yValidId = fresh(prefix + '-y-valid')
  const validId = fresh(prefix + '-valid')
  statements.push(
    readKey(xId, record, 'x', nullableNumberType),
    readKey(yId, record, 'y', nullableNumberType),
    compare(xPresentId, output(xId), literal(null), nullableNumberType, '!='),
    compare(yPresentId, output(yId), literal(null), nullableNumberType, '!='),
    coalesce(xValueId, output(xId), literal(0), numberType),
    coalesce(yValueId, output(yId), literal(0), numberType),
    generatedCall(xFloorId, 'math.floor', { value: output(xValueId) }),
    generatedCall(yFloorId, 'math.floor', { value: output(yValueId) }),
    compare(xIntegerId, output(xValueId), output(xFloorId), numberType),
    compare(yIntegerId, output(yValueId), output(yFloorId), numberType),
    and(xValidId, output(xPresentId), output(xIntegerId)),
    and(yValidId, output(yPresentId), output(yIntegerId)),
    and(validId, output(xValidId), output(yValidId)),
  )
  return { x: output(xValueId), y: output(yValueId), valid: output(validId) }
}

function cellFromCoordinates(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  x: GameplayValue,
  y: GameplayValue,
  prefix: string,
): GameplayValue {
  const cellId = fresh(prefix + '-cell')
  statements.push(generatedCall(cellId, 'spatial.cell', { x, y }))
  return output(cellId, 'cell')
}

function normalizeCell(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  cell: GameplayValue,
  prefix: string,
): GameplayValue {
  const fallbackId = fresh(prefix + '-fallback')
  const normalizedId = fresh(prefix + '-normalized')
  statements.push(
    generatedCall(fallbackId, 'spatial.cell', { x: literal(0), y: literal(0) }),
    coalesce(normalizedId, cell, output(fallbackId, 'cell'), cellType),
  )
  return output(normalizedId)
}

function migrateCellsForSource(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cells = requiredInput(call, 'cells')
  const source = requiredInput(call, 'source')
  if (!cells || !source) return undefined

  const sourceReadId = fresh('source-id')
  const sourceMatchReadId = fresh('source-piece-id')
  const sourceCaptureName = 'sourcePiece'
  const sourceNull = fresh('source-null')
  const sourceEmpty = fresh('source-empty')
  const sourceMatch = fresh('source-match')
  const sourceMissingOrEmpty = fresh('source-missing-or-empty')
  const sourceAllowed = fresh('source-allowed')
  const filtered = fresh('matching-cells')
  const body: GameplayStatement[] = [
    readKey(sourceReadId, input('item'), 'sourcePieceId', nullableStringType),
    readKey(sourceMatchReadId, input('item'), 'sourcePieceId', nullablePieceType),
    compare(sourceNull, output(sourceReadId), literal(null), nullableStringType),
    compare(sourceEmpty, output(sourceReadId), literal(''), nullableStringType),
    compare(sourceMatch, output(sourceMatchReadId), input(sourceCaptureName), nullablePieceType),
    or(sourceMissingOrEmpty, output(sourceNull), output(sourceEmpty)),
    or(sourceAllowed, output(sourceMissingOrEmpty), output(sourceMatch)),
  ]
  const coordinates = coordinateValidity(body, fresh, input('item'), 'cell')
  const sourceAndCoordinates = fresh('source-and-coordinates')
  body.push(and(sourceAndCoordinates, output(sourceAllowed), coordinates.valid))
  body.push({ kind: 'return', id: fresh('filter-return'), value: output(sourceAndCoordinates) })
  const filter: GameplayStatement = {
    kind: 'collection', id: filtered, method: 'filter', items: cells, item: 'item',
    inputs: { [sourceCaptureName]: source }, body,
  }
  const mapBody: GameplayStatement[] = []
  const mappedCoordinates = coordinateValidity(mapBody, fresh, input('item'), 'mapped-cell')
  const cell = cellFromCoordinates(mapBody, fresh, mappedCoordinates.x, mappedCoordinates.y, 'mapped')
  mapBody.push({ kind: 'return', id: fresh('map-return'), value: cell })
  const map: GameplayStatement = {
    kind: 'collection', id: call.id, method: 'map', items: output(filtered), item: 'item', body: mapBody,
  }
  return { statements: [filter, map], outputs: { cells: output(call.id) } }
}

function migrateRecordsToCells(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const records = requiredInput(call, 'records')
  if (!records) return undefined
  const body: GameplayStatement[] = []
  const x = fresh('x')
  const y = fresh('y')
  const cell = fresh('cell')
  body.push(
    readKey(x, input('item'), 'x', numberType),
    readKey(y, input('item'), 'y', numberType),
    generatedCall(cell, 'spatial.cell', { x: output(x), y: output(y) }),
    { kind: 'return', id: fresh('map-return'), value: output(cell, 'cell') },
  )
  const map: GameplayStatement = { kind: 'collection', id: call.id, method: 'map', items: records, item: 'item', body }
  return { statements: [map], outputs: { cells: output(call.id) } }
}

function matchingRecord(
  id: string,
  fresh: (suffix: string) => string,
  records: GameplayValue,
  x: GameplayValue,
  y: GameplayValue,
): GameplayStatement {
  const body: GameplayStatement[] = []
  const match = coordinateMatch(body, fresh, input('record'), input('x'), input('y'), 'record')
  body.push({ kind: 'return', id: fresh('record-return'), value: match })
  return { kind: 'collection', id, method: 'find', items: records, item: 'record', inputs: { x, y }, body }
}

function migrateCellRecordSource(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  if (!piece) return undefined
  const storageKey = call.parameters?.storageKey
  if (storageKey !== undefined && storageKey !== 'amaterasuCells') return undefined

  const extension = extensionRecords(fresh, 'amaterasuCells')
  const positionId = fresh('piece-position')
  const positionPresentId = fresh('piece-position-present')
  const coordinatesId = fresh('piece-coordinates')
  const sourceId = fresh('record-source')
  const ownerId = fresh('record-owner')
  const result = replaceCall(call, 'logic.select', {
    condition: output(positionPresentId),
    whenTrue: output(sourceId),
    whenFalse: literal(null),
  }, { valueType: valueTypeParameter(nullableStringType) }, '2')
  const statements: GameplayStatement[] = [
    ...extension.statements,
    generatedCall(positionId, 'spatial.piece-position', { piece }),
    compare(positionPresentId, output(positionId, 'cell'), literal(null), nullableCellType, '!='),
  ]
  const normalized = normalizeCell(statements, fresh, output(positionId, 'cell'), 'piece-position')
  statements.push(
    generatedCall(coordinatesId, 'spatial.cell-coordinates', { cell: normalized }),
    matchingRecord(fresh('matching-record'), fresh, extension.records, output(coordinatesId, 'x'), output(coordinatesId, 'y')),
  )
  const matchId = statements[statements.length - 1] as Extract<GameplayStatement, { kind: 'collection' }>
  statements.push(
    readKey(sourceId, output(matchId.id), 'sourcePieceId', nullableStringType),
    readKey(ownerId, output(matchId.id), 'ownerPlayerId', nullablePlayerType),
    result,
  )
  return { statements, outputs: { sourceId: output(call.id), ownerPlayerId: output(ownerId) } }
}

function migrateRecordSource(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const record = requiredInput(call, 'record')
  if (!record) return undefined

  // The compatibility helper read a nullable sourceId and then validated that
  // the referenced piece was still owned by the authoritative battle.  Keep
  // both steps explicit so the migrated graph never leaks a stale string as a
  // piece reference.
  const sourceId = fresh('record-source-id')
  const sourcePiece = fresh('record-source-piece')
  const read = readKey(sourceId, record, 'sourceId', nullableStringType)
  const resolve = generatedCall(sourcePiece, 'query.piece-by-id', { id: output(sourceId) })
  return { statements: [read, resolve], outputs: { piece: output(sourcePiece, 'piece') } }
}

function migratePathCellRecordHits(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const storageKey = call.parameters?.storageKey
  if (storageKey !== undefined && storageKey !== 'amaterasuCells') return undefined
  const eventPathId = fresh('contact-cells')
  const pathId = fresh('contact-cells-normalized')
  const eventPath = generatedCall(eventPathId, 'event.field', {}, { field: 'contactCells' })
  const path = coalesce(pathId, output(eventPathId), literal([]), recordListType)
  const extension = extensionRecords(fresh, 'amaterasuCells')

  const foundMapId = fresh('path-matches')
  const foundMapBody: GameplayStatement[] = []
  const pathCoordinates = coordinateValidity(foundMapBody, fresh, input('item'), 'path')
  const found = matchingRecord(fresh('path-match'), fresh, input('records'), pathCoordinates.x, pathCoordinates.y)
  foundMapBody.push(found, { kind: 'return', id: fresh('path-map-return'), value: output((found as Extract<GameplayStatement, { kind: 'collection' }>).id) })
  const foundMap: GameplayStatement = {
    kind: 'collection', id: foundMapId, method: 'map', items: output(pathId), item: 'item',
    inputs: { records: extension.records }, body: foundMapBody,
  }

  const matchedId = fresh('matched-path-records')
  const matchedPresentId = fresh('matched-present')
  const matchedFilter: GameplayStatement = {
    kind: 'collection', id: matchedId, method: 'filter', items: output(foundMapId), item: 'item', body: [
      compare(matchedPresentId, input('item'), literal(null), nullableRecordType, '!='),
      { kind: 'return', id: fresh('matched-filter-return'), value: output(matchedPresentId) },
    ],
  }

  const sourcesId = fresh('matched-sources')
  const sourceReadId = fresh('source')
  const sourceMapBody: GameplayStatement[] = [
    readKey(sourceReadId, input('item'), 'sourcePieceId', nullableStringType),
    { kind: 'return', id: fresh('source-map-return'), value: output(sourceReadId) },
  ]
  const sourceMap: GameplayStatement = {
    kind: 'collection', id: sourcesId, method: 'map', items: output(matchedId), item: 'item', body: sourceMapBody,
  }

  const sourcesFilteredId = fresh('matched-string-sources')
  const sourcePresentId = fresh('source-present')
  const sourcesFiltered: GameplayStatement = {
    kind: 'collection', id: sourcesFilteredId, method: 'filter', items: output(sourcesId), item: 'item', body: [
      compare(sourcePresentId, input('item'), literal(null), nullableStringType, '!='),
      { kind: 'return', id: fresh('source-filter-return'), value: output(sourcePresentId) },
    ],
  }

  const sourceStringsId = fresh('string-sources')
  const sourceStringValueId = fresh('string-source-value')
  const sourceStrings: GameplayStatement = {
    kind: 'collection', id: sourceStringsId, method: 'map', items: output(sourcesFilteredId), item: 'item', body: [
      coalesce(sourceStringValueId, input('item'), literal(''), stringType),
      { kind: 'return', id: fresh('string-source-return'), value: output(sourceStringValueId) },
    ],
  }

  const firstSourceId = fresh('first-source')
  const firstSource: GameplayStatement = {
    kind: 'collection', id: firstSourceId, method: 'find', items: output(sourceStringsId), item: 'item', body: [
      { kind: 'return', id: fresh('first-source-return'), value: literal(true) },
    ],
  }
  const firstSourceRecordId = fresh('first-source-record')
  const firstSourceRecordPresentId = fresh('first-source-record-present')
  const firstSourceRecordMatchId = fresh('first-source-record-match')
  const firstSourceRecord: GameplayStatement = {
    kind: 'collection', id: firstSourceRecordId, method: 'find', items: output(matchedId), item: 'item', body: [
      readKey(firstSourceRecordPresentId, input('item'), 'sourcePieceId', nullableStringType),
      compare(firstSourceRecordMatchId, output(firstSourceRecordPresentId), literal(null), nullableStringType, '!='),
      { kind: 'return', id: fresh('first-source-record-return'), value: output(firstSourceRecordMatchId) },
    ],
  }
  const firstOwnerId = fresh('first-source-owner')
  const firstRecord = output(firstSourceRecordId)
  const owner = readKey(firstOwnerId, firstRecord, 'ownerPlayerId', nullablePlayerType)
  const hits = replaceCall(call, 'collection.length', { items: output(matchedId) })
  return {
    statements: [eventPath, path, ...extension.statements, foundMap, matchedFilter, sourceMap, sourcesFiltered, sourceStrings, firstSource, firstSourceRecord, owner, hits],
    outputs: { hits: output(call.id), sourceId: output(firstSourceId), ownerPlayerId: output(firstOwnerId) },
  }
}

function migrateValidSideCells(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const statusId = requiredInput(call, 'statusId')
  if (!piece || !statusId) return undefined
  const tagsId = fresh('status-tags')
  const tagId = fresh('status')
  const tagReadId = fresh('status-id')
  const tagDefinedId = fresh('status-id-defined')
  const tagMatchId = fresh('status-id-match')
  const tagFoundId = fresh('status-id-and-match')
  const tags = generatedCall(tagsId, 'piece.field', { piece }, { field: 'statusTags' })
  const findTag: GameplayStatement = {
    kind: 'collection', id: tagId, method: 'find', items: output(tagsId), item: 'item', inputs: { statusId }, body: [
      readKey(tagReadId, input('item'), 'id', nullableStringType),
      compare(tagDefinedId, output(tagReadId, 'defined'), literal(true), 'boolean'),
      compare(tagMatchId, output(tagReadId), input('statusId'), nullableStringType),
      and(tagFoundId, output(tagDefinedId), output(tagMatchId)),
      { kind: 'return', id: fresh('status-find-return'), value: output(tagFoundId) },
    ],
  }
  const leftId = fresh('left')
  const rightId = fresh('right')
  const sideRead: GameplayStatement[] = [
    readKey(leftId, output(tagId), 'left', nullableCellType),
    readKey(rightId, output(tagId), 'right', nullableCellType),
  ]
  const sideCellsId = fresh('side-cells')
  const sideIndexId = fresh('side-index')
  const sideSelectId = fresh('side-select')
  const sideMap: GameplayStatement = {
    kind: 'collection', id: sideCellsId, method: 'map', items: literal([0, 1]), item: 'side', index: 'index',
    inputs: { left: output(leftId), right: output(rightId) }, body: [
      compare(sideIndexId, input('index'), literal(0), numberType),
      select(sideSelectId, output(sideIndexId), input('left'), input('right'), nullableCellType),
      { kind: 'return', id: fresh('side-map-return'), value: output(sideSelectId) },
    ],
  }

  const mapCellsId = fresh('map-cells')
  const mapCells = generatedCall(mapCellsId, 'spatial.map-cells')
  const fallbackId = fresh('side-fallback')
  const fallback = generatedCall(fallbackId, 'spatial.cell', { x: literal(0), y: literal(0) })
  const filteredId = fresh('valid-side-cells')
  const sidePresentId = fresh('side-present')
  const normalizedSideId = fresh('normalized-side')
  const sideCoordinatesId = fresh('side-coordinates')
  const tileMatchId = fresh('matching-map-cell')
  const tilePresentId = fresh('map-cell-present')
  const sideValidId = fresh('side-valid')
  const filterBody: GameplayStatement[] = [
    compare(sidePresentId, input('item'), literal(null), nullableCellType, '!='),
    coalesce(normalizedSideId, input('item'), input('fallback'), cellType),
    generatedCall(sideCoordinatesId, 'spatial.cell-coordinates', { cell: output(normalizedSideId) }),
  ]
  const tileCoordinatesId = fresh('tile-coordinates')
  const tileXMatchId = fresh('tile-x-match')
  const tileYMatchId = fresh('tile-y-match')
  const tileMatchValueId = fresh('tile-match')
  const matchingTile: GameplayStatement = {
    kind: 'collection', id: tileMatchId, method: 'find', items: input('mapCells'), item: 'tile', inputs: {
      x: output(sideCoordinatesId, 'x'), y: output(sideCoordinatesId, 'y'),
    }, body: [
      generatedCall(tileCoordinatesId, 'spatial.cell-coordinates', { cell: input('tile') }),
      compare(tileXMatchId, output(tileCoordinatesId, 'x'), input('x'), numberType),
      compare(tileYMatchId, output(tileCoordinatesId, 'y'), input('y'), numberType),
      and(tileMatchValueId, output(tileXMatchId), output(tileYMatchId)),
      { kind: 'return', id: fresh('tile-find-return'), value: output(tileMatchValueId) },
    ],
  }
  filterBody.push(
    matchingTile,
    compare(tilePresentId, output(tileMatchId), literal(null), nullableCellType, '!='),
    and(sideValidId, output(sidePresentId), output(tilePresentId)),
    { kind: 'return', id: fresh('side-filter-return'), value: output(sideValidId) },
  )
  const filter: GameplayStatement = {
    kind: 'collection', id: filteredId, method: 'filter', items: output(sideCellsId), item: 'item',
    inputs: { mapCells: output(mapCellsId, 'cells'), fallback: output(fallbackId, 'cell') }, body: filterBody,
  }
  const resultCellId = fresh('result-cell')
  const resultBody: GameplayStatement[] = [
    coalesce(resultCellId, input('item'), input('fallback'), cellType),
    { kind: 'return', id: fresh('result-return'), value: output(resultCellId) },
  ]
  const result: GameplayStatement = { kind: 'collection', id: call.id, method: 'map', items: output(filteredId), item: 'item', inputs: { fallback: output(fallbackId, 'cell') }, body: resultBody }
  return { statements: [tags, findTag, ...sideRead, sideMap, mapCells, fallback, filter, result], outputs: { cells: output(call.id) } }
}

function migrateAnchorExists(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const cell = requiredInput(call, 'cell')
  if (!source || !cell) return undefined
  const storageKey = call.parameters?.storageKey
  if (storageKey !== undefined && storageKey !== 'minatoAnchors') return undefined
  const extension = extensionRecords(fresh, 'minatoAnchors')
  const cellPresentId = fresh('cell-present')
  const setup: GameplayStatement[] = []
  setup.push(
    compare(cellPresentId, cell, literal(null), nullableCellType, '!='),
  )
  const cellSetup: GameplayStatement[] = []
  const safeCell = normalizeCell(cellSetup, fresh, cell, 'anchor-cell')
  const coordinatesId = fresh('anchor-coordinates')
  cellSetup.push(generatedCall(coordinatesId, 'spatial.cell-coordinates', { cell: safeCell }))
  const findId = fresh('anchor-match')
  const findBody: GameplayStatement[] = []
  const sourceReadId = fresh('anchor-source')
  const sourceDefinedId = fresh('anchor-source-defined')
  const sourceMatchId = fresh('anchor-source-match')
  const sourceAndId = fresh('anchor-source-and')
  findBody.push(
    readKey(sourceReadId, input('item'), 'sourceId', nullablePieceType),
    compare(sourceDefinedId, output(sourceReadId, 'defined'), literal(true), 'boolean'),
    compare(sourceMatchId, output(sourceReadId), input('sourceId'), nullablePieceType),
    and(sourceAndId, output(sourceDefinedId), output(sourceMatchId)),
  )
  const coordinates = coordinateMatch(findBody, fresh, input('item'), input('x'), input('y'), 'anchor')
  const foundAndId = fresh('anchor-found')
  findBody.push(and(foundAndId, output(sourceAndId), coordinates), { kind: 'return', id: fresh('anchor-return'), value: output(foundAndId) })
  const find: GameplayStatement = {
    kind: 'collection', id: findId, method: 'find', items: extension.records, item: 'item',
    inputs: { sourceId: source, x: output(coordinatesId, 'x'), y: output(coordinatesId, 'y') }, body: findBody,
  }
  const foundId = fresh('anchor-found-present')
  const result = replaceCall(call, 'logic.and', { left: output(cellPresentId), right: output(foundId) })
  return {
    statements: [...extension.statements, ...setup, ...cellSetup, find, compare(foundId, output(findId), literal(null), nullableRecordType, '!='), result],
    outputs: { value: output(call.id) },
  }
}

function migratePrimaryMangekyoWitness(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const witness = requiredInput(call, 'witness')
  if (!witness) return undefined

  const piecesId = fresh('all-pieces')
  const ownerId = fresh('witness-owner')
  const candidatesId = fresh('witness-candidates')
  const candidateOwnerId = fresh('candidate-owner')
  const ownerMatchId = fresh('candidate-owner-match')
  const candidateTagsId = fresh('candidate-tags')
  const tagTypeId = fresh('witness-tag-type')
  const tagMatchId = fresh('witness-tag-match')
  const tagFindId = fresh('witness-tag')
  const tagPresentId = fresh('candidate-tag-present')
  const candidateMatchId = fresh('candidate-match')
  const keysId = fresh('witness-keys')
  const sortedId = fresh('sorted-witnesses')
  const firstId = fresh('first-witness')
  const witnessPresentId = fresh('witness-present')
  const firstMatchId = fresh('first-witness-match')

  const allPieces = generatedCall(piecesId, 'query.pieces', {}, { relation: 'all', includeDead: true })
  const owner = generatedCall(ownerId, 'piece.field', { piece: witness }, { field: 'ownerPlayerId' })
  const tagFind: GameplayStatement = {
    kind: 'collection', id: tagFindId, method: 'find', items: output(candidateTagsId), item: 'tag', body: [
      readKey(tagTypeId, input('tag'), 'type', nullableStringType),
      compare(tagMatchId, output(tagTypeId), literal('mangekyo-witness'), nullableStringType),
      { kind: 'return', id: fresh('witness-tag-return'), value: output(tagMatchId) },
    ],
  }
  const candidateFilter: GameplayStatement = {
    kind: 'collection', id: candidatesId, method: 'filter', items: output(piecesId, 'pieces'), item: 'item',
    inputs: { owner: output(ownerId) }, body: [
      generatedCall(candidateOwnerId, 'piece.field', { piece: input('item') }, { field: 'ownerPlayerId' }),
      compare(ownerMatchId, output(candidateOwnerId), input('owner'), playerType),
      generatedCall(candidateTagsId, 'piece.field', { piece: input('item') }, { field: 'statusTags' }),
      tagFind,
      compare(tagPresentId, output(tagFindId), literal(null), nullableRecordType, '!='),
      and(candidateMatchId, output(ownerMatchId), output(tagPresentId)),
      { kind: 'return', id: fresh('witness-filter-return'), value: output(candidateMatchId) },
    ],
  }
  const keyMapBody: GameplayStatement[] = []
  const keyValueId = fresh('witness-key-value')
  keyMapBody.push(
    generatedCall(keyValueId, 'piece.field', { piece: input('item') }, { field: 'instanceId' }),
    { kind: 'return', id: fresh('witness-key-return'), value: output(keyValueId) },
  )
  const stableKeyMap: GameplayStatement = { kind: 'collection', id: keysId, method: 'map', items: output(candidatesId), item: 'item', body: keyMapBody }

  const sorted = generatedCall(sortedId, 'collection.sort', { items: output(candidatesId), keys: output(keysId) }, {
    order: 'ascending', comparison: 'locale',
  }, '2')
  const first: GameplayStatement = {
    kind: 'collection', id: firstId, method: 'find', items: output(sortedId, 'items'), item: 'item', body: [
      { kind: 'return', id: fresh('first-witness-return'), value: literal(true) },
    ],
  }
  const witnessPresent = compare(witnessPresentId, witness, literal(null), nullablePieceType, '!=')
  const firstMatch = compare(firstMatchId, output(firstId), witness, nullablePieceType)
  const result = replaceCall(call, 'logic.and', { left: output(witnessPresentId), right: output(firstMatchId) })
  return {
    statements: [allPieces, owner, candidateFilter, stableKeyMap, sorted, first, witnessPresent, firstMatch, result],
    outputs: { value: output(call.id) },
  }
}

/** Compatibility IDs retired by the structural extension/query recipes. */
export const ATOMIC_EXTENSION_QUERY_MODULES = new Set([
  'extension.cells-for-source',
  'extension.records-to-cells',
  'extension.cell-record-source',
  'extension.record-source',
  'event.path-cell-record-hits',
  'status.valid-side-cells',
  'marker.anchor-exists',
  'followup.primary-mangekyo-witness',
])
export const ATOMIC_EXTENSION_QUERY_MODULE_IDS = ATOMIC_EXTENSION_QUERY_MODULES

export const atomicExtensionQueryRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  switch (call.module) {
    case 'extension.cells-for-source': return migrateCellsForSource(call, fresh)
    case 'extension.records-to-cells': return migrateRecordsToCells(call, fresh)
    case 'extension.cell-record-source': return migrateCellRecordSource(call, fresh)
    case 'extension.record-source': return migrateRecordSource(call, fresh)
    case 'event.path-cell-record-hits': return migratePathCellRecordHits(call, fresh)
    case 'status.valid-side-cells': return migrateValidSideCells(call, fresh)
    case 'marker.anchor-exists': return migrateAnchorExists(call, fresh)
    case 'followup.primary-mangekyo-witness': return migratePrimaryMangekyoWitness(call, fresh)
    default: return undefined
  }
}

export function createExtensionQueryMigrationRecipe(): AtomicRecipe {
  return atomicExtensionQueryRecipe
}

export function migrateExtensionQueryModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicExtensionQueryRecipe)
}

export const migrateAtomicExtensionQueryGraph = migrateExtensionQueryModules
