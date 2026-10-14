import { describe, expect, it } from 'vitest'
import { lowerAuthorExpression } from '../../lib/skill-graph/author-expression-graph'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('extension member expressions', () => {
  it('reads the current stored value on each evaluation rather than the declaration snapshot', () => {
    const piece = makePiece({ instanceId: 'caster' }); const battle = makeState({ pieces: [piece] })
    const context = { piece, playerId: piece.ownerPlayerId }; const flow = createFlowRuntime(battle, context, 'skill', {})
    flow.extension.declareValue('player', piece.ownerPlayerId, 'content', '奖励', 'number', [], 3)
    const lowered = lowerAuthorExpression('当前玩家.extension.奖励 * 2', { surface: 'skill', extensions: [{ scope: 'player', namespace: 'content', name: '奖励', type: 'number' }] })
    const code = compileGameplayModuleGraph({ version: 'rvb-gameplay-modules/v1', surface: 'skill', schemas: lowered.schemas, outputs: [{ name: 'value', type: lowered.type }], body: [...lowered.statements, { kind: 'return', id: 'done', values: { value: lowered.value } }] }, GAMEPLAY_MODULE_REGISTRY).code
    const execute = () => Function('context', 'flow', 'battle', `return (${code})(context)`)(context, flow, battle)
    expect(execute()).toEqual({ value: 6 })
    flow.extension.writeValue('player', piece.ownerPlayerId, 'content', '奖励', '', 'number', [], 5)
    expect(execute()).toEqual({ value: 10 })
  })
  it('permits a custom access in an expected numeric parameter without manufacturing a field', () => {
    const lowered = lowerAuthorExpression('全局.extension.外部技能', { surface: 'skill', expectedType: 'number' })
    expect(lowered.type).toBe('number')
    expect(lowered.statements).toContainEqual(expect.objectContaining({ module: 'extension.read-battle', parameters: { namespace: 'content', name: '外部技能', path: '', valueType: 'number' } }))
    expect(() => lowerAuthorExpression('全局.extension.外部技能', { surface: 'skill' })).toThrow('声明此扩展变量的类型')
  })
  it('rejects an absent field on a known extension schema even in a numeric parameter', () => {
    expect(() => lowerAuthorExpression('全局.extension.数据.不存在', { surface: 'skill', expectedType: 'number',
      extensions: [{ scope: 'battle', namespace: 'content', name: '数据', type: { kind: 'record', schema: 'data' } }],
      schemas: [{ id: 'data', version: '1', fields: [{ name: 'amount', type: 'number' }] }],
    })).toThrow('没有字段')
    expect(() => lowerAuthorExpression('全局.extension.数值.不存在', { surface: 'skill', expectedType: 'number',
      extensions: [{ scope: 'battle', namespace: 'content', name: '数值', type: 'number' }],
    })).toThrow('没有字段')
  })
})
