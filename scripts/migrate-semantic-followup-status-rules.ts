import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
import { assertContentGraphArtifact } from '../electron-editor/content-graph-document'
import { assertFrozenExecutable } from './semantic-migration-source'

export const FOLLOWUP_STATUS_RULE_IDS = [
  'rule-ulquiorra-resurreccion',
  'rule-kenshin-tenken',
  'rule-illidan-demon-strike',
] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const resultOutputs = [{ name: 'result', type: 'record' as const, nullable: true }]
const statusSchema: GameplayRecordSchema = {
  id: 'followup-status-rule-status',
  version: '1',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'visible', type: 'boolean', optional: true },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' },
    { name: 'stacks', type: 'number' },
  ],
}

const success = (id: string, message: GameplayValue = literal('')): GameplayStatement[] => [
  call(id, 'result.action', { success: literal(true), message }),
  { kind: 'return', id: `${id}-return`, value: output(id, 'result') },
]
const failure = (id: string): GameplayStatement[] => [
  call(id, 'result.action', { success: literal(false), message: literal('') }),
  { kind: 'return', id: `${id}-return`, value: output(id, 'result') },
]
const requireCondition = (body: GameplayStatement[], id: string, condition: GameplayValue): void => {
  body.push(call(`${id}-not`, 'logic.not', { value: condition }), {
    kind: 'if', id, condition: output(`${id}-not`, 'value'), then: failure(`${id}-failure`),
  })
}

function holder(body: GameplayStatement[]): GameplayValue {
  body.push(
    call('holder-ref', 'ref.holder'),
    call('holder-exists', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
  )
  requireCondition(body, 'holder-check', output('holder-exists', 'exists'))
  body.push(call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }))
  return output('holder', 'piece')
}

function buildUlquiorraGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  body.push(
    call('alive', 'piece.alive', { piece }),
    call('owner', 'piece.owner-id', { piece }),
    call('event-player', 'event.read-string', { fallback: literal('') }, { field: 'playerId' }),
    call('same-player', 'compare.equal-string', { left: output('owner', 'playerId'), right: output('event-player', 'value') }),
    call('eligible', 'logic.and', { left: output('alive', 'alive'), right: output('same-player', 'value') }),
  )
  requireCondition(body, 'eligible-check', output('eligible', 'value'))
  body.push(
    call('piece-id', 'piece.identifier', { piece }),
    call('resurreccion-id', 'text.concat', { left: literal('ulquiorra-resurreccion-'), right: output('piece-id', 'id') }),
    call('already-transformed', 'status.has-id', { piece, statusId: output('resurreccion-id', 'text') }),
  )
  body.push({ kind: 'if', id: 'already-transformed-branch', condition: output('already-transformed', 'value'), then: failure('already-transformed-result') })
  body.push(
    call('progress-id', 'status.find-id', { piece }, { statusType: 'ulquiorra-resurreccion-progress' }),
    call('progress-present', 'status.has-id', { piece, statusId: output('progress-id', 'id') }),
    call('progress-intensity', 'status.read-number', { piece, statusId: output('progress-id', 'id'), fallback: literal(0) }, { field: 'intensity' }),
    call('progress-ready', 'compare.greater-or-equal', { left: output('progress-intensity', 'value'), right: literal(3) }),
    call('ready', 'logic.and', { left: output('progress-present', 'value'), right: output('progress-ready', 'value') }),
  )
  requireCondition(body, 'ready-check', output('ready', 'value'))
  body.push(
    call('attack-up', 'attribute.adjust', { piece, amount: literal(1) }, { attribute: 'attack' }),
    call('move-range-up', 'attribute.adjust', { piece, amount: literal(1) }, { attribute: 'moveRange' }),
    call('remove-progress', 'status.remove-id', { piece, statusId: output('progress-id', 'id') }),
    call('add-cero', 'skill.add', { piece }, { skillId: 'ulquiorra-black-cero' }),
    {
      kind: 'record.create', id: 'resurreccion-record', schema: 'followup-status-rule-status@1', fields: {
        id: output('resurreccion-id', 'text'), type: literal('resurreccion'), name: literal('归刃'), visible: literal(true),
        currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1),
      },
    },
    call('add-resurreccion', 'status.apply-record', { target: piece, record: output('resurreccion-record', 'value') }, { inputPolicy: 'host' }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('message', 'text.concat', { left: output('name', 'text'), right: literal('归刃为黑翼大魔') }),
  )
  body.push(...success('success', output('message', 'text')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildKenshinGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const piece = holder(body)
  body.push(
    call('alive', 'piece.alive', { piece }),
    call('source-ref', 'ref.source'),
    call('same-source', 'compare.equal-piece-nullable', { left: piece, right: output('source-ref', 'piece') }),
    call('eligible', 'logic.and', { left: output('alive', 'alive'), right: output('same-source', 'value') }),
  )
  requireCondition(body, 'eligible-check', output('eligible', 'value'))
  body.push(
    call('piece-id', 'piece.identifier', { piece }),
    call('charge-id', 'text.concat', { left: literal('tenken-charge-'), right: output('piece-id', 'id') }),
    call('existing', 'status.has-id', { piece, statusId: output('charge-id', 'text') }),
  )
  body.push({ kind: 'if', id: 'existing-branch', condition: output('existing', 'value'), then: [
    call('reset-uses', 'status.set-remaining-uses', { piece, statusId: output('charge-id', 'text'), value: literal(1) }),
  ], else: [
    {
      kind: 'record.create', id: 'charge-record', schema: 'followup-status-rule-status@1', fields: {
        id: output('charge-id', 'text'), name: literal('飞天御剑流'), type: literal('damage-multiplier'),
        currentDuration: literal(-1), currentUses: literal(1), intensity: literal(1.5), stacks: literal(1),
      },
    },
    call('add-charge', 'status.apply-record', { target: piece, record: output('charge-record', 'value') }, { inputPolicy: 'host' }),
  ] })
  body.push(
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('message', 'text.concat', { left: output('name', 'text'), right: literal('蓄积飞天御剑流，下次攻击伤害提升50%！') }),
  )
  body.push(...success('success', output('message', 'text')))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, schemas: [statusSchema], body }
}

function buildIllidanGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  body.push(
    call('skill-id', 'event.read-string', { fallback: literal('') }, { field: 'skillId' }),
    call('is-demon-strike', 'compare.equal-string', { left: output('skill-id', 'value'), right: literal('illidan-demon-strike') }),
  )
  requireCondition(body, 'skill-check', output('is-demon-strike', 'value'))
  const piece = holder(body)
  body.push(
    call('charge-present', 'status.has-id', { piece, statusId: literal('demon-strike-charges') }),
  )
  requireCondition(body, 'charge-check', output('charge-present', 'value'))
  body.push(
    call('before', 'status.read-uses-fallback', { piece, statusId: literal('demon-strike-charges'), fallback: literal(2) }),
    call('remaining', 'math.subtract', { left: output('before', 'value'), right: literal(1) }),
    call('save-remaining', 'status.set-remaining-uses', { piece, statusId: literal('demon-strike-charges'), value: output('remaining', 'value') }),
    call('expired', 'compare.less-or-equal', { left: output('remaining', 'value'), right: literal(0) }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
  )
  body.push({ kind: 'if', id: 'expired-branch', condition: output('expired', 'value'), then: [
    call('remove-charge', 'status.remove-id', { piece, statusId: literal('demon-strike-charges') }),
    call('remove-skill', 'skill.remove', { piece }, { skillId: 'illidan-demon-strike' }),
    call('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-illidan-demon-strike' }),
    call('expired-message', 'text.concat', { left: output('name', 'text'), right: literal('的恶魔冲击次数耗尽，技能已移除') }),
    ...success('expired-success', output('expired-message', 'text')),
  ], else: [
    call('remaining-text', 'text.from-number', { value: output('remaining', 'value') }),
    call('remaining-prefix', 'text.concat', { left: output('name', 'text'), right: literal('恶魔冲击剩余') }),
    call('remaining-body', 'text.concat', { left: output('remaining-prefix', 'text'), right: output('remaining-text', 'text') }),
    call('remaining-message', 'text.concat', { left: output('remaining-body', 'text'), right: literal('次') }),
    ...success('remaining-success', output('remaining-message', 'text')),
  ] })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: resultOutputs, body }
}

export function buildFollowupStatusRulesGraph(id: string): GameplayModuleGraph {
  switch (id) {
    case 'rule-ulquiorra-resurreccion': return buildUlquiorraGraph()
    case 'rule-kenshin-tenken': return buildKenshinGraph()
    case 'rule-illidan-demon-strike': return buildIllidanGraph()
    default: throw new Error(`Unimplemented follow-up status rule ${id}`)
  }
}

export type FollowupStatusRulesPreflight = {
  pending: { id: string; file: string; next: Record<string, unknown> }[]
  preserved: { id: string; message: string }[]
  failures: { id: string; message: string }[]
}

export function preflightFollowupStatusRules(root: string): FollowupStatusRulesPreflight {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: FollowupStatusRulesPreflight['pending'] = []
  const preserved: FollowupStatusRulesPreflight['preserved'] = []
  const failures: FollowupStatusRulesPreflight['failures'] = []
  for (const id of FOLLOWUP_STATUS_RULE_IDS) {
    try {
      const file = path.join(root, 'data/rules', `${id}.json`)
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (current.gameplayModules?.entries?.skillCode) {
        assertGameplayModuleDocument(current)
        preserved.push({ id, message: 'existing gameplayModules entry retained' })
        continue
      }
      const original = baseline[`rules/${id}`]
      assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
      if (current.contentGraph) assertContentGraphArtifact(current)
      for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
        if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
      }
      pending.push({ id, file, next: applyGameplayModuleGraph(current, buildFollowupStatusRulesGraph(id), 'skillCode') })
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { pending, preserved, failures }
}

export function migrateFollowupStatusRules(root: string, write = false, allowPartial = false): string[] {
  const report = preflightFollowupStatusRules(root)
  if (report.failures.length && !allowPartial) throw new Error(`Follow-up status rules migration preflight failed:\n${report.failures.map(item => `- ${item.message}`).join('\n')}`)
  if (write) for (const item of report.pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return report.pending.map(item => path.basename(item.file, '.json'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const allowPartial = process.argv.includes('--write-ready')
  const report = preflightFollowupStatusRules(process.cwd())
  if (report.failures.length && !allowPartial) throw new Error(`Follow-up status rules migration preflight failed:\n${report.failures.map(item => `- ${item.message}`).join('\n')}`)
  if (process.argv.includes('--write')) for (const item of report.pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  console.log(JSON.stringify({ migrated: report.pending.map(item => path.basename(item.file, '.json')), preserved: [...report.preserved, ...report.failures] }))
}
