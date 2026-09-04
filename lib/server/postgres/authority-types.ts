import type {
  BattleAuthorityCheckpointRecord,
  BattleAuthorityReceipt,
  BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import type { Player, Room } from '@/lib/game/room-model'

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

export interface PostgresBattleReportV1 {
  schemaVersion: 'rvb-postgres-battle-report/v1'
  verified: true
  battleId: string
  room: {
    id: string
    name: string
    mapId?: string
    createdAt?: number
    players: Array<Pick<Player, 'id' | 'accountId' | 'name' | 'seat' | 'alignment'>>
  }
  authority: {
    authorityVersion: number
    durableAuthorityVersion: number
    stateHash: string
    publicHash: string
    transitionHash: string
  }
  terminal: {
    committedAt: string
    checkpoint: BattleAuthorityCheckpointRecord
  }
  receipts: BattleAuthorityReceipt[]
  transitions: BattleAuthorityTransitionRecord[]
}

export interface PostgresBattleReportReader {
  readBattleReport(battleId: string): Promise<PostgresBattleReportV1 | undefined>
  listBattleReports(playerId: string, limit?: number): Promise<PostgresBattleReportSummaryV1[]>
}

export interface PostgresBattleReportSummaryV1 {
  battleId: string
  name: string
  mapId?: string
  createdAt?: number
  committedAt: string
  authorityVersion: number
  transitionHash: string
  players: PostgresBattleReportV1['room']['players']
  terminalResult?: unknown
}
