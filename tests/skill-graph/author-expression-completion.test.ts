import { describe, expect, it } from 'vitest'
import { authorExpressionParameterHint, completeAuthorExpression, describeAuthorReference } from '../../lib/skill-graph/author-expression-completion'
const suggestions = (prefix: string) => completeAuthorExpression(prefix, { surface: 'skill' })
describe('author expression lexical suggestions', () => {
  it('closes suggestions after a complete literal or call while keeping empty arguments discoverable', () => {
    expect(suggestions('amount * 2 + 1')).toEqual([])
    expect(suggestions('坐标(1,2)')).toEqual([])
    expect(suggestions('"天照"')).toEqual([])
    expect(suggestions('坐标(1, ')).not.toHaveLength(0)
    expect(suggestions('')).not.toHaveLength(0)
  })
  it('infers the empty argument or comparison at the caret and inspects nested references', () => {
    const context = { surface: 'skill' as const }
    expect(authorExpressionParameterHint('坐标(1, ', context)?.type).toBe('数值')
    expect(authorExpressionParameterHint('当前棋子.阵营 == ', context)?.type).toBe('文本')
    expect(authorExpressionParameterHint('查询棋子(当前棋子.位置,5).筛选(每项.生命值 > ', context)?.type).toBe('数值')
    expect(authorExpressionParameterHint('当前棋子.攻击', context)).toBeNull()
    expect(describeAuthorReference('每项', '查询棋子(当前棋子.位置,5).筛选(', context).fields).toContainEqual({ name: '生命值', type: '数值' })
  })
  it('does not expand every root until that receiver is entered', () => {
    expect(suggestions('').some(item => item.value === '当前棋子.生命值')).toBe(false)
    expect(suggestions('当前棋子。')).toContainEqual({ label: '当前棋子.生命值', value: '当前棋子.生命值', kind: '数值' })
    expect(suggestions('全局.').map(item => item.value)).toEqual(['全局.turnNumber', '全局.currentPlayerId', '全局.extension'])
  })
  it('offers concrete current-skill fields and piece ability groups', () => {
    expect(suggestions('当前技能.')).toContainEqual({ label: '当前技能.冷却', value: '当前技能.冷却', kind: '数值' })
    expect(suggestions('当前技能.')).toContainEqual({ label: '当前技能.所属棋子', value: '当前技能.所属棋子', kind: '棋子' })
    expect(suggestions('当前棋子.')).toContainEqual({ label: '当前棋子.能力组', value: '当前棋子.能力组', kind: '元组<结构体>' })
  })
  it('keeps the current hand as a typed instance while exposing its closed fields', () => {
    const context = { surface: 'card' as const }
    expect(completeAuthorExpression('当前手牌.', context)).toContainEqual({ label: '当前手牌.实例标识', value: '当前手牌.实例标识', kind: '文本' })
    expect(completeAuthorExpression('当前手牌.', context)).toContainEqual({ label: '当前手牌.扩展', value: '当前手牌.扩展', kind: '结构体或空' })
    expect(describeAuthorReference('当前手牌', '', context).fields).toContainEqual({ name: '实例标识', type: '文本' })
  })
  it('infers the inner item from its own tile-effect container', () => {
    const values = suggestions('查询棋子(当前棋子.位置, 5).筛选(每项.位置.地格效果.任意满足(每项.')
    expect(values).toContainEqual({ label: '每项.类型', value: '每项.类型', kind: '文本' })
    expect(values.some(item => item.value === '每项.生命值')).toBe(false)
  })
  it('carries locally created record schemas into nested completion', () => {
    expect(suggestions('{{amount:3}}.筛选(每项.')).toContainEqual({ label: '每项.amount', value: '每项.amount', kind: '数值' })
  })
  it('offers only declared extensions after their owner is entered', () => {
    const context = { surface: 'skill' as const, extensions: [{ scope: 'player' as const, namespace: 'content', name: '奖励', type: 'number' as const }] }
    expect(completeAuthorExpression('', context).some(item => item.value.includes('奖励'))).toBe(false)
    expect(completeAuthorExpression('当前玩家.extension.', context)).toContainEqual({ label: '当前玩家.extension.奖励', value: '当前玩家.extension.奖励', kind: '数值' })
    expect(completeAuthorExpression('全局.extension.', context)).toEqual([])
  })
})
