import { describe, expect, it } from 'vitest'

import { hashBattleState, replayBattle } from '@/lib/game/battle-runner'
import { dealDamage } from '@/lib/game/skills'
import { finalizeBattleTerminal } from '@/lib/game/terminal'
import {
  BattleRuleError,
  applyBattleAction,
  safeCloneBattleState,
  type BattleAction,
  type BattleState,
} from '@/lib/game/turn'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'

const harmlessAction = (playerId = 'player-red'): BattleAction => ({
  type: 'grantChargePoints',
  playerId,
  amount: 0,
})

type TestPiece = ReturnType<typeof makePiece> & { isCore: boolean }

function core(instanceId: string, ownerPlayerId: string, x: number): TestPiece {
  return { ...makePiece({ instanceId, ownerPlayerId, x, currentHp: 5, maxHp: 5 }), isCore: true }
}

function trackedState(phase: 'start' | 'action' | 'end' = 'action', turnNumber = 1) {
  return makeState({
    pieces: [core('core-red', 'player-red', 0), core('core-blue', 'player-blue', 1)],
    currentPlayerId: turnNumber % 2 === 0 ? 'player-blue' : 'player-red',
    phase,
    turnNumber,
  })
}

function eliminate(state: BattleState, instanceId: string) {
  const index = state.pieces.findIndex(piece => piece.instanceId === instanceId)
  const [piece] = state.pieces.splice(index, 1)
  if (!piece) throw new Error('Missing core ' + instanceId)
  piece.currentHp = 0
  state.graveyard.push(piece)
}

describe('authoritative battle terminal settlement', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['light', 'dark'],
  ])('uses ownerPlayerId for %s/%s alignments', (redAlignment, blueAlignment) => {
    const state = trackedState()
    state.extensions = {
      ...state.extensions,
      playerAlignments: { 'player-red': redAlignment, 'player-blue': blueAlignment },
    }
    eliminate(state, 'core-blue')

    expect(applyBattleAction(state, harmlessAction()).terminalResult).toMatchObject({
      status: 'finished',
      winnerPlayerId: 'player-red',
      loserPlayerId: 'player-blue',
      reason: 'core-eliminated',
    })
  })

  it('draws only after a complete simultaneous core-death batch', () => {
    const state = trackedState()
    const red = state.pieces.find(piece => piece.instanceId === 'core-red')!
    const blue = state.pieces.find(piece => piece.instanceId === 'core-blue')!

    dealDamage(red, [red, blue], 5, 'true', state, 'mutual-core')

    expect(state.terminalResult).toBeUndefined()
    expect(state.pieces).toEqual([])
    expect(finalizeBattleTerminal(state, harmlessAction(), { actionIndex: 3 })).toMatchObject({
      winnerPlayerId: null,
      loserPlayerId: null,
      reason: 'mutual-core-elimination',
      settledAt: { actionIndex: 3 },
    })
  })

  it('waits for pending revival settlement and preserves revived core identity', () => {
    const state = trackedState()
    eliminate(state, 'core-blue')
    state.pendingOptionSelection = { playerId: 'player-blue', title: 'Revive', options: ['yes'] }

    expect(finalizeBattleTerminal(state, harmlessAction(), { actionIndex: 4 })).toBeNull()

    state.pendingOptionSelection = undefined
    const revived = state.graveyard.pop()
    if (!revived) throw new Error('Missing revived core')
    Object.assign(revived, { currentHp: 3, x: 2, y: 0, isCore: true })
    state.pieces.push(revived)
    expect(finalizeBattleTerminal(state, harmlessAction(), { actionIndex: 5 })).toBeNull()
  })

  it('does not count a living summon as an eliminated core', () => {
    const state = trackedState()
    eliminate(state, 'core-blue')
    state.pieces.push({
      ...makePiece({ instanceId: 'summon', ownerPlayerId: 'player-blue', x: 2 }),
      isCore: false,
    } as unknown as BattleState['pieces'][number])

    expect(applyBattleAction(state, harmlessAction()).terminalResult).toMatchObject({
      winnerPlayerId: 'player-red',
      loserPlayerId: 'player-blue',
    })
  })

  it('does not infer core identity for legacy states without markers', () => {
    const state = makeState({ pieces: [makePiece({ ownerPlayerId: 'player-red' })] })
    expect(finalizeBattleTerminal(state, harmlessAction(), { actionIndex: 0 })).toBeNull()
  })

  it.each([
    ['voluntary', 'surrender'],
    ['timeout', 'timeout-surrender'],
  ] as const)('settles %s surrender immediately without damage', (reason, expectedReason) => {
    const state = trackedState()
    state.pendingOptionSelection = { playerId: 'player-blue', title: 'Pending', options: ['continue'] }
    const hp = state.pieces.map(piece => piece.currentHp)

    const next = applyBattleAction(state, { type: 'surrender', playerId: 'player-red', reason })

    expect(next.pieces.map(piece => piece.currentHp)).toEqual(hp)
    expect(next.pendingOptionSelection).toBeUndefined()
    expect(next.terminalResult).toMatchObject({
      winnerPlayerId: 'player-blue',
      loserPlayerId: 'player-red',
      reason: expectedReason,
    })
  })

  it('draws after 40 complete rounds, with core victory taking priority', () => {
    expect(applyBattleAction(trackedState('action', 79), {
      type: 'endTurn',
      playerId: 'player-red',
    }).terminalResult).toBeUndefined()

    expect(applyBattleAction(trackedState('action', 80), {
      type: 'endTurn',
      playerId: 'player-blue',
    }).terminalResult).toMatchObject({
      reason: 'round-limit',
      settledAt: { completedRound: 40, turnNumber: 80, phase: 'end' },
    })

    const winningState = trackedState('end', 80)
    eliminate(winningState, 'core-blue')
    expect(finalizeBattleTerminal(winningState, harmlessAction(), { actionIndex: 40 })?.reason)
      .toBe('core-eliminated')
  })

  it('commits one terminal event and rejects later commands without changing the hash', () => {
    const state = trackedState()
    eliminate(state, 'core-blue')
    const terminalState = applyBattleAction(state, harmlessAction())
    const beforeHash = hashBattleState(terminalState)

    expect(terminalState.actions?.filter(entry => entry.type === 'terminalResult')).toHaveLength(1)
    expect(() => applyBattleAction(terminalState, harmlessAction())).toThrowError(
      expect.objectContaining<Partial<BattleRuleError>>({ code: 'BATTLE_ALREADY_TERMINAL' }),
    )
    expect(hashBattleState(terminalState)).toBe(beforeHash)
    expect(terminalState.actions?.filter(entry => entry.type === 'terminalResult')).toHaveLength(1)
  })

  it('replays the round-limit settlement deterministically with a fixed seed', () => {
    const initial = trackedState('action', 80)
    const actions: BattleAction[] = [{ type: 'endTurn', playerId: 'player-blue' }]
    const first = replayBattle({ initialState: safeCloneBattleState(initial), actions, seed: 340034 })
    const second = replayBattle({ initialState: safeCloneBattleState(initial), actions, seed: 340034 })

    expect(first.finalState.terminalResult?.reason).toBe('round-limit')
    expect(first.finalStateHash).toBe(second.finalStateHash)
    expect(first.stateHashes).toEqual(second.stateHashes)
  })
})
