/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures retain legacy JSON-shaped state. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuleRuntime, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '@/lib/game/rule-runtime'
import { clearRuleCache, executeSkillFunction, loadRuleById, type SkillDefinition } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, compileGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { migrateAtomicAuthorGraph } from '@/scripts/migrate-atomic-author-modules'
import { buildAmaterasuRuleGraph, buildAmaterasuSkillGraph, AMATERASU_RULE_IDS, AMATERASU_SKILL_IDS } from '@/scripts/migrate-semantic-amaterasu'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const productionSkills = Object.fromEntries(AMATERASU_SKILL_IDS.map(id => [id, JSON.parse(readFileSync(`data/skills/${id}.json`, 'utf8'))])) as Record<string, SkillDefinition & Record<string, any>>
const productionRules = Object.fromEntries(AMATERASU_RULE_IDS.map(id => [id, JSON.parse(readFileSync(`data/rules/${id}.json`, 'utf8'))])) as Record<string, Record<string, any>>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function namedPiece(overrides: Record<string, any>): any {
  const piece = makePiece(overrides) as any
  piece.name = overrides.name ?? overrides.instanceId
  return piece
}

function comparableState(state: any): any {
  const snapshot = clone(state)
  delete snapshot.skillsById
  return snapshot
}

function comparableAmaterasuRuleRun(run: any): any {
  const snapshot = clone(run)
  // The current graph deliberately records the creating player on each burn
  // status and emits player-sourced damage.  Those fields are the behavior
  // under test below; keep the old-stage differential focused on rule outcome
  // and resulting game state.
  delete snapshot.presentation
  delete snapshot.state.actions
  const stripStatusOwners = (value: any): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(stripStatusOwners)
      return
    }
    if (value.type === 'amaterasu-burn') delete value.ownerPlayerId
    if (Array.isArray(value.statusTags)) value.statusTags.forEach((status: any) => { if (status && typeof status === 'object') delete status.ownerPlayerId })
    Object.values(value).forEach(stripStatusOwners)
  }
  stripStatusOwners(snapshot.state)
  return snapshot
}

type SkillScenario = { pieces: any[]; targetPosition: { x: number; y: number } | null; targetId?: string; extensions?: Record<string, any> }

function skillScenario(id: typeof AMATERASU_SKILL_IDS[number]): SkillScenario {
  const caster = namedPiece({ instanceId: id === 'itachi-amaterasu' ? 'itachi' : 'sasuke', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1, currentHp: 100, maxHp: 100, name: id === 'itachi-amaterasu' ? '鼬' : '佐助' })
  const target = namedPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1, currentHp: 30, maxHp: 30, name: '目标' })
  if (id === 'sasuke-amaterasu') return { pieces: [caster, target], targetPosition: { x: 3, y: 1 } }
  if (id === 'itachi-amaterasu') {
    target.statusTags = [{ id: 'amaterasu-burn-target', type: 'amaterasu-burn', name: '天照灼烧', stacks: 1, intensity: 1, currentDuration: -1, currentUses: -1, sourcePieceId: 'old-source' }]
    return { pieces: [caster, target], targetPosition: { x: 3, y: 1 }, targetId: target.instanceId, extensions: {
      tileEffects: [{ x: 3, y: 1, sourceId: 'amaterasu', tileType: 'amaterasu', presentation: 'expand', presentationStep: 0, icon: '🌑', iconPosition: 'bottom-right' }],
      amaterasuCells: [{ x: 3, y: 1, sourcePieceId: 'old-source', ownerPlayerId: 'player-red' }],
      amaterasuOwnerPlayerId: 'player-blue',
    } }
  }
  target.statusTags = [{ id: 'amaterasu-burn-target', type: 'amaterasu-burn', name: '天照灼烧', stacks: 0, intensity: 2, currentDuration: -1, currentUses: -1 }]
  return { pieces: [caster, target], targetPosition: { x: 3, y: 1 }, targetId: target.instanceId, extensions: {
    tileEffects: [
      { x: 3, y: 1, sourceId: 'amaterasu', tileType: 'amaterasu', presentation: 'expand', presentationStep: 0, icon: '🌑', iconPosition: 'bottom-right' },
      { x: 0, y: 0, sourceId: 'other', tileType: 'other' },
    ],
    amaterasuCells: [
      { x: 3, y: 1, sourcePieceId: 'sasuke', ownerPlayerId: 'player-red' },
      { x: 5, y: 5, sourcePieceId: 'sasuke', ownerPlayerId: 'player-red' },
    ],
  } }
}

function runSkill(id: typeof AMATERASU_SKILL_IDS[number], definition: any, scenario: SkillScenario, pending = false): any {
  const state = makeState({ pieces: clone(scenario.pieces), width: 7, height: 7, currentPlayerId: 'player-red' }) as any
  state.skillsById[id] = definition
  state.extensions = clone(scenario.extensions ?? {})
  const caster = state.pieces.find((piece: any) => piece.instanceId === (id === 'itachi-amaterasu' ? 'itachi' : 'sasuke'))
  const target = scenario.targetId ? state.pieces.find((piece: any) => piece.instanceId === scenario.targetId) : null
  const context: any = {
    piece: caster,
    target: pending ? null : target,
    targetPosition: pending ? null : scenario.targetPosition,
    targets: pending || !target ? [] : [{ info: target, pos: { x: target.x, y: target.y } }],
    battle: state,
    skill: definition,
    playerId: caster.ownerPlayerId,
  }
  const runtime = new RuleRuntime({ rootSeed: 594, tick: 1 })
  const result = withRuleRuntime(runtime, () => recordBattlePresentation(
    state,
    () => executeSkillFunction(definition, context, state),
    () => state,
  ))
  return { result: clone(result), state: comparableState(state), presentation: clone(recordedBattlePresentation(state) ?? []), random: runtime.snapshot() }
}

function loadRuleFromTemporaryProfile(definition: Record<string, any>, id: string): any {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-amaterasu-rule-'))
  mkdirSync(join(root, 'data', 'rules'), { recursive: true })
  writeFileSync(join(root, 'data', 'rules', `${id}.json`), JSON.stringify({ ...clone(definition), id }), 'utf8')
  const previous = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  try {
    const rule = loadRuleById(id, true, true)
    if (!rule || typeof rule.effect !== 'function') throw new Error(`could not load Amaterasu rule ${id}`)
    return rule
  } finally {
    if (previous === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previous
    clearRuleCache()
    rmSync(root, { recursive: true, force: true })
  }
}

type RuleCase = { state: any; context: any }

function ruleCase(id: typeof AMATERASU_RULE_IDS[number]): RuleCase {
  const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1, currentHp: 100, maxHp: 100, name: '佐助' })
  const burned = namedPiece({ instanceId: 'burned', ownerPlayerId: 'player-red', faction: 'red', x: 3, y: 1, currentHp: 20, maxHp: 20, name: '灼烧目标' })
  const second = namedPiece({ instanceId: 'second', ownerPlayerId: 'player-red', faction: 'red', x: 4, y: 1, currentHp: 20, maxHp: 20, name: '第二目标' })
  const state = makeState({ pieces: [caster, burned, second], width: 7, height: 4, currentPlayerId: 'player-red' }) as any
  state.extensions = { amaterasuOwnerPlayerId: 'player-red', amaterasuCells: [
    { x: 3, y: 1, sourcePieceId: 'missing-source', ownerPlayerId: 'player-red' },
    { x: 4, y: 1, sourcePieceId: 'caster', ownerPlayerId: 'player-red' },
  ], tileEffects: [] }
  if (id === 'rule-sasuke-amaterasu-damage') {
    burned.statusTags = [{ id: 'burned-status', type: 'amaterasu-burn', name: '天照灼烧', stacks: 2, intensity: 2, currentDuration: -1, currentUses: -1, sourcePieceId: 'missing-source', ownerPlayerId: 'player-red' }]
  } else if (id === 'rule-sasuke-amaterasu-endturn') {
    burned.statusTags = []
    second.statusTags = [{ id: 'second-status', type: 'amaterasu-burn', name: '天照灼烧', stacks: 1, intensity: 2, currentDuration: -1, currentUses: -1, sourcePieceId: 'caster', ownerPlayerId: 'player-red' }]
  } else if (id === 'rule-sasuke-amaterasu-move') {
    burned.ownerPlayerId = 'player-blue'
    burned.statusTags = []
  } else {
    burned.statusTags = [{ id: 'burned-status', type: 'amaterasu-burn', name: '天照灼烧', stacks: 1, intensity: 2, currentDuration: -1, currentUses: -1, ownerPlayerId: 'player-red' }]
    second.statusTags = []
  }
  const context: any = {
    type: id === 'rule-sasuke-amaterasu-move' ? 'afterPiecePathContact' : 'endTurn',
    playerId: 'player-red',
    ruleOwnerPlayerId: 'player-red',
    sourcePiece: id === 'rule-sasuke-amaterasu-move' ? burned : undefined,
    contactCells: id === 'rule-sasuke-amaterasu-move' ? [{ x: 3, y: 1 }, { x: 3, y: 1 }, { x: 2, y: 1 }] : undefined,
    battle: state,
  }
  return { state, context }
}

function lethalDamageCase(): RuleCase {
  const scenario = ruleCase('rule-sasuke-amaterasu-damage')
  const burned = scenario.state.pieces.find((piece: any) => piece.instanceId === 'burned')
  burned.currentHp = 1
  return scenario
}

function skippedAfterLethalDamageCase(): RuleCase {
  const scenario = ruleCase('rule-sasuke-amaterasu-damage')
  const burned = scenario.state.pieces.find((piece: any) => piece.instanceId === 'burned')
  const second = scenario.state.pieces.find((piece: any) => piece.instanceId === 'second')
  burned.currentHp = 1
  second.statusTags = [{ id: 'second-status', type: 'amaterasu-burn', name: '天照灼烧', stacks: 2, intensity: 2, currentDuration: -1, currentUses: -1, sourcePieceId: 'missing-source', ownerPlayerId: 'player-red' }]
  return scenario
}

function endturnLethalCase(): RuleCase {
  const scenario = ruleCase('rule-sasuke-amaterasu-endturn')
  const burned = scenario.state.pieces.find((piece: any) => piece.instanceId === 'burned')
  burned.currentHp = 1
  burned.statusTags = [{ id: 'burned-status', type: 'amaterasu-burn', name: '天照灼烧', stacks: 2, intensity: 2, currentDuration: -1, currentUses: -1, sourcePieceId: 'missing-source', ownerPlayerId: 'player-red' }]
  return scenario
}

function runRule(definition: Record<string, any>, id: typeof AMATERASU_RULE_IDS[number], scenario: RuleCase = ruleCase(id)): any {
  const rule = loadRuleFromTemporaryProfile(definition, id)
  const { state, context } = scenario
  const triggerSystem = new TriggerSystem()
  const dispatchRule = { ...rule, effect: (battle: any, event: any) => rule.effect(battle, event) }
  triggerSystem.addRule(dispatchRule as any)
  const runtime = new RuleRuntime({ rootSeed: 594, tick: 1 })
  const result = withRuleExecutionContext(createRuleExecutionContext(triggerSystem, { ruleResolver: (_battle, requestedId) => requestedId === id ? dispatchRule as any : null }), () => withRuleRuntime(runtime, () => recordBattlePresentation(
    state,
    () => triggerSystem.checkTriggers(state, context),
    () => state,
  )))
  return { result: clone(result), state: comparableState(state), presentation: clone(recordedBattlePresentation(state) ?? []), random: runtime.snapshot() }
}

afterEach(() => {
  clearRuleCache()
  vi.restoreAllMocks()
})

describe('Amaterasu semantic gameplay modules', () => {
  it('registers typed skill/rule graphs and matches generated production code', () => {
    for (const id of AMATERASU_SKILL_IDS) {
      const graph = migrateAtomicAuthorGraph(buildAmaterasuSkillGraph(id))
      expect(compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code.length).toBeGreaterThan(0)
      const document = applyGameplayModuleGraph(frozen[`skills/${id}`], graph)
      assertGameplayModuleDocument(document)
      expect((document as any).gameplayModules.entries.code.graph).toEqual(graph)
      expect((document as any).code).toBe(productionSkills[id].code)
      expect(JSON.stringify(graph)).not.toContain('executeSkill')
    }
    for (const id of AMATERASU_RULE_IDS) {
      const graph = migrateAtomicAuthorGraph(buildAmaterasuRuleGraph(id))
      expect(compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code.length).toBeGreaterThan(0)
      const document = applyGameplayModuleGraph(frozen[`rules/${id}`], graph, 'skillCode')
      assertGameplayModuleDocument(document)
      expect((document as any).gameplayModules.entries.skillCode.graph).toEqual(graph)
      expect((document as any).skillCode).toBe(productionRules[id].skillCode)
      expect(JSON.stringify(graph)).not.toContain('executeSkill')
    }
  })

  it.each(AMATERASU_SKILL_IDS)('preserves success state, presentation and fixed-seed channels for %s', id => {
    const scenario = skillScenario(id)
    const legacy = runSkill(id, clone(frozen[`skills/${id}`]), scenario)
    const semantic = runSkill(id, productionSkills[id], scenario)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toMatchObject({ success: true })
  })

  it('preserves pending target selection without side effects for all skills', () => {
    for (const id of AMATERASU_SKILL_IDS) {
      const scenario = skillScenario(id)
      const legacy = runSkill(id, clone(frozen[`skills/${id}`]), scenario, true)
      const semantic = runSkill(id, productionSkills[id], scenario, true)
      expect(semantic).toEqual(legacy)
      expect(semantic.state.extensions).toEqual(scenario.extensions ?? {})
    }
  })

  it('stores the creating player on newly created Amaterasu statuses and cell records', () => {
    const sasuke = runSkill('sasuke-amaterasu', productionSkills['sasuke-amaterasu'], skillScenario('sasuke-amaterasu'))
    expect(sasuke.state.extensions.amaterasuCells.length).toBeGreaterThan(0)
    expect(sasuke.state.extensions.amaterasuCells).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerPlayerId: 'player-red' }),
    ]))

    const itachiScenario = skillScenario('itachi-amaterasu')
    const itachiTarget = itachiScenario.pieces.find(piece => piece.instanceId === 'target')
    itachiTarget.statusTags = []
    const itachi = runSkill('itachi-amaterasu', productionSkills['itachi-amaterasu'], itachiScenario)
    const itachiStateTarget = itachi.state.pieces.find((piece: any) => piece.instanceId === 'target')
    expect(itachiStateTarget.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'amaterasu-burn', ownerPlayerId: 'player-red' }),
    ]))
    expect(itachi.state.extensions.amaterasuCells).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerPlayerId: 'player-red' }),
    ]))

    const kagutsuchiScenario = skillScenario('sasuke-kagutsuchi')
    const kagutsuchiTarget = kagutsuchiScenario.pieces.find(piece => piece.instanceId === 'target')
    kagutsuchiTarget.statusTags = []
    const kagutsuchi = runSkill('sasuke-kagutsuchi', productionSkills['sasuke-kagutsuchi'], kagutsuchiScenario)
    const kagutsuchiStateTarget = kagutsuchi.state.pieces.find((piece: any) => piece.instanceId === 'target')
    expect(kagutsuchiStateTarget.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'amaterasu-burn', ownerPlayerId: 'player-red' }),
    ]))
  })

  it.each(AMATERASU_RULE_IDS)('preserves real host rule result, state, presentation and seed for %s', id => {
    const legacy = runRule(frozen[`rules/${id}`], id)
    const semantic = runRule(productionRules[id], id)
    expect(comparableAmaterasuRuleRun(semantic)).toEqual(comparableAmaterasuRuleRun(legacy))
  })

  it('settles damage from the stored player after the caster dies or changes owner', () => {
    const scenario = ruleCase('rule-sasuke-amaterasu-damage')
    const caster = scenario.state.pieces.find((piece: any) => piece.instanceId === 'caster')
    caster.currentHp = 0
    caster.ownerPlayerId = 'player-blue'

    const semantic = runRule(productionRules['rule-sasuke-amaterasu-damage'], 'rule-sasuke-amaterasu-damage', scenario)
    const burned = semantic.state.pieces.find((piece: any) => piece.instanceId === 'burned')
    expect(semantic.result.success).toBe(true)
    expect(burned.currentHp).toBe(16)
    const damageAction = semantic.state.actions.find((action: any) => action.type === 'damage')
    expect(damageAction?.payload.damageSource).toEqual({ kind: 'player', playerId: 'player-red', sourceId: 'player-red' })
    expect(damageAction?.payload.sourceId).toBe('player-red')
  })

  it('invalidates a burn with no captured player instead of falling back to the caster', () => {
    const scenario = ruleCase('rule-sasuke-amaterasu-damage')
    const burned = scenario.state.pieces.find((piece: any) => piece.instanceId === 'burned')
    delete burned.statusTags[0].ownerPlayerId

    const semantic = runRule(productionRules['rule-sasuke-amaterasu-damage'], 'rule-sasuke-amaterasu-damage', scenario)
    expect(semantic.result.success).toBe(false)
    expect(burned.currentHp).toBe(20)
    expect(semantic.state.actions).toEqual([])
  })

  it('propagates the cell owner into statuses created by move, stack and end-turn rules', () => {
    const move = runRule(productionRules['rule-sasuke-amaterasu-move'], 'rule-sasuke-amaterasu-move')
    const moved = move.state.pieces.find((piece: any) => piece.instanceId === 'burned')
    expect(moved.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'amaterasu-burn', ownerPlayerId: 'player-red' }),
    ]))

    const stack = runRule(productionRules['rule-sasuke-amaterasu-stack'], 'rule-sasuke-amaterasu-stack')
    const stacked = stack.state.pieces.find((piece: any) => piece.instanceId === 'second')
    expect(stacked.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'amaterasu-burn', ownerPlayerId: 'player-red' }),
    ]))

    const endTurn = runRule(productionRules['rule-sasuke-amaterasu-endturn'], 'rule-sasuke-amaterasu-endturn')
    const ended = endTurn.state.pieces.find((piece: any) => piece.instanceId === 'burned')
    expect(ended.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'amaterasu-burn', ownerPlayerId: 'player-red' }),
    ]))
  })

  it('preserves a lethal damage result after the target leaves the live piece array', () => {
    const legacy = runRule(frozen['rules/rule-sasuke-amaterasu-damage'], 'rule-sasuke-amaterasu-damage', lethalDamageCase())
    const semantic = runRule(productionRules['rule-sasuke-amaterasu-damage'], 'rule-sasuke-amaterasu-damage', lethalDamageCase())
    expect(comparableAmaterasuRuleRun(semantic)).toEqual(comparableAmaterasuRuleRun(legacy))
    expect(semantic.result.success).toBe(true)
    expect(JSON.stringify(semantic.result)).toContain('灼烧目标受天照灼烧(2层)，失去1点生命值')
  })

  it('preserves live-array skip semantics when the first burn is lethal', () => {
    const legacy = runRule(frozen['rules/rule-sasuke-amaterasu-damage'], 'rule-sasuke-amaterasu-damage', skippedAfterLethalDamageCase())
    const semantic = runRule(productionRules['rule-sasuke-amaterasu-damage'], 'rule-sasuke-amaterasu-damage', skippedAfterLethalDamageCase())
    expect(comparableAmaterasuRuleRun(semantic)).toEqual(comparableAmaterasuRuleRun(legacy))
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'second')?.currentHp).toBe(20)
  })

  it('preserves the end-turn standing and lethal burn messages', () => {
    const legacy = runRule(frozen['rules/rule-sasuke-amaterasu-endturn'], 'rule-sasuke-amaterasu-endturn', endturnLethalCase())
    const semantic = runRule(productionRules['rule-sasuke-amaterasu-endturn'], 'rule-sasuke-amaterasu-endturn', endturnLethalCase())
    expect(comparableAmaterasuRuleRun(semantic)).toEqual(comparableAmaterasuRuleRun(legacy))
    expect(semantic.result.success).toBe(true)
    expect(JSON.stringify(semantic.result)).toContain('灼烧目标站在天照上，层数加深至3层')
    expect(JSON.stringify(semantic.result)).toContain('灼烧目标受天照灼烧(3层)，失去6点生命值')
  })
})
