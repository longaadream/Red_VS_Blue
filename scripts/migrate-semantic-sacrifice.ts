import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
function message(body: GameplayStatement[], prefix: string, parts: GameplayValue[]): GameplayValue {
  let text = l('')
  parts.forEach((part, i) => { body.push(c(prefix + i, 'text.concat', { left: text, right: part })); text = o(prefix + i, 'text') })
  return text
}
const done = (id: string, text: GameplayValue): GameplayStatement => ({ kind: 'return', id, values: { success: l(true), message: text } })

export function buildSacrificeGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('saved', 'source.capture', { source: o('source', 'piece') }),
    c('max-hp', 'source.captured-max-hp', { source: o('saved', 'source'), fallback: l(18) }),
    c('hp', 'source.captured-number', { source: o('saved', 'source') }, { field: 'currentHp' }),
    c('lost', 'math.subtract', { left: o('max-hp'), right: o('hp') }),
    c('self-hit', 'effect.damage-captured', { source: o('saved', 'source'), target: o('saved', 'source'), amount: l(4) }, { damageType: 'true', skillId: 'hidan-sacrifice' }),
    c('owner', 'source.captured-owner', { source: o('saved', 'source') }),
    c('enemies', 'query.pieces', { ownerId: o('owner', 'player') }, { relation: 'enemy', includeDead: false }),
    { kind: 'collection.filter', id: 'oathed', items: o('enemies', 'pieces'), item: 'enemy', body: [
      c('has-oath', 'status.has-piece', { piece: { kind: 'input', name: 'enemy' } }, { statusType: 'blood-oath' }),
      { kind: 'return', id: 'match', value: o('has-oath') },
    ] },
    c('first', 'list.first-piece', { items: o('oathed') }),
    c('exists', 'query.has-piece', { pieceId: o('first', 'piece') }),
    c('third', 'math.divide', { left: o('lost'), right: l(3) }), c('bonus', 'math.floor', { value: o('third') }),
    c('positive', 'compare.greater-than', { left: o('bonus'), right: l(0) }),
    c('eligible', 'logic.and', { left: o('exists', 'exists'), right: o('positive') }),
    c('self-damage', 'effect.result-number', { result: o('self-hit', 'result') }, { field: 'damage' }),
    c('self-text', 'text.from-number', { value: o('self-damage') }),
  ]
  const extra: GameplayStatement[] = [
    c('target', 'query.piece', { pieceId: o('first', 'piece') }), c('saved-target', 'source.capture', { source: o('target', 'piece') }),
    c('bonus-hit', 'effect.damage-captured', { source: o('saved', 'source'), target: o('saved-target', 'source'), amount: o('bonus') }, { damageType: 'true', skillId: 'sacrifice-bonus' }),
    c('bonus-name', 'piece.captured-name', { source: o('saved', 'source') }),
    c('target-name', 'piece.captured-name', { source: o('saved-target', 'source') }),
    c('display-total', 'math.add', { left: l(4), right: o('bonus') }),
    c('total-text', 'text.from-number', { value: o('display-total') }), c('bonus-text', 'text.from-number', { value: o('bonus') }),
  ]
  extra.push(done('bonus-result', message(extra, 'bonus-message-', [o('bonus-name'), l('发动狂信者献祭，对自身造成'), o('self-text', 'text'), l('点真实伤害，对'), o('target-name'), l('造成'), o('total-text', 'text'), l('点真实伤害（含'), o('bonus-text', 'text'), l('点苦难加深）')])))
  body.push({ kind: 'if', id: 'bonus-check', condition: o('eligible'), then: extra }, c('name', 'piece.captured-name', { source: o('saved', 'source') }))
  body.push(done('result', message(body, 'message-', [o('name'), l('发动狂信者献祭，对自身造成'), o('self-text', 'text'), l('点真实伤害')])))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}

export function migrateSacrifice(root: string, write = false): void {
  const file = path.join(root, 'data/skills/hidan-sacrifice.json')
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/hidan-sacrifice']
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  assertFrozenExecutable(current, original, 'code', 'skill', 'hidan-sacrifice')
  const authored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
    if (!authored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`hidan-sacrifice: changed compatibility field ${key}`)
  }
  const next = applyGameplayModuleGraph(current, buildSacrificeGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateSacrifice(process.cwd(), process.argv.includes('--write'))
