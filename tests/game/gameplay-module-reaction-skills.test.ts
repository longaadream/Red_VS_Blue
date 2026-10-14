/* eslint-disable @typescript-eslint/no-explicit-any -- Real host trigger differential fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildReactionSkillGraph, REACTION_SKILL_IDS } from '@/scripts/migrate-semantic-reaction-skills'
import { clearRuleCache, clearSkillDefinitionCache, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
describe('semantic status reactions', () => {
  for (const id of REACTION_SKILL_IDS) it(id + ' preserves event-specific output and mutations', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-reaction-')), previousRoot = process.env.RVB_PROFILE_ROOT
    for (const group of ['skills', 'rules']) mkdirSync(join(root, 'data', group), { recursive: true })
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      process.env.RVB_PROFILE_ROOT = root
      const statusType = { 'anti-heal-block': 'anti-heal', 'freeze-prevent': 'freeze', 'sleep-prevent': 'sleep', 'sleep-remove': 'sleep', 'divine-shield-defense': 'divine-shield', 'hardy-block-trigger': 'hardy-block' }[id]
      const run = (semantic: boolean, damage: number, status: string, event: string) => {
        clearRuleCache(); clearSkillDefinitionCache(); globalTriggerSystem.clearRules()
        const original = fixture['skills/' + id], definition = semantic ? applyGameplayModuleGraph(original, buildReactionSkillGraph(id)) : original
        writeFileSync(join(root, 'data/skills', id + '.json'), JSON.stringify(definition))
        writeFileSync(join(root, 'data/rules/trigger-test.json'), JSON.stringify({ id: 'trigger-test', name: 'test', trigger: { type: event }, effect: { type: 'triggerSkill', skillId: id } }))
        const rule = loadRuleById('trigger-test', true, true)!
        const holder: any = makePiece({ instanceId: 'holder', name: '持有者' }), subject: any = makePiece({ instanceId: 'subject', name: '事件主体', ownerPlayerId: 'player-blue', attack: 3.5 })
        holder.name = '持有者'; subject.name = '事件主体'
        subject.statusTags = status === 'none' ? [] : ['object', 'other-id'].includes(status) ? [{ id: status === 'object' ? statusType : 'other-status', type: statusType }] : [status === 'string' ? statusType : 'prefix-' + statusType]
        subject.rules = ['rule-divine-shield', 'rule-hardy-block', 'rule-sleep-prevent-move', 'rule-sleep-prevent-skill', 'rule-sleep-remove-on-damage'].map(id => ({ id }))
        subject.skills = [{ skillId: 'divine-shield-defense', currentCooldown: 0 }, { skillId: 'sleep-prevent', currentCooldown: 0 }, { skillId: 'sleep-remove', currentCooldown: 0 }]
        const state: any = makeState({ pieces: [holder, subject] }); state.skillsById[id] = definition
        const context: any = { type: event, damage, rulePiece: holder, sourcePiece: holder, piece: subject, target: event === 'beforeDamageTaken' ? holder : null, playerId: 'player-red' }
        const result = rule.effect(state, context)
        const normalized = JSON.parse(JSON.stringify(state)); delete normalized.skillsById
        return { result, state: normalized, damage: context.damage }
      }
      for (const damage of [-1, 0, 0.5, 3, 10.5]) for (const status of ['none', 'object', 'other-id', 'string', 'prefix']) for (const event of ['beforeMove', 'beforeSkillUse', 'beforeDamageTaken']) expect(run(true, damage, status, event)).toEqual(run(false, damage, status, event))
      expect(run(true, 10.5, 'object', 'beforeMove').result.success).toBe(id !== 'anti-heal-block')
    } finally {
      debug.mockRestore(); clearRuleCache(); clearSkillDefinitionCache(); globalTriggerSystem.clearRules()
      if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
      else process.env.RVB_PROFILE_ROOT = previousRoot
      rmSync(root, { recursive: true, force: true })
    }
  })
})
