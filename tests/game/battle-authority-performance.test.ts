/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { recordBattleInitialization } from '@/lib/game/battle-trace'
import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import {
  dispatchRoomBattleAction,
  type DeploymentRoomStore,
} from '@/lib/game/room-battle-actions'
import type { Room } from '@/lib/game/room-store'
import type {
  BattleAuthorityCheckpointRecord,
  BattleAuthorityReceipt,
  BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'
import { createTestServerBattleState, pinTestBattleState } from './profile-test-identity'

const PLAYERS = ['player-red', 'player-blue'] as const
const ROOT_SEED = 0x52454431
const originalAuthorityV2Flag = process.env.RVB_BATTLE_AUTHORITY_V2
beforeAll(() => { process.env.RVB_BATTLE_AUTHORITY_V2 = '1' })
afterAll(() => {
  if (originalAuthorityV2Flag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
  else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthorityV2Flag
})
const TRANSITION_COUNT = 100

interface LegacySample {
  index: number
  ruleMs: number
  dispatchMs: number
  dbSerializeMs: number
  publicHashMs: number
  broadcastSerializeMs: number
  dbPayloadBytes: number
  snapshotBytes: number
  stateBytes: number
}

interface CandidateSample {
  index: number
  dispatchMs: number
  persistenceMs: number
  persistenceBytes: number
  publicPatchBytes: number
}

class InstrumentedMemoryRoomStore implements DeploymentRoomStore {
  room: Room
  writes = 0
  lastDbSerializeMs = 0
  lastDbPayloadBytes = 0

  constructor(room: Room) {
    this.room = clone(room)
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    return this.room.id === roomId ? clone(this.room) : undefined
  }

  async setRoom(_roomId: string, room: Room): Promise<void> {
    this.commit(room, (this.room.version ?? 0) + 1)
  }

  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    if (roomId !== this.room.id || this.room.version !== expectedVersion) return false
    this.commit(room, expectedVersion + 1)
    return true
  }

  private commit(room: Room, nextVersion: number): void {
    const startedAt = performance.now()
    const payload = serializeLegacyRoomPayload(room)
    this.lastDbPayloadBytes = Buffer.byteLength(payload)
    const stored = JSON.parse(payload) as Room
    this.lastDbSerializeMs = performance.now() - startedAt
    this.room = { ...stored, version: nextVersion }
    this.writes += 1
  }
}

class InstrumentedAuthorityV2Store implements DeploymentRoomStore {
  room: Room
  writes = 0
  lastPersistenceMs = 0
  lastPersistenceBytes = 0
  readonly receipts = new Map<string, BattleAuthorityReceipt>()
  readonly transitions: BattleAuthorityTransitionRecord[] = []

  constructor(room: Room) {
    this.room = clone(room)
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    return this.room.id === roomId ? clone(this.room) : undefined
  }

  async setRoom(_roomId: string, room: Room): Promise<void> {
    this.room = clone(room)
  }

  async setRoomIfVersion(): Promise<boolean> {
    throw new Error('RED-109 v2 benchmark must not use legacy room CAS')
  }

  async getBattleAuthorityReceipt(roomId: string, clientActionId: string): Promise<BattleAuthorityReceipt | undefined> {
    return this.receipts.get(`${roomId}:${clientActionId}`)
  }

  async persistBattleAuthorityReceipt(receipt: BattleAuthorityReceipt): Promise<void> {
    this.receipts.set(`${receipt.roomId}:${receipt.clientActionId}`, clone(receipt))
  }

  async commitBattleAuthorityTransition(input: {
    roomId: string
    expectedVersion: number
    nextRoom: Room
    transition: BattleAuthorityTransitionRecord
    baseCheckpoint?: BattleAuthorityCheckpointRecord
    checkpoint?: BattleAuthorityCheckpointRecord
  }): Promise<boolean> {
    if (input.roomId !== this.room.id || this.room.battleAuthorityVersion !== input.expectedVersion) return false
    const startedAt = performance.now()
    const payload = JSON.stringify({
      transition: input.transition,
      baseCheckpoint: input.baseCheckpoint,
      receipt: input.transition.receipt,
      checkpoint: input.checkpoint,
    })
    this.lastPersistenceBytes = Buffer.byteLength(payload)
    JSON.parse(payload)
    this.lastPersistenceMs = performance.now() - startedAt
    this.transitions.push(clone(input.transition))
    this.receipts.set(
      `${input.transition.receipt.roomId}:${input.transition.receipt.clientActionId}`,
      clone(input.transition.receipt),
    )
    this.room = {
      ...clone(input.nextRoom),
      battleAuthorityVersion: input.transition.toVersion,
      battleAuthorityTransitionHash: input.transition.transitionHash,
    }
    this.writes += 1
    return true
  }
}

describe('RED-109 battle authority performance', () => {
  it('records the unchanged legacy 100-transition snapshot baseline', async () => {
    const store = new InstrumentedMemoryRoomStore(makeDeploymentRoom())
    const samples: LegacySample[] = []

    for (let index = 0; index < TRANSITION_COUNT; index += 1) {
      const state = clone((store.room.battleState as any).state) as BattleState
      const action: BattleAction = {
        type: 'deploymentChoice',
        playerId: PLAYERS[0],
        pieceId: index % 9 === 8 ? null : `piece-${(index % 8) + 1}`,
        clientActionId: `red109-legacy-${index + 1}`,
      }

      const ruleStartedAt = performance.now()
      runBattleAction(state, action, { rootSeed: ROOT_SEED })
      const ruleMs = performance.now() - ruleStartedAt

      const dispatchStartedAt = performance.now()
      const result = await dispatchRoomBattleAction(
        store,
        store.room.id,
        PLAYERS[0],
        action,
        { clock: { now: () => 2_000 } },
      )
      const dispatchMs = performance.now() - dispatchStartedAt

      const hashStartedAt = performance.now()
      hashBattleState(result.snapshot.state)
      const publicHashMs = performance.now() - hashStartedAt

      const broadcastStartedAt = performance.now()
      const snapshotJson = JSON.stringify(result.snapshot)
      const broadcastSerializeMs = performance.now() - broadcastStartedAt

      samples.push({
        index: index + 1,
        ruleMs,
        dispatchMs,
        dbSerializeMs: store.lastDbSerializeMs,
        publicHashMs,
        broadcastSerializeMs,
        dbPayloadBytes: store.lastDbPayloadBytes,
        snapshotBytes: Buffer.byteLength(snapshotJson),
        stateBytes: Buffer.byteLength(JSON.stringify(result.snapshot.state)),
      })
    }

    const report = {
      benchmark: 'RED-109 legacy full-snapshot authority baseline',
      architecture: 'legacy-full-state-cas-and-broadcast',
      baseSha: 'a7c1d57da7b025fb69c9c24a3a04d3c5797d6132',
      rootSeed: ROOT_SEED,
      transitions: TRANSITION_COUNT,
      diffStage: 'not-present-in-legacy-path',
      generatedAt: new Date().toISOString(),
      aggregate: {
        ruleMs: summarize(samples.map(sample => sample.ruleMs)),
        dispatchMs: summarize(samples.map(sample => sample.dispatchMs)),
        dbSerializeMs: summarize(samples.map(sample => sample.dbSerializeMs)),
        publicHashMs: summarize(samples.map(sample => sample.publicHashMs)),
        broadcastSerializeMs: summarize(samples.map(sample => sample.broadcastSerializeMs)),
        dbPayloadBytes: summarize(samples.map(sample => sample.dbPayloadBytes)),
        snapshotBytes: summarize(samples.map(sample => sample.snapshotBytes)),
        stateBytes: summarize(samples.map(sample => sample.stateBytes)),
      },
      growth: {
        first10MedianDispatchMs: median(samples.slice(0, 10).map(sample => sample.dispatchMs)),
        last10MedianDispatchMs: median(samples.slice(-10).map(sample => sample.dispatchMs)),
        firstDbPayloadBytes: samples[0]?.dbPayloadBytes ?? 0,
        lastDbPayloadBytes: samples.at(-1)?.dbPayloadBytes ?? 0,
        firstSnapshotBytes: samples[0]?.snapshotBytes ?? 0,
        lastSnapshotBytes: samples.at(-1)?.snapshotBytes ?? 0,
      },
      samples,
    }

    const outputPath = resolve('.tmp-red109/legacy-authority-benchmark.json')
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.info(`RED109_LEGACY_BENCHMARK ${JSON.stringify(report.aggregate)}`)

    expect(store.writes).toBe(TRANSITION_COUNT)
    expect(store.room.version).toBe(TRANSITION_COUNT + 1)
    expect(samples).toHaveLength(TRANSITION_COUNT)
    expect(report.growth.lastSnapshotBytes).toBeGreaterThan(report.growth.firstSnapshotBytes)
  }, 120_000)

  it('records the candidate transition-journal benchmark and enforces the payload target', async () => {
    const store = new InstrumentedAuthorityV2Store(makeDeploymentRoom('red109-candidate-benchmark'))
    const samples: CandidateSample[] = []

    for (let index = 0; index < TRANSITION_COUNT; index += 1) {
      const action: BattleAction = {
        type: 'deploymentChoice',
        playerId: PLAYERS[0],
        pieceId: index % 9 === 8 ? null : `piece-${(index % 8) + 1}`,
        clientActionId: `red109-candidate-${index + 1}`,
      }
      const dispatchStartedAt = performance.now()
      const result = await dispatchRoomBattleAction(
        store,
        store.room.id,
        PLAYERS[0],
        action,
        {
          clock: { now: () => 2_000 },
          expectedAuthorityVersion: store.room.battleAuthorityVersion,
        },
      )
      const dispatchMs = performance.now() - dispatchStartedAt
      expect(result.transition).toBeDefined()
      samples.push({
        index: index + 1,
        dispatchMs,
        persistenceMs: store.lastPersistenceMs,
        persistenceBytes: store.lastPersistenceBytes,
        publicPatchBytes: Buffer.byteLength(JSON.stringify(result.transition?.publicPatch ?? [])),
      })
    }

    const report = {
      benchmark: 'RED-109 transition-journal authority candidate',
      architecture: 'room-fifo-transition-receipt-checkpoint',
      baseSha: 'a7c1d57da7b025fb69c9c24a3a04d3c5797d6132',
      rootSeed: ROOT_SEED,
      transitions: TRANSITION_COUNT,
      generatedAt: new Date().toISOString(),
      aggregate: {
        dispatchMs: summarize(samples.map(sample => sample.dispatchMs)),
        persistenceMs: summarize(samples.map(sample => sample.persistenceMs)),
        persistenceBytes: summarize(samples.map(sample => sample.persistenceBytes)),
        publicPatchBytes: summarize(samples.map(sample => sample.publicPatchBytes)),
      },
      growth: {
        first10MedianDispatchMs: median(samples.slice(0, 10).map(sample => sample.dispatchMs)),
        last10MedianDispatchMs: median(samples.slice(-10).map(sample => sample.dispatchMs)),
      },
      samples,
    }

    const outputPath = resolve('.tmp-red109/candidate-authority-benchmark.json')
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.info(`RED109_CANDIDATE_BENCHMARK ${JSON.stringify(report.aggregate)}`)

    expect(store.writes).toBe(TRANSITION_COUNT)
    expect(store.transitions).toHaveLength(TRANSITION_COUNT)
    expect(store.room.version).toBe(1)
    expect(store.room.battleAuthorityVersion).toBe(TRANSITION_COUNT + 1)
    expect(report.aggregate.persistenceBytes.p50).toBeLessThan(87_642)
    expect(report.growth.last10MedianDispatchMs).toBeLessThan(report.growth.first10MedianDispatchMs * 2)
  }, 120_000)
})

function makeDeploymentRoom(id = 'red109-legacy-benchmark'): Room {
  const pieces = Array.from({ length: 16 }, (_, index) => {
    const ownerPlayerId = index < 8 ? PLAYERS[0] : PLAYERS[1]
    return {
      ...makePiece({
        instanceId: `piece-${index + 1}`,
        ownerPlayerId,
        faction: index < 8 ? 'red' : 'blue',
        x: index % 6,
        y: Math.floor(index / 6),
      }),
      isCore: true,
    }
  })
  const state = makeState({ pieces: pieces as any, phase: 'start' }) as any
  state.gameStartFired = false
  state.deployment = {
    status: 'awaiting-locks',
    playerIds: [...PLAYERS],
    choices: {},
    locks: {
      [PLAYERS[0]]: { locked: false },
      [PLAYERS[1]]: { locked: false },
    },
    startedAt: 1_000,
    deadlineAt: 46_000,
    revision: 0,
    initialPositions: Object.fromEntries(pieces.map(piece => [
      piece.instanceId,
      { x: piece.x, y: piece.y },
    ])),
  }
  pinTestBattleState(state, ROOT_SEED)
  recordBattleInitialization(state, new RuleRuntime({ rootSeed: ROOT_SEED }), [...PLAYERS])

  return {
    id,
    name: id,
    status: 'in-progress',
    players: [
      { id: PLAYERS[0], name: 'Red', seat: 'red', alignment: 'light' },
      { id: PLAYERS[1], name: 'Blue', seat: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 1,
    battleAuthorityVersion: 1,
    battleAuthorityTransitionHash: 'a'.repeat(64),
    battleState: createTestServerBattleState(state, ROOT_SEED),
  }
}

function serializeLegacyRoomPayload(room: Room): string {
  return JSON.stringify({
    ...room,
    players: room.players.map(player => ({
      ...player,
      seat: player.seat || player.faction,
      faction: player.faction || player.seat,
      hasSelectedPieces: player.rosterLocked === true,
      selectedPieces: player.selectedPieces || [],
    })),
    spectators: room.spectators || [],
  }, (_key, value) => typeof value === 'function' ? undefined : value)
}

function summarize(values: number[]): Record<string, number> {
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  }
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index]
}

function median(values: number[]): number {
  return round(percentile(values, 0.5))
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
