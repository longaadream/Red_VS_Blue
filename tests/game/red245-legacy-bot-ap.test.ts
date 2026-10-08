/* eslint-disable @typescript-eslint/no-explicit-any -- legacy generator actions and minimal fixtures are intentionally serialized. */
import { describe, expect, it } from 'vitest'

import { generateBotActions } from '@/lib/game/ai'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { hashStable } from '@/lib/game/battle-trace'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function oneApRosterState(): BattleState {
  const allies = [0, 1, 2].map(index => makePiece({
    instanceId: `red-${index}`,
    ownerPlayerId: 'player-red',
    x: 0,
    y: index,
    moveRange: 1,
  }))
  const enemy = makePiece({
    instanceId: 'blue-anchor',
    ownerPlayerId: 'player-blue',
    x: 7,
    y: 1,
  })
  const state = makeState({ pieces: [...allies, enemy], width: 8, height: 3 }) as any
  state.players[0].actionPoints = 1
  state.players[0].maxActionPoints = 1
  return state
}

function replay(actions: any[], initialState: BattleState) {
  let state = structuredClone(initialState)
  const rejected: unknown[] = []
  for (const action of actions) {
    const result = aiEnvironmentV1.simulate(state, action, { rootSeed: 8675309 })
    if (!result.accepted) {
      rejected.push(result.error)
      continue
    }
    state = result.state
  }
  return { state, rejected }
}

describe('RED-245 retained legacy bot AP budget', () => {
  it('uses the local remaining AP for later movement queries and finishes the replay', () => {
    const state = oneApRosterState()
    const before = hashStable(state)
    const actions = generateBotActions(state, 'player-red')
    const moves = actions.filter(action => action.type === 'move')

    expect(moves).toHaveLength(1)
    expect(actions.at(-1)).toEqual({ type: 'endTurn', playerId: 'player-red' })

    const replayed = replay(actions, state)
    expect(replayed.rejected).toEqual([])
    expect(replayed.state.turn.phase).toBe('end')
    expect(hashStable(state)).toBe(before)
  })

  it('keeps an explicitly free first move available at zero AP', () => {
    const freeMover = makePiece({
      instanceId: 'free-mover',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
      moveRange: 1,
      statusTags: [{
        id: 'deployment-first-move-free',
        type: 'deployment-first-move-free',
        grantedTurnNumber: 1,
        currentUses: 1,
      }],
    })
    const ordinary = makePiece({
      instanceId: 'ordinary-mover',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 2,
      moveRange: 1,
    })
    const enemy = makePiece({ instanceId: 'blue-anchor', ownerPlayerId: 'player-blue', x: 7, y: 1 })
    const state = makeState({ pieces: [freeMover, ordinary, enemy], width: 8, height: 3 }) as any
    state.players[0].actionPoints = 0
    state.players[0].maxActionPoints = 0

    const actions = generateBotActions(state, 'player-red')
    expect(actions.some(action => action.type === 'move' && action.pieceId === 'free-mover')).toBe(true)
    expect(actions.some(action => action.type === 'move' && action.pieceId === 'ordinary-mover')).toBe(false)

    const replayed = replay(actions, state)
    expect(replayed.rejected).toEqual([])
    expect(replayed.state.players[0].actionPoints).toBe(0)
  })
})
