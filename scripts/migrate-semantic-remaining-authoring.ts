import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_DOCUMENT_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  GAMEPLAY_MODULE_REGISTRY,
  compileGameplayModuleGraph,
  renderGameplayModuleText,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'
import { AUTHORING_COMPLETION_GAMEPLAY_MODULES } from '../lib/skill-graph/module-registry-authoring-completion'
import { assertFrozenExecutable } from './semantic-migration-source'
import { buildConstantResultGraph } from './migrate-semantic-constants'
import { buildSemanticPreviewGraph } from './migrate-semantic-previews'

/** The ordinary entries closed by this authoring-completion batch. */
export const REMAINING_AUTHORING_IDS = Object.freeze([
  'arthas-howling-blast',
  'blackwidow-toxin-damage',
  'elune-guidance-trigger',
  'elune-protection-trigger',
  'grimmjow-gran-rey-cero',
  'hand-cannon',
  'holy-shield-defense',
  'obito-kamui',
  'reap-heal',
  'venom-corrosion',
  'rule-lucky-coin-gamestart',
] as const)

// Frozen content is heterogeneous JSON; each executable owner is validated below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>
type SourceField = 'code' | 'previewCode' | 'skillCode'
type Surface = 'skill' | 'triggerSkill' | 'rule' | 'preview'

const VERSION = '1' as const
/**
 * RED-252's frozen source revision.  This is deliberately fixed rather than
 * taking a caller supplied ref: a missing fixture must never turn the current
 * production file into its own migration source.
 */
export const REMAINING_AUTHORING_BASE_SHA = '082166c6b803b2e838bce5f0f6824c5bbc714dd6'
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: VERSION, inputs, parameters })
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], elseBody?: GameplayStatement[]): GameplayStatement => ({
  kind: 'if', id, condition, then, ...(elseBody ? { else: elseBody } : {}),
})
const values = (id: string, success: GameplayValue, message?: GameplayValue, blocked?: GameplayValue): GameplayStatement => ({
  kind: 'return', id,
  values: {
    success,
    ...(message ? { message } : {}),
    ...(blocked ? { blocked } : {}),
  },
})
const activeResult = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] => [
  call(id, 'result.action', { success, message }),
  { kind: 'return', id: `${id}-return`, value: output(id, 'result') },
]
const literalResult = (id: string, success: boolean, message?: string, blocked?: boolean): GameplayStatement => values(
  id,
  literal(success),
  message === undefined ? undefined : literal(message),
  blocked === undefined ? undefined : literal(blocked),
)

function chain(body: GameplayStatement[], prefix: string, parts: GameplayValue): GameplayValue
function chain(body: GameplayStatement[], prefix: string, parts: readonly GameplayValue[]): GameplayValue
function chain(body: GameplayStatement[], prefix: string, parts: GameplayValue | readonly GameplayValue[]): GameplayValue {
  const valuesToJoin = Array.isArray(parts) ? parts : [parts]
  let current: GameplayValue = literal('')
  valuesToJoin.forEach((part, index) => {
    const id = `${prefix}-${index}`
    body.push(call(id, 'text.concat', { left: current, right: part }))
    current = output(id, 'text')
  })
  return current
}

const triggerOutputs = [
  { name: 'success', type: 'boolean' as const },
  { name: 'message', type: 'string' as const, optional: true },
  { name: 'blocked', type: 'boolean' as const, optional: true },
]

const arthasStatusSchema: GameplayRecordSchema = {
  id: 'remaining-arthas-slow@1',
  version: VERSION,
  fields: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' },
    { name: 'stacks', type: 'number' },
    { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
  ],
}

const moonGlowSchema: GameplayRecordSchema = {
  id: 'remaining-moon-glow@1',
  version: VERSION,
  fields: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' },
    { name: 'stacks', type: 'number' },
    { name: 'maxStacks', type: 'number' },
  ],
}

const kamuiSchema: GameplayRecordSchema = {
  id: 'remaining-kamui-shield@1',
  version: VERSION,
  fields: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' },
    { name: 'stacks', type: 'number' },
  ],
}

const eluneProtectionSchema: GameplayRecordSchema = {
  id: 'remaining-elune-protection@1',
  version: VERSION,
  fields: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
  ],
}

function skillGraph(body: GameplayStatement[], schemas: readonly GameplayRecordSchema[] = []): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    ...(schemas.length ? { schemas } : {}),
    body,
  }
}

function triggerGraph(body: GameplayStatement[], schemas: readonly GameplayRecordSchema[] = []): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    outputs: triggerOutputs,
    ...(schemas.length ? { schemas } : {}),
    body,
  }
}

function buildArthasGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('attack', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'attack' }),
    call('multiplier', 'skill.power-multiplier'),
    call('raw-damage', 'math.multiply', { left: output('attack', 'value'), right: output('multiplier', 'value') }),
    call('damage-value', 'math.floor', { value: output('raw-damage', 'value') }),
    call('enemies', 'query.pieces-in-square', { origin: output('source', 'piece') }, { relation: 'enemy', halfExtent: 1 }),
    call('enemy-count', 'collection.piece-count', { pieces: output('enemies', 'pieces') }),
    call('no-enemies', 'compare.equal', { left: output('enemy-count', 'value'), right: literal(0) }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
  ]
  const emptyMessage = chain(body, 'empty-message', [output('source-name', 'text'), literal('释放凛冬咆哮，但周围没有敌人')])
  body.push(
    branch('empty-area', output('no-enemies', 'value'), activeResult('empty-result', literal(true), emptyMessage)),
    call('messages', 'local.string-list-create', { items: literal([]) }),
    {
      kind: 'foreach', id: 'enemy-loop', items: output('enemies', 'pieces'), item: 'enemy', body: [
        call('damage', 'effect.damage', {
          source: output('source', 'piece'), target: input('enemy'), amount: output('damage-value', 'value'),
        }, { damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'arthas-howling-blast', inputPolicy: 'host' }),
        call('alive', 'piece.alive', { piece: input('enemy') }),
        branch('alive-branch', output('alive', 'alive'), [
          call('slowed', 'status.has-piece', { piece: input('enemy') }, { statusType: 'arthas-slow' }),
          branch('slow-branch', output('slowed', 'value'), [
            call('slow-enemy-name', 'attribute.text', { piece: input('enemy') }, { attribute: 'name' }),
            call('slow-damage-text', 'text.from-number', { value: output('damage', 'damage') }),
            call('slow-message', 'text.concat', { left: output('slow-enemy-name', 'text'), right: literal('受到') }),
            call('slow-message-2', 'text.concat', { left: output('slow-message', 'text'), right: output('slow-damage-text', 'text') }),
            call('slow-message-3', 'text.concat', { left: output('slow-message-2', 'text'), right: literal('点法术伤害') }),
            call('slow-append', 'local.string-list-append', { list: output('messages', 'list'), value: output('slow-message-3', 'text') }),
          ], [
            call('move-range', 'attribute.read', { piece: input('enemy') }, { attribute: 'moveRange' }),
            call('move-reduced', 'math.subtract', { left: output('move-range', 'value'), right: literal(1) }),
            call('move-next', 'math.max', { left: literal(1), right: output('move-reduced', 'value') }),
            call('set-move-range', 'attribute.set', { piece: input('enemy'), value: output('move-next', 'value') }, { attribute: 'moveRange' }),
            call('enemy-id', 'piece.identifier', { piece: input('enemy') }),
            call('status-id', 'text.concat', { left: literal('arthas-slow-'), right: output('enemy-id', 'id') }),
            {
              kind: 'record.create', id: 'slow-record', schema: `${arthasStatusSchema.id}`, fields: {
                id: output('status-id', 'text'), name: literal('减速'), type: literal('arthas-slow'),
                currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1),
                relatedRules: literal(['rule-arthas-slow-restore']),
              },
            },
            call('apply-slow', 'status.apply-record', { target: input('enemy'), record: output('slow-record', 'value') }, { inputPolicy: 'host' }),
            call('apply-rule', 'rule.apply-piece', { target: input('enemy') }, { ruleId: 'rule-arthas-slow-restore' }),
            call('fresh-enemy-name', 'attribute.text', { piece: input('enemy') }, { attribute: 'name' }),
            call('fresh-damage-text', 'text.from-number', { value: output('damage', 'damage') }),
            call('fresh-message', 'text.concat', { left: output('fresh-enemy-name', 'text'), right: literal('受到') }),
            call('fresh-message-2', 'text.concat', { left: output('fresh-message', 'text'), right: output('fresh-damage-text', 'text') }),
            call('fresh-message-3', 'text.concat', { left: output('fresh-message-2', 'text'), right: literal('点法术伤害并被减速') }),
            call('fresh-append', 'local.string-list-append', { list: output('messages', 'list'), value: output('fresh-message-3', 'text') }),
          ]),
        ], [
          call('dead-enemy-name', 'piece.name-by-id', { piece: input('enemy'), fallback: literal('') }),
          call('dead-damage-text', 'text.from-number', { value: output('damage', 'damage') }),
          call('dead-message', 'text.concat', { left: output('dead-enemy-name', 'text'), right: literal('受到') }),
          call('dead-message-2', 'text.concat', { left: output('dead-message', 'text'), right: output('dead-damage-text', 'text') }),
          call('dead-message-3', 'text.concat', { left: output('dead-message-2', 'text'), right: literal('点法术伤害被击杀') }),
          call('dead-append', 'local.string-list-append', { list: output('messages', 'list'), value: output('dead-message-3', 'text') }),
        ],
        ),
      ],
    },
    call('message-items', 'local.string-list-read', { list: output('messages', 'list') }),
    call('joined', 'text.join-list', { items: output('message-items', 'items') }, { separator: '，' }),
    call('prefix', 'text.concat', { left: output('source-name', 'text'), right: literal('凛冬咆哮！') }),
  )
  const successMessage = chain(body, 'success-message', [output('prefix', 'text'), output('joined', 'text')])
  body.push(...activeResult('success', literal(true), successMessage))
  return skillGraph(body, [arthasStatusSchema])
}

function buildGrimmjowGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 6, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
    branch('return-selection', output('unresolved', 'value'), [
      call('selection-result', 'choice.as-result', { choice: output('choice', 'choice') }),
      { kind: 'return', id: 'return-selection-result', value: output('selection-result', 'result') },
    ]),
    call('target', 'choice.piece', { choice: output('choice', 'choice') }),
    call('line', 'query.enemies-on-cardinal-segment', { source: output('source', 'piece'), target: output('target', 'piece') }),
    branch('invalid-direction', output('line', 'valid'), [], [
      ...activeResult('invalid-direction-result', literal(false), literal('目标必须与自身处于同一行或同一列')),
    ]),
    call('attack', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'attack' }),
    call('damage-value', 'math.multiply', { left: output('attack', 'value'), right: literal(2) }),
    call('damage', 'effect.damage-many-ordered', {
      source: output('source', 'piece'), targets: output('line', 'pieces'), amount: output('damage-value', 'value'),
    }, { damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'grimmjow-gran-rey-cero' }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('damage-text', 'text.from-number', { value: output('damage', 'totalDamage') }),
  ]
  const successMessage = chain(body, 'success-message', [
    output('source-name', 'text'), literal('释放王虚的闪光，造成'), output('damage-text', 'text'), literal('点魔法伤害'),
  ])
  body.push(...activeResult('success', literal(true), successMessage))
  return skillGraph(body)
}

function buildObitoGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('already', 'status.has-piece', { piece: output('source', 'piece') }, { statusType: 'kamui-shield' }),
  ]
  const alreadyMessage = chain(body, 'already-message', [output('source-name', 'text'), literal('已处于神威护盾中')])
  body.push(branch('already-shielded', output('already', 'value'), activeResult('already-result', literal(false), alreadyMessage)))
  body.push({
      kind: 'record.create', id: 'shield-record', schema: kamuiSchema.id, fields: {
        id: literal('kamui-shield'), name: literal('神威护盾'), type: literal('kamui-shield'),
        currentDuration: literal(-1), currentUses: literal(1), intensity: literal(1), stacks: literal(1),
      },
    })
  body.push(
    call('apply-shield', 'status.apply-record', { target: output('source', 'piece'), record: output('shield-record', 'value') }, { inputPolicy: 'host' }),
    call('apply-rule', 'rule.apply-piece', { target: output('source', 'piece') }, { ruleId: 'rule-obito-kamui-block' }),
  )
  const successMessage = chain(body, 'success-message', [
    output('source-name', 'text'), literal('激活神威，转移至异次元空间！下一次受到的伤害将被完全吸收并反弹'),
  ])
  body.push(...activeResult('success', literal(true), successMessage))
  return skillGraph(body, [kamuiSchema])
}

function buildGuidanceGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('card-id', 'event.card-id'),
    call('holy-card', 'followup.card-has-prefix', { cardId: output('card-id', 'value') }, { prefix: 'holy-' }),
    branch('card-check', output('holy-card', 'value'), [], [literalResult('not-card', false, '不是圣光手牌')]),
    call('player-ref', 'ref.context-player'),
    call('player-exists', 'query.has-player', { playerId: output('player-ref', 'player') }),
    branch('player-check', output('player-exists', 'exists'), [], [literalResult('missing-player', false, '找不到玩家')]),
    call('player', 'query.player', { playerId: output('player-ref', 'player') }),
    call('tyrande-ref', 'query.living-template', { owner: output('player', 'player') }, { templateId: 'tyrande' }),
    call('tyrande-exists', 'query.has-piece', { pieceId: output('tyrande-ref', 'piece') }),
    branch('tyrande-check', output('tyrande-exists', 'exists'), [], [literalResult('missing-tyrande', false, '泰兰德不在场')]),
    call('tyrande', 'query.piece', { pieceId: output('tyrande-ref', 'piece') }),
    call('moon-id', 'status.find-id-by-id', { piece: output('tyrande', 'piece') }, { statusId: 'moon-glow' }),
    call('moon-stacks', 'status.read-number', { piece: output('tyrande', 'piece'), statusId: output('moon-id', 'id'), fallback: literal(0) }, { field: 'stacks' }),
    call('next-stacks', 'math.add', { left: output('moon-stacks', 'value'), right: literal(1) }),
    call('full', 'compare.greater-or-equal', { left: output('next-stacks', 'value'), right: literal(2) }),
  ]
  const healedThenBody: GameplayStatement[] = [
    call('target-id', 'query.lowest-hp', { pieces: output('allies', 'pieces') }),
    call('target', 'query.piece', { pieceId: output('target-id', 'piece') }),
    call('heal', 'effect.heal', { source: output('tyrande', 'piece'), target: output('target', 'piece'), amount: literal(5) }, { skillId: 'elune-guidance' }),
    call('moon-present', 'value.present-string', { value: output('moon-id', 'id') }),
    branch('clear-moon', output('moon-present', 'present'), [call('remove-moon', 'status.remove-id', { piece: output('tyrande', 'piece'), statusId: output('moon-id', 'id') })]),
    call('target-name', 'attribute.text', { piece: output('target', 'piece') }, { attribute: 'name' }),
  ]
  const healedMessage = chain(healedThenBody, 'healed-message', [literal('艾露恩的指引：月华已满，治疗'), output('target-name', 'text'), literal('5点生命')])
  healedThenBody.push(values('healed', literal(true), healedMessage))

  const healedBody: GameplayStatement[] = [
    call('allies', 'query.pieces', { ownerId: output('player', 'player') }, { relation: 'ally', includeDead: false }),
    call('ally-count', 'list.count-pieces', { items: output('allies', 'pieces') }),
    call('has-allies', 'compare.greater-than', { left: output('ally-count', 'value'), right: literal(0) }),
    branch('ally-branch', output('has-allies', 'value'), healedThenBody, [literalResult('no-allies', false)]),
  ]

  const stackedBody: GameplayStatement[] = [
    {
      kind: 'record.create', id: 'moon-record', schema: moonGlowSchema.id, fields: {
        id: literal('moon-glow'), name: literal('月华'), type: literal('buff'), currentDuration: literal(-1), currentUses: literal(-1),
        intensity: literal(1), stacks: output('next-stacks', 'value'), maxStacks: literal(2),
      },
    },
    call('apply-moon', 'status.apply-record', { target: output('tyrande', 'piece'), record: output('moon-record', 'value') }, { inputPolicy: 'host' }),
    call('stack-text', 'text.from-number', { value: output('next-stacks', 'value') }),
  ]
  const stackMessage = chain(stackedBody, 'stack-message', [literal('艾露恩的指引：获得'), output('stack-text', 'text'), literal('层月华')])
  stackedBody.push(values('stacked', literal(true), stackMessage))
  body.push(branch('stack-branch', output('full', 'value'), healedBody, stackedBody))
  return triggerGraph(body, [moonGlowSchema])
}

function buildProtectionGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('target-ref', 'ref.event-piece'),
    call('target-present', 'piece.reference-present', { piece: output('target-ref', 'piece') }),
    branch('target-check', output('target-present', 'value'), [], [literalResult('missing-target', false, '没有目标')]),
    call('target', 'query.piece', { pieceId: output('target-ref', 'piece') }),
    call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }),
    call('positive-damage', 'compare.greater-than', { left: output('damage', 'value'), right: literal(0) }),
    branch('damage-check', output('positive-damage', 'value'), [], [literalResult('missing-damage', false, '没有伤害')]),
    call('current-hp', 'attribute.read', { piece: output('target', 'piece') }, { attribute: 'currentHp' }),
    call('nonlethal', 'compare.greater-than', { left: output('current-hp', 'value'), right: output('damage', 'value') }),
    branch('lethal-check', output('nonlethal', 'value'), [literalResult('not-lethal', false, '不是致命伤害')]),
    call('tyrande-ref', 'query.living-template-faction', { target: output('target', 'piece') }, { templateId: 'tyrande' }),
    call('tyrande-exists', 'query.has-piece', { pieceId: output('tyrande-ref', 'piece') }),
    branch('tyrande-check', output('tyrande-exists', 'exists'), [], [literalResult('missing-tyrande', false, '泰兰德不在场')]),
    call('tyrande', 'query.piece', { pieceId: output('tyrande-ref', 'piece') }),
    call('protected', 'status.has-id', { piece: output('target', 'piece'), statusId: literal('elune-protection-used') }),
    branch('protected-check', output('protected', 'value'), [literalResult('already-protected', false, '已经触发过守护')]),
    {
      kind: 'record.create', id: 'protection-record', schema: eluneProtectionSchema.id, fields: {
        id: literal('elune-protection-used'), name: literal('艾露恩已守护'), type: literal('buff'),
        currentDuration: literal(-1), currentUses: literal(-1),
      },
    },
    call('apply-protection', 'status.apply-record', { target: output('target', 'piece'), record: output('protection-record', 'value') }, { inputPolicy: 'host' }),
    call('heal', 'effect.heal', { source: output('tyrande', 'piece'), target: output('target', 'piece'), amount: literal(5) }, { skillId: 'elune-protection' }),
    call('target-name', 'attribute.text', { piece: output('target', 'piece') }, { attribute: 'name' }),
  ]
  const successMessage = chain(body, 'success-message', [literal('艾露恩的守护使'), output('target-name', 'text'), literal('免疫致命伤害并治疗5点生命')])
  body.push(values('success', literal(true), successMessage, literal(true)))
  return triggerGraph(body, [eluneProtectionSchema])
}

function buildHolyShieldGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('target-ref', 'ref.event-piece'),
    call('target-present', 'piece.reference-present', { piece: output('target-ref', 'piece') }),
    branch('target-check', output('target-present', 'value'), [], [literalResult('missing-target', false)]),
    call('target', 'query.piece', { pieceId: output('target-ref', 'piece') }),
    call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }),
    call('remove-shield', 'status.remove-id', { piece: output('target', 'piece'), statusId: literal('holy-shield') }),
    call('target-name', 'attribute.text', { piece: output('target', 'piece') }, { attribute: 'name' }),
    call('damage-text', 'text.from-number', { value: output('damage', 'value') }),
  ]
  const message = chain(body, 'message', [output('target-name', 'text'), literal('的圣盾抵挡了'), output('damage-text', 'text'), literal('点伤害')])
  body.push(values('success', literal(true), message))
  return triggerGraph(body)
}

function buildReapGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.event-piece'),
    call('source-present', 'piece.reference-present', { piece: output('source-ref', 'piece') }),
    branch('source-check', output('source-present', 'value'), [], [literalResult('missing-source', true, '')]),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }),
    call('half', 'math.multiply', { left: output('damage', 'value'), right: literal(0.5) }),
    call('heal-amount', 'math.floor', { value: output('half', 'value') }),
    call('positive', 'compare.greater-than', { left: output('heal-amount', 'value'), right: literal(0) }),
    call('current-hp', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'currentHp' }),
    call('max-hp', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'maxHp' }),
    call('not-full', 'compare.less-than', { left: output('current-hp', 'value'), right: output('max-hp', 'value') }),
    call('should-heal', 'logic.and', { left: output('positive', 'value'), right: output('not-full', 'value') }),
  ]
  const healedBody: GameplayStatement[] = [
      call('heal', 'effect.heal', { source: output('source', 'piece'), target: output('source', 'piece'), amount: output('heal-amount', 'value') }, { skillId: 'reap-heal' }),
      call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
      call('heal-text', 'text.from-number', { value: output('heal', 'heal') }),
  ]
  const healedMessage = chain(healedBody, 'healed-message', [output('source-name', 'text'), literal('通过收割治疗了'), output('heal-text', 'text'), literal('点生命')])
  healedBody.push(values('healed', literal(true), healedMessage))
  body.push(branch('heal-check', output('should-heal', 'value'), healedBody, [literalResult('no-heal', true, '')]))
  return triggerGraph(body)
}

function buildLuckyCoinGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('player-ref', 'ref.context-player'),
    call('player-exists', 'query.has-player', { playerId: output('player-ref', 'player') }),
    branch('add-card', output('player-exists', 'exists'), [
      call('player', 'query.player', { playerId: output('player-ref', 'player') }),
      call('add', 'card.hand-add', { player: output('player', 'player') }, { cardId: 'lucky-coin' }),
    ]),
    values('success', literal(true), literal('后手获得幸运币')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: triggerOutputs.slice(0, 2),
    body,
  }
}

/**
 * The legacy Arthas preview concatenates a calculated number into its text.
 * The strict preview parser intentionally accepts numeric expressions only, so
 * this small graph keeps the same registered preview atoms while expressing
 * the text conversion explicitly.
 */
function buildArthasPreviewGraph(): GameplayModuleGraph {
  const expectedSchemaId = 'preview-expected-values'
  const resultSchemaId = 'preview-result'
  const body: GameplayStatement[] = [
    call('piece-attack', 'preview.piece-number-nan', { piece: input('piece') }, { attribute: 'attack' }),
    call('skill-multiplier', 'preview.skill-number-nan', { skill: input('skillDef') }, { attribute: 'powerMultiplier' }),
    call('raw-damage', 'math.multiply', { left: output('piece-attack', 'value'), right: output('skill-multiplier', 'value') }),
    call('damage', 'math.floor', { value: output('raw-damage', 'value') }),
    call('damage-text', 'text.from-number', { value: output('damage', 'value') }),
  ]
  const description = chain(body, 'description', [
    literal('对本棋子周围3×3范围内所有敌方棋子造成'),
    output('damage-text', 'text'),
    literal('点法术伤害，并使其移动力-1，持续1回合。'),
  ])
  const expectedNode = 'expected-values'
  body.push({
    kind: 'record.create', id: expectedNode, schema: `${expectedSchemaId}@${VERSION}`,
    fields: { damage: output('damage', 'value'), area: literal('3x3') },
  })
  const resultNode = 'preview-result'
  body.push({
    kind: 'record.create', id: resultNode, schema: `${resultSchemaId}@${VERSION}`,
    fields: { description, expectedValues: output(expectedNode, 'value') },
  })
  body.push({ kind: 'return', id: 'return', value: output(resultNode, 'value') })
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'preview',
    inputs: [
      { name: 'piece', type: 'piece' },
      { name: 'skillDef', type: 'content' },
    ],
    outputs: [{ name: 'result', type: { kind: 'record', schema: `${resultSchemaId}@${VERSION}` } }],
    schemas: [
      {
        id: expectedSchemaId,
        version: VERSION,
        fields: [
          { name: 'damage', type: 'number' },
          { name: 'area', type: 'string' },
        ],
      },
      {
        id: resultSchemaId,
        version: VERSION,
        fields: [
          { name: 'description', type: 'string' },
          { name: 'expectedValues', type: { kind: 'record', schema: `${expectedSchemaId}@${VERSION}` } },
        ],
      },
    ],
    body,
  }
}

const GRAPH_BUILDERS: Readonly<Record<string, () => GameplayModuleGraph>> = Object.freeze({
  'arthas-howling-blast': buildArthasGraph,
  'grimmjow-gran-rey-cero': buildGrimmjowGraph,
  'elune-guidance-trigger': buildGuidanceGraph,
  'elune-protection-trigger': buildProtectionGraph,
  'obito-kamui': buildObitoGraph,
  'holy-shield-defense': buildHolyShieldGraph,
  'reap-heal': buildReapGraph,
})

export function buildRemainingAuthoringGraph(id: string): GameplayModuleGraph {
  const builder = GRAPH_BUILDERS[id]
  if (!builder) throw new Error(`No semantic graph builder for ${id}`)
  return builder()
}

type RegistryCatalog = GameplayModuleRegistry & { readonly descriptors: readonly GameplayModuleDescriptor[] }
const AUTHORING_REGISTRY: RegistryCatalog = (() => {
  const byVersion = new Map<string, GameplayModuleDescriptor>()
  for (const descriptor of [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...AUTHORING_COMPLETION_GAMEPLAY_MODULES]) byVersion.set(`${descriptor.id}@${descriptor.version}`, descriptor)
  const descriptors = Object.freeze([...byVersion.values()])
  const resolve = (id: string, version = '1') => byVersion.get(`${id}@${version}`)
  return Object.freeze({
    descriptors,
    get: resolve,
    resolve,
  })
})()

/** Exported for focused graph tests; production registry wiring belongs to the parent task. */
export const REMAINING_AUTHORING_REGISTRY = AUTHORING_REGISTRY

const DEFAULT_FIELDS: Readonly<Record<string, string>> = { skill: 'code', triggerSkill: 'code', rule: 'skillCode', preview: 'previewCode' }
const COMPATIBILITY_FIELDS = new Set(['code', 'skillCode', 'previewCode', 'gameplayModules', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'cluster'])

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(',')}}`
}

function readJson(file: string): JsonRecord {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`${file}: expected a JSON object`)
  return value
}

/** Read an authoring source that is absent from the ordinary-match fixture. */
function readFrozenGitEntry(key: string): JsonRecord {
  const relative = `data/${key}.json`
  try {
    const value = JSON.parse(execFileSync(
      'git',
      ['show', `${REMAINING_AUTHORING_BASE_SHA}:${relative}`],
      { cwd: REPOSITORY_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )) as unknown
    if (!isRecord(value)) throw new Error('expected a JSON object')
    return value
  } catch (error) {
    throw new Error(`${key}: cannot load frozen source from ${REMAINING_AUTHORING_BASE_SHA}`, { cause: error })
  }
}

function hasEntry(content: JsonRecord, field: SourceField): boolean {
  return isRecord(content.gameplayModules)
    && isRecord(content.gameplayModules.entries)
    && isRecord(content.gameplayModules.entries[field])
}

function assertCompatibility(current: JsonRecord, baseline: JsonRecord, id: string, field: SourceField): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (key === field || COMPATIBILITY_FIELDS.has(key)) continue
    if (canonicalJson(current[key]) !== canonicalJson(baseline[key])) throw new Error(`${id}: changed compatibility field ${key}`)
  }
}

function assertPreserved(current: JsonRecord, next: JsonRecord, id: string, field: SourceField): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (key === field || COMPATIBILITY_FIELDS.has(key)) continue
    if (canonicalJson(current[key]) !== canonicalJson(next[key])) throw new Error(`${id}: migration changed compatibility field ${key}`)
  }
}

function assertCompiledWithAuthoringRegistry(content: JsonRecord, onlyField?: SourceField): void {
  if (!isRecord(content.gameplayModules) || !isRecord(content.gameplayModules.entries)) return
  for (const [field, entry] of Object.entries(content.gameplayModules.entries)) {
    if (onlyField && field !== onlyField) continue
    if (!isRecord(entry) || typeof entry.compilerVersion !== 'string') throw new Error(`invalid gameplay module entry ${field}`)
    const compiled = compileGameplayModuleGraph(entry.graph, AUTHORING_REGISTRY)
    if (content[field] !== compiled.code) throw new Error(`generated ${field} does not match its graph`)
  }
}

/** Local equivalent of applyGameplayModuleGraph using the completion registry. */
function applyAuthoringGraph(content: JsonRecord, graph: GameplayModuleGraph, field?: SourceField): JsonRecord {
  const compiled = compileGameplayModuleGraph(graph, AUTHORING_REGISTRY)
  const target = (field ?? DEFAULT_FIELDS[compiled.surface]) as SourceField | undefined
  if (!target) throw new Error(`No generated field for ${compiled.surface}`)
  const prior = isRecord(content.gameplayModules) && isRecord(content.gameplayModules.entries) ? content.gameplayModules : undefined
  const next: JsonRecord = { ...content }
  const additional = isRecord(content.contentGraphEntries) ? { ...content.contentGraphEntries } : {}
  if (content.contentGraphField === target && isRecord(content.contentGraph)) {
    delete next.contentGraph
    delete next.contentGraphField
    delete next.contentGraphCompilerVersion
    const first = Object.keys(additional).sort()[0]
    if (first && isRecord(additional[first])) {
      next.contentGraph = additional[first].graph
      next.contentGraphField = first
      next.contentGraphCompilerVersion = additional[first].compilerVersion
      delete additional[first]
    }
  } else {
    delete additional[target]
  }
  if (Object.keys(additional).length) next.contentGraphEntries = additional
  else delete next.contentGraphEntries
  next[target] = compiled.code
  next.gameplayModules = {
    ...(prior?.textBindings === undefined ? {} : { textBindings: prior.textBindings }),
    version: GAMEPLAY_MODULE_DOCUMENT_VERSION,
    entries: {
      ...(prior?.entries ?? {}),
      [target]: { graph: JSON.parse(JSON.stringify(graph)), compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION },
    },
  }
  if (isRecord(next.gameplayModules) && isRecord(next.gameplayModules.entries) && next.gameplayModules.textBindings !== undefined) {
    Object.assign(next, renderGameplayModuleText(
      next.gameplayModules.entries as Parameters<typeof renderGameplayModuleText>[0],
      next.gameplayModules.textBindings as Parameters<typeof renderGameplayModuleText>[1],
    ))
  }
  // Existing entries can still carry a prior compiler artifact.  Validate the
  // newly written field here; the parent all-graphs pass owns any repository
  // wide compiler-version refresh.
  assertCompiledWithAuthoringRegistry(next, target)
  return next
}

type Migration = {
  readonly id: string
  readonly key: string
  readonly file: string
  readonly field: SourceField
  readonly surface: Surface
  readonly build: (source: string) => GameplayModuleGraph
}

const migrationsFor = (root: string): readonly Migration[] => {
  const skillIds = [
    'arthas-howling-blast',
    'blackwidow-toxin-damage',
    'elune-guidance-trigger',
    'elune-protection-trigger',
    'grimmjow-gran-rey-cero',
    'holy-shield-defense',
    'obito-kamui',
    'reap-heal',
    'venom-corrosion',
  ] as const
  const result: Migration[] = []
  for (const id of skillIds) {
    result.push({
      id, key: `skills/${id}`, file: path.join(root, 'data', 'skills', `${id}.json`), field: 'code',
      surface: id === 'arthas-howling-blast' || id === 'grimmjow-gran-rey-cero' || id === 'obito-kamui' ? 'skill' : 'triggerSkill',
      build: () => id === 'blackwidow-toxin-damage'
        ? buildConstantResultGraph({ success: true, message: '' }, 'triggerSkill')
        : id === 'venom-corrosion'
          ? buildConstantResultGraph({ success: false, message: '' }, 'triggerSkill')
          : buildRemainingAuthoringGraph(id),
    })
  }
  for (const id of ['arthas-howling-blast', 'blackwidow-toxin-damage', 'hand-cannon', 'obito-kamui'] as const) {
    result.push({
      id, key: `skills/${id}`, file: path.join(root, 'data', 'skills', `${id}.json`), field: 'previewCode', surface: 'preview',
      build: source => id === 'arthas-howling-blast' ? buildArthasPreviewGraph() : buildSemanticPreviewGraph(source),
    })
  }
  result.push({
    id: 'rule-lucky-coin-gamestart', key: 'rules/rule-lucky-coin-gamestart',
    file: path.join(root, 'data', 'rules', 'rule-lucky-coin-gamestart.json'), field: 'skillCode', surface: 'rule',
    build: () => buildLuckyCoinGraph(),
  })
  return result
}

export type RemainingAuthoringReport = {
  readonly id: string
  readonly field: SourceField
  readonly surface: Surface
  readonly status: 'ready' | 'already-migrated' | 'blocked'
  readonly file: string
  readonly reason?: string
}

export type RemainingAuthoringRun = {
  readonly reports: readonly RemainingAuthoringReport[]
  readonly documents: ReadonlyMap<string, JsonRecord>
}

/** Preflight all owned entries. A blocked item prevents every write in --write mode. */
export function runRemainingAuthoringMigrations(root: string, baseline: JsonRecord, selectedIds?: readonly string[]): RemainingAuthoringRun {
  if (!isRecord(baseline.entries)) throw new Error('RED-252 baseline has no entries object')
  if (baseline.baseSha !== REMAINING_AUTHORING_BASE_SHA) {
    throw new Error(`RED-252 baseline must use frozen source revision ${REMAINING_AUTHORING_BASE_SHA}`)
  }
  const migrations = migrationsFor(root)
  const selected = selectedIds?.length
    ? migrations.filter(item => selectedIds.includes(item.id) || selectedIds.includes(`${item.id}.${item.field}`))
    : migrations
  if (selectedIds?.length) {
    const known = new Set(migrations.flatMap(item => [item.id, `${item.id}.${item.field}`]))
    const unknown = selectedIds.filter(id => !known.has(id))
    if (unknown.length) throw new Error(`Unknown remaining authoring migration: ${unknown.join(', ')}`)
  }
  const documents = new Map<string, JsonRecord>()
  const reports: RemainingAuthoringReport[] = []
  for (const migration of selected) {
    const current = documents.get(migration.file) ?? readJson(migration.file)
    if (hasEntry(current, migration.field)) {
      try {
        assertCompiledWithAuthoringRegistry(current, migration.field)
        reports.push({ id: migration.id, field: migration.field, surface: migration.surface, status: 'already-migrated', file: migration.file })
      } catch (error) {
        reports.push({ id: migration.id, field: migration.field, surface: migration.surface, status: 'blocked', file: migration.file, reason: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    try {
      const fixtureEntry = baseline.entries[migration.key]
      // A few historical definitions are intentionally absent from the
      // ordinary-match fixture.  Always use an immutable source for those;
      // treating the current production file as its own baseline would make
      // a hand edit pass the provenance check and then get overwritten.
      const baselineEntry = isRecord(fixtureEntry) ? fixtureEntry : readFrozenGitEntry(migration.key)
      if (typeof baselineEntry[migration.field] !== 'string') throw new Error(`${migration.key}: frozen entry has no ${migration.field}`)
      if (typeof current[migration.field] !== 'string') throw new Error(`${migration.key}: production entry has no ${migration.field}`)
      assertFrozenExecutable(current, baselineEntry, migration.field, migration.surface, migration.key)
      assertCompatibility(current, baselineEntry, migration.key, migration.field)
      const graph = migration.build(baselineEntry[migration.field] as string)
      const next = applyAuthoringGraph(current, graph, migration.field)
      assertPreserved(current, next, migration.key, migration.field)
      documents.set(migration.file, next)
      reports.push({ id: migration.id, field: migration.field, surface: migration.surface, status: 'ready', file: migration.file })
    } catch (error) {
      reports.push({ id: migration.id, field: migration.field, surface: migration.surface, status: 'blocked', file: migration.file, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { reports, documents }
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const selected = args.filter(argument => argument !== '--write')
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const run = runRemainingAuthoringMigrations(root, baseline, selected)
  const blocked = run.reports.filter(report => report.status === 'blocked')
  if (write && blocked.length) throw new Error(JSON.stringify({ message: 'Remaining authoring migration is blocked; no production files were written.', blocked }, null, 2))
  if (write) for (const [file, document] of run.documents) fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({
    mode: write ? 'written' : 'dry-run',
    compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION,
    baseSha: baseline.baseSha,
    counts: {
      ready: run.reports.filter(report => report.status === 'ready').length,
      alreadyMigrated: run.reports.filter(report => report.status === 'already-migrated').length,
      blocked: blocked.length,
      written: write ? run.documents.size : 0,
    },
    migrations: run.reports,
  }, null, 2))
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()
