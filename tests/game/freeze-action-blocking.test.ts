/* eslint-disable @typescript-eslint/no-explicit-any -- runtime rule fixtures intentionally exercise dynamic battle shapes */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function requiredRule(id: string) {
  const rule = loadRuleById(id, true)
  if (!rule) throw new Error('Missing RED-77 fixture rule: ' + id)
  return rule
}

function makeFrozenActionState() {
  const frozen = makePiece({
    instanceId: 'frozen-piece',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    statusTags: [{ id: 'freeze-1', type: 'freeze', currentDuration: 1 }],
    rules: [
      requiredRule('rule-freeze-prevent-move'),
      requiredRule('rule-freeze-prevent-skill'),
    ],
  }) as any
  frozen.name = 'Frozen fixture'
  frozen.skills = [
    { skillId: 'red77-basic', currentCooldown: 0, usesRemaining: 1 },
    { skillId: 'red77-charge', currentCooldown: 0, usesRemaining: 1 },
  ]

  const target = makePiece({
    instanceId: 'target-piece',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 0,
    currentHp: 20,
    maxHp: 20,
  }) as any
  const state = makeState({ pieces: [frozen, target], currentPlayerId: 'player-red', phase: 'action' }) as any
  const blockedSkillCode = "function executeSkill(context) { context.battle.extensions.executed = true; context.battle.pieces.find(function(piece) { return piece.instanceId === 'target-piece'; }).currentHp = 1; return { success: true, message: 'executed' }; }"

  state.skillsById['red77-basic'] = {
    id: 'red77-basic', name: 'RED-77 basic fixture', description: '', kind: 'active', type: 'normal',
    cooldownTurns: 2, maxCharges: 0, powerMultiplier: 1, actionPointCost: 1,
    range: 'self', requiresTarget: false, code: blockedSkillCode,
  }
  state.skillsById['red77-charge'] = {
    id: 'red77-charge', name: 'RED-77 charge fixture', description: '', kind: 'active', type: 'ultimate',
    cooldownTurns: 2, maxCharges: 0, powerMultiplier: 1, actionPointCost: 1, chargeCost: 2,
    range: 'self', requiresTarget: false, code: blockedSkillCode,
  }
  state.players[0].actionPoints = 2
  state.players[0].chargePoints = 3
  return state
}

describe('RED-77 freeze authority without an attack event', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => vi.restoreAllMocks())

  it('blocks movement through beforeMove without paying AP or dispatching afterMove', () => {
    const state = makeFrozenActionState()
    const triggerSpy = vi.spyOn(globalTriggerSystem, 'checkTriggers')

    const next = applyBattleAction(state, {
      type: 'move', playerId: 'player-red', pieceId: 'frozen-piece', toX: 0, toY: 1,
    }) as any
    const eventTypes = triggerSpy.mock.calls.map(([, context]) => context.type)

    expect(next.pieces.find((piece: any) => piece.instanceId === 'frozen-piece')).toMatchObject({ x: 0, y: 0 })
    expect(next.players[0].actionPoints).toBe(2)
    expect(next.actions.filter((action: any) => action.type === 'move')).toEqual([])
    expect(next.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'triggerEffect', payload: expect.objectContaining({ message: expect.stringContaining('无法移动') }) }),
    ]))
    expect(eventTypes).toEqual(['beforeMove'])
    expect(eventTypes).not.toContain('beforeAttack')
  })

  it.each([
    { actionType: 'useBasicSkill' as const, skillId: 'red77-basic' },
    { actionType: 'useChargeSkill' as const, skillId: 'red77-charge' },
  ])('blocks $actionType through beforeSkillUse without costs, damage, cooldown, uses, or afterSkillUsed', ({ actionType, skillId }) => {
    const state = makeFrozenActionState()
    const triggerSpy = vi.spyOn(globalTriggerSystem, 'checkTriggers')

    const next = applyBattleAction(state, {
      type: actionType, playerId: 'player-red', pieceId: 'frozen-piece', skillId,
    }) as any
    const eventTypes = triggerSpy.mock.calls.map(([, context]) => context.type)
    const frozenSkill = next.pieces
      .find((piece: any) => piece.instanceId === 'frozen-piece')
      .skills.find((skill: any) => skill.skillId === skillId)

    expect(next.players[0]).toMatchObject({ actionPoints: 2, chargePoints: 3 })
    expect(frozenSkill).toMatchObject({ currentCooldown: 0, usesRemaining: 1 })
    expect(next.pieces.find((piece: any) => piece.instanceId === 'target-piece').currentHp).toBe(20)
    expect(next.extensions.executed).toBeUndefined()
    expect(next.actions.filter((action: any) => action.type === actionType)).toEqual([])
    expect(next.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'triggerEffect', payload: expect.objectContaining({ message: expect.stringContaining('无法使用技能') }) }),
    ]))
    expect(eventTypes).toEqual(['beforeSkillUse'])
    expect(eventTypes).not.toContain('beforeAttack')
    expect(eventTypes).not.toContain('afterSkillUsed')
  })
})
