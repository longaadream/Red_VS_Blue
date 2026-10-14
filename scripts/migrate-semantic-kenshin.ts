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
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const KENSHIN_SKILL_IDS = ['kenshin-amakakeru', 'kenshin-ryusosen', 'kenshin-ryutsuisen'] as const
export type KenshinSkillId = typeof KENSHIN_SKILL_IDS[number]

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
type MutableIfStatement = { kind: 'if'; id: string; condition: GameplayValue; then: GameplayStatement[]; else?: GameplayStatement[] }
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], elseBody: GameplayStatement[] = []): MutableIfStatement => ({ kind: 'if', id, condition, then, ...(elseBody.length ? { else: elseBody } : {}) })

function actionResult(body: GameplayStatement[], id: string, success: boolean, message: GameplayValue): void {
  body.push(call(id + '-record', 'result.action', { success: literal(success), message }), { kind: 'return', id, value: output(id + '-record', 'result') })
}

/** Wrap only action returns. Collection bodies retain their scalar returns. */
function wrapActionReturns(nodes: readonly GameplayStatement[]): GameplayStatement[] {
  const result: GameplayStatement[] = []
  for (const node of nodes) {
    if (node.kind === 'return' && node.values) {
      const recordId = node.id + '-record'
      result.push(call(recordId, 'result.action', { success: node.values.success, message: node.values.message }), { kind: 'return', id: node.id, value: output(recordId, 'result') })
      continue
    }
    if (node.kind === 'if') { result.push({ ...node, then: wrapActionReturns(node.then), ...(node.else ? { else: wrapActionReturns(node.else) } : {}) }); continue }
    if (node.kind === 'foreach') { result.push({ ...node, body: wrapActionReturns(node.body) }); continue }
    result.push(node)
  }
  return result
}

function graph(body: GameplayStatement[]): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    schemas: [],
    body: wrapActionReturns(body),
  }
}

function pendingBranch(body: GameplayStatement[]): MutableIfStatement {
  const node = branch('choice-unresolved', output('unresolved', 'value'), [])
  body.push(node)
  const target = node.then
  target.push(call('pending-result', 'choice.as-result', { choice: output('choice', 'choice') }), { kind: 'return', id: 'pending-return', value: output('pending-result', 'result') })
  return node
}

function buildAmakakeruGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 99, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
  ]
  pendingBranch(body)
  body.push(
    call('target', 'choice.piece', { choice: output('choice', 'choice') }),
    call('target-present', 'card.piece-present', { value: output('target', 'piece') }),
  )
  const targetPresent = branch('target-present-branch', output('target-present', 'present'), [])
  body.push(targetPresent)
  const targetInvalid: GameplayStatement[] = []
  actionResult(targetInvalid, 'target-invalid', false, literal('目标不存在'))
  targetPresent.else = targetInvalid
  targetPresent.then.push(
    call('target-hp', 'attribute.read', { piece: output('target', 'piece') }, { attribute: 'currentHp' }),
    call('target-alive', 'compare.greater-than', { left: output('target-hp', 'value'), right: literal(0) }),
  )
  const targetAlive = branch('target-alive-branch', output('target-alive', 'value'), [])
  targetPresent.then.push(targetAlive)
  const targetDead: GameplayStatement[] = []
  actionResult(targetDead, 'target-dead', false, literal('目标不存在'))
  targetAlive.else = targetDead

  const valid = targetAlive.then
  valid.push(
    call('cells', 'spatial.cardinal-cells', { target: output('target', 'piece') }),
    {
      kind: 'collection.filter', id: 'legal-cells', items: output('cells', 'cells'), item: 'cell',
      inputs: { caster: output('source', 'piece') },
      body: [
        call('legal', 'spatial.cell-landing-legal', { cell: { kind: 'input', name: 'cell' }, ignoreA: { kind: 'input', name: 'caster' } }, { terrainPolicy: 'walkable' }),
        { kind: 'return', id: 'legal-return', value: output('legal', 'legal') },
      ],
    },
    call('count', 'list.count-cells', { items: output('legal-cells', 'value') }),
    call('has-cells', 'compare.greater-than', { left: output('count', 'value'), right: literal(0) }),
  )
  const hasCells = branch('has-cells-branch', output('has-cells', 'value'), [])
  valid.push(hasCells)
  const noLanding: GameplayStatement[] = []
  actionResult(noLanding, 'no-landing', false, literal('目标相邻地格没有合法落点'))
  hasCells.else = noLanding
  hasCells.then.push(
    call('landing', 'query.random-cell', { items: output('legal-cells', 'value') }),
    call('landing-present', 'value.present-cell', { value: output('landing', 'cell') }),
  )
  const landingPresent = branch('landing-present-branch', output('landing-present', 'present'), [])
  hasCells.then.push(landingPresent)
  const randomFailure: GameplayStatement[] = []
  actionResult(randomFailure, 'random-failure', false, literal('目标相邻地格没有合法落点'))
  landingPresent.else = randomFailure
  landingPresent.then.push(
    call('landing-safe', 'spatial.cell-require', { cell: output('landing', 'cell') }),
    call('saved-source', 'source.capture', { source: output('source', 'piece') }),
    call('saved-target', 'source.capture', { source: output('target', 'piece') }),
    call('move', 'effect.teleport-if-present', { piece: output('source', 'piece'), destination: output('landing-safe', 'cell') }),
  )
  const moved = branch('move-branch', output('move', 'success'), [])
  landingPresent.then.push(moved)
  const blocked: GameplayStatement[] = []
  actionResult(blocked, 'blocked', true, literal('位移被阻挡，本次位移效果取消'))
  moved.else = blocked
  moved.then.push(
    call('attack', 'source.captured-number', { source: output('saved-source', 'source') }, { field: 'attack' }),
    call('scaled', 'math.multiply', { left: output('attack', 'value'), right: literal(2) }),
    call('amount', 'math.floor', { value: output('scaled', 'value') }),
    call('damage', 'effect.damage-captured', { source: output('saved-source', 'source'), target: output('saved-target', 'source'), amount: output('amount', 'value') }, { damageType: 'true', skillId: 'kenshin-amakakeru' }),
    call('damage-number', 'effect.result-number', { result: output('damage', 'result') }, { field: 'damage' }),
    call('source-name', 'piece.captured-name', { source: output('saved-source', 'source') }),
    call('target-name', 'piece.captured-name', { source: output('saved-target', 'source') }),
    call('damage-text', 'text.from-number', { value: output('damage-number', 'value') }),
    call('message-a', 'text.concat', { left: output('source-name', 'value'), right: literal('以天翔龙闪斩向') }),
    call('message-b', 'text.concat', { left: output('message-a', 'text'), right: output('target-name', 'value') }),
    call('message-c', 'text.concat', { left: output('message-b', 'text'), right: literal('，造成') }),
    call('message-d', 'text.concat', { left: output('message-c', 'text'), right: output('damage-text', 'text') }),
    call('message', 'text.concat', { left: output('message-d', 'text'), right: literal('点真实伤害') }),
    call('target-after-hp', 'source.captured-number', { source: output('saved-target', 'source') }, { field: 'currentHp' }),
    call('target-killed', 'compare.less-or-equal', { left: output('target-after-hp', 'value'), right: literal(0) }),
  )
  const killed = branch('killed-branch', output('target-killed', 'value'), [])
  moved.then.push(killed)
  const sourceOwner: GameplayStatement[] = [
    // Keep the detached source handle alive through the damage/death pipeline.
    // The legacy callback reads the caster's owner after the attack, even when
    // a trigger has removed the caster from battle during that attack.
    call('owner', 'source.captured-owner', { source: output('saved-source', 'source') }),
    call('owner-present', 'query.has-player', { playerId: output('owner', 'player') }),
  ]
  const ownerBranch = branch('owner-branch', output('owner-present', 'exists'), [])
  sourceOwner.push(ownerBranch)
  ownerBranch.then.push(call('restore-ap', 'resource.adjust', { player: output('owner', 'player'), amount: literal(1) }, { resource: 'actionPoints' }))
  killed.then.push(...sourceOwner)
  killed.then.push(
    call('kill-message', 'text.concat', { left: output('message', 'text'), right: literal('，击杀目标并恢复1点行动点') }),
  )
  actionResult(killed.then, 'killed-success', true, output('kill-message', 'text'))
  killed.else = []
  actionResult(killed.else, 'ordinary-success', true, output('message', 'text'))
  return graph(body)
}

function buildRyusosenGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 1, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
  ]
  pendingBranch(body)
  body.push(call('target', 'choice.piece', { choice: output('choice', 'choice') }), call('target-present', 'card.piece-present', { value: output('target', 'piece') }))
  const targetPresent = branch('target-present-branch', output('target-present', 'present'), [])
  body.push(targetPresent)
  const targetInvalid: GameplayStatement[] = []
  actionResult(targetInvalid, 'target-invalid', false, literal('目标不存在或不相邻'))
  targetPresent.else = targetInvalid
  targetPresent.then.push(call('target-hp', 'attribute.read', { piece: output('target', 'piece') }, { attribute: 'currentHp' }), call('target-alive', 'compare.greater-than', { left: output('target-hp', 'value'), right: literal(0) }))
  const targetAlive = branch('target-alive-branch', output('target-alive', 'value'), [])
  targetPresent.then.push(targetAlive)
  const dead: GameplayStatement[] = []
  actionResult(dead, 'target-dead', false, literal('目标不存在或不相邻'))
  targetAlive.else = dead
  targetAlive.then.push(
    call('saved-source', 'source.capture', { source: output('source', 'piece') }),
    call('saved-target', 'source.capture', { source: output('target', 'piece') }),
    call('total', 'local.counter-create', { initial: literal(0) }),
    call('hits', 'local.counter-create', { initial: literal(0) }),
    {
      kind: 'foreach', id: 'hit-sequence', items: literal([0, 1, 2]), item: 'hit', body: [
        call('hit-target-hp', 'source.captured-number', { source: output('saved-target', 'source') }, { field: 'currentHp' }),
        call('hit-target-alive', 'compare.greater-than', { left: output('hit-target-hp', 'value'), right: literal(0) }),
        branch('hit-guard', output('hit-target-alive', 'value'), [
          call('attack', 'source.captured-number', { source: output('saved-source', 'source') }, { field: 'attack' }),
          call('scaled', 'math.multiply', { left: output('attack', 'value'), right: literal(0.75) }),
          call('amount', 'math.floor', { value: output('scaled', 'value') }),
          call('damage', 'effect.damage-captured', { source: output('saved-source', 'source'), target: output('saved-target', 'source'), amount: output('amount', 'value') }, { damageType: 'physical', skillId: 'kenshin-ryusosen' }),
          call('dealt', 'effect.result-number', { result: output('damage', 'result') }, { field: 'damage' }),
          call('count-hit', 'local.counter-add', { counter: output('hits', 'counter'), amount: literal(1) }),
          call('sum-damage', 'local.counter-add', { counter: output('total', 'counter'), amount: output('dealt', 'value') }),
        ]),
      ],
    },
    call('source-name', 'piece.captured-name', { source: output('saved-source', 'source') }),
    call('target-name', 'piece.captured-name', { source: output('saved-target', 'source') }),
    call('hit-total', 'local.counter-read', { counter: output('hits', 'counter') }),
    call('damage-total', 'local.counter-read', { counter: output('total', 'counter') }),
    call('hit-text', 'text.from-number', { value: output('hit-total', 'value') }),
    call('damage-text', 'text.from-number', { value: output('damage-total', 'value') }),
    call('message-a', 'text.concat', { left: output('source-name', 'value'), right: literal('发动龙巢闪，对') }),
    call('message-b', 'text.concat', { left: output('message-a', 'text'), right: output('target-name', 'value') }),
    call('message-c', 'text.concat', { left: output('message-b', 'text'), right: literal('连击') }),
    call('message-d', 'text.concat', { left: output('message-c', 'text'), right: output('hit-text', 'text') }),
    call('message-e', 'text.concat', { left: output('message-d', 'text'), right: literal('次，共造成') }),
    call('message-f', 'text.concat', { left: output('message-e', 'text'), right: output('damage-text', 'text') }),
    call('message', 'text.concat', { left: output('message-f', 'text'), right: literal('点伤害') }),
  )
  actionResult(targetAlive.then, 'success', true, output('message', 'text'))
  return graph(body)
}

function buildRyutsuisenGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 5, filter: 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
  ]
  pendingBranch(body)
  body.push(call('target', 'choice.piece', { choice: output('choice', 'choice') }), call('target-present', 'card.piece-present', { value: output('target', 'piece') }))
  const targetPresent = branch('target-present-branch', output('target-present', 'present'), [])
  body.push(targetPresent)
  const targetInvalid: GameplayStatement[] = []
  actionResult(targetInvalid, 'target-invalid', false, literal('目标不存在'))
  targetPresent.else = targetInvalid
  targetPresent.then.push(call('target-hp', 'attribute.read', { piece: output('target', 'piece') }, { attribute: 'currentHp' }), call('target-alive', 'compare.greater-than', { left: output('target-hp', 'value'), right: literal(0) }))
  const targetAlive = branch('target-alive-branch', output('target-alive', 'value'), [])
  targetPresent.then.push(targetAlive)
  const dead: GameplayStatement[] = []
  actionResult(dead, 'target-dead', false, literal('目标不存在'))
  targetAlive.else = dead
  targetAlive.then.push(
    call('cells', 'spatial.shuffle-cardinal-cells', { target: output('target', 'piece') }),
    {
      kind: 'collection.filter', id: 'legal-cells', items: output('cells', 'cells'), item: 'cell',
      inputs: { caster: output('source', 'piece') },
      body: [
        call('legal', 'spatial.cell-landing-legal', { cell: { kind: 'input', name: 'cell' }, ignoreA: { kind: 'input', name: 'caster' } }, { terrainPolicy: 'walkable' }),
        { kind: 'return', id: 'legal-return', value: output('legal', 'legal') },
      ],
    },
    call('landing', 'collection.first-cell', { cells: output('legal-cells', 'value') }),
    call('landing-present', 'value.present-cell', { value: output('landing', 'cell') }),
  )
  const landing = branch('landing-branch', output('landing-present', 'present'), [])
  targetAlive.then.push(landing)
  const noLanding: GameplayStatement[] = []
  actionResult(noLanding, 'no-landing', false, literal('目标周围没有可落脚的位置'))
  landing.else = noLanding
  landing.then.push(
    call('landing-safe', 'spatial.cell-require', { cell: output('landing', 'cell') }),
    call('saved-source', 'source.capture', { source: output('source', 'piece') }),
    call('saved-target', 'source.capture', { source: output('target', 'piece') }),
    call('move', 'effect.displace', { piece: output('source', 'piece'), destination: output('landing-safe', 'cell') }, { kind: 'teleport' }),
  )
  const moved = branch('move-branch', output('move', 'success'), [])
  landing.then.push(moved)
  const blocked: GameplayStatement[] = []
  actionResult(blocked, 'blocked', true, literal('位移被阻挡，本次位移效果取消'))
  moved.else = blocked
  moved.then.push(
    call('attack', 'source.captured-number', { source: output('saved-source', 'source') }, { field: 'attack' }),
    call('amount', 'math.floor', { value: output('attack', 'value') }),
    call('damage', 'effect.damage-captured', { source: output('saved-source', 'source'), target: output('saved-target', 'source'), amount: output('amount', 'value') }, { damageType: 'physical', skillId: 'kenshin-ryutsuisen' }),
    call('damage-number', 'effect.result-number', { result: output('damage', 'result') }, { field: 'damage' }),
    call('source-name', 'piece.captured-name', { source: output('saved-source', 'source') }),
    call('target-name', 'piece.captured-name', { source: output('saved-target', 'source') }),
    call('damage-text', 'text.from-number', { value: output('damage-number', 'value') }),
    call('message-a', 'text.concat', { left: output('source-name', 'value'), right: literal('发动龙槌闪，突进至') }),
    call('message-b', 'text.concat', { left: output('message-a', 'text'), right: output('target-name', 'value') }),
    call('message-c', 'text.concat', { left: output('message-b', 'text'), right: literal('身边，造成') }),
    call('message-d', 'text.concat', { left: output('message-c', 'text'), right: output('damage-text', 'text') }),
    call('message', 'text.concat', { left: output('message-d', 'text'), right: literal('点伤害') }),
  )
  actionResult(moved.then, 'success', true, output('message', 'text'))
  return graph(body)
}

export function buildKenshinSkillGraph(id: KenshinSkillId): GameplayModuleGraph {
  if (id === 'kenshin-amakakeru') return buildAmakakeruGraph()
  if (id === 'kenshin-ryusosen') return buildRyusosenGraph()
  return buildRyutsuisenGraph()
}

const ignoredFields = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
type SkillDocument = Record<string, unknown> & { gameplayModules?: { entries?: { code?: { graph?: unknown } } } }

function assertPreservedFields(next: Record<string, unknown>, original: Record<string, unknown>, id: string): void {
  for (const key of new Set([...Object.keys(original), ...Object.keys(next)])) {
    if (!ignoredFields.has(key) && JSON.stringify(next[key]) !== JSON.stringify(original[key])) throw new Error(`${id}: changed compatibility field ${key}`)
  }
}

export function preflightKenshinSkills(root: string): { migrated: string[]; preserved: string[] } {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const migrated: string[] = [], preserved: string[] = []
  for (const id of KENSHIN_SKILL_IDS) {
    const original = fixture['skills/' + id]
    if (!original) throw new Error(`missing frozen Kenshin skill ${id}`)
    const file = path.join(root, 'data/skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as SkillDocument
    const nextGraph = buildKenshinSkillGraph(id)
    if (current.gameplayModules?.entries?.code) {
      assertGameplayModuleDocument(current)
      if (JSON.stringify(current.gameplayModules.entries.code.graph) !== JSON.stringify(nextGraph)) throw new Error(`${id}: existing gameplay graph differs from approved Kenshin migration graph`)
      assertPreservedFields(current, original, id)
      preserved.push(id)
      continue
    }
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    assertPreservedFields(current, original, id)
    migrated.push(id)
  }
  return { migrated, preserved }
}

export function migrateKenshinSkills(root: string, write = false): { migrated: string[]; preserved: string[] } {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const migrated: string[] = [], preserved: string[] = []
  for (const id of KENSHIN_SKILL_IDS) {
    const original = fixture['skills/' + id]
    if (!original) throw new Error(`missing frozen Kenshin skill ${id}`)
    const file = path.join(root, 'data/skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as SkillDocument
    const nextGraph = buildKenshinSkillGraph(id)
    if (current.gameplayModules?.entries?.code) {
      assertGameplayModuleDocument(current)
      if (JSON.stringify(current.gameplayModules.entries.code.graph) !== JSON.stringify(nextGraph)) {
        if (!write) throw new Error(`${id}: existing gameplay graph differs from approved Kenshin migration graph`)
        const next = applyGameplayModuleGraph(current, nextGraph, 'code')
        assertPreservedFields(next, original, id)
        assertGameplayModuleDocument(next)
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
        migrated.push(id)
        continue
      }
      assertPreservedFields(current, original, id)
      preserved.push(id)
      continue
    }
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    const next = applyGameplayModuleGraph(current, nextGraph, 'code')
    assertPreservedFields(next, original, id)
    assertGameplayModuleDocument(next)
    if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
    migrated.push(id)
  }
  return { migrated, preserved }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(migrateKenshinSkills(process.cwd(), process.argv.includes('--write'))))
}
