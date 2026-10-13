import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayRecordSchema,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * Compatibility helpers whose behavior is a composition of closed field,
 * collection, record, and effect primitives.  The old descriptors stay
 * loadable for historical documents; migrated author graphs contain only the
 * generic operations below and the small, explicitly bounded host writes in
 * module-registry-followup-compositions.
 */
export const ATOMIC_FOLLOWUP_COMPOSITION_MODULES = new Set([
  'rule.append-reference',
  'player.consume-buff',
  'followup.status-records',
  'followup.status-player-field',
  'followup.piece-name-with-template',
  'followup.piece-template-id',
  'attribute.read-stored',
  'effect.damage-many-ordered',
  'effect.damage-many',
])
export const ATOMIC_FOLLOWUP_COMPOSITION_MODULE_IDS = ATOMIC_FOLLOWUP_COMPOSITION_MODULES

const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const recordType: GameplayValueType = 'record'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: playerType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: recordType }
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }

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

function requiredInput(node: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = node.inputs?.[name]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value') ? value : undefined
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0 ? value : undefined
  return record.kind === 'output' && typeof record.node === 'string' && record.node.length > 0
    && typeof record.port === 'string' && record.port.length > 0 ? value : undefined
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

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  valueType: GameplayValueType,
  operator: '==' | '!=',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType: typeParameter(valueType), operator })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.and', { left, right })
}

function readKey(
  id: string,
  record: GameplayValue,
  key: string,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return call(id, 'data.read-key', { record }, { key, valueType: typeParameter(valueType) })
}

function field(
  id: string,
  module: 'piece.field' | 'piece.stored-field',
  piece: GameplayValue,
  selected: string,
): GameplayCallStatement {
  return call(id, module, { [module === 'piece.field' ? 'piece' : 'id']: piece }, { field: selected })
}

function findByField(
  id: string,
  items: GameplayValue,
  fieldName: string,
  expected: GameplayValue,
  valueType: GameplayValueType,
  fresh: (suffix: string) => string,
  options: {
    readonly item?: string
    readonly inputs?: Readonly<Record<string, GameplayValue>>
    readonly expectedInput?: string
  } = {},
): GameplayStatement {
  const itemName = options.item ?? 'item'
  const fieldId = fresh(fieldName + '-field')
  const matchId = fresh(fieldName + '-match')
  const expectedValue = options.expectedInput ? input(options.expectedInput) : expected
  return collection(id, 'find', items, [
    readKey(fieldId, input(itemName), fieldName, valueType),
    compare(matchId, output(fieldId), expectedValue, valueType, '=='),
    returnValue(fresh(fieldName + '-return'), output(matchId)),
  ], { item: itemName, inputs: options.inputs })
}

function appendRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  items: GameplayValue,
  record: GameplayValue,
): GameplayValue {
  const singleton = fresh('singleton')
  const appended = fresh('append')
  statements.push(
    call(singleton, 'collection.singleton', { value: record }, { valueType: typeParameter(recordType) }),
    call(appended, 'collection.concat', { left: items, right: output(singleton, 'items') }, { valueType: typeParameter(recordListType) }),
  )
  return output(appended, 'items')
}

function appendRule(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const target = requiredInput(node, 'target')
  const ruleId = node.parameters?.ruleId
  if (!target || typeof ruleId !== 'string' || ruleId.length === 0) return undefined
  const statements: GameplayStatement[] = []
  const rules = fresh('rules')
  statements.push(field(rules, 'piece.field', target, 'rules'))
  const existing = fresh('existing-rule')
  statements.push(findByField(existing, output(rules), 'id', literal(ruleId), nullableStringType, fresh, { item: 'rule' }))
  const exists = fresh('rule-exists')
  statements.push(compare(exists, output(existing), literal(null), nullableRecordType, '!='))
  const empty = fresh('rule-record')
  statements.push(call(empty, 'record.empty'))
  let record: GameplayValue = output(empty, 'record')
  const withId = fresh('rule-id')
  statements.push(call(withId, 'record.set-key', {
    record, key: literal('id'), value: literal(ruleId),
  }, { valueType: typeParameter(stringType) }))
  record = output(withId, 'record')
  const appended = appendRecord(statements, fresh, output(rules), record)
  const selected = fresh('rules-with-reference')
  statements.push(call(selected, 'logic.select', {
    condition: output(exists), whenTrue: output(rules), whenFalse: appended,
  }, { valueType: typeParameter(recordListType) }, '2'))
  const written = fresh('write-rules')
  statements.push(call(written, 'piece.write-rules', { piece: target, rules: output(selected) }))
  // A duplicate selects the original array, so no second reference is
  // introduced even though the bounded raw write is still a single call.
  return {
    statements,
    outputs: { success: output(written, 'success') },
  }
}

function consumeBuff(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(node, 'player')
  const buffId = node.parameters?.buffId
  if (!player || typeof buffId !== 'string' || buffId.length === 0) return undefined
  const buff = fresh('buff')
  const uses = fresh('uses')
  const normalizedUses = fresh('normalized-uses')
  const nextUses = fresh('next-uses')
  const write = fresh('consume')
  const multiplier = fresh('multiplier')
  const appliedMultiplier = fresh('applied-multiplier')
  return {
    statements: [
      call(buff, 'player.buff-record', { player }, { buffId }),
      readKey(uses, output(buff, 'record'), 'uses', nullableNumberType),
      call(normalizedUses, 'value.coalesce', { value: output(uses), defaultValue: literal(0) }, { valueType: typeParameter(numberType) }),
      call(nextUses, 'math.subtract', { left: output(normalizedUses), right: literal(1) }),
      call(write, 'player.write-buff-uses', { player, uses: output(nextUses) }, { buffId }),
      readKey(multiplier, output(buff, 'record'), 'multiplier', nullableNumberType),
      call(appliedMultiplier, 'value.coalesce', { value: output(multiplier), defaultValue: literal(1) }, { valueType: typeParameter(numberType) }),
      call(node.id, 'logic.select', {
        condition: output(write, 'success'), whenTrue: output(appliedMultiplier), whenFalse: literal(1),
      }, { valueType: typeParameter(numberType) }, '2'),
    ],
    outputs: {
      applied: output(write, 'success'),
      multiplier: output(node.id),
    },
  }
}

function statusRecords(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(node, 'piece')
  const statusType = node.parameters?.statusType
  if (!piece || typeof statusType !== 'string') return undefined
  const tags = fresh('status-tags')
  const filtered = fresh('status-records')
  const body: GameplayStatement[] = []
  const type = fresh('status-type')
  const typeMatch = fresh('status-type-match')
  body.push(
    readKey(type, input('status'), 'type', nullableStringType),
    compare(typeMatch, output(type), literal(statusType), nullableStringType, '=='),
  )
  const turn = requiredInput(node, 'turn')
  if (turn) {
    const appliedTurn = fresh('applied-turn')
    const sameTurn = fresh('same-turn')
    const differentTurn = fresh('different-turn')
    const accepted = fresh('status-accepted')
    body.push(
      readKey(appliedTurn, input('status'), 'appliedTurn', nullableNumberType),
      compare(sameTurn, output(appliedTurn), input('currentTurn'), nullableNumberType, '=='),
      call(differentTurn, 'logic.not', { value: output(sameTurn) }),
      and(accepted, output(typeMatch), output(differentTurn)),
      returnValue(fresh('status-filter-return'), output(accepted)),
    )
  } else {
    body.push(returnValue(fresh('status-filter-return'), output(typeMatch)))
  }
  return {
    statements: [
      field(tags, 'piece.field', piece, 'statusTags'),
      collection(filtered, 'filter', output(tags), body, turn
        ? { item: 'status', inputs: { currentTurn: turn } }
        : { item: 'status' }),
    ],
    outputs: { records: output(filtered) },
  }
}

function statusPlayerField(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(node, 'piece')
  const statusId = requiredInput(node, 'statusId')
  const selectedField = node.parameters?.field
  if (!piece || !statusId || selectedField !== 'opponentPlayerId') return undefined
  const tags = fresh('status-tags')
  const found = fresh('status')
  const value = fresh('player')
  return {
    statements: [
      field(tags, 'piece.field', piece, 'statusTags'),
      findByField(found, output(tags), 'id', statusId, nullableStringType, fresh, {
        item: 'status', inputs: { statusId }, expectedInput: 'statusId',
      }),
      readKey(value, output(found), selectedField, nullablePlayerType),
    ],
    outputs: { player: output(value) },
  }
}

function pieceIdentifier(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  piece: GameplayValue,
): GameplayValue {
  const id = fresh('piece-id')
  // A piece reference is already the stable instance identity.  Converting it
  // to text keeps this lookup valid for a graveyard reference too; querying a
  // live piece merely to recover its ID would incorrectly reject that case.
  statements.push(call(id, 'text.from-value', { value: piece }, { valueType: typeParameter(pieceType) }))
  return output(id, 'text')
}

function pieceTemplateId(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(node, 'piece')
  if (!piece) return undefined
  const statements: GameplayStatement[] = []
  const id = pieceIdentifier(statements, fresh, piece)
  const template = fresh('template-id')
  const result = fresh('template-result')
  statements.push(
    call(template, 'piece.stored-field', { id }, { field: 'templateId' }),
    call(result, 'value.coalesce', { value: output(template), defaultValue: literal('') }, { valueType: typeParameter(stringType) }),
  )
  return { statements, outputs: { text: output(result) } }
}

function pieceNameWithTemplate(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(node, 'piece')
  if (!piece) return undefined
  const statements: GameplayStatement[] = []
  const id = pieceIdentifier(statements, fresh, piece)
  const name = fresh('name')
  const template = fresh('template')
  const namePresent = fresh('name-present')
  const selected = fresh('selected-name')
  const selectedPresent = fresh('selected-present')
  const idFallback = fresh('id-fallback')
  const result = fresh('name-result')
  statements.push(
    call(name, 'piece.stored-field', { id }, { field: 'name' }),
    call(template, 'piece.stored-field', { id }, { field: 'templateId' }),
    call(namePresent, 'value.to-boolean', { value: output(name) }, { valueType: typeParameter(nullableStringType) }),
    call(selected, 'logic.select', { condition: output(namePresent), whenTrue: output(name), whenFalse: output(template) }, {
      valueType: typeParameter(nullableStringType),
    }, '2'),
    call(selectedPresent, 'value.to-boolean', { value: output(selected) }, { valueType: typeParameter(nullableStringType) }),
    call(idFallback, 'value.coalesce', { value: id, defaultValue: literal('') }, { valueType: typeParameter(stringType) }),
    call(result, 'logic.select', { condition: output(selectedPresent), whenTrue: output(selected), whenFalse: output(idFallback) }, {
      valueType: typeParameter(stringType),
    }, '2'),
  )
  return { statements, outputs: { text: output(result) } }
}

function readStoredAttribute(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const id = requiredInput(node, 'id')
  const attribute = node.parameters?.attribute
  if (!id || typeof attribute !== 'string' || !['attack', 'defense', 'moveRange'].includes(attribute)) return undefined
  const stored = fresh('stored')
  const value = fresh('value')
  return {
    statements: [
      call(stored, 'piece.stored-field', { id }, { field: attribute }),
      call(value, 'value.coalesce', { value: output(stored), defaultValue: literal(0) }, { valueType: typeParameter(numberType) }),
    ],
    outputs: { value: output(value), exists: output(stored, 'exists') },
  }
}

function damageMany(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = requiredInput(node, 'source')
  const targets = requiredInput(node, 'targets')
  const amount = requiredInput(node, 'amount')
  if (!source || !targets || !amount) return undefined
  const damage = fresh('author-damage')
  const successful = fresh('successful-results')
  const successBody: GameplayStatement[] = []
  const successField = fresh('result-success')
  successBody.push(
    call(successField, 'result.field', { record: input('result') }, { field: 'success' }),
    returnValue(fresh('result-success-return'), output(successField)),
  )
  const successCount = fresh('success-count')
  const success = fresh('success')
  const empty = fresh('batch-record')
  const withResults = fresh('batch-results')
  const withSuccess = fresh('batch-success')
  const total = fresh('total-damage')
  const statements: GameplayStatement[] = [
    call(damage, 'author.effect.damage', { source, target: targets, amount }, {
      sourceType: 'piece',
      targetType: typeParameter(pieceListType),
      amountType: 'number',
      resultType: typeParameter(recordListType),
      damageType: node.parameters?.damageType === 'true' ? 'true' : 'normal',
      ...(typeof node.parameters?.skillId === 'string' ? { skillId: node.parameters.skillId } : {}),
    }, '2'),
    collection(successful, 'filter', output(damage, 'result'), successBody, { item: 'result' }),
    call(successCount, 'collection.length', { items: output(successful, 'value') }),
    call(success, 'compare.greater-than', { left: output(successCount), right: literal(0) }),
    call(empty, 'record.empty'),
    call(withResults, 'record.set-key', {
      record: output(empty, 'record'), key: literal('results'), value: output(damage, 'result'),
    }, { valueType: typeParameter(recordListType) }),
    call(withSuccess, 'record.set-key', {
      record: output(withResults, 'record'), key: literal('success'), value: output(success),
    }, { valueType: typeParameter(booleanType) }),
    call(total, 'damage.batch-total', { result: output(withSuccess, 'record') }),
  ]
  const withTotal = fresh('batch-total')
  statements.push(call(withTotal, 'record.set-key', {
    record: output(withSuccess, 'record'), key: literal('totalDamage'), value: output(total),
  }, { valueType: typeParameter(numberType) }))
  return {
    statements,
    outputs: {
      result: output(withTotal, 'record'),
      success: output(success),
      totalDamage: output(total),
    },
  }
}

export const atomicFollowupCompositionRecipe: AtomicRecipe = (node, fresh) => {
  switch (node.module) {
    case 'rule.append-reference': return appendRule(node, fresh)
    case 'player.consume-buff': return consumeBuff(node, fresh)
    case 'followup.status-records': return statusRecords(node, fresh)
    case 'followup.status-player-field': return statusPlayerField(node, fresh)
    case 'followup.piece-name-with-template': return pieceNameWithTemplate(node, fresh)
    case 'followup.piece-template-id': return pieceTemplateId(node, fresh)
    case 'attribute.read-stored': return readStoredAttribute(node, fresh)
    case 'effect.damage-many-ordered': return damageMany(node, fresh)
    case 'effect.damage-many': return damageMany(node, fresh)
    default: return undefined
  }
}

function hasFollowupCompositionCall(statements: readonly GameplayStatement[]): boolean {
  for (const statement of statements) {
    if (statement.kind === 'call' && ATOMIC_FOLLOWUP_COMPOSITION_MODULES.has(statement.module)) return true
    if (statement.kind === 'if' && hasFollowupCompositionCall(statement.then)) return true
    if (statement.kind === 'if' && statement.else && hasFollowupCompositionCall(statement.else)) return true
    if ('body' in statement && Array.isArray(statement.body) && hasFollowupCompositionCall(statement.body)) return true
    if (statement.kind === 'while' && hasFollowupCompositionCall(statement.condition.body)) return true
  }
  return false
}

function schemaFieldType(schemas: readonly GameplayRecordSchema[] | undefined, fieldName: string): GameplayValueType | undefined {
  for (const schema of schemas ?? []) {
    const field = schema.fields.find(candidate => candidate.name === fieldName)
    if (field) return field.nullable ? { kind: 'nullable', value: field.type } : field.type
  }
  return undefined
}

/**
 * `data.read-key` intentionally exposes only generic record values.  A
 * schema-bound record field already has an exact type through `record.get`,
 * so keep that structural read intact instead of lowering it to an
 * unrepresentable `valueType` enum entry.
 */
function containsSchemaBoundRecord(value: GameplayValueType): boolean {
  if (typeof value !== 'object') return false
  if (value.kind === 'record') return true
  if (value.kind === 'nullable' || value.kind === 'list' || value.kind === 'set') return containsSchemaBoundRecord(value.kind === 'nullable' ? value.value : value.element)
  if (value.kind === 'map') return containsSchemaBoundRecord(value.key) || containsSchemaBoundRecord(value.value)
  return false
}

/**
 * A status helper historically returned a graph-local typed record list, so
 * callers commonly used the structural `record.get` statement immediately
 * afterwards.  The composition reads ordinary status records through
 * `piece.field`, whose public type is the intentionally generic record list.
 * Project those legacy field reads through the safe generic key reader while
 * retaining the graph schema's field type; otherwise the compiler would
 * reject a valid migrated graph as an untyped `record.get`.
 */
function rewriteSchemaRecordReads(
  statements: readonly GameplayStatement[],
  schemas: readonly GameplayRecordSchema[] | undefined,
): GameplayStatement[] {
  return statements.map(statement => {
    if (statement.kind === 'record.get') {
      const valueType = schemaFieldType(schemas, statement.field)
      if (!valueType) return statement
      if (containsSchemaBoundRecord(valueType)) return statement
      return call(statement.id, 'data.read-key', { record: statement.record }, {
        key: statement.field,
        valueType: typeParameter(valueType),
      })
    }
    if (statement.kind === 'if') {
      return {
        ...statement,
        then: rewriteSchemaRecordReads(statement.then, schemas),
        ...(statement.else ? { else: rewriteSchemaRecordReads(statement.else, schemas) } : {}),
      }
    }
    if (statement.kind === 'foreach') return { ...statement, body: rewriteSchemaRecordReads(statement.body, schemas) }
    if (statement.kind === 'while') {
      return {
        ...statement,
        condition: { ...statement.condition, body: rewriteSchemaRecordReads(statement.condition.body, schemas) },
        body: rewriteSchemaRecordReads(statement.body, schemas),
      }
    }
    if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter'
      || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') {
      return { ...statement, body: rewriteSchemaRecordReads(statement.body, schemas) }
    }
    return statement
  })
}

export const migrateFollowupCompositionModules = (graph: GameplayModuleGraph): GameplayModuleGraph => {
  const hasLegacyComposition = hasFollowupCompositionCall(graph.body)
    || (graph.composites?.some(composite => hasFollowupCompositionCall(composite.body)) ?? false)
    || (graph.continuations?.some(continuation => hasFollowupCompositionCall(continuation.graph.body)) ?? false)
  const migrated = rewriteAtomicGraph(graph, atomicFollowupCompositionRecipe)
  // Other atomic passes can introduce a structural record.get while lowering
  // a legacy status graph.  Once the graph has a declared schema, normalize
  // those reads as well, even if the original follow-up call was already
  // removed by an earlier pass.
  if (!hasLegacyComposition && !(migrated.schemas && migrated.schemas.length > 0)) return migrated
  return {
    ...migrated,
    body: rewriteSchemaRecordReads(migrated.body, migrated.schemas),
    ...(migrated.composites ? {
      composites: migrated.composites.map(composite => ({
        ...composite,
        body: rewriteSchemaRecordReads(composite.body, migrated.schemas),
      })),
    } : {}),
    ...(migrated.continuations ? {
      continuations: migrated.continuations.map(continuation => ({
        ...continuation,
        graph: migrateFollowupCompositionModules(continuation.graph),
      })),
    } : {}),
  }
}
