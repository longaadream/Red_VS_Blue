import { validateServerBattleStateV1, type ServerBattleState } from '@/lib/game/battle-storage'
import type { BattleAuthorityCheckpointRecord } from '@/lib/game/battle-transition'
import type { Room } from '@/lib/game/room-store'
import type { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import {
  CandidateBattleStore,
  createInitialCheckpoint,
  type CandidateAuthorityRepository,
} from './candidate-battle-store'

/**
 * Holds only pre-battle admission state. Once version zero is committed it
 * delegates every RoomStore call to CandidateBattleStore, so setup and battle
 * can never become two live authority sources.
 */
export class ProductBattleStore {
  readonly terminalAuthorityPersistencePolicy = 'durable-barrier' as const
  private authorityStore?: CandidateBattleStore

  constructor(
    private room: Room,
    private readonly repository: CandidateAuthorityRepository,
    private readonly journal: PostgresAuthorityJournal,
  ) {}

  get authority(): CandidateBattleStore | undefined {
    return this.authorityStore
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    if (!this.matches(roomId)) return undefined
    if (this.authorityStore) return this.authorityStore.getRoom(roomId)
    return cloneRoomJson(this.room)
  }

  async setRoom(roomId: string, room: Room): Promise<void> {
    this.assertMatches(roomId)
    if (this.authorityStore) return this.authorityStore.setRoom(roomId, room)
    this.room = cloneRoomJson(room)
  }

  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    if (!this.matches(roomId)) return false
    if (this.authorityStore) {
      return this.authorityStore.setRoomIfVersion(roomId, room, expectedVersion)
    }
    if (Number(this.room.version ?? 0) !== expectedVersion) return false
    this.room = { ...cloneRoomJson(room), version: expectedVersion + 1 }
    return true
  }

  async initializeBattleAuthorityCheckpoint(input: {
    room: Room
    storage: ServerBattleState
    stateHash: string
    publicHash: string
  }): Promise<void> {
    this.assertMatches(input.room.id)
    if (this.authorityStore) return
    const checkpoint = createInitialCheckpoint(input.room)
    assertCheckpointMatches(input, checkpoint)
    await this.repository.initializeRoom(input.room, checkpoint)
    this.authorityStore = await CandidateBattleStore.open({
      roomId: input.room.id,
      repository: this.repository,
      journal: this.journal,
      fixtureFactory: () => input.room,
    })
    this.room = cloneRoomJson(await this.authorityStore.getRoom(input.room.id) ?? input.room)
  }

  async getBattleAuthorityReceipt(
    ...args: Parameters<CandidateBattleStore['getBattleAuthorityReceipt']>
  ): ReturnType<CandidateBattleStore['getBattleAuthorityReceipt']> {
    return this.requireAuthority().getBattleAuthorityReceipt(...args)
  }

  async persistBattleAuthorityReceipt(
    ...args: Parameters<CandidateBattleStore['persistBattleAuthorityReceipt']>
  ): ReturnType<CandidateBattleStore['persistBattleAuthorityReceipt']> {
    return this.requireAuthority().persistBattleAuthorityReceipt(...args)
  }

  async commitBattleAuthorityTransition(
    ...args: Parameters<CandidateBattleStore['commitBattleAuthorityTransition']>
  ): ReturnType<CandidateBattleStore['commitBattleAuthorityTransition']> {
    return this.requireAuthority().commitBattleAuthorityTransition(...args)
  }

  async readBattleAuthorityHistory(): ReturnType<CandidateBattleStore['readBattleAuthorityHistory']> {
    return this.requireAuthority().readBattleAuthorityHistory()
  }

  inspectBattleAuthorityPersistence(): ReturnType<CandidateBattleStore['inspectBattleAuthorityPersistence']> {
    return this.requireAuthority().inspectBattleAuthorityPersistence()
  }

  async drainBattleAuthorityPersistence(
    ...args: Parameters<CandidateBattleStore['drainBattleAuthorityPersistence']>
  ): ReturnType<CandidateBattleStore['drainBattleAuthorityPersistence']> {
    return this.requireAuthority().drainBattleAuthorityPersistence(...args)
  }

  subscribeDurable(
    ...args: Parameters<CandidateBattleStore['subscribeDurable']>
  ): ReturnType<CandidateBattleStore['subscribeDurable']> {
    return this.requireAuthority().subscribeDurable(...args)
  }

  private matches(roomId: string): boolean {
    return normalizeId(roomId) === normalizeId(this.room.id)
  }

  private assertMatches(roomId: string): void {
    if (!this.matches(roomId)) throw new Error('Product battle room mismatch')
  }

  private requireAuthority(): CandidateBattleStore {
    if (!this.authorityStore) throw new Error('Product battle authority has not started')
    return this.authorityStore
  }
}

function assertCheckpointMatches(
  input: { storage: ServerBattleState; stateHash: string; publicHash: string },
  checkpoint: BattleAuthorityCheckpointRecord,
): void {
  if (checkpoint.stateHash !== input.stateHash || checkpoint.publicHash !== input.publicHash) {
    throw new Error('Product battle version-zero checkpoint hash mismatch')
  }
  if (checkpoint.storage.rootSeed !== input.storage.rootSeed) {
    throw new Error('Product battle version-zero checkpoint seed mismatch')
  }
}

function normalizeId(value: string): string {
  return String(value ?? '').trim().toLowerCase()
}

function cloneRoomJson(room: Room): Room {
  const cloned = JSON.parse(JSON.stringify(room, (_key, value) => (
    typeof value === 'function' ? undefined : value
  ))) as Room
  if (cloned.battleState) {
    validateServerBattleStateV1(cloned.battleState)
  }
  return cloned
}
