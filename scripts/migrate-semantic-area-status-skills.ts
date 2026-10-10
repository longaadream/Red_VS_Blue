import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayPort, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

export const AREA_STATUS_SKILL_IDS = ['alfonso-freeze', 'max-full-speed'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildAreaStatusSkillGraph(id: string): GameplayModuleGraph {
  if (!(AREA_STATUS_SKILL_IDS as readonly string[]).includes(id)) throw new Error('Unknown area status skill ' + id)
  const freeze = id === 'alfonso-freeze'
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }), call('owner', 'piece.owner', { piece: out('source', 'piece') }), call('source-id', 'piece.identifier', { piece: out('source', 'piece') }), call('turn', 'turn.number')]
  if (freeze) body.push(call('center', 'spatial.piece-position', { piece: out('source', 'piece') }), call('targets', 'query.pieces-around-cell', { center: out('center', 'cell'), owner: out('owner', 'player') }, { relation: 'enemy', metric: 'manhattan', maximum: 2 }))
  else body.push(call('targets', 'query.pieces', { ownerId: out('owner', 'player') }, { relation: 'ally' }))
  const status: Record<string, GameplayJsonValue> = freeze ? { type: 'freeze', name: '冰冻', visible: true, currentDuration: 1, intensity: 1, relatedRules: ['rule-freeze-prevent-move', 'rule-freeze-prevent-skill'] } : { type: 'deployment-first-move-free', name: '迅捷', visible: true, stacking: 'independent', currentDuration: 1, currentUses: 1, remainingUses: 1 }
  const fields: Record<string, GameplayValue> = Object.fromEntries(Object.entries(status).map(([key, value]) => [key, literal(value)]))
  const schema: GameplayPort[] = Object.entries(status).map(([name, value]) => ({ name, type: Array.isArray(value) ? { kind: 'list', element: 'string' } : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string' }))
  const each: GameplayStatement[] = [call('target-id', 'piece.identifier', { piece: out('apply-each', 'item') })]
  const parts: GameplayValue[] = []
  if (freeze) {
    each.push(call('clock', 'identity.host-time'), call('clock-text', 'text.from-number', { value: out('clock', 'value') }))
    parts.push(literal('freeze-'), out('clock-text', 'text'), literal('-'), out('target-id', 'id'))
  } else {
    each.push(call('turn-text', 'text.from-number', { value: out('turn', 'value') }), call('index-text', 'text.from-number', { value: out('apply-each', 'index') }))
    parts.push(literal('max-full-speed-swift-'), out('source-id', 'id'), literal('-'), out('target-id', 'id'), literal('-'), out('turn-text', 'text'), literal('-'), out('index-text', 'text'))
    fields.grantedTurnNumber = out('turn', 'value'); schema.push({ name: 'grantedTurnNumber', type: 'number' })
  }
  let identity = literal('')
  parts.forEach((part, index) => { each.push(call('identity-' + index, 'text.concat', { left: identity, right: part })); identity = out('identity-' + index, 'text') })
  fields.id = identity; schema.push({ name: 'id', type: 'string' })
  each.push({ kind: 'record.create', id: 'status', schema: 'status@1', fields }, call('apply', 'status.apply-record', { target: out('apply-each', 'item'), record: out('status', 'value') }, { inputPolicy: 'host' }))
  if (freeze) each.push(call('move-rule', 'rule.apply-piece', { target: out('apply-each', 'item') }, { ruleId: 'rule-freeze-prevent-move' }), call('skill-rule', 'rule.apply-piece', { target: out('apply-each', 'item') }, { ruleId: 'rule-freeze-prevent-skill' }), call('skill', 'skill.add', { piece: out('apply-each', 'item') }, { skillId: 'freeze-prevent' }))
  body.push({ kind: 'foreach', id: 'apply-each', items: out('targets', 'pieces'), body: each })
  let message = out('name', 'text')
  const suffix: GameplayValue[] = freeze ? [literal('使周围敌人冰冻')] : [literal('发动全速出击，使'), out('count-text', 'text'), literal('个友方棋子获得迅捷')]
  if (!freeze) body.push(call('count', 'collection.piece-count', { pieces: out('targets', 'pieces') }), call('count-text', 'text.from-number', { value: out('count', 'value') }))
  suffix.forEach((part, index) => { body.push(call('message-' + index, 'text.concat', { left: message, right: part })); message = out('message-' + index, 'text') })
  body.push({ kind: 'return', id: 'done', values: { success: literal(true), message } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [{ id: 'status', version: '1', fields: schema }], outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}

export function migrateAreaStatusSkills(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of AREA_STATUS_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = baseline['skills/' + id]
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildAreaStatusSkillGraph(id)) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateAreaStatusSkills(process.cwd(), process.argv.includes('--write'))))
