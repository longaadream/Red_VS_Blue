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
    'window.SkillSentenceEditor = { mount, __test: { addModule, changeStatementRow, createPureExpression, descriptorForStatement, descriptorOutputType, expressionValueLabel, moduleDescriptorsFor, isCompatibilityDescriptor, isProjectedPureCall } }',
  )
  const window = {}
  const document = { createElement: () => ({}) }
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout })
  vm.runInContext(instrumented, context, { filename })
  return window.SkillSentenceEditor.__test
}

const internals = loadEditorInternals()

test('deleting an expression consumer removes its dependencies but protects external users', () => {
  const dependency = call('expression', 'ref.holder')
  dependency.layout = { authorExpression: { owner: 'consumer', input: 'piece' } }
  const consumer = call('consumer', 'attribute.text', '2', { piece: output('expression', 'piece') }, { attribute: 'name' })
  consumer.layout = { authorExpressions: { piece: { source: '当前棋子', nodes: ['expression'], value: output('expression', 'piece') } } }
  let draft = draftFor(emptyGraph([dependency, consumer]))
  const options = { core: createCore(), field: 'code', getDraft: () => draft, onChange: next => { draft = next } }
  internals.changeStatementRow(options, 'consumer', 'delete')
  assert.equal(draft.gameplayModules.entries.code.graph.body.length, 0)
  draft = draftFor(emptyGraph([dependency, consumer, call('external', 'attribute.text', '2', { piece: output('expression', 'piece') }, { attribute: 'name' })]))
  assert.throws(() => internals.changeStatementRow(options, 'consumer', 'delete'), /仍被后续引用/)
  assert.equal(draft.gameplayModules.entries.code.graph.body.length, 3)
})

test('field selection changes the offered output type and generic comparisons render the selected operator', () => {
  const descriptor = {
    id: 'piece.field', version: '1', inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'record' }],
    parameters: [{ name: 'field', type: 'string' }],
    outputParameterTypeBindings: { value: { parameter: 'field', types: { attack: 'number', faction: 'string', ownerPlayerId: 'player' } } },
  }
  for (const [field, type] of [['attack', 'number'], ['faction', 'string'], ['ownerPlayerId', 'player']]) {
    assert.equal(internals.descriptorOutputType(descriptor, 'value', { parameters: { field } }), type)
  }
  const consumer = call('multiply', 'math.multiply', '1', { left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 2 } })
  let draft = draftFor(emptyGraph([call('holder', 'ref.holder'), consumer]))
  const authorCore = { ...createCore(), getGameplayModuleCatalog: () => [...descriptors, { ...descriptor, effects: { pure: true }, ui: { authoring: 'standard' } }] }
  const options = { core: authorCore, field: 'code', getDraft: () => draft, onChange: next => { draft = next } }
  const expression = internals.createPureExpression(options, 'multiply', 'left', 'number', 'piece.field', '1')
  assert.equal(expression.statement.parameters.field, 'attack', 'a numeric expression must select a numeric field without a record placeholder')
  assert.equal(expression.statement.inputs.piece.node, 'holder')
  const holder = call('holder', 'ref.holder'), target = call('target', 'ref.target')
  const a = call('a', 'piece.field', '1', { piece: output('holder', 'piece') }, { field: 'faction' })
  const b = call('b', 'piece.field', '1', { piece: output('target', 'piece') }, { field: 'faction' })
  const comparison = call('comparison', 'compare.values', '1', { left: output('a', 'value'), right: output('b', 'value') }, { valueType: 'string', operator: '!=' })
  const nested = call('nested', 'compare.values', '1', { left: output('comparison', 'value'), right: { kind: 'literal', value: false } }, { valueType: 'boolean', operator: '==' })
  const graph = emptyGraph([holder, target, a, b, comparison, nested])
  const core = createCore()
  assert.equal(internals.expressionValueLabel(core, graph, output('nested', 'value')), '（当前棋子.阵营 != 当前目标.阵营） == 否')
})

const piecePort = name => ({ name, label: name === 'source' ? '来源' : '目标', type: 'piece' })
const playerPort = name => ({ name, label: '事件玩家', type: 'player' })
const textFieldDescriptor = (version, authoring) => ({
  id: 'attribute.text',
  version,
  label: '读取棋子文本字段',
  inputs: [piecePort('piece')],
  outputs: [{ name: 'text', label: '文本', type: 'string' }],
  parameters: [{ name: 'attribute', label: '字段', type: 'string', enum: version === '1' ? ['name'] : ['name', 'faction'] }],
  allowedSurfaces: ['skill'],
  effects: { pure: true, reads: ['pieces'] },
  ...(version === '2' ? { livingReferences: ['piece'] } : {}),
  ui: { category: 'data', authoring },
})
const playerTextDescriptor = {
  id: 'attribute.player-text',
  version: '1',
  label: '读取玩家文本字段',
  inputs: [playerPort('player')],
  outputs: [{ name: 'text', label: '文本', type: 'string' }],
  parameters: [{ name: 'attribute', label: '字段', type: 'string', enum: ['name', 'faction'] }],
  allowedSurfaces: ['skill'],
  effects: { pure: true, reads: ['players'] },
  ui: { category: 'data', authoring: 'standard' },
}
const comparisonDescriptor = (id, leftType = 'string', authoring = 'standard') => ({
  id,
  version: '1',
  label: id === 'compare.equal-boolean' ? '布尔值相等' : id === 'compare.not-equal-string' ? '文本不相等' : '文本相等',
  inputs: [{ name: 'left', label: '左值', type: leftType }, { name: 'right', label: '右值', type: leftType }],
  outputs: [{ name: 'value', label: '是否成立', type: 'boolean' }],
  allowedSurfaces: ['skill'],
  effects: { pure: true },
  ui: { category: 'calculation', authoring },
})
const compatibilityRelationDescriptor = version => ({
  id: 'query.same-relation',
  version,
  label: '判断棋子敌我关系',
  inputs: [piecePort('source'), piecePort('target')],
  outputs: [{ name: 'value', label: '是否符合', type: 'boolean' }],
  parameters: [{ name: 'relation', label: '关系', type: 'string', enum: ['ally', 'enemy'], default: 'enemy' }],
  allowedSurfaces: ['skill'],
  effects: { pure: true, reads: ['pieces', 'players'] },
  ...(version === '2' ? { livingReferences: ['source', 'target'] } : {}),
  ui: { category: 'query', authoring: 'compatibility' },
})

const descriptors = [
  { id: 'ref.source', version: '1', label: '来源棋子', inputs: [], outputs: [{ name: 'piece', type: 'piece' }], effects: { pure: true } },
  { id: 'ref.target', version: '1', label: '目标棋子', inputs: [], outputs: [{ name: 'piece', type: 'piece' }], effects: { pure: true } },
  { id: 'ref.holder', version: '1', label: '当前棋子', inputs: [], outputs: [{ name: 'piece', type: 'piece' }], effects: { pure: true } },
  { id: 'ref.event-player', version: '1', label: '事件玩家', inputs: [], outputs: [{ name: 'player', type: 'player' }], effects: { pure: true } },
  textFieldDescriptor('1', 'compatibility'),
  textFieldDescriptor('2', 'standard'),
  playerTextDescriptor,
  comparisonDescriptor('compare.equal-string'),
  comparisonDescriptor('compare.not-equal-string'),
  comparisonDescriptor('compare.equal-boolean', 'boolean'),
  compatibilityRelationDescriptor('1'),
  compatibilityRelationDescriptor('2'),
  comparisonDescriptor('compare.allied-players', 'player', 'compatibility'),
]

function emptyGraph(body = []) {
  return {
    version: 'rvb-gameplay-modules/v1',
    surface: 'skill',
    body,
    inputs: [],
    outputs: [],
    composites: [],
    continuations: [],
  }
}

function call(id, module, version = '1', inputs = {}, parameters = {}) {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function output(node, port) {
  return { kind: 'output', node, port }
}

function draftFor(graph) {
  return {
    id: 'module-version-fixture',
    gameplayModules: { version: 'rvb-gameplay-module-document/v1', entries: { code: { graph } } },
  }
}

function createCore() {
  return {
    getGameplayModuleGraph: (draft, field) => draft.gameplayModules?.entries?.[field]?.graph || null,
    getGameplayModuleCatalog: () => descriptors,
    applyGameplayModuleGraph: (draft, graph, field) => ({
      ...draft,
      gameplayModules: {
        ...(draft.gameplayModules || {}),
        entries: {
          ...(draft.gameplayModules?.entries || {}),
          [field]: { ...(draft.gameplayModules?.entries?.[field] || {}), graph },
        },
      },
    }),
  }
}

test('module insertion and nested expressions preserve generic field/comparison versions while legacy fields resolve exactly', () => {
  const core = createCore()
  let draft = draftFor(emptyGraph())
  const options = {
    core,
    field: 'code',
    getDraft: () => draft,
    onChange: next => { draft = next },
  }

  const insertedId = internals.addModule(options, 'attribute.text', '2')
  const inserted = draft.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId)
  assert.equal(inserted?.module, 'attribute.text')
  assert.equal(inserted?.version, '2', 'the picker-selected v2 descriptor must be written to the new call')
  assert.deepEqual(internals.descriptorForStatement(core, inserted), textFieldDescriptor('2', 'standard'))

  const source = call('source', 'ref.source')
  const target = call('target', 'ref.target')
  const sourceText = call('source-text', 'attribute.text', '2', { piece: output(source.id, 'piece') }, { attribute: 'faction' })
  const targetText = call('target-text', 'attribute.text', '2', { piece: output(target.id, 'piece') }, { attribute: 'faction' })
  const condition = { kind: 'if', id: 'condition', condition: { kind: 'literal', value: false }, then: [], else: [] }
  draft = draftFor(emptyGraph([source, target, sourceText, targetText, condition]))
  const expression = internals.createPureExpression(
    options,
    condition.id,
    'condition',
    'boolean',
    'compare.equal-string',
    '1',
  )
  assert.equal(expression.statement.module, 'compare.equal-string')
  assert.equal(expression.statement.version, '1', 'nested expression insertion must keep the selected descriptor version')
  assert.equal(draft.gameplayModules.entries.code.graph.body[4].version, '1')

  const legacy = call('legacy-text', 'attribute.text', '1', {
    piece: output(source.id, 'piece'),
  }, { attribute: 'name' })
  const legacyDescriptor = internals.descriptorForStatement(core, legacy)
  assert.equal(legacyDescriptor?.version, '1', 'reopened legacy field nodes must continue resolving their stored version')
  assert.deepEqual(legacyDescriptor?.parameters?.[0]?.enum, ['name'])
  assert.equal(legacyDescriptor?.livingReferences, undefined)
})

test('the author picker excludes compatibility relation predicates but keeps generic text fields', () => {
  const core = createCore()
  const graph = emptyGraph()
  const visible = internals.moduleDescriptorsFor(core, graph).filter(item => !internals.isCompatibilityDescriptor(item))
  assert.ok(visible.some(item => item.id === 'attribute.text' && item.version === '2'))
  assert.equal(visible.some(item => item.id === 'attribute.text' && item.version === '1'), false)
  assert.equal(visible.some(item => item.id === 'query.same-relation' && ['1', '2'].includes(item.version)), false)
  assert.equal(visible.some(item => item.id === 'compare.allied-players'), false)
})

test('field expressions and ordinary equality comparisons render with context labels and preserve parentheses', () => {
  const core = createCore()
  const holder = call('holder', 'ref.holder')
  const target = call('target', 'ref.target')
  const eventPlayer = call('event-player', 'ref.event-player')
  const holderFaction = call('holder-faction', 'attribute.text', '2', { piece: output(holder.id, 'piece') }, { attribute: 'faction' })
  const targetFaction = call('target-faction', 'attribute.text', '2', { piece: output(target.id, 'piece') }, { attribute: 'faction' })
  const eventFaction = call('event-faction', 'attribute.player-text', '1', { player: output(eventPlayer.id, 'player') }, { attribute: 'faction' })
  const sameFaction = call('same-faction', 'compare.equal-string', '1', {
    left: output(holderFaction.id, 'text'), right: output(targetFaction.id, 'text'),
  })
  const differentFaction = call('different-faction', 'compare.not-equal-string', '1', {
    left: output(eventFaction.id, 'text'), right: output(targetFaction.id, 'text'),
  })
  const nested = call('nested', 'compare.equal-boolean', '1', {
    left: output(sameFaction.id, 'value'), right: { kind: 'literal', value: false },
  })
  const graph = emptyGraph([holder, target, eventPlayer, holderFaction, targetFaction, eventFaction, sameFaction, differentFaction, nested])

  assert.equal(internals.expressionValueLabel(core, graph, output(sameFaction.id, 'value')), '当前棋子.阵营 == 当前目标.阵营')
  assert.equal(internals.expressionValueLabel(core, graph, output(differentFaction.id, 'value')), '事件玩家.阵营 != 当前目标.阵营')
  assert.equal(internals.expressionValueLabel(core, graph, output(nested.id, 'value')), '（当前棋子.阵营 == 当前目标.阵营） == 否')
})

test('legacy consumed pure calls are projected while named outputs stay visible', () => {
  const core = createCore()
  const holder = call('holder', 'ref.holder')
  const field = call('field', 'attribute.text', '2', { piece: output(holder.id, 'piece') }, { attribute: 'faction' })
  const graph = emptyGraph([holder, field])
  assert.equal(internals.isProjectedPureCall(core, graph, holder), true)
  holder.layout = { resultNames: { piece: '主体' } }
  assert.equal(internals.isProjectedPureCall(core, graph, holder), false)
  assert.equal(internals.isProjectedPureCall(core, graph, field), false)
})

test('pure extension reads are projected but extension writes remain author-visible', () => {
  const extensionRead = {
    id: 'extension.read-player', version: '1', label: '读取玩家扩展变量',
    inputs: [{ name: 'owner', type: 'player' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'name', type: 'string' }],
    effects: { pure: true, reads: ['extensions'] },
  }
  const extensionWrite = {
    id: 'extension.write-player', version: '1', label: '写入玩家扩展变量',
    inputs: [{ name: 'owner', type: 'player' }, { name: 'value', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'name', type: 'string' }],
    effects: { pure: false, reads: ['extensions'], writes: ['extensions'] },
  }
  const core = { ...createCore(), getGameplayModuleCatalog: () => [...descriptors, extensionRead, extensionWrite] }
  const owner = call('owner', 'ref.event-player', '1')
  const read = call('read', 'extension.read-player', '1', { owner: output(owner.id, 'player') }, { name: 'priorPlayer' })
  const write = call('write', 'extension.write-player', '1', { owner: output(owner.id, 'player'), value: output(read.id, 'value') }, { name: 'priorPlayer' })
  const graph = emptyGraph([owner, read, write])
  assert.equal(internals.isProjectedPureCall(core, graph, read), true)
  assert.equal(internals.isProjectedPureCall(core, graph, write), false)
  assert.match(internals.expressionValueLabel(core, graph, output(read.id, 'value')), /读取玩家扩展变量.*priorPlayer/)
})
