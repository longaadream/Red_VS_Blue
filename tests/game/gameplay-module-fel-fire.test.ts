/* eslint-disable @typescript-eslint/no-explicit-any -- frozen full-state differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildFelFireGraph } from '@/scripts/migrate-semantic-fel-fire'
import { makePiece, makeState } from '../helpers/minimal-state'
const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/kiljaedan-fel-fire']
const migrated = applyGameplayModuleGraph(original, buildFelFireGraph())
function run(semantic: boolean, hp: number, shield: boolean, neighbor: boolean, selected = true) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 9 })
    caster.name = '基尔加丹'
    const target: any = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 2, currentHp: hp, maxHp: 50 })
    target.name = '目标'
    if (shield) {
      target.statusTags = [{ id: 'divine-shield', type: 'divine-shield', currentDuration: -1, currentUses: 1, stacks: 1, intensity: 1, relatedRules: ['rule-divine-shield'] }]
      target.rules = [loadRuleById('rule-divine-shield', true, true)!]
    }
    const diagonal = makePiece({ instanceId: 'diagonal', ownerPlayerId: 'player-blue', x: neighbor ? 3 : 7, y: neighbor ? 3 : 7, currentHp: 50 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 3, currentHp: 50 })
    const dead = makePiece({ instanceId: 'dead', ownerPlayerId: 'player-blue', x: 3, y: 2, currentHp: 0 })
    const battle: any = makeState({ pieces: [caster, target, diagonal, ally, dead] })
    const definition: any = semantic ? migrated : original
    battle.skillsById[definition.id] = definition
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: selected ? target : null, targets: selected ? [{ info: target, pos: null }] : [] } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}
describe('semantic Fel Fire', () => {
  for (const hp of [1, 50]) for (const shield of [false, true]) for (const neighbor of [false, true]) {
    it(`preserves primary and diagonal splash: HP=${hp}, shield=${shield}, neighbor=${neighbor}`, () => {
      const actual = run(true, hp, shield, neighbor)
      expect(actual).toEqual(run(false, hp, shield, neighbor))
      expect(actual.result.message).toContain(`波及周围${neighbor ? 1 : 0}名敌人`)
      expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'ally').currentHp).toBe(50)
    })
  }
  it('preserves target selection without resolving effects', () => {
    expect(run(true, 50, false, true, false)).toEqual(run(false, 50, false, true, false))
  })
})
