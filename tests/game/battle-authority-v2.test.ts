import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hashPublicBattleState } from '@/lib/game/battle-public-patch'
import { hashBattleState } from '@/lib/game/battle-runner'
import { startBattleFromLockedRosters } from '@/lib/game/room-battle-start'
import { recordBattleInitialization } from '@/lib/game/battle-trace'
import { toPublicBattleState } from '@/lib/game/deployment'
import {
  createPublicBattleTransitionUpdate,
  dispatchRoomBattleAction,
  type DeploymentRoomStore,
} from '@/lib/game/room-battle-actions'
import {
  isBattleAuthorityV2Enabled,
  replayBattleAuthorityTransitions,
  type BattleAuthorityCheckpointRecord,
  type BattleAuthorityReceipt,
  type BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import { DEMO_ROSTER_MANIFEST_VERSION, getDefaultDemoRosterSelection } from '@/lib/game/roster-contract'
import type { Room } from '@/lib/game/room-store'
import type { BattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const originalAuthorityV2Flag = process.env.RVB_BATTLE_AUTHORITY_V2
beforeAll(() => { process.env.RVB_BATTLE_AUTHORITY_V2 = '1' })
afterAll(() => {
  if (originalAuthorityV2Flag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
  else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthorityV2Flag
})

class AuthorityV2MemoryStore implements DeploymentRoomStore {
  room: Room
  commits = 0
  receiptWrites = 0
  failCommits = false
  receipts = new Map<string, BattleAuthorityReceipt>()
  transitions: BattleAuthorityTransitionRecord[] = []
  baseCheckpoints: BattleAuthorityCheckpointRecord[] = []
  checkpoints: BattleAuthorityCheckpointRecord[] = []

  constructor(room: Room) {
    this.room = structuredClone(room)
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    return roomId === this.room.id ? structuredClone(this.room) : undefined
  }

  async setRoom(_roomId: string, room: Room): Promise<void> {
    this.room = structuredClone(room)
  }

  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    if (roomId !== this.room.id || expectedVersion !== this.room.version) return false
    this.room = { ...structuredClone(room), version: expectedVersion + 1 }
    return true
  }

  async getBattleAuthorityReceipt(roomId: string, clientActionId: string): Promise<BattleAuthorityReceipt | undefined> {
    return this.receipts.get(`${roomId}:${clientActionId}`)
  }

  async persistBattleAuthorityReceipt(receipt: BattleAuthorityReceipt): Promise<void> {
    this.receiptWrites += 1
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
    if (this.failCommits || input.roomId !== this.room.id || input.expectedVersion !== this.room.battleAuthorityVersion) return false
    this.commits += 1
    if (input.baseCheckpoint) this.baseCheckpoints.push(structuredClone(input.baseCheckpoint))
    if (input.checkpoint) this.checkpoints.push(structuredClone(input.checkpoint))
    this.transitions.push(structuredClone(input.transition))
    this.receipts.set(
      `${input.transition.receipt.roomId}:${input.transition.receipt.clientActionId}`,
      structuredClone(input.transition.receipt),
    )
    this.room = {
      ...structuredClone(input.nextRoom),
      battleAuthorityVersion: input.transition.toVersion,
      battleAuthorityTransitionHash: input.transition.transitionHash,
    }
    return true
  }

  async readBattleAuthorityHistory(): Promise<Array<{
    trace?: BattleAuthorityTransitionRecord['traces'][number]
    command?: Record<string, unknown>
    replayFrame?: BattleAuthorityTransitionRecord['replayFrames'][number]
  }>> {
    return this.transitions.flatMap(transition => transition.commands.map((command, index) => ({
      command: command as unknown as Record<string, unknown>,
      trace: transition.traces[index],
      replayFrame: transition.replayFrames[index],
    })))
  }
}

describe('RED-109 authority v2 coordinator', () => {
  it('keeps authority v2 disabled unless the candidate flag is explicitly enabled', () => {
    delete process.env.RVB_BATTLE_AUTHORITY_V2
    expect(isBattleAuthorityV2Enabled()).toBe(false)
    process.env.RVB_BATTLE_AUTHORITY_V2 = 'true'
    expect(isBattleAuthorityV2Enabled()).toBe(true)
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
  })

  it('initializes the version-zero checkpoint with the projected public hash', async () => {
    let currentRoom: Room = {
      id: 'red109-initial-checkpoint',
      name: 'RED-109 initial checkpoint',
      status: 'ready',
      players: [
        {
          id: 'player-red',
          name: 'Red',
          seat: 'red',
          alignment: 'light',
          selectedPieces: getDefaultDemoRosterSelection('light'),
          rosterLocked: true,
          rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
        },
        {
          id: 'player-blue',
          name: 'Blue',
          seat: 'blue',
          alignment: 'dark',
          selectedPieces: getDefaultDemoRosterSelection('dark'),
          rosterLocked: true,
          rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
        },
      ],
      spectators: [],
      currentTurnIndex: 0,
      actions: [],
      version: 3,
      battleAuthorityVersion: 0,
    }
    let checkpoint: {
      storage: { state: unknown }
      stateHash: string
      publicHash: string
    } | undefined
    const store = {
      async getRoom(roomId: string) {
        return roomId === currentRoom.id ? structuredClone(currentRoom) : undefined
      },
      async setRoom(_roomId: string, room: Room) {
        currentRoom = structuredClone(room)
      },
      async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number) {
        if (roomId !== currentRoom.id || expectedVersion !== currentRoom.version) return false
        currentRoom = { ...JSON.parse(JSON.stringify(room)) as Room, version: expectedVersion + 1 }
        return true
      },
      async initializeBattleAuthorityCheckpoint(input: {
        room: Room
        storage: { state: unknown }
        stateHash: string
        publicHash: string
      }) {
        checkpoint = structuredClone(input)
      },
    }

    const started = await startBattleFromLockedRosters(store, currentRoom.id, {
      clock: { now: () => 1_000 },
    })

    expect(started.started).toBe(true)
    expect(checkpoint).toBeDefined()
    const captured = checkpoint!
    expect(captured.publicHash).toBe(hashPublicBattleState(toPublicBattleState(captured.storage.state as any)))
    expect(captured.publicHash).not.toBe(captured.stateHash)

    checkpoint = undefined
    const resumed = await startBattleFromLockedRosters(store, currentRoom.id, {
      clock: { now: () => 1_000 },
    })
    expect(resumed.started).toBe(false)
    expect(checkpoint).toBeDefined()
  })

  it('rolls the room back when the mandatory initial checkpoint cannot be created', async () => {
    let currentRoom: Room = {
      id: 'red109-checkpoint-failure',
      name: 'RED-109 checkpoint failure',
      status: 'ready',
      players: [
        {
          id: 'player-red',
          name: 'Red',
          seat: 'red',
          alignment: 'light',
          selectedPieces: getDefaultDemoRosterSelection('light'),
          rosterLocked: true,
          rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
        },
        {
          id: 'player-blue',
          name: 'Blue',
          seat: 'blue',
          alignment: 'dark',
          selectedPieces: getDefaultDemoRosterSelection('dark'),
          rosterLocked: true,
          rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
        },
      ],
      spectators: [],
      currentTurnIndex: 0,
      actions: [],
      version: 3,
      battleAuthorityVersion: 0,
    }
    const store = {
      async getRoom(roomId: string) {
        return roomId === currentRoom.id ? structuredClone(currentRoom) : undefined
      },
      async setRoom(_roomId: string, room: Room) {
        currentRoom = JSON.parse(JSON.stringify(room)) as Room
      },
      async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number) {
        if (roomId !== currentRoom.id || expectedVersion !== currentRoom.version) return false
        currentRoom = { ...JSON.parse(JSON.stringify(room)) as Room, version: expectedVersion + 1 }
        return true
      },
      async initializeBattleAuthorityCheckpoint() {
        throw new Error('checkpoint database unavailable')
      },
    }

    await expect(startBattleFromLockedRosters(store, currentRoom.id, {
      clock: { now: () => 1_000 },
    })).rejects.toThrow('checkpoint database unavailable')

    expect(currentRoom.status).toBe('ready')
    expect(currentRoom.battleState).toBeUndefined()
    expect(currentRoom.version).toBe(5)
  })

  it('commits command, transition and applied receipt once, then deduplicates retries without a write', async () => {
    const store = new AuthorityV2MemoryStore(makeRoom())
    const action = deploymentChoice('command-1')

    const first = await dispatchRoomBattleAction(store, store.room.id, 'player-red', action, {
      expectedAuthorityVersion: 1,
      clock: { now: () => 2_000 },
    })
    const duplicate = await dispatchRoomBattleAction(store, store.room.id, 'player-red', action, {
      expectedAuthorityVersion: 1,
      clock: { now: () => 2_000 },
    })

    expect(first.kind).toBe('applied')
    expect(first.receipt).toMatchObject({ status: 'applied', authorityVersion: 2 })
    expect(first.transition).toMatchObject({ fromVersion: 1, toVersion: 2 })
    expect(first.transition?.preStateHash).toBe(first.submittedActionResult?.trace?.preStateHash)
    expect(first.transition?.preStateHash).toBe(hashBattleState(first.previousAuthorityState!))
    expect(first.transition?.postStateHash).toBe(first.actionResult.stateHash)
    expect(first.transition?.postStateHash).toBe(hashBattleState(first.nextAuthorityState!))
    expect(duplicate.kind).toBe('duplicate')
    expect(duplicate.receipt).toMatchObject({ status: 'duplicate', authorityVersion: 2 })
    expect(store.commits).toBe(1)
    expect(store.transitions).toHaveLength(1)
    expect(store.room.version).toBe(9)
    expect(store.room.battleAuthorityVersion).toBe(2)
  })

  it('falls back to the legacy room CAS and metadata version when v2 is disabled', async () => {
    const previousFlag = process.env.RVB_BATTLE_AUTHORITY_V2
    process.env.RVB_BATTLE_AUTHORITY_V2 = '0'
    try {
      const store = new AuthorityV2MemoryStore(makeRoom())
      const result = await dispatchRoomBattleAction(store, store.room.id, 'player-red', deploymentChoice('legacy-fallback'), {
        expectedAuthorityVersion: 1,
        clock: { now: () => 2_000 },
      })

      expect(result.kind).toBe('applied')
      expect(result.transition).toBeUndefined()
      expect(result.receipt).toBeUndefined()
      expect(result.snapshot.authorityVersion).toBe(10)
      expect(store.room.version).toBe(10)
      expect(store.room.battleAuthorityVersion).toBe(1)
    } finally {
      if (previousFlag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = previousFlag
    }
  })

  it('atomically supplies a version-zero base checkpoint for an in-progress room migrated to v2', async () => {
    const store = new AuthorityV2MemoryStore(makeRoom())
    store.room.battleAuthorityVersion = 0

    const result = await dispatchRoomBattleAction(store, store.room.id, 'player-red', deploymentChoice('migration-base'), {
      expectedAuthorityVersion: 0,
      clock: { now: () => 2_000 },
    })

    expect(result.kind).toBe('applied')
    expect(store.baseCheckpoints).toHaveLength(1)
    expect(store.baseCheckpoints[0]).toMatchObject({
      authorityVersion: 0,
      reason: 'initial',
      stateHash: result.transition?.preStateHash,
      publicHash: result.transition?.prePublicHash,
    })
    expect(store.room.battleAuthorityVersion).toBe(1)
  })

  it('strips restored runtime rule effects before the first v2 deployment transition is persisted', async () => {
    const room = makeRoom()
    room.battleAuthorityVersion = 0
    delete room.battleAuthorityTransitionHash
    const storedState = (room.battleState as unknown as { state: { players: Array<{ rules?: unknown[] }> } }).state
    storedState.players[1].rules = [{
      id: 'rule-lucky-coin-gamestart',
      trigger: { type: 'gameStart' },
    }]
    const store = new AuthorityV2MemoryStore(room)

    const result = await dispatchRoomBattleAction(store, store.room.id, 'player-red', deploymentChoice('runtime-rule-effect'), {
      expectedAuthorityVersion: 0,
      clock: { now: () => 2_000 },
    })

    expect(result.kind).toBe('applied')
    expect(store.commits).toBe(1)
    expect(store.baseCheckpoints).toHaveLength(1)
    expect(containsFunction(store.room.battleState)).toBe(false)
    expect(containsFunction(store.transitions[0])).toBe(false)
    expect(containsFunction(store.baseCheckpoints[0].storage)).toBe(false)
  })
  it('ignores unrelated room metadata version changes when the battle version matches', async () => {
    const store = new AuthorityV2MemoryStore(makeRoom())
    store.room.version = 27

    const result = await dispatchRoomBattleAction(store, store.room.id, 'player-red', deploymentChoice('metadata-gap'), {
      expectedAuthorityVersion: 1,
      clock: { now: () => 2_000 },
    })

    expect(result.kind).toBe('applied')
    expect(store.room.version).toBe(27)
    expect(store.room.battleAuthorityVersion).toBe(2)
    expect(store.transitions).toHaveLength(1)
  })

  it('returns resyncRequired for a stale expected version without running or committing the command', async () => {
    const store = new AuthorityV2MemoryStore(makeRoom())

    const result = await dispatchRoomBattleAction(store, store.room.id, 'player-red', deploymentChoice('stale-1'), {
      expectedAuthorityVersion: 0,
      clock: { now: () => 2_000 },
    })

    expect(result.kind).toBe('resyncRequired')
    expect(result.receipt).toMatchObject({
      status: 'resyncRequired',
      authorityVersion: 1,
      code: 'AUTHORITY_VERSION_MISMATCH',
    })
    expect(store.commits).toBe(0)
    expect(store.receiptWrites).toBe(1)
    expect(store.room.version).toBe(9)
    expect(store.room.battleAuthorityVersion).toBe(1)
    expect((store.room.battleState as any).state.deployment.revision).toBe(0)
  })

  it('uses one fully materialized terminal state for transition, live update, checkpoint and restore', async () => {
    const room = makeRoom()
    room.battleAuthorityVersion = 0
    delete room.battleAuthorityTransitionHash
    const store = new AuthorityV2MemoryStore(room)
    const clock = { now: () => 2_000 }

    await dispatchRoomBattleAction(store, room.id, 'player-red', {
      type: 'deploymentLock',
      playerId: 'player-red',
      clientActionId: 'terminal-history-red-lock',
    }, { expectedAuthorityVersion: 0, clock })
    await dispatchRoomBattleAction(store, room.id, 'player-blue', {
      type: 'deploymentLock',
      playerId: 'player-blue',
      clientActionId: 'terminal-history-blue-lock',
    }, { expectedAuthorityVersion: 1, clock })
    const terminal = await dispatchRoomBattleAction(store, room.id, 'player-red', {
      type: 'surrender',
      playerId: 'player-red',
      clientActionId: 'terminal-history-surrender',
    } as BattleAction, { expectedAuthorityVersion: 2, clock })

    expect(terminal.kind).toBe('applied')
    expect(terminal.nextAuthorityState?.terminalResult).toMatchObject({
      status: 'finished',
      reason: 'surrender',
    })
    const terminalState = terminal.nextAuthorityState!
    expect(JSON.parse(JSON.stringify(terminalState))).toEqual(terminalState)
    const actionLog = terminalState.extensions?.debugBattle?.actionLog ?? []
    expect(actionLog).toHaveLength(4)
    expect(actionLog.map((entry: unknown) => (entry as { actionId?: string }).actionId)).toEqual([
      'system-initialize',
      'terminal-history-red-lock',
      'terminal-history-blue-lock',
      'terminal-history-surrender',
    ])

    const terminalTransition = store.transitions.at(-1)!
    const terminalCheckpoint = store.checkpoints.at(-1)!
    const spectatorPublic = toPublicBattleState(terminalState)
    expect(terminalTransition.preStateHash).toBe(terminal.submittedActionResult?.trace?.preStateHash)
    expect(terminalTransition.preStateHash).toBe(hashBattleState(terminal.previousAuthorityState!))
    expect(terminalTransition.postStateHash).toBe(terminal.actionResult.stateHash)
    expect(terminalTransition.postStateHash).toBe(hashBattleState(terminalState))
    expect(terminalTransition.postPublicHash).toBe(hashPublicBattleState(spectatorPublic))
    expect(terminalCheckpoint.publicHash).toBe(terminalTransition.postPublicHash)
    expect(terminalCheckpoint.storage.state).toEqual(terminalState)
    expect((store.room.battleState as any).state).toEqual(terminalState)

    const liveUpdate = createPublicBattleTransitionUpdate(terminal, room.id, 'player-red', clock)
    expect(liveUpdate?.postPublicHash).toBe(hashPublicBattleState(toPublicBattleState(terminalState, 'player-red')))
    expect(liveUpdate?.patch).toEqual(terminal.transition?.publicPatch)

    const base = store.baseCheckpoints[0]
    const restored = replayBattleAuthorityTransitions({
      roomId: room.id,
      checkpointStorage: base.storage,
      checkpointVersion: base.authorityVersion,
      checkpointStateHash: base.stateHash,
      checkpointPublicHash: base.publicHash,
      checkpointTransitionHash: base.transitionHash,
      targetVersion: store.room.battleAuthorityVersion!,
      targetTransitionHash: store.room.battleAuthorityTransitionHash!,
      transitions: store.transitions,
    })
    expect(restored).toEqual(terminalCheckpoint.storage)
  })
  it('does not expose an applied transition or mutate the room when the atomic commit never succeeds', async () => {
    const store = new AuthorityV2MemoryStore(makeRoom())
    store.failCommits = true

    await expect(dispatchRoomBattleAction(store, store.room.id, 'player-red', deploymentChoice('failed-1'), {
      expectedAuthorityVersion: 1,
      clock: { now: () => 2_000 },
    })).rejects.toMatchObject({ code: 'ROOM_VERSION_CONFLICT' })

    expect(store.commits).toBe(0)
    expect(store.transitions).toHaveLength(0)
    expect(store.receipts).toHaveLength(0)
    expect(store.room.version).toBe(9)
    expect(store.room.battleAuthorityVersion).toBe(1)
  })
})

function deploymentChoice(clientActionId: string): BattleAction {
  return {
    type: 'deploymentChoice',
    playerId: 'player-red',
    pieceId: 'piece-red',
    clientActionId,
  }
}

function containsFunction(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'function') return true
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value).some(entry => containsFunction(entry, seen))
}
function makeRoom(): Room {
  const state = makeState({
    pieces: [
      Object.assign(makePiece({ instanceId: 'piece-red', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 }), { isCore: true }) as any,
      Object.assign(makePiece({ instanceId: 'piece-blue', ownerPlayerId: 'player-blue', faction: 'blue', x: 8, y: 8 }), { isCore: true }) as any,
    ],
    phase: 'start',
  }) as any
  // Server checkpoints exclude the runtime-only skill cache before the runner hydrates it.
  delete state.skillsById
  state.deployment = {
    status: 'awaiting-locks',
    playerIds: ['player-red', 'player-blue'],
    choices: {},
    locks: {
      'player-red': { locked: false },
      'player-blue': { locked: false },
    },
    startedAt: 1_000,
    deadlineAt: 46_000,
    revision: 0,
    initialPositions: {
      'piece-red': { x: 1, y: 1 },
      'piece-blue': { x: 8, y: 8 },
    },
  }
  recordBattleInitialization(state, new RuleRuntime({ rootSeed: 109 }), ['player-red', 'player-blue'])
  return {
    id: 'red109-authority-v2',
    name: 'RED-109 authority v2',
    status: 'in-progress',
    players: [
      { id: 'player-red', name: 'Red', seat: 'red', alignment: 'light' },
      { id: 'player-blue', name: 'Blue', seat: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 9,
    battleAuthorityVersion: 1,
    battleAuthorityTransitionHash: 'a'.repeat(64),
    battleState: { type: 'server-state', seed: 109, state } as any,
  }
}
