/* eslint-disable @typescript-eslint/no-explicit-any -- Frozen event parity. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildIceboundRetaliationGraph } from '@/scripts/migrate-semantic-icebound-retaliation'
import { clearRuleCache, loadRuleById, dealDamage } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'
const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
const id = 'rule-arthas-icebound-retaliate'
describe('icebound retaliation graph', () => {
  it('preserves damage gates, event identity, departed defender and real lethal combat', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-icebound-')), previous = process.env.RVB_PROFILE_ROOT
    mkdirSync(join(root, 'data/rules'), { recursive: true })
    for (const rule of ['rule-freeze-prevent-move', 'rule-freeze-prevent-skill']) writeFileSync(join(root, 'data/rules', rule + '.json'), JSON.stringify(entries['rules/' + rule]))
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, scenario: string, damage: number) => {
        writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(semantic ? applyGameplayModuleGraph(entries['rules/' + id], buildIceboundRetaliationGraph(id), 'skillCode') : entries['rules/' + id])); clearRuleCache()
        const rule = loadRuleById(id, true, true)!
        const holder: any = makePiece({ instanceId: 'holder', currentHp: 2 }), attacker: any = makePiece({ instanceId: 'attacker', ownerPlayerId: scenario === 'same-owner' ? 'player-red' : 'player-blue', currentHp: scenario === 'dead-attacker' ? 0 : 20 })
        holder.name = '防御者'; attacker.name = '攻击者'; holder.rules = [rule]
        holder.statusTags = scenario === 'no-status' ? [] : [{ id: 'ice', type: 'icebound-fortitude', currentDuration: 3 }]
        const battle: any = makeState({ pieces: [holder, attacker] })
        if (scenario === 'departed-defender') { battle.pieces = [attacker]; battle.graveyard = [holder] }
        if (scenario === 'departed-attacker') { battle.pieces = [holder]; battle.graveyard = [attacker] }
        const runtime = new RuleRuntime({ rootSeed: 126 })
        const result = withRuleRuntime(runtime, () => scenario === 'combat' ? dealDamage(attacker, holder, damage, 'true', battle, 'icebound-test') : rule.effect(battle, { type: 'afterDamageTaken', rulePiece: scenario === 'missing-holder' ? null : holder, piece: scenario === 'missing-subject' ? null : scenario === 'wrong-subject' ? attacker : holder, targetPiece: scenario === 'missing-attacker' ? null : attacker, damage } as any))
        const state = JSON.parse(JSON.stringify(battle))
        for (const item of [...state.pieces, ...state.graveyard]) if (item.rules) item.rules = item.rules.map((rule: any) => rule.id)
        return { result, state, random: runtime.snapshot() }
      }
      for (const damage of [0, 0.5, 1, 3, 20]) for (const scenario of ['normal', 'same-owner', 'dead-attacker', 'no-status', 'departed-defender', 'departed-attacker', 'missing-holder', 'missing-subject', 'wrong-subject', 'missing-attacker', 'combat']) expect(run(true, scenario, damage), scenario + ':' + damage).toEqual(run(false, scenario, damage))
      expect(run(true, 'departed-defender', 1).result.success).toBe(true)
      expect(run(true, 'normal', 1).state.pieces[1].statusTags.some((tag: any) => tag.type === 'freeze')).toBe(true)
    } finally {
      clearRuleCache()
      if (previous === undefined) delete process.env.RVB_PROFILE_ROOT; else process.env.RVB_PROFILE_ROOT = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})
