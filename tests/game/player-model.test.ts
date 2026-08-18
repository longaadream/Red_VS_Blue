import { describe, expect, it } from 'vitest'

import {
  alignmentToPieceFaction,
  assignNextSeat,
  getPlayerSeat,
  normalizePlayerAlignment,
} from '@/lib/game/room-store'
import { areAllies, areEnemies, isMatchPlayerId, isPlayerSeat, normalizeContentAlignment } from '@/lib/game/match-identity'

describe('player seat and alignment model', () => {
  it('assigns opposite red/blue seats while keeping light/dark independent', () => {
    const first = { id: 'alice', seat: 'red' as const, faction: 'red' as const, alignment: 'light' as const }
    const secondSeat = assignNextSeat([first], 'bob')

    expect(secondSeat).toBe('blue')
    expect(first.alignment).toBe('light')
  })

  it('allows same-alignment mirrors', () => {
    const players = [
      { id: 'alice', seat: 'red' as const, faction: 'red' as const, alignment: 'dark' as const },
      { id: 'bob', seat: 'blue' as const, faction: 'blue' as const, alignment: 'dark' as const },
    ]

    expect(players.map(getPlayerSeat)).toEqual(['red', 'blue'])
    expect(players.map(p => p.alignment)).toEqual(['dark', 'dark'])
  })

  it('normalizes legacy good/evil requests into light/dark alignment', () => {
    expect(normalizePlayerAlignment('good')).toBe('light')
    expect(normalizePlayerAlignment('evil')).toBe('dark')
    expect(normalizePlayerAlignment('light')).toBe('light')
    expect(normalizePlayerAlignment('dark')).toBe('dark')
  })

  it('maps player alignment to existing piece-template factions', () => {
    expect(alignmentToPieceFaction('light')).toBe('good')
    expect(alignmentToPieceFaction('dark')).toBe('evil')
  })

  it('uses ownerPlayerId rather than seat or content alignment for ally/enemy', () => {
    expect(areAllies('alice', 'alice')).toBe(true)
    expect(areEnemies('alice', 'bob')).toBe(true)
    expect(areEnemies('alice', 'alice')).toBe(false)
  })

  it('accepts only valid seats and content-alignment compatibility values', () => {
    expect(isPlayerSeat('red')).toBe(true)
    expect(isPlayerSeat('light')).toBe(false)
    expect(normalizeContentAlignment('good')).toBe('light')
    expect(normalizeContentAlignment('blue')).toBeUndefined()
  })

  it('rejects a requested first player who is not in the match', () => {
    expect(isMatchPlayerId(['alice', 'bob'], 'bob')).toBe(true)
    expect(isMatchPlayerId(['alice', 'bob'], 'not-in-room')).toBe(false)
  })
})
