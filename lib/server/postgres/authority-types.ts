import type { BattleAuthorityCheckpointRecord, BattleAuthorityTransitionRecord } from '@/lib/game/battle-transition'
import type { Room } from '@/lib/game/room-store'

export interface PostgresAuthorityTransitionJob {
  roomId: string
  epoch: number
  nextRoom: Room
  transition: BattleAuthorityTransitionRecord
  baseCheckpoint?: BattleAuthorityCheckpointRecord
  checkpoint?: BattleAuthorityCheckpointRecord
}

export interface RestoredPostgresAuthorityRoom {
  room: Room
  epoch: number
  durableAuthorityVersion: number
  receipts: BattleAuthorityTransitionRecord['receipt'][]
  transitions: BattleAuthorityTransitionRecord[]
}

export interface PostgresAuthorityBatchWriter {
  commitTransitionBatch(
    roomId: string,
    jobs: readonly PostgresAuthorityTransitionJob[],
  ): Promise<number>
}
