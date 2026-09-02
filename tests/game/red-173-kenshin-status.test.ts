/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored rules expose dynamic runtime fields. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

describe('RED-173 Kenshin multiplier status', () => {
  it('admits one shared additive rule and removes the two legacy additive consumers', () => {
    expect(rule('rule-damage-buff')).toMatchObject({ id: 'rule-damage-buff' })

    const ruleManifest = JSON.parse(readFileSync(resolve('data/rules/manifest.json'), 'utf8')) as string[]
    const skillManifest = JSON.parse(readFileSync(resolve('data/skills/manifest.json'), 'utf8')) as string[]
    expect(ruleManifest).toContain('rule-damage-buff')
    expect(ruleManifest).not.toEqual(expect.arrayContaining(['rule-holy-charge', 'rule-divine-blessing']))
    expect(skillManifest).not.toEqual(expect.arrayContaining(['holy-charge-damage', 'divine-blessing-damage']))
    for (const path of [
      'data/rules/rule-holy-charge.json',
      'data/rules/rule-divine-blessing.json',
      'data/skills/holy-charge-damage.json',
      'data/skills/divine-blessing-damage.json',
    ]) expect(existsSync(resolve(path)), path).toBe(false)
  })

  it('produces an independent multiplier status and leaves additive damage-buff untouched', () => {
    const kenshin = makePiece({ instanceId: 'kenshin', ownerPlayerId: 'player-red' }) as any
    kenshin.name = '绯村剑心'
    kenshin.rules = [rule('rule-kenshin-tenken'), rule('rule-kenshin-tenken-boost')]
    const state = makeState({ pieces: [kenshin] }) as any
    const triggers = new TriggerSystem()

    expect(triggers.checkTriggers(state, {
      type: 'afterMove', playerId: 'player-red', sourcePiece: kenshin,
    }).success).toBe(true)
    expect(kenshin.statusTags).toContainEqual(expect.objectContaining({
      id: 'tenken-charge-kenshin', type: 'damage-multiplier', name: '飞天御剑流',
    }))

    kenshin.statusTags.push({
      id: 'damage-buff', type: 'damage-buff', name: '强化', currentUses: 1, intensity: 2,
    })
    const damageContext: any = {
      type: 'beforeDamageDealt', playerId: 'player-red', sourcePiece: kenshin, damage: 4,
    }
    expect(triggers.checkTriggers(state, damageContext).success).toBe(true)
    expect(damageContext.damage).toBe(6)
    expect(kenshin.statusTags).not.toContainEqual(expect.objectContaining({ id: 'tenken-charge-kenshin' }))
    expect(kenshin.statusTags).toContainEqual(expect.objectContaining({ id: 'damage-buff', intensity: 2 }))
  })
})
