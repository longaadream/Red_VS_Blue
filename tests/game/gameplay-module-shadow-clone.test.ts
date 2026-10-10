/* eslint-disable @typescript-eslint/no-explicit-any -- migration fixtures intentionally use JSON-shaped content records. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  applySemanticShadowCloneGraph,
  buildNarutoCloneDiedGraph,
  buildNarutoCloneImmobileGraph,
  buildNarutoCloneOneHitGraph,
  buildNarutoShadowCloneGraph,
  SEMANTIC_SHADOW_CLONE_MIGRATIONS,
  SHADOW_CLONE_GAMEPLAY_REGISTRY,
  runSemanticShadowCloneMigrations,
} from '@/scripts/migrate-semantic-shadow-clone'
import { compileGameplayModuleGraph } from '@/lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '@/lib/skill-graph/module-types'
import { applyBattleAction, type BattleAction, type BattleState } from '@/lib/game/turn'
import { dealDamage, clearRuleCache } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import * as preview from '@/lib/game/skill-preview'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
type Fixture = { entries: Record<string, JsonRecord>; baseSha?: string }

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as Fixture

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function calls(graph: any): string[] {
  const found: string[] = []
  const visit = (body: readonly any[]) => body.forEach(node => {
    if (node.kind === 'call') found.push(node.module)
    if (node.kind === 'if') { visit(node.then); visit(node.else ?? []) }
    if (node.kind === 'foreach') visit(node.body)
    if (node.kind === 'collection') visit(node.body)
  })
  visit(graph.body)
  for (const composite of graph.composites ?? []) visit(composite.body)
  return found
}

function writeJson(root: string, relative: string, value: unknown): void {
  const filename = join(root, 'data', relative)
  mkdirSync(dirname(filename), { recursive: true })
  writeFileSync(filename, JSON.stringify(value), 'utf8')
}

function fixtureEntry(id: string): JsonRecord {
  const value = fixture.entries[id]
  if (!value) throw new Error(`missing frozen fixture entry ${id}`)
  return value
}

function migratedEntry(id: string): JsonRecord {
  const migration = SEMANTIC_SHADOW_CLONE_MIGRATIONS.find(entry => entry.id === id)
  if (!migration) throw new Error(`missing semantic migration ${id}`)
  return applySemanticShadowCloneGraph(clone(fixtureEntry(id)), migration.build(), migration.field)
}

function writeCloneEntries(root: string, semantic: boolean): void {
  const ids = [
    'skills/naruto-shadow-clone',
    'rules/rule-naruto-clone-died',
    'rules/rule-naruto-clone-immobile',
    'rules/rule-naruto-clone-one-hit',
  ]
  for (const id of ids) {
    const value = semantic ? migratedEntry(id) : clone(fixtureEntry(id))
    writeJson(root, id.startsWith('skills/') ? `skills/${id.slice('skills/'.length)}.json` : `rules/${id.slice('rules/'.length)}.json`, value)
  }
}

function withProfile<T>(semantic: boolean, callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-shadow-clone-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  try {
    writeCloneEntries(root, semantic)
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache()
    return callback(root)
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function cloneState(skill: JsonRecord): BattleState {
  const source = makePiece({
    instanceId: 'naruto', templateId: 'red-naruto', name: '鸣人', ownerPlayerId: 'player-red',
    x: 1, y: 1, currentHp: 20, maxHp: 20,
    skills: [{ skillId: 'naruto-shadow-clone', currentCooldown: 0, usesRemaining: -1 }],
  })
  ;(source as any).name = '鸣人'
  const state = makeState({ pieces: [source], width: 7, height: 7, currentPlayerId: 'player-red', phase: 'action' })
  state.skillsById['naruto-shadow-clone'] = skill as any
  state.players[0].actionPoints = 5
  return state
}

function actionRoot(selectedOption?: string): BattleAction {
  return {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: 'naruto', skillId: 'naruto-shadow-clone',
    ...(selectedOption === undefined ? {} : { selectedOption }),
  } as BattleAction
}

function completeCloneAction(initial: BattleState, option: 'summon' | 'teleport', target: { x: number; y: number }): BattleState {
  const root = actionRoot()
  const first = preview.preparePublicSkillAction(initial, root, 'player-red')
  expect(first.status).toBe('needs-input')
  if (first.status !== 'needs-input' || !first.preparation || first.preparation.kind !== 'needOption') throw new Error('expected option preparation')
  const chosen = {
    ...root, selectedOption: option,
    selectionId: first.preparation.selectionId, stateRevision: first.preparation.stateRevision,
  } as BattleAction
  const second = preview.preparePublicSkillAction(initial, chosen, 'player-red')
  expect(second.status).toBe('needs-input')
  if (second.status !== 'needs-input' || !second.preparation || second.preparation.kind !== 'needTarget') throw new Error('expected target preparation')
  return applyBattleAction(initial, {
    ...chosen, targetX: target.x, targetY: target.y,
    selectionId: second.preparation.selectionId, stateRevision: second.preparation.stateRevision,
  } as BattleAction)
}

function stateSnapshot(state: BattleState): unknown {
  return {
    actionPoints: state.players.map(player => [player.playerId, player.actionPoints]),
    pendingOption: state.pendingOptionSelection ? {
      title: state.pendingOptionSelection.title,
      options: state.pendingOptionSelection.options,
    } : undefined,
    pendingTarget: state.pendingTargetSelection ? {
      targetType: state.pendingTargetSelection.targetType,
      range: state.pendingTargetSelection.range,
      candidates: state.pendingTargetSelection.candidates,
    } : undefined,
    pieces: state.pieces.map(piece => ({
      instanceId: piece.instanceId.startsWith('naruto-clone-') ? 'clone' : piece.instanceId, x: piece.x, y: piece.y, currentHp: piece.currentHp,
      skills: (piece.skills ?? []).map(skill => ({ skillId: skill.skillId, currentCooldown: skill.currentCooldown, usesRemaining: skill.usesRemaining })),
      rules: (piece.rules ?? []).map(rule => rule.id).sort(),
      statusTags: (piece.statusTags ?? []).map(tag => ({ id: String(tag.id ?? '').startsWith('naruto-clone-tag-') ? 'clone-tag' : tag.id, type: tag.type, visible: tag.visible })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    })).sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    graveyard: (state.graveyard ?? []).map(piece => ({ instanceId: piece.instanceId.startsWith('naruto-clone-') ? 'clone' : piece.instanceId, currentHp: piece.currentHp })).sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    messages: (state.actions ?? []).map(action => action?.payload?.message).filter(Boolean),
  }
}

function zeroHealthProbeGraph() {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule' as const,
    outputs: [{ name: 'success', type: 'boolean' as const }],
    body: [
      { kind: 'call' as const, id: 'target-ref', module: 'ref.target', version: '1', inputs: {}, parameters: {} },
      { kind: 'call' as const, id: 'target-present', module: 'query.has-piece', version: '1', inputs: { pieceId: { kind: 'output' as const, node: 'target-ref', port: 'piece' } }, parameters: {} },
      { kind: 'if' as const, id: 'target-guard', condition: { kind: 'output' as const, node: 'target-present', port: 'exists' }, then: [
        { kind: 'call' as const, id: 'target-piece', module: 'query.piece', version: '1', inputs: { pieceId: { kind: 'output' as const, node: 'target-ref', port: 'piece' } }, parameters: {} },
        { kind: 'call' as const, id: 'zero-health', module: 'lifecycle.zero-health', version: '1', inputs: { target: { kind: 'output' as const, node: 'target-piece', port: 'piece' } }, parameters: {} },
        { kind: 'return' as const, id: 'return', value: { kind: 'output' as const, node: 'zero-health', port: 'success' } },
      ], else: [
        { kind: 'return' as const, id: 'missing-target', value: { kind: 'literal' as const, value: false } },
      ] },
      { kind: 'return' as const, id: 'fallback', value: { kind: 'literal' as const, value: false } },
    ],
  }
}

function executeZeroHealthProbe(eventType: string, targetId: string, sourceId: string): { result: unknown; pieces: Record<string, { currentHp: number }> } {
  const compiled = compileGameplayModuleGraph(zeroHealthProbeGraph(), SHADOW_CLONE_GAMEPLAY_REGISTRY)
  const pieces = { victim: { instanceId: 'victim', currentHp: 9 }, unrelated: { instanceId: 'unrelated', currentHp: 7 } }
  const flow = {
    event: { read: () => ({ type: eventType }) },
    refs: { source: () => sourceId, target: () => targetId },
    query: {
      hasPiece: (id: string) => Object.prototype.hasOwnProperty.call(pieces, id),
      piece: (id: string) => pieces[id as keyof typeof pieces],
    },
  }
  const result = new Function('flow', compiled.code)(flow)
  return { result, pieces }
}

describe('RED-252 Naruto shadow-clone semantic module graph', () => {
  it('compiles the Skill + StatusTag + Rule cluster from reusable modules', () => {
    const graphs = [
      buildNarutoShadowCloneGraph(), buildNarutoCloneDiedGraph(),
      buildNarutoCloneImmobileGraph(), buildNarutoCloneOneHitGraph(),
    ]
    for (const graph of graphs) {
      expect(() => compileGameplayModuleGraph(graph, SHADOW_CLONE_GAMEPLAY_REGISTRY)).not.toThrow()
      expect(calls(graph).some(module => module.includes('naruto'))).toBe(false)
    }
    const skillCalls = calls(graphs[0])
    expect(skillCalls.indexOf('choice.option-pair')).toBeGreaterThanOrEqual(0)
    expect(skillCalls.indexOf('choice.target-cell')).toBeGreaterThan(skillCalls.indexOf('choice.option-pair'))
    expect(skillCalls).toEqual(expect.arrayContaining([
      'spatial.piece-position', 'spatial.cell-distance', 'spatial.cell-walkable',
      'spatial.cell-landing-legal', 'effect.teleport', 'lifecycle.queue-summon',
    ]))
    expect(calls(graphs[1])).toEqual(expect.arrayContaining(['ref.source', 'ref.target', 'result.message']))
    expect(calls(graphs[2])).toEqual(expect.arrayContaining(['piece.alive', 'status.has-piece', 'event.block', 'rule.remove-piece']))
    expect(calls(graphs[3])).toEqual(expect.arrayContaining(['event.damage', 'lifecycle.zero-health', 'result.message']))

    const pendingOneHit = { ...graphs[3], surface: 'pending' as const }
    expect(() => compileGameplayModuleGraph(pendingOneHit, SHADOW_CLONE_GAMEPLAY_REGISTRY)).toThrow(/not allowed on pending/)
  })

  it('keeps frozen targeting, capability, and private status metadata unchanged', () => {
    const legacy = fixtureEntry('skills/naruto-shadow-clone')
    const next = migratedEntry('skills/naruto-shadow-clone')
    expect(next.targeting).toEqual(legacy.targeting)
    expect(next.summonCapability).toEqual(legacy.summonCapability)
    expect(next.description).toBe(legacy.description)
    expect(next.cluster).toEqual(legacy.cluster)
    expect(next.gameplayModules.entries.code.compilerVersion).toBe('rvb-gameplay-module-compiler/v1')
  })

  it('dry-runs all four migrations against production-shaped files without writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-shadow-migration-'))
    try {
      writeCloneEntries(root, false)
      const results = runSemanticShadowCloneMigrations(root, fixture)
      expect(results).toHaveLength(4)
      expect(results.every(result => result.status === 'ready')).toBe(true)
      expect(readFileSync(join(root, 'data', 'skills', 'naruto-shadow-clone.json'), 'utf8')).toBe(JSON.stringify(fixtureEntry('skills/naruto-shadow-clone')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves a valid module-owned edit on rerun and blocks stale generated source', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-shadow-idempotence-'))
    try {
      writeCloneEntries(root, false)
      const first = runSemanticShadowCloneMigrations(root, fixture)
      expect(first.every(result => result.status === 'ready')).toBe(true)
      const current = clone(first.find(result => result.id === 'skills/naruto-shadow-clone')!.document!)
      const modules = current.gameplayModules as JsonRecord
      const entries = modules.entries as JsonRecord
      const codeEntry = entries.code as JsonRecord
      const graph = codeEntry.graph as JsonRecord
      const findOption = (body: any[]): any => {
        for (const node of body) {
          if (node?.kind === 'call' && node.module === 'choice.option-pair') return node
          if (node?.kind === 'if') {
            const found = findOption([...(node.then ?? []), ...(node.else ?? [])])
            if (found) return found
          }
        }
        return undefined
      }
      const option = findOption(graph.body as any[])
      expect(option).toBeDefined()
      option.parameters.title = '影分身方式（作者调整）'
      current.code = compileGameplayModuleGraph(graph as any, SHADOW_CLONE_GAMEPLAY_REGISTRY).code
      writeJson(root, 'skills/naruto-shadow-clone.json', current)

      const rerun = runSemanticShadowCloneMigrations(root, fixture)
      const rerunSkill = rerun.find(result => result.id === 'skills/naruto-shadow-clone')!
      expect(rerunSkill.status).toBe('ready')
      expect(rerunSkill.document).toEqual(current)

      const stale = clone(current)
      const staleGraph = (stale.gameplayModules as JsonRecord).entries as JsonRecord
      const staleCodeEntry = staleGraph.code as JsonRecord
      const staleOption = findOption((staleCodeEntry.graph as JsonRecord).body as any[])
      staleOption.parameters.title = '未重新生成的作者调整'
      writeJson(root, 'skills/naruto-shadow-clone.json', stale)
      const blocked = runSemanticShadowCloneMigrations(root, fixture).find(result => result.id === 'skills/naruto-shadow-clone')!
      expect(blocked.status).toBe('blocked')
      expect(blocked.error).toMatch(/generated code does not match/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs summon and teleport through applyBattleAction with no false pending pass', () => {
    // This assertion intentionally uses the central registry. It becomes
    // active once the parent registers SUMMON_GAMEPLAY_MODULES.
    withProfile(true, () => {
      const summon = completeCloneAction(cloneState(migratedEntry('skills/naruto-shadow-clone')), 'summon', { x: 3, y: 1 })
      expect(summon.pendingOptionSelection).toBeUndefined()
      expect(summon.pendingTargetSelection).toBeUndefined()
      expect(summon.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-'))).toMatchObject({ x: 3, y: 1 })

      const teleported = completeCloneAction(cloneState(migratedEntry('skills/naruto-shadow-clone')), 'teleport', { x: 3, y: 1 })
      expect(teleported.pendingOptionSelection).toBeUndefined()
      expect(teleported.pendingTargetSelection).toBeUndefined()
      expect(teleported.pieces.find(piece => piece.instanceId === 'naruto')).toMatchObject({ x: 3, y: 1 })
      expect(teleported.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-'))).toMatchObject({ x: 1, y: 1 })
    })
  })

  it('matches the frozen legacy execution for summon and teleport state transitions', () => {
    const legacySummon = withProfile(false, () => completeCloneAction(cloneState(clone(fixtureEntry('skills/naruto-shadow-clone'))), 'summon', { x: 3, y: 1 }))
    const semanticSummon = withProfile(true, () => completeCloneAction(cloneState(migratedEntry('skills/naruto-shadow-clone')), 'summon', { x: 3, y: 1 }))
    expect(stateSnapshot(semanticSummon)).toEqual(stateSnapshot(legacySummon))

    const legacyTeleport = withProfile(false, () => completeCloneAction(cloneState(clone(fixtureEntry('skills/naruto-shadow-clone'))), 'teleport', { x: 3, y: 1 }))
    const semanticTeleport = withProfile(true, () => completeCloneAction(cloneState(migratedEntry('skills/naruto-shadow-clone')), 'teleport', { x: 3, y: 1 }))
    expect(stateSnapshot(semanticTeleport)).toEqual(stateSnapshot(legacyTeleport))
  })

  it('preserves blocked teleport success, payment, cooldown, and rollback parity', () => {
    const runBlocked = (semantic: boolean): BattleState => withProfile(semantic, () => {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRule({
        id: 'red252-shadow-clone-teleport-block', name: 'red252-shadow-clone-teleport-block', description: '',
        trigger: { type: 'beforePiecePositionChange' },
        effect: (_battle, context) => context.sourcePiece?.instanceId === 'naruto'
          ? { success: true, blocked: true, message: '测试：传送被阻挡' }
          : { success: true },
      })
      try {
        return completeCloneAction(cloneState(semantic
          ? migratedEntry('skills/naruto-shadow-clone')
          : clone(fixtureEntry('skills/naruto-shadow-clone'))), 'teleport', { x: 3, y: 1 })
      } finally {
        globalTriggerSystem.clearRules()
      }
    })
    const legacy = runBlocked(false)
    const semantic = runBlocked(true)
    expect(stateSnapshot(semantic)).toEqual(stateSnapshot(legacy))
    expect(semantic.players[0].actionPoints).toBe(4)
    expect(semantic.pieces.find(piece => piece.instanceId === 'naruto')).toMatchObject({ x: 1, y: 1 })
    expect(semantic.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-'))).toBeUndefined()
    expect(semantic.pieces.find(piece => piece.instanceId === 'naruto')?.skills?.find(skill => skill.skillId === 'naruto-shadow-clone')).toMatchObject({ currentCooldown: 3, usesRemaining: -1 })
    expect(semantic.actions?.some(action => String(action?.payload?.message ?? '').includes('传送被阻挡，影分身之术取消'))).toBe(true)
  })

  it('keeps zero-health scoped to the damage victim and afterDamageTaken phase', () => {
    const unrelated = executeZeroHealthProbe('afterDamageTaken', 'unrelated', 'victim')
    expect(unrelated.result).toBe(false)
    expect(unrelated.pieces.unrelated.currentHp).toBe(7)
    expect(unrelated.pieces.victim.currentHp).toBe(9)

    const wrongPhase = executeZeroHealthProbe('beforeDamageTaken', 'victim', 'victim')
    expect(wrongPhase.result).toBe(false)
    expect(wrongPhase.pieces.victim.currentHp).toBe(9)

    const valid = executeZeroHealthProbe('afterDamageTaken', 'victim', 'victim')
    expect(valid.result).toBe(true)
    expect(valid.pieces.victim.currentHp).toBe(0)
  })

  it('executes immobile, one-hit, and died rules through the real host lifecycle', () => {
    withProfile(true, () => {
      const state = completeCloneAction(cloneState(migratedEntry('skills/naruto-shadow-clone')), 'summon', { x: 3, y: 1 })
      const clonePiece = state.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-'))!
      clonePiece.moveRange = 3
      const beforeMove = clone(clonePiece)
      const moved = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: clonePiece.instanceId, toX: 4, toY: 1 })
      expect(moved.pieces.find(piece => piece.instanceId === clonePiece.instanceId)).toMatchObject({ x: beforeMove.x, y: beforeMove.y })

      const attacker = makePiece({ instanceId: 'attacker', templateId: 'blue-attacker', ownerPlayerId: 'player-blue', x: 0, y: 1, currentHp: 20, maxHp: 20 })
      ;(attacker as any).name = '敌军'
      state.pieces.push(attacker as any)
      const cloneAttack = dealDamage(clonePiece as any, attacker as any, 1, 'physical', state, 'red252-test')
      expect(cloneAttack).toMatchObject({ success: true })
      expect(attacker.currentHp).toBe(19)
      expect(clonePiece.currentHp).toBe(beforeMove.currentHp)
      expect(state.pieces.some(piece => piece.instanceId === clonePiece.instanceId)).toBe(true)
      const damageResult = dealDamage(attacker as any, clonePiece as any, 1, 'physical', state, 'red252-test')
      expect(damageResult).toMatchObject({ success: true })
      expect(state.pieces.some(piece => piece.instanceId === clonePiece.instanceId)).toBe(false)
      expect(state.graveyard?.some(piece => piece.instanceId === clonePiece.instanceId)).toBe(true)
      expect(state.actions?.some(action => String(action?.payload?.message ?? '').includes('受到伤害，立即消散'))).toBe(true)
    })
  })
})

