import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

let activeDocument = null

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.dataset = {}
    this.value = ''
    this.textContent = ''
    this.disabled = false
    this.lastChild = null
    this.attributes = {}
  }

  append(...items) {
    for (const item of items) if (item !== null && item !== undefined) {
      this.children.push(item)
      this.lastChild = item
    }
  }

  replaceChildren(...items) {
    this.children = []
    this.lastChild = null
    this.append(...items)
  }

  setAttribute(name, value) { this.attributes[name] = String(value) }

  removeAttribute(name) { delete this.attributes[name] }

  focus() { if (activeDocument) activeDocument.activeElement = this }

  get childElementCount() { return this.children.length }
}

function loadEditor() {
  const filename = fileURLToPath(new URL('../../electron-editor/ui/object-editor.js', import.meta.url))
  const source = fs.readFileSync(filename, 'utf8')
  const window = {}
  const document = { activeElement: null, createElement: tagName => new StubElement(tagName) }
  activeDocument = document
  vm.runInNewContext(source, { window, document, console }, { filename })
  return { api: window.AuthorObjectEditor, StubElement }
}

function find(root, predicate) {
  if (predicate(root)) return root
  for (const child of root.children || []) {
    const match = find(child, predicate)
    if (match) return match
  }
  return null
}

test('recursive record editing preserves omitted, null, zero, and empty values', () => {
  const { api, StubElement } = loadEditor()
  const schema = {
    id: 'payload', version: '1', label: '载荷结构', fields: [
      { name: 'zero', label: '零值', type: 'number', default: 0 },
      { name: 'empty', label: '空文本', type: 'string', default: '' },
      { name: 'nullable', label: '可空字段', type: { kind: 'nullable', value: 'number' } },
      { name: 'nested', label: '嵌套结构', type: { kind: 'record', schema: 'inner@1' } },
    ],
  }
  const inner = { id: 'inner', version: '1', label: '内层结构', fields: [{ name: 'flag', label: '标记', type: 'boolean' }] }
  const root = new StubElement('div')
  const changes = []
  const editor = api.mount(root, {
    value: { zero: 0, empty: '', nullable: null, nested: { flag: false } },
    type: { kind: 'record', schema: 'payload@1' },
    schemas: [schema, inner],
    onChange: value => changes.push(value),
  })

  assert.equal(JSON.stringify(editor.getValue()), JSON.stringify({ zero: 0, empty: '', nullable: null, nested: { flag: false } }))
  assert.equal(find(root, item => item.dataset.objectEditorFieldState === 'default')?.textContent, '默认值')

  const nullable = find(root, item => item.dataset.objectEditorFieldInclude === 'nested.nullable')
  assert.equal(nullable, null, 'nested field selector is expected on the nested record only')
  const rootNullable = find(root, item => item.dataset.objectEditorFieldInclude === 'nullable')
  rootNullable.value = 'omitted'
  rootNullable.onchange()
  assert.equal(Object.prototype.hasOwnProperty.call(editor.getValue(), 'nullable'), false)
  const omittedAgain = find(root, item => item.dataset.objectEditorFieldInclude === 'nullable')
  omittedAgain.value = 'null'
  omittedAgain.onchange()
  assert.equal(editor.getValue().nullable, null)
  assert.ok(changes.length >= 2)
})

test('schema selection stores a versioned reference while exposing Chinese metadata', () => {
  const { api, StubElement } = loadEditor()
  const root = new StubElement('div')
  const editor = api.mount(root, {
    value: {},
    type: 'record',
    schemas: [{ id: 'piece-display', version: '2', label: '棋子显示结构', fields: [{ name: 'name', label: '名称', type: 'string' }] }],
    allowSchemaSelect: true,
  })
  const schemaSelect = find(root, item => item.dataset.objectEditorSchema === 'true')
  schemaSelect.value = 'piece-display@2'
  schemaSelect.onchange()
  assert.equal(editor.getEditorState().type.schema, 'piece-display@2')
  assert.equal(find(root, item => item.textContent === '棋子显示结构')?.textContent, '棋子显示结构')
})

test('open records use the declared JSON type for unknown fields and preserve arbitrary data', () => {
  const { api, StubElement } = loadEditor()
  const root = new StubElement('div')
  const value = { count: 2, snapshotFields: { shield: 0, flow: { value: ['kept'] }, enabled: false } }
  const schema = {
    id: 'open-payload', version: '1', label: '开放数据结构', additionalFields: 'json',
    fields: [{ name: 'count', label: '数量', type: 'number' }],
  }
  const editor = api.mount(root, {
    value,
    type: { kind: 'record', schema: 'open-payload@1' },
    schemas: [schema],
  })

  const jsonControl = find(root, item => item.dataset.objectEditorValue === 'snapshotFields')
  assert.equal(jsonControl?.tagName, 'TEXTAREA')
  assert.equal(find(root, item => item.className === 'author-object-editor-type' && item.textContent === '任意数据')?.textContent, '任意数据')
  jsonControl.value = '{"shield":0,"flow":{"value":["kept"]},"enabled":false,"empty":[]}'
  jsonControl.onchange()
  assert.equal(JSON.stringify(editor.getValue()), JSON.stringify({
    count: 2,
    snapshotFields: { shield: 0, flow: { value: ['kept'] }, enabled: false, empty: [] },
  }))
})

test('list edits and additions read the latest value and preserve focus', () => {
  const { api, StubElement } = loadEditor()
  const root = new StubElement('div')
  const editor = api.mount(root, { value: [1, 2], type: { kind: 'list', element: 'number' } })

  const first = find(root, item => item.dataset.objectEditorValue === '0')
  first.focus()
  first.value = '10'
  first.onchange()
  const second = find(root, item => item.dataset.objectEditorValue === '1')
  second.value = '20'
  second.onchange()
  assert.equal(JSON.stringify(editor.getValue()), JSON.stringify([10, 20]))

  const add = find(root, item => item.dataset.objectEditorListAdd === '')
  add.focus()
  add.onclick()
  assert.equal(JSON.stringify(editor.getValue()), JSON.stringify([10, 20, 0]))
  assert.equal(find(root, item => item.dataset.objectEditorListAdd === ''), activeDocument?.activeElement)
  const remove = find(root, item => item.dataset.objectEditorListRemove === '1')
  remove.focus()
  remove.onclick()
  assert.equal(JSON.stringify(editor.getValue()), JSON.stringify([10, 0]))
  assert.equal(find(root, item => item.dataset.objectEditorListAdd === ''), activeDocument?.activeElement)
})

test('versioned schema references are exact and bare references reject ambiguity', () => {
  const { api, StubElement } = loadEditor()
  const v1 = { id: 'payload', version: '1', fields: [{ name: 'old', type: 'string' }] }
  const v2 = { id: 'payload', version: '2', fields: [{ name: 'new', type: 'number' }] }
  assert.equal(api.resolveSchema('payload@2', { schemas: [v1, v2] }), v2)
  assert.equal(api.resolveSchema('payload', { schemas: [v1, v2] }), null)

  const registry = {
    payload: v1,
    'payload@2': v2,
    resolve(reference) { return reference === 'payload@2' ? v2 : v1 },
    get(reference) { return this[reference] },
  }
  assert.equal(api.resolveSchema('payload@2', { schemaRegistry: registry }), v2)

  const root = new StubElement('div')
  api.mount(root, { value: {}, type: { kind: 'record', schema: 'payload' }, schemas: [v1, v2] })
  assert.match(find(root, item => item.className === 'author-object-editor-error')?.textContent || '', /版本不明确/)
})

test('author map and set values retain tagged shape, typed nested edits, and uniqueness errors', () => {
  const { api, StubElement } = loadEditor()
  const entry = {
    id: 'entry', version: '1', fields: [{ name: 'count', label: '数量', type: 'number' }],
  }
  const mapRoot = new StubElement('div')
  const mapEditor = api.mount(mapRoot, {
    value: { format: 'author-map/v1', entries: [['red', { count: 1 }], ['blue', { count: 2 }]] },
    type: { kind: 'map', key: 'string', value: { kind: 'record', schema: 'entry@1' } },
    schemas: [entry],
  })
  const key = find(mapRoot, item => item.dataset.objectEditorValue === 'entries.0.0')
  key.value = 'green'; key.onchange()
  const nested = find(mapRoot, item => item.dataset.objectEditorValue === 'entries.0.1.count')
  nested.value = '7'; nested.onchange()
  assert.equal(JSON.stringify(mapEditor.getValue()), JSON.stringify({
    format: 'author-map/v1', entries: [['green', { count: 7 }], ['blue', { count: 2 }]],
  }))
  find(mapRoot, item => item.dataset.objectEditorMapAdd === '').onclick()
  assert.equal(mapEditor.getValue().entries.length, 3)

  const duplicateKey = find(mapRoot, item => item.dataset.objectEditorValue === 'entries.1.0')
  duplicateKey.value = 'green'; duplicateKey.onchange()
  assert.equal(mapEditor.getValue().entries[1][0], 'blue')
  assert.match(find(mapRoot, item => item.className === 'author-object-editor-error')?.textContent || '', /重复/)

  const setRoot = new StubElement('div')
  const setEditor = api.mount(setRoot, {
    value: { format: 'author-set/v1', items: [{ count: 3 }, { count: 4 }] },
    type: { kind: 'set', element: { kind: 'record', schema: 'entry@1' } },
    schemas: [entry],
  })
  const setNested = find(setRoot, item => item.dataset.objectEditorValue === 'items.0.count')
  setNested.value = '8'; setNested.onchange()
  assert.equal(JSON.stringify(setEditor.getValue()), JSON.stringify({ format: 'author-set/v1', items: [{ count: 8 }, { count: 4 }] }))
  find(setRoot, item => item.dataset.objectEditorSetAdd === '').onclick()
  assert.equal(setEditor.getValue().items.length, 3)

  const malformed = { format: 'author-map/v1', entries: [['same', 1], ['same', 2]] }
  const malformedRoot = new StubElement('div')
  const malformedEditor = api.mount(malformedRoot, { value: malformed, type: { kind: 'map', key: 'string', value: 'number' } })
  assert.equal(JSON.stringify(malformedEditor.getValue()), JSON.stringify(malformed))
  assert.match(find(malformedRoot, item => item.className === 'author-object-editor-error')?.textContent || '', /重复/)
})

test('controlled content references show names, preserve IDs, and retain broken or custom strings', () => {
  const { api, StubElement } = loadEditor()
  const schema = {
    id: 'author.piece-template', version: '1', fields: [
      { name: 'templateId', label: '模板引用', type: 'string', referenceCollection: 'pieces' },
      { name: 'rules', label: '初始规则', type: { kind: 'list', element: 'string' }, referenceCollection: 'rules' },
      { name: 'id', label: '自定义标识', type: 'string' },
    ],
  }
  const catalog = {
    pieces: {
      'piece-red': { id: 'piece-red', name: '同名棋子' },
      'piece-blue': { id: 'piece-blue', name: '同名棋子' },
    },
    rules: {
      'rule-one': { id: 'rule-one', name: '受伤后消散' },
    },
  }
  const root = new StubElement('div')
  const editor = api.mount(root, {
    value: { templateId: 'piece-red', rules: ['rule-one'], id: '自定义字符串' },
    type: { kind: 'record', schema: 'author.piece-template@1' },
    schemas: [schema], catalog,
  })
  const template = find(root, item => item.dataset.objectEditorValue === 'templateId')
  assert.equal(template.tagName, 'SELECT')
  assert.deepEqual(
    Array.from(template.children, option => [option.textContent, option.value]),
    [['未选择', ''], ['同名棋子（第1项）', 'piece-red'], ['同名棋子（第2项）', 'piece-blue']],
  )
  template.value = 'piece-blue'; template.onchange()
  assert.equal(editor.getValue().templateId, 'piece-blue', 'same-name entries still save the selected stable ID')

  const rule = find(root, item => item.dataset.objectEditorValue === 'rules.0')
  assert.equal(rule.tagName, 'SELECT')
  assert.equal(rule.children[1].textContent, '受伤后消散')
  const custom = find(root, item => item.dataset.objectEditorValue === 'id')
  assert.equal(custom.tagName, 'INPUT', 'ordinary custom strings do not become content pickers')
  assert.equal(custom.value, '自定义字符串')

  editor.setValue({ templateId: 'piece-removed', rules: ['rule-one'], id: '仍然保留' })
  const missing = find(root, item => item.dataset.objectEditorMissingReference === 'true' && item.tagName === 'OPTION')
  assert.equal(missing.textContent, '引用内容不存在')
  assert.equal(missing.value, 'piece-removed')
  assert.equal(find(root, item => item.className === 'author-object-editor-reference-error')?.textContent, '引用内容不存在')
  assert.equal(editor.getValue().templateId, 'piece-removed', 'a broken reference is visible but never silently replaced')
})

test('schema-scoped reference resolver adapts status IDs without affecting generic records', () => {
  const { api, StubElement } = loadEditor()
  const statusSchema = {
    id: 'author.piece-status', version: '1', fields: [{ name: 'id', type: 'string' }],
  }
  const root = new StubElement('div')
  const editor = api.mount(root, {
    value: { id: 'status-ready' },
    type: { kind: 'record', schema: 'author.piece-status@1' },
    schemas: [statusSchema],
    catalog: { statusTags: [{ id: 'status-ready', name: '准备状态' }] },
    referenceResolver: (field, _path, context) => context.schema === 'author.piece-status@1' && field.name === 'id'
      ? { collection: 'statusTags' } : null,
  })
  const control = find(root, item => item.dataset.objectEditorValue === 'id')
  assert.equal(control.tagName, 'SELECT')
  assert.equal(control.children[1].textContent, '准备状态')
  control.value = 'status-ready'; control.onchange()
  assert.equal(editor.getValue().id, 'status-ready')

  const genericRoot = new StubElement('div')
  const generic = api.mount(genericRoot, {
    value: { id: 'user-id' },
    type: { kind: 'record', schema: 'custom@1' },
    schemas: [{ id: 'custom', version: '1', fields: [{ name: 'id', type: 'string' }] }],
    catalog: { statusTags: [{ id: 'status-ready', name: '准备状态' }] },
  })
  assert.equal(find(genericRoot, item => item.dataset.objectEditorValue === 'id').tagName, 'INPUT')
  assert.equal(generic.getValue().id, 'user-id')
})

test('reference pickers accept catalog snapshots and keep a broken serialized reference', () => {
  const { api, StubElement } = loadEditor()
  const schema = {
    id: 'author.piece-template', version: '1', fields: [
      { name: 'rules', label: '初始规则', type: { kind: 'list', element: 'string' }, referenceCollection: 'rules' },
      { name: 'abilityGroupIds', label: '能力组', type: { kind: 'list', element: 'string' }, referenceCollection: 'clusters' },
    ],
  }
  const root = new StubElement('div')
  const editor = api.mount(root, {
    value: { rules: ['rule-dissolve'], abilityGroupIds: ['cluster-shadow'] },
    type: { kind: 'record', schema: 'author.piece-template@1' },
    schemas: [schema],
    catalog: {
      rules: { items: [{ id: 'rule-dissolve', title: '受伤后消散' }] },
      clusters: { dataMap: { 'cluster-shadow': { id: 'cluster-shadow', label: '影分身能力组' } } },
    },
  })
  assert.equal(find(root, item => item.dataset.objectEditorValue === 'rules.0')?.tagName, 'SELECT')
  assert.equal(find(root, item => item.dataset.objectEditorValue === 'rules.0').children[1].textContent, '受伤后消散')
  assert.equal(find(root, item => item.dataset.objectEditorValue === 'abilityGroupIds.0').children[1].textContent, '影分身能力组')

  editor.setValue({ rules: ['rule-removed'], abilityGroupIds: ['cluster-shadow'] })
  const missing = find(root, item => item.dataset.objectEditorMissingReference === 'true' && item.tagName === 'OPTION')
  assert.equal(missing.textContent, '引用内容不存在')
  assert.equal(missing.value, 'rule-removed')
  assert.equal(editor.getValue().rules[0], 'rule-removed')
})
