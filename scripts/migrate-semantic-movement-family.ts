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
] as const

type JsonRecord = Record<string, unknown>
type GraphField = 'code'

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
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
      call('apply-status', 'status.apply-record', { target: output('source', 'piece'), record: output('status-record', 'value') }),
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

export const MOVEMENT_FAMILY_BUILDERS = Object.freeze({
  'skills/shadow-step': buildShadowStepGraph,
  'skills/shadow-step-teleport': buildShadowStepTeleportGraph,
  'skills/obito-ally-teleport': buildObitoAllyTeleportGraph,
  'skills/obito-space-time': buildObitoSpaceTimeGraph,
  'skills/akaza-flash-step': buildAkazaFlashStepGraph,
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
