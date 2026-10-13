import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayLiteral,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
} from './module-types'

/** Compatibility write helpers replaced by generic instance/collection flows. */
export const ATOMIC_ABILITY_WRITE_MODULES = new Set([
  'skill.reset-cooldowns',
  'skill.adjust-active-cooldowns-at-least',
  'skill.adjust-all-cooldowns',
  'followup.remove-status-types',
  'ability.mark-spent',
  'status.replace-related-rules',
  'status.refresh-position',
])
export const ATOMIC_ABILITY_WRITE_MODULE_IDS = ATOMIC_ABILITY_WRITE_MODULES

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const nullableStringType = /* @__PURE__ */ JSON.stringify({ kind: 'nullable', value: 'string' })
const stringListType = /* @__PURE__ */ JSON.stringify({ kind: 'list', element: 'string' })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function field(id: string, instance: GameplayValue, selected: 'skillId' | 'kind' | 'currentCooldown' | 'definitionExists'): GameplayCallStatement {
  return call(id, 'skill.instance-field', { instance }, { field: selected })
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  valueType: GameplayLiteral,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType, operator })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.and', { left, right })
}

function or(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.or', { left, right })
}

function collection(
  id: string,
  method: 'filter',
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
  item = 'item',
): GameplayStatement {
  return {
    kind: 'collection', id, method, items, item,
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function instances(id: string, piece: GameplayValue): GameplayCallStatement {
  return call(id, 'skill.instances', { piece })
}

function resetReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const piece = node.inputs?.piece ?? literal(null)
  const source = fresh('skill-instances')
  const filtered = fresh('resettable-skills')
  const excluded = typeof node.parameters?.excludeSkillId === 'string'
    ? literal(node.parameters.excludeSkillId)
    : literal(null)
  const skillId = fresh('skill-id')
  const excludedMatch = fresh('excluded-match')
  const exclusionMissing = fresh('exclusion-missing')
  const allowedSkill = fresh('allowed-skill')
  const cooldown = fresh('cooldown')
  const cooldownValue = fresh('cooldown-value')
  const hasCooldown = fresh('has-cooldown')
  const filterBody: GameplayStatement[] = [
    field(skillId, input('item'), 'skillId'),
    compare(excludedMatch, output(skillId), excluded, nullableStringType, '!='),
    compare(exclusionMissing, excluded, literal(null), nullableStringType, '=='),
    or(allowedSkill, output(exclusionMissing), output(excludedMatch)),
    field(cooldown, input('item'), 'currentCooldown'),
    call(cooldownValue, 'value.coalesce', { value: output(cooldown), defaultValue: literal(0) }, { valueType: 'number' }),
    call(hasCooldown, 'compare.greater-than', { left: output(cooldownValue), right: literal(0) }),
    and(fresh('reset-filter-match'), output(allowedSkill), output(hasCooldown)),
  ]
  const resetMatch = filterBody[filterBody.length - 1] as GameplayCallStatement
  filterBody.push(returnValue(fresh('reset-filter-return'), output(resetMatch.id)))
  const filter = collection(filtered, 'filter', output(source, 'instances'), filterBody)
  const write = call(fresh('reset-skill'), 'skill.set-instance-cooldown', { instance: input('item'), value: literal(0) })
  const each: GameplayStatement = { kind: 'foreach', id: fresh('reset-each'), items: output(filtered), item: 'item', body: [write] }
  return {
    statements: [instances(source, piece), filter, each],
    outputs: { success: output(source, 'present'), present: output(source, 'present') },
  }
}

function adjustReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const piece = node.inputs?.piece ?? literal(null)
  const amount = node.inputs?.amount ?? literal(0)
  const amountLocal = fresh('amount-local')
  const amountRead = fresh('amount-read')
  const source = fresh('skill-instances')
  const filtered = fresh('active-skills')
  const definitionExists = fresh('definition-exists')
  const definitionMissing = fresh('definition-missing')
  const kind = fresh('skill-kind')
  const kindActive = fresh('kind-active')
  const active = fresh('active-match')
  const filterBody: GameplayStatement[] = [
    field(definitionExists, input('item'), 'definitionExists'),
    compare(definitionMissing, output(definitionExists), literal(false), 'boolean', '=='),
    field(kind, input('item'), 'kind'),
    compare(kindActive, output(kind), literal('active'), nullableStringType, '=='),
    or(active, output(definitionMissing), output(kindActive)),
    returnValue(fresh('active-filter-return'), output(active)),
  ]
  const filter = collection(filtered, 'filter', output(source, 'instances'), filterBody)
  const cooldown = fresh('cooldown')
  const current = fresh('current-cooldown')
  const next = fresh('next-cooldown')
  const eachBody: GameplayStatement[] = [
    field(cooldown, input('item'), 'currentCooldown'),
    call(current, 'value.coalesce', { value: output(cooldown), defaultValue: literal(0) }, { valueType: 'number' }),
    call(next, 'math.max', { left: output(current), right: output(amountRead) }),
    call(fresh('set-cooldown'), 'skill.set-instance-cooldown', { instance: input('item'), value: output(next) }),
  ]
  const each: GameplayStatement = { kind: 'foreach', id: fresh('adjust-each'), items: output(filtered), item: 'item', body: eachBody }
  const inputsReady = fresh('adjust-inputs-ready')
  const result = fresh('adjust-result')
  const statements: GameplayStatement[] = [
    call(amountLocal, 'local.declare', { initial: amount }, { valueType: 'number' }),
    call(amountRead, 'local.read', { handle: output(amountLocal, 'handle') }, { valueType: 'number' }),
    instances(source, piece),
    filter,
    each,
    and(inputsReady, output(amountLocal, 'success'), output(amountRead, 'success')),
    and(result, output(inputsReady), output(source, 'present')),
  ]
  return {
    statements,
    outputs: { success: output(result), present: output(result) },
  }
}

function removeStatusTypesReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const piece = node.inputs?.piece ?? literal(null)
  const types = node.inputs?.types ?? literal([])
  const statuses = fresh('status-records')
  const matching = fresh('matching-statuses')
  const typesLocal = fresh('types-local')
  const typesRead = fresh('types-read')
  const statusType = fresh('status-type')
  const candidates = fresh('matching-types')
  const candidateMatch = fresh('type-match')
  const candidateCount = fresh('type-count')
  const typePresent = fresh('type-present')
  const filterBody: GameplayStatement[] = [
    call(statusType, 'status.instance-field', { status: input('item') }, { field: 'type' }),
    collection(candidates, 'filter', input('types'), [
      compare(candidateMatch, input('candidate'), input('currentType'), nullableStringType, '=='),
      returnValue(fresh('type-filter-return'), output(candidateMatch)),
    ], { currentType: output(statusType), types: input('types') }, 'candidate'),
    call(candidateCount, 'collection.length', { items: output(candidates) }),
    call(typePresent, 'compare.greater-than', { left: output(candidateCount), right: literal(0) }),
    returnValue(fresh('status-filter-return'), output(typePresent)),
  ]
  const eachBody: GameplayStatement[] = [
    call(fresh('remove-status'), 'status.remove-instance', { status: input('item') }),
  ]
  const each: GameplayStatement = { kind: 'foreach', id: fresh('remove-each'), items: output(matching), item: 'item', body: eachBody }
  const fieldRead = call(statuses, 'status.instances', { piece })
  const inputsReady = fresh('remove-inputs-ready')
  const result = fresh('remove-result')
  const statements: GameplayStatement[] = [
    call(typesLocal, 'local.declare', { initial: types }, { valueType: stringListType }),
    call(typesRead, 'local.read', { handle: output(typesLocal, 'handle') }, { valueType: stringListType }),
    fieldRead,
    collection(matching, 'filter', output(statuses, 'statuses'), filterBody, { types: output(typesRead, 'value') }),
    each,
    and(inputsReady, output(typesLocal, 'success'), output(typesRead, 'success')),
    and(result, output(inputsReady), output(statuses, 'present')),
  ]
  return { statements, outputs: { success: output(result) } }
}

function adjustAllReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const source = fresh('instances'), count = fresh('count'), ready = fresh('has-skills')
  const cooldown = fresh('cooldown'), current = fresh('current'), next = fresh('next')
  const amount = fresh('amount'), amountValue = fresh('amount-value'), result = fresh('result')
  return { statements: [
    call(amount, 'local.declare', { initial: node.inputs!.amount }, { valueType: 'number' }),
    call(amountValue, 'local.read', { handle: output(amount, 'handle') }, { valueType: 'number' }),
    instances(source, node.inputs!.piece),
    call(count, 'collection.length', { items: output(source, 'instances') }),
    call(ready, 'compare.greater-than', { left: output(count), right: literal(0) }),
    { kind: 'foreach', id: fresh('each'), items: output(source, 'instances'), item: 'item', body: [
      field(cooldown, input('item'), 'currentCooldown'),
      call(current, 'value.coalesce', { value: output(cooldown), defaultValue: literal(0) }, { valueType: 'number' }),
      call(next, node.parameters?.mode === 'add' ? 'math.add' : 'math.max', { left: output(current), right: output(amountValue) }),
      call(fresh('write'), 'skill.set-instance-cooldown', { instance: input('item'), value: output(next) }),
    ] },
    and(result, output(ready), output(amountValue, 'success')),
  ], outputs: { success: output(result) } }
}

/** Expand the three convenience writers into generic reads, filters, and setters. */
export const atomicAbilityWriteRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (node.module === 'status.replace-related-rules' || node.module === 'status.refresh-position') {
    const position = node.module === 'status.refresh-position'
    const duration = node.parameters?.duration
    if (position && (typeof duration !== 'number' || !Number.isInteger(duration) || duration < -1)) return undefined
    const statuses = fresh('statuses'), selected = fresh('selected'), type = fresh('type'), matches = fresh('matches'), statusId = fresh('status-id'), idMatches = fresh('id-matches'), both = fresh('both')
    const body: GameplayStatement[] = [
      call(type, 'status.instance-field', { status: input('item') }, { field: 'type' }),
      compare(matches, output(type), literal(node.parameters!.statusType), nullableStringType),
    ]
    if (!position) body.push(
      call(statusId, 'status.instance-field', { status: input('item') }, { field: 'id' }),
      compare(idMatches, output(statusId), literal(node.parameters!.statusId), nullableStringType),
      and(both, output(matches), output(idMatches)),
    )
    body.push(returnValue(fresh('match'), output(position ? matches : both)))
    const statements: GameplayStatement[] = [
      call(statuses, 'status.instances', { piece: node.inputs![position ? 'target' : 'piece'] }),
      { kind: 'collection', id: selected, method: 'find', items: output(statuses, 'statuses'), item: 'item', body },
    ]
    const write = fresh('write')
    if (position) {
      // Validate the complete old operation before its first write. A missing
      // coordinate invalidates all dependent writes, including the duration.
      const empty = fresh('position-record'), x = fresh('position-x'), y = fresh('position-y'), complete = fresh('position-duration')
      statements.push(
        call(empty, 'record.empty'),
        call(x, 'record.set-key', { record: output(empty, 'record'), key: literal('x'), value: node.inputs!.x }, { valueType: 'number' }),
        call(y, 'record.set-key', { record: output(x, 'record'), key: literal('y'), value: node.inputs!.y }, { valueType: 'number' }),
        call(complete, 'record.set-key', { record: output(y, 'record'), key: literal('duration'), value: literal(duration!) }, { valueType: 'number' }),
      )
      for (const [key, field] of [['x', 'value'], ['y', 'intensity'], ['duration', 'remainingDuration']]) {
        const read = fresh(`read-${key}`)
        statements.push(
          call(read, 'data.read-key', { record: output(complete, 'record') }, { key, valueType: 'number' }),
          call(key === 'duration' ? write : fresh(`write-${key}`), 'status.set-number-instance', { status: output(selected), value: output(read) }, { field }),
        )
      }
    }
    else statements.push(call(write, 'status.write-field', { status: output(selected), value: node.inputs!.rules }, { field: 'relatedRules' }))
    return { statements, outputs: { [position ? 'success' : 'changed']: output(write, 'success') } }
  }
  if (node.module === 'ability.mark-spent') {
    const read = fresh('spent-abilities'), append = fresh('append-ability')
    return { statements: [
      call(read, 'piece.field', { piece: node.inputs!.piece }, { field: 'spentPassives' }),
      call(append, 'collection.concat', { left: output(read), right: literal([node.parameters!.abilityId]) }, { valueType: stringListType }),
      call(fresh('write-spent-abilities'), 'piece.write-field', { piece: node.inputs!.piece, value: output(append, 'items') }, { field: 'spentPassives' }),
    ] }
  }
  if (node.module === 'skill.reset-cooldowns') return resetReplacement(node, fresh)
  if (node.module === 'skill.adjust-active-cooldowns-at-least') return adjustReplacement(node, fresh)
  if (node.module === 'skill.adjust-all-cooldowns') return adjustAllReplacement(node, fresh)
  if (node.module === 'followup.remove-status-types') return removeStatusTypesReplacement(node, fresh)
  return undefined
}

export function migrateAbilityWriteModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicAbilityWriteRecipe)
}

export const migrateAtomicAbilityWriteGraph = migrateAbilityWriteModules
