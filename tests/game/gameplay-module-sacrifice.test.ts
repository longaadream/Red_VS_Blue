/* eslint-disable @typescript-eslint/no-explicit-any -- full-state frozen behavior fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildSacrificeGraph } from '@/scripts/migrate-semantic-sacrifice'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/hidan-sacrifice']
const semantic = applyGameplayModuleGraph(frozen, buildSacrificeGraph())
function run(modular: boolean, hp: number, oath: 'none' | 'enemy' | 'ally', fallback = false) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, currentHp: hp, maxHp: 18 })
    caster.name = '飞段'
    if (fallback) { caster.maxHp = 0; caster.stats = { maxHp: 21 } }
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: 30 })
    const enemy: any = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 30 })
    enemy.name = '敌人'
    const other = makePiece({ instanceId: 'other', ownerPlayerId: 'player-blue', x: 4, y: 1, currentHp: 30 })
    if (oath !== 'none') (oath === 'enemy' ? enemy : ally).statusTags = [{ id: 'oath', type: 'blood-oath' }]
    const battle: any = makeState({ pieces: [caster, ally, enemy, other] })
    const skill: any = modular ? semantic : frozen
    battle.skillsById[skill.id] = skill
    const result = executeSkillFunction(skill, { piece: caster, skill, battle, target: null, targets: [] } as any, battle)
    const state = JSON.parse(JSON.stringify(battle))
    delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}
describe('semantic sacrifice', () => {
  for (const hp of [1, 4, 8, 18]) for (const oath of ['none', 'enemy', 'ally'] as const) {
    it(`matches baseline at ${hp} HP with ${oath} oath`, () => {
      const actual = run(true, hp, oath)
      expect(actual).toEqual(run(false, hp, oath))
      expect(actual.result.success).toBe(true)
      if (oath === 'enemy' && hp < 18) expect(actual.result.message).toContain('苦难加深')
    })
  }
  it('uses the baseline base-stat max HP fallback', () => {
    expect(run(true, 8, 'enemy', true)).toEqual(run(false, 8, 'enemy', true))
  })
})
