import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayRecordSchema } from '../../lib/skill-graph/module-types'
import { authorValueSchemas, cloneAuthorInitialValue, requireAuthorValue } from '../../lib/game/author-extension'
import { makePiece, makeState } from '../helpers/minimal-state'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '../../lib/game/gameplay-module-diagnostics'

const schema: GameplayRecordSchema = { id: 'task', version: '1', fields: [{ name: 'piece', type: 'piece' }, { name: 'count', type: 'number' }] }
const declaration = { schema, schemas: [schema], keyField: 'piece' }
function setup() {
  const piece = makePiece({ instanceId: 'a', ownerPlayerId: 'player-red' })
  const battle = makeState({ pieces: [piece] })
  const flow = createFlowRuntime(battle, { piece }, 'skill', {})
  return { battle, flow }
}

describe('author extension maps', () => {
  it('strictly accepts finite JSON author values before typed validation and never runs accessors', () => {
    let accessed = false
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'value', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessed = true
        return 1
      },
    })
    const sparse: unknown[] = []
    sparse.length = 1
    const hidden: Record<string, unknown> = {}
    Object.defineProperty(hidden, 'value', { configurable: true, enumerable: false, value: 1 })
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>
    customPrototype.value = 1
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    for (const invalid of [accessor, sparse, hidden, customPrototype, cyclic]) {
      expect(() => requireAuthorValue(invalid, 'record', [])).toThrow()
    }
    expect(accessed).toBe(false)
    expect(requireAuthorValue('piece-instance', 'piece')).toBe('piece-instance')
  })

  it('rejects ambiguous bare record schema references while retaining exact version references', () => {
    const schemas: GameplayRecordSchema[] = [
      { id: 'versioned', version: '1', fields: [] },
      { id: 'versioned', version: '2', fields: [] },
    ]
    expect(() => authorValueSchemas({ kind: 'record', schema: 'versioned' }, schemas)).toThrow('版本不明确')
    expect(authorValueSchemas({ kind: 'record', schema: 'versioned@2' }, schemas)).toEqual([schemas[1]])
  })

  it('counts UTF-8 bytes when cloning a large initial author value', () => {
    const largeSchema: GameplayRecordSchema = { id: 'utf8', version: '1', fields: [{ name: 'text', type: 'string' }] }
    const value = { text: '😀'.repeat(16384) }

    expect(value.text.length).toBe(32768)
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(65536)
    expect(() => cloneAuthorInitialValue({ type: { kind: 'record', schema: 'utf8@1' }, schemas: [largeSchema], value })).toThrow('64KB')
  })

  it('remembers an empty tuple declaration type and keeps declaration-shaped user records intact', () => {
    const { flow } = setup()
    flow.extension.declareValue('player', 'player-red', 'content', 'list', { kind: 'list', element: 'number' }, [], [])
    expect(() => flow.extension.declareValue('player', 'player-red', 'content', 'list', { kind: 'list', element: 'string' }, [], [])).toThrow('声明类型不一致')
    const userValue = { format: 'author-extension-value/v1', type: 'string', schemas: [], value: 'literal' }
    flow.extension.declareValue('player', 'player-red', 'content', 'literal', 'record', [], userValue)
    expect(flow.extension.readValue('player', 'player-red', 'content', 'literal', '', 'record', [])).toEqual(userValue)
    flow.state.set('player', 'player-red', 'content', 'raw-literal', userValue)
    expect(flow.extension.readValue('player', 'player-red', 'content', 'raw-literal', '', 'record', [])).toEqual(userValue)
    expect(flow.state.get('player', 'player-red', 'content', 'literal')).toEqual(userValue)
  })

  it('supports custom typed access without a local declaration and never creates missing paths', () => {
    const { flow } = setup()
    flow.state.set('player', 'player-red', 'content', '其他技能数据', { count: 3, values: [7, 9] })
    expect(flow.extension.readValue('player', 'player-red', 'content', '其他技能数据', 'count', 'number', [])).toBe(3)
    expect(flow.extension.readValue('player', 'player-red', 'content', '其他技能数据', 'values.1', 'number', [])).toBe(7)
    flow.extension.writeValue('player', 'player-red', 'content', '其他技能数据', 'values.2', 'number', [], 11)
    expect(flow.state.get('player', 'player-red', 'content', '其他技能数据')).toEqual({ count: 3, values: [7, 11] })
    expect(() => flow.extension.writeValue('player', 'player-red', 'content', '其他技能数据', 'missing', 'number', [], 1)).toThrow('字段不存在')
    expect(() => flow.extension.writeValue('player', 'player-red', 'content', 'missing', '', 'number', [], 1)).toThrow('变量不存在')
    expect(() => flow.extension.readValue('player', 'player-red', 'content', '其他技能数据', '__proto__.x', 'number', [])).toThrow('字段路径无效')
    expect(() => flow.extension.readValue('player', 'player-red', 'content', '其他技能数据', 'count', 'string', [])).toThrow('指定类型')
    expect(flow.state.get('player', 'player-red', 'content', 'missing')).toBeUndefined()
    expect(flow.state.get('player', 'player-red', 'content', '其他技能数据')).toEqual({ count: 3, values: [7, 11] })
  })

  it('skips a missing custom access and its dependent writes while running the independent tail', () => {
    const { flow } = setup()
    flow.extension.declareValue('player', 'player-red', 'content', 'existing', 'number', [], 20)
    const owner = { kind: 'output' as const, node: 'player', port: 'player' }
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'player', module: 'ref.player', version: '1' },
      { kind: 'call', id: 'missing', module: 'extension.read-player', version: '1', inputs: { owner }, parameters: { name: 'absent', valueType: 'number' } },
      { kind: 'call', id: 'dependent', module: 'extension.write-player', version: '1', inputs: { owner, value: { kind: 'output', node: 'missing', port: 'value' } }, parameters: { name: 'existing', valueType: 'number' } },
      { kind: 'call', id: 'tail', module: 'extension.declare-player', version: '1', inputs: { owner, value: { kind: 'literal', value: 8 } }, parameters: { name: 'independent', valueType: 'number' } },
    ] }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const context = { flow }
    const host = createGameplayModuleDiagnosticHost('skill', {}, () => undefined)
    const restore = installGameplayModuleDiagnosticHost(context, host)
    try { (runInNewContext('(' + compiled.code + ')', { flow }) as (context: unknown) => unknown)(context) } finally { restore() }
    expect(flow.extension.readValue('player', 'player-red', 'content', 'existing', '', 'number', [])).toBe(20)
    expect(flow.extension.readValue('player', 'player-red', 'content', 'independent', '', 'number', [])).toBe(8)
    expect(flow.state.get('player', 'player-red', 'content', 'absent')).toBeUndefined()
    expect(host.diagnostics.some(item => item.statementId === 'missing' && item.message.includes('变量不存在'))).toBe(true)
  })

  it('preserves a user record named value through compiled declaration, read and write outputs', () => {
    const { flow } = setup()
    const valueSchema: GameplayRecordSchema = { id: 'value-record', version: '1', fields: [{ name: 'value', type: 'number' }] }
    const type = JSON.stringify({ kind: 'record', schema: valueSchema.id })
    const output = (node: string) => ({ kind: 'output' as const, node, port: 'value' })
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [valueSchema], body: [
      { kind: 'record.create', id: 'literal-record', schema: valueSchema.id, fields: { value: { kind: 'literal', value: 7 } } },
      { kind: 'call', id: 'declared', module: 'extension.declare-battle', version: '1', inputs: { value: output('literal-record') }, parameters: { name: 'record', valueType: type } },
      { kind: 'call', id: 'written', module: 'extension.write-battle', version: '1', inputs: { value: output('declared') }, parameters: { name: 'record', valueType: type } },
      { kind: 'call', id: 'read', module: 'extension.read-battle', version: '1', parameters: { name: 'record', valueType: type } },
      { kind: 'record.get', id: 'field', record: output('read'), field: 'value' },
      { kind: 'call', id: 'result', module: 'extension.declare-battle', version: '1', inputs: { value: output('field') }, parameters: { name: 'result' } },
    ] }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const context = { flow }
    const host = createGameplayModuleDiagnosticHost('skill', {}, () => undefined)
    const restore = installGameplayModuleDiagnosticHost(context, host)
    // Dynamic SkillCode executes in the host realm; JSON state rejects foreign
    // prototypes, so preserve that real boundary for structured literals.
    try { (new Function('flow', 'return (' + compiled.code + ')')(flow) as (context: unknown) => unknown)(context) } finally { restore() }
    expect(host.diagnostics).toEqual([])
    expect(flow.state.get('battle', 'battle', 'content', 'record')).toEqual({ value: 7 })
    expect(flow.state.get('battle', 'battle', 'content', 'result')).toBe(7)
  })

  it('infers selected extension value types and rejects mismatched or universal types', () => {
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'read', module: 'extension.read-battle', version: '1', parameters: { name: 'values', valueType: '{"kind":"list","element":"number"}' } },
      { kind: 'call', id: 'length', module: 'collection.length', version: '1', inputs: { items: { kind: 'output', node: 'read', port: 'value' } } },
    ] }
    expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
    const wrong = JSON.parse(JSON.stringify(graph))
    wrong.body[0].parameters.valueType = 'number'
    expect(() => compileGameplayModuleGraph(wrong, GAMEPLAY_MODULE_REGISTRY)).toThrow()
    wrong.body[0].parameters.valueType = 'any'
    expect(() => compileGameplayModuleGraph(wrong, GAMEPLAY_MODULE_REGISTRY)).toThrow('universal')
    const badWrite: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'write', module: 'extension.write-battle', version: '1', inputs: { value: { kind: 'literal', value: 'bad' } }, parameters: { name: 'n', valueType: 'number' } },
    ] }
    expect(() => compileGameplayModuleGraph(badWrite, GAMEPLAY_MODULE_REGISTRY)).toThrow('expects number')
  })

  it('requires declaration and retains existing records when declared again', () => {
    const { flow } = setup()
    expect(() => flow.extension.mapPut('player-red', 'content', 'tasks', declaration, { piece: 'a', count: 1 })).toThrow('尚未声明')
    flow.extension.declareMap('player-red', 'content', 'tasks', declaration)
    flow.extension.mapPut('player-red', 'content', 'tasks', declaration, { piece: 'a', count: 1 })
    expect(flow.extension.declareMap('player-red', 'content', 'tasks', declaration)).toEqual([{ piece: 'a', count: 1 }])
    const changed = { ...declaration, schema: { ...schema, fields: [{ name: 'piece', type: 'piece' as const }, { name: 'count', type: 'string' as const }] } }
    expect(() => flow.extension.declareMap('player-red', 'content', 'tasks', changed)).toThrow('类型不一致')
    expect(flow.extension.mapItems('player-red', 'content', 'tasks', declaration)).toEqual([{ piece: 'a', count: 1 }])
  })

  it('replaces only one instance key and allows cleanup after that instance leaves', () => {
    const { battle, flow } = setup()
    flow.extension.declareMap('player-red', 'content', 'tasks', declaration)
    flow.extension.mapPut('player-red', 'content', 'tasks', declaration, { piece: 'a', count: 1 })
    flow.extension.mapPut('player-red', 'content', 'tasks', declaration, { piece: 'b', count: 2 })
    flow.extension.mapPut('player-red', 'content', 'tasks', declaration, { piece: 'a', count: 3 })
    battle.pieces = []
    flow.extension.mapRemove('player-red', 'content', 'tasks', declaration, { piece: 'a', count: 3 })
    expect(flow.extension.mapItems('player-red', 'content', 'tasks', declaration)).toEqual([{ piece: 'b', count: 2 }])
  })

  it('keeps ownership and value isolation through existing flow state', () => {
    const { battle, flow } = setup()
    flow.extension.declareMap('player-red', 'content', 'tasks', declaration)
    flow.extension.declareMap('player-blue', 'content', 'tasks', declaration)
    const item = { piece: 'a', count: 2 }
    flow.extension.mapPut('player-red', 'content', 'tasks', declaration, item)
    item.count = 999
    const values = flow.extension.mapItems('player-red', 'content', 'tasks', declaration)
    values[0].count = 50
    expect(flow.extension.mapItems('player-red', 'content', 'tasks', declaration)).toEqual([{ piece: 'a', count: 2 }])
    expect(flow.extension.mapItems('player-blue', 'content', 'tasks', declaration)).toEqual([])
    expect(battle.extensions?.flowState.every((entry: { projectionVisibility: string }) => entry.projectionVisibility === 'owner')).toBe(true)
  })

  it('rejects invalid values without losing the old mapping', () => {
    const { flow } = setup()
    flow.extension.declareMap('player-red', 'content', 'tasks', declaration)
    expect(() => flow.extension.mapPut('player-red', 'content', 'tasks', declaration, { piece: 'a', count: 'bad' })).toThrow('不符合声明')
    expect(() => flow.extension.mapPut('player-red', 'content', 'tasks', declaration, { piece: 'a', count: Infinity })).toThrow('不符合声明')
    expect(flow.extension.mapItems('player-red', 'content', 'tasks', declaration)).toEqual([])
  })

  it('reads and updates legacy recallData maps without materializing flowState', () => {
    const { battle, flow } = setup()
    const recallSchema: GameplayRecordSchema = {
      id: 'atomic-recall-record', version: '1', fields: [
        { name: 'piece', type: 'piece', nullable: true },
        { name: 'pieceKey', type: 'string' },
        { name: 'owner', type: 'player' },
        { name: 'position', type: 'cell' },
        { name: 'targetCount', type: 'number' },
        { name: 'actionCount', type: 'number' },
        { name: 'snapshot', type: 'record' },
      ],
    }
    const recallDeclaration = { schema: recallSchema, schemas: [recallSchema], keyField: 'pieceKey' }
    battle.extensions = {
      recallData: [{
        pieceId: 'a', ownerPlayerId: 'player-red', targetCount: 2, actionCount: 0,
        snapshot: { x: 2, y: 3, hp: 7 },
      }],
    }

    expect(flow.extension.mapItems('player-red', 'content', 'recall-records', recallDeclaration)).toEqual([{
      piece: 'a', pieceKey: 'a', owner: 'player-red', position: { x: 2, y: 3 }, targetCount: 2,
      actionCount: 0, snapshot: { x: 2, y: 3, hp: 7 },
    }])
    expect(battle.extensions.flowState).toBeUndefined()

    flow.extension.mapPut('player-red', 'content', 'recall-records', recallDeclaration, {
      piece: 'a', pieceKey: 'a', owner: 'player-red', position: { x: 4, y: 5 }, targetCount: 2,
      actionCount: 1, snapshot: { x: 4, y: 5, hp: 9 },
    })
    expect(battle.extensions.recallData).toEqual([expect.objectContaining({
      pieceId: 'a', ownerPlayerId: 'player-red', actionCount: 1,
      snapshot: { x: 4, y: 5, hp: 9 },
    })])
    flow.extension.mapRemove('player-red', 'content', 'recall-records', recallDeclaration, {
      piece: 'a', pieceKey: 'a', owner: 'player-red', position: { x: 4, y: 5 }, targetCount: 2,
      actionCount: 1, snapshot: { x: 4, y: 5, hp: 9 },
    })
    expect(battle.extensions.recallData).toEqual([])
    expect(battle.extensions.flowState).toBeUndefined()
  })

  it('infers schema-bound list items for author field reads and rejects undeclared schemas', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', inputs: [], outputs: [], schemas: [schema],
      body: [
        { kind: 'call', id: 'player', module: 'ref.player', version: '1' },
        { kind: 'call', id: 'records', module: 'extension.map-declare', version: '1', inputs: { player: { kind: 'output', node: 'player', port: 'player' } }, parameters: { name: 'tasks', schema: 'task@1', keyField: 'piece' } },
        { kind: 'foreach', id: 'each', items: { kind: 'output', node: 'records', port: 'items' }, body: [
          { kind: 'record.get', id: 'count', record: { kind: 'output', node: 'each', port: 'item' }, field: 'count' },
        ] },
      ],
    }
    expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
    const wrong = JSON.parse(JSON.stringify(graph))
    wrong.body[1].parameters.schema = 'missing@1'
    expect(() => compileGameplayModuleGraph(wrong, GAMEPLAY_MODULE_REGISTRY)).toThrow('unknown record schema')
  })
})
