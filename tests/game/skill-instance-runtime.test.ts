import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import type { BattleState } from '../../lib/game/turn'
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
})
