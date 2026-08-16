import { describe, expect, it } from 'vitest'

import { EventTraceProbe } from '../helpers/event-trace'
import { makeState } from '../helpers/minimal-state'

function buildTrace() {
  const probe = new EventTraceProbe()
  const beforeState = makeState()
  const afterState = makeState()
  afterState.players[0].actionPoints -= 1
  const beforeContext = { type: 'beforeDamageDealt', damage: 3 }
  const afterContext = { type: 'beforeDamageDealt', damage: 6 }

  probe.record({
    actionId: 'red45-fixed-action',
    eventId: 'event-1:1',
    depth: 0,
    turn: 2,
    phase: 'action',
    eventType: 'beforeDamageDealt',
    consumerKind: 'pieceRule',
    consumerId: 'rule-watcher-rage-dealt',
    ownerId: 'player-red',
    sourceId: 'rage-owner',
    priority: 50,
    tieBreaker: 'piece:0/rule:0',
    contextBefore: probe.snapshotContext(beforeContext),
    contextAfter: probe.snapshotContext(afterContext),
    contextDiff: probe.diffContext(beforeContext, afterContext),
    success: true,
    blocked: false,
    pending: false,
    stateHashBefore: probe.snapshotState(beforeState),
    stateHash: probe.snapshotState(afterState),
    seed: 45,
    randomStreams: [{ name: 'skill/effect', startCursor: 4, endCursor: 5 }],
  })

  return probe.all()
}

describe('RED-45 deterministic event trace probe', () => {
  it('records the complete RED-28-aware schema deterministically', () => {
    const first = buildTrace()
    const second = buildTrace()

    expect(second).toEqual(first)
    expect(first).toEqual([
      expect.objectContaining({
        actionId: 'red45-fixed-action',
        eventId: 'event-1:1',
        sequence: 1,
        turn: 2,
        phase: 'action',
        consumerKind: 'pieceRule',
        consumerId: 'rule-watcher-rage-dealt',
        tieBreaker: 'piece:0/rule:0',
        contextDiff: { damage: { before: 3, after: 6 } },
        seed: 45,
        randomStreams: [{ name: 'skill/effect', startCursor: 4, endCursor: 5 }],
      }),
    ])
  })
})
