import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import type { BattleState } from '../../lib/game/turn'
import type { TriggerRule } from '../../lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function fixture() {
  const source = makePiece({ instanceId: 'source' })
  source.skills = [
    { skillId: 'duplicate', currentCooldown: 3 },
    { skillId: 'duplicate', currentCooldown: 7 },
    { skillId: 'passive', currentCooldown: 4 },
    { skillId: 'unknown', currentCooldown: 0 },
  ]
  const battle = makeState({ pieces: [source] })
  battle.skillsById = {
    duplicate: { kind: 'active' },
    passive: { kind: 'passive' },
  } as unknown as BattleState['skillsById']
  return { battle, source }
}

describe('flow skill instance runtime', () => {
  it('reads and writes duplicate skill IDs by execution-local instance identity', () => {
    const { battle, source } = fixture()
    const flow = createFlowRuntime(battle, { piece: source }, 'skill', {})
    const result = flow.skills.instances(source.instanceId)

    expect(result.present).toBe(true)
    expect(result.instances).toHaveLength(4)
    expect(flow.skills.field(result.instances[0], 'skillId')).toEqual({ value: 'duplicate', defined: true })
    expect(flow.skills.field(result.instances[1], 'currentCooldown')).toEqual({ value: 7, defined: true })
    expect(flow.skills.field(result.instances[2], 'kind')).toEqual({ value: 'passive', defined: true })
    expect(flow.skills.field(result.instances[3], 'kind')).toEqual({ value: null, defined: false })

    expect(flow.skills.setInstanceCooldown(result.instances[0], 0)).toBe(true)
    expect(flow.skills.setInstanceCooldown(result.instances[1], 2)).toBe(true)
    expect(source.skills.map(skill => skill.currentCooldown)).toEqual([0, 2, 4, 0])
  })

  it('rejects forged, stale, and cross-execution handles without retargeting', () => {
    const { battle, source } = fixture()
    const flow = createFlowRuntime(battle, { piece: source }, 'skill', {})
    const otherFlow = createFlowRuntime(battle, { piece: source }, 'skill', {})
    const [handle] = flow.skills.instances(source.instanceId).instances

    expect(() => flow.skills.field({ ...(handle as object) }, 'skillId')).toThrow('已经失效')
    expect(() => otherFlow.skills.field(handle, 'skillId')).toThrow('已经失效')
    source.skills = source.skills.map(skill => ({ ...skill }))
    expect(() => flow.skills.setInstanceCooldown(handle, 0)).toThrow('已经失效')
    expect(source.skills.map(skill => skill.currentCooldown)).toEqual([3, 7, 4, 0])
  })

  it('keeps absent skill arrays as a present=false read and validates writes', () => {
    const { battle, source } = fixture()
    Reflect.set(source, 'skills', undefined)
    const flow = createFlowRuntime(battle, { piece: source }, 'skill', {})
    expect(flow.skills.instances(source.instanceId)).toEqual({ instances: [], present: false })

    const withSkills = fixture()
    const active = createFlowRuntime(withSkills.battle, { piece: withSkills.source }, 'skill', {})
    const [handle] = active.skills.instances(withSkills.source.instanceId).instances
    expect(() => active.skills.field(handle, 'unsupported' as never)).toThrow('无效技能实例字段')
    expect(() => active.skills.setInstanceCooldown(handle, Infinity)).toThrow('冷却值无效')
    expect(withSkills.source.skills[0].currentCooldown).toBe(3)
  })

  it('resolves the current Cluster by exact Skill membership and supports an explicit disambiguator', () => {
    const { battle, source } = fixture()
    source.skills = [{ skillId: 'duplicate', instanceId: 'duplicate-instance', abilityGroupIds: ['custom-group:0'] }]
    const sourceAny = source as typeof source & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    sourceAny.abilityGroups = [{ id: 'custom-group', instanceId: 'custom-group:0', skills: ['duplicate', 'helper'], rules: [] }]
    const context: {
      piece: typeof source
      skill: { id: string }
      skillInstance: typeof source.skills[number]
      skillInstanceId: string
      clusterInstanceId?: string
    } = {
      piece: source,
      skill: { id: 'duplicate' },
      skillInstance: source.skills[0],
      skillInstanceId: 'duplicate-instance',
    }
    const flow = createFlowRuntime(battle, context, 'skill', {})
    const current = flow.clusters.current()

    expect(current.group).toEqual(expect.objectContaining({ ownerPieceId: 'source', instanceId: 'custom-group:0', id: 'custom-group' }))
    expect(flow.clusters.attribution(current.group)).toBe('custom-group')

    sourceAny.abilityGroups.push({ id: 'other-group', instanceId: 'other-group:0', skills: ['duplicate'], rules: [] })
    source.skills[0].abilityGroupIds = ['custom-group:0', 'other-group:0']
    expect(() => flow.clusters.current()).toThrow('多个能力组')

    context.clusterInstanceId = 'other-group:0'
    expect(flow.clusters.current()).toEqual({ group: expect.objectContaining({ ownerPieceId: 'source', instanceId: 'other-group:0', id: 'other-group' }) })
    expect(flow.clusters.attribution(flow.clusters.current().group)).toBe('other-group')
  })

  it('rejects a Cluster reference whose member or owner no longer matches', () => {
    const { battle, source } = fixture()
    source.skills = [{ skillId: 'duplicate', instanceId: 'duplicate-instance', abilityGroupIds: ['custom-group:0'] }]
    const sourceAny = source as typeof source & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    sourceAny.abilityGroups = [{ id: 'custom-group', instanceId: 'custom-group:0', skills: ['other-skill'], rules: [] }]
    const context = { piece: source, skill: { id: 'duplicate' }, skillInstance: source.skills[0], skillInstanceId: 'duplicate-instance' }
    const flow = createFlowRuntime(battle, context, 'skill', {})

    expect(() => flow.clusters.current()).toThrow('成员')
  })

  it('normalizes framework root IDs without using a member array position', () => {
    const { battle, source } = fixture()
    source.skills = [{ skillId: 'fireball', instanceId: 'fireball-instance', abilityGroupIds: ['skills:fireball:0'] }]
    const sourceAny = source as typeof source & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    sourceAny.abilityGroups = [{ id: 'skills:fireball', instanceId: 'skills:fireball:0', skills: ['helper', 'fireball'], rules: [] }]
    const flow = createFlowRuntime(battle, {
      piece: source,
      skill: { id: 'fireball' },
      skillInstance: source.skills[0],
      skillInstanceId: 'fireball-instance',
    }, 'skill', {})

    const current = flow.clusters.current()
    expect(flow.clusters.attribution(current.group)).toBe('fireball')
  })

  it('only falls back to a unique skill ID when no exact skill instance is supplied', () => {
    const { battle, source } = fixture()
    source.skills = [
      { skillId: 'duplicate', instanceId: 'duplicate-a', abilityGroupIds: ['group-a:0'] },
      { skillId: 'duplicate', instanceId: 'duplicate-b', abilityGroupIds: ['group-b:0'] },
    ]
    const sourceAny = source as typeof source & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    sourceAny.abilityGroups = [
      { id: 'group-a', instanceId: 'group-a:0', skills: ['duplicate'], rules: [] },
      { id: 'group-b', instanceId: 'group-b:0', skills: ['duplicate'], rules: [] },
    ]
    expect(() => createFlowRuntime(battle, { piece: source, skillId: 'duplicate' }, 'skill', {}).clusters.current())
      .toThrow('不唯一')

    const exactContext = { piece: source, skillId: 'duplicate', skillInstance: source.skills[1], skillInstanceId: 'duplicate-b' }
    const flow = createFlowRuntime(battle, exactContext, 'skill', {})
    expect(flow.clusters.attribution(flow.clusters.current().group)).toBe('group-b')

    const replacement = makePiece({ instanceId: 'source' })
    replacement.skills = [{ skillId: 'duplicate', instanceId: 'duplicate-b', abilityGroupIds: ['group-b:0'] }]
    ;(replacement as typeof replacement & { abilityGroups: typeof sourceAny.abilityGroups }).abilityGroups = sourceAny.abilityGroups
    battle.pieces[0] = replacement as unknown as BattleState['pieces'][number]
    expect(() => flow.clusters.current()).toThrow('不存在')
  })

  it('resolves a current Rule Cluster from the exact rule instance', () => {
    const { battle, source } = fixture()
    const rule: TriggerRule & { abilityGroupIds: string[] } = { id: 'rule-fireball', instanceId: 'rule-fireball-instance', abilityGroupIds: ['rules:fireball-rule:0'],
      name: '火球规则', description: '', trigger: { type: 'afterDamageDealt' }, effect: () => ({ success: true }) }
    source.rules = [rule]
    const sourceAny = source as typeof source & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    sourceAny.abilityGroups = [{ id: 'rules:fireball-rule', instanceId: 'rules:fireball-rule:0', skills: ['other-skill'], rules: ['other-rule', 'rule-fireball'] }]
    const context = {
      rulePiece: source,
      rule: source.rules[0],
      ruleId: 'rule-fireball',
      ruleInstance: source.rules[0],
      ruleInstanceId: 'rule-fireball-instance',
    }
    const flow = createFlowRuntime(battle, context, 'rule', {})
    const current = flow.clusters.current()

    expect(flow.clusters.attribution(current.group)).toBe('fireball-rule')
  })

  it('prefers the current Rule over an upstream event skillId on rule-like surfaces', () => {
    const { battle, source } = fixture()
    const defender = makePiece({ instanceId: 'defender' })
    const rule: TriggerRule & { abilityGroupIds: string[] } = { id: 'retaliate', instanceId: 'retaliate-instance', abilityGroupIds: ['rules:retaliate:0'],
      name: '反击规则', description: '', trigger: { type: 'afterDamageTaken' }, effect: () => ({ success: true }) }
    defender.rules = [rule]
    const sourceAny = source as typeof source & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    const defenderAny = defender as typeof defender & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    sourceAny.abilityGroups = [{ id: 'skills:fireball', instanceId: 'skills:fireball:0', skills: ['fireball'], rules: [] }]
    defenderAny.abilityGroups = [{ id: 'rules:retaliate', instanceId: 'rules:retaliate:0', skills: [], rules: ['retaliate'] }]
    battle.pieces.push(defender as unknown as BattleState['pieces'][number])

    const context = {
      piece: source,
      sourcePiece: source,
      rulePiece: defender,
      skillId: 'fireball',
      ruleId: 'retaliate',
      ruleInstance: defender.rules[0],
      ruleInstanceId: 'retaliate-instance',
    }
    const ruleFlow = createFlowRuntime(battle, context, 'rule', {})
    expect(ruleFlow.clusters.attribution(ruleFlow.clusters.current().group)).toBe('retaliate')

    const triggerFlow = createFlowRuntime(battle, context, 'triggerSkill', {})
    expect(triggerFlow.clusters.attribution(triggerFlow.clusters.current().group)).toBe('retaliate')
  })

  it('keeps a current group reference stable when passed through JSON into a new flow', () => {
    const { battle, source } = fixture()
    source.skills = [{ skillId: 'duplicate', instanceId: 'duplicate-instance', abilityGroupIds: ['custom-group:0'] }]
    const sourceAny = source as typeof source & { abilityGroups: Array<{ id: string; instanceId: string; skills: string[]; rules: string[] }> }
    sourceAny.abilityGroups = [{ id: 'custom-group', instanceId: 'custom-group:0', skills: ['duplicate'], rules: [] }]
    const context = { piece: source, skill: { id: 'duplicate' }, skillInstance: source.skills[0], skillInstanceId: 'duplicate-instance' }
    const flow = createFlowRuntime(battle, context, 'skill', {})
    const current = flow.clusters.current()
    const persisted = JSON.parse(JSON.stringify(current.group))
    const local = flow.execution.declare('record', [], current.group)
    const localPersisted = flow.execution.read(local.handle, 'record', []).value
    flow.extension.declareValue('player', 'player-red', 'content', 'saved-cluster', 'record', [], current.group)
    const resumed = createFlowRuntime(battle, {}, 'pending', {})

    expect(resumed.clusters.attribution(persisted)).toBe('custom-group')
    expect(resumed.clusters.attribution(localPersisted as object)).toBe('custom-group')
    expect(resumed.clusters.attribution(resumed.extension.readValue('player', 'player-red', 'content', 'saved-cluster', '', 'record', []) as object)).toBe('custom-group')

    sourceAny.abilityGroups = [{ id: 'custom-group', instanceId: 'replacement:0', skills: ['duplicate'], rules: [] }]
    expect(() => resumed.clusters.attribution(persisted)).toThrow('失效')
  })
})
