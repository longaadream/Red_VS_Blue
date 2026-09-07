import { describe, expect, it } from 'vitest'
import { makePiece, makePlayer, makeState } from '../helpers/minimal-state'
import { finalizeBattleTerminal } from '@/lib/game/terminal'
import { applyBattleAction } from '@/lib/game/turn'
import { assertSelectableMapId, getSelectableMapCatalog } from '@/lib/game/map-selection'
import { observeAiState } from '@/lib/game/ai-semantics'

function teamState() {
  const state = makeState({ currentPlayerId: 'blue1' })
  state.players = ['blue1', 'red1', 'red2', 'blue2'].map((id, index) => ({
    ...makePlayer(id, index === 0 || index === 3 ? 'blue' : 'red'),
    teamId: index === 0 || index === 3 ? 'blue' as const : 'red' as const,
  })) as any
  state.pieces = state.players.map((p, i) => ({ ...makePiece({ instanceId: p.playerId, ownerPlayerId: p.playerId, x: i }), isCore: true })) as any
  return state
}
describe('2v2 team rules', () => {
  it('keeps a team alive after either individual loses every core, then settles for both winning players', () => {
    const state = teamState()
    state.pieces[0].currentHp = 0
    expect(finalizeBattleTerminal(state, { type: 'beginPhase' })).toBeNull()
    state.pieces[3].currentHp = 0
    expect(finalizeBattleTerminal(state, { type: 'beginPhase' })).toMatchObject({ reason: 'core-eliminated', winnerTeamId: 'red', winnerPlayerIds: ['red1', 'red2'], loserPlayerIds: ['blue1', 'blue2'] })
  })
  it('draws on simultaneous team elimination and counts four turns as one full round', () => {
    const state = teamState()
    state.pieces.forEach(p => { p.currentHp = 0 })
    expect(finalizeBattleTerminal(state, { type: 'beginPhase' })).toMatchObject({ winnerTeamId: null, reason: 'mutual-core-elimination' })
    const limit = teamState()
    limit.turn.phase = 'end'; limit.turn.turnNumber = 159
    expect(finalizeBattleTerminal(limit, { type: 'endTurn', playerId: 'blue2' })).toBeNull()
    limit.turn.turnNumber = 160
    expect(finalizeBattleTerminal(limit, { type: 'endTurn', playerId: 'blue2' })).toMatchObject({ reason: 'round-limit', settledAt: { completedRound: 40 } })
  })
  it('rotates blue red red blue, rejects teammate piece control, and observes teammates as allies', () => {
    let state = teamState()
    expect(() => applyBattleAction(state, { type: 'move', playerId: 'blue1', pieceId: 'blue2', toX: 4, toY: 0 } as any)).toThrow()
    for (const next of ['red1', 'red2', 'blue2', 'blue1']) {
      state = applyBattleAction(state, { type: 'endTurn', playerId: state.turn.currentPlayerId })
      state = applyBattleAction(state, { type: 'beginPhase' })
      expect(state.turn.currentPlayerId).toBe(next)
      state = applyBattleAction(state, { type: 'beginPhase' })
    }
    const observation = observeAiState(state, 'blue1', { rulesHash: '', contentHash: '' })
    expect(observation.allies.map(p => p.id)).toEqual(['blue1', 'blue2'])
    expect(observation.enemies.map(p => p.id)).toEqual(['red1', 'red2'])
  })
  it('offers only the dedicated 24×20 connected symmetric map in 2v2', () => {
    expect(() => assertSelectableMapId('open-expanse', '2v2')).toThrow()
    expect(() => assertSelectableMapId('twin-fronts')).toThrow()
    const [map] = getSelectableMapCatalog('2v2')
    expect([map.width, map.height]).toEqual([24, 20])
    const tiles = new Map(map.tiles.map(tile => [`${tile.x},${tile.y}`, tile]))
    for (const tile of map.tiles) {
      expect(tiles.get(`${23 - tile.x},${tile.y}`)?.props).toEqual(tile.props)
      expect(tiles.get(`${tile.x},${19 - tile.y}`)?.props).toEqual(tile.props)
    }
    const floors = map.tiles.filter(t => t.props.walkable)
    const seen = new Set<string>(), queue = [floors[0]]
    while (queue.length) {
      const tile = queue.pop()!, key = `${tile.x},${tile.y}`
      if (seen.has(key)) continue
      seen.add(key)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = tiles.get(`${tile.x + dx},${tile.y + dy}`)
        if (next?.props.walkable && !seen.has(`${next.x},${next.y}`)) queue.push(next)
      }
    }
    expect(seen.size).toBe(floors.length)
    expect(floors.length).toBeGreaterThan(320)
  })
})
