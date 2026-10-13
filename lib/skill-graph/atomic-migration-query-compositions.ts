import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * Compatibility queries which only combined ordinary collection, field and
 * choice operations.  They stay in the migration layer so the public author
 * vocabulary does not grow one content-specific helper for every old graph.
 */
export const ATOMIC_QUERY_COMPOSITION_MODULES = new Set([
  'player.require',
  'content.enemy-player',
  'piece.name-by-id',
  'context.primary-target-rewritten',
  'query.player-case-insensitive',
  'choice.from-pieces',
  'choice.from-cells',
  'choice.selected-pieces',
  'choice.context-piece-or-select',
  'choice.status-tags',
])
export const ATOMIC_QUERY_COMPOSITION_MODULE_IDS = ATOMIC_QUERY_COMPOSITION_MODULES

const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const choiceType: GameplayValueType = 'choice'
const recordType: GameplayValueType = 'record'
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: pieceType }
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: playerType }
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const playerListType: GameplayValueType = { kind: 'list', element: playerType }
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const recordListType: GameplayValueType = { kind: 'list', element: recordType }

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const typeParameter = (type: GameplayValueType): GameplayJsonValue => typeof type === 'string' ? type : JSON.stringify(type)

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function collection(
  id: string,
  method: 'map' | 'filter' | 'find',
  items: GameplayValue,
  body: readonly GameplayStatement[],
  options: { readonly item?: string; readonly index?: string; readonly inputs?: Readonly<Record<string, GameplayValue>> } = {},
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
  operator: '==' | '!=',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType: typeParameter(valueType), operator })
}

function setRecordField(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  key: string,
  value: GameplayValue,
  valueType: GameplayValueType,
): GameplayValue {
  const id = fresh('record-' + key)
  statements.push(call(id, 'record.set-key', {
    record, key: literal(key), value,
  }, { valueType: typeParameter(valueType) }))
  return output(id, 'record')
}

function makeOptionRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  fields: Readonly<Record<string, GameplayValue>>,
): GameplayValue {
  const empty = fresh('option-record')
  statements.push(call(empty, 'record.empty'))
  let record: GameplayValue = output(empty, 'record')
  for (const [key, value] of Object.entries(fields)) {
    const valueType = key === 'label' || key === 'value' || key === 'type'
      ? stringType
      : key === 'x' || key === 'y'
        ? numberType
        : key === 'pieceId'
          ? stringType
          : key === 'instanceId'
          ? pieceType
          : recordType
    record = setRecordField(statements, fresh, record, key, value, valueType)
  }
  return record
}

/**
 * Choice envelopes are structurally ordinary author records at runtime, but
 * the graph type system keeps the protocol value distinct from a free-form
 * record. Project the constructed envelope through the closed record reader
 * so the conversion remains a typed, pure graph operation and the reader
 * still performs its normal safe-copy/finite-value validation.
 */
function makeChoiceRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
): GameplayValue {
  const empty = fresh('choice-box-record')
  statements.push(call(empty, 'record.empty'))
  const boxed = setRecordField(statements, fresh, output(empty, 'record'), 'value', record, recordType)
  const choice = fresh('choice-value')
  statements.push(call(choice, 'data.read-key', { record: boxed }, {
    key: 'value', valueType: typeParameter(choiceType),
  }))
  return output(choice, 'value')
}

function appendRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  items: GameplayValue,
  record: GameplayValue,
): GameplayValue {
  const one = fresh('option-singleton')
  const appended = fresh('option-append')
  statements.push(
    call(one, 'collection.singleton', { value: record }, { valueType: typeParameter(recordType) }),
    call(appended, 'collection.concat', { left: items, right: output(one, 'items') }, { valueType: typeParameter(recordListType) }),
  )
  return output(appended, 'items')
}

/**
 * Normalize the context read emitted by the first query-composition lowering.
 *
 * The old lowering used `preserveMissing: true` and then wrapped the read in
 * a coalesce.  The canonical player.require lowering uses the nullable
 * context field directly, so an absent field is null and can safely reach the
 * fallback query.  This repair is restricted to the generated
 * `*--context-player` node; arbitrary author context reads keep their declared
 * missing-field behavior.
 */
function repairGeneratedPlayerContext(node: GameplayCallStatement): AtomicReplacement | undefined {
  if (node.module !== 'context.field' || node.version !== '4') return undefined
  if (node.parameters?.field !== 'playerId' || node.parameters.preserveMissing !== true) return undefined
  if (!node.id.endsWith('--context-player')) return undefined
  return {
    statements: [{ ...node, parameters: { field: 'playerId' } }],
  }
}

function generatedPlayerBase(id: string, suffix: string): string | undefined {
  if (!id.endsWith(suffix)) return undefined
  const base = id.slice(0, -suffix.length)
  return base.length > 0 ? base : undefined
}

/** Remove the extra context read introduced by the first repair pass. */
function repairGeneratedPlayerFallback(node: GameplayCallStatement): AtomicReplacement | undefined {
  if (node.module !== 'context.field' || node.version !== '4') return undefined
  if (node.parameters?.field !== 'playerId') return undefined
  if (!generatedPlayerBase(node.id, '--required-player--context-player-fallback')) return undefined
  return { statements: [] }
}

/** Rename the first repair pass's temporary presence node to the canonical ID. */
function repairGeneratedPlayerPresence(node: GameplayCallStatement): AtomicReplacement | undefined {
  if (node.module !== 'value.to-boolean' || node.version !== '1') return undefined
  const base = generatedPlayerBase(node.id, '--required-player--player-present')
  if (!base || !node.inputs?.value || node.inputs.value.kind !== 'output') return undefined
  const id = `${base}--player-present`
  return {
    statements: [{ ...node, id }],
    outputs: { value: output(id) },
  }
}

/** Rename the first repair pass's selected player and point it at the context read. */
function repairGeneratedPlayerSelection(node: GameplayCallStatement): AtomicReplacement | undefined {
  if (node.module !== 'logic.select' || node.version !== '2') return undefined
  const base = generatedPlayerBase(node.id, '--required-player--selected-player')
  if (!base || !node.inputs?.condition || !node.inputs.whenTrue) return undefined
  const id = `${base}--selected-player`
  return {
    statements: [{
      ...node,
      id,
      inputs: { ...node.inputs, whenFalse: output(`${base}--context-player`) },
    }],
    outputs: { value: output(id) },
  }
}

/** Rename the first repair pass's validated player and preserve both old ports. */
function repairGeneratedPlayerResult(node: GameplayCallStatement): AtomicReplacement | undefined {
  if (node.module !== 'query.player' || node.version !== '1') return undefined
  const base = generatedPlayerBase(node.id, '--required-player--validated-player')
  if (!base || !node.inputs?.playerId) return undefined
  const id = `${base}--required-player`
  return {
    statements: [{ ...node, id }],
    outputs: { value: output(id, 'player'), player: output(id, 'player') },
  }
}

/**
 * Repair the first query-composition migration's generated player fallback.
 *
 * Published graphs contain the expanded `context.field -> value.coalesce`
 * block.  Rebuild that block into the same canonical shape produced by the
 * current `player.require` recipe: reuse the normalized context node, keep
 * the original base IDs, and replace only the retired coalesce statement.
 * This makes a repair of an old graph byte-for-byte comparable with a fresh
 * factory expansion without weakening the graph/source proof.
 */
function repairGeneratedPlayerRequire(
  node: GameplayCallStatement,
  scope?: { getDefinition(id: string): GameplayStatement | undefined },
): AtomicReplacement | undefined {
  if (node.module !== 'value.coalesce' || !node.id.endsWith('--required-player')) return undefined
  const value = node.inputs?.value
  const defaultValue = node.inputs?.defaultValue
  if (!value || !defaultValue || value.kind !== 'output' || defaultValue.kind !== 'output') return undefined
  const contextDefinition = scope?.getDefinition(value.node)
  const playerDefinition = scope?.getDefinition(defaultValue.node)
  const definitionsMatch = contextDefinition?.kind === 'call'
    && contextDefinition.module === 'context.field'
    && contextDefinition.version === '4'
    && contextDefinition.parameters?.field === 'playerId'
    && playerDefinition?.kind === 'call'
    && playerDefinition.module === 'ref.player'
  // Option migrations can carry an explicit owner read instead of a
  // ref.player node.  That owner is the authoritative selection owner in
  // rule/continuation graphs; context.playerId belongs to the triggering
  // action and must only remain a fallback.  Recognize this exact generated
  // field shape so the repair is safe for unrelated value.coalesce nodes.
  const explicitOwnerDefinition = contextDefinition?.kind === 'call'
    && contextDefinition.module === 'context.field'
    && contextDefinition.version === '4'
    && contextDefinition.parameters?.field === 'playerId'
    && playerDefinition?.kind === 'call'
    && playerDefinition.module === 'piece.field'
    && playerDefinition.parameters?.field === 'ownerPlayerId'
  // `migrateAtomicAuthorGraph` runs this recipe in a callback that historically
  // omitted the rewrite scope.  Keep the repair bounded to the exact IDs
  // emitted by the published player.require expansion so those graphs can be
  // repaired in that production path too, while still preferring definitions
  // whenever the scope is available.
  const publishedIdsMatch = value.node === 'player--context-player' && defaultValue.node === 'player-ref'
  if (!definitionsMatch && !explicitOwnerDefinition && !publishedIdsMatch) return undefined

  const requiredSuffix = '--required-player'
  const baseId = node.id.endsWith(requiredSuffix)
    ? node.id.slice(0, -requiredSuffix.length)
    : undefined
  if (!baseId || value.node !== `${baseId}--context-player`) return undefined
  const present = `${baseId}--player-present`
  const selected = `${baseId}--selected-player`
  const result = `${baseId}${requiredSuffix}`
  return {
    statements: [
      call(present, 'value.to-boolean', { value: defaultValue }, {
        valueType: typeParameter(nullablePlayerType),
      }),
      call(selected, 'logic.select', {
        condition: output(present), whenTrue: defaultValue, whenFalse: value,
      }, { valueType: typeParameter(nullablePlayerType) }, '2'),
      call(result, 'query.player', { playerId: output(selected) }),
    ],
    outputs: { value: output(result, 'player') },
  }
}

/**
 * Published primary-target rewrites were generated with preserveMissing=true.
 * That exposes an absent context property as `undefined`, which invalidates a
 * nullable equality check instead of producing the intended false result.
 * Repair only this exact generated context-field node; unrelated author
 * uses of preserveMissing retain their explicit semantics.
 */
function repairGeneratedPrimaryTargetField(node: GameplayCallStatement): AtomicReplacement | undefined {
  if (node.module !== 'context.field' || node.version !== '4') return undefined
  if (node.parameters?.field !== 'ruleRewrittenPrimaryTargetPieceId' || node.parameters.preserveMissing !== true) return undefined
  return {
    statements: [{ ...node, parameters: { ...node.parameters, preserveMissing: false } }],
  }
}

function playerRequire(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(node, 'player')
  if (!player) return undefined
  const context = fresh('context-player')
  const present = fresh('player-present')
  const selected = fresh('selected-player')
  const result = fresh('required-player')
  return {
    statements: [
      // Preserve the legacy `player || context.playerId` order.  The ref.player
      // input normally resolves from the holder's owner, while context.playerId
      // is only a fallback for event-only callers.  Keeping missing context as
      // a nullable value is important: the preserveMissing form returns
      // `undefined`, which invalidates value.coalesce before the ref fallback
      // can be used by ordinary skill execution.
      call(context, 'context.field', {}, { field: 'playerId' }, '4'),
      call(present, 'value.to-boolean', { value: player }, {
        valueType: typeParameter(nullablePlayerType),
      }),
      call(selected, 'logic.select', {
        condition: output(present), whenTrue: player, whenFalse: output(context, 'value'),
      }, { valueType: typeParameter(nullablePlayerType) }, '2'),
      // query.player refines the selected nullable ID to the non-nullable
      // protocol value and preserves the old missing-player invalidation.
      call(result, 'query.player', { playerId: output(selected) }),
    ],
    outputs: { player: output(result, 'player') },
  }
}

function enemyPlayer(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const owner = requiredInput(node, 'player')
  if (!owner) return undefined
  const statements: GameplayStatement[] = []
  const players = fresh('players')
  const index = fresh('owner-index')
  const ownerExists = fresh('owner-exists')
  const ownerReference = fresh('owner-reference')
  statements.push(
    call(players, 'query.players'),
    call(index, 'collection.index-of', { items: output(players, 'players'), value: owner }, {
      valueType: typeParameter(playerType), itemsType: typeParameter(playerListType),
    }),
    call(ownerExists, 'query.has-player', { playerId: owner }),
    // query.player gives the relation field a typed player port.  The outer
    // nullable guard still returns null for the old null-owner case.
    call(ownerReference, 'query.player', { playerId: owner }),
  )
  const afterOwner = fresh('after-owner')
  statements.push(call(afterOwner, 'math.add', { left: output(index), right: literal(1) }))
  const start = fresh('rotation-start')
  statements.push(call(start, 'logic.select', {
    condition: output(ownerExists, 'exists'), whenTrue: output(afterOwner), whenFalse: literal(2),
  }, { valueType: typeParameter(numberType) }, '2'))
  const tail = fresh('rotation-tail')
  statements.push(call(tail, 'collection.slice', {
    items: output(players, 'players'), start: output(start),
  }))
  const headCount = fresh('rotation-head-count')
  statements.push(call(headCount, 'logic.select', {
    condition: output(ownerExists, 'exists'), whenTrue: output(index), whenFalse: literal(1),
  }, { valueType: typeParameter(numberType) }, '2'))
  const head = fresh('rotation-head')
  statements.push(call(head, 'collection.slice', {
    items: output(players, 'players'), start: literal(1), count: output(headCount),
  }))
  const rotated = fresh('rotated-players')
  statements.push(call(rotated, 'collection.concat', {
    left: output(tail, 'items'), right: output(head, 'items'),
  }, { valueType: typeParameter(playerListType) }))

  const findBody: GameplayStatement[] = []
  const allied = fresh('allied')
  const enemy = fresh('enemy')
  findBody.push(
    call(allied, 'compare.allied-players', {
      left: input('ownerReference'), right: input('candidate'),
    }),
    call(enemy, 'logic.not', { value: output(allied) }),
    returnValue(fresh('enemy-return'), output(enemy)),
  )
  const found = fresh('enemy-player')
  statements.push(collection(found, 'find', output(rotated, 'items'), findBody, {
    item: 'candidate', inputs: { ownerReference: output(ownerReference, 'player') },
  }))
  const ownerPresent = fresh('owner-present')
  statements.push(compare(ownerPresent, owner, literal(null), nullablePlayerType, '!='))
  const result = fresh('enemy-result')
  statements.push(call(result, 'logic.select', {
    condition: output(ownerPresent), whenTrue: output(found), whenFalse: literal(null),
  }, { valueType: typeParameter(nullablePlayerType) }, '2'))
  return { statements, outputs: { enemy: output(result) } }
}

function playerCaseInsensitive(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const playerId = requiredInput(node, 'playerId')
  if (!playerId) return undefined
  const statements: GameplayStatement[] = []
  const normalized = fresh('player-id-default')
  const needle = fresh('player-id-lower')
  const players = fresh('players')
  statements.push(
    call(normalized, 'value.coalesce', { value: playerId, defaultValue: literal('') }, { valueType: typeParameter(stringType) }),
    call(needle, 'text.lowercase', { text: output(normalized) }),
    call(players, 'query.players'),
  )
  const body: GameplayStatement[] = []
  const candidateText = fresh('candidate-text')
  const candidateLower = fresh('candidate-lower')
  const same = fresh('same-player')
  body.push(
    call(candidateText, 'text.from-value', { value: input('candidate') }, { valueType: typeParameter(playerType) }),
    call(candidateLower, 'text.lowercase', { text: output(candidateText, 'text') }),
    call(same, 'compare.values', { left: output(candidateLower, 'text'), right: input('needle') }, {
      valueType: typeParameter(stringType), operator: '==',
    }),
    returnValue(fresh('same-player-return'), output(same)),
  )
  const match = fresh('matching-player')
  statements.push(collection(match, 'find', output(players, 'players'), body, {
    item: 'candidate', inputs: { needle: output(needle, 'text') },
  }))
  const missing = fresh('player-id-missing')
  statements.push(compare(missing, playerId, literal(null), nullableStringType, '=='))
  const selected = fresh('selected-player')
  const error = fresh('player-error')
  statements.push(
    call(selected, 'logic.select', { condition: output(missing), whenTrue: literal(null), whenFalse: output(match) }, {
      valueType: typeParameter(nullablePlayerType),
    }, '2'),
    call(error, 'logic.select', {
      condition: output(missing),
      whenTrue: literal('Error: Cannot read properties of undefined (reading \'toLowerCase\')'),
      whenFalse: literal(''),
    }, { valueType: typeParameter(stringType) }, '2'),
  )
  return { statements, outputs: { player: output(selected), error: output(error) } }
}

function primaryTargetRewritten(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(node, 'target')
  if (!target) return undefined
  const field = fresh('rewritten-target')
  const result = call(node.id, 'compare.values', {
    left: output(field), right: target,
  }, { valueType: typeParameter(nullablePieceType), operator: '==' })
  return {
    statements: [
      // A missing rewrite is the ordinary "no rewritten target" case.  Keep
      // that as the nullable field value so the comparison can evaluate to
      // false; preserving the missing property would expose `undefined` and
      // invalidate the whole statement instead.
      call(field, 'context.field', {}, { field: 'ruleRewrittenPrimaryTargetPieceId' }, '4'),
      result,
    ],
    outputs: { value: output(node.id) },
  }
}

function nameById(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(node, 'piece')
  const fallback = requiredInput(node, 'fallback')
  if (!piece || !fallback) return undefined
  // The generic follow-up reader has the same active-plus-graveyard lookup and
  // template fallback.  Actual callers pass a stable piece reference; the
  // old custom fallback is retained for a null reference below.
  const helper = fresh('piece-name')
  const present = fresh('piece-present')
  const result = fresh('piece-name-result')
  return {
    statements: [
      call(helper, 'followup.piece-name-with-template', { piece }),
      call(present, 'value.to-boolean', { value: piece }, { valueType: typeParameter(nullablePieceType) }),
      call(result, 'logic.select', { condition: output(present), whenTrue: output(helper, 'text'), whenFalse: fallback }, {
        valueType: typeParameter(stringType),
      }, '2'),
    ],
    outputs: { text: output(result) },
  }
}

function fromPieces(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const pieces = requiredInput(node, 'pieces')
  if (!pieces) return undefined
  const records = fresh('piece-choice-records')
  const recordBody: GameplayStatement[] = []
  const id = fresh('piece-choice-id')
  recordBody.push(call(id, 'piece.identifier', { piece: input('piece') }))
  let record = makeOptionRecord(recordBody, fresh, { type: literal('piece') })
  record = setRecordField(recordBody, fresh, record, 'pieceId', output(id, 'id'), stringType)
  const choice = makeChoiceRecord(recordBody, fresh, record)
  recordBody.push(returnValue(fresh('piece-choice-record-return'), choice))
  const keys = fresh('piece-choice-keys')
  const keyBody: GameplayStatement[] = []
  const keyCall = fresh('piece-choice-key')
  keyBody.push(call(keyCall, 'piece.identifier', { piece: input('piece') }))
  keyBody.push(returnValue(fresh('piece-choice-key-return'), output(keyCall, 'id')))
  const statements: GameplayStatement[] = [
    collection(records, 'map', pieces, recordBody, { item: 'piece' }),
    collection(keys, 'map', pieces, keyBody, { item: 'piece' }),
  ]
  const sorted = fresh('piece-choices-sorted')
  statements.push(call(sorted, 'collection.sort', { items: output(records), keys: output(keys) }, {
    comparison: 'locale', order: 'ascending',
  }, '2'))
  return { statements, outputs: { choices: output(sorted, 'items') } }
}

function fromCells(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const cells = requiredInput(node, 'cells')
  if (!cells) return undefined
  const xKeys = fresh('cell-choice-x-keys')
  const xBody: GameplayStatement[] = []
  const xCoordinate = fresh('cell-choice-x')
  xBody.push(call(xCoordinate, 'spatial.cell-coordinates', { cell: input('cell') }))
  xBody.push(returnValue(fresh('cell-choice-x-return'), output(xCoordinate, 'x')))
  const xSorted = fresh('cell-choice-x-sorted')
  const yKeys = fresh('cell-choice-y-keys')
  const yBody: GameplayStatement[] = []
  const yCoordinate = fresh('cell-choice-y')
  yBody.push(call(yCoordinate, 'spatial.cell-coordinates', { cell: input('cell') }))
  yBody.push(returnValue(fresh('cell-choice-y-return'), output(yCoordinate, 'y')))
  const ySorted = fresh('cell-choice-y-sorted')
  const records = fresh('cell-choices')
  const recordBody: GameplayStatement[] = []
  const coords = fresh('cell-choice-coordinates')
  recordBody.push(call(coords, 'spatial.cell-coordinates', { cell: input('cell') }))
  let record = makeOptionRecord(recordBody, fresh, { type: literal('cell') })
  record = setRecordField(recordBody, fresh, record, 'x', output(coords, 'x'), numberType)
  record = setRecordField(recordBody, fresh, record, 'y', output(coords, 'y'), numberType)
  const choice = makeChoiceRecord(recordBody, fresh, record)
  recordBody.push(returnValue(fresh('cell-choice-record-return'), choice))
  const statements: GameplayStatement[] = [
    collection(xKeys, 'map', cells, xBody, { item: 'cell' }),
    call(xSorted, 'collection.sort', { items: cells, keys: output(xKeys) }, { comparison: 'numeric', order: 'ascending' }, '2'),
    collection(yKeys, 'map', output(xSorted, 'items'), yBody, { item: 'cell' }),
    call(ySorted, 'collection.sort', { items: output(xSorted, 'items'), keys: output(yKeys) }, { comparison: 'numeric', order: 'ascending' }, '2'),
    collection(records, 'map', output(ySorted, 'items'), recordBody, { item: 'cell' }),
  ]
  return { statements, outputs: { choices: output(records) } }
}

function selectedPieces(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const targets = requiredInput(node, 'targets')
  if (!targets) return undefined
  const statements: GameplayStatement[] = []
  const filtered = fresh('selected-piece-candidates')
  const filterBody: GameplayStatement[] = []
  const typeField = fresh('selected-piece-type')
  const typeMatch = fresh('selected-piece-type-match')
  const idField = fresh('selected-piece-id')
  const idPresent = fresh('selected-piece-id-present')
  const exists = fresh('selected-piece-exists')
  const alive = fresh('selected-piece-alive')
  const first = fresh('selected-piece-first')
  const second = fresh('selected-piece-second')
  const third = fresh('selected-piece-third')
  const accepted = fresh('selected-piece-accepted')
  const choiceRecord = fresh('selected-piece-record')
  filterBody.push(
    call(choiceRecord, 'choice.as-result', { choice: input('choice') }),
    call(typeField, 'data.read-key', { record: output(choiceRecord, 'result') }, { key: 'type', valueType: typeParameter(nullableStringType) }),
    compare(typeMatch, output(typeField), literal('piece'), nullableStringType, '=='),
    call(idField, 'data.read-key', { record: output(choiceRecord, 'result') }, { key: 'pieceId', valueType: typeParameter(nullablePieceType) }),
    compare(idPresent, output(idField), literal(null), nullablePieceType, '!='),
    call(exists, 'query.has-piece', { pieceId: output(idField) }),
    call(alive, 'piece.alive', { piece: output(idField) }),
    call(first, 'logic.and', { left: output(typeMatch), right: output(idPresent) }),
    call(second, 'logic.and', { left: output(first), right: output(exists, 'exists') }),
    call(third, 'logic.and', { left: output(second), right: output(alive, 'alive') }),
    call(accepted, 'logic.and', { left: output(third), right: output(idPresent) }),
    returnValue(fresh('selected-piece-filter-return'), output(accepted)),
  )
  statements.push(collection(filtered, 'filter', targets, filterBody, { item: 'choice' }))
  const mapped = fresh('selected-piece-ids')
  const mapBody: GameplayStatement[] = []
  const idFieldMap = fresh('selected-piece-map-id')
  const validated = fresh('selected-piece-map-validated')
  const choiceRecordMap = fresh('selected-piece-map-record')
  mapBody.push(
    call(choiceRecordMap, 'choice.as-result', { choice: input('choice') }),
    call(idFieldMap, 'data.read-key', { record: output(choiceRecordMap, 'result') }, { key: 'pieceId', valueType: typeParameter(nullablePieceType) }),
    call(validated, 'query.piece', { pieceId: output(idFieldMap) }),
    returnValue(fresh('selected-piece-map-return'), output(validated, 'piece')),
  )
  statements.push(collection(mapped, 'map', output(filtered), mapBody, { item: 'choice' }))
  const distinct = fresh('selected-piece-distinct')
  statements.push(call(distinct, 'collection.distinct', { items: output(mapped) }, { valueType: typeParameter(pieceListType) }))
  const keys = fresh('selected-piece-sort-keys')
  const keyBody: GameplayStatement[] = []
  const key = fresh('selected-piece-sort-key')
  keyBody.push(call(key, 'piece.identifier', { piece: input('piece') }))
  keyBody.push(returnValue(fresh('selected-piece-sort-return'), output(key, 'id')))
  statements.push(collection(keys, 'map', output(distinct), keyBody, { item: 'piece' }))
  const sorted = fresh('selected-piece-sorted')
  statements.push(call(sorted, 'collection.sort', { items: output(distinct), keys: output(keys) }, {
    comparison: 'locale', order: 'ascending',
  }, '2'))
  return { statements, outputs: { pieces: output(sorted, 'items') } }
}

function contextPieceOrSelect(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const range = node.parameters?.range
  const filter = node.parameters?.filter
  if (typeof range !== 'number' || !Number.isFinite(range) || typeof filter !== 'string' || !['enemy', 'ally', 'all'].includes(filter)) return undefined
  const statements: GameplayStatement[] = []
  const target = fresh('context-target')
  const present = fresh('context-target-present')
  const result = fresh('context-choice')
  const read = fresh('context-choice-read')
  const selectId = fresh('context-choice-select')
  statements.push(
    call(target, 'ref.target'),
    compare(present, output(target, 'piece'), literal(null), nullablePieceType, '!='),
    call(result, 'local.declare', {}, { valueType: typeParameter(choiceType) }),
    {
      kind: 'if', id: fresh('context-target-branch'), condition: output(present),
      then: (() => {
        const body: GameplayStatement[] = []
        const record = makeOptionRecord(body, fresh, {})
        const selected = setRecordField(body, fresh, record, 'instanceId', output(target, 'piece'), pieceType)
        const choice = makeChoiceRecord(body, fresh, selected)
        body.push(call(fresh('context-choice-write-target'), 'local.write', {
          handle: output(result, 'handle'), value: choice,
        }, { valueType: typeParameter(choiceType) }))
        return body
      })(),
      else: [
        call(selectId, 'choice.target-piece', {}, { range, filter }),
        call(fresh('context-choice-write-select'), 'local.write', {
          handle: output(result, 'handle'), value: output(selectId, 'choice'),
        }, { valueType: typeParameter(choiceType) }),
      ],
    },
  )
  statements.push(call(read, 'local.read', { handle: output(result, 'handle') }, { valueType: typeParameter(choiceType) }))
  return { statements, outputs: { choice: output(read, 'value') } }
}

function statusTags(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(node, 'target')
  if (!target) return undefined
  const statuses = fresh('status-tags')
  const mapped = fresh('status-options')
  const body: GameplayStatement[] = []
  const nameField = fresh('status-name')
  const typeField = fresh('status-type')
  const namePresent = fresh('status-name-present')
  const selectedText = fresh('status-selected-text')
  const selectedPresent = fresh('status-selected-present')
  const selectedBase = fresh('status-selected-base')
  const baseText = fresh('status-base-text')
  const number = fresh('status-number')
  const suffixOpen = fresh('status-suffix-open')
  const suffixClose = fresh('status-suffix-close')
  const label = fresh('status-label')
  const numberText = fresh('status-number-text')
  const zeroNumberText = fresh('status-zero-number-text')
  body.push(
    call(nameField, 'data.read-key', { record: input('status') }, { key: 'name', valueType: typeParameter(nullableStringType) }),
    call(typeField, 'data.read-key', { record: input('status') }, { key: 'type', valueType: typeParameter(nullableStringType) }),
    call(namePresent, 'value.to-boolean', { value: output(nameField) }, { valueType: typeParameter(nullableStringType) }),
    call(selectedText, 'logic.select', { condition: output(namePresent), whenTrue: output(nameField), whenFalse: output(typeField) }, {
      valueType: typeParameter(nullableStringType),
    }, '2'),
    call(selectedPresent, 'value.to-boolean', { value: output(selectedText) }, { valueType: typeParameter(nullableStringType) }),
    call(selectedBase, 'logic.select', { condition: output(selectedPresent), whenTrue: output(selectedText), whenFalse: literal('效果') }, {
      valueType: typeParameter(nullableStringType),
    }, '2'),
    call(baseText, 'value.coalesce', { value: output(selectedBase), defaultValue: literal('效果') }, { valueType: typeParameter(stringType) }),
    call(number, 'math.add', { left: input('index'), right: literal(1) }),
    call(numberText, 'text.from-number', { value: output(number) }),
    call(zeroNumberText, 'text.from-number', { value: input('index') }),
    call(suffixOpen, 'text.concat', { left: literal('（'), right: output(numberText, 'text') }),
    call(suffixClose, 'text.concat', { left: output(suffixOpen, 'text'), right: literal('）') }),
    call(label, 'text.concat', { left: output(baseText), right: output(suffixClose, 'text') }),
  )
  const record = makeOptionRecord(body, fresh, { label: output(label, 'text'), value: output(zeroNumberText, 'text') })
  body.push(returnValue(fresh('status-option-return'), record))
  const statements: GameplayStatement[] = [
    call(statuses, 'piece.field', { piece: target }, { field: 'statusTags' }),
    collection(mapped, 'map', output(statuses), body, { item: 'status', index: 'index' }),
  ]
  const none = makeOptionRecord(statements, fresh, { label: literal('不移除效果'), value: literal('none') })
  let options: GameplayValue = output(mapped)
  options = appendRecord(statements, fresh, options, none)
  const inputs: Record<string, GameplayValue> = {
    options, canCancel: literal(true), cancelValue: literal('none'),
  }
  if (Object.prototype.hasOwnProperty.call(node.parameters ?? {}, 'title')) inputs.title = literal(node.parameters!.title!)
  const choice = fresh('status-choice')
  statements.push(call(choice, 'choice.options', inputs))
  return { statements, outputs: { choice: output(choice, 'choice') } }
}

export const atomicQueryCompositionRecipe: AtomicRecipe = (node, fresh, scope): AtomicReplacement | undefined => {
  const repairedPrimaryTarget = repairGeneratedPrimaryTargetField(node)
  if (repairedPrimaryTarget) return repairedPrimaryTarget
  const repairedPlayerContext = repairGeneratedPlayerContext(node)
  if (repairedPlayerContext) return repairedPlayerContext
  const repairedPlayerFallback = repairGeneratedPlayerFallback(node)
  if (repairedPlayerFallback) return repairedPlayerFallback
  const repairedPlayerPresence = repairGeneratedPlayerPresence(node)
  if (repairedPlayerPresence) return repairedPlayerPresence
  const repairedPlayerSelection = repairGeneratedPlayerSelection(node)
  if (repairedPlayerSelection) return repairedPlayerSelection
  const repairedPlayerResult = repairGeneratedPlayerResult(node)
  if (repairedPlayerResult) return repairedPlayerResult
  const repairedPlayer = repairGeneratedPlayerRequire(node, scope)
  if (repairedPlayer) return repairedPlayer
  switch (node.module) {
    case 'player.require': return playerRequire(node, fresh)
    case 'content.enemy-player': return enemyPlayer(node, fresh)
    case 'piece.name-by-id': return nameById(node, fresh)
    case 'context.primary-target-rewritten': return primaryTargetRewritten(node, fresh)
    case 'query.player-case-insensitive': return playerCaseInsensitive(node, fresh)
    case 'choice.from-pieces': return fromPieces(node, fresh)
    case 'choice.from-cells': return fromCells(node, fresh)
    case 'choice.selected-pieces': return selectedPieces(node, fresh)
    case 'choice.context-piece-or-select': return contextPieceOrSelect(node, fresh)
    case 'choice.status-tags': return statusTags(node, fresh)
    default: return undefined
  }
}

export const migrateQueryCompositionModules = (graph: GameplayModuleGraph): GameplayModuleGraph => rewriteAtomicGraph(graph, atomicQueryCompositionRecipe)
