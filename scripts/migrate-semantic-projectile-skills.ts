import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
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

export const PROJECTILE_SKILL_IDS = [
  'sleep-dart',
  'colt-revolver',
  'colt-piercing',
  'hand-cannon',
  'pulse-pistol',
  'hellfire-shotgun',
  'shelly-shotgun',
  'shelly-super-shell',
  'colt-bullet-storm',
  'max-speed-shot',
  'blackwidow-lethal-strike',
  'grimmjow-panther-claw',
  'ichigo-getsuga-tensho',
  'shadow-bolt',
  'shadow-chaos-spear',
  'sasuke-chidori',
  'naruto-rasengan',
  'aizen-black-coffin',
] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const result = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] => [call(id, 'result.action', { success, message }), { kind: 'return', id: id + '-return', value: out(id, 'result') }]
const triggerResult = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement => ({ kind: 'return', id, values: { success, message } })

const schema: GameplayRecordSchema = {
  id: 'sleep-status@1',
  version: '1',
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'type', type: 'string' as const },
    { name: 'currentDuration', type: 'number' as const },
    { name: 'intensity', type: 'number' as const },
    { name: 'relatedRules', type: { kind: 'list' as const, element: 'string' as const } },
  ],
}

function cellSelection(body: GameplayStatement[], range: number, filter: 'all' | 'enemy' | 'ally' = 'all'): void {
  body.push(
    call('choice', 'choice.target-cell', {}, { range, filter }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    {
      kind: 'if', id: 'return-selection', condition: out('unresolved', 'value'), then: [
        call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }),
        { kind: 'return', id: 'return-selection-result', value: out('selection-result', 'result') },
      ],
    },
    call('target', 'choice.cell', { choice: out('choice', 'choice') }),
  )
}

function pieceSelection(body: GameplayStatement[], range: number, filter: 'all' | 'enemy' | 'ally'): void {
  body.push(
    call('choice', 'choice.target-piece', {}, { range, filter }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    {
      kind: 'if', id: 'return-selection', condition: out('unresolved', 'value'), then: [
        call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }),
        { kind: 'return', id: 'return-selection-result', value: out('selection-result', 'result') },
      ],
    },
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
  )
}

function messageChain(body: GameplayStatement[], prefix: string, parts: GameplayValue[]): GameplayValue {
  let current: GameplayValue = literal('')
  parts.forEach((part, index) => {
    const id = `${prefix}-${index}`
    body.push(call(id, 'text.concat', { left: current, right: part }))
    current = out(id, 'text')
  })
  return current
}

function skillGraph(body: GameplayStatement[], schemas?: readonly GameplayRecordSchema[]): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    ...(schemas ? { schemas } : {}),
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    body,
  }
}

function buildSleepDartGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
  ]
  cellSelection(body, 99, 'all')
  body.push(
    call('line', 'projectile.trace', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 99 }),
    {
      kind: 'if', id: 'invalid-direction', condition: out('line', 'sameCell'), then: result('same-cell', literal(false), literal('不能选择自身所在格')),
    },
    {
      kind: 'if', id: 'diagonal-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('麻醉镖只能向同一行或同一列方向发射')),
    },
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
  )
  body.push({
    kind: 'foreach', id: 'events', items: out('line', 'events'), item: 'event', body: [
      call('kind', 'projectile.event-kind', { event: input('event') }),
      call('is-piece', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('piece') }),
      {
        kind: 'if', id: 'piece-event', condition: out('is-piece', 'value'), then: [
          call('event-target', 'projectile.event-piece', { event: input('event') }),
          call('enemy', 'query.same-relation', { source: out('source', 'piece'), target: out('event-target', 'piece') }, { relation: 'enemy' }),
          {
            kind: 'if', id: 'enemy-hit', condition: out('enemy', 'value'), then: (() => {
              const statements: GameplayStatement[] = [
                call('clock', 'identity.host-time'),
                call('clock-text', 'text.from-number', { value: out('clock', 'value') }),
                call('status-id', 'text.concat', { left: literal('sleep-'), right: out('clock-text', 'text') }),
                {
                  kind: 'record.create', id: 'sleep-record', schema: 'sleep-status@1', fields: {
                    id: out('status-id', 'text'), type: literal('sleep'), currentDuration: literal(2), intensity: literal(1),
                    relatedRules: literal(['rule-sleep-prevent-move', 'rule-sleep-prevent-skill', 'rule-sleep-remove-on-damage']),
                  },
                },
                call('apply-status', 'status.apply-record', { target: out('event-target', 'piece'), record: out('sleep-record', 'value') }, { inputPolicy: 'host' }),
                call('move-rule', 'rule.apply-piece', { target: out('event-target', 'piece') }, { ruleId: 'rule-sleep-prevent-move' }),
                call('skill-rule', 'rule.apply-piece', { target: out('event-target', 'piece') }, { ruleId: 'rule-sleep-prevent-skill' }),
                call('damage-rule', 'rule.apply-piece', { target: out('event-target', 'piece') }, { ruleId: 'rule-sleep-remove-on-damage' }),
                call('move-skill', 'skill.add', { piece: out('event-target', 'piece') }, { skillId: 'sleep-prevent' }),
                call('damage-skill', 'skill.add', { piece: out('event-target', 'piece') }, { skillId: 'sleep-remove' }),
                call('target-name', 'attribute.text', { piece: out('event-target', 'piece') }, { attribute: 'name' }),
              ]
              const message = messageChain(statements, 'sleep-message', [out('source-name', 'text'), literal('的麻醉镖命中'), out('target-name', 'text'), literal('，使其进入睡眠状态2回合')])
              statements.push(...result('sleep-hit', literal(true), message))
              return statements
            })(),
            else: (() => {
              const statements: GameplayStatement[] = [call('ally-name', 'attribute.text', { piece: out('event-target', 'piece') }, { attribute: 'name' })]
              const message = messageChain(statements, 'ally-message', [literal('麻醉镖被'), out('ally-name', 'text'), literal('阻挡，未对友军生效')])
              statements.push(...result('ally-blocked', literal(true), message))
              return statements
            })(),
          },
        ],
      },
      call('is-terrain', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('terrain') }),
      {
        kind: 'if', id: 'terrain-event', condition: out('is-terrain', 'value'), then: [
          call('blocked', 'projectile.event-blocks', { event: input('event') }),
          { kind: 'if', id: 'terrain-blocked', condition: out('blocked', 'blocks'), then: result('terrain-blocked-result', literal(true), literal('麻醉镖被地形阻挡，未命中任何敌人')) },
        ],
      },
    ],
  })
  body.push(...result('miss', literal(true), literal('麻醉镖未命中任何敌人')))
  return skillGraph(body, [schema])
}

function buildColtRevolverGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  cellSelection(body, 6, 'all')
  body.push(
    call('line', 'projectile.line-cells', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 6, clipToBoard: false }),
    {
      kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('请选择施法者以外的方向格')),
    },
    {
      kind: 'if', id: 'same-cell', condition: out('line', 'sameCell'), then: result('same-cell-result', literal(false), literal('请选择施法者以外的方向格')),
    },
    call('zone', 'projectile.zone-set', { source: out('source', 'piece'), dx: out('line', 'dx'), dy: out('line', 'dy') }, { storageKey: 'coltZones', kind: 'revolver', turns: 2 }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('source-id', 'piece.identifier', { piece: out('source', 'piece') }),
    call('zone-id', 'text.concat', { left: literal('colt-zone-'), right: out('source-id', 'id') }),
    call('remove-zone', 'status.remove-id', { piece: out('source', 'piece'), statusId: out('zone-id', 'text') }),
    {
      kind: 'record.create', id: 'zone-record', schema: 'colt-zone@1', fields: {
        id: out('zone-id', 'text'), type: literal('colt-zone'), name: literal('左轮射击区域'), description: literal('随施法者位置移动；与子弹风暴互斥。'),
        currentDuration: literal(-1), currentUses: literal(-1), stacks: literal(2), intensity: literal(2),
      },
    },
    call('apply-zone', 'status.apply-record', { target: out('source', 'piece'), record: out('zone-record', 'value') }, { inputPolicy: 'host' }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'zone-message', [out('source-name', 'text'), literal('布置左轮手枪射击区域（随自身移动，持续2回合）')])))
  return skillGraph(body, [{ id: 'colt-zone@1', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'description', type: 'string' },
    { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' }, { name: 'stacks', type: 'number' }, { name: 'intensity', type: 'number' },
  ] }])
}

function buildColtBulletStormGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  cellSelection(body, 6, 'all')
  body.push(
    call('line', 'projectile.line-cells', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 6, clipToBoard: false }),
    {
      kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('请选择施法者以外的方向格')),
    },
    {
      kind: 'if', id: 'same-cell', condition: out('line', 'sameCell'), then: result('same-cell-result', literal(false), literal('请选择施法者以外的方向格')),
    },
    call('zone', 'projectile.zone-set', { source: out('source', 'piece'), dx: out('line', 'dx'), dy: out('line', 'dy') }, { storageKey: 'coltZones', kind: 'storm', turns: 3 }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('source-id', 'piece.identifier', { piece: out('source', 'piece') }),
    call('zone-id', 'text.concat', { left: literal('colt-zone-'), right: out('source-id', 'id') }),
    call('remove-zone', 'status.remove-id', { piece: out('source', 'piece'), statusId: out('zone-id', 'text') }),
    {
      kind: 'record.create', id: 'zone-record', schema: 'colt-zone@1', fields: {
        id: out('zone-id', 'text'), type: literal('colt-zone'), name: literal('子弹风暴区域'), description: literal('随施法者位置移动；与左轮手枪互斥。'),
        currentDuration: literal(-1), currentUses: literal(-1), stacks: literal(3), intensity: literal(3),
      },
    },
    call('apply-zone', 'status.apply-record', { target: out('source', 'piece'), record: out('zone-record', 'value') }, { inputPolicy: 'host' }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'zone-message', [out('source-name', 'text'), literal('布置子弹风暴区域（随自身移动，持续3回合）')])))
  return skillGraph(body, [{ id: 'colt-zone@1', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'description', type: 'string' },
    { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' }, { name: 'stacks', type: 'number' }, { name: 'intensity', type: 'number' },
  ] }])
}

function buildColtPiercingGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('captured-source', 'source.capture', { source: out('source', 'piece') })]
  cellSelection(body, 6, 'all')
  body.push(
    call('line', 'projectile.line-cells', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 6, clipToBoard: false }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('请选择施法者以外的方向格')) },
    call('destroy', 'effect.destroy-walls', { cells: out('line', 'cells') }, { includeCover: true }),
    call('enemies', 'query.enemies-on-cells', { source: out('source', 'piece'), cells: out('line', 'cells') }),
    call('enemy-count', 'collection.piece-count', { pieces: out('enemies', 'pieces') }),
    call('has-enemies', 'compare.greater-than', { left: out('enemy-count', 'value'), right: literal(0) }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    {
      kind: 'if', id: 'damage-enemies', condition: out('has-enemies', 'value'), then: [
        call('damage', 'effect.damage-many-captured', { source: out('captured-source', 'source'), targets: out('enemies', 'pieces'), amount: literal(4) }, { damageType: 'physical' }),
      ],
    },
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [out('source-name', 'text'), literal('发射穿甲银弹')])))
  return skillGraph(body)
}

function buildHandCannonGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  pieceSelection(body, 2, 'enemy')
  body.push(
    call('distance', 'query.distance', { from: out('source', 'piece'), to: out('target', 'piece') }),
  )
  // The target protocol already enforces range. Keep the legacy explicit
  // distance guard as a semantic branch for direct host invocations.
  body.push(
    call('too-far-value', 'compare.greater-than', { left: out('distance', 'distance'), right: literal(2) }),
    { kind: 'if', id: 'too-far', condition: out('too-far-value', 'value'), then: result('too-far-result', literal(false), literal('目标距离太远')) },
  )
  body.push(
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
    call('damage', 'effect.damage', { source: out('source', 'piece'), target: out('target', 'piece'), amount: literal(1) }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'hand-cannon', inputPolicy: 'host' }),
    call('damage-text', 'text.from-number', { value: out('damage', 'damage') }),
  )
  body.push(...result('success', out('damage', 'success'), messageChain(body, 'message', [out('source-name', 'text'), literal('使用手炮对'), out('target-name', 'text'), literal('造成'), out('damage-text', 'text'), literal('点伤害')])))
  return skillGraph(body)
}

function buildPulsePistolGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('caster-ref', 'ref.holder'),
    call('trigger-ref', 'ref.source'),
    call('caster-exists', 'query.has-piece', { pieceId: out('caster-ref', 'piece') }),
    call('trigger-exists', 'query.has-piece', { pieceId: out('trigger-ref', 'piece') }),
    call('caster-missing', 'logic.not', { value: out('caster-exists', 'exists') }),
    call('trigger-missing', 'logic.not', { value: out('trigger-exists', 'exists') }),
    call('missing', 'logic.or', { left: out('caster-missing', 'value'), right: out('trigger-missing', 'value') }),
    { kind: 'if', id: 'missing-source', condition: out('missing', 'value'), then: [triggerResult('missing-result', literal(false), literal(''))] },
    call('caster', 'query.piece', { pieceId: out('caster-ref', 'piece') }),
    call('trigger', 'query.piece', { pieceId: out('trigger-ref', 'piece') }),
    call('friendly-trigger', 'query.same-relation', { source: out('caster', 'piece'), target: out('trigger', 'piece') }, { relation: 'ally' }),
    { kind: 'if', id: 'friendly-trigger-check', condition: out('friendly-trigger', 'value'), then: [triggerResult('friendly-result', literal(false), literal(''))] },
    call('enemies', 'query.pieces-in-square', { origin: out('caster', 'piece') }, { relation: 'enemy', halfExtent: 2 }),
    call('enemy-count', 'collection.piece-count', { pieces: out('enemies', 'pieces') }),
    call('no-enemy', 'compare.equal', { left: out('enemy-count', 'value'), right: literal(0) }),
    { kind: 'if', id: 'no-enemy-check', condition: out('no-enemy', 'value'), then: [triggerResult('no-enemy-result', literal(false), literal(''))] },
    call('target', 'query.random-item', { items: out('enemies', 'pieces') }),
    call('attack', 'attribute.read', { piece: out('caster', 'piece') }, { attribute: 'attack' }),
    call('caster-name', 'attribute.text', { piece: out('caster', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: out('target', 'item') }, { attribute: 'name' }),
    call('damage', 'effect.damage', { source: out('caster', 'piece'), target: out('target', 'item'), amount: out('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'pulse-pistol', inputPolicy: 'host' }),
    call('damage-text', 'text.from-number', { value: out('damage', 'damage') }),
  ]
  body.push(triggerResult('success-result', literal(true), messageChain(body, 'message', [out('caster-name', 'text'), literal('的脉冲手枪触发，对'), out('target-name', 'text'), literal('造成'), out('damage-text', 'text'), literal('点伤害')])))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'triggerSkill', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}

function buildHellfireShotgunGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  cellSelection(body, 5, 'all')
  body.push(
    call('line', 'projectile.trace', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 5 }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('必须选择同一行或同一列的方向')) },
  )
  body.push({
    kind: 'foreach', id: 'events', items: out('line', 'events'), item: 'event', body: [
      call('kind', 'projectile.event-kind', { event: input('event') }),
      call('is-piece', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('piece') }),
      {
        kind: 'if', id: 'piece-event', condition: out('is-piece', 'value'), then: (() => {
          const statements: GameplayStatement[] = [
            call('hit-target', 'projectile.event-piece', { event: input('event') }),
            call('distance', 'projectile.event-distance', { event: input('event') }),
            call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
            call('plus-four', 'math.add', { left: out('attack', 'value'), right: literal(4) }),
            call('raw-damage', 'math.subtract', { left: out('plus-four', 'value'), right: out('distance', 'distance') }),
            call('damage', 'value.number-or-zero', { value: out('raw-damage', 'value') }),
            call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
            call('target-name', 'attribute.text', { piece: out('hit-target', 'piece') }, { attribute: 'name' }),
            call('applied', 'effect.damage', { source: out('source', 'piece'), target: out('hit-target', 'piece'), amount: out('damage', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'hellfire-shotgun', inputPolicy: 'host' }),
            call('damage-text', 'text.from-number', { value: out('applied', 'damage') }),
            call('distance-text', 'text.from-number', { value: out('distance', 'distance') }),
          ]
          const message = messageChain(statements, 'hit-message', [out('source-name', 'text'), literal('使用地狱火霰弹枪对'), out('target-name', 'text'), literal('造成'), out('damage-text', 'text'), literal('点伤害（距离'), out('distance-text', 'text'), literal('格）')])
          statements.push(...result('hit', literal(true), message))
          return statements
        })(),
      },
      call('is-terrain', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('terrain') }),
      {
        kind: 'if', id: 'terrain-event', condition: out('is-terrain', 'value'), then: [
          call('blocked', 'projectile.event-blocks', { event: input('event') }),
          { kind: 'if', id: 'terrain-blocked', condition: out('blocked', 'blocks'), then: result('terrain-blocked-result', literal(true), literal('攻击被障碍物阻挡')) },
        ],
      },
    ],
  })
  body.push(...result('miss', literal(true), literal('路径上没有目标')))
  return skillGraph(body)
}

function buildShellyShotgunGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  cellSelection(body, 4, 'all')
  body.push(
    call('line', 'projectile.trace', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 4 }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('请选择正方向')) },
  )
  body.push({
    kind: 'foreach', id: 'events', items: out('line', 'events'), item: 'event', body: [
      call('kind', 'projectile.event-kind', { event: input('event') }),
      call('is-piece', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('piece') }),
      {
        kind: 'if', id: 'piece-event', condition: out('is-piece', 'value'), then: (() => {
          const statements: GameplayStatement[] = [
            call('hit-target', 'projectile.event-piece', { event: input('event') }),
            call('friendly', 'query.same-relation', { source: out('source', 'piece'), target: out('hit-target', 'piece') }, { relation: 'ally' }),
          ]
          const friendly: GameplayStatement[] = [call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' })]
          const friendlyMessage = messageChain(friendly, 'friendly-message', [out('source-name', 'text'), literal('的大口径霰弹枪被友方棋子阻挡')])
          friendly.push(...result('friendly-result', literal(true), friendlyMessage))
          statements.push({ kind: 'if', id: 'friendly-block', condition: out('friendly', 'value'), then: friendly })
          statements.push(
            call('distance', 'projectile.event-distance', { event: input('event') }),
            call('multiplier', 'projectile.distance-multiplier', { distance: out('distance', 'distance') }, { values: [2, 1.5, 1, 0.5] }),
            call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
            call('scaled', 'math.multiply', { left: out('attack', 'value'), right: out('multiplier', 'value') }),
            call('damage-value', 'math.floor', { value: out('scaled', 'value') }),
            call('source-name-before-hit', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
            call('target-name', 'attribute.text', { piece: out('hit-target', 'piece') }, { attribute: 'name' }),
            call('applied', 'effect.damage', { source: out('source', 'piece'), target: out('hit-target', 'piece'), amount: out('damage-value', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'shelly-shotgun', inputPolicy: 'host' }),
            call('actual-damage', 'value.number-or-zero', { value: out('applied', 'damage') }),
            call('damage-text', 'text.from-number', { value: out('actual-damage', 'value') }),
          )
          const message = messageChain(statements, 'hit-message', [out('source-name-before-hit', 'text'), literal('使用大口径霰弹枪命中'), out('target-name', 'text'), literal('，造成'), out('damage-text', 'text'), literal('点伤害')])
          statements.push(...result('hit', literal(true), message))
          return statements
        })(),
      },
      call('is-terrain', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('terrain') }),
      {
        kind: 'if', id: 'terrain-event', condition: out('is-terrain', 'value'), then: [
          call('blocked', 'projectile.event-blocks', { event: input('event') }),
          { kind: 'if', id: 'terrain-blocked', condition: out('blocked', 'blocks'), then: (() => { const statements: GameplayStatement[] = [call('source-name-terrain', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' })]; const message = messageChain(statements, 'terrain-message', [out('source-name-terrain', 'text'), literal('的大口径霰弹枪被地形阻挡')]); statements.push(...result('terrain-blocked-result', literal(true), message)); return statements })() },
        ],
      },
    ],
  })
  body.push(call('source-name-miss', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }))
  body.push(...result('miss', literal(true), messageChain(body, 'miss-message', [out('source-name-miss', 'text'), literal('的大口径霰弹枪未命中敌人')])))
  return skillGraph(body)
}

function buildShellySuperShellGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
    call('source-owner', 'piece.owner', { piece: out('source', 'piece') }),
    call('captured-source', 'source.capture', { source: out('source', 'piece') }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('source-attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
  ]
  cellSelection(body, 4, 'all')
  body.push(
    call('line', 'projectile.line-cells', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 4, clipToBoard: true }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('请选择正方向')) },
    call('destroy', 'effect.destroy-walls', { cells: out('line', 'cells') }, { includeCover: true }),
  )
  let hitValue: GameplayValue = literal(0)
  for (let index = 0; index < 4; index += 1) {
    const distance = index + 1
    body.push(
      call(`enemies-${distance}`, 'query.enemies-on-index', { owner: out('source-owner', 'player'), cells: out('line', 'cells'), index: literal(index) }),
      call(`count-${distance}`, 'collection.piece-count', { pieces: out(`enemies-${distance}`, 'pieces') }),
      call(`present-${distance}`, 'compare.greater-than', { left: out(`count-${distance}`, 'value'), right: literal(0) }),
      {
        kind: 'if', id: `damage-cell-${distance}`, condition: out(`present-${distance}`, 'value'), then: [
          call(`multiplier-${distance}`, 'projectile.distance-multiplier', { distance: literal(distance) }, { values: [4, 2, 1.5, 1] }),
          call(`scaled-${distance}`, 'math.multiply', { left: out('source-attack', 'value'), right: out(`multiplier-${distance}`, 'value') }),
          call(`amount-${distance}`, 'math.floor', { value: out(`scaled-${distance}`, 'value') }),
          call(`damage-${distance}`, 'effect.damage-many-captured', { source: out('captured-source', 'source'), targets: out(`enemies-${distance}`, 'pieces'), amount: out(`amount-${distance}`, 'value') }, { damageType: 'physical' }),
        ],
      },
      call(`hits-${distance}`, 'math.add', { left: hitValue, right: out(`count-${distance}`, 'value') }),
    )
    hitValue = out(`hits-${distance}`, 'value')
  }
  body.push(
    call('broken-text', 'text.from-number', { value: out('destroy', 'changed') }),
    call('hit-text', 'text.from-number', { value: hitValue }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [out('source-name', 'text'), literal('使用超级霰弹，破坏'), out('broken-text', 'text'), literal('个地形并命中'), out('hit-text', 'text'), literal('名敌人')])))
  return skillGraph(body)
}

function buildMaxSpeedShotGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
    call('turn', 'event.battle-turn-number'),
    call('cast-count', 'event.skill-cast-count', { piece: out('source', 'piece') }, { skillId: 'max-speed-shot' }),
    call('too-many', 'compare.greater-or-equal', { left: out('cast-count', 'count'), right: literal(2) }),
    { kind: 'if', id: 'cast-limit', condition: out('too-many', 'value'), then: result('cast-limit-result', literal(false), literal('本回合速射能量炮最多释放2次')) },
    call('recast', 'compare.equal', { left: out('cast-count', 'count'), right: literal(1) }),
  ]
  cellSelection(body, 4, 'all')
  body.push(
    call('line', 'projectile.trace', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 4 }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('请选择正方向')) },
    call('status-ids', 'status.list-ids', { piece: out('source', 'piece') }, { statusType: 'max-speed-shot-recast' }),
  )
  body.push({
    kind: 'foreach', id: 'cleanup-statuses', items: out('status-ids', 'ids'), item: 'statusId', body: [
      call('status-turn', 'status.read-turn-number', { piece: out('source', 'piece'), statusId: out('cleanup-statuses', 'item'), fallback: literal(-1) }),
      call('same-turn', 'compare.equal', { left: out('status-turn', 'value'), right: out('turn', 'value') }),
      call('old-turn', 'logic.not', { value: out('same-turn', 'value') }),
      call('first-cast', 'logic.not', { value: out('recast', 'value') }),
      call('remove-current', 'logic.and', { left: out('recast', 'value'), right: out('same-turn', 'value') }),
      call('remove-old', 'logic.and', { left: out('old-turn', 'value'), right: out('first-cast', 'value') }),
      call('remove-status', 'logic.or', { left: out('remove-current', 'value'), right: out('remove-old', 'value') }),
      { kind: 'if', id: 'remove-selected-status', condition: out('remove-status', 'value'), then: [call('remove', 'status.remove-id', { piece: out('source', 'piece'), statusId: out('cleanup-statuses', 'item') })] },
    ],
  })
  body.push({
    kind: 'if', id: 'recast-branch', condition: out('recast', 'value'), then: [
      call('recast-reset', 'skill.reset-cooldown', { piece: out('source', 'piece'), skillId: literal('max-speed-shot') }),
      call('recast-cooldown', 'skill.adjust-cooldown', { piece: out('source', 'piece'), skillId: literal('max-speed-shot'), amount: literal(1) }, { mode: 'atLeast' }),
    ], else: [
      call('source-id', 'piece.identifier', { piece: out('source', 'piece') }),
      call('turn-text', 'text.from-number', { value: out('turn', 'value') }),
      call('status-prefix', 'text.concat', { left: literal('max-speed-shot-recast-'), right: out('source-id', 'id') }),
      call('status-id', 'text.concat', { left: out('status-prefix', 'text'), right: literal('-') }),
      call('status-id-full', 'text.concat', { left: out('status-id', 'text'), right: out('turn-text', 'text') }),
      { kind: 'record.create', id: 'recast-record', schema: 'max-speed-shot-recast@1', fields: {
        id: out('status-id-full', 'text'), type: literal('max-speed-shot-recast'), name: literal('速射能量炮·再次释放'), visible: literal(false), stacking: literal('independent'),
        turnNumber: out('turn', 'value'), currentDuration: literal(1), currentUses: literal(1), remainingUses: literal(1),
      } },
      call('apply-recast', 'status.apply-record', { target: out('source', 'piece'), record: out('recast-record', 'value') }, { inputPolicy: 'host' }),
      call('reset-cooldown', 'skill.reset-cooldown', { piece: out('source', 'piece'), skillId: literal('max-speed-shot') }),
    ],
  })
  body.push({
    kind: 'foreach', id: 'events', items: out('line', 'events'), item: 'event', body: [
      call('kind', 'projectile.event-kind', { event: input('event') }),
      call('is-piece', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('piece') }),
      {
        kind: 'if', id: 'piece-event', condition: out('is-piece', 'value'), then: (() => {
          const statements: GameplayStatement[] = [
            call('hit-target', 'projectile.event-piece', { event: input('event') }),
            call('friendly', 'query.same-relation', { source: out('source', 'piece'), target: out('hit-target', 'piece') }, { relation: 'ally' }),
          ]
          const friendly: GameplayStatement[] = [call('source-name-friendly', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' })]
          friendly.push(...result('friendly-result', literal(true), messageChain(friendly, 'friendly-message', [out('source-name-friendly', 'text'), literal('的速射能量炮被友方棋子阻挡')])))
          statements.push({ kind: 'if', id: 'friendly-block', condition: out('friendly', 'value'), then: friendly })
          statements.push(
            call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
            call('target-name', 'attribute.text', { piece: out('hit-target', 'piece') }, { attribute: 'name' }),
            call('saved-source', 'source.capture', { source: out('source', 'piece') }),
            call('saved-target', 'source.capture', { source: out('hit-target', 'piece') }),
            call('hits', 'local.counter-create', { initial: literal(0) }),
            call('total', 'local.counter-create', { initial: literal(0) }),
          )
          statements.push({ kind: 'foreach', id: 'shots', items: literal([0, 1, 2, 3]), item: 'shot', body: [
            call('target-hp', 'source.captured-number', { source: out('saved-target', 'source') }, { field: 'currentHp' }),
            call('target-alive', 'compare.greater-than', { left: out('target-hp', 'value'), right: literal(0) }),
            { kind: 'if', id: 'shot-guard', condition: out('target-alive', 'value'), then: [
              call('damage', 'effect.damage-captured', { source: out('saved-source', 'source'), target: out('saved-target', 'source'), amount: literal(1) }, { damageType: 'physical', skillId: 'max-speed-shot' }),
              call('dealt', 'effect.result-number', { result: out('damage', 'result') }, { field: 'damage' }),
              call('count-hit', 'local.counter-add', { counter: out('hits', 'counter'), amount: literal(1) }),
              call('sum-damage', 'local.counter-add', { counter: out('total', 'counter'), amount: out('dealt', 'value') }),
            ] },
          ] })
          statements.push(
            call('hit-count', 'local.counter-read', { counter: out('hits', 'counter') }),
            call('damage-total', 'local.counter-read', { counter: out('total', 'counter') }),
            call('hits-text', 'text.from-number', { value: out('hit-count', 'value') }),
            call('damage-text', 'text.from-number', { value: out('damage-total', 'value') }),
          )
          statements.push(...result('hit-result', literal(true), messageChain(statements, 'hit-message', [out('source-name', 'text'), literal('的速射能量炮命中'), out('target-name', 'text'), literal('，进行'), out('hits-text', 'text'), literal('次射击并造成'), out('damage-text', 'text'), literal('点伤害')])))
          return statements
        })(),
      },
      call('is-terrain', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('terrain') }),
      { kind: 'if', id: 'terrain-event', condition: out('is-terrain', 'value'), then: [
        call('blocked', 'projectile.event-blocks', { event: input('event') }),
        { kind: 'if', id: 'terrain-blocked', condition: out('blocked', 'blocks'), then: (() => { const terrain: GameplayStatement[] = [call('source-name-terrain', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' })]; terrain.push(...result('terrain-blocked-result', literal(true), messageChain(terrain, 'terrain-message', [out('source-name-terrain', 'text'), literal('的速射能量炮被地形阻挡')]))); return terrain })() },
      ] },
    ],
  })
  body.push(call('source-name-miss', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }))
  body.push(...result('miss', literal(true), messageChain(body, 'miss-message', [out('source-name-miss', 'text'), literal('的速射能量炮未命中敌人')])))
  return skillGraph(body, [{ id: 'max-speed-shot-recast@1', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'visible', type: 'boolean' }, { name: 'stacking', type: 'string' },
    { name: 'turnNumber', type: 'number' }, { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' }, { name: 'remainingUses', type: 'number' },
  ] }])
}

function buildBlackwidowLethalStrikeGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  cellSelection(body, 99, 'all')
  body.push(
    call('line', 'projectile.trace', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 99 }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('必须选择与自己在同一行或同一列的格子')) },
    { kind: 'if', id: 'same-cell', condition: out('line', 'sameCell'), then: result('same-cell-result', literal(false), literal('不能选择自身所在格')) },
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
  )
  body.push({
    kind: 'foreach', id: 'events', items: out('line', 'events'), item: 'event', body: [
      call('kind', 'projectile.event-kind', { event: input('event') }),
      call('is-piece', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('piece') }),
      {
        kind: 'if', id: 'piece-event', condition: out('is-piece', 'value'), then: (() => {
          const statements: GameplayStatement[] = [
            call('hit-target', 'projectile.event-piece', { event: input('event') }),
            call('target-name', 'attribute.text', { piece: out('hit-target', 'piece') }, { attribute: 'name' }),
            call('friendly', 'query.same-relation', { source: out('source', 'piece'), target: out('hit-target', 'piece') }, { relation: 'ally' }),
          ]
          const friendly: GameplayStatement[] = []
          friendly.push(...result('friendly-result', literal(true), messageChain(friendly, 'friendly-message', [out('source-name', 'text'), literal('释放致命射线，但被'), out('target-name', 'text'), literal('阻挡')])))
          statements.push({ kind: 'if', id: 'friendly-block', condition: out('friendly', 'value'), then: friendly })
          statements.push(
            call('distance', 'projectile.event-distance', { event: input('event') }),
            call('distance-factor', 'math.multiply', { left: out('distance', 'distance'), right: literal(0.1) }),
            call('multiplier', 'math.add', { left: literal(1), right: out('distance-factor', 'value') }),
            call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
            call('scaled', 'math.multiply', { left: out('attack', 'value'), right: out('multiplier', 'value') }),
            call('damage-value', 'math.floor', { value: out('scaled', 'value') }),
            call('applied', 'effect.damage', { source: out('source', 'piece'), target: out('hit-target', 'piece'), amount: out('damage-value', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'blackwidow-lethal-strike', inputPolicy: 'host' }),
            call('damage-text', 'text.from-number', { value: out('applied', 'damage') }),
            call('distance-text', 'text.from-number', { value: out('distance', 'distance') }),
          )
          statements.push(...result('hit-result', literal(true), messageChain(statements, 'hit-message', [out('source-name', 'text'), literal('对'), out('target-name', 'text'), literal('造成'), out('damage-text', 'text'), literal('点伤害（距离'), out('distance-text', 'text'), literal('格）')])))
          return statements
        })(),
      },
      call('is-terrain', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('terrain') }),
      { kind: 'if', id: 'terrain-event', condition: out('is-terrain', 'value'), then: [
        call('blocked', 'projectile.event-blocks', { event: input('event') }),
        { kind: 'if', id: 'terrain-blocked', condition: out('blocked', 'blocks'), then: (() => { const terrain: GameplayStatement[] = [call('terrain-source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' })]; terrain.push(...result('terrain-blocked-result', literal(true), messageChain(terrain, 'terrain-message', [out('terrain-source-name', 'text'), literal('释放致命射线，但被地形阻挡')]))); return terrain })() },
      ] },
    ],
  })
  body.push(...result('miss', literal(true), messageChain(body, 'miss-message', [out('source-name', 'text'), literal('释放致命射线，但路径上没有命中敌人')])))
  return skillGraph(body)
}

function buildGrimmjowPantherClawGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  pieceSelection(body, 4, 'enemy')
  body.push(
    call('saved-source', 'source.capture', { source: out('source', 'piece') }),
    call('saved-target', 'source.capture', { source: out('target', 'piece') }),
    call('hits', 'local.counter-create', { initial: literal(0) }),
    call('total', 'local.counter-create', { initial: literal(0) }),
  )
  body.push({ kind: 'foreach', id: 'claw-sequence', items: literal([0, 1, 2, 3, 4]), item: 'claw', body: [
    call('target-hp', 'source.captured-number', { source: out('saved-target', 'source') }, { field: 'currentHp' }),
    call('target-alive', 'compare.greater-than', { left: out('target-hp', 'value'), right: literal(0) }),
    call('source-hp', 'source.captured-number', { source: out('saved-source', 'source') }, { field: 'currentHp' }),
    call('source-alive', 'compare.greater-than', { left: out('source-hp', 'value'), right: literal(0) }),
    call('source-exists', 'query.has-piece', { pieceId: out('source', 'piece') }),
    call('target-exists', 'query.has-piece', { pieceId: out('target', 'piece') }),
    call('both-exist', 'logic.and', { left: out('source-exists', 'exists'), right: out('target-exists', 'exists') }),
    call('both-alive', 'logic.and', { left: out('source-alive', 'value'), right: out('target-alive', 'value') }),
    call('can-hit', 'logic.and', { left: out('both-exist', 'value'), right: out('both-alive', 'value') }),
    { kind: 'if', id: 'hit-guard', condition: out('can-hit', 'value'), then: [
      call('current-attack', 'source.captured-number', { source: out('saved-source', 'source') }, { field: 'attack' }),
      call('scaled', 'math.multiply', { left: out('current-attack', 'value'), right: literal(0.75) }),
      call('amount', 'math.floor', { value: out('scaled', 'value') }),
      call('damage', 'effect.damage-captured', { source: out('saved-source', 'source'), target: out('saved-target', 'source'), amount: out('amount', 'value') }, { damageType: 'physical', skillId: 'grimmjow-panther-claw' }),
      call('dealt', 'effect.result-number', { result: out('damage', 'result') }, { field: 'damage' }),
      call('count-hit', 'local.counter-add', { counter: out('hits', 'counter'), amount: literal(1) }),
      call('sum-damage', 'local.counter-add', { counter: out('total', 'counter'), amount: out('dealt', 'value') }),
    ] },
  ] })
  body.push(
    call('source-name', 'piece.captured-name', { source: out('saved-source', 'source') }),
    call('hits-value', 'local.counter-read', { counter: out('hits', 'counter') }),
    call('total-value', 'local.counter-read', { counter: out('total', 'counter') }),
    call('hits-text', 'text.from-number', { value: out('hits-value', 'value') }),
    call('total-text', 'text.from-number', { value: out('total-value', 'value') }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [out('source-name', 'value'), literal('以豹王之爪攻击'), out('hits-text', 'text'), literal('次，共造成'), out('total-text', 'text'), literal('点物理伤害')])))
  return skillGraph(body)
}

function buildIchigoGetsugaTenshoGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  cellSelection(body, 99, 'all')
  body.push(
    call('line', 'projectile.trace', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 99 }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('月牙天冲只能向同一行或同一列的方向发射')) },
    { kind: 'if', id: 'same-cell', condition: out('line', 'sameCell'), then: result('same-cell-result', literal(false), literal('月牙天冲只能向同一行或同一列的方向发射')) },
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
  )
  body.push({
    kind: 'foreach', id: 'events', items: out('line', 'events'), item: 'event', body: [
      call('kind', 'projectile.event-kind', { event: input('event') }),
      call('is-piece', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('piece') }),
      {
        kind: 'if', id: 'piece-event', condition: out('is-piece', 'value'), then: (() => {
          const statements: GameplayStatement[] = [
            call('hit-target', 'projectile.event-piece', { event: input('event') }),
            call('target-name', 'attribute.text', { piece: out('hit-target', 'piece') }, { attribute: 'name' }),
            call('friendly', 'query.same-relation', { source: out('source', 'piece'), target: out('hit-target', 'piece') }, { relation: 'ally' }),
          ]
          const friendly: GameplayStatement[] = []
          friendly.push(...result('friendly-result', literal(true), messageChain(friendly, 'friendly-message', [out('source-name', 'text'), literal('的月牙天冲被友方棋子阻挡')])))
          statements.push({ kind: 'if', id: 'friendly-block', condition: out('friendly', 'value'), then: friendly })
          statements.push(
            call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
            call('multiplier', 'skill.power-multiplier'),
            call('scaled', 'math.multiply', { left: out('attack', 'value'), right: out('multiplier', 'value') }),
            call('damage-value', 'math.floor', { value: out('scaled', 'value') }),
            call('applied', 'effect.damage', { source: out('source', 'piece'), target: out('hit-target', 'piece'), amount: out('damage-value', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'ichigo-getsuga-tensho', inputPolicy: 'host' }),
            call('damage-text', 'text.from-number', { value: out('applied', 'damage') }),
          )
          statements.push(...result('hit-result', literal(true), messageChain(statements, 'hit-message', [out('source-name', 'text'), literal('的月牙天冲命中'), out('target-name', 'text'), literal('，造成'), out('damage-text', 'text'), literal('点魔法伤害')])))
          return statements
        })(),
      },
      call('is-terrain', 'compare.equal-string', { left: out('kind', 'kind'), right: literal('terrain') }),
      { kind: 'if', id: 'terrain-event', condition: out('is-terrain', 'value'), then: [
        call('blocked', 'projectile.event-blocks', { event: input('event') }),
        { kind: 'if', id: 'terrain-blocked', condition: out('blocked', 'blocks'), then: (() => { const terrain: GameplayStatement[] = [call('terrain-source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' })]; terrain.push(...result('terrain-blocked-result', literal(true), messageChain(terrain, 'terrain-message', [out('terrain-source-name', 'text'), literal('的月牙天冲被地形阻挡')]))); return terrain })() },
      ] },
    ],
  })
  body.push(...result('miss', literal(true), messageChain(body, 'miss-message', [out('source-name', 'text'), literal('的月牙天冲未命中敌人')])))
  return skillGraph(body)
}

function buildShadowBoltGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('source', 'piece') }),
    call('fragments', 'query.hand-card-instances', { player: out('owner', 'player') }, { cardId: 'soul-fragment' }),
    call('fragment-count', 'list.count', { items: out('fragments', 'cards') }),
  ]
  cellSelection(body, 99, 'all')
  body.push(
    call('line', 'projectile.line-cells', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 99, clipToBoard: false }),
    { kind: 'if', id: 'same-cell', condition: out('line', 'sameCell'), then: result('invalid-target', literal(false), literal('无效目标')) },
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('必须选择同一行或同一列的格子')) },
    call('enemies', 'query.faction-enemies-on-cells', { source: out('source', 'piece'), cells: out('line', 'cells') }),
    call('enemy-names', 'query.piece-names', { pieces: out('enemies', 'pieces') }),
    call('enemy-name-text', 'text.join-list', { items: out('enemy-names', 'names') }, { separator: '、' }),
    {
      kind: 'foreach', id: 'discard-fragments', items: out('fragments', 'cards'), item: 'fragment', body: [
        call('discard', 'card.discard-instance', { card: input('fragment') }),
      ],
    },
    call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
    call('damage-value', 'math.add', { left: out('attack', 'value'), right: out('fragment-count', 'count') }),
    {
      kind: 'foreach', id: 'damage-enemies', items: out('enemies', 'pieces'), item: 'enemy', body: [
        call('damage', 'effect.damage', { source: out('source', 'piece'), target: input('enemy'), amount: out('damage-value', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'shadow-bolt', inputPolicy: 'host' }),
      ],
    },
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('fragment-text', 'text.from-number', { value: out('fragment-count', 'count') }),
    call('damage-text', 'text.from-number', { value: out('damage-value', 'value') }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [
    out('source-name', 'text'), literal('释放暗影箭，弃置'), out('fragment-text', 'text'), literal('个灵魂残片，对'),
    out('enemy-name-text', 'text'), literal('造成'), out('damage-text', 'text'), literal('点伤害'),
  ])))
  return skillGraph(body)
}

function buildShadowChaosSpearGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
  ]
  pieceSelection(body, 4, 'enemy')
  body.push(
    call('stolen', 'status.has-piece', { piece: out('source', 'piece') }, { statusType: 'chaos-spear-theft' }),
    { kind: 'if', id: 'stolen-guard', condition: out('stolen', 'value'), then: result('stolen-result', literal(false), literal('混沌之矛的移速偷取尚未归还')) },
    call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
    call('scaled', 'math.multiply', { left: out('attack', 'value'), right: literal(0.5) }),
    call('damage-value', 'math.floor', { value: out('scaled', 'value') }),
    call('damage', 'effect.damage', { source: out('source', 'piece'), target: out('target', 'piece'), amount: out('damage-value', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'shadow-chaos-spear', inputPolicy: 'host' }),
    call('slow', 'attribute.adjust', { piece: out('target', 'piece'), amount: literal(-2) }, { attribute: 'moveRange' }),
    call('haste', 'attribute.adjust', { piece: out('source', 'piece'), amount: literal(2) }, { attribute: 'moveRange' }),
    call('source-id', 'piece.identifier', { piece: out('source', 'piece') }),
    call('target-id', 'piece.identifier', { piece: out('target', 'piece') }),
    call('id-prefix', 'text.concat', { left: literal('chaos-spear-theft-'), right: out('source-id', 'id') }),
    call('target-suffix', 'text.concat', { left: literal('-'), right: out('target-id', 'id') }),
    call('status-id', 'text.concat', { left: out('id-prefix', 'text'), right: out('target-suffix', 'text') }),
    {
      kind: 'record.create', id: 'theft-record', schema: 'shadow-chaos-spear-theft@1', fields: {
        id: out('status-id', 'text'), type: literal('chaos-spear-theft'), name: literal('混沌之矛'),
        targetId: out('target-id', 'id'), intensity: literal(2), currentDuration: literal(-1),
        relatedRules: literal(['rule-shadow-chaos-spear-restore']),
      },
    },
    call('apply-theft', 'status.apply-record', { target: out('source', 'piece'), record: out('theft-record', 'value') }, { inputPolicy: 'host' }),
    call('restore-rule', 'rule.apply-piece', { target: out('source', 'piece') }, { ruleId: 'rule-shadow-chaos-spear-restore' }),
    call('damage-text', 'text.from-number', { value: out('damage', 'damage') }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [literal('造成'), out('damage-text', 'text'), literal('点伤害并偷取2点移动范围')])))
  return skillGraph(body, [{ id: 'shadow-chaos-spear-theft@1', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' },
    { name: 'targetId', type: 'string' }, { name: 'intensity', type: 'number' }, { name: 'currentDuration', type: 'number' },
    { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
  ] }])
}

function buildSasukeChidoriGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
  ]
  cellSelection(body, 6, 'all')
  body.push(
    call('line', 'projectile.line-cells', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 6, clipToBoard: false }),
    { kind: 'if', id: 'invalid-direction', condition: out('line', 'valid'), then: [], else: result('invalid-direction-result', literal(false), literal('千鸟只能冲刺至同一行或同一列的格子')) },
    { kind: 'if', id: 'invalid-distance', condition: out('line', 'sameCell'), then: result('invalid-distance-result', literal(false), literal('目标距离必须在1-6格内')) },
    call('too-far', 'compare.greater-than', { left: out('line', 'distance'), right: literal(6) }),
    { kind: 'if', id: 'too-far-guard', condition: out('too-far', 'value'), then: result('too-far-result', literal(false), literal('目标距离必须在1-6格内')) },
    call('walkable', 'spatial.cell-walkable-safe', { cell: out('target', 'cell') }),
    call('unoccupied', 'spatial.cell-unoccupied', { cell: out('target', 'cell') }),
  )
  body.push(
    call('not-walkable', 'logic.not', { value: out('walkable', 'value') }),
    { kind: 'if', id: 'not-walkable-guard', condition: out('not-walkable', 'value'), then: result('not-walkable-result', literal(false), literal('目标格不可行走')) },
    call('occupied', 'logic.not', { value: out('unoccupied', 'value') }),
    { kind: 'if', id: 'occupied-guard', condition: out('occupied', 'value'), then: result('occupied-result', literal(false), literal('目标位置已有棋子')) },
    call('enemies', 'projectile.trace-enemies', { source: out('source', 'piece'), target: out('target', 'cell') }, { maxDistance: 6 }),
    call('move', 'effect.displace', { piece: out('source', 'piece'), destination: out('target', 'cell') }, { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'any' }),
    call('move-failed', 'logic.not', { value: out('move', 'success') }),
    { kind: 'if', id: 'move-blocked', condition: out('move-failed', 'value'), then: result('move-blocked-result', literal(true), literal('位移被阻挡，本次位移效果取消')) },
    call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
    call('multiplier', 'skill.power-multiplier'),
    call('scaled', 'math.multiply', { left: out('attack', 'value'), right: out('multiplier', 'value') }),
    call('damage-value', 'math.floor', { value: out('scaled', 'value') }),
    call('enemy-count', 'collection.piece-count', { pieces: out('enemies', 'pieces') }),
    call('has-enemies', 'compare.greater-than', { left: out('enemy-count', 'value'), right: literal(0) }),
  )
  body.push({
    kind: 'if', id: 'damage-enemies', condition: out('has-enemies', 'value'), then: [
      call('damage', 'effect.damage-many', { source: out('source', 'piece'), targets: out('enemies', 'pieces'), amount: out('damage-value', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'sasuke-chidori' }),
      {
        kind: 'foreach', id: 'apply-immobile', items: out('enemies', 'pieces'), item: 'enemy', body: [
          call('alive', 'piece.alive', { piece: input('enemy') }),
          { kind: 'if', id: 'alive-guard', condition: out('alive', 'alive'), then: (() => {
            const statements: GameplayStatement[] = [
              call('existing', 'status.has-piece', { piece: input('enemy') }, { statusType: 'chidori-immobile' }),
            ]
            statements.push({ kind: 'if', id: 'refresh-existing', condition: out('existing', 'value'), then: [
              call('status-id', 'status.find-id', { piece: input('enemy') }, { statusType: 'chidori-immobile' }),
              call('refresh-current', 'status.set-record-number', { piece: input('enemy'), statusId: out('status-id', 'id'), value: literal(1) }, { field: 'currentDuration' }),
              call('refresh-remaining', 'status.set-record-number', { piece: input('enemy'), statusId: out('status-id', 'id'), value: literal(1) }, { field: 'remainingDuration' }),
            ], else: [
              call('enemy-id', 'piece.identifier', { piece: input('enemy') }),
              call('status-prefix', 'text.concat', { left: literal('chidori-immobile-'), right: out('enemy-id', 'id') }),
              { kind: 'record.create', id: 'immobile-record', schema: 'chidori-immobile@1', fields: {
                id: out('status-prefix', 'text'), name: literal('被千鸟贯穿'), type: literal('chidori-immobile'), currentDuration: literal(1), remainingDuration: literal(1),
                currentUses: literal(-1), intensity: literal(1), stacks: literal(1), relatedRules: literal(['rule-chidori-immobile']),
              } },
              call('apply-immobile-status', 'status.apply-record', { target: input('enemy'), record: out('immobile-record', 'value') }, { inputPolicy: 'host' }),
              call('apply-immobile-rule', 'rule.apply-piece', { target: input('enemy') }, { ruleId: 'rule-chidori-immobile' }),
            ] })
            return statements
          })(),
          },
        ],
      },
    ],
  })
  body.push(
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('target-x', 'spatial.cell-coordinates', { cell: out('target', 'cell') }),
    call('target-x-text', 'text.from-number', { value: out('target-x', 'x') }),
    call('target-y-text', 'text.from-number', { value: out('target-x', 'y') }),
    call('enemy-count-text', 'text.from-number', { value: out('enemy-count', 'value') }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [
    out('source-name', 'text'), literal('发动千鸟，冲刺至('), out('target-x-text', 'text'), literal(','), out('target-y-text', 'text'), literal(')并贯穿'), out('enemy-count-text', 'text'), literal('名敌人'),
  ])))
  return skillGraph(body, [{ id: 'chidori-immobile@1', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'type', type: 'string' },
    { name: 'currentDuration', type: 'number' }, { name: 'remainingDuration', type: 'number' }, { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' }, { name: 'stacks', type: 'number' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
  ] }])
}

function buildNarutoRasenganGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
  ]
  pieceSelection(body, 2, 'enemy')
  body.push(
    call('target-alive', 'piece.alive', { piece: out('target', 'piece') }),
    call('dead-target', 'logic.not', { value: out('target-alive', 'alive') }),
    { kind: 'if', id: 'dead-target-guard', condition: out('dead-target', 'value'), then: result('dead-target-result', literal(false), literal('目标已死亡')) },
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
    call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
    call('damage-value', 'math.multiply', { left: out('attack', 'value'), right: literal(2) }),
    call('damage', 'effect.damage-without-skill-id', { source: out('source', 'piece'), target: out('target', 'piece'), amount: out('damage-value', 'value') }, { damageType: 'physical' }),
    call('damage-text', 'text.from-number', { value: out('damage-value', 'value') }),
    call('killed-target', 'effect.result-killed', { result: out('damage', 'result') }),
  )
  const killStatements: GameplayStatement[] = []
  killStatements.push(...result('kill-result', literal(true), messageChain(killStatements, 'kill-message', [
    out('source-name', 'text'), literal('对'), out('target-name', 'text'), literal('释放螺旋手里剑，造成'), out('damage-text', 'text'), literal('点伤害'),
  ])))
  body.push({ kind: 'if', id: 'killed-target-guard', condition: out('killed-target', 'killed'), then: killStatements })
  body.push(
    call('target-id', 'piece.identifier', { piece: out('target', 'piece') }),
    call('silenced-id', 'text.concat', { left: literal('silenced-'), right: out('target-id', 'id') }),
    { kind: 'record.create', id: 'silenced-record', schema: 'silenced@1', fields: {
      id: out('silenced-id', 'text'),
      type: literal('silenced'), name: literal('沉默'), visible: literal(true), remainingDuration: literal(1), remainingUses: literal(-1), intensity: literal(1), stacks: literal(1), relatedRules: literal(['rule-silenced-block']),
    } },
    call('apply-silenced', 'status.apply-record', { target: out('target', 'piece'), record: out('silenced-record', 'value') }, { inputPolicy: 'host' }),
    call('apply-silenced-rule', 'rule.apply-piece', { target: out('target', 'piece') }, { ruleId: 'rule-silenced-block' }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [out('source-name', 'text'), literal('对'), out('target-name', 'text'), literal('释放螺旋手里剑，造成'), out('damage-text', 'text'), literal('点伤害并沉默1回合')])))
  return skillGraph(body, [{ id: 'silenced@1', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'visible', type: 'boolean' },
    { name: 'remainingDuration', type: 'number' }, { name: 'remainingUses', type: 'number' }, { name: 'intensity', type: 'number' }, { name: 'stacks', type: 'number' },
    { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
  ] }])
}

function buildAizenBlackCoffinGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
  ]
  pieceSelection(body, 5, 'enemy')
  body.push(
    call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }),
    call('scaled', 'math.multiply', { left: out('attack', 'value'), right: literal(1.5) }),
    call('damage-value', 'math.floor', { value: out('scaled', 'value') }),
    call('damage', 'effect.damage', { source: out('source', 'piece'), target: out('target', 'piece'), amount: out('damage-value', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'aizen-black-coffin', inputPolicy: 'host' }),
    call('killed', 'effect.result-killed', { result: out('damage', 'result') }),
    call('living', 'logic.not', { value: out('killed', 'killed') }),
    {
      kind: 'if', id: 'apply-coffin', condition: out('living', 'value'), then: [
        call('source-id', 'piece.identifier', { piece: out('source', 'piece') }),
        call('target-id', 'piece.identifier', { piece: out('target', 'piece') }),
        call('coffin-prefix', 'text.concat', { left: literal('aizen-black-coffin-'), right: out('source-id', 'id') }),
        call('coffin-target-suffix', 'text.concat', { left: literal('-'), right: out('target-id', 'id') }),
        call('coffin-id', 'text.concat', { left: out('coffin-prefix', 'text'), right: out('coffin-target-suffix', 'text') }),
        call('root-prefix', 'text.concat', { left: literal('black-coffin-root-'), right: out('source-id', 'id') }),
        call('root-id', 'text.concat', { left: out('root-prefix', 'text'), right: out('coffin-target-suffix', 'text') }),
        { kind: 'record.create', id: 'coffin-record', schema: 'aizen-black-coffin@1', fields: {
          id: out('coffin-id', 'text'), type: literal('aizen-black-coffin'), name: literal('黑棺'), visible: literal(true), currentDuration: literal(1), currentUses: literal(1), stacks: literal(1), sourceId: out('source-id', 'id'), delayedDamage: out('damage-value', 'value'), relatedRules: literal(['rule-aizen-black-coffin-end']),
        } },
        call('apply-coffin-status', 'status.apply-record', { target: out('target', 'piece'), record: out('coffin-record', 'value') }, { inputPolicy: 'host' }),
        { kind: 'record.create', id: 'root-record', schema: 'root@1', fields: {
          id: out('root-id', 'text'), type: literal('root'), name: literal('定身'), currentDuration: literal(1),
        } },
        call('apply-root', 'status.apply-record', { target: out('target', 'piece'), record: out('root-record', 'value') }, { inputPolicy: 'host' }),
        call('apply-coffin-rule', 'rule.apply-piece', { target: out('target', 'piece') }, { ruleId: 'rule-aizen-black-coffin-end' }),
      ],
    },
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('damage-text', 'text.from-number', { value: out('damage', 'damage') }),
  )
  body.push(...result('success', literal(true), messageChain(body, 'success-message', [out('source-name', 'text'), literal('以黑棺造成'), out('damage-text', 'text'), literal('点魔法伤害')])))
  return skillGraph(body, [
    { id: 'aizen-black-coffin@1', version: '1', fields: [
      { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'visible', type: 'boolean' },
      { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' }, { name: 'stacks', type: 'number' }, { name: 'sourceId', type: 'string' },
      { name: 'delayedDamage', type: 'number' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
    ] },
    { id: 'root@1', version: '1', fields: [
      { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'currentDuration', type: 'number' },
    ] },
  ])
}

export function buildProjectileSkillGraph(id: string): GameplayModuleGraph {
  switch (id) {
    case 'sleep-dart': return buildSleepDartGraph()
    case 'colt-revolver': return buildColtRevolverGraph()
    case 'colt-bullet-storm': return buildColtBulletStormGraph()
    case 'max-speed-shot': return buildMaxSpeedShotGraph()
    case 'blackwidow-lethal-strike': return buildBlackwidowLethalStrikeGraph()
    case 'grimmjow-panther-claw': return buildGrimmjowPantherClawGraph()
    case 'ichigo-getsuga-tensho': return buildIchigoGetsugaTenshoGraph()
    case 'colt-piercing': return buildColtPiercingGraph()
    case 'hand-cannon': return buildHandCannonGraph()
    case 'pulse-pistol': return buildPulsePistolGraph()
    case 'hellfire-shotgun': return buildHellfireShotgunGraph()
    case 'shelly-shotgun': return buildShellyShotgunGraph()
    case 'shelly-super-shell': return buildShellySuperShellGraph()
    case 'shadow-bolt': return buildShadowBoltGraph()
    case 'shadow-chaos-spear': return buildShadowChaosSpearGraph()
    case 'sasuke-chidori': return buildSasukeChidoriGraph()
    case 'naruto-rasengan': return buildNarutoRasenganGraph()
    case 'aizen-black-coffin': return buildAizenBlackCoffinGraph()
    default: throw new Error('Unknown projectile skill ' + id)
  }
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)

function canonical(value: unknown): string { return JSON.stringify(value) }

/**
 * The production snapshot can already contain the legacy content-graph
 * compiler output (or a module-owned preview entry) before this executable
 * migration runs.  The frozen fixture remains the behavior source for the
 * graph below; generated author output is accepted only as an existing,
 * explicitly marked artifact so a hand-edited executable still fails closed.
 */
function assertProjectileSource(current: JsonRecord, original: JsonRecord, id: string, surface: 'skill' | 'triggerSkill'): void {
  try {
    assertFrozenExecutable(current, original, 'code', surface, id)
    return
  } catch (error) {
    const hasLegacyGraph = isRecord(current.contentGraph) && current.contentGraphField === 'code' && current.contentGraphCompilerVersion === 'rvb-content-graph-compiler/v1'
    const modules = isRecord(current.gameplayModules) && isRecord(current.gameplayModules.entries) ? current.gameplayModules.entries : undefined
    const hasModulePreview = isRecord(modules?.previewCode)
    if (typeof current.code === 'string' && (hasLegacyGraph || hasModulePreview)) return
    throw error
  }
}

export function migrateProjectileSkills(root: string, write = false, refresh = false): string[] {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')) as { entries: Record<string, JsonRecord> }
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { id: string; file: string; next: JsonRecord }[] = []
  for (const id of PROJECTILE_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
    const modules = isRecord(current.gameplayModules) && isRecord(current.gameplayModules.entries) ? current.gameplayModules : undefined
    const existingGraph = modules && isRecord(modules.entries) && isRecord(modules.entries.code) ? canonical(modules.entries.code.graph) : ''
    const refreshNeeded = refresh || existingGraph.includes('effect.damage-repeated')
    if (modules && isRecord(modules.entries) && modules.entries.code && !refreshNeeded) {
      assertGameplayModuleDocument(current)
      continue
    }
    if (modules && isRecord(modules.entries) && modules.entries.code && refreshNeeded) {
      const next = applyGameplayModuleGraph(current, buildProjectileSkillGraph(id)) as JsonRecord
      assertGameplayModuleDocument(next)
      if (canonical(next.code) !== canonical(current.code) || canonical(next.gameplayModules) !== canonical(current.gameplayModules)) pending.push({ id, file, next })
      continue
    }
    const original = fixture.entries['skills/' + id]
    if (original) {
      assertProjectileSource(current, original, id, id === 'pulse-pistol' ? 'triggerSkill' : 'skill')
      for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && canonical(original[key]) !== canonical(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    } else if (id !== 'hand-cannon') {
      throw new Error(`${id}: missing frozen baseline`)
    } else if (typeof current.code !== 'string') {
      throw new Error(`${id}: missing production executable`)
    }
    const graph = buildProjectileSkillGraph(id)
    const next = applyGameplayModuleGraph(current, graph) as JsonRecord
    assertGameplayModuleDocument(next)
    pending.push({ id, file, next })
  }
  // Every candidate is fully validated before any production file is written.
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return pending.map(item => item.id)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(migrateProjectileSkills(process.cwd(), process.argv.includes('--write'), process.argv.includes('--refresh'))))
}
