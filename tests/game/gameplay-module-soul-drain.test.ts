/* eslint-disable @typescript-eslint/no-explicit-any -- frozen state differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildSoulDrainGraph } from '@/scripts/migrate-semantic-soul-drain'
import { makePiece, makeState } from '../helpers/minimal-state'
const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/kiljaedan-soul-drain']
const migrated = applyGameplayModuleGraph(frozen, buildSoulDrainGraph())
function run(semantic: boolean, enemies: number, shield: boolean, maxHp: number) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, currentHp: 30 })
    caster.name = '基尔加丹'
    const targets: any[] = Array.from({ length: enemies }, (_, index) => {
      const piece: any = makePiece({ instanceId: 'enemy-' + index, ownerPlayerId: 'player-blue', x: index + 2, y: 1, currentHp: index < 2 ? 2 : 30, maxHp })
      piece.name = '敌人' + index
      if (shield && index === 0) {
        piece.statusTags = [{ id: 'divine-shield', type: 'divine-shield', currentDuration: -1, currentUses: 1, stacks: 1, intensity: 1, relatedRules: ['rule-divine-shield'] }]
        piece.rules = [loadRuleById('rule-divine-shield', true, true)!]
      }
      return piece
    })
    const battle: any = makeState({ pieces: [caster, ...targets] })
    const definition: any = semantic ? migrated : frozen
    battle.skillsById[definition.id] = definition
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: null, targets: [] } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}
describe('semantic Soul Drain', () => {
  for (const enemies of [0, 1, 3]) for (const shield of [false, true]) for (const maxHp of [1, 37]) {
    it(`preserves weakest selection and survivor batch: enemies=${enemies}, shield=${shield}, maxHP=${maxHp}`, () => {
      const actual = run(true, enemies, shield, maxHp)
      expect(actual).toEqual(run(false, enemies, shield, maxHp))
      expect(actual.result.success).toBe(enemies > 0)
      if (enemies > 0) expect(actual.result.message).toContain('敌人0')
    })
  }
})
