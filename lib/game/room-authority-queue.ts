export type RoomAuthorityEventKind = 'player' | 'timer' | 'pending' | 'bot' | 'disconnect' | 'system'

export interface RoomAuthorityEventContext {
  kind: RoomAuthorityEventKind
  actionId?: string
  playerId?: string
  authorityVersion?: number
}

export interface RoomAuthorityQueueOptions {
  /** Number of events allowed to wait behind the currently running event. */
  maxPendingPerRoom?: number
}

export class RoomAuthorityQueueError extends Error {
  code: 'ROOM_AUTHORITY_BACKPRESSURE' | 'ROOM_AUTHORITY_QUEUE_CLOSED'
  context: Record<string, unknown>

  constructor(
    code: RoomAuthorityQueueError['code'],
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RoomAuthorityQueueError'
    this.code = code
    this.context = context
  }
}

interface QueuedAuthorityEvent<T = unknown> {
  context: RoomAuthorityEventContext
  operation: () => Promise<T> | T
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

interface RoomQueueState {
  running: boolean
  events: QueuedAuthorityEvent[]
  active?: RoomAuthorityEventContext
  closedReason?: string
}

export class RoomAuthorityQueue {
  private readonly rooms = new Map<string, RoomQueueState>()
  private readonly maxPendingPerRoom: number

  constructor(options: RoomAuthorityQueueOptions = {}) {
    const requested = options.maxPendingPerRoom ?? 64
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new Error('maxPendingPerRoom must be a non-negative safe integer')
    }
    this.maxPendingPerRoom = requested
  }

  enqueue<T>(
    roomId: string,
    context: RoomAuthorityEventContext,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const normalizedRoomId = normalizeRoomId(roomId)
    let state = this.rooms.get(normalizedRoomId)
    if (!state) {
      state = { running: false, events: [] }
      this.rooms.set(normalizedRoomId, state)
    }
    if (state.closedReason) {
      return Promise.reject(new RoomAuthorityQueueError(
        'ROOM_AUTHORITY_QUEUE_CLOSED',
        `Authority queue for ${normalizedRoomId} is closed`,
        queueContext(normalizedRoomId, context, state, { reason: state.closedReason }),
      ))
    }
    if (state.running && state.events.length >= this.maxPendingPerRoom) {
      return Promise.reject(new RoomAuthorityQueueError(
        'ROOM_AUTHORITY_BACKPRESSURE',
        `Authority queue for ${normalizedRoomId} reached its pending limit`,
        queueContext(normalizedRoomId, context, state, { maxPendingPerRoom: this.maxPendingPerRoom }),
      ))
    }

    const result = new Promise<T>((resolve, reject) => {
      state!.events.push({ context, operation, resolve: value => resolve(value as T), reject })
    })
    if (!state.running) {
      state.running = true
      void this.drain(normalizedRoomId, state)
    }
    return result
  }

  closeRoom(roomId: string, reason = 'closed'): void {
    const normalizedRoomId = normalizeRoomId(roomId)
    const state = this.rooms.get(normalizedRoomId) ?? { running: false, events: [] }
    state.closedReason = reason
    this.rooms.set(normalizedRoomId, state)
  }

  reopenRoom(roomId: string): void {
    const normalizedRoomId = normalizeRoomId(roomId)
    const state = this.rooms.get(normalizedRoomId)
    if (!state) return
    delete state.closedReason
    if (!state.running && state.events.length === 0) this.rooms.delete(normalizedRoomId)
  }

  inspect(roomId: string): {
    running: boolean
    pending: number
    active?: RoomAuthorityEventContext
    closedReason?: string
  } {
    const state = this.rooms.get(normalizeRoomId(roomId))
    return state
      ? {
          running: state.running,
          pending: state.events.length,
          active: state.active ? { ...state.active } : undefined,
          closedReason: state.closedReason,
        }
      : { running: false, pending: 0 }
  }

  private async drain(roomId: string, state: RoomQueueState): Promise<void> {
    while (state.events.length > 0) {
      const event = state.events.shift()!
      state.active = event.context
      try {
        event.resolve(await event.operation())
      } catch (error) {
        event.reject(error)
      } finally {
        delete state.active
      }
    }
    state.running = false
    if (!state.closedReason && this.rooms.get(roomId) === state) this.rooms.delete(roomId)
  }
}

const authorityQueueGlobal = globalThis as typeof globalThis & {
  __rvbRoomAuthorityQueueV2?: RoomAuthorityQueue
}

export const roomAuthorityQueue = (
  authorityQueueGlobal.__rvbRoomAuthorityQueueV2 ??= new RoomAuthorityQueue()
)

function queueContext(
  roomId: string,
  context: RoomAuthorityEventContext,
  state: RoomQueueState,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    roomId,
    eventKind: context.kind,
    actionId: context.actionId,
    playerId: context.playerId,
    authorityVersion: context.authorityVersion,
    active: state.active,
    pending: state.events.length,
    ...extra,
  }
}

function normalizeRoomId(roomId: string): string {
  const normalized = String(roomId ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('roomId is required')
  return normalized
}
