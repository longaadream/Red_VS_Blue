import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '../../lib/game/gameplay-module-diagnostics'
import { AuthorChoiceCancelled } from '../../lib/game/author-choice-runtime'
import { SuspendableActionPending, SuspendableActionRuntime, withSuspendableActionRuntime, type SuspendableInteractionAnswer } from '../../lib/game/suspendable-action-transaction'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('author choice host', () => {
  it('selects distinct options with equal values in click order and preserves multi shape', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' })
    const battle = makeState({ pieces: [source] })
    const options = [{ label: '甲', value: 7 }, { label: '乙', value: 7 }, { label: '丙', value: 2 }]
    const select = (answers: SuspendableInteractionAnswer[], minSelections = 2, maxSelections = 2) => {
      const flow = createFlowRuntime(battle, { piece: source, skill: { id: 'multi' } }, 'skill', {})
      return withSuspendableActionRuntime(new SuspendableActionRuntime(answers), () => flow.choice.authorOption({ options, indexed: true, selectionMode: 'multi', minSelections, maxSelections, playerId: 'player-blue' }, 'selection'))
    }
    let pending!: SuspendableActionPending
    try { select([]) } catch (error) { expect(error).toBeInstanceOf(SuspendableActionPending); pending = error as SuspendableActionPending }
    expect(pending.prompt).toMatchObject({ playerId: 'player-blue', selectionMode: 'multi', minSelections: 2, maxSelections: 2 })
    const answer = (indexes: number[]) => [{ key: pending.key, input: { selectedOption: indexes.map(authorOptionIndex => ({ authorOptionIndex })) } }]
    expect(select(answer([3, 1]))).toEqual([2, 7])
    expect(select(answer([2, 1]))).toEqual([7, 7])
    expect(() => select(answer([1, 1]))).toThrow('duplicate')
    expect(() => select(answer([1]))).toThrow('count')
    expect(() => select(answer([1, 4]))).toThrow('candidate')
    expect(select(answer([3]), 1, 1)).toEqual([2])
  })

  it.each([false, true])('keeps cancellation distinct from selection and can return a typed cancellation value (indexed=%s)', indexed => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' })
    const battle = makeState({ pieces: [source] })
    const select = (answers: SuspendableInteractionAnswer[], continuation: boolean) => {
      const flow = createFlowRuntime(battle, { piece: source, skill: { id: 'optional-trigger' } }, 'skill', {})
      return withSuspendableActionRuntime(new SuspendableActionRuntime(answers), () => flow.choice.authorOption({
        options: [{ label: '触发', value: 'yes' }, { label: '不触发', value: 'no' }],
        indexed, canCancel: true, ...(continuation ? { cancelValue: 'no' } : {}),
      }, 'trigger'))
    }
    let pending!: SuspendableActionPending
    try { select([], true) } catch (error) { expect(error).toBeInstanceOf(SuspendableActionPending); pending = error as SuspendableActionPending }
    expect(pending.prompt).toMatchObject({ canCancel: true, cancelValue: 'no', resumeOnCancel: true })
    const answers = [{ key: pending.key, input: { cancelled: true, resumeConsumerOnCancel: true } }]
    expect(select(answers, true)).toBe('no')
    expect(() => select(answers, false)).toThrow(AuthorChoiceCancelled)
    expect(select([{ key: pending.key, input: { selectedOption: indexed ? { authorOptionIndex: 1 } : 'yes' } }], true)).toBe('yes')
  })

  it('does not open an impossible selector and permits empty zero-minimum choices', () => {
    const source = makePiece({ instanceId: 'source' })
    const flow = createFlowRuntime(makeState({ pieces: [source] }), { piece: source }, 'skill', {})
    expect(() => flow.choice.authorOption({ options: [], indexed: true, selectionMode: 'multi', minSelections: 1, maxSelections: 2 }, 'unavailable')).toThrow(AuthorChoiceCancelled)
    expect(flow.choice.authorOption({ options: [], indexed: true, selectionMode: 'multi', minSelections: 0, maxSelections: 2 }, 'empty')).toEqual([])
    expect(() => flow.choice.authorOption({ options: [], minSelections: NaN }, 'invalid')).toThrow('数量范围')
  })

  it('floors fractional selection bounds and rejects non-finite bounds', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' })
    const battle = makeState({ pieces: [source] })
    const flow = createFlowRuntime(battle, { piece: source, skill: { id: 'fractional-bounds' } }, 'skill', {})
    let pending!: SuspendableActionPending
    try {
      withSuspendableActionRuntime(new SuspendableActionRuntime([]), () => flow.choice.authorOption({
        options: [{ label: '甲', value: 1 }, { label: '乙', value: 2 }],
        indexed: true,
        selectionMode: 'multi',
        minSelections: 0.5,
        maxSelections: 1.5,
      }, 'fractional'))
    } catch (error) {
      expect(error).toBeInstanceOf(SuspendableActionPending)
      pending = error as SuspendableActionPending
    }
    expect(pending.prompt).toMatchObject({ minSelections: 0, maxSelections: 1 })
    expect(() => flow.choice.authorOption({ options: [{ label: '甲', value: 1 }], minSelections: Infinity }, 'infinite-min')).toThrow('数量范围')
    expect(() => flow.choice.authorOption({ options: [{ label: '甲', value: 1 }], maxSelections: -Infinity }, 'infinite-max')).toThrow('数量范围')
  })

  it('suspends twice through real diagnostic boundaries, then runs the dependent effect once', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const battle = makeState({ pieces: [source] })
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [
      { id: 'numbers', version: '1', fields: [{ name: '零', type: 'number' }, { name: '七', type: 'number' }, { name: '九', type: 'number' }] },
      { id: 'flags', version: '1', fields: [{ name: '否', type: 'boolean' }, { name: '是', type: 'boolean' }] },
    ], body: [
      { kind: 'record.create', id: 'numbers', schema: 'numbers', fields: { 零: { kind: 'literal', value: 0 }, 七: { kind: 'literal', value: 7 }, 九: { kind: 'literal', value: 9 } } },
      { kind: 'call', id: 'number', module: 'author.choice.option', version: '1', inputs: { options: { kind: 'output', node: 'numbers', port: 'value' } }, parameters: { valueType: 'number' } },
      { kind: 'record.create', id: 'flags', schema: 'flags', fields: { 否: { kind: 'literal', value: false }, 是: { kind: 'literal', value: true } } },
      { kind: 'call', id: 'flag', module: 'author.choice.option', version: '1', inputs: { options: { kind: 'output', node: 'flags', port: 'value' } }, parameters: { valueType: 'boolean' } },
      { kind: 'call', id: 'tail', module: 'extension.declare-battle', version: '1', inputs: { value: { kind: 'output', node: 'number', port: 'value' } }, parameters: { name: 'selected' } },
    ] }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const execute = (answers: SuspendableInteractionAnswer[]) => {
      const context = { piece: source, skill: { id: 'test' } }
      const flow = createFlowRuntime(battle, context, 'skill', {})
      const diagnostics = createGameplayModuleDiagnosticHost('skill', {}, () => undefined)
      const restore = installGameplayModuleDiagnosticHost(context, diagnostics)
      const runtime = new SuspendableActionRuntime(answers)
      try {
        withSuspendableActionRuntime(runtime, () => new Function('flow', 'return (' + compiled.code + ')')(flow)(context))
        runtime.assertReplayComplete()
      } catch (error) {
        if (!(error instanceof SuspendableActionPending)) throw error
        return error
      } finally {
        restore()
        expect(diagnostics.diagnostics).toEqual([])
      }
    }
    const first = execute([])!
    expect(first.prompt.options).toHaveLength(3)
    expect(battle.extensions?.flowState).toBeUndefined()
    const firstAnswer = { key: first.key, input: { selectedOption: 7 } }
    const second = execute([firstAnswer])!
    expect(second.key).not.toEqual(first.key)
    expect(second.prompt.options).toHaveLength(2)
    expect(battle.extensions?.flowState).toBeUndefined()
    expect(execute([firstAnswer, { key: second.key, input: { selectedOption: false } }])).toBeUndefined()
    expect(battle.extensions?.flowState).toHaveLength(1)
    expect(battle.extensions?.flowState[0].value).toBe(7)
  })

  it('uses the engine candidate set for terrain, occupancy, distance and replay validation', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const blocker = makePiece({ instanceId: 'blocker', ownerPlayerId: 'player-blue', x: 3, y: 2 })
    const battle = makeState({ pieces: [source, blocker], width: 6, height: 6 })
    battle.map.tiles.find(tile => tile.x === 2 && tile.y === 1)!.props.walkable = false
    const select = (answers: SuspendableInteractionAnswer[]) => {
      const flow = createFlowRuntime(battle, { piece: source, skill: { id: 'test' } }, 'skill', {})
      const runtime = new SuspendableActionRuntime(answers)
      return withSuspendableActionRuntime(runtime, () => flow.choice.authorTarget({ type: 'grid', range: 1, filter: 'all' }, 'target'))
    }
    let pending!: SuspendableActionPending
    try { select([]) } catch (error) { expect(error).toBeInstanceOf(SuspendableActionPending); pending = error as SuspendableActionPending }
    expect(pending.prompt.candidates).toEqual(expect.arrayContaining([{ type: 'cell', x: 1, y: 2 }, { type: 'cell', x: 2, y: 3 }]))
    expect(pending.prompt.candidates).toHaveLength(2)
    expect(select([{ key: pending.key, input: { targetX: 1, targetY: 2 } }])).toEqual({ x: 1, y: 2 })
    expect(() => select([{ key: pending.key, input: { targetX: 3, targetY: 2 } }])).toThrow('no longer legal')
    expect(() => select([{ key: pending.key, input: { cancelled: true } }])).toThrow(AuthorChoiceCancelled)
  })

  it('preserves record-valued choices with reserved-looking names and consumes preselected input once', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' })
    const battle = makeState({ pieces: [source] })
    const value = { value: 4, needsOptionSelection: true }
    const flow = createFlowRuntime(battle, { piece: source, skill: { id: 'test' }, selectedOption: { ...value } }, 'skill', {})
    expect(flow.choice.authorOption({ options: [{ label: 'Record', value }] }, 'first')).toEqual(value)
    expect(() => flow.choice.authorOption({ options: [{ label: 'Record', value }] }, 'second')).toThrow(SuspendableActionPending)
  })
})
