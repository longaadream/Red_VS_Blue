/* eslint-disable @typescript-eslint/no-explicit-any -- Frozen event object parity. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildDeathCardRuleGraph, DEATH_CARD_RULE_IDS } from '@/scripts/migrate-semantic-death-card-rules'
import { clearRuleCache, loadRuleById, dealDamage } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'
const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('death card generation preserves event references', () => {
  for (const id of DEATH_CARD_RULE_IDS) it(id, () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-death-cards-')), previous = process.env.RVB_PROFILE_ROOT
    for (const group of ['rules', 'cards']) mkdirSync(join(root, 'data', group), { recursive: true })
    writeFileSync(join(root, 'data/cards/soul-fragment.json'), JSON.stringify(entries['cards/soul-fragment']))
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, scenario: string) => {
        writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(semantic ? applyGameplayModuleGraph(entries['rules/' + id], buildDeathCardRuleGraph(id), 'skillCode') : entries['rules/' + id])); clearRuleCache()
        const rule = loadRuleById(id, true, true)!
        const holder: any = makePiece({ instanceId: 'holder' }), source: any = makePiece({ instanceId: 'dead', ownerPlayerId: 'player-blue', currentHp: scenario === 'combat' ? 1 : 0 })
        holder.name = '裂魂持有者'; source.name = '死亡棋子'
        const battle: any = makeState({ pieces: [holder, source] })
        if (scenario === 'graveyard' || scenario === 'both-gone') { battle.pieces = [holder]; battle.graveyard = [source] }
        if (scenario === 'both-gone') { battle.pieces = []; battle.graveyard.push(holder) }
        if (scenario === 'full-hand') battle.players[0].hand = Array.from({ length: 10 }, (_, i) => ({ cardId: 'soul-fragment', instanceId: 'existing-' + i }))
        if (id.endsWith('-player')) battle.players[0].rules = [rule]; else holder.rules = [rule]
        const runtime = new RuleRuntime({ rootSeed: 594 })
        const result = withRuleRuntime(runtime, () => scenario === 'combat' ? dealDamage(holder, source, 2, 'true', battle, 'death-card-test') : rule.effect(battle, { type: 'onPieceDied', rulePiece: scenario === 'missing-holder' ? null : holder, sourcePiece: scenario === 'missing-source' ? null : source, playerId: 'player-red' } as any))
        const state = JSON.parse(JSON.stringify(battle))
        for (const item of [...state.pieces, ...state.graveyard, ...state.players]) if (item.rules) item.rules = item.rules.map((rule: any) => rule.id)
        return { result, state, random: runtime.snapshot() }
      }
      for (const scenario of ['normal', 'graveyard', 'both-gone', 'full-hand', 'missing-holder', 'missing-source', 'combat']) expect(run(true, scenario), scenario).toEqual(run(false, scenario))
      expect(run(true, 'graveyard').result.success).toBe(true)
      expect(run(true, 'combat').state.players[0].hand).toHaveLength(1)
    } finally {
      clearRuleCache()
      if (previous === undefined) delete process.env.RVB_PROFILE_ROOT; else process.env.RVB_PROFILE_ROOT = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})
