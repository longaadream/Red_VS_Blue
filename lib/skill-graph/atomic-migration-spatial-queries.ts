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

/**
 * Spatial and template query wrappers in this family only combined ordinary
 * map, field, query and collection facts.  Keep their ids as migration
 * markers while lowering the policy into the public graph vocabulary.
 */
export const ATOMIC_SPATIAL_QUERY_MODULES = new Set([
  'spatial.walkable-cells',
  'spatial.nearest-adjacent-landing',
  'spatial.random-adjacent-landing',
  'marker.anchor-candidates',
  'marker.nearby-enemies',
  'query.living-template',
  'query.living-template-faction',
  'piece.by-template',
  'spatial.cell-terrain-in',
])

export const ATOMIC_SPATIAL_QUERY_MODULE_IDS = ATOMIC_SPATIAL_QUERY_MODULES

const playerType: GameplayValueType = 'player'
const cellType: GameplayValueType = 'cell'
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const nullableCellType: GameplayValueType = { kind: 'nullable', value: cellType }
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: playerType }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function typeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function finalCall(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
  version = '1',
): GameplayCallStatement {
  return { ...original, module, version, inputs, parameters }
}

function requiredInput(node: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = node.inputs?.[name]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value') ? value : undefined
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0 ? value : undefined
  return record.kind === 'output' && typeof record.node === 'string' && record.node.length > 0
    && typeof record.port === 'string' && record.port.length > 0 ? value : undefined
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  valueType: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType: typeParameter(valueType), operator })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.and', { left, right })
}

function or(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.or', { left, right })
}

function not(id: string, value: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.not', { value })
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function collection(
  id: string,
  method: 'map' | 'filter' | 'find',
  items: GameplayValue,
  body: readonly GameplayStatement[],
  options: {
    readonly item?: string
    readonly index?: string
    readonly inputs?: Readonly<Record<string, GameplayValue>>
  } = {},
): GameplayStatement {
  return {
    kind: 'collection', id, method, items,
    item: options.item ?? 'item',
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    body,
  }
}

function field(id: string, piece: GameplayValue, name: string): GameplayCallStatement {
  return call(id, 'piece.field', { piece }, { field: name }, '1')
}

function queryPieces(
  id: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return call(id, 'query.pieces', inputs, parameters)
}

function coordinates(id: string, cell: GameplayValue, safe = false): GameplayCallStatement {
  return call(id, safe ? 'spatial.cell-coordinates-safe' : 'spatial.cell-coordinates', { cell })
}

function cellFromXY(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  x: GameplayValue,
  y: GameplayValue,
): GameplayValue {
  const id = fresh('cell')
  statements.push(call(id, 'spatial.cell', { x, y }))
  return output(id, 'cell')
}

function offset(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  value: GameplayValue,
  amount: number,
): GameplayValue {
  if (amount === 0) return value
  const id = fresh(amount > 0 ? 'coordinate-add' : 'coordinate-subtract')
  statements.push(call(id, amount > 0 ? 'math.add' : 'math.subtract', {
    left: value,
    right: literal(Math.abs(amount)),
  }))
  return output(id)
}

function singleton(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  value: GameplayValue,
): GameplayValue {
  const id = fresh('singleton')
  statements.push(call(id, 'collection.singleton', { value }, { valueType: typeParameter(cellType) }))
  return output(id, 'items')
}

function concat(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  left: GameplayValue,
  right: GameplayValue,
): GameplayValue {
  const id = fresh('concat')
  statements.push(call(id, 'collection.concat', { left, right }, { valueType: typeParameter(cellListType) }))
  return output(id, 'items')
}

function adjacentCells(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  x: GameplayValue,
  y: GameplayValue,
  diagonal: boolean,
): GameplayValue {
  const offsets: readonly (readonly [number, number])[] = diagonal
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]]
  let result = singleton(statements, fresh, cellFromXY(
    statements, fresh, offset(statements, fresh, x, offsets[0][0]), offset(statements, fresh, y, offsets[0][1]),
  ))
  for (const [dx, dy] of offsets.slice(1)) {
    result = concat(statements, fresh, result, singleton(statements, fresh, cellFromXY(
      statements, fresh, offset(statements, fresh, x, dx), offset(statements, fresh, y, dy),
    )))
  }
  return result
}

function sortByCoordinate(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  items: GameplayValue,
  coordinate: 'x' | 'y',
  suffix: string,
): GameplayValue {
  const keys = fresh(`${suffix}-${coordinate}-keys`)
  const body: GameplayStatement[] = []
  const point = fresh(`${suffix}-${coordinate}-coordinates`)
  body.push(coordinates(point, input('item')))
  body.push(returnValue(fresh(`${suffix}-${coordinate}-key`), output(point, coordinate)))
  statements.push(collection(keys, 'map', items, body, { item: 'item' }))
  const sorted = fresh(`${suffix}-${coordinate}-sorted`)
  statements.push(call(sorted, 'collection.sort', { items, keys: output(keys) }, {
    comparison: 'numeric', order: 'ascending',
  }, '2'))
  return output(sorted, 'items')
}

function sortByDistance(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  items: GameplayValue,
  reference: GameplayValue,
): GameplayValue {
  const keys = fresh('distance-keys')
  const keyBody: GameplayStatement[] = []
  const distance = fresh('distance-key')
  keyBody.push(call(distance, 'spatial.cell-distance', { from: input('item'), to: input('reference') }))
  keyBody.push(returnValue(fresh('distance-key-return'), output(distance, 'distance')))
  statements.push(collection(keys, 'map', items, keyBody, { item: 'item', inputs: { reference } }))
  const sorted = fresh('distance-sorted')
  statements.push(call(sorted, 'collection.sort', { items, keys: output(keys) }, {
    comparison: 'numeric', order: 'ascending',
  }, '2'))
  return output(sorted, 'items')
}

function walkableReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const map = fresh('map-cells')
  const filtered = node.id
  const body: GameplayStatement[] = [call(map, 'spatial.map-cells')]
  const filterBody: GameplayStatement[] = [
    call(fresh('walkable'), 'spatial.cell-walkable', { cell: input('item') }),
  ]
  filterBody.push(returnValue(fresh('walkable-return'), output(filterBody[0].id, 'walkable')))
  body.push(collection(filtered, 'filter', output(map, 'cells'), filterBody, { item: 'item' }))

  // The host sorts y first and x second.  Stable two-pass sorting expresses the
  // same ordering while retaining the ordinary collection sort primitive.
  const xSorted = sortByCoordinate(body, fresh, output(filtered), 'x', 'walkable')
  const ySorted = sortByCoordinate(body, fresh, xSorted, 'y', 'walkable')
  return { statements: body, outputs: { cells: ySorted } }
}

function anchorReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(node, 'source')
  if (!source) return undefined
  const rawRange = node.parameters?.range
  const range = rawRange === undefined ? 7 : rawRange
  if (typeof range !== 'number' || !Number.isFinite(range) || range < 0) return undefined
  const order = node.parameters?.order === undefined ? 'yx' : node.parameters.order
  if (order !== 'map' && order !== 'yx') return undefined

  const map = fresh('map-cells')
  const filtered = order === 'map' ? node.id : fresh('anchor-candidates')
  const body: GameplayStatement[] = [call(map, 'spatial.map-cells')]
  const filterBody: GameplayStatement[] = []
  const exists = fresh('source-exists')
  filterBody.push(call(exists, 'query.has-piece', { pieceId: input('source') }))
  const then: GameplayStatement[] = []
  const sourceX = fresh('source-x')
  const sourceY = fresh('source-y')
  const sourceCell = fresh('source-cell')
  then.push(field(sourceX, input('source'), 'x'), field(sourceY, input('source'), 'y'))
  then.push(call(sourceCell, 'spatial.cell', { x: output(sourceX), y: output(sourceY) }))
  const walkable = fresh('anchor-walkable')
  const distance = fresh('anchor-distance')
  const unoccupied = fresh('anchor-unoccupied')
  then.push(call(walkable, 'spatial.cell-walkable', { cell: input('item') }))
  then.push(call(distance, 'spatial.cell-distance', { from: output(sourceCell, 'cell'), to: input('item') }))
  then.push(call(fresh('anchor-in-range'), 'compare.less-or-equal', { left: output(distance, 'distance'), right: literal(range) }))
  then.push(call(unoccupied, 'spatial.cell-unoccupied', { cell: input('item') }))
  const inRange = then[then.length - 2] as GameplayCallStatement
  const first = fresh('anchor-first')
  const second = fresh('anchor-second')
  then.push(and(first, output(walkable, 'walkable'), output(inRange.id)))
  then.push(and(second, output(first), output(unoccupied)))
  then.push(returnValue(fresh('anchor-return'), output(second)))
  filterBody.push({ kind: 'if', id: fresh('source-branch'), condition: output(exists, 'exists'), then, else: [returnValue(fresh('source-missing-return'), literal(false))] })
  body.push(collection(filtered, 'filter', output(map, 'cells'), filterBody, { item: 'item', inputs: { source } }))
  if (order === 'map') return { statements: body, outputs: { cells: output(node.id) } }

  const xSorted = sortByCoordinate(body, fresh, output(filtered), 'x', 'anchor')
  const ySorted = sortByCoordinate(body, fresh, xSorted, 'y', 'anchor')
  return { statements: body, outputs: { cells: ySorted } }
}

function nearestReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(node, 'target')
  const reference = requiredInput(node, 'reference')
  if (!target || !reference) return undefined
  const rawDiagonal = node.parameters?.diagonal
  const diagonal = rawDiagonal === undefined ? true : rawDiagonal
  if (typeof diagonal !== 'boolean') return undefined
  const targetX = fresh('target-x')
  const targetY = fresh('target-y')
  const body: GameplayStatement[] = [field(targetX, target, 'x'), field(targetY, target, 'y')]
  const referenceCoordinates = fresh('reference-coordinates')
  body.push(coordinates(referenceCoordinates, reference, true))
  const safeReference = fresh('safe-reference')
  body.push(call(safeReference, 'spatial.cell', {
    x: output(referenceCoordinates, 'x'), y: output(referenceCoordinates, 'y'),
  }))
  const referencePresent = fresh('reference-present')
  body.push(compare(referencePresent, reference, literal(null), nullableCellType, '!='))
  const candidates = adjacentCells(body, fresh, output(targetX), output(targetY), diagonal)
  const sortedCandidates = sortByDistance(body, fresh, candidates, output(safeReference, 'cell'))
  const findBody: GameplayStatement[] = []
  const walkable = fresh('nearest-walkable')
  const unoccupied = fresh('nearest-unoccupied')
  findBody.push(call(walkable, 'spatial.cell-walkable', { cell: input('item') }))
  const ignore = requiredInput(node, 'ignore')
  findBody.push(call(unoccupied, 'spatial.cell-unoccupied', {
    cell: input('item'),
    ...(ignore ? { ignore: input('ignore') } : {}),
  }))
  const legal = fresh('nearest-legal')
  findBody.push(and(legal, output(walkable, 'walkable'), output(unoccupied, 'value')))
  findBody.push(returnValue(fresh('nearest-return'), output(legal)))
  const found = fresh('nearest-found')
  const findInputs: Record<string, GameplayValue> = {}
  if (ignore) findInputs.ignore = ignore
  body.push(collection(found, 'find', sortedCandidates, findBody, { item: 'item', inputs: findInputs }))
  body.push(finalCall(node, 'logic.select', {
    condition: output(referencePresent), whenTrue: output(found), whenFalse: literal(null),
  }, { valueType: typeParameter(nullableCellType) }))
  return {
    statements: body,
    outputs: { cell: output(node.id) },
  }
}

function randomReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(node, 'target')
  if (!target) return undefined
  const targetX = fresh('target-x')
  const targetY = fresh('target-y')
  const body: GameplayStatement[] = [field(targetX, target, 'x'), field(targetY, target, 'y')]
  const reserved = fresh('reserved-cells')
  body.push(call(reserved, 'context.field', {}, { field: 'reservedCells' }, '2'))
  const candidates = adjacentCells(body, fresh, output(targetX), output(targetY), false)
  const filtered = fresh('landing-candidates')
  const filterBody: GameplayStatement[] = []
  const walkable = fresh('landing-walkable')
  const unoccupied = fresh('landing-unoccupied')
  filterBody.push(call(walkable, 'spatial.cell-walkable', { cell: input('item') }))
  const ignore = requiredInput(node, 'ignore')
  filterBody.push(call(unoccupied, 'spatial.cell-unoccupied', {
    cell: input('item'),
    ...(ignore ? { ignore: input('ignore') } : {}),
  }))
  const matches = fresh('reserved-match')
  const matchBody: GameplayStatement[] = []
  const candidateCoordinates = fresh('candidate-coordinates')
  const reservedCoordinates = fresh('reserved-coordinates')
  matchBody.push(coordinates(candidateCoordinates, input('candidate')))
  matchBody.push(coordinates(reservedCoordinates, input('reservedCell')))
  const sameX = fresh('reserved-x-match')
  const sameY = fresh('reserved-y-match')
  matchBody.push(compare(sameX, output(candidateCoordinates, 'x'), output(reservedCoordinates, 'x'), 'number'))
  matchBody.push(compare(sameY, output(candidateCoordinates, 'y'), output(reservedCoordinates, 'y'), 'number'))
  const same = fresh('reserved-cell-match')
  matchBody.push(and(same, output(sameX), output(sameY)))
  matchBody.push(returnValue(fresh('reserved-match-return'), output(same)))
  filterBody.push(collection(matches, 'find', input('reservedList'), matchBody, {
    item: 'reservedCell', inputs: { candidate: input('item'), reservedList: input('reservedList') },
  }))
  const noReserved = fresh('not-reserved')
  filterBody.push(compare(noReserved, output(matches), literal(null), nullableCellType, '=='))
  const first = fresh('landing-walkable-and-empty')
  filterBody.push(and(first, output(walkable, 'walkable'), output(unoccupied, 'value')))
  const legal = fresh('landing-legal')
  filterBody.push(and(legal, output(first), output(noReserved)))
  filterBody.push(returnValue(fresh('landing-return'), output(legal)))
  const filterInputs: Record<string, GameplayValue> = { reservedList: output(reserved, 'value') }
  if (ignore) filterInputs.ignore = ignore
  body.push(collection(filtered, 'filter', candidates, filterBody, { item: 'item', inputs: filterInputs }))
  body.push(finalCall(node, 'collection.random', { items: output(filtered) }, {}, '1'))
  return { statements: body, outputs: { cell: output(node.id, 'value') } }
}

function nearbyEnemiesReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(node, 'source')
  const cell = requiredInput(node, 'cell')
  if (!source || !cell) return undefined
  const rawRange = node.parameters?.range
  const range = rawRange === undefined ? 3 : rawRange
  if (typeof range !== 'number' || !Number.isFinite(range) || range < 0) return undefined
  const candidates = fresh('enemy-candidates')
  const body: GameplayStatement[] = [queryPieces(candidates, { originId: source }, { relation: 'enemy', includeDead: false })]
  const filtered = node.id
  const filterBody: GameplayStatement[] = []
  const cellPresent = fresh('cell-present')
  filterBody.push(compare(cellPresent, input('cell'), literal(null), nullableCellType, '!='))
  const then: GameplayStatement[] = []
  const position = fresh('enemy-position')
  const distance = fresh('enemy-distance')
  then.push(call(position, 'spatial.piece-position', { piece: input('item') }))
  then.push(call(distance, 'spatial.cell-distance', { from: input('cell'), to: output(position, 'cell') }))
  const inRange = fresh('enemy-in-range')
  then.push(call(inRange, 'compare.less-or-equal', { left: output(distance, 'distance'), right: literal(range) }))
  then.push(returnValue(fresh('enemy-return'), output(inRange)))
  filterBody.push({ kind: 'if', id: fresh('cell-branch'), condition: output(cellPresent), then, else: [returnValue(fresh('cell-missing-return'), literal(false))] })
  body.push(collection(filtered, 'filter', output(candidates, 'pieces'), filterBody, { item: 'item', inputs: { cell } }))
  return { statements: body, outputs: { pieces: output(node.id) } }
}

function livingTemplateReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const owner = requiredInput(node, 'owner')
  const templateId = node.parameters?.templateId
  if (!owner || typeof templateId !== 'string') return undefined
  const candidates = fresh('owner-pieces')
  const body: GameplayStatement[] = [queryPieces(candidates, { ownerId: owner }, { relation: 'all', includeDead: false })]
  const ownerField = fresh('piece-owner')
  const templateField = fresh('piece-template')
  const ownerMatch = fresh('owner-match')
  const templateMatch = fresh('template-match')
  const predicate: GameplayStatement[] = [
    field(ownerField, input('item'), 'ownerPlayerId'),
    compare(ownerMatch, output(ownerField), input('owner'), nullablePlayerType),
    field(templateField, input('item'), 'templateId'),
    compare(templateMatch, output(templateField), literal(templateId), 'string'),
  ]
  const accepted = fresh('template-accepted')
  predicate.push(and(accepted, output(ownerMatch), output(templateMatch)))
  predicate.push(returnValue(fresh('template-return'), output(accepted)))
  body.push(collection(node.id, 'find', output(candidates, 'pieces'), predicate, { item: 'item', inputs: { owner } }))
  return { statements: body, outputs: { piece: output(node.id) } }
}

function livingTemplateFactionReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(node, 'target')
  const templateId = node.parameters?.templateId
  if (!target || typeof templateId !== 'string') return undefined
  const candidates = fresh('living-pieces')
  const body: GameplayStatement[] = [queryPieces(candidates, {}, { relation: 'all', includeDead: false })]
  const predicate: GameplayStatement[] = []
  const targetExists = fresh('target-exists')
  predicate.push(call(targetExists, 'query.has-piece', { pieceId: input('target') }))
  const then: GameplayStatement[] = []
  const targetFaction = fresh('target-faction')
  const pieceFaction = fresh('piece-faction')
  const pieceTemplate = fresh('piece-template')
  then.push(field(targetFaction, input('target'), 'faction'))
  then.push(field(pieceFaction, input('item'), 'faction'))
  then.push(field(pieceTemplate, input('item'), 'templateId'))
  const sameFaction = fresh('same-faction')
  const sameTemplate = fresh('same-template')
  then.push(compare(sameFaction, output(pieceFaction), output(targetFaction), 'string'))
  then.push(compare(sameTemplate, output(pieceTemplate), literal(templateId), 'string'))
  const accepted = fresh('faction-template-accepted')
  then.push(and(accepted, output(sameFaction), output(sameTemplate)))
  then.push(returnValue(fresh('faction-template-return'), output(accepted)))
  predicate.push({ kind: 'if', id: fresh('target-branch'), condition: output(targetExists, 'exists'), then, else: [returnValue(fresh('target-missing-return'), literal(false))] })
  body.push(collection(node.id, 'find', output(candidates, 'pieces'), predicate, { item: 'item', inputs: { target } }))
  return { statements: body, outputs: { piece: output(node.id) } }
}

function byTemplateReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const templateId = node.parameters?.templateId
  const alive = node.parameters?.alive === undefined ? true : node.parameters.alive
  if (typeof templateId !== 'string' || typeof alive !== 'boolean') return undefined
  const owner = requiredInput(node, 'owner') ?? literal(null)
  const candidates = fresh('all-pieces')
  const body: GameplayStatement[] = [queryPieces(candidates, {}, { relation: 'all', includeDead: true })]
  const predicate: GameplayStatement[] = []
  const pieceTemplate = fresh('piece-template')
  const templateMatch = fresh('template-match')
  predicate.push(field(pieceTemplate, input('item'), 'templateId'))
  predicate.push(compare(templateMatch, output(pieceTemplate), literal(templateId), 'string'))
  const ownerField = fresh('piece-owner')
  const ownerPresent = fresh('owner-present')
  const ownerMissing = fresh('owner-missing')
  const ownerMatch = fresh('owner-match')
  predicate.push(field(ownerField, input('item'), 'ownerPlayerId'))
  predicate.push(compare(ownerPresent, input('owner'), literal(null), nullablePlayerType, '!='))
  predicate.push(not(ownerMissing, output(ownerPresent)))
  predicate.push(compare(ownerMatch, output(ownerField), input('owner'), nullablePlayerType))
  const ownerAllowed = fresh('owner-allowed')
  predicate.push(or(ownerAllowed, output(ownerMissing), output(ownerMatch)))
  const templateAndOwner = fresh('template-owner-allowed')
  predicate.push(and(templateAndOwner, output(templateMatch), output(ownerAllowed)))
  let accepted: GameplayValue = output(templateAndOwner)
  if (alive) {
    const living = fresh('piece-alive')
    predicate.push(call(living, 'piece.alive', { piece: input('item') }))
    const liveAllowed = fresh('template-owner-alive')
    predicate.push(and(liveAllowed, output(templateAndOwner), output(living, 'alive')))
    accepted = output(liveAllowed)
  }
  predicate.push(returnValue(fresh('by-template-return'), accepted))
  body.push(collection(node.id, 'find', output(candidates, 'pieces'), predicate, { item: 'item', inputs: { owner } }))
  return { statements: body, outputs: { piece: output(node.id) } }
}

function terrainMembershipReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cell = requiredInput(node, 'cell')
  const types = node.parameters?.types
  if (!cell || !Array.isArray(types) || types.some(value => typeof value !== 'string')) return undefined

  const fieldId = fresh('terrain-type')
  const findId = fresh('terrain-match')
  const predicate: GameplayStatement[] = []
  const sameType = fresh('terrain-equal')
  predicate.push(
    compare(sameType, input('item'), input('terrain'), { kind: 'nullable', value: 'string' }),
    returnValue(fresh('terrain-match-return'), output(sameType)),
  )
  const statements: GameplayStatement[] = [
    call(fieldId, 'cell.field', { cell }, { field: 'terrainType' }),
    collection(findId, 'find', literal(types), predicate, { item: 'item', inputs: { terrain: output(fieldId) } }),
    finalCall(node, 'compare.values', { left: output(findId), right: literal(null) }, {
      valueType: typeParameter({ kind: 'nullable', value: 'string' }), operator: '!=',
    }),
  ]
  return { statements, outputs: { value: output(node.id) } }
}

export const atomicSpatialQueryRecipe: AtomicRecipe = (node, fresh) => {
  switch (node.module) {
    case 'spatial.walkable-cells': return walkableReplacement(node, fresh)
    case 'spatial.nearest-adjacent-landing': return nearestReplacement(node, fresh)
    case 'spatial.random-adjacent-landing': return randomReplacement(node, fresh)
    case 'marker.anchor-candidates': return anchorReplacement(node, fresh)
    case 'marker.nearby-enemies': return nearbyEnemiesReplacement(node, fresh)
    case 'query.living-template': return livingTemplateReplacement(node, fresh)
    case 'query.living-template-faction': return livingTemplateFactionReplacement(node, fresh)
    case 'piece.by-template': return byTemplateReplacement(node, fresh)
    case 'spatial.cell-terrain-in': return terrainMembershipReplacement(node, fresh)
    default: return undefined
  }
}

export function migrateSpatialQueryModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicSpatialQueryRecipe)
}
