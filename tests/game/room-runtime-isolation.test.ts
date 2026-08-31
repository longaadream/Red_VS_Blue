import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { RoomAuthorityQueue } from '@/lib/game/room-authority-queue'
import {
  RoomRuleRuntimeError,
  RoomRuleRuntimeRegistry,
  type RoomRuleRuntime,
} from '@/lib/game/room-rule-runtime'
import { getRuleMath } from '@/lib/game/rule-runtime'
import type { TriggerRule } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

interface RuntimeSnapshot {
  stateHash: string
  runtimeCursors: Record<string, number>
  pending: { option: unknown; target: unknown }
  triggerUses: number
}

function markerRule(
  roomId: string,
  options: { throwOnRun?: boolean; spinIterations?: number } = {},
): TriggerRule {
  return {
    id: `room-marker:${roomId}`,
    name: `Room marker ${roomId}`,
    description: 'RED-141 room-scoped rule',
    trigger: { type: 'endTurn' },
    limits: { maxUses: 100, uses: 0, currentCooldown: 0 },
    effect(battle) {
      for (let index = 0; index < (options.spinIterations ?? 0); index += 1) {
        Math.imul(index, 31)
      }
      if (options.throwOnRun) throw new Error(`expected ${roomId} rule failure`)
      const extensions = battle.extensions as Record<string, unknown>
      const rolls = Array.isArray(extensions.ruleRolls) ? [...extensions.ruleRolls] : []
      rolls.push(getRuleMath().random())
      extensions.roomMarker = roomId
      extensions.ruleRolls = rolls
      extensions.ruleRuns = Number(extensions.ruleRuns ?? 0) + 1
      return { success: true, message: roomId }
    },
  }
}

function pendingRule(roomId: string): TriggerRule {
  return {
    id: `room-pending:${roomId}`,
    name: `Room pending ${roomId}`,
    description: 'RED-141 pending isolation',
    trigger: { type: 'custom-pending' },
    effect() {
      return {
        success: true,
        message: roomId,
        needsOptionSelection: true,
        options: ['keep', 'cancel'],
        playerId: 'player-red',
      } as ReturnType<TriggerRule['effect']>
    },
  }
}

function rosterState(roomId: string): BattleState {
  return makeState({
    pieces: [
      Object.assign(makePiece({
        instanceId: `${roomId}:red-core`,
        templateId: `${roomId}:red-template`,
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 0,
        y: 0,
      }), { isCore: true }),
      Object.assign(makePiece({
        instanceId: `${roomId}:blue-core`,
        templateId: `${roomId}:blue-template`,
        ownerPlayerId: 'player-blue',
        faction: 'blue',
        x: 5,
        y: 4,
      }), { isCore: true }),
    ],
    currentPlayerId: 'player-red',
    phase: 'action',
  })
}

function createRuntime(
  registry: RoomRuleRuntimeRegistry,
  roomId: string,
  rule: TriggerRule,
): RoomRuleRuntime {
  const runtime = registry.create(roomId)
  runtime.executionContext.triggerSystem.addRule(rule)
  return runtime
}

function transitionAt(
  runtime: RoomRuleRuntime,
  state: BattleState,
  rootSeed: number,
  roomId: string,
  index: number,
): { state: BattleState; stateHash: string } {
  const action = index % 2 === 0
    ? {
        type: 'endTurn',
        playerId: state.turn.currentPlayerId,
        clientActionId: `${roomId}:end:${index}`,
      }
    : {
        type: 'beginPhase',
        clientActionId: `${roomId}:begin:${index}`,
      }
  const result = runBattleAction(state, action as never, {
    rootSeed,
    ruleExecutionContext: runtime.executionContext,
  })
  return { state: result.state, stateHash: result.stateHash }
}

function snapshot(runtime: RoomRuleRuntime, state: BattleState, stateHash: string): RuntimeSnapshot {
  const debugBattle = state.extensions?.debugBattle as {
    authority?: { runtimeCursors?: Record<string, number> }
  } | undefined
  return {
    stateHash,
    runtimeCursors: { ...(debugBattle?.authority?.runtimeCursors ?? {}) },
    pending: {
      option: state.pendingOptionSelection ?? null,
      target: state.pendingTargetSelection ?? null,
    },
    triggerUses: runtime.executionContext.triggerSystem.getRules()[0]?.limits?.uses ?? 0,
  }
}

function runSolo(roomId: string, rootSeed: number): RuntimeSnapshot {
  const queue = new RoomAuthorityQueue()
  const registry = new RoomRuleRuntimeRegistry(queue)
  const runtime = createRuntime(registry, roomId, markerRule(roomId))
  let state = rosterState(roomId)
  let stateHash = hashBattleState(state)
  for (let index = 0; index < 100; index += 1) {
    const result = transitionAt(runtime, state, rootSeed, roomId, index)
    state = result.state
    stateHash = result.stateHash
  }
  return snapshot(runtime, state, stateHash)
}

function randomSkillState(roomId: string): BattleState {
  const caster = makePiece({
    instanceId: `${roomId}:caster`,
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
  }) as unknown as Omit<ReturnType<typeof makePiece>, 'skills'> & {
    skills: Array<Record<string, unknown>>
  }
  caster.skills = [{ skillId: 'room-cache-skill', currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({
    pieces: [caster] as unknown as ReturnType<typeof makePiece>[],
    currentPlayerId: 'player-red',
    phase: 'action',
  }) as BattleState
  const player = state.players.find(candidate => candidate.playerId === 'player-red')!
  player.actionPoints = 10
  state.skillsById['room-cache-skill'] = {
    id: 'room-cache-skill',
    name: 'Room cache skill',
    description: '',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    requiresTarget: false,
    code: "function executeSkill(context) { context.battle.extensions.cacheRoom = context.battle.extensions.cacheRoom || 'compiled'; return { success: true, message: 'ok' }; }",
  } as never
  return state
}

describe('RED-141 room rule runtime isolation', () => {
  it('matches two interleaved 100-transition rooms with their solo hashes, RNG cursors, pending state, and limits', () => {
    const soloA = runSolo('room-a', 1401)
    const soloB = runSolo('room-b', 1402)

    const queue = new RoomAuthorityQueue()
    const registry = new RoomRuleRuntimeRegistry(queue)
    const runtimeA = createRuntime(registry, 'room-a', markerRule('room-a'))
    const runtimeB = createRuntime(registry, 'room-b', markerRule('room-b'))
    let stateA = rosterState('room-a')
    let stateB = rosterState('room-b')
    let hashA = hashBattleState(stateA)
    let hashB = hashBattleState(stateB)

    for (let index = 0; index < 100; index += 1) {
      const resultA = transitionAt(runtimeA, stateA, 1401, 'room-a', index)
      stateA = resultA.state
      hashA = resultA.stateHash
      const resultB = transitionAt(runtimeB, stateB, 1402, 'room-b', index)
      stateB = resultB.state
      hashB = resultB.stateHash
    }

    expect(snapshot(runtimeA, stateA, hashA)).toEqual(soloA)
    expect(snapshot(runtimeB, stateB, hashB)).toEqual(soloB)
    expect(stateA.extensions?.roomMarker).toBe('room-a')
    expect(stateB.extensions?.roomMarker).toBe('room-b')
  }, 20_000)

  it('contains throw, limits, pending, and compiled caches inside the owning room', () => {
    const queue = new RoomAuthorityQueue()
    const registry = new RoomRuleRuntimeRegistry(queue)
    const runtimeA = createRuntime(registry, 'fault-a', markerRule('fault-a', { throwOnRun: true }))
    const runtimeB = createRuntime(registry, 'healthy-b', markerRule('healthy-b'))

    expect(() => transitionAt(runtimeA, rosterState('fault-a'), 1411, 'fault-a', 0))
      .toThrow('expected fault-a rule failure')
    const healthy = transitionAt(runtimeB, rosterState('healthy-b'), 1412, 'healthy-b', 0)

    expect(healthy.state.extensions?.roomMarker).toBe('healthy-b')
    expect(runtimeA.executionContext.triggerSystem.getRules()[0]?.limits?.uses).toBe(0)
    expect(runtimeB.executionContext.triggerSystem.getRules()[0]?.limits?.uses).toBe(1)

    runtimeA.executionContext.triggerSystem.addRule(pendingRule('fault-a'))
    const pending = runtimeA.run(() => runtimeA.executionContext.triggerSystem.checkTriggers(
      rosterState('fault-a'),
      { type: 'custom-pending', playerId: 'player-red' },
    ))
    expect(pending).toMatchObject({ needsOptionSelection: true, playerId: 'player-red' })
    expect(healthy.state.pendingOptionSelection).toBeUndefined()

    runBattleAction(randomSkillState('fault-a'), {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'fault-a:caster',
      skillId: 'room-cache-skill',
      clientActionId: 'fault-a:cache',
    } as never, { rootSeed: 1421, ruleExecutionContext: runtimeA.executionContext })
    runBattleAction(randomSkillState('healthy-b'), {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'healthy-b:caster',
      skillId: 'room-cache-skill',
      clientActionId: 'healthy-b:cache',
    } as never, { rootSeed: 1422, ruleExecutionContext: runtimeB.executionContext })

    const cacheA = [...runtimeA.executionContext.cache.values()][0] as {
      dynamicCodeRuntime: { stats(): { compiled: number } }
    }
    const cacheB = [...runtimeB.executionContext.cache.values()][0] as {
      dynamicCodeRuntime: { stats(): { compiled: number } }
    }
    expect(cacheA).not.toBe(cacheB)
    expect(cacheA.dynamicCodeRuntime.stats().compiled).toBe(1)
    expect(cacheB.dynamicCodeRuntime.stats().compiled).toBe(1)

    registry.close('fault-a', 'fault-injected')
    expect(runtimeA.executionContext.cache.size).toBe(0)
    expect(runtimeB.executionContext.cache.size).toBe(1)
  })

  it('keeps real rule work cross-room concurrent while preserving same-room FIFO, backpressure, inspect, and close', async () => {
    const queue = new RoomAuthorityQueue({ maxPendingPerRoom: 1 })
    const registry = new RoomRuleRuntimeRegistry(queue)
    const runtimeA = createRuntime(registry, 'queue-a', markerRule('queue-a', { spinIterations: 250_000 }))
    const runtimeB = createRuntime(registry, 'queue-b', markerRule('queue-b'))
    let releaseA!: () => void
    const gateA = new Promise<void>(resolve => { releaseA = resolve })

    const firstA = queue.enqueue('queue-a', { kind: 'player', actionId: 'a-1' }, async () => {
      const result = transitionAt(runtimeA, rosterState('queue-a'), 1431, 'queue-a', 0)
      await gateA
      return result.state.extensions?.roomMarker
    })
    const secondA = queue.enqueue('queue-a', { kind: 'timer', actionId: 'a-2' }, () => 'a-2')
    await expect(queue.enqueue('queue-a', { kind: 'pending', actionId: 'a-3' }, () => 'a-3'))
      .rejects.toMatchObject({ code: 'ROOM_AUTHORITY_BACKPRESSURE' })

    const roomB = await queue.enqueue('queue-b', { kind: 'system', actionId: 'b-1' }, () => (
      transitionAt(runtimeB, rosterState('queue-b'), 1432, 'queue-b', 0).state.extensions?.roomMarker
    ))
    expect(roomB).toBe('queue-b')
    expect(registry.inspect('queue-a')).toMatchObject({
      activeEvent: { kind: 'player', actionId: 'a-1' },
      queueDepth: 2,
      pendingDepth: 1,
      closed: false,
    })

    releaseA()
    await expect(Promise.all([firstA, secondA])).resolves.toEqual(['queue-a', 'a-2'])

    const firstClose = registry.close('queue-a', 'terminal')
    const secondClose = registry.close('queue-a', 'ignored-repeat')
    expect(secondClose).toEqual(firstClose)
    expect(firstClose).toMatchObject({ closed: true, closedReason: 'terminal', queueDepth: 0 })
    expect(() => registry.create('queue-a')).toThrow(RoomRuleRuntimeError)
    await expect(queue.enqueue('queue-a', { kind: 'disconnect', actionId: 'late' }, () => 'late'))
      .rejects.toMatchObject({ code: 'ROOM_AUTHORITY_QUEUE_CLOSED' })
  })

  it('prevents the online path from falling back to the mutable process TriggerSystem', () => {
    const actions = readFileSync(resolve(process.cwd(), 'lib/game/room-battle-actions.ts'), 'utf8')
    const start = readFileSync(resolve(process.cwd(), 'lib/game/room-battle-start.ts'), 'utf8')
    const setup = readFileSync(resolve(process.cwd(), 'lib/game/battle-setup.ts'), 'utf8')
    const turn = readFileSync(resolve(process.cwd(), 'lib/game/turn.ts'), 'utf8')
    const skills = readFileSync(resolve(process.cwd(), 'lib/game/skills.ts'), 'utf8')

    expect(actions).not.toContain('globalTriggerSystem')
    expect(actions).toContain('ruleExecutionContext: roomRuleRuntime.executionContext')
    expect(start).toContain('ruleExecutionContext: roomRuleRuntime.executionContext')
    expect(setup).toContain('getRuleExecutionTriggerSystem(globalTriggerSystem)')
    expect(turn).toContain('getRuleExecutionTriggerSystem(globalTriggerSystem)')
    expect(skills).toContain('getRuleExecutionTriggerSystem(globalTriggerSystem)')
  })
})
