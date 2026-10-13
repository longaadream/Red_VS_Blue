import { describe, expect, it } from 'vitest'
import { areMatchAllies, getMatchFactionKey, matchCapacity, nextTeamSlot, orderedMatchPlayers, TEAM_TURN_ORDER } from '@/lib/game/match-teams'
import type { Room } from '@/lib/game/room-model'

describe('2v2 team contract', () => {
  it('orders seats blue red red blue regardless of arrival order and reuses a vacant slot', () => {
    const players = [3, 1, 0, 2].map(teamSlot => ({ id: `p${teamSlot}`, name: `P${teamSlot}`, teamSlot, seat: TEAM_TURN_ORDER[teamSlot] }))
    expect(orderedMatchPlayers({ mode: '2v2', players } as Room).map(p => p.id)).toEqual(['p0', 'p1', 'p2', 'p3'])
    expect(nextTeamSlot(players.filter(p => p.teamSlot !== 1))).toBe(1)
    expect(() => orderedMatchPlayers({ mode: '2v2', players: players.slice(1) } as Room)).toThrow()
  })
  it('separates friendship from ownership and retains old matches', () => {
    const state = { players: [{ playerId: 'a', teamId: 'blue' as const }, { playerId: 'b', teamId: 'blue' as const }, { playerId: 'c', teamId: 'red' as const }] }
    expect(areMatchAllies(state, 'a', 'b')).toBe(true)
    expect(areMatchAllies(state, 'a', 'c')).toBe(false)
    expect(areMatchAllies({ players: [{ playerId: 'a' }, { playerId: 'b' }] }, 'a', 'b')).toBe(false)
    expect(matchCapacity('2v2')).toBe(4)
    expect(matchCapacity(undefined)).toBe(2)
    expect(() => matchCapacity('3v3')).toThrow()
  })
  it('derives namespace-safe faction keys from teams, then normalized ownership', () => {
    const teams = { players: [
      { playerId: 'RedOwner', teamId: 'red' as const },
      { playerId: 'red-partner', teamId: 'red' as const },
      { playerId: 'blue-owner', teamId: 'blue' as const },
    ] }
    expect(getMatchFactionKey(teams, 'RedOwner')).toBe('team:red')
    expect(getMatchFactionKey(teams, 'red-partner')).toBe('team:red')
    expect(getMatchFactionKey(teams, 'blue-owner')).toBe('team:blue')
    expect(getMatchFactionKey({ players: [{ playerId: 'Alice' }] }, 'ALICE')).toBe('owner:alice')
    expect(getMatchFactionKey({ players: [{ playerId: 'Alice' }] }, 'unknown')).toBe('owner:unknown')
  })
})
