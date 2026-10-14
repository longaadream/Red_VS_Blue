import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph, GAMEPLAY_MODULE_GRAPH_VERSION, GAMEPLAY_MODULE_REGISTRY, type GameplayModuleGraph } from '../../lib/skill-graph/module-document'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('semantic facts and guarded effects', () => {
  it('queries status counts and ownership without exposing mutable entities', () => {
    const piece = makePiece({ instanceId: 'subject', statusTags: [{ id: 'one', type: 'immune' }, { id: 'two', type: 'immune' }] })
    const battle = makeState({ pieces: [piece] })
    const context = { rulePiece: piece, piece }
    const flow = createFlowRuntime(battle, context, 'rule', {})
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'count', type: 'number' }, { name: 'owner', type: 'player' }],
      body: [
        { kind: 'call', id: 'piece', module: 'ref.event-piece', version: '1' },
        { kind: 'call', id: 'count', module: 'status.count-piece', version: '1', inputs: { piece: { kind: 'output', node: 'piece', port: 'piece' } }, parameters: { statusType: 'immune' } },
        { kind: 'call', id: 'owner', module: 'piece.owner', version: '1', inputs: { piece: { kind: 'output', node: 'piece', port: 'piece' } } },
        { kind: 'return', id: 'return', values: { count: { kind: 'output', node: 'count', port: 'value' }, owner: { kind: 'output', node: 'owner', port: 'player' } } },
      ],
    }
    const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
    expect(Function('context', 'flow', 'battle', code)(context, flow, battle)).toEqual({ count: 2, owner: piece.ownerPlayerId })
    expect(piece.statusTags).toHaveLength(2)
  })
  it('rejects coordinate writes and preview effects before execution', () => {
    const base: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'holder', module: 'ref.holder', version: '1' },
      { kind: 'call', id: 'adjust', module: 'attribute.adjust', version: '1', parameters: { attribute: 'x' }, inputs: { piece: { kind: 'output', node: 'holder', port: 'piece' }, amount: { kind: 'literal', value: 3 } } },
    ] }
    expect(() => compileGameplayModuleGraph(base, GAMEPLAY_MODULE_REGISTRY)).toThrow()
    expect(() => compileGameplayModuleGraph({ ...base, surface: 'preview' }, GAMEPLAY_MODULE_REGISTRY)).toThrow()
  })
})
