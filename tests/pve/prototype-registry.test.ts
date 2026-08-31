import { describe, expect, it } from 'vitest'

import { createPrototypePveRegistryV1 } from '@/lib/pve/prototype-registry'

describe('RED-117 sealed Prototype PVE registry', () => {
  it('resolves exactly the active Profile registered 8x8 Demo rosters', () => {
    const registry = createPrototypePveRegistryV1()
    const player = registry.requireRoster('prototype-player-roster')
    const enemy = registry.requireRoster('prototype-enemy-roster')

    expect(player.pieceIds).toHaveLength(8)
    expect(enemy.pieceIds).toHaveLength(8)
    expect(new Set([...player.pieceIds, ...enemy.pieceIds]).size).toBe(16)
    expect(registry.requireRewardTable('prototype-card-reward-table').subjectIds)
      .toEqual(['holy-heal', 'holy-smite', 'lucky-coin'])
  })

  it('fails closed on every ID outside the sealed Prototype surface', () => {
    const registry = createPrototypePveRegistryV1()

    expect(() => registry.requireRoster('unregistered-roster'))
      .toThrow('Missing registered roster ID')
    expect(() => registry.requireMap('unregistered-map'))
      .toThrow('Missing registered map ID')
    expect(() => registry.requireEffect('unregistered-effect'))
      .toThrow('Missing registered effect ID')
  })
})
