import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleSurface,
  type GameplayPort,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
} from '../lib/skill-graph/module-document'
import { SEMANTIC_MODULE_VERSION } from './migrate-semantic-modules'

/** RED-252's pending spatial migration.  The graph is the authoring source;
 * registered modules below it only expose closed host capabilities. */

export const SEMANTIC_PENDING_VERSION = '1' as const
type JsonRecord = Record<string, unknown>
export type PendingField = 'code' | 'skillCode'
export type PendingMigration = { readonly id: string; readonly field: PendingField; readonly surface: Exclude<GameplayModuleSurface, 'preview'>; readonly build: () => GameplayModuleGraph }
export type PendingReport = { readonly id: string; readonly field: PendingField; readonly surface: PendingMigration['surface']; readonly status: 'ready' | 'already-migrated' | 'blocked'; readonly reason?: string; readonly document?: JsonRecord; readonly file: string }
export type PendingRun = { readonly migrations: readonly PendingMigration[]; readonly reports: readonly PendingReport[]; readonly documents: ReadonlyMap<string, JsonRecord> }

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const list = (element: GameplayValueType): GameplayValueType => ({ kind: 'list', element })
const call = (id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}, parameters: Readonly<Record<string, GameplayLiteral>> = {}): GameplayStatement => ({ kind: 'call', id, module, version: SEMANTIC_MODULE_VERSION, inputs, parameters })
const branch = (id: string, condition: GameplayValue, then: readonly GameplayStatement[], otherwise: readonly GameplayStatement[] = []): GameplayStatement => ({ kind: 'if', id, condition, then, else: otherwise })
const ret = (id: string, value: GameplayValue): GameplayStatement => ({ kind: 'return', id, value })
const schema = (id: string, fields: readonly GameplayPort[]): GameplayRecordSchema => ({ id, version: SEMANTIC_PENDING_VERSION, fields })
const recordGet = (id: string, record: GameplayValue, field: string): GameplayStatement => ({ kind: 'record.get', id, record, field })
const recordCreate = (id: string, schemaId: string, fields: Readonly<Record<string, GameplayValue>>): GameplayStatement => ({ kind: 'record.create', id, schema: `${schemaId}@${SEMANTIC_PENDING_VERSION}`, fields })
const RESULT_OUTPUTS: readonly GameplayPort[] = [port('result', 'record', { nullable: true })]

function result(id: string, success: GameplayValue, message?: GameplayValue): readonly GameplayStatement[] {
  return [call(id, 'result.action', message === undefined ? { success } : { success, message }), ret(`${id}-return`, output(id, 'result'))]
}
function failure(id: string, message = ''): readonly GameplayStatement[] { return result(id, literal(false), literal(message)) }
function success(id: string, message = ''): readonly GameplayStatement[] { return result(id, literal(true), literal(message)) }
function textChain(prefix: string, values: readonly GameplayValue[]): { readonly statements: readonly GameplayStatement[]; readonly value: GameplayValue } {
  if (!values.length) return { statements: [], value: literal('') }
  let value = values[0]
  const statements: GameplayStatement[] = []
  values.slice(1).forEach((right, index) => {
    const id = `${prefix}-${index}`
    statements.push(call(id, 'text.concat', { left: value, right }))
    value = output(id, 'text')
  })
  return { statements, value }
}
function message(id: string, values: readonly GameplayValue[], ok = true): readonly GameplayStatement[] {
  const chain = textChain(`${id}-text`, values)
  return [...chain.statements, ...result(`${id}-result`, literal(ok), chain.value)]
}
function returnChoice(id: string, pendingNode: string, choiceNode: string): GameplayStatement {
  return branch(`${id}-pending`, output(pendingNode, 'pending'), [call(`${id}-choice-result`, 'choice.as-result', { choice: output(choiceNode, 'choice') }), ret(`${id}-choice-return`, output(`${id}-choice-result`, 'result'))])
}
function returnUnresolvedChoice(id: string, unresolvedNode: string, choiceNode: string): GameplayStatement {
  return branch(`${id}-unresolved`, output(unresolvedNode, 'value'), [call(`${id}-choice-result`, 'choice.as-result', { choice: output(choiceNode, 'choice') }), ret(`${id}-choice-return`, output(`${id}-choice-result`, 'result'))])
}
function records(...items: GameplayRecordSchema[]): readonly GameplayRecordSchema[] { return items }

const payloadSource = schema('pending-source-payload', [port('sourcePieceId', 'piece')])
const payloadSelected = schema('pending-selected-payload', [port('sourcePieceId', 'piece'), port('selectedIds', list('piece'))])
const payloadMover = schema('pending-mover-payload', [port('moverId', 'piece')])
const payloadShield = schema('pending-shield-record', [
  port('id', 'string'), port('name', 'string'), port('type', 'string'), port('currentDuration', 'number'), port('currentUses', 'number'), port('intensity', 'number'), port('stacks', 'number'), port('relatedRules', list('string')),
])
const payloadCaster = schema('pending-caster-payload', [port('casterId', 'piece')])

export function buildMinatoRasenganGraph(): GameplayModuleGraph {
  const successBody: GameplayStatement[] = [
    call('caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: output('target', 'piece') }, { attribute: 'name' }),
    call('attack', 'attribute.read', { piece: output('caster', 'piece') }, { attribute: 'attack' }),
    call('damage', 'effect.damage', { source: output('caster', 'piece'), target: output('target', 'piece'), amount: output('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', inputPolicy: 'host', skillId: 'minato-rasengan' }),
    call('damage-text', 'text.from-number', { value: output('damage', 'damage') }),
    call('attack-up', 'attribute.adjust', { piece: output('caster', 'piece'), amount: literal(1) }, { attribute: 'attack' }),
    call('mark', 'status.mark-apply', { target: output('target', 'piece'), source: output('caster', 'piece') }, { statusType: 'flying-raijin-mark', statusName: '飞雷神', statusIdPrefix: 'flying-raijin-mark' }),
    ...message('success', [output('caster-name', 'text'), literal('对'), output('target-name', 'text'), literal('释放螺旋丸，造成'), output('damage-text', 'text'), literal('点伤害，攻击力+1，并附加1层飞雷神标记')]),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: RESULT_OUTPUTS,
    body: [
      call('caster-ref', 'ref.holder'), call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }), call('target-choice', 'choice.target-piece', {}, { range: 1, filter: 'enemy' }),
      call('target-unresolved', 'choice.is-pending', { choice: output('target-choice', 'choice') }), returnChoice('target', 'target-unresolved', 'target-choice'),
      call('target', 'choice.piece', { choice: output('target-choice', 'choice') }), call('target-hp', 'attribute.read', { piece: output('target', 'piece') }, { attribute: 'currentHp' }),
      call('target-dead', 'compare.less-or-equal', { left: output('target-hp', 'value'), right: literal(0) }),
      branch('target-check', output('target-dead', 'value'), failure('dead', '目标已出局'), successBody),
    ],
  }
}

export function buildMinatoKunaiFormulaGraph(): GameplayModuleGraph {
  const successBody: GameplayStatement[] = [
    call('remove-anchor', 'marker.anchor-remove', { source: output('caster', 'piece'), cell: output('cell', 'cell') }, { storageKey: 'minatoAnchors', tileType: 'flying-raijin-anchor' }),
    call('move', 'effect.teleport', { piece: output('ally', 'piece'), destination: output('cell', 'cell') }, { kind: 'teleport' }),
    branch('move-check', output('move', 'success'), [
      call('mark', 'status.mark-apply', { target: output('ally', 'piece'), source: output('caster', 'piece') }, { statusType: 'flying-raijin-mark', statusName: '飞雷神', statusIdPrefix: 'flying-raijin-mark' }),
      call('caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }), call('ally-name', 'attribute.text', { piece: output('ally', 'piece') }, { attribute: 'name' }),
      call('coordinates', 'spatial.cell-coordinates', { cell: output('cell', 'cell') }), call('x', 'text.from-number', { value: output('coordinates', 'x') }), call('y', 'text.from-number', { value: output('coordinates', 'y') }),
      ...message('success', [output('caster-name', 'text'), literal('发动苦无术式，将'), output('ally-name', 'text'), literal('传送至飞雷神锚点('), output('x', 'text'), literal(','), output('y', 'text'), literal(')并附加飞雷神标记')]),
    ], failure('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: RESULT_OUTPUTS,
    body: [
      call('caster-ref', 'ref.holder'), call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }), call('ally-choice', 'choice.target-piece', {}, { range: 99, filter: 'ally' }), call('ally-unresolved', 'choice.is-pending', { choice: output('ally-choice', 'choice') }), returnChoice('ally', 'ally-unresolved', 'ally-choice'), call('ally', 'choice.piece', { choice: output('ally-choice', 'choice') }),
      call('cell-choice', 'choice.target-cell', {}, { range: 99, filter: 'all' }), call('cell-unresolved', 'choice.is-pending', { choice: output('cell-choice', 'choice') }), returnChoice('cell', 'cell-unresolved', 'cell-choice'), call('cell', 'choice.cell', { choice: output('cell-choice', 'choice') }), call('anchor', 'marker.anchor-exists', { source: output('caster', 'piece'), cell: output('cell', 'cell') }, { storageKey: 'minatoAnchors' }),
      branch('anchor-check', output('anchor', 'value'), [call('walkable', 'spatial.cell-walkable-safe', { cell: output('cell', 'cell') }), branch('walkable-check', output('walkable', 'value'), [call('free', 'spatial.cell-unoccupied', { cell: output('cell', 'cell'), ignore: output('ally', 'piece') }), branch('free-check', output('free', 'value'), successBody, failure('occupied', '锚点位置已被占用'))], failure('terrain', '锚点位置不可行走'))], failure('missing-anchor', '目标位置不是水门的飞雷神锚点')),
    ],
  }
}

export function buildMinatoSpiralBarrageGraph(): GameplayModuleGraph {
  const continuation: GameplayModuleGraph = {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'pending', outputs: RESULT_OUTPUTS,
    hostBindings: { payload: { kind: 'record', schema: `${payloadCaster.id}@${payloadCaster.version}` }, targetCell: { kind: 'nullable', value: 'cell' } }, schemas: records(payloadCaster),
    body: [recordGet('caster-id', input('payload'), 'casterId'), call('caster', 'query.piece', { pieceId: output('caster-id', 'value') }), call('place', 'marker.anchor-place', { source: output('caster', 'piece'), cell: input('targetCell') }, { storageKey: 'minatoAnchors', tileType: 'flying-raijin-anchor' }), call('coords', 'spatial.cell-coordinates-safe', { cell: input('targetCell') }), call('x', 'text.from-number', { value: output('coords', 'x') }), call('y', 'text.from-number', { value: output('coords', 'y') }), ...message('placed', [literal('飞雷神锚点设置在('), output('x', 'text'), literal(','), output('y', 'text'), literal(')')])],
  }
  // The target is removed by the damage effect before the killed branch runs.
  // Reuse the target name captured before damage instead of querying the dead
  // piece again through the live battle collection.
  const pendingMessage = textChain('pending-message', [output('anchor-caster-name', 'text'), literal('发动螺旋连丸击杀'), output('target-name', 'text'), literal('，造成'), output('killed-damage-text', 'text'), literal('点伤害并攻击力+1，请选择新的飞雷神锚点')])
  const killed: GameplayStatement[] = [
    recordCreate('payload', payloadCaster.id, { casterId: output('caster', 'piece') }), call('anchor-caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }), call('killed-damage-text', 'text.from-number', { value: output('damage', 'damage') }), call('player-ref', 'ref.player'), call('player', 'player.require', { player: output('player-ref', 'player') }), call('title', 'text.concat', { left: output('anchor-caster-name', 'text'), right: literal('选择新的飞雷神锚点') }),
    ...pendingMessage.statements,
     { kind: 'defer-choice', id: 'new-anchor', graph: 'minato-spiral-barrage-anchor', payload: output('payload', 'value'), player: output('player', 'player'), title: output('title', 'text'), message: pendingMessage.value, targetType: literal('cell'), range: literal(99), filter: literal('all'), selectionMode: literal('single'), min: literal(1), max: literal(1), canCancel: literal(true), resumeOnCancel: literal(true) },
    ...success('pending', ''),
  ]
  const ordinary: GameplayStatement[] = [call('mark', 'status.mark-apply', { target: output('target', 'item'), source: output('caster', 'piece') }, { statusType: 'flying-raijin-mark', statusName: '飞雷神', statusIdPrefix: 'flying-raijin-mark' }), call('caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }), call('coordinates', 'spatial.cell-coordinates-safe', { cell: output('anchor-cell', 'cell') }), call('x', 'text.from-number', { value: output('coordinates', 'x') }), call('y', 'text.from-number', { value: output('coordinates', 'y') }), call('damage-text', 'text.from-number', { value: output('damage', 'damage') }), ...message('ordinary', [output('caster-name', 'text'), literal('发动螺旋连丸，经由锚点('), output('x', 'text'), literal(','), output('y', 'text'), literal(')闪至'), output('target-name', 'text'), literal('相邻地格，造成'), output('damage-text', 'text'), literal('点伤害并攻击力+1，附加飞雷神标记')])]
  const body: GameplayStatement[] = [
      call('caster-ref', 'ref.holder'), call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }), call('anchor-choice', 'choice.target-cell', {}, { range: 99, filter: 'all' }), call('anchor-unresolved', 'choice.is-pending', { choice: output('anchor-choice', 'choice') }), returnChoice('anchor', 'anchor-unresolved', 'anchor-choice'), call('anchor-cell', 'choice.cell', { choice: output('anchor-choice', 'choice') }), call('has-anchor', 'marker.anchor-exists', { source: output('caster', 'piece'), cell: output('anchor-cell', 'cell') }, { storageKey: 'minatoAnchors' }),
    branch('anchor-check', output('has-anchor', 'value'), [call('walkable', 'spatial.cell-walkable-safe', { cell: output('anchor-cell', 'cell') }), branch('walkable-check', output('walkable', 'value'), [call('enemies', 'marker.nearby-enemies', { source: output('caster', 'piece'), cell: output('anchor-cell', 'cell') }, { range: 3 }), call('enemy-count', 'list.count-pieces', { items: output('enemies', 'pieces') }), call('has-enemies', 'compare.greater-than', { left: output('enemy-count', 'value'), right: literal(0) }), branch('enemy-check', output('has-enemies', 'value'), [call('target', 'query.random-item', { items: output('enemies', 'pieces') }), call('landing', 'spatial.nearest-adjacent-landing', { target: output('target', 'item'), reference: output('anchor-cell', 'cell'), ignore: output('caster', 'piece') }, { diagonal: true }), call('landing-valid', 'value.present-cell', { value: output('landing', 'cell') }), branch('landing-check', output('landing-valid', 'present'), [call('landing-safe', 'spatial.cell-require', { cell: output('landing', 'cell') }), call('target-name', 'attribute.text', { piece: output('target', 'item') }, { attribute: 'name' }), call('target-hp-before', 'attribute.read', { piece: output('target', 'item') }, { attribute: 'currentHp' }), call('remove-anchor', 'marker.anchor-remove', { source: output('caster', 'piece'), cell: output('anchor-cell', 'cell') }, { storageKey: 'minatoAnchors', tileType: 'flying-raijin-anchor' }), call('move', 'effect.teleport', { piece: output('caster', 'piece'), destination: output('landing-safe', 'cell') }, { kind: 'teleport' }), branch('move-check', output('move', 'success'), [call('attack', 'attribute.read', { piece: output('caster', 'piece') }, { attribute: 'attack' }), call('damage', 'effect.damage', { source: output('caster', 'piece'), target: output('target', 'item'), amount: output('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', inputPolicy: 'host', skillId: 'minato-spiral-barrage' }), call('attack-up', 'attribute.adjust', { piece: output('caster', 'piece'), amount: literal(1) }, { attribute: 'attack' }), call('killed', 'compare.less-or-equal', { left: output('target-hp-before', 'value'), right: output('damage', 'damage') }), branch('killed-check', output('killed', 'value'), killed, ordinary)], failure('blocked', '位移被阻挡，本次位移效果取消'))], failure('no-landing', '目标相邻地格没有合法落点'))], failure('no-enemy', '锚点3格内没有敌人'))], failure('terrain', '锚点位置不可行走'))], failure('missing-anchor', '目标位置不是水门的飞雷神锚点')),
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: RESULT_OUTPUTS, body, schemas: records(payloadCaster), continuations: [{ id: 'minato-spiral-barrage-anchor', version: SEMANTIC_PENDING_VERSION, graph: continuation }] }
}

export function buildMinatoAnchorEndTurnGraph(): GameplayModuleGraph {
  const selected: GameplayStatement[] = [
    call('target-cell', 'event.target-coordinate-cell'),
    { kind: 'collection', id: 'matching', method: 'filter', items: output('cells', 'cells'), inputs: { target: output('target-cell', 'cell') }, body: [
      call('same', 'spatial.cell-equal', { left: input('item'), right: input('target') }),
      ret('same-result', output('same', 'value')),
    ] },
    call('matching-count', 'list.count-cells', { items: output('matching', 'value') }),
    call('legal', 'compare.greater-than', { left: output('matching-count', 'value'), right: literal(0) }),
    branch('legal-check', output('legal', 'value'), [
      call('place', 'marker.anchor-place', { source: output('holder', 'piece'), cell: output('target-cell', 'cell') }, { storageKey: 'minatoAnchors', tileType: 'flying-raijin-anchor' }),
      call('name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
      call('coords', 'spatial.cell-coordinates', { cell: output('target-cell', 'cell') }),
      call('x', 'text.from-number', { value: output('coords', 'x') }), call('y', 'text.from-number', { value: output('coords', 'y') }),
      ...message('placed', [output('name', 'text'), literal('标记飞雷神锚点('), output('x', 'text'), literal(','), output('y', 'text'), literal(')')]),
    ], failure('illegal', '飞雷神锚点位置不合法')),
  ]
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'), call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
    call('holder-missing', 'logic.not', { value: output('holder-present', 'exists') }),
    branch('holder-guard', output('holder-missing', 'value'), failure('missing', '')),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('hp', 'attribute.read', { piece: output('holder', 'piece') }, { attribute: 'currentHp' }),
    call('alive', 'compare.greater-than', { left: output('hp', 'value'), right: literal(0) }), call('owner', 'piece.owner', { piece: output('holder', 'piece') }),
    call('current-player', 'turn.current-player'), call('same-player', 'compare.equal-player', { left: output('owner', 'player'), right: output('current-player', 'player') }),
    call('active', 'logic.and', { left: output('alive', 'value'), right: output('same-player', 'value') }),
    branch('active-check', output('active', 'value'), [
      call('cells', 'marker.anchor-candidates', { source: output('holder', 'piece') }, { range: 7, order: 'map' }),
      call('has-x', 'event.has-field', {}, { field: 'targetX' }), call('has-y', 'event.has-field', {}, { field: 'targetY' }),
      call('has-target', 'logic.and', { left: output('has-x', 'value'), right: output('has-y', 'value') }),
      branch('target-check', output('has-target', 'value'), selected, [
        call('count', 'list.count-cells', { items: output('cells', 'cells') }), call('has-cells', 'compare.greater-than', { left: output('count', 'value'), right: literal(0) }),
        branch('candidate-check', output('has-cells', 'value'), [
          call('choice-name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }), call('title', 'text.concat', { left: output('choice-name', 'text'), right: literal('选择飞雷神锚点') }),
          call('choice', 'choice.cell-options', { player: output('owner', 'player'), cells: output('cells', 'cells'), title: output('title', 'text') }, { targetType: 'cell', range: 7, filter: 'all', canCancel: true }),
          ret('choice-result', output('choice', 'result')),
        ], failure('none', '')),
      ]),
    ], failure('inactive', '')),
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: RESULT_OUTPUTS, body }
}

export function buildMinatoFlyingRaijinTriggerGraph(): GameplayModuleGraph {
  const successBody: GameplayStatement[] = [
    call('landing-safe', 'spatial.cell-require', { cell: output('landing', 'cell') }),
    call('move', 'effect.teleport', { piece: output('minato', 'piece'), destination: output('landing-safe', 'cell') }, { kind: 'teleport' }),
    branch('move-check', output('move', 'success'), [
      call('attack', 'attribute.read', { piece: output('minato', 'piece') }, { attribute: 'attack' }),
      call('damage', 'effect.damage', { source: output('minato', 'piece'), target: output('target-safe', 'piece'), amount: output('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', inputPolicy: 'host', skillId: 'minato-rasengan' }),
      call('attack-up', 'attribute.adjust', { piece: output('minato', 'piece'), amount: literal(1) }, { attribute: 'attack' }),
      call('mark-target', 'status.mark-apply', { target: output('target', 'target'), source: output('minato', 'piece') }, { statusType: 'flying-raijin-mark', statusName: '飞雷神', statusIdPrefix: 'flying-raijin-mark' }),
      call('remove-mark', 'status.mark-remove', { target: output('marked', 'piece'), source: output('minato', 'piece') }, { statusType: 'flying-raijin-mark' }),
      call('name', 'attribute.text', { piece: output('minato', 'piece') }, { attribute: 'name' }), call('target-name', 'attribute.text', { piece: output('target-safe', 'piece') }, { attribute: 'name' }), call('damage-text', 'text.from-number', { value: output('damage', 'damage') }),
      ...message('success', [output('name', 'text'), literal('触发飞雷神，传送至'), output('target-name', 'text'), literal('相邻地格释放螺旋丸，造成'), output('damage-text', 'text'), literal('点伤害并攻击力+1')]),
    ], failure('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  const yesBody: GameplayStatement[] = [
    call('player-ref', 'ref.player'), call('player', 'player.require', { player: output('player-ref', 'player') }), call('choice', 'choice.binary-option', { player: output('player', 'player') }, { title: '飞雷神触发', yesLabel: '触发飞雷神，传送并释放螺旋丸', noLabel: '不触发', yesValue: 'yes', noValue: 'no' }), call('choice-unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
    branch('choice-check', output('choice-unresolved', 'value'), [call('choice-result', 'choice.as-result', { choice: output('choice', 'choice') }), ret('choice-return', output('choice-result', 'result'))], [
      call('choice-value', 'choice.raw-string-value', { choice: output('choice', 'choice') }), call('yes', 'compare.equal-string-nullable', { left: output('choice-value', 'value'), right: literal('yes') }), branch('yes-check', output('yes', 'value'), successBody, failure('declined', '')),
    ]),
  ]
  const body: GameplayStatement[] = [
    call('minato-ref', 'ref.holder'), call('minato', 'query.piece', { pieceId: output('minato-ref', 'piece') }), call('source-ref', 'ref.source'), call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }), call('marked-ref', 'ref.target'), call('marked', 'query.piece', { pieceId: output('marked-ref', 'piece') }), call('skill-id', 'event.skill-id'),
      call('minato-alive', 'piece.alive', { piece: output('minato', 'piece') }), call('marked-alive', 'piece.alive', { piece: output('marked', 'piece') }), call('spiral', 'compare.equal-string-nullable', { left: output('skill-id', 'value'), right: literal('minato-spiral-barrage') }),
    call('mark', 'status.has-source-mark', { target: output('marked', 'piece'), source: output('minato', 'piece') }, { statusType: 'flying-raijin-mark' }), call('not-spiral', 'logic.not', { value: output('spiral', 'value') }), call('eligible', 'logic.and', { left: output('minato-alive', 'alive'), right: output('marked-alive', 'alive') }), call('eligible-2', 'logic.and', { left: output('eligible', 'value'), right: output('not-spiral', 'value') }), call('eligible-3', 'logic.and', { left: output('eligible-2', 'value'), right: output('mark', 'value') }),
    branch('eligible-check', output('eligible-3', 'value'), [
      call('target', 'marker.trigger-target', { source: output('source', 'piece'), marked: output('marked', 'piece'), origin: output('minato', 'piece') }), call('target-safe', 'piece.require', { piece: output('target', 'target') }), call('target-alive', 'piece.alive', { piece: output('target-safe', 'piece') }),
      branch('target-check', output('target-alive', 'alive'), [call('landing', 'spatial.random-adjacent-landing', { target: output('target-safe', 'piece'), ignore: output('minato', 'piece') }), call('landing-valid', 'value.present-cell', { value: output('landing', 'cell') }), branch('landing-check', output('landing-valid', 'present'), yesBody, failure('no-landing', ''))], failure('no-target', '')),
    ], failure('ineligible', '')),
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: RESULT_OUTPUTS, body }
}

export function buildTuralyonGrandCrusadeGraph(): GameplayModuleGraph {
  const complete: GameplayModuleGraph = {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'pending', outputs: RESULT_OUTPUTS, hostBindings: { payload: { kind: 'record', schema: `${payloadSelected.id}@${payloadSelected.version}` }, targetCell: { kind: 'nullable', value: 'cell' } }, schemas: records(payloadSelected, payloadShield),
    body: [recordGet('source-id', input('payload'), 'sourcePieceId'), recordGet('selected-ids', input('payload'), 'selectedIds'), call('sorted-selected', 'list.sort-pieces', { items: output('selected-ids', 'value') }), call('source', 'query.piece', { pieceId: output('source-id', 'value') }), call('valid-selection', 'spatial.formation-selection-valid', { source: output('source', 'piece'), selected: output('sorted-selected', 'sorted') }), branch('selection-check', output('valid-selection', 'value'), [call('centers', 'spatial.formation-candidates', { source: output('source', 'piece'), selected: output('sorted-selected', 'sorted') }, { range: 6 }), call('center-valid', 'spatial.cell-in-list', { cell: input('targetCell'), cells: output('centers', 'cells') }), branch('center-check', output('center-valid', 'value'), [call('center-safe', 'spatial.cell-require', { cell: input('targetCell') }), call('slots', 'spatial.formation-slots', { center: output('center-safe', 'cell'), selected: output('sorted-selected', 'sorted') }), call('move', 'effect.displace-many', { pieces: output('sorted-selected', 'sorted'), destinations: output('slots', 'cells') }, { kind: 'teleport' }), branch('move-check', output('move', 'success'), [{ kind: 'foreach', id: 'shield-each', items: output('sorted-selected', 'sorted'), item: 'piece', index: 'index', body: [call('id', 'piece.identifier', { piece: output('shield-each', 'item') }), call('id-text', 'text.concat', { left: literal('turalyon-grand-crusade-shield-'), right: output('id', 'id') }), recordCreate('shield', payloadShield.id, { id: output('id-text', 'text'), name: literal('圣盾'), type: literal('divine-shield'), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1), relatedRules: literal(['rule-divine-shield']) }), call('status', 'status.apply-record', { target: output('shield-each', 'item'), record: output('shield', 'value') }, { inputPolicy: 'host' }), call('has-rule', 'rule.has-piece', { piece: output('shield-each', 'item') }, { ruleId: 'rule-divine-shield' }), call('missing-rule', 'logic.not', { value: output('has-rule', 'value') }), branch('rule-check', output('missing-rule', 'value'), [call('add-rule', 'rule.append-reference', { target: output('shield-each', 'item') }, { ruleId: 'rule-divine-shield' })])] }, call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }), call('count', 'list.count-pieces', { items: output('sorted-selected', 'sorted') }), call('count-text', 'text.from-number', { value: output('count', 'value') }), ...message('success', [output('source-name', 'text'), literal('发起圣光大远征，集结了'), output('count-text', 'text'), literal('个友方并赋予圣盾')])], failure('move-failed', '编队落点失效，大远征取消'))], failure('center-failed', '圣光大远征的集结点已失效'))], failure('selection-failed', '圣光大远征的友方目标已失效'))],
  }
  const selectCell: GameplayModuleGraph = {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'pending', outputs: RESULT_OUTPUTS, hostBindings: { payload: { kind: 'record', schema: `${payloadSource.id}@${payloadSource.version}` }, selectedTargets: list('choice') }, schemas: records(payloadSource, payloadSelected), continuations: [{ id: 'turalyon-grand-crusade-complete', version: SEMANTIC_PENDING_VERSION, graph: complete }],
    body: [recordGet('source-id', input('payload'), 'sourcePieceId'), call('source', 'query.piece', { pieceId: output('source-id', 'value') }), call('selected', 'choice.selected-pieces', { targets: input('selectedTargets') }), call('valid-selection', 'spatial.formation-selection-valid', { source: output('source', 'piece'), selected: output('selected', 'pieces') }), branch('selection-check', output('valid-selection', 'value'), [call('centers', 'spatial.formation-candidates', { source: output('source', 'piece'), selected: output('selected', 'pieces') }, { range: 6 }), call('count', 'list.count-cells', { items: output('centers', 'cells') }), call('has-centers', 'compare.greater-than', { left: output('count', 'value'), right: literal(0) }), branch('center-check', output('has-centers', 'value'), [call('candidates', 'choice.from-cells', { cells: output('centers', 'cells') }), recordCreate('next-payload', payloadSelected.id, { sourcePieceId: output('source', 'piece'), selectedIds: output('selected', 'pieces') }), call('player-ref', 'ref.player'), call('player', 'player.require', { player: output('player-ref', 'player') }), { kind: 'defer-choice', id: 'center-choice', graph: 'turalyon-grand-crusade-complete', payload: output('next-payload', 'value'), player: output('player', 'player'), title: literal('圣光大远征：选择集结点'), targetType: literal('grid'), range: literal(6), filter: literal('all'), candidates: output('candidates', 'choices'), selectionMode: literal('single'), min: literal(1), max: literal(1), canCancel: literal(true), resumeOnCancel: literal(true) }, ...success('pending', '')], failure('no-centers', '没有可用集结点'))], failure('selection-failed', '选择的友方核心棋子无效'))],
  }
  const body: GameplayStatement[] = [call('caster-ref', 'ref.holder'), call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }), call('allies', 'query.pieces', { originId: output('caster', 'piece') }, { relation: 'ally', includeDead: false }), { kind: 'collection', id: 'core-allies', method: 'filter', items: output('allies', 'pieces'), item: 'piece', body: [call('core', 'piece.is-core', { piece: input('piece') }), ret('core-return', output('core', 'value'))] }, call('count', 'list.count-pieces', { items: output('core-allies', 'value') }), call('has-core', 'compare.greater-than', { left: output('count', 'value'), right: literal(0) }), branch('core-check', output('has-core', 'value'), [call('candidates', 'choice.from-pieces', { pieces: output('core-allies', 'value') }), call('source-id', 'piece.identifier', { piece: output('caster', 'piece') }), recordCreate('payload', payloadSource.id, { sourcePieceId: output('caster', 'piece') }), call('player-ref', 'ref.player'), call('player', 'player.require', { player: output('player-ref', 'player') }), { kind: 'defer-choice', id: 'piece-choice', graph: 'turalyon-grand-crusade-select-cell', payload: output('payload', 'value'), player: output('player', 'player'), title: literal('圣光大远征：选择1至3个友方核心棋子'), targetType: literal('piece'), range: literal(99), filter: literal('ally'), candidates: output('candidates', 'choices'), selectionMode: literal('multi'), min: literal(1), max: literal(3), canCancel: literal(true) }, ...success('pending', '')], failure('no-core', '没有可选择的友方核心棋子'))]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: RESULT_OUTPUTS, body, schemas: records(payloadSource), continuations: [{ id: 'turalyon-grand-crusade-select-cell', version: SEMANTIC_PENDING_VERSION, graph: selectCell }] }
}

function marchCancelledBody(prefix: string): GameplayStatement[] {
  return [
    call(`${prefix}-holder-ref`, 'ref.holder'),
    call(`${prefix}-holder`, 'query.piece', { pieceId: output(`${prefix}-holder-ref`, 'piece') }),
    call(`${prefix}-name`, 'attribute.text', { piece: output(`${prefix}-holder`, 'piece') }, { attribute: 'name' }),
    ...message(`${prefix}-cancelled`, [output(`${prefix}-name`, 'text'), literal('放弃了本次圣铸进军')]),
  ]
}

function buildMarchComplete(): GameplayModuleGraph {
  const completion: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    recordGet('mover-id', input('payload'), 'moverId'),
    call('mover', 'query.piece', { pieceId: output('mover-id', 'value') }),
    call('destinations', 'movement.adventure-destinations', { mover: output('mover', 'piece') }),
    call('valid', 'spatial.cell-in-list', { cell: input('targetCell'), cells: output('destinations', 'cells') }),
    call('free', 'spatial.cell-unoccupied', { cell: input('targetCell') }),
    branch('valid-check', output('valid', 'value'), [
      branch('free-check', output('free', 'value'), [
        call('move', 'movement.adventure-move', { mover: output('mover', 'piece'), destination: input('targetCell') }),
        branch('move-check', output('move', 'success'), [
          call('name', 'attribute.text', { piece: output('mover', 'piece') }, { attribute: 'name' }),
          call('coords', 'spatial.cell-coordinates-safe', { cell: input('targetCell') }),
          call('x', 'text.from-number', { value: output('coords', 'x') }),
          call('y', 'text.from-number', { value: output('coords', 'y') }),
          ...message('success', [output('name', 'text'), literal('完成圣铸进军，移动至('), output('x', 'text'), literal(','), output('y', 'text'), literal(')')]),
        ], message('blocked', [literal('位移被阻挡，本次位移效果取消')])),
      ], failure('invalid-destination', '远征移动的落点已失效')),
    ], failure('invalid-mover', '远征移动的落点已失效')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'pending',
    outputs: RESULT_OUTPUTS,
    hostBindings: { payload: { kind: 'record', schema: `${payloadMover.id}@${payloadMover.version}` }, targetCell: { kind: 'nullable', value: 'cell' } },
    schemas: records(payloadMover),
    body: [call('cancelled', 'event.cancelled'), branch('cancelled-check', output('cancelled', 'value'), marchCancelledBody('complete-cancel'), completion)],
  }
}

function buildMarchDestination(): GameplayModuleGraph {
  const selection: GameplayStatement[] = [
    recordGet('source-id', input('payload'), 'sourcePieceId'),
    call('selected', 'choice.selected-pieces', { targets: input('selectedTargets') }),
    call('selected-piece', 'list.first-piece', { items: output('selected', 'pieces') }),
    call('selected-piece-safe', 'piece.require', { piece: output('selected-piece', 'piece') }),
    call('count', 'list.count-pieces', { items: output('selected', 'pieces') }),
    call('one', 'compare.equal', { left: output('count', 'value'), right: literal(1) }),
    branch('one-check', output('one', 'value'), [
      call('mover', 'query.piece', { pieceId: output('selected-piece-safe', 'piece') }),
      call('destinations', 'movement.adventure-destinations', { mover: output('mover', 'piece') }),
      call('destination-count', 'list.count-cells', { items: output('destinations', 'cells') }),
      call('has-destination', 'compare.greater-than', { left: output('destination-count', 'value'), right: literal(0) }),
      branch('destination-check', output('has-destination', 'value'), [
        call('candidates', 'choice.from-cells', { cells: output('destinations', 'cells') }),
        recordCreate('mover-payload', payloadMover.id, { moverId: output('selected-piece-safe', 'piece') }),
        call('player-ref', 'ref.player'),
        call('player', 'player.require', { player: output('player-ref', 'player') }),
        call('name', 'attribute.text', { piece: output('mover', 'piece') }, { attribute: 'name' }),
        call('title', 'text.concat', { left: literal('圣铸进军：选择'), right: output('name', 'text') }),
        call('title-2', 'text.concat', { left: output('title', 'text'), right: literal('的落点（点击高亮格）') }),
        { kind: 'defer-choice', id: 'destination-choice', graph: 'turalyon-lightforged-march-complete', payload: output('mover-payload', 'value'), player: output('player', 'player'), title: output('title-2', 'text'), targetType: literal('grid'), filter: literal('all'), candidates: output('candidates', 'choices'), selectionMode: literal('single'), min: literal(1), max: literal(1), canCancel: literal(true), resumeOnCancel: literal(true) },
        ...success('pending', ''),
      ], failure('no-destination', '选择的远征角色已失效')),
    ], failure('mover-invalid', '选择的远征角色已失效')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'pending',
    outputs: RESULT_OUTPUTS,
    hostBindings: { payload: { kind: 'record', schema: `${payloadSource.id}@${payloadSource.version}` }, selectedTargets: list('choice') },
    schemas: records(payloadSource, payloadMover),
    body: [call('cancelled', 'event.cancelled'), branch('cancelled-check', output('cancelled', 'value'), marchCancelledBody('destination-cancel'), selection)],
  }
}

export function buildTuralyonLightforgedMarchGraph(): GameplayModuleGraph {
  const complete = buildMarchComplete()
  const destination: GameplayModuleGraph = { ...buildMarchDestination(), continuations: [{ id: 'turalyon-lightforged-march-complete', version: SEMANTIC_PENDING_VERSION, graph: complete }] }
  const noSelection: GameplayStatement[] = [
    call('allies', 'query.adventure-allies', { source: output('holder', 'piece') }),
    { kind: 'collection', id: 'movers', method: 'filter', items: output('allies', 'pieces'), item: 'piece', body: [
      call('position', 'piece.has-position', { piece: input('piece') }),
      call('destinations', 'movement.adventure-destinations', { mover: input('piece') }),
      call('count', 'list.count-cells', { items: output('destinations', 'cells') }),
      call('has', 'compare.greater-than', { left: output('count', 'value'), right: literal(0) }),
      call('valid', 'logic.and', { left: output('position', 'value'), right: output('has', 'value') }),
      ret('return', output('valid', 'value')),
    ] },
    call('candidate-count', 'list.count-pieces', { items: output('movers', 'value') }),
    call('has-movers', 'compare.greater-than', { left: output('candidate-count', 'value'), right: literal(0) }),
    branch('movers-check', output('has-movers', 'value'), [
      call('candidates', 'choice.from-pieces', { pieces: output('movers', 'value') }),
      recordCreate('payload', payloadSource.id, { sourcePieceId: output('holder', 'piece') }),
      call('mover-player-ref', 'ref.player'),
      call('mover-player', 'player.require', { player: output('mover-player-ref', 'player') }),
      { kind: 'defer-choice', id: 'piece-choice', graph: 'turalyon-lightforged-march-destination', payload: output('payload', 'value'), player: output('mover-player', 'player'), title: literal('圣铸进军：选择一名友方角色'), targetType: literal('piece'), filter: literal('ally'), candidates: output('candidates', 'choices'), selectionMode: literal('single'), min: literal(1), max: literal(1), canCancel: literal(true), resumeOnCancel: literal(true) },
      ...success('pending', ''),
    ], failure('no-movers', '')),
  ]
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('hp', 'attribute.read', { piece: output('holder', 'piece') }, { attribute: 'currentHp' }),
    call('alive', 'compare.greater-than', { left: output('hp', 'value'), right: literal(0) }),
    call('owner', 'piece.owner', { piece: output('holder', 'piece') }),
    call('player-ref', 'ref.player'),
    call('player', 'player.require', { player: output('player-ref', 'player') }),
    call('same-player', 'compare.equal-player', { left: output('owner', 'player'), right: output('player', 'player') }),
    call('active', 'logic.and', { left: output('alive', 'value'), right: output('same-player', 'value') }),
    call('card', 'event.card-id'),
    call('smite', 'compare.equal-string-nullable', { left: output('card', 'value'), right: literal('holy-smite') }),
    call('heal', 'compare.equal-string-nullable', { left: output('card', 'value'), right: literal('holy-heal') }),
    call('charge', 'compare.equal-string-nullable', { left: output('card', 'value'), right: literal('holy-charge') }),
    call('is-holy', 'logic.or', { left: output('smite', 'value'), right: output('heal', 'value') }),
    call('is-holy-2', 'logic.or', { left: output('is-holy', 'value'), right: output('charge', 'value') }),
    call('eligible', 'logic.and', { left: output('active', 'value'), right: output('is-holy-2', 'value') }),
    branch('eligible-check', output('eligible', 'value'), [
      call('cancelled', 'event.cancelled'),
      branch('cancelled-check', output('cancelled', 'value'), [
        call('name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
        ...message('cancelled', [output('name', 'text'), literal('放弃了本次圣铸进军')]),
      ], noSelection),
    ], failure('inactive', '')),
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: RESULT_OUTPUTS, schemas: records(payloadSource, payloadMover), body, continuations: [{ id: 'turalyon-lightforged-march-destination', version: SEMANTIC_PENDING_VERSION, graph: destination }, { id: 'turalyon-lightforged-march-complete', version: SEMANTIC_PENDING_VERSION, graph: complete }] }
}

export function buildTuralyonExpeditionOrderGraph(): GameplayModuleGraph {
  const selected: GameplayStatement[] = [
    call('selected', 'choice.raw-string-value', { choice: output('choice', 'choice') }),
    call('is-smite', 'compare.equal-string-nullable', { left: output('selected', 'value'), right: literal('holy-smite') }),
    call('is-heal', 'compare.equal-string-nullable', { left: output('selected', 'value'), right: literal('holy-heal') }),
    call('is-charge', 'compare.equal-string-nullable', { left: output('selected', 'value'), right: literal('holy-charge') }),
    call('name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }),
    branch('card-selection', output('is-smite', 'value'), [
      call('add-smite', 'card.hand-add', { player: output('owner', 'player') }, { cardId: 'holy-smite' }),
      ...message('smite-success', [output('name', 'text'), literal('发布征讨号令，获得1张圣光手牌')]),
    ], [
      branch('heal-selection', output('is-heal', 'value'), [
        call('add-heal', 'card.hand-add', { player: output('owner', 'player') }, { cardId: 'holy-heal' }),
        ...message('heal-success', [output('name', 'text'), literal('发布征讨号令，获得1张圣光手牌')]),
      ], [
        branch('charge-selection', output('is-charge', 'value'), [
          call('add-charge', 'card.hand-add', { player: output('owner', 'player') }, { cardId: 'holy-charge' }),
          ...message('charge-success', [output('name', 'text'), literal('发布征讨号令，获得1张圣光手牌')]),
        ], failure('invalid-selection', '无效的圣光手牌选择')),
      ]),
    ]),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: RESULT_OUTPUTS,
    body: [
      call('caster-ref', 'ref.holder'),
      call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }),
      call('owner', 'piece.owner', { piece: output('caster', 'piece') }),
      call('player', 'player.require', { player: output('owner', 'player') }),
      call('choice', 'choice.string-options', {}, { title: '征讨号令：选择一种圣光手牌', options: ['holy-smite', 'holy-heal', 'holy-charge'], labels: ['圣光惩戒', '圣光治疗', '圣光充能'] }),
      call('choice-unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
      returnUnresolvedChoice('pending-choice', 'choice-unresolved', 'choice'),
      ...selected,
    ],
  }
}

export function buildMinatoPassiveGraph(): GameplayModuleGraph { return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: RESULT_OUTPUTS, body: failure('passive', '') } }

export function buildTuralyonLightforgedMarchSkillGraph(): GameplayModuleGraph { return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'success', type: 'boolean' }], body: [{ kind: 'return', id: 'noop', values: { success: literal(true) } }] } }

export const SEMANTIC_PENDING_MIGRATIONS: readonly PendingMigration[] = Object.freeze([
  { id: 'skills/minato-rasengan', field: 'code', surface: 'skill', build: buildMinatoRasenganGraph },
  { id: 'skills/minato-kunai-formula', field: 'code', surface: 'skill', build: buildMinatoKunaiFormulaGraph },
  { id: 'skills/minato-spiral-barrage', field: 'code', surface: 'skill', build: buildMinatoSpiralBarrageGraph },
  { id: 'skills/minato-flying-raijin-passive', field: 'code', surface: 'skill', build: buildMinatoPassiveGraph },
  { id: 'skills/turalyon-expedition-order', field: 'code', surface: 'skill', build: buildTuralyonExpeditionOrderGraph },
  { id: 'skills/turalyon-lightforged-march', field: 'code', surface: 'skill', build: buildTuralyonLightforgedMarchSkillGraph },
  { id: 'skills/turalyon-grand-crusade', field: 'code', surface: 'skill', build: buildTuralyonGrandCrusadeGraph },
  { id: 'rules/rule-minato-anchor-end-turn', field: 'skillCode', surface: 'rule', build: buildMinatoAnchorEndTurnGraph },
  { id: 'rules/rule-minato-flying-raijin-trigger', field: 'skillCode', surface: 'rule', build: buildMinatoFlyingRaijinTriggerGraph },
  { id: 'rules/rule-turalyon-lightforged-march', field: 'skillCode', surface: 'rule', build: buildTuralyonLightforgedMarchGraph },
])
export const SEMANTIC_PENDING_MIGRATION_IDS = Object.freeze(SEMANTIC_PENDING_MIGRATIONS.map(entry => `${entry.id}.${entry.field}`))

function record(value: unknown): value is JsonRecord { return !!value && typeof value === 'object' && !Array.isArray(value) }
function canonical(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as JsonRecord)[key])}`).join(',')}}` }
const GENERATED = new Set(['code', 'skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules'])
function generatedFields(value: JsonRecord): Set<string> { const result = new Set(GENERATED); if (typeof value.contentGraphField === 'string') result.add(value.contentGraphField); if (record(value.contentGraphEntries)) Object.keys(value.contentGraphEntries).forEach(key => result.add(key)); if (record(value.gameplayModules) && record(value.gameplayModules.entries)) Object.keys(value.gameplayModules.entries).forEach(key => result.add(key)); return result }
function assertCompatibility(current: JsonRecord, baseline: JsonRecord, id: string): void { const generated = generatedFields(current); for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) { if (generated.has(key) || key === 'cluster') continue; if (canonical(current[key]) !== canonical(baseline[key])) throw new Error(`${id}: compatibility field changed before semantic migration: ${key}`) } }
function migrateOne(root: string, baseline: JsonRecord, entry: PendingMigration): JsonRecord { if (!record(baseline.entries) || !record(baseline.entries[entry.id])) throw new Error(`${entry.id}: not in frozen RED-252 baseline`); const expected = baseline.entries[entry.id] as JsonRecord; const file = path.join(root, 'data', `${entry.id}.json`); if (!fs.existsSync(file)) throw new Error(`${entry.id}: production file does not exist`); const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord; if (typeof current[entry.field] !== 'string' || typeof expected[entry.field] !== 'string') throw new Error(`${entry.id}: missing ${entry.field}`); assertCompatibility(current, expected, entry.id); const next = applyGameplayModuleGraph(current, entry.build(), entry.field) as JsonRecord; assertGameplayModuleDocument(next); const generated = generatedFields(current); for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) { if (generated.has(key) || key === 'cluster') continue; if (canonical(current[key]) !== canonical(next[key])) throw new Error(`${entry.id}: migration changed compatibility field: ${key}`) } return next }
function selected(ids?: readonly string[]): readonly PendingMigration[] { if (!ids?.length) return SEMANTIC_PENDING_MIGRATIONS; const known = new Set(SEMANTIC_PENDING_MIGRATION_IDS.flatMap(id => [id, id.slice(0, id.lastIndexOf('.'))])); const unknown = ids.filter(id => !known.has(id)); if (unknown.length) throw new Error(`Unknown semantic pending migration: ${unknown.join(', ')}`); return SEMANTIC_PENDING_MIGRATIONS.filter(entry => ids.includes(entry.id) || ids.includes(`${entry.id}.${entry.field}`)) }
export function runSemanticPendingMigrations(root: string, baseline: JsonRecord, ids?: readonly string[]): PendingRun {
  const migrations = selected(ids), reports: PendingReport[] = [], documents = new Map<string, JsonRecord>()
  for (const entry of migrations) {
    const file = path.join(root, 'data', `${entry.id}.json`)
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
      const hasEntry = record(current.gameplayModules) && record(current.gameplayModules.entries) && record(current.gameplayModules.entries[entry.field])
      // Recompile an existing semantic document when a closed registry lowerer
      // or compiler changed.  A graph artifact alone is not proof that its
      // generated executable still matches the current registry.
      const document = migrateOne(root, baseline, entry)
      const unchanged = hasEntry && canonical(current[entry.field]) === canonical(document[entry.field]) && canonical(current.gameplayModules) === canonical(document.gameplayModules)
      if (unchanged) reports.push({ id: entry.id, field: entry.field, surface: entry.surface, status: 'already-migrated', file })
      else {
        documents.set(file, document)
        reports.push({ id: entry.id, field: entry.field, surface: entry.surface, status: 'ready', reason: hasEntry ? 'regenerated-current-compiler' : undefined, document, file })
      }
    } catch (error) {
      reports.push({ id: entry.id, field: entry.field, surface: entry.surface, status: 'blocked', reason: error instanceof Error ? error.message : String(error), file })
    }
  }
  return { migrations, reports, documents }
}
function cli(): void { const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const args = process.argv.slice(2), write = args.includes('--write'), ids = args.filter(arg => arg !== '--write'); const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'), 'utf8')) as JsonRecord; const run = runSemanticPendingMigrations(root, baseline, ids), blocked = run.reports.filter(report => report.status === 'blocked'); if (write && blocked.length) throw new Error(JSON.stringify({ message: 'Semantic pending migration is blocked; no production files were written.', blocked }, null, 2)); if (write) for (const [file, document] of run.documents) fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8'); console.log(JSON.stringify({ mode: write ? 'written' : 'dry-run', compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION, graphVersion: GAMEPLAY_MODULE_GRAPH_VERSION, baseSha: baseline.baseSha, migrations: run.reports.map(({ id, field, surface, status, reason }) => ({ id, field, surface, status, reason })) }, null, 2)); if (blocked.length) process.exitCode = 1 }
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()
