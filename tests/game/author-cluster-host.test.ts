import { describe, expect, it } from 'vitest'

import { getRuleDate, RuleRuntime, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '../../lib/game/rule-runtime'
import { loadRuleForBattle, loadSkillForBattle, createSkillCodeFlow, type SkillDefinition } from '../../lib/game/skills'
import { globalTriggerSystem, type TriggerRule } from '../../lib/game/triggers'
import type { BattleState } from '../../lib/game/turn'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

function skill(id: string): SkillDefinition {
  return {
    id,
    name: id,
    description: id,
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    code: 'function executeSkill(context) { return { success: true, message: "" } }',
    range: 'self',
    actionPointCost: 0,
  }
}

function rule(id: string): TriggerRule {
  return {
    id,
    name: id,
    description: id,
    trigger: { type: 'beginTurn' },
    effect: () => ({ success: true, message: '' }),
  }
}

function fixture(skillIds: string[], ruleIds: string[]) {
  const piece = asPieceInstance(makePiece({ instanceId: 'cluster-host' }))
  const battle = makeState({ pieces: [piece] })
  battle.skillsById = Object.fromEntries(skillIds.map(id => [id, skill(id)]))
  const rules = new Map(ruleIds.map(id => [id, rule(id)]))
  return { battle, piece, rules }
}

function directHostOverrides(battle: BattleState) {
  return {
    addSkillById: (pieceId: string, skillId: string) => {
      const target = battle.pieces.find(candidate => candidate.instanceId === pieceId)
      const definition = target
        ? loadSkillForBattle(battle, skillId, battle.skillsById[skillId], { requireExecutable: true })
        : null
      if (!target || !definition || target.skills.some(candidate => candidate.skillId === skillId)) return false
      target.skills.push({ skillId, currentCooldown: 0 })
      return true
    },
    removeSkillById: (pieceId: string, skillId: string) => {
      const target = battle.pieces.find(candidate => candidate.instanceId === pieceId)
      if (!target) return false
      const before = target.skills.length
      target.skills = target.skills.filter(candidate => candidate.skillId !== skillId)
      return target.skills.length !== before
    },
    addRuleById: (pieceId: string, ruleId: string) => {
      const target = battle.pieces.find(candidate => candidate.instanceId === pieceId)
      const definition = target ? loadRuleForBattle(battle, ruleId, { sourceId: pieceId }) : null
      if (!target || !definition || target.rules.some(candidate => candidate.id === ruleId)) return false
      target.rules.push({ ...definition })
      return true
    },
    removeRuleById: (pieceId: string, ruleId: string) => {
      const target = battle.pieces.find(candidate => candidate.instanceId === pieceId)
      if (!target) return false
      const before = target.rules.length
      target.rules = target.rules.filter(candidate => candidate.id !== ruleId)
      return target.rules.length !== before
    },
  }
}

function runInRuntime<T>(
  runtime: RuleRuntime,
  ruleResolver: (battle: unknown, ruleId: string, metadata?: unknown) => unknown | null,
  operation: () => T,
): T {
  const context = createRuleExecutionContext(globalTriggerSystem, { ruleResolver })
  return withRuleExecutionContext(context, () => withRuleRuntime(runtime, operation))
}

describe('author Cluster flow host integration', () => {
  it('does not create Cluster bookkeeping for ordinary direct member changes', () => {
    const { battle, piece, rules } = fixture(['ordinary-skill'], ['ordinary-rule'])
    const flow = createSkillCodeFlow(battle, { piece }, 'skill', directHostOverrides(battle))
    runInRuntime(new RuleRuntime({ rootSeed: 252 }), (_battle, id) => rules.get(id) ?? null, () => {
      flow.skills.add(piece.instanceId, 'ordinary-skill')
      flow.rules.add(piece.instanceId, 'ordinary-rule')
      expect(piece).not.toHaveProperty('abilityGroupOwnership')
      flow.skills.remove(piece.instanceId, 'ordinary-skill')
      flow.rules.remove(piece.instanceId, 'ordinary-rule')
      expect(piece).not.toHaveProperty('abilityGroupOwnership')
    })
  })
  it('resolves members with the destination piece attribution on acquire and removal', () => {
    const { battle, piece, rules } = fixture(['scoped-skill'], ['scoped-rule'])
    const seen: string[] = []
    const runtime = new RuleRuntime({ rootSeed: 252 })
    const execution = createRuleExecutionContext(globalTriggerSystem, {
      skillResolver: (_battle, id, _candidate, metadata) => { expect(metadata).toMatchObject({ sourceId: piece.instanceId }); seen.push(id); return battle.skillsById[id] },
      ruleResolver: (_battle, id, metadata) => { expect(metadata).toMatchObject({ sourceId: piece.instanceId }); seen.push(id); return rules.get(id) ?? null },
    })
    const flow = createSkillCodeFlow(battle, { piece }, 'skill')
    withRuleExecutionContext(execution, () => withRuleRuntime(runtime, () => {
      const group = flow.clusters.acquire(piece.instanceId, { id: 'scoped-cluster', skills: ['scoped-skill'], rules: ['scoped-rule'] })
      expect(flow.clusters.remove(group)).toBe(true)
    }))
    expect(seen).toContain('scoped-skill')
    expect(seen).toContain('scoped-rule')
    expect(piece.skills).toEqual([])
    expect(piece.rules).toEqual([])
  })
  it('acquires and lists real skill and rule definitions, then retains shared members on removal', () => {
    const { battle, piece, rules } = fixture(
      ['skill-shared', 'skill-a', 'skill-b'],
      ['rule-shared', 'rule-a', 'rule-b'],
    )
    const runtime = new RuleRuntime({ rootSeed: 252, tick: 4 })
    const flow = createSkillCodeFlow(battle, {
      piece,
      sourcePiece: piece,
      skill: { id: 'host-skill', name: 'Host', type: 'normal', powerMultiplier: 1 },
    }, 'skill')

    runInRuntime(runtime, (_battle, ruleId) => rules.get(ruleId) ?? null, () => {
      flow.clusters.acquire('cluster-host', {
        id: 'group-a',
        skills: ['skill-shared', 'skill-a'],
        rules: ['rule-shared', 'rule-a'],
      })
      flow.clusters.acquire('cluster-host', {
        id: 'group-b',
        skills: ['skill-shared', 'skill-b'],
        rules: ['rule-shared', 'rule-b'],
      })
    })

    expect(piece.skills.map(entry => entry.skillId)).toEqual(['skill-shared', 'skill-a', 'skill-b'])
    expect(piece.rules.map(entry => entry.id)).toEqual(['rule-shared', 'rule-a', 'rule-b'])
    const groups = flow.clusters.list('cluster-host')
    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.ownerPieceId)).toEqual(['cluster-host', 'cluster-host'])

    runInRuntime(runtime, (_battle, ruleId) => rules.get(ruleId) ?? null, () => {
      expect(flow.clusters.remove(groups[0])).toBe(true)
    })

    expect(piece.skills.map(entry => entry.skillId)).toEqual(['skill-shared', 'skill-b'])
    expect(piece.rules.map(entry => entry.id)).toEqual(['rule-shared', 'rule-b'])
    expect(flow.clusters.list('cluster-host')).toHaveLength(1)

    runInRuntime(runtime, (_battle, ruleId) => rules.get(ruleId) ?? null, () => {
      expect(flow.clusters.remove(flow.clusters.list('cluster-host')[0])).toBe(true)
    })
    expect(piece.skills).toEqual([])
    expect(piece.rules).toEqual([])
  })

  it('protects Cluster members when direct skill and rule additions are requested through flow', () => {
    const { battle, piece, rules } = fixture(['skill-shared'], ['rule-shared'])
    const runtime = new RuleRuntime({ rootSeed: 253, tick: 4 })
    const flow = createSkillCodeFlow(battle, {
      piece,
      sourcePiece: piece,
      skill: { id: 'host-skill', name: 'Host', type: 'normal', powerMultiplier: 1 },
    }, 'skill', directHostOverrides(battle))
    const resolver = (_battle: unknown, ruleId: string) => rules.get(ruleId) ?? null

    runInRuntime(runtime, resolver, () => {
      const group = flow.clusters.acquire('cluster-host', {
        id: 'protected',
        skills: ['skill-shared'],
        rules: ['rule-shared'],
      })

      expect(flow.skills.add('cluster-host', 'skill-shared')).toBe(false)
      expect(flow.rules.add('cluster-host', 'rule-shared')).toBe(false)
      expect(flow.clusters.remove(group)).toBe(true)
    })

    expect(piece.skills.map(entry => entry.skillId)).toEqual(['skill-shared'])
    expect(piece.rules.map(entry => entry.id)).toEqual(['rule-shared'])
    expect(piece.abilityGroupOwnership).toMatchObject({
      skills: {},
      rules: {},
      protectedSkills: ['skill-shared'],
      protectedRules: ['rule-shared'],
    })
  })

  it('rolls back a bad definition, piece state, random cursor, and deterministic clock', () => {
    const { battle, piece, rules } = fixture(['skill-valid'], ['rule-valid'])
    const runtime = new RuleRuntime({
      rootSeed: 254,
      tick: 4,
      cursors: { 'author-cluster-rollback': 0 },
    })
    const flow = createSkillCodeFlow(battle, {
      piece,
      sourcePiece: piece,
      skill: { id: 'host-skill', name: 'Host', type: 'normal', powerMultiplier: 1 },
    }, 'skill')
    const beforeState = JSON.stringify(battle)
    const beforeRuntime = runtime.snapshot()

    expect(() => runInRuntime(runtime, (_battle, ruleId) => {
      if (ruleId === 'rule-missing') {
        runtime.nextRandom('author-cluster-rollback')
        getRuleDate().now()
        return null
      }
      return rules.get(ruleId) ?? null
    }, () => flow.clusters.acquire('cluster-host', {
      id: 'broken',
      skills: ['skill-valid'],
      rules: ['rule-missing'],
    }))).toThrow(/missing|unavailable/i)

    expect(JSON.stringify(battle)).toBe(beforeState)
    expect(runtime.snapshot()).toEqual(beforeRuntime)
    expect(piece.abilityGroups).toBeUndefined()
  })
})
