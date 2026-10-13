import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph, compileGameplayModuleGraphV1, GAMEPLAY_MODULE_COMPILER_VERSION } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayLiteral, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayModuleRegistry, type GameplayValue } from '../../lib/skill-graph/module-types'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { AUTHOR_PIECE_TEMPLATE_SCHEMA_ID, AUTHOR_SUMMON_RECORD_SCHEMAS } from '../../lib/game/author-summon-schema'

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

  it('accepts an author map literal for a strongly typed map input', () => {
    const optionsType = { kind: 'map' as const, key: 'string' as const, value: 'boolean' as const }
    const choose = {
      ...descriptor(
        'test.choose',
        [{ name: 'options', type: 'record' }],
        [{ name: 'value', type: 'record' }],
        ({ inputs }) => ({ expression: '({value: ' + inputs.options + '})' }),
      ),
      inputValueTypeBindings: { options: { parameter: 'optionsType' } },
      outputValueTypeBindings: { value: { parameter: 'optionsType' } },
      parameters: [{ name: 'optionsType', type: 'string' as const }],
    }
    const options = {
      format: 'author-map/v1' as const,
      entries: [
        ['传送并在原地留下分身', true],
        ['在目标格召唤分身', false],
      ] as const,
    }
    const compiled = compileGameplayModuleGraph(graph('skill', [
      { ...call('choose', choose.id, { options: { kind: 'literal', value: options } }), parameters: { optionsType: JSON.stringify(optionsType) } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'choose', port: 'value' } },
    ], { outputs: [{ name: 'value', type: optionsType }] }), registryOf(choose))
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual(options)
  })

  it('compiles the real choice v3 map input emitted by the recursive map editor', () => {
    const compiled = compileGameplayModuleGraph(graph('skill', [
      {
        kind: 'call', id: 'choice', module: 'author.choice.option', version: '3',
        inputs: {
          options: {
            kind: 'literal',
            value: {
              format: 'author-map/v1',
              entries: [['传送并在原地留下分身', true], ['在目标格召唤分身', false]],
            },
          },
        },
        parameters: {
          optionsType: '{"kind":"map","key":"string","value":"boolean"}',
          valueType: 'boolean',
          selectionMode: 'single',
          title: '是否传送并在原地留下分身',
          canCancel: false,
        },
      },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'choice', port: 'value' } },
    ], { outputs: [{ name: 'value', type: 'boolean' }] }), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('authorMapItems')
  })

  it('accepts plain JSON records in declared record fields while rejecting array values', () => {
    const schema = AUTHOR_SUMMON_RECORD_SCHEMAS.find(entry => entry.id + '@' + entry.version === AUTHOR_PIECE_TEMPLATE_SCHEMA_ID)
    if (!schema) throw new Error('author piece template schema is not registered')
    const compileTemplate = (extension: GameplayLiteral | undefined) => compileGameplayModuleGraph(graph('skill', [
      {
        kind: 'record.create', id: 'template', schema: AUTHOR_PIECE_TEMPLATE_SCHEMA_ID,
        fields: extension === undefined ? {} : { extension: { kind: 'literal', value: extension } },
      },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'template', port: 'value' } },
      ], { outputs: [{ name: 'value', type: { kind: 'record', schema: AUTHOR_PIECE_TEMPLATE_SCHEMA_ID } }] }), GAMEPLAY_MODULE_REGISTRY)
    const extension = { '影分身标记': 'shadow-clone' }
    const compiled = compileTemplate(extension)
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ extension })
    expect(runInNewContext('(' + compileTemplate(undefined).code + ')')({})).toEqual({})
    expect(runInNewContext('(' + compileTemplate({}).code + ')')({})).toEqual({ extension: {} })
    expect(() => compileTemplate([])).toThrow(/record field "extension" expects record/)
  })

  it('does not treat an arbitrary json input or record.get result as a record', () => {
    const sourceSchema = { id: 'json-source', version: '1', fields: [{ name: 'payload', type: 'json' as const }] }
    const targetSchema = { id: 'json-target', version: '1', fields: [{ name: 'extension', type: 'record' as const }] }
    const inputGraph = graph('skill', [
      {
        kind: 'record.create', id: 'target', schema: 'json-target@1',
        fields: { extension: { kind: 'input', name: 'payload' } },
      },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'target', port: 'value' } },
    ], {
      inputs: [{ name: 'payload', type: 'json' }],
      inputBindings: { payload: 'runtime-json' },
      schemas: [targetSchema],
      outputs: [{ name: 'value', type: { kind: 'record', schema: 'json-target@1' } }],
    })
    expect(() => compileGameplayModuleGraph(inputGraph, registryOf())).toThrow(/record field "extension" expects record, got json/)

    const getGraph = graph('skill', [
      {
        kind: 'record.create', id: 'source', schema: 'json-source@1',
        fields: { payload: { kind: 'literal', value: { arbitrary: true } } },
      },
      { kind: 'record.get', id: 'payload', record: { kind: 'output', node: 'source', port: 'value' }, field: 'payload' },
      {
        kind: 'record.create', id: 'target', schema: 'json-target@1',
        fields: { extension: { kind: 'output', node: 'payload', port: 'value' } },
      },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'target', port: 'value' } },
    ], {
      schemas: [sourceSchema, targetSchema],
      outputs: [{ name: 'value', type: { kind: 'record', schema: 'json-target@1' } }],
    })
    expect(() => compileGameplayModuleGraph(getGraph, registryOf())).toThrow(/record field "extension" expects record, got json/)
  })

  it('round-trips record node layout metadata without changing generated code', () => {
    const schema = { id: 'layout-record', version: '1', fields: [{ name: 'value', type: 'number' as const }] }
    const makeGraph = (layouts: Readonly<Record<string, unknown>> = {}) => ({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill' as const,
      schemas: [schema],
      outputs: [{ name: 'value', type: { kind: 'record' as const, schema: 'layout-record@1' } }],
      body: [
        {
          kind: 'record.create' as const,
          id: 'source',
          schema: 'layout-record@1',
          fields: { value: { kind: 'literal' as const, value: 1 } },
          ...(layouts.create === undefined ? {} : { layout: layouts.create }),
        },
        {
          kind: 'record.get' as const,
          id: 'read',
          record: { kind: 'output' as const, node: 'source', port: 'value' },
          field: 'value',
          ...(layouts.get === undefined ? {} : { layout: layouts.get }),
        },
        {
          kind: 'record.with' as const,
          id: 'updated',
          record: { kind: 'output' as const, node: 'source', port: 'value' },
          fields: { value: { kind: 'literal' as const, value: 2 } },
          ...(layouts.with === undefined ? {} : { layout: layouts.with }),
        },
        { kind: 'return' as const, id: 'done', value: { kind: 'output' as const, node: 'updated', port: 'value' } },
      ],
    })
    const plain = compileGameplayModuleGraph(makeGraph(), registryOf())
    const layouts = {
      create: { sentenceExpression: { owner: 'source', input: 'value' }, position: { x: 12, y: 34 } },
      get: { sentenceExpression: { owner: 'read', input: 'record' }, tags: ['读取'] },
      with: { sentenceExpression: { owner: 'updated', input: 'value' }, collapsed: false },
    }
    const saved = JSON.parse(JSON.stringify(makeGraph(layouts))) as unknown
    const reloaded = compileGameplayModuleGraph(saved, registryOf())
    expect((saved as { body: readonly { layout?: unknown }[] }).body.map(node => node.layout).filter(layout => layout !== undefined)).toEqual(Object.values(layouts))
    expect(reloaded.code).toBe(plain.code)
    const execute = runInNewContext('(' + reloaded.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ value: 2 })
  })

  it('rejects non-JSON record node layout metadata at the source boundary', () => {
    const schema = { id: 'layout-record-malicious', version: '1', fields: [{ name: 'value', type: 'number' as const }] }
    const makeGraph = (kind: 'record.create' | 'record.get' | 'record.with') => ({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill' as const,
      schemas: [schema],
      outputs: [{ name: 'value', type: { kind: 'record' as const, schema: 'layout-record-malicious@1' } }],
      body: [
        {
          kind: 'record.create' as const,
          id: 'source',
          schema: 'layout-record-malicious@1',
          fields: { value: { kind: 'literal' as const, value: 1 } },
        },
        kind === 'record.create'
          ? { kind: 'record.create' as const, id: 'bad', schema: 'layout-record-malicious@1', layout: { editor: () => true } }
          : kind === 'record.get'
            ? { kind: 'record.get' as const, id: 'bad', record: { kind: 'output' as const, node: 'source', port: 'value' }, field: 'value', layout: { editor: () => true } }
            : { kind: 'record.with' as const, id: 'bad', record: { kind: 'output' as const, node: 'source', port: 'value' }, fields: { value: { kind: 'literal' as const, value: 2 } }, layout: { editor: () => true } },
        { kind: 'return' as const, id: 'done', value: { kind: 'output' as const, node: 'source', port: 'value' } },
      ],
    })
    for (const kind of ['record.create', 'record.get', 'record.with'] as const) {
      expect(() => compileGameplayModuleGraph(makeGraph(kind), registryOf())).toThrow(/functions and non-JSON values are not allowed/)
    }
  })

  it('keeps graph schema order in lowering contexts when the registry has extra built-ins', () => {
    const graphSchema = { id: 'graph-record', version: '1', fields: [{ name: 'value', type: 'number' as const }] }
    const builtinSchema = { id: 'registry-record', version: '1', fields: [{ name: 'value', type: 'number' as const }] }
    const inspect = {
      ...descriptor('test.inspect-schemas', [], [{ name: 'value', type: 'string' }], ({ recordSchemas }) => ({
        expression: JSON.stringify((recordSchemas ?? []).map(schema => schema.id + '@' + schema.version)),
      })),
      recordSchemas: [builtinSchema],
    }
    const registry = {
      descriptors: [inspect],
      get: (id: string, requestedVersion?: string) => id === inspect.id && (requestedVersion ?? version) === version ? inspect : undefined,
    }
    const compiled = compileGameplayModuleGraphV1(graph('skill', [
      call('inspect', inspect.id),
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'inspect', port: 'value' } },
    ], { outputs: [{ name: 'value', type: 'string' }], schemas: [graphSchema] }), registry)
    expect(compiled.code).toContain('["graph-record@1"]')
    expect(compiled.code).not.toContain('registry-record@1')
  })

  it.each([false, true])('adds transitive built-in schema dependencies (root already declared=%s)', declaredRoot => {
    const dependencySchema = { id: 'registry-dependency', version: '1', fields: [{ name: 'value', type: 'number' as const }] }
    const rootSchema = { id: 'registry-root', version: '1', fields: [{ name: 'child', type: { kind: 'record' as const, schema: 'registry-dependency@1' } }] }
    const typed = {
      ...descriptor('test.typed-schemas', [], [{ name: 'value', type: 'record' }], ({ recordSchemas }) => ({
        expression: JSON.stringify((recordSchemas ?? []).map(schema => schema.id + '@' + schema.version)),
      })),
      recordSchemas: [rootSchema, dependencySchema],
      outputValueTypeBindings: { value: { parameter: 'valueType' } },
      parameters: [{ name: 'valueType', type: 'string' as const }],
    }
    const registry = {
      descriptors: [typed],
      get: (id: string, requestedVersion?: string) => id === typed.id && (requestedVersion ?? version) === version ? typed : undefined,
    }
    const compiled = compileGameplayModuleGraphV1(graph('skill', [
      { ...call('typed', typed.id), parameters: { valueType: '{"kind":"record","schema":"registry-root@1"}' } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'typed', port: 'value' } },
    ], { outputs: [{ name: 'value', type: 'record' }], ...(declaredRoot ? { schemas: [rootSchema] } : {}) }), registry)
    expect(compiled.code).toContain('["registry-root@1","registry-dependency@1"]')
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

  it('invalidates living reference dependents for dead or removed pieces while continuing branches and the independent tail', () => {
    const producePiece = descriptor('test.living-piece', [], [{ name: 'piece', type: 'piece' }], () => ({ expression: '"piece-id"' }), { pure: true, previewSafe: true }, ['skill'])
    const livingPredicate = {
      ...descriptor('test.living-predicate', [{ name: 'piece', type: 'piece' }], [{ name: 'value', type: 'boolean' }], () => ({ expression: '({value: (context.values.push("predicate"), true)})' }), { pure: true, previewSafe: true }, ['skill']),
      livingReferences: ['piece'] as const,
    }
    const thenBranch = descriptor('test.living-then', [], [], () => ({ expression: 'context.values.push("then")' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const elseBranch = descriptor('test.living-else', [], [], () => ({ expression: 'context.values.push("else")' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const independent = descriptor('test.living-independent', [], [], () => ({ expression: 'context.values.push("independent")' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const input = graph('skill', [
      call('piece', 'test.living-piece'),
      call('predicate', 'test.living-predicate', { piece: { kind: 'output', node: 'piece', port: 'piece' } }),
      {
        kind: 'if', id: 'branch', condition: { kind: 'output', node: 'predicate', port: 'value' },
        then: [call('then', 'test.living-then')], else: [call('else', 'test.living-else')],
      },
      call('independent', 'test.living-independent'),
    ])
    const compiled = compileGameplayModuleGraph(input, registryOf(producePiece, livingPredicate, thenBranch, elseBranch, independent))
    const aliveFlow = { query: { hasPiece: () => true, piece: () => ({ currentHp: 2 }) } }
    const deadFlow = { query: { hasPiece: () => true, piece: () => ({ currentHp: 0 }) } }
    const removedFlow = { query: { hasPiece: () => false, piece: () => undefined } }
    const invoke = (flow: unknown) => {
      const values: string[] = []
      const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (context: unknown) => unknown
      execute({ values })
      return values
    }
    expect(invoke(aliveFlow)).toEqual(['predicate', 'then', 'independent'])
    expect(invoke(deadFlow)).toEqual(['independent'])
    expect(invoke(removedFlow)).toEqual(['independent'])
    expect(invoke({ query: { hasPiece: () => true } })).toEqual(['independent'])
  })

  it('keeps unmarked references on the legacy v1 path without adding living checks', () => {
    const producer = descriptor('test.legacy-producer', [], [{ name: 'piece', type: 'piece' }], () => ({ expression: '"piece-id"' }), { pure: true, previewSafe: true }, ['skill'])
    const legacyReader = descriptor('test.legacy-reader', [{ name: 'piece', type: 'piece' }], [{ name: 'value', type: 'number' }], ({ inputs }) => ({ expression: '({value: context.values.push(' + inputs.piece + ')})' }), { pure: false, writes: ['test'], previewSafe: false }, ['skill'])
    const input = graph('skill', [
      call('piece', 'test.legacy-producer'),
      call('read', 'test.legacy-reader', { piece: { kind: 'output', node: 'piece', port: 'piece' } }),
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'read', port: 'value' } },
    ], { outputs: [{ name: 'value', type: 'number' }] })
    const compiled = compileGameplayModuleGraphV1(input, registryOf(producer, legacyReader))
    expect(compiled.code).not.toContain('currentHp')
    expect(compiled.code).not.toContain('__gameplayRecordFault')
    const execute = runInNewContext('(' + compiled.code + ')') as (context: { values: string[] }) => unknown
    expect(execute({ values: [] })).toEqual(1)
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

  it('honors an explicit preview prohibition even for pure host queries', () => {
    const hostQuery = descriptor('host.read', [], [], () => 'flow.cards.hand("player-red")', { pure: true, previewSafe: false }, ['skill', 'preview'])
    const registry = registryOf(hostQuery)
    expect(() => compileGameplayModuleGraph(graph('skill', [call('read', 'host.read')]), registry)).not.toThrow()
    expect(() => compileGameplayModuleGraph(graph('preview', [call('read', 'host.read')]), registry)).toThrow(/preview/)
    const composite = { id: 'nested.read', version, inputs: [], outputs: [], allowedSurfaces: ['preview'] as const, body: [call('read', 'host.read')] }
    expect(() => compileGameplayModuleGraph(graph('preview', [call('nested', 'nested.read')], { composites: [composite] }), registry)).toThrow(/preview/)
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
    const unknownLiving = { ...descriptor('bad.living-missing', [], [], () => ({ expression: '0' })), livingReferences: ['missing'] as const }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.living-missing')]), registryOf(unknownLiving))).toThrow(/livingReferences names unknown input/)
    const nonPieceLiving = { ...descriptor('bad.living-player', [{ name: 'player', type: 'player' }], [], () => ({ expression: '0' })), livingReferences: ['player'] as const }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.living-player', { player: { kind: 'literal', value: 'player-id' } })]), registryOf(nonPieceLiving))).toThrow(/livingReferences input .*piece reference/)
    const conflictingReferences = { ...descriptor('bad.living-conflict', [{ name: 'piece', type: 'piece' }], [], () => ({ expression: '0' })), livingReferences: ['piece'] as const, inspectReferences: ['piece'] as const }
    expect(() => compileGameplayModuleGraph(graph('skill', [call('bad', 'bad.living-conflict', { piece: { kind: 'literal', value: 'piece-id' } })]), registryOf(conflictingReferences))).toThrow(/both livingReferences and inspectReferences/)
  })
})
