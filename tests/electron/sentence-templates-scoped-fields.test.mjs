import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const templates = require('../../electron-editor/ui/sentence-templates.js')

const v2 = {
  id: 'piece.write-field',
  version: '2',
  inputs: [
    { name: 'piece', type: 'piece', optional: true },
    { name: 'id', type: 'string', optional: true },
    { name: 'value', type: 'record' },
  ],
  outputs: [{ name: 'success', type: 'boolean' }],
  parameters: [
    { name: 'scope', type: 'string', enum: ['live', 'stored'], default: 'live' },
    { name: 'field', type: 'string', enum: ['spentPassives', 'momentum', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'showFreezeEffect'] },
    { name: 'valueType', type: 'string', enum: ['number'] },
  ],
  ui: { category: 'field', authoring: 'standard', parameterTypeBindings: { valueType: { parameter: 'field', types: {} } } },
}

const normalMove = {
  id: 'query.normal-move-cells',
  version: '1',
  inputs: [{ name: 'piece', type: 'piece' }],
  parameters: [],
}

const sourceField = {
  id: 'source.field',
  version: '1',
  inputs: [{ name: 'source', type: 'record' }],
  parameters: [{ name: 'field', type: 'string', enum: ['attack', 'defense', 'moveRange'] }],
}
const sourceCapture = {
  id: 'source.capture',
  version: '1',
  inputs: [{ name: 'source', type: 'piece' }],
  parameters: [],
}
const eventCapture = {
  id: 'source.capture-event-piece',
  version: '1',
  inputs: [],
  parameters: [{ name: 'field', type: 'string', enum: ['sourcePiece', 'targetPiece', 'piece', 'rulePiece'] }],
}
const removeEnemy = {
  id: 'lifecycle.remove-enemy',
  version: '1',
  inputs: [{ name: 'target', type: 'piece', nullable: true }],
  parameters: [],
}
const detachActive = {
  id: 'piece.detach-active',
  version: '2',
  inputs: [{ name: 'piece', type: 'piece' }],
  parameters: [{ name: 'flowStatePolicy', type: 'string', enum: ['cleanup', 'preserve'], default: 'cleanup' }],
}

function slots(fragments, kind) {
  return fragments.filter(item => item && typeof item === 'object' && item.kind === kind)
}

function rendered(fragments) {
  return fragments.map(fragment => typeof fragment === 'string' ? fragment : `【${fragment.kind}:${fragment.name}】`).join('')
}

test('v2 scoped writer renders one Chinese target and hides the other target input', () => {
  const live = { module: v2.id, version: '2', inputs: { piece: {}, id: {}, value: {} }, parameters: { scope: 'live', field: 'attack', valueType: 'number' } }
  const liveFragments = templates.describeCall(v2, live)
  assert.equal(templates.isSlotAvailable(v2, live, 'input', 'piece'), true)
  assert.equal(templates.isSlotAvailable(v2, live, 'input', 'id'), false)
  assert.equal(rendered(liveFragments), '将当前棋子【input:piece】的【parameter:field】设为【input:value】')
  assert.equal(slots(liveFragments, 'parameter').some(slot => slot.name === 'scope'), false)

  const stored = { module: v2.id, version: '2', inputs: { piece: {}, id: {}, value: {} }, parameters: { scope: 'stored', field: 'defense', valueType: 'number' } }
  const storedFragments = templates.describeCall(v2, stored)
  assert.equal(templates.isSlotAvailable(v2, stored, 'input', 'piece'), false)
  assert.equal(templates.isSlotAvailable(v2, stored, 'input', 'id'), true)
  assert.equal(rendered(storedFragments), '将已保存棋子记录【input:id】的【parameter:field】设为【input:value】')

  const storedFreeze = { module: v2.id, version: '2', inputs: { piece: {}, id: {}, value: {} }, parameters: { scope: 'stored', field: 'showFreezeEffect', valueType: 'boolean' } }
  assert.equal(rendered(templates.describeCall(v2, storedFreeze)), '将已保存棋子记录【input:id】的【parameter:field】设为【input:value】')
})

test('shared field and movement queries have author-facing Chinese sentences', () => {
  assert.equal(rendered(templates.describeCall(normalMove, { module: normalMove.id, version: '1', inputs: { piece: {} }, parameters: {} })), '按宿主普通移动规则查询【input:piece】的合法落点')
  assert.equal(rendered(templates.describeCall(sourceField, { module: sourceField.id, version: '1', inputs: { source: {} }, parameters: { field: 'attack' } })), '读取【input:source】的来源【parameter:field】字段')
  assert.equal(rendered(templates.describeCall(sourceCapture, { module: sourceCapture.id, version: '1', inputs: { source: {} }, parameters: {} })), '保留【input:source】作为本次结算来源')
  assert.equal(rendered(templates.describeCall(eventCapture, { module: eventCapture.id, version: '1', inputs: {}, parameters: { field: 'sourcePiece' } })), '保留事件中的【parameter:field】作为本次结算来源')
  assert.equal(rendered(templates.describeCall(removeEnemy, { module: removeEnemy.id, version: '1', inputs: { target: {} }, parameters: {} })), '使【input:target】出局')
  assert.equal(rendered(templates.describeCall(detachActive, { module: detachActive.id, version: '2', inputs: { piece: {} }, parameters: { flowStatePolicy: 'preserve' } })), '将【input:piece】安全移除，状态处理为【parameter:flowStatePolicy】')
})
