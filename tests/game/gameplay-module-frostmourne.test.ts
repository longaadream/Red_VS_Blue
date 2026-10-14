/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildFrostmourneGraph } from '@/scripts/migrate-semantic-frostmourne'
import { makePiece, makeState } from '../helpers/minimal-state'

const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/arthas-frostmourne']
const migrated = applyGameplayModuleGraph(original, buildFrostmourneGraph())
function run(semantic: boolean, hp: number, noKillCharge: boolean, charge: number, select = true) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 12 })
    caster.name = '阿尔萨斯'
    const target: any = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: hp, maxHp: 50 })
    target.name = '目标'; target.noKillCharge = noKillCharge
    const other = makePiece({ instanceId: 'other', ownerPlayerId: 'player-blue', x: 4, y: 1, currentHp: 50 })
    const battle: any = makeState({ pieces: [caster, target, other] })
    battle.players[0].chargePoints = charge
    const skill: any = semantic ? migrated : original
    battle.skillsById[skill.id] = skill
    const result = executeSkillFunction(skill, { piece: caster, skill, battle, target: select ? target : null, targets: select ? [{ info: target, pos: null }] : [] } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}
describe('semantic Frostmourne', () => {
  for (const hp of [1, 50]) for (const noKillCharge of [false, true]) for (const charge of [0, 3]) {
    it(`preserves hit and charge at HP=${hp}, exempt=${noKillCharge}, charge=${charge}`, () => {
      const actual = run(true, hp, noKillCharge, charge)
      expect(actual).toEqual(run(false, hp, noKillCharge, charge))
      if (hp === 1 && !noKillCharge) expect(actual.state.players[0].chargePoints).toBe(charge + 1)
      if (hp === 50 || noKillCharge) expect(actual.result.message).not.toContain('额外获得')
    })
  }
  it('preserves the unresolved target protocol', () => {
    expect(run(true, 50, false, 0, false)).toEqual(run(false, 50, false, 0, false))
  })
})
