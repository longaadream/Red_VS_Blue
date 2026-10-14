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

/** Compatibility card helpers replaced by the generic hand/field pipeline. */
export const ATOMIC_HAND_QUERY_MODULES = new Set([
  'content.filter-hand',
  'card.hand-instances-by-definition-ids',
  'query.hand-card-instances',
  'card.bound-living-template',
  'card.find-content-records',
  'card.read-definition-id',
  'card.read-definition-name',
  'card.read-content-boolean',
])

export const ATOMIC_HAND_QUERY_MODULE_IDS = ATOMIC_HAND_QUERY_MODULES

const nullableRecord: GameplayValueType = { kind: 'nullable', value: 'record' }
const nullableString: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullableNumber: GameplayValueType = { kind: 'nullable', value: 'number' }
const nullablePiece: GameplayValueType = { kind: 'nullable', value: 'piece' }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
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

function finalCall(
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

function or(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'logic.or', { left, right })
}

function coalesce(
  id: string,
  value: GameplayValue,
  defaultValue: GameplayValue,
  type: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'value.coalesce', { value, defaultValue }, { valueType: valueTypeParameter(type) })
}

function collection(
  id: string,
  method: 'map' | 'filter' | 'find',
  items: GameplayValue,
  body: readonly GameplayStatement[],
  options: { readonly item?: string; readonly inputs?: Readonly<Record<string, GameplayValue>> } = {},
): GameplayStatement {
  return {
    kind: 'collection', id, method, items,
    item: options.item ?? 'item',
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    body,
  }
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function instanceField(id: string, card: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, 'card.instance-field', { card }, { field })
}

function definitionField(id: string, card: GameplayValue, field: 'id' | 'name'): GameplayCallStatement {
  return generatedCall(id, 'card.definition-field', { card }, { field })
}

function contentField(id: string, record: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, 'card.content-field', { record }, { field })
}

function hand(id: string, player: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'card.hand-records', { player })
}

function filterDefinitionItems(
  id: string,
  items: GameplayValue,
  cardIds: GameplayValue,
  fresh: (suffix: string) => string,
): GameplayStatement {
  const definition = fresh('definition-id')
  const candidateMatch = fresh('candidate-match')
  const candidates = fresh('definition-candidates')
  const candidateCount = fresh('definition-count')
  const included = fresh('definition-included')
  return {
    kind: 'collection', id, method: 'filter', items, item: 'item', body: [
      definitionField(definition, input('item'), 'id'),
      {
        kind: 'collection', id: candidates, method: 'filter', items: cardIds, item: 'candidate',
        inputs: { current: output(definition) },
        body: [
          compare(candidateMatch, input('candidate'), input('current'), 'string'),
          returnValue(fresh('candidate-return'), output(candidateMatch)),
        ],
      },
      generatedCall(candidateCount, 'collection.length', { items: output(candidates) }),
      compare(included, output(candidateCount), literal(0), 'number', '!='),
      returnValue(fresh('filter-return'), output(included)),
    ],
  }
}

function contentFilterReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const player = node.inputs?.player ?? literal(null)
  const handNode = fresh('hand')
  const filtered = fresh('filtered-hand')
  const mapped = node.id
  const handStatement = hand(handNode, player)
  const nameContains = typeof node.parameters?.nameContains === 'string' ? node.parameters.nameContains : undefined
  const cardIdPrefix = typeof node.parameters?.cardIdPrefix === 'string' ? node.parameters.cardIdPrefix : undefined
  const body: GameplayStatement[] = []
  const matches: GameplayValue[] = []
  if (nameContains !== undefined) {
    const name = fresh('name')
    const nameMatch = fresh('name-match')
    body.push(instanceField(name, input('item'), 'name'))
    body.push(generatedCall(nameMatch, 'text.contains', { text: output(name), value: literal(nameContains) }))
    matches.push(output(nameMatch))
  }
  if (cardIdPrefix !== undefined) {
    const definition = fresh('definition-id')
    const prefixMatch = fresh('prefix-match')
    body.push(definitionField(definition, input('item'), 'id'))
    body.push(generatedCall(prefixMatch, 'text.starts-with', { text: output(definition), value: literal(cardIdPrefix) }))
    matches.push(output(prefixMatch))
  }
  const match = matches.length === 0
    ? literal(false)
    : matches.length === 1
      ? matches[0]
      : (body.push(or(fresh('either-match'), matches[0], matches[1])), output(body[body.length - 1].id))
  body.push(returnValue(fresh('filter-return'), match))
  const filter = collection(filtered, 'filter', output(handNode, 'cards'), body)
  const definition = fresh('mapped-definition-id')
  const mapBody: GameplayStatement[] = [
    definitionField(definition, input('item'), 'id'),
    returnValue(fresh('map-return'), output(definition)),
  ]
  const map = collection(mapped, 'map', output(filtered), mapBody)
  return {
    statements: [handStatement, filter, map],
    outputs: { cards: output(mapped), hasHand: output(handNode, 'hasHand') },
  }
}

function handInstancesByDefinitionsReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const player = node.inputs?.player ?? literal(null)
  const handNode = fresh('hand')
  const filtered = fresh('matching-hand')
  const cardIds = literal(Array.isArray(node.parameters?.cardIds) ? node.parameters.cardIds : [])
  const filter = filterDefinitionItems(filtered, output(handNode, 'cards'), cardIds, fresh)
  const instanceId = fresh('instance-id')
  const mapBody: GameplayStatement[] = [
    instanceField(instanceId, input('item'), 'instanceId'),
    returnValue(fresh('map-return'), output(instanceId)),
  ]
  const map = collection(node.id, 'map', output(filtered), mapBody)
  return {
    statements: [hand(handNode, player), filter, map],
    outputs: { cards: output(node.id) },
  }
}

function boundLivingTemplateReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const owner = node.inputs?.owner ?? literal(null)
  const handNode = fresh('hand')
  const boundCard = fresh('bound-card')
  const cardId = literal(typeof node.parameters?.cardId === 'string' ? node.parameters.cardId : '')
  const boundId = fresh('bound-id')
  const cardMatch = fresh('card-match')
  const boundPresent = fresh('bound-present')
  const findBody: GameplayStatement[] = [
    definitionField(fresh('definition-id'), input('item'), 'id'),
  ]
  const definitionNode = findBody[0] as GameplayCallStatement
  const definitionMatch = fresh('card-match')
  findBody.push(compare(definitionMatch, output(definitionNode.id), cardId, 'string'))
  const fieldNode = instanceField(boundId, input('item'), 'boundPieceInstanceId')
  const boundCheck = fresh('bound-check')
  findBody.push(fieldNode, compare(boundCheck, output(boundId), literal(null), nullablePiece, '!='), and(cardMatch, output(definitionMatch), output(boundCheck)), returnValue(fresh('find-return'), output(cardMatch)))
  const find = collection(boundCard, 'find', output(handNode, 'cards'), findBody)
  const selectedBound = fresh('selected-bound')
  const selectedBoundField = instanceField(selectedBound, output(boundCard), 'boundPieceInstanceId')
  const boundAlive = fresh('bound-alive')
  const boundPieceRaw = fresh('bound-piece-raw')
  const boundNull = fresh('bound-null')
  const boundPiece = fresh('bound-piece')
  const fallback = fresh('template-fallback')
  const boundPieceValue = generatedCall(boundPiece, 'logic.select', {
    condition: output(boundAlive, 'alive'),
    whenTrue: output(boundPieceRaw, 'piece'),
    whenFalse: output(boundNull, 'piece'),
  }, { valueType: valueTypeParameter(nullablePiece) })
  const selected = finalCall(node, 'logic.select', {
    condition: output(boundPresent),
    whenTrue: output(boundPiece),
    whenFalse: output(fallback, 'piece'),
  }, { valueType: valueTypeParameter(nullablePiece) })
  return {
    statements: [
      hand(handNode, owner),
      find,
      compare(boundPresent, output(boundCard), literal(null), nullableRecord, '!='),
      selectedBoundField,
      generatedCall(boundAlive, 'piece.alive', { piece: output(selectedBound) }),
      generatedCall(boundPieceRaw, 'query.piece', { pieceId: output(selectedBound) }),
      generatedCall(boundNull, 'query.piece', { pieceId: literal(null) }),
      boundPieceValue,
      generatedCall(fallback, 'query.living-template', { owner }, { templateId: typeof node.parameters?.templateId === 'string' ? node.parameters.templateId : '' }),
      selected,
    ],
    outputs: { piece: output(node.id) },
  }
}

function findContentRecordsReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const player = node.inputs?.player ?? literal(null)
  const source = node.inputs?.source ?? literal(null)
  const turn = node.inputs?.turn ?? literal(0)
  const handNode = fresh('hand')
  const filtered = fresh('matching-records')
  const fieldName = typeof node.parameters?.field === 'string' ? node.parameters.field : 'velenHolyProphecy'
  const sourceIdentity = fresh('source-identity')
  const sourceId = fresh('source-id')
  const filterBody: GameplayStatement[] = [
    instanceField(fresh('content-state'), input('item'), 'contentState'),
  ]
  const contentState = filterBody[0] as GameplayCallStatement
  const record = fresh('content-record')
  filterBody.push(contentField(record, output(contentState.id), fieldName))
  const recordPresent = fresh('record-present')
  filterBody.push(compare(recordPresent, output(record), literal(null), nullableRecord, '!='))
  const recordSource = fresh('record-source')
  filterBody.push(contentField(recordSource, output(record), 'sourcePieceId'))
  const sourceMatch = fresh('source-match')
  filterBody.push(compare(sourceMatch, output(recordSource), input('sourceId'), nullableString))
  const created = fresh('created-turn')
  filterBody.push(contentField(created, output(record), 'createdTurnNumber'))
  const createdFallback = fresh('created-fallback')
  filterBody.push(coalesce(createdFallback, output(created), input('turn'), 'number'))
  const beforeTurn = fresh('before-turn')
  filterBody.push(generatedCall(beforeTurn, 'compare.less-than', { left: output(createdFallback), right: input('turn') }))
  const createdMissing = fresh('created-missing')
  filterBody.push(compare(createdMissing, output(created), literal(null), nullableNumber))
  const createdAllowed = fresh('created-allowed')
  filterBody.push(or(createdAllowed, output(createdMissing), output(beforeTurn)))
  const matchesSource = fresh('record-source-and-turn')
  filterBody.push(and(matchesSource, output(sourceMatch), output(createdAllowed)))
  const matches = fresh('record-match')
  filterBody.push(and(matches, output(recordPresent), output(matchesSource)))
  filterBody.push(returnValue(fresh('filter-return'), output(matches)))
  const filter = collection(filtered, 'filter', output(handNode, 'cards'), filterBody, { inputs: { sourceId: output(sourceIdentity), turn } })
  const mapBody: GameplayStatement[] = [
    instanceField(sourceId, input('item'), 'instanceId'),
    returnValue(fresh('map-return'), output(sourceId)),
  ]
  const map = collection(node.id, 'map', output(filtered), mapBody)
  return {
    statements: [
      generatedCall(sourceIdentity, 'piece.field', { piece: source }, { field: 'instanceId' }),
      hand(handNode, player), filter, map,
    ],
    outputs: { cards: output(node.id) },
  }
}

function findHandCardReplacement(
  node: GameplayCallStatement,
  fresh: (suffix: string) => string,
  definition: boolean,
): AtomicReplacement {
  const player = node.inputs?.player ?? literal(null)
  const instanceId = node.inputs?.card ?? literal('')
  const handNode = fresh('hand')
  const found = fresh('card')
  const fieldNode = fresh('card-instance-id')
  const match = fresh('card-match')
  const find = collection(found, 'find', output(handNode, 'cards'), [
    instanceField(fieldNode, input('item'), 'instanceId'),
    compare(match, output(fieldNode), input('requestedCard'), 'string'),
    returnValue(fresh('find-return'), output(match)),
  ], { inputs: { requestedCard: instanceId } })
  const valueNode = definition
    ? definitionField(fresh('definition-id'), output(found), 'id')
    : finalCall(node, 'card.definition-field', { card: output(found) }, { field: 'name' })
  if (definition) {
    const fallback = finalCall(node, 'value.coalesce', { value: output(valueNode.id), defaultValue: literal('') }, { valueType: 'string' })
    return { statements: [hand(handNode, player), find, valueNode, fallback], outputs: { cardId: output(node.id) } }
  }
  return { statements: [hand(handNode, player), find, valueNode], outputs: { name: output(node.id) } }
}

function readContentBooleanReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const player = node.inputs?.player ?? literal(null)
  const instanceId = node.inputs?.card ?? literal('')
  const handNode = fresh('hand')
  const found = fresh('card')
  const fieldNode = fresh('card-instance-id')
  const match = fresh('card-match')
  const find = collection(found, 'find', output(handNode, 'cards'), [
    instanceField(fieldNode, input('item'), 'instanceId'),
    compare(match, output(fieldNode), input('requestedCard'), 'string'),
    returnValue(fresh('find-return'), output(match)),
  ], { inputs: { requestedCard: instanceId } })
  const contentState = fresh('content-state')
  const stateRecord = fresh('state-record')
  const fieldName = typeof node.parameters?.field === 'string' ? node.parameters.field : 'velenHolyProphecy'
  const state = instanceField(stateRecord, output(found), 'contentState')
  const content = contentField(contentState, output(stateRecord), fieldName)
  if (fieldName === 'velenHolyProphecyEnhanced') {
    const final = finalCall(node, 'card.content-field', { record: output(stateRecord) }, { field: fieldName })
    return { statements: [hand(handNode, player), find, state, final], outputs: { value: output(node.id) } }
  }
  const result = finalCall(node, 'compare.values', { left: output(contentState), right: literal(null) }, {
    valueType: valueTypeParameter(nullableRecord), operator: '!=',
  })
  return { statements: [hand(handNode, player), find, state, content, result], outputs: { value: output(node.id) } }
}

/** Rewrite one retired hand/card helper into generic hand reads and fields. */
export const atomicHandQueryRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  switch (node.module) {
    case 'content.filter-hand': return contentFilterReplacement(node, fresh)
    case 'card.hand-instances-by-definition-ids': return handInstancesByDefinitionsReplacement(node, fresh)
    case 'query.hand-card-instances': return handInstancesByDefinitionsReplacement({ ...node, parameters: { cardIds: [node.parameters!.cardId] } }, fresh)
    case 'card.bound-living-template': return boundLivingTemplateReplacement(node, fresh)
    case 'card.find-content-records': return findContentRecordsReplacement(node, fresh)
    case 'card.read-definition-id': return findHandCardReplacement(node, fresh, true)
    case 'card.read-definition-name': return findHandCardReplacement(node, fresh, false)
    case 'card.read-content-boolean': return readContentBooleanReplacement(node, fresh)
    default: return undefined
  }
}

export function migrateHandQueryModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicHandQueryRecipe)
}

export const migrateAtomicHandQueryGraph = migrateHandQueryModules
