/* eslint-disable @typescript-eslint/no-explicit-any -- Frozen content host parity scenarios. */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildMeleeSequenceGraph, MELEE_SEQUENCE_SKILL_IDS } from '@/scripts/migrate-semantic-melee-sequences'
import { makePiece, makeState } from '../helpers/minimal-state'
const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
function run(id: string, semantic: boolean, scenario: string) {
  const definition = semantic ? applyGameplayModuleGraph(entries['skills/' + id], buildMeleeSequenceGraph(id)) : entries['skills/' + id]
  const source: any = makePiece({ instanceId: 'source', currentHp: scenario === 'full-hp' ? 20 : 9, maxHp: 20, attack: 7, x: 1, y: 1 }); source.name = '攻击者'
  const target: any = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', currentHp: scenario === 'target-dies' ? 1 : 99, maxHp: 99, x: 2, y: 1 }); target.name = '目标'
  if (scenario === 'blocked') target.rules = [{ id: 'block-test', name: 'block', enabled: true, priority: -100, trigger: { type: 'beforeDamageApplied' }, effect: () => ({ success: true, blocked: true }) }]
  if (scenario === 'source-dies') target.rules = [{ id: 'reflect-test', name: 'reflect', enabled: true, priority: -100, trigger: { type: 'beforeDamageApplied' }, effect: (_battle: any, context: any) => {
    if (context.piece?.instanceId !== target.instanceId) return { success: false }
    context.damageQueue.push({ attacker: target, target: source, damage: 99, damageType: 'true', skillId: 'reflect-test' })
    return { success: true }
  } }]
  const battle: any = makeState({ pieces: [source, target] }); battle.skillsById[id] = definition
  const runtime = new RuleRuntime({ rootSeed: 594 })
  const result = withRuleRuntime(runtime, () => executeSkillFunction(definition, { piece: source, skill: definition, battle, target: scenario === 'pending' ? null : target, targetPosition: null, targets: scenario === 'pending' ? [] : [{ info: target, pos: null }] } as any, battle))
  const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
  return { result, state, random: runtime.snapshot() }
}
describe('composable sequential melee effects', () => {
  for (const id of MELEE_SEQUENCE_SKILL_IDS) for (const scenario of ['normal', 'full-hp', 'target-dies', 'source-dies', 'blocked', 'pending']) it(`${id}:${scenario}`, () => {
    const legacy = run(id, false, scenario), semantic = run(id, true, scenario)
    expect(semantic).toEqual(legacy)
    if (scenario !== 'pending') expect(semantic.result.success, JSON.stringify(semantic.result)).toBe(true)
    if (scenario === 'source-dies') expect(semantic.state.graveyard.some((piece: any) => piece.instanceId === 'source')).toBe(true)
    if (scenario === 'target-dies') expect(semantic.state.graveyard.some((piece: any) => piece.instanceId === 'target')).toBe(true)
  })
})
