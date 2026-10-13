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
const nullableStatus: GameplayValueType = { kind: 'nullable', value: 'status' }
const nullablePiece: GameplayValueType = { kind: 'nullable', value: 'piece' }
const nullableRecord: GameplayValueType = { kind: 'nullable', value: 'record' }
const nullableCellList: GameplayValueType = { kind: 'nullable', value: { kind: 'list', element: 'cell' } }
const cellList: GameplayValueType = { kind: 'list', element: 'cell' }
const stringList: GameplayValueType = { kind: 'list', element: 'string' }

const STATUS_NUMBER_FIELDS = new Set([
  'stacks', 'intensity', 'currentDuration', 'remainingDuration', 'currentUses', 'remainingUses', 'value',
])
const STATUS_RECORD_NUMBER_FIELDS = new Set(['stacks', 'intensity', 'hitCount', 'readyCharges'])
const STATUS_NUMBER_FIELD_FIELDS = new Set([
  'dx', 'dy', 'damage', 'turns', 'intensity', 'stacks', 'createdTurnNumber', 'currentDuration', 'currentUses',
])
const STATUS_TRUTHY_FIELDS = new Set(['intensity', 'stacks'])
const PLAYER_TRUTHY_FIELDS = new Set(['intensity', 'value', 'extraValue'])
const PLAYER_NUMBER_FIELDS = new Set(['centerX', 'centerY', 'damage'])

/** Compatibility module IDs lowered by this recipe. */
export const ATOMIC_STATUS_FIELD_MODULES = new Set([
  'status.find-id',
  'status.find-id-by-id',
  'status.find-id-by-number',
  'status.find-id-by-prefix',
  'status.list-ids',
  'status.read-number',
  'status.read-record-number',
  'status.read-number-field',
  'status.read-number-instance',
  'status.read-number-truthy',
  'status.read-player-field',
  'status.read-duration',
  'status.read-uses',
  'status.read-uses-fallback',
  'status.read-turn-number',
  'status.read-player-number',
  'status.read-player-number-truthy',
  'status.read-player-text-field',
  'status.read-text-field',
  'status.find-player-id',
  'status.find-player-id-at',
  'status.find-source-before-id',
  'status.read-cell-field',
  'status.read-cell-list',
  'status.find-flight',
  'status.read-live-source',
  'status.read-reference',
  'status.read-piece-reference',
])

/** Alias used by catalogs that expose retired compatibility IDs. */
export const ATOMIC_STATUS_FIELD_MODULE_IDS = ATOMIC_STATUS_FIELD_MODULES

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
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version: '1', inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

/** Keep source metadata on the final replacement statement. */
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

function optionalField(id: string, record: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, 'data.optional-field', { record }, { field })
}

function readKey(id: string, record: GameplayValue, key: string, type: GameplayValueType): GameplayCallStatement {
  return generatedCall(id, 'data.read-key', { record }, {
    key,
    valueType: valueTypeParameter({ kind: 'nullable', value: type }),
  })
}

function fieldRead(id: string, module: 'piece.field' | 'player.field', owner: string, value: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, module, { [owner]: value }, { field })
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

function coalesce(
  id: string,
  value: GameplayValue,
  defaultValue: GameplayValue,
  type: GameplayValueType,
): GameplayCallStatement {
  return generatedCall(id, 'value.coalesce', { value, defaultValue }, { valueType: valueTypeParameter(type) })
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

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

type StatusOwner = {
  readonly module: 'piece.field' | 'player.field'
  readonly input: 'piece' | 'player'
  readonly value: GameplayValue
}

function statusTags(id: string, owner: StatusOwner): GameplayCallStatement {
  return fieldRead(id, owner.module, owner.input, owner.value, 'statusTags')
}

function findCollection(
  id: string,
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'find', items, item: 'item',
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function findTagById(id: string, tags: GameplayValue, statusId: GameplayValue, fresh: (suffix: string) => string): GameplayStatement {
  const tagId = fresh('tag-id')
  const idDefined = fresh('id-defined')
  const idMatch = fresh('id-match')
  const result = fresh('id-and-match')
  return findCollection(id, tags, [
    optionalField(tagId, input('item'), 'id'),
    compare(idDefined, output(tagId, 'defined'), literal(true), 'boolean'),
    compare(idMatch, output(tagId), input('statusId'), nullableString),
    and(result, output(idDefined), output(idMatch)),
    returnValue(fresh('find-return'), output(result)),
  ], { statusId })
}

function findTagByPrefix(id: string, tags: GameplayValue, prefix: string, fresh: (suffix: string) => string): GameplayStatement {
  const tagId = fresh('tag-id')
  const prefixMatch = fresh('prefix-match')
  return findCollection(id, tags, [
    optionalField(tagId, input('item'), 'id'),
    generatedCall(prefixMatch, 'text.starts-with', { text: output(tagId), value: literal(prefix) }),
    returnValue(fresh('find-return'), output(prefixMatch)),
  ])
}

function findTagByType(id: string, tags: GameplayValue, statusType: string, fresh: (suffix: string) => string): GameplayStatement {
  const tagType = fresh('tag-type')
  const typeMatch = fresh('type-match')
  return findCollection(id, tags, [
    optionalField(tagType, input('item'), 'type'),
    compare(typeMatch, output(tagType), literal(statusType), nullableString),
    returnValue(fresh('find-return'), output(typeMatch)),
  ])
}

function findTagByTypeAndNumber(
  id: string,
  tags: GameplayValue,
  statusType: string,
  field: string,
  expected: GameplayValue,
  fresh: (suffix: string) => string,
): GameplayStatement {
  const tagType = fresh('tag-type')
  const typeMatch = fresh('type-match')
  const tagValue = fresh('tag-value')
  const valueDefined = fresh('value-defined')
  const normalizedValue = fresh('normalized-value')
  const valueMatch = fresh('value-match')
  const both = fresh('type-and-value')
  const match = fresh('find-match')
  return findCollection(id, tags, [
    optionalField(tagType, input('item'), 'type'),
    compare(typeMatch, output(tagType), literal(statusType), nullableString),
    optionalField(tagValue, input('item'), field),
    compare(valueDefined, output(tagValue, 'defined'), literal(true), 'boolean'),
    coalesce(normalizedValue, output(tagValue), literal(0), nullableNumber),
    compare(valueMatch, output(normalizedValue), input('expected'), nullableNumber),
    and(both, output(valueDefined), output(valueMatch)),
    and(match, output(typeMatch), output(both)),
    returnValue(fresh('find-return'), output(match)),
  ], { expected })
}

function findTagByPlayerCoordinates(
  id: string,
  tags: GameplayValue,
  statusType: string,
  x: GameplayValue,
  y: GameplayValue,
  fresh: (suffix: string) => string,
): GameplayStatement {
  const tagType = fresh('tag-type')
  const typeMatch = fresh('type-match')
  const tagX = fresh('tag-x')
  const tagY = fresh('tag-y')
  const xMatch = fresh('x-match')
  const yMatch = fresh('y-match')
  const coordinatesMatch = fresh('coordinates-match')
  const result = fresh('find-match')
  return findCollection(id, tags, [
    optionalField(tagType, input('item'), 'type'),
    compare(typeMatch, output(tagType), literal(statusType), nullableString),
    optionalField(tagX, input('item'), 'value'),
    optionalField(tagY, input('item'), 'extraValue'),
    compare(xMatch, output(tagX), input('x'), nullableNumber),
    compare(yMatch, output(tagY), input('y'), nullableNumber),
    and(coordinatesMatch, output(xMatch), output(yMatch)),
    and(result, output(typeMatch), output(coordinatesMatch)),
    returnValue(fresh('find-return'), output(result)),
  ], { x, y })
}

function findTagBeforeTurn(
  id: string,
  tags: GameplayValue,
  statusType: string,
  sourceId: GameplayValue,
  turn: GameplayValue,
  fresh: (suffix: string) => string,
): GameplayStatement {
  const tagType = fresh('tag-type')
  const typeMatch = fresh('type-match')
  const tagSource = fresh('tag-source')
  const sourceMatch = fresh('source-match')
  const tagTurn = fresh('tag-turn')
  const turnValue = fresh('turn-value')
  const turnPresent = fresh('turn-present')
  const selectedTurn = fresh('selected-turn')
  const normalizedTurn = fresh('normalized-turn')
  const turnBefore = fresh('turn-before')
  const sourceAndType = fresh('source-and-type')
  const result = fresh('find-match')
  const beforeMatch = fresh('before-match')
  return findCollection(id, tags, [
    optionalField(tagType, input('item'), 'type'),
    compare(typeMatch, output(tagType), literal(statusType), nullableString),
    optionalField(tagSource, input('item'), 'sourceId'),
    compare(sourceMatch, output(tagSource), input('sourceId'), nullableString),
    optionalField(tagTurn, input('item'), 'createdTurnNumber'),
    compare(turnPresent, output(tagTurn, 'defined'), literal(true), 'boolean'),
    coalesce(turnValue, output(tagTurn), literal(0), nullableNumber),
    select(selectedTurn, output(turnPresent), output(turnValue), input('turn'), nullableNumber),
    coalesce(normalizedTurn, output(selectedTurn), input('turn'), 'number'),
    generatedCall(turnBefore, 'compare.less-than', { left: output(normalizedTurn), right: input('turn') }),
    and(sourceAndType, output(typeMatch), output(sourceMatch)),
    and(result, output(sourceAndType), output(turnPresent)),
    and(beforeMatch, output(result), output(turnBefore)),
    returnValue(fresh('find-return'), output(beforeMatch)),
  ], { sourceId, turn })
}

function idInput(call: GameplayCallStatement): GameplayValue | undefined {
  const direct = requiredInput(call, 'statusId')
  if (direct) return direct
  const parameters = call.parameters ?? {}
  if (!Object.prototype.hasOwnProperty.call(parameters, 'statusId')) return literal(null)
  return typeof parameters.statusId === 'string' ? literal(parameters.statusId) : undefined
}

function statusRecordFromPiece(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
): { statements: GameplayStatement[]; record: GameplayValue } | undefined {
  const piece = requiredInput(call, 'piece')
  const statusId = requiredInput(call, 'statusId')
  if (!piece || !statusId) return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      findTagById(findId, output(tagsId), statusId, fresh),
    ],
    record: output(findId),
  }
}

function statusRecordFromPlayer(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
): { statements: GameplayStatement[]; record: GameplayValue } | undefined {
  const player = requiredInput(call, 'player')
  const statusId = requiredInput(call, 'statusId')
  if (!player || !statusId) return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'player.field', input: 'player', value: player }),
      findTagById(findId, output(tagsId), statusId, fresh),
    ],
    record: output(findId),
  }
}

function statusRecordFromInstance(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
): { statements: GameplayStatement[]; record: GameplayValue } | undefined {
  const status = requiredInput(call, 'status')
  if (!status) return undefined
  const fields = fresh('status-fields')
  return {
    statements: [
      // `status.fields` is a pure snapshot read and is therefore legal inside
      // collection bodies.  Its lowering treats a missing handle as a null
      // record; `data.optional-field` then follows the legacy fallback path.
      generatedCall(fields, 'status.fields', { status }),
    ],
    record: output(fields, 'record'),
  }
}

function readNumber(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  allowedFields: ReadonlySet<string>,
  source: (call: GameplayCallStatement, fresh: (suffix: string) => string) => { statements: GameplayStatement[]; record: GameplayValue } | undefined,
  fixedField?: string,
): AtomicReplacement | undefined {
  const field = fixedField ?? call.parameters?.field
  const fallback = requiredInput(call, 'fallback')
  if (typeof field !== 'string' || !allowedFields.has(field) || !fallback) return undefined
  const record = source(call, fresh)
  if (!record) return undefined
  const rawId = fresh('raw')
  const presentId = fresh('present')
  const selectedId = fresh('selected')
  const present = compare(presentId, output(rawId), literal(null), nullableNumber, '!=')
  const selected = select(selectedId, output(presentId), output(rawId), fallback, nullableNumber)
  const result = replaceCall(call, 'value.coalesce', {
    value: output(selectedId), defaultValue: fallback,
  }, { valueType: 'number' })
  return {
    statements: [...record.statements, optionalField(rawId, record.record, field), present, selected, result],
    outputs: { value: output(call.id) },
  }
}

function readTruthyNumber(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  allowedFields: ReadonlySet<string>,
  source: (call: GameplayCallStatement, fresh: (suffix: string) => string) => { statements: GameplayStatement[]; record: GameplayValue } | undefined,
): AtomicReplacement | undefined {
  const field = call.parameters?.field
  const fallback = requiredInput(call, 'fallback')
  if (typeof field !== 'string' || !allowedFields.has(field) || !fallback) return undefined
  const record = source(call, fresh)
  if (!record) return undefined
  const rawId = fresh('raw')
  const normalizedId = fresh('normalized')
  const truthyId = fresh('truthy')
  const selectedId = fresh('selected')
  const normalized = coalesce(normalizedId, output(rawId), fallback, nullableNumber)
  const truthy = compare(truthyId, output(normalizedId), literal(0), nullableNumber, '!=')
  const selected = select(selectedId, output(truthyId), output(normalizedId), fallback, nullableNumber)
  const result = replaceCall(call, 'value.coalesce', {
    value: output(selectedId), defaultValue: fallback,
  }, { valueType: 'number' })
  return {
    statements: [...record.statements, optionalField(rawId, record.record, field), normalized, truthy, selected, result],
    outputs: { value: output(call.id) },
  }
}

function readLifecycleNumber(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  primaryField: string,
  secondaryField: string,
  secondaryTruthy: boolean,
): AtomicReplacement | undefined {
  const fallback = requiredInput(call, 'fallback')
  if (!fallback) return undefined
  const record = statusRecordFromPiece(call, fresh)
  if (!record) return undefined
  const primaryId = fresh('primary')
  const secondaryId = fresh('secondary')
  const secondaryDefinedId = fresh('secondary-defined')
  const primaryValueId = fresh('primary-value')
  const secondaryValueId = fresh('secondary-value')
  const primaryPresentId = fresh('primary-present')
  const primarySelectedId = fresh('primary-selected')
  const statements: GameplayStatement[] = [
    ...record.statements,
    optionalField(primaryId, record.record, primaryField),
    optionalField(secondaryId, record.record, secondaryField),
    compare(primaryPresentId, output(primaryId, 'defined'), literal(true), 'boolean'),
    compare(secondaryDefinedId, output(secondaryId, 'defined'), literal(true), 'boolean'),
    coalesce(primaryValueId, output(primaryId), literal(0), nullableNumber),
  ]
  if (secondaryTruthy) {
    const secondaryNormalizedId = fresh('secondary-normalized')
    const secondaryTruthyId = fresh('secondary-truthy')
    const secondaryFallbackId = fresh('secondary-fallback')
    statements.push(
      coalesce(secondaryNormalizedId, output(secondaryId), fallback, nullableNumber),
      compare(secondaryTruthyId, output(secondaryNormalizedId), literal(0), nullableNumber, '!='),
      select(secondaryFallbackId, output(secondaryTruthyId), output(secondaryNormalizedId), fallback, nullableNumber),
      select(secondaryValueId, output(secondaryDefinedId), output(secondaryFallbackId), fallback, nullableNumber),
    )
  } else {
    const secondaryDefaultId = fresh('secondary-default')
    statements.push(
      coalesce(secondaryDefaultId, output(secondaryId), literal(0), nullableNumber),
      select(secondaryValueId, output(secondaryDefinedId), output(secondaryDefaultId), fallback, nullableNumber),
    )
  }
  statements.push(
    select(primarySelectedId, output(primaryPresentId), output(primaryValueId), output(secondaryValueId), nullableNumber),
  )
  const result = replaceCall(call, 'value.coalesce', {
    value: output(primarySelectedId), defaultValue: output(secondaryValueId),
  }, { valueType: 'number' })
  statements.push(result)
  return { statements, outputs: { value: output(call.id) } }
}

function findId(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const statusType = call.parameters?.statusType
  if (!piece || typeof statusType !== 'string') return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      findTagByType(findId, output(tagsId), statusType, fresh),
      replaceCall(call, 'data.optional-field', { record: output(findId) }, { field: 'id' }),
    ],
    outputs: { id: output(call.id) },
  }
}

function findPlayerId(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(call, 'player')
  const statusType = call.parameters?.statusType
  if (!player || typeof statusType !== 'string') return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'player.field', input: 'player', value: player }),
      findTagByType(findId, output(tagsId), statusType, fresh),
      replaceCall(call, 'data.optional-field', { record: output(findId) }, { field: 'id' }),
    ],
    outputs: { id: output(call.id) },
  }
}

function findIdById(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const statusId = idInput(call)
  if (!piece || !statusId) return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      findTagById(findId, output(tagsId), statusId, fresh),
      replaceCall(call, 'data.optional-field', { record: output(findId) }, { field: 'id' }),
    ],
    outputs: { id: output(call.id) },
  }
}

function findIdByPrefix(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const prefix = call.parameters?.prefix
  if (!piece || typeof prefix !== 'string') return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      findTagByPrefix(findId, output(tagsId), prefix, fresh),
      replaceCall(call, 'data.optional-field', { record: output(findId) }, { field: 'id' }),
    ],
    outputs: { id: output(call.id) },
  }
}

function findIdByNumber(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const expected = requiredInput(call, 'value')
  const statusType = call.parameters?.statusType
  const field = call.parameters?.field
  if (!piece || !expected || typeof statusType !== 'string' || field !== 'turnNumber') return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      findTagByTypeAndNumber(findId, output(tagsId), statusType, field, expected, fresh),
      replaceCall(call, 'data.optional-field', { record: output(findId) }, { field: 'id' }),
    ],
    outputs: { id: output(call.id) },
  }
}

function listIds(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const statusType = call.parameters?.statusType
  if (!piece || typeof statusType !== 'string') return undefined
  const tagsId = fresh('status-tags')
  const matchingId = fresh('matching-statuses')
  const mapId = fresh('status-ids')
  const idId = fresh('id')
  const presentId = fresh('id-present')
  const textId = fresh('id-text')
  const filterTypeId = fresh('filter-tag-type')
  const filterMatchId = fresh('filter-type-match')
  const filtered: GameplayStatement = {
    kind: 'collection', id: matchingId, method: 'filter', items: output(tagsId), item: 'item', body: [
      optionalField(filterTypeId, input('item'), 'type'),
      compare(filterMatchId, output(filterTypeId), literal(statusType), nullableString),
      returnValue(fresh('filter-return'), output(filterMatchId)),
    ],
  }
  const mapped: GameplayStatement = {
    kind: 'collection', id: mapId, method: 'map', items: output(matchingId), item: 'item', body: [
      optionalField(idId, input('item'), 'id'),
      compare(presentId, output(idId), literal(null), nullableString, '!='),
      {
        kind: 'if', id: fresh('id-present-branch'), condition: output(presentId),
        then: [
          generatedCall(textId, 'text.from-value', { value: output(idId) }, { valueType: valueTypeParameter(nullableString) }),
          returnValue(fresh('map-return'), output(textId, 'text')),
        ],
      },
    ],
  }
  const result = replaceCall(call, 'value.coalesce', {
    value: output(mapId), defaultValue: literal([]),
  }, { valueType: valueTypeParameter(stringList) })
  return {
    statements: [
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      filtered,
      // The filter is intentionally named after the source owner above so the
      // following map can capture it without introducing a second status read.
      mapped,
      result,
    ],
    outputs: { ids: output(call.id) },
  }
}

function findPlayerIdAt(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(call, 'player')
  const x = requiredInput(call, 'x')
  const y = requiredInput(call, 'y')
  const statusType = call.parameters?.statusType
  if (!player || !x || !y || typeof statusType !== 'string') return undefined
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      statusTags(tagsId, { module: 'player.field', input: 'player', value: player }),
      findTagByPlayerCoordinates(findId, output(tagsId), statusType, x, y, fresh),
      replaceCall(call, 'data.optional-field', { record: output(findId) }, { field: 'id' }),
    ],
    outputs: { id: output(call.id) },
  }
}

function findSourceBeforeId(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const source = requiredInput(call, 'source')
  const turn = requiredInput(call, 'turn')
  const statusType = call.parameters?.statusType
  if (!piece || !source || !turn || typeof statusType !== 'string') return undefined
  const sourceId = fresh('source-id')
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  return {
    statements: [
      fieldRead(sourceId, 'piece.field', 'piece', source, 'instanceId'),
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      findTagBeforeTurn(findId, output(tagsId), statusType, output(sourceId), turn, fresh),
      replaceCall(call, 'data.optional-field', { record: output(findId) }, { field: 'id' }),
    ],
    outputs: { id: output(call.id) },
  }
}

function readCellField(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const field = call.parameters?.field
  if (field !== 'left' && field !== 'right') return undefined
  const record = statusRecordFromPiece(call, fresh)
  if (!record) return undefined
  return {
    statements: [...record.statements, replaceCall(call, 'data.optional-field', { record: record.record }, { field })],
    outputs: { cell: output(call.id) },
  }
}

function readCellList(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  if (call.parameters?.field !== 'pathCells') return undefined
  const record = statusRecordFromPiece(call, fresh)
  if (!record) return undefined
  const rawId = fresh('path-cells')
  const presentId = fresh('path-cells-present')
  const selectedId = fresh('path-cells-selected')
  const present = compare(presentId, output(rawId), literal(null), nullableCellList, '!=')
  const selected = select(selectedId, output(presentId), output(rawId), literal([]), nullableCellList)
  const result = replaceCall(call, 'value.coalesce', {
    value: output(selectedId), defaultValue: literal([]),
  }, { valueType: valueTypeParameter(cellList) })
  return {
    statements: [...record.statements, optionalField(rawId, record.record, 'pathCells'), present, selected, result],
    outputs: { cells: output(call.id) },
  }
}

function findFlight(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(call, 'target')
  const statusType = call.parameters?.statusType
  if (!target || typeof statusType !== 'string') return undefined

  const tagsId = fresh('status-tags')
  const targetId = fresh('target-id')
  const tagId = fresh('flight-status')
  const tagType = fresh('tag-type')
  const typeMatch = fresh('type-match')
  const tagOwner = fresh('tag-owner')
  const ownerMatch = fresh('owner-match')
  const match = fresh('flight-match')
  const found = fresh('found')
  const idRaw = fresh('id-raw')
  const id = fresh('id')
  const flightIdRaw = fresh('flight-id-raw')
  const flightId = fresh('flight-id')
  const allyIdRaw = fresh('ally-id-raw')
  const allyAlive = fresh('ally-alive')
  const allyId = fresh('ally-id')
  const xRaw = fresh('x-raw')
  const x = fresh('x')
  const yRaw = fresh('y-raw')
  const y = fresh('y')
  const allyXRaw = fresh('ally-x-raw')
  const allyX = fresh('ally-x')
  const allyYRaw = fresh('ally-y-raw')
  const allyY = fresh('ally-y')
  const appliedTurnRaw = fresh('applied-turn-raw')
  const appliedTurn = fresh('applied-turn')
  const currentDurationRaw = fresh('current-duration-raw')
  const currentDuration = fresh('current-duration')
  const statements: GameplayStatement[] = [
    statusTags(tagsId, { module: 'piece.field', input: 'piece', value: target }),
    fieldRead(targetId, 'piece.field', 'piece', target, 'instanceId'),
    findCollection(tagId, output(tagsId), [
      readKey(tagType, input('item'), 'type', 'string'),
      compare(typeMatch, output(tagType), input('statusType'), nullableString),
      readKey(tagOwner, input('item'), 'ownerId', 'string'),
      compare(ownerMatch, output(tagOwner), input('targetId'), nullableString),
      and(match, output(typeMatch), output(ownerMatch)),
      returnValue(fresh('find-return'), output(match)),
    ], { statusType: literal(statusType), targetId: output(targetId) }),
    compare(found, output(tagId), literal(null), nullableRecord, '!='),
    readKey(idRaw, output(tagId), 'id', 'string'),
    coalesce(id, output(idRaw), literal(''), 'string'),
    readKey(flightIdRaw, output(tagId), 'flightId', 'string'),
    coalesce(flightId, output(flightIdRaw), literal(''), 'string'),
    readKey(allyIdRaw, output(tagId), 'allyId', 'piece'),
    generatedCall(allyAlive, 'piece.alive', { piece: output(allyIdRaw) }),
    select(allyId, output(allyAlive, 'alive'), output(allyIdRaw), literal(null), nullablePiece),
    readKey(xRaw, output(tagId), 'x', 'number'),
    coalesce(x, output(xRaw), literal(0), 'number'),
    readKey(yRaw, output(tagId), 'y', 'number'),
    coalesce(y, output(yRaw), literal(0), 'number'),
    readKey(allyXRaw, output(tagId), 'allyX', 'number'),
    coalesce(allyX, output(allyXRaw), literal(0), 'number'),
    readKey(allyYRaw, output(tagId), 'allyY', 'number'),
    coalesce(allyY, output(allyYRaw), literal(0), 'number'),
    readKey(appliedTurnRaw, output(tagId), 'appliedTurn', 'number'),
    coalesce(appliedTurn, output(appliedTurnRaw), literal(-1), 'number'),
    readKey(currentDurationRaw, output(tagId), 'currentDuration', 'number'),
    coalesce(currentDuration, output(currentDurationRaw), literal(0), 'number'),
  ]
  return {
    statements,
    outputs: {
      found: output(found), id: output(id), flightId: output(flightId), allyId: output(allyId),
      x: output(x), y: output(y), allyX: output(allyX), allyY: output(allyY),
      appliedTurn: output(appliedTurn), currentDuration: output(currentDuration),
    },
  }
}

function readLiveSource(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const statusId = requiredInput(call, 'statusId')
  if (!piece || !statusId) return undefined
  const tagsId = fresh('status-tags')
  const tagId = fresh('status')
  const tagStatusId = fresh('tag-id')
  const idMatch = fresh('id-match')
  const sourceIdRaw = fresh('source-id-raw')
  const sources = fresh('live-sources')
  const sourceMatches = fresh('source-matches')
  const selected = fresh('selected-source')
  return {
    statements: [
      statusTags(tagsId, { module: 'piece.field', input: 'piece', value: piece }),
      findCollection(tagId, output(tagsId), [
        readKey(tagStatusId, input('item'), 'id', 'string'),
        compare(idMatch, output(tagStatusId), input('statusId'), nullableString),
        returnValue(fresh('find-return'), output(idMatch)),
      ], { statusId }),
      readKey(sourceIdRaw, output(tagId), 'sourcePieceId', 'piece'),
      generatedCall(sources, 'query.pieces', {}, { relation: 'all', includeDead: false }),
      findCollection(selected, output(sources, 'pieces'), [
        compare(sourceMatches, input('item'), input('sourceId'), nullablePiece),
        returnValue(fresh('source-return'), output(sourceMatches)),
      ], { sourceId: output(sourceIdRaw) }),
    ],
    outputs: { source: output(selected) },
  }
}

function readReference(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  field: string,
): AtomicReplacement | undefined {
  const record = statusRecordFromPiece(call, fresh)
  if (!record) return undefined
  const referenceRaw = fresh('reference-raw')
  const exists = fresh('reference-exists')
  const reference = fresh('reference-piece')
  const result = fresh('reference-result')
  return {
    statements: [
      ...record.statements,
      readKey(referenceRaw, record.record, field, 'piece'),
      generatedCall(exists, 'query.has-piece', { pieceId: output(referenceRaw) }),
      generatedCall(reference, 'query.piece', { pieceId: output(referenceRaw) }),
      select(result, output(exists, 'exists'), output(reference, 'piece'), literal(null), nullablePiece),
    ],
    outputs: { reference: output(result) },
  }
}

function readTextField(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const field = call.parameters?.field
  const fallback = requiredInput(call, 'fallback')
  if ((field !== 'sourceId' && field !== 'kind' && field !== 'id') || !fallback) return undefined
  const record = statusRecordFromPiece(call, fresh)
  if (!record) return undefined
  const rawId = fresh('raw')
  return {
    statements: [
      ...record.statements,
      optionalField(rawId, record.record, field),
      replaceCall(call, 'value.coalesce', { value: output(rawId), defaultValue: fallback }, { valueType: 'string' }),
    ],
    outputs: { value: output(call.id) },
  }
}

function readPlayerField(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  if (call.parameters?.field !== 'ownerPlayerId') return undefined
  const record = statusRecordFromPiece(call, fresh)
  if (!record) return undefined
  return {
    statements: [
      ...record.statements,
      generatedCall(call.id, 'data.read-key', { record: record.record }, {
        key: 'ownerPlayerId',
        valueType: valueTypeParameter({ kind: 'nullable', value: 'player' }),
      }),
    ],
    outputs: { player: output(call.id) },
  }
}

/** Recipe consumed by `rewriteAtomicGraph` for status reader aliases. */
export const atomicStatusFieldsRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  switch (call.module) {
    case 'status.find-id': return findId(call, fresh)
    case 'status.find-id-by-id': return findIdById(call, fresh)
    case 'status.find-id-by-prefix': return findIdByPrefix(call, fresh)
    case 'status.find-id-by-number': return findIdByNumber(call, fresh)
    case 'status.list-ids': return listIds(call, fresh)
    case 'status.read-number': return readNumber(call, fresh, STATUS_NUMBER_FIELDS, statusRecordFromPiece)
    case 'status.read-record-number': return readNumber(call, fresh, STATUS_RECORD_NUMBER_FIELDS, statusRecordFromPiece)
    case 'status.read-number-field': return readNumber(call, fresh, STATUS_NUMBER_FIELD_FIELDS, statusRecordFromPiece)
    case 'status.read-number-instance': return readNumber(call, fresh, STATUS_NUMBER_FIELDS, statusRecordFromInstance)
    case 'status.read-number-truthy': return readTruthyNumber(call, fresh, STATUS_TRUTHY_FIELDS, statusRecordFromPiece)
    case 'status.read-player-field': return readPlayerField(call, fresh)
    case 'status.read-duration': return readLifecycleNumber(call, fresh, 'remainingDuration', 'currentDuration', false)
    case 'status.read-uses': return readLifecycleNumber(call, fresh, 'remainingUses', 'currentUses', false)
    case 'status.read-uses-fallback': return readLifecycleNumber(call, fresh, 'remainingUses', 'currentUses', true)
    case 'status.read-turn-number': return readNumber(call, fresh, new Set(['turnNumber']), statusRecordFromPiece, 'turnNumber')
    case 'status.read-player-number': return readNumber(call, fresh, PLAYER_NUMBER_FIELDS, statusRecordFromPlayer)
    case 'status.read-player-number-truthy': return readTruthyNumber(call, fresh, PLAYER_TRUTHY_FIELDS, statusRecordFromPlayer)
    case 'status.read-player-text-field': {
      if (call.parameters?.field !== 'sourceId') return undefined
      const record = statusRecordFromPlayer(call, fresh)
      if (!record) return undefined
      return {
        statements: [...record.statements, replaceCall(call, 'data.optional-field', { record: record.record }, { field: 'sourceId' })],
        outputs: { value: output(call.id) },
      }
    }
    case 'status.read-text-field': return readTextField(call, fresh)
    case 'status.find-player-id': return findPlayerId(call, fresh)
    case 'status.find-player-id-at': return findPlayerIdAt(call, fresh)
    case 'status.find-source-before-id': return findSourceBeforeId(call, fresh)
    case 'status.read-cell-field': return readCellField(call, fresh)
    case 'status.read-cell-list': return readCellList(call, fresh)
    case 'status.find-flight': return findFlight(call, fresh)
    case 'status.read-live-source': return readLiveSource(call, fresh)
    case 'status.read-reference': {
      const field = call.parameters?.field
      return field === 'targetId' || field === 'sourceId' ? readReference(call, fresh, field) : undefined
    }
    case 'status.read-piece-reference': {
      return call.parameters?.field === 'targetPieceId' ? readReference(call, fresh, 'targetPieceId') : undefined
    }
    default: return undefined
  }
}

/** Backwards-compatible factory form for callers composing multiple recipes. */
export function createStatusFieldMigrationRecipe(): AtomicRecipe {
  return atomicStatusFieldsRecipe
}

/** Rewrite every graph scope, including branches, composites, and continuations. */
export function migrateStatusFieldModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicStatusFieldsRecipe)
}

export const migrateAtomicStatusFieldGraph = migrateStatusFieldModules
