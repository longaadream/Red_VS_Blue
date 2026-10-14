/* eslint-disable @typescript-eslint/no-explicit-any -- frozen full-state differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildKyokaGraph } from '@/scripts/migrate-semantic-kyoka'
import { makePiece, makeState } from '../helpers/minimal-state'
const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/aizen-kyoka-suiguetsu']
const migrated = applyGameplayModuleGraph(original, buildKyokaGraph())
function run(semantic: boolean, selected: boolean, prior: boolean, self: boolean, opponent: boolean) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.name = '蓝染'
    const ally: any = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 })
    caster.statusTags = [{ id: 'unrelated', type: 'unrelated', stacks: 3 }]
    if (prior) caster.statusTags.push({ id: 'old-active', type: 'aizen-kyoka-active', stacks: 4 }, { id: 'old-secret', type: 'aizen-kyoka-secret', targetPieceId: 'obsolete' })
    const battle: any = makeState({ pieces: [caster, ally] })
    if (!opponent) battle.players = battle.players.filter((player: any) => player.playerId === 'player-red')
    const definition: any = semantic ? migrated : original
    battle.skillsById[definition.id] = definition
    const target = self ? caster : ally
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: selected ? target : null, targets: selected ? [{ info: target, pos: null }] : [] } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state, runtime: runtime.snapshot() }
  })
}
describe('semantic Kyoka Suigetsu', () => {
  for (const selected of [false, true]) for (const prior of [false, true]) for (const self of [false, true]) for (const opponent of [false, true]) {
    it(`preserves hidden target: selected=${selected}, prior=${prior}, self=${self}, opponent=${opponent}`, () => {
      const actual = run(true, selected, prior, self, opponent)
      expect(actual).toEqual(run(false, selected, prior, self, opponent))
      if (selected) {
        const tags = actual.state.pieces[0].statusTags
        expect(tags.filter((tag: any) => tag.type === 'aizen-kyoka-secret')).toHaveLength(1)
        const secret = tags.find((tag: any) => tag.type === 'aizen-kyoka-secret')
        expect(secret.visible).toBe(false)
        expect(secret.targetPieceId).toBe(self ? 'caster' : 'ally')
      }
    })
  }
})
