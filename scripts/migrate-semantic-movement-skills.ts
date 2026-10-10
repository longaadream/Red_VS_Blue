import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

export const MOVEMENT_SKILL_IDS = ['blink', 'shelly-dash', 'aizen-shunpo'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const result = (id: string, success: boolean, message: GameplayValue): GameplayStatement[] => [call(id, 'result.action', { success: literal(success), message }), { kind: 'return', id: id + '-return', value: out(id, 'result') }]
export function buildMovementSkillGraph(id: string): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' })]
  const source = out('source', 'piece')
  const require = (key: string, condition: GameplayValue, message: string, success = false) => body.push(call(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: out(key + '-not', 'value'), then: result(key + '-error', success, literal(message)) })
  const choice = (key: string, type: 'piece' | 'cell', range: number, filter: 'all' | 'enemy') => {
    body.push(call(key + '-choice', 'choice.target-' + type, {}, { range, filter }), call(key + '-waiting', 'choice.is-unresolved', { choice: out(key + '-choice', 'choice') }), { kind: 'if', id: key + '-return-choice', condition: out(key + '-waiting', 'value'), then: [call(key + '-choice-result', 'choice.as-result', { choice: out(key + '-choice', 'choice') }), { kind: 'return', id: key + '-waiting-result', value: out(key + '-choice-result', 'result') }] }, call(key, 'choice.' + type, { choice: out(key + '-choice', 'choice') }))
    return out(key, type)
  }
  let enemy: GameplayValue | undefined
  if (id === 'aizen-shunpo') enemy = choice('enemy', 'piece', 5, 'enemy')
  const destination = choice('destination', 'cell', enemy ? 99 : 2, 'all')
  body.push(call('origin', 'spatial.piece-position', { piece: enemy ?? source }))
  if (enemy) {
    body.push(call('distance', 'spatial.cell-distance', { from: out('origin', 'cell'), to: destination }), call('in-range', 'compare.less-or-equal', { left: out('distance', 'distance'), right: literal(2) }))
    require('require-range', out('in-range', 'value'), '落点超出范围')
  } else {
    body.push(call('delta', 'spatial.cell-delta', { from: out('origin', 'cell'), to: destination }))
    if (id === 'blink') { body.push(call('in-range', 'compare.less-or-equal', { left: out('delta', 'chebyshev'), right: literal(2) })); require('require-range', out('in-range', 'value'), '目标超出闪现范围（5x5格内）') }
    else require('require-direction', out('delta', 'orthogonal'), '请选择正方向地格')
    body.push(call('walkable', 'spatial.cell-walkable', { cell: destination }))
    require('require-walkable', out('walkable', 'walkable'), id === 'blink' ? '目标位置不可行走' : '目标地格不可行走')
    body.push(call('vacant', 'spatial.cell-unoccupied', { cell: destination, ...(id === 'shelly-dash' ? { ignore: source } : {}) }))
    require('require-vacant', out('vacant', 'value'), id === 'blink' ? '目标位置已被占用' : '目标地格已有棋子')
  }
  if (enemy) body.push(call('owner', 'piece.owner', { piece: source }))
  body.push(call('move', 'effect.teleport', { piece: source, destination }, { kind: id === 'shelly-dash' ? 'dash' : 'teleport' }))
  require('require-move', out('move', 'success'), '位移被阻挡，本次位移效果取消', true)
  if (enemy) {
    body.push(call('refund', 'resource.adjust', { player: out('owner', 'player'), amount: literal(2) }, { resource: 'actionPoints' }), call('message', 'text.concat', { left: out('name', 'text'), right: literal('发动瞬步并获得2点临时行动点') }), ...result('success', true, out('message', 'text')))
  } else {
    body.push(call('coords', 'spatial.cell-coordinates', { cell: destination }), call('x', 'text.from-number', { value: out('coords', 'x') }), call('y', 'text.from-number', { value: out('coords', 'y') }))
    let message = out('name', 'text')
    ;[literal(id === 'blink' ? '闪现至(' : '冲刺至('), out('x', 'text'), literal(','), out('y', 'text'), literal(')')].forEach((part, index) => { const key = 'message-' + index; body.push(call(key, 'text.concat', { left: message, right: part })); message = out(key, 'text') })
    body.push(...result('success', true, message))
  }
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function migrateMovementSkills(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of MOVEMENT_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = baseline['skills/' + id]
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildMovementSkillGraph(id)) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateMovementSkills(process.cwd(), process.argv.includes('--write'))))
