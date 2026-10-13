import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

function loadEditorInternals() {
  const filename = fileURLToPath(new URL('../../electron-editor/ui/sentence-editor.js', import.meta.url))
  const source = fs.readFileSync(filename, 'utf8')
  const marker = 'window.SkillSentenceEditor = { mount }'
  assert.ok(source.includes(marker), 'sentence editor export marker must remain stable')
  const instrumented = source.replace(
    marker,
    'window.SkillSentenceEditor = { mount, __test: { setStatementValue, authorExpressionMetadataName, legacyAuthorExpressionMetadataMatches, authorExpressionMetadataEntry, authorReferenceCatalog, authorReferenceEntries, authorReferenceValueInfo } }',
  )
  const window = {}
  const document = { createElement: () => ({}) }
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout })
  vm.runInContext(instrumented, context, { filename })
  return window.SkillSentenceEditor.__test
}

const internals = loadEditorInternals()

const output = (node, port = 'value') => ({ kind: 'output', node, port })

test('record.with keeps a field named record separate from its source record', () => {
  const statement = { kind: 'record.with', record: output('source'), fields: {} }

  assert.equal(internals.setStatementValue(statement, 'field:record', output('field-expression')), true)
  assert.deepEqual(JSON.parse(JSON.stringify(statement.record)), output('source'))
  assert.deepEqual(JSON.parse(JSON.stringify(statement.fields)), { record: output('field-expression') })

  assert.equal(internals.setStatementValue(statement, 'record', output('new-source')), true)
  assert.deepEqual(JSON.parse(JSON.stringify(statement.record)), output('new-source'))
  assert.deepEqual(JSON.parse(JSON.stringify(statement.fields)), { record: output('field-expression') })
})

test('record.with metadata namespaces the colliding field and keeps legacy field metadata readable', () => {
  const withStatement = { kind: 'record.with' }
  const createStatement = { kind: 'record.create' }

  assert.equal(internals.authorExpressionMetadataName(withStatement, 'field:record'), 'field:record')
  assert.equal(internals.authorExpressionMetadataName(withStatement, 'field:amount'), 'amount')
  assert.equal(internals.authorExpressionMetadataName(createStatement, 'field:record'), 'record')

  // The namespaced key is distinct from the source-record key even when both
  // expressions exist on the same statement.
  assert.notEqual(
    internals.authorExpressionMetadataName(withStatement, 'field:record'),
    internals.authorExpressionMetadataName(withStatement, 'record'),
  )

  const fieldValue = output('field-expression')
  const sourceValue = output('source-expression')
  const current = { kind: 'output', node: 'field-expression', port: 'value' }
  const legacy = { kind: 'record.with', layout: { authorExpressions: { record: { source: '旧字段表达式', value: fieldValue } } } }
  const source = { kind: 'record.with', layout: { authorExpressions: { record: { source: '来源表达式', value: sourceValue } } } }
  assert.equal(internals.authorExpressionMetadataEntry(legacy, 'field:record', current).legacy, true)
  assert.equal(internals.authorExpressionMetadataEntry(source, 'field:record', current).entry, null)

  const sharedValue = output('shared-expression')
  const sharedCurrent = output('shared-expression')
  const ambiguousLegacy = {
    kind: 'record.with',
    record: sharedValue,
    layout: { authorExpressions: { record: { source: '来源表达式', value: sharedValue } } },
  }
  assert.equal(internals.legacyAuthorExpressionMetadataMatches(ambiguousLegacy, ambiguousLegacy.layout.authorExpressions.record, sharedCurrent), false)
  assert.equal(internals.authorExpressionMetadataEntry(ambiguousLegacy, 'field:record', sharedCurrent).entry, null)
})

test('content reference labels resolve catalog names while preserving unknown IDs', () => {
  const catalog = {
    rules: { 'rule-dissolve': { id: 'rule-dissolve', name: '受伤后消散' } },
    skills: { items: [{ id: 'skill-fire', title: '火球术' }] },
    clusters: { dataMap: { 'cluster-piece': { id: 'cluster-piece', label: '影分身能力组' } } },
  }
  assert.equal(JSON.stringify(internals.authorReferenceEntries(catalog, 'rules')), JSON.stringify([{ id: 'rule-dissolve', label: '受伤后消散' }]))
  assert.equal(JSON.stringify(internals.authorReferenceValueInfo('rule-dissolve', 'rules', catalog)), JSON.stringify({
    text: '受伤后消散', missing: false, raw: 'rule-dissolve',
  }))
  assert.equal(JSON.stringify(internals.authorReferenceValueInfo(['rule-dissolve', 'rule-removed'], 'rules', catalog)), JSON.stringify({
    text: '受伤后消散、未找到引用', missing: true, raw: ['rule-dissolve', 'rule-removed'],
  }))
  assert.equal(JSON.stringify(internals.authorReferenceValueInfo('rule-removed', 'rules', catalog)), JSON.stringify({
    text: '未找到引用', missing: true, raw: 'rule-removed',
  }))
  assert.equal(internals.authorReferenceValueInfo('skill-fire', 'skills', catalog)?.text, '火球术')
  assert.equal(internals.authorReferenceValueInfo('cluster-piece', 'clusters', catalog)?.text, '影分身能力组')
})

test('status catalog aliases survive author catalog adaptation', () => {
  const aliasCatalog = {
    statusTags: [],
    statuses: { 'status-ready': { id: 'status-ready', name: '准备状态' } },
    skills: { 'skill-without-status': { id: 'skill-without-status', name: '技能' } },
  }
  const adapted = internals.authorReferenceCatalog(aliasCatalog)
  assert.equal(internals.authorReferenceValueInfo('status-ready', 'statusTags', adapted)?.text, '准备状态')
  assert.equal(internals.authorReferenceEntries(adapted, 'statusTags')[0]?.id, 'status-ready')

  const legacyOnly = { 'status-effects': [{ id: 'status-burn', title: '灼烧' }] }
  const legacyAdapted = internals.authorReferenceCatalog(legacyOnly)
  assert.equal(internals.authorReferenceValueInfo('status-burn', 'statusTags', legacyAdapted)?.text, '灼烧')
})
