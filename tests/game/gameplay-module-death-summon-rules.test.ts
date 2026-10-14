/* eslint-disable @typescript-eslint/no-explicit-any -- Frozen host differential scenarios. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildDeathSummonRuleGraph, DEATH_SUMMON_RULE_IDS } from '@/scripts/migrate-semantic-death-summon-rules'
import { clearRuleCache, loadRuleById, dealDamage } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('death summon profiles expressed as typed data', () => {
  for (const id of DEATH_SUMMON_RULE_IDS) it(id + ' preserves guards and complete death/resummon behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-death-modules-')), previous = process.env.RVB_PROFILE_ROOT
    mkdirSync(join(root, 'data/rules'), { recursive: true })
    mkdirSync(join(root, 'data/skills'), { recursive: true })
    for (const skill of ['fireball', 'grimmjow-destruction-instinct', 'grimmjow-hunting-instinct', 'grimmjow-resurreccion', 'grimmjow-panther-claw']) writeFileSync(join(root, 'data/skills', skill + '.json'), JSON.stringify(fixture['skills/' + skill]))
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, scenario: string, core: boolean, hp: number) => {
        const original = fixture['rules/' + id]
        writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(semantic ? applyGameplayModuleGraph(original, buildDeathSummonRuleGraph(id), 'skillCode') : original)); clearRuleCache()
        const rule = loadRuleById(id, true, true)!
        const holder: any = makePiece({ instanceId: 'holder', ownerPlayerId: 'player-blue', x: 2, y: 2, currentHp: hp, maxHp: 20, attack: 7 })
        holder.name = '测试棋子'; holder.isCore = core; holder.defense = 2; holder.rules = [rule]
        holder.statusTags = scenario === 'already' ? [{ id: 'resurreccion', type: 'resurreccion' }] : scenario === 'missing-status' ? [] : [{ id: 'covenant', type: 'lich-covenant' }]
        holder.skills = [{ skillId: 'fireball', currentCooldown: 3, usesRemaining: 1 }]
        holder.initialDefinition = { stats: { maxHp: 20, attack: 6, defense: 1, moveRange: 3 }, skills: [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: 2 }], rules: [], statusTags: [] }
        const attacker: any = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-red', x: 1, y: 2 })
        const state: any = makeState({ pieces: [holder, attacker] })
        const result = scenario === 'combat' ? dealDamage(attacker, holder, 999, 'true', state, 'death-parity') : rule.effect(state, { type: 'onPieceDied', piece: holder, sourcePiece: scenario === 'wrong-subject' ? attacker : scenario === 'missing-subject' ? null : holder, rulePiece: scenario === 'missing-holder' ? null : holder } as any)
        const plain = JSON.parse(JSON.stringify(state))
        return { result, state: plain }
      }
      for (const scenario of ['active', 'already', 'missing-status', 'wrong-subject', 'missing-subject', 'missing-holder']) for (const hp of [0, 1, -1]) expect(run(true, scenario, true, hp), scenario + ':' + hp).toEqual(run(false, scenario, true, hp))
      for (const core of [true, false]) {
        const expected = run(false, 'combat', core, 2), actual = run(true, 'combat', core, 2)
        expect(actual).toEqual(expected)
        expect(actual.state.graveyard).toHaveLength(1)
        const summoned = actual.state.pieces.find((piece: any) => piece.ownerPlayerId === 'player-blue')
        expect(summoned.instanceId).not.toBe('holder')
        expect(summoned.currentHp).toBe(id === 'rule-arthas-lich-covenant' ? 20 : 10)
        expect(summoned.skills.every((skill: any) => skill.currentCooldown === 0)).toBe(true)
      }
    } finally {
      clearRuleCache()
      if (previous === undefined) delete process.env.RVB_PROFILE_ROOT; else process.env.RVB_PROFILE_ROOT = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})
