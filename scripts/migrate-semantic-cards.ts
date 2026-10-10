import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleGraph,
  type GameplayLiteral,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'
import { assertFrozenExecutable } from './semantic-migration-source'

const value = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, string | number | boolean> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], otherwise: GameplayStatement[] = []): GameplayStatement => ({ kind: 'if', id, condition, then, else: otherwise })
const returnResult = (id: string, result: GameplayValue): GameplayStatement => ({ kind: 'return', id, value: result })

const resultBranch = (id: string, success: boolean, message?: string): GameplayStatement[] => {
  const result = `${id}-result`
  return [
    call(result, 'result.action', { success: value(success), ...(message === undefined ? {} : { message: value(message) }) }),
    returnResult(`${id}-return`, out(result, 'result')),
  ]
}

const recordCreate = (id: string, schema: string, fields: Record<string, GameplayValue>): GameplayStatement => ({ kind: 'record.create', id, schema, fields })

const textMessage = (body: GameplayStatement[], parts: (string | GameplayValue)[], prefix: string): GameplayValue => {
  let message: GameplayValue = value('')
  parts.forEach((part, index) => {
    const id = `${prefix}-${index}`
    body.push(call(id, 'text.concat', { left: message, right: typeof part === 'string' ? value(part) : part }))
    message = out(id, 'text')
  })
  return message
}

const commonSchemas: readonly GameplayRecordSchema[] = [
  {
    id: 'damage-buff-status',
    version: '1',
    fields: [
      { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' },
      { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' },
      { name: 'intensity', type: 'number' }, { name: 'stacks', type: 'number' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
    ],
  },
  {
    id: 'calm-shield-status',
    version: '1',
    fields: [
      { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' },
      { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' },
      { name: 'intensity', type: 'number' }, { name: 'stacks', type: 'number' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
    ],
  },
  {
    id: 'stance-status',
    version: '1',
    fields: [
      { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' },
      { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' },
      { name: 'intensity', type: 'number' }, { name: 'stacks', type: 'number' },
    ],
  },
]

const graph = (body: GameplayStatement[], schemas = commonSchemas): GameplayModuleGraph => ({
  version: GAMEPLAY_MODULE_GRAPH_VERSION,
  surface: 'card',
  outputs: [{ name: 'result', type: 'record', nullable: true }],
  body,
  schemas,
})

export const SEMANTIC_CARD_IDS = [
  'demon-summon-1', 'demon-summon-2', 'demon-summon-3', 'demon-summon-4', 'demon-summon-5',
  'hashirama-edo-nature-heal', 'hashirama-edo-thousand-hands',
  'holy-charge', 'holy-heal', 'holy-smite', 'sample-reactive-card', 'soul-fragment',
  'watcher-calm', 'watcher-rage',
] as const

type SemanticCardId = typeof SEMANTIC_CARD_IDS[number]

function demonSummonGraph(index: number): GameplayModuleGraph {
  const id = `demon-summon-${index}`
  const amount = index + 1
  const next = index < 5 ? `demon-summon-${index + 1}` : null
  const body: GameplayStatement[] = [
    call('owner', 'ref.player'),
    call('owner-valid', 'query.player', { playerId: out('owner', 'player') }),
    call('choice', 'choice.target-piece', {}, { range: 99, filter: 'ally' }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    branch('wait-or-cancel', out('unresolved', 'value'), [
      call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }),
      returnResult('return-selection', out('selection-result', 'result')),
    ]),
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
    call('captured-target', 'source.capture', { source: out('target', 'piece') }),
    call('damage', 'effect.damage-from-player', { owner: out('owner-valid', 'player'), target: out('target', 'piece'), amount: value(amount) }, { kind: 'player', instanceId: 'demon-ritual', name: '恶魔仪式', damageType: 'true', skillId: id, inputPolicy: 'host' }),
    call('attack', 'attribute.adjust-captured', { source: out('captured-target', 'source'), amount: value(1) }, { attribute: 'attack' }),
  ]
  if (next) body.push(call('next-card', 'card.hand-add', { player: out('owner-valid', 'player') }, { cardId: next }))
  const ordinal = ['', '一', '二', '三', '四'][index]
  body.push(call('target-name', 'piece.captured-name', { source: out('captured-target', 'source') }))
  body.push(call('message-final-0', 'text.concat', { left: value(`恶魔仪式第${ordinal}印记：`), right: out('target-name', 'value') }))
  body.push(call('message-final-1', 'text.concat', { left: out('message-final-0', 'text'), right: value(`承受${amount}点真实伤害，攻击力+1${next ? `，【恶魔召唤（${index + 1}）】已加入手牌` : ''}`) }))
  body.push(call('result', 'result.action', { success: value(true), message: out('message-final-1', 'text') }), returnResult('return-result', out('result', 'result')))
  return graph(body)
}

function demonSummonFiveGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('owner', 'ref.player'),
    call('owner-valid', 'query.player', { playerId: out('owner', 'player') }),
    call('anchor-choice', 'choice.target-piece', {}, { range: 99, filter: 'ally' }),
    call('anchor-unresolved', 'choice.is-unresolved', { choice: out('anchor-choice', 'choice') }),
    branch('anchor-wait-or-cancel', out('anchor-unresolved', 'value'), [
      call('anchor-selection-result', 'choice.as-result', { choice: out('anchor-choice', 'choice') }),
      returnResult('return-anchor-selection', out('anchor-selection-result', 'result')),
    ]),
    call('anchor', 'choice.piece', { choice: out('anchor-choice', 'choice') }),
    call('captured-anchor', 'source.capture', { source: out('anchor', 'piece') }),
    call('cell-choice', 'choice.target-cell', {}, { range: 99, filter: 'all' }),
    call('cell-unresolved', 'choice.is-unresolved', { choice: out('cell-choice', 'choice') }),
    branch('cell-wait-or-cancel', out('cell-unresolved', 'value'), [
      call('cell-selection-result', 'choice.as-result', { choice: out('cell-choice', 'choice') }),
      returnResult('return-cell-selection', out('cell-selection-result', 'result')),
    ]),
    call('cell', 'choice.cell', { choice: out('cell-choice', 'choice') }),
    call('walkable', 'spatial.cell-walkable', { cell: out('cell', 'cell') }),
    call('not-walkable', 'logic.not', { value: out('walkable', 'walkable') }),
    branch('walkable-guard', out('not-walkable', 'value'), resultBranch('walkable-failed', false, '召唤位置必须是可行走地格')),
    call('unoccupied', 'card.cell-unoccupied', { cell: out('cell', 'cell') }),
    call('occupied', 'logic.not', { value: out('unoccupied', 'value') }),
    branch('occupied-guard', out('occupied', 'value'), resultBranch('occupied-failed', false, '召唤位置已被占用')),
    call('summon-available', 'summon.unique-template-available', { owner: out('owner-valid', 'player') }, {
      templateId: 'kiljaedan', storageExtensionKey: 'kiljaedanPiece', ownerScopedStorageExtensionKey: 'kiljaedanPiecesByPlayerId',
    }),
    call('summon-unavailable', 'logic.not', { value: out('summon-available', 'available') }),
    branch('summon-guard', out('summon-unavailable', 'value'), resultBranch('summon-failed', false, '基尔加丹已经在场上')),
    call('damage', 'effect.damage-from-player', { owner: out('owner-valid', 'player'), target: out('anchor', 'piece'), amount: value(6) }, { kind: 'player', instanceId: 'demon-ritual', name: '恶魔仪式', damageType: 'true', skillId: 'demon-summon-5', inputPolicy: 'host' }),
    call('attack', 'attribute.adjust-captured', { source: out('captured-anchor', 'source'), amount: value(1) }, { attribute: 'attack' }),
    call('queue', 'lifecycle.summon-captured', { source: out('captured-anchor', 'source'), cell: out('cell', 'cell') }),
    call('coordinates', 'spatial.cell-coordinates', { cell: out('cell', 'cell') }),
    call('x-text', 'text.from-number', { value: out('coordinates', 'x') }),
    call('y-text', 'text.from-number', { value: out('coordinates', 'y') }),
  ]
  body.push(call('anchor-name', 'piece.captured-name', { source: out('captured-anchor', 'source') }))
  body.push(call('message-0', 'text.concat', { left: out('anchor-name', 'value'), right: value('以血肉完成最终仪式（攻击力+1），基尔加丹从虚空降临并被召唤到(') }))
  body.push(call('message-1', 'text.concat', { left: out('message-0', 'text'), right: out('x-text', 'text') }))
  body.push(call('message-2', 'text.concat', { left: out('message-1', 'text'), right: value(',') }))
  body.push(call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('y-text', 'text') }))
  body.push(call('message-4', 'text.concat', { left: out('message-3', 'text'), right: value(')') }))
  body.push(call('result', 'result.action', { success: value(true), message: out('message-4', 'text') }), returnResult('return-result', out('result', 'result')))
  return graph(body)
}

function hashiramaNatureHealGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('owner', 'ref.player'),
    call('hashirama', 'card.bound-living-template', { owner: out('owner', 'player') }, { templateId: 'hashirama-edo', cardId: 'hashirama-edo-nature-heal' }),
    call('has-hashirama', 'card.piece-present', { value: out('hashirama', 'piece') }),
    call('missing', 'logic.not', { value: out('has-hashirama', 'present') }),
    branch('missing-guard', out('missing', 'value'), resultBranch('missing-result', false, '场上没有存活的柱间')),
    call('hashirama-valid', 'query.piece', { pieceId: out('hashirama', 'piece') }),
    call('captured-hashirama', 'source.capture', { source: out('hashirama-valid', 'piece') }),
    call('max-hp', 'attribute.read', { piece: out('hashirama-valid', 'piece') }, { attribute: 'maxHp' }),
    call('current-hp', 'attribute.read', { piece: out('hashirama-valid', 'piece') }, { attribute: 'currentHp' }),
    call('missing-hp', 'math.subtract', { left: out('max-hp', 'value'), right: out('current-hp', 'value') }),
    call('full', 'compare.less-or-equal', { left: out('missing-hp', 'value'), right: value(0) }),
  ]
  const fullName = 'full-name'
  body.push(call(fullName, 'piece.captured-name', { source: out('captured-hashirama', 'source') }))
  body.push(branch('full-guard', out('full', 'value'), [
    call('full-message', 'text.concat', { left: out(fullName, 'value'), right: value(' 生命值已满，无需治疗') }),
    call('full-result', 'result.action', { success: value(true), message: out('full-message', 'text') }),
    returnResult('return-full', out('full-result', 'result')),
  ], [
    call('scaled', 'math.multiply', { left: out('missing-hp', 'value'), right: value(0.8) }),
    call('heal-amount', 'math.floor', { value: out('scaled', 'value') }),
    call('heal', 'effect.heal', { source: out('hashirama-valid', 'piece'), target: out('hashirama-valid', 'piece'), amount: out('heal-amount', 'value') }, { skillId: 'hashirama-edo-nature-heal' }),
    call('heal-text', 'text.from-number', { value: out('heal', 'heal') }),
    call('message', 'text.concat', { left: value('仙术·大自然愈合！'), right: out(fullName, 'value') }),
    call('message-2', 'text.concat', { left: out('message', 'text'), right: value(' 恢复 ') }),
    call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('heal-text', 'text') }),
    call('message-4', 'text.concat', { left: out('message-3', 'text'), right: value(' 点生命值') }),
    call('success-result', 'result.action', { success: value(true), message: out('message-4', 'text') }),
    returnResult('return-success', out('success-result', 'result')),
  ]))
  return graph(body)
}

function hashiramaThousandHandsGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('owner', 'ref.player'),
    call('hashirama', 'card.bound-living-template', { owner: out('owner', 'player') }, { templateId: 'hashirama-edo', cardId: 'hashirama-edo-thousand-hands' }),
    call('has-hashirama', 'card.piece-present', { value: out('hashirama', 'piece') }),
    call('missing', 'logic.not', { value: out('has-hashirama', 'present') }),
    branch('missing-guard', out('missing', 'value'), resultBranch('missing-result', false, '场上没有存活的柱间')),
    call('hashirama-valid', 'query.piece', { pieceId: out('hashirama', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 99, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    branch('wait-or-cancel', out('unresolved', 'value'), [
      call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }),
      returnResult('return-selection', out('selection-result', 'result')),
    ]),
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
    call('target-valid', 'query.piece', { pieceId: out('target', 'piece') }),
    call('captured-source', 'source.capture', { source: out('hashirama-valid', 'piece') }),
    call('captured-target', 'source.capture', { source: out('target-valid', 'piece') }),
    call('attack', 'attribute.read', { piece: out('hashirama-valid', 'piece') }, { attribute: 'attack' }),
    call('damage', 'effect.damage', { source: out('hashirama-valid', 'piece'), target: out('target-valid', 'piece'), amount: out('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'hashirama-edo-thousand-hands', inputPolicy: 'host' }),
    call('source-name', 'piece.captured-name', { source: out('captured-source', 'source') }),
    call('target-name', 'piece.captured-name', { source: out('captured-target', 'source') }),
    call('damage-text', 'text.from-number', { value: out('damage', 'damage') }),
  ]
  const message = textMessage(body, [out('source-name', 'value'), ' 对', out('target-name', 'value'), ' 造成 ', out('damage-text', 'text'), ' 点物理伤害'], 'message')
  body.push(call('message-prefix', 'text.concat', { left: value('木遁·真数千手：'), right: message }), call('result', 'result.action', { success: value(true), message: out('message-prefix', 'text') }), returnResult('return-result', out('result', 'result')))
  return graph(body)
}

function holyChargeGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('owner', 'ref.player'), call('owner-valid', 'query.player', { playerId: out('owner', 'player') }), call('has-player', 'query.has-player', { playerId: out('owner', 'player') })]
  body.push(branch('player-guard', out('has-player', 'exists'), [
    call('allies', 'query.affectable-pieces', { owner: out('owner', 'player') }, { relation: 'ally' }),
    call('amount', 'player.consume-buff', { player: out('owner-valid', 'player') }, { buffId: 'elune-blessing-buff' }),
    call('scaled', 'math.multiply', { left: value(2), right: out('amount', 'multiplier') }),
    call('buff-amount', 'math.floor', { value: out('scaled', 'value') }),
    {
      kind: 'foreach', id: 'apply-to-allies', items: out('allies', 'pieces'), item: 'ally', body: [
        recordCreate('damage-buff-record', 'damage-buff-status', {
          id: value('damage-buff'), type: value('damage-buff'), name: value('强化'), currentDuration: value(-1), currentUses: value(1),
          intensity: out('buff-amount', 'value'), stacks: value(1), relatedRules: value(['rule-damage-buff']),
        }),
        call('status', 'effect.status-record', { target: out('apply-to-allies', 'item'), record: out('damage-buff-record', 'value') }, { inputPolicy: 'host' }),
        call('has-rule', 'rule.has-piece', { piece: out('apply-to-allies', 'item') }, { ruleId: 'rule-damage-buff' }),
        call('missing-rule', 'logic.not', { value: out('has-rule', 'value') }),
        branch('rule-guard', out('missing-rule', 'value'), [call('add-rule', 'rule.apply-piece', { target: out('apply-to-allies', 'item') }, { ruleId: 'rule-damage-buff' })]),
      ],
    },
    call('buff-fragment', 'text.optional-fragment', { condition: out('amount', 'applied'), value: value('') }, { prefix: '（月神赐福强化）' }),
    call('message', 'text.concat', { left: value('圣光充能'), right: out('buff-fragment', 'text') }),
    call('message-2', 'text.concat', { left: out('message', 'text'), right: value('：己方所有棋子下次伤害+') }),
    call('amount-text', 'text.from-number', { value: out('buff-amount', 'value') }),
    call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('amount-text', 'text') }),
    call('result', 'result.action', { success: value(true), message: out('message-3', 'text') }),
    returnResult('return-success', out('result', 'result')),
  ], resultBranch('player-failed', false, '找不到玩家')))
  return graph(body)
}

function holyHealGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('owner', 'ref.player'), call('owner-valid', 'query.player', { playerId: out('owner', 'player') }), call('has-player', 'query.has-player', { playerId: out('owner', 'player') })]
  body.push(branch('player-guard', out('has-player', 'exists'), [
    call('allies', 'query.affectable-pieces', { owner: out('owner', 'player') }, { relation: 'ally' }),
    call('ally-count', 'list.count-pieces', { items: out('allies', 'pieces') }),
    call('no-allies', 'compare.equal', { left: out('ally-count', 'value'), right: value(0) }),
    branch('ally-guard', out('no-allies', 'value'), resultBranch('no-allies-result', false, '没有友方'), [
      call('target', 'query.lowest-hp', { pieces: out('allies', 'pieces') }),
      call('target-valid', 'query.piece', { pieceId: out('target', 'piece') }),
      call('captured-target', 'source.capture', { source: out('target-valid', 'piece') }),
      call('buff', 'player.consume-buff', { player: out('owner-valid', 'player') }, { buffId: 'elune-blessing-buff' }),
      call('scaled', 'math.multiply', { left: value(8), right: out('buff', 'multiplier') }),
      call('amount', 'math.floor', { value: out('scaled', 'value') }),
      call('heal', 'effect.heal', { source: out('target-valid', 'piece'), target: out('target-valid', 'piece'), amount: out('amount', 'value') }, { skillId: 'holy-heal' }),
      call('name', 'piece.captured-name', { source: out('captured-target', 'source') }),
      call('heal-text', 'text.from-number', { value: out('heal', 'heal') }),
      call('buff-fragment', 'text.optional-fragment', { condition: out('buff', 'applied'), value: value('') }, { prefix: '（月神赐福强化）' }),
      call('message', 'text.concat', { left: value('圣光治疗'), right: out('buff-fragment', 'text') }),
      call('message-2', 'text.concat', { left: out('message', 'text'), right: value('使') }),
      call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('name', 'value') }),
      call('message-4', 'text.concat', { left: out('message-3', 'text'), right: value('恢复') }),
      call('message-5', 'text.concat', { left: out('message-4', 'text'), right: out('heal-text', 'text') }),
      call('message-6', 'text.concat', { left: out('message-5', 'text'), right: value('点生命') }),
      call('result', 'result.action', { success: value(true), message: out('message-6', 'text') }),
      returnResult('return-success', out('result', 'result')),
    ]),
  ], resultBranch('player-failed', false, '找不到玩家')))
  return graph(body)
}

function holySmiteGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('owner', 'ref.player'), call('owner-valid', 'query.player', { playerId: out('owner', 'player') }), call('has-player', 'query.has-player', { playerId: out('owner', 'player') })]
  body.push(branch('player-guard', out('has-player', 'exists'), [
    call('enemies', 'query.affectable-pieces', { owner: out('owner', 'player') }, { relation: 'enemy' }),
    call('enemy-count', 'list.count-pieces', { items: out('enemies', 'pieces') }),
    call('no-enemies', 'compare.equal', { left: out('enemy-count', 'value'), right: value(0) }),
    branch('enemy-guard', out('no-enemies', 'value'), resultBranch('no-enemies-result', false, '没有敌人'), [
      call('target', 'query.lowest-hp', { pieces: out('enemies', 'pieces') }),
      call('target-valid', 'query.piece', { pieceId: out('target', 'piece') }),
      call('captured-target', 'source.capture', { source: out('target-valid', 'piece') }),
      call('buff', 'player.consume-buff', { player: out('owner-valid', 'player') }, { buffId: 'elune-blessing-buff' }),
      call('scaled', 'math.multiply', { left: value(5), right: out('buff', 'multiplier') }),
      call('amount', 'math.floor', { value: out('scaled', 'value') }),
      call('damage', 'effect.damage-from-player', { owner: out('owner-valid', 'player'), target: out('target-valid', 'piece'), amount: out('amount', 'value') }, { kind: 'player', instanceId: 'holy-smite', name: '圣光惩击', damageType: 'true', skillId: 'holy-smite', inputPolicy: 'host' }),
      call('name', 'piece.captured-name', { source: out('captured-target', 'source') }),
      call('damage-text', 'text.from-number', { value: out('damage', 'damage') }),
      call('buff-fragment', 'text.optional-fragment', { condition: out('buff', 'applied'), value: value('') }, { prefix: '（月神赐福强化）' }),
      call('message', 'text.concat', { left: value('圣光惩击'), right: out('buff-fragment', 'text') }),
      call('message-2', 'text.concat', { left: out('message', 'text'), right: value('对') }),
      call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('name', 'value') }),
      call('message-4', 'text.concat', { left: out('message-3', 'text'), right: value('造成') }),
      call('message-5', 'text.concat', { left: out('message-4', 'text'), right: out('damage-text', 'text') }),
      call('message-6', 'text.concat', { left: out('message-5', 'text'), right: value('点真实伤害') }),
      call('result', 'result.action', { success: value(true), message: out('message-6', 'text') }),
      returnResult('return-success', out('result', 'result')),
    ]),
  ], resultBranch('player-failed', false, '找不到玩家')))
  return graph(body)
}

function sampleReactiveGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source', 'source.capture-event-piece', {}, { field: 'sourcePiece' }),
    call('has-source', 'source.is-present', { source: out('source', 'source') }),
    branch('source-guard', out('has-source', 'value'), [
      call('target', 'source.capture-event-piece', {}, { field: 'targetPiece' }),
      call('has-target', 'source.is-present', { source: out('target', 'source') }),
      branch('target-guard', out('has-target', 'value'), [
        call('source-valid', 'source.require-present', { source: out('source', 'source') }),
        call('target-valid', 'source.require-present', { source: out('target', 'source') }),
        call('target-owner', 'source.captured-owner', { source: out('target-valid', 'source') }),
        call('owner', 'ref.player'),
        call('same-owner', 'compare.player-reference', { left: out('target-owner', 'player'), right: out('owner', 'player') }),
        branch('friendly-target-guard', out('same-owner', 'value'), [
          call('damage', 'effect.damage-captured', { source: out('target-valid', 'source'), target: out('source-valid', 'source'), amount: value(5) }, { damageType: 'true', skillId: 'sample-reactive-card' }),
          call('attacker-name', 'piece.captured-name', { source: out('source-valid', 'source') }, { fallback: 'templateId' }),
          call('message', 'text.concat', { left: value('反击意志：对'), right: out('attacker-name', 'value') }),
          call('message-2', 'text.concat', { left: out('message', 'text'), right: value('造成5点真实伤害') }),
          call('result', 'result.action', { success: value(true), message: out('message-2', 'text') }),
          returnResult('return-success', out('result', 'result')),
        ], resultBranch('friendly-target', false)),
      ], resultBranch('missing-target', false)),
    ], resultBranch('missing-source', false)),
  ]
  return graph(body)
}

function soulFragmentGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('choice', 'choice.target-piece', {}, { range: 99, filter: 'ally' }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    branch('wait-or-cancel', out('unresolved', 'value'), [
      call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }),
      returnResult('return-selection', out('selection-result', 'result')),
    ]),
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
    call('captured-target', 'source.capture', { source: out('target', 'piece') }),
    call('heal', 'effect.heal', { source: out('target', 'piece'), target: out('target', 'piece'), amount: value(2) }, { skillId: 'soul-fragment' }),
    call('target-name', 'piece.captured-name', { source: out('captured-target', 'source') }),
    call('heal-text', 'text.from-number', { value: out('heal', 'heal') }),
    call('message', 'text.concat', { left: value('灵魂残片使'), right: out('target-name', 'value') }),
    call('message-2', 'text.concat', { left: out('message', 'text'), right: value('恢复') }),
    call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('heal-text', 'text') }),
    call('message-4', 'text.concat', { left: out('message-3', 'text'), right: value('点生命') }),
    call('result', 'result.action', { success: value(true), message: out('message-4', 'text') }),
    returnResult('return-result', out('result', 'result')),
  ]
  return graph(body)
}

function watcherCalmGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('owner', 'ref.player'),
    call('watcher', 'query.living-template', { owner: out('owner', 'player') }, { templateId: 'blue-watcher' }),
    call('has-watcher', 'card.piece-present', { value: out('watcher', 'piece') }),
    call('missing', 'logic.not', { value: out('has-watcher', 'present') }),
    branch('watcher-guard', out('missing', 'value'), resultBranch('missing-result', false, '找不到观察者棋子')),
    call('watcher-valid', 'query.piece', { pieceId: out('watcher', 'piece') }),
    call('watcher-id', 'piece.identifier', { piece: out('watcher-valid', 'piece') }),
    call('calm-shield-key', 'text.concat', { left: value('calm-shield-'), right: out('watcher-id', 'id') }),
    call('calm-shield-id', 'status.find-id', { piece: out('watcher-valid', 'piece') }, { statusType: 'calm-shield' }),
    call('has-calm-shield', 'card.string-present', { value: out('calm-shield-id', 'id') }),
    call('missing-calm-shield', 'logic.not', { value: out('has-calm-shield', 'present') }),
    branch('calm-shield-guard', out('missing-calm-shield', 'value'), [
      recordCreate('calm-shield-record', 'calm-shield-status', {
        id: out('calm-shield-key', 'text'), type: value('calm-shield'), name: value('平静护盾'), currentDuration: value(-1), currentUses: value(-1), intensity: value(2), stacks: value(1), relatedRules: value(['rule-watcher-shield']),
      }),
      call('add-calm-shield', 'effect.status-record', { target: out('watcher-valid', 'piece'), record: out('calm-shield-record', 'value') }, { inputPolicy: 'host' }),
      call('add-shield-rule', 'rule.apply-piece', { target: out('watcher-valid', 'piece') }, { ruleId: 'rule-watcher-shield' }),
    ], [
      call('shield-intensity', 'status.read-number', { piece: out('watcher-valid', 'piece'), statusId: out('calm-shield-id', 'id'), fallback: value(2) }, { field: 'intensity' }),
      call('new-shield-intensity', 'math.add', { left: out('shield-intensity', 'value'), right: value(2) }),
      call('set-shield-intensity', 'status.set-number', { piece: out('watcher-valid', 'piece'), statusId: out('calm-shield-id', 'id'), value: out('new-shield-intensity', 'value') }, { field: 'intensity' }),
    ]),
    call('rage-id', 'status.find-id', { piece: out('watcher-valid', 'piece') }, { statusType: 'rage-stance' }),
    call('has-rage', 'card.string-present', { value: out('rage-id', 'id') }),
    branch('rage-cleanup', out('has-rage', 'present'), [
      call('remove-rage', 'status.remove-id', { piece: out('watcher-valid', 'piece'), statusId: out('rage-id', 'id') }),
      call('remove-rage-taken', 'rule.remove-piece', { target: out('watcher-valid', 'piece') }, { ruleId: 'rule-watcher-rage-taken' }),
      call('remove-rage-dealt', 'rule.remove-piece', { target: out('watcher-valid', 'piece') }, { ruleId: 'rule-watcher-rage-dealt' }),
    ]),
    call('calm-id', 'status.find-id', { piece: out('watcher-valid', 'piece') }, { statusType: 'calm-stance' }),
    call('has-calm', 'card.string-present', { value: out('calm-id', 'id') }),
    call('missing-calm', 'logic.not', { value: out('has-calm', 'present') }),
    branch('calm-stance-guard', out('missing-calm', 'value'), [
      call('calm-key', 'text.concat', { left: value('calm-stance-'), right: out('watcher-id', 'id') }),
      recordCreate('calm-record', 'stance-status', {
        id: out('calm-key', 'text'), type: value('calm-stance'), name: value('平静姿态'), currentDuration: value(-1), currentUses: value(-1), intensity: value(1), stacks: value(1),
      }),
      call('add-calm', 'effect.status-record', { target: out('watcher-valid', 'piece'), record: out('calm-record', 'value') }, { inputPolicy: 'host' }),
    ]),
    call('final-shield-id', 'status.find-id', { piece: out('watcher-valid', 'piece') }, { statusType: 'calm-shield' }),
    call('final-shield', 'status.read-number', { piece: out('watcher-valid', 'piece'), statusId: out('final-shield-id', 'id'), fallback: value(2) }, { field: 'intensity' }),
    call('watcher-name', 'piece.display-name', { piece: out('watcher-valid', 'piece') }),
    call('shield-text', 'text.from-number', { value: out('final-shield', 'value') }),
    call('message', 'text.concat', { left: out('watcher-name', 'value'), right: value('进入平静姿态，护盾可格挡') }),
    call('message-2', 'text.concat', { left: out('message', 'text'), right: out('shield-text', 'text') }),
    call('message-3', 'text.concat', { left: out('message-2', 'text'), right: value('点伤害') }),
    call('result', 'result.action', { success: value(true), message: out('message-3', 'text') }),
    returnResult('return-result', out('result', 'result')),
  ]
  return graph(body)
}

function watcherRageGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('owner', 'ref.player'),
    call('owner-valid', 'query.player', { playerId: out('owner', 'player') }),
    call('watcher', 'query.living-template', { owner: out('owner', 'player') }, { templateId: 'blue-watcher' }),
    call('has-watcher', 'card.piece-present', { value: out('watcher', 'piece') }),
    call('missing-watcher', 'logic.not', { value: out('has-watcher', 'present') }),
    branch('watcher-guard', out('missing-watcher', 'value'), resultBranch('missing-watcher-result', false, '找不到观察者棋子')),
    call('watcher-valid', 'query.piece', { pieceId: out('watcher', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 3, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    branch('wait-or-cancel', out('unresolved', 'value'), [
      call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }),
      returnResult('return-selection', out('selection-result', 'result')),
    ]),
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
    call('target-alive', 'piece.alive', { piece: out('target', 'piece') }),
    call('target-missing', 'logic.not', { value: out('target-alive', 'alive') }),
    branch('target-guard', out('target-missing', 'value'), resultBranch('target-missing-result', false, '目标不存在或已阵亡')),
    call('target-valid', 'query.piece', { pieceId: out('target', 'piece') }),
    call('captured-watcher', 'source.capture', { source: out('watcher-valid', 'piece') }),
    call('captured-target', 'source.capture', { source: out('target-valid', 'piece') }),
    call('distance', 'query.distance', { from: out('watcher-valid', 'piece'), to: out('target-valid', 'piece') }),
    call('too-far', 'compare.greater-than', { left: out('distance', 'distance'), right: value(3) }),
    branch('range-guard', out('too-far', 'value'), resultBranch('range-failed', false, '目标超出暴怒攻击范围（3格内）')),
    call('watcher-id', 'piece.identifier', { piece: out('watcher-valid', 'piece') }),
    call('attack', 'attribute.read', { piece: out('watcher-valid', 'piece') }, { attribute: 'attack' }),
    call('attack-scaled', 'math.multiply', { left: out('attack', 'value'), right: value(1) }),
    call('attack-amount', 'math.floor', { value: out('attack-scaled', 'value') }),
    call('damage', 'effect.damage', { source: out('watcher-valid', 'piece'), target: out('target-valid', 'piece'), amount: out('attack-amount', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'watcher-rage', inputPolicy: 'host' }),
    call('damage-text', 'value.number-or-zero', { value: out('damage', 'damage') }),
    call('damage-text-string', 'text.from-number', { value: out('damage-text', 'value') }),
    call('watcher-name', 'piece.captured-name', { source: out('captured-watcher', 'source') }),
    call('target-name', 'piece.captured-name', { source: out('captured-target', 'source') }),
    call('message-0', 'text.concat', { left: out('watcher-name', 'value'), right: value('暴怒攻击') }),
    call('message-1', 'text.concat', { left: out('message-0', 'text'), right: out('target-name', 'value') }),
    call('message-2', 'text.concat', { left: out('message-1', 'text'), right: value('，造成') }),
    call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('damage-text-string', 'text') }),
    call('message-4', 'text.concat', { left: out('message-3', 'text'), right: value('点伤害') }),
    call('calm-id', 'status.find-id', { piece: out('watcher-valid', 'piece') }, { statusType: 'calm-stance' }),
    call('has-calm', 'card.string-present', { value: out('calm-id', 'id') }),
    branch('calm-exit', out('has-calm', 'present'), [
      call('remove-calm', 'status.remove-id', { piece: out('watcher-valid', 'piece'), statusId: out('calm-id', 'id') }),
      call('has-owner', 'query.has-player', { playerId: out('owner', 'player') }),
      branch('restore-action-point', out('has-owner', 'exists'), [call('restore-ap', 'resource.adjust', { player: out('owner-valid', 'player'), amount: value(1) }, { resource: 'actionPoints' })]),
    ]),
    call('rage-id', 'status.find-id', { piece: out('watcher-valid', 'piece') }, { statusType: 'rage-stance' }),
    call('has-rage', 'card.string-present', { value: out('rage-id', 'id') }),
    call('missing-rage', 'logic.not', { value: out('has-rage', 'present') }),
    branch('rage-entry', out('missing-rage', 'value'), [
      call('rage-key', 'text.concat', { left: value('rage-stance-'), right: out('watcher-id', 'id') }),
      recordCreate('rage-record', 'stance-status', {
        id: out('rage-key', 'text'), type: value('rage-stance'), name: value('暴怒姿态'), currentDuration: value(-1), currentUses: value(-1), intensity: value(1), stacks: value(1),
      }),
      call('add-rage', 'effect.status-record', { target: out('watcher-valid', 'piece'), record: out('rage-record', 'value') }, { inputPolicy: 'host' }),
      call('add-rage-taken', 'rule.apply-piece', { target: out('watcher-valid', 'piece') }, { ruleId: 'rule-watcher-rage-taken' }),
      call('add-rage-dealt', 'rule.apply-piece', { target: out('watcher-valid', 'piece') }, { ruleId: 'rule-watcher-rage-dealt' }),
    ]),
    call('calm-fragment', 'text.optional-fragment', { condition: out('has-calm', 'present'), value: value('') }, { prefix: '（退出平静姿态，恢复1点行动力）' }),
    call('rage-fragment', 'text.optional-fragment', { condition: out('missing-rage', 'value'), value: value('') }, { prefix: '，进入暴怒姿态' }),
    call('killed', 'effect.result-killed', { result: out('damage', 'result') }),
    call('killed-fragment', 'text.optional-fragment', { condition: out('killed', 'killed'), value: out('target-name', 'value') }, { prefix: '，', suffix: '被击败' }),
    call('message-5', 'text.concat', { left: out('message-4', 'text'), right: out('calm-fragment', 'text') }),
    call('message-6', 'text.concat', { left: out('message-5', 'text'), right: out('rage-fragment', 'text') }),
    call('message-7', 'text.concat', { left: out('message-6', 'text'), right: out('killed-fragment', 'text') }),
    call('result', 'result.action', { success: value(true), message: out('message-7', 'text') }),
    returnResult('return-result', out('result', 'result')),
  ]
  return graph(body)
}

export function buildSemanticCardGraph(id: SemanticCardId): GameplayModuleGraph {
  if (id.startsWith('demon-summon-')) {
    const index = Number(id.slice('demon-summon-'.length))
    return index === 5 ? demonSummonFiveGraph() : demonSummonGraph(index)
  }
  switch (id) {
    case 'hashirama-edo-nature-heal': return hashiramaNatureHealGraph()
    case 'hashirama-edo-thousand-hands': return hashiramaThousandHandsGraph()
    case 'holy-charge': return holyChargeGraph()
    case 'holy-heal': return holyHealGraph()
    case 'holy-smite': return holySmiteGraph()
    case 'sample-reactive-card': return sampleReactiveGraph()
    case 'soul-fragment': return soulFragmentGraph()
    case 'watcher-calm': return watcherCalmGraph()
    case 'watcher-rage': return watcherRageGraph()
  }
  throw new Error(`Unknown semantic card ${id}`)
}

const generatedFields = new Set([
  'code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules',
])

/**
 * These are the exact graph snapshots produced by this migration before the
 * captured-source repair.  They are the only persisted gameplay graphs this
 * script is allowed to regenerate.  A graph edited by an author has a
 * different fingerprint and is retained for normal document validation.
 */
const MIGRATION_OWNED_GRAPH_FINGERPRINTS: Readonly<Record<SemanticCardId, string>> = {
  'demon-summon-1': '592f56a4faff566c1b435a81be097aae31749185f04b9e95495c3873a0c6e2e3',
  'demon-summon-2': '5a27c2063fe37cbe8d6e1471892a083d498745c80e32f554b9bd02ee042c234e',
  'demon-summon-3': 'cbe8341313ff975067ae24f66f3c71e32a926e06e87db2cd2004761dc6520a54',
  'demon-summon-4': '1eb8451662340dae510dbf51775411edec842c454bea2ace67f00ec2c1165f68',
  'demon-summon-5': 'ec466950a4063131711d5ed214dde5c7a6a9ed6b1eaf23b4fc4cb4814b990f02',
  'hashirama-edo-nature-heal': '1089202b5444d3e211f4945512f222d4cf4ecd6dc8ad84f4edee54d7fa2c16d4',
  'hashirama-edo-thousand-hands': 'f6359e64b1444c0bd34558235c0e96284763f972410dceee3eebc18877e99dcf',
  'holy-charge': 'ce5cf92ed21d42d3043bf8ee6b9d264997c3db6b64a33de7ea685f37028038c7',
  'holy-heal': '8278188a94e91c0f3afe9114b28c0ef73cad1dced76a997dd3f4134d70c2b451',
  'holy-smite': 'c452dda567c2e7b46f91607617e5ad51afe36ed56f0584a4904fb71725a4ef61',
  'sample-reactive-card': '7d03e61609fde736d5979094a76e9154975a35ad15dece28d67833a6944524ea',
  'soul-fragment': 'f5d11218c0b176a366149b39618dd037b9c0eb1476963b68c807dc9b8b561e57',
  'watcher-calm': 'f5240d598251c4e015fd1f5a862b1f7cb9e26583698ee838d70da5caea38d787',
  'watcher-rage': 'c22225e3bbadffb80d3750d25ab73973db1f5675f8e7e32518fe5225c20c9867',
}

function graphFingerprint(graph: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(graph)).digest('hex')
}

export function migrateSemanticCards(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const documents: { filename: string; id: string; next: Record<string, unknown> }[] = []
  for (const id of SEMANTIC_CARD_IDS) {
    const filename = path.join(root, 'data', 'cards', id + '.json')
    const current = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, unknown>
    const original = baseline['cards/' + id]
    if (!original) throw new Error(`${id}: missing frozen baseline`)
    for (const field of new Set([...Object.keys(current), ...Object.keys(original)])) {
      if (field !== 'cluster' && !generatedFields.has(field) && JSON.stringify(current[field]) !== JSON.stringify(original[field])) {
        throw new Error(`${id}: compatibility field changed before migration: ${field}`)
      }
    }
    let next = current
    if (current.gameplayModules && typeof current.gameplayModules === 'object') {
      const modules = current.gameplayModules as { entries?: { code?: { graph?: unknown } } }
      const existingGraph = modules.entries?.code?.graph
      if (existingGraph !== undefined && graphFingerprint(existingGraph) === MIGRATION_OWNED_GRAPH_FINGERPRINTS[id]) {
        next = applyGameplayModuleGraph(current, buildSemanticCardGraph(id)) as Record<string, unknown>
        assertGameplayModuleDocument(next)
      } else {
        assertGameplayModuleDocument(current)
      }
    } else {
      assertFrozenExecutable(current, original, 'code', 'card', 'cards/' + id)
      next = applyGameplayModuleGraph(current, buildSemanticCardGraph(id)) as Record<string, unknown>
      assertGameplayModuleDocument(next)
    }
    documents.push({ filename, id: 'cards/' + id, next })
  }
  if (write) for (const document of documents) fs.writeFileSync(document.filename, JSON.stringify(document.next, null, 2) + '\n')
  return documents.map(document => document.id)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  console.log(JSON.stringify(migrateSemanticCards(root, process.argv.includes('--write'))))
}
