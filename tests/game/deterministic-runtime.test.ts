/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RANDOM_STREAM_NAMES,
  RuleRuntime,
  deriveStreamSeed,
  withRuleRuntime,
  withRuleRuntimeCheckpoint,
} from '@/lib/game/rule-runtime'
import { getBattleRootSeed, replayBattle, runBattleAction, sha256Hex } from '@/lib/game/battle-runner'
import { loadRuleById } from '@/lib/game/skills'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function makeRandomSkillState(success = true): BattleState {
  const caster = makePiece({
    instanceId: 'caster',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
  }) as any
  caster.skills = [{ skillId: 'deterministic-script', currentCooldown: 0, usesRemaining: -1 }]

  const state = makeState({
    pieces: [caster],
    currentPlayerId: 'player-red',
    phase: 'action',
  }) as any
  state.players.find((player: any) => player.playerId === 'player-red').actionPoints = 10
  state.skillsById['deterministic-script'] = {
    id: 'deterministic-script',
    name: 'Deterministic Script',
    description: '',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    requiresTarget: false,
    code: `function executeSkill(context) {
      context.battle.extensions.scriptRoll = Math.random();
      context.battle.extensions.scriptId = 'script-' + Date.now();
      return { success: ${success}, message: ${success ? "'ok'" : "'rejected'"} };
    }`,
  }
  return state
}

const RANDOM_ACTION = {
  type: 'useBasicSkill',
  playerId: 'player-red',
  pieceId: 'caster',
  skillId: 'deterministic-script',
  clientActionId: 'action-random-1',
} as any

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deterministic rule runtime', () => {
  it('returns the same isolated rule limits on cache miss and cache hit', () => {
    const first = loadRuleById('rule-lucky-coin-gamestart', true)
    const cached = loadRuleById('rule-lucky-coin-gamestart')

    expect(first?.limits).toEqual(cached?.limits)
    expect(first?.limits).not.toBe(cached?.limits)
    if (first?.limits) first.limits.currentCooldown = 9
    expect(loadRuleById('rule-lucky-coin-gamestart')?.limits?.currentCooldown).toBe(0)
  })

  it('freezes stable named-stream derivation vectors', () => {
    expect(deriveStreamSeed(0x12345678, RANDOM_STREAM_NAMES.deployment)).toBe(1042218019)
    expect(deriveStreamSeed(0x12345678, RANDOM_STREAM_NAMES.skillEffect)).toBe(1945309363)

    const runtime = new RuleRuntime({ rootSeed: 0x12345678 })
    expect(Math.floor(runtime.nextRandom(RANDOM_STREAM_NAMES.deployment) * 0x1_0000_0000)).toBe(2989293187)
    expect(Math.floor(runtime.nextRandom(RANDOM_STREAM_NAMES.deployment) * 0x1_0000_0000)).toBe(2046591406)
  })

  it('isolates deployment from skill/effect random calls', () => {
    const direct = new RuleRuntime({ rootSeed: 1234 })
    const directDeployment = [
      direct.nextRandom(RANDOM_STREAM_NAMES.deployment),
      direct.nextRandom(RANDOM_STREAM_NAMES.deployment),
    ]

    const interleaved = new RuleRuntime({ rootSeed: 1234 })
    interleaved.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
    interleaved.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
    interleaved.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
    const interleavedDeployment = [
      interleaved.nextRandom(RANDOM_STREAM_NAMES.deployment),
      interleaved.nextRandom(RANDOM_STREAM_NAMES.deployment),
    ]

    expect(interleavedDeployment).toEqual(directDeployment)
  })

  it('creates stable unique IDs and a deterministic logical clock', () => {
    const first = new RuleRuntime({ rootSeed: 99, tick: 7 })
    const second = new RuleRuntime({ rootSeed: 99, tick: 7 })

    const firstIds = [first.nextInstanceId('card'), first.nextInstanceId('card'), first.nextInstanceId('status')]
    const secondIds = [second.nextInstanceId('card'), second.nextInstanceId('card'), second.nextInstanceId('status')]

    expect(firstIds).toEqual(secondIds)
    expect(new Set(firstIds).size).toBe(firstIds.length)
    expect([first.clock.now(), first.clock.now()]).toEqual([second.clock.now(), second.clock.now()])
  })

  it('rolls back random, ID, and clock cursors used by preflight', () => {
    const runtime = new RuleRuntime({ rootSeed: 2028, tick: 3 })

    withRuleRuntime(runtime, () => {
      withRuleRuntimeCheckpoint(() => {
        runtime.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        runtime.nextInstanceId('card')
        runtime.clock.now()
      })
    })

    expect(runtime.randomTrace()).toContainEqual(
      { name: RANDOM_STREAM_NAMES.skillEffect, startCursor: 0, endCursor: 0 },
    )
    expect(runtime.nextInstanceId('card')).toBe(new RuleRuntime({ rootSeed: 2028, tick: 3 }).nextInstanceId('card'))
    expect(runtime.clock.now()).toBe(new RuleRuntime({ rootSeed: 2028, tick: 3 }).clock.now())
  })
})

describe('deterministic battle runner', () => {
  it('uses the browser-safe SHA-256 implementation for trace hashes', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('红蓝⚔️')).toBe('2b508c520ea1e50e8f21bffa52ceef4fb0e60bfeb9d2b8c53179277cc0c7edf3')
  })

  it('ignores wall-clock changes in authoritative data scripts', () => {
    vi.spyOn(Date, 'now').mockReturnValue(111)
    const first = runBattleAction(makeRandomSkillState(), RANDOM_ACTION, { rootSeed: 4242 })

    vi.mocked(Date.now).mockReturnValue(999_999_999)
    const second = runBattleAction(makeRandomSkillState(), RANDOM_ACTION, { rootSeed: 4242 })

    expect(first.stateHash).toBe(second.stateHash)
    expect((first.state as any).extensions.scriptRoll).toBe((second.state as any).extensions.scriptRoll)
    expect((first.state as any).extensions.scriptId).toBe((second.state as any).extensions.scriptId)
    expect(first.trace?.randomStreams).toContainEqual({
      name: RANDOM_STREAM_NAMES.skillEffect,
      startCursor: 0,
      endCursor: 1,
    })
  })

  it('does not advance cursors or pollute state when a command fails', () => {
    const failedState = makeRandomSkillState(false)
    const before = JSON.parse(JSON.stringify(failedState))

    let thrown: any
    try {
      runBattleAction(failedState, RANDOM_ACTION, { rootSeed: 5150 })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown.determinism).toMatchObject({
      rootSeed: 5150,
      streamName: RANDOM_STREAM_NAMES.skillEffect,
      cursor: 0,
      turn: failedState.turn.turnNumber,
      playerId: 'player-red',
      actionId: 'action-random-1',
    })
    expect(failedState).toEqual(before)

    const afterFailure = makeRandomSkillState(true)
    const control = makeRandomSkillState(true)
    const afterFailureResult = runBattleAction(afterFailure, RANDOM_ACTION, { rootSeed: 5150 })
    const controlResult = runBattleAction(control, RANDOM_ACTION, { rootSeed: 5150 })
    expect(afterFailureResult.stateHash).toBe(controlResult.stateHash)
    expect(afterFailureResult.trace?.randomStreams).toContainEqual({
      name: RANDOM_STREAM_NAMES.skillEffect,
      startCursor: 0,
      endCursor: 1,
    })
  })

  it('records seed, action ID, stream cursors, and before/after hashes', () => {
    const result = runBattleAction(makeRandomSkillState(), RANDOM_ACTION, { rootSeed: 8080 })

    expect(result.trace).toMatchObject({
      rootSeed: 8080,
      actionId: 'action-random-1',
      playerId: 'player-red',
      turn: 1,
      preStateHash: expect.any(String),
      postStateHash: result.stateHash,
    })
    expect((result.state.extensions as any).debugBattle.actionLog.at(-1)).toEqual(result.trace)
    expect(getBattleRootSeed(result.state)).toBe(8080)
  })

  it.each([
    {
      name: 'pending option',
      prepare(state: any) {
        state.pendingOptionSelection = {
          playerId: 'player-red',
          title: 'Choose',
          options: ['yes', 'no'],
        }
      },
      action: {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'yes',
        clientActionId: 'pending-option-1',
      },
      pendingKey: 'pendingOptionSelection',
    },
    {
      name: 'pending target',
      prepare(state: any) {
        state.pendingTargetSelection = {
          playerId: 'player-red',
          title: 'Choose a cell',
          targetType: 'cell',
          range: 99,
          filter: 'all',
          effectCode: "function(ctx) { ctx.battle.extensions.pendingTargetApplied = [ctx.targetX, ctx.targetY]; return { success: true, message: 'ok' }; }",
        }
      },
      action: {
        type: 'pendingTargetSelect',
        playerId: 'player-red',
        targetX: 0,
        targetY: 0,
        clientActionId: 'pending-target-1',
      },
      pendingKey: 'pendingTargetSelection',
    },
  ])('commits a $name action-log echo exactly once through the runner', ({ prepare, action, pendingKey }) => {
    const initial = makeState({ currentPlayerId: 'player-red', phase: 'action' }) as any
    prepare(initial)
    const peerInitial = JSON.parse(JSON.stringify(initial))

    const authority = runBattleAction(initial, action as any, { rootSeed: 42 })
    const peer = runBattleAction(peerInitial, action as any, { rootSeed: 42 })

    expect(authority.stateHash).toBe(peer.stateHash)
    expect(authority.trace?.actionId).toBe((action as any).clientActionId)
    expect(peer.trace?.actionId).toBe((action as any).clientActionId)
    expect((authority.state as any)[pendingKey]).toBeUndefined()
    expect((initial as any)[pendingKey]).toBeDefined()
    expect((authority.state.extensions as any).debugBattle.actionLog).toHaveLength(1)
  })

  it('replays identical per-action hashes for the same seed and commands', () => {
    const initialState = makeRandomSkillState()
    const actions = [
      RANDOM_ACTION,
      { type: 'endTurn', playerId: 'player-red', clientActionId: 'action-end-1' },
      { type: 'beginPhase', clientActionId: 'action-begin-2' },
    ] as any[]
    const replayA = replayBattle({ initialState, actions, seed: 12345 })
    const replayB = replayBattle({ initialState, actions, seed: 12345 })

    expect(replayA.stateHashes).toHaveLength(actions.length)
    expect(replayA.stateHashes).toEqual(replayB.stateHashes)
    expect(replayA.finalStateHash).toBe(replayB.finalStateHash)
  })
})
