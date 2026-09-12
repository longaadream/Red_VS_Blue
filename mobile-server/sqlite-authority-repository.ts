import { Worker } from 'node:worker_threads'
import type { AdventureRepository } from '../lib/server/colyseus/adventure-store'
import type { BattleServerRepository } from '../lib/server/colyseus/create-colyseus-server'
import type { Room } from '../lib/game/room-model'
import type { BattleAuthorityCheckpointRecord } from '../lib/game/battle-transition'
import type { PostgresAuthorityTransitionJob, RestoredPostgresAuthorityRoom } from '../lib/server/postgres/authority-types'

export class AndroidSqliteAuthorityRepository implements BattleServerRepository {
  private worker: Worker
  private sequence = 0
  private failed?: Error
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  constructor(databasePath: string, workerPath: string) {
    this.worker = new Worker(workerPath, { workerData: { databasePath } })
    this.worker.on('message', result => {
      const request = this.pending.get(result.id)
      if (!request) return
      this.pending.delete(result.id)
      if (result.error) request.reject(new Error(result.error)); else request.resolve(result.value)
    })
    const fail = (error: Error) => {
      this.failed = error
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.worker.on('exit', code => fail(new Error('Android SQLite worker stopped: ' + code)))
  }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.failed) return Promise.reject(this.failed)
    if (this.pending.size >= 128) return Promise.reject(new Error('Android SQLite queue full'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.worker.postMessage({ id, method, args })
    })
  }
  initializeSchema() { return this.call<void>('initializeSchema') }
  adventureRepository(): AdventureRepository {
    return {
      initialize: () => this.call('adventure.initialize'),
      create: (...args) => this.call('adventure.create', ...args),
      get: (...args) => this.call('adventure.get', ...args),
      list: (...args) => this.call('adventure.list', ...args),
      commit: (...args) => this.call('adventure.commit', ...args),
      receipt: (...args) => this.call('adventure.receipt', ...args),
      save: (...args) => this.call('adventure.save', ...args),
    }
  }
  healthCheck() { return this.call<void>('healthCheck') }
  initializeRoom(room: Room, checkpoint: BattleAuthorityCheckpointRecord, epoch = 1) { return this.call<void>('initializeRoom', room, checkpoint, epoch) }
  commitTransitionBatch(id: string, jobs: readonly PostgresAuthorityTransitionJob[]) { return this.call<number>('commitTransitionBatch', id, jobs) }
  restoreRoom(id: string) { return this.call<RestoredPostgresAuthorityRoom | undefined>('restoreRoom', id) }
  async listRestorableRoomIds(): Promise<string[]> { return [] }
  async close() { try { await this.call('close') } finally { await this.worker.terminate() } }
}
