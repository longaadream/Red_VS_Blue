import { describe, expect, it } from 'vitest'

import {
  PENDING_RESPONSE_DURATION_MS,
  TURN_BURN_WINDOW_MS,
  TURN_FAST_DURATION_MS,
  createRunningTurnTimer,
  getFullRoundNumber,
  getNormalTurnDurationMs,
  projectPendingTimer,
  projectTurnTimer,
  syncTurnTimerAfterAcceptedAction,
} from '@/lib/game/turn-timer'
import { finalizePendingOptionSession } from '@/lib/game/pending-interaction'
import { finalizePendingTargetSession } from '@/lib/game/targeting'
import { makeState } from '../helpers/minimal-state'

describe('RED-36 growing authoritative turn timer', () => {
  it.each([
    [1, 1, 90_000],
    [4, 2, 90_000],
    [5, 3, 120_000],
    [8, 4, 120_000],
    [9, 5, 150_000],
    [12, 6, 150_000],
    [13, 7, 180_000],
    [16, 8, 180_000],
    [17, 9, 210_000],
    [80, 40, 210_000],
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
      durationMs: 120_000,
      deadlineAt: 130_000,
      burnStartsAt: 115_000,
      fast: false,
      burnPhase: 'normal',
      noOpStreaks: {
        'player-red': 0,
        'player-blue': 0,
      },
    })
    expect(projectTurnTimer(timer, 114_999)).toMatchObject({
      remainingMs: 15_001,
      burning: false,
    })
    expect(projectTurnTimer(timer, 115_000)).toMatchObject({
      remainingMs: TURN_BURN_WINDOW_MS,
      burning: true,
    })
  })

  it('starts for pending input before action phase but rejects idle non-action phases', () => {
    const waitingState = makeState({ turnNumber: 2, phase: 'start' })
    waitingState.pendingOptionSelection = finalizePendingOptionSession({
      playerId: 'player-blue',
      title: 'Resolve begin-turn effect',
      options: ['resolve'],
    }, waitingState.targetingRevision ?? 0)

    expect(createRunningTurnTimer(waitingState, 2_000)).toMatchObject({
      status: 'running',
      ownerPlayerId: 'player-red',
      inputOwnerPlayerId: 'player-blue',
      turnOwnerPlayerId: 'player-red',
      turnNumber: 2,
      startedAt: 2_000,
      remainingMs: 90_000,
      deadlineAt: 92_000,
      pendingResponse: {
        ownerPlayerId: 'player-blue',
        durationMs: PENDING_RESPONSE_DURATION_MS,
        deadlineAt: 32_000,
      },
    })

    const idleStart = makeState({ phase: 'start' })
    const idleEnd = makeState({ phase: 'end' })
    expect(() => createRunningTurnTimer(idleStart, 0))
      .toThrow(/action phase or for pending input/)
    expect(() => createRunningTurnTimer(idleEnd, 0))
      .toThrow(/action phase or for pending input/)
  })

  it('uses a doubled 40-second fast rope only for a player carrying a no-op timeout streak', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    const timer = createRunningTurnTimer(state, 4_000, {
      'player-red': 1,
      'player-blue': 0,
    })

    expect(timer).toMatchObject({
      durationMs: TURN_FAST_DURATION_MS,
      deadlineAt: 44_000,
      burnStartsAt: 29_000,
      fast: true,
    })
  })

  it('freezes the turn clock and starts a fresh doubled off-turn response clock', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    state.turnTimer = createRunningTurnTimer(state, 0, {
      'player-red': 2,
      'player-blue': 1,
    })
    state.pendingOptionSelection = finalizePendingOptionSession({
      playerId: 'player-blue',
      title: 'Respond',
      options: ['accept'],
    }, state.targetingRevision ?? 0)

    const waitingForBlue = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 1_000,
      resumedAt: 5_000,
      actorPlayerId: 'player-red',
      acceptedActionType: 'move',
    })

    expect(waitingForBlue).toMatchObject({
      ownerPlayerId: 'player-red',
      inputOwnerPlayerId: 'player-blue',
      turnOwnerPlayerId: 'player-red',
      acceptedGameplayAction: true,
      durationMs: TURN_FAST_DURATION_MS,
      remainingMs: 39_000,
      pendingResponse: {
        ownerPlayerId: 'player-blue',
        durationMs: PENDING_RESPONSE_DURATION_MS,
        startedAt: 5_000,
        deadlineAt: 35_000,
        timeoutResolution: { kind: 'cancel' },
      },
      noOpStreaks: {
        'player-red': 0,
        'player-blue': 1,
      },
    })
    expect(projectTurnTimer(waitingForBlue, 12_000)).toMatchObject({
      ownerPlayerId: 'player-red',
      remainingMs: 39_000,
      paused: true,
    })
    expect(projectPendingTimer(waitingForBlue, 12_000)).toMatchObject({
      ownerPlayerId: 'player-blue',
      durationMs: PENDING_RESPONSE_DURATION_MS,
      remainingMs: 23_000,
      deadlineAt: 35_000,
    })

    // The responder completes the pending input, so authority returns to red.
    // Red resumes the exact budget frozen when the response began. Time spent
    // resolving the response does not consume that budget.
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
      remainingMs: 39_000,
      deadlineAt: 46_000,
      fast: true,
      acceptedGameplayAction: true,
      noOpStreaks: { 'player-red': 0, 'player-blue': 1 },
    })
    expect(returnedToRed?.pendingResponse).toBeUndefined()
  })

  it('gives each newly created off-turn pending session a fresh response clock', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    state.turnTimer = createRunningTurnTimer(state, 0)
    state.pendingOptionSelection = finalizePendingOptionSession({
      playerId: 'player-blue',
      title: 'First response',
      options: ['continue'],
    }, 0)
    state.turnTimer = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 5_000,
      resumedAt: 5_000,
      actorPlayerId: 'player-red',
      acceptedActionType: 'move',
    })
    expect(state.turnTimer?.pendingResponse?.deadlineAt).toBe(35_000)

    state.pendingOptionSelection = finalizePendingOptionSession({
      playerId: 'player-blue',
      title: 'Second response',
      options: ['finish'],
    }, 1)
    state.turnTimer = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 10_000,
      resumedAt: 12_000,
      actorPlayerId: 'player-blue',
      acceptedActionType: 'pendingOptionSelect',
    })

    expect(state.turnTimer).toMatchObject({
      remainingMs: 85_000,
      pendingResponse: {
        startedAt: 12_000,
        deadlineAt: 42_000,
        durationMs: PENDING_RESPONSE_DURATION_MS,
      },
    })
  })

  it('keeps consuming the ordinary clock when the turn owner owns the pending input', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    state.turnTimer = createRunningTurnTimer(state, 0)
    state.pendingOptionSelection = finalizePendingOptionSession({
      playerId: 'player-red',
      title: 'Own pending',
      options: ['resolve'],
    }, 0)

    state.turnTimer = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 6_000,
      resumedAt: 8_000,
      actorPlayerId: 'player-red',
      acceptedActionType: 'move',
    })

    expect(state.turnTimer).toMatchObject({
      ownerPlayerId: 'player-red',
      inputOwnerPlayerId: 'player-red',
      remainingMs: 84_000,
      deadlineAt: 92_000,
    })
    expect(state.turnTimer?.pendingResponse).toBeUndefined()
    expect(projectTurnTimer(state.turnTimer, 10_000)).toMatchObject({
      remainingMs: 82_000,
      paused: false,
    })
  })

  it('stamps the first stable legal option as a mandatory timeout default', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    state.pendingOptionSelection = finalizePendingOptionSession({
      playerId: 'player-blue',
      title: 'Mandatory response',
      options: [
        { label: 'Second label', value: 'first-stable-value' },
        { label: 'First label', value: 'second-stable-value' },
      ],
      canCancel: false,
    }, 0)

    expect(createRunningTurnTimer(state, 3_000).pendingResponse?.timeoutResolution).toEqual({
      kind: 'option',
      selectedOption: 'first-stable-value',
    })
  })

  it('stamps the first stable legal target as a mandatory timeout default', () => {
    const state = makeState({ turnNumber: 3, phase: 'action' })
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-blue',
      ownerPlayerId: 'player-blue',
      title: 'Mandatory target response',
      targetType: 'cell',
      fixedCandidates: true,
      candidates: [
        { type: 'cell', x: 2, y: 1 },
        { type: 'cell', x: 3, y: 1 },
      ],
      canCancel: false,
    }, 0)

    expect(createRunningTurnTimer(state, 3_000).pendingResponse?.timeoutResolution).toEqual({
      kind: 'target',
      targetX: 2,
      targetY: 1,
    })
  })
})
