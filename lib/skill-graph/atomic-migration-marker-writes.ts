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

const recordType: GameplayValueType = 'record'
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: recordType }
const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: 'number' }
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: 'player' }
const nullableCellType: GameplayValueType = { kind: 'nullable', value: 'cell' }
const nullableStatusType: GameplayValueType = { kind: 'nullable', value: 'status' }
const numberType: GameplayValueType = 'number'
const cellType: GameplayValueType = 'cell'
const cellListType: GameplayValueType = { kind: 'list', element: cellType }

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

function valueTypeParameter(type: GameplayValueType): GameplayJsonValue {
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

function not(id: string, value: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.not', { value })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.and', { left, right })
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

function readKey(
  id: string,
  record: GameplayValue,
  key: string,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'data.read-key', { record }, {
    key, valueType: valueTypeParameter(valueType),
  })
}

function textFromValue(
  id: string,
  value: GameplayValue,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'text.from-value', { value }, { valueType: valueTypeParameter(valueType) })
}

function textConcat(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'text.concat', { left, right })
}

function optionalField(
  id: string,
  record: GameplayValue,
  field: string,
): GameplayCallStatement {
  return generatedCall(id, 'data.optional-field', { record }, { field })
}

function setField(
  id: string,
  record: GameplayValue,
  field: string,
  value: GameplayValue,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'record.set-field', { record, value }, { field, valueType: valueTypeParameter(valueType) })
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function ifStatement(
  id: string,
  condition: GameplayValue,
  then: readonly GameplayStatement[],
  otherwise?: readonly GameplayStatement[],
): GameplayStatement {
  return {
    kind: 'if', id, condition, then,
    ...(otherwise === undefined ? {} : { else: otherwise }),
  }
}

function filterCollection(
  id: string,
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
  item = 'item',
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'filter', items, item,
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function mapCollection(
  id: string,
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
  item = 'item',
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'map', items, item,
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
  item = 'item',
  accumulator = 'accumulator',
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'reduce', items, item, accumulator, initial,
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function readExtensionList(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  extensions: GameplayValue,
  key: string,
  prefix: string,
): GameplayValue {
  const raw = fresh(prefix + '-raw')
  const normalized = fresh(prefix + '-normalized')
  statements.push(
    readKey(raw, extensions, key, { kind: 'nullable', value: recordListType }),
    generatedCall(normalized, 'value.coalesce', {
      value: output(raw), defaultValue: literal([]),
    }, { valueType: valueTypeParameter(recordListType) }),
  )
  return output(normalized)
}

function readOptional(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  field: string,
  prefix: string,
): GameplayValue {
  const id = fresh(prefix + '-' + field)
  statements.push(optionalField(id, record, field))
  return output(id)
}

function matchAnchor(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  sourceId: GameplayValue,
  x: GameplayValue,
  y: GameplayValue,
  prefix: string,
): GameplayValue {
  const recordSource = readOptional(statements, fresh, record, 'sourceId', prefix)
  const recordXId = fresh(prefix + '-x')
  const recordYId = fresh(prefix + '-y')
  statements.push(readKey(recordXId, record, 'x', nullableNumberType), readKey(recordYId, record, 'y', nullableNumberType))
  const recordX = output(recordXId)
  const recordY = output(recordYId)
  const sourceMatch = fresh(prefix + '-source-match')
  const xMatch = fresh(prefix + '-x-match')
  const yMatch = fresh(prefix + '-y-match')
  const xyMatch = fresh(prefix + '-xy-match')
  const result = fresh(prefix + '-match')
  statements.push(
    compare(sourceMatch, recordSource, sourceId, nullableStringType),
    compare(xMatch, recordX, x, nullableNumberType),
    compare(yMatch, recordY, y, nullableNumberType),
    and(xyMatch, output(xMatch), output(yMatch)),
    and(result, output(sourceMatch), output(xyMatch)),
  )
  return output(result)
}

function matchTileForAnchor(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  tile: GameplayValue,
  anchor: GameplayValue,
  tileType: string,
  prefix: string,
): GameplayValue {
  const anchorSource = readOptional(statements, fresh, anchor, 'sourceId', prefix + '-anchor')
  const anchorXId = fresh(prefix + '-anchor-x')
  const anchorYId = fresh(prefix + '-anchor-y')
  statements.push(readKey(anchorXId, anchor, 'x', nullableNumberType), readKey(anchorYId, anchor, 'y', nullableNumberType))
  const anchorX = output(anchorXId)
  const anchorY = output(anchorYId)
  const tileSource = readOptional(statements, fresh, tile, 'sourceId', prefix + '-tile')
  const tileXId = fresh(prefix + '-tile-x')
  const tileYId = fresh(prefix + '-tile-y')
  statements.push(readKey(tileXId, tile, 'x', nullableNumberType), readKey(tileYId, tile, 'y', nullableNumberType))
  const tileX = output(tileXId)
  const tileY = output(tileYId)
  const tileKindId = fresh(prefix + '-tile-tileType')
  statements.push(readKey(tileKindId, tile, 'tileType', nullableStringType))
  const tileKind = output(tileKindId)
  const sourceMatch = fresh(prefix + '-source-match')
  const xMatch = fresh(prefix + '-x-match')
  const yMatch = fresh(prefix + '-y-match')
  const kindMatch = fresh(prefix + '-kind-match')
  const xyMatch = fresh(prefix + '-xy-match')
  const sourceAndPosition = fresh(prefix + '-source-position')
  const result = fresh(prefix + '-match')
  statements.push(
    compare(sourceMatch, tileSource, anchorSource, nullableStringType),
    compare(xMatch, tileX, anchorX, nullableNumberType),
    compare(yMatch, tileY, anchorY, nullableNumberType),
    compare(kindMatch, tileKind, literal(tileType), nullableStringType),
    and(xyMatch, output(xMatch), output(yMatch)),
    and(sourceAndPosition, output(sourceMatch), output(xyMatch)),
    and(result, output(sourceAndPosition), output(kindMatch)),
  )
  return output(result)
}

function matchTileAtCell(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  tile: GameplayValue,
  sourceId: GameplayValue,
  x: GameplayValue,
  y: GameplayValue,
  tileType: string,
  prefix: string,
): GameplayValue {
  const tileSource = readOptional(statements, fresh, tile, 'sourceId', prefix + '-tile')
  const tileXId = fresh(prefix + '-tile-x')
  const tileYId = fresh(prefix + '-tile-y')
  statements.push(readKey(tileXId, tile, 'x', nullableNumberType), readKey(tileYId, tile, 'y', nullableNumberType))
  const tileX = output(tileXId)
  const tileY = output(tileYId)
  const tileKindId = fresh(prefix + '-tile-tileType')
  statements.push(readKey(tileKindId, tile, 'tileType', nullableStringType))
  const tileKind = output(tileKindId)
  const sourceMatch = fresh(prefix + '-source-match')
  const xMatch = fresh(prefix + '-x-match')
  const yMatch = fresh(prefix + '-y-match')
  const kindMatch = fresh(prefix + '-kind-match')
  const xyMatch = fresh(prefix + '-xy-match')
  const sourceAndPosition = fresh(prefix + '-source-position')
  const result = fresh(prefix + '-match')
  statements.push(
    compare(sourceMatch, tileSource, sourceId, nullableStringType),
    compare(xMatch, tileX, x, nullableNumberType),
    compare(yMatch, tileY, y, nullableNumberType),
    compare(kindMatch, tileKind, literal(tileType), nullableStringType),
    and(xyMatch, output(xMatch), output(yMatch)),
    and(sourceAndPosition, output(sourceMatch), output(xyMatch)),
    and(result, output(sourceAndPosition), output(kindMatch)),
  )
  return output(result)
}

function buildRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  fields: ReadonlyArray<readonly [string, GameplayValue, GameplayValueType]>,
  prefix: string,
): GameplayValue {
  const emptyId = fresh(prefix + '-empty')
  statements.push(generatedCall(emptyId, 'record.empty'))
  let record: GameplayValue = output(emptyId, 'record')
  for (const [field, value, valueType] of fields) {
    const id = fresh(prefix + '-' + field)
    statements.push(setField(id, record, field, value, valueType))
    record = output(id, 'record')
  }
  return record
}

function extensionState(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  storageKey: string,
): { extensions: GameplayValue; anchors: GameplayValue; tiles: GameplayValue } {
  const extensionsId = fresh('extensions')
  statements.push(generatedCall(extensionsId, 'battle.extensions'))
  const extensions = output(extensionsId, 'record')
  const anchors = readExtensionList(statements, fresh, extensions, storageKey, 'anchors')
  const tiles = readExtensionList(statements, fresh, extensions, 'tileEffects', 'tiles')
  return { extensions, anchors, tiles }
}

function trimToCapacity(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  anchors: GameplayValue,
  tiles: GameplayValue,
  sourceId: GameplayValue,
  tileType: string,
  maxAnchors: number,
): { anchors: GameplayValue; tiles: GameplayValue } {
  const ownId = fresh('own-anchors')
  const ownBody: GameplayStatement[] = []
  const ownSource = readOptional(ownBody, fresh, input('item'), 'sourceId', 'own-source')
  const ownSourceMatch = fresh('own-source-match')
  ownBody.push(
    compare(ownSourceMatch, ownSource, input('sourceId'), nullableStringType),
    returnValue(fresh('own-return'), output(ownSourceMatch)),
  )
  statements.push(filterCollection(ownId, anchors, ownBody, { sourceId }))
  const ownCountId = fresh('own-count')
  const excessRawId = fresh('excess-raw')
  const overId = fresh('over-capacity')
  const excessId = fresh('excess')
  statements.push(
    generatedCall(ownCountId, 'collection.length', { items: output(ownId) }),
    generatedCall(overId, 'compare.greater-than', { left: output(ownCountId), right: literal(maxAnchors) }),
    generatedCall(excessRawId, 'math.subtract', { left: output(ownCountId), right: literal(maxAnchors) }),
    select(excessId, output(overId), output(excessRawId), literal(0), 'number'),
  )

  const keysId = fresh('own-created-at-keys')
  const keyBody: GameplayStatement[] = []
  const createdId = fresh('created-at-createdAt')
  keyBody.push(readKey(createdId, input('item'), 'createdAt', nullableNumberType))
  const created = output(createdId)
  const normalized = fresh('created-at-normalized')
  keyBody.push(
    generatedCall(normalized, 'value.coalesce', { value: created, defaultValue: literal(0) }, { valueType: 'number' }),
    returnValue(fresh('key-return'), output(normalized)),
  )
  statements.push(mapCollection(keysId, output(ownId), keyBody))
  const sortedId = fresh('oldest-first')
  statements.push(generatedCall(sortedId, 'collection.sort', { items: output(ownId), keys: output(keysId) }, { order: 'ascending', comparison: 'numeric' }, '2'))

  const removedId = fresh('removed-anchors')
  const removedBody: GameplayStatement[] = []
  const beforeId = fresh('removed-before-capacity')
  removedBody.push(
    generatedCall(beforeId, 'compare.less-than', { left: input('index'), right: input('excess') }),
    returnValue(fresh('removed-return'), output(beforeId)),
  )
  statements.push(filterCollection(removedId, output(sortedId, 'items'), removedBody, { excess: output(excessId) }, 'item'))

  const keptId = fresh('kept-anchors')
  const keptBody: GameplayStatement[] = []
  const foundId = fresh('removed-match')
  const foundBody: GameplayStatement[] = []
  const sameId = fresh('same-removed-anchor')
  foundBody.push(
    compare(sameId, input('removed'), input('candidate'), nullableRecordType),
    returnValue(fresh('removed-match-return'), output(sameId)),
  )
  keptBody.push(
    findCollection(foundId, input('removed'), foundBody, { candidate: input('item') }, 'removed'),
  )
  const keepId = fresh('keep-anchor')
  keptBody.push(
    compare(keepId, output(foundId), literal(null), nullableRecordType),
    returnValue(fresh('keep-anchor-return'), output(keepId)),
  )
  statements.push(filterCollection(keptId, anchors, keptBody, { removed: output(removedId) }))

  const keptTilesId = fresh('kept-tiles')
  const keptTilesBody: GameplayStatement[] = []
  const removedTileId = fresh('removed-tile-match')
  const removedTileBody: GameplayStatement[] = []
  const tileMatch = matchTileForAnchor(removedTileBody, fresh, input('tile'), input('removed'), tileType, 'removed-tile')
  removedTileBody.push(returnValue(fresh('removed-tile-return'), tileMatch))
  keptTilesBody.push(findCollection(removedTileId, input('removed'), removedTileBody, { tile: input('item') }, 'removed'))
  const keepTileId = fresh('keep-tile')
  keptTilesBody.push(
    compare(keepTileId, output(removedTileId), literal(null), nullableRecordType),
    returnValue(fresh('keep-tile-return'), output(keepTileId)),
  )
  statements.push(filterCollection(keptTilesId, tiles, keptTilesBody, { removed: output(removedId) }))
  return { anchors: output(keptId), tiles: output(keptTilesId) }
}

function cellCoordinates(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  cell: GameplayValue,
  prefix: string,
): { readonly x: GameplayValue; readonly y: GameplayValue } {
  const id = fresh(prefix + '-coordinates')
  statements.push(generatedCall(id, 'spatial.cell-coordinates', { cell }))
  return { x: output(id, 'x'), y: output(id, 'y') }
}

function migrateTileAddMarker(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cell = requiredInput(call, 'cell')
  const sourceId = requiredInput(call, 'sourceId')
  const effectType = call.parameters?.effectType
  const icon = call.parameters?.icon
  const bgColor = call.parameters?.bgColor
  const boxShadow = call.parameters?.boxShadow
  const iconPosition = call.parameters?.iconPosition
  if (!cell || !sourceId || [effectType, icon, bgColor, boxShadow, iconPosition].some(value => typeof value !== 'string')) return undefined

  const statements: GameplayStatement[] = []
  const coordinates = cellCoordinates(statements, fresh, cell, 'marker')
  const effect = buildRecord(statements, fresh, [
    ['x', coordinates.x, numberType], ['y', coordinates.y, numberType],
    ['sourceId', sourceId, 'string'], ['tileType', literal(effectType as string), 'string'],
    ['icon', literal(icon as string), 'string'], ['bgColor', literal(bgColor as string), 'string'],
    ['boxShadow', literal(boxShadow as string), 'string'], ['iconPosition', literal(iconPosition as string), 'string'],
  ], 'marker-effect')
  const records = fresh('marker-records')
  statements.push(generatedCall(records, 'collection.singleton', { value: effect }, { valueType: valueTypeParameter(recordType) }))
  const submitted = fresh('marker-submit')
  statements.push(generatedCall(submitted, 'tile.batch-records', { records: output(records, 'items') }))
  return { statements, outputs: { success: output(submitted, 'success') } }
}

function migrateTileClearMarker(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const sourceId = requiredInput(call, 'sourceId')
  const effectType = call.parameters?.effectType
  if (!sourceId || typeof effectType !== 'string') return undefined

  const statements: GameplayStatement[] = []
  const extensionsId = fresh('marker-extensions')
  statements.push(generatedCall(extensionsId, 'battle.extensions'))
  const effects = readExtensionList(statements, fresh, output(extensionsId, 'record'), 'tileEffects', 'marker-effects')
  const filteredId = fresh('marker-kept-effects')
  const predicate: GameplayStatement[] = []
  const tileTypeId = fresh('marker-effect-type')
  const sourceIdRead = fresh('marker-effect-source')
  predicate.push(
    readKey(tileTypeId, input('item'), 'tileType', nullableStringType),
    readKey(sourceIdRead, input('item'), 'sourceId', nullableStringType),
  )
  const typeMatch = fresh('marker-type-match')
  const sourceMatch = fresh('marker-source-match')
  const matches = fresh('marker-match')
  const keep = fresh('marker-keep')
  predicate.push(
    compare(typeMatch, output(tileTypeId), literal(effectType), nullableStringType),
    compare(sourceMatch, output(sourceIdRead), input('sourceId'), nullableStringType),
    and(matches, output(typeMatch), output(sourceMatch)),
    not(keep, output(matches)),
    returnValue(fresh('marker-keep-return'), output(keep)),
  )
  statements.push(filterCollection(filteredId, effects, predicate, { sourceId }))
  const replaced = fresh('marker-replace')
  statements.push(generatedCall(replaced, 'tile.replace-effects', { effects: output(filteredId) }))
  return { statements, outputs: { success: output(replaced, 'success') } }
}

function migrateTileAddMarkers(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cells = requiredInput(call, 'cells')
  const origin = requiredInput(call, 'origin')
  const sourceId = requiredInput(call, 'sourceId')
  const ownerPlayerId = call.inputs?.ownerPlayerId
  const effectType = call.parameters?.effectType
  const icon = call.parameters?.icon
  const bgColor = call.parameters?.bgColor
  const boxShadow = call.parameters?.boxShadow
  const iconPosition = call.parameters?.iconPosition
  if (!cells || !origin || !sourceId || [effectType, icon, bgColor, boxShadow, iconPosition].some(value => typeof value !== 'string')) return undefined

  const statements: GameplayStatement[] = []
  const originCoordinates = cellCoordinates(statements, fresh, origin, 'marker-origin')
  const mappedId = fresh('marker-effects')
  const mapBody: GameplayStatement[] = []
  const cell = cellCoordinates(mapBody, fresh, input('item'), 'marker-cell')
  const xDelta = fresh('marker-dx')
  const yDelta = fresh('marker-dy')
  const xDistance = fresh('marker-x-distance')
  const yDistance = fresh('marker-y-distance')
  const xDominates = fresh('marker-x-dominates')
  const step = fresh('marker-presentation-step')
  mapBody.push(
    generatedCall(xDelta, 'math.subtract', { left: cell.x, right: input('originX') }),
    generatedCall(yDelta, 'math.subtract', { left: cell.y, right: input('originY') }),
    generatedCall(xDistance, 'math.abs', { value: output(xDelta) }),
    generatedCall(yDistance, 'math.abs', { value: output(yDelta) }),
    generatedCall(xDominates, 'compare.greater-than', { left: output(xDistance), right: output(yDistance) }),
    select(step, output(xDominates), output(xDistance), output(yDistance), numberType),
  )
  const effect = buildRecord(mapBody, fresh, [
    ['x', cell.x, numberType], ['y', cell.y, numberType], ['sourceId', input('sourceId'), 'string'],
    ['tileType', literal(effectType as string), 'string'], ['icon', literal(icon as string), 'string'],
    ['bgColor', literal(bgColor as string), 'string'], ['boxShadow', literal(boxShadow as string), 'string'],
    ['iconPosition', literal(iconPosition as string), 'string'], ['presentation', literal('expand'), 'string'],
    ['presentationStep', output(step), numberType],
    ...(ownerPlayerId ? [['ownerPlayerId', input('ownerPlayerId'), 'player'] as const] : []),
  ], 'marker-effect')
  mapBody.push(returnValue(fresh('marker-effect-return'), effect))
  statements.push(mapCollection(mappedId, cells, mapBody, {
    originX: originCoordinates.x, originY: originCoordinates.y, sourceId,
    ...(ownerPlayerId ? { ownerPlayerId } : {}),
  }))
  const countId = fresh('marker-effect-count')
  const nonemptyId = fresh('marker-effect-nonempty')
  const submittedId = fresh('marker-submit')
  const successId = fresh('marker-success')
  statements.push(
    generatedCall(countId, 'collection.length', { items: output(mappedId) }),
    generatedCall(nonemptyId, 'compare.greater-than', { left: output(countId), right: literal(0) }),
    generatedCall(submittedId, 'tile.batch-records', { records: output(mappedId) }),
    and(successId, output(nonemptyId), output(submittedId, 'success')),
  )
  return { statements, outputs: { success: output(successId) } }
}

function tileEffectMatchesCell(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  effect: GameplayValue,
  cell: GameplayValue,
  tileType: GameplayValue,
  prefix: string,
): GameplayValue {
  const coordinates = cellCoordinates(statements, fresh, cell, prefix + '-cell')
  const typeId = fresh(prefix + '-type')
  const xId = fresh(prefix + '-x')
  const yId = fresh(prefix + '-y')
  statements.push(
    readKey(typeId, effect, 'tileType', nullableStringType),
    readKey(xId, effect, 'x', nullableNumberType),
    readKey(yId, effect, 'y', nullableNumberType),
  )
  const typeMatch = fresh(prefix + '-type-match')
  const xMatch = fresh(prefix + '-x-match')
  const yMatch = fresh(prefix + '-y-match')
  const xyMatch = fresh(prefix + '-xy-match')
  const result = fresh(prefix + '-match')
  statements.push(
    compare(typeMatch, output(typeId), tileType, nullableStringType),
    compare(xMatch, output(xId), coordinates.x, nullableNumberType),
    compare(yMatch, output(yId), coordinates.y, nullableNumberType),
    and(xyMatch, output(xMatch), output(yMatch)),
    and(result, output(typeMatch), output(xyMatch)),
  )
  return output(result)
}

function anchorMatchesCell(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  anchor: GameplayValue,
  cell: GameplayValue,
  prefix: string,
): GameplayValue {
  const coordinates = cellCoordinates(statements, fresh, cell, prefix + '-cell')
  const xId = fresh(prefix + '-x')
  const yId = fresh(prefix + '-y')
  statements.push(
    readKey(xId, anchor, 'x', nullableNumberType),
    readKey(yId, anchor, 'y', nullableNumberType),
  )
  const xMatch = fresh(prefix + '-x-match')
  const yMatch = fresh(prefix + '-y-match')
  const result = fresh(prefix + '-match')
  statements.push(
    compare(xMatch, output(xId), coordinates.x, nullableNumberType),
    compare(yMatch, output(yId), coordinates.y, nullableNumberType),
    and(result, output(xMatch), output(yMatch)),
  )
  return output(result)
}

function emptyCellList(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
): GameplayValue {
  const id = fresh('empty-cell-list')
  statements.push(generatedCall(id, 'collection.concat', { left: literal([]), right: literal([]) }, { valueType: valueTypeParameter(cellListType) }))
  return output(id, 'items')
}

function uniqueCells(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  cells: GameplayValue,
): GameplayValue {
  const initial = emptyCellList(statements, fresh)
  const reducedId = fresh('unique-cells')
  const findBody: GameplayStatement[] = []
  const same = fresh('same-cell')
  findBody.push(generatedCall(same, 'spatial.cell-equal', { left: input('candidate'), right: input('existing') }))
  findBody.push(returnValue(fresh('same-cell-return'), output(same)))
  const found = fresh('existing-cell')
  const present = fresh('existing-cell-present')
  const singletonId = fresh('unique-singleton')
  const appended = fresh('unique-appended')
  const selected = fresh('unique-selected')
  const body: GameplayStatement[] = [
    findCollection(found, input('accumulator'), findBody, { candidate: input('item') }, 'existing'),
    compare(present, output(found), literal(null), nullableCellType, '!='),
    generatedCall(singletonId, 'collection.singleton', { value: input('item') }, { valueType: valueTypeParameter(cellType) }),
    generatedCall(appended, 'collection.concat', { left: input('accumulator'), right: output(singletonId, 'items') }, { valueType: valueTypeParameter(cellListType) }),
    select(selected, output(present), input('accumulator'), output(appended, 'items'), cellListType),
    returnValue(fresh('unique-return'), output(selected)),
  ]
  statements.push(reduceCollection(reducedId, cells, initial, body))
  return output(reducedId)
}

function migrateTileAddPersistentMarkers(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const cells = requiredInput(call, 'cells')
  const tileSourceId = requiredInput(call, 'tileSourceId')
  const effectType = call.parameters?.effectType
  const icon = call.parameters?.icon
  const iconPosition = call.parameters?.iconPosition
  const storageKey = call.parameters?.storageKey
  if (!source || !cells || !tileSourceId || [effectType, icon, iconPosition, storageKey].some(value => typeof value !== 'string') || storageKey !== 'amaterasuCells') return undefined

  const statements: GameplayStatement[] = []
  const extensionsId = fresh('persistent-extensions')
  statements.push(generatedCall(extensionsId, 'battle.extensions'))
  const extensions = output(extensionsId, 'record')
  const existingTiles = readExtensionList(statements, fresh, extensions, 'tileEffects', 'persistent-tiles')
  const existingAnchors = readExtensionList(statements, fresh, extensions, storageKey as string, 'persistent-anchors')

  const mapCellsId = fresh('persistent-map-cells')
  statements.push(generatedCall(mapCellsId, 'spatial.map-cells'))
  const mapValidId = fresh('persistent-map-valid')
  const mapValidBody: GameplayStatement[] = [
    generatedCall(fresh('persistent-cell-in-map'), 'spatial.cell-in-list', { cell: input('item'), cells: input('mapCells') }),
  ]
  mapValidBody.push(returnValue(fresh('persistent-map-valid-return'), output(mapValidBody[0].id)))
  statements.push(filterCollection(mapValidId, cells, mapValidBody, { mapCells: output(mapCellsId, 'cells') }))
  const candidates = uniqueCells(statements, fresh, output(mapValidId))

  const sourceExistsId = fresh('persistent-source-exists')
  const ownerHandleId = fresh('persistent-owner-local')
  statements.push(
    generatedCall(ownerHandleId, 'local.declare', { initial: literal(null) }, { valueType: valueTypeParameter(nullablePlayerType) }),
    generatedCall(sourceExistsId, 'query.has-piece', { pieceId: source }),
  )
  const sourceBranch: GameplayStatement[] = []
  const sourceOwnerId = fresh('persistent-source-owner')
  sourceBranch.push(
    generatedCall(sourceOwnerId, 'piece.field', { piece: source }, { field: 'ownerPlayerId' }),
    generatedCall(fresh('persistent-owner-write'), 'local.write', { handle: output(ownerHandleId, 'handle'), value: output(sourceOwnerId) }, { valueType: valueTypeParameter(nullablePlayerType) }),
  )
  statements.push(ifStatement(fresh('persistent-source-owner-branch'), output(sourceExistsId, 'exists'), sourceBranch))
  const ownerReadId = fresh('persistent-owner-read')
  const sourceTextId = fresh('persistent-source-id-text')
  statements.push(
    generatedCall(ownerReadId, 'local.read', { handle: output(ownerHandleId, 'handle') }, { valueType: valueTypeParameter(nullablePlayerType) }),
    generatedCall(sourceTextId, 'text.from-value', { value: source }, { valueType: 'piece' }),
  )

  const tileCellsId = fresh('persistent-new-tile-cells')
  const tilePredicate: GameplayStatement[] = []
  const tileFoundId = fresh('persistent-existing-tile')
  const tileMatchBody: GameplayStatement[] = []
  const tileMatch = tileEffectMatchesCell(tileMatchBody, fresh, input('candidate'), input('cell'), input('tileType'), 'persistent-tile-match')
  tileMatchBody.push(returnValue(fresh('persistent-tile-match-return'), tileMatch))
  tilePredicate.push(findCollection(tileFoundId, input('tiles'), tileMatchBody, { cell: input('item'), tileType: input('tileType') }, 'candidate'))
  const tileAbsentId = fresh('persistent-tile-absent')
  tilePredicate.push(compare(tileAbsentId, output(tileFoundId), literal(null), nullableRecordType))
  tilePredicate.push(returnValue(fresh('persistent-tile-absent-return'), output(tileAbsentId)))
  statements.push(filterCollection(tileCellsId, candidates, tilePredicate, { tiles: existingTiles, tileType: literal(effectType as string) }))

  const anchorCellsId = fresh('persistent-new-anchor-cells')
  const anchorPredicate: GameplayStatement[] = []
  const anchorFoundId = fresh('persistent-existing-anchor')
  const anchorMatchBody: GameplayStatement[] = []
  const anchorMatch = anchorMatchesCell(anchorMatchBody, fresh, input('candidate'), input('cell'), 'persistent-anchor-match')
  anchorMatchBody.push(returnValue(fresh('persistent-anchor-match-return'), anchorMatch))
  anchorPredicate.push(findCollection(anchorFoundId, input('anchors'), anchorMatchBody, { cell: input('item') }, 'candidate'))
  const anchorAbsentId = fresh('persistent-anchor-absent')
  anchorPredicate.push(compare(anchorAbsentId, output(anchorFoundId), literal(null), nullableRecordType))
  anchorPredicate.push(returnValue(fresh('persistent-anchor-absent-return'), output(anchorAbsentId)))
  statements.push(filterCollection(anchorCellsId, candidates, anchorPredicate, { anchors: existingAnchors }))

  const tileRecordsId = fresh('persistent-tile-records')
  const tileRecordBody: GameplayStatement[] = []
  const tileCoordinates = cellCoordinates(tileRecordBody, fresh, input('item'), 'persistent-tile')
  const tileRecord = buildRecord(tileRecordBody, fresh, [
    ['x', tileCoordinates.x, numberType], ['y', tileCoordinates.y, numberType],
    ['sourceId', input('tileSourceId'), 'string'], ['tileType', literal(effectType as string), 'string'],
    ['icon', literal(icon as string), 'string'], ['iconPosition', literal(iconPosition as string), 'string'],
  ], 'persistent-tile-record')
  tileRecordBody.push(returnValue(fresh('persistent-tile-record-return'), tileRecord))
  statements.push(mapCollection(tileRecordsId, output(tileCellsId), tileRecordBody, { tileSourceId }))

  const anchorRecordsId = fresh('persistent-anchor-records')
  const anchorRecordBody: GameplayStatement[] = []
  const anchorCoordinates = cellCoordinates(anchorRecordBody, fresh, input('item'), 'persistent-anchor')
  const anchorRecord = buildRecord(anchorRecordBody, fresh, [
    ['x', anchorCoordinates.x, numberType], ['y', anchorCoordinates.y, numberType],
    ['sourcePieceId', input('sourcePieceId'), 'string'], ['ownerPlayerId', input('ownerPlayerId'), nullablePlayerType],
  ], 'persistent-anchor-record')
  const ownerPresentId = fresh('persistent-owner-present')
  const ownerWithoutFieldId = fresh('persistent-anchor-without-owner')
  anchorRecordBody.push(compare(ownerPresentId, input('ownerPlayerId'), literal(null), nullablePlayerType, '!='))
  anchorRecordBody.push(generatedCall(ownerWithoutFieldId, 'data.omit-key', {
    record: anchorRecord, key: literal('ownerPlayerId'),
  }))
  anchorRecordBody.push(ifStatement(fresh('persistent-owner-field-branch'), output(ownerPresentId), [
    returnValue(fresh('persistent-anchor-with-owner-return'), anchorRecord),
  ], [
    returnValue(fresh('persistent-anchor-without-owner-return'), output(ownerWithoutFieldId)),
  ]))
  statements.push(mapCollection(anchorRecordsId, output(anchorCellsId), anchorRecordBody, {
    sourcePieceId: output(sourceTextId, 'text'), ownerPlayerId: output(ownerReadId, 'value'),
  }))

  const emptyAnchorsId = fresh('persistent-empty-anchors')
  statements.push(generatedCall(emptyAnchorsId, 'extension.declare-battle', { value: literal([]) }, {
    namespace: '', name: storageKey as string, valueType: valueTypeParameter(recordListType),
  }, '2'))
  const nextAnchorsId = fresh('persistent-next-anchors')
  statements.push(generatedCall(nextAnchorsId, 'collection.concat', {
    left: existingAnchors, right: output(anchorRecordsId),
  }, { valueType: valueTypeParameter(recordListType) }))
  const writeAnchorsId = fresh('persistent-write-anchors')
  statements.push(generatedCall(writeAnchorsId, 'extension.write-battle', { value: output(nextAnchorsId, 'items') }, {
    namespace: '', name: storageKey as string, valueType: valueTypeParameter(recordListType),
  }, '2'))
  const submitTilesId = fresh('persistent-submit-tiles')
  statements.push(generatedCall(submitTilesId, 'tile.batch-records', { records: output(tileRecordsId) }))
  const addedId = fresh('persistent-added-count')
  statements.push(generatedCall(addedId, 'collection.length', { items: output(anchorRecordsId) }))
  return { statements, outputs: { added: output(addedId) } }
}

function migrateAnchorPlace(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const cell = requiredInput(call, 'cell')
  if (!source || !cell) return undefined
  const storageKey = call.parameters?.storageKey
  const tileType = call.parameters?.tileType
  const maxAnchors = call.parameters?.maxAnchors === undefined ? 3 : call.parameters.maxAnchors
  if (storageKey !== 'minatoAnchors' || typeof tileType !== 'string' || typeof maxAnchors !== 'number' || !Number.isSafeInteger(maxAnchors) || maxAnchors < 1) return undefined

  const statements: GameplayStatement[] = []
  const sourceId = fresh('source-resolved')
  const coordinatesId = fresh('coordinates')
  statements.push(
    generatedCall(sourceId, 'piece.resolve-including-graveyard', { piece: source }),
    generatedCall(coordinatesId, 'spatial.cell-coordinates', { cell }),
  )
  const state = extensionState(statements, fresh, storageKey)

  // The ordinary resolver/coordinate calls carry the dependency validity. A
  // missing historical piece or malformed cell invalidates this find and the
  // enclosing branch, so no authored found/valid fallback is needed.
  const existingId = fresh('existing-anchor')
  const existingBody: GameplayStatement[] = []
  const existingMatch = matchAnchor(existingBody, fresh, input('item'), input('sourceId'), input('x'), input('y'), 'existing')
  existingBody.push(returnValue(fresh('existing-return'), existingMatch))
  statements.push(findCollection(existingId, state.anchors, existingBody, {
    sourceId: output(sourceId, 'id'),
    x: output(coordinatesId, 'x'),
    y: output(coordinatesId, 'y'),
  }))
  const existingPresentId = fresh('existing-present')
  statements.push(compare(existingPresentId, output(existingId), literal(null), nullableRecordType, '!='))

  const resultHandleId = fresh('place-result-local')
  statements.push(generatedCall(resultHandleId, 'local.declare', {}, { valueType: 'boolean' }))

  const appendTileAndCommit = (
    branch: GameplayStatement[],
    candidateAnchors: GameplayValue,
    suffix: string,
  ): void => {
    const currentTileFilterId = fresh(suffix + '-replace-current-tile')
    const currentTileBody: GameplayStatement[] = []
    const currentTileMatch = matchTileAtCell(currentTileBody, fresh, input('item'), input('sourceId'), input('x'), input('y'), tileType, suffix + '-current-tile')
    const keepCurrentTileId = fresh(suffix + '-keep-current-tile')
    currentTileBody.push(
      generatedCall(keepCurrentTileId, 'logic.not', { value: currentTileMatch }),
      returnValue(fresh(suffix + '-current-tile-return'), output(keepCurrentTileId)),
    )
    branch.push(filterCollection(currentTileFilterId, state.tiles, currentTileBody, {
      sourceId: output(sourceId, 'id'),
      x: output(coordinatesId, 'x'),
      y: output(coordinatesId, 'y'),
    }))

    const newTile = buildRecord(branch, fresh, [
      ['x', output(coordinatesId, 'x'), 'number'], ['y', output(coordinatesId, 'y'), 'number'],
      ['sourceId', output(sourceId, 'id'), nullableStringType], ['tileType', literal(tileType), 'string'],
      ['icon', literal('⚡'), 'string'], ['bgColor', literal('rgba(250, 204, 21, 0.14)'), 'string'],
      ['boxShadow', literal('inset 0 0 0 2px rgba(250, 204, 21, 0.75)'), 'string'], ['iconPosition', literal('top-left'), 'string'],
    ], suffix + '-new-tile')
    const singleTileId = fresh(suffix + '-single-tile')
    const candidateTilesId = fresh(suffix + '-candidate-tiles')
    branch.push(
      generatedCall(singleTileId, 'collection.singleton', { value: newTile }, { valueType: 'record' }),
      generatedCall(candidateTilesId, 'collection.concat', { left: output(currentTileFilterId), right: output(singleTileId, 'items') }, { valueType: valueTypeParameter(recordListType) }),
    )

    const trimmed = trimToCapacity(branch, fresh, candidateAnchors, output(candidateTilesId, 'items'), output(sourceId, 'id'), tileType, maxAnchors)
    const commitId = fresh(suffix + '-commit')
    branch.push(generatedCall(commitId, 'extension.commit-root-with-tiles', {
      root: trimmed.anchors, tiles: trimmed.tiles,
    }, { storageKey }))
    branch.push(generatedCall(fresh(suffix + '-result-write'), 'local.write', {
      handle: output(resultHandleId, 'handle'), value: output(commitId, 'success'),
    }, { valueType: 'boolean' }))
  }

  const existingBranch: GameplayStatement[] = []
  const existingNowId = fresh('existing-sample-time')
  existingBranch.push(generatedCall(existingNowId, 'identity.host-time'))
  const refreshedId = fresh('refreshed-anchors')
  const refreshedBody: GameplayStatement[] = []
  const sameExistingId = fresh('same-existing')
  const refreshedRecordId = fresh('refreshed-record')
  const selectedId = fresh('selected-anchor')
  refreshedBody.push(
    compare(sameExistingId, input('item'), input('existing'), nullableRecordType),
    setField(refreshedRecordId, input('item'), 'createdAt', input('now'), 'number'),
    select(selectedId, output(sameExistingId), output(refreshedRecordId, 'record'), input('item'), recordType),
    returnValue(fresh('refresh-return'), output(selectedId)),
  )
  existingBranch.push(mapCollection(refreshedId, state.anchors, refreshedBody, { existing: output(existingId), now: output(existingNowId) }))
  appendTileAndCommit(existingBranch, output(refreshedId), 'place-existing')

  const newBranch: GameplayStatement[] = []
  const newNowId = fresh('new-sample-time')
  newBranch.push(generatedCall(newNowId, 'identity.host-time'))
  const newAnchor = buildRecord(newBranch, fresh, [
    ['x', output(coordinatesId, 'x'), 'number'], ['y', output(coordinatesId, 'y'), 'number'],
    ['sourceId', output(sourceId, 'id'), nullableStringType], ['ownerPlayerId', output(sourceId, 'ownerPlayerId'), { kind: 'nullable', value: 'player' }], ['createdAt', output(newNowId), 'number'],
  ], 'new-anchor')
  const singleAnchorId = fresh('single-anchor')
  const appendedId = fresh('appended-anchors')
  newBranch.push(
    generatedCall(singleAnchorId, 'collection.singleton', { value: newAnchor }, { valueType: 'record' }),
    generatedCall(appendedId, 'collection.concat', { left: state.anchors, right: output(singleAnchorId, 'items') }, { valueType: valueTypeParameter(recordListType) }),
  )
  appendTileAndCommit(newBranch, output(appendedId, 'items'), 'place-new')

  statements.push(ifStatement(fresh('place-existing-or-new'), output(existingPresentId), existingBranch, newBranch))
  const resultReadId = fresh('place-result-read')
  statements.push(generatedCall(resultReadId, 'local.read', { handle: output(resultHandleId, 'handle') }, { valueType: 'boolean' }))
  return { statements, outputs: { success: output(resultReadId, 'value') } }
}

function migrateAnchorRemove(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const cell = requiredInput(call, 'cell')
  if (!source || !cell) return undefined
  const storageKey = call.parameters?.storageKey
  const tileType = call.parameters?.tileType
  if (storageKey !== 'minatoAnchors' || typeof tileType !== 'string') return undefined

  const statements: GameplayStatement[] = []
  const sourceId = fresh('source-resolved')
  const coordinatesId = fresh('coordinates')
  statements.push(
    generatedCall(sourceId, 'piece.resolve-including-graveyard', { piece: source }),
    generatedCall(coordinatesId, 'spatial.cell-coordinates', { cell }),
  )
  const state = extensionState(statements, fresh, storageKey)
  const resultHandleId = fresh('remove-result-local')
  // A remove result is successful only after the atomic root/tile commit
  // reports success. Invalid dependencies leave this default untouched.
  statements.push(generatedCall(resultHandleId, 'local.declare', {}, { valueType: 'boolean' }))

  const filteredAnchorsId = fresh('removed-anchors')
  const anchorBody: GameplayStatement[] = []
  const anchorMatch = matchAnchor(anchorBody, fresh, input('item'), input('sourceId'), input('x'), input('y'), 'remove-anchor')
  const keepAnchorId = fresh('keep-anchor')
  anchorBody.push(generatedCall(keepAnchorId, 'logic.not', { value: anchorMatch }), returnValue(fresh('remove-anchor-return'), output(keepAnchorId)))
  statements.push(filterCollection(filteredAnchorsId, state.anchors, anchorBody, {
    sourceId: output(sourceId, 'id'),
    x: output(coordinatesId, 'x'),
    y: output(coordinatesId, 'y'),
  }))

  const filteredTilesId = fresh('removed-tiles')
  const tileBody: GameplayStatement[] = []
  const tileMatch = matchTileAtCell(tileBody, fresh, input('item'), input('sourceId'), input('x'), input('y'), tileType, 'remove-tile')
  const keepTileId = fresh('keep-tile')
  tileBody.push(generatedCall(keepTileId, 'logic.not', { value: tileMatch }), returnValue(fresh('remove-tile-return'), output(keepTileId)))
  statements.push(filterCollection(filteredTilesId, state.tiles, tileBody, {
    sourceId: output(sourceId, 'id'),
    x: output(coordinatesId, 'x'),
    y: output(coordinatesId, 'y'),
  }))

  const commitId = fresh('remove-commit')
  statements.push(generatedCall(commitId, 'extension.commit-root-with-tiles', {
    root: output(filteredAnchorsId), tiles: output(filteredTilesId),
  }, { storageKey }))
  statements.push(generatedCall(fresh('remove-result-write'), 'local.write', {
    handle: output(resultHandleId, 'handle'), value: output(commitId, 'success'),
  }, { valueType: 'boolean' }))
  const resultReadId = fresh('remove-result-read')
  statements.push(generatedCall(resultReadId, 'local.read', { handle: output(resultHandleId, 'handle') }, { valueType: 'boolean' }))
  return { statements, outputs: { success: output(resultReadId, 'value') } }
}

/**
 * Expand the legacy source-mark helper into a typed read/update/add graph.
 * Existing records are updated through the no-event compatibility setter;
 * only the add branch calls the status lifecycle, matching the old event
 * behavior and avoiding a second afterStatusApplied notification.
 */
function migrateStatusMarkApply(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(call, 'target')
  const source = requiredInput(call, 'source')
  const statusType = call.parameters?.statusType
  const statusName = call.parameters?.statusName
  const statusIdPrefix = call.parameters?.statusIdPrefix
  if (!target || !source || typeof statusType !== 'string' || typeof statusName !== 'string' || typeof statusIdPrefix !== 'string') return undefined

  const targetRequired = fresh('mark-target-required')
  const sourceRequired = fresh('mark-source-required')
  const targetId = fresh('mark-target-id')
  const sourceId = fresh('mark-source-id')
  const statusesId = fresh('mark-statuses')
  const existingId = fresh('mark-existing')
  const existingPresent = fresh('mark-existing-present')

  // Resolve nullable author references through the ordinary engine guard.  A
  // missing target/source makes the dependent calls invalid and therefore
  // skips the tail without manufacturing a legacy false result.
  const statements: GameplayStatement[] = [
    generatedCall(targetRequired, 'piece.require', { piece: target }),
    generatedCall(sourceRequired, 'piece.require', { piece: source }),
    generatedCall(targetId, 'piece.field', { piece: output(targetRequired, 'piece') }, { field: 'instanceId' }),
    generatedCall(sourceId, 'piece.field', { piece: output(sourceRequired, 'piece') }, { field: 'instanceId' }),
    generatedCall(statusesId, 'status.query-instances', {
      piece: output(targetRequired, 'piece'), source: output(sourceRequired, 'piece'),
    }, { statusType }),
  ]
  const existingBody: GameplayStatement[] = [returnValue(fresh('mark-find-return'), literal(true))]
  statements.push(findCollection(existingId, output(statusesId, 'statuses'), existingBody))
  statements.push(compare(existingPresent, output(existingId), literal(null), nullableStatusType, '!='))
  const resultHandleId = fresh('mark-result-local')
  statements.push(generatedCall(resultHandleId, 'local.declare', {}, { valueType: 'boolean' }))

  const existingBranch: GameplayStatement[] = []
  const existingStacks = fresh('mark-existing-stacks')
  const existingStacksNonzero = fresh('mark-existing-stacks-nonzero')
  const existingStacksTruthyValue = fresh('mark-existing-stacks-truthy-value')
  const nextStacks = fresh('mark-next-stacks')
  const existingStacksSet = fresh('mark-existing-stacks-set')
  const existingDurationSet = fresh('mark-existing-duration-set')
  const existingResult = fresh('mark-existing-result')
  existingBranch.push(
    generatedCall(existingStacks, 'status.read-number-instance', {
      status: output(existingId), fallback: literal(1),
    }, { field: 'stacks' }),
    compare(existingStacksNonzero, output(existingStacks), literal(0), 'number', '!='),
    select(existingStacksTruthyValue, output(existingStacksNonzero), output(existingStacks), literal(1), 'number'),
    generatedCall(nextStacks, 'math.add', { left: output(existingStacksTruthyValue), right: literal(1) }),
    generatedCall(existingStacksSet, 'status.set-number-instance', {
      status: output(existingId), value: output(nextStacks),
    }, { field: 'stacks' }),
    generatedCall(existingDurationSet, 'status.set-number-instance', {
      status: output(existingId), value: literal(-1),
    }, { field: 'currentDuration' }),
    and(existingResult, output(existingStacksSet, 'success'), output(existingDurationSet, 'success')),
    generatedCall(fresh('mark-existing-result-write'), 'local.write', {
      handle: output(resultHandleId, 'handle'), value: output(existingResult),
    }, { valueType: 'boolean' }),
  )

  const newBranch: GameplayStatement[] = []
  const nowId = fresh('mark-now')
  const nowTextId = fresh('mark-now-text')
  const prefixTextId = fresh('mark-prefix-text')
  const prefixSourceId = fresh('mark-prefix-source')
  const prefixSourceTargetId = fresh('mark-prefix-source-target')
  const statusIdText = fresh('mark-status-id')
  const fullStatusId = fresh('mark-full-status-id')
  const idWithTime = fresh('mark-id-with-time')
  newBranch.push(
    generatedCall(nowId, 'identity.host-time'),
    textFromValue(nowTextId, output(nowId), 'number'),
    textConcat(prefixTextId, literal(statusIdPrefix), literal('-')),
    textConcat(prefixSourceId, output(prefixTextId, 'text'), output(sourceId, 'value')),
    textConcat(prefixSourceTargetId, output(prefixSourceId, 'text'), literal('-')),
    textConcat(statusIdText, output(prefixSourceTargetId, 'text'), output(targetId, 'value')),
    textConcat(fullStatusId, output(statusIdText, 'text'), literal('-')),
    textConcat(idWithTime, output(fullStatusId, 'text'), output(nowTextId, 'text')),
  )
  const newRecord = buildRecord(newBranch, fresh, [
    ['id', output(idWithTime, 'text'), 'string'],
    ['type', literal(statusType), 'string'],
    ['name', literal(statusName), 'string'],
    ['visible', literal(true), 'boolean'],
    ['currentDuration', literal(-1), 'number'],
    ['currentUses', literal(-1), 'number'],
    ['intensity', literal(1), 'number'],
    ['stacks', literal(1), 'number'],
    ['sourceId', output(sourceId, 'value'), 'string'],
  ], 'mark-new-record')
  const addResult = fresh('mark-add-result')
  newBranch.push(generatedCall(addResult, 'status.apply-record', {
    target: output(targetRequired, 'piece'), record: newRecord,
  }, { inputPolicy: 'host' }))
  newBranch.push(generatedCall(fresh('mark-add-result-write'), 'local.write', {
    handle: output(resultHandleId, 'handle'), value: output(addResult, 'success'),
  }, { valueType: 'boolean' }))

  statements.push(ifStatement(fresh('mark-existing-branch'), output(existingPresent), existingBranch, newBranch))
  const resultReadId = fresh('mark-result-read')
  statements.push(generatedCall(resultReadId, 'local.read', { handle: output(resultHandleId, 'handle') }, { valueType: 'boolean' }))
  return { statements, outputs: { success: output(resultReadId, 'value') } }
}

export const ATOMIC_MARKER_WRITE_MODULES = new Set([
  'marker.anchor-place', 'marker.anchor-remove', 'status.mark-apply',
  'tile.add-marker', 'tile.clear-marker', 'tile.add-markers', 'tile.add-persistent-markers',
])
export const ATOMIC_MARKER_WRITE_MODULE_IDS = ATOMIC_MARKER_WRITE_MODULES
export const ATOMIC_MARKER_MODULES = ATOMIC_MARKER_WRITE_MODULES

export const atomicMarkerWritesRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  if (call.module === 'marker.anchor-place') return migrateAnchorPlace(call, fresh)
  if (call.module === 'marker.anchor-remove') return migrateAnchorRemove(call, fresh)
  if (call.module === 'status.mark-apply') return migrateStatusMarkApply(call, fresh)
  if (call.module === 'tile.add-marker') return migrateTileAddMarker(call, fresh)
  if (call.module === 'tile.clear-marker') return migrateTileClearMarker(call, fresh)
  if (call.module === 'tile.add-markers') return migrateTileAddMarkers(call, fresh)
  if (call.module === 'tile.add-persistent-markers') return migrateTileAddPersistentMarkers(call, fresh)
  return undefined
}

export function migrateMarkerWriteModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicMarkerWritesRecipe)
}

export const migrateMarkerWrites = migrateMarkerWriteModules
