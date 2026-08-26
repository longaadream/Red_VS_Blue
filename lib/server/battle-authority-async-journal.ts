export type BattleAuthorityJournalStatus = 'durable' | 'pending' | 'degraded'

export interface BattleAuthorityJournalInspection {
  status: BattleAuthorityJournalStatus
  durableAuthorityVersion: number
  pending: number
  lastError?: string
}

export interface BattleAuthorityJournalJob {
  roomId: string
  kind: 'transition' | 'receipt' | 'checkpoint'
  authorityVersion?: number
  clientActionId?: string
  /**
   * Expensive integrity work that must remain serialized with persistence but
   * must not delay the command ACK. Audits are fail-closed and intentionally
   * never retried: retrying can only repeat deterministic CPU work.
   */
  audit?: () => void | Promise<void>
  persist: (context: BattleAuthorityJournalPersistContext) => Promise<void>
}

export interface BattleAuthorityJournalPersistContext {
  /**
   * Cooperative cancellation for adapters that can stop their underlying
   * write. Prisma uses a shorter database-native deadline; this signal is the
   * final journal safety fence.
   */
  signal: AbortSignal
  safetyTimeoutMs: number
}

export interface BattleAuthorityAsyncJournalOptions {
  maxPendingPerRoom?: number
  retryDelaysMs?: number[]
  persistTimeoutMs?: number
  onStateChange?: (roomId: string, state: BattleAuthorityJournalInspection) => void
}

interface RoomJournalState {
  durableAuthorityVersion: number
  pending: number
  degradedError?: Error
  waiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }>
}

/**
 * One non-blocking ingress with a single durable writer. Gameplay only calls
 * enqueue(); SQLite/Prisma work runs after the authoritative room operation
 * has returned. The single writer prevents background jobs from manufacturing
 * their own SQLite write-lock contention.
 */
export class BattleAuthorityAsyncJournal {
  private readonly rooms = new Map<string, RoomJournalState>()
  private readonly jobs: Array<BattleAuthorityJournalJob & { roomId: string }> = []
  private readonly maxPendingPerRoom: number
  private readonly retryDelaysMs: number[]
  private readonly persistTimeoutMs: number
  private readonly onStateChange?: BattleAuthorityAsyncJournalOptions['onStateChange']
  private running = false
  private scheduled = false
  private accepting = true
  private globalWaiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }> = []

  constructor(options: BattleAuthorityAsyncJournalOptions = {}) {
    const maxPendingPerRoom = options.maxPendingPerRoom ?? 256
    if (!Number.isSafeInteger(maxPendingPerRoom) || maxPendingPerRoom < 1) {
      throw new Error('maxPendingPerRoom must be a positive safe integer')
    }
    const retryDelaysMs = options.retryDelaysMs ?? [25, 100, 250]
    if (retryDelaysMs.some(delay => !Number.isFinite(delay) || delay < 0)) {
      throw new Error('retryDelaysMs must contain only non-negative finite values')
    }
    const persistTimeoutMs = options.persistTimeoutMs ?? 2_000
    if (!Number.isFinite(persistTimeoutMs) || persistTimeoutMs <= 0) {
      throw new Error('persistTimeoutMs must be a positive finite number')
    }
    this.maxPendingPerRoom = maxPendingPerRoom
    this.retryDelaysMs = [...retryDelaysMs]
    this.persistTimeoutMs = persistTimeoutMs
    this.onStateChange = options.onStateChange
  }

  enqueue(job: BattleAuthorityJournalJob): boolean {
    const roomId = normalizeRoomId(job.roomId)
    if (!this.accepting) return false
    const state = this.roomState(roomId)
    if (state.degradedError) return false
    if (state.pending >= this.maxPendingPerRoom) {
      this.degrade(roomId, new Error(
        `Battle authority journal pending limit ${this.maxPendingPerRoom} exceeded in ${roomId}`,
      ))
      return false
    }
    state.pending += 1
    this.jobs.push({ ...job, roomId })
    this.emit(roomId)
    this.scheduleRun()
    return true
  }

  closeIngress(): void {
    this.accepting = false
  }

  isAccepting(): boolean {
    return this.accepting
  }

  markDurable(roomId: string, authorityVersion: number): void {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 0) {
      throw new Error('authorityVersion must be a non-negative safe integer')
    }
    const state = this.roomState(normalizedRoomId)
    state.durableAuthorityVersion = Math.max(state.durableAuthorityVersion, authorityVersion)
    this.emit(normalizedRoomId)
  }

  inspect(roomId: string): BattleAuthorityJournalInspection {
    const state = this.rooms.get(normalizeRoomId(roomId))
    if (!state) {
      return { status: 'durable', durableAuthorityVersion: 0, pending: 0 }
    }
    return inspectionOf(state)
  }

  drain(roomId?: string): Promise<void> {
    if (roomId !== undefined) {
      const normalizedRoomId = normalizeRoomId(roomId)
      const state = this.roomState(normalizedRoomId)
      if (state.degradedError && state.pending === 0) return Promise.reject(state.degradedError)
      if (state.pending === 0) return Promise.resolve()
      return new Promise<void>((resolve, reject) => state.waiters.push({ resolve, reject }))
    }
    const degraded = [...this.rooms.values()].find(state => state.degradedError && state.pending === 0)
    if (!this.running && this.jobs.length === 0) {
      return degraded?.degradedError ? Promise.reject(degraded.degradedError) : Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => this.globalWaiters.push({ resolve, reject }))
  }

  forgetRoom(roomId: string): void {
    const normalizedRoomId = normalizeRoomId(roomId)
    const state = this.rooms.get(normalizedRoomId)
    if (state && state.pending > 0) {
      throw new Error(
        `Battle authority journal cannot forget ${normalizedRoomId} with ${state.pending} pending job(s)`,
      )
    }
    this.rooms.delete(normalizedRoomId)
  }

  private scheduleRun(): void {
    if (this.running || this.scheduled) return
    this.scheduled = true
    // Do not enter Prisma or serialize durable payloads in the command's ACK
    // turn. A timer task lets the dispatch continuation build and send its
    // receipt/patch before the single durable writer begins any work.
    setTimeout(() => {
      this.scheduled = false
      void this.run()
    }, 0)
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!
        const state = this.roomState(job.roomId)
        if (state.degradedError) {
          state.pending = Math.max(0, state.pending - 1)
          this.settleRoom(job.roomId)
          continue
        }
        try {
          await job.audit?.()
          await this.persistWithRetry(job)
          if (job.kind === 'transition' && job.authorityVersion !== undefined) {
            if (!Number.isSafeInteger(job.authorityVersion) || job.authorityVersion < 0) {
              throw new Error(`Invalid durable authority version for ${job.roomId}`)
            }
            state.durableAuthorityVersion = Math.max(
              state.durableAuthorityVersion,
              job.authorityVersion,
            )
          }
        } catch (error) {
          this.degrade(job.roomId, asError(error))
          this.dropQueuedJobs(job.roomId)
        } finally {
          state.pending = Math.max(0, state.pending - 1)
          this.settleRoom(job.roomId)
        }
      }
    } finally {
      this.running = false
      this.settleGlobal()
      if (this.jobs.length > 0) this.scheduleRun()
    }
  }

  private async persistWithRetry(job: BattleAuthorityJournalJob & { roomId: string }): Promise<void> {
    let attempt = 0
    while (true) {
      try {
        const controller = new AbortController()
        const message = `Battle authority journal persist timed out after ${this.persistTimeoutMs}ms in ${job.roomId}`
        await withTimeoutWithoutOverlap(
          job.persist({ signal: controller.signal, safetyTimeoutMs: this.persistTimeoutMs }),
          this.persistTimeoutMs,
          message,
          () => {
            controller.abort()
            this.degrade(job.roomId, new BattleAuthorityJournalPersistTimeoutError(message))
            this.dropQueuedJobs(job.roomId)
          },
        )
        return
      } catch (error) {
        // A timed-out Prisma call has an ambiguous outcome and cannot be
        // cancelled safely. Do not manufacture concurrent duplicate writes.
        if (error instanceof BattleAuthorityJournalPersistTimeoutError) throw error
        if (attempt >= this.retryDelaysMs.length) throw error
        const delay = this.retryDelaysMs[attempt]
        attempt += 1
        if (delay > 0) await sleep(delay)
      }
    }
  }

  private roomState(roomId: string): RoomJournalState {
    let state = this.rooms.get(roomId)
    if (!state) {
      state = { durableAuthorityVersion: 0, pending: 0, waiters: [] }
      this.rooms.set(roomId, state)
    }
    return state
  }

  private degrade(roomId: string, error: Error): void {
    const state = this.roomState(roomId)
    state.degradedError ??= error
    this.emit(roomId)
  }

  private dropQueuedJobs(roomId: string): void {
    let dropped = 0
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      if (this.jobs[index].roomId !== roomId) continue
      this.jobs.splice(index, 1)
      dropped += 1
    }
    const state = this.roomState(roomId)
    state.pending = Math.max(0, state.pending - dropped)
  }

  private settleRoom(roomId: string): void {
    const state = this.roomState(roomId)
    this.emit(roomId)
    if (state.pending !== 0) return
    const waiters = state.waiters.splice(0)
    for (const waiter of waiters) {
      if (state.degradedError) waiter.reject(state.degradedError)
      else waiter.resolve()
    }
  }

  private settleGlobal(): void {
    if (this.running || this.jobs.length > 0) return
    const error = [...this.rooms.values()].find(state => state.degradedError)?.degradedError
    const waiters = this.globalWaiters.splice(0)
    for (const waiter of waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }

  private emit(roomId: string): void {
    this.onStateChange?.(roomId, inspectionOf(this.roomState(roomId)))
  }
}

function inspectionOf(state: RoomJournalState): BattleAuthorityJournalInspection {
  return {
    status: state.degradedError
      ? 'degraded'
      : state.pending > 0
        ? 'pending'
        : 'durable',
    durableAuthorityVersion: state.durableAuthorityVersion,
    pending: state.pending,
    ...(state.degradedError ? { lastError: state.degradedError.message } : {}),
  }
}

function normalizeRoomId(roomId: string): string {
  const normalized = String(roomId ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('roomId is required')
  return normalized
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class BattleAuthorityJournalPersistTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BattleAuthorityJournalPersistTimeoutError'
  }
}

async function withTimeoutWithoutOverlap<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  type Outcome =
    | { kind: 'fulfilled'; value: T }
    | { kind: 'rejected'; error: unknown }
  const outcome = promise.then<Outcome, Outcome>(
    value => ({ kind: 'fulfilled', value }),
    error => ({ kind: 'rejected', error }),
  )
  let timeout: ReturnType<typeof setTimeout> | undefined
  const first = await Promise.race<Outcome | { kind: 'timeout' }>([
    outcome,
    new Promise(resolve => {
      timeout = setTimeout(() => {
        onTimeout()
        resolve({ kind: 'timeout' })
      }, timeoutMs)
      timeout.unref?.()
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (first.kind === 'fulfilled') return first.value
  if (first.kind === 'rejected') throw first.error

  // Promise.race cannot cancel Prisma. Do not start another room's job until
  // the old adapter confirms its physical write has stopped. Production
  // Prisma adapters have a shorter native transaction/busy timeout and should
  // normally settle before this safety branch.
  await outcome
  throw new BattleAuthorityJournalPersistTimeoutError(message)
}

function sleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}
