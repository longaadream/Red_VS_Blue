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

export const RECALL_SKILL_IDS = [
  'recall',
  'recall-endturn-trigger',
  'recall-move-trigger',
  'recall-skill-trigger',
  'pulse-pistol-move',
] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })

const resultAction = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] => [
  call(id, 'result.action', { success, message }),
  { kind: 'return', id: `${id}-return`, value: output(id, 'result') },
]

const triggerResult = (id: string, success: GameplayValue, message?: GameplayValue): GameplayStatement => ({
  kind: 'return',
  id,
  values: message === undefined ? { success } : { success, message },
})

/**
 * The graph-facing Recall record is flat and typed.  The registry's storage
 * adapter may serialize this shape into the legacy nested `recallData` format,
 * but the author graph never treats that nested object as an opaque snapshot.
 */
export const RECALL_RECORD_SCHEMA: GameplayRecordSchema = {
  id: 'recall-record@1',
  version: '1',
  fields: [
    { name: 'pieceId', type: 'piece' },
    { name: 'ownerPlayerId', type: 'player' },
    { name: 'projectionVisibility', type: 'string' },
    { name: 'targetCount', type: 'number' },
    { name: 'actionCount', type: 'number' },
    { name: 'x', type: 'number' },
    { name: 'y', type: 'number' },
    { name: 'hp', type: 'number' },
    { name: 'shield', type: 'number', nullable: true, optional: true },
    { name: 'statusTags', type: { kind: 'list', element: 'record' }, nullable: true, optional: true },
    { name: 'buffs', type: { kind: 'list', element: 'record' }, nullable: true, optional: true },
    { name: 'debuffs', type: { kind: 'list', element: 'record' }, nullable: true, optional: true },
  ],
}

const recordGet = (id: string, record: GameplayValue, field: string): GameplayStatement => ({ kind: 'record.get', id, record, field })

const recordWith = (id: string, record: GameplayValue, fields: Record<string, GameplayValue>): GameplayStatement => ({ kind: 'record.with', id, record, fields })

function hasGeneratedCodeEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = (value as Record<string, unknown>).entries
  return !!entries && typeof entries === 'object' && !Array.isArray(entries)
    && Object.prototype.hasOwnProperty.call(entries, 'code')
}

function buildRecallSkillGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('piece-reference', 'recall.piece-reference', { piece: output('holder', 'piece') }),
    call('owner', 'piece.owner', { piece: output('holder', 'piece') }),
    call('selected-count', 'recall.selected-count'),
    call('minimum', 'compare.greater-or-equal', { left: output('selected-count', 'value'), right: literal(1) }),
    call('maximum', 'compare.less-or-equal', { left: output('selected-count', 'value'), right: literal(10) }),
    call('valid-count', 'logic.and', { left: output('minimum', 'value'), right: output('maximum', 'value') }),
    {
      kind: 'if',
      id: 'invalid-count',
      condition: output('valid-count', 'value'),
      then: [],
      else: resultAction('invalid-count-result', literal(false), literal('Invalid Recall action count')),
    },
    call('x', 'attribute.read', { piece: output('holder', 'piece') }, { attribute: 'x' }),
    call('y', 'attribute.read', { piece: output('holder', 'piece') }, { attribute: 'y' }),
    call('hp', 'attribute.read', { piece: output('holder', 'piece') }, { attribute: 'currentHp' }),
    call('shield', 'recall.read-shield', { piece: output('holder', 'piece') }),
    call('status-tags', 'recall.read-status-tags', { piece: output('holder', 'piece') }),
    call('buffs', 'recall.read-buffs', { piece: output('holder', 'piece') }),
    call('debuffs', 'recall.read-debuffs', { piece: output('holder', 'piece') }),
    {
      kind: 'record.create',
      id: 'record',
      schema: RECALL_RECORD_SCHEMA.id,
      fields: {
        pieceId: output('piece-reference', 'piece'),
        ownerPlayerId: output('owner', 'player'),
        projectionVisibility: literal('owner'),
        targetCount: output('selected-count', 'value'),
        actionCount: literal(0),
        x: output('x', 'value'),
        y: output('y', 'value'),
        hp: output('hp', 'value'),
        shield: output('shield', 'value'),
        statusTags: output('status-tags', 'value'),
        buffs: output('buffs', 'value'),
        debuffs: output('debuffs', 'value'),
      },
    },
    call('store', 'recall.store-record', { record: output('record', 'value') }),
    call('name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
    call('message', 'text.concat', { left: output('name', 'text'), right: literal('已设置回溯') }),
  ]
  body.push(...resultAction('success', literal(true), output('message', 'text')))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [RECALL_RECORD_SCHEMA],
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    body,
  }
}

type RecallTriggerMode = 'endturn' | 'move' | 'skill'

function resolveRecallRecord(): GameplayStatement[] {
  return [
    call('piece-present', 'recall.record-piece-present', { record: input('record') }),
    recordGet('saved-piece', input('record'), 'pieceId'),
    recordGet('saved-x', input('record'), 'x'),
    recordGet('saved-y', input('record'), 'y'),
    recordGet('saved-hp', input('record'), 'hp'),
    recordGet('saved-shield', input('record'), 'shield'),
    recordGet('saved-status-tags', input('record'), 'statusTags'),
    recordGet('saved-buffs', input('record'), 'buffs'),
    recordGet('saved-debuffs', input('record'), 'debuffs'),
    call('position', 'spatial.cell', { x: output('saved-x', 'value'), y: output('saved-y', 'value') }),
    {
      kind: 'if',
      id: 'resolve-if-valid',
      condition: output('piece-present', 'value'),
      then: [
        call('move', 'effect.displace', { piece: output('saved-piece', 'value'), destination: output('position', 'cell') }, { kind: 'teleport' }),
        {
          kind: 'if',
          id: 'restore-after-move',
          condition: output('move', 'success'),
          then: [
            call('restore-hp', 'recall.restore-hp', { piece: output('saved-piece', 'value'), value: output('saved-hp', 'value') }),
            call('restore-shield', 'recall.restore-shield', { piece: output('saved-piece', 'value'), value: output('saved-shield', 'value') }),
            call('restore-status-tags', 'recall.restore-status-tags', { piece: output('saved-piece', 'value'), value: output('saved-status-tags', 'value') }),
            call('restore-buffs', 'recall.restore-buffs', { piece: output('saved-piece', 'value'), value: output('saved-buffs', 'value') }),
            call('restore-debuffs', 'recall.restore-debuffs', { piece: output('saved-piece', 'value'), value: output('saved-debuffs', 'value') }),
          ],
        },
      ],
    },
  ]
}

function buildRecallTriggerGraph(mode: RecallTriggerMode): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('records', 'recall.records'),
  ]
  const actor: GameplayValue = mode === 'endturn' ? output('event-player', 'player') : output('actor-owner', 'player')
  if (mode === 'endturn') {
    body.push(call('event-player', 'ref.event-player'))
  } else {
    body.push(
      call('actor-owner', 'recall.source-owner'),
    )
  }

  const opposedBody: GameplayStatement[] = []
  if (mode !== 'endturn') {
    opposedBody.push(
      recordGet('action-count', input('record'), 'actionCount'),
      call('next-action-count', 'math.add', { left: output('action-count', 'value'), right: literal(1) }),
      recordWith('advanced-record', input('record'), { actionCount: output('next-action-count', 'value') }),
      call('replace-count', 'recall.replace-count', { record: output('advanced-record', 'value') }),
      recordGet('target-count', input('record'), 'targetCount'),
      call('ready', 'compare.greater-or-equal', { left: output('next-action-count', 'value'), right: output('target-count', 'value') }),
    )
    opposedBody.push({
      kind: 'if',
      id: 'threshold',
      condition: output('ready', 'value'),
      then: [...resolveRecallRecord(), call('remove', 'recall.remove', { record: input('record') })],
    })
  } else {
    opposedBody.push(...resolveRecallRecord(), call('remove', 'recall.remove', { record: input('record') }))
  }

  body.push({
    kind: 'foreach',
    id: 'records-loop',
    items: output('records', 'records'),
    item: 'record',
    body: [
      call('belongs', 'recall.record-for-holder', { record: input('record'), holder: output('holder', 'piece') }),
      {
        kind: 'if',
        id: 'belongs-branch',
        condition: output('belongs', 'value'),
        then: [
          call('opposed', 'recall.record-opposed', { record: input('record'), actor }),
          { kind: 'if', id: 'opposed-branch', condition: output('opposed', 'value'), then: opposedBody },
        ],
      },
    ],
  })
  body.push(triggerResult('done', literal(false)))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    schemas: [RECALL_RECORD_SCHEMA],
    outputs: [{ name: 'success', type: 'boolean' }],
    body,
  }
}

function buildPulsePistolMoveGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('caster-ref', 'ref.holder'),
    call('caster-exists', 'query.has-piece', { pieceId: output('caster-ref', 'piece') }),
    call('caster-missing', 'logic.not', { value: output('caster-exists', 'exists') }),
    {
      kind: 'if',
      id: 'missing-source',
      condition: output('caster-missing', 'value'),
      then: [triggerResult('missing-result', literal(false), literal(''))],
    },
    call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }),
    call('source-present', 'recall.source-present'),
    call('source-missing', 'logic.not', { value: output('source-present', 'value') }),
    {
      kind: 'if',
      id: 'missing-trigger',
      condition: output('source-missing', 'value'),
      then: [triggerResult('missing-trigger-result', literal(false), literal(''))],
    },
    call('source-owner', 'recall.source-owner'),
    call('caster-owner', 'piece.owner', { piece: output('caster', 'piece') }),
    call('friendly-trigger', 'recall.opposed-players', { actor: output('source-owner', 'player'), owner: output('caster-owner', 'player') }),
    call('not-opposed', 'logic.not', { value: output('friendly-trigger', 'value') }),
    {
      kind: 'if',
      id: 'friendly-trigger-check',
      condition: output('not-opposed', 'value'),
      then: [triggerResult('friendly-result', literal(false), literal(''))],
    },
    call('enemies', 'query.pieces-in-square', { origin: output('caster', 'piece') }, { relation: 'enemy', halfExtent: 2 }),
    call('enemy-count', 'collection.piece-count', { pieces: output('enemies', 'pieces') }),
    call('no-enemy', 'compare.equal', { left: output('enemy-count', 'value'), right: literal(0) }),
    {
      kind: 'if',
      id: 'no-enemy-check',
      condition: output('no-enemy', 'value'),
      then: [triggerResult('no-enemy-result', literal(false), literal(''))],
    },
    call('target', 'query.random-item', { items: output('enemies', 'pieces') }),
    call('attack', 'attribute.read', { piece: output('caster', 'piece') }, { attribute: 'attack' }),
    call('caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: output('target', 'item') }, { attribute: 'name' }),
    call('damage', 'effect.damage', { source: output('caster', 'piece'), target: output('target', 'item'), amount: output('attack', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'physical', skillId: 'pulse-pistol-move', inputPolicy: 'host' }),
    call('damage-text', 'text.from-number', { value: output('damage', 'damage') }),
  ]
  let message: GameplayValue = literal('')
  for (const [index, part] of [
    output('caster-name', 'text'), literal('的脉冲手枪触发，对'), output('target-name', 'text'), literal('造成'), output('damage-text', 'text'), literal('点伤害'),
  ].entries()) {
    const id = `message-${index}`
    body.push(call(id, 'text.concat', { left: message, right: part }))
    message = output(id, 'text')
  }
  body.push(triggerResult('success-result', literal(true), message))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    schemas: [RECALL_RECORD_SCHEMA],
    outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
    body,
  }
}

export function buildRecallGraph(id: typeof RECALL_SKILL_IDS[number]): GameplayModuleGraph {
  if (id === 'recall') return buildRecallSkillGraph()
  if (id === 'recall-endturn-trigger') return buildRecallTriggerGraph('endturn')
  if (id === 'recall-move-trigger') return buildRecallTriggerGraph('move')
  if (id === 'recall-skill-trigger') return buildRecallTriggerGraph('skill')
  return buildPulsePistolMoveGraph()
}

export function migrateRecall(root: string, write = false): void {
  const frozen = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, unknown>
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const id of RECALL_SKILL_IDS) {
    const file = path.join(root, 'data/skills', `${id}.json`)
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if (hasGeneratedCodeEntry(current.gameplayModules)) {
      // Generated gameplay modules are already authored content.  A rerun of
      // this migration must validate and preserve them, including editor-only
      // graph changes and unrelated document metadata; it must never silently
      // replace an author's graph with the current migration builder.
      assertGameplayModuleDocument(current)
      continue
    }
    const original = frozen[`skills/${id}`] as Record<string, unknown> | undefined
    if (!original) throw new Error(`missing frozen fixture skills/${id}`)
    assertFrozenExecutable(current, original, 'code', id === 'recall' ? 'skill' : 'triggerSkill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
      if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    }
    const next = applyGameplayModuleGraph(current, buildRecallGraph(id))
    if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateRecall(process.cwd(), process.argv.includes('--write'))
