/* eslint-disable @typescript-eslint/no-explicit-any -- Execute compiled authoring fixtures through the production battle runner. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySkillGraph, assertSkillGraphArtifact, compileSkillGraph, createSkillGraph, GRAPH_VERSION, newGraphNode, type SkillGraph, type NodeKind } from '../../electron-editor/skill-graph'
import { readDocumentSnapshot, writeDocumentSnapshot } from '../../electron-editor/content-project'
import { runBattleAction, hashBattleState } from '../../lib/game/battle-runner'
import { loadAllSkillsById } from '../../lib/game/skills'
import { prepareAction } from '../../lib/game/targeting'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { removePieceStatusSource } from '../../lib/game/status-lifecycle'
import { makePiece, makeState } from '../helpers/minimal-state'

function chain(parts: Array<[NodeKind, Record<string, unknown>?]>): SkillGraph {
  const nodes = parts.map(([kind, params], index) => ({ ...newGraphNode(kind, 'n' + index), params: { ...newGraphNode(kind, 'unused').params, ...params } }))
  nodes.forEach((node, index) => { if (index < nodes.length - 1) node.next = nodes[index + 1].id })
  return { version: GRAPH_VERSION, entry: nodes[0].id, nodes }
}
const drainGraph = () => chain([
  ['start'], ['select-piece', { relation: 'enemy', range: 5 }],
  ['damage', { target: 'n1', basis: 'fixed', value: 10, damageType: 'true' }],
  ['heal', { target: 'self', basis: 'actualDamage', source: 'n2', value: 50 }], ['end'],
])
function skill(graph: SkillGraph): any {
  return applySkillGraph({ id: 'graph-fixture', name: '图技能', type: 'normal', cooldownTurns: 1, maxCharges: 0, actionPointCost: 1, powerMultiplier: 1, extension: { preserved: true } }, graph)
}
function stateFor(graph: SkillGraph) {
  const state = makeState({ width: 10, height: 5, pieces: [
    makePiece({ instanceId: 'caster', x: 0, y: 0, currentHp: 50, maxHp: 100 }),
    makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 2, maxHp: 100 }),
    makePiece({ instanceId: 'other', ownerPlayerId: 'player-blue', x: 9, y: 0 }),
    makePiece({ instanceId: 'ally', x: 1, y: 0 }),
  ] })
  state.skillsById = { ...loadAllSkillsById(), 'graph-fixture': skill(graph) }
  state.pieces[0].skills = [{ skillId: 'graph-fixture', currentCooldown: 0, usesRemaining: -1 } as any]
  return state
}
const action = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'graph-fixture' } as const
function command(state: any, target = 'target', extraTargets?: unknown[]) {
  const prepared = prepareAction(state, action)
  if (prepared.kind !== 'needTarget') throw new Error('expected target selection: ' + prepared.kind)
  return { ...action, targetPieceId: target, extraTargets, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as any
}
const folders: string[] = []
beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

describe('typed skill graph authoring', () => {
  it('generates deterministic code, target steps and descriptions from one definition', () => {
    const graph = drainGraph(), compiled = compileSkillGraph(graph)
    expect(compileSkillGraph(JSON.parse(JSON.stringify(graph)))).toEqual(compiled)
    expect(compiled.targeting.steps).toHaveLength(1)
    expect(compiled.description).toContain('10点真实伤害')
    expect(compiled.description).toContain('实际伤害50%')
    const preview = new Function(compiled.previewCode + '; return calculatePreview;')()
    expect(preview().description).toBe(compiled.description)
    expect(skill(graph).extension).toEqual({ preserved: true })
    expect(() => assertSkillGraphArtifact(skill(graph))).not.toThrow()
  })
  it('rejects unknown versions, duplicate IDs, disconnected nodes and control cycles', () => {
    expect(() => compileSkillGraph({ ...createSkillGraph(), version: 'future' })).toThrow('版本')
    const duplicate = createSkillGraph(); duplicate.nodes[1].id = 'start'
    expect(() => compileSkillGraph(duplicate)).toThrow('重复')
    const detached = createSkillGraph(); detached.nodes.push(newGraphNode('end', 'unused'))
    expect(() => compileSkillGraph(detached)).toThrow('未连接')
    const loop = drainGraph(); loop.nodes[3].next = 'n2'
    expect(() => compileSkillGraph(loop)).toThrow('循环')
  })
  it('rejects mismatched data ports, forward values, invalid numbers and choices after effects', () => {
    const type = drainGraph(); type.nodes[3].params.source = 'n1'
    expect(() => compileSkillGraph(type)).toThrow('类型不匹配')
    const forward = drainGraph(); forward.nodes[2].params = { ...forward.nodes[2].params, basis: 'actualDamage', source: 'n2' }
    expect(() => compileSkillGraph(forward)).toThrow('前置路径')
    const nan = drainGraph(); nan.nodes[2].params.value = NaN
    expect(() => compileSkillGraph(nan)).toThrow('数值')
    const late = chain([['start'], ['heal'], ['select-piece'], ['end']])
    expect(() => compileSkillGraph(late)).toThrow('选择必须')
  })
  it('requires data dependencies to dominate both sides of a branch', () => {
    const graph = chain([['start'], ['condition'], ['damage'], ['heal', { basis: 'actualDamage', source: 'n2' }], ['end']])
    delete graph.nodes[1].next; graph.nodes[1].yes = 'n2'; graph.nodes[1].no = 'n3'
    expect(() => compileSkillGraph(graph)).toThrow('前置路径')
  })
  it('rejects inconsistent artifacts at the atomic save boundary without changing the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-graph-')); folders.push(root)
    const file = join(root, 'skill.json'), original = skill(drainGraph())
    writeFileSync(file, JSON.stringify(original))
    const snapshot = readDocumentSnapshot(file)
    expect(() => writeDocumentSnapshot(file, { ...original, code: 'changed' }, snapshot.revision)).toThrow('不一致')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(original)
    const next = { ...original, name: '改名但不改效果' }
    writeDocumentSnapshot(file, next, snapshot.revision)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(next)
  })
})

describe('compiled graphs use the production battle engine', () => {
  it('heals from actual HP loss rather than overkill and is deterministic', () => {
    const state = stateFor(drainGraph()), before = hashBattleState(state), cmd = command(state)
    const first = runBattleAction(state, cmd, { rootSeed: 192 }).state
    const second = runBattleAction(state, cmd, { rootSeed: 192 }).state
    expect(first.pieces.find(piece => piece.instanceId === 'caster')!.currentHp).toBe(51)
    expect(hashBattleState(first)).toBe(hashBattleState(second))
    expect(hashBattleState(state)).toBe(before)
    expect(first.players[0].actionPoints).toBe(state.players[0].actionPoints - 1)
  })
  it('installs a real divine shield, which blocks damage without triggering lifesteal', () => {
    const graph = chain([['start'], ['select-piece'], ['status', { target: 'n1', status: 'divine-shield', turns: -1 }], ['damage', { target: 'n1', basis: 'fixed', value: 10, damageType: 'true' }], ['heal', { target: 'self', basis: 'actualDamage', source: 'n3', value: 50 }], ['end']])
    const state = stateFor(graph)
    const result = runBattleAction(state, command(state), { rootSeed: 192 }).state
    expect(result.pieces.find(piece => piece.instanceId === 'target')!.currentHp).toBe(2)
    expect(result.pieces[0].currentHp).toBe(50)
    expect(result.pieces.find(piece => piece.instanceId === 'target')!.statusTags.some(tag => tag.type === 'divine-shield')).toBe(false)
  })
  it('selects an ally and a destination through the existing authority contract', () => {
    const graph = chain([['start'], ['select-piece', { relation: 'ally', range: 7 }], ['select-cell', { range: 7 }], ['teleport', { target: 'n1', cell: 'n2' }], ['end']])
    const state = stateFor(graph)
    const result = runBattleAction(state, command(state, 'ally', [{ x: 5, y: 1 }]), { rootSeed: 192 }).state
    expect(result.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({ x: 5, y: 1 })
    expect(result.pieces[0]).toMatchObject({ x: 0, y: 0 })
    const before = hashBattleState(state)
    expect(() => runBattleAction(state, command(state, 'ally', [{ x: 2, y: 0 }]), { rootSeed: 192 })).toThrow()
    expect(hashBattleState(state)).toBe(before)
    expect(() => runBattleAction(result, command(state, 'ally', [{ x: 5, y: 1 }]), { rootSeed: 192 })).toThrow()
    const pending = prepareAction(state, { ...command(state, 'ally'), extraTargets: undefined })
    expect(pending.kind).toBe('needTarget')
    expect(hashBattleState(state)).toBe(before) // abandoning the second choice commits nothing
    state.pieces.find(piece => piece.instanceId === 'ally')!.statusTags = [{ id: 'lock', type: 'imprisoned' } as any]
    const blockedBefore = hashBattleState(state), candidates = prepareAction(state, action)
    if (candidates.kind === 'needTarget') expect(candidates.candidates).not.toContainEqual({ type: 'piece', pieceId: 'ally' })
    expect(() => runBattleAction(state, command(state, 'ally', [{ x: 5, y: 1 }]), { rootSeed: 192 })).toThrow()
    expect(hashBattleState(state)).toBe(blockedBefore)
  })
  it('preserves each caster contribution when graph-applied roots merge', () => {
    const graph = chain([['start'], ['select-piece'], ['status', { target: 'n1', status: 'root', turns: 1 }], ['end']])
    const state = stateFor(graph)
    let result = runBattleAction(state, command(state), { rootSeed: 192 }).state
    result.skillsById = state.skillsById
    const second = result.pieces.find(piece => piece.instanceId === 'ally')!
    second.skills = [{ skillId: 'graph-fixture', currentCooldown: 0, usesRemaining: -1 } as any]
    const base = { ...action, pieceId: 'ally' }, prepared = prepareAction(result, base)
    if (prepared.kind !== 'needTarget') throw new Error('expected second caster selection')
    result = runBattleAction(result, { ...base, targetPieceId: 'target', selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }, { rootSeed: 192 }).state
    const target = result.pieces.find(piece => piece.instanceId === 'target')!
    expect(target.statusTags.filter(tag => tag.type === 'root')).toHaveLength(1)
    expect(target.statusTags[0].currentDuration).toBe(2)
    removePieceStatusSource(target, 'caster')
    expect(target.statusTags[0].currentDuration).toBe(1)
    expect(target.statusTags[0].statusOrigins).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'ally' })]))
  })
  it('executes only the selected branch and uses the common timed root status', () => {
    const graph = chain([['start'], ['condition', { target: 'self', value: 75 }], ['status', { target: 'self', status: 'root', turns: 1 }], ['end']])
    delete graph.nodes[1].next; graph.nodes[1].yes = 'n2'; graph.nodes[1].no = 'n3'
    const state = stateFor(graph)
    const result = runBattleAction(state, action, { rootSeed: 192 }).state
    expect(result.pieces[0].statusTags).toContainEqual(expect.objectContaining({ type: 'root', currentDuration: 1 }))
    state.pieces[0].currentHp = 100
    expect(runBattleAction(state, action, { rootSeed: 192 }).state.pieces[0].statusTags).toEqual([])
  })
})
