import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import {
  dispatchRoomBattleAction,
  type DeploymentRoomStore,
} from '@/lib/game/room-battle-actions'
import { RoomAuthorityQueue } from '@/lib/game/room-authority-queue'
import {
  RoomRuleRuntimeError,
  RoomRuleRuntimeRegistry,
  restoreRoomRuleRuntime,
  type RoomRuleRuntime,
} from '@/lib/game/room-rule-runtime'
import { getRuleMath } from '@/lib/game/rule-runtime'
import type {
  BattleAuthorityCheckpointRecord,
  BattleAuthorityReceipt,
  BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import type { Room } from '@/lib/game/room-store'
import { getBattleStorage } from '@/lib/game/battle-storage'
import type { TriggerRule } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'
import { createTestServerBattleState } from './profile-test-identity'

interface RuntimeSnapshot {
  stateHash: string
  runtimeCursors: Record<string, number>
  pending: { option: unknown; target: unknown }
  triggerUses: number
}

interface OnlineRuntimeSnapshot extends RuntimeSnapshot {
  authorityVersion: number
  receipts: Array<{ status: string; authorityVersion: number; clientActionId: string }>
}

class MultiRoomAuthorityStore implements DeploymentRoomStore {
  readonly rooms = new Map<string, Room>()
  readonly receipts = new Map<string, BattleAuthorityReceipt>()
  readonly transitions = new Map<string, BattleAuthorityTransitionRecord[]>()
  private readonly commitBlocks = new Map<string, {
    gate: Promise<void>
    markStarted: () => void
  }>()

  constructor(rooms: Room[]) {
    for (const room of rooms) this.rooms.set(room.id, structuredClone(room))
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    const room = this.rooms.get(roomId)
    return room ? structuredClone(room) : undefined
  }

  async setRoom(roomId: string, room: Room): Promise<void> {
    this.rooms.set(roomId, structuredClone(room))
  }

  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    const current = this.rooms.get(roomId)
    if (!current || current.version !== expectedVersion) return false
    this.rooms.set(roomId, { ...structuredClone(room), version: expectedVersion + 1 })
    return true
  }

  async getBattleAuthorityReceipt(roomId: string, clientActionId: string): Promise<BattleAuthorityReceipt | undefined> {
    const receipt = this.receipts.get(`${roomId}:${clientActionId}`)
    return receipt ? structuredClone(receipt) : undefined
  }

  async persistBattleAuthorityReceipt(receipt: BattleAuthorityReceipt): Promise<void> {
    this.receipts.set(`${receipt.roomId}:${receipt.clientActionId}`, structuredClone(receipt))
  }

  async commitBattleAuthorityTransition(input: {
    roomId: string
    expectedVersion: number
    nextRoom: Room
    transition: BattleAuthorityTransitionRecord
    baseCheckpoint?: BattleAuthorityCheckpointRecord
    checkpoint?: BattleAuthorityCheckpointRecord
  }): Promise<boolean> {
    const current = this.rooms.get(input.roomId)
    if (!current || current.battleAuthorityVersion !== input.expectedVersion) return false
    const block = this.commitBlocks.get(input.roomId)
    if (block) {
      block.markStarted()
      await block.gate
      this.commitBlocks.delete(input.roomId)
    }
    const roomTransitions = this.transitions.get(input.roomId) ?? []
    roomTransitions.push(structuredClone(input.transition))
    this.transitions.set(input.roomId, roomTransitions)
    this.receipts.set(
      `${input.roomId}:${input.transition.receipt.clientActionId}`,
      structuredClone(input.transition.receipt),
    )
    this.rooms.set(input.roomId, {
      ...structuredClone(input.nextRoom),
      battleAuthorityVersion: input.transition.toVersion,
      battleAuthorityTransitionHash: input.transition.transitionHash,
    })
    return true
  }

  inspectBattleAuthorityPersistence(roomId: string) {
    const authorityVersion = Number(this.rooms.get(roomId)?.battleAuthorityVersion ?? 0)
    return {
      status: 'durable' as const,
      durableAuthorityVersion: authorityVersion,
      authorityVersion,
      pending: 0,
    }
  }

  state(roomId: string): BattleState {
    const storage = getBattleStorage(this.rooms.get(roomId)!)
    if (!storage) throw new Error(`Missing battle storage for ${roomId}`)
    return storage.state as BattleState
  }

  blockNextCommit(roomId: string): { started: Promise<void>; release: () => void } {
    let release!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    this.commitBlocks.set(roomId, { gate, markStarted })
    return { started, release }
  }
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

function pendingTargetState(roomId: string): BattleState {
  const state = rosterState(roomId)
  state.targetingRevision = 0
  state.pendingTargetSelection = {
    playerId: 'player-red',
    ownerPlayerId: 'player-red',
    selectionId: 'shared-pending-selection',
    stateRevision: 0,
    title: 'Choose a cell',
    targetType: 'cell',
    filter: 'all',
    effectCode: `function(ctx) { ctx.battle.extensions.pendingRuntimeRoom = '${roomId}'; return { success: true, message: '${roomId}' }; }`,
  }
  return state
}

function onlineRoom(runtimeRoomId: string, stateRoomId: string, rootSeed: number): Room {
  const state = rosterState(stateRoomId)
  return {
    id: runtimeRoomId,
    name: runtimeRoomId,
    status: 'in-progress',
    players: [
      { id: 'player-red', name: 'Red', seat: 'red', alignment: 'light' },
      { id: 'player-blue', name: 'Blue', seat: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 1,
    battleAuthorityVersion: 0,
    battleState: createTestServerBattleState(state as unknown as Record<string, unknown>, rootSeed),
  }
}

async function dispatchTransitionAt(
  store: MultiRoomAuthorityStore,
  runtime: RoomRuleRuntime,
  stateRoomId: string,
  index: number,
): Promise<{ stateHash: string; receipt: OnlineRuntimeSnapshot['receipts'][number] }> {
  const state = store.state(runtime.roomId)
  const action = index % 2 === 0
    ? {
        type: 'endTurn',
        playerId: state.turn.currentPlayerId,
        clientActionId: `${stateRoomId}:end:${index}`,
      }
    : {
        type: 'beginPhase',
        clientActionId: `${stateRoomId}:begin:${index}`,
      }
  const result = await dispatchRoomBattleAction(
    store,
    runtime.roomId,
    'playerId' in action ? action.playerId : state.turn.currentPlayerId,
    action as never,
    { expectedAuthorityVersion: index, clock: { now: () => 50_000 + index } },
  )
  expect(result.kind).toBe('applied')
  expect(result.receipt).toMatchObject({ status: 'applied', authorityVersion: index + 1 })
  return {
    stateHash: result.actionResult.stateHash,
    receipt: {
      status: result.receipt!.status,
      authorityVersion: result.receipt!.authorityVersion,
      clientActionId: result.receipt!.clientActionId,
    },
  }
}

async function runOnlineSolo(
  runtimeRoomId: string,
  stateRoomId: string,
  rootSeed: number,
): Promise<OnlineRuntimeSnapshot> {
  const store = new MultiRoomAuthorityStore([onlineRoom(runtimeRoomId, stateRoomId, rootSeed)])
  const runtime = restoreRoomRuleRuntime(runtimeRoomId)
  runtime.executionContext.triggerSystem.addRule(markerRule(stateRoomId))
  const receipts: OnlineRuntimeSnapshot['receipts'] = []
  let stateHash = hashBattleState(store.state(runtimeRoomId))
  for (let index = 0; index < 100; index += 1) {
    const result = await dispatchTransitionAt(store, runtime, stateRoomId, index)
    stateHash = result.stateHash
    receipts.push(result.receipt)
  }
  return {
    ...snapshot(runtime, store.state(runtimeRoomId), stateHash),
    authorityVersion: Number(store.rooms.get(runtimeRoomId)?.battleAuthorityVersion ?? -1),
    receipts,
  }
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

  it('matches real online dispatch receipts and states for two interleaved 100-transition rooms', async () => {
    const previousAuthorityFlag = process.env.RVB_BATTLE_AUTHORITY_V2
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
    try {
      const soloA = await runOnlineSolo('dispatch-solo-a', 'dispatch-state-a', 1441)
      const soloB = await runOnlineSolo('dispatch-solo-b', 'dispatch-state-b', 1442)

      const store = new MultiRoomAuthorityStore([
        onlineRoom('dispatch-interleaved-a', 'dispatch-state-a', 1441),
        onlineRoom('dispatch-interleaved-b', 'dispatch-state-b', 1442),
      ])
      const runtimeA = restoreRoomRuleRuntime('dispatch-interleaved-a')
      const runtimeB = restoreRoomRuleRuntime('dispatch-interleaved-b')
      runtimeA.executionContext.triggerSystem.addRule(markerRule('dispatch-state-a'))
      runtimeB.executionContext.triggerSystem.addRule(markerRule('dispatch-state-b'))
      const receiptsA: OnlineRuntimeSnapshot['receipts'] = []
      const receiptsB: OnlineRuntimeSnapshot['receipts'] = []
      let hashA = hashBattleState(store.state(runtimeA.roomId))
      let hashB = hashBattleState(store.state(runtimeB.roomId))

      for (let index = 0; index < 100; index += 1) {
        const resultA = await dispatchTransitionAt(store, runtimeA, 'dispatch-state-a', index)
        hashA = resultA.stateHash
        receiptsA.push(resultA.receipt)
        const resultB = await dispatchTransitionAt(store, runtimeB, 'dispatch-state-b', index)
        hashB = resultB.stateHash
        receiptsB.push(resultB.receipt)
      }

      const interleavedA: OnlineRuntimeSnapshot = {
        ...snapshot(runtimeA, store.state(runtimeA.roomId), hashA),
        authorityVersion: Number(store.rooms.get(runtimeA.roomId)?.battleAuthorityVersion ?? -1),
        receipts: receiptsA,
      }
      const interleavedB: OnlineRuntimeSnapshot = {
        ...snapshot(runtimeB, store.state(runtimeB.roomId), hashB),
        authorityVersion: Number(store.rooms.get(runtimeB.roomId)?.battleAuthorityVersion ?? -1),
        receipts: receiptsB,
      }
      expect(interleavedA).toEqual(soloA)
      expect(interleavedB).toEqual(soloB)
      expect(interleavedA.authorityVersion).toBe(100)
      expect(interleavedB.authorityVersion).toBe(100)
    } finally {
      if (previousAuthorityFlag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousAuthorityFlag
    }
  }, 120_000)

  it('keeps real online failures and stalled commits inside the owning room while peers ACK', async () => {
    const previousAuthorityFlag = process.env.RVB_BATTLE_AUTHORITY_V2
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
    try {
      const faultStore = new MultiRoomAuthorityStore([
        onlineRoom('dispatch-fault-a', 'dispatch-fault-state-a', 1451),
        onlineRoom('dispatch-healthy-b', 'dispatch-healthy-state-b', 1452),
      ])
      const faultRuntime = restoreRoomRuleRuntime('dispatch-fault-a')
      const healthyRuntime = restoreRoomRuleRuntime('dispatch-healthy-b')
      faultRuntime.executionContext.triggerSystem.addRule(markerRule('dispatch-fault-state-a', { throwOnRun: true }))
      healthyRuntime.executionContext.triggerSystem.addRule(markerRule('dispatch-healthy-state-b'))

      await expect(dispatchTransitionAt(faultStore, faultRuntime, 'dispatch-fault-state-a', 0))
        .rejects.toThrow('expected dispatch-fault-state-a rule failure')
      const healthy = await dispatchTransitionAt(faultStore, healthyRuntime, 'dispatch-healthy-state-b', 0)
      expect(healthy.receipt).toMatchObject({ status: 'applied', authorityVersion: 1 })
      expect(faultStore.rooms.get(faultRuntime.roomId)?.battleAuthorityVersion).toBe(0)
      expect(faultStore.rooms.get(healthyRuntime.roomId)?.battleAuthorityVersion).toBe(1)
      expect(faultStore.state(healthyRuntime.roomId).extensions?.roomMarker).toBe('dispatch-healthy-state-b')

      const concurrentStore = new MultiRoomAuthorityStore([
        onlineRoom('dispatch-stalled-a', 'dispatch-stalled-state-a', 1461),
        onlineRoom('dispatch-peer-b', 'dispatch-peer-state-b', 1462),
      ])
      const stalledRuntime = restoreRoomRuleRuntime('dispatch-stalled-a')
      const peerRuntime = restoreRoomRuleRuntime('dispatch-peer-b')
      stalledRuntime.executionContext.triggerSystem.addRule(markerRule('dispatch-stalled-state-a', { spinIterations: 250_000 }))
      peerRuntime.executionContext.triggerSystem.addRule(markerRule('dispatch-peer-state-b'))
      const commitBlock = concurrentStore.blockNextCommit(stalledRuntime.roomId)
      const stalled = dispatchTransitionAt(concurrentStore, stalledRuntime, 'dispatch-stalled-state-a', 0)
      await commitBlock.started
      const peer = await dispatchTransitionAt(concurrentStore, peerRuntime, 'dispatch-peer-state-b', 0)
      expect(peer.receipt).toMatchObject({ status: 'applied', authorityVersion: 1 })
      expect(concurrentStore.rooms.get(stalledRuntime.roomId)?.battleAuthorityVersion).toBe(0)
      commitBlock.release()
      await expect(stalled).resolves.toMatchObject({ receipt: { status: 'applied', authorityVersion: 1 } })
    } finally {
      if (previousAuthorityFlag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousAuthorityFlag
    }
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

    const pendingA = runBattleAction(pendingTargetState('fault-a'), {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 0,
      targetY: 0,
      selectionId: 'shared-pending-selection',
      stateRevision: 0,
      clientActionId: 'fault-a:pending-cache',
    } as never, { rootSeed: 1421, ruleExecutionContext: runtimeA.executionContext })
    const pendingB = runBattleAction(pendingTargetState('healthy-b'), {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 0,
      targetY: 0,
      selectionId: 'shared-pending-selection',
      stateRevision: 0,
      clientActionId: 'healthy-b:pending-cache',
    } as never, { rootSeed: 1422, ruleExecutionContext: runtimeB.executionContext })
    expect(pendingA.state.extensions?.pendingRuntimeRoom).toBe('fault-a')
    expect(pendingB.state.extensions?.pendingRuntimeRoom).toBe('healthy-b')
    expect(cacheA.dynamicCodeRuntime.stats().compiled).toBe(2)
    expect(cacheB.dynamicCodeRuntime.stats().compiled).toBe(2)

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
    expect(turn).toContain('getRuleDynamicCodeRuntime().compileExpression')
    expect(turn).not.toContain("from './dynamic-code-runtime'")
  })
})
