import { describe, expect, it } from 'vitest'
import { lowerAuthorExpression } from '../../lib/skill-graph/author-expression-graph'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

function execute(expression: string) {
  const lowered = lowerAuthorExpression(expression, { surface: 'skill' })
  const graph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', schemas: lowered.schemas, outputs: [{ name: 'value', type: lowered.type }], body: [...lowered.statements, { kind: 'return', id: 'final', values: { value: lowered.value } }] }
  const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
  const piece = makePiece({ instanceId: 'caster', attack: 7 })
  const battle = makeState({ pieces: [piece] })
  const context = { piece, sourcePiece: piece, playerId: piece.ownerPlayerId }
  const flow = createFlowRuntime(battle, context, 'skill', {})
  return Function('context', 'flow', 'battle', `return (${code})(context)`)(context, flow, battle)
}

describe('author text lowers to the authoritative graph compiler', () => {
  it('runs nested arithmetic, booleans and Chinese field reads', () => {
    expect(execute('2 + 3 * (4 - 1)')).toEqual({ value: 11 })
    expect(execute('!(2 > 5) && (1 + 1 == 2)')).toEqual({ value: true })
    expect(execute('当前棋子.攻击力 * 1.5')).toEqual({ value: 10 })
    expect(execute('5 - 5 / 2')).toEqual({ value: 3 })
    expect(execute('-5 / 2')).toEqual({ value: -3 })
    expect(execute('false && (1 / 0 > 0)')).toEqual({ value: false })
    expect(execute('true || (1 / 0 > 0)')).toEqual({ value: true })
  })
  it('lowers current-hand field access through the typed instance reader', () => {
    expect(lowerAuthorExpression('当前手牌', { surface: 'card' }).domain).toBe('card-instance')
    const lowered = lowerAuthorExpression('当前手牌.实例标识', { surface: 'card' })
    expect(lowered.type).toEqual({ kind: 'nullable', value: 'string' })
    expect(lowered.statements.map(statement => statement.kind === 'call' ? statement.module : statement.kind)).toEqual(['ref.current-card', 'card.instance-field'])
    expect(lowered.statements.at(-1)).toMatchObject({ module: 'card.instance-field', parameters: { field: 'instanceId' } })
  })
  it('keeps record fields, tuples, 1-based indexing and nested item scopes typed', () => {
    expect(execute('{生命: 3, 数值: 5}.数值')).toEqual({ value: 5 })
    expect(execute('{3, 5, 7}[2]')).toEqual({ value: 5 })
    expect(execute('{1, 2, 3}.筛选(每项 > 1).逐项变换(每项 * 2)')).toEqual({ value: [4, 6] })
    expect(execute('{{1, 2}, {3, 4}}.任意满足(每项.全部满足(每项 > 2))')).toEqual({ value: true })
    expect(execute('{1,2}.包含(2)')).toEqual({ value: true })
    expect(execute('首项序号({1,2}, 2)')).toEqual({ value: 2 })
  })
  it('rejects unknown fields, undeclared references and unregistered functions', () => {
    for (const input of ['当前棋子.任意宿主字段', 'missing + 1', 'eval("1")', '当前对局.pieces', '1 == "1"', 'toString', 'valueOf', 'hasOwnProperty', '{1,2}.toString(每项 > 0)', '+"1"']) expect(() => execute(input), input).toThrow()
  })
})
