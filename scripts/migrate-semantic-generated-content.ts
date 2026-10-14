import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_DOCUMENT_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayPort,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '../lib/skill-graph/module-registry'
import { CONTENT_GENERATION_GAMEPLAY_MODULES } from '../lib/skill-graph/module-registry-content-generation'
import { buildSemanticPreviewGraph } from './migrate-semantic-previews'

/** RED-252 semantic graph version for generated-content recipes. */
export const GENERATED_CONTENT_SEMANTIC_VERSION = '1' as const

type JsonRecord = Record<string, unknown>
type GraphField = 'code' | 'skillCode' | 'previewCode'
type GeneratedDocument = JsonRecord & {
  readonly id: string
  readonly gameplayModules: {
    readonly version: typeof GAMEPLAY_MODULE_DOCUMENT_VERSION
    readonly entries: Record<string, { readonly graph: GameplayModuleGraph; readonly compilerVersion: string }>
  }
}

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const port = (name: string, type: GameplayPort['type'], options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
): GameplayStatement {
  return { kind: 'call', id, module, version: GENERATED_CONTENT_SEMANTIC_VERSION, inputs, parameters }
}

function branch(id: string, condition: GameplayValue, then: readonly GameplayStatement[], otherwise: readonly GameplayStatement[] = []): GameplayStatement {
  return { kind: 'if', id, condition, then, else: otherwise }
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function actionResult(id: string, success: boolean, message: GameplayValue): GameplayStatement[] {
  return [
    call(`${id}-result`, 'result.action', { success: literal(success), message }),
    returnValue(`${id}-return`, output(`${id}-result`, 'result')),
  ]
}

function actionFailure(id: string, message: string): GameplayStatement[] {
  return actionResult(id, false, literal(message))
}

function pendingResult(id: string, choiceNode: string): GameplayStatement[] {
  return [
    call(`${id}-result`, 'choice.as-result', { choice: output(choiceNode, 'choice') }),
    returnValue(`${id}-return`, output(`${id}-result`, 'result')),
  ]
}

function createRecord(id: string, schema: string, fields: Readonly<Record<string, GameplayValue>>): GameplayStatement {
  return { kind: 'record.create', id, schema, fields }
}

const ARMOR_MODULES = ['heal', 'attack', 'speed', 'defense'] as const
const ARMOR_CARD_IDS = ARMOR_MODULES
  .flatMap((left, index) => ARMOR_MODULES.slice(index + 1).map(right => `armor-${[left, right].sort().join('-')}`))
  .sort()

export const GENERATED_ARMOR_CARD_IDS: readonly string[] = Object.freeze(ARMOR_CARD_IDS)

const ARMOR_STATUS_SCHEMA: GameplayRecordSchema = {
  id: 'generated-content.armor-status',
  version: GENERATED_CONTENT_SEMANTIC_VERSION,
  fields: [
    port('id', 'string'),
    port('type', 'string'),
    port('name', 'string'),
    port('stacks', 'number'),
    port('relatedRules', { kind: 'list', element: 'string' }),
  ],
}

const localDescriptors = Array.from(new Map([
  ...GAMEPLAY_MODULE_REGISTRY.descriptors,
  ...CONTENT_GENERATION_GAMEPLAY_MODULES,
].map(descriptor => [`${descriptor.id}\u0000${descriptor.version}`, descriptor] as const)).values())
const localDescriptorById = new Map(localDescriptors.map(descriptor => [`${descriptor.id}\u0000${descriptor.version}`, descriptor]))

/** Registry used by this migration before the root registry imports the new descriptors. */
export const GENERATED_CONTENT_GAMEPLAY_REGISTRY: GameplayModuleRegistry = Object.freeze({
  descriptors: Object.freeze(localDescriptors),
  get: (id: string, version?: string) => {
    const descriptor = localDescriptorById.get(`${id}\u0000${version ?? GENERATED_CONTENT_SEMANTIC_VERSION}`)
    return descriptor && (version === undefined || descriptor.version === version) ? descriptor : undefined
  },
  resolve: (id: string, version?: string) => {
    const descriptor = localDescriptorById.get(`${id}\u0000${version ?? GENERATED_CONTENT_SEMANTIC_VERSION}`)
    return descriptor && (version === undefined || descriptor.version === version) ? descriptor : undefined
  },
})

export function buildTailsArmorCardGraph(selected: readonly string[]): GameplayModuleGraph {
  if (selected.length !== 2 || selected.some(item => !ARMOR_MODULES.includes(item as typeof ARMOR_MODULES[number])) || selected[0] === selected[1]) {
    throw new Error('tails armor card graph requires two different registered modules')
  }
  const body: GameplayStatement[] = [
    call('target-choice', 'choice.target-piece', {}, { range: 99, filter: 'ally' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-pending', output('target-unresolved', 'value'), pendingResult('target-pending', 'target-choice'), [
      call('target', 'choice.piece', { choice: output('target-choice', 'choice') }),
      call('target-present', 'query.has-piece', { pieceId: output('target', 'piece') }),
      branch('target-guard', output('target-present', 'exists'), [
        {
          kind: 'foreach',
          id: 'apply-modules',
          items: input('selected'),
          item: 'module',
          index: 'moduleIndex',
          body: [
            call('is-heal', 'compare.equal-string', { left: output('apply-modules', 'item'), right: literal('heal') }),
            branch('heal-guard', output('is-heal', 'value'), [
              call('heal-id', 'status.make-id', { target: output('target', 'piece') }, { prefix: 'periodic-heal-' }),
              createRecord('heal-status', ARMOR_STATUS_SCHEMA.id, {
                id: output('heal-id', 'id'), type: literal('periodic-heal'), name: literal('恢复模块'), stacks: literal(1), relatedRules: literal(['rule-tails-armor-recovery']),
              }),
              call('apply-heal-status', 'status.append-record', { target: output('target', 'piece'), record: output('heal-status', 'value') }),
              call('apply-heal-rule', 'rule.apply-piece', { target: output('target', 'piece') }, { ruleId: 'rule-tails-armor-recovery' }),
            ]),
            call('is-attack', 'compare.equal-string', { left: output('apply-modules', 'item'), right: literal('attack') }),
            branch('attack-guard', output('is-attack', 'value'), [
              call('apply-attack', 'attribute.adjust', { piece: output('target', 'piece'), amount: literal(3) }, { attribute: 'attack' }),
            ]),
            call('is-speed', 'compare.equal-string', { left: output('apply-modules', 'item'), right: literal('speed') }),
            branch('speed-guard', output('is-speed', 'value'), [
              call('speed-id', 'status.make-id', { target: output('target', 'piece') }, { prefix: 'free-normal-move-every-turn-' }),
              createRecord('speed-status', ARMOR_STATUS_SCHEMA.id, {
                id: output('speed-id', 'id'), type: literal('free-normal-move-every-turn'), name: literal('高速模块'), stacks: literal(1), relatedRules: literal(['rule-sonic-free-move']),
              }),
              call('apply-speed-status', 'status.append-record', { target: output('target', 'piece'), record: output('speed-status', 'value') }),
              call('apply-speed-rule', 'rule.apply-piece', { target: output('target', 'piece') }, { ruleId: 'rule-sonic-free-move' }),
            ]),
            call('is-defense', 'compare.equal-string', { left: output('apply-modules', 'item'), right: literal('defense') }),
            branch('defense-guard', output('is-defense', 'value'), [
              call('apply-defense', 'attribute.adjust', { piece: output('target', 'piece'), amount: literal(2) }, { attribute: 'defense' }),
            ]),
          ],
        },
        ...actionResult('success', true, literal('获得组合护甲效果')),
      ], actionFailure('missing-target', '无法找到护甲目标')),
    ]),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'card',
    inputs: [port('selected', { kind: 'list', element: 'string' })],
    inputBindings: { selected: [...selected] },
    outputs: [port('result', 'record', { nullable: true })],
    schemas: [ARMOR_STATUS_SCHEMA],
    body,
  }
}

export function buildTailsArmorAssemblyGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('owner-ref', 'ref.player'),
    call('owner-present', 'query.has-player', { playerId: output('owner-ref', 'player') }),
    branch('owner-guard', output('owner-present', 'exists'), [
      call('owner', 'query.player', { playerId: output('owner-ref', 'player') }),
      call('module-choice', 'choice.string-options', {}, {
        title: '护甲组装：选择两个不同模块', options: [...ARMOR_MODULES], labels: ['恢复模块', '攻击模块', '高速模块', '硬化模块'], minSelections: 2, maxSelections: 2, selectionMode: 'multi',
      }),
      call('choice-unresolved', 'choice.is-unresolved', { choice: output('module-choice', 'choice') }),
      branch('choice-pending', output('choice-unresolved', 'value'), pendingResult('choice-pending', 'module-choice'), [
        call('selected', 'choice.as-string-list', { choice: output('module-choice', 'choice') }),
        call('selected-count', 'list.count', { items: output('selected', 'values') }),
        call('has-two', 'compare.equal', { left: output('selected-count', 'count'), right: literal(2) }),
        call('duplicate', 'list.has-duplicate', { items: output('selected', 'values') }),
        call('no-duplicate', 'logic.not', { value: output('duplicate', 'duplicate') }),
        call('allowed', 'list.all-in', { items: output('selected', 'values') }, { allowed: [...ARMOR_MODULES] }),
        branch('selection-count-guard', output('has-two', 'value'), [
          branch('selection-duplicate-guard', output('no-duplicate', 'value'), [
            branch('selection-domain-guard', output('allowed', 'valid'), [
              call('sorted', 'list.sort-string', { items: output('selected', 'values') }),
              call('joined', 'list.join', { items: output('sorted', 'sorted') }, { separator: '-' }),
              call('card-id-prefix', 'text.concat', { left: literal('armor-'), right: output('joined', 'text') }),
              call('name-joined', 'list.join', { items: output('sorted', 'sorted') }, { separator: ' + ' }),
              call('card-name-prefix', 'text.concat', { left: literal('组合护甲（'), right: output('name-joined', 'text') }),
              call('card-name', 'text.concat', { left: output('card-name-prefix', 'text'), right: literal('）') }),
              call('card-materialized', 'content.materialize-template', {
                templateId: output('card-id-prefix', 'text'), cardId: output('card-id-prefix', 'text'), name: output('card-name', 'text'),
                description: literal('对一名友军使用，永久获得所选模块效果。'), owner: output('owner', 'player'),
              }, { kind: 'card' }),
              branch('materialize-guard', output('card-materialized', 'success'), [
                call('add-card', 'card.hand-add-ref', { player: output('owner', 'player'), cardId: output('card-materialized', 'cardId') }),
                branch('add-card-guard', output('add-card', 'success'), actionResult('created', true, literal('创造了组合护甲手牌')), actionFailure('add-card-failed', '无法创建组合护甲手牌')),
              ], actionFailure('materialize-failed', '无法创建组合护甲手牌')),
            ], actionFailure('invalid-module', '模块选择无效')),
          ], actionFailure('duplicate-module', '必须选择两个不同模块')),
        ], actionFailure('invalid-count', '必须选择两个不同模块')),
      ]),
    ], actionFailure('missing-owner', '无法找到护甲持有者')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [port('result', 'record', { nullable: true })],
    body,
  }
}

export function buildTailsMechanicalSupportGraph(): GameplayModuleGraph {
  const statusBody = (choice: GameplayValue | undefined, prefix: string): GameplayStatement[] => {
    const id = (name: string) => `${prefix}-${name}`
    return [
    call(id('removal'), 'status.remove-choice', { target: output('target', 'piece'), ...(choice ? { choice } : {}) }),
    call(id('momentum-eight'), 'compare.greater-or-equal', { left: output('momentum', 'value'), right: literal(8) }),
    call(id('turn'), 'turn.number'),
    branch(id('free-move-guard'), output(id('momentum-eight'), 'value'), [
      call(id('refresh-free-move'), 'status.refresh-temporary', { target: output('target', 'piece'), turn: output(id('turn'), 'value') }, {
        statusType: 'deployment-first-move-free', name: '下一次普通移动免费', idPrefix: 'mechanical-support-free-move-', duration: 1, uses: 1, visible: true,
      }),
    ]),
    call(id('heal-text'), 'text.from-number', { value: output('heal', 'heal') }),
    call(id('heal-prefix'), 'text.concat', { left: literal('回复'), right: output(id('heal-text'), 'text') }),
    call(id('heal-message'), 'text.concat', { left: output(id('heal-prefix'), 'text'), right: literal('点生命') }),
    call(id('removed-fragment'), 'text.optional-fragment', { condition: output(id('removal'), 'removed'), value: output(id('removal'), 'name') }, { prefix: '，移除了' }),
    call(id('free-fragment'), 'text.optional-fragment', { condition: output(id('momentum-eight'), 'value'), value: literal('') }, { prefix: '，下一次普通移动免费' }),
    call(id('message-with-removal'), 'text.concat', { left: output(id('heal-message'), 'text'), right: output(id('removed-fragment'), 'text') }),
    call(id('full-message'), 'text.concat', { left: output(id('message-with-removal'), 'text'), right: output(id('free-fragment'), 'text') }),
    call(id('success-result'), 'result.action', { success: literal(true), message: output(id('full-message'), 'text') }),
    returnValue(id('success-return'), output(id('success-result'), 'result')),
  ]
  }
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('target-choice', 'choice.target-piece', {}, { range: 7, filter: 'ally' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-pending', output('target-unresolved', 'value'), pendingResult('target-pending', 'target-choice'), [
      call('target', 'choice.piece', { choice: output('target-choice', 'choice') }),
      call('target-present', 'query.has-piece', { pieceId: output('target', 'piece') }),
      branch('target-guard', output('target-present', 'exists'), [
        call('momentum', 'piece.momentum', { piece: output('source', 'piece') }),
        call('momentum-four', 'compare.greater-or-equal', { left: output('momentum', 'value'), right: literal(4) }),
        call('bonus', 'value.select-number', { condition: output('momentum-four', 'value'), whenTrue: literal(2), whenFalse: literal(0) }),
        call('heal-amount', 'math.add', { left: literal(5), right: output('bonus', 'value') }),
        call('heal', 'effect.heal', { source: output('source', 'piece'), target: output('target', 'piece'), amount: output('heal-amount', 'value') }, { skillId: 'tails-mechanical-support' }),
        call('status-count', 'status.count-all', { target: output('target', 'piece') }),
        call('has-status', 'compare.greater-than', { left: output('status-count', 'count'), right: literal(0) }),
          branch('status-available', output('has-status', 'value'), [
          call('status-choice', 'choice.status-tags', { target: output('target', 'piece') }, { title: '机械支援：选择要解除的效果' }),
          call('status-unresolved', 'choice.is-unresolved', { choice: output('status-choice', 'choice') }),
          branch('status-pending', output('status-unresolved', 'value'), pendingResult('status-pending', 'status-choice'), statusBody(output('status-choice', 'choice'), 'selected-status')),
        ], statusBody(undefined, 'empty-status')),
      ], actionFailure('missing-target', '无法找到机械支援目标')),
    ]),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [port('result', 'record', { nullable: true })],
    body,
  }
}

export function buildRafaamCurseAmplifyGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('caster-ref', 'ref.holder'),
    call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }),
    call('caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }),
    call('owner-ref', 'ref.player'),
    call('enemy', 'content.enemy-player', { player: output('owner-ref', 'player') }),
    call('enemy-present', 'query.has-player', { playerId: output('enemy', 'enemy') }),
    branch('enemy-guard', output('enemy-present', 'exists'), [
      call('enemy-player', 'query.player', { playerId: output('enemy', 'enemy') }),
      call('hand', 'content.filter-hand', { player: output('enemy-player', 'player') }, { nameContains: '诅咒', cardIdPrefix: 'rafaam-curse' }),
      branch('hand-guard', output('hand', 'hasHand'), [
        call('curse-count', 'list.count', { items: output('hand', 'cards') }),
        call('has-curses', 'compare.greater-than', { left: output('curse-count', 'count'), right: literal(0) }),
        branch('curse-guard', output('has-curses', 'value'), [
          {
            kind: 'foreach',
            id: 'copy-curses',
            items: output('hand', 'cards'),
            item: 'sourceCard',
            index: 'cardIndex',
            body: [
              call('copy', 'content.copy-card', { sourceId: output('copy-curses', 'item'), index: output('copy-curses', 'index') }, { idPrefix: 'rafaam-curse-copy-' }),
              call('add-copy', 'card.hand-add-ref', { player: output('enemy-player', 'player'), cardId: output('copy', 'cardId') }),
            ],
          },
          call('count-text', 'text.from-number', { value: output('curse-count', 'count') }),
          call('message-prefix', 'text.concat', { left: output('caster-name', 'text'), right: literal('给对方复制了') }),
          call('message-count', 'text.concat', { left: output('message-prefix', 'text'), right: output('count-text', 'text') }),
          call('message', 'text.concat', { left: output('message-count', 'text'), right: literal('张诅咒') }),
          ...actionResult('success', true, output('message', 'text')),
        ], actionFailure('missing-curses', '对手手牌中没有诅咒')),
      ], actionFailure('missing-hand', '对手没有手牌')),
    ], actionFailure('missing-enemy', '对手没有手牌')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [port('result', 'record', { nullable: true })],
    body,
  }
}

function buildRuleFailure(id: string, message = ''): GameplayStatement[] {
  return actionFailure(id, message)
}

/**
 * Refresh the existing free-movement status at the owning player's turn
 * boundary.  The status host supplies the stable ID and lifecycle fields,
 * preserving the old direct-object mutation without exposing object paths to
 * the graph author.
 */
export function buildSonicFreeMoveRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
    branch('holder-guard', output('holder-present', 'exists'), [
      call('piece', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
      call('owner', 'piece.owner', { piece: output('piece', 'piece') }),
      call('event-player', 'ref.event-player'),
      call('own-turn', 'compare.player-reference', { left: output('owner', 'player'), right: output('event-player', 'player') }),
      branch('turn-guard', output('own-turn', 'value'), [
        call('turn', 'turn.number'),
        call('refresh', 'status.refresh-temporary', { target: output('piece', 'piece'), turn: output('turn', 'value') }, {
          statusType: 'deployment-first-move-free',
          name: '本回合首次移动免费',
          idPrefix: 'sonic-free-normal-move-',
          duration: 1,
          uses: 1,
          visible: true,
        }),
        call('name', 'attribute.text', { piece: output('piece', 'piece') }, { attribute: 'name' }),
        call('message', 'text.concat', { left: output('name', 'text'), right: literal('获得了本回合首次免费移动') }),
        ...actionResult('success', true, output('message', 'text')),
      ], buildRuleFailure('wrong-turn')),
    ], buildRuleFailure('missing-piece')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [port('result', 'record', { nullable: true })],
    body,
  }
}

/**
 * Count every armor recovery instance, including legacy records without ids.
 * Recovery uses the authoritative healing path, as required by the author
 * contract, so healing rules and presentation observe the same operation.
 */
export function buildTailsArmorRecoveryRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
    branch('holder-guard', output('holder-present', 'exists'), [
      call('piece', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
      call('hp', 'attribute.read', { piece: output('piece', 'piece') }, { attribute: 'currentHp' }),
      call('alive', 'compare.greater-than', { left: output('hp', 'value'), right: literal(0) }),
      call('owner', 'piece.owner', { piece: output('piece', 'piece') }),
      call('event-player', 'ref.event-player'),
      call('own-turn', 'compare.player-reference', { left: output('owner', 'player'), right: output('event-player', 'player') }),
      branch('event-guard', output('alive', 'value'), [
        branch('turn-guard', output('own-turn', 'value'), [
          call('status-instances', 'status.instances', { piece: output('piece', 'piece') }),
          { kind: 'collection', id: 'recovery-statuses', method: 'filter', items: output('status-instances', 'statuses'), item: 'status', body: [
            call('status-type', 'status.instance-field', { status: input('status') }, { field: 'type' }),
            call('is-recovery', 'compare.values', { left: output('status-type', 'value'), right: literal('periodic-heal') }, { valueType: JSON.stringify({ kind: 'nullable', value: 'string' }), operator: '==' }),
            returnValue('recovery-match', output('is-recovery', 'value')),
          ] },
          call('status-count', 'collection.length', { items: output('recovery-statuses', 'value') }),
          call('has-status', 'compare.greater-than', { left: output('status-count', 'value'), right: literal(0) }),
          branch('status-guard', output('has-status', 'value'), [
            call('amount', 'math.multiply', { left: output('status-count', 'value'), right: literal(3) }),
            call('heal', 'effect.heal', { source: output('piece', 'piece'), target: output('piece', 'piece'), amount: output('amount', 'value') }, { skillId: 'rule-tails-armor-recovery' }),
            call('name', 'attribute.text', { piece: output('piece', 'piece') }, { attribute: 'name' }),
            call('prefix', 'text.concat', { left: output('name', 'text'), right: literal('的恢复模块回复') }),
            call('amount-text', 'text.from-number', { value: output('amount', 'value') }),
            call('with-amount', 'text.concat', { left: output('prefix', 'text'), right: output('amount-text', 'text') }),
            call('message', 'text.concat', { left: output('with-amount', 'text'), right: literal('点生命') }),
            ...actionResult('success', true, output('message', 'text')),
          ], [
            call('remove-rule', 'rule.remove-piece', { target: output('piece', 'piece') }, { ruleId: 'rule-tails-armor-recovery' }),
            ...buildRuleFailure('missing-status'),
          ]),
        ], buildRuleFailure('wrong-turn')),
      ], buildRuleFailure('dead-piece')),
    ], buildRuleFailure('missing-piece')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [port('result', 'record', { nullable: true })],
    body,
  }
}

type Recipe = {
  readonly id: string
  readonly file: string
  readonly field: GraphField
  readonly build: () => GameplayModuleGraph
  readonly previewBuild?: (baseline: JsonRecord) => GameplayModuleGraph
}

type RuleRecipe = {
  readonly id: string
  readonly file: string
  readonly field: 'skillCode'
  readonly build: () => GameplayModuleGraph
}

export const GENERATED_CONTENT_RECIPES: readonly Recipe[] = Object.freeze([
  { id: 'skills/tails-armor-assembly', file: 'data/skills/tails-armor-assembly.json', field: 'code', build: buildTailsArmorAssemblyGraph },
  { id: 'skills/tails-mechanical-support', file: 'data/skills/tails-mechanical-support.json', field: 'code', build: buildTailsMechanicalSupportGraph },
  {
    id: 'skills/rafaam-curse-amplify', file: 'data/skills/rafaam-curse-amplify.json', field: 'code', build: buildRafaamCurseAmplifyGraph,
    previewBuild: baseline => {
      if (typeof baseline.previewCode !== 'string') throw new Error('skills/rafaam-curse-amplify: frozen baseline has no previewCode')
      return buildSemanticPreviewGraph(baseline.previewCode)
    },
  },
])

export const GENERATED_CONTENT_RULE_RECIPES: readonly RuleRecipe[] = Object.freeze([
  { id: 'rules/rule-sonic-free-move', file: 'data/rules/rule-sonic-free-move.json', field: 'skillCode', build: buildSonicFreeMoveRuleGraph },
  { id: 'rules/rule-tails-armor-recovery', file: 'data/rules/rule-tails-armor-recovery.json', field: 'skillCode', build: buildTailsArmorRecoveryRuleGraph },
])

function artifact(graph: GameplayModuleGraph): { graph: GameplayModuleGraph; compilerVersion: string } {
  const compiled = compileGameplayModuleGraph(graph, GENERATED_CONTENT_GAMEPLAY_REGISTRY)
  return { graph, compilerVersion: compiled.compilerVersion }
}

function applyLocalGraph(
  document: JsonRecord,
  graph: GameplayModuleGraph,
  field: GraphField,
  additional: readonly { readonly field: GraphField; readonly graph: GameplayModuleGraph }[] = [],
): GeneratedDocument {
  const compiled = compileGameplayModuleGraph(graph, GENERATED_CONTENT_GAMEPLAY_REGISTRY)
  const next: JsonRecord = { ...document, [field]: compiled.code }
  const previous = document.gameplayModules && typeof document.gameplayModules === 'object' && !Array.isArray(document.gameplayModules)
    ? document.gameplayModules as JsonRecord
    : undefined
  const previousEntries = previous?.entries && typeof previous.entries === 'object' && !Array.isArray(previous.entries)
    ? previous.entries as Record<string, unknown>
    : {}
  next.gameplayModules = {
    version: GAMEPLAY_MODULE_DOCUMENT_VERSION,
    ...(previous?.textBindings === undefined ? {} : { textBindings: previous.textBindings }),
    entries: {
      ...previousEntries,
      [field]: artifact(graph),
      ...Object.fromEntries(additional.map(item => [item.field, artifact(item.graph)])),
    },
  }
  for (const item of additional) {
    const compiledAdditional = compileGameplayModuleGraph(item.graph, GENERATED_CONTENT_GAMEPLAY_REGISTRY)
    next[item.field] = compiledAdditional.code
  }
  const removedFields = new Set<GraphField>([field, ...additional.map(item => item.field)])
  if (removedFields.has(document.contentGraphField as GraphField) || (document.contentGraph && typeof document.contentGraph === 'object' && (document.contentGraph as JsonRecord).surface === graph.surface)) {
    delete next.contentGraph
    delete next.contentGraphField
    delete next.contentGraphCompilerVersion
  }
  if (document.contentGraphEntries && typeof document.contentGraphEntries === 'object' && !Array.isArray(document.contentGraphEntries)) {
    const entries = { ...(document.contentGraphEntries as Record<string, unknown>) }
    for (const generatedField of removedFields) delete entries[generatedField]
    if (Object.keys(entries).length) next.contentGraphEntries = entries
    else delete next.contentGraphEntries
  }
  return next as GeneratedDocument
}

function assertLocalDocument(document: JsonRecord): void {
  const modules = document.gameplayModules
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) return
  const artifactValue = modules as JsonRecord
  if (artifactValue.version !== GAMEPLAY_MODULE_DOCUMENT_VERSION || !artifactValue.entries || typeof artifactValue.entries !== 'object' || Array.isArray(artifactValue.entries)) throw new Error('invalid gameplayModules artifact')
  for (const [field, entryValue] of Object.entries(artifactValue.entries as Record<string, unknown>)) {
    if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) throw new Error(`invalid gameplayModules entry ${field}`)
    const entry = entryValue as JsonRecord
    const graph = entry.graph as GameplayModuleGraph
    if (entry.compilerVersion !== GAMEPLAY_MODULE_COMPILER_VERSION) throw new Error(`unsupported gameplayModules compiler for ${field}`)
    const compiled = compileGameplayModuleGraph(graph, GENERATED_CONTENT_GAMEPLAY_REGISTRY)
    if (document[field] !== compiled.code) throw new Error(`generated ${field} does not match its graph`)
  }
}

function loadBaseline(root: string): Record<string, JsonRecord> {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')) as { entries: Record<string, JsonRecord> }
  return fixture.entries
}

function compatibilityFields(value: JsonRecord): JsonRecord {
  const generated = new Set(['code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  return Object.fromEntries(Object.entries(value).filter(([key]) => !generated.has(key)))
}

function assertCompatibility(id: string, baseline: JsonRecord, current: JsonRecord): void {
  const expected = compatibilityFields(baseline)
  const actual = compatibilityFields(current)
  // The frozen fixture defines fields whose gameplay meaning must remain
  // stable.  New metadata fields belong to the owning document and must pass
  // through unchanged, so they are intentionally absent from this comparison.
  for (const key of Object.keys(expected)) if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) throw new Error(`${id}: changed compatibility field ${key}`)
}

export function buildGeneratedCardDefinitions(): readonly JsonRecord[] {
  return GENERATED_ARMOR_CARD_IDS.map(cardId => {
    const selected = cardId.slice('armor-'.length).split('-')
    const graph = buildTailsArmorCardGraph(selected)
    const compiled = compileGameplayModuleGraph(graph, GENERATED_CONTENT_GAMEPLAY_REGISTRY)
    return {
      id: cardId,
      name: `组合护甲（${selected.join(' + ')}）`,
      description: '对一名友军使用，永久获得所选模块效果。',
      type: 'active',
      actionPointCost: 2,
      code: compiled.code,
      gameplayModules: {
        version: GAMEPLAY_MODULE_DOCUMENT_VERSION,
        entries: { code: { graph, compilerVersion: compiled.compilerVersion } },
      },
    } satisfies JsonRecord
  })
}

export type MigrationResult = { readonly id: string; readonly file: string; readonly document: GeneratedDocument; readonly graph: GameplayModuleGraph; readonly changed: boolean }

export function preflightGeneratedContent(root: string): {
  readonly skills: readonly MigrationResult[]
  readonly rules: readonly MigrationResult[]
  readonly cards: readonly { readonly file: string; readonly document: JsonRecord }[]
} {
  const baseline = loadBaseline(root)
  const skills: MigrationResult[] = []
  for (const recipe of GENERATED_CONTENT_RECIPES) {
    const file = path.join(root, recipe.file)
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
    const original = baseline[recipe.id]
    if (!original) throw new Error(`missing frozen baseline ${recipe.id}`)
    assertCompatibility(recipe.id, original, current)
    const graph = recipe.build()
    const baselineEntry = original
    const previewGraph = recipe.previewBuild?.(baselineEntry)
    const modules = current.gameplayModules
    if (modules !== undefined) {
      assertLocalDocument(current)
      const entries = modules && typeof modules === 'object' && !Array.isArray(modules) ? (modules as JsonRecord).entries : undefined
      const hasCodeEntry = entries && typeof entries === 'object' && !Array.isArray(entries) && Object.prototype.hasOwnProperty.call(entries, recipe.field)
      const hasPreviewEntry = previewGraph && entries && typeof entries === 'object' && !Array.isArray(entries) && Object.prototype.hasOwnProperty.call(entries, 'previewCode')
      if (hasCodeEntry && (!previewGraph || hasPreviewEntry)) {
        // A validated authored graph owns this content after the first save.
        skills.push({ id: recipe.id, file: recipe.file, document: current as GeneratedDocument, graph, changed: false })
        continue
      }
      if (!hasCodeEntry) throw new Error(`${recipe.id}: gameplayModules exists without a validated ${recipe.field} entry`)
      const next = applyLocalGraph(current, graph, recipe.field, previewGraph ? [{ field: 'previewCode', graph: previewGraph }] : [])
      assertLocalDocument(next)
      skills.push({ id: recipe.id, file: recipe.file, document: next, graph, changed: JSON.stringify(next) !== JSON.stringify(current) })
      continue
    }
    const next = applyLocalGraph(current, graph, recipe.field, previewGraph ? [{ field: 'previewCode', graph: previewGraph }] : [])
    assertLocalDocument(next)
    skills.push({ id: recipe.id, file: recipe.file, document: next, graph, changed: JSON.stringify(next) !== JSON.stringify(current) })
  }

  const rules: MigrationResult[] = []
  for (const recipe of GENERATED_CONTENT_RULE_RECIPES) {
    const file = path.join(root, recipe.file)
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
    const original = baseline[recipe.id]
    if (!original) throw new Error(`missing frozen baseline ${recipe.id}`)
    assertCompatibility(recipe.id, original, current)
    const graph = recipe.build()
    const modules = current.gameplayModules
    if (modules !== undefined) {
      assertLocalDocument(current)
      const entries = modules && typeof modules === 'object' && !Array.isArray(modules) ? (modules as JsonRecord).entries : undefined
      const hasEntry = entries && typeof entries === 'object' && !Array.isArray(entries) && Object.prototype.hasOwnProperty.call(entries, recipe.field)
      if (hasEntry) {
        // A validated authored graph owns this rule after the first save.
        rules.push({ id: recipe.id, file: recipe.file, document: current as GeneratedDocument, graph, changed: false })
        continue
      }
      throw new Error(`${recipe.id}: gameplayModules exists without a validated ${recipe.field} entry`)
    }
    const next = applyLocalGraph(current, graph, recipe.field)
    assertLocalDocument(next)
    rules.push({ id: recipe.id, file: recipe.file, document: next, graph, changed: JSON.stringify(next) !== JSON.stringify(current) })
  }

  const cards = buildGeneratedCardDefinitions().map(document => {
    const file = path.join(root, 'data/cards', `${String(document.id)}.json`)
    if (fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
      const modules = current.gameplayModules
      if (modules !== undefined) {
        // A validated authored card graph owns the executable fields on rerun;
        // static metadata and unknown author fields still remain untouched.
        assertLocalDocument(current)
        for (const key of ['id', 'name', 'description', 'type', 'actionPointCost']) {
          if (JSON.stringify(current[key]) !== JSON.stringify(document[key])) throw new Error(`${document.id}: generated card metadata changed: ${key}`)
        }
        return { file: path.relative(root, file), document: current }
      }
      if (JSON.stringify(current) !== JSON.stringify(document)) throw new Error(`${document.id}: generated card already exists with different content`)
      return { file: path.relative(root, file), document: current }
    }
    return { file: path.relative(root, file), document }
  })
  return { skills, rules, cards }
}

export function migrateGeneratedContent(root: string, write = false): string[] {
  // Every graph, source document, and generated card is compiled and checked
  // before any write starts so a failed item leaves the worktree untouched.
  const pending = preflightGeneratedContent(root)
  const changedCards = pending.cards.filter(item => !fs.existsSync(path.join(root, item.file))).map(item => item.file)
  const changedRules = pending.rules.filter(item => item.changed).map(item => item.id)
  if (write) {
    for (const item of pending.skills) if (item.changed) fs.writeFileSync(path.join(root, item.file), JSON.stringify(item.document, null, 2) + '\n')
    for (const item of pending.rules) if (item.changed) fs.writeFileSync(path.join(root, item.file), JSON.stringify(item.document, null, 2) + '\n')
    for (const item of pending.cards) {
      const file = path.join(root, item.file)
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(item.document, null, 2) + '\n')
    }
  }
  return [...pending.skills.filter(item => item.changed).map(item => item.id), ...changedRules, ...changedCards]
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd()
  const result = migrateGeneratedContent(root, process.argv.includes('--write'))
  console.log(JSON.stringify(result))
}

