import { describe, expect, it } from 'vitest'
import { AuthorExpressionError, parseAuthorExpression as parse } from '../../lib/skill-graph/author-expression'

describe('author expression parser', () => {
  it('parses the nested tile-effect predicate without executing any function', () => {
    const text = '每项.位置.地格效果.任意满足(每项.类型 == "amaterasu")'
    expect(parse(text)).toMatchObject({ kind: 'call', callee: { kind: 'member', field: '任意满足' }, arguments: [{ value: { kind: 'binary', operator: '==', left: { kind: 'member', field: '类型' }, right: { kind: 'literal', value: 'amaterasu' } } }], start: 0, end: text.length })
  })
  it('keeps precedence and full-width syntax, preserving quoted text', () => {
    expect(parse('！（当前棋子。生命值 ＞ ５） ＆＆ x ＋ ２ × ３ ＝＝ ７')).toMatchObject({ kind: 'binary', operator: '&&', left: { kind: 'unary', operator: '!' }, right: { kind: 'binary', operator: '==', left: { kind: 'binary', operator: '+', right: { kind: 'binary', operator: '*' } } } })
    expect(parse('“全角。文字，保持！”')).toMatchObject({ kind: 'literal', value: '全角。文字，保持！' })
    expect(parse('2 ^ 3 ^ 2')).toMatchObject({ kind: 'binary', right: { kind: 'binary', operator: '^' } })
  })
  it('supports tuple/record construction, named parameters and one-based indexes', () => {
    expect(parse('{坐标(0, -1), 坐标(1, 0)}')).toMatchObject({ kind: 'tuple', items: [{ kind: 'call' }, { kind: 'call' }] })
    expect(parse('加入手牌(玩家: 当前玩家, 扩展初始化: {parts: parts})')).toMatchObject({ kind: 'call', arguments: [{ name: '玩家' }, { name: '扩展初始化', value: { kind: 'object', fields: [{ name: 'parts' }] } }] })
    expect(parse('目标列表[1].生命值')).toMatchObject({ kind: 'member', object: { kind: 'index', index: { kind: 'literal', value: 1 } } })
    expect(parse('{}')).toMatchObject({ kind: 'tuple', items: [] })
  })
  it('rejects script syntax, unsafe fields and malformed expressions with positions', () => {
    for (const source of ['x = 2', 'x => x', 'x; f()', '`text`', 'a.constructor', '{__proto__: 1}', 'f(a:1,a:2)', '{a:1,a:2}', 'f(a:1,2)', '1e', '1e999', 'f(', 'a.', '"unfinished']) expect(() => parse(source), source).toThrow(AuthorExpressionError)
    try { parse('a = 2') } catch (error) { expect(error).toMatchObject({ position: 2 }) }
  })
  it('bounds input and nested work instead of hanging', () => {
    expect(() => parse('('.repeat(100) + 'x' + ')'.repeat(100))).toThrow('嵌套超过上限')
    expect(() => parse('x'.repeat(33000))).toThrow('长度上限')
    expect(() => parse('x+'.repeat(2500) + 'x')).toThrow('符号数量上限')
  })
})
