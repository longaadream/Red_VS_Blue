import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildSuperFormGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('owner', 'piece.owner', { piece: o('source', 'piece') }),
    c('player-present', 'query.has-player', { playerId: o('owner', 'player') }),
    { kind: 'if', id: 'grant-check', condition: o('player-present', 'exists'), then: [
      c('grant', 'resource.adjust', { player: o('owner', 'player'), amount: l(2) }, { resource: 'actionPoints' }),
    ] },
    c('remove-old', 'status.remove-type-raw', { piece: o('source', 'piece') }, { statusType: 'preserve-momentum' }),
    c('id', 'piece.identifier', { piece: o('source', 'piece') }),
    c('status-id', 'text.concat', { left: l('preserve-momentum-'), right: o('id', 'id') }),
    c('turn', 'event.battle-turn-number'),
    { kind: 'record.create', id: 'status', schema: 'momentum-preservation@1', fields: {
      id: o('status-id', 'text'), type: l('preserve-momentum'), name: l('超级形态'), stacks: l(1), currentDuration: l(1), untilTurn: o('turn'),
    } },
    c('apply', 'status.apply-record', { target: o('source', 'piece'), record: o('status') }, { inputPolicy: 'host' }),
    c('result', 'result.action', { success: l(true), message: l('获得2点临时行动点，本回合动能不会被消耗') }),
    { kind: 'return', id: 'done', value: o('result', 'result') },
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [{ id: 'momentum-preservation', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' },
    { name: 'stacks', type: 'number' }, { name: 'currentDuration', type: 'number' }, { name: 'untilTurn', type: 'number' },
  ] }], outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function migrateSuperForm(root: string, write = false): void {
  const file = path.join(root, 'data/skills/sonic-super-form.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/sonic-super-form']
  assertFrozenExecutable(current, original, 'code', 'skill', 'sonic-super-form')
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`sonic-super-form: changed compatibility field ${key}`)
  const next = applyGameplayModuleGraph(current, buildSuperFormGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateSuperForm(process.cwd(), process.argv.includes('--write'))
