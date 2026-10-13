import { describe, expect, it, vi } from 'vitest'

import { DynamicCodeRuntime } from '@/lib/game/dynamic-code-runtime'
import {
  AUTHOR_CODE_BLOCK_INVOKE_CONTEXT_KEY,
  AuthorCodeBlockRuntimeError,
  createAuthorCodeBlockExecutor,
} from '@/lib/game/author-code-block-runtime'
import { createGameplayModuleDiagnosticHost } from '@/lib/game/gameplay-module-diagnostics'
import {
  AUTHOR_CODE_BLOCK_VERSION,
  type AuthorCodeBlock,
} from '@/lib/skill-graph/author-code-block'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '@/lib/skill-graph/module-types'

type UnknownRecord = Record<string, unknown>

function armorBlock(): AuthorCodeBlock {
  return {
    version: AUTHOR_CODE_BLOCK_VERSION,
    id: 'armor.runtime-test',
    signature: {
      inputs: [{ name: 'target', type: 'piece' }],
      outputs: [{ name: 'owner', type: 'player' }],
    },
    graph: {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'pending',
      schemas: [{
        id: 'armor-runtime-arguments',
        version: '1',
        fields: [{ name: 'target', type: 'piece' }],
      }],
      hostBindings: {
        payload: { kind: 'record', schema: 'armor-runtime-arguments@1' },
      },
      outputs: [{ name: 'owner', type: 'player' }],
      body: [
        {
          kind: 'record.get',
          id: 'target-value',
          record: { kind: 'input', name: 'payload' },
          field: 'target',
        },
        {
          kind: 'call',
          id: 'owner-value',
          module: 'piece.owner',
          version: '1',
          inputs: { piece: { kind: 'output', node: 'target-value', port: 'value' } },
        },
        {
          kind: 'return',
          id: 'return-owner',
          values: { owner: { kind: 'output', node: 'owner-value', port: 'player' } },
        },
      ],
    },
  }
}

describe('author code block runtime adapter', () => {
  it('validates, compiles through the injected runtime, and returns the graph value', () => {
    const requests: UnknownRecord[] = []
    const dynamic = new DynamicCodeRuntime()
    const execute = createAuthorCodeBlockExecutor({
      compileExpression: request => {
        requests.push(request)
        return dynamic.compileExpression(request)
      },
      flow: {
        query: {
          piece: (id: string) => ({ instanceId: id, ownerPlayerId: 'player-red' }),
        },
      },
      context: { type: 'pendingEffect', actionId: 'action-1' },
    })

    expect(execute(armorBlock(), { target: 'piece-1' })).toEqual({ owner: 'player-red' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      surface: 'pendingEffectCode',
      contentId: 'armor.runtime-test',
      contentVersion: AUTHOR_CODE_BLOCK_VERSION,
    })
    expect((requests[0].code as string)).not.toContain('piece-1')
  })

  it('rejects data-only violations before asking the injected compiler to execute', () => {
    const compileExpression = vi.fn(() => () => 'should not run')
    const execute = createAuthorCodeBlockExecutor({ compileExpression })
    const invalid = armorBlock() as unknown as UnknownRecord
    const graph = invalid.graph as UnknownRecord
    graph.layout = { callback: () => 1 }

    expect(() => execute(invalid, { target: 'piece-1' })).toThrow(/function|callback/i)
    expect(compileExpression).not.toHaveBeenCalled()
  })

  it('keeps the current flow and diagnostic host available without swallowing signals', () => {
    const dynamic = new DynamicCodeRuntime()
    const currentContext: UnknownRecord = { marker: 'current-context' }
    const host = createGameplayModuleDiagnosticHost('pending', {}, () => undefined)
    Object.defineProperty(currentContext, '__gameplayModuleDiagnosticHost', {
      configurable: true,
      enumerable: false,
      value: host,
    })
    const fatal = { code: 'AUTHOR_FATAL' }
    const compileExpression = vi.fn(() => (context: unknown) => {
      const value = context as UnknownRecord
      expect(value.flow).toBeDefined()
      expect(value.marker).toBe('current-context')
      expect(value.__gameplayModuleDiagnosticHost).toBe(host)
      throw fatal
    })
    const execute = createAuthorCodeBlockExecutor({
      compileExpression,
      context: currentContext,
      flow: { query: {} },
    })

    expect(() => execute(armorBlock(), { target: 'piece-1' })).toThrow(fatal)
    expect(dynamic.stats().compiled).toBe(0)
  })

  it('shares bounded invocation and recursion state with nested generic calls', () => {
    const block = armorBlock()
    const compileExpression = vi.fn(() => (context: unknown) => {
      const value = context as UnknownRecord
      const invoke = value[AUTHOR_CODE_BLOCK_INVOKE_CONTEXT_KEY] as (next: unknown, args: UnknownRecord) => unknown
      return invoke(block, { target: 'piece-1' })
    })
    const execute = createAuthorCodeBlockExecutor({
      compileExpression,
      maxInvocations: 10,
      maxRecursionDepth: 2,
    })

    expect(() => execute(block, { target: 'piece-1' })).toThrowError(
      expect.objectContaining<Partial<AuthorCodeBlockRuntimeError>>({
        code: 'AUTHOR_CODE_BLOCK_RUNTIME_RECURSION_LIMIT',
        limit: 2,
      }),
    )
    expect(compileExpression).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh budget for each top-level call', () => {
    let nested = true
    const block = armorBlock()
    const compileExpression = vi.fn(() => (context: unknown) => {
      if (!nested) return { owner: 'player-red' }
      nested = false
      const value = context as UnknownRecord
      return (value[AUTHOR_CODE_BLOCK_INVOKE_CONTEXT_KEY] as (next: unknown, args: UnknownRecord) => unknown)(block, { target: 'piece-1' })
    })
    const execute = createAuthorCodeBlockExecutor({ compileExpression, maxInvocations: 2 })

    expect(execute(block, { target: 'piece-1' })).toEqual({ owner: 'player-red' })
    expect(execute(block, { target: 'piece-1' })).toEqual({ owner: 'player-red' })
    expect(compileExpression).toHaveBeenCalledTimes(3)
  })

  it('does not replace pending or fatal errors from generated execution', () => {
    const pending = { code: 'PENDING' }
    const compileExpression = vi.fn(() => () => { throw pending })
    const execute = createAuthorCodeBlockExecutor({ compileExpression })

    expect(() => execute(armorBlock(), { target: 'piece-1' })).toThrow(pending)
  })

  it('validates the actual generated result against the block output signature', () => {
    const compileExpression = vi.fn(() => () => ({ owner: 42 }))
    const execute = createAuthorCodeBlockExecutor({ compileExpression })

    expect(() => execute(armorBlock(), { target: 'piece-1' })).toThrowError(
      expect.objectContaining<Partial<AuthorCodeBlockRuntimeError>>({
        code: 'AUTHOR_CODE_BLOCK_RUNTIME_RESULT',
      }),
    )
  })

  it('rejects an incompatible caller result type before dynamic code execution', () => {
    const compileExpression = vi.fn(() => () => ({ owner: 'player-red' }))
    const execute = createAuthorCodeBlockExecutor({ compileExpression })

    expect(() => execute(armorBlock(), { target: 'piece-1' }, { type: 'number', schemas: [] })).toThrowError(
      expect.objectContaining<Partial<AuthorCodeBlockRuntimeError>>({
        code: 'AUTHOR_CODE_BLOCK_RUNTIME_RESULT',
      }),
    )
    expect(compileExpression).not.toHaveBeenCalled()
  })

  it('checks the generated value against the caller result schema after execution', () => {
    const compileExpression = vi.fn(() => () => ({ owner: 'player-red' }))
    const execute = createAuthorCodeBlockExecutor({ compileExpression })
    const expected = {
      type: { kind: 'record', schema: 'author-runtime-result@1' },
      schemas: [{
        id: 'author-runtime-result',
        version: '1',
        fields: [{ name: 'owner', type: 'player' }],
      }],
    } as const

    expect(execute(armorBlock(), { target: 'piece-1' }, expected)).toEqual({ owner: 'player-red' })
    expect(compileExpression).toHaveBeenCalledTimes(1)
  })
})
