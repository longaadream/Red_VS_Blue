/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures retain legacy JSON-shaped state. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeSkillFunction } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { assertGameplayModuleDocument, compileGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { migrateAtomicAuthorGraph } from '@/scripts/migrate-atomic-author-modules'
import {
  buildHashiramaEdoSageBuddhaGraph,
  buildItachiTotsukaBladeGraph,
  buildSageTotsukaGraph,
  SAGE_TOTSUKA_SKILL_IDS,
} from '@/scripts/migrate-semantic-sage-totsuka'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const production = Object.fromEntries(SAGE_TOTSUKA_SKILL_IDS.map(id => [id, JSON.parse(readFileSync(`data/skills/${id}.json`, 'utf8'))])) as Record<string, any>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function namedPiece(overrides: Record<string, any>): any {
  const piece = makePiece(overrides) as any
  piece.name = overrides.name ?? overrides.instanceId
  return piece
}

type Scenario = {
  pieces: any[]
  targetPosition: { x: number; y: number } | null
  targetId?: string
  hand?: any[]
  skillsById?: Record<string, any>
  blockedTarget?: { x: number; y: number }
}

function hashiramaScenario(kind: 'success' | 'pending' | 'occupied' | 'wall'): Scenario {
  const caster = namedPiece({
    instanceId: 'hashirama', ownerPlayerId: 'player-red', faction: 'red', x: 0, y: 0, name: '柱间',
    skills: [
      { skillId: 'hashirama-edo-sage-buddha', currentCooldown: 2 },
      { skillId: 'other-active', currentCooldown: 3 },
      { skillId: 'passive', currentCooldown: -1 },
      { skillId: 'already-ready', currentCooldown: 0 },
    ],
  })
  const targetPosition = { x: 2, y: 0 }
  if (kind === 'occupied') {
    return {
      pieces: [caster, namedPiece({ instanceId: 'occupant', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, name: '占位者' })],
      targetPosition,
      blockedTarget: targetPosition,
    }
  }
  return { pieces: [caster], targetPosition: kind === 'pending' ? null : targetPosition, blockedTarget: kind === 'wall' ? targetPosition : undefined }
}

function totsukaScenario(kind: 'success' | 'pending'): Scenario {
  const caster = namedPiece({ instanceId: 'itachi', ownerPlayerId: 'player-red', faction: 'red', x: 0, y: 0, attack: 10, name: '鼬' })
  const target = namedPiece({
    instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 100, maxHp: 100, name: '目标',
    skills: [
      { skillId: 'active-ready', currentCooldown: 0 },
      { skillId: 'active-cooling', currentCooldown: 2 },
      { skillId: 'passive', currentCooldown: 4 },
      { skillId: 'missing-definition', currentCooldown: 3 },
    ],
  })
  return {
    pieces: [caster, target],
    targetId: 'target',
    targetPosition: kind === 'pending' ? null : { x: 2, y: 0 },
    skillsById: {
      'active-ready': { id: 'active-ready', kind: 'active' },
      'active-cooling': { id: 'active-cooling', kind: 'active' },
      passive: { id: 'passive', kind: 'passive' },
    },
  }
}

function totsukaLethalScenario(): Scenario {
  const scenario = totsukaScenario('success')
  const caster = scenario.pieces.find((piece: any) => piece.instanceId === 'itachi')
  const target = scenario.pieces.find((piece: any) => piece.instanceId === 'target')
  caster.attack = 5
  target.currentHp = 9
  return scenario
}

function runSkill(id: typeof SAGE_TOTSUKA_SKILL_IDS[number], definition: any, scenario: Scenario): any {
  const state = makeState({ pieces: clone(scenario.pieces), width: 7, height: 5, currentPlayerId: 'player-red' }) as any
  state.skillsById = clone(scenario.skillsById ?? {})
  state.players[0].hand = clone(scenario.hand ?? [])
  if (scenario.blockedTarget) {
    const tile = state.map.tiles.find((candidate: any) => candidate.x === scenario.blockedTarget!.x && candidate.y === scenario.blockedTarget!.y)
    tile.props = { ...tile.props, type: 'wall', walkable: false }
  }
  const source = state.pieces[0]
  const target = scenario.targetId ? state.pieces.find((piece: any) => piece.instanceId === scenario.targetId) : null
  const pending = scenario.targetPosition === null
  const context: any = {
    piece: source,
    target: pending ? null : target,
    targetPosition: scenario.targetPosition,
    targets: pending || !target ? [] : [{ info: target, pos: { x: target.x, y: target.y } }],
    battle: state,
    skill: definition,
    playerId: source.ownerPlayerId,
  }
  const runtime = new RuleRuntime({ rootSeed: 594, tick: 1 })
  const result = withRuleRuntime(runtime, () => recordBattlePresentation(
    state,
    () => executeSkillFunction(definition, context, state),
    () => state,
  ))
  const snapshot = clone(state)
  delete snapshot.skillsById
  return {
    result: clone(result),
    state: snapshot,
    presentation: clone(recordedBattlePresentation(state) ?? []),
    random: runtime.snapshot(),
  }
}

describe('Sage Buddha and Totsuka semantic gameplay modules', () => {
  it('registers typed graphs and generated production code', () => {
    for (const id of SAGE_TOTSUKA_SKILL_IDS) {
      const graph = migrateAtomicAuthorGraph(buildSageTotsukaGraph(id))
      const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
      expect(compiled.code.length).toBeGreaterThan(0)
      expect(JSON.stringify(graph)).not.toContain('executeSkill')
      assertGameplayModuleDocument(production[id])
      expect(production[id].gameplayModules.entries.code.graph).toEqual(graph)
      expect(production[id].code).toBe(compiled.code)
    }
    expect(buildHashiramaEdoSageBuddhaGraph()).toEqual(buildSageTotsukaGraph('hashirama-edo-sage-buddha'))
    expect(buildItachiTotsukaBladeGraph()).toEqual(buildSageTotsukaGraph('itachi-totsuka-blade'))
  })

  it.each([
    ['hashirama-edo-sage-buddha', 'success'],
    ['hashirama-edo-sage-buddha', 'pending'],
    ['hashirama-edo-sage-buddha', 'occupied'],
    ['hashirama-edo-sage-buddha', 'wall'],
    ['itachi-totsuka-blade', 'success'],
    ['itachi-totsuka-blade', 'pending'],
  ] as const)('preserves frozen result, state, presentation and fixed seed for %s (%s)', (id, kind) => {
    const scenario = id === 'hashirama-edo-sage-buddha' ? hashiramaScenario(kind as 'success' | 'pending' | 'occupied' | 'wall') : totsukaScenario(kind as 'success' | 'pending')
    const legacy = runSkill(id, clone(frozen[`skills/${id}`]), scenario)
    const semantic = runSkill(id, production[id], scenario)
    expect(semantic).toEqual(legacy)
  })

  it('preserves the lethal Totsuka result and captured target name', () => {
    const scenario = totsukaLethalScenario()
    const legacy = runSkill('itachi-totsuka-blade', clone(frozen['skills/itachi-totsuka-blade']), scenario)
    const semantic = runSkill('itachi-totsuka-blade', production['itachi-totsuka-blade'], scenario)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toMatchObject({ success: true })
    expect(semantic.result.message).toContain('鼬以十拳剑对目标造成9点魔法伤害')
  })
})
