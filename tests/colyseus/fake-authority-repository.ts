import type { BattleAuthorityCheckpointRecord, BattleAuthorityReceipt, BattleAuthorityTransitionRecord } from '@/lib/game/battle-transition'
import type { Room } from '@/lib/game/room-model'
import type { PostgresAuthorityTransitionJob, RestoredPostgresAuthorityRoom } from '@/lib/server/postgres/authority-types'
import type { BattleServerRepository } from '@/lib/server/colyseus/create-colyseus-server'

export class FakeAuthorityRepository implements BattleServerRepository {
  readonly batches: PostgresAuthorityTransitionJob[][] = []
  beforeCommit?: () => Promise<void>
  failRoomId?: string
  private readonly rooms = new Map<string, {
    room: Room
    epoch: number
    durable: number
    receipts: BattleAuthorityReceipt[]
    transitions: BattleAuthorityTransitionRecord[]
  }>()

  async initializeSchema(): Promise<void> {}
  async healthCheck(): Promise<void> {}
  async close(): Promise<void> {}

  async listRestorableRoomIds(): Promise<string[]> {
    return [...this.rooms.entries()]
      .filter(([, value]) => value.room.status !== 'finished')
      .map(([roomId]) => roomId)
      .sort()
  }

  async initializeRoom(
    room: Room,
    _checkpoint: BattleAuthorityCheckpointRecord,
    epoch = 1,
  ): Promise<void> {
    const roomId = normalizeRoomId(room.id)
    if (this.rooms.has(roomId)) return
    this.rooms.set(roomId, {
      room: {
        ...structuredClone(room),
        id: roomId,
        battleAuthorityVersion: 0,
        battleAuthorityDurableVersion: 0,
        battleAuthorityPersistenceStatus: 'durable',
      },
      epoch,
      durable: 0,
      receipts: [],
      transitions: [],
    })
  }

  async restoreRoom(roomId: string): Promise<RestoredPostgresAuthorityRoom | undefined> {
    const value = this.rooms.get(normalizeRoomId(roomId))
    if (!value) return undefined
    return {
      room: structuredClone(value.room),
      epoch: value.epoch,
      durableAuthorityVersion: value.durable,
      receipts: structuredClone(value.receipts),
      transitions: structuredClone(value.transitions),
    }
  }

  async commitTransitionBatch(
    roomId: string,
    jobs: readonly PostgresAuthorityTransitionJob[],
  ): Promise<number> {
    roomId = normalizeRoomId(roomId)
    await this.beforeCommit?.()
    if (this.failRoomId === roomId) throw new Error(`simulated PostgreSQL failure for ${roomId}`)
    const value = this.rooms.get(roomId)
    if (!value) throw new Error(`fake authority room ${roomId} missing`)
    const first = jobs[0]
    const last = jobs[jobs.length - 1]
    if (first.transition.fromVersion !== value.durable) {
      if (last.transition.toVersion === value.durable) return value.durable
      throw new Error(`fake authority version gap for ${roomId}`)
    }
    this.batches.push(structuredClone([...jobs]))
    for (const job of jobs) {
      value.transitions.push(structuredClone(job.transition))
      value.receipts.push(structuredClone(job.transition.receipt))
    }
    value.room = {
      ...structuredClone(last.nextRoom),
      battleAuthorityVersion: last.transition.toVersion,
      battleAuthorityDurableVersion: last.transition.toVersion,
      battleAuthorityPersistenceStatus: 'durable',
    }
    value.durable = last.transition.toVersion
    return value.durable
  }
}

function normalizeRoomId(roomId: string): string {
  return String(roomId ?? '').trim().toLowerCase()
}
