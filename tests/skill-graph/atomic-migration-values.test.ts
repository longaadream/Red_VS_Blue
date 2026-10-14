import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { atomicValuesRecipe, migrateValueModules } from '../../lib/skill-graph/atomic-migration-values'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GENERIC_VALUE_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-generic-values'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayLiteral,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
} from '../../lib/skill-graph/module-types'

const version = '1'

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayLiteral>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

function graph(body: readonly GameplayStatement[], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, ...extra }
}

function callsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  const visit = (statements: readonly GameplayStatement[]): void => {
    if (!Array.isArray(statements)) return
    for (const statement of statements) {
      if (statement.kind === 'call') result.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        if (statement.else) visit(statement.else)
      } else if (statement.kind === 'foreach' || statement.kind === 'while' || statement.kind === 'collection' || statement.kind.startsWith('collection.')) {
        if (Array.isArray(statement.body)) visit(statement.body)
      }
    }
  }
  visit(body)
  return result
}

const pieceList: GameplayValueType = { kind: 'list', element: 'piece' }
const cellList: GameplayValueType = { kind: 'list', element: 'cell' }

function testDescriptor(id: string, outputType: GameplayValueType, expression: string): GameplayModuleDescriptor {
  return {
    id,
    version,
    label: id,
    inputs: [],
    outputs: [{ name: 'value', type: outputType }],
    allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true },
    lower: () => expression,
  }
}

const testPieces: GameplayModuleDescriptor = {
  ...testDescriptor('test.pieces', pieceList, '["piece-a", "piece-b"]'),
  outputs: [{ name: 'pieces', type: pieceList }],
}
const testCells: GameplayModuleDescriptor = {
  ...testDescriptor('test.cells', cellList, '[{x:-3,y:4},{x:1,y:1}]'),
  outputs: [{ name: 'cells', type: cellList }],
}
const testEmptyCells: GameplayModuleDescriptor = {
  ...testDescriptor('test.empty-cells', cellList, '[]'),
  outputs: [{ name: 'cells', type: cellList }],
}

function registryWith(...extra: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const generic = [...GENERIC_VALUE_GAMEPLAY_MODULES]
  const local = new Map([...generic, ...extra].map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return {
    get: (id, requestedVersion) => local.get(id + '@' + (requestedVersion ?? version)) ?? GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
    resolve: (id, requestedVersion) => local.get(id + '@' + (requestedVersion ?? version)) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, requestedVersion),
    descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...generic, ...extra],
  }
}

function execute(source: GameplayModuleGraph, registry: GameplayModuleRegistry = registryWith()): { compiled: ReturnType<typeof compileGameplayModuleGraph>; value: unknown } {
  const compiled = compileGameplayModuleGraph(source, registry)
  const run = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
  return { compiled, value: run({}) }
}

function scalarGraph(statement: GameplayCallStatement, outputPort: string, outputType: GameplayValueType, extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return graph([
    statement,
    { kind: 'return', id: 'done', values: { result: output(statement.id, outputPort) } },
  ], { outputs: [{ name: 'result', type: outputType }], ...extra })
}

describe('atomic generic value migrations', () => {
  it('rewrites every bounded compatibility helper and keeps the source graph idempotent', () => {
    const source = graph([
      call('count-text', 'list.count', { items: literal(['a', 'b']) }),
      call('count-pieces', 'list.count-pieces', { items: output('pieces', 'pieces') }),
      call('count-cells', 'list.count-cells', { items: output('cells', 'cells') }),
      call('count-choices', 'list.count-choices', { items: literal([]) }),
      call('piece-count', 'collection.piece-count', { pieces: output('pieces', 'pieces') }),
      call('join', 'list.join', { items: literal(['a', 'b']) }, { separator: ' / ' }),
      call('select', 'value.select-number', { condition: literal(true), whenTrue: literal(1), whenFalse: literal(2) }),
      call('contains-piece', 'collection.contains-piece', { items: output('pieces', 'pieces'), value: output('piece', 'value') }),
      call('contains-string', 'collection.contains-string', { items: literal(['a']), value: literal('a') }),
      call('adjacent', 'spatial.cell-adjacent', { left: output('left', 'cell'), right: output('right', 'cell') }),
      call('equal', 'spatial.cell-equal', { left: output('left', 'cell'), right: output('right', 'cell') }),
      call('delta', 'spatial.cell-delta', { from: output('left', 'cell'), to: output('right', 'cell') }),
      call('first-piece', 'list.first-piece', { items: output('pieces', 'pieces') }),
      call('first-cell', 'collection.first-cell', { cells: output('cells', 'cells') }),
      call('piece-at', 'collection.piece-at', { items: output('pieces', 'pieces'), index: literal(0) }),
      call('cell-in-list', 'spatial.cell-in-list', { cell: output('left', 'cell'), cells: output('cells', 'cells') }),
    ], {
      composites: [{ id: 'nested', version, inputs: [], outputs: [], body: [call('nested-count', 'list.count', { items: literal([]) })] }],
      continuations: [{ id: 'later', version, graph: graph([call('continuation-join', 'list.join', { items: literal(['x']) })]) }],
    })
    const migrated = migrateValueModules(source)
    const modules = callsIn(migrated.body).map(statement => statement.module)
    expect(modules).not.toEqual(expect.arrayContaining([
      'list.count', 'list.count-pieces', 'list.count-cells', 'list.count-choices',
      'collection.piece-count', 'list.join', 'value.select-number',
      'collection.contains-piece', 'collection.contains-string', 'spatial.cell-in-list',
      'spatial.cell-adjacent', 'spatial.cell-equal', 'spatial.cell-delta',
      'list.first-piece', 'collection.first-cell', 'collection.piece-at',
    ]))
    expect(callsIn(migrated.body).map(statement => statement.module)).toEqual(expect.arrayContaining([
      'collection.length', 'text.join-list', 'logic.select', 'compare.values',
      'compare.greater-than', 'spatial.cell-distance',
      'spatial.cell-coordinates', 'math.subtract', 'math.abs', 'math.max',
      'logic.and',
    ]))
    expect(migrateValueModules(migrated)).toEqual(migrated)
    expect(callsIn(migrated.continuations![0].graph.body).map(statement => statement.module)).toEqual(['text.join-list'])
    expect(callsIn(migrated.composites![0].body).map(statement => statement.module)).toEqual(['collection.length'])
  })

  it('preserves ordinary direct value behavior for counts, joins, and conditional numbers', () => {
    const count = scalarGraph(call('count', 'list.count', { items: input('items') }), 'count', 'number', {
      inputs: [{ name: 'items', type: { kind: 'list', element: 'string' } }], inputBindings: { items: ['a', 'b', 'c'] },
    })
    expect(execute(migrateValueModules(count)).value).toEqual(execute(count).value)
    const emptyCount = scalarGraph(call('count', 'list.count-cells', { items: input('items') }), 'value', 'number', {
      inputs: [{ name: 'items', type: cellList }], inputBindings: { items: [] },
    })
    expect(execute(migrateValueModules(emptyCount)).value).toEqual({ result: 0 })

    const joined = scalarGraph(call('join', 'list.join', { items: input('items') }, { separator: ' | ' }), 'text', 'string', {
      inputs: [{ name: 'items', type: { kind: 'list', element: 'string' } }], inputBindings: { items: ['one', 'two'] },
    })
    expect(execute(migrateValueModules(joined)).value).toEqual(execute(joined).value)
    const emptyJoin = scalarGraph(call('join', 'list.join', { items: input('items') }), 'text', 'string', {
      inputs: [{ name: 'items', type: { kind: 'list', element: 'string' } }], inputBindings: { items: [] },
    })
    expect(execute(migrateValueModules(emptyJoin)).value).toEqual({ result: '' })

    const selected = scalarGraph(call('select', 'value.select-number', {
      condition: input('condition'), whenTrue: input('whenTrue'), whenFalse: input('whenFalse'),
    }), 'value', 'number', {
      inputs: [{ name: 'condition', type: 'boolean' }, { name: 'whenTrue', type: 'number' }, { name: 'whenFalse', type: 'number' }],
      inputBindings: { condition: false, whenTrue: 8, whenFalse: -3 },
    })
    expect(execute(migrateValueModules(selected)).value).toEqual(execute(selected).value)
  })

  it('uses a typed filter plus length for string and piece membership, including empty lists', () => {
    const strings = scalarGraph(call('contains', 'collection.contains-string', { items: input('items'), value: input('value') }), 'contains', 'boolean', {
      inputs: [{ name: 'items', type: { kind: 'list', element: 'string' } }, { name: 'value', type: 'string' }],
      inputBindings: { items: ['a', 'b'], value: 'b' },
    })
    expect(execute(migrateValueModules(strings)).value).toEqual(execute(strings).value)
    const emptyStrings = scalarGraph(call('contains', 'collection.contains-string', { items: input('items'), value: input('value') }), 'contains', 'boolean', {
      inputs: [{ name: 'items', type: { kind: 'list', element: 'string' } }, { name: 'value', type: 'string' }],
      inputBindings: { items: [], value: 'b' },
    })
    expect(execute(emptyStrings).value).toEqual({ result: false })
    expect(execute(migrateValueModules(emptyStrings)).value).toEqual({ result: false })

    const pieces = scalarGraph(call('contains', 'collection.contains-piece', {
      items: output('pieces', 'pieces'), value: output('needle', 'value'),
    }), 'contains', 'boolean')
    const pieceGraph = graph([
      call('pieces', 'test.pieces'),
      call('needle', 'test.piece'),
      ...pieces.body,
    ], { outputs: pieces.outputs })
    const pieceRegistry = registryWith(
      testPieces,
      testDescriptor('test.piece', 'piece', '"piece-b"'),
    )
    expect(execute(migrateValueModules(pieceGraph), pieceRegistry).value).toEqual(execute(pieceGraph, pieceRegistry).value)
  })

  it('rebuilds spatial adjacency, equality, membership, and delta with generic coordinates', () => {
    const source = graph([
      call('left', 'spatial.cell', { x: literal(-3), y: literal(4) }),
      call('right', 'spatial.cell', { x: literal(-2), y: literal(4) }),
      call('adjacent', 'spatial.cell-adjacent', { left: output('left', 'cell'), right: output('right', 'cell') }),
      call('equal', 'spatial.cell-equal', { left: output('left', 'cell'), right: output('right', 'cell') }),
      call('delta', 'spatial.cell-delta', { from: output('left', 'cell'), to: output('right', 'cell') }),
      call('cells', 'test.cells'),
      call('member', 'spatial.cell-in-list', { cell: output('left', 'cell'), cells: output('cells', 'cells') }),
      { kind: 'return', id: 'done', values: {
        adjacent: output('adjacent'), equal: output('equal'), member: output('member'),
        dx: output('delta', 'dx'), dy: output('delta', 'dy'), chebyshev: output('delta', 'chebyshev'), orthogonal: output('delta', 'orthogonal'),
      } },
    ], {
      outputs: [
        { name: 'adjacent', type: 'boolean' }, { name: 'equal', type: 'boolean' }, { name: 'member', type: 'boolean' },
        { name: 'dx', type: 'number' }, { name: 'dy', type: 'number' }, { name: 'chebyshev', type: 'number' }, { name: 'orthogonal', type: 'boolean' },
      ],
    })
    const registry = registryWith(testCells)
    const original = execute(source, registry)
    const migrated = execute(migrateValueModules(source), registry)
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({ adjacent: true, equal: false, member: true, dx: 1, dy: 0, chebyshev: 1, orthogonal: true })
    expect(migrated.compiled.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'spatial.cell-coordinates' }), expect.objectContaining({ id: 'math.subtract' }),
      expect.objectContaining({ id: 'math.abs' }), expect.objectContaining({ id: 'math.max' }), expect.objectContaining({ id: 'compare.values' }),
    ]))
  })

  it('keeps negative and zero coordinate arithmetic exact', () => {
    const source = graph([
      call('left', 'spatial.cell', { x: literal(-4), y: literal(-2) }),
      call('right', 'spatial.cell', { x: literal(-4), y: literal(-2) }),
      call('delta', 'spatial.cell-delta', { from: output('left', 'cell'), to: output('right', 'cell') }),
      { kind: 'return', id: 'done', values: { dx: output('delta', 'dx'), dy: output('delta', 'dy'), chebyshev: output('delta', 'chebyshev'), orthogonal: output('delta', 'orthogonal') } },
    ], { outputs: [{ name: 'dx', type: 'number' }, { name: 'dy', type: 'number' }, { name: 'chebyshev', type: 'number' }, { name: 'orthogonal', type: 'boolean' }] })
    expect(execute(migrateValueModules(source)).value).toEqual({ dx: 0, dy: 0, chebyshev: 0, orthogonal: false })
    expect(execute(source).value).toEqual({ dx: 0, dy: 0, chebyshev: 0, orthogonal: false })
  })

  it('maps nullable first-item helpers to find and preserves legacy zero-based indices', () => {
    const firstPiece = graph([
      call('pieces', 'test.pieces'),
      call('first', 'list.first-piece', { items: output('pieces', 'pieces') }),
      { kind: 'return', id: 'done', value: output('first', 'piece') },
    ], { outputs: [{ name: 'result', type: 'piece', nullable: true }] })
    const firstCell = graph([
      call('cells', 'test.cells'),
      call('first', 'collection.first-cell', { cells: output('cells', 'cells') }),
      { kind: 'return', id: 'done', value: output('first', 'cell') },
    ], { outputs: [{ name: 'result', type: 'cell', nullable: true }] })
    const registry = registryWith(testPieces, testCells, testEmptyCells)
    expect(execute(migrateValueModules(firstPiece), registry).value).toEqual(execute(firstPiece, registry).value)
    expect(execute(migrateValueModules(firstCell), registry).value).toEqual(execute(firstCell, registry).value)

    const at = graph([
      call('pieces', 'test.pieces'),
      call('piece', 'collection.piece-at', { items: output('pieces', 'pieces'), index: input('index') }),
      { kind: 'return', id: 'done', value: output('piece', 'piece') },
    ], { inputs: [{ name: 'index', type: 'number' }], inputBindings: { index: 0 }, outputs: [{ name: 'result', type: 'piece', nullable: true }] })
    expect(execute(migrateValueModules(at), registry).value).toEqual(execute(at, registry).value)
    expect(execute(migrateValueModules(at), registry).value).toEqual('piece-a')

    const negativeAt = { ...at, inputBindings: { index: -1 } }
    expect(execute(migrateValueModules(negativeAt), registry).value).toBeNull()
    expect(execute(negativeAt, registry).value).toBeNull()
  })

  it('preserves a legitimate null for an empty nullable first item', () => {
    const emptyCell = graph([
      call('cells', 'test.empty-cells'),
      call('first', 'collection.first-cell', { cells: output('cells', 'cells') }),
      { kind: 'return', id: 'done', value: output('first', 'cell') },
    ], { outputs: [{ name: 'result', type: 'cell', nullable: true, optional: true }] })
    const registry = registryWith(testEmptyCells)
    expect(execute(emptyCell, registry).value).toBeNull()
    expect(execute(migrateValueModules(emptyCell), registry).value).toBeNull()
    expect(migrateValueModules(emptyCell).body[1]).toMatchObject({ kind: 'collection', method: 'find' })
  })

  it('supports typed generic selection, strict comparison, nullable values, and string predicates', () => {
    const listSelected = scalarGraph(call('select', 'logic.select', {
      condition: input('condition'), whenTrue: input('whenTrue'), whenFalse: input('whenFalse'),
    }, { valueType: JSON.stringify({ kind: 'list', element: 'number' }) }), 'value', { kind: 'list', element: 'number' }, {
      inputs: [
        { name: 'condition', type: 'boolean' },
        { name: 'whenTrue', type: { kind: 'list', element: 'number' } },
        { name: 'whenFalse', type: { kind: 'list', element: 'number' } },
      ],
      inputBindings: { condition: false, whenTrue: [1, 2], whenFalse: [3] },
    })
    expect(execute(listSelected).value).toEqual({ result: [3] })

    const nullableComparison = scalarGraph(call('compare', 'compare.values', {
      left: input('left'), right: input('right'),
    }, { valueType: JSON.stringify({ kind: 'nullable', value: 'string' }), operator: '==' }), 'value', 'boolean', {
      inputs: [{ name: 'left', type: 'string', nullable: true }, { name: 'right', type: 'string', nullable: true }],
      inputBindings: { left: null, right: null },
    })
    expect(execute(nullableComparison).value).toEqual({ result: true })

    const starts = graph([
      call('starts', 'text.starts-with', { text: input('text'), value: input('value') }),
      call('contains', 'text.contains', { text: input('text'), value: input('value') }),
      { kind: 'return', id: 'done', values: { starts: output('starts'), contains: output('contains') } },
    ], {
      inputs: [{ name: 'text', type: 'string', nullable: true }, { name: 'value', type: 'string' }],
      inputBindings: { text: null, value: 'x' },
      outputs: [{ name: 'starts', type: 'boolean' }, { name: 'contains', type: 'boolean' }],
    })
    expect(execute(starts).value).toEqual({ starts: false, contains: false })

    const emptyText = { ...starts, inputBindings: { text: '', value: '' } }
    expect(execute(emptyText).value).toEqual({ starts: true, contains: true })

    const crossType = scalarGraph(call('compare', 'compare.values', {
      left: literal(1), right: literal('1'),
    }, { valueType: 'number', operator: '==' }), 'value', 'boolean')
    expect(() => execute(crossType)).toThrow(/expects number|got string/i)
  })

  it('migrates typed comparisons, presence checks, selections, fragments, duplicates, and all-in checks', () => {
    const source = graph([
      call('same-text', 'compare.text', { left: input('left'), right: input('right') }),
      call('same-number', 'compare.equal', { left: input('numberA'), right: input('numberB') }),
      call('selected-text', 'value.select-text', { condition: input('condition'), whenTrue: input('whenTrue'), whenFalse: input('whenFalse') }),
      call('fragment', 'text.optional-fragment', { condition: input('condition'), value: input('whenTrue') }, { prefix: '[', suffix: ']' }),
      call('duplicate', 'list.has-duplicate', { items: input('items') }),
      call('all-in', 'collection.all-in-strings', { items: input('items'), allowed: input('allowed') }),
      call('all-in-parameter', 'list.all-in', { items: input('items') }, { allowed: ['a', 'b'] }),
      call('present', 'value.present-string', { value: input('present') }),
      { kind: 'return', id: 'done', values: {
        sameText: output('same-text'), sameNumber: output('same-number'), selected: output('selected-text', 'text'),
        fragment: output('fragment', 'text'), duplicate: output('duplicate', 'duplicate'), allIn: output('all-in', 'valid'), allInParameter: output('all-in-parameter', 'valid'), present: output('present', 'present'),
      } },
    ], {
      inputs: [
        { name: 'left', type: 'string', nullable: true }, { name: 'right', type: 'string', nullable: true },
        { name: 'numberA', type: 'number' }, { name: 'numberB', type: 'number' }, { name: 'condition', type: 'boolean' },
        { name: 'whenTrue', type: 'string' }, { name: 'whenFalse', type: 'string' },
        { name: 'items', type: { kind: 'list', element: 'string' } }, { name: 'allowed', type: { kind: 'list', element: 'string' } },
        { name: 'present', type: 'string', nullable: true },
      ],
      inputBindings: { left: null, right: null, numberA: 3, numberB: 3, condition: true, whenTrue: 'ready', whenFalse: 'fallback', items: ['a', 'a'], allowed: ['a', 'b'], present: '' },
      outputs: [
        { name: 'sameText', type: 'boolean' }, { name: 'sameNumber', type: 'boolean' }, { name: 'selected', type: 'string' },
        { name: 'fragment', type: 'string' }, { name: 'duplicate', type: 'boolean' }, { name: 'allIn', type: 'boolean' }, { name: 'allInParameter', type: 'boolean' }, { name: 'present', type: 'boolean' },
      ],
    })
    const migrated = migrateValueModules(source)
    expect(callsIn(migrated.body).map(statement => statement.module)).not.toEqual(expect.arrayContaining([
      'compare.text', 'compare.equal', 'value.select-text', 'text.optional-fragment', 'list.has-duplicate', 'collection.all-in-strings', 'list.all-in', 'value.present-string',
    ]))
    expect(callsIn(migrated.body).map(statement => statement.module)).toEqual(expect.arrayContaining(['compare.values', 'logic.select', 'text.concat', 'collection.distinct']))
    expect(execute(migrated).value).toEqual({
      sameText: true, sameNumber: true, selected: 'ready', fragment: '[ready]', duplicate: true, allIn: true, allInParameter: true, present: true,
    })

    const invalidAllIn = { ...source, inputBindings: { ...source.inputBindings, items: ['c'] } }
    expect(execute(migrateValueModules(invalidAllIn)).value).toMatchObject({ allIn: false, allInParameter: false })
    const emptyItems = { ...source, inputBindings: { ...source.inputBindings, items: [] } }
    expect(execute(migrateValueModules(emptyItems)).value).toMatchObject({ duplicate: false, allIn: true, allInParameter: true })
    expect(migrateValueModules(migrated)).toEqual(migrated)
  })

  it('does not rewrite malformed calls and preserves unrelated call metadata', () => {
    const missingInput = call('broken', 'list.count')
    const metadata = call('count', 'list.count', { items: literal([]) }) as GameplayCallStatement & { futureMetadata?: unknown }
    metadata.futureMetadata = { keep: true }
    const source = graph([missingInput, metadata])
    const migrated = migrateValueModules(source)
    expect(migrated.body[0]).toEqual(missingInput)
    expect(migrated.body[1]).toMatchObject({ id: 'count', module: 'collection.length', futureMetadata: { keep: true } })
    expect(atomicValuesRecipe(missingInput, suffix => 'unused-' + suffix)).toBeUndefined()
  })
})
