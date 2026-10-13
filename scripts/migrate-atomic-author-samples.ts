import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyGameplayModuleGraph,
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayCallStatement,
  type GameplayModuleGraph,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'
import { migrateAtomicAuthorGraph } from './migrate-atomic-author-modules'

/**
 * RED-252's bounded authoring sample migration.
 *
 * This file intentionally owns only the four sample domains assigned to the
 * atomic authoring batch.  The older semantic migration builders remain in
 * their original files so their frozen differential fixtures stay useful.
 */

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
  version = '1',
): GameplayCallStatement => ({ kind: 'call', id, module, version, inputs, parameters })

const expression = (statement: GameplayCallStatement, owner: string, input: string): GameplayCallStatement => ({
  ...statement, layout: { sentenceExpression: { owner, input } },
})

const triggerResult = (id: string, success: GameplayValue): GameplayStatement => ({
  kind: 'return', id, values: { success },
})

const recordGet = (id: string, record: GameplayValue, field: string): GameplayStatement => ({
  kind: 'record.get', id, record, field,
})

const recordWith = (id: string, record: GameplayValue, fields: Record<string, GameplayValue>): GameplayStatement => ({
  kind: 'record.with', id, record, fields,
})

export const ATOMIC_RECALL_RECORD_SCHEMA: GameplayRecordSchema = {
  id: 'atomic-recall-record@1',
  version: '1',
  fields: [
    // The holder reference is nullable at the context boundary.  Keeping that
    // fact in the record schema lets the compiler add its normal invalid-value
    // propagation without a separate existence/require guard in author code.
    { name: 'piece', type: 'piece', nullable: true },
    // The map key must be a required field even though the host reference is
    // nullable at the context boundary.  Keep the stable instance identifier
    // alongside the reference so the extension map remains well-formed while
    // the record can still carry the nullable holder for restore.
    { name: 'pieceKey', type: 'string' },
    { name: 'owner', type: 'player' },
    { name: 'position', type: 'cell' },
    { name: 'targetCount', type: 'number' },
    { name: 'actionCount', type: 'number' },
    { name: 'snapshot', type: 'record' },
  ],
}

const RECALL_OPTIONS_SCHEMA: GameplayRecordSchema = {
  id: 'atomic-recall-options@1',
  version: '1',
  fields: Array.from({ length: 10 }, (_, index) => ({ name: String(index + 1), type: 'number' as const })),
}

const NARUTO_OPTIONS_SCHEMA: GameplayRecordSchema = {
  id: 'atomic-naruto-shadow-clone-options@1',
  version: '1',
  fields: [
    { name: '在目标格召唤分身', type: 'string' },
    { name: '传送至目标格，原地留下分身', type: 'string' },
  ],
}

const MINATO_OPTIONS_SCHEMA: GameplayRecordSchema = {
  id: 'atomic-minato-flying-raijin-options@1',
  version: '1',
  fields: [
    // Preserve the legacy pending-selection protocol.  The labels are for
    // presentation, while the existing rule and clients submit these stable
    // text values when resuming the choice.
    { name: '触发飞雷神', type: 'string' },
    { name: '不触发', type: 'string' },
  ],
}

const MINATO_MARK_SCHEMA: GameplayRecordSchema = {
  id: 'atomic-minato-flying-raijin-mark@1',
  version: '1',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'visible', type: 'boolean' },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' },
    { name: 'stacks', type: 'number' },
    { name: 'sourceId', type: 'string' },
  ],
}

function buildRecallSkillGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('owner', 'piece.owner', { piece: output('holder-ref', 'piece') }),
    {
      kind: 'record.create',
      id: 'options',
      schema: RECALL_OPTIONS_SCHEMA.id,
      fields: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index + 1), literal(index + 1)])),
    },
    call('selected', 'author.choice.option', { options: output('options', 'value') }, {
      valueType: 'number', title: '选择回溯次数', canCancel: true,
    }),
    call('position', 'spatial.piece-position', { piece: output('holder-ref', 'piece') }),
    call('piece-key', 'piece.identifier', { piece: output('holder-ref', 'piece') }),
    call('snapshot', 'instance.copy-piece', { piece: output('holder-ref', 'piece') }),
    {
      kind: 'record.create',
      id: 'record',
      schema: ATOMIC_RECALL_RECORD_SCHEMA.id,
      fields: {
        piece: output('holder-ref', 'piece'),
        pieceKey: output('piece-key', 'id'),
        owner: output('owner', 'player'),
        position: output('position', 'cell'),
        targetCount: output('selected', 'value'),
        actionCount: literal(0),
        snapshot: output('snapshot', 'snapshot'),
      },
    },
    call('declare-records', 'extension.map-declare', { player: output('owner', 'player') }, {
      namespace: 'content', name: 'recall-records', schema: ATOMIC_RECALL_RECORD_SCHEMA.id, keyField: 'pieceKey',
    }),
    call('put-record', 'extension.map-put', { player: output('owner', 'player'), item: output('record', 'value') }, {
      namespace: 'content', name: 'recall-records', schema: ATOMIC_RECALL_RECORD_SCHEMA.id, keyField: 'pieceKey',
    }),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [ATOMIC_RECALL_RECORD_SCHEMA, RECALL_OPTIONS_SCHEMA],
    outputs: [],
    body,
  }
}

function resolveRecallRecord(prefix: string, record: GameplayValue): GameplayStatement[] {
  const piece = output(`${prefix}-piece`, 'value')
  const position = output(`${prefix}-position`, 'value')
  const snapshot = output(`${prefix}-snapshot`, 'value')
  return [
    recordGet(`${prefix}-piece`, record, 'piece'),
    recordGet(`${prefix}-position`, record, 'position'),
    recordGet(`${prefix}-snapshot`, record, 'snapshot'),
    // Removing the record first makes the operation idempotent when restoring
    // position or instance information emits another observed event.
    call(`${prefix}-remove`, 'extension.map-remove', {
      player: output(`${prefix}-owner`, 'value'), item: record,
    }, {
      namespace: 'content', name: 'recall-records', schema: ATOMIC_RECALL_RECORD_SCHEMA.id, keyField: 'pieceKey',
    }),
    call(`${prefix}-move`, 'effect.displace-one', { piece, destination: position }, { kind: 'teleport' }),
    // Position and information restoration are deliberately independent.  A
    // blocked position request must not suppress application of the snapshot.
    call(`${prefix}-apply`, 'instance.apply-piece', { piece, snapshot }),
  ]
}

function recallTriggerBody(mode: 'endturn' | 'move' | 'skill'): GameplayStatement[] {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-owner', 'piece.owner', { piece: output('holder-ref', 'piece') }),
    call('event-player', 'ref.event-player'),
    call('records', 'extension.map-items', { player: output('holder-owner', 'player') }, {
      namespace: 'content', name: 'recall-records', schema: ATOMIC_RECALL_RECORD_SCHEMA.id, keyField: 'pieceKey',
    }),
  ]

  const perRecord: GameplayStatement[] = [
    recordGet('record-piece', input('record'), 'piece'),
    recordGet('record-owner', input('record'), 'owner'),
    call('same-piece', 'compare.equal-piece', { left: output('holder-ref', 'piece'), right: output('record-piece', 'value') }),
    expression(call('event-player-faction', 'attribute.player-text', { player: output('event-player', 'player') }, { attribute: 'faction' }), 'enemy-action', 'left'),
    expression(call('record-owner-faction', 'attribute.player-text', { player: output('record-owner', 'value') }, { attribute: 'faction' }), 'enemy-action', 'right'),
    call('enemy-action', 'compare.not-equal-string', { left: output('event-player-faction', 'text'), right: output('record-owner-faction', 'text') }),
    call('eligible', 'logic.and', { left: output('same-piece', 'value'), right: output('enemy-action', 'value') }),
  ]

  const restore = [
    recordGet('restore-owner', input('record'), 'owner'),
    ...resolveRecallRecord('restore', input('record')),
  ]

  if (mode === 'endturn') {
    perRecord.push({ kind: 'if', id: 'eligible-branch', condition: output('eligible', 'value'), then: restore })
  } else {
    perRecord.push(
      {
        kind: 'if',
        id: 'eligible-branch',
        condition: output('eligible', 'value'),
        then: [
          recordGet('action-count', input('record'), 'actionCount'),
          call('next-action-count', 'math.add', { left: output('action-count', 'value'), right: literal(1) }),
          recordWith('advanced-record', input('record'), { actionCount: output('next-action-count', 'value') }),
          recordGet('advanced-owner', output('advanced-record', 'value'), 'owner'),
          call('replace-record', 'extension.map-put', {
            player: output('advanced-owner', 'value'), item: output('advanced-record', 'value'),
          }, {
            namespace: 'content', name: 'recall-records', schema: ATOMIC_RECALL_RECORD_SCHEMA.id, keyField: 'pieceKey',
          }),
          recordGet('target-count', input('record'), 'targetCount'),
          call('ready', 'compare.greater-or-equal', { left: output('next-action-count', 'value'), right: output('target-count', 'value') }),
          { kind: 'if', id: 'ready-branch', condition: output('ready', 'value'), then: restore },
        ],
      },
    )
  }

  body.push({ kind: 'foreach', id: 'records-loop', items: output('records', 'items'), item: 'record', body: perRecord })
  body.push(triggerResult('done', literal(false)))
  return body
}

function buildRecallTriggerGraph(mode: 'endturn' | 'move' | 'skill'): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    schemas: [ATOMIC_RECALL_RECORD_SCHEMA],
    outputs: [{ name: 'success', type: 'boolean' }],
    body: recallTriggerBody(mode),
  }
}

function buildAtomicRecallGraphRaw(id: 'recall' | 'recall-endturn-trigger' | 'recall-move-trigger' | 'recall-skill-trigger'): GameplayModuleGraph {
  if (id === 'recall') return buildRecallSkillGraph()
  return buildRecallTriggerGraph(id === 'recall-endturn-trigger' ? 'endturn' : id === 'recall-move-trigger' ? 'move' : 'skill')
}

export function buildAtomicRecallGraph(id: 'recall' | 'recall-endturn-trigger' | 'recall-move-trigger' | 'recall-skill-trigger'): GameplayModuleGraph {
  return migrateAtomicAuthorGraph(buildAtomicRecallGraphRaw(id))
}

function buildAtomicFireballGraphRaw(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [{ name: 'result', type: 'record' }],
    body: [
      call('source', 'ref.holder'),
      call('target', 'author.choice.target-piece', {}, { range: 5, filter: 'enemy', title: '选择火球术目标', canCancel: true }),
      // Capture display names before damage, so a lethal hit can still report
      // its settled result without reading an already removed target.
      call('source-name', 'piece.field', { piece: output('source', 'piece') }, { field: 'name' }),
      call('target-name', 'piece.field', { piece: output('target', 'piece') }, { field: 'name' }),
      call('attack', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'attack' }),
      call('power', 'skill.power-multiplier'),
      call('amount', 'math.multiply', { left: output('attack', 'value'), right: output('power', 'value') }),
      call('damage', 'author.effect.damage', {
        source: output('source', 'piece'), target: output('target', 'piece'), amount: output('amount', 'value'),
      }, { damageType: 'normal', skillId: 'fireball' }),
      call('damage-text', 'text.from-number', { value: output('damage', 'damage') }),
      call('message-start', 'text.concat', { left: output('source-name'), right: literal('使用了火球术，对') }),
      call('message-target', 'text.concat', { left: output('message-start', 'text'), right: output('target-name') }),
      call('message-effect', 'text.concat', { left: output('message-target', 'text'), right: literal('造成') }),
      call('message-amount', 'text.concat', { left: output('message-effect', 'text'), right: output('damage-text', 'text') }),
      call('message', 'text.concat', { left: output('message-amount', 'text'), right: literal('点伤害') }),
      call('result', 'result.action', { success: literal(true), message: output('message', 'text') }),
      { kind: 'return', id: 'return-result', value: output('result', 'result') },
    ],
  }
}

export function buildAtomicFireballGraph(): GameplayModuleGraph {
  return migrateAtomicAuthorGraph(buildAtomicFireballGraphRaw())
}

function buildAtomicNarutoShadowCloneGraphRaw(): GameplayModuleGraph {
  const options: GameplayStatement = {
    kind: 'record.create',
    id: 'mode-options',
    schema: NARUTO_OPTIONS_SCHEMA.id,
    fields: {
      '在目标格召唤分身': literal('summon'),
      '传送至目标格，原地留下分身': literal('teleport'),
    },
  }
  const summon = [
    call('summon', 'lifecycle.queue-summon', {
      source: output('source', 'piece'), destination: output('target', 'cell'), variant: literal('summon'),
    }),
  ]
  const teleport: GameplayStatement[] = [
    call('move', 'effect.displace-one', { piece: output('source', 'piece'), destination: output('target', 'cell') }, { kind: 'teleport' }),
    {
      kind: 'if',
      id: 'teleport-success',
      condition: output('move', 'success'),
      then: [
        call('clone', 'lifecycle.queue-summon', {
          source: output('source', 'piece'), destination: output('origin', 'cell'), variant: literal('teleport'),
        }),
      ],
      else: [],
    },
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [NARUTO_OPTIONS_SCHEMA],
    outputs: [],
    body: [
      call('source', 'ref.holder'),
      options,
      call('mode', 'author.choice.option', { options: output('mode-options', 'value') }, {
        valueType: 'string', title: '选择影分身方式', canCancel: true,
      }),
      call('target', 'author.choice.target-cell', {}, {
        range: 5, filter: 'all', title: '选择影分身目标地格', canCancel: true,
      }),
      call('origin', 'spatial.piece-position', { piece: output('source', 'piece') }),
      call('is-teleport', 'compare.equal-string', { left: output('mode', 'value'), right: literal('teleport') }),
      {
        kind: 'if', id: 'mode-branch', condition: output('is-teleport', 'value'), then: teleport, else: summon,
      },
    ],
  }
}

function minatoLanding(prefix: string, target: GameplayValue): GameplayStatement[] {
  const cells = `${prefix}-adjacent`
  const reserved = `${prefix}-reserved`
  const available = `${prefix}-available`
  const landing = `${prefix}-landing`
  const options = `${prefix}-options`
  const choice = `${prefix}-choice`
  const choiceConfirmed = `${prefix}-choice-confirmed`
  const move = `${prefix}-move`
  const count = `${prefix}-count`
  const hasCells = `${prefix}-has-cells`
  const targetStatuses = `${prefix}-target-statuses`
  const targetStatusCount = `${prefix}-target-status-count`
  const targetHasStatus = `${prefix}-target-has-status`
  const targetStatus = `${prefix}-target-status`
  const sourceId = `${prefix}-source-id`
  const markId = `${prefix}-mark-id`
  const oldStatuses = `${prefix}-old-statuses`
  return [
    call(`${prefix}-position`, 'spatial.piece-position', { piece: target }),
    call(cells, 'spatial.adjacent-cells-ordered', { center: output(`${prefix}-position`, 'cell') }),
    call(reserved, 'event.reserved-cells'),
    {
      kind: 'collection', id: available, method: 'filter', items: output(cells, 'cells'),
      inputs: { reserved: output(reserved, 'cells') }, item: 'cell', body: [
        call(`${prefix}-legal`, 'spatial.cell-landing-legal', { cell: input('cell') }, { terrainPolicy: 'walkable' }),
        call(`${prefix}-reserved-hit`, 'spatial.cell-in-list', { cell: input('cell'), cells: input('reserved') }),
        call(`${prefix}-not-reserved`, 'logic.not', { value: output(`${prefix}-reserved-hit`, 'value') }),
        call(`${prefix}-valid`, 'logic.and', { left: output(`${prefix}-legal`, 'legal'), right: output(`${prefix}-not-reserved`, 'value') }),
        { kind: 'return', id: `${prefix}-available-return`, value: output(`${prefix}-valid`, 'value') },
      ],
    },
    call(count, 'collection.length', { items: output(available, 'value') }),
    call(hasCells, 'compare.greater-than', { left: output(count, 'value'), right: literal(0) }),
    {
      kind: 'if', id: `${prefix}-landing-branch`, condition: output(hasCells, 'value'), then: [
        {
          kind: 'record.create', id: options, schema: MINATO_OPTIONS_SCHEMA.id,
          fields: { '触发飞雷神': literal('yes'), '不触发': literal('no') },
        },
        call(choice, 'author.choice.option', { options: output(options, 'value'), cancelValue: literal('no') }, {
          valueType: 'string', title: '飞雷神触发', canCancel: true,
        }),
        call(choiceConfirmed, 'compare.equal-string', {
          left: output(choice, 'value'), right: literal('yes'),
        }),
        {
          kind: 'if', id: `${prefix}-choice-branch`, condition: output(choiceConfirmed, 'value'), then: [
            // Delay the random draw until the player confirms the trigger so
            // cancellation and "不触发" do not advance the match RNG.
            call(landing, 'query.random-cell', { items: output(available, 'value') }),
            call(move, 'effect.displace-one', { piece: output('minato', 'piece'), destination: output(landing, 'cell') }, { kind: 'teleport' }),
            {
              kind: 'if', id: `${prefix}-move-branch`, condition: output(move, 'success'), then: [
                call(`${prefix}-attack`, 'attribute.read', { piece: output('minato', 'piece') }, { attribute: 'attack' }),
                call(`${prefix}-damage`, 'author.effect.damage', {
                  source: output('minato', 'piece'), target, amount: output(`${prefix}-attack`, 'value'),
                }, { damageType: 'normal', skillId: 'minato-rasengan' }),
                call(`${prefix}-attack-up`, 'attribute.adjust', { piece: output('minato', 'piece'), amount: literal(1) }, { attribute: 'attack' }),
                call(targetStatuses, 'status.query-instances', { piece: target, source: output('minato', 'piece') }, {
                  statusType: 'flying-raijin-mark',
                }),
                call(targetStatusCount, 'collection.length', { items: output(targetStatuses, 'statuses') }),
                call(targetHasStatus, 'compare.greater-than', {
                  left: output(targetStatusCount, 'value'), right: literal(0),
                }),
                {
                  kind: 'if', id: `${prefix}-target-status-branch`, condition: output(targetHasStatus, 'value'), then: [
                    call(targetStatus, 'collection.at', {
                      items: output(targetStatuses, 'statuses'), position: literal(1),
                    }),
                    call(`${prefix}-read-stacks`, 'status.read-number-instance', {
                      status: output(targetStatus, 'value'), fallback: literal(1),
                    }, { field: 'stacks' }),
                    call(`${prefix}-empty-stacks`, 'compare.equal', {
                      left: output(`${prefix}-read-stacks`, 'value'), right: literal(0),
                    }),
                    call(`${prefix}-effective-stacks`, 'logic.select-number', {
                      condition: output(`${prefix}-empty-stacks`, 'value'), whenTrue: literal(1),
                      whenFalse: output(`${prefix}-read-stacks`, 'value'),
                    }),
                    call(`${prefix}-next-stacks`, 'math.add', {
                      left: output(`${prefix}-effective-stacks`, 'value'), right: literal(1),
                    }),
                    call(`${prefix}-write-stacks`, 'status.set-number-instance', {
                      status: output(targetStatus, 'value'), value: output(`${prefix}-next-stacks`, 'value'),
                    }, { field: 'stacks' }),
                    call(`${prefix}-write-duration`, 'status.set-number-instance', {
                      status: output(targetStatus, 'value'), value: literal(-1),
                    }, { field: 'currentDuration' }),
                  ], else: [
                    call(sourceId, 'piece.identifier', { piece: output('minato', 'piece') }),
                    call(markId, 'status.make-id', { target }, { prefix: 'flying-raijin-mark-' }),
                    {
                      kind: 'record.create', id: `${prefix}-mark-record`, schema: MINATO_MARK_SCHEMA.id,
                      fields: {
                        id: output(markId, 'id'),
                        type: literal('flying-raijin-mark'),
                        name: literal('飞雷神'),
                        visible: literal(true),
                        currentDuration: literal(-1),
                        currentUses: literal(-1),
                        intensity: literal(1),
                        stacks: literal(1),
                        sourceId: output(sourceId, 'id'),
                      },
                    },
                    call(`${prefix}-mark-target`, 'status.apply-record', {
                      target, record: output(`${prefix}-mark-record`, 'value'),
                    }, { inputPolicy: 'host' }),
                  ],
                },
                call(oldStatuses, 'status.query-instances', {
                  piece: output('marked', 'piece'), source: output('minato', 'piece'),
                }, { statusType: 'flying-raijin-mark' }),
                {
                  kind: 'foreach', id: `${prefix}-remove-old-statuses`,
                  items: output(oldStatuses, 'statuses'), item: 'status', body: [
                    call(`${prefix}-remove-mark`, 'status.remove-instance', {
                      status: output(`${prefix}-remove-old-statuses`, 'item'),
                    }),
                  ],
                },
              ],
              else: [],
            },
          ],
          else: [],
        },
      ],
    },
  ]
}

export function buildAtomicNarutoShadowCloneGraph(): GameplayModuleGraph {
  return migrateAtomicAuthorGraph(buildAtomicNarutoShadowCloneGraphRaw())
}

function buildAtomicMinatoFlyingRaijinRuleGraphRaw(): GameplayModuleGraph {
  const sourceBranch = minatoLanding('source-target', output('source', 'piece'))
  const markedBranch = minatoLanding('marked-target', output('marked', 'piece'))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [{ name: 'success', type: 'boolean' }],
    schemas: [MINATO_OPTIONS_SCHEMA, MINATO_MARK_SCHEMA],
    body: [
      call('minato', 'ref.holder'),
      call('source', 'ref.source'),
      call('marked', 'ref.target'),
      call('skill-id', 'event.skill-id'),
      call('spiral', 'compare.equal-string-nullable', { left: output('skill-id', 'value'), right: literal('minato-spiral-barrage') }),
      call('not-spiral', 'logic.not', { value: output('spiral', 'value') }),
      call('mark-instances', 'status.query-instances', {
        piece: output('marked', 'piece'), source: output('minato', 'piece'),
      }, { statusType: 'flying-raijin-mark' }),
      {
        kind: 'collection', id: 'active-mark-instances', method: 'filter',
        items: output('mark-instances', 'statuses'), item: 'status', body: [
          call('mark-stacks', 'status.read-number-instance', {
            status: input('status'), fallback: literal(1),
          }, { field: 'stacks' }),
          // The baseline treats an explicit zero as one, just like a missing
          // stack count. For finite counts, (stacks || 1) > 0 is stacks >= 0.
          call('mark-active', 'compare.greater-or-equal', {
            left: output('mark-stacks', 'value'), right: literal(0),
          }),
          { kind: 'return', id: 'active-mark-return', value: output('mark-active', 'value') },
        ],
      },
      call('mark-count', 'collection.length', { items: output('active-mark-instances', 'value') }),
      call('has-mark', 'compare.greater-than', {
        left: output('mark-count', 'value'), right: literal(0),
      }),
      call('eligible', 'logic.and', { left: output('not-spiral', 'value'), right: output('has-mark', 'value') }),
      {
        kind: 'if', id: 'eligible-branch', condition: output('eligible', 'value'), then: [
          expression(call('minato-faction', 'attribute.text', { piece: output('minato', 'piece') }, { attribute: 'faction' }, '2'), 'marked-ally', 'left'),
          expression(call('marked-faction', 'attribute.text', { piece: output('marked', 'piece') }, { attribute: 'faction' }, '2'), 'marked-ally', 'right'),
          call('marked-ally', 'compare.equal-string', { left: output('minato-faction', 'text'), right: output('marked-faction', 'text') }),
          {
            kind: 'if', id: 'marked-ally-branch', condition: output('marked-ally', 'value'), then: [
              expression(call('source-faction', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'faction' }, '2'), 'source-enemy', 'right'),
              call('source-enemy', 'compare.not-equal-string', { left: output('minato-faction', 'text'), right: output('source-faction', 'text') }),
              { kind: 'if', id: 'source-enemy-branch', condition: output('source-enemy', 'value'), then: sourceBranch },
            ], else: [
              call('marked-enemy', 'compare.not-equal-string', { left: output('minato-faction', 'text'), right: output('marked-faction', 'text') }),
              { kind: 'if', id: 'marked-enemy-branch', condition: output('marked-enemy', 'value'), then: markedBranch },
            ],
          },
        ],
      },
      triggerResult('done', literal(false)),
    ],
  }
}

export function buildAtomicMinatoFlyingRaijinRuleGraph(): GameplayModuleGraph {
  return migrateAtomicAuthorGraph(buildAtomicMinatoFlyingRaijinRuleGraphRaw())
}

export const ATOMIC_AUTHOR_SAMPLE_ENTRIES = [
  { id: 'skills/fireball', file: 'data/skills/fireball.json', field: 'code', build: buildAtomicFireballGraph },
  { id: 'skills/naruto-shadow-clone', file: 'data/skills/naruto-shadow-clone.json', field: 'code', build: buildAtomicNarutoShadowCloneGraph },
  { id: 'skills/recall', file: 'data/skills/recall.json', field: 'code', build: () => buildAtomicRecallGraph('recall') },
  { id: 'skills/recall-endturn-trigger', file: 'data/skills/recall-endturn-trigger.json', field: 'code', build: () => buildAtomicRecallGraph('recall-endturn-trigger') },
  { id: 'skills/recall-move-trigger', file: 'data/skills/recall-move-trigger.json', field: 'code', build: () => buildAtomicRecallGraph('recall-move-trigger') },
  { id: 'skills/recall-skill-trigger', file: 'data/skills/recall-skill-trigger.json', field: 'code', build: () => buildAtomicRecallGraph('recall-skill-trigger') },
  { id: 'skills/minato-flying-raijin-passive', file: 'data/skills/minato-flying-raijin-passive.json', field: 'code', build: (): GameplayModuleGraph => ({
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [], body: [],
  }) },
  { id: 'rules/rule-minato-flying-raijin-trigger', file: 'data/rules/rule-minato-flying-raijin-trigger.json', field: 'skillCode', build: buildAtomicMinatoFlyingRaijinRuleGraph },
] as const

export function buildAtomicAuthorSampleGraph(id: (typeof ATOMIC_AUTHOR_SAMPLE_ENTRIES)[number]['id']): GameplayModuleGraph {
  const entry = ATOMIC_AUTHOR_SAMPLE_ENTRIES.find(item => item.id === id)
  if (!entry) throw new Error(`unknown atomic author sample ${id}`)
  return entry.build()
}

const GENERATED_KEYS = new Set([
  'code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion',
  'contentGraphEntries', 'gameplayModules', 'cluster',
])

function assertCompatibility(current: Record<string, unknown>, baseline: Record<string, unknown>, id: string): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (GENERATED_KEYS.has(key)) continue
    if (JSON.stringify(current[key]) !== JSON.stringify(baseline[key])) throw new Error(`${id}: changed compatibility field ${key}`)
  }
}

function migrateOne(root: string, baseline: Record<string, unknown>, entry: (typeof ATOMIC_AUTHOR_SAMPLE_ENTRIES)[number], write: boolean): void {
  const file = path.join(root, entry.file)
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  const original = baseline[entry.id]
  if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error(`missing frozen fixture ${entry.id}`)
  assertCompatibility(current, original as Record<string, unknown>, entry.id)
  const next = applyGameplayModuleGraph(current, entry.build(), entry.field)
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

export function migrateAtomicAuthorSamples(root: string, write = false): void {
  const baselinePath = path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json')
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).entries as Record<string, unknown>
  for (const entry of ATOMIC_AUTHOR_SAMPLE_ENTRIES) migrateOne(root, baseline, entry, write)
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  migrateAtomicAuthorSamples(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--write'))
}

export { GAMEPLAY_MODULE_COMPILER_VERSION }
