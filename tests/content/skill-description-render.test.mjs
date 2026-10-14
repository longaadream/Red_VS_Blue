import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const context = vm.createContext({})
vm.runInContext(fs.readFileSync(new URL('../../data/pages/js/author-expression-core.js', import.meta.url), 'utf8'), context)
vm.runInContext(fs.readFileSync(new URL('../../data/pages/js/skill-description.js', import.meta.url), 'utf8'), context)
const render = context.RvBSkillDescription.render
const interpolate = context.RvBSkillDescription.interpolate

test('只加粗声明关键词，保留距离、倍率、持续时间与原标点', () => {
  const text = '选择敌人（>6），造成2x攻击力的真实伤害，并施加定身[3]。'
  const html = render(text, ['真实伤害', '定身'])
  assert.ok(html.includes('<strong class="skill-description-keyword">真实伤害</strong>'))
  assert.ok(html.includes('<strong class="skill-description-keyword">定身</strong>[3]'))
  assert.equal(html.replace(/<[^>]*>/g, '').replaceAll('&gt;', '>'), text)
})

test('重复及重叠关键词只高亮一次且优先最长词', () => {
  assert.equal(render('真实伤害', ['伤害', '真实伤害', '真实伤害']), '<strong class="skill-description-keyword">真实伤害</strong>')
})

test('描述和关键词中的HTML只作为文字显示', () => {
  const html = render('<img src=x onerror=alert(1)> & "', ['<img'])
  assert.equal(html.includes('<img'), false)
  assert.ok(html.includes('&lt;img'))
  assert.ok(html.endsWith('&amp; &quot;'))
})

test('无关键词或空描述不改变正常显示', () => {
  assert.equal(render('回复自身5点。', null), '回复自身5点。')
  assert.equal(render('', ['打坐']), '')
})

test('只从显式实例上下文读取插值，保留零值并标记缺失字段', () => {
  const html = render(
    '攻击{当前棋子.攻击力}，冷却{当前技能.冷却}/{当前技能.基础冷却}，扩展{当前棋子.扩展变量.倍率}，缺失{当前棋子.没有这个字段}。',
    [],
    {
      piece: { stats: { attack: 0 }, extension: { 倍率: 2 } },
      skill: { cooldownTurns: 4 },
      skillInstance: { currentCooldown: 0 },
    },
  )
  const text = html.replace(/<[^>]*>/g, '')
  assert.equal(text, '攻击0，冷却0/4，扩展2，缺失未赋值。')
})

test('编辑器未提供实例上下文时不伪造运行时数值', () => {
  assert.equal(render('伤害{当前棋子.攻击力}。', [], {}), '伤害未赋值。')
  assert.equal(render('伤害{当前棋子.攻击力}。', []), '伤害{当前棋子.攻击力}。')
})

test('插值结果和占位符仍按文字转义，禁止读取原型路径', () => {
  assert.equal(
    render('标签{values.label}，原型{values.constructor}。', [], { values: { label: '<b>&' } }),
    '标签&lt;b&gt;&amp;，原型未赋值。',
  )
  assert.equal(interpolate('{{amount}} / {amount}', { values: { amount: 0 } }), '0 / 0')
  assert.equal(interpolate('{amount}', { values: { amount: 7.5 } }), '7.5')
})

test('复用作者表达式 AST，只求值安全成员和纯运算', () => {
  const contextValue = { values: { amount: 7.5, other: 2 } }
  assert.equal(interpolate('{amount * 1.5}', contextValue), '11.25')
  assert.equal(interpolate('{math.floor(amount * 1.5)}', contextValue), '11')
  assert.equal(interpolate('{最大值(amount, other)}', contextValue), '7.5')
  assert.equal(interpolate('{math.max(right: other, left: amount)}', contextValue), '7.5')
  assert.equal(interpolate('{amount > other && !false}', contextValue), '是')
  assert.equal(interpolate('{Math.max(amount, other)}', contextValue), '未赋值')
  assert.equal(interpolate('{evil(amount)}', { values: { amount: 1, evil() { throw new Error('must not run') } } }), '未赋值')
})

test('布尔插值显示中文状态，作者写入的文本保持原样', () => {
  assert.equal(interpolate('{enabled} / {disabled}', { values: { enabled: true, disabled: false } }), '是 / 否')
  assert.equal(interpolate('{text}', { values: { text: 'true' } }), 'true')
})

test('支持全角占位符并保留字符串字面量中的括号', () => {
  assert.equal(interpolate('结果：｛１＋２｝；文本：｛"保留｛括号｝"｝。', {}), '结果：3；文本：保留｛括号｝。')
  assert.equal(interpolate('结果：｛１＋２｝。', undefined), '结果：｛１＋２｝。')
})

test('只读取数据描述符，不执行 getter', () => {
  let called = false
  const values = {}
  Object.defineProperty(values, 'amount', { enumerable: true, get() { called = true; return 9 } })
  assert.equal(interpolate('{amount}', { values }), '未赋值')
  assert.equal(called, false)
})

test('数组和作者 tuple 使用一基索引，记录数值键保持原样', () => {
  const context = { values: { 值: [10, 20], 记录: { 1: 30 } } }
  assert.equal(interpolate('{值[1]} / {值[2]} / {值[0]} / {记录[1]} / {({10, 20})[1]}', context), '10 / 20 / 未赋值 / 30 / 10')
})

test('未闭合占位符按文字尾部一次处理，并限制整段模板预算', () => {
  const details = context.RvBSkillDescription.interpolateDetails
  const unclosed = '前缀{amount + 1，后缀｛仍是文字'
  assert.equal(details(unclosed, { values: { amount: 2 } }).text, unclosed)

  const many = Array.from({ length: 300 }, () => '{amount}').join('')
  const result = details(many, { values: { amount: 1 } })
  assert.ok(result.diagnostics.includes('description-template-budget'))
  assert.ok(result.text.includes('未赋值'))
  assert.equal(result.text.slice(0, 256), '1'.repeat(256))
})
