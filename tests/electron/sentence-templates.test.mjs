import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const templates = require('../../electron-editor/ui/sentence-templates.js')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function loadStandardCatalog() {
  const source = [
    "import registry from './lib/skill-graph/module-registry.ts'",
    "const catalog = registry.getGameplayModuleCatalog().filter(item => item.ui?.authoring === 'standard')",
    "console.log(JSON.stringify(catalog.map(item => ({ id: item.id, version: item.version, label: item.label, inputs: item.inputs, outputs: item.outputs, parameters: item.parameters, ui: item.ui }))))",
  ].join('; ')
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', source], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

const standardCatalog = loadStandardCatalog()

test('new summons expose an empty template slot and label the summon mode', () => {
  const descriptor = standardCatalog.find(item => item.id === 'author.effect.summon' && item.version === '2')
  const statement = { module: descriptor.id, version: '2', inputs: {}, parameters: { mode: 'new-instance' } }
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'template'), true)
  assert.match(rendered(templates.describeCall(descriptor, statement)), /召唤【input:template】/u)
  assert.match(rendered(templates.describeCall(descriptor, statement)), /召唤方式为【parameter:mode】/u)
  statement.parameters.mode = 'declaration'
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'template'), false)
})

test('writable fields derive their value type from registry metadata without another author type choice', () => {
  const piece = standardCatalog.find(item => item.id === 'piece.write-field')
  const status = standardCatalog.find(item => item.id === 'status.write-field')
  for (const [descriptor, field, expected] of [
    [piece, 'currentHp', 'number'], [piece, 'momentum', 'number'],
    [piece, 'spentPassives', JSON.stringify({ kind: 'list', element: 'string' })],
    [status, 'visible', 'boolean'], [status, 'name', 'string'],
    [status, 'expiresAfterTurn', JSON.stringify({ kind: 'nullable', value: 'number' })],
  ]) {
    const statement = { module: descriptor.id, version: descriptor.version, parameters: { field, valueType: 'stale' } }
    assert.deepEqual(templates.derivedParameterValues(descriptor, statement), { valueType: expected })
    assert.equal(templates.isSlotAvailable(descriptor, statement, 'parameter', 'valueType'), false)
    assert.equal(statement.parameters.valueType, 'stale', 'derivation does not mutate the draft before applying the edit')
  }
})

test('dynamic card creation reads as one sentence and hides inferred structural types', () => {
  const descriptor = standardCatalog.find(item => item.id === 'content.materialize-template' && item.version === '2')
  const statement = { module: descriptor.id, version: '2', inputs: { template: { kind: 'literal', value: 'armor' },
    name: { kind: 'literal', value: '护甲' }, cardId: { kind: 'literal', value: 'armor-new' } },
    parameters: { fieldsType: 'record', extensionType: 'record' } }
  const sentence = rendered(templates.describeCall(descriptor, statement))
  assert.ok(sentence.startsWith('使用模板【input:template】创建卡牌【input:name】'))
  assert.equal(sentence.includes('fieldsType'), false)
  assert.equal(sentence.includes('extensionType'), false)
  assert.equal(sentence.includes('input:extension'), false)
})

test('captured rule removal keeps one Chinese sentence and derives its target type', () => {
  const descriptor = standardCatalog.find(item => item.id === 'rule.remove-id-raw' && item.version === '2')
  assert.ok(descriptor)
  const statement = {
    module: descriptor.id,
    version: descriptor.version,
    inputs: { target: { kind: 'literal', value: { scope: 'execution-source', id: 'source-a' } } },
    parameters: { targetType: 'record', ruleId: 'legacy-rule' },
  }
  const fragments = templates.describeCall(descriptor, statement)
  assert.equal(slots(fragments, 'parameter').some(item => item.name === 'targetType'), false)
  assert.equal(templates.isDerivedParameter(descriptor, statement, 'targetType'), true)
  assert.equal(rendered(fragments), '从本次执行来源【input:target】中移除规则【parameter:ruleId】')
})

test('summon declaration mode uses the shared Chinese sentence and hides template-only inputs', () => {
  const descriptor = standardCatalog.find(item => item.id === 'author.effect.summon' && item.version === '2')
  assert.ok(descriptor)
  const statement = {
    module: descriptor.id,
    version: descriptor.version,
    inputs: {
      source: { kind: 'output', node: 'capture', port: 'source' },
      destination: { kind: 'output', node: 'cell', port: 'cell' },
    },
    parameters: { mode: 'declaration', sourceType: 'record', destinationType: 'cell' },
  }
  const fragments = templates.describeCall(descriptor, statement)
  assert.equal(rendered(fragments), '在【input:destination】使用当前内容声明召唤，来源为【input:source】')
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'template'), false)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'display'), false)
  assert.equal(slots(fragments, 'input').some(item => item.name === 'template' || item.name === 'display'), false)
})

function slots(fragments, kind) {
  return fragments.filter(item => item && typeof item === 'object' && item.kind === kind)
}

function rendered(fragments) {
  return fragments.map(fragment => {
    if (typeof fragment === 'string') return fragment
    return `【${fragment.kind}:${fragment.name}】`
  }).join('')
}

test('standard registry modules expose each required slot exactly once', () => {
  assert.ok(standardCatalog.length > 100)
  for (const descriptor of standardCatalog) {
    const statement = {
      module: descriptor.id,
      version: descriptor.version,
      inputs: Object.fromEntries((descriptor.inputs || []).map((item, index) => [item.name, { kind: 'literal', value: index + 1 }])),
      parameters: Object.fromEntries((descriptor.parameters || []).map((item, index) => [item.name, index + 1])),
    }
    const fragments = templates.describeCall(descriptor, statement)
    for (const [kind, field] of [['input', 'inputs'], ['parameter', 'parameters']]) {
      for (const definition of descriptor[field] || []) {
        const count = slots(fragments, kind).filter(item => item.name === definition.name).length
        const inferredParameters = {
          'author.card.gain': ['extensionType'], 'local.write': ['valueType'],
          // v2 keeps the live/stored scope in the serialized statement and
          // inspector, while the sentence renders the selected Chinese
          // target directly instead of exposing a duplicate slot.
          'piece.write-field': ['scope'],
          'author.cluster.acquire': ['definitionType'], 'code-block.invoke': ['blockType', 'argsType'],
          'author.effect.summon': ['sourceType', 'templateType', 'destinationType', 'displayType'], 'author.piece.display': ['displayType'],
        }
        const inferred = kind === 'parameter' && (
          templates.isDerivedParameter(descriptor, statement, definition.name)
          || inferredParameters[descriptor.id]?.includes(definition.name)
          || /^author\.effect\.(damage|heal)$/.test(descriptor.id) && descriptor.version === '2' && (['sourceType', 'targetType', 'amountType', 'resultType', 'legacyNormalSpelling'].includes(definition.name) || descriptor.id === 'author.effect.heal' && definition.name === 'damageType')
          || (/^set\./.test(descriptor.id) || /^map\.(create|get|set|delete|count)$/.test(descriptor.id) || /^map\.(has-key|keys|values)$/.test(descriptor.id) && descriptor.version === '2') && ['containerType', 'keyType', 'valueType', 'keysType', 'valuesType', 'itemsType'].includes(definition.name)
        )
        assert.equal(count, inferred ? 0 : 1, `${descriptor.id} ${kind}.${definition.name} appeared ${count} times`)
      }
    }
  }
})

test('successful action results hide redundant messages while preserving old graph data', () => {
  const descriptor = standardCatalog.find(item => item.id === 'result.action')
  assert.ok(descriptor)
  const statement = {
    module: descriptor.id,
    version: descriptor.version,
    inputs: {
      success: { kind: 'literal', value: true },
      message: { kind: 'literal', value: '' },
    },
    parameters: {},
  }
  const before = JSON.stringify(statement)
  const fragments = templates.describeCall(descriptor, statement)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'message'), false)
  assert.equal(templates.isRedundantResultMessage(descriptor, statement, 'input', 'message'), true)
  assert.equal(slots(fragments, 'input').some(item => item.name === 'message'), false)
  assert.doesNotMatch(rendered(fragments), /消息|提示文字/)
  assert.deepEqual(fragments.optional, [{ kind: 'input', name: 'message' }])
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'message', { allowUnsetOptional: true }), true)
  assert.equal(JSON.stringify(statement), before)
})

test('failed or dynamic action results keep the failure reason input editable', () => {
  const descriptor = standardCatalog.find(item => item.id === 'result.action')
  assert.ok(descriptor)
  for (const success of [
    { kind: 'literal', value: false },
    { kind: 'output', node: 'maybe-fails', port: 'success' },
  ]) {
    const statement = {
      module: descriptor.id,
      version: descriptor.version,
      inputs: { success, message: { kind: 'literal', value: '失败原因' } },
      parameters: {},
    }
    const fragments = templates.describeCall(descriptor, statement)
    assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'message'), true)
    assert.equal(templates.isRedundantResultMessage(descriptor, statement, 'input', 'message'), false)
    assert.equal(slots(fragments, 'input').filter(item => item.name === 'message').length, 1)
    assert.match(rendered(fragments), /消息为/)
  }
})

test('an existing successful message stays visible and editable', () => {
  const descriptor = standardCatalog.find(item => item.id === 'result.action')
  assert.ok(descriptor)
  for (const message of [
    { kind: 'literal', value: '成功说明' },
    { kind: 'output', node: 'success-text', port: 'text' },
  ]) {
    const statement = {
      module: descriptor.id,
      version: descriptor.version,
      inputs: { success: { kind: 'literal', value: true }, message },
      parameters: {},
    }
    const fragments = templates.describeCall(descriptor, statement)
    assert.equal(templates.isRedundantResultMessage(descriptor, statement, 'input', 'message'), false)
    assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'message'), true)
    assert.equal(slots(fragments, 'input').filter(item => item.name === 'message').length, 1)
    assert.match(rendered(fragments), /消息为/)
  }
})

test('an empty successful message stays optional without deleting authored data', () => {
  const descriptor = standardCatalog.find(item => item.id === 'result.action')
  assert.ok(descriptor)
  const statement = {
    module: descriptor.id,
    version: descriptor.version,
    inputs: { success: { kind: 'literal', value: true }, message: { kind: 'literal', value: '' } },
    parameters: {},
  }
  const before = JSON.stringify(statement)
  const fragments = templates.describeCall(descriptor, statement)
  assert.equal(templates.isRedundantResultMessage(descriptor, statement, 'input', 'message'), true)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'message'), false)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'message', { allowUnsetOptional: true }), true)
  assert.deepEqual(fragments.optional, [{ kind: 'input', name: 'message' }])
  assert.equal(JSON.stringify(statement), before)
})

test('legacy result.message defaults to a silent success while retaining authored text and failure text', () => {
  const descriptor = {
    id: 'result.message',
    version: '1',
    inputs: [{ name: 'message', type: 'string' }],
    parameters: [{ name: 'success', type: 'boolean', default: true }],
  }
  const successful = { module: descriptor.id, inputs: {}, parameters: {} }
  assert.equal(templates.isRedundantResultMessage(descriptor, successful, 'input', 'message'), true)
  assert.equal(slots(templates.describeCall(descriptor, successful), 'input').length, 0)

  const authored = { ...successful, inputs: { message: { kind: 'literal', value: '旧成功文案' } } }
  assert.equal(templates.isRedundantResultMessage(descriptor, authored, 'input', 'message'), false)
  assert.equal(slots(templates.describeCall(descriptor, authored), 'input').length, 1)

  const failed = { ...authored, parameters: { success: false } }
  assert.equal(templates.isRedundantResultMessage(descriptor, failed, 'input', 'message'), false)
  assert.equal(slots(templates.describeCall(descriptor, failed), 'input').length, 1)
})

test('instance extension entity kind is derived from the typed entity input', () => {
  for (const id of ['extension.declare-instance', 'extension.read-instance', 'extension.write-instance']) {
    const descriptor = standardCatalog.find(item => item.id === id)
    assert.ok(descriptor, id)
    assert.deepEqual(templates.getTemplate(id).derivedParameters, ['entityKind'])
    const statement = {
      module: id,
      version: descriptor.version,
      inputs: { entity: { kind: 'output', node: 'current-hand', port: 'instance' } },
      parameters: { entityKind: 'card', namespace: 'content', name: 'armor', valueType: 'number' },
    }
    const fragments = templates.describeCall(descriptor, statement)
    assert.equal(slots(fragments, 'parameter').some(item => item.name === 'entityKind'), false)
    assert.equal(templates.isSlotAvailable(descriptor, statement, 'parameter', 'entityKind'), false)
    assert.equal(statement.parameters.entityKind, 'card')
  }
})

test('unconfigured optional slots stay out of the sentence and remain available to the UI', () => {
  const descriptor = standardCatalog.find(item => item.id === 'author.effect.damage')
  const fragments = templates.describeCall(descriptor, {
    module: descriptor.id,
    version: descriptor.version,
    inputs: {},
    parameters: {},
  })
  assert.equal(slots(fragments, 'parameter').some(item => item.name === 'skillId'), false)
  assert.deepEqual(fragments.optional, [{ kind: 'parameter', name: 'skillId' }])
})

test('damage sentence keeps the agreed Chinese slot order', () => {
  const descriptor = standardCatalog.find(item => item.id === 'author.effect.damage')
  const fragments = templates.describeCall(descriptor, {
    module: descriptor.id,
    version: descriptor.version,
    inputs: { source: {}, target: {}, amount: {} },
    parameters: { damageType: 'normal' },
  })
  assert.equal(rendered(fragments), '对【input:target】造成【input:amount】点【parameter:damageType】伤害，来源为【input:source】')
  const currentDescriptor = standardCatalog.find(item => item.id === 'author.effect.damage' && item.version === '2')
  assert.ok(currentDescriptor)
  const currentStatement = {
    module: currentDescriptor.id, version: '2',
    inputs: { source: {}, target: {}, amount: {} },
    parameters: { damageType: 'normal', legacyNormalSpelling: 'magical' },
  }
  const currentFragments = templates.describeCall(currentDescriptor, currentStatement)
  assert.equal(rendered(currentFragments), '对【input:target】造成【input:amount】点【parameter:damageType】伤害，来源为【input:source】')
  assert.equal(currentFragments.optional.some(slot => slot.name === 'legacyNormalSpelling'), false)
  assert.equal(currentStatement.parameters.legacyNormalSpelling, 'magical')
  const unattributedFragments = templates.describeCall(currentDescriptor, {
    module: currentDescriptor.id, version: '2',
    inputs: { source: {}, target: {}, amount: {} },
    parameters: { damageType: 'true', attribution: 'unattributed' },
  })
  assert.equal(rendered(unattributedFragments), '对【input:target】造成【input:amount】点【parameter:damageType】伤害，来源为【input:source】，归属方式为【parameter:attribution】')
})

test('dynamic card copy exposes typed inputs and an editable natural sentence', () => {
  const descriptor = standardCatalog.find(item => item.id === 'content.copy-card')
  assert.ok(descriptor)
  assert.deepEqual(
    descriptor.inputs.map(item => [item.name, item.type]),
    [['sourceId', 'string'], ['index', 'number']],
  )
  assert.deepEqual(
    descriptor.outputs.map(item => [item.name, item.type]),
    [['cardId', 'string'], ['copied', 'boolean']],
  )
  const fragments = templates.describeCall(descriptor, {
    module: descriptor.id,
    version: descriptor.version,
    inputs: { sourceId: {}, index: {} },
    parameters: { idPrefix: 'rafaam-curse-copy-' },
  })
  assert.equal(
    rendered(fragments),
    '复制【input:sourceId】的卡牌定义，序号为【input:index】，新卡牌标识前缀为【parameter:idPrefix】',
  )
})

test('extension and dependency metadata remain Chinese and type-aware', () => {
  const descriptor = standardCatalog.find(item => item.id === 'extension.read-player')
  const fragments = templates.describeCall(descriptor, {
    module: descriptor.id,
    version: descriptor.version,
    inputs: { owner: {} },
    parameters: { name: 'state', path: '', valueType: 'number' },
  })
  const text = rendered(fragments)
  assert.match(text, /读取/)
  assert.doesNotMatch(text, /字段路径|分组为/)
  assert.ok(fragments.optional.some(slot => slot.name === 'path'))
  const fieldText = rendered(templates.describeCall(descriptor, { parameters: { name: 'state', path: 'hp', valueType: 'number' }, inputs: { owner: {} } }))
  assert.match(fieldText, /字段路径/)
  assert.match(text, /类型为/)
  const metadata = templates.getTemplate(descriptor.id).dependencies
  assert.deepEqual(metadata.valueType, ['name'])
  assert.deepEqual(metadata.value, ['name', 'valueType'])
})

test('dependent extension slots appear only after a meaningful name', () => {
  const descriptor = standardCatalog.find(item => item.id === 'extension.declare-player')
  const statement = {
    module: descriptor.id,
    inputs: { owner: {}, value: { kind: 'literal', value: 0 } },
    parameters: { name: '' },
  }
  const before = JSON.stringify(statement)
  const empty = templates.describeCall(descriptor, statement)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'parameter', 'name'), true)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'parameter', 'valueType'), false)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'value'), false)
  assert.equal(slots(empty, 'input').some(item => item.name === 'value'), false)
  assert.doesNotMatch(rendered(empty), /初始值|类型为/)
  assert.equal(JSON.stringify(statement), before)

  const readyStatement = {
    ...statement,
    parameters: { ...statement.parameters, name: 'health' },
  }
  const ready = templates.describeCall(descriptor, readyStatement)
  assert.equal(templates.isSlotAvailable(descriptor, readyStatement, 'parameter', 'valueType'), true)
  assert.equal(templates.isSlotAvailable(descriptor, readyStatement, 'input', 'value'), true)
  assert.match(rendered(ready), /初始值为【input:value】/)
  assert.match(rendered(ready), /类型为【parameter:valueType】/)
  assert.equal(statement.parameters.name, '')
  assert.equal(statement.inputs.value.value, 0)

  const blockedNamespace = {
    ...readyStatement,
    parameters: { ...readyStatement.parameters, namespace: '', valueType: 'number' },
  }
  const blockedBefore = JSON.stringify(blockedNamespace)
  const blocked = templates.describeCall(descriptor, blockedNamespace)
  assert.equal(templates.isSlotAvailable(descriptor, blockedNamespace, 'parameter', 'name'), false)
  assert.equal(templates.isSlotAvailable(descriptor, blockedNamespace, 'parameter', 'valueType'), false)
  assert.equal(templates.isSlotAvailable(descriptor, blockedNamespace, 'input', 'value'), false)
  assert.doesNotMatch(rendered(blocked), /初始值|类型为/)
  assert.equal(JSON.stringify(blockedNamespace), blockedBefore)
  assert.equal(blockedNamespace.inputs.value.value, 0)

  const restoredNamespace = {
    ...blockedNamespace,
    parameters: { ...blockedNamespace.parameters, namespace: 'content' },
  }
  const restored = templates.describeCall(descriptor, restoredNamespace)
  assert.equal(templates.isSlotAvailable(descriptor, restoredNamespace, 'parameter', 'name'), true)
  assert.equal(templates.isSlotAvailable(descriptor, restoredNamespace, 'parameter', 'valueType'), true)
  assert.equal(templates.isSlotAvailable(descriptor, restoredNamespace, 'input', 'value'), true)
  assert.match(rendered(restored), /初始值为【input:value】/)
  assert.match(rendered(restored), /类型为【parameter:valueType】/)
  assert.equal(restoredNamespace.inputs.value.value, 0)

  const falseType = { ...readyStatement, parameters: { ...readyStatement.parameters, valueType: false } }
  assert.equal(templates.isSlotAvailable(descriptor, falseType, 'input', 'value'), true)
  const clearedType = { ...readyStatement, parameters: { ...readyStatement.parameters, valueType: '' } }
  assert.equal(templates.isSlotAvailable(descriptor, clearedType, 'input', 'value'), false)
})

test('extension map slots follow name and schema dependencies without dangling text', () => {
  const descriptor = standardCatalog.find(item => item.id === 'extension.map-put')
  const statement = {
    module: descriptor.id,
    inputs: { player: {}, item: { kind: 'literal', value: false } },
    parameters: { name: '', schema: 'state', keyField: 'id' },
  }
  const before = JSON.stringify(statement)
  assert.deepEqual(templates.getTemplate(descriptor.id).dependencies.item, ['schema'])
  const empty = templates.describeCall(descriptor, statement)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'parameter', 'name'), true)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'parameter', 'schema'), false)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'parameter', 'keyField'), false)
  assert.equal(templates.isSlotAvailable(descriptor, statement, 'input', 'item'), false)
  assert.doesNotMatch(rendered(empty), /记录类型|键字段|记录为/)
  assert.equal(JSON.stringify(statement), before)
  const blockedName = { ...statement, parameters: { ...statement.parameters, namespace: '', name: '' } }
  assert.doesNotMatch(rendered(templates.describeCall(descriptor, blockedName)), /名称为$/)

  const readyStatement = {
    ...statement,
    parameters: { ...statement.parameters, name: 'records', schema: 'state' },
  }
  assert.equal(statement.parameters.schema, 'state')
  assert.equal(statement.parameters.keyField, 'id')
  assert.equal(statement.inputs.item.value, false)
  const ready = templates.describeCall(descriptor, readyStatement)
  assert.equal(templates.isSlotAvailable(descriptor, readyStatement, 'parameter', 'schema'), true)
  assert.equal(templates.isSlotAvailable(descriptor, readyStatement, 'parameter', 'keyField'), true)
  assert.equal(templates.isSlotAvailable(descriptor, readyStatement, 'input', 'item'), true)
  assert.match(rendered(ready), /记录类型为【parameter:schema】/)
  assert.match(rendered(ready), /键字段为【parameter:keyField】/)
  assert.match(rendered(ready), /记录为【input:item】/)
})

test('semantic templates preserve write targets and operand direction', () => {
  const descriptor = standardCatalog.find(item => item.id === 'extension.write-player')
  const writeText = rendered(templates.describeCall(descriptor, {
    module: descriptor.id,
    inputs: { owner: {}, value: {} },
    parameters: { name: 'state', path: '', valueType: 'number' },
  }))
  assert.match(writeText, /^将【input:value】写入【input:owner】的扩展变量【parameter:name】/)

  const battleDescriptor = standardCatalog.find(item => item.id === 'extension.write-battle')
  const battleText = rendered(templates.describeCall(battleDescriptor, {
    module: battleDescriptor.id,
    inputs: { value: {} },
    parameters: { name: 'state', path: '', valueType: 'number' },
  }))
  assert.match(battleText, /^将【input:value】写入全局扩展变量【parameter:name】/)

  const notDescriptor = standardCatalog.find(item => item.id === 'logic.not')
  assert.equal(rendered(templates.describeCall(notDescriptor, { module: notDescriptor.id, inputs: { value: {} }, parameters: {} })), '判断【input:value】是否不成立')

  for (const [id, sentence] of [
    ['math.subtract', '将【input:left】减去【input:right】'],
    ['math.divide', '将【input:left】除以【input:right】'],
    ['math.power', '计算【input:left】的【input:right】次幂'],
    ['compare.less-than', '判断【input:left】是否小于【input:right】'],
  ]) {
    const item = standardCatalog.find(candidate => candidate.id === id)
    assert.equal(rendered(templates.describeCall(item, { module: item.id, inputs: { left: {}, right: {} }, parameters: {} })), sentence)
  }
})

test('generic piece and player text fields expose the same Chinese field vocabulary', () => {
  const pieceDescriptor = {
    id: 'attribute.text', version: '2', label: '读取棋子文本字段',
    inputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    outputs: [{ name: 'text', type: 'string' }],
    parameters: [{ name: 'attribute', label: '字段', type: 'string', enum: ['name', 'faction'] }],
    ui: { category: 'data', authoring: 'standard' },
  }
  const playerDescriptor = {
    id: 'attribute.player-text', version: '1', label: '读取玩家文本字段',
    inputs: [{ name: 'player', label: '玩家', type: 'player' }],
    outputs: [{ name: 'text', type: 'string' }],
    parameters: [{ name: 'attribute', label: '字段', type: 'string', enum: ['name', 'faction'] }],
    ui: { category: 'data', authoring: 'standard' },
  }
  assert.equal(
    rendered(templates.describeCall(pieceDescriptor, { module: pieceDescriptor.id, inputs: { piece: {} }, parameters: { attribute: 'faction' } })),
    '读取【input:piece】的文本字段【parameter:attribute】',
  )
  assert.equal(
    rendered(templates.describeCall(playerDescriptor, { module: playerDescriptor.id, inputs: { player: {} }, parameters: { attribute: 'faction' } })),
    '读取【input:player】的文本字段【parameter:attribute】',
  )
})

test('ordinary equality templates use operators for generic field comparisons', () => {
  const descriptor = {
    id: 'compare.equal-string', version: '1', label: '文本相等',
    inputs: [{ name: 'left', label: '左值', type: 'string' }, { name: 'right', label: '右值', type: 'string' }],
    outputs: [{ name: 'value', type: 'boolean' }],
    ui: { category: 'calculation', authoring: 'standard' },
  }
  assert.equal(
    rendered(templates.describeCall(descriptor, { module: descriptor.id, inputs: { left: {}, right: {} }, parameters: {} })),
    '【input:left】 == 【input:right】',
  )
  const notEqualDescriptor = { ...descriptor, id: 'compare.not-equal-string', label: '文本不相等' }
  assert.equal(
    rendered(templates.describeCall(notEqualDescriptor, { module: notEqualDescriptor.id, inputs: { left: {}, right: {} }, parameters: {} })),
    '【input:left】 != 【input:right】',
  )
})

test('specialized relation descriptors remain readable compatibility projections', () => {
  const descriptor = {
    id: 'query.same-relation', version: '2', label: '判断棋子敌我关系',
    inputs: [{ name: 'source', type: 'piece' }, { name: 'target', type: 'piece' }],
    outputs: [{ name: 'value', type: 'boolean' }],
    parameters: [{ name: 'relation', type: 'string', enum: ['ally', 'enemy'] }],
    ui: { category: 'query', authoring: 'compatibility' },
  }
  const fragments = templates.describeCall(descriptor, {
    module: descriptor.id, version: descriptor.version,
    inputs: { source: {}, target: {} }, parameters: { relation: 'enemy' },
  })
  assert.doesNotMatch(rendered(fragments), /仅保留读取|兼容内容/)
  assert.match(rendered(fragments), /query\.same-relation|判断棋子敌我关系/)
  assert.deepEqual(slots(fragments, 'input').map(slot => slot.name), ['source', 'target'])
  assert.deepEqual(slots(fragments, 'parameter').map(slot => slot.name), ['relation'])
})

test('a template cannot emit a slot that is absent from its descriptor', () => {
  const descriptor = {
    id: 'author.effect.damage',
    version: '1',
    label: '造成伤害',
    inputs: [{ name: 'target', type: 'piece' }, { name: 'amount', type: 'number' }],
    parameters: [{ name: 'damageType', type: 'string' }],
  }
  const fragments = templates.describeCall(descriptor, {
    module: descriptor.id,
    inputs: { target: {}, amount: {}, source: {} },
    parameters: { damageType: 'normal', skillId: 'missing' },
  })
  assert.equal(slots(fragments, 'input').some(item => item.name === 'source'), false)
  assert.equal(slots(fragments, 'parameter').some(item => item.name === 'skillId'), false)
})

test('unknown legacy modules retain a readable compatibility hint', () => {
  const fragments = templates.describeCall(undefined, { module: 'legacy.fireball', inputs: {}, parameters: {} })
  assert.match(rendered(fragments), /暂不支持结构化句式/)
  assert.match(rendered(fragments), /legacy\.fireball/)
})

test('structural statements expose editable input and parameter slots', () => {
  const cases = [
    ['if', { kind: 'if', condition: {} }, ['input:condition']],
    ['foreach', { kind: 'foreach', items: {} }, ['input:items']],
    ['while', { kind: 'while', budget: 3 }, ['parameter:budget']],
    ['record.create', { kind: 'record.create', schema: 'state@1', fields: { hp: {} } }, ['parameter:schema', 'input:field:hp']],
    ['record.get', { kind: 'record.get', record: {}, field: 'hp' }, ['input:record', 'parameter:field']],
    ['record.with', { kind: 'record.with', record: {}, fields: { hp: {} } }, ['input:record', 'input:field:hp']],
    ['collection.map', { kind: 'collection.map', items: {} }, ['input:items']],
    ['collection.filter', { kind: 'collection.filter', items: {} }, ['input:items']],
    ['collection.reduce', { kind: 'collection.reduce', items: {}, initial: {} }, ['input:items', 'input:initial']],
    ['return', { kind: 'return', values: { result: {} } }, ['input:return:result']],
    ['defer-choice', { kind: 'defer-choice', graph: 'next@1', payload: {} }, ['parameter:graph', 'input:payload']],
  ]
  for (const [kind, statement, expected] of cases) {
    const fragments = templates.describeStatement(statement)
    const actual = fragments.filter(item => item && typeof item === 'object').map(item => `${item.kind}:${item.name}`)
    for (const slot of expected) assert.ok(actual.includes(slot), `${kind} missing ${slot}`)
  }
})

test('browser aliases are available for both editor entry points', () => {
  assert.equal(globalThis.SentenceTemplates, templates)
  assert.equal(globalThis.SentenceTemplateCatalog, templates)
  assert.equal(globalThis.SkillSentenceTemplates, templates)
  assert.equal(globalThis.GameplaySentenceTemplates, templates)
})
