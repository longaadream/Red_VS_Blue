/* eslint-disable @typescript-eslint/no-explicit-any -- frozen full-state differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildInfiniteBladeGraph } from '@/scripts/migrate-semantic-infinite-blade'
import { makePiece, makeState } from '../helpers/minimal-state'
const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/shishio-infinite-blade']
const migrated = applyGameplayModuleGraph(original, buildInfiniteBladeGraph())
function run(semantic: boolean, hp: number, shield: boolean, kills: number | null, selected = true) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 9 })
    caster.name = '志志雄'
    if (kills !== null) caster.statusTags = [{ id: 'kills', type: 'shishio-kills', intensity: kills }]
    const target: any = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 2, currentHp: hp, maxHp: 50 })
    target.name = '目标'
    if (shield) {
      target.statusTags = [{ id: 'divine-shield', type: 'divine-shield', currentDuration: -1, currentUses: 1, stacks: 1, intensity: 1, relatedRules: ['rule-divine-shield'] }]
      target.rules = [loadRuleById('rule-divine-shield', true, true)!]
    }
    target.defense = 30
    const battle: any = makeState({ pieces: [caster, target] })
    const definition: any = semantic ? migrated : original
    battle.skillsById[definition.id] = definition
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: selected ? target : null, targets: selected ? [{ info: target, pos: null }] : [] } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}
describe('semantic Infinite Blade', () => {
  for (const hp of [1, 50]) for (const shield of [false, true]) for (const kills of [null, 0, 1, 2, 5]) {
    it(`preserves kill multiplier, shields and lethal hits: HP=${hp}, shield=${shield}, kills=${kills}`, () => {
      const actual = run(true, hp, shield, kills)
      expect(actual).toEqual(run(false, hp, shield, kills))
      expect(actual.result.success).toBe(true)
      if (shield) expect(actual.result.message).toContain('造成0点真实伤害')
    })
  }
  it('preserves pending target selection', () => {
    expect(run(true, 50, false, 2, false)).toEqual(run(false, 50, false, 2, false))
  })
})
