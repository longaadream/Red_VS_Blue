import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayRecordSchema, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
import { assertContentGraphArtifact } from '../electron-editor/content-graph-document'
import { assertFrozenExecutable } from './semantic-migration-source'

export const SHISHIO_VELEN_COLT_RULE_IDS = [
  'rule-momentum-consume',
  'rule-shishio-burn-endturn',
  'rule-shishio-burn-move',
  'rule-shishio-combustion',
  'rule-shishio-execute-option',
  'rule-shishio-infinite-blade-recast',
  'rule-shishio-silence-burst',
  'rule-velen-death-cleanup',
  'rule-velen-delayed-effects',
  'rule-velen-fate-target',
  'rule-colt-big-stride',
  'rule-colt-zone-endturn',
] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const resultOutputs = [{ name: 'result', type: 'record' as const, nullable: true }]
const statusSchema: GameplayRecordSchema = {
  id: 'shishio-velen-colt-status@1', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string', optional: true },
    { name: 'visible', type: 'boolean', optional: true }, { name: 'sourceId', type: 'string', nullable: true, optional: true },
    { name: 'currentDuration', type: 'number', optional: true }, { name: 'remainingDuration', type: 'number', optional: true },
    { name: 'currentUses', type: 'number', optional: true }, { name: 'remainingUses', type: 'number', optional: true },
    { name: 'stacks', type: 'number', optional: true }, { name: 'intensity', type: 'number', optional: true },
    { name: 'dx', type: 'number', optional: true }, { name: 'dy', type: 'number', optional: true }, { name: 'damage', type: 'number', optional: true },
    { name: 'createdTurnNumber', type: 'number', optional: true }, { name: 'pathCells', type: { kind: 'list', element: 'cell' }, optional: true },
    { name: 'skillIds', type: { kind: 'list', element: 'string' }, optional: true },
    { name: 'relatedRules', type: { kind: 'list', element: 'string' }, optional: true },
  ],
}
const result = (id: string, success: GameplayValue, message: GameplayValue = literal('')): GameplayStatement[] => [call(id, 'result.action', { success, message }), { kind: 'return', id: `${id}-return`, value: out(id, 'result') }]
const failure = (id: string, message = ''): GameplayStatement[] => result(id, literal(false), literal(message))
const success = (id: string, message: GameplayValue = literal('')): GameplayStatement[] => result(id, literal(true), message)
const returnResult = (id: string, value: GameplayValue): GameplayStatement[] => [{ kind: 'return', id, value }]

function requireCondition(body: GameplayStatement[], id: string, condition: GameplayValue, message = ''): void {
  body.push(call(`${id}-not`, 'logic.not', { value: condition }), {
    kind: 'if', id, condition: out(`${id}-not`, 'value'), then: failure(`${id}-failure`, message),
  })
}

function holder(body: GameplayStatement[], message = ''): GameplayValue {
  body.push(call('holder-ref', 'ref.holder'), call('holder-exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  requireCondition(body, 'holder-check', out('holder-exists', 'exists'), message)
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }))
  return out('holder', 'piece')
}

function sourceSame(body: GameplayStatement[], piece: GameplayValue, message = ''): void {
  body.push(call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
  requireCondition(body, 'source-check', out('source-exists', 'exists'), message)
  body.push(call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('source-same', 'compare.equal-piece', { left: piece, right: out('source', 'piece') }))
  requireCondition(body, 'source-same-check', out('source-same', 'value'), message)
}

function targetFromContext(body: GameplayStatement[], message = ''): GameplayValue {
  body.push(call('target-ref', 'ref.target'), call('target-exists', 'query.has-piece', { pieceId: out('target-ref', 'piece') }))
  requireCondition(body, 'target-check', out('target-exists', 'exists'), message)
  body.push(call('target', 'query.piece', { pieceId: out('target-ref', 'piece') }))
  return out('target', 'piece')
}

function buildMomentumConsumeGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  sourceSame(body, piece)
  body.push(
    call('owner', 'piece.owner', { piece }),
    call('core-instance', 'status.find-instance', { piece }, { statusType: 'momentum-core' }),
    call('skill-id', 'event.read-string', { fallback: literal('') }, { field: 'skillId' }),
    call('has-skill', 'status.has-skill-instance', { status: out('core-instance', 'status'), skillId: out('skill-id', 'value') }),
  )
  requireCondition(body, 'skill-check', out('has-skill', 'value'))
  body.push(
    call('side-id', 'status.find-id', { piece }, { statusType: 'shadow-ride-sweep-side' }),
    call('shadow-sweep', 'compare.equal-string', { left: out('skill-id', 'value'), right: literal('shadow-ride-sweep') }),
    call('has-side', 'status.has-id', { piece, statusId: out('side-id', 'id') }),
    call('side-eligible', 'logic.and', { left: out('shadow-sweep', 'value'), right: out('has-side', 'value') }),
  )
  const sideCompletion = (prefix: string, sideMessage: GameplayValue): GameplayStatement[] => [
    call(`${prefix}-preserve`, 'status.has-piece', { piece }, { statusType: 'preserve-momentum' }),
    call(`${prefix}-name`, 'attribute.text', { piece }, { attribute: 'name' }),
    call(`${prefix}-skill-gains`, 'skill.boolean-flag', { skillId: out('skill-id', 'value') }, { field: 'momentumGainOnUse' }),
    {
      kind: 'if', id: `${prefix}-preserve-branch`, condition: out(`${prefix}-preserve`, 'value'), then: [
        call(`${prefix}-preserve-prefix`, 'text.concat', { left: out(`${prefix}-name`, 'text'), right: literal('保留了动能') }),
        call(`${prefix}-preserve-message`, 'text.concat', { left: out(`${prefix}-preserve-prefix`, 'text'), right: sideMessage }),
        ...success(`${prefix}-preserve-result`, out(`${prefix}-preserve-message`, 'text')),
      ], else: [
        {
          kind: 'if', id: `${prefix}-gain-branch`, condition: out(`${prefix}-skill-gains`, 'value'), then: [
            call(`${prefix}-gain-prefix`, 'text.concat', { left: out(`${prefix}-name`, 'text'), right: literal('获得了动能') }),
            call(`${prefix}-gain-message`, 'text.concat', { left: out(`${prefix}-gain-prefix`, 'text'), right: sideMessage }),
            ...success(`${prefix}-gain-result`, out(`${prefix}-gain-message`, 'text')),
          ], else: [
            call(`${prefix}-reset-core`, 'status.set-number-instance', { status: out('core-instance', 'status'), value: literal(0) }, { field: 'stacks' }),
            call(`${prefix}-reset-momentum`, 'attribute.set-momentum', { piece, value: literal(0) }),
            call(`${prefix}-side-without-comma`, 'text.strip-leading-comma', { text: sideMessage }),
            call(`${prefix}-reset-prefix`, 'text.concat', { left: out(`${prefix}-side-without-comma`, 'value'), right: literal('；') }),
            call(`${prefix}-reset-body`, 'text.concat', { left: out(`${prefix}-reset-prefix`, 'text'), right: out(`${prefix}-name`, 'text') }),
            call(`${prefix}-reset-message`, 'text.concat', { left: out(`${prefix}-reset-body`, 'text'), right: literal('的动能已重置') }),
            ...success(`${prefix}-reset-result`, out(`${prefix}-reset-message`, 'text')),
          ],
        },
      ],
    },
  ]

  body.push({
    kind: 'if', id: 'side-branch', condition: out('side-eligible', 'value'), then: [
      call('side-candidates', 'status.valid-side-cells', { piece, statusId: out('side-id', 'id') }),
      call('target-x-present', 'event.has-field', {}, { field: 'targetX' }),
      call('target-y-present', 'event.has-field', {}, { field: 'targetY' }),
      call('target-present', 'logic.and', { left: out('target-x-present', 'value'), right: out('target-y-present', 'value') }),
      {
        kind: 'if', id: 'side-target-branch', condition: out('target-present', 'value'), then: [
          call('target-x', 'event.read-number', { fallback: literal(0) }, { field: 'targetX' }),
          call('target-y', 'event.read-number', { fallback: literal(0) }, { field: 'targetY' }),
          call('target-cell', 'spatial.cell', { x: out('target-x', 'value'), y: out('target-y', 'value') }),
          call('left-cell', 'status.read-cell-field', { piece, statusId: out('side-id', 'id') }, { field: 'left' }),
          call('right-cell', 'status.read-cell-field', { piece, statusId: out('side-id', 'id') }, { field: 'right' }),
          call('left-match', 'spatial.cell-equal', { left: out('target-cell', 'cell'), right: out('left-cell', 'cell') }),
          call('right-match', 'spatial.cell-equal', { left: out('target-cell', 'cell'), right: out('right-cell', 'cell') }),
          call('valid-side', 'logic.or', { left: out('left-match', 'value'), right: out('right-match', 'value') }),
          {
            kind: 'if', id: 'valid-side-branch', condition: out('valid-side', 'value'), then: [
              call('side-name', 'value.select-text', { condition: out('left-match', 'value'), whenTrue: literal('left'), whenFalse: literal('right') }),
              call('side-label', 'value.select-text', { condition: out('left-match', 'value'), whenTrue: literal('左侧'), whenFalse: literal('右侧') }),
              call('dx', 'status.read-number-field', { piece, statusId: out('side-id', 'id'), fallback: literal(0) }, { field: 'dx' }),
              call('dy', 'status.read-number-field', { piece, statusId: out('side-id', 'id'), fallback: literal(0) }, { field: 'dy' }),
              call('direction', 'spatial.perpendicular-direction', { dx: out('dx', 'value'), dy: out('dy', 'value'), side: out('side-name', 'text') }),
              call('path-cells', 'status.read-cell-list', { piece, statusId: out('side-id', 'id') }, { field: 'pathCells' }),
              call('side-damage', 'status.read-number-field', { piece, statusId: out('side-id', 'id'), fallback: literal(5) }, { field: 'damage' }),
              call('hit-messages', 'collection.text-list-create'),
              { kind: 'foreach', id: 'side-ray-origins', items: out('path-cells', 'cells'), item: 'origin', index: 'origin-index', body: [
                call('events', 'projectile.events-from-cell-bounded', { origin: input('origin'), direction: out('direction', 'direction') }, { maxDistance: 128, stopAtBlockingTerrain: true }),
                { kind: 'foreach', id: 'side-ray-events', items: out('events', 'events'), item: 'event', index: 'event-index', body: [
                  call('kind', 'projectile.event-kind', { event: input('event') }),
                  call('is-piece', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('piece') }),
                  { kind: 'if', id: 'side-piece-event', condition: out('is-piece', 'value'), then: [
                    call('target', 'projectile.event-piece', { event: input('event') }),
                    call('alive', 'piece.alive', { piece: out('target', 'piece') }),
                    call('enemy', 'query.same-relation', { source: piece, target: out('target', 'piece') }, { relation: 'enemy' }),
                    call('valid-hit-a', 'logic.and', { left: out('alive', 'alive'), right: out('enemy', 'value') }),
                    { kind: 'if', id: 'side-hit-event', condition: out('valid-hit-a', 'value'), then: [
                      call('damage', 'effect.damage', { source: piece, target: out('target', 'piece'), amount: out('side-damage', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'shadow-ride-sweep', inputPolicy: 'host' }),
                      call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
                      call('damage-text', 'text.from-number', { value: out('damage', 'damage') }),
                      call('hit-text-0', 'text.concat', { left: out('target-name', 'text'), right: literal('(-') }),
                      call('hit-text-1', 'text.concat', { left: out('hit-text-0', 'text'), right: out('damage-text', 'text') }),
                      call('hit-text', 'text.concat', { left: out('hit-text-1', 'text'), right: literal(')') }),
                      call('append-hit', 'collection.text-list-add', { items: out('hit-messages', 'items'), value: out('hit-text', 'text') }),
                    ] },
                  ] },
                ] },
              ] },
              call('hit-names', 'text.join-list', { items: out('hit-messages', 'items') }, { separator: '、' }),
              call('hit-count', 'list.count', { items: out('hit-messages', 'items') }),
              call('has-hits', 'compare.greater-than', { left: out('hit-count', 'count'), right: literal(0) }),
              call('hit-fragment', 'text.optional-fragment', { condition: out('has-hits', 'value'), value: out('hit-names', 'text') }, { prefix: '命中', suffix: '' }),
              call('side-prefix', 'text.concat', { left: literal('，按本次冲刺方向垂直射击'), right: out('side-label', 'text') }),
              call('side-message', 'text.concat', { left: out('side-prefix', 'text'), right: out('hit-fragment', 'text') }),
              ...sideCompletion('side-hit', out('side-message', 'text')),
            ], else: failure('invalid-side-result', '骑射横扫必须选择冲刺终点左侧或右侧的相邻地格'),
          },
        ], else: [
          call('candidate-count', 'list.count-cells', { items: out('side-candidates', 'cells') }),
          call('candidate-present', 'compare.greater-than', { left: out('candidate-count', 'value'), right: literal(0) }),
          {
            kind: 'if', id: 'candidate-branch', condition: out('candidate-present', 'value'), then: [
              call('choice-result', 'choice.grid-candidates', { player: out('owner', 'player'), candidates: out('side-candidates', 'cells') }, { title: '骑射横扫：选择冲刺方向左侧或右侧地格', canCancel: true, resumeOnCancel: false }),
              ...returnResult('side-choice-return', out('choice-result', 'result')),
            ], else: [
              call('remove-side', 'status.remove-record', { piece, value: out('side-id', 'id') }, { selector: 'id' }),
              ...sideCompletion('side-empty', literal('，侧射方向没有可选地格')),
            ],
          },
        ],
      },
    ], else: [],
  })
  body.push(
    call('has-preserve', 'status.has-piece', { piece }, { statusType: 'preserve-momentum' }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('skill-gains', 'skill.boolean-flag', { skillId: out('skill-id', 'value') }, { field: 'momentumGainOnUse' }),
  )
  body.push({ kind: 'if', id: 'preserve-branch', condition: out('has-preserve', 'value'), then: success('preserve-result', out('name', 'text')), else: [
    { kind: 'if', id: 'gain-branch', condition: out('skill-gains', 'value'), then: success('gain-result', out('name', 'text')), else: [
      call('reset-core', 'status.set-number-instance', { status: out('core-instance', 'status'), value: literal(0) }, { field: 'stacks' }),
      call('reset-momentum', 'attribute.set-momentum', { piece, value: literal(0) }),
      call('reset-message', 'text.concat', { left: out('name', 'text'), right: literal('的动能已重置') }),
      ...success('reset-result', out('reset-message', 'text')),
    ],
    },
  ] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildShishioBurnEndturnGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  body.push(
    call('event-player', 'ref.player'),
    call('shishio', 'piece.by-template', { owner: out('event-player', 'player') }, { templateId: 'red-shishio', alive: true }),
    call('shishio-present', 'piece.reference-present', { piece: out('shishio', 'piece') }),
  )
  requireCondition(body, 'shishio-check', out('shishio-present', 'value'))
  body.push(
    call('shishio-required', 'piece.require', { piece: out('shishio', 'piece') }),
    call('burn-records', 'extension.read-list', {}, { key: 'shishioBurnTiles' }),
    call('burn-cells', 'extension.cells-for-source', { cells: out('burn-records', 'cells'), source: out('shishio-required', 'piece') }),
    call('on-burn', 'query.pieces-on-cells-all', { cells: out('burn-cells', 'cells') }, { relation: 'all' }),
    call('messages', 'collection.text-list-create'),
    { kind: 'foreach', id: 'burn-loop', items: out('on-burn', 'pieces'), item: 'target', index: 'index', body: [
      call('hp', 'attribute.read', { piece: input('target') }, { attribute: 'currentHp' }),
      call('raw-damage', 'math.multiply', { left: out('hp', 'value'), right: literal(0.5) }),
      call('damage-amount', 'math.floor', { value: out('raw-damage', 'value') }),
      call('damage', 'effect.damage', { source: out('shishio-required', 'piece'), target: input('target'), amount: out('damage-amount', 'value') }, { damageType: 'true', skillId: 'shishio-burn-endturn', inputPolicy: 'host' }),
      call('target-name', 'attribute.text', { piece: input('target') }, { attribute: 'name' }),
      call('damage-text', 'text.from-number', { value: out('damage-amount', 'value') }),
      call('message-0', 'text.concat', { left: out('target-name', 'text'), right: literal(' 被燃地炙烤，失去 ') }),
      call('message-1', 'text.concat', { left: out('message-0', 'text'), right: out('damage-text', 'text') }),
      call('target-message', 'text.concat', { left: out('message-1', 'text'), right: literal(' 点真实伤害（当前生命值50%）') }),
      call('append', 'collection.text-list-add', { items: out('messages', 'items'), value: out('target-message', 'text') }),
    ] },
    call('message', 'text.join-list', { items: out('messages', 'items') }, { separator: '；' }),
    call('count', 'list.count', { items: out('messages', 'items') }),
    call('has-damage', 'compare.greater-than', { left: out('count', 'count'), right: literal(0) }),
  )
  body.push({ kind: 'if', id: 'burn-end-result', condition: out('has-damage', 'value'), then: success('burn-end-success', out('message', 'text')), else: failure('burn-end-failure') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildShishioCombustionGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  sourceSame(body, piece)
  const target = targetFromContext(body)
  body.push(
    call('not-self', 'compare.not-equal-piece', { left: piece, right: target }),
  )
  requireCondition(body, 'not-self-check', out('not-self', 'value'))
  body.push(
    call('skill-id', 'event.read-string', { fallback: literal('') }, { field: 'skillId' }),
    call('is-burn-end', 'compare.equal-string', { left: out('skill-id', 'value'), right: literal('shishio-burn-endturn') }),
    call('is-burn-move', 'compare.equal-string', { left: out('skill-id', 'value'), right: literal('shishio-burn-move') }),
    call('is-self', 'compare.equal-string', { left: out('skill-id', 'value'), right: literal('combustion-self') }),
    call('excluded-a', 'logic.or', { left: out('is-burn-end', 'value'), right: out('is-burn-move', 'value') }),
    call('excluded', 'logic.or', { left: out('excluded-a', 'value'), right: out('is-self', 'value') }),
    call('allowed', 'logic.not', { value: out('excluded', 'value') }),
  )
  requireCondition(body, 'skill-check', out('allowed', 'value'))
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  requireCondition(body, 'damage-check', out('positive', 'value'))
  body.push(call('counter-id', 'status.find-id', { piece }, { statusType: 'shishio-dmg-counter' }), call('counter-present', 'status.has-id', { piece, statusId: out('counter-id', 'id') }))
  body.push({ kind: 'if', id: 'counter-create', condition: out('counter-present', 'value'), then: [], else: [
    call('piece-id', 'piece.identifier', { piece }),
    call('new-id', 'text.concat', { left: literal('shishio-dmg-counter-'), right: out('piece-id', 'id') }),
    { kind: 'record.create', id: 'counter-record', schema: 'shishio-velen-colt-status@1', fields: {
      id: out('new-id', 'text'), type: literal('shishio-dmg-counter'), name: literal('灵力消耗'), intensity: literal(0), currentDuration: literal(-1), visible: literal(false),
    } },
    call('append', 'status.append-record', { target: piece, record: out('counter-record', 'value') }),
  ] })
  body.push(
    call('counter-id-after', 'status.find-id', { piece }, { statusType: 'shishio-dmg-counter' }),
    call('previous', 'status.read-number-field', { piece, statusId: out('counter-id-after', 'id'), fallback: literal(0) }, { field: 'intensity' }),
    call('total', 'math.add', { left: out('previous', 'value'), right: out('damage', 'value') }),
    call('times-raw', 'math.divide', { left: out('total', 'value'), right: literal(5) }),
    call('times', 'math.floor', { value: out('times-raw', 'value') }),
    call('remaining', 'math.modulo', { left: out('total', 'value'), right: literal(5) }),
    call('save', 'status.set-number', { piece, statusId: out('counter-id-after', 'id'), value: out('remaining', 'value') }, { field: 'intensity' }),
    call('has-times', 'compare.greater-than', { left: out('times', 'value'), right: literal(0) }),
  )
  body.push({ kind: 'if', id: 'combustion-trigger', condition: out('has-times', 'value'), then: [
    call('queue', 'effect.queue-damage', { attacker: piece, target: piece, amount: out('times', 'value') }, { damageType: 'true', skillId: 'combustion-self' }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('previous-text', 'text.from-number', { value: out('previous', 'value') }),
    call('damage-text', 'text.from-number', { value: out('damage', 'value') }),
    call('total-text', 'text.from-number', { value: out('total', 'value') }),
    call('times-text', 'text.from-number', { value: out('times', 'value') }),
    call('remaining-text', 'text.from-number', { value: out('remaining', 'value') }),
    call('message-0', 'text.concat', { left: out('name', 'text'), right: literal(' 自燃·灵力消耗：计数 ') }),
    call('message-1', 'text.concat', { left: out('message-0', 'text'), right: out('previous-text', 'text') }),
    call('message-2', 'text.concat', { left: out('message-1', 'text'), right: literal('+') }),
    call('message-3', 'text.concat', { left: out('message-2', 'text'), right: out('damage-text', 'text') }),
    call('message-4', 'text.concat', { left: out('message-3', 'text'), right: literal('=') }),
    call('message-5', 'text.concat', { left: out('message-4', 'text'), right: out('total-text', 'text') }),
    call('message-6', 'text.concat', { left: out('message-5', 'text'), right: literal('，触发') }),
    call('message-7', 'text.concat', { left: out('message-6', 'text'), right: out('times-text', 'text') }),
    call('message-8', 'text.concat', { left: out('message-7', 'text'), right: literal('次，') }),
    call('message-9', 'text.concat', { left: out('message-8', 'text'), right: out('name', 'text') }),
    call('message-10', 'text.concat', { left: out('message-9', 'text'), right: literal(' 失去 ') }),
    call('message-11', 'text.concat', { left: out('message-10', 'text'), right: out('times-text', 'text') }),
    call('message-12', 'text.concat', { left: out('message-11', 'text'), right: literal(' 点生命值（剩余计数：') }),
    call('message-13', 'text.concat', { left: out('message-12', 'text'), right: out('remaining-text', 'text') }),
    call('message', 'text.concat', { left: out('message-13', 'text'), right: literal('）') }),
    ...success('combustion-success', out('message', 'text')),
  ], else: failure('combustion-no-trigger') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildShishioExecuteGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  sourceSame(body, piece)
  const target = targetFromContext(body)
  body.push(call('not-self', 'compare.not-equal-piece', { left: piece, right: target }))
  requireCondition(body, 'not-self-check', out('not-self', 'value'))
  body.push(call('target-alive', 'piece.alive', { piece: target }))
  requireCondition(body, 'target-alive-check', out('target-alive', 'alive'))
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('target-hp', 'attribute.read', { piece: target }, { attribute: 'currentHp' }), call('overkill', 'compare.greater-than', { left: out('damage', 'value'), right: out('target-hp', 'value') }))
  requireCondition(body, 'overkill-check', out('overkill', 'value'))
  body.push(
    call('choice', 'choice.option-pair-cancel', {}, {
      title: '自燃·灭杀', firstLabel: '立即出局', firstValue: 'execute', firstDescription: '目标立即出局，不增加充能点',
      secondLabel: '正常造成伤害', secondValue: 'normal', secondDescription: '正常造成伤害', cancelValue: 'normal',
    }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
  )
  body.push({ kind: 'if', id: 'choice-pending', condition: out('unresolved', 'value'), then: [call('choice-result', 'choice.as-result', { choice: out('choice', 'choice') }), ...returnResult('choice-return', out('choice-result', 'result'))], else: [
    call('selected', 'choice.option-selected', { choice: out('choice', 'choice') }),
    call('execute', 'compare.equal-string', { left: out('selected', 'value'), right: literal('execute') }),
    {
      kind: 'if', id: 'execute-branch', condition: out('execute', 'value'), then: [
        call('defeat', 'effect.force-defeat', { target }),
        call('name', 'attribute.text', { piece }, { attribute: 'name' }),
        call('target-name', 'attribute.text', { piece: target }, { attribute: 'name' }),
        call('message-prefix', 'text.concat', { left: out('name', 'text'), right: literal(' 自燃·灭杀：') }),
        call('message-body', 'text.concat', { left: out('message-prefix', 'text'), right: out('target-name', 'text') }),
        call('message', 'text.concat', { left: out('message-body', 'text'), right: literal(' 立即出局！（不增加充能）') }),
        call('blocked', 'result.blocked', { message: out('message', 'text') }),
        ...returnResult('blocked-return', out('blocked', 'result')),
      ], else: failure('normal-result'),
    },
  ] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildShishioRecastGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  sourceSame(body, piece)
  body.push(call('owner', 'piece.owner', { piece }), call('alive', 'piece.alive', { piece }))
  requireCondition(body, 'alive-check', out('alive', 'alive'))
  body.push(call('skill-id', 'event.read-string', { fallback: literal('') }, { field: 'skillId' }), call('is-recast', 'compare.equal-string', { left: out('skill-id', 'value'), right: literal('shishio-infinite-blade') }))
  requireCondition(body, 'skill-check', out('is-recast', 'value'))
  body.push(call('target-ref', 'ref.target'), call('target-present', 'piece.reference-present', { piece: out('target-ref', 'piece') }))
  body.push({ kind: 'if', id: 'target-choice-branch', condition: out('target-present', 'value'), then: [
    call('target-exists', 'query.has-piece', { pieceId: out('target-ref', 'piece') }),
    call('target-exists-not', 'logic.not', { value: out('target-exists', 'exists') }),
    { kind: 'if', id: 'target-exists-check', condition: out('target-exists-not', 'value'), then: failure('target-exists-failure') },
    call('target', 'query.piece', { pieceId: out('target-ref', 'piece') }),
    call('target-alive', 'piece.alive', { piece: out('target', 'piece') }),
    call('enemy', 'query.same-relation', { source: piece, target: out('target', 'piece') }, { relation: 'enemy' }),
    call('distance', 'query.distance', { from: piece, to: out('target', 'piece') }),
    call('near', 'compare.less-or-equal', { left: out('distance', 'distance'), right: literal(2) }),
    call('valid-target-a', 'logic.and', { left: out('target-alive', 'alive'), right: out('enemy', 'value') }),
    call('valid-target', 'logic.and', { left: out('valid-target-a', 'value'), right: out('near', 'value') }),
    { kind: 'if', id: 'target-valid-branch', condition: out('valid-target', 'value'), then: recastDamageBody(piece, out('target', 'piece')), else: failure('target-invalid', '无限刃二段目标已失效') },
  ], else: [
    call('candidates', 'query.pieces-in-square', { origin: piece }, { relation: 'enemy', halfExtent: 2 }),
    call('candidate-count', 'list.count-pieces', { items: out('candidates', 'pieces') }),
    call('has-candidates', 'compare.greater-than', { left: out('candidate-count', 'value'), right: literal(0) }),
    { kind: 'if', id: 'candidate-check', condition: out('has-candidates', 'value'), then: [
      call('choice-result', 'choice.piece-candidates', { player: out('owner', 'player'), pieces: out('candidates', 'pieces') }, { title: '无限刃：选择二段目标（无需额外行动点）' }),
      ...returnResult('target-choice-return', out('choice-result', 'result')),
    ], else: failure('no-candidates') },
  ] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildShishioSilenceGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  sourceSame(body, piece)
  const target = targetFromContext(body)
  body.push(call('not-self', 'compare.not-equal-piece', { left: piece, right: target }))
  requireCondition(body, 'not-self-check', out('not-self', 'value'))
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('strong', 'compare.greater-or-equal', { left: out('damage', 'value'), right: literal(8) }))
  requireCondition(body, 'damage-check', out('strong', 'value'))
  body.push(call('target-alive', 'piece.alive', { piece: target }))
  requireCondition(body, 'target-alive-check', out('target-alive', 'alive'))
  body.push(
    call('target-id', 'piece.identifier', { piece: target }),
    call('status-id', 'text.concat', { left: literal('silenced-'), right: out('target-id', 'id') }),
    { kind: 'record.create', id: 'silence-record', schema: 'shishio-velen-colt-status@1', fields: {
      id: out('status-id', 'text'), type: literal('silenced'), name: literal('沉默'), visible: literal(true),
      remainingDuration: literal(1), remainingUses: literal(-1), intensity: literal(1), stacks: literal(1), relatedRules: literal(['rule-silenced-block']),
    } },
    call('apply', 'status.apply-record', { target, record: out('silence-record', 'value') }, { inputPolicy: 'host' }),
    call('rule', 'rule.apply-piece', { target }, { ruleId: 'rule-silenced-block' }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: target }, { attribute: 'name' }),
    call('damage-text', 'text.from-number', { value: out('damage', 'value') }),
    call('m0', 'text.concat', { left: out('name', 'text'), right: literal(' 自燃·灼魂：对 ') }),
    call('m1', 'text.concat', { left: out('m0', 'text'), right: out('target-name', 'text') }),
    call('m2', 'text.concat', { left: out('m1', 'text'), right: literal(' 造成 ') }),
    call('m3', 'text.concat', { left: out('m2', 'text'), right: out('damage-text', 'text') }),
    call('m4', 'text.concat', { left: out('m3', 'text'), right: literal(' 点伤害，灼烧其灵魂！') }),
    call('message', 'text.concat', { left: out('m4', 'text'), right: out('target-name', 'text') }),
    call('final', 'text.concat', { left: out('message', 'text'), right: literal(' 被沉默 1 回合') }),
  )
  body.push(...success('silence-success', out('final', 'text')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildVelenFateTargetGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  sourceSame(body, piece)
  body.push(
    call('removed', 'status.remove-type-raw', { piece }, { statusType: 'velen-fate-shelter' }),
    call('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-velen-fate-target' }),
    call('changed', 'compare.greater-than', { left: out('removed', 'count'), right: literal(0) }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('suffix', 'value.select-text', { condition: out('changed', 'value'), whenTrue: literal('死亡，命运庇护未能完成'), whenFalse: literal('') }),
    call('message', 'text.concat', { left: out('name', 'text'), right: out('suffix', 'text') }),
  )
  // The frozen rule reports success=false with an empty message when it found
  // no shelter.  Keep the status cleanup result independent from that text.
  body.push({ kind: 'if', id: 'fate-result', condition: out('changed', 'value'), then: success('fate-success', out('message', 'text')), else: failure('fate-empty') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildVelenDeathCleanupGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  sourceSame(body, piece)
  body.push(
    call('removed-counter', 'local.counter-create', { initial: literal(0) }),
    call('all-pieces', 'query.all-pieces'),
    { kind: 'foreach', id: 'cleanup-loop', items: out('all-pieces', 'pieces'), item: 'target', index: 'index', body: [
      call('remove-shelter', 'status.remove-source-type-raw', { target: input('target'), source: piece }, { statusType: 'velen-fate-shelter' }),
      call('count-removed', 'local.counter-add', { counter: out('removed-counter', 'counter'), amount: out('remove-shelter', 'count') }),
      call('removed-shelter', 'compare.greater-than', { left: out('remove-shelter', 'count'), right: literal(0) }),
      { kind: 'if', id: 'remove-owned-shelter-rule', condition: out('removed-shelter', 'value'), then: [
        call('remove-rule', 'rule.remove-id-raw', { target: input('target') }, { ruleId: 'rule-velen-fate-target' }),
      ] },
    ] },
    call('removed-total', 'local.counter-read', { counter: out('removed-counter', 'counter') }),
    call('has-shelter', 'compare.greater-than', { left: out('removed-total', 'value'), right: literal(0) }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('count-text', 'text.from-number', { value: out('removed-total', 'value') }),
    call('m0', 'text.concat', { left: out('name', 'text'), right: literal('死亡，') }),
    call('m1', 'text.concat', { left: out('m0', 'text'), right: out('count-text', 'text') }),
    call('message', 'text.concat', { left: out('m1', 'text'), right: literal('个命运庇护消散') }),
  )
  body.push({ kind: 'if', id: 'cleanup-result', condition: out('has-shelter', 'value'), then: success('cleanup-success', out('message', 'text')), else: failure('cleanup-empty') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildVelenDelayedEffectsGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  body.push(call('holder-ref', 'ref.holder'), call('holder-present', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }), call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }))
  const piece = out('holder', 'piece')
  const pieceBody: GameplayStatement[] = []
  pieceBody.push(call('alive', 'piece.alive', { piece }), call('owner', 'piece.owner', { piece }), call('event-player', 'ref.event-player'), call('owner-match', 'compare.player-reference', { left: out('owner', 'player'), right: out('event-player', 'player') }))
  pieceBody.push(call('eligible-a', 'logic.and', { left: out('alive', 'alive'), right: out('owner-match', 'value') }))
  requireCondition(pieceBody, 'eligible-check', out('eligible-a', 'value'))
  pieceBody.push(call('turn', 'turn.number'), call('prophecies', 'card.find-content-records', { player: out('owner', 'player'), source: piece, turn: out('turn', 'value') }, { field: 'velenHolyProphecy' }), call('completed-counter', 'local.counter-create', { initial: literal(0) }))
  pieceBody.push({ kind: 'foreach', id: 'prophecy-loop', items: out('prophecies', 'cards'), item: 'card', index: 'index', body: [
    call('enhance-flag', 'card.set-content-boolean', { player: out('owner', 'player'), card: input('card') }, { field: 'velenHolyProphecyEnhanced' }),
    call('clear-prophecy', 'card.clear-content-field', { player: out('owner', 'player'), card: input('card') }, { field: 'velenHolyProphecy' }),
    call('card-id', 'card.read-definition-id', { player: out('owner', 'player'), card: input('card') }),
    call('is-smite', 'compare.equal-string', { left: out('card-id', 'cardId'), right: literal('holy-smite') }),
    call('is-heal', 'compare.equal-string', { left: out('card-id', 'cardId'), right: literal('holy-heal') }),
    call('is-charge', 'compare.equal-string', { left: out('card-id', 'cardId'), right: literal('holy-charge') }),
    {
      kind: 'if', id: 'smite-enhancement', condition: out('is-smite', 'value'), then: [
        call('smite-modifier', 'card.set-effect-modifier', { player: out('owner', 'player'), card: input('card') }, { effect: 'damage', operation: 'multiply', value: 1.5 }),
        call('smite-presentation', 'card.set-presentation', { player: out('owner', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：对敌方生命值最低的棋子造成7点真实伤害。' }),
      ], else: [
        {
          kind: 'if', id: 'heal-enhancement', condition: out('is-heal', 'value'), then: [
            call('heal-modifier', 'card.set-effect-modifier', { player: out('owner', 'player'), card: input('card') }, { effect: 'heal', operation: 'multiply', value: 1.5 }),
            call('heal-presentation', 'card.set-presentation', { player: out('owner', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：治疗己方生命值最低的棋子12点生命。' }),
          ], else: [
            {
              kind: 'if', id: 'charge-enhancement', condition: out('is-charge', 'value'), then: [
                call('charge-modifier', 'card.set-effect-modifier', { player: out('owner', 'player'), card: input('card') }, { effect: 'statusIntensity', operation: 'multiply', value: 1.5, statusType: 'damage-buff' }),
                call('charge-presentation', 'card.set-presentation', { player: out('owner', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：使己方所有棋子下次造成的伤害提高3点。' }),
              ], else: [],
            },
          ],
        },
      ],
    },
    call('one', 'local.counter-add', { counter: out('completed-counter', 'counter'), amount: literal(1) }),
  ] })
  pieceBody.push(call('allies', 'query.pieces', { originId: piece }, { relation: 'ally', includeDead: false }))
  pieceBody.push({ kind: 'collection', id: 'sheltered', method: 'filter', items: out('allies', 'pieces'), item: 'target', inputs: { source: piece, turn: out('turn', 'value') }, body: [
    call('shelter-id', 'status.find-source-before-id', { piece: input('target'), source: input('source'), turn: input('turn') }, { statusType: 'velen-fate-shelter' }),
    call('has-shelter', 'value.present-string', { value: out('shelter-id', 'id') }),
    { kind: 'return', id: 'shelter-return', value: out('has-shelter', 'present') },
  ] })
  pieceBody.push({ kind: 'foreach', id: 'shelter-loop', items: out('sheltered', 'value'), item: 'target', index: 'index', body: [
    call('shelter-id-apply', 'status.find-source-before-id', { piece: input('target'), source: piece, turn: out('turn', 'value') }, { statusType: 'velen-fate-shelter' }),
    call('heal', 'effect.heal', { source: piece, target: input('target'), amount: literal(8) }, { skillId: 'velen-fate-shelter' }),
    call('shield-id', 'status.find-id', { piece: input('target') }, { statusType: 'divine-shield' }),
    call('has-shield', 'status.has-id', { piece: input('target'), statusId: out('shield-id', 'id') }),
    call('not-shield', 'logic.not', { value: out('has-shield', 'value') }),
    { kind: 'if', id: 'shield-branch', condition: out('not-shield', 'value'), then: [
      { kind: 'record.create', id: 'shield-record', schema: 'shishio-velen-colt-status@1', fields: {
        id: literal('divine-shield'), type: literal('divine-shield'), name: literal('圣盾'), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1), relatedRules: literal(['rule-divine-shield']),
      } },
      call('apply-shield', 'status.apply-record', { target: input('target'), record: out('shield-record', 'value') }, { inputPolicy: 'host' }),
      call('apply-shield-rule', 'rule.apply-piece', { target: input('target') }, { ruleId: 'rule-divine-shield' }),
    ] },
    call('remove-shelter', 'status.remove-record', { piece: input('target'), value: out('shelter-id-apply', 'id') }, { selector: 'id' }),
    call('remove-shelter-rule', 'rule.remove-piece', { target: input('target') }, { ruleId: 'rule-velen-fate-target' }),
  ] })
  pieceBody.push(
    call('completed', 'local.counter-read', { counter: out('completed-counter', 'counter') }),
    call('sheltered-count', 'list.count-pieces', { items: out('sheltered', 'value') }),
    call('any-completed', 'compare.greater-than', { left: out('completed', 'value'), right: literal(0) }),
    call('any-sheltered', 'compare.greater-than', { left: out('sheltered-count', 'value'), right: literal(0) }),
    call('any', 'logic.or', { left: out('any-completed', 'value'), right: out('any-sheltered', 'value') }),
  )
  requireCondition(pieceBody, 'anything-check', out('any', 'value'))
  pieceBody.push(
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('completed-text', 'text.from-number', { value: out('completed', 'value') }),
    call('completed-part', 'text.concat', { left: out('completed-text', 'text'), right: literal('张圣光手牌完成预言') }),
    call('completed-optional', 'text.optional-fragment', { condition: out('any-completed', 'value'), value: out('completed-part', 'text') }, { prefix: '', suffix: '' }),
    call('names', 'query.piece-names', { pieces: out('sheltered', 'value') }),
    call('names-text', 'text.join-list', { items: out('names', 'names') }, { separator: '、' }),
    call('sheltered-part', 'text.concat', { left: out('names-text', 'text'), right: literal('完成命运庇护') }),
    call('sheltered-optional', 'text.optional-fragment', { condition: out('any-sheltered', 'value'), value: out('sheltered-part', 'text') }, { prefix: '', suffix: '' }),
    call('has-both', 'logic.and', { left: out('any-completed', 'value'), right: out('any-sheltered', 'value') }),
    call('separator', 'text.optional-fragment', { condition: out('has-both', 'value'), value: out('sheltered-optional', 'text') }, { prefix: '；', suffix: '' }),
    call('parts', 'text.concat', { left: out('completed-optional', 'text'), right: out('separator', 'text') }),
    call('parts-only-shelter', 'text.concat', { left: literal(''), right: out('sheltered-optional', 'text') }),
    call('parts-selected', 'value.select-text', { condition: out('any-completed', 'value'), whenTrue: out('parts', 'text'), whenFalse: out('parts-only-shelter', 'text') }),
    call('prefix', 'text.concat', { left: out('name', 'text'), right: literal('：') }),
    call('message', 'text.concat', { left: out('prefix', 'text'), right: out('parts-selected', 'text') }),
  )
  pieceBody.push(...success('delayed-success', out('message', 'text')))

  const playerBody: GameplayStatement[] = []
  playerBody.push(
    call('player', 'ref.player'),
    call('player-event', 'ref.event-player'),
    call('player-match', 'compare.player-reference', { left: out('player', 'player'), right: out('player-event', 'player') }),
  )
  requireCondition(playerBody, 'player-match-check', out('player-match', 'value'))
  playerBody.push(
    call('player-turn', 'turn.number'),
    call('player-hand', 'card.hand-records', { player: out('player', 'player') }),
    { kind: 'collection', id: 'player-pending-records', method: 'filter', items: out('player-hand', 'cards'), item: 'card', inputs: { turn: out('player-turn', 'value') }, body: [
      call('player-content-state', 'card.instance-field', { card: input('card') }, { field: 'contentState' }),
      call('player-prophecy', 'card.content-field', { record: out('player-content-state', 'value') }, { field: 'velenHolyProphecy' }),
      call('player-has-prophecy', 'compare.values', { left: out('player-prophecy', 'value'), right: literal(null) }, { valueType: JSON.stringify({ kind: 'nullable', value: 'record' }), operator: '!=' }),
      call('player-created-turn', 'card.content-field', { record: out('player-prophecy', 'value') }, { field: 'createdTurnNumber' }),
      call('player-created-default', 'value.coalesce', { value: out('player-created-turn', 'value'), defaultValue: input('turn') }, { valueType: 'number' }),
      call('player-before-turn', 'compare.less-than', { left: out('player-created-default', 'value'), right: input('turn') }),
      call('player-created-missing', 'compare.values', { left: out('player-created-turn', 'value'), right: literal(null) }, { valueType: JSON.stringify({ kind: 'nullable', value: 'number' }), operator: '==' }),
      call('player-created-allowed', 'logic.or', { left: out('player-created-missing', 'value'), right: out('player-before-turn', 'value') }),
      call('player-pending-match', 'logic.and', { left: out('player-has-prophecy', 'value'), right: out('player-created-allowed', 'value') }),
      { kind: 'return', id: 'player-pending-return', value: out('player-pending-match', 'value') },
    ] },
    { kind: 'collection', id: 'player-pending-cards', method: 'map', items: out('player-pending-records', 'value'), item: 'card', body: [
      call('player-card-id', 'card.instance-field', { card: input('card') }, { field: 'instanceId' }),
      call('player-card-id-safe', 'value.coalesce', { value: out('player-card-id', 'value'), defaultValue: literal('') }, { valueType: 'string' }),
      { kind: 'return', id: 'player-card-id-return', value: out('player-card-id-safe', 'value') },
    ] },
    call('player-completed-counter', 'local.counter-create', { initial: literal(0) }),
    { kind: 'foreach', id: 'player-prophecy-loop', items: out('player-pending-cards', 'value'), item: 'card', index: 'index', body: [
      call('player-enhance-flag', 'card.set-content-boolean', { player: out('player', 'player'), card: input('card') }, { field: 'velenHolyProphecyEnhanced' }),
      call('player-clear-prophecy', 'card.clear-content-field', { player: out('player', 'player'), card: input('card') }, { field: 'velenHolyProphecy' }),
      call('player-card-id-read', 'card.read-definition-id', { player: out('player', 'player'), card: input('card') }),
      call('player-is-smite', 'compare.equal-string', { left: out('player-card-id-read', 'cardId'), right: literal('holy-smite') }),
      call('player-is-heal', 'compare.equal-string', { left: out('player-card-id-read', 'cardId'), right: literal('holy-heal') }),
      call('player-is-charge', 'compare.equal-string', { left: out('player-card-id-read', 'cardId'), right: literal('holy-charge') }),
      {
        kind: 'if', id: 'player-smite-enhancement', condition: out('player-is-smite', 'value'), then: [
          call('player-smite-modifier', 'card.set-effect-modifier', { player: out('player', 'player'), card: input('card') }, { effect: 'damage', operation: 'multiply', value: 1.5 }),
          call('player-smite-presentation', 'card.set-presentation', { player: out('player', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：对敌方生命值最低的棋子造成7点真实伤害。' }),
        ], else: [
          {
            kind: 'if', id: 'player-heal-enhancement', condition: out('player-is-heal', 'value'), then: [
              call('player-heal-modifier', 'card.set-effect-modifier', { player: out('player', 'player'), card: input('card') }, { effect: 'heal', operation: 'multiply', value: 1.5 }),
              call('player-heal-presentation', 'card.set-presentation', { player: out('player', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：治疗己方生命值最低的棋子12点生命。' }),
            ], else: [
              {
                kind: 'if', id: 'player-charge-enhancement', condition: out('player-is-charge', 'value'), then: [
                  call('player-charge-modifier', 'card.set-effect-modifier', { player: out('player', 'player'), card: input('card') }, { effect: 'statusIntensity', operation: 'multiply', value: 1.5, statusType: 'damage-buff' }),
                  call('player-charge-presentation', 'card.set-presentation', { player: out('player', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：使己方所有棋子下次造成的伤害提高3点。' }),
                ], else: [],
              },
            ],
          },
        ],
      },
      call('player-one', 'local.counter-add', { counter: out('player-completed-counter', 'counter'), amount: literal(1) }),
    ] },
    call('player-completed', 'local.counter-read', { counter: out('player-completed-counter', 'counter') }),
    call('player-any', 'compare.greater-than', { left: out('player-completed', 'value'), right: literal(0) }),
  )
  requireCondition(playerBody, 'player-any-check', out('player-any', 'value'))
  playerBody.push(
    call('player-count-text', 'text.from-number', { value: out('player-completed', 'value') }),
    call('player-message', 'text.concat', { left: out('player-count-text', 'text'), right: literal('张圣光手牌完成预言') }),
    ...success('player-success', out('player-message', 'text')),
  )

  body.push({ kind: 'if', id: 'delayed-scope', condition: out('holder-present', 'exists'), then: pieceBody, else: playerBody })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildColtBigStrideGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  body.push(call('alive', 'piece.alive', { piece }), call('position', 'piece.has-position', { piece }), call('owner', 'piece.owner', { piece }), call('event-player', 'ref.event-player'), call('event-player-valid', 'query.player', { playerId: out('event-player', 'player') }), call('allied', 'compare.allied-players', { left: out('owner', 'player'), right: out('event-player-valid', 'player') }), call('cancelled', 'event.cancelled'), call('not-allied', 'logic.not', { value: out('allied', 'value') }), call('eligible-a', 'logic.and', { left: out('alive', 'alive'), right: out('position', 'value') }), call('eligible-b', 'logic.and', { left: out('eligible-a', 'value'), right: out('not-allied', 'value') }), call('not-cancelled', 'logic.not', { value: out('cancelled', 'value') }), call('eligible', 'logic.and', { left: out('eligible-b', 'value'), right: out('not-cancelled', 'value') }))
  requireCondition(body, 'eligible-check', out('eligible', 'value'))
  body.push(call('selected', 'event.selected-targets'), call('selected-count', 'list.count-choices', { items: out('selected', 'targets') }), call('has-selected', 'compare.greater-than', { left: out('selected-count', 'value'), right: literal(0) }))
  body.push({ kind: 'if', id: 'selected-branch', condition: out('has-selected', 'value'), then: [
    call('destination', 'choice.first-cell-reference', { items: out('selected', 'targets') }),
    call('has-destination', 'value.present-cell', { value: out('destination', 'cell') }),
    { kind: 'if', id: 'destination-guard', condition: out('has-destination', 'present'), then: [], else: failure('invalid-destination', '移动目标已失效') },
    call('destination-required', 'spatial.cell-require', { cell: out('destination', 'cell') }),
    call('move', 'effect.free-move', { piece, destination: out('destination-required', 'cell') }),
    ...returnResult('move-return', out('move', 'result')),
  ], else: [
    call('cells', 'query.normal-move-cells', { piece }),
    call('count', 'list.count-cells', { items: out('cells', 'cells') }),
    call('has-cells', 'compare.greater-than', { left: out('count', 'value'), right: literal(0) }),
    { kind: 'if', id: 'cell-choice', condition: out('has-cells', 'value'), then: [
      call('choice-result', 'choice.cell-options', { player: out('owner', 'player'), cells: out('cells', 'cells'), title: literal('大步流星：选择移动落点，或放弃移动') }, { targetType: 'cell', success: false, canCancel: true, resumeOnCancel: true }),
      ...returnResult('cell-choice-return', out('choice-result', 'result')),
    ], else: failure('no-cells') },
  ] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function buildColtZoneGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const holderPiece = holder(body)
  body.push(
    call('zone', 'extension.read-owner-record', { owner: holderPiece }, { key: 'coltZones' }),
    call('source-ref', 'extension.record-source', { record: out('zone', 'record') }),
    call('source-present', 'piece.reference-present', { piece: out('source-ref', 'piece') }),
    call('source', 'piece.require', { piece: out('source-ref', 'piece') }),
    call('source-alive', 'piece.alive', { piece: out('source', 'piece') }),
    call('source-position', 'piece.has-position', { piece: out('source', 'piece') }),
    call('kind', 'extension.read-text', { record: out('zone', 'record'), fallback: literal('') }, { field: 'kind' }),
    call('is-revolver', 'compare.equal-string', { left: out('kind', 'value'), right: literal('revolver') }),
    call('is-storm', 'compare.equal-string', { left: out('kind', 'value'), right: literal('storm') }),
    call('valid-kind', 'logic.or', { left: out('is-revolver', 'value'), right: out('is-storm', 'value') }),
    call('turns', 'extension.read-number', { record: out('zone', 'record'), fallback: literal(0) }, { field: 'turns' }),
    call('turns-positive', 'compare.greater-than', { left: out('turns', 'value'), right: literal(0) }),
    call('dx', 'extension.read-number', { record: out('zone', 'record'), fallback: literal(0) }, { field: 'dx' }),
    call('dy', 'extension.read-number', { record: out('zone', 'record'), fallback: literal(0) }, { field: 'dy' }),
    call('dx-floor', 'math.floor', { value: out('dx', 'value') }),
    call('dy-floor', 'math.floor', { value: out('dy', 'value') }),
    call('dx-integer', 'compare.equal', { left: out('dx', 'value'), right: out('dx-floor', 'value') }),
    call('dy-integer', 'compare.equal', { left: out('dy', 'value'), right: out('dy-floor', 'value') }),
    call('integer-direction', 'logic.and', { left: out('dx-integer', 'value'), right: out('dy-integer', 'value') }),
    call('abs-dx', 'math.abs', { value: out('dx', 'value') }),
    call('abs-dy', 'math.abs', { value: out('dy', 'value') }),
    call('abs-sum', 'math.add', { left: out('abs-dx', 'value'), right: out('abs-dy', 'value') }),
    call('cardinal', 'compare.equal', { left: out('abs-sum', 'value'), right: literal(1) }),
    call('valid-direction', 'logic.and', { left: out('integer-direction', 'value'), right: out('cardinal', 'value') }),
    call('valid-shape-a', 'logic.and', { left: out('valid-kind', 'value'), right: out('turns-positive', 'value') }),
    call('valid-shape', 'logic.and', { left: out('valid-shape-a', 'value'), right: out('valid-direction', 'value') }),
    call('invalid-shape', 'logic.not', { value: out('valid-shape', 'value') }),
  )
  body.push({ kind: 'if', id: 'invalid-shape-branch', condition: out('invalid-shape', 'value'), then: [
    ...failure('invalid-shape-result'),
  ] })
  body.push(
    call('valid-source-state', 'logic.and', { left: out('source-present', 'value'), right: out('source-alive', 'alive') }),
    call('valid-source', 'logic.and', { left: out('valid-source-state', 'value'), right: out('source-position', 'value') }),
    call('valid-zone-a', 'logic.and', { left: out('valid-source', 'value'), right: out('valid-kind', 'value') }),
    call('valid-zone-b', 'logic.and', { left: out('valid-zone-a', 'value'), right: out('turns-positive', 'value') }),
    call('valid-zone', 'logic.and', { left: out('valid-zone-b', 'value'), right: out('valid-direction', 'value') }),
    call('invalid-zone', 'logic.not', { value: out('valid-zone', 'value') }),
  )
  body.push({ kind: 'if', id: 'invalid-zone-branch', condition: out('invalid-zone', 'value'), then: [
    call('remove-invalid-zone', 'extension.remove-owner-record', { owner: holderPiece }, { key: 'coltZones' }),
    { kind: 'if', id: 'remove-invalid-status-branch', condition: out('source-present', 'value'), then: [
      call('source-id', 'piece.identifier', { piece: out('source', 'piece') }),
      call('zone-status-id', 'text.concat', { left: literal('colt-zone-'), right: out('source-id', 'id') }),
      call('remove-invalid-status', 'status.remove-record', { piece: out('source', 'piece'), value: out('zone-status-id', 'text') }, { selector: 'id' }),
    ] },
    ...failure('invalid-zone-result'),
  ] })
  body.push(
    call('direction', 'spatial.cell', { x: out('dx', 'value'), y: out('dy', 'value') }),
    call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
    call('source-name', 'piece.name-by-id', { piece: out('source', 'piece'), fallback: literal('') }),
    call('hit-messages', 'collection.text-list-create'),
  )
  body.push({ kind: 'if', id: 'revolver-branch', condition: out('is-revolver', 'value'), then: [
    call('target-ref', 'projectile.first-enemy-on-path', { source: out('source', 'piece'), direction: out('direction', 'cell') }, { maxDistance: 6 }),
    call('target-present', 'piece.reference-present', { piece: out('target-ref', 'target') }),
    { kind: 'if', id: 'revolver-hit', condition: out('target-present', 'value'), then: [
      call('target', 'piece.require', { piece: out('target-ref', 'target') }),
      call('revolver-damage', 'effect.damage', { source: out('source', 'piece'), target: out('target', 'piece'), amount: out('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'colt-revolver', inputPolicy: 'host' }),
      call('revolver-append-hit', 'collection.text-list-add', { items: out('hit-messages', 'items'), value: out('source-name', 'text') }),
    ] },
  ], else: [
    call('cells', 'spatial.ray-cells', { source: out('source', 'piece'), direction: out('direction', 'cell') }, { maxDistance: 6 }),
    call('destroy-walls', 'effect.destroy-walls', { cells: out('cells', 'cells') }, { includeCover: true }),
    call('targets', 'query.enemies-on-ordered-cells', { source: out('source', 'piece'), cells: out('cells', 'cells') }),
    { kind: 'foreach', id: 'storm-loop', items: out('targets', 'pieces'), item: 'target', index: 'index', body: [
      call('storm-damage', 'effect.damage', { source: out('source', 'piece'), target: input('target'), amount: out('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'colt-bullet-storm', inputPolicy: 'host' }),
    ] },
    call('target-count', 'list.count-pieces', { items: out('targets', 'pieces') }),
    call('has-targets', 'compare.greater-than', { left: out('target-count', 'value'), right: literal(0) }),
    { kind: 'if', id: 'storm-hit', condition: out('has-targets', 'value'), then: [
      call('storm-append-hit', 'collection.text-list-add', { items: out('hit-messages', 'items'), value: out('source-name', 'text') }),
    ] },
  ] })
  body.push(
    call('turns-after', 'extension.decrement-turns', { record: out('zone', 'record') }),
    call('turns-expired', 'compare.less-or-equal', { left: out('turns-after', 'value'), right: literal(0) }),
    call('source-id-after', 'piece.identifier', { piece: out('source', 'piece') }),
    call('zone-status-id-after', 'text.concat', { left: literal('colt-zone-'), right: out('source-id-after', 'id') }),
  )
  body.push({ kind: 'if', id: 'zone-expiry', condition: out('turns-expired', 'value'), then: [
    call('remove-zone', 'extension.remove-owner-record', { owner: holderPiece }, { key: 'coltZones' }),
    call('remove-zone-status', 'status.remove-record', { piece: out('source', 'piece'), value: out('zone-status-id-after', 'text') }, { selector: 'id' }),
  ], else: [
    call('set-stacks', 'status.set-number', { piece: out('source', 'piece'), statusId: out('zone-status-id-after', 'text'), value: out('turns-after', 'value') }, { field: 'stacks' }),
    call('set-intensity', 'status.set-number', { piece: out('source', 'piece'), statusId: out('zone-status-id-after', 'text'), value: out('turns-after', 'value') }, { field: 'intensity' }),
  ] })
  body.push(
    call('hit-count', 'list.count', { items: out('hit-messages', 'items') }),
    call('has-hits', 'compare.greater-than', { left: out('hit-count', 'count'), right: literal(0) }),
    call('message', 'text.optional-fragment', { condition: out('has-hits', 'value'), value: out('source-name', 'text') }, { prefix: '', suffix: '的射击区域造成伤害' }),
  )
  body.push({ kind: 'if', id: 'zone-result', condition: out('has-hits', 'value'), then: success('zone-success', out('message', 'text')), else: failure('zone-empty') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

function recastDamageBody(piece: GameplayValue, target: GameplayValue): GameplayStatement[] {
  return [
    call('self-damage', 'effect.damage', { source: piece, target: piece, amount: literal(1) }, { damageType: 'true', skillId: 'shishio-infinite-blade-recast-cost', inputPolicy: 'host' }),
    call('still-alive', 'piece.alive', { piece }),
    { kind: 'if', id: 'self-death', condition: (() => out('still-alive', 'alive'))(), then: [], else: [
      call('death-name', 'attribute.text', { piece }, { attribute: 'name' }),
      call('death-message', 'text.concat', { left: out('death-name', 'text'), right: literal('受到真实伤害后倒下，无法再次发动无限刃') }),
      ...success('self-death-result', out('death-message', 'text')),
    ] },
    call('kill-id', 'status.find-id', { piece }, { statusType: 'shishio-kills' }),
    call('kills', 'status.read-number-field', { piece, statusId: out('kill-id', 'id'), fallback: literal(0) }, { field: 'intensity' }),
    call('two-kills', 'compare.greater-or-equal', { left: out('kills', 'value'), right: literal(2) }),
    call('one-kill', 'compare.greater-or-equal', { left: out('kills', 'value'), right: literal(1) }),
    call('one-or-more', 'value.select-number', { condition: out('one-kill', 'value'), whenTrue: literal(1.5), whenFalse: literal(1) }),
    call('multiplier', 'value.select-number', { condition: out('two-kills', 'value'), whenTrue: literal(2), whenFalse: out('one-or-more', 'value') }),
    call('attack', 'attribute.read', { piece }, { attribute: 'attack' }),
    call('raw-damage', 'math.multiply', { left: out('attack', 'value'), right: out('multiplier', 'value') }),
    call('damage', 'math.floor', { value: out('raw-damage', 'value') }),
    call('target-damage', 'effect.damage', { source: piece, target, amount: out('damage', 'value') }, { damageType: 'true', skillId: 'shishio-infinite-blade', inputPolicy: 'host' }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: target }, { attribute: 'name' }),
    call('self-text', 'text.from-number', { value: out('self-damage', 'damage') }),
    call('target-text', 'text.from-number', { value: out('target-damage', 'damage') }),
    call('m0', 'text.concat', { left: out('name', 'text'), right: literal('受到') }),
    call('m1', 'text.concat', { left: out('m0', 'text'), right: out('self-text', 'text') }),
    call('m2', 'text.concat', { left: out('m1', 'text'), right: literal('点真实伤害，再次发动无限刃，对') }),
    call('m3', 'text.concat', { left: out('m2', 'text'), right: out('target-name', 'text') }),
    call('m4', 'text.concat', { left: out('m3', 'text'), right: literal('造成') }),
    call('m5', 'text.concat', { left: out('m4', 'text'), right: out('target-text', 'text') }),
    call('message', 'text.concat', { left: out('m5', 'text'), right: literal('点真实伤害') }),
    ...success('recast-success', out('message', 'text')),
  ]
}

function buildShishioBurnMoveGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  body.push(call('event-player', 'ref.player'), call('shishio', 'piece.by-template', { owner: out('event-player', 'player') }, { templateId: 'red-shishio', alive: true }))
  body.push(call('shishio-present', 'piece.reference-present', { piece: out('shishio', 'piece') }))
  requireCondition(body, 'shishio-check', out('shishio-present', 'value'))
  body.push(call('shishio-required', 'piece.require', { piece: out('shishio', 'piece') }), call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
  requireCondition(body, 'source-check', out('source-exists', 'exists'))
  body.push(call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('source-required', 'piece.require', { piece: out('source', 'piece') }), call('alive', 'piece.alive', { piece: out('source-required', 'piece') }))
  requireCondition(body, 'alive-check', out('alive', 'alive'))
  body.push(call('burn-records', 'extension.read-list', {}, { key: 'shishioBurnTiles' }), call('burn-cells', 'extension.cells-for-source', { cells: out('burn-records', 'cells'), source: out('shishio-required', 'piece') }), call('on-burn', 'query.pieces-on-cells-all', { cells: out('burn-cells', 'cells') }, { relation: 'all' }), call('is-on-burn', 'collection.contains-piece', { items: out('on-burn', 'pieces'), value: out('source-required', 'piece') }))
  requireCondition(body, 'on-burn-check', out('is-on-burn', 'contains'))
  body.push(
    call('hp', 'attribute.read', { piece: out('source-required', 'piece') }, { attribute: 'currentHp' }),
    call('raw-damage', 'math.multiply', { left: out('hp', 'value'), right: literal(0.5) }),
    call('damage-amount', 'math.floor', { value: out('raw-damage', 'value') }),
    call('damage', 'effect.damage', { source: out('shishio-required', 'piece'), target: out('source-required', 'piece'), amount: out('damage-amount', 'value') }, { damageType: 'true', skillId: 'shishio-burn-move', inputPolicy: 'host' }),
    call('target-name', 'attribute.text', { piece: out('source-required', 'piece') }, { attribute: 'name' }),
    call('damage-text', 'text.from-number', { value: out('damage-amount', 'value') }),
    call('message-0', 'text.concat', { left: out('target-name', 'text'), right: literal(' 踏入燃地！承受 ') }),
    call('message-1', 'text.concat', { left: out('message-0', 'text'), right: out('damage-text', 'text') }),
    call('message', 'text.concat', { left: out('message-1', 'text'), right: literal(' 点真实伤害（当前生命值50%）') }),
    call('has-damage', 'compare.greater-than', { left: out('damage', 'damage'), right: literal(-1) }),
  )
  body.push({ kind: 'if', id: 'burn-move-result', condition: out('has-damage', 'value'), then: success('burn-move-success', out('message', 'text')), else: failure('burn-move-failure') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

export function buildShishioVelenColtGraph(id: string): GameplayModuleGraph {
  switch (id) {
    case 'rule-momentum-consume': return buildMomentumConsumeGraph()
    case 'rule-shishio-burn-endturn': return buildShishioBurnEndturnGraph()
    case 'rule-shishio-burn-move': return buildShishioBurnMoveGraph()
    case 'rule-shishio-combustion': return buildShishioCombustionGraph()
    case 'rule-shishio-execute-option': return buildShishioExecuteGraph()
    case 'rule-shishio-infinite-blade-recast': return buildShishioRecastGraph()
    case 'rule-shishio-silence-burst': return buildShishioSilenceGraph()
    case 'rule-velen-death-cleanup': return buildVelenDeathCleanupGraph()
    case 'rule-velen-delayed-effects': return buildVelenDelayedEffectsGraph()
    case 'rule-velen-fate-target': return buildVelenFateTargetGraph()
    case 'rule-colt-big-stride': return buildColtBigStrideGraph()
    case 'rule-colt-zone-endturn': return buildColtZoneGraph()
    default: throw new Error('Unimplemented Shishio/Velen/Colt rule ' + id)
  }
}

export type ShishioVelenColtPreflight = {
  pending: { id: string; file: string; next: Record<string, unknown> }[]
  preserved: { id: string; message: string }[]
  failures: { id: string; message: string }[]
}

export function preflightShishioVelenColt(root: string): ShishioVelenColtPreflight {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: ShishioVelenColtPreflight['pending'] = [], preserved: ShishioVelenColtPreflight['preserved'] = [], failures: ShishioVelenColtPreflight['failures'] = []
  for (const id of SHISHIO_VELEN_COLT_RULE_IDS) {
    try {
      const file = path.join(root, 'data/rules', id + '.json')
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
      const original = baseline['rules/' + id]
      // Existing RED-252 checkouts may already contain a compatibility
      // contentGraph compiled from the frozen executable. Validate the actual
      // executable provenance first, then preserve that graph while replacing
      // only the semantic module entry.
      assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
      if (current.contentGraph) assertContentGraphArtifact(current)
      for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
      pending.push({ id, file, next: applyGameplayModuleGraph(current, buildShishioVelenColtGraph(id), 'skillCode') })
    } catch (error) { failures.push({ id, message: error instanceof Error ? error.message : String(error) }) }
  }
  return { pending, preserved, failures }
}

export function migrateShishioVelenColt(root: string, write = false, allowPartial = false): string[] {
  const report = preflightShishioVelenColt(root)
  if (report.failures.length && !allowPartial) throw new Error(`Shishio/Velen/Colt migration preflight failed:\n${report.failures.map(item => `- ${item.message}`).join('\n')}`)
  if (write) for (const item of report.pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return report.pending.map(item => path.basename(item.file, '.json'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const allowPartial = process.argv.includes('--write-ready')
  const report = preflightShishioVelenColt(process.cwd())
  if (report.failures.length && !allowPartial) throw new Error(`Shishio/Velen/Colt migration preflight failed:\n${report.failures.map(item => `- ${item.message}`).join('\n')}`)
  if (process.argv.includes('--write')) for (const item of report.pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  console.log(JSON.stringify({ migrated: report.pending.map(item => path.basename(item.file, '.json')), preserved: [...report.preserved, ...report.failures] }))
}
