import type { PostgresAuthorityBatchWriter, PostgresAuthorityTransitionJob } from './authority-types'

export interface PostgresAuthorityJournalOptions {
  maxBatchSize?: number
  maxDwellMs?: number
  maxPendingPerRoom?: number
  maxPendingGlobal?: number
  maxAttempts?: number
  retryDelaysMs?: number[]
}

export interface PostgresAuthorityJournalInspection {
  status: 'durable' | 'pending' | 'degraded'
  durableAuthorityVersion: number
  authorityVersion: number
  pending: number
  reserved: number
  oldestAgeMs: number
  flushCount: number
  committedTransitions: number
  lastBatchSize: number
  lastCommitMs: number
  lastError?: string
}

export interface PostgresAuthorityReservation {
  readonly roomId: string
  readonly job: PostgresAuthorityTransitionJob
  state: 'reserved' | 'committed' | 'cancelled'
}

interface Waiter {
  version: number
  resolve: () => void
  reject: (error: Error) => void
}

interface QueuedJob {
  job: PostgresAuthorityTransitionJob
  enqueuedAt: number
}

interface RoomJournalState {
  durableAuthorityVersion: number
  authorityVersion: number
  reserved: number
  queue: QueuedJob[]
  flushing: boolean
  flushTimer?: ReturnType<typeof setTimeout>
  degradedError?: Error
  waiters: Waiter[]
  listeners: Set<(version: number) => void>
  flushCount: number
  committedTransitions: number
  lastBatchSize: number
  lastCommitMs: number
}

export class PostgresAuthorityJournal {
  private readonly rooms = new Map<string, RoomJournalState>()
  private readonly maxBatchSize: number
  private readonly maxDwellMs: number
  private readonly maxPendingPerRoom: number
  private readonly maxPendingGlobal: number
  private readonly maxAttempts: number
  private readonly retryDelaysMs: number[]
  private pendingGlobal = 0
  private reservedGlobal = 0
  private closed = false
  private closePromise?: Promise<void>
  private readonly reservationSettledWaiters: Array<() => void> = []

  constructor(
    private readonly writer: PostgresAuthorityBatchWriter,
    options: PostgresAuthorityJournalOptions = {},
  ) {
    this.maxBatchSize = positiveInteger(options.maxBatchSize ?? 8, 'maxBatchSize')
    this.maxDwellMs = nonNegativeInteger(options.maxDwellMs ?? 25, 'maxDwellMs')
    this.maxPendingPerRoom = positiveInteger(options.maxPendingPerRoom ?? 128, 'maxPendingPerRoom')
    this.maxPendingGlobal = positiveInteger(options.maxPendingGlobal ?? 4096, 'maxPendingGlobal')
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, 'maxAttempts')
    this.retryDelaysMs = options.retryDelaysMs ?? [10, 50]
  }

  registerRoom(roomId: string, durableAuthorityVersion: number): void {
    if (this.closed) throw journalError('POSTGRES_AUTHORITY_JOURNAL_CLOSED', 'PostgreSQL authority journal is closed')
    const normalized = normalizeRoomId(roomId)
    const version = authorityVersion(durableAuthorityVersion)
    const existing = this.rooms.get(normalized)
    if (existing) {
      if (existing.queue.length > 0 || existing.flushing || existing.reserved > 0) {
        throw new Error(`Cannot re-register active PostgreSQL journal room ${normalized}`)
      }
      existing.durableAuthorityVersion = version
      existing.authorityVersion = version
      delete existing.degradedError
      return
    }
    this.rooms.set(normalized, {
      durableAuthorityVersion: version,
      authorityVersion: version,
      reserved: 0,
      queue: [],
      flushing: false,
      waiters: [],
      listeners: new Set(),
      flushCount: 0,
      committedTransitions: 0,
      lastBatchSize: 0,
      lastCommitMs: 0,
    })
  }

  reserve(job: PostgresAuthorityTransitionJob): PostgresAuthorityReservation {
    if (this.closed) throw journalError('POSTGRES_AUTHORITY_JOURNAL_CLOSED', 'PostgreSQL authority journal is closed')
    const state = this.requireRoom(job.roomId)
    if (state.degradedError) throw state.degradedError
    const roomLoad = state.queue.length + state.reserved
    if (roomLoad >= this.maxPendingPerRoom || this.pendingGlobal + this.reservedGlobal >= this.maxPendingGlobal) {
      throw journalError(
        'POSTGRES_AUTHORITY_BACKPRESSURE',
        `PostgreSQL authority journal capacity is exhausted for ${job.roomId}`,
      )
    }
    if (job.transition.fromVersion !== state.authorityVersion + state.reserved) {
      throw journalError(
        'POSTGRES_AUTHORITY_VERSION_GAP',
        `PostgreSQL authority reservation expected ${state.authorityVersion + state.reserved}, got ${job.transition.fromVersion}`,
      )
    }
    state.reserved += 1
    this.reservedGlobal += 1
    return { roomId: normalizeRoomId(job.roomId), job: structuredClone(job), state: 'reserved' }
  }

  commit(reservation: PostgresAuthorityReservation): void {
    if (reservation.state !== 'reserved') throw new Error('PostgreSQL authority reservation is not active')
    const state = this.requireRoom(reservation.roomId)
    state.reserved -= 1
    this.reservedGlobal -= 1
    this.resolveReservationSettledWaiters()
    state.queue.push({ job: reservation.job, enqueuedAt: performance.now() })
    state.authorityVersion = reservation.job.transition.toVersion
    this.pendingGlobal += 1
    reservation.state = 'committed'
    this.schedule(reservation.roomId, state)
  }

  cancel(reservation: PostgresAuthorityReservation): void {
    if (reservation.state !== 'reserved') return
    const state = this.requireRoom(reservation.roomId)
    state.reserved -= 1
    this.reservedGlobal -= 1
    this.resolveReservationSettledWaiters()
    reservation.state = 'cancelled'
  }

  subscribe(roomId: string, listener: (version: number) => void): () => void {
    const state = this.requireRoom(roomId)
    state.listeners.add(listener)
    return () => state.listeners.delete(listener)
  }

  inspect(roomId: string): PostgresAuthorityJournalInspection {
    const state = this.requireRoom(roomId)
    const pending = state.queue.length + (state.flushing ? 0 : 0)
    return {
      status: state.degradedError ? 'degraded' : pending > 0 || state.reserved > 0 ? 'pending' : 'durable',
      durableAuthorityVersion: state.durableAuthorityVersion,
      authorityVersion: state.authorityVersion,
      pending,
      reserved: state.reserved,
      oldestAgeMs: state.queue[0] ? Math.max(0, performance.now() - state.queue[0].enqueuedAt) : 0,
      flushCount: state.flushCount,
      committedTransitions: state.committedTransitions,
      lastBatchSize: state.lastBatchSize,
      lastCommitMs: state.lastCommitMs,
      ...(state.degradedError ? { lastError: state.degradedError.message } : {}),
    }
  }

  async waitForDurable(roomId: string, version: number): Promise<void> {
    const state = this.requireRoom(roomId)
    const target = authorityVersion(version)
    if (state.durableAuthorityVersion >= target) return
    if (state.degradedError) throw state.degradedError
    await new Promise<void>((resolve, reject) => state.waiters.push({ version: target, resolve, reject }))
  }

  async drain(roomId: string): Promise<void> {
    const normalized = normalizeRoomId(roomId)
    const state = this.requireRoom(normalized)
    if (state.degradedError) throw state.degradedError
    const target = state.authorityVersion
    if (state.queue.length > 0 && !state.flushing) void this.flush(normalized, state)
    await this.waitForDurable(normalized, target)
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      if (this.reservedGlobal > 0) {
        await new Promise<void>(resolve => this.reservationSettledWaiters.push(resolve))
      }
      await Promise.all([...this.rooms.keys()].map(roomId => this.drain(roomId)))
    })()
    return this.closePromise
  }

  private resolveReservationSettledWaiters(): void {
    if (this.reservedGlobal !== 0) return
    for (const resolve of this.reservationSettledWaiters.splice(0)) resolve()
  }

  private schedule(roomId: string, state: RoomJournalState): void {
    if (state.flushing || state.degradedError) return
    if (state.queue.length >= this.maxBatchSize) {
      if (state.flushTimer) clearTimeout(state.flushTimer)
      delete state.flushTimer
      queueMicrotask(() => void this.flush(roomId, state))
      return
    }
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        delete state.flushTimer
        void this.flush(roomId, state)
      }, this.maxDwellMs)
    }
  }

  private async flush(roomId: string, state: RoomJournalState): Promise<void> {
    if (state.flushing || state.degradedError || state.queue.length === 0) return
    if (state.flushTimer) clearTimeout(state.flushTimer)
    delete state.flushTimer
    state.flushing = true
    const batch = state.queue.slice(0, this.maxBatchSize)
    const startedAt = performance.now()
    try {
      const durable = await this.writeWithRetry(roomId, batch.map(item => item.job))
      if (durable !== batch[batch.length - 1].job.transition.toVersion) {
        throw new Error(`PostgreSQL writer returned an invalid durable watermark for ${roomId}`)
      }
      state.queue.splice(0, batch.length)
      this.pendingGlobal -= batch.length
      state.durableAuthorityVersion = durable
      state.flushCount += 1
      state.committedTransitions += batch.length
      state.lastBatchSize = batch.length
      state.lastCommitMs = performance.now() - startedAt
      this.resolveWaiters(state)
      for (const listener of state.listeners) listener(durable)
    } catch (error) {
      const failure = journalError(
        'POSTGRES_AUTHORITY_DEGRADED',
        `PostgreSQL authority persistence degraded for ${roomId}: ${errorMessage(error)}`,
      )
      state.degradedError = failure
      for (const waiter of state.waiters.splice(0)) waiter.reject(failure)
    } finally {
      state.flushing = false
      if (!state.degradedError && state.queue.length > 0) {
        if (state.queue.length >= this.maxBatchSize) queueMicrotask(() => void this.flush(roomId, state))
        else this.schedule(roomId, state)
      }
    }
  }

  private async writeWithRetry(
    roomId: string,
    jobs: readonly PostgresAuthorityTransitionJob[],
  ): Promise<number> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.writer.commitTransitionBatch(roomId, jobs)
      } catch (error) {
        lastError = error
        if (attempt < this.maxAttempts) {
          const delay = this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 0
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    throw lastError
  }

  private resolveWaiters(state: RoomJournalState): void {
    const pending: Waiter[] = []
    for (const waiter of state.waiters) {
      if (waiter.version <= state.durableAuthorityVersion) waiter.resolve()
      else pending.push(waiter)
    }
    state.waiters = pending
  }

  private requireRoom(roomId: string): RoomJournalState {
    const normalized = normalizeRoomId(roomId)
    const state = this.rooms.get(normalized)
    if (!state) throw new Error(`PostgreSQL authority journal room ${normalized} is not registered`)
    return state
  }
}

function journalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function authorityVersion(value: number): number {
  return nonNegativeInteger(value, 'authorityVersion')
}

function normalizeRoomId(roomId: string): string {
  const normalized = String(roomId ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('roomId is required')
  return normalized
}
