import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { migrateAtomicAuthorGraph } from './migrate-atomic-author-modules'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const AMATERASU_SKILL_IDS = ['sasuke-amaterasu', 'sasuke-kagutsuchi', 'itachi-amaterasu'] as const
export const AMATERASU_RULE_IDS = [
  'rule-sasuke-amaterasu-damage',
  'rule-sasuke-amaterasu-endturn',
  'rule-sasuke-amaterasu-move',
  'rule-sasuke-amaterasu-stack',
] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const ruleResult = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement => ({ kind: 'return', id, values: { success, message } })
const result = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] => [call(id, 'result.action', { success, message }), { kind: 'return', id: id + '-return', value: out(id, 'result') }]

const burnSchema: GameplayRecordSchema = {
  id: 'amaterasu-burn@1',
  version: '1',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' },
    { name: 'stacks', type: 'number' },
    { name: 'sourcePieceId', type: 'string', nullable: true, optional: true },
    { name: 'ownerPlayerId', type: 'player', nullable: true, optional: true },
  ],
}

function cellSelection(body: GameplayStatement[], range: number): void {
  body.push(
    call('choice', 'choice.target-cell', {}, { range, filter: 'all' }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'return-selection', condition: out('unresolved', 'value'), then: [call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }), { kind: 'return', id: 'return-selection-result', value: out('selection-result', 'result') }] },
    call('target', 'choice.cell', { choice: out('choice', 'choice') }),
  )
}

function pieceSelection(body: GameplayStatement[], range: number, filter: 'all' | 'enemy' | 'ally'): void {
  body.push(
    call('choice', 'choice.target-piece', {}, { range, filter }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'return-selection', condition: out('unresolved', 'value'), then: [call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }), { kind: 'return', id: 'return-selection-result', value: out('selection-result', 'result') }] },
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
  )
}

function singleCellList(body: GameplayStatement[], cell: GameplayValue): GameplayValue {
  const id = `cell-list-${body.length}`
  body.push({ kind: 'collection', id, method: 'map', items: literal([0]), inputs: { center: cell }, item: 'item', body: [{ kind: 'return', id: `${id}-return`, value: input('center') }] })
  return out(id, 'value')
}

function appendMessage(body: GameplayStatement[], prefix: string, parts: GameplayValue[]): GameplayValue {
  let current: GameplayValue = literal('')
  parts.forEach((part, index) => {
    const id = `${prefix}-${index}`
    body.push(call(id, 'text.concat', { left: current, right: part }))
    current = out(id, 'text')
  })
  return current
}

function skillGraph(body: GameplayStatement[], schemas: readonly GameplayRecordSchema[] = []): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', ...(schemas.length ? { schemas } : {}), outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

function buildSasukeAmaterasuGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('source', 'piece') }),
  ]
  cellSelection(body, 5)
  body.push(
    call('square', 'spatial.square-cells', { center: out('target', 'cell') }, { radius: 1 }),
    call('cells', 'spatial.clip-cells', { cells: out('square', 'cells') }),
    call('added', 'tile.append-dedup-markers', { cells: out('cells', 'cells'), origin: out('target', 'cell') }, { tileType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right', presentation: 'expand', presentationBatch: 'queue' }),
    call('records', 'extension.append-cell-records', { source: out('source', 'piece'), cells: out('cells', 'cells') }, { storageKey: 'amaterasuCells' }),
    call('set-owner', 'extension.set-owner', { player: out('owner', 'player') }, { storageKey: 'amaterasuOwnerPlayerId', overwrite: false }),
    call('move-rule', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-sasuke-amaterasu-move' }),
    call('stack-rule', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-sasuke-amaterasu-stack' }),
    call('damage-rule', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-sasuke-amaterasu-damage' }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
  )
  // The selected cell is a value, so read its coordinates through the closed
  // spatial adapter rather than embedding an object path in author content.
  body.push(
    call('target-coordinates', 'spatial.cell-coordinates', { cell: out('target', 'cell') }),
    call('target-x-text', 'text.from-number', { value: out('target-coordinates', 'x') }),
    call('target-y-text', 'text.from-number', { value: out('target-coordinates', 'y') }),
    call('added-text', 'text.from-number', { value: out('added', 'added') }),
  )
  const message = appendMessage(body, 'success-message', [
    out('source-name', 'text'), literal('释放天照，以('), out('target-x-text', 'text'), literal(','), out('target-y-text', 'text'), literal(')为中心标记了'), out('added-text', 'text'), literal('个格子为永久天照范围！凡踏入者将遭受黑炎灼烧'),
  ])
  body.push(...result('success', literal(true), message))
  return skillGraph(body)
}

function buildItachiAmaterasuGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('source', 'piece') }),
  ]
  body.push(
    call('choice', 'choice.target-piece', {}, { range: 5, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'return-selection', condition: out('unresolved', 'value'), then: [call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }), { kind: 'return', id: 'return-selection-result', value: out('selection-result', 'result') }] },
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
    call('target-x', 'attribute.read', { piece: out('target', 'piece') }, { attribute: 'x' }),
    call('target-y', 'attribute.read', { piece: out('target', 'piece') }, { attribute: 'y' }),
    call('target-cell', 'spatial.cell', { x: out('target-x', 'value'), y: out('target-y', 'value') }),
  )
  const targetCells = singleCellList(body, out('target-cell', 'cell'))
  body.push(
    call('added', 'tile.append-dedup-markers', { cells: targetCells, origin: out('target-cell', 'cell') }, { tileType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right', presentation: 'expand', presentationBatch: 'direct' }),
    call('records', 'extension.append-cell-records', { source: out('source', 'piece'), cells: targetCells }, { storageKey: 'amaterasuCells' }),
    call('set-owner', 'extension.set-owner', { player: out('owner', 'player') }, { storageKey: 'amaterasuOwnerPlayerId', overwrite: true }),
    call('target-id', 'piece.identifier', { piece: out('target', 'piece') }),
    call('source-id', 'piece.identifier', { piece: out('source', 'piece') }),
    call('status-id', 'status.find-id', { piece: out('target', 'piece') }, { statusType: 'amaterasu-burn' }),
    call('status-present', 'value.present-string', { value: out('status-id', 'id') }),
    call('old-stacks', 'status.read-number', { piece: out('target', 'piece'), statusId: out('status-id', 'id'), fallback: literal(1) }, { field: 'stacks' }),
    call('next-stacks', 'math.add', { left: out('old-stacks', 'value'), right: literal(1) }),
  )
  const newBranch: GameplayStatement[] = [
    call('burn-id', 'text.concat', { left: literal('amaterasu-burn-'), right: out('target-id', 'id') }),
    { kind: 'record.create', id: 'burn-record', schema: 'amaterasu-burn@1', fields: {
      id: out('burn-id', 'text'), type: literal('amaterasu-burn'), name: literal('天照灼烧'), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1), sourcePieceId: out('source-id', 'id'), ownerPlayerId: out('owner', 'player'),
    } },
    call('apply-burn', 'status.apply-record', { target: out('target', 'piece'), record: out('burn-record', 'value') }, { inputPolicy: 'host' }),
  ]
  const existingBranch: GameplayStatement[] = [call('set-stacks', 'status.set-number', { piece: out('target', 'piece'), statusId: out('status-id', 'id'), value: out('next-stacks', 'value') }, { field: 'stacks' })]
  body.push({ kind: 'if', id: 'existing-burn', condition: out('status-present', 'present'), then: existingBranch, else: newBranch })
  body.push(
    call('move-rule', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-sasuke-amaterasu-move' }),
    call('stack-rule', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-sasuke-amaterasu-stack' }),
    call('damage-rule', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-sasuke-amaterasu-damage' }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
  )
  const message = appendMessage(body, 'success-message', [out('source-name', 'text'), literal('以天照点燃'), out('target-name', 'text'), literal('所在格，并使其获得1层天照')])
  body.push(...result('success', literal(true), message))
  return skillGraph(body, [burnSchema])
}

function buildSasukeKagutsuchiGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('source', 'piece') }),
  ]
  pieceSelection(body, 99, 'all')
  body.push(
    call('all-cells', 'extension.read-cell-records', {}, { storageKey: 'amaterasuCells' }),
    call('target-x', 'attribute.read', { piece: out('target', 'piece') }, { attribute: 'x' }),
    call('target-y', 'attribute.read', { piece: out('target', 'piece') }, { attribute: 'y' }),
    call('target-cell', 'spatial.cell', { x: out('target-x', 'value'), y: out('target-y', 'value') }),
    call('nearby', 'spatial.cells-within-range', { origin: out('target-cell', 'cell'), cells: out('all-cells', 'cells') }, { range: 4, metric: 'manhattan' }),
    call('removed', 'extension.remove-cell-records', { cells: out('nearby', 'cells') }, { storageKey: 'amaterasuCells', tileType: 'amaterasu', presentationBatch: 'queue' }),
    call('base-stacks', 'math.add', { left: literal(2), right: out('removed', 'removed') }),
    call('layers', 'math.min', { left: literal(4), right: out('base-stacks', 'value') }),
    call('status-id', 'status.find-id', { piece: out('target', 'piece') }, { statusType: 'amaterasu-burn' }),
    call('status-present', 'value.present-string', { value: out('status-id', 'id') }),
    call('old-stacks', 'status.read-number', { piece: out('target', 'piece'), statusId: out('status-id', 'id'), fallback: literal(0) }, { field: 'stacks' }),
    call('sum-stacks', 'math.add', { left: out('old-stacks', 'value'), right: out('layers', 'value') }),
    call('next-stacks', 'math.min', { left: literal(4), right: out('sum-stacks', 'value') }),
    call('target-id', 'piece.identifier', { piece: out('target', 'piece') }),
  )
  body.push({ kind: 'if', id: 'existing-burn', condition: out('status-present', 'present'), then: [call('set-stacks', 'status.set-number', { piece: out('target', 'piece'), statusId: out('status-id', 'id'), value: out('next-stacks', 'value') }, { field: 'stacks' })], else: [
    call('burn-id', 'text.concat', { left: literal('amaterasu-burn-'), right: out('target-id', 'id') }),
    { kind: 'record.create', id: 'burn-record', schema: 'amaterasu-burn@1', fields: {
      id: out('burn-id', 'text'), type: literal('amaterasu-burn'), name: literal('天照灼烧'), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(2), stacks: out('layers', 'value'), ownerPlayerId: out('owner', 'player'),
    } },
    call('apply-burn', 'status.apply-record', { target: out('target', 'piece'), record: out('burn-record', 'value') }, { inputPolicy: 'host' }),
  ] })
  body.push(
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
    call('removed-text', 'text.from-number', { value: out('removed', 'removed') }),
    call('layers-text', 'text.from-number', { value: out('layers', 'value') }),
  )
  const message = appendMessage(body, 'success-message', [out('source-name', 'text'), literal('使用加具土命，移除目标周围'), out('removed-text', 'text'), literal('个天照地格，为'), out('target-name', 'text'), literal('附加'), out('layers-text', 'text'), literal('层天照')])
  body.push(...result('success', literal(true), message))
  return skillGraph(body, [burnSchema])
}

export function buildAmaterasuSkillGraph(id: typeof AMATERASU_SKILL_IDS[number]): GameplayModuleGraph {
  switch (id) {
    case 'sasuke-amaterasu': return buildSasukeAmaterasuGraph()
    case 'sasuke-kagutsuchi': return buildSasukeKagutsuchiGraph()
    case 'itachi-amaterasu': return buildItachiAmaterasuGraph()
  }
}

function ruleGraph(body: GameplayStatement[], schemas: readonly GameplayRecordSchema[] = []): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', ...(schemas.length ? { schemas } : {}), outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}

function appendRuleAuthorization(body: GameplayStatement[]): void {
  body.push(
    call('authorized', 'rule.authorized-by-owner', {}, { storageKey: 'amaterasuOwnerPlayerId' }),
    call('unauthorized', 'logic.not', { value: out('authorized', 'authorized') }),
    { kind: 'if', id: 'authorization-guard', condition: out('unauthorized', 'value'), then: [ruleResult('unauthorized-result', literal(false), literal(''))] },
  )
}

function appendCellGuard(body: GameplayStatement[]): void {
  body.push(
    call('cells', 'extension.read-cell-records', {}, { storageKey: 'amaterasuCells' }),
    call('cell-count', 'list.count-cells', { items: out('cells', 'cells') }),
    call('has-cells', 'compare.greater-than', { left: out('cell-count', 'value'), right: literal(0) }),
    call('no-cells', 'logic.not', { value: out('has-cells', 'value') }),
    { kind: 'if', id: 'cell-guard', condition: out('no-cells', 'value'), then: [ruleResult('no-cells-result', literal(false), literal(''))] },
  )
}

function appendBurnMutation(
  body: GameplayStatement[],
  prefix: string,
  target: GameplayValue,
  sourceId: GameplayValue,
  ownerId: GameplayValue,
  amount: GameplayValue,
  intensity: number,
  cap: number | undefined,
): GameplayValue {
  body.push(
    call(`${prefix}-status-id`, 'status.find-id', { piece: target }, { statusType: 'amaterasu-burn' }),
    call(`${prefix}-present`, 'value.present-string', { value: out(`${prefix}-status-id`, 'id') }),
    call(`${prefix}-old`, 'status.read-number', { piece: target, statusId: out(`${prefix}-status-id`, 'id'), fallback: literal(1) }, { field: 'stacks' }),
    call(`${prefix}-sum`, 'math.add', { left: out(`${prefix}-old`, 'value'), right: amount }),
    ...(cap === undefined ? [] : [call(`${prefix}-capped`, 'math.min', { left: literal(cap), right: out(`${prefix}-sum`, 'value') })]),
    call(`${prefix}-next`, 'value.select-number', { condition: out(`${prefix}-present`, 'present'), whenTrue: cap === undefined ? out(`${prefix}-sum`, 'value') : out(`${prefix}-capped`, 'value'), whenFalse: amount }),
  )
  const newFields: Record<string, GameplayValue> = {
    id: out(`${prefix}-burn-id`, 'text'), type: literal('amaterasu-burn'), name: literal('天照灼烧'), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(intensity), stacks: out(`${prefix}-next`, 'value'),
  }
  newFields.sourcePieceId = sourceId
  newFields.ownerPlayerId = ownerId
  body.push({ kind: 'if', id: `${prefix}-apply`, condition: out(`${prefix}-present`, 'present'), then: [
    call(`${prefix}-set`, 'status.set-number', { piece: target, statusId: out(`${prefix}-status-id`, 'id'), value: out(`${prefix}-next`, 'value') }, { field: 'stacks' }),
  ], else: [
    call(`${prefix}-target-id`, 'piece.identifier', { piece: target }),
    call(`${prefix}-burn-id`, 'text.concat', { left: literal('amaterasu-burn-'), right: out(`${prefix}-target-id`, 'id') }),
    { kind: 'record.create', id: `${prefix}-record`, schema: 'amaterasu-burn@1', fields: newFields },
    call(`${prefix}-add`, 'status.apply-record', { target, record: out(`${prefix}-record`, 'value') }, { inputPolicy: 'host' }),
  ] })
  return out(`${prefix}-next`, 'value')
}

function appendDamage(body: GameplayStatement[], prefix: string, target: GameplayValue, statusId: GameplayValue, amount: GameplayValue): void {
  body.push(
    call(`${prefix}-source-player-ref`, 'status.read-player-field', { piece: target, statusId }, { field: 'ownerPlayerId' }),
    call(`${prefix}-source-player`, 'query.player', { playerId: out(`${prefix}-source-player-ref`, 'player') }),
    call(`${prefix}-damage`, 'effect.damage', { source: out(`${prefix}-source-player`, 'player'), target, amount }, { sourceType: 'player', damageType: 'true', skillId: 'amaterasu-burn-tick', inputPolicy: 'host' }),
    call(`${prefix}-damage-message`, 'record.read-text', { record: out(`${prefix}-damage`, 'result'), fallback: literal('') }, { field: 'message' }),
  )
}

function appendDamageMessage(body: GameplayStatement[], prefix: string, targetName: GameplayValue, stacks: GameplayValue, damage: GameplayValue, actualOnly: boolean): void {
  body.push(
    call(`${prefix}-stacks-text`, 'text.from-number', { value: stacks }),
    call(`${prefix}-damage-text`, 'text.from-number', { value: damage }),
  )
  const actual = `${prefix}-actual-positive`
  body.push(call(actual, 'compare.greater-than', { left: out(`${prefix}-damage`, 'damage'), right: literal(0) }))
  const actualMessage = appendMessage(body, `${prefix}-actual-message`, [targetName, literal('受天照灼烧('), out(`${prefix}-stacks-text`, 'text'), literal('层)，失去'), out(`${prefix}-damage-text`, 'text'), literal('点生命值')])
  const appendActual = call(`${prefix}-append-actual`, 'collection.text-list-add', { items: out('messages', 'items'), value: actualMessage })
  const blockedCheck: GameplayStatement[] = [
    call(`${prefix}-failed`, 'logic.not', { value: out(`${prefix}-damage`, 'success') }),
    call(`${prefix}-blocked`, 'compare.not-equal-string', { left: out(`${prefix}-damage-message`, 'value'), right: literal('') }),
    call(`${prefix}-blocked-condition`, 'logic.and', { left: out(`${prefix}-failed`, 'value'), right: out(`${prefix}-blocked`, 'value') }),
    { kind: 'if', id: `${prefix}-blocked-branch`, condition: out(`${prefix}-blocked-condition`, 'value'), then: [
      call(`${prefix}-blocked-message`, 'text.concat', { left: targetName, right: literal('天照灼烧被抵挡') }),
      call(`${prefix}-append-blocked`, 'collection.text-list-add', { items: out('messages', 'items'), value: out(`${prefix}-blocked-message`, 'text') }),
    ] },
  ]
  body.push({ kind: 'if', id: `${prefix}-message-branch`, condition: out(actual, 'value'), then: actualOnly ? [appendActual] : [appendActual], else: actualOnly ? [] : blockedCheck })
}

function buildDamageRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  appendRuleAuthorization(body)
  body.push(
    call('current-player', 'turn.current-player'),
    call('target-count', 'collection.live-piece-count'),
    call('damage-index', 'local.counter-create', { initial: literal(0) }),
    call('messages', 'collection.text-list-create'),
  )
  const damageLoopCondition: GameplayStatement[] = [
    call('damage-index-value', 'local.counter-read', { counter: input('damageIndex') }),
    call('damage-index-continue', 'compare.less-than', { left: out('damage-index-value', 'value'), right: input('targetCount') }),
    { kind: 'return', id: 'damage-loop-condition-return', value: out('damage-index-continue', 'value') },
  ]
  const damageLoopBody: GameplayStatement[] = [
    call('live-target', 'collection.live-piece-at', { index: input('damage-loop-index') }),
    call('live-target-present', 'query.has-piece', { pieceId: out('live-target', 'piece') }),
    { kind: 'if', id: 'live-target-guard', condition: out('live-target-present', 'exists'), then: [
      call('target', 'piece.require', { piece: out('live-target', 'piece') }),
      call('target-alive', 'piece.alive', { piece: out('target', 'piece') }),
      call('target-owner', 'piece.owner', { piece: out('target', 'piece') }),
      call('target-own-turn', 'compare.equal-player', { left: out('target-owner', 'player'), right: out('current-player', 'player') }),
      call('target-eligible', 'logic.and', { left: out('target-alive', 'alive'), right: out('target-own-turn', 'value') }),
      { kind: 'if', id: 'target-eligible-guard', condition: out('target-eligible', 'value'), then: [
        call('status-id', 'status.find-id', { piece: out('target', 'piece') }, { statusType: 'amaterasu-burn' }),
        call('present', 'value.present-string', { value: out('status-id', 'id') }),
        { kind: 'if', id: 'has-burn', condition: out('present', 'present'), then: [
          call('stacks', 'status.read-number', { piece: out('target', 'piece'), statusId: out('status-id', 'id'), fallback: literal(1) }, { field: 'stacks' }),
          call('amount', 'math.multiply', { left: literal(2), right: out('stacks', 'value') }),
          call('damage-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
          ...(() => { const nodes: GameplayStatement[] = []; appendDamage(nodes, 'damage', out('target', 'piece'), out('status-id', 'id'), out('amount', 'value')); appendDamageMessage(nodes, 'damage', out('damage-name', 'text'), out('stacks', 'value'), out('damage-damage', 'damage'), false); return nodes })(),
        ] },
      ] },
    ] },
    call('damage-index-add', 'local.counter-add', { counter: out('damage-index', 'counter'), amount: literal(1) }),
  ]
  body.push({ kind: 'while', id: 'damage-pieces-loop', index: 'damage-loop-index', budget: 128, condition: { inputs: { damageIndex: out('damage-index', 'counter'), targetCount: out('target-count', 'count') }, body: damageLoopCondition }, body: damageLoopBody })
  body.push(
    call('message', 'text.join-list', { items: out('messages', 'items') }, { separator: '；' }),
    call('message-count', 'list.count', { items: out('messages', 'items') }),
    call('has-message', 'compare.greater-than', { left: out('message-count', 'count'), right: literal(0) }),
    { kind: 'if', id: 'message-result', condition: out('has-message', 'value'), then: [ruleResult('success-result', literal(true), out('message', 'text'))], else: [ruleResult('empty-result', literal(false), literal(''))] },
  )
  return ruleGraph(body, [burnSchema])
}

function buildStackRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  appendRuleAuthorization(body)
  appendCellGuard(body)
  body.push(call('targets', 'query.pieces-on-cells-all', { cells: out('cells', 'cells') }, { relation: 'all' }), call('messages', 'collection.text-list-create'))
  body.push({ kind: 'foreach', id: 'stack-pieces', items: out('targets', 'pieces'), item: 'target', body: [
    call('source-id', 'extension.cell-record-source', { piece: input('target') }, { storageKey: 'amaterasuCells' }),
    ...(() => { const nodes: GameplayStatement[] = []; const next = appendBurnMutation(nodes, 'stack', input('target'), out('source-id', 'sourceId'), out('source-id', 'ownerPlayerId'), literal(1), 2, undefined); nodes.push(call('name', 'attribute.text', { piece: input('target') }, { attribute: 'name' }), call('next-text', 'text.from-number', { value: next }), { kind: 'if', id: 'existing-message', condition: out('stack-present', 'present'), then: [call('next-message', 'text.concat', { left: out('name', 'text'), right: literal('站在天照上，层数加深至') }), call('next-message-number', 'text.concat', { left: out('next-message', 'text'), right: out('next-text', 'text') }), call('next-message-suffix', 'text.concat', { left: out('next-message-number', 'text'), right: literal('层') }), call('append-next', 'collection.text-list-add', { items: out('messages', 'items'), value: out('next-message-suffix', 'text') })], else: [call('new-message', 'text.concat', { left: out('name', 'text'), right: literal('站在天照上，获得1层天照效果') }), call('append-new', 'collection.text-list-add', { items: out('messages', 'items'), value: out('new-message', 'text') })] }); return nodes })(),
  ] })
  body.push(call('message', 'text.join-list', { items: out('messages', 'items') }, { separator: '；' }), call('message-count', 'list.count', { items: out('messages', 'items') }), call('has-message', 'compare.greater-than', { left: out('message-count', 'count'), right: literal(0) }), { kind: 'if', id: 'message-result', condition: out('has-message', 'value'), then: [ruleResult('success-result', literal(true), out('message', 'text'))], else: [ruleResult('empty-result', literal(false), literal(''))] })
  return ruleGraph(body, [burnSchema])
}

function buildEndturnRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  appendRuleAuthorization(body)
  appendCellGuard(body)
  body.push(call('messages', 'collection.text-list-create'), call('all-pieces', 'query.pieces', {}, { relation: 'all', includeDead: false }))
  body.push({ kind: 'foreach', id: 'stack-pieces', items: out('all-pieces', 'pieces'), item: 'target', body: [
    call('source-id', 'extension.cell-record-source', { piece: input('target') }, { storageKey: 'amaterasuCells' }),
    call('has-source', 'value.present-string', { value: out('source-id', 'sourceId') }),
    { kind: 'if', id: 'stack-on-cell', condition: out('has-source', 'present'), then: [
      ...(() => { const nodes: GameplayStatement[] = []; const next = appendBurnMutation(nodes, 'end-stack', input('target'), out('source-id', 'sourceId'), out('source-id', 'ownerPlayerId'), literal(1), 2, undefined); nodes.push(call('end-stack-name', 'attribute.text', { piece: input('target') }, { attribute: 'name' }), call('end-stack-next-text', 'text.from-number', { value: next }), { kind: 'if', id: 'end-stack-existing-message', condition: out('end-stack-present', 'present'), then: [call('end-stack-next-message', 'text.concat', { left: out('end-stack-name', 'text'), right: literal('站在天照上，层数加深至') }), call('end-stack-next-message-number', 'text.concat', { left: out('end-stack-next-message', 'text'), right: out('end-stack-next-text', 'text') }), call('end-stack-next-message-suffix', 'text.concat', { left: out('end-stack-next-message-number', 'text'), right: literal('层') }), call('end-stack-append-next', 'collection.text-list-add', { items: out('messages', 'items'), value: out('end-stack-next-message-suffix', 'text') })], else: [call('end-stack-new-message', 'text.concat', { left: out('end-stack-name', 'text'), right: literal('站在天照上，获得1层天照效果') }), call('end-stack-append-new', 'collection.text-list-add', { items: out('messages', 'items'), value: out('end-stack-new-message', 'text') })] }); return nodes })(),
    ] },
  ] })
  body.push(call('current-player', 'turn.current-player'), call('damage-pieces', 'query.pieces', { ownerId: out('current-player', 'player') }, { relation: 'all', includeDead: false }))
  body.push({ kind: 'foreach', id: 'damage-pieces-loop', items: out('damage-pieces', 'pieces'), item: 'target', body: [
    call('status-id', 'status.find-id', { piece: input('target') }, { statusType: 'amaterasu-burn' }),
    call('present', 'value.present-string', { value: out('status-id', 'id') }),
    { kind: 'if', id: 'has-burn', condition: out('present', 'present'), then: [
      call('stacks', 'status.read-number', { piece: input('target'), statusId: out('status-id', 'id'), fallback: literal(1) }, { field: 'stacks' }),
      call('amount', 'math.multiply', { left: literal(2), right: out('stacks', 'value') }),
      ...(() => { const nodes: GameplayStatement[] = []; nodes.push(call('end-damage-name', 'attribute.text', { piece: input('target') }, { attribute: 'name' })); appendDamage(nodes, 'end-damage', input('target'), out('status-id', 'id'), out('amount', 'value')); nodes.push(call('end-damage-stacks-text', 'text.from-number', { value: out('stacks', 'value') }), call('end-damage-amount-text', 'text.from-number', { value: out('amount', 'value') })); const message = appendMessage(nodes, 'end-damage-message', [out('end-damage-name', 'text'), literal('受天照灼烧('), out('end-damage-stacks-text', 'text'), literal('层)，失去'), out('end-damage-amount-text', 'text'), literal('点生命值')]); nodes.push(call('end-damage-append', 'collection.text-list-add', { items: out('messages', 'items'), value: message })); return nodes })(),
    ] },
  ] })
  body.push(call('message', 'text.join-list', { items: out('messages', 'items') }, { separator: '；' }), call('message-count', 'list.count', { items: out('messages', 'items') }), call('has-message', 'compare.greater-than', { left: out('message-count', 'count'), right: literal(0) }), { kind: 'if', id: 'message-result', condition: out('has-message', 'value'), then: [ruleResult('success-result', literal(true), out('message', 'text'))], else: [ruleResult('empty-result', literal(false), literal(''))] })
  return ruleGraph(body, [burnSchema])
}

function buildMoveRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  appendRuleAuthorization(body)
  appendCellGuard(body)
  body.push(
    call('moved-ref', 'ref.source'),
    call('moved', 'query.piece', { pieceId: out('moved-ref', 'piece') }),
    call('alive', 'piece.alive', { piece: out('moved', 'piece') }),
    call('not-alive', 'logic.not', { value: out('alive', 'alive') }),
    { kind: 'if', id: 'moved-guard', condition: out('not-alive', 'value'), then: [ruleResult('moved-invalid', literal(false), literal(''))] },
    call('hits', 'event.path-cell-record-hits', {}, { storageKey: 'amaterasuCells' }),
    call('has-hits', 'compare.greater-than', { left: out('hits', 'hits'), right: literal(0) }),
    { kind: 'if', id: 'hit-guard', condition: out('has-hits', 'value'), else: [ruleResult('no-hit', literal(false), literal(''))], then: [] },
    call('status-id', 'status.find-id', { piece: out('moved', 'piece') }, { statusType: 'amaterasu-burn' }),
    call('present', 'value.present-string', { value: out('status-id', 'id') }),
    call('old-stacks', 'status.read-number', { piece: out('moved', 'piece'), statusId: out('status-id', 'id'), fallback: literal(1) }, { field: 'stacks' }),
    call('sum-stacks', 'math.add', { left: out('old-stacks', 'value'), right: out('hits', 'hits') }),
    call('next-stacks', 'value.select-number', { condition: out('present', 'present'), whenTrue: out('sum-stacks', 'value'), whenFalse: out('hits', 'hits') }),
  )
  body.push({ kind: 'if', id: 'apply-hit-status', condition: out('present', 'present'), then: [call('set-stacks', 'status.set-number', { piece: out('moved', 'piece'), statusId: out('status-id', 'id'), value: out('next-stacks', 'value') }, { field: 'stacks' })], else: [
    call('moved-id', 'piece.identifier', { piece: out('moved', 'piece') }),
    call('burn-id', 'text.concat', { left: literal('amaterasu-burn-'), right: out('moved-id', 'id') }),
    { kind: 'record.create', id: 'burn-record', schema: 'amaterasu-burn@1', fields: { id: out('burn-id', 'text'), type: literal('amaterasu-burn'), name: literal('天照灼烧'), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(2), stacks: out('next-stacks', 'value'), sourcePieceId: out('hits', 'sourceId'), ownerPlayerId: out('hits', 'ownerPlayerId') } },
    call('apply-status', 'status.apply-record', { target: out('moved', 'piece'), record: out('burn-record', 'value') }, { inputPolicy: 'host' }),
  ] })
  body.push(call('moved-name', 'attribute.text', { piece: out('moved', 'piece') }, { attribute: 'name' }), call('hits-text', 'text.from-number', { value: out('hits', 'hits') }), call('next-text', 'text.from-number', { value: out('next-stacks', 'value') }))
  const message = appendMessage(body, 'success-message', [out('moved-name', 'text'), literal('经过天照范围，附加'), out('hits-text', 'text'), literal('层天照效果（当前'), out('next-text', 'text'), literal('层）')])
  body.push(ruleResult('success-result', literal(true), message))
  return ruleGraph(body, [burnSchema])
}

export function buildAmaterasuRuleGraph(id: typeof AMATERASU_RULE_IDS[number]): GameplayModuleGraph {
  switch (id) {
    case 'rule-sasuke-amaterasu-damage': return buildDamageRuleGraph()
    case 'rule-sasuke-amaterasu-endturn': return buildEndturnRuleGraph()
    case 'rule-sasuke-amaterasu-move': return buildMoveRuleGraph()
    case 'rule-sasuke-amaterasu-stack': return buildStackRuleGraph()
  }
}

type JsonRecord = Record<string, unknown>
const generatedFields = new Set(['skillCode', 'code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export function migrateSemanticAmaterasu(root: string, write = false): string[] {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')) as { entries: Record<string, JsonRecord> }
  const pending: Array<{ file: string; next: JsonRecord }> = []
  for (const id of AMATERASU_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
    const currentEntry = ((current.gameplayModules as JsonRecord | undefined)?.entries as JsonRecord | undefined)?.code as JsonRecord | undefined
    if (currentEntry?.graph) {
      assertGameplayModuleDocument(current)
      const expected = migrateAtomicAuthorGraph(buildAmaterasuSkillGraph(id))
      if (!equal(currentEntry.graph, expected)) pending.push({ file, next: applyGameplayModuleGraph(current, expected) as JsonRecord })
      continue
    }
    const original = fixture.entries['skills/' + id]
    if (!original) throw new Error(`${id}: missing frozen baseline`)
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generatedFields.has(key) && !equal(original[key], current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildAmaterasuSkillGraph(id)) as JsonRecord })
  }
  for (const id of AMATERASU_RULE_IDS) {
    const file = path.join(root, 'data/rules', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
    const currentEntry = ((current.gameplayModules as JsonRecord | undefined)?.entries as JsonRecord | undefined)?.skillCode as JsonRecord | undefined
    if (currentEntry?.graph) {
      assertGameplayModuleDocument(current)
      const expected = migrateAtomicAuthorGraph(buildAmaterasuRuleGraph(id))
      if (!equal(currentEntry.graph, expected)) pending.push({ file, next: applyGameplayModuleGraph(current, expected, 'skillCode') as JsonRecord })
      continue
    }
    const original = fixture.entries['rules/' + id]
    if (!original) throw new Error(`${id}: missing frozen baseline`)
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generatedFields.has(key) && !equal(original[key], current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildAmaterasuRuleGraph(id), 'skillCode') as JsonRecord })
  }
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateSemanticAmaterasu(process.cwd(), process.argv.includes('--write'))))
