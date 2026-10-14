import { describe, expect, it, vi } from 'vitest'
import { lowerAuthorAssignment, lowerAuthorExtensionDeclaration } from '../../lib/skill-graph/author-statements'
import { lowerAuthorExpression } from '../../lib/skill-graph/author-expression-graph'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createSkillCodeFlow, gainCardInstance } from '../../lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'
import type { GameplayModuleGraph } from '../../lib/skill-graph/module-types'

describe('unified author statements', () => {
  it.each(['当前棋子', '当前玩家', '全局'])('declares, assigns and reads a Chinese extension on %s through real runtime', owner => {
    const context = { surface: 'skill' as const }
    const declared = lowerAuthorExtensionDeclaration(owner, '计数', 'number', '2', { ...context, prefix: 'declare' })
    const assigned = lowerAuthorAssignment(`${owner}.扩展变量.计数`, `${owner}.扩展变量.计数 + 3`, {
      ...context, prefix: 'assign', extensions: [{ scope: declared.scope, namespace: 'content', name: '计数', type: 'number' }],
    })
    const read = lowerAuthorExpression(`${owner}.扩展变量.计数`, { ...context, prefix: 'read', expectedType: 'number' })
    const graph: GameplayModuleGraph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'value', type: 'number' }],
      body: [...declared.statements, ...assigned.statements, ...read.statements, { kind: 'return', id: 'return', values: { value: read.value } }] }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const piece = makePiece({ instanceId: 'caster' }), battle = makeState({ pieces: [piece] }), runtimeContext = { piece, playerId: piece.ownerPlayerId }
    const flow = createFlowRuntime(battle, runtimeContext, 'skill', {})
    expect(Function('context', 'flow', `return (${compiled.code})(context)`)(runtimeContext, flow)).toEqual({ value: 5 })
  })

  it('resolves local assignment to the existing handle and infers its type', () => {
    const result = lowerAuthorAssignment('次数', '次数 + 1', { surface: 'skill', bindings: {
      次数: { local: true, type: 'number', value: { kind: 'output', node: 'declare', port: 'handle' } },
    } })
    expect(result.statements.at(-1)).toMatchObject({ module: 'local.write', inputs: { handle: { kind: 'output', node: 'declare', port: 'handle' } }, parameters: { valueType: 'number' } })
    expect(() => lowerAuthorAssignment('次数', '1', { surface: 'skill' })).toThrow('尚未声明')
  })

  it('selects the bounded piece and skill field writers without permitting position writes', () => {
    expect(lowerAuthorAssignment('当前棋子.攻击力', '5', { surface: 'skill' }).statements.at(-1)).toMatchObject({ module: 'piece.write-field', parameters: { field: 'attack', scope: 'live' } })
    expect(lowerAuthorAssignment('当前技能.冷却', '1', { surface: 'skill' }).statements.at(-1)).toMatchObject({ module: 'author.skill-instance.write', parameters: { field: 'currentCooldown' } })
    expect(() => lowerAuthorAssignment('当前棋子.x', '5', { surface: 'skill' })).toThrow()
    expect(() => lowerAuthorAssignment('当前棋子.攻击力', '"五"', { surface: 'skill' })).toThrow()
    expect(() => lowerAuthorAssignment('1 + 2', '5', { surface: 'skill' })).toThrow()
  })

  it('uses the same declaration for a skill instance and checks names and initial types', () => {
    const result = lowerAuthorExtensionDeclaration('当前技能', '计数', 'number', '0', { surface: 'skill' })
    expect(result.statements.at(-1)).toMatchObject({ module: 'extension.declare-instance', parameters: { entityKind: 'skill', name: '计数' } })
    expect(() => lowerAuthorExtensionDeclaration('当前玩家', '', 'number', '0', { surface: 'skill' })).toThrow()
    expect(() => lowerAuthorExtensionDeclaration('当前玩家', '计数', 'number', '"零"', { surface: 'skill' })).toThrow()
  })

  it.each(['card', 'skill', 'rule', 'status', 'cluster'] as const)('preserves a saved %s instance as an extension owner', kind => {
    const context = { surface: 'skill' as const, bindings: {
      已选对象: { local: true, type: 'record' as const, domain: `${kind}-instance` as const, value: { kind: 'output' as const, node: 'saved', port: 'handle' } },
    } }
    const declaration = lowerAuthorExtensionDeclaration('已选对象', '倍率', 'number', '1', context)
    expect(declaration.scope).toBe(kind)
    expect(declaration.statements.at(-1)).toMatchObject({ module: 'extension.declare-instance', parameters: { entityKind: kind } })
    const assignment = lowerAuthorAssignment('已选对象.扩展变量.倍率', '2', context)
    expect(assignment.statements.at(-1)).toMatchObject({ module: 'extension.write-instance', parameters: { entityKind: kind } })
  })

  it('preserves a saved instance tuple through indexing before extension access', () => {
    const result = lowerAuthorExtensionDeclaration('手牌们[1]', '倍率', 'number', '1', { surface: 'skill', bindings: {
      手牌们: { local: true, type: { kind: 'list', element: 'record' }, domain: 'card-instances', value: { kind: 'output', node: 'saved', port: 'handle' } },
    } })
    expect(result.scope).toBe('card')
    expect(result.statements.at(-1)).toMatchObject({ module: 'extension.declare-instance', parameters: { entityKind: 'card' } })
  })

  it('changes only one of two same-name hand instances and reads its multiplier after restore', () => {
    const battle = makeState(), playerId = battle.players[0].playerId
    gainCardInstance(battle, 'holy-smite', playerId)
    gainCardInstance(battle, 'holy-smite', playerId)
    expect(battle.players[0].hand).toHaveLength(2)
    const root = lowerAuthorExpression('当前手牌', { surface: 'card', prefix: 'card' })
    const options = { surface: 'card' as const, bindings: {
      选中的手牌: { local: true, type: root.type, domain: 'card-instance' as const, value: { kind: 'output' as const, node: 'saved', port: 'handle' } },
    }, extensions: [{ scope: 'card' as const, namespace: 'content', name: '倍率', type: 'number' as const }] }
    const declare = lowerAuthorExtensionDeclaration('选中的手牌', '倍率', 'number', '1', { ...options, prefix: 'declare' })
    const assign = lowerAuthorAssignment('选中的手牌.扩展变量.倍率', '2', { ...options, prefix: 'assign' })
    const read = lowerAuthorExpression('5 * 当前手牌.扩展变量.倍率', { ...options, prefix: 'read' })
    const run = (state: typeof battle, index: number, strengthen: boolean) => {
      const graph: GameplayModuleGraph = { version: 'rvb-gameplay-modules/v1', surface: 'card', outputs: [{ name: 'value', type: 'number' }], body: [
        ...root.statements,
        { kind: 'call', id: 'saved', module: 'local.declare', version: '2', parameters: { name: '选中的手牌', valueType: typeof root.type === 'string' ? root.type : JSON.stringify(root.type) }, inputs: { initial: root.value } },
        ...declare.statements, ...(strengthen ? assign.statements : []), ...read.statements,
        { kind: 'return', id: 'return', values: { value: read.value } },
      ] }
      const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
      const cardInstance = state.players[0].hand[index], context = { playerId, card: { id: cardInstance.cardId }, cardInstance }
      return Function('context', 'flow', `return (${code})(context)`)(context, createSkillCodeFlow(state, context, 'card'))
    }
    expect(run(battle, 0, true)).toEqual({ value: 10 })
    expect(run(battle, 1, false)).toEqual({ value: 5 })
    const restored = JSON.parse(JSON.stringify(battle)) as typeof battle
    expect(run(restored, 0, false)).toEqual({ value: 10 })
    expect(run(restored, 1, false)).toEqual({ value: 5 })
  })

  it('writes a new key into an extension map without first reading the absent key', () => {
    const type = { kind: 'map' as const, key: 'string' as const, value: 'number' as const }
    const options = { surface: 'skill' as const, extensions: [{ scope: 'player' as const, namespace: 'content', name: '奖励', type }] }
    const declare = lowerAuthorExtensionDeclaration('当前玩家', '奖励', type, '映射({"原有"}, {2})', { ...options, prefix: 'declare' })
    const assign = lowerAuthorAssignment('当前玩家.扩展变量.奖励["新增"]', '7', { ...options, prefix: 'sentence-module-7' })
    expect(assign.statements.some(statement => statement.kind === 'call' && statement.module === 'map.get')).toBe(false)
    const read = lowerAuthorExpression('当前玩家.扩展变量.奖励["新增"] + 当前玩家.扩展变量.奖励["原有"]', { ...options, prefix: 'read' })
    const graph: GameplayModuleGraph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'value', type: 'number' }], body: [...declare.statements, ...assign.statements, ...read.statements, { kind: 'return', id: 'done', values: { value: read.value } }] }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const piece = makePiece(), battle = makeState({ pieces: [piece] }), runtimeContext = { piece, playerId: piece.ownerPlayerId }
    const flow = createFlowRuntime(battle, runtimeContext, 'skill', {})
    expect(Function('context', 'flow', `return (${compiled.code})(context)`)(runtimeContext, flow)).toEqual({ value: 9 })
  })

  it('updates one field of a local structure and preserves its other fields', () => {
    const schemas = [{ id: 'stats', version: '1', fields: [{ name: 'amount', label: '伤害', type: 'number' as const }, { name: 'other', type: 'number' as const }] }]
    const type = { kind: 'record' as const, schema: 'stats@1' }
    const bindings = { 数据: { local: true, type, value: { kind: 'output' as const, node: 'local', port: 'handle' } } }
    const options = { surface: 'skill' as const, schemas, bindings }
    const assign = lowerAuthorAssignment('数据.伤害', '数据.伤害 + 3', options)
    const read = lowerAuthorExpression('数据.伤害 + 数据.other', { ...options, prefix: 'read' })
    const graph: GameplayModuleGraph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', schemas, outputs: [{ name: 'value', type: 'number' }], body: [
      { kind: 'record.create', id: 'initial', schema: 'stats@1', fields: { amount: { kind: 'literal', value: 2 }, other: { kind: 'literal', value: 7 } } },
      { kind: 'call', id: 'local', module: 'local.declare', version: '2', parameters: { name: '数据', valueType: JSON.stringify(type) }, inputs: { initial: { kind: 'output', node: 'initial', port: 'value' } } },
      ...assign.statements, ...read.statements, { kind: 'return', id: 'done', values: { value: read.value } },
    ] }
    const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
    const context = {}, battle = makeState(), flow = createFlowRuntime(battle, context, 'skill', {})
    expect(Function('context', 'flow', `return (${code})(context)`)(context, flow)).toEqual({ value: 12 })
  })

  it('evaluates a random assignment receiver once and preserves each piece’s own map', () => {
    const type = { kind: 'map' as const, key: 'string' as const, value: 'number' as const }
    const options = { surface: 'skill' as const, extensions: [{ scope: 'piece' as const, namespace: 'content', name: '奖励', type }],
      bindings: { 对手: { type: { kind: 'nullable' as const, value: 'piece' as const }, value: { kind: 'output' as const, node: 'other', port: 'piece' } },
        棋子们: { type: { kind: 'list' as const, element: 'piece' as const }, value: { kind: 'output' as const, node: 'pieces', port: 'pieces' } } } }
    const a = lowerAuthorExtensionDeclaration('当前棋子', '奖励', type, '映射({"原有"}, {11})', { ...options, prefix: 'a' })
    const b = lowerAuthorExtensionDeclaration('对手', '奖励', type, '映射({"原有"}, {22})', { ...options, prefix: 'b' })
    const assign = lowerAuthorAssignment('随机项目(棋子们).扩展变量.奖励["新增"]', '7', { ...options, prefix: 'assign' })
    const read = lowerAuthorExpression('当前棋子.扩展变量.奖励["原有"] + 当前棋子.扩展变量.奖励["新增"] + 对手.扩展变量.奖励["原有"]', { ...options, prefix: 'read' })
    const graph: GameplayModuleGraph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'value', type: 'number' }], body: [
      { kind: 'call', id: 'other', module: 'ref.target', version: '1', inputs: {} },
      { kind: 'call', id: 'pieces', module: 'query.pieces', version: '1', inputs: {}, parameters: { relation: 'all' } },
      ...a.statements, ...b.statements, ...assign.statements, ...read.statements, { kind: 'return', id: 'done', values: { value: read.value } },
    ] }
    const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
    const piece = makePiece({ instanceId: 'a' }), other = makePiece({ instanceId: 'b', x: 1 })
    const battle = makeState({ pieces: [piece, other] }), context = { piece, target: other, playerId: piece.ownerPlayerId }
    const flow = createFlowRuntime(battle, context, 'skill', {})
    let calls = 0
    const random = vi.spyOn(flow.query, 'random').mockImplementation(items => items[calls++ % items.length])
    const result = Function('context', 'flow', `return (${code})(context)`)(context, flow)
    expect(random).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ value: 40 })
  })

  it('accepts null only for nullable variables and extensions', () => {
    const type = { kind: 'nullable' as const, value: 'number' as const }
    const options = { surface: 'skill' as const, bindings: { 值: { local: true, type, value: { kind: 'output' as const, node: 'local', port: 'handle' } } } }
    expect(() => lowerAuthorExtensionDeclaration('当前玩家', '值', type, 'null', options)).not.toThrow()
    expect(() => lowerAuthorAssignment('值', 'null', options)).not.toThrow()
    expect(() => lowerAuthorAssignment('值', '3', options)).not.toThrow()
    expect(() => lowerAuthorExtensionDeclaration('当前玩家', '值', 'number', 'null', options)).toThrow()
  })
})
