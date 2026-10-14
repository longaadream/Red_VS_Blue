import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('generic field snapshots', () => {
  it('reads a captured historical source without exposing mutable host state', () => {
    const source = makePiece({ instanceId: 'source', currentHp: 0 })
    source.statusTags = [{ type: 'burn', stacks: 2 }]
    const battle = makeState({ pieces: [source] })
    const flow = createFlowRuntime(battle, { sourcePiece: source }, 'rule', {})
    const handle = flow.effects.captureEventPiece('sourcePiece')
    battle.pieces = []
    const snapshot = flow.effects.capturedFields(handle)
    expect(snapshot.instanceId).toBe('source')
    snapshot.statusTags[0].stacks = 100
    expect(source.statusTags[0].stacks).toBe(2)
    const eventView = flow.event.pieceFields('sourcePiece')
    expect(eventView.instanceId).toBe('source')
    eventView.statusTags[0].stacks = 200
    expect(source.statusTags[0].stacks).toBe(2)
    expect(flow.event.pieceFields('targetPiece')).toBeNull()
    expect(() => flow.effects.capturedFields({})).toThrow()
  })

  it('reads the exact status handle and invalidates it after removal', () => {
    const source = makePiece({ instanceId: 'source' })
    source.statusTags = [{ id: 'same', type: 'mark', stacks: 2 }, { id: 'same', type: 'mark', stacks: 3 }]
    const flow = createFlowRuntime(makeState({ pieces: [source] }), { piece: source }, 'skill', {})
    const handles = flow.status.queryInstances('source', 'mark')
    const snapshot = flow.status.fields(handles[0])
    snapshot.stacks = 99
    expect(source.statusTags.map(tag => tag.stacks)).toEqual([2, 3])
    flow.status.removeInstance(handles[0])
    expect(() => flow.status.fields(handles[0])).toThrow('已经失效')
    expect(flow.status.fields(handles[1]).stacks).toBe(3)
  })
})
