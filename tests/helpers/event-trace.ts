import { hashStable, stableJson } from '@/lib/game/battle-runner'

export type EventTraceRandomStream = {
  name: string
  startCursor: number
  endCursor: number
}

export type EventTraceEntry = {
  actionId: string
  eventId: string
  parentEventId?: string
  depth: number
  sequence: number
  turn?: number
  phase?: string
  eventType: string
  consumerKind: 'globalRule' | 'pieceRule' | 'playerRule' | 'responseCard'
  consumerId?: string
  ownerId?: string
  sourceId?: string
  priority?: number
  tieBreaker?: string
  contextBefore: string
  contextAfter: string
  contextDiff?: Record<string, { before?: unknown; after?: unknown }>
  success?: boolean
  blocked?: boolean
  pending?: boolean
  exception?: string
  stateHashBefore?: string
  stateHash: string
  seed?: number
  randomStreams?: EventTraceRandomStream[]
}

export class EventTraceProbe {
  private readonly entries: EventTraceEntry[] = []
  private sequence = 0

  record(entry: Omit<EventTraceEntry, 'sequence' | 'eventId'> & { eventId?: string }): EventTraceEntry {
    const complete: EventTraceEntry = {
      ...entry,
      sequence: ++this.sequence,
      eventId: entry.eventId ?? `${entry.actionId}:${this.sequence}`,
    }
    this.entries.push(complete)
    return complete
  }

  snapshotContext(context: unknown): string {
    return stableJson(context)
  }

  diffContext(before: unknown, after: unknown): Record<string, { before?: unknown; after?: unknown }> {
    const beforeRecord = before && typeof before === 'object' ? before as Record<string, unknown> : {}
    const afterRecord = after && typeof after === 'object' ? after as Record<string, unknown> : {}
    const diff: Record<string, { before?: unknown; after?: unknown }> = {}
    for (const key of [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()) {
      if (stableJson(beforeRecord[key]) !== stableJson(afterRecord[key])) {
        diff[key] = { before: beforeRecord[key], after: afterRecord[key] }
      }
    }
    return diff
  }

  snapshotState(state: unknown): string {
    return hashStable(state)
  }

  all(): readonly EventTraceEntry[] {
    return this.entries
  }
}
