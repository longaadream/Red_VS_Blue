import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const result = (id: string, success: boolean, message: GameplayValue): GameplayStatement[] => [c(id, 'result.action', { success: l(success), message }), { kind: 'return', id: id + '-return', value: o(id, 'result') }]

export function buildChaosControlGraph(): GameplayModuleGraph {
  const target = o('each', 'item')
  const status = (prefix: string, type: string, name: string, ruleId: string): GameplayStatement[] => [
    c(prefix + '-id', 'text.concat', { left: l(prefix + '-'), right: o('target-id', 'id') }),
    { kind: 'record.create', id: prefix + '-record', schema: 'control-status@1', fields: {
      id: o(prefix + '-id', 'text'), type: l(type), name: l(name), stacks: l(1), currentDuration: l(1), remainingDuration: l(1), relatedRules: l([ruleId]),
    } },
    c(prefix + '-apply', 'status.apply-record', { target, record: o(prefix + '-record') }, { inputPolicy: 'host' }),
    c(prefix + '-rule', 'rule.apply-piece', { target }, { ruleId }),
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }],
    schemas: [{ id: 'control-status', version: '1', fields: [
      { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' },
      { name: 'stacks', type: 'number' }, { name: 'currentDuration', type: 'number' }, { name: 'remainingDuration', type: 'number' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
    ] }],
    body: [
      c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
      c('choice', 'choice.target-cell', {}, { range: 5, filter: 'all' }), c('unresolved', 'choice.is-unresolved', { choice: o('choice', 'choice') }),
      { kind: 'if', id: 'choice-check', condition: o('unresolved'), then: [c('pending', 'choice.as-result', { choice: o('choice', 'choice') }), { kind: 'return', id: 'waiting', value: o('pending', 'result') }] },
      c('cell', 'choice.cell', { choice: o('choice', 'choice') }),
      c('walkable', 'spatial.cell-walkable-safe', { cell: o('cell', 'cell') }),
      c('terrain', 'spatial.cell-terrain-in', { cell: o('cell', 'cell') }, { types: ['floor', 'cover'] }),
      c('vacant', 'spatial.cell-unoccupied', { cell: o('cell', 'cell') }),
      c('valid-terrain', 'logic.and', { left: o('walkable'), right: o('terrain') }),
      c('valid', 'logic.and', { left: o('valid-terrain'), right: o('vacant') }),
      { kind: 'if', id: 'valid-check', condition: o('valid'), then: [], else: result('invalid', false, l('目标必须是未被占据的空地或掩体')) },
      c('move', 'effect.displace-one', { piece: o('source', 'piece'), destination: o('cell', 'cell') }, { kind: 'teleport' }),
      { kind: 'if', id: 'move-check', condition: o('move', 'success'), then: [], else: result('blocked', true, l('位移被阻挡，本次位移效果取消')) },
      c('center', 'spatial.piece-position', { piece: o('source', 'piece') }), c('owner', 'piece.owner', { piece: o('source', 'piece') }),
      c('targets', 'query.pieces-around-cell', { center: o('center', 'cell'), owner: o('owner', 'player') }, { relation: 'enemy', metric: 'chebyshev', maximum: 2 }),
      { kind: 'foreach', id: 'each', presentation: 'statusAdded', items: o('targets', 'pieces'), body: [
        c('target-id', 'piece.identifier', { piece: target }), ...status('silenced', 'silenced', '沉默', 'rule-silenced-block'),
        c('existing', 'status.find-id', { piece: target }, { statusType: 'chidori-immobile' }),
        c('has-existing', 'status.has-id', { piece: target, statusId: o('existing', 'id') }),
        { kind: 'if', id: 'refresh-or-apply', condition: o('has-existing'), then: [
          c('duration', 'status.set-record-number', { piece: target, statusId: o('existing', 'id'), value: l(1) }, { field: 'currentDuration' }),
          c('remaining', 'status.set-record-number', { piece: target, statusId: o('existing', 'id'), value: l(1) }, { field: 'remainingDuration' }),
        ], else: status('immobile', 'chidori-immobile', '定身', 'rule-chidori-immobile') },
      ] },
      c('count', 'collection.piece-count', { pieces: o('targets', 'pieces') }), c('count-text', 'text.from-number', { value: o('count') }),
      c('message-start', 'text.concat', { left: l('混沌控制生效，'), right: o('count-text', 'text') }),
      c('message', 'text.concat', { left: o('message-start', 'text'), right: l('名敌人被沉默并定身1回合') }),
      ...result('done', true, o('message', 'text')),
    ],
  }
}
export function migrateChaosControl(root: string, write = false): void {
  const file = path.join(root, 'data/skills/shadow-chaos-control.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/shadow-chaos-control']
  assertFrozenExecutable(current, original, 'code', 'skill', 'shadow-chaos-control')
  const next = applyGameplayModuleGraph(current, buildChaosControlGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateChaosControl(process.cwd(), process.argv.includes('--write'))
