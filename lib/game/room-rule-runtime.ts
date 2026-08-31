import {
  RoomAuthorityQueue,
  roomAuthorityQueue,
  type RoomAuthorityEventContext,
} from './room-authority-queue'
import {
  createRuleExecutionContext,
  withRuleExecutionContext,
  type RuleExecutionContext,
} from './rule-runtime'
import { globalTriggerSystem, TriggerSystem, type TriggerRule } from './triggers'

export class RoomRuleRuntimeError extends Error {
  readonly code = 'ROOM_RULE_RUNTIME_CLOSED'

  constructor(
    message: string,
    readonly context: { roomId: string; generation: number; closedReason: string },
  ) {
    super(message)
    this.name = 'RoomRuleRuntimeError'
  }
}

export interface RoomRuleRuntimeInspection {
  roomId: string
  generation: number
  closed: boolean
  closedReason: string | null
  activeEvent: RoomAuthorityEventContext | null
  queueDepth: number
  pendingDepth: number
}

export class RoomRuleRuntime {
  readonly executionContext: RuleExecutionContext
  private closedReason: string | null = null

  constructor(
    readonly roomId: string,
    readonly generation: number,
    private readonly queue: RoomAuthorityQueue,
    triggerSystem = new TriggerSystem(),
  ) {
    this.executionContext = createRuleExecutionContext(triggerSystem)
  }

  run<T>(operation: () => T): T {
    this.assertOpen()
    return withRuleExecutionContext(this.executionContext, operation)
  }

  close(reason = 'closed'): void {
    if (this.closedReason) return
    const normalizedReason = String(reason || 'closed').trim() || 'closed'
    this.closedReason = normalizedReason
    this.executionContext.triggerSystem.clearRules()
    this.executionContext.cache.clear()
    this.queue.closeRoom(this.roomId, normalizedReason)
  }

  inspect(): RoomRuleRuntimeInspection {
    const queue = this.queue.inspect(this.roomId)
    return {
      roomId: this.roomId,
      generation: this.generation,
      closed: this.closedReason !== null,
      closedReason: this.closedReason ?? queue.closedReason ?? null,
      activeEvent: queue.active ? { ...queue.active } : null,
      queueDepth: queue.pending + (queue.running ? 1 : 0),
      pendingDepth: queue.pending,
    }
  }

  private assertOpen(): void {
    if (!this.closedReason) return
    throw new RoomRuleRuntimeError(
      `Rule runtime for ${this.roomId} is closed`,
      { roomId: this.roomId, generation: this.generation, closedReason: this.closedReason },
    )
  }
}

export class RoomRuleRuntimeRegistry {
  private readonly rooms = new Map<string, RoomRuleRuntime>()
  private nextGeneration = 0

  constructor(private readonly queue: RoomAuthorityQueue = roomAuthorityQueue) {}

  create(roomId: string): RoomRuleRuntime {
    return this.getOrCreate(roomId, false)
  }

  restore(roomId: string): RoomRuleRuntime {
    return this.getOrCreate(roomId, true)
  }

  close(roomId: string, reason = 'closed'): RoomRuleRuntimeInspection {
    const normalizedRoomId = normalizeRoomId(roomId)
    let runtime = this.rooms.get(normalizedRoomId)
    if (!runtime) {
      runtime = new RoomRuleRuntime(normalizedRoomId, ++this.nextGeneration, this.queue)
      this.rooms.set(normalizedRoomId, runtime)
    }
    runtime.close(reason)
    return runtime.inspect()
  }

  inspect(roomId: string): RoomRuleRuntimeInspection | null {
    return this.rooms.get(normalizeRoomId(roomId))?.inspect() ?? null
  }

  private getOrCreate(roomId: string, seedFromLegacyFallback: boolean): RoomRuleRuntime {
    const normalizedRoomId = normalizeRoomId(roomId)
    const existing = this.rooms.get(normalizedRoomId)
    if (existing) {
      const inspection = existing.inspect()
      if (inspection.closed) {
        throw new RoomRuleRuntimeError(
          `Rule runtime for ${normalizedRoomId} is closed`,
          {
            roomId: normalizedRoomId,
            generation: inspection.generation,
            closedReason: inspection.closedReason ?? 'closed',
          },
        )
      }
      return existing
    }

    const runtime = new RoomRuleRuntime(
      normalizedRoomId,
      ++this.nextGeneration,
      this.queue,
      seedFromLegacyFallback ? cloneLegacyTriggerSystem() : undefined,
    )
    this.rooms.set(normalizedRoomId, runtime)
    return runtime
  }
}

function cloneLegacyTriggerSystem(): TriggerSystem {
  const triggerSystem = new TriggerSystem()
  triggerSystem.addRules(globalTriggerSystem.getRules().map(cloneTriggerRule))
  return triggerSystem
}

function cloneTriggerRule(rule: TriggerRule): TriggerRule {
  return {
    ...rule,
    trigger: { ...rule.trigger },
    limits: rule.limits ? { ...rule.limits } : undefined,
  }
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __rvbRoomRuleRuntimeV1?: RoomRuleRuntimeRegistry
}

export const roomRuleRuntimes = (
  runtimeGlobal.__rvbRoomRuleRuntimeV1 ??= new RoomRuleRuntimeRegistry()
)

export function createRoomRuleRuntime(roomId: string): RoomRuleRuntime {
  return roomRuleRuntimes.create(roomId)
}

export function restoreRoomRuleRuntime(roomId: string): RoomRuleRuntime {
  return roomRuleRuntimes.restore(roomId)
}

export function closeRoomRuleRuntime(roomId: string, reason = 'closed'): RoomRuleRuntimeInspection {
  return roomRuleRuntimes.close(roomId, reason)
}

export function inspectRoomRuleRuntime(roomId: string): RoomRuleRuntimeInspection | null {
  return roomRuleRuntimes.inspect(roomId)
}

function normalizeRoomId(roomId: string): string {
  const normalized = String(roomId ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('roomId is required')
  return normalized
}
