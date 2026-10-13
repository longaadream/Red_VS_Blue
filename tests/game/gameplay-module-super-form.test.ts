/* eslint-disable @typescript-eslint/no-explicit-any -- frozen full-state differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildSuperFormGraph } from '@/scripts/migrate-semantic-super-form'
import { makePiece, makeState } from '../helpers/minimal-state'
const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/sonic-super-form']
const migrated = applyGameplayModuleGraph(original, buildSuperFormGraph())
function run(semantic: boolean, actionPoints: number, prior: boolean, hasOwner: boolean) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.name = '索尼克'
    caster.statusTags = [{ id: 'unrelated', type: 'unrelated', stacks: 3 }]
    if (prior) caster.statusTags.push({ id: 'old-preservation', type: 'preserve-momentum', stacks: 4, currentDuration: 7 })
    const battle: any = makeState({ pieces: [caster] })
    battle.turn.turnNumber = 5
    battle.players.find((player: any) => player.playerId === 'player-red').actionPoints = actionPoints
    if (!hasOwner) battle.players = battle.players.filter((player: any) => player.playerId !== 'player-red')
    const definition: any = semantic ? migrated : original
    battle.skillsById[definition.id] = definition
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}
describe('semantic Super Form', () => {
  for (const points of [0, 3, 20]) for (const prior of [false, true]) for (const owner of [false, true]) {
    it(`preserves grant, replacement, and turn marker: AP=${points}, prior=${prior}, owner=${owner}`, () => {
      const actual = run(true, points, prior, owner)
      expect(actual).toEqual(run(false, points, prior, owner))
      expect(actual.result.success).toBe(true)
      const tags = actual.state.pieces[0].statusTags
      expect(tags.filter((tag: any) => tag.type === 'preserve-momentum')).toHaveLength(1)
      expect(tags.find((tag: any) => tag.type === 'unrelated').stacks).toBe(3)
      if (owner) expect(actual.state.players.find((player: any) => player.playerId === 'player-red').actionPoints).toBe(points + 2)
    })
  }
})
