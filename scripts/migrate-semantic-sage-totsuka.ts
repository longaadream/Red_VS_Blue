import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import {
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '../lib/skill-graph/module-registry'

export const SAGE_TOTSUKA_SKILL_IDS = ['hashirama-edo-sage-buddha', 'itachi-totsuka-blade'] as const
export type SageTotsukaSkillId = typeof SAGE_TOTSUKA_SKILL_IDS[number]

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], otherwise: GameplayStatement[] = []): GameplayStatement => ({ kind: 'if', id, condition, then, ...(otherwise.length ? { else: otherwise } : {}) })

function action(body: GameplayStatement[], id: string, success: GameplayValue, message: GameplayValue): void {
  body.push(call(id + '-record', 'result.action', { success, message }), { kind: 'return', id, value: output(id + '-record', 'result') })
}

function graph(body: GameplayStatement[], schemas: readonly GameplayRecordSchema[] = []): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas,
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    body,
  }
}

function pendingReturn(choiceNode: string): GameplayStatement[] {
  return [call('pending-result', 'choice.as-result', { choice: output(choiceNode, 'choice') }), { kind: 'return', id: 'pending-return', value: output('pending-result', 'result') }]
}

function appendText(body: GameplayStatement[], id: string, left: GameplayValue, right: GameplayValue): GameplayValue {
  body.push(call(id, 'text.concat', { left, right }))
  return output(id, 'text')
}

function buildSageBuddhaSuccessBody(source: GameplayValue, target: GameplayValue): GameplayStatement[] {
  const body: GameplayStatement[] = [
    call('source-name', 'attribute.text', { piece: source }, { attribute: 'name' }),
    call('target-coordinates', 'spatial.cell-coordinates', { cell: target }),
    call('x-text', 'text.from-number', { value: output('target-coordinates', 'x') }),
    call('y-text', 'text.from-number', { value: output('target-coordinates', 'y') }),
  ]
  let message = output('source-name', 'text')
  message = appendText(body, 'message-prefix', message, literal('施放仙术·顶上化佛，瞬移至('))
  message = appendText(body, 'message-x', message, output('x-text', 'text'))
  message = appendText(body, 'message-separator', message, literal(','))
  message = appendText(body, 'message-y', message, output('y-text', 'text'))
  message = appendText(body, 'message-close', message, literal(')'))
  body.push(
    call('reset', 'skill.reset-cooldowns', { piece: source }, { excludeSkillId: 'hashirama-edo-sage-buddha' }),
    call('reset-clause', 'value.select-text', { condition: output('reset', 'present'), whenTrue: literal('，其他技能冷却已重置'), whenFalse: literal('') }),
  )
  message = appendText(body, 'message-reset', message, output('reset-clause', 'text'))
  body.push(
    call('owner', 'piece.owner', { piece: source }),
    call('add-thousand-hands', 'card.hand-add-ref', { player: output('owner', 'player'), cardId: literal('hashirama-edo-thousand-hands') }),
    call('bind-thousand-hands', 'card.bind-latest-unbound', { player: output('owner', 'player'), piece: source }, { cardId: 'hashirama-edo-thousand-hands' }),
    call('add-nature-heal', 'card.hand-add-ref', { player: output('owner', 'player'), cardId: literal('hashirama-edo-nature-heal') }),
    call('bind-nature-heal', 'card.bind-latest-unbound', { player: output('owner', 'player'), piece: source }, { cardId: 'hashirama-edo-nature-heal' }),
  )
  message = appendText(body, 'message-reward', message, literal('，获得【木遁·真数千手】和【仙术·大自然愈合】各1张'))
  action(body, 'success', literal(true), message)
  return body
}

export function buildHashiramaEdoSageBuddhaGraph(): GameplayModuleGraph {
  const source = output('source', 'piece')
  const target = output('target', 'cell')
  const legalBody: GameplayStatement[] = [
    call('unoccupied', 'spatial.cell-unoccupied-except', { cell: target, ignore: source }),
  ]
  legalBody.push(branch('occupancy-check', output('unoccupied', 'unoccupied'), [
    call('move', 'effect.displace', { piece: source, destination: target }, { kind: 'teleport' }),
    branch('move-check', output('move', 'success'), buildSageBuddhaSuccessBody(source, target), [
      ...(() => { const blocked: GameplayStatement[] = []; action(blocked, 'blocked', literal(true), literal('位移被阻挡，本次位移效果取消')); return blocked })(),
    ]),
  ], (() => { const occupied: GameplayStatement[] = []; action(occupied, 'occupied', literal(false), literal('目标格已被占用')); return occupied })()))

  const walkableFailure: GameplayStatement[] = []
  action(walkableFailure, 'invalid', literal(false), literal('目标格不可移动'))
  return graph([
    call('holder', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('holder', 'piece') }),
    call('choice', 'choice.target-cell', {}, { range: 2, filter: 'all' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
    branch('choice-check', output('unresolved', 'value'), pendingReturn('choice')),
    call('target', 'choice.cell', { choice: output('choice', 'choice') }),
    call('walkable', 'spatial.cell-walkable', { cell: target }),
    branch('walkable-check', output('walkable', 'walkable'), legalBody, walkableFailure),
  ])
}

function buildTotsukaSuccessBody(targetName: GameplayValue): GameplayStatement[] {
  const body: GameplayStatement[] = [
    call('damage-text', 'text.from-number', { value: output('hit', 'damage') }),
  ]
  let message = output('source-name', 'text')
  message = appendText(body, 'message-prefix', message, literal('以十拳剑对'))
  message = appendText(body, 'message-target', message, targetName)
  message = appendText(body, 'message-damage-prefix', message, literal('造成'))
  message = appendText(body, 'message-damage', message, output('damage-text', 'text'))
  message = appendText(body, 'message-suffix', message, literal('点魔法伤害，并使其所有主动技能进入至少1回合冷却'))
  action(body, 'success', literal(true), message)
  return body
}

export function buildItachiTotsukaBladeGraph(): GameplayModuleGraph {
  const source = output('source', 'piece')
  const target = output('target', 'piece')
  const resolvedBody: GameplayStatement[] = [
    call('source-name', 'attribute.text', { piece: source }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: target }, { attribute: 'name' }),
    call('attack', 'attribute.read', { piece: source }, { attribute: 'attack' }),
    call('power', 'skill.power-multiplier'),
    call('scaled', 'math.multiply', { left: output('attack', 'value'), right: output('power', 'value') }),
    call('amount', 'math.floor', { value: output('scaled', 'value') }),
    call('cooldown', 'skill.adjust-active-cooldowns-at-least', { piece: target, amount: literal(1) }),
    call('hit', 'effect.damage', { source, target, amount: output('amount', 'value') }, { damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'itachi-totsuka-blade' }),
    ...buildTotsukaSuccessBody(output('target-name', 'text')),
  ]
  return graph([
    call('holder', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('holder', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 3, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
    branch('choice-check', output('unresolved', 'value'), pendingReturn('choice')),
    call('target', 'choice.piece', { choice: output('choice', 'choice') }),
    ...resolvedBody,
  ])
}

export function buildSageTotsukaGraph(id: SageTotsukaSkillId): GameplayModuleGraph {
  return id === 'hashirama-edo-sage-buddha' ? buildHashiramaEdoSageBuddhaGraph() : buildItachiTotsukaBladeGraph()
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as JsonRecord)[key])}`).join(',')}}`
}
const GENERATED_FIELDS = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])

function assertCompatibility(current: JsonRecord, baseline: JsonRecord, id: string): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (GENERATED_FIELDS.has(key)) continue
    if (canonical(current[key]) !== canonical(baseline[key])) throw new Error(`${id}: changed compatibility field ${key}`)
  }
}

function applySageTotsukaGraph(inputDocument: JsonRecord, graphValue: GameplayModuleGraph): JsonRecord {
  const compiled = compileGameplayModuleGraph(graphValue, GAMEPLAY_MODULE_REGISTRY)
  if (compiled.surface !== 'skill') throw new Error('sage/totsuka graph must target skill surface')
  const next: JsonRecord = { ...inputDocument }
  const additional: JsonRecord = isRecord(inputDocument.contentGraphEntries) ? { ...inputDocument.contentGraphEntries } : {}
  const primaryField = isRecord(inputDocument.contentGraph) && typeof inputDocument.contentGraphField === 'string' ? inputDocument.contentGraphField : ''
  if (primaryField === 'code') {
    delete next.contentGraph
    delete next.contentGraphField
    delete next.contentGraphCompilerVersion
    const first = Object.keys(additional).sort()[0]
    if (first) {
      const entry = additional[first]
      if (!isRecord(entry)) throw new Error(`invalid legacy graph entry ${first}`)
      next.contentGraph = entry.graph
      next.contentGraphField = first
      next.contentGraphCompilerVersion = entry.compilerVersion
      delete additional[first]
    }
  } else {
    delete additional.code
  }
  if (Object.keys(additional).length) next.contentGraphEntries = additional
  else delete next.contentGraphEntries
  next.code = compiled.code
  const prior = isRecord(inputDocument.gameplayModules) && isRecord(inputDocument.gameplayModules.entries)
    ? inputDocument.gameplayModules as JsonRecord & { entries: Record<string, unknown>; textBindings?: unknown }
    : undefined
  next.gameplayModules = {
    ...(prior && prior.textBindings !== undefined ? { textBindings: prior.textBindings } : {}),
    version: 'rvb-gameplay-module-document/v1',
    entries: { ...(prior?.entries ?? {}), code: { graph: JSON.parse(JSON.stringify(graphValue)), compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION } },
  }
  assertGameplayModuleDocument(next)
  return next
}

export function applySemanticSageTotsukaGraph(inputDocument: JsonRecord, graphValue: GameplayModuleGraph): JsonRecord {
  return applySageTotsukaGraph(inputDocument, graphValue)
}

function assertSource(current: JsonRecord, baseline: JsonRecord, id: SageTotsukaSkillId): void {
  try {
    assertFrozenExecutable(current, baseline, 'code', 'skill', id)
  } catch (error) {
    const hasLegacyGraph = isRecord(current.contentGraph) && current.contentGraphField === 'code' && current.contentGraphCompilerVersion === 'rvb-content-graph-compiler/v1'
    const entries = isRecord(current.gameplayModules) && isRecord(current.gameplayModules.entries) ? current.gameplayModules.entries : undefined
    if (typeof current.code === 'string' && (hasLegacyGraph || isRecord(entries?.previewCode))) return
    throw error
  }
}

function migrateOne(root: string, baseline: JsonRecord, id: SageTotsukaSkillId): JsonRecord {
  const original = isRecord(baseline.entries) ? baseline.entries['skills/' + id] : undefined
  if (!original) throw new Error(`${id}: missing frozen baseline`)
  const file = path.join(root, 'data', 'skills', `${id}.json`)
  if (!fs.existsSync(file)) throw new Error(`${id}: production file does not exist`)
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
  assertCompatibility(current, original as JsonRecord, id)
  const entries = isRecord(current.gameplayModules) && isRecord(current.gameplayModules.entries) ? current.gameplayModules.entries : undefined
  const owned = entries?.code
  const expected = buildSageTotsukaGraph(id)
  if (isRecord(owned)) {
    assertGameplayModuleDocument(current)
    if (canonical(owned.graph) !== canonical(expected)) throw new Error(`${id}: existing gameplay module graph differs from the frozen migration graph`)
    return applySageTotsukaGraph(current, expected)
  }
  assertSource(current, original as JsonRecord, id)
  return applySageTotsukaGraph(current, expected)
}

export type SemanticSageTotsukaResult = { readonly id: SageTotsukaSkillId; readonly status: 'ready' | 'blocked'; readonly error?: string; readonly document?: JsonRecord; readonly file: string }

export function runSemanticSageTotsukaMigrations(root: string, baseline: JsonRecord, selectedIds?: readonly string[]): readonly SemanticSageTotsukaResult[] {
  const selected = selectedIds?.length ? SAGE_TOTSUKA_SKILL_IDS.filter(id => selectedIds.includes(id)) : SAGE_TOTSUKA_SKILL_IDS
  return selected.map(id => {
    const file = path.join(root, 'data', 'skills', `${id}.json`)
    try { return { id, status: 'ready', document: migrateOne(root, baseline, id), file } }
    catch (error) { return { id, status: 'blocked', error: error instanceof Error ? error.message : String(error), file } }
  })
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2), write = args.includes('--write'), selected = args.filter(value => value !== '--write')
  if (selected.some(id => !SAGE_TOTSUKA_SKILL_IDS.includes(id as SageTotsukaSkillId))) throw new Error(`Unknown sage/totsuka migration: ${selected.join(', ')}`)
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'), 'utf8')) as JsonRecord
  const results = runSemanticSageTotsukaMigrations(root, baseline, selected)
  const blocked = results.filter(result => result.status === 'blocked')
  if (write && blocked.length) throw new Error(JSON.stringify({ message: 'Semantic sage/totsuka migration is blocked; no production files were written.', blocked }, null, 2))
  if (write) for (const result of results) if (result.document) fs.writeFileSync(result.file, JSON.stringify(result.document, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ mode: write ? 'written' : 'dry-run', compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION, graphVersion: GAMEPLAY_MODULE_GRAPH_VERSION, migrations: results.map(({ id, status, error }) => ({ id, status, error })) }, null, 2))
  if (blocked.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli()
