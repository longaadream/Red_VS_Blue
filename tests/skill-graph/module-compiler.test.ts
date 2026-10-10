import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph, GAMEPLAY_MODULE_COMPILER_VERSION } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayModuleRegistry, type GameplayValue } from '../../lib/skill-graph/module-types'

const version = '1'

function registryOf(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(item => [item.id + '@' + item.version, item]))
  return { get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version)) }
}

function descriptor(
  id: string,
  inputs: GameplayModuleDescriptor['inputs'],
  outputs: GameplayModuleDescriptor['outputs'],
  lower: GameplayModuleDescriptor['lower'],
  effects: GameplayModuleDescriptor['effects'] = { pure: true, previewSafe: true },
  allowedSurfaces: GameplayModuleDescriptor['allowedSurfaces'] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
): GameplayModuleDescriptor {
  return { id, version, label: id, inputs, outputs, allowedSurfaces, effects, lower }
}

function graph(surface: GameplayModuleGraph['surface'], body: GameplayModuleGraph['body'], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface, body, ...extra }
}

function call(id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}) {
  return { kind: 'call' as const, id, module, version, inputs }
}

const add = descriptor(
  'math.add',
  [{ name: 'left', type: 'number' }, { name: 'right', type: 'number' }],
  [{ name: 'value', type: 'number' }],
  ({ inputs }) => ({ expression: '({value: (' + inputs.left + ' + ' + inputs.right + ')})' }),
)

describe('semantic gameplay module compiler', () => {
  it('lowers a typed native call once into the existing skill host surface', () => {
    const compiled = compileGameplayModuleGraph(graph('skill', [
      call('sum', 'math.add', { left: { kind: 'literal', value: 2 }, right: { kind: 'literal', value: 3 } }),
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'sum', port: 'value' } } },
    ], { outputs: [{ name: 'result', type: 'number' }] }), registryOf(add))
    expect(compiled.compilerVersion).toBe(GAMEPLAY_MODULE_COMPILER_VERSION)
    expect(compiled.code).toContain('function executeSkill(context)')
    expect(compiled.code).not.toContain('eval(')
    expect(compiled.dependencies).toEqual([{ id: 'math.add', version, kind: 'native' }])
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ result: 5 })
  })

  it('executes trusted statement lowerings with a result assignment', () => {
    const statementModule = descriptor(
      'test.statement',
      [],
      [{ name: 'value', type: 'number' }],
      () => ({ statements: 'context.count += 1;', result: 'context.count' }),
      { pure: false, writes: ['test'], previewSafe: false },
      ['skill'],
    )
    const compiled = compileGameplayModuleGraph(graph('skill', [
      call('increment', 'test.statement'),
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'increment', port: 'value' } } },
    ], { outputs: [{ name: 'result', type: 'number' }] }), registryOf(statementModule))
    const execute = runInNewContext('(' + compiled.code + ')') as (context: { count: number }) => unknown
    expect(execute({ count: 2 })).toEqual({ result: 3 })
  })

  it('accepts a JSON-shaped graph crossing a VM realm boundary', () => {
    const foreignGraph = runInNewContext(`({
      version: ${JSON.stringify(GAMEPLAY_MODULE_GRAPH_VERSION)},
      surface: 'skill',
      body: [
        { kind: 'call', id: 'sum', module: 'math.add', version: ${JSON.stringify(version)}, inputs: {
          left: { kind: 'literal', value: 2 }, right: { kind: 'literal', value: 3 }
        } },
        { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'sum', port: 'value' } } }
      ],
      outputs: [{ name: 'result', type: 'number' }]
    })`)
    const compiled = compileGameplayModuleGraph(foreignGraph, registryOf(add))
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ result: 5 })
  })

  it('preserves paired Unicode surrogates while rejecting unschematized records', () => {
    const unicode = compileGameplayModuleGraph(graph('skill', [{ kind: 'return', id: 'done', value: { kind: 'literal', value: '🙂' } }], { outputs: [{ name: 'value', type: 'string' }] }), registryOf(add))
    const execute = runInNewContext('(' + unicode.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual('🙂')
    expect(() => compileGameplayModuleGraph(graph('skill', [{ kind: 'return', id: 'record', value: { kind: 'literal', value: { unsafe: true } } as never }], { outputs: [{ name: 'value', type: 'record' }] }), registryOf(add))).toThrow(/record schema|structured literal/)
  })

  it('skips stale entity dependents while continuing independent calls', () => {
    const producePiece = descriptor('test.produce-piece', [], [{ name: 'piece', type: 'piece' }], () => ({ expression: "'gone'" }), { pure: true, previewSafe: true }, ['skill'])
    const readPiece = descriptor('test.read-piece', [{ name: 'piece', type: 'piece' }], [{ name: 'value', type: 'number' }], ({ inputs }) => ({ expression: 'context.read(' + inputs.piece + ')' }), { pure: true, previewSafe: true }, ['skill'])
    const consume = descriptor('test.consume', [{ name: 'value', type: 'number' }], [], ({ inputs }) => ({ expression: 'context.consume(' + inputs.value + ')' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const independent = descriptor('test.independent', [], [], () => ({ expression: 'context.values.push(1)' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const compiled = compileGameplayModuleGraph(graph('skill', [
      call('piece', 'test.produce-piece'),
      call('read', 'test.read-piece', { piece: { kind: 'output', node: 'piece', port: 'piece' } }),
      call('use', 'test.consume', { value: { kind: 'output', node: 'read', port: 'value' } }),
      call('independent', 'test.independent'),
    ]), registryOf(producePiece, readPiece, consume, independent))
    const context = {
      values: [] as number[],
      read: () => { throw new Error('stale reader should be skipped') },
      consume: () => { throw new Error('dependent should be skipped') },
    }
    const execute = runInNewContext('(' + compiled.code + ')', { flow: { query: { hasPiece: () => false } } }) as (value: typeof context) => unknown
    execute(context)
    expect(context.values).toEqual([1])
  })

  it('lets trusted reference predicates inspect stale non-null IDs while effects still skip', () => {
    const producePiece = descriptor('test.inspect-piece', [], [{ name: 'piece', type: 'piece' }], () => ({ expression: "'gone'" }), { pure: true, previewSafe: true }, ['skill'])
    const inspectPiece = {
      ...descriptor('test.inspect-exists', [{ name: 'piece', type: 'piece' }], [{ name: 'exists', type: 'boolean' }], ({ inputs }) => ({ expression: 'flow.query.hasPiece(' + inputs.piece + ')' }), { pure: true, previewSafe: true }, ['skill']),
      inspectReferences: ['piece'] as const,
    }
    const recordPredicate = descriptor('test.record-predicate', [{ name: 'exists', type: 'boolean' }], [], ({ inputs }) => ({ expression: 'context.predicates.push(' + inputs.exists + ')' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const effect = descriptor('test.inspect-effect', [{ name: 'piece', type: 'piece' }], [], ({ inputs }) => ({ expression: 'context.effects.push(' + inputs.piece + ')' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const compiled = compileGameplayModuleGraph(graph('skill', [
      call('piece', 'test.inspect-piece'),
      call('predicate', 'test.inspect-exists', { piece: { kind: 'output', node: 'piece', port: 'piece' } }),
      call('record', 'test.record-predicate', { exists: { kind: 'output', node: 'predicate', port: 'exists' } }),
      call('effect', 'test.inspect-effect', { piece: { kind: 'output', node: 'piece', port: 'piece' } }),
    ]), registryOf(producePiece, inspectPiece, recordPredicate, effect))
    let hasPieceCalls = 0
    const context = { predicates: [] as boolean[], effects: [] as string[] }
    const execute = runInNewContext('(' + compiled.code + ')', {
      flow: {
        query: {
          hasPiece: () => { hasPieceCalls += 1; return false },
        },
      },
    }) as (value: typeof context) => unknown
    execute(context)
    expect(context.predicates).toEqual([false])
    expect(context.effects).toEqual([])
    expect(hasPieceCalls).toBe(2)
  })

  it('propagates invalid branch conditions through composite outputs', () => {
    const producePiece = descriptor('test.condition-piece', [], [{ name: 'piece', type: 'piece' }], () => ({ expression: "'gone'" }), { pure: true, previewSafe: true }, ['skill'])
    const readPiece = descriptor('test.condition-read', [{ name: 'piece', type: 'piece' }], [{ name: 'value', type: 'number' }], ({ inputs }) => ({ expression: 'context.read(' + inputs.piece + ')' }), { pure: true, previewSafe: true }, ['skill'])
    const toBoolean = descriptor('test.condition-bool', [{ name: 'value', type: 'number' }], [{ name: 'value', type: 'boolean' }], ({ inputs }) => ({ expression: 'context.toBoolean(' + inputs.value + ')' }), { pure: true, previewSafe: true }, ['skill'])
    const consume = descriptor('test.condition-consume', [{ name: 'value', type: 'number' }], [], ({ inputs }) => ({ expression: 'context.consume(' + inputs.value + ')' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const independent = descriptor('test.condition-independent', [], [], () => ({ expression: 'context.values.push(1)' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const composite = {
      id: 'test.invalid-branch', version, inputs: [], outputs: [{ name: 'value', type: 'number' as const }], body: [
        call('piece', 'test.condition-piece'),
        call('read', 'test.condition-read', { piece: { kind: 'output', node: 'piece', port: 'piece' } }),
        call('condition', 'test.condition-bool', { value: { kind: 'output', node: 'read', port: 'value' } }),
        {
          kind: 'if' as const, id: 'branch', condition: { kind: 'output' as const, node: 'condition', port: 'value' },
          then: [{ kind: 'return' as const, id: 'then-return', value: { kind: 'literal' as const, value: 1 } }],
          else: [{ kind: 'return' as const, id: 'else-return', value: { kind: 'literal' as const, value: 2 } }],
        },
      ],
    }
    const compiled = compileGameplayModuleGraph(graph('skill', [
      call('result', 'test.invalid-branch'),
      call('use', 'test.condition-consume', { value: { kind: 'output', node: 'result', port: 'value' } }),
      call('independent', 'test.condition-independent'),
      { kind: 'return', id: 'done', values: { value: { kind: 'output', node: 'result', port: 'value' } } },
    ], { outputs: [{ name: 'value', type: 'number' }], composites: [composite] }), registryOf(producePiece, readPiece, toBoolean, consume, independent))
    const context = {
      values: [] as number[],
      read: () => { throw new Error('stale branch input should be skipped') },
      toBoolean: () => { throw new Error('invalid condition should be skipped') },
      consume: () => { throw new Error('invalid composite output should be skipped') },
    }
    const execute = runInNewContext('(' + compiled.code + ')', { flow: { query: { hasPiece: () => false } } }) as (value: typeof context) => unknown
    expect(execute(context)).toBeUndefined()
    expect(context.values).toEqual([1])
  })

  it('propagates omitted optional composite inputs instead of evaluating NaN', () => {
    const consume = descriptor('test.optional-consume', [{ name: 'value', type: 'number' }], [], ({ inputs }) => ({ expression: 'context.consume(' + inputs.value + ')' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const independent = descriptor('test.optional-independent', [], [], () => ({ expression: 'context.values.push(1)' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const composite = {
      id: 'test.optional', version, inputs: [{ name: 'amount', type: 'number' as const, optional: true }], outputs: [{ name: 'value', type: 'number' as const }], body: [
        call('sum', 'math.add', { left: { kind: 'input', name: 'amount' }, right: { kind: 'literal', value: 1 } }),
        { kind: 'return' as const, id: 'done', value: { kind: 'output' as const, node: 'sum', port: 'value' } },
      ],
    }
    const compiled = compileGameplayModuleGraph(graph('skill', [
      call('result', 'test.optional'),
      call('use', 'test.optional-consume', { value: { kind: 'output', node: 'result', port: 'value' } }),
      call('independent', 'test.optional-independent'),
    ], { composites: [composite] }), registryOf(add, consume, independent))
    const context = { values: [] as number[], consume: () => { throw new Error('omitted optional value should be skipped') } }
    const execute = runInNewContext('(' + compiled.code + ')') as (value: typeof context) => unknown
    execute(context)
    expect(context.values).toEqual([1])
  })

  it('expands a reusable composite and retains typed output references', () => {
    const composite = {
      id: 'math.double',
      version,
      inputs: [{ name: 'value', type: 'number' as const }],
      outputs: [{ name: 'value', type: 'number' as const }],
      body: [
        call('inner-sum', 'math.add', { left: { kind: 'input', name: 'value' }, right: { kind: 'input', name: 'value' } }),
        { kind: 'return' as const, id: 'inner-return', value: { kind: 'output' as const, node: 'inner-sum', port: 'value' } },
      ],
    }
    const compiled = compileGameplayModuleGraph(graph('card', [
      call('double', 'math.double', { value: { kind: 'literal', value: 4 } }),
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'double', port: 'value' } } },
    ], { outputs: [{ name: 'result', type: 'number' }], composites: [composite] }), registryOf(add))
    expect(compiled.code).toContain('function executeCard(context)')
    expect(compiled.expanded.calls.map(entry => entry.kind)).toEqual(['composite', 'native'])
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ result: 8 })
  })

  it('executes structured if/foreach statements through native lowering once per iteration', () => {
    let lowerCalls = 0
    const push = descriptor(
      'test.push',
      [{ name: 'value', type: 'number' }],
      [],
      ({ inputs }) => {
        lowerCalls += 1
        return { expression: 'context.values.push(' + inputs.value + ')' }
      },
      { pure: false, writes: ['test'], previewSafe: false },
      ['skill'],
    )
    const compiled = compileGameplayModuleGraph(graph('skill', [
      {
        kind: 'if', id: 'guard', condition: { kind: 'literal', value: true }, then: [{
          kind: 'foreach', id: 'each', items: { kind: 'literal', value: [1, 2, 3] }, item: 'current', body: [
            call('push-value', 'test.push', { value: { kind: 'output', node: 'each', port: 'item' } }),
          ],
        }], else: [],
      },
      { kind: 'return', id: 'done' },
    ]), registryOf(push))
    expect(lowerCalls).toBe(1)
    const context = { values: [] as number[] }
    const execute = runInNewContext('(' + compiled.code + ')') as (value: typeof context) => unknown
    execute(context)
    expect(context.values).toEqual([1, 2, 3])
  })

  it('uses the current wrappers for rule, pending, preview, and card surfaces', () => {
    const registry = registryOf()
    const rule = compileGameplayModuleGraph(graph('rule', [{ kind: 'return', id: 'done', value: { kind: 'literal', value: 1 } }], { outputs: [{ name: 'value', type: 'number' }] }), registry)
    const pending = compileGameplayModuleGraph(graph('pending', [{ kind: 'return', id: 'done', value: { kind: 'literal', value: 1 } }], { outputs: [{ name: 'value', type: 'number' }] }), registry)
    const preview = compileGameplayModuleGraph(graph('preview', [{ kind: 'return', id: 'done', value: { kind: 'literal', value: 1 } }], { outputs: [{ name: 'value', type: 'number' }] }), registry)
    const card = compileGameplayModuleGraph(graph('card', [{ kind: 'return', id: 'done', value: { kind: 'literal', value: 1 } }], { outputs: [{ name: 'value', type: 'number' }] }), registry)
    expect(rule.code).not.toContain('function ')
    expect(pending.code).toContain('function(ctx)')
    expect(preview.code).toContain('function calculatePreview(piece, skillDef, currentCooldown)')
    expect(card.code).toContain('function executeCard(context)')
  })

  it('rejects unsafe author fields, bad ports, branch leaks, and preview effects', () => {
    expect(() => compileGameplayModuleGraph(graph('skill', [{ ...call('bad', 'math.add'), source: 'return context' } as never]), registryOf(add))).toThrow(/unknown field/)
    expect(() => compileGameplayModuleGraph(graph('skill', [{ kind: 'return', id: 'bad', value: { kind: 'get', object: { kind: 'input', name: 'x' }, key: 'hp' } as never }], { outputs: [{ name: 'value', type: 'number' }] }), registryOf(add))).toThrow(/unsupported value kind/)
    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'if', id: 'branch', condition: { kind: 'literal', value: true }, then: [call('hidden', 'math.add', { left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } })] },
      { kind: 'return', id: 'leak', value: { kind: 'output', node: 'hidden', port: 'value' } },
    ], { outputs: [{ name: 'value', type: 'number' }] }), registryOf(add))).toThrow(/scope|dominate/)
    const effect = descriptor('state.write', [], [], () => ({ expression: 'context.state.push(1)' }), { pure: false, writes: ['state'], previewSafe: false }, ['preview'])
    const composite = { id: 'unsafe.preview', version, inputs: [], outputs: [], allowedSurfaces: ['preview'] as const, body: [call('write', 'state.write'), { kind: 'return' as const, id: 'done' }] }
    expect(() => compileGameplayModuleGraph(graph('preview', [call('unsafe', 'unsafe.preview'), { kind: 'return', id: 'done' }], { composites: [composite] }), registryOf(effect))).toThrow(/preview/)
  })

  it('rejects composite cycles, universal port types, and mutable root context lookup', () => {
    const cycle = { id: 'loop', version, inputs: [], outputs: [], body: [call('again', 'loop'), { kind: 'return' as const, id: 'done' }] }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('loop', 'loop')], { composites: [cycle] }), registryOf())).toThrow(/cycle/)
    const fallthrough = { id: 'fallthrough', version, inputs: [], outputs: [{ name: 'value', type: 'number' as const }], body: [call('inner', 'math.add', { left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } })] }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('fallthrough', 'fallthrough')], { composites: [fallthrough] }), registryOf(add))).toThrow(/fall through|return|output/)
    const parameterized = { id: 'parameterized', version, inputs: [], outputs: [], parameters: [{ name: 'mode', type: 'string' as const }], body: [{ kind: 'return' as const, id: 'done' }] }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('parameterized', 'parameterized')], { composites: [parameterized] }), registryOf())).toThrow(/composite parameters/)
    expect(() => compileGameplayModuleGraph(graph('preview', [{ kind: 'return', id: 'done', value: { kind: 'input', name: 'piece' } }], { inputs: [{ name: 'piece', type: 'number' }], outputs: [{ name: 'value', type: 'number' }] }), registryOf())).toThrow(/preview host|incompatible|type/)
    const universal = descriptor('bad.type', [], [{ name: 'value', type: 'unknown' as never }], () => ({ expression: '1' }))
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.type'), { kind: 'return', id: 'done' }]), registryOf(universal))).toThrow(/universal|type/)
    expect(() => compileGameplayModuleGraph(graph('skill', [{ kind: 'return', id: 'bad', value: { kind: 'input', name: 'context.hp' } }], { outputs: [{ name: 'value', type: 'number' }] }), registryOf())).toThrow(/static|root input|unknown input/)
    expect(() => compileGameplayModuleGraph(graph('skill', [{ kind: 'return', id: 'large', value: { kind: 'literal', value: 'long' } }], { outputs: [{ name: 'value', type: 'string' }] }), registryOf(), { maxLiteralBytes: 2 })).toThrow(/budget/)
    const duplicatePorts = descriptor('bad.ports', [{ name: 'value', type: 'number' }, { name: 'value', type: 'number' }], [], () => ({ expression: '0' }))
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.ports')]), registryOf(duplicatePorts))).toThrow(/duplicate port/)
    const unsafePort = descriptor('bad.name', [{ name: '__proto__', type: 'number' }], [], () => ({ expression: '0' }))
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.name')]), registryOf(unsafePort))).toThrow(/unsafe name/)
    const invalidInspection = { ...descriptor('bad.inspect', [{ name: 'value', type: 'number' }], [], () => ({ expression: '0' })), inspectReferences: ['value'] as const }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.inspect')]), registryOf(invalidInspection))).toThrow(/piece or player/)
    const unknownInspection = { ...descriptor('bad.inspect-missing', [], [], () => ({ expression: '0' })), inspectReferences: ['missing'] as const }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.inspect-missing')]), registryOf(unknownInspection))).toThrow(/unknown input/)
  })
})
