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
  type GameplayPort,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const HOLY_SUPPORT_SKILL_IDS = ['light-extraction', 'divine-blessing', 'blood-echo-trigger'] as const
export type HolySupportSkillId = (typeof HOLY_SUPPORT_SKILL_IDS)[number]

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], otherwise: GameplayStatement[] = []): GameplayStatement => ({ kind: 'if', id, condition, then, ...(otherwise.length ? { else: otherwise } : {}) })

const result = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] => [
  call(id + '-value', 'result.action', { success, message }),
  { kind: 'return', id: id + '-return', value: output(id + '-value', 'result') },
]
const failure = (id: string, message = ''): GameplayStatement[] => result(id, literal(false), literal(message))
const success = (id: string, message: GameplayValue): GameplayStatement[] => result(id, literal(true), message)

const holyStatusFields: readonly GameplayPort[] = [
  { name: 'id', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'name', type: 'string' },
  { name: 'currentDuration', type: 'number' },
  { name: 'currentUses', type: 'number' },
  { name: 'intensity', type: 'number' },
  { name: 'stacks', type: 'number' },
  { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
]


function buildLightExtractionGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 99, filter: 'ally' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
    branch('selection-wait', output('unresolved', 'value'), [
      call('choice-result', 'choice.as-result', { choice: output('choice', 'choice') }),
      { kind: 'return', id: 'selection-return', value: output('choice-result', 'result') },
    ]),
    call('target', 'choice.piece', { choice: output('choice', 'choice') }),
    call('shield-id', 'status.find-id', { piece: output('target', 'piece') }, { statusType: 'divine-shield' }),
    call('has-shield', 'status.has-piece', { piece: output('target', 'piece') }, { statusType: 'divine-shield' }),
    call('missing-shield', 'logic.not', { value: output('has-shield', 'value') }),
    branch('shield-check', output('missing-shield', 'value'), failure('no-shield', '目标没有圣盾')),
    call('remove-shield', 'status.remove-id', { piece: output('target', 'piece'), statusId: output('shield-id', 'id') }),
    call('remove-rule', 'rule.remove-piece', { target: output('target', 'piece') }, { ruleId: 'rule-divine-shield' }),
    call('add-smite', 'card.hand-add', { player: output('owner', 'player') }, { cardId: 'holy-smite' }),
    call('add-heal', 'card.hand-add', { player: output('owner', 'player') }, { cardId: 'holy-heal' }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: output('target', 'piece') }, { attribute: 'name' }),
    call('message-0', 'text.concat', { left: output('source-name', 'text'), right: literal('汲取了') }),
    call('message-1', 'text.concat', { left: output('message-0', 'text'), right: output('target-name', 'text') }),
    call('message-2', 'text.concat', { left: output('message-1', 'text'), right: literal('的圣盾，生成圣光惩戒和圣光治疗') }),
    ...success('success', output('message-2', 'text')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    body,
  }
}

function buildDivineBlessingGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('all-pieces', 'query.pieces', {}, { relation: 'all', includeDead: false }),
    {
      kind: 'collection', id: 'shielded-pieces', method: 'filter', items: output('all-pieces', 'pieces'), item: 'piece', body: [
        call('shielded-piece-has-shield', 'status.has-piece', { piece: input('piece') }, { statusType: 'divine-shield' }),
        { kind: 'return', id: 'shielded-value', value: output('shielded-piece-has-shield', 'value') },
      ],
    },
    call('shield-count', 'collection.piece-count', { pieces: output('shielded-pieces', 'value') }),
    call('shield-bonus', 'math.add', { left: literal(2), right: output('shield-count', 'value') }),
    call('allies', 'query.pieces', { originId: output('source', 'piece') }, { relation: 'ally', includeDead: false }),
    {
      kind: 'foreach', id: 'apply-to-allies', presentation: 'statusAdded', items: output('allies', 'pieces'), item: 'ally', body: [
        { kind: 'record.create', id: 'damage-buff-record', schema: 'damage-buff@1', fields: {
          id: literal('damage-buff'),
          type: literal('damage-buff'),
          name: literal('强化'),
          currentDuration: literal(-1),
          currentUses: literal(1),
          intensity: output('shield-bonus', 'value'),
          stacks: literal(1),
          relatedRules: literal(['rule-damage-buff']),
        } },
        call('apply-buff', 'status.apply-record', { target: input('ally'), record: output('damage-buff-record', 'value') }, { inputPolicy: 'host' }),
        call('has-rule', 'rule.has-piece', { piece: input('ally') }, { ruleId: 'rule-damage-buff' }),
        call('missing-rule', 'logic.not', { value: output('has-rule', 'value') }),
        branch('install-rule', output('missing-rule', 'value'), [call('apply-rule', 'rule.apply-piece', { target: input('ally') }, { ruleId: 'rule-damage-buff' })]),
        call('replace-related-rules', 'status.replace-related-rules', { piece: input('ally'), rules: literal(['rule-damage-buff']) }, { statusId: 'damage-buff', statusType: 'damage-buff' }),
      ],
    },
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('bonus-text', 'text.from-number', { value: output('shield-bonus', 'value') }),
    call('message-0', 'text.concat', { left: output('source-name', 'text'), right: literal('为所有友方棋子赐福，下一次伤害增加') }),
    call('message-1', 'text.concat', { left: output('message-0', 'text'), right: output('bonus-text', 'text') }),
    call('message-2', 'text.concat', { left: output('message-1', 'text'), right: literal('点') }),
    call('shield-count-text', 'text.from-number', { value: output('shield-count', 'value') }),
    call('shield-suffix-0', 'text.concat', { left: literal('（圣盾×'), right: output('shield-count-text', 'text') }),
    call('shield-suffix', 'text.concat', { left: output('shield-suffix-0', 'text'), right: literal('）') }),
    call('has-shield', 'compare.greater-than', { left: output('shield-count', 'value'), right: literal(0) }),
    call('suffix', 'value.select-text', { condition: output('has-shield', 'value'), whenTrue: output('shield-suffix', 'text'), whenFalse: literal('') }),
    call('message', 'text.concat', { left: output('message-2', 'text'), right: output('suffix', 'text') }),
    ...success('success', output('message', 'text')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [{ id: 'damage-buff', version: '1', fields: holyStatusFields }],
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    body,
  }
}

function buildBloodEchoTriggerGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('status-id', 'event.status-text', {}, { field: 'statusId' }),
    call('is-shield', 'compare.text', { left: output('status-id', 'value'), right: literal('divine-shield') }),
    branch('status-check', { kind: 'output', node: 'is-shield', port: 'value' }, [], failure('wrong-status')),
    call('event-source', 'source.capture-event-piece', {}, { field: 'sourcePiece' }),
    call('fallback-source', 'source.capture-event-piece', {}, { field: 'piece' }),
    call('source-ref', 'value.coalesce-record', { first: output('event-source', 'source'), fallback: output('fallback-source', 'source') }),
    call('source-present', 'source.is-present', { source: output('source-ref', 'value') }),
    branch('source-check', output('source-present', 'value'), [], failure('no-source')),
    call('source', 'source.require-present', { source: output('source-ref', 'value') }),
    call('source-owner', 'source.captured-owner', { source: output('source', 'source') }),
    call('bound', 'source.capture-event-piece', {}, { field: 'rulePiece' }),
    call('bound-present', 'source.is-present', { source: output('bound', 'source') }),
    branch('bound-check', output('bound-present', 'value'), [], failure('no-bound')),
    call('holder-ref', 'ref.holder'),
    call('holder-exists', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
    branch('holder-check', output('holder-exists', 'exists'), [], failure('no-holder')),
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('alive', 'piece.alive', { piece: output('holder', 'piece') }),
    call('is-liadrin', 'piece.matches-template', { piece: output('holder', 'piece') }, { templateId: 'liadrin' }),
    call('holder-owner', 'piece.owner', { piece: output('holder', 'piece') }),
    call('player-exists', 'query.has-player', { playerId: output('holder-owner', 'player') }),
    branch('player-check', output('player-exists', 'exists'), [], failure('no-player')),
    call('allied', 'compare.allied-players', { left: output('holder-owner', 'player'), right: output('source-owner', 'player') }),
    call('eligible-1', 'logic.and', { left: output('alive', 'alive'), right: output('is-liadrin', 'value') }),
    call('eligible', 'logic.and', { left: output('eligible-1', 'value'), right: output('allied', 'value') }),
    branch('eligibility-check', output('eligible', 'value'), [], failure('ineligible')),
    call('add-card', 'card.hand-add', { player: output('holder-owner', 'player') }, { cardId: 'holy-charge' }),
    call('message', 'value.select-text', { condition: output('add-card', 'success'), whenTrue: literal('血色回响生成了1张圣光充能'), whenFalse: literal('') }),
    ...result('success', output('add-card', 'success'), output('message', 'text')),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    body,
  }
}

export function buildHolySupportGraph(id: HolySupportSkillId): GameplayModuleGraph {
  if (id === 'light-extraction') return buildLightExtractionGraph()
  if (id === 'divine-blessing') return buildDivineBlessingGraph()
  if (id === 'blood-echo-trigger') return buildBloodEchoTriggerGraph()
  throw new Error('Unknown holy support skill ' + id)
}

export function migrateHolySupportSkills(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: Array<{ file: string; next: Record<string, unknown> }> = []
  for (const id of HOLY_SUPPORT_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const modules = current.gameplayModules as { entries?: Record<string, unknown> } | undefined
    if (modules?.entries?.code) {
      assertGameplayModuleDocument(current)
      continue
    }
    const original = baseline['skills/' + id]
    if (!original) throw new Error(`Missing frozen baseline skills/${id}`)
    const surface = id === 'blood-echo-trigger' ? 'triggerSkill' : 'skill'
    assertFrozenExecutable(current, original, 'code', surface, id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
      if (!generated.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    }
    pending.push({ file, next: applyGameplayModuleGraph(current, buildHolySupportGraph(id)) })
  }
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(migrateHolySupportSkills(process.cwd(), process.argv.includes('--write'))))
}

