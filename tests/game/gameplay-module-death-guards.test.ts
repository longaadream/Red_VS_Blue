/* eslint-disable @typescript-eslint/no-explicit-any -- Legacy event parity fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildDeathGuardGraph, DEATH_GUARD_RULE_IDS } from '@/scripts/migrate-semantic-death-guards'
import { clearRuleCache, loadRuleById, dealDamage } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('semantic lethal protection and queued reflection', () => {
  for (const id of DEATH_GUARD_RULE_IDS) it(id + ' preserves effect results and queue order', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-death-guards-')), oldRoot = process.env.RVB_PROFILE_ROOT
    mkdirSync(join(root, 'data/rules'), { recursive: true })
    writeFileSync(join(root, 'data/rules/rule-hidan-undying-tick.json'), JSON.stringify(frozen['rules/rule-hidan-undying-tick']))
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, damage: number, scenario: string) => {
        writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(semantic ? applyGameplayModuleGraph(frozen['rules/' + id], buildDeathGuardGraph(id), 'skillCode') : frozen['rules/' + id]))
        clearRuleCache()
        const rule = loadRuleById(id, true, true)!
        const holder: any = makePiece({ instanceId: 'holder', currentHp: 8, maxHp: 10 })
        holder.name = '被保护棋子'; holder.rules = [rule]
        if (id.includes('dying-immune') || scenario === 'dying') holder.statusTags.push({ id: 'dying', type: 'hidan-dying' })
        if (id.includes('kamui') && scenario !== 'missing-status') holder.statusTags.push({ id: 'kamui-shield', type: 'kamui-shield' })
        if (scenario === 'spent') holder.spentPassives = ['hidan-undying']
        if (scenario === 'used-tag') holder.statusTags.push({ id: 'used', type: 'hidan-undying-used' })
        if (scenario === 'missing-status') holder.statusTags = []
        const enemy: any = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', currentHp: scenario === 'dead-attacker' ? 0 : 20 })
        enemy.name = '敌方来源'
        if (scenario !== 'no-oath') enemy.statusTags = [{ id: 'oath', type: 'blood-oath' }]
        const battle: any = makeState({ pieces: [holder, enemy] })
        const context: any = { type: frozen['rules/' + id].trigger.type, rulePiece: holder, piece: scenario === 'wrong-subject' ? enemy : holder, target: scenario === 'missing-attacker' ? null : enemy, damage, damageQueue: [] }
        const result = scenario === 'combat' ? dealDamage(enemy, holder, damage, 'true', battle, 'guard-parity') : rule.effect(battle, context)
        const plain = JSON.parse(JSON.stringify({ battle, result, queue: context.damageQueue }))
        for (const piece of [...plain.battle.pieces, ...(plain.battle.graveyard || [])]) piece.rules = piece.rules.map((rule: any) => rule.id)
        for (const queued of plain.queue) for (const piece of [queued.attacker, queued.target]) piece.rules = piece.rules.map((rule: any) => rule.id)
        return plain
      }
      for (const damage of [0, 0.5, 7, 8, 20]) for (const scenario of ['normal', 'missing-status', 'wrong-subject', 'spent', 'used-tag', 'dying', 'no-oath', 'missing-attacker', 'dead-attacker']) {
        expect(run(true, damage, scenario), `${id}:${damage}:${scenario}`).toEqual(run(false, damage, scenario))
      }
      expect(run(true, 8, 'normal').result).toMatchObject({ success: true, blocked: true })
      for (const damage of [1, 8, 20]) expect(run(true, damage, 'combat')).toEqual(run(false, damage, 'combat'))
    } finally {
      clearRuleCache()
      if (oldRoot === undefined) delete process.env.RVB_PROFILE_ROOT
      else process.env.RVB_PROFILE_ROOT = oldRoot
      rmSync(root, { recursive: true, force: true })
    }
  })
})
