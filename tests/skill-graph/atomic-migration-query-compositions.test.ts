import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  ATOMIC_QUERY_COMPOSITION_MODULES,
  migrateQueryCompositionModules,
} from '../../lib/skill-graph/atomic-migration-query-compositions'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
} from '../../lib/skill-graph/module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: string | number | boolean | null): GameplayValue => ({ kind: 'literal', value })

const fixtures: readonly GameplayModuleDescriptor[] = [
  {
    id: 'test.piece', version: '1', label: 'piece', inputs: [], outputs: [{ name: 'piece', type: 'piece' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.piece',
  },
  {
    id: 'test.nullable-piece', version: '1', label: 'nullable piece', inputs: [],
    outputs: [{ name: 'piece', type: { kind: 'nullable', value: 'piece' } }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.nullablePiece',
  },
  {
    id: 'test.player', version: '1', label: 'player', inputs: [], outputs: [{ name: 'player', type: 'player' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.player',
  },
  {
    id: 'test.nullable-player', version: '1', label: 'nullable player', inputs: [],
    outputs: [{ name: 'player', type: { kind: 'nullable', value: 'player' } }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.nullablePlayer',
  },
  {
    id: 'test.text', version: '1', label: 'text', inputs: [], outputs: [{ name: 'text', type: { kind: 'nullable', value: 'string' } }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.text',
  },
  {
    id: 'test.pieces', version: '1', label: 'pieces', inputs: [], outputs: [{ name: 'pieces', type: { kind: 'list', element: 'piece' } }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.pieces',
  },
  {
    id: 'test.cells', version: '1', label: 'cells', inputs: [], outputs: [{ name: 'cells', type: { kind: 'list', element: 'cell' } }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.cells',
  },
  {
    id: 'test.choices', version: '1', label: 'choices', inputs: [], outputs: [{ name: 'choices', type: { kind: 'list', element: 'choice' } }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.choices',
  },
]

const registry = {
  get: (id: string, version?: string) => fixtures.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id: string, version?: string) => fixtures.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...fixtures],
}

type TestModule = {
  readonly id: string
  readonly inputModule?: string
  readonly inputPort?: string
  readonly inputType?: GameplayValueType
  readonly output: string
  readonly outputType: GameplayValueType
  readonly params?: Record<string, string | number | boolean>
  readonly inputs?: Record<string, GameplayValue>
}

const cases: readonly TestModule[] = [
  { id: 'player.require', inputModule: 'test.nullable-player', inputPort: 'player', output: 'player', outputType: 'player' },
  { id: 'content.enemy-player', inputModule: 'test.player', inputPort: 'player', output: 'enemy', outputType: { kind: 'nullable', value: 'player' } },
  { id: 'piece.name-by-id', inputModule: 'test.piece', inputPort: 'piece', output: 'text', outputType: 'string', inputs: { fallback: literal('missing') } },
  { id: 'context.primary-target-rewritten', inputModule: 'test.piece', inputPort: 'piece', output: 'value', outputType: 'boolean', inputs: { target: output('target', 'piece') } },
  { id: 'query.player-case-insensitive', inputModule: 'test.text', inputPort: 'text', output: 'player', outputType: { kind: 'nullable', value: 'player' } },
  { id: 'choice.from-pieces', inputModule: 'test.pieces', inputPort: 'pieces', output: 'choices', outputType: { kind: 'list', element: 'choice' } },
  { id: 'choice.from-cells', inputModule: 'test.cells', inputPort: 'cells', output: 'choices', outputType: { kind: 'list', element: 'choice' } },
  { id: 'choice.selected-pieces', inputModule: 'test.choices', inputPort: 'choices', output: 'pieces', outputType: { kind: 'list', element: 'piece' } },
  { id: 'choice.context-piece-or-select', output: 'choice', outputType: 'choice', params: { range: 99, filter: 'enemy' } },
  { id: 'choice.status-tags', inputModule: 'test.piece', inputPort: 'piece', output: 'choice', outputType: 'choice', params: { title: '状态' } },
]

function graphFor(test: TestModule): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const inputs: Record<string, GameplayValue> = { ...(test.inputs ?? {}) }
  if (test.inputModule) {
    const sourceId = 'source'
    body.push({ kind: 'call', id: sourceId, module: test.inputModule, version: '1' })
    const inputName = test.id === 'piece.name-by-id'
      ? 'piece'
      : test.id === 'choice.status-tags'
        ? 'target'
        : test.id === 'query.player-case-insensitive'
          ? 'playerId'
          : test.id === 'choice.selected-pieces'
            ? 'targets'
            : test.inputPort!
    inputs[inputName] = output(sourceId, test.inputPort ?? 'value')
  }
  if (test.id === 'context.primary-target-rewritten') {
    inputs.target = output('source', 'piece')
  }
  body.push({ kind: 'call', id: 'source-call', module: test.id, version: '1', inputs, parameters: test.params })
  body.push({ kind: 'return', id: 'return', value: output('source-call', test.output) })
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body,
    outputs: [{ name: 'value', type: test.outputType }],
  }
}

function modulesIn(graph: GameplayModuleGraph): string[] {
  const result: string[] = []
  const visit = (statements: readonly GameplayStatement[]): void => statements.forEach(statement => {
    if (statement.kind === 'call') result.push(statement.module)
    if (statement.kind === 'collection' || statement.kind === 'foreach' || statement.kind === 'while') visit(statement.body)
    if (statement.kind === 'if') { visit(statement.then); visit(statement.else ?? []) }
  })
  visit(graph.body)
  return result
}

function compileMigrated(test: TestModule): GameplayModuleGraph {
  const migrated = migrateQueryCompositionModules(graphFor(test))
  expect(modulesIn(migrated)).not.toEqual(expect.arrayContaining([...ATOMIC_QUERY_COMPOSITION_MODULES]))
  compileGameplayModuleGraph(migrated, registry)
  return migrated
}

describe('atomic query and choice composition migrations', () => {
  for (const test of cases) {
    it(`rewrites and compiles ${test.id}`, () => {
      const migrated = compileMigrated(test)
      expect(migrateQueryCompositionModules(migrated)).toEqual(migrated)
    })
  }

  it('keeps player rotation, case-insensitive matching, and candidate order', () => {
    const migrated = migrateQueryCompositionModules(graphFor(cases.find(item => item.id === 'content.enemy-player')!))
    const flow = {
      query: {
        players: () => ['red', 'red-ally', 'blue'],
        hasPlayer: (id: unknown) => typeof id === 'string' && ['red', 'red-ally', 'blue'].includes(id),
        player: (id: string) => ({ playerId: id, faction: id === 'blue' ? 'blue' : 'red' }),
        playerText: (id: string) => id === 'blue' ? 'blue' : 'red',
        alliedPlayers: (left: string, right: string) => (left === 'red' || left === 'red-ally') && (right === 'red' || right === 'red-ally'),
      },
    }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({ player: 'red' })).toBe('blue')
  })

  it('keeps the holder player before the optional context fallback', () => {
    const migrated = migrateQueryCompositionModules(graphFor(cases.find(item => item.id === 'player.require')!))
    const flow = {
      query: {
        hasPlayer: (id: unknown) => id === 'player-red' || id === 'player-blue',
        player: (id: string) => ({ playerId: id }),
      },
    }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({ nullablePlayer: 'player-red' })).toBe('player-red')
    expect(run({ nullablePlayer: null, playerId: 'player-blue' })).toBe('player-blue')
  })

  it('repairs the published generated player fallback shape', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'player-ref', module: 'ref.player', version: '1', inputs: {}, parameters: {} },
        { kind: 'call', id: 'player--context-player', module: 'context.field', version: '4', inputs: {}, parameters: { field: 'playerId', preserveMissing: true } },
        {
          kind: 'call', id: 'player--required-player', module: 'value.coalesce', version: '1',
          inputs: { value: output('player--context-player', 'value'), defaultValue: output('player-ref', 'player') },
          parameters: { valueType: 'player' },
        },
        { kind: 'return', id: 'return', value: output('player--required-player') },
      ],
      outputs: [{ name: 'value', type: 'player' }],
    }
    const migrated = migrateQueryCompositionModules(graph)
    expect(migrated.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'call', module: 'query.player' }),
    ]))
    const flow = {
      refs: { player: () => 'player-red' },
      query: { hasPlayer: (id: unknown) => id === 'player-red', player: (id: string) => ({ playerId: id }) },
    }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({})).toBe('player-red')
  })

  it('gives a repaired player fallback the same shape as a fresh player.require expansion', () => {
    const published: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'player-ref', module: 'ref.player', version: '1', inputs: {}, parameters: {} },
        { kind: 'call', id: 'player--context-player', module: 'context.field', version: '4', inputs: {}, parameters: { field: 'playerId', preserveMissing: true } },
        {
          kind: 'call', id: 'player--required-player', module: 'value.coalesce', version: '1',
          inputs: { value: output('player--context-player', 'value'), defaultValue: output('player-ref', 'player') },
          parameters: { valueType: 'player' },
        },
        { kind: 'return', id: 'return', value: output('player--required-player') },
      ],
      outputs: [{ name: 'value', type: 'player' }],
    }
    const factory: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'player-ref', module: 'ref.player', version: '1', inputs: {}, parameters: {} },
        {
          kind: 'call', id: 'player', module: 'player.require', version: '1',
          inputs: { player: output('player-ref', 'player') }, parameters: {},
        },
        { kind: 'return', id: 'return', value: output('player', 'player') },
      ],
      outputs: [{ name: 'value', type: 'player' }],
    }

    const repaired = migrateQueryCompositionModules(published)
    const rebuilt = migrateQueryCompositionModules(factory)
    expect(repaired).toEqual(rebuilt)
    const context = repaired.body.find(statement => statement.kind === 'call' && statement.module === 'context.field')
    expect(context && context.kind === 'call' ? context.parameters : undefined).toEqual({ field: 'playerId' })
    expect(JSON.stringify(repaired)).not.toContain('context-player-fallback')
  })

  it('repairs a generated owner-field fallback before the triggering context player', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'aizen', module: 'test.piece', version: '1', inputs: {}, parameters: {} },
        {
          kind: 'call', id: 'aizen-owner', module: 'piece.field', version: '1',
          inputs: { piece: output('aizen', 'piece') }, parameters: { field: 'ownerPlayerId' },
        },
        { kind: 'call', id: 'player--context-player', module: 'context.field', version: '4', inputs: {}, parameters: { field: 'playerId', preserveMissing: true } },
        {
          kind: 'call', id: 'player--required-player', module: 'value.coalesce', version: '1',
          inputs: { value: output('player--context-player', 'value'), defaultValue: output('aizen-owner', 'value') },
          parameters: { valueType: 'player' },
        },
        { kind: 'return', id: 'return', value: output('player--required-player') },
      ],
      outputs: [{ name: 'value', type: 'player' }],
    }
    const migrated = migrateQueryCompositionModules(graph)
    expect(migrated.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'call', module: 'query.player' }),
    ]))
    const flow = {
      query: {
        piece: (id: string) => ({ instanceId: id, ownerPlayerId: 'player-blue' }),
        hasPlayer: (id: unknown) => id === 'player-blue' || id === 'player-red',
        player: (id: string) => ({ playerId: id }),
      },
    }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({ piece: 'aizen', playerId: 'player-red' })).toBe('player-blue')
  })

  it('treats an absent rewritten primary target as a false comparison', () => {
    const migrated = migrateQueryCompositionModules(graphFor(cases.find(item => item.id === 'context.primary-target-rewritten')!))
    const field = migrated.body.find(statement => statement.kind === 'call' && statement.module === 'context.field')
    expect(field && field.kind === 'call' ? field.parameters : undefined).toEqual({ field: 'ruleRewrittenPrimaryTargetPieceId' })
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow: {} }) as (context: unknown) => unknown
    expect(run({ piece: 'piece-a' })).toBe(false)
    expect(run({ piece: 'piece-a', ruleRewrittenPrimaryTargetPieceId: 'piece-a' })).toBe(true)
  })

  it('repairs published rewritten-target fields without preserving undefined', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'target-rewritten--rewritten-target', module: 'context.field', version: '4', inputs: {}, parameters: { field: 'ruleRewrittenPrimaryTargetPieceId', preserveMissing: true } },
        { kind: 'return', id: 'return', value: output('target-rewritten--rewritten-target', 'value') },
      ],
      outputs: [{ name: 'value', type: { kind: 'nullable', value: 'piece' } }],
    }
    const migrated = migrateQueryCompositionModules(graph)
    const field = migrated.body.find(statement => statement.kind === 'call')
    expect(field && field.kind === 'call' ? field.parameters : undefined).toEqual({ field: 'ruleRewrittenPrimaryTargetPieceId', preserveMissing: false })
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow: {} }) as (context: unknown) => unknown
    expect(run({})).toBeNull()
  })

  it('keeps typed piece and cell candidate envelopes after record construction', () => {
    const pieceGraph = migrateQueryCompositionModules(graphFor(cases.find(item => item.id === 'choice.from-pieces')!))
    const pieceFlow = { query: { piece: (id: string) => ({ instanceId: id }) } }
    const pieceRun = runInNewContext('(' + compileGameplayModuleGraph(pieceGraph, registry).code + ')', { flow: pieceFlow }) as (context: unknown) => unknown
    expect(pieceRun({ pieces: ['piece-b', 'piece-a'] })).toEqual([
      { type: 'piece', pieceId: 'piece-a' },
      { type: 'piece', pieceId: 'piece-b' },
    ])

    const cellGraph = migrateQueryCompositionModules(graphFor(cases.find(item => item.id === 'choice.from-cells')!))
    const cellRun = runInNewContext('(' + compileGameplayModuleGraph(cellGraph, registry).code + ')', { flow: {} }) as (context: unknown) => unknown
    expect(cellRun({ cells: [{ x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }] })).toEqual([
      { type: 'cell', x: 0, y: 0 },
      { type: 'cell', x: 1, y: 1 },
      { type: 'cell', x: 2, y: 1 },
    ])
  })

  it('decodes choice envelopes before selected-piece filtering', () => {
    const migrated = migrateQueryCompositionModules(graphFor(cases.find(item => item.id === 'choice.selected-pieces')!))
    const flow = {
      query: {
        hasPiece: (id: unknown) => id === 'piece-a' || id === 'piece-b',
        piece: (id: string) => ({ instanceId: id, currentHp: id === 'piece-b' ? 0 : 3 }),
      },
    }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({ choices: [
      { type: 'piece', pieceId: 'piece-b' },
      { type: 'piece', pieceId: 'piece-a' },
      { type: 'piece', pieceId: 'piece-a' },
      { type: 'cell', x: 0, y: 0 },
    ] })).toEqual(['piece-a'])
  })

  it('preserves status option labels and the explicit none option', () => {
    const migrated = migrateQueryCompositionModules(graphFor(cases.find(item => item.id === 'choice.status-tags')!))
    const requests: unknown[] = []
    const flow = {
      query: { piece: () => ({ instanceId: 'target', statusTags: [{ name: '冻结', type: 'freeze' }, { type: 'burn' }] }), hasPiece: () => true },
      choice: { option: (config: unknown) => { requests.push(config); return { success: true, needsOptionSelection: true } } },
    }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    run({ piece: 'target' })
    const config = requests[0] as { options: Array<{ label: string; value: string }>; canCancel: boolean; cancelValue: string }
    expect(config.options).toEqual([
      { label: '冻结（1）', value: '0' },
      { label: 'burn（2）', value: '1' },
      { label: '不移除效果', value: 'none' },
    ])
    expect(config.canCancel).toBe(true)
    expect(config.cancelValue).toBe('none')
  })
})
