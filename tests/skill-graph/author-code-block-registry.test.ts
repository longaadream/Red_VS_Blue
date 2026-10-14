import { describe, expect, it } from 'vitest'

import { DynamicCodeRuntime } from '@/lib/game/dynamic-code-runtime'
import {
  AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE,
  AUTHOR_CODE_BLOCK_GAMEPLAY_MODULES,
} from '@/lib/skill-graph/module-registry-author-code-block'
import { compileGameplayModuleGraph } from '@/lib/skill-graph/module-compiler'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleGraph,
  type GameplayNativeLoweringContext,
} from '@/lib/skill-graph/module-types'

const blockType = { kind: 'record', schema: 'block@1' } as const
const argsType = { kind: 'record', schema: 'args@1' } as const
const resultType = { kind: 'record', schema: 'result@1' } as const
const payloadType = { kind: 'record', schema: 'payload@1' } as const

function invokeGraph(surface: 'pending' | 'skill' = 'pending'): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface,
    schemas: [
      { id: 'block', version: '1', fields: [{ name: 'id', type: 'string' }] },
      { id: 'args', version: '1', fields: [{ name: 'target', type: 'string' }] },
      { id: 'result', version: '1', fields: [{ name: 'value', type: 'string' }] },
      {
        id: 'payload',
        version: '1',
        fields: [
          { name: 'block', type: blockType },
          { name: 'args', type: argsType },
        ],
      },
    ],
    hostBindings: {
      payload: payloadType,
    },
    outputs: [{ name: 'result', type: resultType }],
    body: [
      {
        kind: 'record.get',
        id: 'block-input',
        record: { kind: 'input', name: 'payload' },
        field: 'block',
      },
      {
        kind: 'record.get',
        id: 'args-input',
        record: { kind: 'input', name: 'payload' },
        field: 'args',
      },
      {
        kind: 'call',
        id: 'invoke',
        module: AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.id,
        version: AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.version,
        inputs: {
          block: { kind: 'output', node: 'block-input', port: 'value' },
          args: { kind: 'output', node: 'args-input', port: 'value' },
        },
        parameters: {
          blockType: JSON.stringify(blockType),
          argsType: JSON.stringify(argsType),
          resultType: JSON.stringify(resultType),
        },
      },
      {
        kind: 'return',
        id: 'return',
        values: { result: { kind: 'output', node: 'invoke', port: 'result' } },
      },
    ],
  }
}

function registry() {
  return new Map([
    [`${AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.id}\u0000${AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.version}`, AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE],
  ])
}

describe('author code block registry module', () => {
  it('binds block, argument, and result record types and invokes the pending host', () => {
    const compiled = compileGameplayModuleGraph(invokeGraph(), registry())
    expect(compiled.code).toContain('ctx.__authorCodeBlockInvoke')

    const runtime = new DynamicCodeRuntime()
    const execute = runtime.compileExpression<(context: unknown) => unknown>({
      surface: 'pendingEffectCode',
      contentId: 'code-block-registry-test',
      contentVersion: '1',
      code: compiled.code,
      entry: 'author code block registry test',
    })
    expect(execute({
      payload: {
        block: { id: 'armor.attack' },
        args: { target: 'piece-1' },
      },
      __authorCodeBlockInvoke: (block: { id: string }, args: { target: string }) => ({ value: `${block.id}:${args.target}` }),
    })).toEqual({ result: { value: 'armor.attack:piece-1' } })
  })

  it('falls back to the ordinary flow facade for a resumed pending graph', () => {
    const compiled = compileGameplayModuleGraph(invokeGraph(), registry())
    const runtime = new DynamicCodeRuntime()
    const execute = runtime.compileExpression<(context: unknown) => unknown>({
      surface: 'pendingEffectCode',
      contentId: 'code-block-registry-fallback-test',
      contentVersion: '1',
      code: compiled.code,
      entry: 'author code block registry fallback test',
    })
    expect(execute({
      payload: {
        block: { id: 'armor.attack' },
        args: { target: 'piece-1' },
      },
      flow: {
        codeBlocks: {
          invoke: (block: { id: string }, args: { target: string }) => ({ value: `${block.id}:${args.target}` }),
        },
      },
    })).toEqual({ result: { value: 'armor.attack:piece-1' } })
  })

  it('uses the ordinary flow facade outside pending continuations', () => {
    const context: GameplayNativeLoweringContext = {
      surface: 'skill',
      callId: 'invoke',
      moduleId: AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.id,
      moduleVersion: AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.version,
      inputs: { block: 'blockValue', args: 'argsValue' },
      parameters: { blockType: JSON.stringify(blockType), argsType: JSON.stringify(argsType), resultType: JSON.stringify(resultType) },
      outputPorts: AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.outputs,
      emitLiteral: value => JSON.stringify(value),
    }
    expect(AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.lower(context)).toBe('flow.codeBlocks.invoke(blockValue,argsValue,{"type":{"kind":"record","schema":"result@1"},"schemas":[]})')
  })

  it('rejects a call whose bound record type does not match the declared result shape', () => {
    const graph = invokeGraph()
    const body = graph.body as unknown as Array<{ kind: string; parameters?: Record<string, string> }>
    const call = body.find(node => node.kind === 'call')
    if (!call) throw new Error('test graph is missing the invocation call')
    call.parameters = {
      blockType: JSON.stringify(blockType),
      argsType: JSON.stringify(argsType),
      resultType: JSON.stringify({ kind: 'record', schema: 'args@1' }),
    }
    expect(() => compileGameplayModuleGraph(graph, registry())).toThrow(/return|result|type|record/i)
  })

  it('publishes one generic descriptor without author supplied functions or source text', () => {
    expect(AUTHOR_CODE_BLOCK_GAMEPLAY_MODULES).toHaveLength(1)
    expect(AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.lower.toString()).not.toContain('new Function')
    expect(AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE.lower.toString()).not.toContain('eval')
  })
})
