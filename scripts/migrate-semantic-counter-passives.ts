import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { importContentGraph } from '../electron-editor/content-graph-import'
import { assertContentGraphArtifact } from '../electron-editor/content-graph-document'
import { assertFrozenExecutable } from './semantic-migration-source'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const COUNTER_PASSIVE_RULE_IDS = [
  'rule-momentum-gain',
  'rule-mortis-damage-counter',
  'rule-el-primo-injury-counter',
  'rule-grimmjow-destruction-instinct',
  'rule-ulquiorra-damage-dealt',
  'rule-ulquiorra-damage-taken',
  'rule-akaza-damage-mark',
  'rule-akaza-fighting-spirit',
  'rule-obito-grudge',
  'rule-shishio-kill-track',
  'rule-shishio-cooldown-once',
  'rule-muzan-regeneration-damage',
  'rule-muzan-regeneration-end',
] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const local = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })

type UnknownRecord = Record<string, unknown>

const record = (value: unknown): UnknownRecord | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined
const stringValue = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/**
 * The three existing author graphs were imported by an older content-graph
 * importer.  That importer represented `find`/`indexOf` as a bound-method
 * bind followed by an invoke.  The current graph form stores the same call as
 * one collection expression.  Fold only those exact receiver pairs before
 * comparing the graph; arbitrary hand edits still fail the structural check.
 */
function foldFrozenCollectionReceivers(input: unknown): UnknownRecord {
  const graph = record(input)
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('author graph is invalid')
  const nodes = graph.nodes.map(record)
  if (nodes.some(node => !node)) throw new Error('author graph contains an invalid node')
  const concrete = nodes as UnknownRecord[]
  const invokes = new Map<string, UnknownRecord>()
  for (const node of concrete) {
    const target = record(node.target)
    const targetValue = target && record(target.value)
    if (node.kind === 'invoke' && target?.kind === 'function' && targetValue?.kind === 'ref') {
      const name = stringValue(targetValue.name)
      if (name) invokes.set(name, node)
    }
  }
  const paired = new Set<string>()
  for (const node of concrete) {
    const expression = record(node.expr)
    const method = expression && stringValue(expression.method)
    const name = stringValue(node.name)
    if (node.kind === 'bind' && expression?.kind === 'boundMethod' && (method === 'find' || method === 'indexOf') && name && invokes.has(name)) {
      const invoke = invokes.get(name)!
      const invokeTarget = record(invoke.target)
      const invokeTargetValue = invokeTarget && record(invokeTarget.value)
      if (node.next === invoke.id && invokeTarget?.kind === 'function' && invokeTargetValue?.kind === 'ref' && invokeTargetValue.name === name && typeof invoke.result === 'string' && typeof invoke.next === 'string') paired.add(String(invoke.id))
    }
  }
  const output: UnknownRecord[] = []
  for (const node of concrete) {
    if (paired.has(String(node.id))) continue
    const expression = record(node.expr)
    const method = expression && stringValue(expression.method)
    const name = stringValue(node.name)
    const invoke = name ? invokes.get(name) : undefined
    const invokeTarget = invoke && record(invoke.target)
    const invokeTargetValue = invokeTarget && record(invokeTarget.value)
    if (node.kind === 'bind' && expression?.kind === 'boundMethod' && (method === 'find' || method === 'indexOf') && name && invoke && node.next === invoke.id && paired.has(String(invoke.id)) && invokeTarget?.kind === 'function' && invokeTargetValue?.kind === 'ref' && invokeTargetValue.name === name && typeof invoke.result === 'string' && typeof invoke.next === 'string') {
      output.push({ id: node.id, kind: 'bind', name: invoke.result, expr: { kind: 'collection', object: expression.object, method, args: invoke.args }, next: invoke.next })
      continue
    }
    output.push(node)
  }
  return { ...graph, nodes: output }
}

function canonicalFrozenAuthorGraph(input: unknown): UnknownRecord {
  const graph = foldFrozenCollectionReceivers(input)
  const nodes = graph.nodes as UnknownRecord[]
  const byId = new Map(nodes.map(node => [String(node.id), node]))
  const aliases = new Map<string, string>()
  // Only an adjacent snapshot of a single-assignment importer temporary is
  // interchangeable with its source. General aliases may capture old values.
  const writes = new Map<string, number>()
  const definitions = new Map<string, UnknownRecord>()
  const visitWrites = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visitWrites); return }
    const item = record(value)
    if (!item) return
    const target = record(item.target)
    const assigned = item.kind === 'bind' ? stringValue(item.name)
      : item.kind === 'set' && target?.kind === 'ref' ? stringValue(target.name)
      : ['call', 'invoke'].includes(String(item.kind)) ? stringValue(item.result) : undefined
    if (assigned) { writes.set(assigned, (writes.get(assigned) ?? 0) + 1); definitions.set(assigned, item) }
    Object.values(item).forEach(visitWrites)
  }
  visitWrites(nodes)
  const temporary = /^__rvb_import_(?:operand|effect)_\d+$/
  for (const node of nodes) {
    const expression = record(node.expr)
    const name = stringValue(node.name)
    const reference = expression && stringValue(expression.name)
    if (node.kind === 'bind' && name && expression?.kind === 'ref' && reference
      && temporary.test(name) && temporary.test(reference)
      && writes.get(name) === 1 && writes.get(reference) === 1
      && definitions.get(reference)?.next === node.id) aliases.set(name, reference)
  }
  const resolve = (name: string): string => {
    let current = name
    const seen = new Set<string>()
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current)
      current = aliases.get(current)!
    }
    return current
  }
  const aliasNodeIds = new Set(nodes.filter(node => node.kind === 'bind' && aliases.has(String(node.name))).map(node => String(node.id)))
  const skipAlias = (id: string): string => {
    let current = id
    const seen = new Set<string>()
    while (aliasNodeIds.has(current) && !seen.has(current)) {
      seen.add(current)
      const next = stringValue(byId.get(current)?.next)
      if (!next) return current
      current = next
    }
    return current
  }
  const ordered: UnknownRecord[] = []
  const visited = new Set<string>()
  const visit = (id: string | undefined): void => {
    if (!id) return
    const current = skipAlias(id)
    if (visited.has(current)) return
    const node = byId.get(current)
    if (!node) return
    visited.add(current)
    ordered.push(node)
    if (node.kind === 'branch') {
      visit(stringValue(node.yes))
      visit(stringValue(node.no))
    } else visit(stringValue(node.next))
  }
  visit(stringValue(graph.entry))
  for (const node of nodes) {
    const id = String(node.id)
    if (!visited.has(id) && !aliasNodeIds.has(id)) ordered.push(node)
  }
  const nodeIds = new Map(ordered.map((node, index) => [String(node.id), `node${index + 1}`]))
  const localNames = new Map<string, string>()
  const roots = new Set(['context', 'battle', 'flow', 'Math', 'Number', 'String', 'Array', 'Object', 'undefined', 'NaN', 'Infinity'])
  let localIndex = 0
  const local = (name: string): string => {
    const resolved = resolve(name)
    if (roots.has(resolved)) return resolved
    const existing = localNames.get(resolved)
    if (existing) return existing
    const normalized = `local${++localIndex}`
    localNames.set(resolved, normalized)
    return normalized
  }
  const transform = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => transform(item))
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' && (key === 'name' || key === 'result') ? local(value) : value
    }
    const output: UnknownRecord = {}
    for (const [entryKey, entryValue] of Object.entries(value as UnknownRecord)) {
      if (entryKey === 'id' && typeof entryValue === 'string' && byId.has(entryValue)) output[entryKey] = nodeIds.get(entryValue)
      else if (['next', 'yes', 'no'].includes(entryKey) && typeof entryValue === 'string' && byId.has(entryValue)) output[entryKey] = nodeIds.get(skipAlias(entryValue))
      else if (['name', 'result'].includes(entryKey) && typeof entryValue === 'string') output[entryKey] = local(entryValue)
      else output[entryKey] = transform(entryValue, entryKey)
    }
    return output
  }
  return {
    version: graph.version,
    surface: graph.surface,
    entry: nodeIds.get(skipAlias(String(graph.entry))),
    nodes: ordered.map(node => transform(node)),
  }
}

/** Validate one preserved author graph against the frozen importer result. */
export function assertCounterPassiveAuthorGraph(current: Record<string, unknown>, original: Record<string, unknown>, id: string): void {
  if (!record(current.contentGraph) || current.contentGraphField !== 'skillCode') throw new Error(`${id}: missing rule author graph`) 
  assertContentGraphArtifact(current)
  if (typeof original.skillCode !== 'string') throw new Error(`${id}: frozen skillCode is missing`)
  const imported = importContentGraph(original.skillCode, 'rule')
  const expected = JSON.stringify(canonicalFrozenAuthorGraph(imported))
  const actual = JSON.stringify(canonicalFrozenAuthorGraph(current.contentGraph))
  if (actual !== expected) throw new Error(`${id}: author graph is not the exact frozen importer graph after receiver normalization`)
}
const fail = (id: string, message = ''): GameplayStatement => ({
  kind: 'return', id, values: { success: literal(false), message: literal(message) },
})
const failWithoutMessage = (id: string): GameplayStatement => ({ kind: 'return', id, values: { success: literal(false) } })
const success = (id: string, message?: GameplayValue): GameplayStatement => ({
  kind: 'return', id, values: { success: literal(true), ...(message === undefined ? {} : { message }) },
})
const requireCondition = (body: GameplayStatement[], id: string, condition: GameplayValue, failure: GameplayStatement = fail(id + '-return')) => {
  body.push(call(id + '-not', 'logic.not', { value: condition }), {
    kind: 'if', id, condition: out(id + '-not', 'value'), then: [failure],
  })
}
const holderPrelude = (body: GameplayStatement[], withoutMessage = false) => {
  body.push(call('holder-ref', 'ref.holder'), call('holder-exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  requireCondition(body, 'require-holder', out('holder-exists', 'exists'), withoutMessage ? failWithoutMessage('require-holder-return') : undefined)
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }))
  return out('holder', 'piece')
}
const sourceSamePrelude = (body: GameplayStatement[], holder: GameplayValue, withoutMessage = false) => {
  body.push(call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
  requireCondition(body, 'require-source', out('source-exists', 'exists'), withoutMessage ? failWithoutMessage('require-source-return') : undefined)
  body.push(call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('source-same', 'compare.equal-piece', { left: holder, right: out('source', 'piece') }))
  requireCondition(body, 'require-source-same', out('source-same', 'value'), withoutMessage ? failWithoutMessage('require-source-same-return') : undefined)
}
const targetPrelude = (body: GameplayStatement[], failureMessage = '') => {
  body.push(call('target-ref', 'ref.target'), call('target-exists', 'query.has-piece', { pieceId: out('target-ref', 'piece') }))
  requireCondition(body, 'require-target', out('target-exists', 'exists'), fail('require-target-return', failureMessage))
  body.push(call('target', 'query.piece', { pieceId: out('target-ref', 'piece') }))
  return out('target', 'piece')
}
const resultOutputs = [
  { name: 'success', type: 'boolean' as const },
  { name: 'message', type: 'string' as const },
]
const noMessageOutputs = [{ name: 'success', type: 'boolean' as const }]

const statusSchema = {
  id: 'counter-passive-status',
  version: '1',
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'type', type: 'string' as const },
    { name: 'name', type: 'string' as const, optional: true },
    { name: 'visible', type: 'boolean' as const, optional: true },
    { name: 'stacking', type: 'string' as const, optional: true },
    { name: 'sourceId', type: 'string' as const, nullable: true, optional: true },
    { name: 'currentDuration', type: 'number' as const, optional: true },
    { name: 'remainingDuration', type: 'number' as const, optional: true },
    { name: 'currentUses', type: 'number' as const, optional: true },
    { name: 'remainingUses', type: 'number' as const, optional: true },
    { name: 'expiresAfterTurn', type: 'number' as const, nullable: true, optional: true },
    { name: 'lastDamageTurn', type: 'number' as const, optional: true },
    { name: 'stacks', type: 'number' as const, optional: true },
    { name: 'intensity', type: 'number' as const, optional: true },
    { name: 'value', type: 'number' as const, optional: true },
    { name: 'hitCount', type: 'number' as const, optional: true },
    { name: 'readyCharges', type: 'number' as const, optional: true },
  ],
}

function buildMomentumGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  sourceSamePrelude(body, piece)
  body.push(
    call('has-core', 'status.has-piece', { piece }, { statusType: 'momentum-core' }),
  )
  requireCondition(body, 'require-core', out('has-core', 'value'))
  body.push(
    call('distance', 'event.last-move-distance', { piece }),
    call('moved', 'compare.greater-than', { left: out('distance', 'distance'), right: literal(0) }),
  )
  requireCondition(body, 'require-moved', out('moved', 'value'))
  body.push(
    call('core-instance', 'status.find-instance', { piece }, { statusType: 'momentum-core' }),
    call('old', 'status.read-number-instance', { status: out('core-instance', 'status'), fallback: literal(0) }, { field: 'stacks' }),
    call('next', 'math.add', { left: out('old', 'value'), right: out('distance', 'distance') }),
    call('save-core', 'status.set-number-instance', { status: out('core-instance', 'status'), value: out('next', 'value') }, { field: 'stacks' }),
    call('save-momentum', 'attribute.set-momentum', { piece, value: out('next', 'value') }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('distance-text', 'text.from-number', { value: out('distance', 'distance') }),
    call('prefix', 'text.concat', { left: out('name', 'text'), right: literal('获得') }),
    call('gain-text', 'text.concat', { left: out('prefix', 'text'), right: out('distance-text', 'text') }),
    call('gain-text-2', 'text.concat', { left: out('gain-text', 'text'), right: literal('点动能（') }),
    call('next-text', 'text.from-number', { value: out('next', 'value') }),
    call('message', 'text.concat', { left: out('gain-text-2', 'text'), right: out('next-text', 'text') }),
    call('message-end', 'text.concat', { left: out('message', 'text'), right: literal('）') }),
  )
  body.push(success('success', out('message-end', 'text')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildMortisGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  sourceSamePrelude(body, piece)
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'))
  targetPrelude(body)
  body.push(call('not-self', 'compare.not-equal-piece', { left: piece, right: out('target', 'piece') }))
  requireCondition(body, 'require-not-self', out('not-self', 'value'))
  body.push(call('counter-id', 'status.find-id', { piece }, { statusType: 'mortis-damage-counter' }))
  body.push(call('counter-present', 'status.has-id', { piece, statusId: out('counter-id', 'id') }))
  body.push({
    kind: 'if', id: 'create-counter', condition: out('counter-present', 'value'), then: [], else: [
      call('piece-id', 'piece.identifier', { piece }),
      call('counter-record-id', 'text.concat', { left: literal('mortis-damage-counter-'), right: out('piece-id', 'id') }),
      {
        kind: 'record.create', id: 'counter-record', schema: 'counter-passive-status@1', fields: {
          id: out('counter-record-id', 'text'), type: literal('mortis-damage-counter'), name: literal('暗夜造物'), visible: literal(true),
          stacks: literal(0), intensity: literal(0), hitCount: literal(0), readyCharges: literal(0), currentDuration: literal(-1), currentUses: literal(-1),
        },
      },
      call('append-counter', 'status.append-record', { target: piece, record: out('counter-record', 'value') }),
    ],
  })
  body.push(
    call('counter-id-after', 'status.find-id', { piece }, { statusType: 'mortis-damage-counter' }),
    call('hits', 'status.read-record-number', { piece, statusId: out('counter-id-after', 'id'), fallback: literal(0) }, { field: 'hitCount' }),
    call('intensity-fallback', 'status.read-record-number', { piece, statusId: out('counter-id-after', 'id'), fallback: literal(0) }, { field: 'intensity' }),
    call('charges-raw', 'status.read-record-number', { piece, statusId: out('counter-id-after', 'id'), fallback: literal(0) }, { field: 'readyCharges' }),
    call('charges-present', 'compare.not-equal', { left: out('charges-raw', 'value'), right: literal(0) }),
    call('charges', 'value.select-number', { condition: out('charges-present', 'value'), whenTrue: out('charges-raw', 'value'), whenFalse: out('intensity-fallback', 'value') }),
    call('next-hits-total', 'math.add', { left: out('hits', 'value'), right: literal(1) }),
    call('hit-quarters', 'math.divide', { left: out('next-hits-total', 'value'), right: literal(3) }),
    call('unlocked', 'math.floor', { value: out('hit-quarters', 'value') }),
    call('remaining-hits', 'math.modulo', { left: out('next-hits-total', 'value'), right: literal(3) }),
    call('next-charges', 'math.add', { left: out('charges', 'value'), right: out('unlocked', 'value') }),
    call('save-hits', 'status.set-record-number', { piece, statusId: out('counter-id-after', 'id'), value: out('remaining-hits', 'value') }, { field: 'hitCount' }),
    call('save-ready', 'status.set-record-number', { piece, statusId: out('counter-id-after', 'id'), value: out('next-charges', 'value') }, { field: 'readyCharges' }),
    call('save-stacks', 'status.set-record-number', { piece, statusId: out('counter-id-after', 'id'), value: out('remaining-hits', 'value') }, { field: 'stacks' }),
    call('save-intensity', 'status.set-record-number', { piece, statusId: out('counter-id-after', 'id'), value: out('next-charges', 'value') }, { field: 'intensity' }),
    call('has-unlock', 'compare.greater-than', { left: out('unlocked', 'value'), right: literal(0) }),
  )
  body.push({
    kind: 'if', id: 'unlocked-branch', condition: out('has-unlock', 'value'), then: [
      call('add-skill', 'skill.add', { piece }, { skillId: 'mortis-bat-support' }),
      call('name', 'attribute.text', { piece }, { attribute: 'name' }),
      call('unlock-count', 'text.from-number', { value: out('unlocked', 'value') }),
      call('multiple', 'compare.greater-than', { left: out('unlocked', 'value'), right: literal(1) }),
      call('multiple-prefix', 'text.concat', { left: literal('×'), right: out('unlock-count', 'text') }),
      call('multiple-text', 'text.concat', { left: out('name', 'text'), right: literal('解锁蝙蝠增援') }),
      call('multiple-text-2', 'text.concat', { left: out('multiple-text', 'text'), right: out('multiple-prefix', 'text') }),
      call('message', 'value.select-text', { condition: out('multiple', 'value'), whenTrue: out('multiple-text-2', 'text'), whenFalse: out('multiple-text', 'text') }),
      success('unlocked-success', out('message', 'text')),
    ], else: [fail('not-unlocked')],
  })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildElPrimoGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  sourceSamePrelude(body, piece)
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'))
  body.push(
    call('owner', 'piece.owner', { piece }),
    call('old-total', 'state.read-player-number', { player: out('owner', 'player'), fallback: literal(0) }, { path: 'contentCounters' }),
    call('total', 'math.add', { left: out('old-total', 'value'), right: out('damage', 'value') }),
    call('quarters', 'math.divide', { left: out('total', 'value'), right: literal(4) }),
    call('discount', 'math.floor', { value: out('quarters', 'value') }),
    call('remainder', 'math.modulo', { left: out('total', 'value'), right: literal(4) }),
    call('old-discount', 'state.read-player-number', { player: out('owner', 'player'), fallback: literal(0) }, { path: 'contentCounters.elPrimoChargeDiscount' }),
    call('discount-plus', 'math.add', { left: out('old-discount', 'value'), right: out('discount', 'value') }),
    call('discount-capped', 'math.min', { left: literal(2), right: out('discount-plus', 'value') }),
    call('save-total', 'state.write-player-number', { player: out('owner', 'player'), value: out('remainder', 'value') }, { path: 'contentCounters' }),
    call('save-discount', 'state.write-player-number', { player: out('owner', 'player'), value: out('discount-capped', 'value') }, { path: 'contentCounters.elPrimoChargeDiscount' }),
    call('has-discount', 'compare.greater-than', { left: out('discount', 'value'), right: literal(0) }),
  )
  body.push({
    kind: 'if', id: 'discount-branch', condition: out('has-discount', 'value'), then: [
      call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('discount-text', 'text.from-number', { value: out('discount', 'value') }),
      call('prefix', 'text.concat', { left: out('name', 'text'), right: literal('受伤计数达到') }), call('text', 'text.concat', { left: out('prefix', 'text'), right: out('discount-text', 'text') }),
      call('message', 'text.concat', { left: out('text', 'text'), right: literal('层') }), success('discount-success', out('message', 'text')),
    ], else: [fail('no-discount')],
  })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildGrimmjowGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body, true)
  body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }))
  requireCondition(body, 'require-alive', out('alive', 'value'), failWithoutMessage('require-alive-return'))
  sourceSamePrelude(body, piece, true)
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'), failWithoutMessage('require-damage-return'))
  body.push(call('skill-id', 'event.skill-id'), call('self-skill', 'compare.text', { left: out('skill-id', 'value'), right: literal('grimmjow-destruction-instinct') }), call('other-skill', 'logic.not', { value: out('self-skill', 'value') }))
  requireCondition(body, 'require-other-skill', out('other-skill', 'value'), failWithoutMessage('require-other-skill-return'))
  body.push(call('queue', 'effect.queue-damage', { attacker: piece, target: piece, amount: literal(1) }, { damageType: 'true', skillId: 'grimmjow-destruction-instinct' }), success('success'))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: noMessageOutputs, body }
}

function buildUlquiorraGraph(taken: boolean): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  sourceSamePrelude(body, piece)
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'))
  if (taken) {
    body.push(call('target-ref', 'ref.target'), call('target-present', 'piece.reference-present', { piece: out('target-ref', 'piece') }), {
      kind: 'if', id: 'target-self-check', condition: out('target-present', 'value'), then: [
        call('same-target', 'compare.equal-piece-nullable', { left: piece, right: out('target-ref', 'piece') }),
        { kind: 'if', id: 'target-is-self', condition: out('same-target', 'value'), then: [fail('target-is-self-return')] },
      ],
    })
  }
  body.push(call('piece-id', 'piece.identifier', { piece }), call('resurrection-id', 'text.concat', { left: literal('ulquiorra-resurreccion-'), right: out('piece-id', 'id') }), call('transformed', 'status.has-id', { piece, statusId: out('resurrection-id', 'text') }), call('not-transformed', 'logic.not', { value: out('transformed', 'value') }))
  body.push({
    kind: 'if', id: 'progress-branch', condition: out('not-transformed', 'value'), then: [
      call('progress-id', 'status.find-id', { piece }, { statusType: 'ulquiorra-resurreccion-progress' }),
      call('progress-missing', 'compare.text', { left: out('progress-id', 'id'), right: literal(null) }),
      {
        kind: 'if', id: 'create-progress', condition: out('progress-missing', 'value'), then: [
          call('progress-record-id', 'text.concat', { left: literal('ulquiorra-resurreccion-progress-'), right: out('piece-id', 'id') }),
          { kind: 'record.create', id: 'progress-record', schema: 'counter-passive-status@1', fields: { id: out('progress-record-id', 'text'), type: literal('ulquiorra-resurreccion-progress'), name: literal('归刃进度'), visible: literal(true), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(0), stacks: literal(0) } },
          call('append-progress', 'status.append-record', { target: piece, record: out('progress-record', 'value') }),
        ],
      },
      call('progress-id-after', 'status.find-id', { piece }, { statusType: 'ulquiorra-resurreccion-progress' }),
      call('progress', 'status.read-number', { piece, statusId: out('progress-id-after', 'id'), fallback: literal(0) }, { field: 'intensity' }),
      call('progress-plus', 'math.add', { left: out('progress', 'value'), right: literal(1) }),
      call('next-progress', 'math.min', { left: literal(3), right: out('progress-plus', 'value') }),
      call('save-intensity', 'status.set-number', { piece, statusId: out('progress-id-after', 'id'), value: out('next-progress', 'value') }, { field: 'intensity' }),
      call('save-stacks', 'status.set-number', { piece, statusId: out('progress-id-after', 'id'), value: out('next-progress', 'value') }, { field: 'stacks' }),
    ],
  })
  body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }), {
    kind: 'if', id: 'heal-branch', condition: out('alive', 'value'), then: [call('heal', 'effect.queue-heal', { healer: piece, target: piece, amount: literal(1) }, { skillId: 'ulquiorra-high-speed-regeneration' })],
  }, call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('message', 'text.concat', { left: out('name', 'text'), right: literal('触发超速再生') }), success('success', out('message', 'text')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildAkazaMarkGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  sourceSamePrelude(body, piece)
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'))
  const target = targetPrelude(body)
  body.push(call('not-self', 'compare.not-equal-piece', { left: piece, right: target }))
  requireCondition(body, 'require-not-self', out('not-self', 'value'))
  body.push(call('enemies', 'query.pieces', { originId: piece }, { relation: 'enemy', includeDead: true }), call('enemy', 'collection.contains-piece', { items: out('enemies', 'pieces'), value: target }))
  requireCondition(body, 'require-enemy', out('enemy', 'contains'))
  body.push(call('piece-id', 'piece.identifier', { piece }), call('marker-id', 'text.concat', { left: literal('akaza-damaged-by:'), right: out('piece-id', 'id') }), call('turn', 'turn.number'), call('has-marker', 'status.has-id', { piece: target, statusId: out('marker-id', 'text') }))
  body.push({
    kind: 'if', id: 'marker-branch', condition: out('has-marker', 'value'), then: [
      call('set-type', 'status.set-record-text', { piece: target, statusId: out('marker-id', 'text'), value: literal('akaza-damaged') }, { field: 'type' }),
      call('set-source', 'status.set-record-text', { piece: target, statusId: out('marker-id', 'text'), value: out('piece-id', 'id') }, { field: 'sourceId' }),
      call('set-visible', 'status.set-record-boolean', { piece: target, statusId: out('marker-id', 'text'), value: literal(false) }, { field: 'visible' }),
      call('set-current-duration', 'status.set-record-number', { piece: target, statusId: out('marker-id', 'text'), value: literal(-1) }, { field: 'currentDuration' }),
      call('set-remaining-duration', 'status.set-record-number', { piece: target, statusId: out('marker-id', 'text'), value: literal(-1) }, { field: 'remainingDuration' }),
      call('set-expires', 'status.clear-record-field', { piece: target, statusId: out('marker-id', 'text') }, { field: 'expiresAfterTurn' }),
      call('set-turn', 'status.set-record-number', { piece: target, statusId: out('marker-id', 'text'), value: out('turn', 'value') }, { field: 'lastDamageTurn' }),
    ], else: [
      { kind: 'record.create', id: 'marker-record', schema: 'counter-passive-status@1', fields: { id: out('marker-id', 'text'), type: literal('akaza-damaged'), sourceId: out('piece-id', 'id'), visible: literal(false), stacking: literal('independent'), currentDuration: literal(-1), remainingDuration: literal(-1), currentUses: literal(-1), lastDamageTurn: out('turn', 'value') } },
      call('apply-marker', 'status.apply-record', { target, record: out('marker-record', 'value') }, { inputPolicy: 'host' }),
    ],
  })
  body.push(success('success', literal('')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildAkazaFightingSpiritGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  const target = targetPrelude(body)
  body.push(call('target-is-holder', 'compare.equal-piece', { left: piece, right: target }))
  requireCondition(body, 'require-holder-target', out('target-is-holder', 'value'))
  body.push(call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
  requireCondition(body, 'require-victim', out('source-exists', 'exists'))
  body.push(call('victim', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('victim-hp', 'attribute.read', { piece: out('victim', 'piece') }, { attribute: 'currentHp' }), call('victim-max-hp', 'attribute.read', { piece: out('victim', 'piece') }, { attribute: 'maxHp' }), call('full', 'compare.equal', { left: out('victim-hp', 'value'), right: out('victim-max-hp', 'value') }))
  requireCondition(body, 'require-full', out('full', 'value'))
  body.push(call('enemies', 'query.pieces', { originId: piece }, { relation: 'enemy' }), call('enemy', 'collection.contains-piece', { items: out('enemies', 'pieces'), value: out('victim', 'piece') }))
  requireCondition(body, 'require-enemy', out('enemy', 'contains'))
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'))
  body.push(call('scaled', 'math.multiply', { left: out('damage', 'value'), right: literal(1.5) }), call('write-damage', 'event.write-number', { value: out('scaled', 'value') }, { field: 'damage', inputPolicy: 'host' }), call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('message', 'text.concat', { left: out('name', 'text'), right: literal('触发先手斗气，伤害提高50%') }), success('success', out('message', 'text')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildObitoGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  body.push(call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
  requireCondition(body, 'require-source', out('source-exists', 'exists'))
  body.push(call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('allies', 'query.pieces', { originId: piece }, { relation: 'ally', includeDead: true }), call('ally', 'collection.contains-piece', { items: out('allies', 'pieces'), value: out('source', 'piece') }))
  requireCondition(body, 'require-ally', out('ally', 'contains'))
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'))
  body.push(call('grudge-id', 'status.find-id', { piece }, { statusType: 'obito-grudge' }), call('has-grudge', 'status.has-id', { piece, statusId: out('grudge-id', 'id') }))
  body.push({
    kind: 'if', id: 'create-grudge', condition: out('has-grudge', 'value'), then: [], else: [
      call('piece-id', 'piece.identifier', { piece }),
      call('grudge-record-id', 'text.concat', { left: literal('obito-grudge-'), right: out('piece-id', 'id') }),
      { kind: 'record.create', id: 'grudge-record', schema: 'counter-passive-status@1', fields: { id: out('grudge-record-id', 'text'), type: literal('obito-grudge'), name: literal('怨念'), stacks: literal(0), intensity: literal(0) } },
      call('append-grudge', 'status.append-record', { target: piece, record: out('grudge-record', 'value') }),
    ],
  })
  body.push(call('grudge-id-after', 'status.find-id', { piece }, { statusType: 'obito-grudge' }), call('stacks', 'status.read-record-number', { piece, statusId: out('grudge-id-after', 'id'), fallback: literal(0) }, { field: 'stacks' }), call('at-cap', 'compare.greater-or-equal', { left: out('stacks', 'value'), right: literal(3) }))
  body.push({ kind: 'if', id: 'cap-check', condition: out('at-cap', 'value'), then: [fail('cap-return', '怨念已达上限（3层）')], else: [
    call('next-stacks', 'math.add', { left: out('stacks', 'value'), right: literal(1) }),
    call('intensity', 'status.read-record-number', { piece, statusId: out('grudge-id-after', 'id'), fallback: literal(0) }, { field: 'intensity' }),
    call('next-intensity', 'math.add', { left: out('intensity', 'value'), right: literal(2) }),
    call('save-stacks', 'status.set-record-number', { piece, statusId: out('grudge-id-after', 'id'), value: out('next-stacks', 'value') }, { field: 'stacks' }),
    call('save-intensity', 'status.set-record-number', { piece, statusId: out('grudge-id-after', 'id'), value: out('next-intensity', 'value') }, { field: 'intensity' }),
    call('attack', 'attribute.adjust', { piece, amount: literal(2) }, { attribute: 'attack' }),
    call('self-source', 'compare.equal-piece', { left: piece, right: out('source', 'piece') }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('source-text', 'value.select-text', { condition: out('self-source', 'value'), whenTrue: literal('自身'), whenFalse: out('source-name', 'text') }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('name-prefix', 'text.concat', { left: out('name', 'text'), right: literal('的怨念因') }),
    call('source-prefix', 'text.concat', { left: out('name-prefix', 'text'), right: out('source-text', 'text') }),
    call('prefix', 'text.concat', { left: out('source-prefix', 'text'), right: literal('受伤而积蓄（第') }),
    call('stack-text', 'text.from-number', { value: out('next-stacks', 'value') }),
    call('body-text', 'text.concat', { left: out('prefix', 'text'), right: out('stack-text', 'text') }),
    call('body-text-2', 'text.concat', { left: out('body-text', 'text'), right: literal('层），攻击力+2，现为') }),
    call('attack-text', 'text.from-number', { value: out('attack', 'value') }),
    call('message', 'text.concat', { left: out('body-text-2', 'text'), right: out('attack-text', 'text') }),
    success('grudge-success', out('message', 'text')),
  ] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildShishioKillGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  sourceSamePrelude(body, piece)
  const target = targetPrelude(body)
  body.push(call('kill-id', 'status.find-id', { piece }, { statusType: 'shishio-kills' }), call('has-kills', 'status.has-id', { piece, statusId: out('kill-id', 'id') }))
  body.push({ kind: 'if', id: 'create-kills', condition: out('has-kills', 'value'), then: [], else: [
    call('piece-id', 'piece.identifier', { piece }),
    call('kills-record-id', 'text.concat', { left: literal('shishio-kills-'), right: out('piece-id', 'id') }),
    { kind: 'record.create', id: 'kills-record', schema: 'counter-passive-status@1', fields: { id: out('kills-record-id', 'text'), type: literal('shishio-kills'), name: literal('击杀数'), intensity: literal(0), currentDuration: literal(-1) } },
    call('append-kills', 'status.append-record', { target: piece, record: out('kills-record', 'value') }),
  ] })
  body.push(call('kill-id-after', 'status.find-id', { piece }, { statusType: 'shishio-kills' }), call('kills', 'status.read-record-number', { piece, statusId: out('kill-id-after', 'id'), fallback: literal(0) }, { field: 'intensity' }), call('next-kills', 'math.add', { left: out('kills', 'value'), right: literal(1) }), call('save-kills', 'status.set-record-number', { piece, statusId: out('kill-id-after', 'id'), value: out('next-kills', 'value') }, { field: 'intensity' }), call('two-or-more', 'compare.greater-or-equal', { left: out('next-kills', 'value'), right: literal(2) }), call('multiplier', 'value.select-text', { condition: out('two-or-more', 'value'), whenTrue: literal('200%'), whenFalse: literal('150%') }), call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('target-name', 'piece.name-by-id', { piece: target, fallback: literal('目标') }), call('prefix', 'text.concat', { left: out('name', 'text'), right: literal(' 击杀 ') }), call('prefix-2', 'text.concat', { left: out('prefix', 'text'), right: out('target-name', 'text') }), call('prefix-3', 'text.concat', { left: out('prefix-2', 'text'), right: literal('！击杀数：') }), call('kills-text', 'text.from-number', { value: out('next-kills', 'value') }), call('prefix-4', 'text.concat', { left: out('prefix-3', 'text'), right: out('kills-text', 'text') }), call('prefix-5', 'text.concat', { left: out('prefix-4', 'text'), right: literal('，无限刃/炎灵升至 ') }), call('message', 'text.concat', { left: out('prefix-5', 'text'), right: out('multiplier', 'text') }), success('success', out('message', 'text')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildShishioCooldownGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  sourceSamePrelude(body, piece)
  body.push(call('target-ref', 'ref.target'), call('target-present', 'piece.reference-present', { piece: out('target-ref', 'piece') }))
  requireCondition(body, 'require-target', out('target-present', 'value'))
  body.push(call('same-target', 'compare.equal-piece-nullable', { left: piece, right: out('target-ref', 'piece') }), call('not-self', 'logic.not', { value: out('same-target', 'value') }))
  requireCondition(body, 'require-not-self', out('not-self', 'value'))
  body.push(call('target', 'query.piece', { pieceId: out('target-ref', 'piece') }))
  body.push(call('turn', 'turn.number'), call('fired-id', 'status.find-id', { piece }, { statusType: 'shishio-cooldown-fired' }), call('has-fired', 'status.has-id', { piece, statusId: out('fired-id', 'id') }), call('fired-turn', 'status.read-record-number', { piece, statusId: out('fired-id', 'id'), fallback: literal(-1) }, { field: 'intensity' }), call('same-turn', 'compare.equal', { left: out('fired-turn', 'value'), right: out('turn', 'value') }))
  body.push({ kind: 'if', id: 'already-fired', condition: out('same-turn', 'value'), then: [fail('already-fired-return')], else: [
    { kind: 'if', id: 'create-fired', condition: out('has-fired', 'value'), then: [call('save-fired', 'status.set-record-number', { piece, statusId: out('fired-id', 'id'), value: out('turn', 'value') }, { field: 'intensity' })], else: [
      call('piece-id', 'piece.identifier', { piece }),
      call('fired-record-id', 'text.concat', { left: literal('shishio-cooldown-fired-'), right: out('piece-id', 'id') }),
      { kind: 'record.create', id: 'fired-record', schema: 'counter-passive-status@1', fields: { id: out('fired-record-id', 'text'), type: literal('shishio-cooldown-fired'), name: literal('压制已触发'), intensity: out('turn', 'value'), currentDuration: literal(-1), visible: literal(false) } },
      call('append-fired', 'status.append-record', { target: piece, record: out('fired-record', 'value') }),
    ] },
    call('target-has-piece', 'query.has-piece', { pieceId: out('target-ref', 'piece') }),
    { kind: 'if', id: 'target-alive-check', condition: out('target-has-piece', 'exists'), then: [
      call('target-hp', 'attribute.read', { piece: out('target', 'piece') }, { attribute: 'currentHp' }),
      call('target-alive', 'compare.greater-than', { left: out('target-hp', 'value'), right: literal(0) }),
      { kind: 'if', id: 'target-valid', condition: out('target-alive', 'value'), then: [
        call('adjust', 'skill.adjust-all-cooldowns', { piece: out('target', 'piece'), amount: literal(1) }, { mode: 'atLeast' }),
        { kind: 'if', id: 'adjusted', condition: out('adjust', 'success'), then: [
          call('holder-name', 'attribute.text', { piece }, { attribute: 'name' }),
          call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
          call('prefix', 'text.concat', { left: out('holder-name', 'text'), right: literal(' 自燃·压制：') }),
          call('prefix-2', 'text.concat', { left: out('prefix', 'text'), right: out('target-name', 'text') }),
          call('message', 'text.concat', { left: out('prefix-2', 'text'), right: literal(' 所有技能进入至少1回合冷却！') }),
          success('success', out('message', 'text')),
        ], else: [fail('no-skills')] },
      ], else: [fail('dead-target')] },
    ], else: [fail('missing-target')] },
  ] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildMuzanDamageGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holderPrelude(body)
  body.push(call('source-ref', 'ref.source'), call('source-same', 'compare.equal-piece-nullable', { left: piece, right: out('source-ref', 'piece') }))
  requireCondition(body, 'require-source-same', out('source-same', 'value'))
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'require-damage', out('positive', 'value'))
  body.push(call('turn', 'event.battle-turn-number'), call('turn-valid', 'value.is-finite', { value: out('turn', 'value') }))
  requireCondition(body, 'require-turn', out('turn-valid', 'value'))
  body.push(call('save-last-damage', 'state.write-piece-number', { piece, value: out('turn', 'value') }, { namespace: 'muzan-flesh-regeneration', name: 'lastDamageTurn' }), success('success', literal('')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildMuzanEndGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  body.push(call('holder-ref', 'ref.holder'), call('holder-exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  requireCondition(body, 'require-holder', out('holder-exists', 'exists'))
  body.push(call('piece', 'query.piece', { pieceId: out('holder-ref', 'piece') }), call('turn', 'event.battle-turn-number'), call('turn-valid', 'value.is-finite', { value: out('turn', 'value') }))
  requireCondition(body, 'require-turn', out('turn-valid', 'value'))
  body.push(call('last-check', 'state.read-piece-number', { piece: out('piece', 'piece'), fallback: literal(-1) }, { namespace: 'muzan-flesh-regeneration', name: 'lastCheckTurn' }), call('checked-this-turn', 'compare.equal', { left: out('last-check', 'value'), right: out('turn', 'value') }))
  body.push({ kind: 'if', id: 'already-checked', condition: out('checked-this-turn', 'value'), then: [fail('already-checked-return')] })
  body.push(call('save-check', 'state.write-piece-number', { piece: out('piece', 'piece'), value: out('turn', 'value') }, { namespace: 'muzan-flesh-regeneration', name: 'lastCheckTurn' }))
  body.push(call('hp', 'attribute.read', { piece: out('piece', 'piece') }, { attribute: 'currentHp' }), call('max-hp', 'attribute.read', { piece: out('piece', 'piece') }, { attribute: 'maxHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }), call('not-full', 'compare.less-than', { left: out('hp', 'value'), right: out('max-hp', 'value') }), call('eligible', 'logic.and', { left: out('alive', 'value'), right: out('not-full', 'value') }))
  requireCondition(body, 'require-eligible', out('eligible', 'value'))
  body.push(call('last-damage', 'state.read-piece-number', { piece: out('piece', 'piece'), fallback: literal(-1) }, { namespace: 'muzan-flesh-regeneration', name: 'lastDamageTurn' }), call('damaged-state', 'compare.equal', { left: out('last-damage', 'value'), right: out('turn', 'value') }), call('actions', 'event.actions'))
  body.push({
    kind: 'collection', id: 'damage-history', method: 'reduce', items: out('actions', 'actions'), item: 'action', index: 'index', accumulator: 'matched', initial: literal(false), inputs: { currentTurn: out('turn', 'value'), target: out('piece', 'piece') }, body: [
      call('action-type', 'event.action-text', { action: local('action'), fallback: literal('') }, { field: 'type' }),
      call('is-damage', 'compare.equal-string', { left: out('action-type', 'value'), right: literal('damage') }),
      call('action-turn', 'event.action-number', { action: local('action'), fallback: literal(-1) }, { field: 'turn' }),
      call('same-turn', 'compare.equal', { left: out('action-turn', 'value'), right: local('currentTurn') }),
      call('action-target', 'event.action-piece', { action: local('action'), fallback: literal(null) }, { field: 'payload.targetId' }),
      call('same-target', 'compare.equal-piece-nullable', { left: out('action-target', 'value'), right: local('target') }),
      call('final-damage', 'event.action-number', { action: local('action'), fallback: literal(0) }, { field: 'payload.finalDamage' }),
      call('positive-damage', 'compare.greater-than', { left: out('final-damage', 'value'), right: literal(0) }),
      call('type-and-turn', 'logic.and', { left: out('is-damage', 'value'), right: out('same-turn', 'value') }),
      call('target-and-damage', 'logic.and', { left: out('same-target', 'value'), right: out('positive-damage', 'value') }),
      call('matched-now', 'logic.and', { left: out('type-and-turn', 'value'), right: out('target-and-damage', 'value') }),
      call('matched', 'logic.or', { left: local('matched'), right: out('matched-now', 'value') }),
      { kind: 'return', id: 'history-return', value: out('matched', 'value') },
    ],
  })
  body.push(
    call('damaged-history', 'logic.or', { left: out('damaged-state', 'value'), right: out('damage-history', 'value') }),
    call('not-damaged', 'logic.not', { value: out('damaged-history', 'value') }),
  )
  requireCondition(body, 'require-no-damage', out('not-damaged', 'value'))
  body.push(
    call('successful-heals', 'state.read-piece-number', { piece: out('piece', 'piece'), fallback: literal(0) }, { namespace: 'muzan-flesh-regeneration', name: 'successfulHeals' }),
    call('heal-cap', 'compare.greater-or-equal', { left: out('successful-heals', 'value'), right: literal(3) }),
    call('can-heal', 'logic.not', { value: out('heal-cap', 'value') }),
  )
  requireCondition(body, 'require-heal-cap', out('can-heal', 'value'))
  body.push(call('heal', 'effect.heal', { source: out('piece', 'piece'), target: out('piece', 'piece'), amount: literal(2) }, { skillId: 'muzan-flesh-regeneration' }), call('positive-heal', 'compare.greater-than', { left: out('heal', 'heal'), right: literal(0) }), call('heal-success', 'logic.and', { left: out('heal', 'success'), right: out('positive-heal', 'value') }))
  body.push({ kind: 'if', id: 'heal-branch', condition: out('heal-success', 'value'), then: [
    call('next-heals', 'math.add', { left: out('successful-heals', 'value'), right: literal(1) }),
    call('save-heals', 'state.write-piece-number', { piece: out('piece', 'piece'), value: out('next-heals', 'value') }, { namespace: 'muzan-flesh-regeneration', name: 'successfulHeals' }),
    call('piece-name', 'attribute.text', { piece: out('piece', 'piece') }, { attribute: 'name' }),
    call('heal-text', 'text.from-number', { value: out('heal', 'heal') }),
    call('message-prefix', 'text.concat', { left: out('piece-name', 'text'), right: literal('触发血肉再生，恢复') }),
    call('message-body', 'text.concat', { left: out('message-prefix', 'text'), right: out('heal-text', 'text') }),
    call('message', 'text.concat', { left: out('message-body', 'text'), right: literal('点生命') }),
    success('heal-success-return', out('message', 'text')),
  ], else: [fail('heal-failed')] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

export function buildCounterPassiveGraph(id: string): GameplayModuleGraph {
  switch (id) {
    case 'rule-momentum-gain': return buildMomentumGraph()
    case 'rule-mortis-damage-counter': return buildMortisGraph()
    case 'rule-el-primo-injury-counter': return buildElPrimoGraph()
    case 'rule-grimmjow-destruction-instinct': return buildGrimmjowGraph()
    case 'rule-ulquiorra-damage-dealt': return buildUlquiorraGraph(false)
    case 'rule-ulquiorra-damage-taken': return buildUlquiorraGraph(true)
    case 'rule-akaza-damage-mark': return buildAkazaMarkGraph()
    case 'rule-akaza-fighting-spirit': return buildAkazaFightingSpiritGraph()
    case 'rule-obito-grudge': return buildObitoGraph()
    case 'rule-shishio-kill-track': return buildShishioKillGraph()
    case 'rule-shishio-cooldown-once': return buildShishioCooldownGraph()
    case 'rule-muzan-regeneration-damage': return buildMuzanDamageGraph()
    case 'rule-muzan-regeneration-end': return buildMuzanEndGraph()
    default: throw new Error('Unknown counter/passive rule ' + id)
  }
}

export type CounterPassivePreflight = {
  pending: { id: string; file: string; next: Record<string, unknown> }[]
  preserved: { id: string; message: string }[]
  failures: { id: string; message: string }[]
}

export function preflightCounterPassives(root: string): CounterPassivePreflight {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: CounterPassivePreflight['pending'] = []
  const preserved: CounterPassivePreflight['preserved'] = []
  const failures: CounterPassivePreflight['failures'] = []
  for (const id of COUNTER_PASSIVE_RULE_IDS) {
    try {
      const file = path.join(root, 'data/rules', id + '.json')
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (current.gameplayModules?.entries?.skillCode) {
        assertGameplayModuleDocument(current)
        continue
      }
      const original = baseline['rules/' + id]
      if (current.contentGraph) {
        // A byte-verified historical importer artifact is migration input,
        // not an authored semantic graph to preserve instead of migrating.
        assertCounterPassiveAuthorGraph(current, original, id)
      } else assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
      for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
        if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
      }
      pending.push({ id, file, next: applyGameplayModuleGraph(current, buildCounterPassiveGraph(id), 'skillCode') })
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { pending, preserved, failures }
}

export function migrateCounterPassives(root: string, write = false, allowPartial = false): string[] {
  const report = preflightCounterPassives(root)
  if (report.failures.length && !allowPartial) {
    throw new Error(`counter/passive migration preflight failed:\n${report.failures.map(failure => `- ${failure.message}`).join('\n')}`)
  }
  if (write) for (const { file, next } of report.pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return report.pending.map(item => path.basename(item.file, '.json'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const allowPartial = process.argv.includes('--write-ready')
  const report = preflightCounterPassives(process.cwd())
  if (report.failures.length && !allowPartial) throw new Error(`counter/passive migration preflight failed:\n${report.failures.map(failure => `- ${failure.message}`).join('\n')}`)
  if (process.argv.includes('--write')) for (const { file, next } of report.pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  console.log(JSON.stringify({ migrated: report.pending.map(item => path.basename(item.file, '.json')), preserved: [...report.preserved, ...report.failures] }))
}

