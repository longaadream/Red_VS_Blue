import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  assertGameplayModuleDocument,
  type GameplayJsonValue,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleSurface,
  type GameplayPort,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'
import { compileGameplayModuleGraph } from '../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../lib/skill-graph/module-registry'
import { assertFrozenExecutable } from './semantic-migration-source'

export const SEMANTIC_MOVEMENT_FAMILY_VERSION = '1' as const
export const MOVEMENT_FAMILY_SKILL_IDS = [
  'skills/shadow-step',
  'skills/shadow-step-teleport',
  'skills/obito-ally-teleport',
  'skills/obito-space-time',
  'skills/akaza-flash-step',
  'skills/sonic-spin-dash',
  'skills/sonic-homing-attack',
  'skills/shadow-ride-sweep',
  'skills/illidan-blade-dash',
  'skills/mortis-shovel-charge',
  'skills/el-primo-elbow',
  'skills/edgar-pogo-jump',
  'skills/max-phase-shifter',
  'skills/alfonso-kick',
  'skills/alfonso-water-dash',
  'skills/rocket-punch',
  'skills/muzan-demon-body',
  'skills/venom-host-transfer',
  'skills/venom-symbiote-drag',
] as const

type JsonRecord = Record<string, unknown>
type GraphField = 'code'

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const inputValue = (name: string): GameplayValue => ({ kind: 'input', name })
const port = (name: string, type: GameplayPort['type'], options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })

function call(id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}, parameters: Readonly<Record<string, GameplayJsonValue>> = {}): GameplayStatement {
  return { kind: 'call', id, module, version: SEMANTIC_MOVEMENT_FAMILY_VERSION, inputs, parameters }
}

function branch(id: string, condition: GameplayValue, then: readonly GameplayStatement[], otherwise: readonly GameplayStatement[] = []): GameplayStatement {
  return { kind: 'if', id, condition, then, else: otherwise }
}

function returnValue(id: string, value: GameplayValue): GameplayStatement { return { kind: 'return', id, value } }
function resultAction(id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] {
  return [call(id + '-result', 'result.action', { success, message }), returnValue(id + '-return', output(id + '-result', 'result'))]
}

function failureAction(id: string, message: string): GameplayStatement[] { return resultAction(id, literal(false), literal(message)) }
function cancelledAction(id: string, message: string): GameplayStatement[] { return resultAction(id, literal(true), literal(message)) }
function emptyAction(id: string): GameplayStatement[] { return resultAction(id, literal(false), literal('')) }
function pendingReturn(id: string, choiceNode: string): GameplayStatement[] {
  return [call(id + '-result', 'choice.as-result', { choice: output(choiceNode, 'choice') }), returnValue(id + '-return', output(id + '-result', 'result'))]
}

function appendText(body: GameplayStatement[], id: string, left: GameplayValue, right: GameplayValue): GameplayValue {
  body.push(call(id, 'text.concat', { left, right }))
  return output(id, 'text')
}

function appendedResult(id: string, success: GameplayValue, left: GameplayValue, right: GameplayValue): GameplayStatement[] {
  const body: GameplayStatement[] = []
  const message = appendText(body, id + '-message', left, right)
  body.push(...resultAction(id, success, message))
  return body
}

function collectionMap(id: string, items: GameplayValue, body: readonly GameplayStatement[], inputs: Readonly<Record<string, GameplayValue>> = {}): GameplayStatement {
  return { kind: 'collection.map', id, items, ...(Object.keys(inputs).length ? { inputs } : {}), body } as GameplayStatement
}

function graph(body: readonly GameplayStatement[], schemas?: readonly GameplayRecordSchema[]): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [port('result', 'record', { nullable: true })],
    ...(schemas ? { schemas } : {}),
    body,
  }
}

const SHADOW_STEP_SCHEMA: GameplayRecordSchema = {
  id: 'movement.shadow-step-marker', version: SEMANTIC_MOVEMENT_FAMILY_VERSION,
  fields: [
    port('id', 'string'), port('type', 'string'), port('name', 'string'), port('remainingDuration', 'number'),
    port('value', 'number'), port('intensity', 'number'), port('relatedRules', { kind: 'list', element: 'string' }),
  ],
}

function buildShadowStepGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('target-choice', 'choice.target-cell', {}, { range: 7, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice')),
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('walkable', 'spatial.cell-walkable', { cell: output('target', 'cell') }),
  ]
  const vacantBody: GameplayStatement[] = [
    call('source-id', 'piece.identifier', { piece: output('source', 'piece') }),
    call('source-id-text', 'text.concat', { left: literal('shadow-step-'), right: output('source-id', 'id') }),
    call('target-coordinates', 'spatial.cell-coordinates', { cell: output('target', 'cell') }),
    call('existing-id', 'status.find-id', { piece: output('source', 'piece') }, { statusType: 'shadow-step' }),
    call('existing', 'value.present-string', { value: output('existing-id', 'id') }),
    branch('existing-branch', output('existing', 'present'), [
      call('clear-existing-tile', 'tile.clear-marker', { sourceId: output('source-id-text', 'text') }, { effectType: 'shadow-step' }),
      call('refresh-existing', 'status.refresh-position', { target: output('source', 'piece'), x: output('target-coordinates', 'x'), y: output('target-coordinates', 'y') }, { statusType: 'shadow-step', duration: 2 }),
    ], [
      call('now', 'identity.host-time'),
      call('now-text', 'text.from-number', { value: output('now', 'value') }),
      call('status-id', 'text.concat', { left: literal('shadow-step-'), right: output('now-text', 'text') }),
      { kind: 'record.create', id: 'status-record', schema: SHADOW_STEP_SCHEMA.id, fields: {
        id: output('status-id', 'text'), type: literal('shadow-step'), name: literal('暗影步'), remainingDuration: literal(2),
        value: output('target-coordinates', 'x'), intensity: output('target-coordinates', 'y'), relatedRules: literal(['rule-shadow-step']),
      } },
      call('apply-status', 'status.apply-record', { target: output('source', 'piece'), record: output('status-record', 'value') }, { inputPolicy: 'host' }),
    ]),
    call('add-tile', 'tile.add-marker', { cell: output('target', 'cell'), sourceId: output('source-id-text', 'text') }, {
      effectType: 'shadow-step', icon: '👁', bgColor: 'rgba(147, 51, 234, 0.12)',
      boxShadow: 'inset 0 0 0 2px rgba(168, 85, 247, 0.65)', iconPosition: 'top-left',
    }),
    call('has-rule', 'rule.has-piece', { piece: output('source', 'piece') }, { ruleId: 'rule-shadow-step' }),
    branch('rule-guard', output('has-rule', 'value'), [], [
      call('add-rule', 'rule.apply-piece', { target: output('source', 'piece') }, { ruleId: 'rule-shadow-step' }),
    ]),
    call('x-text', 'text.from-number', { value: output('target-coordinates', 'x') }),
    call('y-text', 'text.from-number', { value: output('target-coordinates', 'y') }),
  ]
  const messageBody: GameplayStatement[] = []
  let message: GameplayValue = output('source-name', 'text')
  message = appendText(messageBody, 'message-prefix', message, literal('标记了暗影步位置，将在下回合开始时传送到('))
  message = appendText(messageBody, 'message-x', message, output('x-text', 'text'))
  message = appendText(messageBody, 'message-separator', message, literal(','))
  message = appendText(messageBody, 'message-y', message, output('y-text', 'text'))
  message = appendText(messageBody, 'message-suffix', message, literal(')'))
  messageBody.push(...resultAction('success', literal(true), message))
  vacantBody.push(...messageBody)
  const markBody: GameplayStatement[] = [
    call('vacant', 'spatial.cell-unoccupied', { cell: output('target', 'cell') }),
    branch('vacant-guard', output('vacant', 'value'), vacantBody, failureAction('occupied', '目标位置已被占用')),
  ]
  sourceBody.push(branch('walkable-guard', output('walkable', 'walkable'), markBody, failureAction('not-walkable', '目标位置不可行走')))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body, [SHADOW_STEP_SCHEMA])
}

function shadowCleanup(id: string, reason: string): GameplayStatement[] {
  return [
    call(id + '-clear-tile', 'tile.clear-marker', { sourceId: output('source-id-text', 'text') }, { effectType: 'shadow-step' }),
    call(id + '-remove-status', 'status.remove-record', { piece: output('source', 'piece'), value: literal('shadow-step') }, { selector: 'type' }),
    call(id + '-message', 'text.concat', { left: output('source-name', 'text'), right: literal('的暗影步' + reason + '，传送取消') }),
    ...resultAction(id, literal(true), output(id + '-message', 'text')),
  ]
}

function buildShadowStepTeleportGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('source-id', 'piece.identifier', { piece: output('source', 'piece') }),
    call('source-id-text', 'text.concat', { left: literal('shadow-step-'), right: output('source-id', 'id') }),
    call('status-id', 'status.find-id', { piece: output('source', 'piece') }, { statusType: 'shadow-step' }),
    call('status-present', 'value.present-string', { value: output('status-id', 'id') }),
  ]
  const statusBody: GameplayStatement[] = [
    call('duration', 'status.read-duration', { piece: output('source', 'piece'), statusId: output('status-id', 'id'), fallback: literal(0) }),
    call('duration-live', 'compare.greater-than', { left: output('duration', 'value'), right: literal(0) }),
  ]
  const ownerBody: GameplayStatement[] = [
    call('current-player', 'turn.current-player'),
    call('owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('owner-turn', 'compare.equal-player', { left: output('owner', 'player'), right: output('current-player', 'player') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target-x', 'status.read-number', { piece: output('source', 'piece'), statusId: output('status-id', 'id'), fallback: literal(0) }, { field: 'value' }),
    call('target-y', 'status.read-number', { piece: output('source', 'piece'), statusId: output('status-id', 'id'), fallback: literal(0) }, { field: 'intensity' }),
    call('target-cell', 'spatial.cell', { x: output('target-x', 'value'), y: output('target-y', 'value') }),
    call('walkable', 'spatial.cell-walkable', { cell: output('target-cell', 'cell') }),
  ]
  const commitBody: GameplayStatement[] = [
    call('vacant', 'spatial.cell-unoccupied', { cell: output('target-cell', 'cell') }),
    branch('vacant-guard', output('vacant', 'value'), [
      call('clear-before-move', 'tile.clear-marker', { sourceId: output('source-id-text', 'text') }, { effectType: 'shadow-step' }),
      call('move', 'effect.teleport', { piece: output('source', 'piece'), destination: output('target-cell', 'cell') }, { kind: 'teleport' }),
      branch('move-guard', output('move', 'success'), [
        call('remove-status', 'status.remove-record', { piece: output('source', 'piece'), value: literal('shadow-step') }, { selector: 'type' }),
        call('x-text', 'text.from-number', { value: output('target-x', 'value') }),
        call('y-text', 'text.from-number', { value: output('target-y', 'value') }),
        call('message-prefix', 'text.concat', { left: output('source-name', 'text'), right: literal('通过暗影步传送到了(') }),
        call('message-x', 'text.concat', { left: output('message-prefix', 'text'), right: output('x-text', 'text') }),
        call('message-separator', 'text.concat', { left: output('message-x', 'text'), right: literal(',') }),
        call('message-y', 'text.concat', { left: output('message-separator', 'text'), right: output('y-text', 'text') }),
        call('message', 'text.concat', { left: output('message-y', 'text'), right: literal(')') }),
        ...resultAction('success', literal(true), output('message', 'text')),
      ], shadowCleanup('blocked', '被阻挡')),
    ], shadowCleanup('occupied', '目标位置已被占用')),
  ]
  targetBody.push(branch('walkable-guard', output('walkable', 'walkable'), commitBody, shadowCleanup('terrain', '目标位置不可行走')))
  ownerBody.push(branch('owner-guard', output('owner-turn', 'value'), targetBody, emptyAction('wrong-player')))
  statusBody.push(branch('duration-guard', output('duration-live', 'value'), ownerBody, emptyAction('expired')))
  sourceBody.push(branch('status-guard', output('status-present', 'present'), statusBody, emptyAction('missing-status')))
  return graph(body.concat([branch('source-guard', output('source-present', 'exists'), sourceBody, emptyAction('missing-source'))]))
}

function buildObitoAllyTeleportGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('ally-choice', 'choice.target-piece', {}, { range: 7, filter: 'ally' }),
    call('ally-unresolved', 'choice.is-unresolved', { choice: output('ally-choice', 'choice') }),
    branch('ally-wait-or-cancel', output('ally-unresolved', 'value'), pendingReturn('ally-pending', 'ally-choice')),
    call('ally', 'choice.piece', { choice: output('ally-choice', 'choice') }),
    call('target-choice', 'choice.target-cell', {}, { range: 7, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice')),
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('same', 'compare.equal-piece', { left: output('ally', 'piece'), right: output('source', 'piece') }),
    call('source-owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('ally-owner', 'piece.owner', { piece: output('ally', 'piece') }),
    call('allied', 'compare.allied-players', { left: output('source-owner', 'player'), right: output('ally-owner', 'player') }),
    call('ally-distance', 'query.distance', { from: output('source', 'piece'), to: output('ally', 'piece') }),
    call('ally-in-range', 'compare.less-or-equal', { left: output('ally-distance', 'distance'), right: literal(7) }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('target-distance', 'spatial.cell-distance', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
    call('target-in-range', 'compare.less-or-equal', { left: output('target-distance', 'distance'), right: literal(7) }),
    call('not-same', 'logic.not', { value: output('same', 'value') }),
    call('not-allied', 'logic.not', { value: output('allied', 'value') }),
    call('not-ally-range', 'logic.not', { value: output('ally-in-range', 'value') }),
    call('not-target-range', 'logic.not', { value: output('target-in-range', 'value') }),
    call('bad-same-allied', 'logic.or', { left: output('same', 'value'), right: output('not-allied', 'value') }),
    call('bad-ally-range', 'logic.or', { left: output('not-ally-range', 'value'), right: output('not-target-range', 'value') }),
    call('invalid', 'logic.or', { left: output('bad-same-allied', 'value'), right: output('bad-ally-range', 'value') }),
  ]
  const valid: GameplayStatement[] = [
    call('ally-name', 'attribute.text', { piece: output('ally', 'piece') }, { attribute: 'name' }),
    call('target-coordinates', 'spatial.cell-coordinates', { cell: output('target', 'cell') }),
    call('x-text', 'text.from-number', { value: output('target-coordinates', 'x') }),
    call('y-text', 'text.from-number', { value: output('target-coordinates', 'y') }),
    call('move', 'effect.teleport', { piece: output('ally', 'piece'), destination: output('target', 'cell') }, { kind: 'teleport' }),
    branch('move-guard', output('move', 'success'), [
      call('message-prefix', 'text.concat', { left: output('source-name', 'text'), right: literal('将') }),
      call('message-ally', 'text.concat', { left: output('message-prefix', 'text'), right: output('ally-name', 'text') }),
      call('message-pos', 'text.concat', { left: output('message-ally', 'text'), right: literal('传送至(') }),
      call('message-x', 'text.concat', { left: output('message-pos', 'text'), right: output('x-text', 'text') }),
      call('message-separator', 'text.concat', { left: output('message-x', 'text'), right: literal(',') }),
      call('message-y', 'text.concat', { left: output('message-separator', 'text'), right: output('y-text', 'text') }),
      call('message', 'text.concat', { left: output('message-y', 'text'), right: literal(')') }),
      ...resultAction('success', literal(true), output('message', 'text')),
    ], failureAction('blocked', '友军无法传送至该落点')),
  ]
  sourceBody.push(branch('invalid-guard', output('invalid', 'value'), failureAction('invalid', '神威转移目标不合法'), valid))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildObitoSpaceTimeGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('target-choice', 'choice.target-piece', {}, { range: 99, filter: 'enemy' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice')),
    call('target', 'choice.piece', { choice: output('target-choice', 'choice') }),
    call('target-name', 'piece.display-name', { piece: output('target', 'piece') }, { fallback: 'templateId' }),
    call('remove', 'lifecycle.remove-enemy', { target: output('target', 'piece') }),
  ]
  const removed: GameplayStatement[] = [
    call('message-1', 'text.concat', { left: output('source-name', 'text'), right: literal('发动神威，将') }),
    call('message-2', 'text.concat', { left: output('message-1', 'text'), right: output('target-name', 'value') }),
    call('message-3', 'text.concat', { left: output('message-2', 'text'), right: literal('强制移出战场') }),
    ...resultAction('success', literal(true), output('message-3', 'text')),
  ]
  sourceBody.push(branch('remove-guard', output('remove', 'success'), removed, failureAction('blocked', '目标无法被神威移除')))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildAkazaFlashStepGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('target-choice', 'choice.target-piece', {}, { range: 3, filter: 'enemy' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice')),
    call('target', 'choice.piece', { choice: output('target-choice', 'choice') }),
    call('cell-choice', 'choice.target-cell', {}, { range: 99, filter: 'all' }),
    call('cell-unresolved', 'choice.is-unresolved', { choice: output('cell-choice', 'choice') }),
    branch('cell-wait-or-cancel', output('cell-unresolved', 'value'), pendingReturn('cell-pending', 'cell-choice')),
    call('cell', 'choice.cell', { choice: output('cell-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('source-alive', 'piece.alive', { piece: output('source', 'piece') }),
    call('target-present', 'query.has-piece', { pieceId: output('target', 'piece') }),
  ]
  const validTarget: GameplayStatement[] = [
    call('target-alive', 'piece.alive', { piece: output('target', 'piece') }),
    call('target-position', 'spatial.piece-position', { piece: output('target', 'piece') }),
    call('source-owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('target-owner', 'piece.owner', { piece: output('target', 'piece') }),
    call('allied', 'compare.allied-players', { left: output('source-owner', 'player'), right: output('target-owner', 'player') }),
    call('target-delta', 'spatial.cell-delta', { from: output('source-position', 'cell'), to: output('target-position', 'cell') }),
    call('target-range', 'compare.less-or-equal', { left: output('target-delta', 'chebyshev'), right: literal(3) }),
    call('not-allied', 'logic.not', { value: output('allied', 'value') }),
    call('target-valid-1', 'logic.and', { left: output('target-alive', 'alive'), right: output('not-allied', 'value') }),
    call('target-valid-2', 'logic.and', { left: output('target-valid-1', 'value'), right: output('target-range', 'value') }),
  ]
  const markedBody: GameplayStatement[] = [
    call('marked', 'status.has-source-mark', { target: output('target', 'piece'), source: output('source', 'piece') }, { statusType: 'akaza-damaged' }),
  ]
  const landingBody: GameplayStatement[] = [
    call('adjacent', 'spatial.cell-adjacent', { left: output('target-position', 'cell'), right: output('cell', 'cell') }),
    call('walkable', 'spatial.cell-walkable-safe', { cell: output('cell', 'cell') }),
    call('vacant', 'spatial.cell-unoccupied', { cell: output('cell', 'cell') }),
  ]
  const movedBody: GameplayStatement[] = [
    call('still-present', 'query.has-piece', { pieceId: output('source', 'piece') }),
    branch('still-present-guard', output('still-present', 'exists'), [
      call('still-alive', 'piece.alive', { piece: output('source', 'piece') }),
      branch('still-alive-guard', output('still-alive', 'alive'), [
        call('attack', 'attribute.adjust', { piece: output('source', 'piece'), amount: literal(1) }, { attribute: 'attack' }),
        call('active-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
        call('message', 'text.concat', { left: output('active-name', 'text'), right: literal('发动瞬步，攻击力永久+1') }),
        ...resultAction('success', literal(true), output('message', 'text')),
      ], [call('inactive-message-after-alive', 'text.concat', { left: literal('猗窝座'), right: literal('在瞬步接触结算后已失效') }), ...resultAction('inactive-after-alive', literal(true), output('inactive-message-after-alive', 'text'))]),
    ], [call('inactive-message-after-present', 'text.concat', { left: literal('猗窝座'), right: literal('在瞬步接触结算后已失效') }), ...resultAction('inactive-after-present', literal(true), output('inactive-message-after-present', 'text'))]),
  ]
  const commitBody: GameplayStatement[] = [
    call('move', 'effect.teleport-with-change', { piece: output('source', 'piece'), destination: output('cell', 'cell') }, { kind: 'teleport' }),
    branch('move-guard', output('move', 'success'), [
      branch('changed-guard', output('move', 'changed'), movedBody, cancelledAction('unchanged', '瞬步没有产生实际位移，本次效果取消')),
    ], cancelledAction('blocked', '瞬步位移被阻挡，本次效果取消')),
  ]
  landingBody.push(branch('adjacent-guard', output('adjacent', 'value'), [
    branch('walkable-guard', output('walkable', 'value'), [
      branch('vacant-guard', output('vacant', 'value'), commitBody, failureAction('occupied', '瞬步落点已被占用')),
    ], failureAction('terrain', '瞬步落点不可行走')),
  ], failureAction('adjacent', '瞬步落点必须是目标的正方向相邻地格')))
  markedBody.push(branch('marked-guard', output('marked', 'value'), landingBody, failureAction('unmarked', '目标必须是本局内曾被猗窝座实际造成过伤害的敌军')))
  validTarget.push(branch('target-valid-guard', output('target-valid-2', 'value'), markedBody, failureAction('target-invalid', '瞬步目标已失效')))
  sourceBody.push(branch('source-alive-guard', output('source-alive', 'alive'), [
    branch('target-present-guard', output('target-present', 'exists'), validTarget, failureAction('target-missing', '瞬步目标已失效')),
  ], failureAction('source-invalid', '瞬步施法者已失效')))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '瞬步施法者已失效')))
  return graph(body)
}

const SONIC_SILENCE_SCHEMA: GameplayRecordSchema = {
  id: 'movement.sonic-silence', version: SEMANTIC_MOVEMENT_FAMILY_VERSION,
  fields: [
    port('id', 'string'), port('type', 'string'), port('name', 'string'), port('stacks', 'number'),
    port('currentDuration', 'number'), port('relatedRules', { kind: 'list', element: 'string' }),
  ],
}

const SHADOW_RIDE_SIDE_SCHEMA: GameplayRecordSchema = {
  id: 'movement.shadow-ride-side', version: SEMANTIC_MOVEMENT_FAMILY_VERSION,
  fields: [
    port('id', 'string'), port('type', 'string'), port('name', 'string'), port('pathCells', { kind: 'list', element: 'cell' }),
    port('dx', 'number'), port('dy', 'number'), port('damage', 'number'), port('left', 'cell'), port('right', 'cell'),
    port('currentDuration', 'number'), port('lifetime', 'string'), port('currentUses', 'number'), port('visible', 'boolean'),
  ],
}

function buildSonicSpinDashGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-id', 'source.captured-identifier', { source: output('source-capture', 'source') }),
    call('core-instance', 'status.find-instance', { piece: output('source', 'piece') }, { statusType: 'momentum-core' }),
    call('fallback-momentum', 'piece.momentum', { piece: output('source', 'piece') }),
    call('momentum', 'status.read-number-instance', { status: output('core-instance', 'status'), fallback: output('fallback-momentum', 'value') }, { field: 'stacks' }),
    call('powered', 'compare.greater-or-equal', { left: output('momentum', 'value'), right: literal(5) }),
    call('max-distance', 'value.select-number', { condition: output('powered', 'value'), whenTrue: literal(7), whenFalse: literal(5) }),
    call('target-choice', 'choice.target-cell-by-range', { range: output('max-distance', 'value') }, { filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice')),
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
    call('range-ok', 'compare.less-or-equal', { left: output('direction', 'distance'), right: output('max-distance', 'value') }),
    call('direction-ok', 'logic.and', { left: output('direction', 'valid'), right: output('range-ok', 'value') }),
  ]
  const validBody: GameplayStatement[] = [
    // The range limit controls which cells may be selected, but the selected
    // endpoint controls how far the dash actually travels.  Passing the
    // maximum here silently extended a short selection to the far edge.
    call('trace', 'movement.trace', { source: output('source', 'piece'), direction: output('direction', 'direction'), maxDistance: output('direction', 'distance') }, { passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: ['wall', 'trap', 'hole'] }),
    call('first-enemy', 'piece.reference-present', { piece: output('trace', 'firstEnemy') }),
    call('first-enemy-ref', 'piece.require', { piece: output('trace', 'firstEnemy') }),
  ]
  const momentumUpdate = (id: string, steps: GameplayValue): GameplayStatement[] => [
    call(id + '-preserved', 'source.captured-has-status', { source: output('source-capture', 'source') }, { statusType: 'preserve-momentum' }),
    call(id + '-base', 'value.select-number', { condition: output(id + '-preserved', 'value'), whenTrue: output('momentum', 'value'), whenFalse: literal(0) }),
    call(id + '-next', 'math.add', { left: output(id + '-base', 'value'), right: steps }),
    call(id + '-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
    branch(id + '-write', output(id + '-present', 'exists'), [
      call(id + '-set-momentum', 'attribute.set-momentum', { piece: output('source', 'piece'), value: output(id + '-next', 'value') }),
      call(id + '-set-core', 'status.set-number-instance', { status: output('core-instance', 'status'), value: output(id + '-next', 'value') }, { field: 'stacks' }),
    ]),
  ]
  const enemyAfter = (id: string, steps: GameplayValue): GameplayStatement[] => [
    call(id + '-attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
    call(id + '-scaled', 'math.multiply', { left: output(id + '-attack', 'value'), right: literal(1.5) }),
    call(id + '-amount', 'math.floor', { value: output(id + '-scaled', 'value') }),
    call(id + '-damage', 'effect.damage-captured', { source: output('source-capture', 'source'), target: output('enemy-capture', 'source'), amount: output(id + '-amount', 'value') }, { damageType: 'physical', skillId: 'sonic-spin-dash' }),
    call(id + '-name', 'piece.captured-name', { source: output('enemy-capture', 'source') }, { fallback: 'none' }),
    call(id + '-damage-number', 'effect.result-number', { result: output(id + '-damage', 'result') }, { field: 'damage' }),
    call(id + '-damage-text', 'text.from-number', { value: output(id + '-damage-number', 'value') }),
    call(id + '-hit-prefix', 'text.concat', { left: literal('命中'), right: output(id + '-name', 'value') }),
    call(id + '-hit-open', 'text.concat', { left: output(id + '-hit-prefix', 'text'), right: literal('(-') }),
    call(id + '-hit-number', 'text.concat', { left: output(id + '-hit-open', 'text'), right: output(id + '-damage-text', 'text') }),
    call(id + '-hit', 'text.concat', { left: output(id + '-hit-number', 'text'), right: literal(')') }),
    call(id + '-silence-enabled', 'compare.greater-or-equal', { left: output('momentum', 'value'), right: literal(7) }),
    branch(id + '-empowered-silence', output(id + '-silence-enabled', 'value'), [
      call(id + '-target-alive', 'piece.alive', { piece: output('first-enemy-ref', 'piece') }),
      branch(id + '-silence', output(id + '-target-alive', 'alive'), [
        call(id + '-enemy-id', 'source.captured-identifier', { source: output('enemy-capture', 'source') }),
        call(id + '-silence-prefix', 'text.concat', { left: literal('sonic-silence-'), right: output(id + '-enemy-id', 'value') }),
        { kind: 'record.create', id: id + '-silence-record', schema: SONIC_SILENCE_SCHEMA.id, fields: { id: output(id + '-silence-prefix', 'text'), type: literal('silenced'), name: literal('沉默'), stacks: literal(1), currentDuration: literal(1), relatedRules: literal(['rule-silenced-block']) } },
        call(id + '-apply-silence', 'status.apply-record', { target: output('first-enemy-ref', 'piece'), record: output(id + '-silence-record', 'value') }, { inputPolicy: 'host' }),
        call(id + '-apply-rule', 'rule.apply-piece', { target: output('first-enemy-ref', 'piece') }, { ruleId: 'rule-silenced-block' }),
      ]),
    ]),
    ...momentumUpdate(id, steps),
    call(id + '-steps-text', 'text.from-number', { value: steps }),
    call(id + '-moved', 'text.concat', { left: literal('冲刺'), right: output(id + '-steps-text', 'text') }),
    call(id + '-moved-suffix', 'text.concat', { left: output(id + '-moved', 'text'), right: literal('格，') }),
    call(id + '-message', 'text.concat', { left: output(id + '-moved-suffix', 'text'), right: output(id + '-hit', 'text') }),
    ...resultAction(id + '-result', literal(true), output(id + '-message', 'text')),
  ]
  const noEnemyAfter = (id: string, steps: GameplayValue): GameplayStatement[] => [
    ...momentumUpdate(id, steps),
    ...resultAction(id + '-result', literal(true), literal('未移动')),
  ]
  const enemyPath: GameplayStatement[] = [call('enemy-capture', 'source.capture', { source: output('first-enemy-ref', 'piece') }), call('enemy-move-needed', 'compare.greater-than', { left: output('trace', 'firstEnemyDistance'), right: literal(1) }), branch('enemy-move', output('enemy-move-needed', 'value'), [
    call('enemy-move-effect', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('trace', 'beforeFirstEnemy') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
    branch('enemy-move-success', output('enemy-move-effect', 'success'), enemyAfter('enemy-moved', output('enemy-move-effect', 'steps')), failureAction('enemy-blocked', '位移被阻挡')),
  ], enemyAfter('enemy-stationary', literal(0)))]
  const noEnemyPath: GameplayStatement[] = [call('no-enemy-needed', 'logic.not', { value: output('first-enemy', 'value') }), branch('no-enemy-move', output('trace', 'hasNewLandable'), [
    call('no-enemy-destination', 'spatial.cell-require', { cell: output('trace', 'lastLandable') }),
    call('no-enemy-move-effect', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('no-enemy-destination', 'cell') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
    branch('no-enemy-move-success', output('no-enemy-move-effect', 'success'), [
      ...momentumUpdate('no-enemy-moved', output('no-enemy-move-effect', 'steps')),
      call('no-enemy-steps', 'text.from-number', { value: output('no-enemy-move-effect', 'steps') }),
      call('no-enemy-prefix', 'text.concat', { left: literal('冲刺'), right: output('no-enemy-steps', 'text') }),
      call('no-enemy-message', 'text.concat', { left: output('no-enemy-prefix', 'text'), right: literal('格') }),
      ...resultAction('no-enemy-success', literal(true), output('no-enemy-message', 'text')),
    ], failureAction('no-enemy-blocked', '位移被阻挡')),
  ], noEnemyAfter('no-enemy-stationary', literal(0)))]
  validBody.push(branch('enemy-or-empty', output('first-enemy', 'value'), enemyPath, noEnemyPath))
  sourceBody.push(branch('direction-guard', output('direction-ok', 'value'), validBody, failureAction('direction-invalid', '请选择上下左右方向')))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body, [SONIC_SILENCE_SCHEMA])
}

function buildSonicHomingAttackGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('momentum', 'piece.momentum', { piece: output('source', 'piece') }),
    call('target-choice', 'choice.target-piece', {}, { range: 4, filter: 'enemy' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.piece', { choice: output('target-choice', 'choice') }),
    call('target-present', 'piece.reference-present', { piece: output('target', 'piece') }),
  ]
  const validBody: GameplayStatement[] = [
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('target-position', 'spatial.piece-position', { piece: output('target', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target-position', 'cell') }),
    call('not-same', 'logic.not', { value: output('direction', 'sameCell') }),
    call('not-cardinal', 'logic.not', { value: output('direction', 'valid') }),
    call('diagonal', 'logic.and', { left: output('not-same', 'value'), right: output('not-cardinal', 'value') }),
    call('rewritten', 'context.primary-target-rewritten', { target: output('target', 'piece') }),
    call('not-rewritten', 'logic.not', { value: output('rewritten', 'value') }),
    call('diagonal-invalid', 'logic.and', { left: output('diagonal', 'value'), right: output('not-rewritten', 'value') }),
  ]
  const landingBody: GameplayStatement[] = [
    call('landing', 'spatial.random-cardinal-landing', { target: output('target', 'piece') }),
    call('landing-present', 'value.present-cell', { value: output('landing', 'cell') }),
  ]
  const commitBody: GameplayStatement[] = [
    call('destination', 'spatial.cell-require', { cell: output('landing', 'cell') }),
    call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('destination', 'cell') }, { kind: 'teleport', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
    branch('move-guard', output('move', 'success'), [
      call('attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
      call('half-attack', 'math.multiply', { left: output('attack', 'value'), right: literal(0.5) }),
      call('quarter-raw', 'math.divide', { left: output('momentum', 'value'), right: literal(4) }),
      call('quarter-bonus', 'math.floor', { value: output('quarter-raw', 'value') }),
      call('amount', 'math.add', { left: output('half-attack', 'value'), right: output('quarter-bonus', 'value') }),
      call('damage', 'effect.damage-captured', { source: output('source-capture', 'source'), target: output('target-capture', 'source'), amount: output('amount', 'value') }, { damageType: 'physical', skillId: 'sonic-homing-attack' }),
      call('damage-number', 'effect.result-number', { result: output('damage', 'result') }, { field: 'damage' }),
      call('damage-text', 'text.from-number', { value: output('damage-number', 'value') }),
      call('message-prefix', 'text.concat', { left: literal('追踪攻击造成'), right: output('damage-text', 'text') }),
      call('message', 'text.concat', { left: output('message-prefix', 'text'), right: literal('点伤害') }),
      ...resultAction('success', literal(true), output('message', 'text')),
    ], cancelledAction('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  landingBody.push(branch('landing-guard', output('landing-present', 'present'), [
    call('target-capture', 'source.capture', { source: output('target', 'piece') }),
    ...commitBody,
  ], failureAction('no-landing', '目标相邻地格没有合法落点')))
  validBody.push(branch('diagonal-guard', output('diagonal-invalid', 'value'), failureAction('diagonal', '请选择正方向内的敌人'), landingBody))
  targetBody.push(branch('target-guard', output('target-present', 'value'), validBody, failureAction('target-missing', '请选择正方向内的敌人')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildShadowRideSweepGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('core-instance', 'status.find-instance', { piece: output('source', 'piece') }, { statusType: 'momentum-core' }),
    call('fallback-momentum', 'piece.momentum', { piece: output('source', 'piece') }),
    call('momentum', 'status.read-number-instance', { status: output('core-instance', 'status'), fallback: output('fallback-momentum', 'value') }, { field: 'stacks' }),
    call('powered', 'compare.greater-or-equal', { left: output('momentum', 'value'), right: literal(5) }),
    call('empowered', 'compare.greater-or-equal', { left: output('momentum', 'value'), right: literal(7) }),
    call('target-choice', 'choice.target-cell', {}, { range: 7, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
    call('range-ok', 'compare.less-or-equal', { left: output('direction', 'distance'), right: literal(7) }),
    call('direction-ok', 'logic.and', { left: output('direction', 'valid'), right: output('range-ok', 'value') }),
  ]
  const validBody: GameplayStatement[] = [
    call('trace', 'movement.trace', { source: output('source', 'piece'), direction: output('direction', 'direction'), maxDistance: output('direction', 'distance') }, { passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: ['wall', 'trap', 'hole'] }),
  ]
  const updateMomentum = (id: string, steps: GameplayValue): GameplayStatement[] => [
    call(id + '-preserved', 'source.captured-has-status', { source: output('source-capture', 'source') }, { statusType: 'preserve-momentum' }),
    call(id + '-base', 'value.select-number', { condition: output(id + '-preserved', 'value'), whenTrue: output('momentum', 'value'), whenFalse: literal(0) }),
    call(id + '-next', 'math.add', { left: output(id + '-base', 'value'), right: steps }),
    call(id + '-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
    branch(id + '-write', output(id + '-present', 'exists'), [
      call(id + '-set-momentum', 'attribute.set-momentum', { piece: output('source', 'piece'), value: output(id + '-next', 'value') }),
      call(id + '-set-core', 'status.set-number-instance', { status: output('core-instance', 'status'), value: output(id + '-next', 'value') }, { field: 'stacks' }),
    ]),
  ]
  const pathDamage: GameplayStatement[] = [
    call('target-captures', 'source.capture-list', { pieces: output('trace', 'enemyPieces') }),
    call('attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
    call('bonus', 'value.select-number', { condition: output('empowered', 'value'), whenTrue: literal(2), whenFalse: literal(0) }),
    call('damage-amount', 'math.add', { left: output('attack', 'value'), right: output('bonus', 'value') }),
    call('enemy-count', 'collection.piece-count', { pieces: output('trace', 'enemyPieces') }),
  ]
  const damageBody: GameplayStatement[] = [
    call('damage', 'effect.damage-captured-list', { source: output('source-capture', 'source'), targets: output('target-captures', 'sources'), amount: output('damage-amount', 'value') }, { damageType: 'physical', skillId: 'shadow-ride-sweep' }),
    collectionMap('path-hits', output('target-captures', 'sources'), [
      call('target-name', 'piece.captured-name', { source: inputValue('item') }, { fallback: 'none' }),
      call('target-damage', 'damage.batch-amount-at', { result: inputValue('damage'), index: inputValue('index') }),
      call('target-damage-text', 'text.from-number', { value: output('target-damage', 'value') }),
      call('target-prefix', 'text.concat', { left: output('target-name', 'value'), right: literal('(-') }),
      call('target-number', 'text.concat', { left: output('target-prefix', 'text'), right: output('target-damage-text', 'text') }),
      call('target-close', 'text.concat', { left: output('target-number', 'text'), right: literal(')') }),
      returnValue('target-return', output('target-close', 'text')),
    ], { damage: output('damage', 'result') }),
  ]
  const destinationBody: GameplayStatement[] = [
    call('destination', 'spatial.cell-require', { cell: output('trace', 'lastLandable') }),
    call('destination-coordinates', 'spatial.cell-coordinates', { cell: output('destination', 'cell') }),
    call('direction-coordinates', 'spatial.cell-coordinates', { cell: output('direction', 'direction') }),
    branch('powered-side', output('powered', 'value'), [
      call('side-id', 'status.make-id', { target: output('source', 'piece') }, { prefix: 'shadow-ride-sweep-side-' }),
      call('damage-five', 'value.select-number', { condition: output('empowered', 'value'), whenTrue: literal(7), whenFalse: literal(5) }),
      call('sides', 'spatial.perpendicular-cells', { center: output('target', 'cell'), direction: output('direction', 'direction') }),
      { kind: 'record.create', id: 'side-record', schema: SHADOW_RIDE_SIDE_SCHEMA.id, fields: {
        id: output('side-id', 'id'), type: literal('shadow-ride-sweep-side'), name: literal('骑射横扫侧射'), pathCells: output('trace', 'cells'),
        dx: output('direction-coordinates', 'x'), dy: output('direction-coordinates', 'y'), damage: output('damage-five', 'value'), left: output('sides', 'left'), right: output('sides', 'right'),
        currentDuration: literal(0), lifetime: literal('event'), currentUses: literal(1), visible: literal(false),
      } },
      call('apply-side', 'status.apply-record', { target: output('source', 'piece'), record: output('side-record', 'value') }, { inputPolicy: 'host' }),
    ]),
    call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('destination', 'cell') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: ['wall', 'trap', 'hole'] }),
    branch('move-guard', output('move', 'success'), [
      ...updateMomentum('moved', output('move', 'steps')),
      call('x-text', 'text.from-number', { value: output('destination-coordinates', 'x') }),
      call('y-text', 'text.from-number', { value: output('destination-coordinates', 'y') }),
      call('message-prefix', 'text.concat', { left: literal('骑射横扫至('), right: output('x-text', 'text') }),
      call('message-comma', 'text.concat', { left: output('message-prefix', 'text'), right: literal(',') }),
      call('message-close', 'text.concat', { left: output('message-comma', 'text'), right: output('y-text', 'text') }),
      call('message-base', 'text.concat', { left: output('message-close', 'text'), right: literal(')') }),
      call('has-hits', 'compare.greater-than', { left: output('enemy-count', 'value'), right: literal(0) }),
      call('hits-text', 'list.join', { items: output('path-hits', 'value') }, { separator: '、' }),
      call('optional-hits', 'text.optional-fragment', { condition: output('has-hits', 'value'), value: output('hits-text', 'text') }, { prefix: '，路径命中' }),
      call('message', 'text.concat', { left: output('message-base', 'text'), right: output('optional-hits', 'text') }),
      ...resultAction('success', literal(true), output('message', 'text')),
    ], cancelledAction('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  const noLanding: GameplayStatement[] = failureAction('no-landing', '没有可落脚的空格')
  validBody.push(branch('trace-guard', output('trace', 'reachedTarget'), [
    ...pathDamage,
    ...damageBody,
    branch('landing-guard', output('trace', 'hasNewLandable'), destinationBody, noLanding),
  ], failureAction('trace-blocked', '冲刺路径被墙体、陷阱或不可通行地形阻挡')))
  targetBody.push(branch('direction-guard', output('direction-ok', 'value'), validBody, failureAction('direction-invalid', '请选择7格内上下左右方向')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body, [SHADOW_RIDE_SIDE_SCHEMA])
}

function buildIllidanBladeDashGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-id', 'source.captured-identifier', { source: output('source-capture', 'source') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-cell', {}, { range: 6, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
    call('target-legal', 'spatial.cell-landing-legal', { cell: output('target', 'cell'), ignoreA: output('source', 'piece') }, { terrainPolicy: 'walkable' }),
  ]
  const validBody: GameplayStatement[] = [
    call('trace', 'movement.trace', { source: output('source', 'piece'), direction: output('direction', 'direction'), maxDistance: output('direction', 'distance') }, { passAllies: false, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: [] }),
  ]
  const commitBody: GameplayStatement[] = [
    call('destination', 'spatial.cell-require', { cell: output('trace', 'lastLandable') }),
    call('targets', 'source.capture-list', { pieces: output('trace', 'enemyPieces') }),
    call('attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
    call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('destination', 'cell') }, { kind: 'dash', passAllies: false, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: [] }),
    branch('move-guard', output('move', 'success'), [
      call('target-count', 'collection.piece-count', { pieces: output('trace', 'enemyPieces') }),
      call('has-targets', 'compare.greater-than', { left: output('target-count', 'value'), right: literal(0) }),
      branch('damage-guard', output('has-targets', 'value'), [
        call('damage', 'effect.damage-captured-list', { source: output('source-capture', 'source'), targets: output('targets', 'sources'), amount: output('attack', 'value') }, { damageType: 'physical', skillId: 'illidan-blade-dash' }),
        call('total', 'damage.batch-total', { result: output('damage', 'result') }),
        collectionMap('names', output('targets', 'sources'), [
          call('name', 'piece.captured-name', { source: inputValue('item') }, { fallback: 'none' }),
          returnValue('return', output('name', 'value')),
        ]),
        call('name-list', 'list.join', { items: output('names', 'value') }, { separator: '、' }),
        call('total-text', 'text.from-number', { value: output('total', 'value') }),
        call('with-targets', 'text.concat', { left: output('source-name', 'value'), right: literal('战刃挥刺，对') }),
        call('with-names', 'text.concat', { left: output('with-targets', 'text'), right: output('name-list', 'text') }),
        call('with-damage', 'text.concat', { left: output('with-names', 'text'), right: literal('造成') }),
        call('with-total', 'text.concat', { left: output('with-damage', 'text'), right: output('total-text', 'text') }),
        call('message', 'text.concat', { left: output('with-total', 'text'), right: literal('点伤害') }),
        ...resultAction('damaged', literal(true), output('message', 'text')),
      ], [
        call('empty-message', 'text.concat', { left: output('source-name', 'value'), right: literal('战刃挥刺冲向目标位置') }),
        ...resultAction('empty', literal(true), output('empty-message', 'text')),
      ]),
      ], cancelledAction('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  validBody.push(branch('path-guard', output('trace', 'hasNewLandable'), commitBody, failureAction('path-blocked', '路径被阻挡，无法冲刺')))
  targetBody.push(branch('direction-guard', output('direction', 'valid'), [
    branch('landing-guard', output('target-legal', 'legal'), validBody, cancelledAction('occupied', '目标格已被占用，战刃挥刺取消')),
  ], failureAction('direction-invalid', '目标格子必须在同一行或同一列')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildMortisShovelChargeGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-id', 'source.captured-identifier', { source: output('source-capture', 'source') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-cell', {}, { range: 3, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
    call('range-ok', 'compare.less-or-equal', { left: output('direction', 'distance'), right: literal(3) }),
  ]
  const validBody: GameplayStatement[] = [
    call('trace', 'movement.trace', { source: output('source', 'piece'), direction: output('direction', 'direction'), maxDistance: output('direction', 'distance') }, { passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: [] }),
    call('target-landable', 'spatial.cell-equal', { left: output('trace', 'lastLandable'), right: output('target', 'cell') }),
  ]
  const commitBody: GameplayStatement[] = [
    call('targets', 'source.capture-list', { pieces: output('trace', 'enemyPieces') }),
    call('target-count', 'collection.piece-count', { pieces: output('trace', 'enemyPieces') }),
    call('has-targets', 'compare.greater-than', { left: output('target-count', 'value'), right: literal(0) }),
    call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('target', 'cell') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: [] }),
    branch('move-guard', output('move', 'success'), [
      branch('damage-guard', output('has-targets', 'value'), [
        call('damage', 'effect.damage-captured-list', { source: output('source-capture', 'source'), targets: output('targets', 'sources'), amount: literal(4) }, { damageType: 'physical', skillId: 'mortis-shovel-charge' }),
      ]),
      call('target-coordinates', 'spatial.cell-coordinates', { cell: output('target', 'cell') }),
      call('x-text', 'text.from-number', { value: output('target-coordinates', 'x') }),
      call('y-text', 'text.from-number', { value: output('target-coordinates', 'y') }),
      call('prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('铁铲突击至(') }),
      call('with-x', 'text.concat', { left: output('prefix', 'text'), right: output('x-text', 'text') }),
      call('with-comma', 'text.concat', { left: output('with-x', 'text'), right: literal(',') }),
      call('with-y', 'text.concat', { left: output('with-comma', 'text'), right: output('y-text', 'text') }),
      call('base-message', 'text.concat', { left: output('with-y', 'text'), right: literal(')') }),
      call('count-text', 'text.from-number', { value: output('target-count', 'value') }),
      call('target-fragment', 'text.optional-fragment', { condition: output('has-targets', 'value'), value: output('count-text', 'text') }, { prefix: '，对路径上', suffix: '名敌人造成4点伤害' }),
      call('message', 'text.concat', { left: output('base-message', 'text'), right: output('target-fragment', 'text') }),
      ...resultAction('success', literal(true), output('message', 'text')),
    ], cancelledAction('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  validBody.push(branch('landing-guard', output('target-landable', 'value'), commitBody, failureAction('no-landing', '路径上没有合法落点')))
  targetBody.push(branch('direction-guard', output('direction', 'valid'), [branch('range-guard', output('range-ok', 'value'), validBody, failureAction('out-of-range', '目标地格超出3格'))], failureAction('direction-invalid', '请选择正方向地格')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildElPrimoElbowGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-cell', {}, { range: 7, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('walkable', 'spatial.cell-walkable', { cell: output('target', 'cell') }),
  ]
  const validBody: GameplayStatement[] = [
    call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('target', 'cell') }, { kind: 'teleport', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
    branch('move-guard', output('move', 'success'), [
      call('cells', 'spatial.square-cells', { center: output('target', 'cell') }, { radius: 1 }),
      call('destroy', 'effect.destroy-walls', { cells: output('cells', 'cells') }, { includeCover: true }),
      call('owner', 'source.captured-owner', { source: output('source-capture', 'source') }),
      call('targets', 'query.pieces-around-cell', { center: output('target', 'cell'), owner: output('owner', 'player') }, { relation: 'enemy', metric: 'chebyshev', minimum: 0, maximum: 1 }),
      call('target-captures', 'source.capture-list', { pieces: output('targets', 'pieces') }),
      call('target-count', 'collection.piece-count', { pieces: output('targets', 'pieces') }),
      call('has-targets', 'compare.greater-than', { left: output('target-count', 'value'), right: literal(0) }),
      call('attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
      branch('damage-guard', output('has-targets', 'value'), [
        call('damage', 'effect.damage-captured-list', { source: output('source-capture', 'source'), targets: output('target-captures', 'sources'), amount: output('attack', 'value') }, { damageType: 'physical', skillId: 'el-primo-elbow' }),
      ]),
      call('move-range', 'attribute.adjust-captured', { source: output('source-capture', 'source'), amount: literal(1) }, { attribute: 'moveRange' }),
      call('message-prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('飞身肘击并破墙') }),
      ...resultAction('success', literal(true), output('message-prefix', 'text')),
    ], cancelledAction('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  targetBody.push(branch('walkable-guard', output('walkable', 'walkable'), validBody, failureAction('not-walkable', '目标地格不可行走')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildEdgarPogoJumpGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('source-owner', 'source.captured-owner', { source: output('source-capture', 'source') }),
    call('target-choice', 'choice.target-cell-by-range', { range: literal(5) }, { filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('walkable', 'spatial.cell-walkable', { cell: output('target', 'cell') }),
    call('unoccupied', 'spatial.cell-unoccupied', { cell: output('target', 'cell'), ignore: output('source', 'piece') }),
  ]
  const commitBody: GameplayStatement[] = [
    call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('target', 'cell') }, { kind: 'teleport', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
    branch('move-guard', output('move', 'success'), [
      call('targets', 'query.pieces-around-cell', { center: output('target', 'cell'), owner: output('source-owner', 'player') }, { relation: 'enemy', metric: 'chebyshev', minimum: 0, maximum: 1 }),
      call('target-captures', 'source.capture-list', { pieces: output('targets', 'pieces') }),
      call('target-count', 'collection.piece-count', { pieces: output('targets', 'pieces') }),
      call('has-targets', 'compare.greater-than', { left: output('target-count', 'value'), right: literal(0) }),
      branch('damage-guard', output('has-targets', 'value'), [
        call('damage', 'effect.damage-captured-list', { source: output('source-capture', 'source'), targets: output('target-captures', 'sources'), amount: literal(3) }, { damageType: 'physical', skillId: 'edgar-pogo-jump' }),
      ]),
      call('move-range', 'attribute.adjust-captured', { source: output('source-capture', 'source'), amount: literal(1) }, { attribute: 'moveRange' }),
      call('target-coordinates', 'spatial.cell-coordinates', { cell: output('target', 'cell') }),
      call('x-text', 'text.from-number', { value: output('target-coordinates', 'x') }),
      call('y-text', 'text.from-number', { value: output('target-coordinates', 'y') }),
      call('prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('跳跃至(') }),
      call('with-x', 'text.concat', { left: output('prefix', 'text'), right: output('x-text', 'text') }),
      call('with-comma', 'text.concat', { left: output('with-x', 'text'), right: literal(',') }),
      call('with-y', 'text.concat', { left: output('with-comma', 'text'), right: output('y-text', 'text') }),
      call('message', 'text.concat', { left: output('with-y', 'text'), right: literal(')并对周围敌人造成3点伤害，移速+1') }),
      ...resultAction('success', literal(true), output('message', 'text')),
    ], cancelledAction('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  targetBody.push(branch('walkable-guard', output('walkable', 'walkable'), [
    branch('unoccupied-guard', output('unoccupied', 'value'), commitBody, failureAction('occupied', '目标地格已有棋子')),
  ], failureAction('not-walkable', '目标地格不可行走')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

const MAX_PHASE_RECAST_SCHEMA: GameplayRecordSchema = {
  id: 'movement.max-phase-recast', version: SEMANTIC_MOVEMENT_FAMILY_VERSION,
  fields: [
    port('id', 'string'), port('type', 'string'), port('name', 'string'), port('visible', 'boolean'),
    port('turnNumber', 'number'), port('currentDuration', 'number'), port('currentUses', 'number'),
    port('relatedRules', { kind: 'list', element: 'string' }),
  ],
}

function buildMaxPhaseShifterGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('turn', 'turn.number'),
    call('recast-id', 'status.find-id-by-number', { piece: output('source', 'piece'), value: output('turn', 'value') }, { statusType: 'max-phase-recast', field: 'turnNumber' }),
    call('recast-present', 'value.present-string', { value: output('recast-id', 'id') }),
    call('action-points', 'resource.read', { player: output('owner', 'player') }, { resource: 'actionPoints' }),
    call('needs-ap', 'compare.less-than', { left: output('action-points', 'value'), right: literal(1) }),
    call('recast-blocked', 'logic.and', { left: output('recast-present', 'present'), right: output('needs-ap', 'value') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
    call('walkable', 'spatial.cell-walkable', { cell: output('target', 'cell') }),
    call('unoccupied', 'spatial.cell-unoccupied', { cell: output('target', 'cell'), ignore: output('source', 'piece') }),
  ]
  const initialCast: GameplayStatement[] = [
    call('remove-expired', 'status.remove-expired-turn-type', { target: output('source', 'piece'), turn: output('turn', 'value') }, { statusType: 'max-phase-recast' }),
    call('source-id', 'source.captured-identifier', { source: output('source-capture', 'source') }),
    call('status-id', 'text.concat', { left: literal('max-phase-recast-'), right: output('source-id', 'value') }),
    { kind: 'record.create', id: 'recast-record', schema: MAX_PHASE_RECAST_SCHEMA.id, fields: {
      id: output('status-id', 'text'), type: literal('max-phase-recast'), name: literal('相位偏移器·再次释放'), visible: literal(false),
      turnNumber: output('turn', 'value'), currentDuration: literal(1), currentUses: literal(1), relatedRules: literal(['rule-max-phase-recast-expire']),
    } },
    call('apply-recast', 'status.apply-record', { target: output('source', 'piece'), record: output('recast-record', 'value') }, { inputPolicy: 'host' }),
    call('apply-rule', 'rule.apply-piece', { target: output('source', 'piece') }, { ruleId: 'rule-max-phase-recast-expire' }),
  ]
  const afterMove: GameplayStatement[] = [
    branch('recast-status', output('recast-present', 'present'), [
      call('remove-recast', 'status.remove-id', { piece: output('source', 'piece'), statusId: output('recast-id', 'id') }),
    ], initialCast),
    call('reset-cooldown', 'skill.reset-cooldown', { piece: output('source', 'piece'), skillId: literal('max-phase-shifter') }),
    branch('recast-cooldown', output('recast-present', 'present'), [
      call('set-recast-cooldown', 'skill.adjust-cooldown', { piece: output('source', 'piece'), skillId: literal('max-phase-shifter'), amount: literal(3) }, { mode: 'atLeast' }),
    ]),
    call('target-coordinates', 'spatial.cell-coordinates', { cell: output('target', 'cell') }),
    call('x-text', 'text.from-number', { value: output('target-coordinates', 'x') }),
    call('y-text', 'text.from-number', { value: output('target-coordinates', 'y') }),
    call('prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('相位偏移至(') }),
    call('with-x', 'text.concat', { left: output('prefix', 'text'), right: output('x-text', 'text') }),
    call('with-comma', 'text.concat', { left: output('with-x', 'text'), right: literal(',') }),
    call('with-y', 'text.concat', { left: output('with-comma', 'text'), right: output('y-text', 'text') }),
    call('base-message', 'text.concat', { left: output('with-y', 'text'), right: literal(')') }),
    call('message', 'text.concat', { left: output('base-message', 'text'), right: output('recast-present', 'present') }),
  ]
  // The message suffix is selected without exposing the status record.  Both
  // branches share the same authoritative cooldown/status writes above.
  afterMove.pop()
  afterMove.push(branch('message-recast', output('recast-present', 'present'), [
    ...resultAction('recast-success', literal(true), appendText(afterMove, 'recast-message', output('base-message', 'text'), literal('，消耗1行动点完成再次释放'))),
  ], [
    ...resultAction('first-success', literal(true), appendText(afterMove, 'first-message', output('base-message', 'text'), literal('，本回合可消耗1行动点再次释放'))),
  ]))
  const validBody: GameplayStatement[] = [
    branch('recast-ap', output('recast-present', 'present'), [
      call('spend-ap', 'resource.adjust', { player: output('owner', 'player'), amount: literal(-1) }, { resource: 'actionPoints' }),
    ]),
    call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('target', 'cell') }, { kind: 'teleport', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
    branch('move-guard', output('move', 'success'), afterMove, cancelledAction('blocked', '位移被阻挡，本次位移效果取消')),
  ]
  targetBody.push(
    call('legal', 'logic.and', { left: output('walkable', 'walkable'), right: output('unoccupied', 'value') }),
    branch('direction-guard', output('direction', 'valid'), [
      branch('legal-guard', output('legal', 'value'), validBody, failureAction('illegal', '请选择合法地格')),
    ], failureAction('direction-invalid', '请选择正方向地格')),
  )
  sourceBody.push(branch('recast-ap-guard', output('recast-blocked', 'value'), failureAction('recast-no-ap', '再次释放相位偏移器需要1行动点'), [
    call('target-choice', 'choice.target-cell-by-range', { range: literal(2) }, { filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody),
  ]))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body, [MAX_PHASE_RECAST_SCHEMA])
}

function buildAlfonsoKickGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-cell-by-range', { range: literal(6) }, { filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
    call('trace', 'projectile.trace-strict', { source: output('source', 'piece'), target: output('target', 'cell') }, { maxDistance: 6 }),
    call('first-piece', 'movement.first-piece-on-trace', { source: output('source', 'piece'), events: output('trace', 'events') }),
  ]
  const hitBody: GameplayStatement[] = [
    call('target-ref', 'piece.require', { piece: output('first-piece', 'piece') }),
    call('target-capture', 'source.capture', { source: output('target-ref', 'piece') }),
    call('first-damage', 'effect.damage-captured', { source: output('source-capture', 'source'), target: output('target-capture', 'source'), amount: literal(2) }, { damageType: 'physical', skillId: 'alfonso-kick' }),
    call('distance-adjacent', 'compare.equal', { left: output('first-piece', 'distance'), right: literal(1) }),
    branch('adjacent-bonus', output('distance-adjacent', 'value'), [
      call('attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
      call('half-attack', 'math.multiply', { left: output('attack', 'value'), right: literal(0.5) }),
      call('bonus', 'math.floor', { value: output('half-attack', 'value') }),
      call('bonus-damage', 'effect.damage-captured', { source: output('source-capture', 'source'), target: output('target-capture', 'source'), amount: output('bonus', 'value') }, { damageType: 'physical', skillId: 'alfonso-kick' }),
    ]),
  ]
  hitBody.push(...resultAction('hit-result', literal(true), appendText(hitBody, 'hit-message', output('source-name', 'value'), literal('踢出鞋子造成伤害'))))
  const missBody = (id: string): GameplayStatement[] => appendedResult(id, literal(true), output('source-name', 'value'), literal('的鞋子未命中'))
  const validTargetBody: GameplayStatement[] = [
    branch('piece-present', output('first-piece', 'present'), [
      branch('enemy-guard', output('first-piece', 'enemy'), hitBody, missBody('enemy-miss')),
    ], missBody('empty-miss')),
  ]
  targetBody.push(branch('direction-guard', output('direction', 'valid'), validTargetBody, failureAction('direction-invalid', '请选择正方向')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildAlfonsoWaterDashGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
    call('damage-amount', 'math.multiply', { left: output('attack', 'value'), right: literal(2) }),
    call('target-choice', 'choice.target-cell-by-range', { range: literal(30) }, { filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
  ]
  const traceBody: GameplayStatement[] = [
    call('trace', 'movement.trace', { source: output('source', 'piece'), direction: output('direction', 'direction'), maxDistance: literal(100) }, { passAllies: false, passEnemies: false, terrain: 'walkable', blockedTerrainTypes: [] }),
    call('first-piece', 'query.has-piece', { pieceId: output('trace', 'firstEnemy') }),
  ]
  const chain = (id: string, initialTargets: GameplayValue, withInitialDamage: readonly GameplayStatement[] = []): GameplayStatement[] => {
    const initialIds = id + '-initial-ids'
    const hitList = id + '-hit-list'
    const hitCounter = id + '-hit-counter'
    const damageTotal = id + '-damage-total'
    const sourceId = id + '-source-id'
    const candidate = id + '-candidate'
    const target = id + '-target'
    const targetId = id + '-target-id'
    const targetCapture = id + '-target-capture'
    const landing = id + '-landing'

    const appendHit = (suffix: string): GameplayStatement[] => [
      call(id + '-' + suffix + '-append', 'local.string-list-append', { list: output(hitList, 'list'), value: output(targetId, 'id') }),
      call(id + '-' + suffix + '-count', 'local.counter-add', { counter: output(hitCounter, 'counter'), amount: literal(1) }),
    ]
    const targetAlive: GameplayStatement[] = [
      call(id + '-target-live', 'query.has-piece-id', { id: output(targetId, 'id') }),
      branch(id + '-target-live-guard', output(id + '-target-live', 'exists'), [
        call(id + '-damage', 'effect.damage-captured', { source: output('source-capture', 'source'), target: output(targetCapture, 'source'), amount: output('damage-amount', 'value') }, { damageType: 'physical', skillId: 'alfonso-water-dash' }),
        call(id + '-damage-value', 'effect.result-number', { result: output(id + '-damage', 'result') }, { field: 'damage' }),
        call(id + '-damage-add', 'local.counter-add', { counter: output(damageTotal, 'counter'), amount: output(id + '-damage-value', 'value') }),
        ...appendHit('hit'),
      ], appendHit('target-gone')),
    ]
    const landed: GameplayStatement[] = [
      call(id + '-landing-safe', 'spatial.cell-require', { cell: output(landing, 'cell') }),
      call(id + '-move', 'effect.teleport-with-change', { piece: output(id + '-source-piece', 'piece'), destination: output(id + '-landing-safe', 'cell') }, { kind: 'teleport' }),
      call(id + '-source-live', 'query.has-piece-id', { id: output(sourceId, 'value') }),
      branch(id + '-source-live-guard', output(id + '-source-live', 'exists'), targetAlive),
    ]
    const conditionBody: GameplayStatement[] = [
      call(id + '-condition-source-id', 'source.captured-identifier', { source: inputValue('source') }),
      call(id + '-condition-hit-ids', 'local.string-list-read', { list: inputValue('hits') }),
      call(id + '-condition-candidates', 'movement.bounce-candidates', { sourceId: output(id + '-condition-source-id', 'value'), excluded: output(id + '-condition-hit-ids', 'items'), range: literal(4) }),
      call(id + '-condition-count', 'list.count-pieces', { items: output(id + '-condition-candidates', 'pieces') }),
      call(id + '-condition-has-candidate', 'compare.greater-than', { left: output(id + '-condition-count', 'value'), right: literal(0) }),
      call(id + '-condition-bounces', 'local.counter-read', { counter: inputValue('bounces') }),
      call(id + '-condition-under-limit', 'compare.less-than', { left: output(id + '-condition-bounces', 'value'), right: literal(10) }),
      call(id + '-condition-continue', 'logic.and', { left: output(id + '-condition-has-candidate', 'value'), right: output(id + '-condition-under-limit', 'value') }),
      returnValue(id + '-condition-return', output(id + '-condition-continue', 'value')),
    ]
    const loopBody: GameplayStatement[] = [
      call(id + '-bounce-count-add', 'local.counter-add', { counter: output(id + '-bounce-count', 'counter'), amount: literal(1) }),
      call(sourceId, 'source.captured-identifier', { source: output('source-capture', 'source') }),
      call(id + '-hit-ids', 'local.string-list-read', { list: output(hitList, 'list') }),
      call(candidate, 'movement.bounce-candidates', { sourceId: output(sourceId, 'value'), excluded: output(id + '-hit-ids', 'items'), range: literal(4) }),
      call(target, 'query.random-item', { items: output(candidate, 'pieces') }),
      call(targetId, 'piece.identifier', { piece: output(target, 'item') }),
      call(targetCapture, 'source.capture', { source: output(target, 'item') }),
      call(id + '-source-piece', 'source.captured-piece-reference', { source: output('source-capture', 'source') }),
      call(landing, 'spatial.random-adjacent-landing', { target: output(target, 'item'), ignore: output(id + '-source-piece', 'piece') }),
      call(id + '-landing-present', 'value.present-cell', { value: output(landing, 'cell') }),
      branch(id + '-landing-branch', output(id + '-landing-present', 'present'), landed, appendHit('no-landing')),
    ]
    return [
      ...withInitialDamage,
      call(id + '-land-present', 'value.present-cell', { value: output('trace', 'lastLandable') }),
      branch(id + '-land', output(id + '-land-present', 'present'), [
        call(id + '-destination', 'spatial.cell-require', { cell: output('trace', 'lastLandable') }),
        call(id + '-dash', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output(id + '-destination', 'cell') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
      ]),
      collectionMap(initialIds, initialTargets, [
        call(initialIds + '-capture-id', 'source.captured-identifier', { source: inputValue('item') }),
        returnValue(initialIds + '-return', output(initialIds + '-capture-id', 'value')),
      ]),
      call(id + '-hit-list', 'local.string-list-create', { items: output(initialIds, 'value') }),
      call(id + '-initial-count', 'list.count', { items: output(initialIds, 'value') }),
      call(hitCounter, 'local.counter-create', { initial: output(id + '-initial-count', 'count') }),
      call(id + '-damage-total', 'local.counter-create', { initial: literal(0) }),
      call(id + '-bounce-count', 'local.counter-create', { initial: literal(0) }),
      { kind: 'while', id: id + '-bounce-loop', index: 'index', budget: 10, condition: {
        inputs: { source: output('source-capture', 'source'), hits: output(id + '-hit-list', 'list'), bounces: output(id + '-bounce-count', 'counter') }, body: conditionBody,
      }, body: loopBody },
      call(id + '-hit-count-final', 'local.counter-read', { counter: output(hitCounter, 'counter') }),
      call(id + '-hit-text', 'text.from-number', { value: output(id + '-hit-count-final', 'value') }),
      call(id + '-message-prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('惊鸿掠水，共命中') }),
      call(id + '-message-count', 'text.concat', { left: output(id + '-message-prefix', 'text'), right: output(id + '-hit-text', 'text') }),
      ...appendedResult(id + '-result', literal(true), output(id + '-message-count', 'text'), literal('名敌人')),
    ]
  }
  const firstEnemy: GameplayStatement[] = [
    call('first-target-ref', 'piece.require', { piece: output('trace', 'firstEnemy') }),
    call('first-target-capture', 'source.capture', { source: output('first-target-ref', 'piece') }),
    call('initial-targets', 'collection.single-piece-list', { piece: output('first-target-ref', 'piece') }),
    call('initial-target-captures', 'source.capture-list', { pieces: output('initial-targets', 'pieces') }),
    call('first-damage', 'effect.damage-captured', { source: output('source-capture', 'source'), target: output('first-target-capture', 'source'), amount: output('damage-amount', 'value') }, { damageType: 'physical', skillId: 'alfonso-water-dash' }),
    ...chain('enemy-chain', output('initial-target-captures', 'sources')),
  ]
  const noFirstEnemy = (id: string): GameplayStatement[] => chain(id, literal([]))
  traceBody.push(branch('first-present', output('first-piece', 'exists'), firstEnemy, noFirstEnemy('empty-chain-no-piece')))
  targetBody.push(branch('direction-guard', output('direction', 'valid'), traceBody, failureAction('direction-invalid', '请选择正方向')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

function buildRocketPunchGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') })]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-cell-by-range', { range: literal(5) }, { filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
  ]
  const traceBody: GameplayStatement[] = [
    call('trace', 'movement.trace', { source: output('source', 'piece'), direction: output('direction', 'direction'), maxDistance: literal(5) }, { passAllies: false, passEnemies: false, terrain: 'walkable', blockedTerrainTypes: [] }),
    call('projectile-trace', 'projectile.trace', { source: output('source', 'piece'), target: output('target', 'cell') }, { maxDistance: 5 }),
    call('first-piece', 'movement.first-piece-on-trace', { source: output('source', 'piece'), events: output('projectile-trace', 'events') }),
  ]
  const commit = (id: string, hit: GameplayValue, target: GameplayValue): GameplayStatement[] => {
    const hitBody: GameplayStatement[] = [
      call(id + '-target-ref', 'piece.require', { piece: target }),
      call(id + '-target-capture', 'source.capture', { source: output(id + '-target-ref', 'piece') }),
      call(id + '-power', 'skill.power-multiplier'),
      call(id + '-attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
      call(id + '-scaled', 'math.multiply', { left: output(id + '-attack', 'value'), right: output(id + '-power', 'value') }),
      call(id + '-damage-amount', 'math.floor', { value: output(id + '-scaled', 'value') }),
      call(id + '-damage', 'effect.damage-captured', { source: output('source-capture', 'source'), target: output(id + '-target-capture', 'source'), amount: output(id + '-damage-amount', 'value') }, { damageType: 'physical', skillId: 'rocket-punch' }),
      call(id + '-target-name', 'piece.captured-name', { source: output(id + '-target-capture', 'source') }, { fallback: 'none' }),
      call(id + '-damage-number', 'effect.result-number', { result: output(id + '-damage', 'result') }, { field: 'damage' }),
      call(id + '-damage-text', 'text.from-number', { value: output(id + '-damage-number', 'value') }),
    ]
    return [
      call(id + '-destination', 'spatial.cell-require', { cell: output('trace', 'lastLandable') }),
      call(id + '-move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output(id + '-destination', 'cell') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] }),
      branch(id + '-move-guard', output(id + '-move', 'success'), [
        call(id + '-x', 'spatial.cell-coordinates', { cell: output(id + '-destination', 'cell') }),
        call(id + '-x-text', 'text.from-number', { value: output(id + '-x', 'x') }),
        call(id + '-y-text', 'text.from-number', { value: output(id + '-x', 'y') }),
        call(id + '-prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('使用火箭重拳冲刺至(') }),
        call(id + '-with-x', 'text.concat', { left: output(id + '-prefix', 'text'), right: output(id + '-x-text', 'text') }),
        call(id + '-with-comma', 'text.concat', { left: output(id + '-with-x', 'text'), right: literal(',') }),
        call(id + '-with-y', 'text.concat', { left: output(id + '-with-comma', 'text'), right: output(id + '-y-text', 'text') }),
        call(id + '-base-message', 'text.concat', { left: output(id + '-with-y', 'text'), right: literal(')') }),
        branch(id + '-hit', hit, [
          ...hitBody,
          call(id + '-damage-message', 'text.concat', { left: output(id + '-base-message', 'text'), right: literal('，对') }),
          call(id + '-with-target', 'text.concat', { left: output(id + '-damage-message', 'text'), right: output(id + '-target-name', 'value') }),
          call(id + '-with-damage-prefix', 'text.concat', { left: output(id + '-with-target', 'text'), right: literal('造成') }),
          call(id + '-with-damage', 'text.concat', { left: output(id + '-with-damage-prefix', 'text'), right: output(id + '-damage-text', 'text') }),
          ...appendedResult(id + '-hit-result', literal(true), output(id + '-with-damage', 'text'), literal('点物理伤害')),
        ], resultAction(id + '-empty-result', literal(true), output(id + '-base-message', 'text'))),
      ], cancelledAction(id + '-blocked', '位移被阻挡，本次位移效果取消')),
    ]
  }
  const targetRef = output('first-piece', 'piece')
  traceBody.push(branch('path-guard', output('trace', 'hasNewLandable'), [
    branch('piece-present', output('first-piece', 'present'), [
      branch('enemy-guard', output('first-piece', 'enemy'), commit('enemy', literal(true), targetRef), commit('ally', literal(false), targetRef)),
    ], commit('empty', literal(false), targetRef)),
  ], failureAction('no-path', '位移被阻挡，本次位移效果取消')))
  targetBody.push(branch('direction-guard', output('direction', 'valid'), traceBody, failureAction('direction-invalid', '目标必须与末日铁拳在同一行或同一列')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body)
}

const VENOM_ROOT_SCHEMA: GameplayRecordSchema = {
  id: 'movement.venom-root-status', version: SEMANTIC_MOVEMENT_FAMILY_VERSION,
  fields: [
    port('id', 'string'), port('type', 'string'), port('name', 'string'),
    port('currentDuration', 'number'), port('currentUses', 'number'),
    port('intensity', 'number'), port('stacks', 'number'), port('sourceId', 'string'),
  ],
}

function buildVenomHostTransferGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-id', 'source.captured-identifier', { source: output('source-capture', 'source') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-piece', {}, { range: 7, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]

  const targetBody: GameplayStatement[] = [
    call('target', 'choice.piece', { choice: output('target-choice', 'choice') }),
    call('mirror', 'context.primary-target-rewritten', { target: output('target', 'piece') }),
    call('same', 'compare.equal-piece', { left: output('target', 'piece'), right: output('source', 'piece') }),
    call('not-mirror', 'logic.not', { value: output('mirror', 'value') }),
    call('self-without-mirror', 'logic.and', { left: output('not-mirror', 'value'), right: output('same', 'value') }),
  ]

  const positionBody: GameplayStatement[] = [
    call('target-capture', 'source.capture', { source: output('target', 'piece') }),
    call('target-id', 'source.captured-identifier', { source: output('target-capture', 'source') }),
    call('target-name', 'piece.captured-name', { source: output('target-capture', 'source') }, { fallback: 'none' }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('target-position', 'spatial.piece-position', { piece: output('target', 'piece') }),
    call('distance', 'spatial.cell-distance', { from: output('source-position', 'cell'), to: output('target-position', 'cell') }),
    call('in-range', 'compare.less-or-equal', { left: output('distance', 'distance'), right: literal(7) }),
    call('range-exempt', 'logic.or', { left: output('mirror', 'value'), right: output('in-range', 'value') }),
  ]

  const mirrorSelf: GameplayStatement[] = [
    call('self-message-prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('发动宿主转移，目标为自身，位置不变') }),
    ...resultAction('self-result', literal(true), output('self-message-prefix', 'text')),
  ]

  const enemyStatus: GameplayStatement[] = [
    call('root-id-prefix', 'text.concat', { left: literal('root-'), right: output('source-id', 'value') }),
    call('root-id-separator', 'text.concat', { left: output('root-id-prefix', 'text'), right: literal('-') }),
    call('root-id', 'text.concat', { left: output('root-id-separator', 'text'), right: output('target-id', 'value') }),
    {
      kind: 'record.create', id: 'root-record', schema: VENOM_ROOT_SCHEMA.id, fields: {
        id: output('root-id', 'text'), type: literal('root'), name: literal('定身'),
        currentDuration: literal(1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1),
        sourceId: output('source-id', 'value'),
      },
    },
    call('apply-root', 'status.apply-record', { target: output('target', 'piece'), record: output('root-record', 'value') }, { inputPolicy: 'host' }),
  ]

  const swapped: GameplayStatement[] = [
    call('swap', 'effect.swap-pieces', { first: output('source', 'piece'), second: output('target', 'piece') }),
    branch('swap-guard', output('swap', 'success'), [
      call('source-owner', 'source.captured-owner', { source: output('source-capture', 'source') }),
      call('target-owner', 'source.captured-owner', { source: output('target-capture', 'source') }),
      call('allied', 'compare.allied-players', { left: output('source-owner', 'player'), right: output('target-owner', 'player') }),
      call('not-allied', 'logic.not', { value: output('allied', 'value') }),
      branch('enemy-root', output('not-allied', 'value'), enemyStatus),
      call('message-prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('发动宿主转移，与') }),
      call('message-target', 'text.concat', { left: output('message-prefix', 'text'), right: output('target-name', 'value') }),
      call('message-base', 'text.concat', { left: output('message-target', 'text'), right: literal('交换位置') }),
      call('message-extra', 'value.select-text', { condition: output('not-allied', 'value'), whenTrue: literal('并使其定身1回合'), whenFalse: literal('') }),
      call('message', 'text.concat', { left: output('message-base', 'text'), right: output('message-extra', 'text') }),
      ...resultAction('success', literal(true), output('message', 'text')),
    ], cancelledAction('blocked', '换位被阻挡，双方保持原位')),
  ]

  positionBody.push(branch('range-guard', output('range-exempt', 'value'), [
    branch('mirror-self', output('same', 'value'), mirrorSelf, swapped),
  ], failureAction('out-of-range', '目标距离超过7格')))

  const validTarget: GameplayStatement[] = [
    call('target-alive', 'piece.alive', { piece: output('target', 'piece') }),
    call('target-positioned', 'piece.has-position', { piece: output('target', 'piece') }),
    call('source-positioned', 'piece.has-position', { piece: output('source', 'piece') }),
    call('target-position-valid', 'logic.and', { left: output('target-alive', 'alive'), right: output('target-positioned', 'value') }),
    call('position-valid', 'logic.and', { left: output('target-position-valid', 'value'), right: output('source-positioned', 'value') }),
  ]
  validTarget.push(branch('target-valid-guard', output('position-valid', 'value'), positionBody, failureAction('target-invalid', '宿主转移只能选择场上的存活角色')))
  targetBody.push(branch('self-guard', output('self-without-mirror', 'value'), failureAction('self', '宿主转移不能选择毒液自身'), [
    ...validTarget,
  ]))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body, [VENOM_ROOT_SCHEMA])
}

function buildVenomSymbioteDragGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-id', 'source.captured-identifier', { source: output('source-capture', 'source') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-cell', {}, { range: 99, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]
  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-positioned', 'piece.has-position', { piece: output('source', 'piece') }),
  ]
  const validSourceBody: GameplayStatement[] = [
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
  ]
  const traceBody: GameplayStatement[] = [
    call('trace', 'projectile.trace', { source: output('source', 'piece'), target: output('target', 'cell') }, { maxDistance: 99 }),
    call('obstruction', 'movement.first-trace-obstruction', { source: output('source', 'piece'), events: output('trace', 'events') }),
  ]

  const rootStatus = (prefix: string): GameplayStatement[] => [
    call(prefix + '-hit-id', 'piece.identifier', { piece: output('hit-ref', 'piece') }),
    call(prefix + '-root-id-prefix', 'text.concat', { left: literal('root-'), right: output('source-id', 'value') }),
    call(prefix + '-root-id-separator', 'text.concat', { left: output(prefix + '-root-id-prefix', 'text'), right: literal('-') }),
    call(prefix + '-root-id', 'text.concat', { left: output(prefix + '-root-id-separator', 'text'), right: output(prefix + '-hit-id', 'id') }),
    {
      kind: 'record.create', id: prefix + '-root-record', schema: VENOM_ROOT_SCHEMA.id, fields: {
        id: output(prefix + '-root-id', 'text'), type: literal('root'), name: literal('定身'),
        currentDuration: literal(1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1),
        sourceId: output('source-id', 'value'),
      },
    },
    call(prefix + '-apply-root', 'status.apply-record', { target: output('hit-ref', 'piece'), record: output(prefix + '-root-record', 'value') }, { inputPolicy: 'host' }),
    call(prefix + '-message-prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('发动共生拖行，将') }),
    call(prefix + '-message-target', 'text.concat', { left: output(prefix + '-message-prefix', 'text'), right: output('hit-name', 'value') }),
    call(prefix + '-message-suffix', 'value.select-text', { condition: output('long-pull', 'value'), whenTrue: literal('拉到身前并使其定身1回合'), whenFalse: literal('定身1回合') }),
    call(prefix + '-message', 'text.concat', { left: output(prefix + '-message-target', 'text'), right: output(prefix + '-message-suffix', 'text') }),
    ...resultAction(prefix + '-success', literal(true), output(prefix + '-message', 'text')),
  ]

  const longPull: GameplayStatement[] = [
    call('source-coordinates', 'spatial.cell-coordinates', { cell: output('source-position', 'cell') }),
    call('direction-coordinates', 'spatial.cell-coordinates', { cell: output('direction', 'direction') }),
    call('landing-x', 'math.add', { left: output('source-coordinates', 'x'), right: output('direction-coordinates', 'x') }),
    call('landing-y', 'math.add', { left: output('source-coordinates', 'y'), right: output('direction-coordinates', 'y') }),
    call('landing', 'spatial.cell', { x: output('landing-x', 'value'), y: output('landing-y', 'value') }),
    call('landing-legal', 'spatial.cell-landing-legal', { cell: output('landing', 'cell'), ignoreA: output('source', 'piece'), ignoreB: output('hit-ref', 'piece') }, { terrainPolicy: 'walkable' }),
    branch('landing-guard', output('landing-legal', 'legal'), [
      call('pull', 'effect.displace-policy', { piece: output('hit-ref', 'piece'), destination: output('landing', 'cell') }, { kind: 'pull', passAllies: false, passEnemies: false, terrain: 'projectile', blockedTerrainTypes: [] }),
      branch('pull-guard', output('pull', 'success'), rootStatus('pull'), cancelledAction('pull-blocked', '位移被阻挡，本次位移效果取消')),
    ], cancelledAction('landing-invalid', '毒液正前方不是合法落点')),
  ]

  const enemyBody: GameplayStatement[] = [
    call('hit-name', 'piece.captured-name', { source: output('hit-capture', 'source') }, { fallback: 'none' }),
    call('long-pull', 'compare.greater-than', { left: output('obstruction', 'distance'), right: literal(1) }),
  ]
  enemyBody.push(branch('distance-guard', output('long-pull', 'value'), longPull, rootStatus('adjacent')))

  traceBody.push(
    branch('terrain-guard', output('obstruction', 'terrainBlocked'), cancelledAction('terrain', '共生拖行被地形阻挡'), [
      branch('piece-guard', output('obstruction', 'present'), [
        branch('ally-guard', output('obstruction', 'ally'), cancelledAction('ally', '共生拖行被路径上的友方角色阻挡'), [
          call('hit-ref', 'piece.require', { piece: output('obstruction', 'piece') }),
          call('hit-capture', 'source.capture', { source: output('hit-ref', 'piece') }),
          ...enemyBody,
        ]),
      ], cancelledAction('empty', '路径上没有可拖行的敌人')),
    ]),
  )
  validSourceBody.push(branch('direction-guard', output('direction', 'valid'), traceBody, failureAction('direction-invalid', '必须选择与毒液在同一行或同一列的方向')))
  targetBody.push(branch('source-position-guard', output('source-positioned', 'value'), validSourceBody, failureAction('missing-position', '毒液当前不在战场上')))
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body, [VENOM_ROOT_SCHEMA])
}

const MUZAN_ROOT_SCHEMA: GameplayRecordSchema = {
  id: 'movement.muzan-root-status', version: SEMANTIC_MOVEMENT_FAMILY_VERSION,
  fields: [
    port('id', 'string'), port('type', 'string'), port('name', 'string'),
    port('currentDuration', 'number'), port('remainingDuration', 'number'),
    port('stacks', 'number'), port('sourceId', 'string'),
  ],
}

const MUZAN_REDUCTION_SCHEMA: GameplayRecordSchema = {
  id: 'movement.muzan-reduction-status', version: SEMANTIC_MOVEMENT_FAMILY_VERSION,
  fields: [
    port('id', 'string'), port('type', 'string'), port('name', 'string'),
    port('currentDuration', 'number'), port('remainingDuration', 'number'),
    port('intensity', 'number'), port('stacks', 'number'), port('sourceId', 'string'),
    port('relatedRules', { kind: 'list', element: 'string' }),
  ],
}

function buildMuzanDemonBodyGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-capture', 'source.capture', { source: output('source', 'piece') }),
    call('source-id', 'source.captured-identifier', { source: output('source-capture', 'source') }),
    call('source-name', 'piece.captured-name', { source: output('source-capture', 'source') }, { fallback: 'none' }),
    call('target-choice', 'choice.target-cell-by-range', { range: literal(6) }, { filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
  ]

  const targetBody: GameplayStatement[] = [
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('source-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('direction', 'spatial.cardinal-direction', { from: output('source-position', 'cell'), to: output('target', 'cell') }),
  ]

  const statusReductionAndMessage: GameplayStatement[] = [
    call('source-piece-live', 'source.captured-piece-reference', { source: output('source-capture', 'source') }),
    call('reduction-id', 'text.concat', { left: literal('muzan-demon-body-reduction-'), right: output('source-id', 'value') }),
    {
      kind: 'record.create', id: 'reduction-status-record', schema: MUZAN_REDUCTION_SCHEMA.id, fields: {
        id: output('reduction-id', 'text'), type: literal('muzan-damage-reduction'), name: literal('无惨之躯'),
        currentDuration: literal(1), remainingDuration: literal(1), intensity: literal(1), stacks: literal(1),
        sourceId: output('source-id', 'value'), relatedRules: literal(['rule-muzan-damage-reduction']),
      },
    },
    call('apply-reduction', 'status.apply-record', { target: output('source-piece-live', 'piece'), record: output('reduction-status-record', 'value') }),
    call('source-position-final', 'spatial.piece-position', { piece: output('source-piece-live', 'piece') }),
    call('final-coordinates', 'spatial.cell-coordinates', { cell: output('source-position-final', 'cell') }),
    call('final-x-text', 'text.from-number', { value: output('final-coordinates', 'x') }),
    call('final-y-text', 'text.from-number', { value: output('final-coordinates', 'y') }),
    call('hit-count-text', 'text.from-number', { value: output('hit-count-final', 'value') }),
    call('hit-positive', 'compare.greater-than', { left: output('hit-count-final', 'value'), right: literal(0) }),
    call('hit-description-prefix', 'text.concat', { left: literal('，命中'), right: output('hit-count-text', 'text') }),
    call('hit-description-count', 'text.concat', { left: output('hit-description-prefix', 'text'), right: literal('名敌人并使其定身') }),
    call('hit-description', 'value.select-text', { condition: output('hit-positive', 'value'), whenTrue: output('hit-description-count', 'text'), whenFalse: literal('') }),
    call('message-prefix', 'text.concat', { left: output('source-name', 'value'), right: literal('化为无惨之躯冲刺至(') }),
    call('message-x', 'text.concat', { left: output('message-prefix', 'text'), right: output('final-x-text', 'text') }),
    call('message-comma', 'text.concat', { left: output('message-x', 'text'), right: literal(',') }),
    call('message-y', 'text.concat', { left: output('message-comma', 'text'), right: output('final-y-text', 'text') }),
    call('message-close', 'text.concat', { left: output('message-y', 'text'), right: literal(')') }),
    call('message-hits', 'text.concat', { left: output('message-close', 'text'), right: output('hit-description', 'text') }),
    ...appendedResult('success', literal(true), output('message-hits', 'text'), literal('，获得50%减伤1回合')),
  ]

  const loopBody: GameplayStatement[] = [
    call('enemy-index-value', 'local.counter-read', { counter: output('enemy-index', 'counter') }),
    call('enemy-item', 'collection.piece-at', { items: output('actual-enemies', 'pieces'), index: output('enemy-index-value', 'value') }),
    call('enemy-alive-before', 'piece.alive', { piece: output('enemy-item', 'piece') }),
    branch('enemy-alive-guard', output('enemy-alive-before', 'alive'), [
      call('enemy-ref', 'piece.require', { piece: output('enemy-item', 'piece') }),
      call('enemy-capture', 'source.capture', { source: output('enemy-ref', 'piece') }),
      call('enemy-id', 'source.captured-identifier', { source: output('enemy-capture', 'source') }),
      call('damage', 'effect.damage-captured', {
        source: output('source-capture', 'source'), target: output('enemy-capture', 'source'), amount: output('damage-amount', 'value'),
      }, { damageType: 'physical', skillId: 'muzan-demon-body' }),
      call('hit-count-add', 'local.counter-add', { counter: output('hit-count', 'counter'), amount: literal(1) }),
      call('enemy-alive-after', 'piece.alive', { piece: output('enemy-ref', 'piece') }),
      branch('root-alive-guard', output('enemy-alive-after', 'alive'), [
        call('root-id-prefix', 'text.concat', { left: literal('muzan-demon-body-root-'), right: output('source-id', 'value') }),
        call('root-id-separator', 'text.concat', { left: output('root-id-prefix', 'text'), right: literal('-') }),
        call('root-id', 'text.concat', { left: output('root-id-separator', 'text'), right: output('enemy-id', 'value') }),
        {
          kind: 'record.create', id: 'root-status-record', schema: MUZAN_ROOT_SCHEMA.id, fields: {
            id: output('root-id', 'text'), type: literal('root'), name: literal('定身'),
            currentDuration: literal(1), remainingDuration: literal(1), stacks: literal(1), sourceId: output('source-id', 'value'),
          },
        },
        call('apply-root', 'status.apply-record', { target: output('enemy-ref', 'piece'), record: output('root-status-record', 'value') }),
      ]),
    ]),
    call('enemy-index-add', 'local.counter-add', { counter: output('enemy-index', 'counter'), amount: literal(1) }),
  ]
  const loopCondition: GameplayStatement[] = [
    call('enemy-index-condition-value', 'local.counter-read', { counter: inputValue('enemyIndex') }),
    call('enemy-index-continue', 'compare.less-than', { left: output('enemy-index-condition-value', 'value'), right: inputValue('enemyCount') }),
    returnValue('enemy-loop-condition-return', output('enemy-index-continue', 'value')),
  ]

  const processAfterMove: GameplayStatement[] = [
    call('actual-enemies', 'movement.actual-path-enemies', { source: output('source-capture', 'source'), movement: output('move', 'result') }),
    call('enemy-count', 'list.count-pieces', { items: output('actual-enemies', 'pieces') }),
    call('enemy-index', 'local.counter-create', { initial: literal(0) }),
    call('hit-count', 'local.counter-create', { initial: literal(0) }),
    call('attack', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'attack' }),
    call('power', 'skill.power-multiplier'),
    call('scaled-damage', 'math.multiply', { left: output('attack', 'value'), right: output('power', 'value') }),
    call('damage-amount', 'math.floor', { value: output('scaled-damage', 'value') }),
    {
      kind: 'while', id: 'enemy-loop', index: 'enemy-loop-index', budget: 128,
      condition: { inputs: { enemyIndex: output('enemy-index', 'counter'), enemyCount: output('enemy-count', 'value') }, body: loopCondition },
      body: loopBody,
    },
    call('hit-count-final', 'local.counter-read', { counter: output('hit-count', 'counter') }),
    call('source-hp-after-damage', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'currentHp' }),
    call('source-present-after-damage', 'query.has-piece-id', { id: output('source-id', 'value') }),
    call('source-hp-positive-after-damage', 'compare.greater-than', { left: output('source-hp-after-damage', 'value'), right: literal(0) }),
    call('source-live-after-damage', 'logic.and', { left: output('source-present-after-damage', 'exists'), right: output('source-hp-positive-after-damage', 'value') }),
    branch('source-live-after-damage-guard', output('source-live-after-damage', 'value'), statusReductionAndMessage, [
      call('dead-hit-count-text', 'text.from-number', { value: output('hit-count-final', 'value') }),
      call('dead-message-prefix', 'text.concat', { left: literal('无惨之躯命中'), right: output('dead-hit-count-text', 'text') }),
      ...appendedResult('dead-result', literal(true), output('dead-message-prefix', 'text'), literal('名敌人，但无惨已死亡')),
    ]),
  ]

  const traceBody: GameplayStatement[] = [
    call('trace', 'movement.trace', {
      source: output('source', 'piece'), direction: output('direction', 'direction'), maxDistance: output('direction', 'distance'),
    }, { passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: [] }),
    call('last-landable-equal', 'spatial.cell-equal', { left: output('trace', 'lastLandable'), right: output('target', 'cell') }),
    call('path-reached', 'logic.and', { left: output('trace', 'reachedTarget'), right: output('last-landable-equal', 'value') }),
    branch('path-guard', output('path-reached', 'value'), [
      call('destination', 'spatial.cell-require', { cell: output('trace', 'lastLandable') }),
      call('move', 'effect.displace-policy', { piece: output('source', 'piece'), destination: output('destination', 'cell') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: [] }),
      branch('move-success-guard', output('move', 'success'), [
        call('move-has-path', 'compare.greater-than', { left: output('move', 'steps'), right: literal(0) }),
        branch('move-path-guard', output('move-has-path', 'value'), [
          call('source-hp-after-move', 'source.captured-number', { source: output('source-capture', 'source') }, { field: 'currentHp' }),
          call('source-present-after-move', 'query.has-piece-id', { id: output('source-id', 'value') }),
          call('source-hp-positive-after-move', 'compare.greater-than', { left: output('source-hp-after-move', 'value'), right: literal(0) }),
          call('source-alive-after-move', 'logic.and', { left: output('source-present-after-move', 'exists'), right: output('source-hp-positive-after-move', 'value') }),
          branch('source-alive-after-move-guard', output('source-alive-after-move', 'value'), processAfterMove, cancelledAction('source-died-during-move', '无惨在冲刺途中死亡，后续效果取消')),
        ], cancelledAction('no-path-change', '冲刺没有产生位移，本次技能效果取消')),
      ], cancelledAction('move-invalidated', '冲刺落点已失效，本次位移取消')),
    ], failureAction('path-blocked', '冲刺路径被阻挡')),
  ]

  const validatedTargetBody: GameplayStatement[] = [
    call('walkable', 'spatial.cell-walkable', { cell: output('target', 'cell') }),
    branch('walkable-guard', output('walkable', 'walkable'), [
      call('unoccupied', 'spatial.cell-unoccupied', { cell: output('target', 'cell') }),
      branch('unoccupied-guard', output('unoccupied', 'value'), traceBody, failureAction('occupied', '目标地格已有棋子')),
    ], failureAction('not-walkable', '目标地格不可行走')),
  ]
  targetBody.push(
    branch('direction-guard', output('direction', 'valid'), [
      call('distance-too-short', 'compare.less-than', { left: output('direction', 'distance'), right: literal(1) }),
      call('distance-too-long', 'compare.greater-than', { left: output('direction', 'distance'), right: literal(6) }),
      call('distance-invalid', 'logic.or', { left: output('distance-too-short', 'value'), right: output('distance-too-long', 'value') }),
      branch('distance-guard', output('distance-invalid', 'value'), failureAction('distance-invalid', '目标地格必须在正方向6格内'), validatedTargetBody),
    ], failureAction('direction-invalid', '请选择正方向地格')),
  )
  sourceBody.push(branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice'), targetBody))
  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return graph(body, [MUZAN_ROOT_SCHEMA, MUZAN_REDUCTION_SCHEMA])
}

export const MOVEMENT_FAMILY_BUILDERS = Object.freeze({
  'skills/shadow-step': buildShadowStepGraph,
  'skills/shadow-step-teleport': buildShadowStepTeleportGraph,
  'skills/obito-ally-teleport': buildObitoAllyTeleportGraph,
  'skills/obito-space-time': buildObitoSpaceTimeGraph,
  'skills/akaza-flash-step': buildAkazaFlashStepGraph,
  'skills/sonic-spin-dash': buildSonicSpinDashGraph,
  'skills/sonic-homing-attack': buildSonicHomingAttackGraph,
  'skills/shadow-ride-sweep': buildShadowRideSweepGraph,
  'skills/illidan-blade-dash': buildIllidanBladeDashGraph,
  'skills/mortis-shovel-charge': buildMortisShovelChargeGraph,
  'skills/el-primo-elbow': buildElPrimoElbowGraph,
  'skills/edgar-pogo-jump': buildEdgarPogoJumpGraph,
  'skills/max-phase-shifter': buildMaxPhaseShifterGraph,
  'skills/alfonso-kick': buildAlfonsoKickGraph,
  'skills/alfonso-water-dash': buildAlfonsoWaterDashGraph,
  'skills/rocket-punch': buildRocketPunchGraph,
  'skills/muzan-demon-body': buildMuzanDemonBodyGraph,
  'skills/venom-host-transfer': buildVenomHostTransferGraph,
  'skills/venom-symbiote-drag': buildVenomSymbioteDragGraph,
})

export function buildMovementFamilyGraph(id: (typeof MOVEMENT_FAMILY_SKILL_IDS)[number]): GameplayModuleGraph {
  return MOVEMENT_FAMILY_BUILDERS[id]()
}

export type SemanticMovementFamilyMigration = {
  readonly id: (typeof MOVEMENT_FAMILY_SKILL_IDS)[number]
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly build: () => GameplayModuleGraph
}

export const SEMANTIC_MOVEMENT_FAMILY_MIGRATIONS: readonly SemanticMovementFamilyMigration[] = Object.freeze(
  MOVEMENT_FAMILY_SKILL_IDS.map(id => ({ id, field: 'code' as const, surface: 'skill' as const, build: MOVEMENT_FAMILY_BUILDERS[id] })),
)
export const SEMANTIC_MOVEMENT_FAMILY_MIGRATION_IDS = Object.freeze(SEMANTIC_MOVEMENT_FAMILY_MIGRATIONS.map(entry => `${entry.id}.${entry.field}`))

function isRecord(value: unknown): value is JsonRecord { return !!value && typeof value === 'object' && !Array.isArray(value) }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(',')}}`
}
const GENERATED_FIELDS = new Set(['code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])

function assertCompatibility(current: JsonRecord, baseline: JsonRecord, id: string): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (GENERATED_FIELDS.has(key)) continue
    if (canonicalJson(current[key]) !== canonicalJson(baseline[key])) throw new Error(`${id}: compatibility field changed before semantic migration: ${key}`)
  }
}

function relativeFile(id: string): string { return path.join('data', 'skills', id.slice('skills/'.length) + '.json') }
function readJson(file: string): JsonRecord {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`${file}: expected JSON object`)
  return value
}

function applyMovementGraph(inputDocument: JsonRecord, graphValue: GameplayModuleGraph): JsonRecord {
  const compiled = compileGameplayModuleGraph(graphValue, GAMEPLAY_MODULE_REGISTRY)
  if (compiled.surface !== 'skill') throw new Error('movement family graph must target skill surface')
  const next: JsonRecord = { ...inputDocument }
  const additional: JsonRecord = isRecord(inputDocument.contentGraphEntries) ? { ...inputDocument.contentGraphEntries } : {}
  const primaryField = isRecord(inputDocument.contentGraph) && typeof inputDocument.contentGraphField === 'string' ? inputDocument.contentGraphField : ''
  if (primaryField === 'code') {
    delete next.contentGraph
    delete next.contentGraphField
    delete next.contentGraphCompilerVersion
    const first = Object.keys(additional).sort()[0]
    if (first) {
      const entry = additional[first]
      if (!isRecord(entry)) throw new Error(`invalid legacy graph entry ${first}`)
      next.contentGraph = entry.graph
      next.contentGraphField = first
      next.contentGraphCompilerVersion = entry.compilerVersion
      delete additional[first]
    }
  } else {
    delete additional.code
  }
  if (Object.keys(additional).length) next.contentGraphEntries = additional
  else delete next.contentGraphEntries
  next.code = compiled.code
  const prior = isRecord(inputDocument.gameplayModules) && isRecord(inputDocument.gameplayModules.entries) ? inputDocument.gameplayModules as JsonRecord & { entries: Record<string, unknown> } : undefined
  next.gameplayModules = {
    ...(prior && prior.textBindings !== undefined ? { textBindings: prior.textBindings } : {}),
    version: 'rvb-gameplay-module-document/v1',
    entries: { ...(prior?.entries ?? {}), code: { graph: JSON.parse(JSON.stringify(graphValue)), compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION } },
  }
  assertGameplayModuleDocument(next)
  return next
}

export function applySemanticMovementFamilyGraph(inputDocument: JsonRecord, graphValue: GameplayModuleGraph): JsonRecord { return applyMovementGraph(inputDocument, graphValue) }

function migrateOne(root: string, baseline: JsonRecord, entry: SemanticMovementFamilyMigration): JsonRecord {
  const baselineEntry = isRecord(baseline.entries) ? baseline.entries[entry.id] : undefined
  if (!isRecord(baselineEntry)) throw new Error(`${entry.id}: missing frozen baseline entry`)
  if (typeof baselineEntry.code !== 'string') throw new Error(`${entry.id}: frozen entry has no code`)
  const file = path.join(root, relativeFile(entry.id))
  if (!fs.existsSync(file)) throw new Error(`${entry.id}: production file does not exist`)
  const current = readJson(file)
  assertCompatibility(current, baselineEntry, entry.id)
  const owned = isRecord(current.gameplayModules) && isRecord(current.gameplayModules.entries) ? current.gameplayModules.entries.code : undefined
  if (isRecord(owned)) {
    const expected = entry.build()
    if (canonicalJson(owned.graph) === canonicalJson(expected)) return applyMovementGraph(current, expected)
    // A module-owned graph is authoritative once persisted.  Do not silently
    // accept an unrelated graph as a migration input: that would let an
    // author override the frozen migration contract while the CLI reports a
    // successful dry-run.  Validate the document first so malformed generated
    // code still reports its concrete document error, then block with the
    // graph provenance mismatch.
    assertGameplayModuleDocument(current)
    throw new Error(`${entry.id}: existing gameplay module graph differs from the frozen migration graph`)
  }
  if (current.gameplayModules !== undefined) {
    const sanitized: JsonRecord = { ...current }
    if (isRecord(sanitized.contentGraph) && sanitized.contentGraphField === 'code') {
      delete sanitized.contentGraph
      delete sanitized.contentGraphField
      delete sanitized.contentGraphCompilerVersion
    }
    assertGameplayModuleDocument(sanitized)
  }
  assertFrozenExecutable(current, baselineEntry, 'code', 'skill', entry.id)
  return applyMovementGraph(current, entry.build())
}

export type SemanticMovementFamilyResult = {
  readonly id: string
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly status: 'ready' | 'blocked'
  readonly error?: string
  readonly document?: JsonRecord
  readonly file?: string
}

export function runSemanticMovementFamilyMigrations(root: string, baseline: JsonRecord, selectedIds?: readonly string[]): readonly SemanticMovementFamilyResult[] {
  const selected = selectedIds?.length
    ? SEMANTIC_MOVEMENT_FAMILY_MIGRATIONS.filter(entry => selectedIds.includes(entry.id) || selectedIds.includes(`${entry.id}.${entry.field}`))
    : SEMANTIC_MOVEMENT_FAMILY_MIGRATIONS
  return selected.map(entry => {
    const file = path.join(root, relativeFile(entry.id))
    try { return { id: entry.id, field: entry.field, surface: entry.surface, status: 'ready', document: migrateOne(root, baseline, entry), file } }
    catch (error) { return { id: entry.id, field: entry.field, surface: entry.surface, status: 'blocked', error: error instanceof Error ? error.message : String(error), file } }
  })
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2), write = args.includes('--write'), requested = args.filter(argument => argument !== '--write')
  if (requested.some(id => !SEMANTIC_MOVEMENT_FAMILY_MIGRATION_IDS.includes(id) && !MOVEMENT_FAMILY_SKILL_IDS.includes(id as never))) throw new Error(`Unknown movement-family migration: ${requested.join(', ')}`)
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const results = runSemanticMovementFamilyMigrations(root, baseline, requested)
  const blocked = results.filter(result => result.status === 'blocked')
  if (write && blocked.length) throw new Error(JSON.stringify({ message: 'Semantic movement-family migration is blocked; no production files were written.', blocked }, null, 2))
  if (write) for (const result of results) {
    if (!result.document || !result.file) throw new Error(`${result.id}: missing migrated document`)
    fs.writeFileSync(result.file, JSON.stringify(result.document, null, 2) + '\n', 'utf8')
  }
  console.log(JSON.stringify({ mode: write ? 'written' : 'dry-run', compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION, baseSha: baseline.baseSha, migrations: results.map(({ id, field, surface, status, error }) => ({ id, field, surface, status, error })) }, null, 2))
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()
