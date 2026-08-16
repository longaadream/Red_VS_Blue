import { hashStable, stableJson } from '@/lib/game/battle-runner'

export type EventTraceEntry = {
  actionId: string
  eventId: string
  parentEventId?: string
  depth: number
  sequence: number
  eventType: string
  consumerKind: 'globalRule' | 'pieceRule' | 'playerRule' | 'responseCard' | 'attachedEffect'
  consumerId?: string
  ownerId?: string
  priority?: number
  contextBefore: string
  contextAfter: string
  success?: boolean
  blocked?: boolean
  pending?: boolean
  exception?: string
  stateHash: string
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

  snapshotState(state: unknown): string {
    return hashStable(state)
  }

  all(): readonly EventTraceEntry[] {
    return this.entries
  }
}
