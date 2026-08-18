/* eslint-disable @typescript-eslint/no-explicit-any -- production data definitions are dynamically loaded */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import {
  dealDamage,
  executeSkillFunction,
  healDamage,
  loadAllSkillsById,
  loadRuleById,
} from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const PASSIVE_ID = 'shishio-combustion-passive'
const ROOT_SEED = 7601

function loadPassive() {
  const passive = loadAllSkillsById()[PASSIVE_ID]
  if (!passive) throw new Error(`${PASSIVE_ID} did not load`)
  return passive
}

function loadShishioRules() {
  return [
    'rule-shishio-cooldown-once',
    'rule-shishio-combustion',
    'rule-shishio-no-heal',
  ].map(ruleId => {
    const rule = loadRuleById(ruleId, true)
    if (!rule) throw new Error(`${ruleId} did not load`)
    return rule
  })
}

describe('RED-76 Shishio combustion passive', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('loads a callable passive entry that returns failure without mutating state', () => {
    const passive = loadPassive()
    const shishio = makePiece({
      instanceId: 'shishio',
      templateId: 'red-shishio',
      ownerPlayerId: 'player-red',
      currentHp: 7,
      maxHp: 7,
    })
    const state = makeState({ pieces: [shishio] }) as any
    const beforeHash = hashBattleState(state)

    const result = withRuleRuntime(
      new RuleRuntime({ rootSeed: ROOT_SEED, tick: 1 }),
      () => executeSkillFunction(passive, {
        piece: shishio,
        target: null,
        targetPosition: null,
        battle: state,
        skill: passive,
      } as any, state),
    )

    expect(passive.kind).toBe('passive')
    expect(result).toMatchObject({ success: false, message: '' })
    expect(hashBattleState(state)).toBe(beforeHash)
  })

  it('rejects an attempted active use without changing the fixed-seed authoritative state', () => {
    const passive = loadPassive()
    const shishio = makePiece({
      instanceId: 'shishio',
      templateId: 'red-shishio',
      ownerPlayerId: 'player-red',
      currentHp: 7,
      maxHp: 7,
    }) as any
    shishio.skills = [{ skillId: PASSIVE_ID, currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [shishio], currentPlayerId: 'player-red', phase: 'action' }) as any
    state.skillsById[PASSIVE_ID] = passive
    const beforeJson = JSON.stringify(state)
    const beforeHash = hashBattleState(state)

    expect(() => runBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: shishio.instanceId,
      skillId: PASSIVE_ID,
      clientActionId: 'red-76-active-attempt',
    } as any, { rootSeed: ROOT_SEED })).toThrow(/^技能施放失败 \[seed=7601 /)

    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(hashBattleState(state)).toBe(beforeHash)
  })

  it('applies its approved effects only through the production damage and heal events', () => {
    const shishio = makePiece({
      instanceId: 'shishio',
      templateId: 'red-shishio',
      ownerPlayerId: 'player-red',
      currentHp: 7,
      maxHp: 7,
    }) as any
    shishio.name = '志志雄真实'
    shishio.rules = loadShishioRules()
    const target = makePiece({
      instanceId: 'target',
      ownerPlayerId: 'player-blue',
      currentHp: 20,
      maxHp: 20,
    }) as any
    target.name = '目标'
    target.skills = [{ skillId: 'target-skill', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [shishio, target], turnNumber: 9 }) as any

    withRuleRuntime(new RuleRuntime({ rootSeed: ROOT_SEED, tick: 1 }), () => {
      const first = dealDamage(shishio, target, 4, 'true', state, 'red-76-direct-damage')
      expect(first).toMatchObject({ success: true, damage: 4 })
      expect(target.skills[0].currentCooldown).toBe(2)
      expect(shishio.currentHp).toBe(7)
      expect(shishio.statusTags.find((tag: any) => tag.type === 'shishio-dmg-counter')?.intensity).toBe(4)

      target.skills[0].currentCooldown = 0
      const damageLogStart = state.actions.filter((action: any) => action.type === 'damage').length
      const threshold = dealDamage(shishio, target, 1, 'true', state, 'red-76-direct-damage')
      expect(threshold).toMatchObject({ success: true, damage: 1 })
      expect(target.skills[0].currentCooldown).toBe(0)
      expect(shishio.currentHp).toBe(6)
      expect(shishio.statusTags.find((tag: any) => tag.type === 'shishio-dmg-counter')?.intensity).toBe(0)
      const thresholdLogs = state.actions
        .filter((action: any) => action.type === 'damage')
        .slice(damageLogStart)
        .map((action: any) => action.payload)
      expect(thresholdLogs.map((payload: any) => payload.skillId)).toEqual([
        'red-76-direct-damage',
        'combustion-self',
      ])
      expect(thresholdLogs[0].batchId).toBe(threshold.batchId)
      expect(thresholdLogs[1].parentBatchId).toBe(thresholdLogs[0].batchId)
      expect(thresholdLogs[1].chainId).toBe(thresholdLogs[0].chainId)

      const blockedHeal = healDamage(target, shishio, 3, state, 'red-76-heal-attempt')
      expect(blockedHeal).toMatchObject({ success: false, heal: 0, targetHp: 6 })
      expect(shishio.currentHp).toBe(6)
    })
  })
})
