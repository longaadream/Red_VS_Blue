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
 * The formation helpers used to hide a small spatial query in three native
 * descriptors.  Keep their old ids as migration markers, but express the
 * query as ordinary field, collection, coordinate and comparison nodes.
 */
export const ATOMIC_FORMATION_MODULES = new Set([
  'spatial.formation-selection-valid',
  'spatial.formation-candidates',
  'spatial.formation-slots',
])
export const ATOMIC_FORMATION_MODULE_IDS = ATOMIC_FORMATION_MODULES

const pieceType: GameplayValueType = 'piece'
const pieceListType: GameplayValueType = { kind: 'list', element: 'piece' }
const cellListType: GameplayValueType = { kind: 'list', element: 'cell' }

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

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  type: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType: typeParameter(type), operator })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.and', { left, right })
}

function or(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.or', { left, right })
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

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function queryPieces(id: string, inputs: Readonly<Record<string, GameplayValue>> = {}, parameters: Readonly<Record<string, GameplayJsonValue>> = {}): GameplayCallStatement {
  return call(id, 'query.pieces', inputs, parameters)
}

function position(id: string, piece: GameplayValue): GameplayCallStatement {
  return call(id, 'spatial.piece-position', { piece })
}

function coordinates(id: string, cell: GameplayValue): GameplayCallStatement {
  return call(id, 'spatial.cell-coordinates', { cell })
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

function offsetValue(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  value: GameplayValue,
  offset: number,
): GameplayValue {
  if (offset === 0) return value
  const id = fresh(offset > 0 ? 'coordinate-add' : 'coordinate-subtract')
  statements.push(call(id, offset > 0 ? 'math.add' : 'math.subtract', {
    left: value,
    right: literal(Math.abs(offset)),
  }))
  return output(id)
}

function singleton(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  value: GameplayValue,
): GameplayValue {
  const id = fresh('singleton')
  statements.push(call(id, 'collection.singleton', { value }, { valueType: 'cell' }))
  return output(id, 'items')
}

function concat(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  left: GameplayValue,
  right: GameplayValue,
): GameplayValue {
  const id = fresh('slot-concat')
  statements.push(call(id, 'collection.concat', { left, right }, { valueType: typeParameter(cellListType) }))
  return output(id, 'items')
}

function buildSlots(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  center: GameplayValue,
): GameplayValue {
  const centerCoordinates = fresh('center-coordinates')
  statements.push(coordinates(centerCoordinates, center))
  const x = output(centerCoordinates, 'x')
  const y = output(centerCoordinates, 'y')
  // This order is part of the public formation behavior: center, up, left,
  // right, down.  Do not replace it with map order.
  const offsets = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]] as const
  let all = singleton(statements, fresh, cellFromXY(
    statements, fresh, offsetValue(statements, fresh, x, offsets[0][0]), offsetValue(statements, fresh, y, offsets[0][1]),
  ))
  for (const [dx, dy] of offsets.slice(1)) {
    const next = singleton(statements, fresh, cellFromXY(
      statements, fresh, offsetValue(statements, fresh, x, dx), offsetValue(statements, fresh, y, dy),
    ))
    all = concat(statements, fresh, all, next)
  }
  return all
}

type Occupancy = { readonly ids: GameplayValue; readonly count: GameplayValue; readonly first: GameplayValue }

function occupantPredicate(
  fresh: (suffix: string) => string,
  itemName: string,
): GameplayStatement[] {
  const body: GameplayStatement[] = []
  const piecePosition = fresh('occupant-position')
  body.push(position(piecePosition, input(itemName)))
  const pieceCoordinates = fresh('occupant-coordinates')
  const cellCoordinates = fresh('target-coordinates')
  body.push(coordinates(pieceCoordinates, output(piecePosition, 'cell')))
  body.push(coordinates(cellCoordinates, input('targetCell')))
  const sameX = fresh('occupant-x-match')
  const sameY = fresh('occupant-y-match')
  body.push(compare(sameX, output(pieceCoordinates, 'x'), output(cellCoordinates, 'x'), 'number'))
  body.push(compare(sameY, output(pieceCoordinates, 'y'), output(cellCoordinates, 'y'), 'number'))
  const sameCell = fresh('occupant-cell-match')
  body.push(and(sameCell, output(sameX), output(sameY)))
  body.push(returnValue(fresh('occupant-filter-return'), output(sameCell)))
  return body
}

/** Return the living pieces at a cell.  The cell and living list are explicit
 * captures because collection subprocesses have no implicit outer scope. */
function buildOccupancy(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  cell: GameplayValue,
  living: GameplayValue,
): Occupancy {
  const matchingId = fresh('occupants')
  const body = occupantPredicate(fresh, 'occupant')
  const filtered = collection(matchingId, 'filter', living, body, {
    item: 'occupant', inputs: { targetCell: cell },
  })
  statements.push(filtered)
  const firstId = fresh('first-occupant')
  statements.push(collection(firstId, 'find', living, occupantPredicate(fresh, 'occupant'), {
    item: 'occupant', inputs: { targetCell: cell },
  }))
  const countId = fresh('occupant-count')
  statements.push(call(countId, 'collection.length', { items: output(matchingId) }))
  return { ids: output(matchingId), count: output(countId), first: output(firstId) }
}

function buildSelectedOccupancy(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  occupied: GameplayValue,
  selected: GameplayValue,
): GameplayValue {
  const selectedId = fresh('selected-occupants')
  const matchesBody: GameplayStatement[] = []
  const match = fresh('selected-occupant-match')
  matchesBody.push(compare(match, input('candidate'), input('occupied'), { kind: 'nullable', value: pieceType }))
  matchesBody.push(returnValue(fresh('selected-occupant-return'), output(match)))
  statements.push(collection(selectedId, 'filter', selected, matchesBody, { item: 'candidate', inputs: { occupied } }))
  const allSelected = fresh('selected-occupant-count')
  statements.push(call(allSelected, 'collection.length', { items: output(selectedId) }))
  return output(allSelected)
}

/** Check one fixed slot.  The center slot is stricter: it must be empty even
 * when a selected piece happens to occupy the same coordinate. */
function buildSlotAllowed(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  cell: GameplayValue,
  living: GameplayValue,
  selected: GameplayValue,
  center: boolean,
): GameplayValue {
  // The native selector rejected off-board and non-walkable slots before
  // checking occupancy.  Keep that fact in the generic graph so a wall does
  // not count toward formation capacity merely because it is empty (or has a
  // selected piece on it).
  const walkable = fresh('slot-walkable')
  statements.push(call(walkable, 'spatial.cell-walkable', { cell }))
  const occupancy = buildOccupancy(statements, fresh, cell, living)
  const empty = fresh('slot-empty')
  statements.push(compare(empty, occupancy.count, literal(0), 'number'))
  const emptyWalkable = fresh('slot-empty-walkable')
  statements.push(and(emptyWalkable, output(walkable, 'walkable'), output(empty)))
  if (center) return output(emptyWalkable)
  const selectedCount = buildSelectedOccupancy(statements, fresh, occupancy.first, selected)
  const allSelected = fresh('slot-selected')
  statements.push(call(allSelected, 'compare.greater-than', { left: selectedCount, right: literal(0) }))
  const occupiedOrSelected = fresh('slot-occupied-or-selected')
  statements.push(or(occupiedOrSelected, output(empty), output(allSelected)))
  const allowed = fresh('slot-allowed')
  statements.push(and(allowed, output(walkable, 'walkable'), output(occupiedOrSelected)))
  return output(allowed)
}

function allOf(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  values: readonly GameplayValue[],
): GameplayValue {
  if (values.length === 0) return literal(true)
  let result = values[0]
  for (const value of values.slice(1)) {
    const id = fresh('all')
    statements.push(and(id, result, value))
    result = output(id)
  }
  return result
}

function requiredInput(callNode: GameplayCallStatement, name: string): GameplayValue | undefined {
  return callNode.inputs?.[name]
}

function selectionValidReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(node, 'source')
  const selected = requiredInput(node, 'selected')
  if (!source || !selected) return undefined

  const selectedLength = fresh('selected-count')
  const distinct = fresh('selected-distinct')
  const distinctLength = fresh('distinct-count')
  const min = fresh('selection-minimum')
  const max = fresh('selection-maximum')
  const unique = fresh('selection-unique')
  const allies = fresh('allies')
  const validItems = fresh('valid-selected')
  const validCount = fresh('valid-count')
  const allValid = fresh('all-selected-valid')
  const minAndMax = fresh('selection-size-valid')
  const sizeAndUnique = fresh('selection-size-unique')
  const resultId = node.id

  const body: GameplayStatement[] = [
    call(selectedLength, 'collection.length', { items: selected }),
    call(distinct, 'collection.distinct', { items: selected }, { valueType: typeParameter(pieceListType) }),
    call(distinctLength, 'collection.length', { items: output(distinct, 'value') }),
    compare(unique, output(distinctLength), output(selectedLength), 'number'),
    queryPieces(allies, { originId: source }, { relation: 'ally', includeDead: false }),
  ]

  // compare.values intentionally handles identity here.  Range comparisons
  // use the ordinary numeric comparison descriptors below.
  body.splice(3, 0,
    call(min, 'compare.greater-or-equal', { left: output(selectedLength), right: literal(1) }),
    call(max, 'compare.less-or-equal', { left: output(selectedLength), right: literal(3) }),
  )
  const validBody: GameplayStatement[] = []
  const allyMatches = fresh('ally-matches')
  const allyMatch = fresh('ally-match')
  validBody.push(collection(allyMatches, 'filter', input('allies'), [
    compare(allyMatch, input('ally'), input('selectedPiece'), pieceType),
    returnValue(fresh('ally-return'), output(allyMatch)),
  ], { item: 'ally', inputs: { selectedPiece: input('selectedPiece') } }))
  const allyCount = fresh('ally-count')
  const hasAlly = fresh('has-ally')
  validBody.push(call(allyCount, 'collection.length', { items: output(allyMatches) }))
  validBody.push(call(hasAlly, 'compare.greater-than', { left: output(allyCount), right: literal(0) }))
  const core = fresh('selected-core')
  validBody.push(call(core, 'piece.is-core', { piece: input('selectedPiece') }))
  const alive = fresh('selected-alive')
  // piece.alive performs the same currentHp > 0 check as the old helper, but
  // also keeps an invalid selected reference from dereferencing a missing
  // piece record before the rest of the selection predicate can fail.
  validBody.push(call(alive, 'piece.alive', { piece: input('selectedPiece') }))
  const valid = allOf(validBody, fresh, [output(hasAlly), output(core), output(alive, 'alive')])
  validBody.push(returnValue(fresh('selected-valid-return'), valid))
  body.push(collection(validItems, 'filter', selected, validBody, {
    item: 'selectedPiece', inputs: { allies: output(allies, 'pieces') },
  }))
  body.push(call(validCount, 'collection.length', { items: output(validItems) }))
  body.push(compare(allValid, output(validCount), output(selectedLength), 'number'))
  body.push(and(minAndMax, output(min), output(max)))
  body.push(and(sizeAndUnique, output(minAndMax), output(unique)))
  body.push(and(resultId, output(sizeAndUnique), output(allValid)))
  return { statements: body, outputs: { value: output(resultId) } }
}

function candidateReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(node, 'source')
  const selected = requiredInput(node, 'selected')
  if (!source || !selected) return undefined
  const rawRange = node.parameters?.range
  if (rawRange !== undefined && (typeof rawRange !== 'number' || !Number.isFinite(rawRange) || rawRange < 0)) return undefined
  const radius = literal(rawRange === undefined ? 6 : rawRange)
  const sourcePosition = fresh('source-position')
  const mapCells = fresh('map-cells')
  const living = fresh('living-pieces')
  const filtered = fresh('candidate-cells')
  const sortedXKeys = fresh('candidate-x-keys')
  const sortedX = fresh('candidate-x-sorted')
  const sortedYKeys = fresh('candidate-y-keys')
  const final = finalCall(node, 'collection.sort', {
    items: output(sortedX, 'items'), keys: output(sortedYKeys),
  }, { comparison: 'numeric', order: 'ascending' }, '2')
  const body: GameplayStatement[] = [
    position(sourcePosition, source),
    call(mapCells, 'spatial.map-cells'),
    queryPieces(living, {}, { includeDead: false }),
  ]
  const candidateBody: GameplayStatement[] = []
  const walkable = fresh('candidate-walkable')
  candidateBody.push(call(walkable, 'spatial.cell-walkable', { cell: input('candidate') }))
  const distance = fresh('candidate-distance')
  candidateBody.push(call(distance, 'spatial.cell-distance', { from: input('sourceCell'), to: input('candidate') }))
  const inRange = fresh('candidate-in-range')
  candidateBody.push(call(inRange, 'compare.less-or-equal', { left: output(distance, 'distance'), right: radius }))
  const centerAllowed = buildSlotAllowed(candidateBody, fresh, input('candidate'), input('living'), input('selected'), true)
  const slots = buildSlots(candidateBody, fresh, input('candidate'))
  const legalSlots = fresh('candidate-legal-slots')
  const slotBody: GameplayStatement[] = []
  const slotAllowed = buildSlotAllowed(slotBody, fresh, input('slot'), input('living'), input('selected'), false)
  slotBody.push(returnValue(fresh('candidate-slot-return'), slotAllowed))
  candidateBody.push(collection(legalSlots, 'filter', slots, slotBody, {
    item: 'slot', inputs: { living: input('living'), selected: input('selected') },
  }))
  const legalCount = fresh('candidate-slot-count')
  candidateBody.push(call(legalCount, 'collection.length', { items: output(legalSlots) }))
  const selectedCount = fresh('candidate-selected-count')
  candidateBody.push(call(selectedCount, 'collection.length', { items: input('selected') }))
  const capacity = fresh('candidate-capacity')
  candidateBody.push(call(capacity, 'compare.greater-or-equal', { left: output(legalCount), right: output(selectedCount) }))
  const accepted = allOf(candidateBody, fresh, [output(walkable, 'walkable'), output(inRange), centerAllowed, output(capacity)])
  candidateBody.push(returnValue(fresh('candidate-return'), accepted))
  body.push(collection(filtered, 'filter', output(mapCells, 'cells'), candidateBody, {
    item: 'candidate', inputs: { selected, sourceCell: output(sourcePosition, 'cell'), living: output(living, 'pieces') },
  }))
  // Stable sorts produce the legacy y-then-x ordering without a bespoke sort
  // predicate.  Sort by x first, then stable-sort that result by y.
  const xBody: GameplayStatement[] = []
  const xCoordinates = fresh('candidate-x-coordinates')
  xBody.push(coordinates(xCoordinates, input('item')))
  xBody.push(returnValue(fresh('candidate-x-key'), output(xCoordinates, 'x')))
  body.push(collection(sortedXKeys, 'map', output(filtered), xBody, { item: 'item' }))
  body.push(call(sortedX, 'collection.sort', { items: output(filtered), keys: output(sortedXKeys) }, { comparison: 'numeric', order: 'ascending' }, '2'))
  const yBody: GameplayStatement[] = []
  const yCoordinates = fresh('candidate-y-coordinates')
  yBody.push(coordinates(yCoordinates, input('item')))
  yBody.push(returnValue(fresh('candidate-y-key'), output(yCoordinates, 'y')))
  body.push(collection(sortedYKeys, 'map', output(sortedX, 'items'), yBody, { item: 'item' }))
  body.push(final)
  return { statements: body, outputs: { cells: output(node.id, 'items') } }
}

function slotsReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const center = requiredInput(node, 'center')
  const selected = requiredInput(node, 'selected')
  if (!center || !selected) return undefined
  const living = fresh('living-pieces')
  const legal = fresh('legal-slots')
  const selectedCount = fresh('selected-count')
  const capped = node.id
  const body: GameplayStatement[] = [queryPieces(living, {}, { includeDead: false })]
  const slotCells: GameplayValue = buildSlots(body, fresh, center)
  const legalBody: GameplayStatement[] = []
  const allowed = buildSlotAllowed(legalBody, fresh, input('slot'), input('living'), input('selected'), false)
  legalBody.push(returnValue(fresh('slot-return'), allowed))
  body.push(collection(legal, 'filter', slotCells, legalBody, { item: 'slot', inputs: { living: output(living, 'pieces'), selected } }))
  body.push(call(selectedCount, 'collection.length', { items: selected }))
  const capBody: GameplayStatement[] = []
  const within = fresh('slot-limit')
  capBody.push(call(within, 'compare.less-than', { left: input('slotIndex'), right: input('selectedCount') }))
  capBody.push(returnValue(fresh('slot-cap-return'), output(within)))
  body.push(collection(capped, 'filter', output(legal), capBody, { item: 'slot', index: 'slotIndex', inputs: { selectedCount: output(selectedCount) } }))
  return { statements: body, outputs: { cells: output(capped) } }
}

export const atomicFormationRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (node.module === 'spatial.formation-selection-valid') return selectionValidReplacement(node, fresh)
  if (node.module === 'spatial.formation-candidates') return candidateReplacement(node, fresh)
  if (node.module === 'spatial.formation-slots') return slotsReplacement(node, fresh)
  return undefined
}

export function migrateFormationModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicFormationRecipe)
}
