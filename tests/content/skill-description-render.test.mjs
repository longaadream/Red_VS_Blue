import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const context = vm.createContext({})
vm.runInContext(fs.readFileSync(new URL('../../data/pages/js/skill-description.js', import.meta.url), 'utf8'), context)
const render = context.RvBSkillDescription.render

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
