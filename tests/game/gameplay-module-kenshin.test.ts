/* eslint-disable @typescript-eslint/no-explicit-any -- frozen skill differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_REGISTRY,
} from '@/lib/skill-graph/module-document'
import { executeSkillFunction, dealDamage, loadRuleById } from '@/lib/game/skills'
import { runBattleAction } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildKenshinSkillGraph, KENSHIN_SKILL_IDS, type KenshinSkillId } from '@/scripts/migrate-semantic-kenshin'
import { makePiece as makeRawPiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function makePiece(overrides: Record<string, any> = {}): any {
  // minimal-state deliberately defaults defense/name; spell them out here so
  // the differential cases cannot silently depend on fixture helper defaults.
  const piece = makeRawPiece(overrides) as any
  if (typeof overrides.name === 'string') piece.name = overrides.name
  if (overrides.defense !== undefined) piece.defense = overrides.defense
  return piece
}

function comparableState(battle: any): any {
  const state = clone(battle)
  delete state.skillsById
  return state
}

type Scenario = {
  targetHp?: number
  targetDefense?: number
  sourceAttack?: number
  sourceHp?: number
  sourceDeath?: boolean
  blocked?: boolean
  noLanding?: boolean
  shield?: boolean
  attackChanges?: boolean
}

function setupSkill(id: KenshinSkillId, semantic: boolean, scenario: Scenario = {}) {
  const source = makePiece({
    instanceId: 'source', templateId: 'kenshin', ownerPlayerId: 'player-red', faction: 'red',
    name: '剑心', x: 1, y: 2, attack: scenario.sourceAttack ?? 10,
    currentHp: scenario.sourceHp ?? 30, maxHp: scenario.sourceHp ?? 30, defense: 0,
    skills: [{ skillId: id, currentCooldown: 0, usesRemaining: -1 }],
  })
  const target = makePiece({
    instanceId: 'target', templateId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue',
    name: '敌军', x: id === 'kenshin-ryusosen' ? 2 : 4, y: 2,
    attack: 4, currentHp: scenario.targetHp ?? 100, maxHp: 100,
    defense: scenario.targetDefense ?? 0,
  })
  if (scenario.shield) {
    target.statusTags = [{
      id: 'divine-shield', type: 'divine-shield', name: '圣盾', currentDuration: -1,
      currentUses: 1, intensity: 1, stacks: 1, relatedRules: ['rule-divine-shield'],
    }]
    target.rules = [loadRuleById('rule-divine-shield', true, true)!]
  }
  const battle: any = makeState({ pieces: [source, target], width: 9, height: 9, currentPlayerId: 'player-red' })
  battle.players[0].actionPoints = 5
  battle.players[0].chargePoints = 2
  const definition = semantic ? applyGameplayModuleGraph(fixture['skills/' + id], buildKenshinSkillGraph(id)) : clone(fixture['skills/' + id])
  battle.skillsById[id] = definition
  if (scenario.noLanding) {
    for (const [x, y] of [[target.x, target.y - 1], [target.x + 1, target.y], [target.x, target.y + 1], [target.x - 1, target.y]]) {
      const tile = battle.map.tiles.find((entry: any) => entry.x === x && entry.y === y)
      if (tile) tile.props.walkable = false
    }
  }
  const context: any = {
    piece: source,
    battle,
    skill: definition,
    target,
    targetPosition: null,
    targets: [{ info: target, pos: null }],
    playerId: 'player-red',
  }
  return { battle, source, target, definition, context }
}

function installScenarioTriggers(id: KenshinSkillId, scenario: Scenario): void {
  if (scenario.blocked) {
    globalTriggerSystem.addRule({
      id: `kenshin-test-block-${id}`, name: '测试阻挡', description: '',
      trigger: { type: 'beforePiecePositionChange' },
      effect: (_battle: any, context: any) => context.sourcePiece?.instanceId === 'source'
        ? { success: true, blocked: true, message: '测试阻挡' }
        : { success: true },
    } as any)
  }
  if (scenario.sourceDeath) {
    globalTriggerSystem.addRule({
      id: `kenshin-test-source-death-${id}`, name: '测试施法者死亡', description: '',
      trigger: { type: 'beforePiecePositionChange' },
      effect: (battle: any, context: any) => {
        if (context.sourcePiece?.instanceId !== 'source') return { success: true }
        const source = context.sourcePiece
        const killer = battle.pieces.find((piece: any) => piece.instanceId === 'target')
        if (killer && source.currentHp > 0) dealDamage(killer, source, source.currentHp + 99, 'true', battle, `kenshin-test-source-death-${id}`)
        return { success: true, message: '位移前置反应使施法者死亡' }
      },
    } as any)
  }
  if (scenario.attackChanges) {
    globalTriggerSystem.addRule({
      id: `kenshin-test-attack-refresh-${id}`, name: '测试逐击读取攻击力', description: '',
      trigger: { type: 'beforeDamageDealt' },
      effect: (_battle: any, context: any) => {
        if (context.skillId !== id || context.sourcePiece?.instanceId !== 'source') return { success: true }
        context.sourcePiece.attack += 1
        return { success: true }
      },
    } as any)
  }
}

function runDirect(id: KenshinSkillId, semantic: boolean, scenario: Scenario = {}) {
  const { battle, context } = setupSkill(id, semantic, scenario)
  installScenarioTriggers(id, scenario)
  const runtime = new RuleRuntime({ rootSeed: 594 })
  try {
    return withRuleRuntime(runtime, () => {
      const result = recordBattlePresentation(
        battle,
        () => executeSkillFunction(battle.skillsById[id], context, battle),
        () => battle,
      )
      return {
        result: clone(result),
        state: comparableState(battle),
        presentation: clone(recordedBattlePresentation(battle) ?? []),
        runtime: runtime.snapshot(),
      }
    })
  } finally {
    globalTriggerSystem.clearRules()
  }
}

function runHost(id: KenshinSkillId, semantic: boolean, scenario: Scenario = {}) {
  const { battle } = setupSkill(id, semantic, scenario)
  installScenarioTriggers(id, scenario)
  const type = id === 'kenshin-amakakeru' ? 'useChargeSkill' : 'useBasicSkill'
  const draft: any = { type, playerId: 'player-red', pieceId: 'source', skillId: id }
  const prepared = prepareAction(battle, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`${id}: expected target selection, got ${prepared.kind}`)
  const action: any = { ...draft, targetPieceId: 'target', selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
  try {
    const result = recordBattlePresentation(
      battle,
      () => runBattleAction(battle, action, { rootSeed: 594 }),
      value => value.state,
    )
    return {
      result: { stateHash: result.stateHash, actionHash: result.actionHash, randomStreams: result.trace?.randomStreams ?? [] },
      state: comparableState(result.state),
      presentation: clone(recordedBattlePresentation(battle) ?? []),
    }
  } finally {
    globalTriggerSystem.clearRules()
  }
}

describe('semantic Kenshin skill migrations', () => {
  it('registers all three skills as typed gameplay documents', () => {
    for (const id of KENSHIN_SKILL_IDS) {
      const graph = buildKenshinSkillGraph(id)
      const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
      expect(compiled.code).toContain('function executeSkill')
      const document = applyGameplayModuleGraph(fixture['skills/' + id], graph)
      assertGameplayModuleDocument(document)
      expect((document.gameplayModules as any).entries.code.graph).toEqual(graph)
    }
  })

  it.each(KENSHIN_SKILL_IDS)('preserves ordinary success, result, full state, presentation and RNG: %s', id => {
    const legacy = runDirect(id, false)
    const semantic = runDirect(id, true)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toMatchObject({ success: true })
    if (id === 'kenshin-amakakeru') expect(semantic.result.message).toContain('天翔龙闪')
    if (id === 'kenshin-ryusosen') expect(semantic.result.message).toContain('连击3次')
    if (id === 'kenshin-ryutsuisen') expect(semantic.result.message).toContain('龙槌闪')
  })

  it('preserves Amakakeru kill reward and no-landing failure', () => {
    const legacy = runDirect('kenshin-amakakeru', false, { targetHp: 1 })
    const semantic = runDirect('kenshin-amakakeru', true, { targetHp: 1 })
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '剑心以天翔龙闪斩向敌军，造成1点真实伤害，击杀目标并恢复1点行动点' })
    expect(semantic.state.players[0].actionPoints).toBe(6)

    const blocked = runDirect('kenshin-amakakeru', true, { noLanding: true })
    expect(blocked).toEqual(runDirect('kenshin-amakakeru', false, { noLanding: true }))
    expect(blocked.result).toEqual({ success: false, message: '目标相邻地格没有合法落点' })
    expect(blocked.runtime).toEqual(new RuleRuntime({ rootSeed: 594 }).snapshot())
  })

  it('preserves Amakakeru blocked displacement and source-owner lookup after source death', () => {
    expect(runDirect('kenshin-amakakeru', true, { blocked: true })).toEqual(runDirect('kenshin-amakakeru', false, { blocked: true }))
    expect(runDirect('kenshin-amakakeru', true, { sourceDeath: true })).toEqual(runDirect('kenshin-amakakeru', false, { sourceDeath: true }))
  })

  it('preserves Ryusosen fixed three-hit stop-on-death and re-read attack semantics', () => {
    const death = runDirect('kenshin-ryusosen', true, { targetHp: 8 })
    expect(death).toEqual(runDirect('kenshin-ryusosen', false, { targetHp: 8 }))
    expect(death.result.message).toContain('连击2次')

    const changing = runDirect('kenshin-ryusosen', true, { attackChanges: true })
    expect(changing).toEqual(runDirect('kenshin-ryusosen', false, { attackChanges: true }))
    expect(changing.state.pieces.find((piece: any) => piece.instanceId === 'source').attack).toBe(13)

    const shield = runDirect('kenshin-ryusosen', true, { shield: true })
    expect(shield).toEqual(runDirect('kenshin-ryusosen', false, { shield: true }))
    expect(shield.state.pieces.find((piece: any) => piece.instanceId === 'target').currentHp).toBe(86)
  })

  it('preserves Ryutsuisen full shuffle random draws, blocked displacement and source death', () => {
    const noLanding = runDirect('kenshin-ryutsuisen', true, { noLanding: true })
    expect(noLanding).toEqual(runDirect('kenshin-ryutsuisen', false, { noLanding: true }))
    expect(noLanding.result).toEqual({ success: false, message: '目标周围没有可落脚的位置' })

    const blocked = runDirect('kenshin-ryutsuisen', true, { blocked: true })
    expect(blocked).toEqual(runDirect('kenshin-ryutsuisen', false, { blocked: true }))
    const sourceDeath = runDirect('kenshin-ryutsuisen', true, { sourceDeath: true })
    expect(sourceDeath).toEqual(runDirect('kenshin-ryutsuisen', false, { sourceDeath: true }))
  })

  it.each(KENSHIN_SKILL_IDS)('matches the real action host with complete state and presentation: %s', id => {
    const legacy = runHost(id, false)
    const semantic = runHost(id, true)
    expect(semantic).toEqual(legacy)
    expect(semantic.result.randomStreams).toEqual(legacy.result.randomStreams)
  })
})
