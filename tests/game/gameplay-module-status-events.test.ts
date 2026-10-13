/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildStatusEventGraph, STATUS_EVENT_RECIPES } from '@/scripts/migrate-semantic-status-events'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('semantic status event recipes', () => {
  for (const [id, recipe] of Object.entries(STATUS_EVENT_RECIPES)) {
    it(id + ' preserves authoritative effects, fractional damage, status consumption and invalid references', () => {
      const root = mkdtempSync(join(tmpdir(), 'rvb-status-events-')), oldRoot = process.env.RVB_PROFILE_ROOT
      mkdirSync(join(root, 'data/rules'), { recursive: true })
      try {
        process.env.RVB_PROFILE_ROOT = root
        const run = (semantic: boolean, damage: number, scenario: string) => {
          const frozen = fixture['rules/' + id]
          const document = semantic ? applyGameplayModuleGraph(frozen, buildStatusEventGraph(id), 'skillCode') : frozen
          writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(document)); clearRuleCache()
          const rule = loadRuleById(id, true, true)!
          const holder: any = makePiece({ instanceId: 'holder', ownerPlayerId: 'player-red', currentHp: scenario === 'dead' ? 0 : 10 })
          holder.name = '测试棋子'; holder.rules = [rule]
          holder.statusTags = scenario === 'missing-status' ? [] : [{ id: 'first', type: recipe.status }, { id: 'second', type: recipe.status }]
          if (id === 'rule-naruto-sage-tick' && holder.statusTags.length) holder.statusTags[0].stacks = damage
          if (recipe.absorb && holder.statusTags.length) holder.statusTags[0].intensity = 3.5
          const other: any = makePiece({ instanceId: 'other', ownerPlayerId: 'player-blue' })
          const state: any = makeState({ pieces: [holder, other] })
          if (scenario.includes('clones')) {
            const clone = makePiece({ instanceId: 'clone', ownerPlayerId: scenario === 'enemy-clones' ? 'player-blue' : 'player-red', currentHp: scenario === 'dead-clones' ? 0 : 1 }) as any
            clone.statusTags = [{ id: 'clone-tag', type: 'naruto-clone' }]
            state.pieces.push(clone)
          }
          const subject = scenario === 'missing-subject' ? null : scenario === 'wrong-subject' ? other : holder
          const context: any = { type: frozen.trigger.type, damage, rulePiece: scenario === 'missing-holder' ? null : holder, piece: subject, sourcePiece: subject, playerId: scenario === 'wrong-turn' ? 'player-blue' : 'player-red' }
          const result = rule.effect(state, context)
          const plain = JSON.parse(JSON.stringify(state))
          return { result, state: plain, damage: context.damage }
        }
        for (const damage of [-2, 0, 0.5, 1, 2, 10.5]) for (const scenario of ['active', 'dead', 'missing-status', 'missing-subject', 'wrong-subject', 'missing-holder', ...(id === 'rule-naruto-sage-tick' ? ['clones', 'enemy-clones', 'dead-clones', 'wrong-turn'] : [])]) {
          expect(run(true, damage, scenario), `${id}:${scenario}:${damage}`).toEqual(run(false, damage, scenario))
        }
        expect(run(true, 10.5, 'active').result).toMatchObject({ success: true })
      } finally {
        clearRuleCache()
        if (oldRoot === undefined) delete process.env.RVB_PROFILE_ROOT
        else process.env.RVB_PROFILE_ROOT = oldRoot
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
