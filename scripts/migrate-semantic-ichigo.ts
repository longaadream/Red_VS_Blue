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

/**
 * RED-252 Ichigo migration.
 *
 * The skill and rule graphs below own ordering, guards, messages, and the
 * continuation payload.  The registered descriptors only expose closed
 * projectile, damage, position, and marker capabilities.
 */
export const ICHIGO_IDS = [
  'ichigo-bankai-tensa-zangetsu',
  'ichigo-black-getsuga-tensho',
  'rule-ichigo-black-getsuga-teleport',
] as const

type IchigoId = typeof ICHIGO_IDS[number]

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const branch = (
  id: string,
  condition: GameplayValue,
  then: readonly GameplayStatement[],
  otherwise: readonly GameplayStatement[] = [],
): GameplayStatement => ({ kind: 'if', id, condition, then, else: otherwise })
const recordGet = (id: string, record: GameplayValue, field: string): GameplayStatement => ({
  kind: 'record.get',
  id,
  record,
  field,
})
const recordCreate = (id: string, schema: string, fields: Record<string, GameplayValue>): GameplayStatement => ({
  kind: 'record.create',
  id,
  schema,
  fields,
})
const result = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] => [
  call(id, 'result.action', { success, message }),
  { kind: 'return', id: id + '-return', value: output(id, 'result') },
]
const failure = (id: string, message = ''): GameplayStatement[] => result(id, literal(false), literal(message))
const success = (id: string, message = ''): GameplayStatement[] => result(id, literal(true), literal(message))

const BANKAI_STATUS_SCHEMA: GameplayRecordSchema = {
  id: 'ichigo-bankai-status@1',
  version: '1',
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

const TELEPORT_PAYLOAD_SCHEMA: GameplayRecordSchema = {
  id: 'ichigo-black-getsuga-teleport-payload@1',
  version: '1',
  fields: [{ name: 'sourcePieceId', type: 'piece' }],
}

const RESULT_OUTPUTS = [{ name: 'result', type: 'record' as const, nullable: true }]

function messageChain(id: string, parts: readonly GameplayValue[]): { statements: GameplayStatement[]; value: GameplayValue } {
  const statements: GameplayStatement[] = []
  let value = parts[0] ?? literal('')
  parts.slice(1).forEach((right, index) => {
    const node = id + '-' + index
    statements.push(call(node, 'text.concat', { left: value, right }))
    value = output(node, 'text')
  })
  return { statements, value }
}

function buildBankaiGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('active', 'status.has-piece', { piece: output('holder', 'piece') }, { statusType: 'ichigo-bankai' }),
    branch('already-active', output('active', 'value'), failure('already-active-result', '卍解·天锁斩月每局只能使用一次')),
    call('attack-up', 'attribute.adjust', { piece: output('holder', 'piece'), amount: literal(1) }, { attribute: 'attack' }),
    call('move-up', 'attribute.adjust', { piece: output('holder', 'piece'), amount: literal(2) }, { attribute: 'moveRange' }),
    call('owner', 'piece.owner', { piece: output('holder', 'piece') }),
    call('player-exists', 'query.has-player', { playerId: output('owner', 'player') }),
    branch('player-check', output('player-exists', 'exists'), [
      call('action-point', 'resource.adjust', { player: output('owner', 'player'), amount: literal(1) }, { resource: 'actionPoints' }),
    ]),
    call('remove-getsuga', 'skill.remove', { piece: output('holder', 'piece') }, { skillId: 'ichigo-getsuga-tensho' }),
    call('remove-bankai', 'skill.remove', { piece: output('holder', 'piece') }, { skillId: 'ichigo-bankai-tensa-zangetsu' }),
    call('add-black-getsuga', 'skill.add', { piece: output('holder', 'piece') }, { skillId: 'ichigo-black-getsuga-tensho' }),
    call('holder-id', 'piece.identifier', { piece: output('holder', 'piece') }),
    call('status-id', 'text.concat', { left: literal('ichigo-bankai-'), right: output('holder-id', 'id') }),
    recordCreate('status', BANKAI_STATUS_SCHEMA.id, {
      id: output('status-id', 'text'),
      name: literal('卍解·天锁斩月'),
      type: literal('ichigo-bankai'),
      currentDuration: literal(-1),
      currentUses: literal(-1),
      intensity: literal(1),
      stacks: literal(1),
    }),
    call('apply-status', 'status.apply-record', { target: output('holder', 'piece'), record: output('status', 'value') }, { inputPolicy: 'host' }),
  ]
  // Keep the source wording and only read the name through the closed text
  // primitive.  The branch above deliberately updates the state before the
  // message, just like the frozen executable.
  body.push(
    call('holder-name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
  )
  const message = messageChain('bankai-message', [
    output('holder-name', 'text'),
    literal('发动卍解·天锁斩月，攻击力+1、移动值+2并获得1点临时行动点'),
  ])
  body.push(...message.statements, ...result('success', literal(true), message.value))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [BANKAI_STATUS_SCHEMA],
    outputs: RESULT_OUTPUTS,
    body,
  }
}

function buildBlackGetsugaGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('clear-old-marker', 'extension.clear-piece-cells', { owner: output('holder', 'piece') }, { key: 'ichigoBlackGetsugaTeleportByCaster' }),
    call('choice', 'choice.target-cell', {}, { range: 99, filter: 'all' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
    branch('return-selection', output('unresolved', 'value'), [
      call('selection-result', 'choice.as-result', { choice: output('choice', 'choice') }),
      { kind: 'return', id: 'selection-result-return', value: output('selection-result', 'result') },
    ]),
    call('target', 'choice.cell', { choice: output('choice', 'choice') }),
    call('line', 'projectile.trace-until-blocker', { source: output('holder', 'piece'), target: output('target', 'cell') }, { maxDistance: 99 }),
    branch('invalid-direction', output('line', 'sameCell'), failure('same-cell', '黑色月牙天冲只能向同一行或同一列的方向发射')),
    branch('direction-check', output('line', 'valid'), [], failure('invalid-direction-result', '黑色月牙天冲只能向同一行或同一列的方向发射')),
    call('attack', 'attribute.read', { piece: output('holder', 'piece') }, { attribute: 'attack' }),
    call('multiplier', 'skill.power-multiplier'),
    call('damage-amount', 'math.multiply', { left: output('attack', 'value'), right: output('multiplier', 'value') }),
    call('damage-floor', 'math.floor', { value: output('damage-amount', 'value') }),
    call('damage', 'effect.damage-many-ordered', {
      source: output('holder', 'piece'),
      targets: output('line', 'enemyPieces'),
      amount: output('damage-floor', 'value'),
    }, { damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'ichigo-black-getsuga-tensho' }),
    call('enemy-count', 'list.count-pieces', { items: output('line', 'enemyPieces') }),
    call('enemy-count-text', 'text.from-number', { value: output('enemy-count', 'value') }),
    call('total-damage-text', 'text.from-number', { value: output('damage', 'totalDamage') }),
    call('holder-name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
  ]
  const hasEnemies: GameplayStatement[] = [
    call('damage-message', 'text.concat', { left: output('holder-name', 'text'), right: literal('的黑色月牙天冲命中') }),
    call('damage-message-count', 'text.concat', { left: output('damage-message', 'text'), right: output('enemy-count-text', 'text') }),
    call('damage-message-targets', 'text.concat', { left: output('damage-message-count', 'text'), right: literal('名敌人，造成共') }),
    call('damage-message-total', 'text.concat', { left: output('damage-message-targets', 'text'), right: output('total-damage-text', 'text') }),
    call('damage-message-final', 'text.concat', { left: output('damage-message-total', 'text'), right: literal('点魔法伤害') }),
    call('holder-alive', 'piece.alive', { piece: output('holder', 'piece') }),
    branch('holder-alive-check', output('holder-alive', 'alive'), [
      call('adjacent', 'spatial.adjacent-cells-ordered', { center: output('line', 'firstCell') }),
      {
        kind: 'collection',
        id: 'landing-candidates',
        method: 'filter',
        items: output('adjacent', 'cells'),
        inputs: { source: output('holder', 'piece') },
        item: 'cell',
        body: [
          call('walkable', 'spatial.cell-walkable-safe', { cell: input('cell') }),
          call('unoccupied', 'spatial.cell-unoccupied', { cell: input('cell'), ignore: input('source') }),
          call('candidate', 'logic.and', { left: output('walkable', 'value'), right: output('unoccupied', 'value') }),
          { kind: 'return', id: 'landing-candidate-return', value: output('candidate', 'value') },
        ],
      },
      call('landing-count', 'list.count-cells', { items: output('landing-candidates', 'value') }),
      call('has-landing', 'compare.greater-than', { left: output('landing-count', 'value'), right: literal(0) }),
      branch('landing-check', output('has-landing', 'value'), [
        call('save-landing', 'extension.set-piece-cells', { owner: output('holder', 'piece'), cells: output('landing-candidates', 'value') }, { key: 'ichigoBlackGetsugaTeleportByCaster' }),
        ...result('hit', literal(true), output('damage-message-final', 'text')),
      ], [
        call('no-landing-message', 'text.concat', { left: output('damage-message-final', 'text'), right: literal('，首个目标附近没有合法空格') }),
        ...result('hit-no-landing', literal(true), output('no-landing-message', 'text')),
      ]),
    ], [
      ...result('hit-source-gone', literal(true), output('damage-message-final', 'text')),
    ]),
  ]
  const noEnemies: GameplayStatement[] = [
    call('miss-message', 'text.concat', { left: output('holder-name', 'text'), right: literal('的黑色月牙天冲未命中敌人') }),
    ...result('miss', literal(true), output('miss-message', 'text')),
  ]
  body.push(
    call('has-enemies', 'compare.greater-than', { left: output('enemy-count', 'value'), right: literal(0) }),
    branch('enemy-check', output('has-enemies', 'value'), hasEnemies, noEnemies),
  )
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: RESULT_OUTPUTS,
    body,
  }
}

function clearMarkerBody(prefix: string): GameplayStatement[] {
  return [
    call(prefix + '-clear', 'extension.clear-piece-cells', { owner: output('source', 'piece') }, { key: 'ichigoBlackGetsugaTeleportByCaster' }),
    call(prefix + '-clean', 'extension.remove-empty-piece-store', {}, { key: 'ichigoBlackGetsugaTeleportByCaster' }),
  ]
}

function buildTeleportContinuation(): GameplayModuleGraph {
  const invalid = (prefix: string): GameplayStatement[] => [
    ...clearMarkerBody(prefix),
    ...failure(prefix + '-result', '黑色月牙天冲的传送落点已失效'),
  ]
  const cancelled: GameplayStatement[] = [
    ...clearMarkerBody('cancelled'),
    ...failure('cancelled-result'),
  ]
  const complete: GameplayStatement[] = [
    recordGet('source-id', input('payload'), 'sourcePieceId'),
    call('source', 'query.piece', { pieceId: output('source-id', 'value') }),
    call('source-alive', 'piece.alive', { piece: output('source', 'piece') }),
    call('cancelled', 'event.cancelled'),
    branch('cancelled-check', output('cancelled', 'value'), cancelled),
    branch('source-check', output('source-alive', 'alive'), [], invalid('invalid-source')),
    call('candidates', 'extension.read-piece-cells', { owner: output('source', 'piece') }, { key: 'ichigoBlackGetsugaTeleportByCaster' }),
    call('target', 'event.target-cell'),
    call('has-target', 'value.present-cell', { value: output('target', 'cell') }),
    branch('target-check', output('has-target', 'present'), [], invalid('invalid-target')),
    call('in-candidates', 'spatial.cell-in-list', { cell: output('target', 'cell'), cells: output('candidates', 'cells') }),
    call('walkable', 'spatial.cell-walkable-safe', { cell: output('target', 'cell') }),
    call('unoccupied', 'spatial.cell-unoccupied', { cell: output('target', 'cell'), ignore: output('source', 'piece') }),
    call('candidate-valid', 'logic.and', { left: output('in-candidates', 'value'), right: output('walkable', 'value') }),
    call('candidate-valid-2', 'logic.and', { left: output('candidate-valid', 'value'), right: output('unoccupied', 'value') }),
    branch('destination-check', output('candidate-valid-2', 'value'), [
      ...clearMarkerBody('land'),
      call('destination', 'spatial.cell-require', { cell: output('target', 'cell') }),
      call('move', 'effect.teleport', { piece: output('source', 'piece'), destination: output('destination', 'cell') }, { kind: 'teleport' }),
      call('source-name', 'piece.name-or', { piece: output('source', 'piece'), fallback: literal('黑崎一护') }),
      branch('move-check', output('move', 'success'), [
        call('moved-message', 'text.concat', { left: output('source-name', 'text'), right: literal('传送至首个目标身旁') }),
        ...result('moved-result', literal(true), output('moved-message', 'text')),
      ], failure('move-failed', '传送落点失效')),
    ], invalid('invalid-destination')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'pending',
    schemas: [TELEPORT_PAYLOAD_SCHEMA],
    hostBindings: {
      payload: { kind: 'record', schema: TELEPORT_PAYLOAD_SCHEMA.id },
      targetCell: { kind: 'nullable', value: 'cell' },
    },
    outputs: RESULT_OUTPUTS,
    body: complete,
  }
}

function buildTeleportRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('rule-piece-ref', 'ref.holder'),
    call('rule-piece', 'query.piece', { pieceId: output('rule-piece-ref', 'piece') }),
    call('source-ref', 'ref.source'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('skill-id', 'event.skill-id'),
    call('right-skill', 'compare.equal-string-nullable', { left: output('skill-id', 'value'), right: literal('ichigo-black-getsuga-tensho') }),
    call('same-piece', 'compare.equal-piece', { left: output('rule-piece', 'piece'), right: output('source', 'piece') }),
    call('eligible', 'logic.and', { left: output('right-skill', 'value'), right: output('same-piece', 'value') }),
    branch('eligible-check', output('eligible', 'value'), [], failure('ineligible')),
    call('candidates', 'extension.read-piece-cells', { owner: output('source', 'piece') }, { key: 'ichigoBlackGetsugaTeleportByCaster' }),
    call('candidate-count', 'list.count-cells', { items: output('candidates', 'cells') }),
    call('has-candidates', 'compare.greater-than', { left: output('candidate-count', 'value'), right: literal(0) }),
    branch('candidate-check', output('has-candidates', 'value'), [], failure('no-candidates')),
    call('source-owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('player', 'player.require', { player: output('source-owner', 'player') }),
    call('candidate-choices', 'choice.from-cells', { cells: output('candidates', 'cells') }),
    recordCreate('payload', TELEPORT_PAYLOAD_SCHEMA.id, { sourcePieceId: output('source', 'piece') }),
    {
      kind: 'defer-choice',
      id: 'teleport-choice',
      graph: 'ichigo-black-getsuga-teleport-complete',
      payload: output('payload', 'value'),
      player: output('player', 'player'),
      title: literal('选择黑色月牙天冲的传送落点'),
      targetType: literal('cell'),
      range: literal(99),
      filter: literal('all'),
      candidates: output('candidate-choices', 'choices'),
      selectionMode: literal('single'),
      min: literal(1),
      max: literal(1),
      canCancel: literal(true),
      resumeOnCancel: literal(true),
    },
    ...success('pending', ''),
  ]
  const continuation = buildTeleportContinuation()
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    schemas: [TELEPORT_PAYLOAD_SCHEMA],
    outputs: RESULT_OUTPUTS,
    body,
    continuations: [{ id: 'ichigo-black-getsuga-teleport-complete', version: '1', graph: continuation }],
  }
}

export function buildIchigoGraph(id: IchigoId): GameplayModuleGraph {
  if (id === 'ichigo-bankai-tensa-zangetsu') return buildBankaiGraph()
  if (id === 'ichigo-black-getsuga-tensho') return buildBlackGetsugaGraph()
  return buildTeleportRuleGraph()
}

type Document = Record<string, unknown>
type PendingWrite = { file: string; document: Document }

const GENERATED_KEYS = new Set([
  'code',
  'skillCode',
  'previewCode',
  'contentGraph',
  'contentGraphField',
  'contentGraphCompilerVersion',
  'contentGraphEntries',
  'gameplayModules',
  'cluster',
])

function hasGeneratedEntry(value: unknown, field: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = (value as Record<string, unknown>).entries
  return !!entries && typeof entries === 'object' && !Array.isArray(entries)
    && Object.prototype.hasOwnProperty.call(entries, field)
}

function assertCompatibility(current: Document, original: Document, id: string): void {
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
    if (!GENERATED_KEYS.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) {
      throw new Error(id + ': changed compatibility field ' + key)
    }
  }
}

const MIGRATIONS: readonly { id: IchigoId; file: string; field: 'code' | 'skillCode'; surface: 'skill' | 'rule' }[] = [
  { id: 'ichigo-bankai-tensa-zangetsu', file: 'data/skills/ichigo-bankai-tensa-zangetsu.json', field: 'code', surface: 'skill' },
  { id: 'ichigo-black-getsuga-tensho', file: 'data/skills/ichigo-black-getsuga-tensho.json', field: 'code', surface: 'skill' },
  { id: 'rule-ichigo-black-getsuga-teleport', file: 'data/rules/rule-ichigo-black-getsuga-teleport.json', field: 'skillCode', surface: 'rule' },
]

export function migrateIchigo(root: string, write = false): readonly string[] {
  const frozen = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Document>
  const pending: PendingWrite[] = []
  const migrated: string[] = []
  for (const migration of MIGRATIONS) {
    const file = path.join(root, migration.file)
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Document
    if (hasGeneratedEntry(current.gameplayModules, migration.field)) {
      assertGameplayModuleDocument(current)
      continue
    }
    const fixtureKey = migration.file.startsWith('data/skills/') ? 'skills/' + migration.id : 'rules/' + migration.id
    const original = frozen[fixtureKey]
    if (!original) throw new Error('missing frozen fixture ' + fixtureKey)
    assertFrozenExecutable(current, original, migration.field, migration.surface, migration.id)
    assertCompatibility(current, original, migration.id)
    const next = applyGameplayModuleGraph(current, buildIchigoGraph(migration.id), migration.field)
    assertGameplayModuleDocument(next)
    pending.push({ file, document: next })
    migrated.push(migration.id)
  }
  if (write) {
    for (const entry of pending) fs.writeFileSync(entry.file, JSON.stringify(entry.document, null, 2) + '\n')
  }
  return migrated
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const migrated = migrateIchigo(process.cwd(), process.argv.includes('--write'))
  process.stdout.write(JSON.stringify({ migrated }, null, 2) + '\n')
}
