import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'

const execute = (graph: GameplayModuleGraph) => runInNewContext(`(${compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code})`, { flow: { refs: { holder: () => 'departed-piece' }, query: { hasPiece: () => false, hasPlayer: () => false } } })({})

describe('generic scalar and conditional values', () => {
  it('keeps a record with its own value field intact', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record' }],
      schemas: [{ id: 'sample', version: '1', fields: [{ name: 'value', type: 'number' }, { name: 'extra', type: 'number' }] }],
      body: [
        { kind: 'record.create', id: 'record', schema: 'sample@1', fields: { value: { kind: 'literal', value: 3 }, extra: { kind: 'literal', value: 4 } } },
        { kind: 'call', id: 'selected', module: 'logic.select', version: '2', parameters: { valueType: 'record' }, inputs: {
          condition: { kind: 'literal', value: true }, whenTrue: { kind: 'output', node: 'record', port: 'value' }, whenFalse: { kind: 'output', node: 'record', port: 'value' },
        } },
        { kind: 'return', id: 'done', value: { kind: 'output', node: 'selected', port: 'value' } },
      ],
    }
    expect(execute(graph)).toEqual({ value: 3, extra: 4 })
  })

  it('formats historical identity without requiring a living instance', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill',
      outputs: [{ name: 'result', type: 'string' }], body: [
        { kind: 'call', id: 'holder', module: 'ref.holder', version: '1', inputs: {} },
        { kind: 'call', id: 'text', module: 'text.from-value', version: '1', parameters: { valueType: 'piece' }, inputs: { value: { kind: 'output', node: 'holder', port: 'piece' } } },
        { kind: 'return', id: 'done', value: { kind: 'output', node: 'text', port: 'text' } },
      ],
    }
    expect(execute(graph)).toBe('departed-piece')
  })
})
