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
 * Projectile, spatial and movement selectors that only combine ordinary
 * graph facts.  The two path adapters used below remain host boundaries: the
 * graph owns filtering/truncation/order, while flow-runtime owns traversal.
 */
export const ATOMIC_PROJECTILE_QUERY_MODULES = new Set([
  'projectile.trace-enemies',
  'query.faction-enemies-on-cells',
  'query.enemies-on-index',
  'spatial.random-cardinal-landing',
  'movement.first-piece-on-trace',
  'movement.bounce-candidates',
  'projectile.first-enemy-on-path',
  'spatial.shuffle-cardinal-cells',
  'projectile.events-from-cell-bounded',
  'projectile.trace-until-blocker',
])
export const ATOMIC_PROJECTILE_QUERY_MODULE_IDS = ATOMIC_PROJECTILE_QUERY_MODULES

const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const cellType: GameplayValueType = 'cell'
const eventType: GameplayValueType = 'event'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const stringListType: GameplayValueType = { kind: 'list', element: stringType }
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: pieceType }
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: playerType }
const nullableCellType: GameplayValueType = { kind: 'nullable', value: cellType }
const nullableEventType: GameplayValueType = { kind: 'nullable', value: eventType }
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function isValue(value: unknown): value is GameplayValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value')
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0
  return record.kind === 'output' && typeof record.node === 'string' && record.node.length > 0
    && typeof record.port === 'string' && record.port.length > 0
}

function requiredInput(call: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = call.inputs?.[name]
  return isValue(value) ? value : undefined
}

function typeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function generatedCall(
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
  valueType: GameplayValueType,
  operator: '==' | '!=' | '<' | '<=' | '>' | '>=' = '==',
): GameplayCallStatement {
  if (operator !== '==' && operator !== '!=') {
    const comparisonModule = operator === '<' ? 'compare.less-than'
      : operator === '<=' ? 'compare.less-or-equal'
        : operator === '>' ? 'compare.greater-than' : 'compare.greater-or-equal'
    return generatedCall(id, comparisonModule, { left, right })
  }
  return generatedCall(id, 'compare.values', { left, right }, {
    valueType: typeParameter(valueType), operator,
  })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.and', { left, right })
}

function or(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.or', { left, right })
}

function not(id: string, value: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.not', { value })
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function collection(
  id: string,
  method: 'map' | 'filter' | 'find' | 'reduce',
  items: GameplayValue,
  body: readonly GameplayStatement[],
  options: {
    readonly item?: string
    readonly index?: string
    readonly accumulator?: string
    readonly initial?: GameplayValue
    readonly inputs?: Readonly<Record<string, GameplayValue>>
  } = {},
): GameplayStatement {
  return {
    kind: 'collection', id, method, items, item: options.item ?? 'item',
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.accumulator === undefined ? {} : { accumulator: options.accumulator }),
    ...(options.initial === undefined ? {} : { initial: options.initial }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }), body,
  }
}

function field(id: string, piece: GameplayValue, name: string): GameplayCallStatement {
  return generatedCall(id, 'piece.field', { piece }, { field: name }, '2')
}

function queryPieces(
  id: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return generatedCall(id, 'query.pieces', inputs, parameters)
}

function localCall(
  id: string,
  module: 'local.declare' | 'local.read' | 'local.write',
  inputs: Readonly<Record<string, GameplayValue>>,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, module, inputs, { valueType: typeParameter(valueType) })
}

function numberParameter(call: GameplayCallStatement, name: string, fallback: number): number | undefined {
  const value = call.parameters?.[name]
  const selected = value === undefined ? fallback : value
  return typeof selected === 'number' && Number.isFinite(selected) ? selected : undefined
}

function booleanParameter(call: GameplayCallStatement, name: string, fallback: boolean): boolean | undefined {
  const value = call.parameters?.[name]
  const selected = value === undefined ? fallback : value
  return typeof selected === 'boolean' ? selected : undefined
}

function pieceEventStop(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  event: GameplayValue,
  stopAtPiece: boolean,
): GameplayValue {
  const kind = fresh('event-kind')
  statements.push(generatedCall(kind, 'projectile.event-kind', { event }))
  const boundary = fresh('boundary')
  statements.push(compare(boundary, output(kind, 'kind'), literal('boundary'), nullableStringType))
  const terrain = fresh('terrain')
  statements.push(compare(terrain, output(kind, 'kind'), literal('terrain'), nullableStringType))
  const blocks = fresh('blocks')
  statements.push(generatedCall(blocks, 'projectile.event-blocks', { event }))
  const terrainBlocked = fresh('terrain-blocked')
  statements.push(and(terrainBlocked, output(terrain), output(blocks, 'blocks')))
  let stop: GameplayValue = output(boundary)
  const terrainStop = fresh('terrain-stop')
  statements.push(or(terrainStop, stop, output(terrainBlocked)))
  stop = output(terrainStop)
  if (stopAtPiece) {
    const piece = fresh('piece')
    statements.push(compare(piece, output(kind, 'kind'), literal('piece'), nullableStringType))
    const allStop = fresh('piece-stop')
    statements.push(or(allStop, stop, output(piece)))
    stop = output(allStop)
  }
  return stop
}

function traceEnemiesReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const target = requiredInput(call, 'target')
  const maxDistance = numberParameter(call, 'maxDistance', 6)
  if (!source || !target || maxDistance === undefined) return undefined

  const statements: GameplayStatement[] = []
  const trace = fresh('trace')
  const enemies = fresh('enemy-ids')
  statements.push(
    generatedCall(trace, 'projectile.trace-to-cell', { source, target }, { maxDistance }),
    queryPieces(enemies, { originId: source }, { relation: 'enemy', includeDead: false }),
  )

  const filtered = fresh('enemy-encounters')
  const filterBody: GameplayStatement[] = []
  const kind = fresh('kind')
  const piece = fresh('piece')
  const kindMatch = fresh('kind-match')
  const contains = fresh('enemy-match')
  const accepted = fresh('accepted')
  filterBody.push(
    generatedCall(kind, 'projectile.event-kind', { event: input('event') }),
    generatedCall(piece, 'projectile.event-piece-id', { event: input('event') }),
    compare(kindMatch, output(kind, 'kind'), literal('piece'), nullableStringType),
    generatedCall(contains, 'collection.contains', { items: input('enemyIds'), value: output(piece, 'piece') }, {
      valueType: typeParameter(pieceType), itemsType: typeParameter(pieceListType),
    }),
    and(accepted, output(kindMatch), output(contains)),
    returnValue(fresh('enemy-encounter-return'), output(accepted)),
  )
  statements.push(collection(filtered, 'filter', output(trace, 'events'), filterBody, {
    item: 'event', inputs: { enemyIds: output(enemies, 'pieces') },
  }))

  const mapped = fresh('enemy-pieces')
  const mapBody: GameplayStatement[] = [
    generatedCall(fresh('enemy-piece'), 'projectile.event-piece-id', { event: input('event') }),
  ]
  mapBody.push(returnValue(fresh('enemy-piece-return'), output(mapBody[0].id, 'piece')))
  statements.push(collection(mapped, 'map', output(filtered), mapBody, { item: 'event' }))

  return {
    statements,
    outputs: {
      pieces: output(mapped),
      valid: output(trace, 'valid'),
      sameCell: output(trace, 'sameCell'),
      distance: output(trace, 'distance'),
    },
  }
}

function factionEnemiesReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const cells = requiredInput(call, 'cells')
  if (!source || !cells) return undefined

  const statements: GameplayStatement[] = []
  const resultLocal = fresh('faction-result')
  statements.push(localCall(resultLocal, 'local.declare', { initial: literal([]) }, pieceListType))
  const sourceExists = fresh('faction-source-exists')
  statements.push(generatedCall(sourceExists, 'query.has-piece', { pieceId: source }))
  const branch: GameplayStatement[] = []
  const sourceFaction = fresh('source-faction')
  const candidates = fresh('all-living-pieces')
  branch.push(
    generatedCall(sourceFaction, 'piece.raw-faction', { piece: source }),
    queryPieces(candidates, {}, { relation: 'all', includeDead: false }),
  )

  const filtered = call.id
  const body: GameplayStatement[] = []
  const pieceFaction = fresh('piece-faction')
  const factionMatch = fresh('faction-match')
  body.push(
    generatedCall(pieceFaction, 'piece.raw-faction', { piece: input('piece') }),
    compare(factionMatch, output(pieceFaction, 'faction'), input('sourceFaction'), nullableStringType, '!='),
  )
  const onCell = fresh('on-cell')
  const cellBody: GameplayStatement[] = []
  const cellCoordinates = fresh('cell-coordinates')
  const candidateX = fresh('piece-x')
  const candidateY = fresh('piece-y')
  const xMatch = fresh('cell-x-match')
  const yMatch = fresh('cell-y-match')
  const sameCell = fresh('same-cell')
  cellBody.push(
    field(candidateX, input('piece'), 'x'),
    field(candidateY, input('piece'), 'y'),
    generatedCall(cellCoordinates, 'spatial.cell-coordinates', { cell: input('cell') }),
    compare(xMatch, output(candidateX, 'value'), output(cellCoordinates, 'x'), numberType),
    compare(yMatch, output(candidateY, 'value'), output(cellCoordinates, 'y'), numberType),
    and(sameCell, output(xMatch), output(yMatch)),
    returnValue(fresh('same-cell-return'), output(sameCell)),
  )
  body.push(collection(onCell, 'find', input('cells'), cellBody, {
    item: 'cell', inputs: { piece: input('piece') },
  }))
  const hasCell = fresh('has-cell')
  body.push(compare(hasCell, output(onCell), literal(null), nullableCellType, '!='))
  const accepted = fresh('accepted')
  body.push(and(accepted, output(factionMatch), output(hasCell)))
  body.push(returnValue(fresh('faction-enemy-return'), output(accepted)))
  branch.push(collection(filtered, 'filter', output(candidates, 'pieces'), body, {
    item: 'piece', inputs: { sourceFaction: output(sourceFaction, 'faction'), cells },
  }))
  branch.push(localCall(fresh('faction-result-write'), 'local.write', { handle: output(resultLocal, 'handle'), value: output(filtered) }, pieceListType))
  statements.push({ kind: 'if', id: fresh('faction-source-branch'), condition: output(sourceExists, 'exists'), then: branch })
  const result = fresh('faction-result-read')
  statements.push(localCall(result, 'local.read', { handle: output(resultLocal, 'handle') }, pieceListType))
  return { statements, outputs: { pieces: output(result) } }
}

function enemiesOnIndexReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cells = requiredInput(call, 'cells')
  const index = requiredInput(call, 'index')
  if (!cells || !index) return undefined
  const source = requiredInput(call, 'source') ?? literal(null)
  const owner = requiredInput(call, 'owner') ?? literal(null)
  const statements: GameplayStatement[] = []

  const resultLocal = fresh('index-result')
  statements.push(localCall(resultLocal, 'local.declare', { initial: literal([]) }, pieceListType))
  const length = fresh('cells-length')
  const floor = fresh('index-floor')
  const integer = fresh('index-integer')
  const nonnegative = fresh('index-nonnegative')
  const inBounds = fresh('index-in-bounds')
  statements.push(
    generatedCall(length, 'collection.length', { items: cells }),
    generatedCall(floor, 'math.floor', { value: index }),
    compare(integer, output(floor), index, numberType),
    compare(nonnegative, index, literal(0), numberType, '>='),
    compare(inBounds, index, output(length), numberType, '<'),
  )
  const validIndex = fresh('valid-index')
  statements.push(and(validIndex, output(integer), output(nonnegative)))
  const indexAllowed = fresh('index-allowed')
  statements.push(and(indexAllowed, output(validIndex), output(inBounds)))

  const sourcePresent = fresh('source-present')
  const ownerPresent = fresh('owner-present')
  const sourceValid = fresh('source-valid')
  const sourceAllowed = fresh('source-allowed')
  const sourceAndValid: GameplayStatement[] = []
  sourceAndValid.push(generatedCall(sourceValid, 'query.has-piece', { pieceId: source }))
  sourceAndValid.push(and(sourceAllowed, output(sourcePresent), output(sourceValid, 'exists')))
  const ownerOrSource = fresh('owner-or-source')
  statements.push(
    compare(sourcePresent, source, literal(null), nullablePieceType, '!='),
    compare(ownerPresent, owner, literal(null), nullablePlayerType, '!='),
    ...sourceAndValid,
    or(ownerOrSource, output(ownerPresent), output(sourceAllowed)),
  )
  const valid = fresh('valid-query')
  statements.push(and(valid, output(indexAllowed), output(ownerOrSource)))

  const then: GameplayStatement[] = []
  const position = fresh('index-position')
  const cell = fresh('index-cell')
  then.push(
    generatedCall(position, 'math.add', { left: output(floor), right: literal(1) }),
    generatedCall(cell, 'collection.at', { items: cells, position: output(position) }),
  )
  const filterAtCell = (candidate: GameplayValue, candidateId: string): GameplayStatement[] => {
    const body: GameplayStatement[] = []
    const x = fresh(candidateId + '-x')
    const y = fresh(candidateId + '-y')
    const cellCoordinates = fresh(candidateId + '-cell-coordinates')
    const xMatch = fresh(candidateId + '-x-match')
    const yMatch = fresh(candidateId + '-y-match')
    const accepted = fresh(candidateId + '-accepted')
    body.push(
      field(x, input('piece'), 'x'),
      field(y, input('piece'), 'y'),
      generatedCall(cellCoordinates, 'spatial.cell-coordinates', { cell: input('cell') }),
      compare(xMatch, output(x, 'value'), output(cellCoordinates, 'x'), numberType),
      compare(yMatch, output(y, 'value'), output(cellCoordinates, 'y'), numberType),
      and(accepted, output(xMatch), output(yMatch)),
      returnValue(fresh(candidateId + '-return'), output(accepted)),
    )
    return [collection(candidateId, 'filter', candidate, body, { item: 'piece', inputs: { cell: output(cell, 'value') } })]
  }
  const ownerBranch = fresh('owner-branch')
  const ownerIds = fresh('owner-enemies')
  const sourceIds = fresh('source-enemies')
  const ownerFiltered = fresh('owner-at-cell')
  const sourceFiltered = fresh('source-at-cell')
  const ownerThen: GameplayStatement[] = [
    queryPieces(ownerIds, { ownerId: owner }, { relation: 'enemy', includeDead: false }),
    ...filterAtCell(output(ownerIds, 'pieces'), ownerFiltered),
    localCall(fresh('owner-result-write'), 'local.write', { handle: output(resultLocal, 'handle'), value: output(ownerFiltered) }, pieceListType),
  ]
  const sourceThen: GameplayStatement[] = [
    queryPieces(sourceIds, { originId: source }, { relation: 'enemy', includeDead: false }),
    ...filterAtCell(output(sourceIds, 'pieces'), sourceFiltered),
    localCall(fresh('source-result-write'), 'local.write', { handle: output(resultLocal, 'handle'), value: output(sourceFiltered) }, pieceListType),
  ]
  then.push({ kind: 'if', id: ownerBranch, condition: output(ownerPresent), then: ownerThen, else: sourceThen })
  statements.push({ kind: 'if', id: fresh('valid-index-branch'), condition: output(valid), then })
  const result = fresh('index-result-read')
  statements.push(localCall(result, 'local.read', { handle: output(resultLocal, 'handle') }, pieceListType))
  return { statements, outputs: { pieces: output(result) } }
}

function randomLandingReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(call, 'target')
  if (!target) return undefined
  const statements: GameplayStatement[] = []
  const resultLocal = fresh('landing-result')
  statements.push(localCall(resultLocal, 'local.declare', { initial: literal(null) }, nullableCellType))
  const targetExists = fresh('landing-target-exists')
  statements.push(generatedCall(targetExists, 'query.has-piece', { pieceId: target }))
  const branch: GameplayStatement[] = []
  const cells = fresh('cardinal-cells')
  branch.push(generatedCall(cells, 'spatial.cardinal-cells-ordered', { target }, { order: 'up-right-down-left' }))
  const filtered = fresh('landing-candidates')
  const filterBody: GameplayStatement[] = []
  const legal = fresh('landing-legal')
  filterBody.push(
    generatedCall(legal, 'spatial.cell-landing-legal', { cell: input('cell') }, { terrainPolicy: 'walkable' }),
    returnValue(fresh('landing-return'), output(legal, 'legal')),
  )
  branch.push(collection(filtered, 'filter', output(cells, 'cells'), filterBody, { item: 'cell' }))
  const random = finalCall(call, 'collection.random', { items: output(filtered) })
  branch.push(random)
  branch.push(localCall(fresh('landing-result-write'), 'local.write', { handle: output(resultLocal, 'handle'), value: output(call.id, 'value') }, nullableCellType))
  statements.push({ kind: 'if', id: fresh('landing-target-branch'), condition: output(targetExists, 'exists'), then: branch })
  const result = fresh('landing-result-read')
  statements.push(localCall(result, 'local.read', { handle: output(resultLocal, 'handle') }, nullableCellType))
  return { statements, outputs: { cell: output(result) } }
}

function bounceCandidatesReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const sourceId = requiredInput(call, 'sourceId')
  const excluded = requiredInput(call, 'excluded')
  const range = requiredInput(call, 'range')
  if (!sourceId || !excluded || !range) return undefined
  const statements: GameplayStatement[] = []
  const source = fresh('bounce-source')
  statements.push(generatedCall(source, 'query.piece-by-id', { id: sourceId }))
  const finite = fresh('bounce-range-finite')
  const nonnegative = fresh('bounce-range-nonnegative')
  const validRange = fresh('bounce-range-valid')
  statements.push(
    generatedCall(finite, 'value.is-finite', { value: range }),
    compare(nonnegative, range, literal(0), numberType, '>='),
    and(validRange, output(finite, 'value'), output(nonnegative)),
  )
  const sourceReference = fresh('bounce-source-reference')
  statements.push(generatedCall(sourceReference, 'piece.require', { piece: output(source, 'piece') }))
  const enemies = fresh('bounce-enemies')
  // Query the living pieces without an origin so this replacement remains a
  // pure expression even when the legacy call is nested in a while condition.
  // The source reference is validated by the predicate below; an absent source
  // therefore produces an empty result through the compiler's invalid-value
  // propagation instead of requiring a local branch/result slot.
  statements.push(queryPieces(enemies, {}, { relation: 'all', includeDead: false }))
  const filterBody: GameplayStatement[] = []
  const pieceId = fresh('bounce-piece-id')
  const excludedMatch = fresh('excluded-match')
  const allowed = fresh('excluded-allowed')
  const enemy = fresh('bounce-enemy')
  const distance = fresh('bounce-distance')
  const inRange = fresh('bounce-in-range')
  const allowedEnemy = fresh('bounce-allowed-enemy')
  const allowedDistance = fresh('bounce-allowed-distance')
  const accepted = fresh('bounce-accepted')
  filterBody.push(
    generatedCall(pieceId, 'piece.identifier', { piece: input('piece') }),
    generatedCall(excludedMatch, 'collection.contains', { items: input('excludedIds'), value: output(pieceId, 'id') }, {
      valueType: typeParameter(stringType), itemsType: typeParameter(stringListType),
    }),
    not(allowed, output(excludedMatch)),
    // The legacy helper only required the source to exist, so keep the
    // non-living relation descriptor here.  The v2 descriptor adds a living
    // reference guard that would incorrectly drop candidates for a dead source.
    generatedCall(enemy, 'query.same-relation', { source: input('sourceReference'), target: input('piece') }, { relation: 'enemy' }, '1'),
    generatedCall(distance, 'query.distance', { from: input('sourceReference'), to: input('piece') }),
    compare(inRange, output(distance, 'distance'), input('range'), numberType, '<='),
    and(allowedEnemy, output(allowed), output(enemy)),
    and(allowedDistance, output(allowedEnemy), output(inRange)),
    and(accepted, output(allowedDistance), input('validRange')),
    returnValue(fresh('bounce-return'), output(accepted)),
  )
  const filtered = fresh('bounce-filtered')
  statements.push(collection(filtered, 'filter', output(enemies, 'pieces'), filterBody, {
    item: 'piece', inputs: {
      excludedIds: excluded, sourceReference: output(sourceReference, 'piece'), range,
      validRange: output(validRange),
    },
  }))
  return { statements, outputs: { pieces: output(filtered) } }
}

function firstPieceReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const events = requiredInput(call, 'events')
  if (!source || !events) return undefined
  const statements: GameplayStatement[] = []
  const pieceLocal = fresh('first-piece')
  const enemyLocal = fresh('first-enemy')
  const distanceLocal = fresh('first-distance')
  const cellLocal = fresh('first-cell')
  const presentLocal = fresh('first-present')
  statements.push(
    localCall(pieceLocal, 'local.declare', { initial: literal(null) }, nullablePieceType),
    localCall(enemyLocal, 'local.declare', { initial: literal(false) }, booleanType),
    localCall(distanceLocal, 'local.declare', { initial: literal(0) }, numberType),
    localCall(cellLocal, 'local.declare', { initial: literal(null) }, nullableCellType),
    localCall(presentLocal, 'local.declare', { initial: literal(false) }, booleanType),
  )
  const sourceExists = fresh('first-source-exists')
  statements.push(generatedCall(sourceExists, 'query.has-piece', { pieceId: source }))
  const branch: GameplayStatement[] = []
  const selected = fresh('first-selected-event')
  const findBody: GameplayStatement[] = []
  const stop = pieceEventStop(findBody, fresh, input('event'), true)
  findBody.push(returnValue(fresh('first-event-stop-return'), stop))
  branch.push(collection(selected, 'find', events, findBody, { item: 'event' }))
  const selectedPresent = fresh('first-selected-present')
  branch.push(compare(selectedPresent, output(selected), literal(null), nullableEventType, '!='))
  const selectedThen: GameplayStatement[] = []
  const kind = fresh('first-selected-kind')
  const isPiece = fresh('first-selected-is-piece')
  selectedThen.push(
    generatedCall(kind, 'projectile.event-kind', { event: output(selected) }),
    compare(isPiece, output(kind, 'kind'), literal('piece'), nullableStringType),
  )
  const pieceThen: GameplayStatement[] = []
  const target = fresh('first-target')
  pieceThen.push(generatedCall(target, 'projectile.event-piece-id', { event: output(selected) }))
  const exists = fresh('first-target-exists')
  pieceThen.push(generatedCall(exists, 'query.has-piece', { pieceId: output(target, 'piece') }))
  const validThen: GameplayStatement[] = []
  const relation = fresh('first-target-enemy')
  const eventDistance = fresh('first-distance-value')
  const eventCell = fresh('first-cell-value')
  validThen.push(
    generatedCall(relation, 'query.same-relation', { source, target: output(target, 'piece') }, { relation: 'enemy' }, '2'),
    generatedCall(eventDistance, 'projectile.event-distance', { event: output(selected) }),
    generatedCall(eventCell, 'projectile.event-cell', { event: output(selected) }),
    localCall(fresh('first-piece-write'), 'local.write', { handle: output(pieceLocal, 'handle'), value: output(target, 'piece') }, nullablePieceType),
    localCall(fresh('first-enemy-write'), 'local.write', { handle: output(enemyLocal, 'handle'), value: output(relation) }, booleanType),
    localCall(fresh('first-distance-write'), 'local.write', { handle: output(distanceLocal, 'handle'), value: output(eventDistance, 'distance') }, numberType),
    localCall(fresh('first-cell-write'), 'local.write', { handle: output(cellLocal, 'handle'), value: output(eventCell, 'cell') }, nullableCellType),
    localCall(fresh('first-present-write'), 'local.write', { handle: output(presentLocal, 'handle'), value: literal(true) }, booleanType),
  )
  const invalidThen: GameplayStatement[] = [
    generatedCall(fresh('first-invalid-distance-value'), 'projectile.event-distance', { event: output(selected) }),
    generatedCall(fresh('first-invalid-cell-value'), 'projectile.event-cell', { event: output(selected) }),
  ]
  const invalidDistance = invalidThen[0] as GameplayCallStatement
  const invalidCell = invalidThen[1] as GameplayCallStatement
  invalidThen.push(
    localCall(fresh('first-invalid-distance-write'), 'local.write', { handle: output(distanceLocal, 'handle'), value: output(invalidDistance.id, 'distance') }, numberType),
    localCall(fresh('first-invalid-cell-write'), 'local.write', { handle: output(cellLocal, 'handle'), value: output(invalidCell.id, 'cell') }, nullableCellType),
  )
  pieceThen.push({ kind: 'if', id: fresh('first-target-branch'), condition: output(exists, 'exists'), then: validThen, else: invalidThen })
  selectedThen.push({ kind: 'if', id: fresh('first-piece-branch'), condition: output(isPiece), then: pieceThen })
  branch.push({ kind: 'if', id: fresh('first-selected-branch'), condition: output(selectedPresent), then: selectedThen })
  statements.push({ kind: 'if', id: fresh('first-source-branch'), condition: output(sourceExists, 'exists'), then: branch })
  const pieceRead = fresh('first-piece-read')
  const enemyRead = fresh('first-enemy-read')
  const distanceRead = fresh('first-distance-read')
  const cellRead = fresh('first-cell-read')
  const presentRead = fresh('first-present-read')
  statements.push(
    localCall(pieceRead, 'local.read', { handle: output(pieceLocal, 'handle') }, nullablePieceType),
    localCall(enemyRead, 'local.read', { handle: output(enemyLocal, 'handle') }, booleanType),
    localCall(distanceRead, 'local.read', { handle: output(distanceLocal, 'handle') }, numberType),
    localCall(cellRead, 'local.read', { handle: output(cellLocal, 'handle') }, nullableCellType),
    localCall(presentRead, 'local.read', { handle: output(presentLocal, 'handle') }, booleanType),
  )
  return {
    statements,
    outputs: {
      piece: output(pieceRead),
      enemy: output(enemyRead),
      distance: output(distanceRead),
      cell: output(cellRead),
      present: output(presentRead),
    },
  }
}

function firstEnemyReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const direction = requiredInput(call, 'direction')
  const maxDistance = numberParameter(call, 'maxDistance', 6)
  if (!source || !direction || maxDistance === undefined) return undefined
  const statements: GameplayStatement[] = []
  const resultLocal = fresh('first-enemy-result')
  statements.push(localCall(resultLocal, 'local.declare', { initial: literal(null) }, nullablePieceType))
  const sourceExists = fresh('first-enemy-source-exists')
  statements.push(generatedCall(sourceExists, 'query.has-piece', { pieceId: source }))
  const branch: GameplayStatement[] = []
  const sourceX = fresh('first-enemy-source-x')
  const sourceY = fresh('first-enemy-source-y')
  const origin = fresh('first-enemy-origin')
  const trace = fresh('first-enemy-trace')
  branch.push(
    field(sourceX, source, 'x'),
    field(sourceY, source, 'y'),
    generatedCall(origin, 'spatial.cell', { x: output(sourceX), y: output(sourceY) }),
    generatedCall(trace, 'projectile.trace-from-cell', {
      origin: output(origin, 'cell'), direction, maxDistance: literal(maxDistance), excludePiece: source,
    }),
  )
  const selected = fresh('first-enemy-selected-event')
  const findBody: GameplayStatement[] = []
  const stop = pieceEventStop(findBody, fresh, input('event'), true)
  findBody.push(returnValue(fresh('first-enemy-stop-return'), stop))
  branch.push(collection(selected, 'find', output(trace, 'events'), findBody, { item: 'event' }))
  const selectedPresent = fresh('first-enemy-selected-present')
  branch.push(compare(selectedPresent, output(selected), literal(null), nullableEventType, '!='))
  const selectedThen: GameplayStatement[] = []
  const kind = fresh('first-enemy-kind')
  const isPiece = fresh('first-enemy-is-piece')
  const target = fresh('first-enemy-target')
  const targetExists = fresh('first-enemy-target-exists')
  const targetEnemy = fresh('first-enemy-target-enemy')
  selectedThen.push(
    generatedCall(kind, 'projectile.event-kind', { event: output(selected) }),
    compare(isPiece, output(kind, 'kind'), literal('piece'), nullableStringType),
    generatedCall(target, 'projectile.event-piece-id', { event: output(selected) }),
    generatedCall(targetExists, 'query.has-piece', { pieceId: output(target, 'piece') }),
    generatedCall(targetEnemy, 'query.same-relation', { source, target: output(target, 'piece') }, { relation: 'enemy' }, '2'),
  )
  selectedThen.push({ kind: 'if', id: fresh('first-enemy-piece-branch'), condition: output(isPiece), then: [
    { kind: 'if', id: fresh('first-enemy-valid-target'), condition: output(targetExists, 'exists'), then: [
      { kind: 'if', id: fresh('first-enemy-enemy-branch'), condition: output(targetEnemy, 'value'), then: [
        localCall(fresh('first-enemy-result-write'), 'local.write', { handle: output(resultLocal, 'handle'), value: output(target, 'piece') }, nullablePieceType),
      ] },
    ] },
  ] })
  branch.push({ kind: 'if', id: fresh('first-enemy-selected-branch'), condition: output(selectedPresent), then: selectedThen })
  statements.push({ kind: 'if', id: fresh('first-enemy-source-branch'), condition: output(sourceExists, 'exists'), then: branch })
  const result = fresh('first-enemy-result-read')
  statements.push(localCall(result, 'local.read', { handle: output(resultLocal, 'handle') }, nullablePieceType))
  return { statements, outputs: { target: output(result) } }
}

function boundedEventsReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const origin = requiredInput(call, 'origin')
  const direction = requiredInput(call, 'direction')
  const maxDistance = numberParameter(call, 'maxDistance', 128)
  const stopAtBlockingTerrain = booleanParameter(call, 'stopAtBlockingTerrain', true)
  if (!origin || !direction || maxDistance === undefined || stopAtBlockingTerrain === undefined) return undefined

  if (!stopAtBlockingTerrain) {
    return {
      statements: [finalCall(call, 'projectile.events-from-cell', { origin, direction }, { maxDistance })],
      outputs: { events: output(call.id, 'events') },
    }
  }

  const statements: GameplayStatement[] = []
  const events = fresh('bounded-events')
  statements.push(generatedCall(events, 'projectile.events-from-cell', { origin, direction }, { maxDistance }))

  const stopIndex = fresh('bounded-stop-index')
  const reduceBody: GameplayStatement[] = []
  const kind = fresh('bounded-kind')
  const boundary = fresh('bounded-boundary')
  const terrain = fresh('bounded-terrain')
  const blocks = fresh('bounded-blocks')
  const terrainBlocked = fresh('bounded-terrain-blocked')
  const stop = fresh('bounded-stop')
  const first = fresh('bounded-first')
  const selected = fresh('bounded-selected')
  const index = fresh('bounded-index')
  const accept = fresh('bounded-accept')
  reduceBody.push(
    generatedCall(kind, 'projectile.event-kind', { event: input('event') }),
    compare(boundary, output(kind, 'kind'), literal('boundary'), stringType),
    compare(terrain, output(kind, 'kind'), literal('terrain'), stringType),
    generatedCall(blocks, 'projectile.event-blocks', { event: input('event') }),
    and(terrainBlocked, output(terrain), output(blocks, 'blocks')),
    or(stop, output(boundary), output(terrainBlocked)),
    compare(first, input('accumulator'), literal(0), numberType),
    and(accept, output(stop), output(first)),
    generatedCall(index, 'math.add', { left: input('index'), right: literal(1) }),
    generatedCall(selected, 'value.select-number', {
      condition: output(accept), whenTrue: output(index), whenFalse: input('accumulator'),
    }),
    returnValue(fresh('bounded-reduce-return'), output(selected)),
  )
  statements.push(collection(stopIndex, 'reduce', output(events, 'events'), reduceBody, {
    item: 'event', index: 'index', accumulator: 'accumulator', initial: literal(0),
  }))

  const eventCount = fresh('bounded-event-count')
  const hasStop = fresh('bounded-has-stop')
  const selectedCount = fresh('bounded-count')
  statements.push(
    generatedCall(eventCount, 'collection.length', { items: output(events, 'events') }),
    compare(hasStop, output(stopIndex), literal(0), numberType, '>'),
    generatedCall(selectedCount, 'value.select-number', {
      condition: output(hasStop), whenTrue: output(stopIndex), whenFalse: output(eventCount),
    }),
    finalCall(call, 'collection.slice', {
      items: output(events, 'events'), start: literal(1), count: output(selectedCount),
    }),
  )
  return { statements, outputs: { events: output(call.id, 'items') } }
}

function traceUntilBlockerReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(call, 'source')
  const target = requiredInput(call, 'target')
  const maxDistance = numberParameter(call, 'maxDistance', 99)
  if (!source || !target || maxDistance === undefined) return undefined

  const statements: GameplayStatement[] = []
  const piecesResult = fresh('blocker-pieces-result')
  const firstCellResult = fresh('blocker-first-cell-result')
  const validResult = fresh('blocker-valid-result')
  const sameCellResult = fresh('blocker-same-cell-result')
  const distanceResult = fresh('blocker-distance-result')
  statements.push(
    localCall(piecesResult, 'local.declare', { initial: literal([]) }, pieceListType),
    localCall(firstCellResult, 'local.declare', { initial: literal(null) }, nullableCellType),
    localCall(validResult, 'local.declare', { initial: literal(false) }, booleanType),
    localCall(sameCellResult, 'local.declare', { initial: literal(false) }, booleanType),
    localCall(distanceResult, 'local.declare', { initial: literal(0) }, numberType),
  )
  const sourceExists = fresh('blocker-source-exists')
  statements.push(generatedCall(sourceExists, 'query.has-piece', { pieceId: source }))

  const branch: GameplayStatement[] = []
  const trace = fresh('blocker-trace')
  const enemies = fresh('blocker-enemy-ids')
  branch.push(
    generatedCall(trace, 'projectile.trace', { source, target }, { maxDistance }),
    queryPieces(enemies, { originId: source }, { relation: 'enemy', includeDead: false }),
    localCall(fresh('blocker-valid-write'), 'local.write', { handle: output(validResult, 'handle'), value: output(trace, 'valid') }, booleanType),
    localCall(fresh('blocker-same-cell-write'), 'local.write', { handle: output(sameCellResult, 'handle'), value: output(trace, 'sameCell') }, booleanType),
    localCall(fresh('blocker-distance-write'), 'local.write', { handle: output(distanceResult, 'handle'), value: output(trace, 'distance') }, numberType),
  )

  const prefixIndex = fresh('blocker-prefix-index')
  const reduceBody: GameplayStatement[] = []
  const kind = fresh('blocker-kind')
  const boundary = fresh('blocker-boundary')
  const terrain = fresh('blocker-terrain')
  const blocks = fresh('blocker-blocks')
  const terrainBlocked = fresh('blocker-terrain-blocked')
  const terrainStop = fresh('blocker-terrain-stop')
  const piece = fresh('blocker-piece')
  const pieceId = fresh('blocker-piece-id')
  const enemyMatch = fresh('blocker-enemy-match')
  const nonEnemy = fresh('blocker-non-enemy')
  const pieceStop = fresh('blocker-piece-stop')
  const stop = fresh('blocker-stop')
  const first = fresh('blocker-first')
  const matches = fresh('blocker-matches')
  const index = fresh('blocker-index')
  const selected = fresh('blocker-selected')
  reduceBody.push(
    generatedCall(kind, 'projectile.event-kind', { event: input('event') }),
    compare(boundary, output(kind, 'kind'), literal('boundary'), stringType),
    compare(terrain, output(kind, 'kind'), literal('terrain'), stringType),
    generatedCall(blocks, 'projectile.event-blocks', { event: input('event') }),
    and(terrainBlocked, output(terrain), output(blocks, 'blocks')),
    or(terrainStop, output(boundary), output(terrainBlocked)),
    compare(piece, output(kind, 'kind'), literal('piece'), stringType),
    generatedCall(pieceId, 'projectile.event-piece-id', { event: input('event') }),
    generatedCall(enemyMatch, 'collection.contains', { items: input('enemyIds'), value: output(pieceId, 'piece') }, {
      valueType: typeParameter(pieceType), itemsType: typeParameter(pieceListType),
    }),
    not(nonEnemy, output(enemyMatch)),
    and(pieceStop, output(piece), output(nonEnemy)),
    or(stop, output(terrainStop), output(pieceStop)),
    compare(first, input('accumulator'), literal(0), numberType),
    and(matches, output(stop), output(first)),
    generatedCall(index, 'math.add', { left: input('index'), right: literal(1) }),
    generatedCall(selected, 'logic.select', {
      condition: output(matches), whenTrue: output(index), whenFalse: input('accumulator'),
    }, { valueType: typeParameter(numberType) }),
    returnValue(fresh('blocker-reduce-return'), output(selected)),
  )
  branch.push(collection(prefixIndex, 'reduce', output(trace, 'events'), reduceBody, {
    item: 'event', index: 'index', accumulator: 'accumulator', initial: literal(0),
    inputs: { enemyIds: output(enemies, 'pieces') },
  }))

  const eventCount = fresh('blocker-event-count')
  const hasStop = fresh('blocker-has-stop')
  const beforeStop = fresh('blocker-before-stop')
  const prefixCount = fresh('blocker-prefix-count')
  const prefix = fresh('blocker-prefix')
  branch.push(
    generatedCall(eventCount, 'collection.length', { items: output(trace, 'events') }),
    compare(hasStop, output(prefixIndex), literal(0), numberType, '>'),
    generatedCall(beforeStop, 'math.subtract', { left: output(prefixIndex), right: literal(1) }),
    generatedCall(prefixCount, 'value.select-number', {
      condition: output(hasStop), whenTrue: output(beforeStop), whenFalse: output(eventCount),
    }),
    generatedCall(prefix, 'collection.slice', {
      items: output(trace, 'events'), start: literal(1), count: output(prefixCount),
    }),
  )

  const filtered = fresh('blocker-enemy-events')
  const filterBody: GameplayStatement[] = []
  const filterKind = fresh('blocker-filter-kind')
  const filterPiece = fresh('blocker-filter-piece')
  const filterIsPiece = fresh('blocker-filter-is-piece')
  const filterMatch = fresh('blocker-filter-match')
  const filterAccepted = fresh('blocker-filter-accepted')
  filterBody.push(
    generatedCall(filterKind, 'projectile.event-kind', { event: input('event') }),
    compare(filterIsPiece, output(filterKind, 'kind'), literal('piece'), stringType),
    generatedCall(filterPiece, 'projectile.event-piece-id', { event: input('event') }),
    generatedCall(filterMatch, 'collection.contains', { items: input('enemyIds'), value: output(filterPiece, 'piece') }, {
      valueType: typeParameter(pieceType), itemsType: typeParameter(pieceListType),
    }),
    and(filterAccepted, output(filterIsPiece), output(filterMatch)),
    returnValue(fresh('blocker-filter-return'), output(filterAccepted)),
  )
  branch.push(collection(filtered, 'filter', output(prefix, 'items'), filterBody, {
    item: 'event', inputs: { enemyIds: output(enemies, 'pieces') },
  }))

  const mapped = fresh('blocker-enemy-pieces')
  const mapBody: GameplayStatement[] = [
    generatedCall(fresh('blocker-map-piece'), 'projectile.event-piece-id', { event: input('event') }),
  ]
  mapBody.push(returnValue(fresh('blocker-map-return'), output(mapBody[0].id, 'piece')))
  branch.push(collection(mapped, 'map', output(filtered), mapBody, { item: 'event' }))

  const distinct = fresh('blocker-distinct-pieces')
  branch.push(generatedCall(distinct, 'collection.distinct', { items: output(mapped) }, {
    valueType: typeParameter(pieceListType),
  }))
  branch.push(localCall(fresh('blocker-pieces-write'), 'local.write', {
    handle: output(piecesResult, 'handle'), value: output(distinct, 'value'),
  }, pieceListType))

  const firstEvent = fresh('blocker-first-event')
  const firstBody: GameplayStatement[] = []
  const firstKind = fresh('blocker-first-kind')
  const firstPiece = fresh('blocker-first-piece')
  const firstIsPiece = fresh('blocker-first-is-piece')
  const firstMatch = fresh('blocker-first-match')
  const firstAccepted = fresh('blocker-first-accepted')
  firstBody.push(
    generatedCall(firstKind, 'projectile.event-kind', { event: input('event') }),
    compare(firstIsPiece, output(firstKind, 'kind'), literal('piece'), stringType),
    generatedCall(firstPiece, 'projectile.event-piece-id', { event: input('event') }),
    generatedCall(firstMatch, 'collection.contains', { items: input('enemyIds'), value: output(firstPiece, 'piece') }, {
      valueType: typeParameter(pieceType), itemsType: typeParameter(pieceListType),
    }),
    and(firstAccepted, output(firstIsPiece), output(firstMatch)),
    returnValue(fresh('blocker-first-return'), output(firstAccepted)),
  )
  branch.push(collection(firstEvent, 'find', output(prefix, 'items'), firstBody, {
    item: 'event', inputs: { enemyIds: output(enemies, 'pieces') },
  }))
  const firstPresent = fresh('blocker-first-present')
  branch.push(compare(firstPresent, output(firstEvent), literal(null), nullableEventType, '!='))
  const firstThen: GameplayStatement[] = []
  const firstCell = fresh('blocker-first-cell')
  firstThen.push(
    generatedCall(firstCell, 'projectile.event-cell', { event: output(firstEvent) }),
    localCall(fresh('blocker-first-cell-write'), 'local.write', {
      handle: output(firstCellResult, 'handle'), value: output(firstCell, 'cell'),
    }, nullableCellType),
  )
  branch.push({ kind: 'if', id: fresh('blocker-first-branch'), condition: output(firstPresent), then: firstThen })
  statements.push({ kind: 'if', id: fresh('blocker-source-branch'), condition: output(sourceExists, 'exists'), then: branch })

  const piecesRead = fresh('blocker-pieces-read')
  const firstCellRead = fresh('blocker-first-cell-read')
  const validRead = fresh('blocker-valid-read')
  const sameCellRead = fresh('blocker-same-cell-read')
  const distanceRead = fresh('blocker-distance-read')
  statements.push(
    localCall(piecesRead, 'local.read', { handle: output(piecesResult, 'handle') }, pieceListType),
    localCall(firstCellRead, 'local.read', { handle: output(firstCellResult, 'handle') }, nullableCellType),
    localCall(validRead, 'local.read', { handle: output(validResult, 'handle') }, booleanType),
    localCall(sameCellRead, 'local.read', { handle: output(sameCellResult, 'handle') }, booleanType),
    localCall(distanceRead, 'local.read', { handle: output(distanceResult, 'handle') }, numberType),
  )
  return {
    statements,
    outputs: {
      enemyPieces: output(piecesRead),
      firstCell: output(firstCellRead),
      valid: output(validRead),
      sameCell: output(sameCellRead),
      distance: output(distanceRead),
    },
  }
}

function shuffleCardinalReplacement(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(call, 'target')
  if (!target) return undefined
  const statements: GameplayStatement[] = []
  const cells = fresh('cardinal-cells')
  statements.push(generatedCall(cells, 'spatial.cardinal-cells-ordered', { target }, { order: 'up-right-down-left' }))
  statements.push(finalCall(call, 'collection.shuffle', { items: output(cells, 'cells') }))
  return { statements, outputs: { cells: output(call.id, 'items') } }
}

export const atomicProjectileQueryRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  switch (call.module) {
    case 'projectile.trace-enemies': return traceEnemiesReplacement(call, fresh)
    case 'query.faction-enemies-on-cells': return factionEnemiesReplacement(call, fresh)
    case 'query.enemies-on-index': return enemiesOnIndexReplacement(call, fresh)
    case 'spatial.random-cardinal-landing': return randomLandingReplacement(call, fresh)
    case 'movement.first-piece-on-trace': return firstPieceReplacement(call, fresh)
    case 'movement.bounce-candidates': return bounceCandidatesReplacement(call, fresh)
    case 'projectile.first-enemy-on-path': return firstEnemyReplacement(call, fresh)
    case 'spatial.shuffle-cardinal-cells': return shuffleCardinalReplacement(call, fresh)
    case 'projectile.events-from-cell-bounded': return boundedEventsReplacement(call, fresh)
    case 'projectile.trace-until-blocker': return traceUntilBlockerReplacement(call, fresh)
    default: return undefined
  }
}

export function migrateProjectileQueryModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return repairProjectileBlockerBranches(rewriteAtomicGraph(graph, atomicProjectileQueryRecipe))
}

/** Older expansions evaluated piece-only fields even for terrain events.
 * Branch on the event kind before reading an instance reference so a valid
 * terrain stop cannot be invalidated by an unrelated, absent piece field. */
export function repairProjectileBlockerBranches(graph: GameplayModuleGraph): GameplayModuleGraph {
  function visit(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(visit)
    const record = value as Record<string, unknown>
    if (record.kind === 'literal') return value
    const next = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]))
    if (next.kind !== 'collection' || next.method !== 'reduce' || typeof next.id !== 'string'
      || !next.id.endsWith('blocker-prefix-index') || !Array.isArray(next.body)) return next
    const body = next.body as GameplayStatement[]
    const suffixes = ['blocker-kind', 'blocker-boundary', 'blocker-terrain', 'blocker-blocks', 'blocker-terrain-blocked', 'blocker-terrain-stop', 'blocker-piece', 'blocker-piece-id', 'blocker-enemy-match', 'blocker-non-enemy', 'blocker-piece-stop', 'blocker-stop', 'blocker-first', 'blocker-matches', 'blocker-index', 'blocker-selected', 'blocker-reduce-return']
    if (body.length !== suffixes.length || body.some((item, index) => !item.id.endsWith(suffixes[index]))) return next
    const accumulator = input(typeof next.accumulator === 'string' ? next.accumulator : 'accumulator')
    const at = output(body[14].id)
    next.body = [
      body[12],
      { kind: 'if', id: next.id + '--first-branch', condition: output(body[12].id), then: [
        ...body.slice(0, 6), body[14],
        { kind: 'if', id: next.id + '--terrain-branch', condition: output(body[5].id), then: [returnValue(next.id + '--terrain-return', at)] },
        body[6],
        { kind: 'if', id: next.id + '--piece-branch', condition: output(body[6].id), then: [
          ...body.slice(7, 10),
          { kind: 'if', id: next.id + '--ally-branch', condition: output(body[9].id), then: [returnValue(next.id + '--ally-return', at)] },
        ] },
      ] },
      returnValue(body[16].id, accumulator),
    ] satisfies GameplayStatement[]
    return next
  }
  return visit(graph) as GameplayModuleGraph
}

export const migrateAtomicProjectileQueryGraph = migrateProjectileQueryModules
