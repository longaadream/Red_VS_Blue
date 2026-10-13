import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('author status instance selection', () => {
  it('filters by source identity and removes exactly the selected object even with duplicate IDs', () => {
    const target = makePiece({ instanceId: 'target' })
    target.statusTags = [
      { id: 'same', type: 'mark', sourceId: 'one', stacks: 2 },
      { id: 'same', type: 'mark', sourceId: 'two', stacks: 3 },
      { type: 'mark', sourceId: 'one', stacks: 4 },
      { id: 'other', type: 'other', sourceId: 'one' },
    ]
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const selected = flow.status.queryInstances('target', 'mark', 'one')
    expect(selected).toHaveLength(2)
    expect(flow.status.queryInstances('target', 'mark')).toHaveLength(3)
    expect(flow.status.queryInstances('target', 'missing')).toEqual([])
    expect(flow.status.readNumberInstance(selected[0], 'stacks', 0)).toBe(2)
    flow.status.setNumberInstance(selected[0], 'stacks', 5)
    expect(target.statusTags[0].stacks).toBe(5)
    selected.forEach(handle => flow.status.removeInstance(handle))
    expect(target.statusTags.map(tag => [tag.type, tag.sourceId, tag.stacks])).toEqual([
      ['mark', 'two', 3], ['other', 'one', undefined],
    ])
    expect(() => flow.status.removeInstance(selected[0])).toThrow('已经失效')
    expect(target.statusTags).toHaveLength(2)
  })

  it('does not retarget an old handle to a new same-ID state or another execution', () => {
    const target = makePiece({ instanceId: 'target' })
    target.statusTags = [{ id: 'same', type: 'mark', sourceId: 'one' }]
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const [selected] = flow.status.queryInstances('target', 'mark')
    target.statusTags = [{ id: 'same', type: 'mark', sourceId: 'two' }]
    expect(() => flow.status.removeInstance(selected)).toThrow('已经失效')
    const otherFlow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    expect(() => otherFlow.status.removeInstance(selected)).toThrow('已经失效')
    expect(target.statusTags[0].sourceId).toBe('two')
  })

  it('updates only the selected duration and rejects invalid counters before mutation', () => {
    const target = makePiece({ instanceId: 'target' })
    target.statusTags = [{ id: 'same', type: 'mark', currentDuration: 1 }, { id: 'same', type: 'mark', currentDuration: 2 }]
    const flow = createFlowRuntime(makeState({ pieces: [target] }), { piece: target }, 'skill', {})
    const [selected] = flow.status.queryInstances('target', 'mark')
    expect(flow.status.setNumberInstance(selected, 'currentDuration', -1)).toBe(true)
    expect(target.statusTags.map(tag => tag.currentDuration)).toEqual([-1, 2])
    for (const value of [-2, 1.5, Infinity]) expect(() => flow.status.setNumberInstance(selected, 'currentDuration', value)).toThrow('无效')
    expect(() => flow.status.setNumberInstance(selected, 'sourceId', 1)).toThrow('无效')
    expect(target.statusTags.map(tag => tag.currentDuration)).toEqual([-1, 2])
  })
})
