import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const source = fs.readFileSync(fileURLToPath(new URL('../../electron-editor/ui/author-diagnostics.js', import.meta.url)), 'utf8')

function load() {
  const window = {}
  vm.runInNewContext(source, { window, console }, { filename: 'author-diagnostics.js' })
  return window.AuthorDiagnostics
}

const catalog = {
  descriptors: [{
    id: 'author.effect.damage',
    version: '2',
    label: '造成伤害',
    inputs: [
      { name: 'source', label: '来源', type: 'piece' },
      { name: 'target', label: '目标', type: 'piece' },
    ],
    outputs: [{ name: 'result', label: '结算结果', type: 'record' }],
    parameters: [{ name: 'damageType', label: '伤害类型', type: 'string' }],
  }],
}

test('missing input keeps compiler cause and localizes the graph statement position', () => {
  const api = load()
  const formatted = api.format({
    code: 'GAMEPLAY_MODULE_MISSING_PORT',
    message: 'missing input port "target" (graph.body[0].inputs)',
    path: 'graph.body[0].inputs',
  }, catalog)

  assert.match(formatted, /缺少输入“目标”/u)
  assert.match(formatted, /第1条语句的输入/u)
  assert.doesNotMatch(formatted, /missing input port|graph\.body/u)
})

test('the stable semantic fallback works when a raw compiler string has no catalog', () => {
  const api = load()
  const formatted = api.format('missing input port "source" (graph.body[0].inputs)')
  assert.match(formatted, /缺少输入“来源”/u)
  assert.match(formatted, /第1条语句的输入/u)
})

test('different module labels for a known input still have a Chinese diagnostic', () => {
  const api = load()
  const catalog = { descriptors: [
    { id: 'move', inputs: [{ name: 'destination', label: '目标地格' }] },
    { id: 'summon', inputs: [{ name: 'destination', label: '召唤位置' }] },
  ] }
  assert.match(api.format('missing input port "destination" (graph.body[0].inputs)', catalog), /缺少输入“落点”/u)
})

test('type mismatch translates builtin types and labels without losing the actionable values', () => {
  const api = load()
  const formatted = api.format({
    code: 'GAMEPLAY_MODULE_PORT_TYPE',
    message: 'input "source" expects number, got string (graph.body[1].inputs.source)',
    path: 'graph.body[1].inputs.source',
  }, catalog)

  assert.match(formatted, /输入“来源”需要数字，当前是文本/u)
  assert.match(formatted, /第2条语句的输入“来源”/u)
})

test('branch paths become statement and branch positions', () => {
  const api = load()
  const formatted = api.format({
    code: 'GAMEPLAY_MODULE_UNKNOWN_PORT',
    message: 'unknown input port "customInput" (graph.body[0].then[1].inputs.customInput)',
    path: 'graph.body[0].then[1].inputs.customInput',
  }, catalog)

  assert.match(formatted, /第1条语句的“如果”分支中的第2条语句的输入“customInput”/u)
  assert.match(formatted, /未知输入“customInput”/u)
})

test('document consistency, compiler version, schema, and field errors are actionable Chinese', () => {
  const api = load()
  assert.match(api.format(new Error('Gameplay module document: generated skillCode does not match its module graph')), /生成的“技能代码”与模块图不同步/u)
  assert.match(api.format(new Error('Gameplay module document: unsupported compiler version for customEntry')), /条目“customEntry”使用了不支持的编译器版本/u)
  assert.match(api.format({ code: 'GAMEPLAY_MODULE_UNKNOWN_SCHEMA', message: 'unknown record schema "customPayload"', path: 'graph.schemas[0]' }), /未知记录结构“customPayload”/u)
  assert.match(api.format({ code: 'GAMEPLAY_MODULE_UNKNOWN_FIELD', message: 'unknown field "customField"', path: 'graph.body[0].fields.customField' }), /未知字段“customField”/u)
})

test('user-defined names remain intact while unknown diagnostics stay Chinese and retain raw copy data', () => {
  const api = load()
  const userName = api.format({
    code: 'GAMEPLAY_MODULE_UNKNOWN_INPUT',
    message: 'unknown input "myDamageVariable"',
    path: 'graph.body[0].inputs.myDamageVariable',
  }, catalog)
  assert.match(userName, /myDamageVariable/u)

  const unknown = 'a future compiler diagnostic: custom variable needs attention'
  const detail = api.formatDetailed({
    code: 'GAMEPLAY_MODULE_FUTURE',
    message: unknown,
    path: 'graph.body[0].inputs.customVariable',
  }, catalog)
  assert.match(detail.text, /模块诊断：未识别错误/u)
  assert.match(detail.text, /诊断编号：GAMEPLAY_MODULE_FUTURE/u)
  assert.match(detail.text, /第1条语句的输入“customVariable”/u)
  assert.doesNotMatch(detail.text, /future compiler diagnostic|needs attention/u)
  assert.match(detail.copyText, /future compiler diagnostic: custom variable needs attention/u)
  assert.equal(detail.code, 'GAMEPLAY_MODULE_FUTURE')
  assert.ok(api.coverage.remainingGaps.length > 0)
  assert.ok(api.coverage.supportedCodes.includes('GAMEPLAY_MODULE_PORT_TYPE'))
})

test('actual compiler and document errors are localized without exposing builtin English', () => {
  const api = load()
  const cases = [
    {
      error: { code: 'GAMEPLAY_MODULE_DUPLICATE_PORT', message: 'duplicate port "source"', path: 'graph.inputs' },
      forbidden: /duplicate port/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_PARAMETER_VALUE', message: 'parameter "damageType" is outside its enum', path: 'graph.body[0].parameters.damageType' },
      forbidden: /outside its enum/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_ROOT_INPUT', message: 'root inputs require static inputBindings', path: 'graph.inputs[0]' },
      forbidden: /root inputs require static inputBindings/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_COLLECTION_EFFECT', message: 'collection body cannot call effectful module "author.effect.damage"', path: 'graph.body[0].body[0].module' },
      forbidden: /collection body cannot call effectful module/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_UNTYPED_RECORD', message: 'record.get requires a typed record', path: 'graph.body[0].record' },
      forbidden: /record\.get requires a typed record/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_BUDGET_EXCEEDED', message: 'statement budget exceeded', path: 'graph.body' },
      forbidden: /statement budget exceeded/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_UNKNOWN_CONTINUATION', message: 'unknown continuation graph "resume@1"', path: 'graph.body[0].graph' },
      forbidden: /unknown continuation graph/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_INVALID_STATEMENT', message: 'collection discriminator conflicts with method fields', path: 'graph.body[0]' },
      forbidden: /collection discriminator conflicts with method fields/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_LOWERING_FAILED', message: 'native lowering failed: module test.module: parameter amount must be number', path: 'graph.body[0]' },
      forbidden: /native lowering failed|parameter amount must be number/u,
    },
    {
      error: new Error('Gameplay module document: invalid summonCapability: source-mirror status.relatedRules must exactly match capability rules'),
      forbidden: /source-mirror|must exactly match capability rules/u,
    },
    {
      error: new Error('Gameplay module document: invalid summonCapability: stored-or-declared-piece uniqueTemplateId must match fallback.templateId'),
      forbidden: /uniqueTemplateId must match fallback\.templateId/u,
    },
    {
      error: new Error('Gameplay module document: invalid entry customEntry'),
      forbidden: /invalid entry/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_REGISTRY_INVALID', message: 'registry descriptor lower must be a function', path: 'registry.author.effect.damage.lower' },
      forbidden: /registry descriptor lower must be a function/u,
    },
    {
      error: { code: 'GAMEPLAY_MODULE_INVALID_OPTION', message: 'compiler option must be a positive integer', path: 'options.maxExpandedCalls' },
      forbidden: /compiler option must be a positive integer/u,
    },
  ]

  for (const entry of cases) {
    const detail = api.formatDetailed(entry.error, catalog)
    assert.match(detail.text, /[\u3400-\u9fff]/u, detail.text)
    assert.doesNotMatch(detail.text, entry.forbidden, detail.text)
    const raw = entry.error instanceof Error ? entry.error.message : entry.error.message
    assert.match(detail.copyText, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  }
})

test('author expression messages keep their Chinese cause and user-defined module name', () => {
  const api = load()
  const detail = api.formatDetailed({
    name: 'AuthorExpressionError',
    message: '未注册作者模块 “custom.module”',
    path: 'expression',
  }, catalog)

  assert.equal(detail.localized, true)
  assert.match(detail.text, /未注册作者模块/u)
  assert.match(detail.text, /custom\.module/u)
  assert.doesNotMatch(detail.text, /AUTHOR_EXPRESSION/u)
})
