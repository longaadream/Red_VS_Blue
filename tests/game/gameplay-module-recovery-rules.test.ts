/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildRecoveryRuleGraph, RECOVERY_RULE_IDS } from '@/scripts/migrate-semantic-recovery-rules'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('semantic status event recipes', () => {
  for (const id of RECOVERY_RULE_IDS) {
    it(id + ' preserves authoritative effects, fractional damage, status consumption and invalid references', () => {
      const root = mkdtempSync(join(tmpdir(), 'rvb-status-events-')), oldRoot = process.env.RVB_PROFILE_ROOT
      mkdirSync(join(root, 'data/rules'), { recursive: true })
      writeFileSync(join(root, 'data/rules/rule-divine-shield.json'), JSON.stringify(fixture['rules/rule-divine-shield']))
      try {
        process.env.RVB_PROFILE_ROOT = root
        const run = (semantic: boolean, damage: number, scenario: string) => {
          const frozen = fixture['rules/' + id]
          const document = semantic ? applyGameplayModuleGraph(frozen, buildRecoveryRuleGraph(id), 'skillCode') : frozen
          writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(document)); clearRuleCache()
          const rule = loadRuleById(id, true, true)!
          const holder: any = makePiece({ instanceId: 'holder', ownerPlayerId: 'player-red', currentHp: scenario === 'dead' ? 0 : 10 })
          holder.name = '测试棋子'; holder.rules = [rule]
          holder.statusTags = []
          if (scenario === 'has-shield') holder.statusTags.push({ id: 'custom-shield', type: 'divine-shield', stacks: 1 })
          holder.attack = 2.5
          if (scenario === 'spent') holder.spentPassives = ['shelly-bandage']
          holder.maxHp = 21
          holder.currentHp = scenario === 'dead' ? 0 : damage
          const other: any = makePiece({ instanceId: 'other', ownerPlayerId: 'player-blue' })
          const state: any = makeState({ pieces: [holder, other] })
          state.turn.currentPlayerId = scenario === 'wrong-turn' ? 'player-blue' : 'player-red'
          const subject = scenario === 'missing-subject' ? null : scenario === 'wrong-subject' ? other : holder
          const context: any = { type: frozen.trigger.type, damage, heal: damage, rulePiece: scenario === 'missing-holder' ? null : holder, piece: subject, sourcePiece: subject, playerId: scenario === 'wrong-turn' ? 'player-blue' : 'player-red' }
          context.statusType = scenario === 'missing-status' || scenario === 'id-only' ? undefined : 'divine-shield'
          context.statusId = scenario === 'missing-status' ? 'other' : scenario === 'id-only' ? 'divine-shield' : 'custom-shield'
          const result = rule.effect(state, context)
          const plain = JSON.parse(JSON.stringify(state))
          for (const piece of plain.pieces) piece.rules = piece.rules.map((r: any) => r.id)
          return { result, state: plain, damage: context.damage, heal: context.heal }
        }
        for (const damage of [0, 0.5, 1, 2, 9, 10, 10.5, 21]) for (const scenario of ['active', 'dead', 'missing-status', 'missing-subject', 'wrong-subject', 'missing-holder', 'wrong-turn', 'spent', 'has-shield', 'id-only']) {
          expect(run(true, damage, scenario), `${id}:${scenario}:${damage}`).toEqual(run(false, damage, scenario))
        }
        expect(run(true, 2, 'active').result).toMatchObject({ success: true })
        if (id === 'rule-tirion-divine-shield-start') {
          expect(run(true, 2, 'active').state.pieces[0].rules).toContain('rule-divine-shield')
          expect(run(true, 2, 'has-shield').result.success).toBe(false)
        }
      } finally {
        clearRuleCache()
        if (oldRoot === undefined) delete process.env.RVB_PROFILE_ROOT
        else process.env.RVB_PROFILE_ROOT = oldRoot
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
