import { describe, expect, it } from 'vitest'

import {
  TURN_BURN_WINDOW_MS,
  TURN_FAST_DURATION_MS,
  createRunningTurnTimer,
  getFullRoundNumber,
  getNormalTurnDurationMs,
  projectTurnTimer,
  syncTurnTimerAfterAcceptedAction,
} from '@/lib/game/turn-timer'
import { makeState } from '../helpers/minimal-state'

describe('RED-36 growing authoritative turn timer', () => {
  it.each([
    [1, 1, 45_000],
    [4, 2, 45_000],
    [5, 3, 60_000],
    [8, 4, 60_000],
    [9, 5, 75_000],
    [12, 6, 75_000],
    [13, 7, 90_000],
    [16, 8, 90_000],
    [17, 9, 105_000],
    [80, 40, 105_000],
  ])('maps turn %i to complete round %i and %i ms', (turnNumber, round, durationMs) => {
    expect(getFullRoundNumber(turnNumber)).toBe(round)
    expect(getNormalTurnDurationMs(turnNumber)).toBe(durationMs)
  })

  it('starts a normal timer from the server clock and projects the final 15 seconds', () => {
    const state = makeState({ turnNumber: 5, phase: 'action' })
    const timer = createRunningTurnTimer(state, 10_000)

    expect(timer).toMatchObject({
      ownerPlayerId: 'player-red',
      turnNumber: 5,
      fullRound: 3,
      durationMs: 60_000,
      deadlineAt: 70_000,
      burnStartsAt: 55_000,
      fast: false,
      burnPhase: 'normal',
      noOpStreaks: {
        'player-red': 0,
        'player-blue': 0,
      },
    })
    expect(projectTurnTimer(timer, 54_999)).toMatchObject({
      remainingMs: 15_001,
      burning: false,
    })
    expect(projectTurnTimer(timer, 55_000)).toMatchObject({
      remainingMs: TURN_BURN_WINDOW_MS,
      burning: true,
    })
  })

  it('starts for pending input before action phase but rejects idle non-action phases', () => {
    const waitingState = makeState({ turnNumber: 2, phase: 'start' })
    waitingState.pendingOptionSelection = {
      playerId: 'player-blue',
      title: 'Resolve begin-turn effect',
      options: ['resolve'],
    }

    expect(createRunningTurnTimer(waitingState, 2_000)).toMatchObject({
      status: 'running',
      ownerPlayerId: 'player-blue',
      inputOwnerPlayerId: 'player-blue',
      turnOwnerPlayerId: 'player-red',
      turnNumber: 2,
      startedAt: 2_000,
      remainingMs: 45_000,
      deadlineAt: 47_000,
    })

    const idleStart = makeState({ phase: 'start' })
    const idleEnd = makeState({ phase: 'end' })
    expect(() => createRunningTurnTimer(idleStart, 0))
      .toThrow(/action phase or for pending input/)
    expect(() => createRunningTurnTimer(idleEnd, 0))
      .toThrow(/action phase or for pending input/)
  })

  it('uses a 20-second fast rope only for a player carrying a no-op timeout streak', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    const timer = createRunningTurnTimer(state, 4_000, {
      'player-red': 1,
      'player-blue': 0,
    })

    expect(timer).toMatchObject({
      durationMs: TURN_FAST_DURATION_MS,
      deadlineAt: 24_000,
      burnStartsAt: 9_000,
      fast: true,
    })
  })

  it('transfers the running clock to the current pending input owner', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    state.turnTimer = createRunningTurnTimer(state, 0, {
      'player-red': 2,
      'player-blue': 1,
    })
    state.pendingOptionSelection = {
      playerId: 'player-blue',
      title: 'Respond',
      options: ['accept'],
    }

    const waitingForBlue = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 1_000,
      resumedAt: 5_000,
      actorPlayerId: 'player-red',
      acceptedActionType: 'move',
    })

    expect(waitingForBlue).toMatchObject({
      ownerPlayerId: 'player-blue',
      inputOwnerPlayerId: 'player-blue',
      turnOwnerPlayerId: 'player-red',
      acceptedGameplayAction: false,
      durationMs: getNormalTurnDurationMs(3),
      fast: false,
      noOpStreaks: {
        'player-red': 0,
        'player-blue': 1,
      },
    })

    // The responder completes the pending input, so authority returns to red.
    // Red must resume its original 20-second fast budget after spending 1 second,
    // not receive a fresh timer from repeated pending transfers.
    state.turnTimer = waitingForBlue
    state.pendingOptionSelection = undefined
    const returnedToRed = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 6_000,
      resumedAt: 7_000,
      actorPlayerId: 'player-blue',
      acceptedActionType: 'pendingOptionSelect',
    })
    expect(returnedToRed).toMatchObject({
      ownerPlayerId: 'player-red',
      durationMs: TURN_FAST_DURATION_MS,
      remainingMs: 19_000,
      deadlineAt: 26_000,
      fast: true,
      acceptedGameplayAction: true,
      noOpStreaks: { 'player-red': 0, 'player-blue': 0 },
    })
  })
})
