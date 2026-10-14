import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.dataset = {}
    this.className = ''
    this.textContent = ''
    this.value = ''
  }

  append(...items) {
    for (const item of items) if (item !== null && item !== undefined) this.children.push(item)
  }

  querySelectorAll() { return [] }
}

function loadEditorInternals() {
  const filename = fileURLToPath(new URL('../../electron-editor/ui/sentence-editor.js', import.meta.url))
  const source = fs.readFileSync(filename, 'utf8')
  const marker = 'window.SkillSentenceEditor = { mount }'
  assert.ok(source.includes(marker), 'sentence editor export marker must remain stable')
  const instrumented = source.replace(
    marker,
    'window.SkillSentenceEditor = { mount, __test: { movementEnumDisplay, enumLiteralDisplay, enumValueDisplay, literalControl, literalDisplay, semanticSlotLabel, outputLabel, typeLabel, authorContentReference, authorReferenceCatalog } }',
  )
  const window = {}
  const document = { createElement: tagName => new StubElement(tagName) }
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout })
  vm.runInContext(instrumented, context, { filename })
  return window.SkillSentenceEditor.__test
}

const internals = loadEditorInternals()
const editorSource = fs.readFileSync(fileURLToPath(new URL('../../electron-editor/ui/sentence-editor.js', import.meta.url)), 'utf8')

test('movement enum values use Chinese labels only in their typed contexts', () => {
  const kind = { name: 'kind', type: 'string', enum: ['teleport', 'dash', 'walk', 'push', 'pull', 'swap'] }
  const terrain = { name: 'terrain', type: 'string', enum: ['walkable', 'projectile', 'any'] }
  const kindLabels = {
    teleport: '传送', dash: '冲刺', walk: '步行', push: '推动', pull: '拉拽', swap: '交换',
  }
  const terrainLabels = { walkable: '可通行', projectile: '弹道', any: '任意' }

  for (const [value, label] of Object.entries(kindLabels)) assert.equal(internals.movementEnumDisplay(value, kind), label)
  for (const [value, label] of Object.entries(terrainLabels)) assert.equal(internals.movementEnumDisplay(value, terrain), label)
  assert.equal(internals.movementEnumDisplay('dash', { name: 'kind', type: 'string', enum: ['card', 'revolver'] }), undefined)
  assert.equal(internals.movementEnumDisplay('walkable', { name: 'mode', type: 'string', enum: ['walkable'] }), undefined)
  assert.equal(internals.enumLiteralDisplay('dash', { name: 'kind', type: 'string', enum: ['card'] }), 'dash')
  assert.equal((editorSource.match(/movementEnumDisplay\(value, definition\)/g) || []).length, 2, 'dropdown and sentence-slot paths must share the movement mapper')
})

test('movement dropdown labels preserve stable English serialized values', () => {
  const control = internals.literalControl('dash', {
    name: 'kind', type: 'string', enum: ['dash', 'swap'],
  }, () => {})
  const select = control.children[0]
  assert.equal(JSON.stringify(Array.from(select.children, option => String(option.textContent))), '["冲刺","交换"]')
  assert.equal(JSON.stringify(Array.from(select.children, option => String(option.value))), '["\\"dash\\"","\\"swap\\""]')
})

test('damage attribution labels are Chinese while serialized policy IDs stay stable', () => {
  const definition = { name: 'attribution', type: 'string', enum: ['current', 'unattributed'] }
  assert.equal(internals.enumLiteralDisplay('current', definition), '沿用当前归属')
  assert.equal(internals.enumLiteralDisplay('unattributed', definition), '无技能归属')
  const control = internals.literalControl('unattributed', definition, () => {})
  const select = control.children[0]
  assert.equal(JSON.stringify(Array.from(select.children, option => String(option.textContent))), '["沿用当前归属","无技能归属"]')
  assert.equal(JSON.stringify(Array.from(select.children, option => String(option.value))), '["\\"current\\"","\\"unattributed\\""]')
})

test('standard summon and display enum controls localize values without changing serialized IDs', () => {
  const mode = { name: 'mode', type: 'string', enum: ['new-instance', 'return-instance', 'declaration'] }
  const sourceType = { name: 'sourceType', type: 'string', enum: ['piece', 'record'] }
  const audience = { name: 'audience', type: 'string', enum: ['public', 'owner', 'allies', 'enemies', 'spectators'] }

  assert.deepEqual(
    Array.from(internals.literalControl('new-instance', mode, () => {}).children[0].children, option => [option.textContent, option.value]),
    [['新建棋子', '"new-instance"'], ['原实例回场', '"return-instance"'], ['使用当前内容声明', '"declaration"']],
  )
  assert.deepEqual(
    Array.from(internals.literalControl('public', audience, () => {}).children[0].children, option => [option.textContent, option.value]),
    [['公开', '"public"'], ['所属玩家', '"owner"'], ['友方', '"allies"'], ['敌方', '"enemies"'], ['观战者', '"spectators"']],
  )
  assert.equal(internals.enumLiteralDisplay('piece', sourceType), '棋子来源')
  assert.equal(internals.semanticSlotLabel({ name: 'attackBonus' }, 'attackBonus'), '攻击加成')
  assert.equal(internals.outputLabel({ outputs: [{ name: 'beforeFirstEnemy' }] }, 'beforeFirstEnemy'), '首个敌人之前')
  assert.equal(internals.typeLabel({ kind: 'list', element: 'piece' }), '元组<棋子>')
  assert.equal(internals.literalDisplay('attack'), '攻击力')
})

test('author content references are limited to shared schemas and status catalog entries', () => {
  assert.equal(internals.authorContentReference({ name: 'rules' }, 'template.rules', { schema: 'author.piece-template@1' }).collection, 'rules')
  assert.equal(internals.authorContentReference({ name: 'skillId' }, 'skill.skillId', { schema: 'author.piece-skill@1' }).collection, 'skills')
  assert.equal(internals.authorContentReference({ name: 'templateId' }, 'display.templateId', { schema: 'author.piece-display@1' }).collection, 'pieces')
  assert.equal(internals.authorContentReference({ name: 'id' }, 'status.id', { schema: 'author.piece-status@1' }).collection, 'statusTags')
  assert.equal(internals.authorContentReference({ name: 'id' }, 'custom.id', { schema: 'custom@1' }), null)

  const catalog = internals.authorReferenceCatalog({
    skills: { skill: { id: 'skill', statusTag: { id: 'status-skill', name: '技能状态' } } },
    pieces: { piece: { id: 'piece', initialStatusTags: [{ id: 'status-piece', name: '棋子状态' }] } },
  })
  assert.equal(JSON.stringify(Array.from(catalog.statusTags, item => item.id)), '["status-skill","status-piece"]')
})

test('built-in nested structure types have distinct Chinese names', () => {
  assert.equal(internals.typeLabel({ kind: 'record', schema: 'author.piece-template@1' }), '棋子模板')
  assert.equal(internals.typeLabel({ kind: 'list', element: { kind: 'record', schema: 'author.piece-skill@1' } }), '元组<技能实例>')
  assert.equal(internals.typeLabel({ kind: 'record', schema: 'author.piece-display-plan@1' }), '棋子显示方案')
  assert.equal(internals.typeLabel({ kind: 'record', schema: 'author.piece-instance@1' }), '棋子实例副本')
})
