/* eslint-disable @typescript-eslint/no-explicit-any -- Frozen rule host parity fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildPlayerProtectionRuleGraph, PLAYER_PROTECTION_RULE_IDS } from '@/scripts/migrate-semantic-player-protection-rules'
import { clearRuleCache, loadRuleById, dealDamage } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('player protection semantic rules', () => {
  for (const id of PLAYER_PROTECTION_RULE_IDS) it(id + ' preserves shared consumption, teams and guard cases', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-protection-')), oldRoot = process.env.RVB_PROFILE_ROOT
    mkdirSync(join(root, 'data/rules'), { recursive: true })
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, damage: number, scenario: string) => {
        for (const ruleId of PLAYER_PROTECTION_RULE_IDS) writeFileSync(join(root, 'data/rules', ruleId + '.json'), JSON.stringify(semantic ? applyGameplayModuleGraph(frozen['rules/' + ruleId], buildPlayerProtectionRuleGraph(ruleId), 'skillCode') : frozen['rules/' + ruleId]))
        clearRuleCache()
        const holder: any = makePiece({ instanceId: 'holder', currentHp: 8, maxHp: 10 })
        holder.name = '守护对象'
        const other: any = makePiece({ instanceId: 'other', ownerPlayerId: 'player-blue', currentHp: 8, maxHp: 10 })
        other.name = '另一棋子'
        const battle: any = makeState({ pieces: [holder, other] })
        if (scenario === 'ally') for (const player of battle.players) player.teamId = 'red'
        if (scenario !== 'no-status') battle.players[0].statusTags = [
          { id: 'first', type: 'elune-protection' },
          { id: 'second', type: 'elune-protection' },
          { id: 'keep', type: 'other' },
        ]
        const target = scenario === 'enemy' || scenario === 'ally' ? other : holder
        const context: any = { type: frozen['rules/' + id].trigger.type, rulePiece: scenario === 'missing-holder' ? null : holder, sourcePiece: scenario === 'wrong-source' ? other : holder, piece: scenario === 'missing-target' ? null : target, playerId: scenario === 'missing-player' ? 'absent' : 'player-red', damage }
        const rule = loadRuleById(id, true, true)!
        if (scenario === 'combat') battle.players[0].rules = [rule]
        const result = scenario === 'combat' ? dealDamage(other, holder, damage, 'true', battle, 'protection-parity') : rule.effect(battle, context)
        const plain = JSON.parse(JSON.stringify(battle))
        return { result, battle: plain }
      }
      for (const damage of [0, 1, 7.5, 8, 9, 100]) for (const scenario of ['normal', 'no-status', 'ally', 'enemy', 'missing-holder', 'missing-target', 'missing-player', 'wrong-source']) {
        expect(run(true, damage, scenario), `${id}:${damage}:${scenario}`).toEqual(run(false, damage, scenario))
      }
      if (id.endsWith('-player')) {
        for (const damage of [1, 8, 99]) expect(run(true, damage, 'combat')).toEqual(run(false, damage, 'combat'))
        const success = run(true, 8, 'ally')
        expect(success.result).toMatchObject({ success: true, blocked: true })
        expect(success.battle.players[0].statusTags).toEqual([{ id: 'keep', type: 'other' }])
        expect(success.battle.pieces[1].currentHp).toBe(10)
      } else expect(run(true, 8, 'no-status').result.success).toBe(true)
    } finally {
      clearRuleCache()
      if (oldRoot === undefined) delete process.env.RVB_PROFILE_ROOT
      else process.env.RVB_PROFILE_ROOT = oldRoot
      rmSync(root, { recursive: true, force: true })
    }
  })
})
