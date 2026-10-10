/* eslint-disable @typescript-eslint/no-explicit-any -- Frozen queue/event parity. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildOathReflectionGraph } from '@/scripts/migrate-semantic-oath-reflection'
import { clearRuleCache, loadRuleById, dealDamage } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'
const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
const id = 'rule-hidan-blood-oath-reflect'
describe('oath reflection semantic graph', () => {
  it('preserves first living enemy selection, departure, raw rule removal and authoritative queue writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-oath-')), previous = process.env.RVB_PROFILE_ROOT
    mkdirSync(join(root, 'data/rules'), { recursive: true })
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, scenario: string, damage: number) => {
        writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(semantic ? applyGameplayModuleGraph(entries['rules/' + id], buildOathReflectionGraph(id), 'skillCode') : entries['rules/' + id])); clearRuleCache()
        const rule = loadRuleById(id, true, true)!
        const holder: any = makePiece({ instanceId: 'holder', currentHp: 10 }), enemy: any = makePiece({ instanceId: 'first', ownerPlayerId: scenario === 'ally' ? 'player-red' : 'player-blue', currentHp: scenario === 'dead-first' ? 0 : 20 }), second: any = makePiece({ instanceId: 'second', ownerPlayerId: 'player-blue', currentHp: 20 })
        holder.name = '飞段'; enemy.name = '首位目标'; second.name = '后位目标'; holder.rules = [rule]
        for (const target of [enemy, second]) target.statusTags = scenario === 'no-oath' || scenario === 'departed-no-oath' ? [] : [{ id: 'oath', type: 'blood-oath' }]
        const battle: any = makeState({ pieces: [holder, enemy, second] })
        if (scenario.startsWith('departed')) { battle.pieces = [enemy, second]; battle.graveyard = [holder] }
        const queued: any[] = []
        const context: any = { type: 'afterDamageTaken', rulePiece: holder, piece: scenario === 'wrong-subject' ? enemy : holder, damage, damageQueue: { push: (effect: any) => queued.push(effect) } }
        const runtime = new RuleRuntime({ rootSeed: 251 })
        const result = withRuleRuntime(runtime, () => scenario === 'combat' ? dealDamage(enemy, holder, damage, 'true', battle, 'oath-test') : rule.effect(battle, context))
        const state = JSON.parse(JSON.stringify(battle))
        for (const item of [...state.pieces, ...state.graveyard]) if (item.rules) item.rules = item.rules.map((rule: any) => rule.id)
        return { result, state, queued: queued.map(effect => ({ ...effect, attacker: effect.attacker.instanceId, target: effect.target.instanceId })), random: runtime.snapshot() }
      }
      for (const damage of [0, 0.5, 1, 10, 20]) for (const scenario of ['normal', 'ally', 'dead-first', 'no-oath', 'departed', 'departed-no-oath', 'wrong-subject', 'combat']) expect(run(true, scenario, damage), scenario + ':' + damage).toEqual(run(false, scenario, damage))
      expect(run(true, 'normal', 1).queued[0].target).toBe('first')
      expect(run(true, 'dead-first', 1).queued[0].target).toBe('second')
      expect(run(true, 'departed-no-oath', 1).state.graveyard[0].rules).toEqual([])
      expect(run(true, 'combat', 1).state.pieces.find((piece: any) => piece.instanceId === 'first').currentHp).toBe(19)
    } finally {
      clearRuleCache()
      if (previous === undefined) delete process.env.RVB_PROFILE_ROOT; else process.env.RVB_PROFILE_ROOT = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})
