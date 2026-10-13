import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { migrateStructuredActionLogModules } from '../lib/skill-graph/atomic-migration-structured-action-log'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const FOLLOWUP_RULE_IDS = [
  'rule-aizen-black-coffin-end',
  'rule-aizen-kyoka-expire',
  'rule-elune-guidance',
  'rule-mangekyo-friendly-death',
  'rule-grimmjow-hunt-after-move',
  'rule-grimmjow-hunt-after-skill',
] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const resultOutputs = [
  { name: 'success', type: 'boolean' as const },
  { name: 'message', type: 'string' as const },
]
const optionalResultOutputs = [
  { name: 'success', type: 'boolean' as const, optional: true },
  { name: 'message', type: 'string' as const, optional: true },
]
const fail = (id: string, message = ''): GameplayStatement => ({ kind: 'return', id, values: { success: literal(false), message: literal(message) } })
const failWithoutMessage = (id: string): GameplayStatement => ({ kind: 'return', id, values: { success: literal(false) } })
const success = (id: string, message?: GameplayValue): GameplayStatement => ({ kind: 'return', id, values: { success: literal(true), ...(message === undefined ? {} : { message }) } })
const guard = (body: GameplayStatement[], id: string, condition: GameplayValue, failure: GameplayStatement = fail(id + '-return')): void => {
  body.push(call(id + '-not', 'logic.not', { value: condition }), { kind: 'if', id, condition: out(id + '-not', 'value'), then: [failure] })
}

const statusSchema = {
  id: 'followup-status',
  version: '1',
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'type', type: 'string' as const },
    { name: 'name', type: 'string' as const, nullable: true, optional: true },
    { name: 'sourceId', type: 'string' as const, nullable: true, optional: true },
    { name: 'delayedDamage', type: 'number' as const, nullable: true, optional: true },
    { name: 'appliedTurn', type: 'number' as const, optional: true },
    { name: 'opponentPlayerId', type: 'player' as const, nullable: true, optional: true },
    { name: 'currentDuration', type: 'number' as const, nullable: true, optional: true },
    { name: 'currentUses', type: 'number' as const, nullable: true, optional: true },
    { name: 'intensity', type: 'number' as const, nullable: true, optional: true },
    { name: 'stacks', type: 'number' as const, nullable: true, optional: true },
    { name: 'maxStacks', type: 'number' as const, nullable: true, optional: true },
  ],
}

const moonGlowSchema = {
  id: 'followup-moon-glow',
  version: '1',
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'name', type: 'string' as const },
    { name: 'type', type: 'string' as const },
    { name: 'currentDuration', type: 'number' as const },
    { name: 'currentUses', type: 'number' as const },
    { name: 'intensity', type: 'number' as const },
    { name: 'stacks', type: 'number' as const },
    { name: 'maxStacks', type: 'number' as const },
  ],
}

const mangekyoPayloadSchema = {
  id: 'followup-mangekyo-action-payload',
  version: '1',
  fields: [
    { name: 'message', type: 'string' as const },
    { name: 'pieceId', type: 'string' as const },
    { name: 'pieceTemplateId', type: 'string' as const },
    { name: 'mangekyoDeathCount', type: 'number' as const },
  ],
}
const mangekyoActionSchema = {
  id: 'followup-mangekyo-action',
  version: '1',
  fields: [
    { name: 'type', type: 'string' as const },
    { name: 'playerId', type: 'player' as const },
    { name: 'turn', type: 'number' as const },
    { name: 'payload', type: { kind: 'record' as const, schema: 'followup-mangekyo-action-payload@1' } },
  ],
}

const grimmPayloadSchema = {
  id: 'followup-grimm-hunt-payload',
  version: '1',
  fields: [
    { name: 'grimm', type: 'piece' as const },
    { name: 'enemy', type: 'piece' as const },
  ],
}

function baseGraph(surface: 'rule' | 'pending', body: readonly GameplayStatement[], options: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface,
    outputs: optionalResultOutputs,
    body,
    ...options,
  }
}

function buildBlackCoffinGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }),
  ]
  guard(body, 'holder-check', out('holder-exists', 'exists'))
  body.push(
    call('target', 'query.piece', { pieceId: out('holder-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('target', 'piece') }),
    call('event-player', 'ref.event-player'),
    call('own-turn', 'compare.player-reference', { left: out('owner', 'player'), right: out('event-player', 'player') }),
  )
  guard(body, 'owner-check', out('own-turn', 'value'))
  body.push(call('has-coffin', 'status.matches-type', { piece: out('target', 'piece') }, { statusType: 'aizen-black-coffin' }))
  body.push({ kind: 'if', id: 'coffin-present', condition: out('has-coffin', 'value'), then: [], else: [
    call('remove-rule', 'rule.remove-piece', { target: out('target', 'piece') }, { ruleId: 'rule-aizen-black-coffin-end' }),
    fail('no-coffin'),
  ] })
  body.push(
    call('turn', 'turn.number'),
    call('tags', 'followup.status-records', { piece: out('target', 'piece'), turn: out('turn', 'value') }, { statusType: 'aizen-black-coffin' }),
    {
      kind: 'collection', id: 'eligible-tags', method: 'filter', items: out('tags', 'records'), item: 'tag',
      body: [
        { kind: 'record.get', id: 'type', record: input('tag'), field: 'type' },
        call('type-ok', 'compare.equal-string', { left: out('type', 'value'), right: literal('aizen-black-coffin') }),
        { kind: 'return', id: 'tag-result', value: out('type-ok', 'value') },
      ],
    },
    // Capture the display name while the target is still in battle. The
    // authoritative damage path moves a lethal target to the graveyard, so
    // querying attribute.text after damage would become invalid and discard
    // an otherwise successful delayed-damage message.
    call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
    call('message-start', 'followup.message-buffer-start'),
    {
      kind: 'foreach', id: 'damage-tags', items: out('eligible-tags', 'value'), item: 'tag',
      body: [
        call('hp', 'attribute.read', { piece: out('target', 'piece') }, { attribute: 'currentHp' }),
        call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }),
        {
          kind: 'if', id: 'target-alive', condition: out('alive', 'value'), then: [
            call('damage', 'followup.damage-status', { status: input('tag'), target: out('target', 'piece') }, { damageType: 'magical', skillId: 'aizen-black-coffin-delayed' }),
            { kind: 'record.get', id: 'tag-id', record: input('tag'), field: 'id' },
            call('remove-tag', 'status.remove-id', { piece: out('target', 'piece'), statusId: out('tag-id', 'value') }),
            call('damage-text', 'effect.result-number', { result: out('damage', 'result') }, { field: 'damage' }),
            call('damage-number', 'text.from-number', { value: out('damage-text', 'value') }),
            call('message-a', 'text.concat', { left: literal('黑棺终结，对'), right: out('target-name', 'text') }),
            call('message-b', 'text.concat', { left: out('message-a', 'text'), right: literal('造成') }),
            call('message-c', 'text.concat', { left: out('message-b', 'text'), right: out('damage-number', 'text') }),
            call('message-d', 'text.concat', { left: out('message-c', 'text'), right: literal('点魔法伤害') }),
            call('message-add', 'followup.message-buffer-add', { message: out('message-d', 'text') }),
          ],
        },
      ],
    },
    call('messages', 'followup.message-buffer-read'),
    call('has-messages', 'compare.greater-than', { left: out('messages', 'count'), right: literal(0) }),
    { kind: 'if', id: 'message-result', condition: out('has-messages', 'value'), then: [success('success', out('messages', 'text'))], else: [fail('no-damage')] },
  )
  return baseGraph('rule', body, { outputs: resultOutputs, schemas: [statusSchema] })
}

function buildKyokaGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('holder-ref', 'ref.holder'), call('holder-exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') })]
  guard(body, 'holder-check', out('holder-exists', 'exists'))
  body.push(
    call('aizen', 'query.piece', { pieceId: out('holder-ref', 'piece') }),
    call('secret-id', 'status.find-id', { piece: out('aizen', 'piece') }, { statusType: 'aizen-kyoka-secret' }),
    call('secret-present', 'value.present-string', { value: out('secret-id', 'id') }),
  )
  guard(body, 'secret-check', out('secret-present', 'present'))
  body.push(
    call('event-player', 'ref.event-player'),
    call('opponent', 'followup.status-player-field', { piece: out('aizen', 'piece'), statusId: out('secret-id', 'id') }, { field: 'opponentPlayerId' }),
    call('same-player', 'compare.player-reference', { left: out('event-player', 'player'), right: out('opponent', 'player') }),
  )
  guard(body, 'opponent-check', out('same-player', 'value'))
  body.push(
    call('remove-tags', 'followup.remove-status-types', { piece: out('aizen', 'piece'), types: literal(['aizen-kyoka-active', 'aizen-kyoka-secret']) }),
    call('name', 'attribute.text', { piece: out('aizen', 'piece') }, { attribute: 'name' }),
    call('message', 'text.concat', { left: out('name', 'text'), right: literal('的镜花水月失效') }),
    success('success', out('message', 'text')),
  )
  return baseGraph('rule', body, { outputs: resultOutputs })
}

function buildEluneGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('card-id', 'event.card-id'),
    call('holy-card', 'followup.card-has-prefix', { cardId: out('card-id', 'value') }, { prefix: 'holy-' }),
    { kind: 'if', id: 'card-check', condition: out('holy-card', 'value'), then: [], else: [failWithoutMessage('not-holy')] },
    call('player-ref', 'ref.event-player'),
    call('player-exists', 'query.has-player', { playerId: out('player-ref', 'player') }),
    { kind: 'if', id: 'player-check', condition: out('player-exists', 'exists'), then: [], else: [failWithoutMessage('missing-player')] },
    call('player', 'query.player', { playerId: out('player-ref', 'player') }),
    call('tyrande-ref', 'query.living-template', { owner: out('player', 'player') }, { templateId: 'tyrande' }),
    call('tyrande-exists', 'query.has-piece', { pieceId: out('tyrande-ref', 'piece') }),
    { kind: 'if', id: 'tyrande-check', condition: out('tyrande-exists', 'exists'), then: [], else: [failWithoutMessage('missing-tyrande')] },
    call('tyrande', 'query.piece', { pieceId: out('tyrande-ref', 'piece') }),
    call('moon-id', 'status.find-id-by-id', { piece: out('tyrande', 'piece') }, { statusId: 'moon-glow' }),
    call('moon-stacks', 'status.read-number', { piece: out('tyrande', 'piece'), statusId: out('moon-id', 'id'), fallback: literal(0) }, { field: 'stacks' }),
    call('next-stacks', 'math.add', { left: out('moon-stacks', 'value'), right: literal(1) }),
    call('full', 'compare.greater-or-equal', { left: out('next-stacks', 'value'), right: literal(2) }),
    {
      kind: 'if', id: 'stack-branch', condition: out('full', 'value'),
      then: [
        call('allies', 'query.pieces', { ownerId: out('player', 'player') }, { relation: 'ally', includeDead: false }),
        call('ally-count', 'list.count-pieces', { items: out('allies', 'pieces') }),
        call('has-allies', 'compare.greater-than', { left: out('ally-count', 'value'), right: literal(0) }),
        { kind: 'if', id: 'ally-branch', condition: out('has-allies', 'value'), then: [
          call('target', 'query.lowest-hp', { pieces: out('allies', 'pieces') }),
          call('target-required', 'query.piece', { pieceId: out('target', 'piece') }),
          call('heal', 'effect.heal', { source: out('tyrande', 'piece'), target: out('target-required', 'piece'), amount: literal(5) }, { skillId: 'elune-guidance' }),
          call('moon-present', 'value.present-string', { value: out('moon-id', 'id') }),
          { kind: 'if', id: 'clear-moon', condition: out('moon-present', 'present'), then: [call('remove-moon', 'status.remove-id', { piece: out('tyrande', 'piece'), statusId: out('moon-id', 'id') })] },
          call('target-name', 'attribute.text', { piece: out('target-required', 'piece') }, { attribute: 'name' }),
          call('message-a', 'text.concat', { left: literal('艾露恩的指引：月华满层，为'), right: out('target-name', 'text') }),
          call('message', 'text.concat', { left: out('message-a', 'text'), right: literal('恢复5点生命') }),
          success('healed', out('message', 'text')),
        ], else: [failWithoutMessage('no-allies')] },
      ],
      else: [
        { kind: 'record.create', id: 'moon-record', schema: 'followup-moon-glow@1', fields: {
          id: literal('moon-glow'), name: literal('月华'), type: literal('buff'), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: out('next-stacks', 'value'), maxStacks: literal(2),
        } },
        call('apply-moon', 'status.apply-record', { target: out('tyrande', 'piece'), record: out('moon-record', 'value') }, { inputPolicy: 'host' }),
        call('stack-text', 'text.from-number', { value: out('next-stacks', 'value') }),
        call('stack-message-a', 'text.concat', { left: literal('艾露恩的指引：获得'), right: out('stack-text', 'text') }),
        call('stack-message', 'text.concat', { left: out('stack-message-a', 'text'), right: literal('层月华') }),
        success('stacked', out('stack-message', 'text')),
      ],
    },
  ]
  return baseGraph('rule', body, { outputs: optionalResultOutputs, schemas: [moonGlowSchema] })
}

function buildMangekyoGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('witness-ref', 'ref.holder'),
    call('dead-ref', 'ref.source'),
    call('witness-exists', 'query.has-piece', { pieceId: out('witness-ref', 'piece') }),
    call('dead-exists', 'query.has-piece', { pieceId: out('dead-ref', 'piece') }),
    call('both-present', 'logic.and', { left: out('witness-exists', 'exists'), right: out('dead-exists', 'exists') }),
  ]
  guard(body, 'references-check', out('both-present', 'value'))
  body.push(
    call('witness', 'query.piece', { pieceId: out('witness-ref', 'piece') }),
    call('dead', 'query.piece', { pieceId: out('dead-ref', 'piece') }),
    call('witness-owner', 'piece.owner', { piece: out('witness', 'piece') }),
    call('dead-owner', 'piece.owner', { piece: out('dead', 'piece') }),
    call('allied', 'compare.allied-players', { left: out('witness-owner', 'player'), right: out('dead-owner', 'player') }),
  )
  guard(body, 'allied-check', out('allied', 'value'))
  body.push(
    call('primary', 'followup.primary-mangekyo-witness', { witness: out('witness', 'piece') }),
  )
  guard(body, 'primary-check', out('primary', 'value'))
  body.push(
    call('next-count', 'followup.counter.increment-player', { player: out('witness-owner', 'player') }, { counter: 'mangekyoDeaths' }),
    call('dead-name', 'followup.piece-name-with-template', { piece: out('dead', 'piece') }),
    call('message-a', 'text.concat', { left: out('dead-name', 'text'), right: literal('的死亡令【万花筒】充能消耗降低1') }),
    call('dead-template', 'followup.piece-template-id', { piece: out('dead', 'piece') }),
    call('dead-id', 'piece.identifier', { piece: out('dead', 'piece') }),
    call('turn', 'followup.turn-number-or-zero'),
    { kind: 'record.create', id: 'payload', schema: 'followup-mangekyo-action-payload@1', fields: {
      message: out('message-a', 'text'), pieceId: out('dead-id', 'id'), pieceTemplateId: out('dead-template', 'text'), mangekyoDeathCount: out('next-count', 'next'),
    } },
    { kind: 'record.create', id: 'action', schema: 'followup-mangekyo-action@1', fields: {
      type: literal('mangekyoDeath'), playerId: out('witness-owner', 'player'), turn: out('turn', 'value'), payload: out('payload', 'value'),
    } },
    call('append-action', 'followup.action.append', { action: out('action', 'value') }),
    success('success', out('message-a', 'text')),
  )
  return baseGraph('rule', body, { outputs: resultOutputs, schemas: [mangekyoPayloadSchema, mangekyoActionSchema] })
}

/**
 * Build the hunt resolution as ordinary graph statements.  This used to be
 * persisted as a graph-local `followup.grimm-hunt-resolve` composite.  The
 * statements are kept in a small factory for the two trigger graphs, then
 * inlined before persistence so the author surface contains only the same
 * generic queries, conditions, movement and damage sentences as every other
 * rule.
 */
function buildGrimmResolveBody(): GameplayStatement[] {
  const body: GameplayStatement[] = [
    call('selected-cell', 'choice.first-cell-reference', { items: input('selected') }),
    call('has-cell', 'value.present-cell', { value: out('selected-cell', 'cell') }),
    { kind: 'if', id: 'selected-check', condition: out('has-cell', 'present'), then: [], else: [fail('invalid-selection', '狩猎本能落点无效')] },
    call('selected-required', 'spatial.cell-require', { cell: out('selected-cell', 'cell') }),
    call('walkable', 'spatial.cell-walkable-safe', { cell: out('selected-required', 'cell') }),
    call('free', 'spatial.cell-unoccupied', { cell: out('selected-required', 'cell') }),
    call('reserved-hit', 'spatial.cell-in-list', { cell: out('selected-required', 'cell'), cells: input('reserved') }),
    call('not-reserved', 'logic.not', { value: out('reserved-hit', 'value') }),
    call('grimm-position', 'spatial.piece-position', { piece: input('grimm') }),
    call('distance', 'spatial.cell-distance', { from: out('grimm-position', 'cell'), to: out('selected-required', 'cell') }),
    call('in-range', 'compare.less-or-equal', { left: out('distance', 'distance'), right: literal(2) }),
    call('valid-a', 'logic.and', { left: out('walkable', 'value'), right: out('free', 'value') }),
    call('valid-b', 'logic.and', { left: out('valid-a', 'value'), right: out('not-reserved', 'value') }),
    call('valid', 'logic.and', { left: out('valid-b', 'value'), right: out('in-range', 'value') }),
    { kind: 'if', id: 'valid-check', condition: out('valid', 'value'), then: [], else: [fail('stale-selection', '狩猎本能落点已失效')] },
    call('move', 'effect.teleport', { piece: input('grimm'), destination: out('selected-required', 'cell') }, { kind: 'teleport' }),
    { kind: 'if', id: 'move-check', condition: out('move', 'success'), then: [], else: [success('blocked', literal('位移被阻挡，本次位移效果取消'))] },
    call('counter', 'local.counter-create', { initial: literal(0) }),
    call('enemy-hp', 'attribute.read', { piece: input('enemy') }, { attribute: 'currentHp' }),
    call('enemy-alive', 'compare.greater-than', { left: out('enemy-hp', 'value'), right: literal(0) }),
    call('grimm-after', 'spatial.piece-position', { piece: input('grimm') }),
    call('enemy-after', 'spatial.piece-position', { piece: input('enemy') }),
    call('adjacent-distance', 'spatial.cell-distance', { from: out('grimm-after', 'cell'), to: out('enemy-after', 'cell') }),
    call('adjacent', 'compare.equal', { left: out('adjacent-distance', 'distance'), right: literal(1) }),
    call('can-hit', 'logic.and', { left: out('enemy-alive', 'value'), right: out('adjacent', 'value') }),
    {
      kind: 'if', id: 'attack-branch', condition: out('can-hit', 'value'), then: [{
        kind: 'foreach', id: 'two-attacks', items: literal([0, 1]), item: 'hit', body: [
          call('grimm-hp', 'attribute.read', { piece: input('grimm') }, { attribute: 'currentHp' }),
          call('active-grimm', 'compare.greater-than', { left: out('grimm-hp', 'value'), right: literal(0) }),
          call('enemy-live', 'attribute.read', { piece: input('enemy') }, { attribute: 'currentHp' }),
          call('active-enemy', 'compare.greater-than', { left: out('enemy-live', 'value'), right: literal(0) }),
          call('both-active', 'logic.and', { left: out('active-grimm', 'value'), right: out('active-enemy', 'value') }),
          { kind: 'if', id: 'hit-check', condition: out('both-active', 'value'), then: [
            call('attack', 'attribute.read', { piece: input('grimm') }, { attribute: 'attack' }),
            call('raw-damage', 'math.multiply', { left: out('attack', 'value'), right: literal(0.75) }),
            call('damage', 'math.floor', { value: out('raw-damage', 'value') }),
            call('deal', 'effect.damage', { source: input('grimm'), target: input('enemy'), amount: out('damage', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'grimmjow-hunting-instinct', inputPolicy: 'host' }),
            call('hit-count', 'local.counter-add', { counter: out('counter', 'counter'), amount: literal(1) }),
          ] },
        ],
      }] },
    call('hits', 'local.counter-read', { counter: out('counter', 'counter') }),
    call('has-hits', 'compare.greater-than', { left: out('hits', 'value'), right: literal(0) }),
    call('grimm-name', 'attribute.text', { piece: input('grimm') }, { attribute: 'name' }),
    call('hit-text', 'text.from-number', { value: out('hits', 'value') }),
    call('message-a', 'text.concat', { left: out('grimm-name', 'text'), right: literal('发动狩猎本能') }),
    {
      kind: 'if', id: 'message-branch', condition: out('has-hits', 'value'), then: [
        call('message-b', 'text.concat', { left: out('message-a', 'text'), right: literal('并攻击') }),
        call('message-c', 'text.concat', { left: out('message-b', 'text'), right: out('hit-text', 'text') }),
        call('message-d', 'text.concat', { left: out('message-c', 'text'), right: literal('次') }),
        success('attacked', out('message-d', 'text')),
      ], else: [success('moved', out('message-a', 'text'))],
    },
  ]
  return body
}

type GrimmInlineBindings = Readonly<Record<string, GameplayValue>>

function rewriteGrimmValue(value: GameplayValue, bindings: GrimmInlineBindings, prefix: string, locals: ReadonlySet<string>): GameplayValue {
  if (value.kind === 'input') {
    if (!locals.has(value.name) && bindings[value.name] !== undefined) return bindings[value.name]
    return value
  }
  if (value.kind === 'output') return { ...value, node: prefix + value.node }
  return value
}

function rewriteGrimmValues(values: Readonly<Record<string, GameplayValue>> | undefined, bindings: GrimmInlineBindings, prefix: string, locals: ReadonlySet<string>): Record<string, GameplayValue> | undefined {
  if (values === undefined) return undefined
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, rewriteGrimmValue(value, bindings, prefix, locals)]))
}

function inlineGrimmStatement(statement: GameplayStatement, bindings: GrimmInlineBindings, prefix: string, locals: ReadonlySet<string> = new Set()): GameplayStatement {
  const id = prefix + statement.id
  switch (statement.kind) {
    case 'call':
      return { ...statement, id, ...(statement.inputs === undefined ? {} : { inputs: rewriteGrimmValues(statement.inputs, bindings, prefix, locals) }) }
    case 'if':
      return {
        ...statement,
        id,
        condition: rewriteGrimmValue(statement.condition, bindings, prefix, locals),
        then: statement.then.map(child => inlineGrimmStatement(child, bindings, prefix, locals)),
        ...(statement.else === undefined ? {} : { else: statement.else.map(child => inlineGrimmStatement(child, bindings, prefix, locals)) }),
      }
    case 'foreach': {
      const nestedLocals = new Set(locals)
      if (statement.item) nestedLocals.add(statement.item)
      if (statement.index) nestedLocals.add(statement.index)
      return {
        ...statement,
        id,
        items: rewriteGrimmValue(statement.items, bindings, prefix, locals),
        body: statement.body.map(child => inlineGrimmStatement(child, bindings, prefix, nestedLocals)),
      }
    }
    case 'while': {
      const nestedLocals = new Set(locals)
      if (statement.index) nestedLocals.add(statement.index)
      return {
        ...statement,
        id,
        condition: {
          ...statement.condition,
          ...(statement.condition.inputs === undefined ? {} : { inputs: rewriteGrimmValues(statement.condition.inputs, bindings, prefix, locals) }),
          body: statement.condition.body.map(child => inlineGrimmStatement(child, bindings, prefix, locals)),
        },
        body: statement.body.map(child => inlineGrimmStatement(child, bindings, prefix, nestedLocals)),
      }
    }
    case 'record.create':
      return { ...statement, id, ...(statement.fields === undefined ? {} : { fields: rewriteGrimmValues(statement.fields, bindings, prefix, locals) }) }
    case 'record.get':
      return { ...statement, id, record: rewriteGrimmValue(statement.record, bindings, prefix, locals) }
    case 'record.with':
      return { ...statement, id, record: rewriteGrimmValue(statement.record, bindings, prefix, locals), ...(statement.fields === undefined ? {} : { fields: rewriteGrimmValues(statement.fields, bindings, prefix, locals) }) }
    case 'collection': {
      const nestedLocals = new Set(locals)
      if (statement.item) nestedLocals.add(statement.item)
      if (statement.index) nestedLocals.add(statement.index)
      if (statement.accumulator) nestedLocals.add(statement.accumulator)
      return {
        ...statement,
        id,
        items: rewriteGrimmValue(statement.items, bindings, prefix, locals),
        ...(statement.inputs === undefined ? {} : { inputs: rewriteGrimmValues(statement.inputs, bindings, prefix, locals) }),
        ...(statement.initial === undefined ? {} : { initial: rewriteGrimmValue(statement.initial, bindings, prefix, locals) }),
        body: statement.body.map(child => inlineGrimmStatement(child, bindings, prefix, nestedLocals)),
      }
    }
    case 'defer-choice':
      return {
        ...statement,
        id,
        payload: rewriteGrimmValue(statement.payload, bindings, prefix, locals),
        ...(statement.player === undefined ? {} : { player: rewriteGrimmValue(statement.player, bindings, prefix, locals) }),
        ...(statement.title === undefined ? {} : { title: rewriteGrimmValue(statement.title, bindings, prefix, locals) }),
        ...(statement.targetType === undefined ? {} : { targetType: rewriteGrimmValue(statement.targetType, bindings, prefix, locals) }),
        ...(statement.range === undefined ? {} : { range: rewriteGrimmValue(statement.range, bindings, prefix, locals) }),
        ...(statement.filter === undefined ? {} : { filter: rewriteGrimmValue(statement.filter, bindings, prefix, locals) }),
        ...(statement.candidates === undefined ? {} : { candidates: rewriteGrimmValue(statement.candidates, bindings, prefix, locals) }),
        ...(statement.selectionMode === undefined ? {} : { selectionMode: rewriteGrimmValue(statement.selectionMode, bindings, prefix, locals) }),
        ...(statement.min === undefined ? {} : { min: rewriteGrimmValue(statement.min, bindings, prefix, locals) }),
        ...(statement.max === undefined ? {} : { max: rewriteGrimmValue(statement.max, bindings, prefix, locals) }),
        ...(statement.minSelections === undefined ? {} : { minSelections: rewriteGrimmValue(statement.minSelections, bindings, prefix, locals) }),
        ...(statement.maxSelections === undefined ? {} : { maxSelections: rewriteGrimmValue(statement.maxSelections, bindings, prefix, locals) }),
        ...(statement.canCancel === undefined ? {} : { canCancel: rewriteGrimmValue(statement.canCancel, bindings, prefix, locals) }),
        ...(statement.resumeOnCancel === undefined ? {} : { resumeOnCancel: rewriteGrimmValue(statement.resumeOnCancel, bindings, prefix, locals) }),
        ...(statement.message === undefined ? {} : { message: rewriteGrimmValue(statement.message, bindings, prefix, locals) }),
      }
    case 'return':
      return {
        ...statement,
        id,
        ...(statement.value === undefined ? {} : { value: rewriteGrimmValue(statement.value, bindings, prefix, locals) }),
        ...(statement.values === undefined ? {} : { values: rewriteGrimmValues(statement.values, bindings, prefix, locals) }),
      }
    default:
      return statement
  }
}

function inlineGrimmResolve(selected: GameplayValue, grimm: GameplayValue, enemy: GameplayValue, reserved: GameplayValue): GameplayStatement[] {
  const bindings: GrimmInlineBindings = { grimm, enemy, selected, reserved }
  return buildGrimmResolveBody().map(statement => inlineGrimmStatement(statement, bindings, 'resolve-'))
}

function buildGrimmGraph(trigger: 'afterMove' | 'afterSkillUsed'): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('grimm-ref', 'ref.holder'), call('grimm-exists', 'query.has-piece', { pieceId: out('grimm-ref', 'piece') }),
  ]
  guard(body, 'grimm-check', out('grimm-exists', 'exists'))
  body.push(
    call('grimm', 'query.piece', { pieceId: out('grimm-ref', 'piece') }),
    call('enemy-ref', 'ref.source'), call('enemy-exists', 'query.has-piece', { pieceId: out('enemy-ref', 'piece') }),
  )
  guard(body, 'enemy-check', out('enemy-exists', 'exists'))
  body.push(
    call('enemy', 'query.piece', { pieceId: out('enemy-ref', 'piece') }),
    call('grimm-hp', 'attribute.read', { piece: out('grimm', 'piece') }, { attribute: 'currentHp' }),
    call('enemy-hp', 'attribute.read', { piece: out('enemy', 'piece') }, { attribute: 'currentHp' }),
    call('grimm-alive', 'compare.greater-than', { left: out('grimm-hp', 'value'), right: literal(0) }),
    call('enemy-alive', 'compare.greater-than', { left: out('enemy-hp', 'value'), right: literal(0) }),
    call('grimm-owner', 'piece.owner', { piece: out('grimm', 'piece') }),
    call('enemy-owner', 'piece.owner', { piece: out('enemy', 'piece') }),
    call('allied', 'compare.allied-players', { left: out('enemy-owner', 'player'), right: out('grimm-owner', 'player') }),
    call('not-allied', 'logic.not', { value: out('allied', 'value') }),
    call('different', 'compare.not-equal-piece', { left: out('enemy', 'piece'), right: out('grimm', 'piece') }),
    call('distance', 'query.distance', { from: out('enemy', 'piece'), to: out('grimm', 'piece') }),
    call('nearby', 'compare.less-or-equal', { left: out('distance', 'distance'), right: literal(4) }),
    call('cancelled', 'event.cancelled'), call('not-cancelled', 'logic.not', { value: out('cancelled', 'value') }),
    call('eligible-a', 'logic.and', { left: out('grimm-alive', 'value'), right: out('enemy-alive', 'value') }),
    call('eligible-b', 'logic.and', { left: out('eligible-a', 'value'), right: out('not-allied', 'value') }),
    call('eligible-c', 'logic.and', { left: out('eligible-b', 'value'), right: out('different', 'value') }),
    call('eligible-d', 'logic.and', { left: out('eligible-c', 'value'), right: out('nearby', 'value') }),
    call('eligible', 'logic.and', { left: out('eligible-d', 'value'), right: out('not-cancelled', 'value') }),
  )
  guard(body, 'eligible-check', out('eligible', 'value'))
  body.push(call('selected', 'event.selected-targets'), call('selected-count', 'list.count-choices', { items: out('selected', 'targets') }), call('has-selected', 'compare.greater-than', { left: out('selected-count', 'value'), right: literal(0) }))
  const resolve = (selected: GameplayValue): GameplayStatement[] => [
    call('resolve-reserved', 'event.reserved-cells'),
    ...inlineGrimmResolve(selected, out('grimm', 'piece'), out('enemy', 'piece'), out('resolve-reserved', 'cells')),
  ]
  const candidateBody: GameplayStatement[] = [
    call('candidate-distance', 'spatial.cell-distance', { from: input('origin'), to: input('item') }),
    call('candidate-near', 'compare.less-or-equal', { left: out('candidate-distance', 'distance'), right: literal(2) }),
    call('candidate-same-distance', 'compare.equal', { left: out('candidate-distance', 'distance'), right: literal(0) }),
    call('candidate-not-same', 'logic.not', { value: out('candidate-same-distance', 'value') }),
    call('candidate-free', 'spatial.cell-unoccupied', { cell: input('item') }),
    call('candidate-reserved-hit', 'spatial.cell-in-list', { cell: input('item'), cells: input('reserved') }),
    call('candidate-not-reserved', 'logic.not', { value: out('candidate-reserved-hit', 'value') }),
    call('candidate-a', 'logic.and', { left: out('candidate-near', 'value'), right: out('candidate-not-same', 'value') }),
    call('candidate-b', 'logic.and', { left: out('candidate-a', 'value'), right: out('candidate-free', 'value') }),
    call('candidate', 'logic.and', { left: out('candidate-b', 'value'), right: out('candidate-not-reserved', 'value') }),
    { kind: 'return', id: 'candidate-result', value: out('candidate', 'value') },
  ]
  body.push({
    kind: 'if', id: 'selection-branch', condition: out('has-selected', 'value'), then: resolve(out('selected', 'targets')), else: [
      call('origin', 'spatial.piece-position', { piece: out('grimm', 'piece') }),
      call('candidate-reserved', 'event.reserved-cells'),
      call('walkable', 'spatial.walkable-cells'),
      { kind: 'collection', id: 'candidates', method: 'filter', items: out('walkable', 'cells'), item: 'item', inputs: { origin: out('origin', 'cell'), reserved: out('candidate-reserved', 'cells') }, body: candidateBody },
      call('candidate-count', 'list.count-cells', { items: out('candidates', 'value') }),
      call('has-candidates', 'compare.greater-than', { left: out('candidate-count', 'value'), right: literal(0) }),
      { kind: 'if', id: 'candidate-branch', condition: out('has-candidates', 'value'), then: [
        call('choice-result', 'choice.cell-options', { player: out('grimm-owner', 'player'), cells: out('candidates', 'value'), title: literal('狩猎本能：选择落点') }, { targetType: 'cell', success: false, filter: 'all', selectionMode: 'single', minSelections: 1, maxSelections: 1, canCancel: true, resumeOnCancel: true }),
        { kind: 'return', id: 'choice-return', value: out('choice-result', 'result') },
      ], else: [fail('no-candidates')] },
    ],
  })
  const asResultRecords = (statements: readonly GameplayStatement[]): GameplayStatement[] => statements.flatMap(statement => {
    if (statement.kind === 'return' && statement.values) return [
      call(statement.id + '-record', 'result.action', { ...statement.values }),
      { kind: 'return', id: statement.id, value: out(statement.id + '-record', 'result') } as GameplayStatement,
    ]
    if (statement.kind === 'if') return [{ ...statement, then: asResultRecords(statement.then), ...(statement.else ? { else: asResultRecords(statement.else) } : {}) }]
    return [statement]
  })
  return baseGraph('rule', asResultRecords(body), { outputs: [{ name: 'result', type: 'record' }], schemas: [grimmPayloadSchema], layout: { trigger } })
}

export function buildFollowupRuleGraph(id: typeof FOLLOWUP_RULE_IDS[number]): GameplayModuleGraph {
  if (id === 'rule-aizen-black-coffin-end') return buildBlackCoffinGraph()
  if (id === 'rule-aizen-kyoka-expire') return buildKyokaGraph()
  if (id === 'rule-elune-guidance') return buildEluneGraph()
  // Keep the approved production builder on the typed structured-log
  // boundary.  The migration recipe remains available for historical
  // documents, but newly generated Mangekyo graphs must not emit the retired
  // arbitrary action-record input.
  if (id === 'rule-mangekyo-friendly-death') return migrateStructuredActionLogModules(buildMangekyoGraph())
  if (id === 'rule-grimmjow-hunt-after-move') return buildGrimmGraph('afterMove')
  return buildGrimmGraph('afterSkillUsed')
}

export const buildFollowupRuleGraphs = Object.freeze(Object.fromEntries(FOLLOWUP_RULE_IDS.map(id => [id, buildFollowupRuleGraph(id)]))) as Readonly<Record<typeof FOLLOWUP_RULE_IDS[number], GameplayModuleGraph>>

const ignoredLegacyKeys = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
function assertPreservedFields(current: Record<string, unknown>, original: Record<string, unknown>, id: string): void {
  for (const [key, value] of Object.entries(original)) {
    if (ignoredLegacyKeys.has(key)) continue
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) throw new Error(`${id}: migration changed frozen field ${key}`)
  }
}

export function migrateSemanticFollowupRules(root = process.cwd(), write = false): { ids: readonly string[]; written: boolean } {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')) as { entries: Record<string, Record<string, unknown>> }
  const pending: Array<{ file: string; document: Record<string, unknown> }> = []
  for (const id of FOLLOWUP_RULE_IDS) {
    const original = fixture.entries['rules/' + id]
    if (!original) throw new Error(`missing frozen follow-up rule ${id}`)
    const file = path.join(root, 'data/rules', id + '.json')
    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const graph = buildFollowupRuleGraph(id)
    const existingModules = existing.gameplayModules
    const alreadyModuleOwned = Boolean(existingModules && typeof existingModules === 'object' && !Array.isArray(existingModules)
      && (existingModules as Record<string, unknown>).entries && typeof (existingModules as Record<string, unknown>).entries === 'object'
      && ((existingModules as Record<string, unknown>).entries as Record<string, unknown>).skillCode)
    if (alreadyModuleOwned) {
      assertGameplayModuleDocument(existing)
      const entry = (existingModules as Record<string, unknown>).entries as Record<string, unknown>
      const existingGraph = (entry.skillCode as Record<string, unknown>).graph
      if (JSON.stringify(existingGraph) !== JSON.stringify(graph)) throw new Error(`${id}: existing gameplay graph differs from approved migration graph`)
      assertPreservedFields(existing, original, id)
      continue
    }
    assertFrozenExecutable(existing, original, 'skillCode', 'rule', id)
    const migrated = applyGameplayModuleGraph(original, graph, 'skillCode')
    assertPreservedFields(migrated, original, id)
    assertGameplayModuleDocument(migrated)
    pending.push({ file, document: migrated })
  }
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.document, null, 2) + '\n')
  return { ids: FOLLOWUP_RULE_IDS, written: write }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const write = process.argv.includes('--write')
  console.log(JSON.stringify(migrateSemanticFollowupRules(process.cwd(), write)))
}
