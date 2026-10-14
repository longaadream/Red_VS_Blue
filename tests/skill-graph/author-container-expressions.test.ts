import { describe, expect, it } from 'vitest'

import { createSkillCodeFlow } from '../../lib/game/skills'
import { lowerAuthorExpression } from '../../lib/skill-graph/author-expression-graph'
import { authorTypeLabel, completeAuthorExpression } from '../../lib/skill-graph/author-expression-completion'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayCallStatement, type GameplayModuleGraph, type GameplayStatement, type GameplayValueType } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

function expressionGraph(expression: string, expectedType?: GameplayValueType): { graph: GameplayModuleGraph; lowered: ReturnType<typeof lowerAuthorExpression> } {
  const lowered = lowerAuthorExpression(expression, { surface: 'skill', expectedType })
  return {
    lowered,
    graph: {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      schemas: lowered.schemas,
      body: [...lowered.statements, { kind: 'return', id: 'done', value: lowered.value }],
      outputs: [{ name: 'value', type: lowered.type }],
    },
  }
}

function execute(expression: string, expectedType?: GameplayValueType): { result: unknown; lowered: ReturnType<typeof lowerAuthorExpression>; compiled: ReturnType<typeof compileGameplayModuleGraph> } {
  const { graph, lowered } = expressionGraph(expression, expectedType)
  const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
  const piece = makePiece({ instanceId: 'caster', attack: 7 })
  const battle = makeState({ pieces: [piece] })
  const context = { piece, sourcePiece: piece, playerId: piece.ownerPlayerId }
  const flow = createSkillCodeFlow(battle, context, 'skill')
  const run = Function('context', 'flow', 'battle', `return (${compiled.code})(context)`) as (context: unknown, flow: unknown, battle: unknown) => unknown
  return { result: run(context, flow, battle), lowered, compiled }
}

const modules = (lowered: ReturnType<typeof lowerAuthorExpression>) => lowered.statements.filter(statement => statement.kind === 'call').map(statement => `${statement.module}@${statement.version}`)
const callStatement = (statements: readonly GameplayStatement[], module: string): GameplayCallStatement | undefined => statements.find((statement): statement is GameplayCallStatement => statement.kind === 'call' && statement.module === module)

describe('author generic container expressions', () => {
  it('infers set and map generic parameters without user type arguments', () => {
    const set = expressionGraph('集合({1,2}).加入(3).数量()').lowered
    expect(set.type).toBe('number')
    expect(modules(set)).toEqual(['collection.singleton@1', 'collection.singleton@1', 'collection.concat@1', 'set.create@1', 'set.add@1', 'set.count@1'])
    const setCreate = callStatement(set.statements, 'set.create')
    expect(setCreate?.parameters).toMatchObject({
      containerType: JSON.stringify({ kind: 'set', element: 'number' }),
      valueType: 'number',
      itemsType: JSON.stringify({ kind: 'list', element: 'number' }),
    })

    const map = expressionGraph('映射({1,2},{10,20}).读取(1)').lowered
    expect(map.type).toBe('number')
    expect(modules(map)).toContain('map.create@1')
    expect(modules(map)).toContain('map.get@1')
    const mapCreate = callStatement(map.statements, 'map.create')
    expect(mapCreate?.parameters).toMatchObject({
      containerType: JSON.stringify({ kind: 'map', key: 'number', value: 'number' }),
    })
  })

  it('executes set members and function forms through createSkillCodeFlow', () => {
    expect(execute('集合({1,2,1}).包含(2)').result).toBe(true)
    expect(execute('包含(集合({1,2}),2)').result).toBe(true)
    expect(execute('集合({1,2,1}).移除(1).加入(3).转元组()').result).toEqual([2, 3])
    expect(execute('转元组(加入(集合({1}),2))').result).toEqual([1, 2])
    expect(execute('集合({1,2}).数量()').result).toBe(2)
    expect(execute('{1,2}.包含(2)').result).toBe(true)
  })

  it('executes typed map members, function forms, and map indexing', () => {
    expect(execute('映射({1,2},{10,20}).读取(1)').result).toBe(10)
    expect(execute('映射({"a","b"},{10,20})["b"]').result).toBe(20)
    expect(execute('映射({1,2},{10,20}).写入(3,30)[3]').result).toBe(30)
    expect(execute('写入(映射({1},{10}),2,20).读取(2)').result).toBe(20)
    expect(execute('映射({1,2},{10,20}).移除(1).数量()').result).toBe(1)
    expect(execute('映射({1,2},{10,20}).键列表()').result).toEqual([1, 2])
    expect(execute('值列表(映射({1,2},{10,20}))').result).toEqual([10, 20])
    expect(execute('映射({1,2},{10,20}).包含键(1)').result).toBe(true)
    expect(execute('包含键(映射({1,2},{10,20}),2)').result).toBe(true)
    expect(execute('映射({1,2},{10,20}).数量()').result).toBe(2)
  })

  it('keeps legacy record-map helpers on v1 while generic maps use the latest descriptors', () => {
    const legacy = expressionGraph('{x: 1, y: 2}.包含键("x")').lowered
    const hasKey = callStatement(legacy.statements, 'map.has-key')
    expect(hasKey?.version).toBe('1')
    expect(execute('{x: 1, y: 2}.包含键("x")').result).toBe(true)
    const legacyValues = expressionGraph('{x: 1, y: 2}.值列表()').lowered
    expect(callStatement(legacyValues.statements, 'map.values')?.version).toBe('1')
    expect(execute('{x: 1, y: 2}.值列表()').result).toEqual([1, 2])

    const generic = expressionGraph('映射({1},{2}).包含键(1)').lowered
    const genericHasKey = callStatement(generic.statements, 'map.has-key')
    expect(genericHasKey?.version).toBe('2')
    expect(genericHasKey?.parameters).toMatchObject({
      containerType: JSON.stringify({ kind: 'map', key: 'number', value: 'number' }),
      keyType: 'number',
      valueType: 'number',
      keysType: JSON.stringify({ kind: 'list', element: 'number' }),
      valuesType: JSON.stringify({ kind: 'list', element: 'number' }),
    })
  })

  it('uses expected set/map types only for empty constructors', () => {
    expect(() => lowerAuthorExpression('集合({})', { surface: 'skill' })).toThrow(/空元组需要集合类型上下文/)
    expect(() => lowerAuthorExpression('映射({}, {})', { surface: 'skill' })).toThrow(/空.*需要映射类型上下文/)
    expect(() => lowerAuthorExpression('集合({})', { surface: 'skill', expectedType: { kind: 'list', element: 'number' } })).toThrow(/集合类型上下文/)

    const emptySet = execute('集合({})', { kind: 'set', element: 'number' })
    expect(emptySet.result).toEqual({ format: 'author-set/v1', items: [] })
    expect(emptySet.lowered.type).toEqual({ kind: 'set', element: 'number' })
    const emptyMap = execute('映射({}, {})', { kind: 'map', key: 'string', value: 'number' })
    expect(emptyMap.result).toEqual({ format: 'author-map/v1', entries: [] })
    expect(emptyMap.lowered.type).toEqual({ kind: 'map', key: 'string', value: 'number' })
  })

  it('rejects container operation type mismatches during lowering', () => {
    expect(() => lowerAuthorExpression('集合({1}).加入("x")', { surface: 'skill' })).toThrow(/集合元素类型不一致/)
    expect(() => lowerAuthorExpression('映射({1},{10}).读取("1")', { surface: 'skill' })).toThrow(/映射键类型不一致/)
    expect(() => lowerAuthorExpression('映射({1},{10})["1"]', { surface: 'skill' })).toThrow(/映射键类型不一致/)
  })

  it('completes methods according to list, set, and map kinds', () => {
    const setValues = completeAuthorExpression('集合({1,2}).', { surface: 'skill' }).map(item => item.value)
    expect(setValues).toEqual(expect.arrayContaining(['集合({1,2}).包含()', '集合({1,2}).数量()', '集合({1,2}).加入()', '集合({1,2}).移除()', '集合({1,2}).转元组()']))
    const mapValues = completeAuthorExpression('映射({1},{2}).', { surface: 'skill' }).map(item => item.value)
    expect(mapValues).toEqual(expect.arrayContaining(['映射({1},{2}).包含键()', '映射({1},{2}).键列表()', '映射({1},{2}).值列表()', '映射({1},{2}).读取()', '映射({1},{2}).写入()', '映射({1},{2}).移除()']))
    expect(completeAuthorExpression('', { surface: 'skill' }).some(item => item.value === '集合()')).toBe(true)
    expect(authorTypeLabel({ kind: 'map', key: 'number', value: 'string' })).toBe('映射<数值, 文本>')
  })
})
