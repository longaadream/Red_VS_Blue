/* eslint-disable @typescript-eslint/no-explicit-any -- Frozen host parity fixtures. */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction, clearRuleCache, clearSkillDefinitionCache, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildHandGrantGraph, HAND_GRANT_SKILL_IDS } from '@/scripts/migrate-semantic-hand-grants'
import { makePiece, makeState } from '../helpers/minimal-state'
const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('semantic hand generation', () => {
  for (const id of HAND_GRANT_SKILL_IDS) it(id + ' preserves hand cap, random stream and buff overwrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-hand-grants-')), previous = process.env.RVB_PROFILE_ROOT
    for (const group of ['rules', 'skills', 'cards']) mkdirSync(join(root, 'data', group), { recursive: true })
    for (const card of ['holy-smite', 'holy-heal', 'holy-charge', 'sample-reactive-card']) writeFileSync(join(root, 'data/cards', card + '.json'), JSON.stringify(entries['cards/' + card]))
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, seed: number, handCount: number) => {
        const runtime = new RuleRuntime({ rootSeed: seed })
        return withRuleRuntime(runtime, () => {
        const definition = semantic ? applyGameplayModuleGraph(entries['skills/' + id], buildHandGrantGraph(id)) : entries['skills/' + id]
        const caster: any = makePiece({ instanceId: 'caster' }); caster.name = '施放者'
        const battle: any = makeState({ pieces: [caster] }); battle.skillsById[id] = definition
        for (const player of battle.players) {
          player.hand = Array.from({ length: handCount }, (_, index) => ({ instanceId: player.playerId + index, cardId: 'holy-charge', ownerPlayerId: player.playerId }))
          player.buffs = { 'elune-blessing-buff': { multiplier: 1.5, uses: 4 }, other: { uses: 2 } }
        }
        let result
        if (id === 'initial-draw') {
          clearRuleCache(); clearSkillDefinitionCache()
          writeFileSync(join(root, 'data/skills', id + '.json'), JSON.stringify(definition))
          writeFileSync(join(root, 'data/rules/hand-trigger.json'), JSON.stringify({ id: 'hand-trigger', name: 'test', trigger: { type: 'onGameStart' }, effect: { type: 'triggerSkill', skillId: id } }))
          result = loadRuleById('hand-trigger', true, true)!.effect(battle, { type: 'onGameStart', rulePiece: caster, sourcePiece: caster, piece: caster, playerId: 'player-red' } as any)
        } else result = executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: null, targets: [] } as any, battle)
        const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
        return { result, state, runtime: runtime.snapshot() }
        })
      }
      for (const seed of [1, 17, 594, 2000]) for (const count of [0, 8, 10]) {
        const expected = run(false, seed, count), actual = run(true, seed, count)
        expect(actual, `${id}:${seed}:${count}`).toEqual(expected)
        expect(actual.result.success).toBe(true)
        if (id === 'elune-blessing') expect(actual.state.players[0].buffs['elune-blessing-buff']).toEqual({ multiplier: 2, uses: 1 })
      }
    } finally {
      clearRuleCache(); clearSkillDefinitionCache()
      if (previous === undefined) delete process.env.RVB_PROFILE_ROOT; else process.env.RVB_PROFILE_ROOT = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})
