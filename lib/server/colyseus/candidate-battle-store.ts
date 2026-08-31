import { hashPublicBattleState } from '@/lib/game/battle-public-patch'
import { hashBattleState } from '@/lib/game/battle-runner'
import { getBattleStorage } from '@/lib/game/battle-storage'
import {
  type DeploymentRoomStore,
} from '@/lib/game/room-battle-actions'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import {
  createBattleAuthorityGenesisHash,
  type BattleAuthorityCheckpointRecord,
  type BattleAuthorityReceipt,
  type BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import { toPublicBattleState } from '@/lib/game/deployment'
import type { Room } from '@/lib/game/room-store'
import type { BattleState } from '@/lib/game/turn'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'
import type { RestoredPostgresAuthorityRoom } from '@/lib/server/postgres/authority-types'

export type BattleRoomFixtureFactory = (roomId: string) => Room | Promise<Room>

export interface CandidateAuthorityRepository {
  restoreRoom(roomId: string): Promise<RestoredPostgresAuthorityRoom | undefined>
  initializeRoom(room: Room, checkpoint: BattleAuthorityCheckpointRecord, epoch?: number): Promise<void>
}

export class CandidateBattleStore implements DeploymentRoomStore {
  private readonly receipts = new Map<string, BattleAuthorityReceipt>()
  private readonly transitions: BattleAuthorityTransitionRecord[]

  private constructor(
    private room: Room,
    readonly epoch: number,
    private readonly repository: CandidateAuthorityRepository,
    private readonly journal: PostgresAuthorityJournal,
    receipts: BattleAuthorityReceipt[],
    transitions: BattleAuthorityTransitionRecord[],
  ) {
    for (const receipt of receipts) this.receipts.set(receipt.clientActionId, structuredClone(receipt))
    this.transitions = structuredClone(transitions)
  }

  static async open(input: {
    roomId: string
    repository: CandidateAuthorityRepository
    journal: PostgresAuthorityJournal
    fixtureFactory: BattleRoomFixtureFactory
  }): Promise<CandidateBattleStore> {
    const roomId = normalizeRoomId(input.roomId)
    const restored = await input.repository.restoreRoom(roomId)
    if (restored) {
      input.journal.registerRoom(roomId, restored.durableAuthorityVersion)
      return new CandidateBattleStore(
        restored.room,
        restored.epoch,
        input.repository,
        input.journal,
        restored.receipts,
        restored.transitions,
      )
    }

    const fixture = structuredClone(await input.fixtureFactory(roomId))
    fixture.id = roomId
    fixture.battleAuthorityVersion = 0
    fixture.battleAuthorityDurableVersion = 0
    fixture.battleAuthorityPersistenceStatus = 'durable'
    const checkpoint = createInitialCheckpoint(fixture)
    fixture.battleAuthorityTransitionHash = checkpoint.transitionHash
    await input.repository.initializeRoom(fixture, checkpoint)
    input.journal.registerRoom(roomId, 0)
    return new CandidateBattleStore(fixture, 1, input.repository, input.journal, [], [])
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    return normalizeRoomId(roomId) === this.room.id ? structuredClone(this.room) : undefined
  }

  async setRoom(roomId: string, room: Room): Promise<void> {
    if (normalizeRoomId(roomId) !== this.room.id) throw new Error('Candidate room mismatch')
    this.room = structuredClone(room)
  }

  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    if (normalizeRoomId(roomId) !== this.room.id || Number(this.room.version ?? 0) !== expectedVersion) return false
    this.room = { ...structuredClone(room), version: expectedVersion + 1 }
    return true
  }

  async getBattleAuthorityReceipt(
    roomId: string,
    clientActionId: string,
  ): Promise<BattleAuthorityReceipt | undefined> {
    if (normalizeRoomId(roomId) !== this.room.id) return undefined
    const receipt = this.receipts.get(clientActionId)
    return receipt ? structuredClone(receipt) : undefined
  }

  async persistBattleAuthorityReceipt(receipt: BattleAuthorityReceipt): Promise<void> {
    if (receipt.roomId !== this.room.id) throw new Error('Candidate receipt room mismatch')
    this.receipts.set(receipt.clientActionId, structuredClone(receipt))
  }

  async commitBattleAuthorityTransition(input: {
    roomId: string
    expectedVersion: number
    nextRoom: Room
    transition: BattleAuthorityTransitionRecord
    transitionPreStateHash: string
    runnerPreStateHash: string
    runnerPostStateHash: string
    baseCheckpoint?: BattleAuthorityCheckpointRecord
    checkpoint?: BattleAuthorityCheckpointRecord
  }): Promise<boolean> {
    const roomId = normalizeRoomId(input.roomId)
    if (
      roomId !== this.room.id
      || Number(this.room.battleAuthorityVersion ?? 0) !== input.expectedVersion
    ) return false
    const durableRoom = {
      ...structuredClone(input.nextRoom),
      battleAuthorityVersion: input.transition.toVersion,
      battleAuthorityTransitionHash: input.transition.transitionHash,
    }
    const reservation = this.journal.reserve({
      roomId,
      epoch: this.epoch,
      nextRoom: durableRoom,
      transition: input.transition,
      baseCheckpoint: input.baseCheckpoint,
      checkpoint: input.checkpoint,
    })
    try {
      const terminalPending = input.checkpoint?.reason === 'terminal'
      this.room = {
        ...durableRoom,
        ...(terminalPending ? { status: 'in-progress' as const } : {}),
        battleAuthorityDurableVersion: this.journal.inspect(roomId).durableAuthorityVersion,
        battleAuthorityPersistenceStatus: 'pending',
      }
      this.receipts.set(input.transition.clientActionId, structuredClone(input.transition.receipt))
      this.transitions.push(structuredClone(input.transition))
      this.journal.commit(reservation)
      return true
    } catch (error) {
      this.journal.cancel(reservation)
      throw error
    }
  }

  async readBattleAuthorityHistory(): Promise<Array<{
    trace?: BattleAuthorityTransitionRecord['traces'][number]
    command?: Record<string, unknown>
    replayFrame?: BattleAuthorityTransitionRecord['replayFrames'][number]
  }>> {
    return this.transitions.flatMap(transition => transition.commands.map((command, index) => ({
      command: structuredClone(command) as unknown as Record<string, unknown>,
      trace: transition.traces[index] ? structuredClone(transition.traces[index]) : undefined,
      replayFrame: transition.replayFrames[index] ? structuredClone(transition.replayFrames[index]) : undefined,
    })))
  }

  inspectBattleAuthorityPersistence() {
    return this.journal.inspect(this.room.id)
  }

  async drainBattleAuthorityPersistence(roomId = this.room.id): Promise<void> {
    const normalized = normalizeRoomId(roomId)
    try {
      await this.journal.drain(normalized)
    } catch (error) {
      this.room = {
        ...this.room,
        battleAuthorityPersistenceStatus: 'degraded',
      }
      throw error
    }
    const inspection = this.journal.inspect(normalized)
    this.room = {
      ...this.room,
      battleAuthorityDurableVersion: inspection.durableAuthorityVersion,
      battleAuthorityPersistenceStatus: inspection.status,
      ...((getBattleStorage(this.room)?.state as BattleState | undefined)?.terminalResult
        ? { status: 'finished' as const }
        : {}),
    }
  }

  subscribeDurable(listener: (version: number) => void): () => void {
    return this.journal.subscribe(this.room.id, version => {
      this.room = {
        ...this.room,
        battleAuthorityDurableVersion: version,
        battleAuthorityPersistenceStatus: version >= Number(this.room.battleAuthorityVersion ?? 0)
          ? 'durable'
          : 'pending',
      }
      listener(version)
    })
  }
}

function createInitialCheckpoint(room: Room): BattleAuthorityCheckpointRecord {
  const storage = getBattleStorage(room)
  if (!storage) throw new Error(`Candidate room ${room.id} has no battle state`)
  const state = storage.state as BattleState
  const stateHash = hashBattleState(state)
  const publicHash = hashPublicBattleState(toPublicBattleState(state))
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    roomId: room.id,
    authorityVersion: 0,
    seed: storage.rootSeed,
    storage: structuredClone(storage),
    stateHash,
    publicHash,
    transitionHash: createBattleAuthorityGenesisHash({ roomId: room.id, stateHash, publicHash }),
    reason: 'initial',
    createdAt: Date.now(),
  }
}

function normalizeRoomId(roomId: string): string {
  const normalized = String(roomId ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('roomId is required')
  return normalized
}
