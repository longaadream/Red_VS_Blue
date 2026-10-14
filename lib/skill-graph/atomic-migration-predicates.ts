import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayJsonValue, GameplayStatement, GameplayValue, GameplayValueType } from './module-types'

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}, version = '1'): GameplayCallStatement => ({ kind: 'call', id, module, version, inputs, parameters })
const field = (id: string, module: string, name: string, inputs: Record<string, GameplayValue>): GameplayCallStatement => call(id, module, inputs, { field: name })
const generatedCall = (id: string, module: string, inputs: Record<string, GameplayValue>, parameters?: Record<string, GameplayJsonValue>): GameplayCallStatement => ({
  kind: 'call', id, module, version: '1', inputs,
  ...(parameters === undefined ? {} : { parameters }),
})
const valueTypeParameter = (type: GameplayValueType): GameplayJsonValue => typeof type === 'string' ? type : JSON.stringify(type)
const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: 'piece' }
const genericCompare = (
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  type: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement => generatedCall(id, 'compare.values', { left, right }, { valueType: valueTypeParameter(type), operator })

/** Keep the source node's layout and any editor metadata on direct rewrites. */
const replaceCall = (
  node: GameplayCallStatement,
  module: string,
  inputs: Record<string, GameplayValue>,
  parameters?: Record<string, GameplayJsonValue>,
): GameplayCallStatement => {
  const next: Record<string, unknown> = { ...node, module, version: '1', inputs }
  if (parameters === undefined) delete next.parameters
  else next.parameters = parameters
  return next as GameplayCallStatement
}

export const ATOMIC_PREDICATE_MODULES = new Set([
  'status.has-piece', 'status.count-piece', 'status.has-player', 'status.has-id', 'rule.has-piece',
  'piece.matches-template', 'piece.is-core', 'damage.killed', 'damage.was-blocked', 'damage.batch-kill-count', 'damage.batch-total',
  'card.hand-count', 'status.count-all', 'source.captured-has-status', 'status.has-source-turn',
  'effect.result-killed', 'effect.result-number', 'damage.batch-amount-at', 'damage.batch-succeeded-at',
  'status.has-skill-instance', 'status.has-skill-id', 'status.has-source-mark', 'tile.has-effect', 'status.matches-type',
  'effect.batch-succeeded-for', 'effect.batch-number-for', 'followup.card-has-prefix', 'status.player-transfer-records',
  'source.captured-no-kill-charge', 'source.captured-number',
])

/** Gameplay predicates are editable collection expressions, not native recipes. */
export const atomicPredicateRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_PREDICATE_MODULES.has(node.module)) return undefined
  const source = node.inputs || {}
  const parameters = node.parameters || {}
  const statements: GameplayStatement[] = []
  const read = (module: string, name: string, inputs: Record<string, GameplayValue>): GameplayValue => {
    const id = fresh(name)
    statements.push(field(id, module, name, inputs))
    return output(id)
  }
  if (node.module === 'piece.is-core') {
    return { statements: [field(node.id, 'piece.field', 'isCore', { piece: source.piece })] }
  }
  if (node.module === 'followup.card-has-prefix') {
    const prefix = parameters.prefix
    if (typeof prefix !== 'string') return undefined
    return { statements: [replaceCall(node, 'text.starts-with', { text: source.cardId, value: literal(prefix) })] }
  }
  if (node.module === 'source.captured-no-kill-charge' || node.module === 'source.captured-number') {
    const selected = node.module === 'source.captured-no-kill-charge' ? 'noKillCharge' : parameters.field
    if (typeof selected !== 'string' || (node.module === 'source.captured-number' && !['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'].includes(selected))) return undefined
    const snapshot = fresh('source')
    return { statements: [call(snapshot, 'source.fields', { source: source.source }), field(node.id, 'data.field', selected, { record: output(snapshot, 'record') })] }
  }
  if (node.module === 'status.has-source-mark') {
    const statusType = parameters.statusType
    if (typeof statusType !== 'string') return undefined
    const statuses = read('piece.field', 'statusTags', { piece: source.target })
    const sourceId = fresh('source-id')
    const filtered = fresh('matches')
    const tagType = fresh('tag-type')
    const tagSource = fresh('tag-source')
    const stacks = fresh('stacks')
    const typeMatch = fresh('type-match')
    const sourceMatch = fresh('source-match')
    const positive = fresh('positive')
    const zero = fresh('zero')
    const nonnegative = fresh('nonnegative')
    const same = fresh('same')
    const both = fresh('both')
    const defaultPositive = fresh('default-positive')
    const defaultSame = fresh('default-same')
    const defaultBoth = fresh('default-both')
    const count = fresh('count')
    statements.push(
      field(sourceId, 'piece.field', 'instanceId', { piece: source.source }),
      {
        kind: 'collection', id: filtered, method: 'filter', items: statuses, item: 'item',
        inputs: { source: output(sourceId) }, body: [
          field(tagType, 'data.field', 'type', { record: input('item') }),
          field(tagSource, 'data.field', 'sourceId', { record: input('item') }),
          field(stacks, 'data.field', 'stacks', { record: input('item') }),
          genericCompare(typeMatch, output(tagType), literal(statusType), nullableStringType),
          genericCompare(sourceMatch, output(tagSource), input('source'), nullableStringType),
          {
            kind: 'if', id: fresh('stack-default'), condition: output(stacks, 'exists'),
            then: [
              call(positive, 'compare.greater-than', { left: output(stacks), right: literal(0) }),
              genericCompare(zero, output(stacks), literal(0), 'number'),
              call(nonnegative, 'logic.or', { left: output(positive), right: output(zero) }),
              call(same, 'logic.and', { left: output(typeMatch), right: output(sourceMatch) }),
              call(both, 'logic.and', { left: output(same), right: output(nonnegative) }),
              { kind: 'return', id: fresh('filter-return'), value: output(both) },
            ],
            else: [
              call(defaultPositive, 'compare.greater-than', { left: literal(1), right: literal(0) }),
              call(defaultSame, 'logic.and', { left: output(typeMatch), right: output(sourceMatch) }),
              call(defaultBoth, 'logic.and', { left: output(defaultSame), right: output(defaultPositive) }),
              { kind: 'return', id: fresh('filter-default-return'), value: output(defaultBoth) },
            ],
          },
        ],
      },
      call(count, 'collection.length', { items: output(filtered) }),
      call(node.id, 'compare.greater-than', { left: output(count), right: literal(0) }),
    )
    return { statements }
  }
  if (node.module === 'effect.batch-succeeded-for') {
    const results = read('result.field', 'results', { record: source.result })
    const filtered = fresh('matches')
    const targetId = fresh('target-id')
    const success = fresh('success')
    const targetMatch = fresh('target-match')
    const successMatch = fresh('success-match')
    const both = fresh('both')
    const count = fresh('count')
    statements.push(
      {
        kind: 'collection', id: filtered, method: 'filter', items: results, item: 'item',
        inputs: { target: source.target }, body: [
          field(targetId, 'result.field', 'targetId', { record: input('item') }),
          genericCompare(targetMatch, output(targetId), input('target'), nullablePieceType),
          field(success, 'result.field', 'success', { record: input('item') }),
          genericCompare(successMatch, output(success), literal(true), 'boolean'),
          call(both, 'logic.and', { left: output(targetMatch), right: output(successMatch) }),
          { kind: 'return', id: fresh('filter-return'), value: output(both) },
        ],
      },
      call(count, 'collection.length', { items: output(filtered) }),
      call(node.id, 'compare.greater-than', { left: output(count), right: literal(0) }),
    )
    return { statements }
  }
  if (node.module === 'effect.batch-number-for') {
    const selected = parameters.field === undefined ? 'damage' : parameters.field
    if (selected !== 'damage' && selected !== 'heal') return undefined
    const results = read('result.field', 'results', { record: source.result })
    const filtered = fresh('matches')
    const targetId = fresh('target-id')
    const targetMatch = fresh('target-match')
    const reduced = fresh('first-number')
    const amount = fresh('amount')
    const firstIndex = fresh('first-index')
    const nextAccumulator = fresh('next-accumulator')
    statements.push(
      {
        kind: 'collection', id: filtered, method: 'filter', items: results, item: 'item',
        inputs: { target: source.target }, body: [
          field(targetId, 'result.field', 'targetId', { record: input('item') }),
          genericCompare(targetMatch, output(targetId), input('target'), nullablePieceType),
          { kind: 'return', id: fresh('filter-return'), value: output(targetMatch) },
        ],
      },
      {
        kind: 'collection', id: reduced, method: 'reduce', items: output(filtered), item: 'item', accumulator: 'accumulator', initial: literal(0), body: [
          field(amount, 'result.field', selected, { record: input('item') }),
          genericCompare(firstIndex, input('index'), literal(0), 'number'),
          generatedCall(nextAccumulator, 'logic.select', {
            condition: output(firstIndex), whenTrue: output(amount), whenFalse: input('accumulator'),
          }, { valueType: 'number' }),
          { kind: 'return', id: fresh('reduce-return'), value: output(nextAccumulator) },
        ],
      },
    )
    return { statements, outputs: { value: output(reduced) } }
  }
  if (node.module === 'status.has-skill-id') {
    const statuses = read('piece.field', 'statusTags', { piece: source.piece })
    const reduced = fresh('first-status')
    const tagId = fresh('status-id')
    const skillIds = fresh('skill-ids')
    const idMatch = fresh('status-match')
    const idPresent = fresh('status-present')
    const idAndMatch = fresh('status-present-match')
    const skillMatches = fresh('skill-matches')
    const skillMatch = fresh('skill-match')
    const skillCount = fresh('skill-count')
    const skillExists = fresh('skill-exists')
    const accumulatorEmpty = fresh('status-unmatched')
    const firstMatch = fresh('first-status-match')
    const candidate = fresh('status-result')
    const next = fresh('next-status-result')
    statements.push({
      kind: 'collection', id: reduced, method: 'reduce', items: statuses, item: 'item', accumulator: 'accumulator', initial: literal(0),
      inputs: { statusId: source.statusId, skillId: source.skillId }, body: [
        field(tagId, 'data.field', 'id', { record: input('item') }),
        genericCompare(idMatch, output(tagId), input('statusId'), nullableStringType),
        genericCompare(idPresent, output(tagId), literal(null), nullableStringType, '!='),
        call(idAndMatch, 'logic.and', { left: output(idPresent), right: output(idMatch) }),
        field(skillIds, 'data.field', 'skillIds', { record: input('item') }),
        {
          kind: 'collection', id: skillMatches, method: 'filter', items: output(skillIds), item: 'skill',
          inputs: { expected: input('skillId') }, body: [
            genericCompare(skillMatch, input('skill'), input('expected'), nullableStringType),
            { kind: 'return', id: fresh('skill-return'), value: output(skillMatch) },
          ],
        },
        call(skillCount, 'collection.length', { items: output(skillMatches) }),
        call(skillExists, 'compare.greater-than', { left: output(skillCount), right: literal(0) }),
        genericCompare(accumulatorEmpty, input('accumulator'), literal(0), 'number'),
        call(firstMatch, 'logic.and', { left: output(idAndMatch), right: output(accumulatorEmpty) }),
        generatedCall(candidate, 'logic.select', { condition: output(skillExists), whenTrue: literal(1), whenFalse: literal(-1) }, { valueType: 'number' }),
        generatedCall(next, 'logic.select', { condition: output(firstMatch), whenTrue: output(candidate), whenFalse: input('accumulator') }, { valueType: 'number' }),
        { kind: 'return', id: fresh('reduce-return'), value: output(next) },
      ],
    })
    statements.push(genericCompare(node.id, output(reduced), literal(1), 'number'))
    return { statements }
  }
  if (node.module === 'status.player-transfer-records') {
    const statusType = parameters.statusType
    if (typeof statusType !== 'string') return undefined
    const tagsId = fresh('status-tags')
    statements.push(field(tagsId, 'player.field', 'statusTags', { player: source.player }))
    const tags = output(tagsId)
    const filtered = fresh('matches')
    const tagType = fresh('tag-type')
    const typeMatch = fresh('type-match')
    const records = fresh('records')
    const intensity = fresh('intensity')
    const sourceId = fresh('source-id')
    const targetId = fresh('target-id')
    const sourcePresent = fresh('source-present')
    const targetPresent = fresh('target-present')
    const normalizedSource = fresh('normalized-source')
    const normalizedTarget = fresh('normalized-target')
    const record = fresh('record')
    const zeroRecord = fresh('zero-record')
    const count = fresh('count')
    statements.push(
      {
        kind: 'collection', id: filtered, method: 'filter', items: tags, item: 'item', body: [
          field(tagType, 'data.field', 'type', { record: input('item') }),
          genericCompare(typeMatch, output(tagType), literal(statusType), nullableStringType),
          { kind: 'return', id: fresh('filter-return'), value: output(typeMatch) },
        ],
      },
      {
        kind: 'collection', id: records, method: 'map', items: output(filtered), item: 'item', body: [
          field(intensity, 'data.field', 'intensity', { record: input('item') }),
          field(sourceId, 'data.field', 'sourceId', { record: input('item') }),
          field(targetId, 'data.field', 'targetId', { record: input('item') }),
          genericCompare(sourcePresent, output(sourceId), literal(''), nullableStringType, '!='),
          genericCompare(targetPresent, output(targetId), literal(''), nullableStringType, '!='),
          generatedCall(normalizedSource, 'logic.select', {
            condition: output(sourcePresent), whenTrue: output(sourceId), whenFalse: literal(null),
          }, { valueType: valueTypeParameter(nullableStringType) }),
          generatedCall(normalizedTarget, 'logic.select', {
            condition: output(targetPresent), whenTrue: output(targetId), whenFalse: literal(null),
          }, { valueType: valueTypeParameter(nullableStringType) }),
          {
            kind: 'if', id: fresh('intensity-default'), condition: output(intensity, 'exists'), then: [
              {
                kind: 'record.create', id: record, schema: 'attribute-transfer@1',
                fields: { intensity: output(intensity), sourceId: output(normalizedSource), targetId: output(normalizedTarget) },
              },
              { kind: 'return', id: fresh('map-return'), value: output(record, 'value') },
            ], else: [
              {
                kind: 'record.create', id: zeroRecord, schema: 'attribute-transfer@1',
                fields: { intensity: literal(0), sourceId: output(normalizedSource), targetId: output(normalizedTarget) },
              },
              { kind: 'return', id: fresh('map-default-return'), value: output(zeroRecord, 'value') },
            ],
          },
        ],
      },
    )
    statements.push(
      call(count, 'collection.length', { items: output(records) }),
    )
    return { statements, outputs: { records: output(records), count: output(count), exists: output(tagsId, 'exists') } }
  }
  if (node.module === 'piece.matches-template') {
    const template = read('piece.field', 'templateId', { piece: source.piece })
    statements.push(call(node.id, 'compare.equal-string', { left: template, right: literal(parameters.templateId) }))
    return { statements }
  }
  if (node.module === 'damage.killed' || node.module === 'damage.was-blocked' || node.module === 'effect.result-killed' || node.module === 'effect.result-number') {
    const name = node.module === 'damage.was-blocked' ? 'blocked' : node.module === 'effect.result-number' ? String(parameters.field) : 'isKilled'
    return { statements: [field(node.id, 'result.field', name, { record: source.result })], ...(node.module === 'effect.result-killed' ? { outputs: { killed: output(node.id) } } : {}) }
  }
  if (node.module === 'damage.batch-amount-at' || node.module === 'damage.batch-succeeded-at') {
    const items = read('result.field', 'results', { record: source.result }), position = fresh('position'), item = fresh('item')
    statements.push(call(position, 'math.add', { left: source.index, right: literal(1) }), call(item, 'collection.at', { items, position: output(position) }),
      field(node.id, 'result.field', node.module === 'damage.batch-amount-at' ? 'damage' : 'success', { record: output(item) }))
    return { statements }
  }
  if (node.module === 'status.has-skill-instance') {
    const snapshot = fresh('status'), optionalItems = fresh('optional-skills'), items = fresh('skills'), matches = fresh('matches'), match = fresh('match'), count = fresh('count')
    // An absent status is a valid negative membership query, not an invalid
    // condition that would skip both branches and run the rule's suffix.
    statements.push(call(snapshot, 'status.fields', { status: source.status }), field(optionalItems, 'data.optional-field', 'skillIds', { record: output(snapshot, 'record') }),
      call(items, 'value.coalesce', { value: output(optionalItems), defaultValue: literal([]) }, { valueType: valueTypeParameter({ kind: 'list', element: 'string' }) }),
      { kind: 'collection', id: matches, method: 'filter', items: output(items), inputs: { skill: source.skillId }, body: [
        call(match, 'compare.equal-string-nullable', { left: input('item'), right: input('skill') }, {}, '2'),
        { kind: 'return', id: fresh('return'), value: output(match) },
      ] }, call(count, 'collection.length', { items: output(matches) }), call(node.id, 'compare.greater-than', { left: output(count), right: literal(0) }))
    return { statements }
  }
  if (node.module === 'tile.has-effect') {
    const items = read('battle.field', 'tileEffects', {}), cell = fresh('cell'), matches = fresh('matches'), count = fresh('count')
    const x = fresh('x'), y = fresh('y'), type = fresh('type'), xMatch = fresh('x-match'), yMatch = fresh('y-match'), typeMatch = fresh('type-match'), cellMatch = fresh('cell-match'), all = fresh('all')
    statements.push(call(cell, 'spatial.cell-coordinates', { cell: source.cell }),
      { kind: 'collection', id: matches, method: 'filter', items, inputs: { x: output(cell, 'x'), y: output(cell, 'y') }, body: [
        field(x, 'data.field', 'x', { record: input('item') }), field(y, 'data.field', 'y', { record: input('item') }), field(type, 'data.field', 'type', { record: input('item') }),
        call(xMatch, 'compare.equal', { left: output(x), right: input('x') }), call(yMatch, 'compare.equal', { left: output(y), right: input('y') }),
        call(typeMatch, 'compare.equal-string-nullable', { left: output(type), right: literal(parameters.effectType) }, {}, '2'),
        call(cellMatch, 'logic.and', { left: output(xMatch), right: output(yMatch) }), call(all, 'logic.and', { left: output(cellMatch), right: output(typeMatch) }),
        { kind: 'return', id: fresh('return'), value: output(all) },
      ] }, call(count, 'collection.length', { items: output(matches) }), call(node.id, 'compare.greater-than', { left: output(count), right: literal(0) }))
    return { statements, outputs: { exists: output(node.id) } }
  }
  if (node.module === 'card.hand-count') {
    const id = fresh('hand')
    return { statements: [call(id, 'card.hand-instances', { player: source.player }), call(node.id, 'collection.length', { items: output(id, 'cards') })] }
  }
  if (node.module === 'status.count-all') {
    const items = read('piece.field', 'statusTags', { piece: source.target })
    statements.push(call(node.id, 'collection.length', { items }))
    return { statements, outputs: { count: output(node.id) } }
  }
  const isBatch = node.module.startsWith('damage.batch-')
  const isRule = node.module === 'rule.has-piece'
  let items: GameplayValue
  if (isBatch) items = read('result.field', 'results', { record: source.result })
  else if (node.module === 'source.captured-has-status') {
    const id = fresh('source')
    statements.push(call(id, 'source.fields', { source: source.source }))
    items = read('data.field', 'statusTags', { record: output(id, 'record') })
  } else if (node.module === 'status.has-player') items = read('player.field', 'statusTags', { player: source.player })
  else items = read('piece.field', isRule ? 'rules' : 'statusTags', { piece: source.piece || source.target })

  if (node.module === 'damage.batch-total') {
    const amount = fresh('damage'), sum = fresh('sum'), done = fresh('sum-return')
    statements.push({ kind: 'collection', id: node.id, method: 'reduce', items, initial: literal(0), body: [
      field(amount, 'result.field', 'damage', { record: input('item') }),
      call(sum, 'math.add', { left: input('accumulator'), right: output(amount) }),
      { kind: 'return', id: done, value: output(sum) },
    ] })
    return { statements }
  }
  const filtered = fresh('filtered'), property = fresh('field'), matched = fresh('matches')
  const propertyName = isBatch ? 'isKilled' : isRule || node.module === 'status.has-id' ? 'id' : 'type'
  const expected = isRule ? literal(parameters.ruleId) : node.module === 'status.has-id' ? source.statusId : literal(parameters.statusType)
  const body: GameplayStatement[] = [field(property, isBatch ? 'result.field' : 'data.field', propertyName, { record: input('item') })]
  let condition = output(property)
  const captures: Record<string, GameplayValue> = {}
  if (!isBatch) {
    captures.expected = expected
    body.push(call(matched, 'compare.equal-string-nullable', { left: output(property), right: input('expected') }, {}, '2'))
    condition = output(matched)
    if (node.module === 'status.has-id') {
      const present = fresh('present')
      const hasId = fresh('has-id')
      body.push(
        genericCompare(present, output(property), literal(null), nullableStringType, '!='),
        call(hasId, 'logic.and', { left: output(present), right: output(matched) }),
      )
      condition = output(hasId)
    }
  }
  if (node.module === 'status.matches-type' && parameters.legacyStrings && parameters.legacyStrings !== 'ignore') {
    const legacy = fresh('legacy-text'), legacyMatches = fresh('legacy-matches'), either = fresh('either')
    body.push(field(legacy, 'data.field', 'legacyText', { record: input('item') }),
      parameters.legacyStrings === 'exact'
        ? call(legacyMatches, 'compare.equal-string-nullable', { left: output(legacy), right: input('expected') }, {}, '2')
        : call(legacyMatches, 'text.contains', { text: output(legacy), value: input('expected') }),
      call(either, 'logic.or', { left: condition, right: output(legacyMatches) }))
    condition = output(either)
  }
  if (node.module === 'status.has-source-turn') {
    const identifier = fresh('source-id')
    statements.push(field(identifier, 'piece.field', 'instanceId', { piece: source.source }))
    captures.source = output(identifier); captures.turn = source.turn
    const tagSource = fresh('tag-source'), sameSource = fresh('same-source'), tagTurn = fresh('tag-turn'), sameTurn = fresh('same-turn'), both = fresh('both'), all = fresh('all')
    body.push(
      field(tagSource, 'data.field', 'sourceId', { record: input('item') }),
      call(sameSource, 'compare.equal-string-nullable', { left: output(tagSource), right: input('source') }, {}, '2'),
      field(tagTurn, 'data.field', 'lastDamageTurn', { record: input('item') }),
      call(sameTurn, 'compare.equal', { left: output(tagTurn), right: input('turn') }),
      call(both, 'logic.and', { left: condition, right: output(sameSource) }),
      call(all, 'logic.and', { left: output(both), right: output(sameTurn) }),
    )
    condition = output(all)
  }
  body.push({ kind: 'return', id: fresh('filter-return'), value: condition })
  statements.push({ kind: 'collection', id: filtered, method: 'filter', items, inputs: captures, body })
  if (node.module === 'status.count-piece' || node.module === 'damage.batch-kill-count') {
    statements.push(call(node.id, 'collection.length', { items: output(filtered) }))
  } else {
    const length = fresh('count')
    statements.push(call(length, 'collection.length', { items: output(filtered) }), call(node.id, 'compare.greater-than', { left: output(length), right: literal(0) }))
  }
  return { statements }
}
