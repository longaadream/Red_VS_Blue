import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildTemporalDistortionGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('choice', 'choice.target-piece', {}, { range: 5, filter: 'enemy' }), c('unresolved', 'choice.is-unresolved', { choice: o('choice', 'choice') }),
    { kind: 'if', id: 'selection-check', condition: o('unresolved'), then: [c('pending', 'choice.as-result', { choice: o('choice', 'choice') }), { kind: 'return', id: 'waiting', value: o('pending', 'result') }] },
    c('target', 'choice.piece', { choice: o('choice', 'choice') }),
    c('attack', 'attribute.read', { piece: o('target', 'piece') }, { attribute: 'attack' }),
    c('positive', 'compare.greater-than', { left: o('attack'), right: l(0) }),
    c('stolen', 'value.select-number', { condition: o('positive'), whenTrue: o('attack'), whenFalse: l(0) }),
    c('remaining', 'math.subtract', { left: o('attack'), right: o('stolen') }),
    c('deduct', 'attribute.set', { piece: o('target', 'piece'), value: o('remaining') }, { attribute: 'attack' }),
    c('credit', 'attribute.adjust', { piece: o('source', 'piece'), amount: o('stolen') }, { attribute: 'attack' }),
    c('owner', 'piece.owner', { piece: o('target', 'piece') }),
    c('source-id', 'piece.identifier', { piece: o('source', 'piece') }), c('target-id', 'piece.identifier', { piece: o('target', 'piece') }),
    c('time', 'identity.host-time'), c('time-text', 'text.from-number', { value: o('time') }),
  ]
  const join = (prefix: string, parts: GameplayValue[]): GameplayValue => {
    let text: GameplayValue = l('')
    parts.forEach((part, index) => { body.push(c(prefix + index, 'text.concat', { left: text, right: part })); text = o(prefix + index, 'text') })
    return text
  }
  const id = join('id-', [l('rafaam-temporal-distortion-'), o('source-id', 'id'), l('-'), o('target-id', 'id'), l('-'), o('time-text', 'text')])
  body.push({ kind: 'record.create', id: 'status', schema: 'temporal-record@1', fields: {
    id, name: l('时空扭曲'), type: l('rafaam-temporal-distortion'), currentDuration: l(-1), currentUses: l(-1), intensity: o('stolen'), sourceId: o('source-id', 'id'), targetId: o('target-id', 'id'),
  } }, c('apply-status', 'status.apply-player-record', { player: o('owner', 'player'), record: o('status') }),
  c('apply-rule', 'rule.apply-player', { target: o('owner', 'player') }, { ruleId: 'rule-rafaam-temporal-distortion' }),
  c('source-name', 'attribute.text', { piece: o('source', 'piece') }, { attribute: 'name' }),
  c('target-name', 'attribute.text', { piece: o('target', 'piece') }, { attribute: 'name' }),
  c('amount-text', 'text.from-number', { value: o('stolen') }))
  const message = join('message-', [o('source-name', 'text'), l('从'), o('target-name', 'text'), l('偷取'), o('amount-text', 'text'), l('点攻击力，将在对方下回合结束时归还')])
  body.push(c('result', 'result.action', { success: l(true), message }), { kind: 'return', id: 'done', value: o('result', 'result') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [{ id: 'temporal-record', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'type', type: 'string' },
    { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' }, { name: 'intensity', type: 'number' },
    { name: 'sourceId', type: 'string' }, { name: 'targetId', type: 'string' },
  ] }], outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function buildTemporalRepaymentGraph(): GameplayModuleGraph {
  const input = (name: string): GameplayValue => ({ kind: 'input', name })
  const fail = (id: string): GameplayStatement => ({ kind: 'return', id, values: { success: l(false), message: l('') } })
  const body: GameplayStatement[] = [
    c('player', 'ref.event-player'), c('turn-player', 'turn.current-player'),
    c('own-turn', 'compare.player-reference', { left: o('player', 'player'), right: o('turn-player', 'player') }),
    { kind: 'if', id: 'turn-check', condition: o('own-turn'), then: [], else: [fail('wrong-turn')] },
    c('records', 'status.player-transfer-records', { player: o('player', 'player') }, { statusType: 'rafaam-temporal-distortion' }),
    { kind: 'if', id: 'player-check', condition: o('records', 'exists'), then: [], else: [fail('missing-player-status')] },
    c('valid-player', 'player.require', { player: o('player', 'player') }),
    c('has-records', 'compare.greater-than', { left: o('records', 'count'), right: l(0) }),
    { kind: 'if', id: 'records-check', condition: o('has-records'), then: [], else: [c('remove-empty-rule', 'rule.remove-player', { target: o('valid-player', 'player') }, { ruleId: 'rule-rafaam-temporal-distortion' }), fail('no-records')] },
    { kind: 'foreach', id: 'return-records', items: o('records', 'records'), item: 'record', body: [
      { kind: 'record.get', id: 'raw-amount', record: input('record'), field: 'intensity' },
      c('positive', 'compare.greater-than', { left: o('raw-amount'), right: l(0) }),
      c('amount', 'value.select-number', { condition: o('positive'), whenTrue: o('raw-amount'), whenFalse: l(0) }),
      { kind: 'record.get', id: 'target-id', record: input('record'), field: 'targetId' },
      { kind: 'record.get', id: 'source-id', record: input('record'), field: 'sourceId' },
      c('target-attack', 'attribute.read-stored', { id: o('target-id') }, { attribute: 'attack' }),
      c('target-next', 'math.add', { left: o('target-attack'), right: o('amount') }),
      c('target-set', 'attribute.set-stored', { id: o('target-id'), value: o('target-next') }, { attribute: 'attack' }),
      c('source-attack', 'attribute.read-stored', { id: o('source-id') }, { attribute: 'attack' }),
      c('source-deducted', 'math.subtract', { left: o('source-attack'), right: o('amount') }),
      c('source-positive', 'compare.greater-than', { left: o('source-deducted'), right: l(0) }),
      c('source-next', 'value.select-number', { condition: o('source-positive'), whenTrue: o('source-deducted'), whenFalse: l(0) }),
      c('source-set', 'attribute.set-stored', { id: o('source-id'), value: o('source-next') }, { attribute: 'attack' }),
    ] },
    { kind: 'collection.reduce', id: 'total-returned', items: o('records', 'records'), item: 'record', accumulator: 'total', initial: l(0), body: [
      { kind: 'record.get', id: 'sum-raw-amount', record: input('record'), field: 'intensity' },
      c('sum-positive', 'compare.greater-than', { left: o('sum-raw-amount'), right: l(0) }),
      c('sum-amount', 'value.select-number', { condition: o('sum-positive'), whenTrue: o('sum-raw-amount'), whenFalse: l(0) }),
      c('sum', 'math.add', { left: input('total'), right: o('sum-amount') }),
      { kind: 'return', id: 'sum-result', value: o('sum') },
    ] },
    c('remove-status', 'status.remove-player-records', { player: o('valid-player', 'player') }, { statusType: 'rafaam-temporal-distortion' }),
    c('remove-rule', 'rule.remove-player', { target: o('valid-player', 'player') }, { ruleId: 'rule-rafaam-temporal-distortion' }),
    c('amount-text', 'text.from-number', { value: o('total-returned') }),
    c('message-start', 'text.concat', { left: l('时空扭曲归还了'), right: o('amount-text', 'text') }),
    c('message', 'text.concat', { left: o('message-start', 'text'), right: l('点攻击力') }),
    { kind: 'return', id: 'done', values: { success: l(true), message: o('message', 'text') } },
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], schemas: [{ id: 'attribute-transfer', version: '1', fields: [
    { name: 'intensity', type: 'number' }, { name: 'sourceId', type: 'string', nullable: true }, { name: 'targetId', type: 'string', nullable: true },
  ] }], body }
}

export function migrateTemporalRepayment(root: string, write = false): void {
  const file = path.join(root, 'data/rules/rule-rafaam-temporal-distortion.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['rules/rule-rafaam-temporal-distortion']
  assertFrozenExecutable(current, original, 'skillCode', 'rule', 'rule-rafaam-temporal-distortion')
  const next = applyGameplayModuleGraph(current, buildTemporalRepaymentGraph(), 'skillCode')
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}

export function migrateTemporalDistortion(root: string, write = false): void {
  const file = path.join(root, 'data/skills/rafaam-temporal-distortion.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/rafaam-temporal-distortion']
  assertFrozenExecutable(current, original, 'code', 'skill', 'rafaam-temporal-distortion')
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`rafaam-temporal-distortion: changed compatibility field ${key}`)
  const next = applyGameplayModuleGraph(current, buildTemporalDistortionGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  migrateTemporalDistortion(process.cwd(), false)
  migrateTemporalRepayment(process.cwd(), false)
  if (process.argv.includes('--write')) {
    migrateTemporalDistortion(process.cwd(), true)
    migrateTemporalRepayment(process.cwd(), true)
  }
}
