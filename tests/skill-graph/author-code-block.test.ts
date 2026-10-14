import { describe, expect, it } from 'vitest'

import { DynamicCodeRuntime } from '@/lib/game/dynamic-code-runtime'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import {
  AUTHOR_CODE_BLOCK_VERSION,
  compileAuthorCodeBlock,
  compileAuthorCodeBlockWithArguments,
  createAuthorCodeBlock,
  validateAuthorCodeBlock,
  type AuthorCodeBlock,
} from '@/lib/skill-graph/author-code-block'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '@/lib/skill-graph/module-types'

type UnknownRecord = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function armorBlock(): AuthorCodeBlock {
  const signature = {
    inputs: [{ name: 'target', type: 'piece' }],
    outputs: [{ name: 'owner', type: 'player' }],
  } as const
  return {
    version: AUTHOR_CODE_BLOCK_VERSION,
    id: 'armor.attack',
    signature,
    graph: {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'pending',
      schemas: [{
        id: 'armor-arguments',
        version: '1',
        fields: signature.inputs,
      }],
      hostBindings: {
        payload: { kind: 'record', schema: 'armor-arguments@1' },
      },
      outputs: signature.outputs,
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

describe('author code blocks', () => {
  it('compiles a typed target payload and leaves invocation binding outside the definition', () => {
    const source = armorBlock()
    const result = compileAuthorCodeBlockWithArguments(source, { target: 'piece-1' })

    expect(result.definition).not.toBe(source)
    expect(result.definition.graph).not.toBe(source.graph)
    expect(result.argumentBinding.payload).toEqual({ target: 'piece-1' })
    expect(result.compiled.surface).toBe('pending')
    expect(result.compiled.code).toContain('ctx["payload"]')
    expect(JSON.stringify(result.definition)).not.toContain('piece-1')
    expect(JSON.stringify(result.definition)).not.toMatch(/function|source|invoke/)

    const runtime = new DynamicCodeRuntime()
    const execute = runtime.compileExpression<(context: UnknownRecord) => unknown>({
      surface: 'pendingEffectCode',
      contentId: result.definition.id,
      contentVersion: result.definition.version,
      code: result.compiled.code,
      entry: 'author code block',
    })
    expect(execute({
      payload: result.argumentBinding.payload,
      flow: { query: { piece: (id: string) => ({ instanceId: id, ownerPlayerId: 'player-red' }) } },
    })).toEqual({ owner: 'player-red' })
  })

  it('creates a fresh validated definition and keeps clone independence', () => {
    const source = armorBlock()
    const created = createAuthorCodeBlock({ id: source.id, graph: source.graph, signature: source.signature })
    const validated = validateAuthorCodeBlock(source)

    expect(created).toEqual(validated)
    const mutableGraph = validated.graph as unknown as { body: unknown[] }
    mutableGraph.body.push({ kind: 'return', id: 'extra' })
    expect(source.graph.body).toHaveLength(3)
    expect(validated.graph.body).toHaveLength(4)
    expect((source.graph.schemas?.[0].fields[0] as UnknownRecord).type).toBe('piece')
  })

  it('revalidates unregistered modules and typed port mismatches through the existing compiler', () => {
    const unregistered = clone(armorBlock()) as UnknownRecord
    const unregisteredGraph = unregistered.graph as UnknownRecord
    const unregisteredBody = unregisteredGraph.body as UnknownRecord[]
    unregisteredBody[1] = { ...unregisteredBody[1], module: 'author.unregistered' }
    expect(() => validateAuthorCodeBlock(unregistered)).toThrow(/module|registered|unknown/i)

    const mismatch = clone(armorBlock()) as UnknownRecord
    const mismatchGraph = mismatch.graph as UnknownRecord
    const mismatchSchema = mismatchGraph.schemas as UnknownRecord[]
    const mismatchFields = mismatchSchema[0].fields as UnknownRecord[]
    mismatchFields[0] = { ...mismatchFields[0], type: 'string' }
    const mismatchSignature = mismatch.signature as UnknownRecord
    mismatchSignature.inputs = [{ name: 'target', type: 'string' }]
    expect(() => compileAuthorCodeBlock(mismatch, GAMEPLAY_MODULE_REGISTRY)).toThrow(/expects piece|port|type/i)
  })

  it('rejects callback data, accessors, cycles, and static host references', () => {
    const callback = clone(armorBlock()) as UnknownRecord
    const callbackSignature = callback.signature as UnknownRecord
    ;(callbackSignature.inputs as UnknownRecord[]).push({ name: 'callback', type: 'string' })
    expect(() => validateAuthorCodeBlock({ ...callback, signature: { ...callbackSignature, callback: () => 1 } })).toThrow(/function|callback/i)

    const accessor = clone(armorBlock()) as UnknownRecord
    Object.defineProperty(accessor, 'id', { enumerable: true, get: () => 'armor.attack' })
    expect(() => validateAuthorCodeBlock(accessor)).toThrow(/accessor|data property/i)

    const cycle = clone(armorBlock()) as UnknownRecord
    const layout: UnknownRecord = {}
    layout.self = layout
    ;(cycle.graph as UnknownRecord).layout = layout
    expect(() => validateAuthorCodeBlock(cycle)).toThrow(/cycle/i)

    const staticBinding = clone(armorBlock()) as UnknownRecord
    ;(staticBinding.graph as UnknownRecord).inputBindings = { payload: { target: 'piece-1' } }
    expect(() => validateAuthorCodeBlock(staticBinding)).toThrow(/static|payload/i)

    const hostReference = clone(armorBlock()) as UnknownRecord
    ;(hostReference.graph as UnknownRecord).hostBindings = {
      payload: { kind: 'record', schema: 'armor-arguments@1' },
      targetPiece: 'piece',
    }
    expect(() => validateAuthorCodeBlock(hostReference)).toThrow(/payload|host binding/i)
  })

  it('rejects unsupported surfaces and argument binding mismatches', () => {
    const unsupported = clone(armorBlock()) as UnknownRecord
    ;(unsupported.graph as UnknownRecord).surface = 'skill'
    expect(() => validateAuthorCodeBlock(unsupported)).toThrow(/pending surface/i)

    expect(() => compileAuthorCodeBlockWithArguments(armorBlock(), {})).toThrow(/missing argument/i)
    expect(() => compileAuthorCodeBlockWithArguments(armorBlock(), { target: 42 })).toThrow(/entity|argument|piece/i)
    expect(() => compileAuthorCodeBlockWithArguments(armorBlock(), { target: 'piece-1', callback: () => 1 })).toThrow(/unknown argument/i)
    expect(() => compileAuthorCodeBlock(armorBlock(), GAMEPLAY_MODULE_REGISTRY, { maxExpandedStatements: 0 })).toThrow(/positive|option/i)
  })
})
