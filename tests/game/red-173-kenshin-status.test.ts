/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored rules expose dynamic runtime fields. */
import { beforeEach, describe, expect, it } from 'vitest'

import { loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem, TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function rule(id: string) {
  const loaded = loadRuleById(id, true)
  if (!loaded) throw new Error(`Rule ${id} did not load`)
  return loaded
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('RED-173 Kenshin reusable damage-buff status', () => {
  it('produces the shared status and consumes only the Tenken source id', () => {
    const kenshin = makePiece({ instanceId: 'kenshin', ownerPlayerId: 'player-red' }) as any
    kenshin.name = '绯村剑心'
    kenshin.rules = [rule('rule-kenshin-tenken'), rule('rule-kenshin-tenken-boost')]
    const state = makeState({ pieces: [kenshin] }) as any
    const triggers = new TriggerSystem()

    expect(triggers.checkTriggers(state, {
      type: 'afterMove', playerId: 'player-red', sourcePiece: kenshin,
    }).success).toBe(true)
    expect(kenshin.statusTags).toContainEqual(expect.objectContaining({
      id: 'tenken-charge-kenshin', type: 'damage-buff', name: '强化',
    }))

    kenshin.statusTags.push({
      id: 'holy-charge-buff', type: 'damage-buff', name: '强化', currentUses: 1, intensity: 2,
    })
    const damageContext: any = {
      type: 'beforeDamageDealt', playerId: 'player-red', sourcePiece: kenshin, damage: 4,
    }
    expect(triggers.checkTriggers(state, damageContext).success).toBe(true)
    expect(damageContext.damage).toBe(6)
    expect(kenshin.statusTags).not.toContainEqual(expect.objectContaining({ id: 'tenken-charge-kenshin' }))
    expect(kenshin.statusTags).toContainEqual(expect.objectContaining({ id: 'holy-charge-buff' }))
  })
})
