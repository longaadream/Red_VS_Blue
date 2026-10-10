/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildTriggerSkillGraph, TRIGGER_SKILL_IDS } from '@/scripts/migrate-semantic-trigger-skills'
import { clearRuleCache, clearSkillDefinitionCache, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('semantic trigger skill entry points', () => {
  for (const id of TRIGGER_SKILL_IDS) it(id + ' preserves triggered context and state', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-trigger-skills-')), previousRoot = process.env.RVB_PROFILE_ROOT
    for (const group of ['skills', 'rules']) mkdirSync(join(root, 'data', group), { recursive: true })
    for (const rule of ['rule-elune-guidance', 'rule-elune-protection-player']) writeFileSync(join(root, 'data/rules', rule + '.json'), JSON.stringify(fixture['rules/' + rule]))
    try {
      process.env.RVB_PROFILE_ROOT = root
      const run = (semantic: boolean, damage: number, intensities: (number | null)[]) => {
        clearRuleCache(); clearSkillDefinitionCache(); globalTriggerSystem.clearRules()
        const original = fixture['skills/' + id], definition = semantic ? applyGameplayModuleGraph(original, buildTriggerSkillGraph(id)) : original
        writeFileSync(join(root, 'data/skills', id + '.json'), JSON.stringify(definition))
        writeFileSync(join(root, 'data/rules/trigger-test.json'), JSON.stringify({ id: 'trigger-test', name: 'test', trigger: { type: 'beforeDamageDealt' }, effect: { type: 'triggerSkill', skillId: id } }))
        const rule = loadRuleById('trigger-test', true, true)!
        const source: any = makePiece({ instanceId: 'source', name: '来源' }), subject: any = makePiece({ instanceId: 'subject', name: '事件主体', ownerPlayerId: 'player-blue' })
        source.name = '来源'; subject.name = '事件主体'
        source.statusTags = intensities.map((intensity, index) => ({ id: 'boost-' + index, type: 'nano-boost', ...(intensity === null ? {} : { intensity }) }))
        const state: any = makeState({ pieces: [source, subject] }); state.skillsById[id] = definition
        const context: any = { type: 'beforeDamageDealt', damage, rulePiece: source, sourcePiece: source, piece: subject, playerId: 'player-red' }
        const result = rule.effect(state, context)
        const normalized = JSON.parse(JSON.stringify(state)); delete normalized.skillsById
        for (const entity of [...normalized.pieces, ...normalized.players]) if (entity.rules) entity.rules = entity.rules.map((r: any) => r.id)
        return { result, state: normalized, damage: context.damage }
      }
      for (const damage of [-1, 0, 0.5, 10.5]) for (const intensities of [[], [1], [1, 2.5, null], [-1, 1]]) expect(run(true, damage, intensities)).toEqual(run(false, damage, intensities))
      expect(run(true, 10.5, [1]).result).toMatchObject({ success: true })
    } finally {
      clearRuleCache(); clearSkillDefinitionCache(); globalTriggerSystem.clearRules()
      if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
      else process.env.RVB_PROFILE_ROOT = previousRoot
      rmSync(root, { recursive: true, force: true })
    }
  })
})
