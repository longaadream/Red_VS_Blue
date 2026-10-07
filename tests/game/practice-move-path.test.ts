import { afterEach, describe, expect, it } from 'vitest'
import { PracticeSession } from '@/lib/practice/session'
import { HUMAN_ID, AI_ID } from '@/lib/practice/setup'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { dropChargeCrystal } from '@/lib/game/charge-crystals'
import { makePiece, makeState } from '../helpers/minimal-state'

afterEach(() => globalTriggerSystem.clearRules())

describe('practice authority selected move route', () => {
  it('preserves a deliberate 180-degree detour rather than replacing it with the shorter endpoint route', () => {
    const state = makeState({ currentPlayerId: HUMAN_ID, width: 4, height: 4,
      pieces: [makePiece({ instanceId: 'mover', ownerPlayerId: HUMAN_ID, x: 1, y: 1, moveRange: 4 })] })
    state.players[0].playerId = HUMAN_ID
    state.players[1].playerId = AI_ID
    dropChargeCrystal(state, { id: 'detour', sourcePieceId: 'dead', x: 2, y: 1 })
    const path = [{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }]
    const result = new PracticeSession(state, 240).human({ type: 'move', playerId: HUMAN_ID,
      pieceId: 'mover', toX: 1, toY: 2, path }, 0)
    expect(result.state.pieces[0]).toMatchObject({ x: 1, y: 2 })
    expect(result.state.players[0]).toMatchObject({ actionPoints: 1, chargePoints: 1 })
    expect(result.events.find(event => event.kind === 'move')?.presentation?.pathCells).toEqual(path)
    expect(result.action).toMatchObject({ path })
  })

  it('commits and publishes the chosen bend and collects only its traversed cells', () => {
    const state = makeState({ currentPlayerId: HUMAN_ID, width: 4, height: 4,
      pieces: [makePiece({ instanceId: 'mover', ownerPlayerId: HUMAN_ID, x: 0, y: 0, moveRange: 4 })] })
    state.players[0].playerId = HUMAN_ID
    state.players[1].playerId = AI_ID
    dropChargeCrystal(state, { id: 'chosen', sourcePieceId: 'dead', x: 0, y: 1 })
    dropChargeCrystal(state, { id: 'other-route', sourcePieceId: 'dead', x: 1, y: 0 })
    const path = [{ x: 0, y: 1 }, { x: 1, y: 1 }]
    const result = new PracticeSession(state, 240).human({ type: 'move', playerId: HUMAN_ID,
      pieceId: 'mover', toX: 1, toY: 1, path }, 0)
    expect(result.state.pieces[0]).toMatchObject({ x: 1, y: 1 })
    expect(result.state.players[0]).toMatchObject({ actionPoints: 1, chargePoints: 1 })
    expect(result.state.extensions?.tileEffects).toContainEqual(expect.objectContaining({ id: 'other-route' }))
    expect(result.events.find(event => event.kind === 'move')?.presentation?.pathCells).toEqual(path)
    expect(result.action).toMatchObject({ path })
    expect(result.state.actions).toEqual([])
  })
})
