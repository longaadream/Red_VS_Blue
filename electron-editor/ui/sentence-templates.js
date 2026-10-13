/*
 * Chinese sentence projections for the author-facing gameplay module catalog.
 *
 * This file is deliberately data-only.  It does not import the TypeScript
 * registry and it never changes a descriptor or a graph statement.  The
 * editor can therefore load it as a small browser script while node tests can
 * require the same implementation.
 */
(function installSentenceTemplates(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root && typeof root === 'object') {
    root.SentenceTemplates = api
    root.SentenceTemplateCatalog = api
    // These aliases are kept for the two editor entry points that shipped
    // while the catalogue was being split out of sentence-editor.js.
    root.SkillSentenceTemplates = api
    root.GameplaySentenceTemplates = api
  }
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, function createSentenceTemplates() {
  'use strict'

  const own = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key))
  const array = value => Array.isArray(value) ? value : []
  const object = value => value && typeof value === 'object' ? value : {}
  const descriptorId = (descriptor, statement) => String(descriptor?.id || statement?.module || '')
  const definitionFor = (descriptor, kind, name) => {
    const list = kind === 'input' ? array(descriptor?.inputs) : kind === 'parameter' ? array(descriptor?.parameters) : []
    return list.find(item => item && item.name === name) || null
  }

  // `0` and `false` are authored values.  Only an omitted/undefined/null or
  // empty text value is considered unavailable when satisfying a dependency.
  const hasMeaningfulValue = value => value !== undefined && value !== null && value !== ''
  const configured = (statement, kind, name) => {
    const bucket = kind === 'input' ? statement?.inputs : statement?.parameters
    return own(bucket, name) && hasMeaningfulValue(bucket[name])
  }
  const keyOf = (kind, name) => `${kind}:${name}`

  const arithmeticWords = Object.freeze({
    'math.add': '相加',
    'math.subtract': '相减',
    'math.multiply': '相乘',
    'math.divide': '相除',
    'math.modulo': '取余',
    'math.power': '计算幂',
    'math.min': '取较小值',
    'math.max': '取较大值',
  })
  const comparisonWords = Object.freeze({
    'compare.equal': '是否相等',
    'compare.not-equal': '是否不相等',
    'compare.equal-string': '文本是否相等',
    'compare.not-equal-string': '文本是否不相等',
    'compare.equal-string-nullable': '可空文本是否相等',
    'compare.equal-boolean': '布尔值是否相等',
    'compare.not-equal-boolean': '布尔值是否不相等',
    'compare.equal-piece': '棋子是否相同',
    'compare.not-equal-piece': '棋子是否不同',
    'compare.equal-piece-nullable': '可空棋子是否相同',
    'compare.equal-player': '玩家是否相同',
    'compare.not-equal-player': '玩家是否不同',
    'compare.player-reference': '可空玩家是否相同',
    'compare.text': '文本是否相等',
    'compare.less-than': '是否小于',
    'compare.less-or-equal': '是否小于或等于',
    'compare.greater-than': '是否大于',
    'compare.greater-or-equal': '是否大于或等于',
  })
  const comparisonOperators = Object.freeze({
    'compare.equal': '==',
    'compare.not-equal': '!=',
    'compare.equal-string': '==',
    'compare.not-equal-string': '!=',
    'compare.equal-string-nullable': '==',
    'compare.equal-boolean': '==',
    'compare.not-equal-boolean': '!=',
    'compare.equal-piece': '==',
    'compare.not-equal-piece': '!=',
    'compare.equal-piece-nullable': '==',
    'compare.equal-player': '==',
    'compare.not-equal-player': '!=',
    'compare.player-reference': '==',
    'compare.text': '==',
  })
  const logicWords = Object.freeze({
    'logic.and': '同时满足',
    'logic.or': '至少满足一个',
    'logic.not': '不满足',
  })

  // Metadata is intentionally separate from descriptors.  It gives the UI a
  // stable ordering and tells both the renderer and editor which choice makes
  // a later slot meaningful; isSlotAvailable is the shared dependency check.
  const metadata = Object.create(null)
  const specs = Object.create(null)
  function define(ids, build, info = {}) {
    for (const id of array(ids).length ? ids : [ids]) {
      specs[id] = build
      metadata[id] = {
        slotOrder: array(info.slotOrder).slice(),
        dependencies: { ...(info.dependencies || {}) },
        // These parameters are retained in the serialized graph for compiler
        // validation but are derived from a typed input by the authoring UI.
        // Keeping the list in the sentence metadata makes the omission an
        // explicit authoring contract instead of an unexplained slot count.
        derivedParameters: array(info.derivedParameters).slice(),
        category: info.category || '',
      }
    }
  }

  const extensionDependencies = Object.freeze({
    namespace: [],
    name: ['namespace'],
    path: ['name'],
    // An empty path means the declared variable itself.  The value type is
    // already determined by the variable name and must not wait for a path.
    valueType: ['name'],
    value: ['name', 'valueType'],
  })
  const extensionMapDependencies = Object.freeze({
    namespace: [],
    name: ['namespace'],
    schema: ['name'],
    keyField: ['schema'],
    item: ['schema'],
  })

  function dependencyNames(descriptor, statement, name) {
    const info = metadata[descriptorId(descriptor, statement)]
    const dependencies = info?.dependencies?.[name]
    if (Array.isArray(dependencies)) return dependencies
    return dependencies ? [dependencies] : []
  }

  const dependencyReference = dependency => typeof dependency === 'string'
    ? { kind: '', name: dependency }
    : dependency && typeof dependency === 'object'
      ? { kind: dependency.kind || dependency.type || '', name: dependency.name || dependency.parameter || dependency.field || '' }
      : { kind: '', name: '' }

  function dependencyKind(descriptor, reference, requestedKind = '') {
    if (requestedKind === 'input' || requestedKind === 'parameter') return requestedKind
    return definitionFor(descriptor, 'input', reference) ? 'input' : 'parameter'
  }

  // A dependency must have an effective value, and that value's own
  // dependencies must also be effective.  This is separate from the public
  // slot check because a required empty slot remains editable, while it must
  // not make later slots meaningful.  `stack` is the current dependency path;
  // a cycle is unavailable rather than an invitation to recurse forever.
  function dependencyValueAvailable(descriptor, statement, kind, name, stack) {
    const key = keyOf(kind, name)
    if (stack.has(key)) return false
    const definition = definitionFor(descriptor, kind, name)
    if (!definition) return false
    const bucket = kind === 'input' ? statement?.inputs : statement?.parameters
    if (own(bucket, name)) {
      if (!hasMeaningfulValue(bucket[name])) return false
    } else if (!own(definition, 'default') || !hasMeaningfulValue(definition.default)) {
      return false
    }
    const nextStack = new Set(stack)
    nextStack.add(key)
    return dependencyNames(descriptor, statement, name).every(dependency => {
      const reference = dependencyReference(dependency)
      if (!reference.name) return false
      const dependencyKindName = dependencyKind(descriptor, reference.name, reference.kind)
      return dependencyValueAvailable(descriptor, statement, dependencyKindName, reference.name, nextStack)
    })
  }

  function valueForDependency(descriptor, statement, dependency, stack) {
    const reference = dependencyReference(dependency)
    if (!reference.name) return false
    const kind = dependencyKind(descriptor, reference.name, reference.kind)
    return dependencyValueAvailable(descriptor, statement, kind, reference.name, stack)
  }

  // A successful action does not require a human-facing message, but authors
  // may add one when it helps explain the result.  Old graphs may already
  // contain one, so this is an authoring visibility rule rather than a graph
  // migration or a lowering change.
  const resultMessageModules = new Set(['result.action', 'result.action-ui', 'result.message', 'result.structured'])
  const isLiteralTrue = value => value === true || Boolean(value && typeof value === 'object' && value.kind === 'literal' && value.value === true)
  function hasAuthoredResultMessage(statement) {
    const value = statement?.inputs?.message
    if (!own(statement?.inputs, 'message') || value === undefined || value === null || value === '') return false
    if (value && typeof value === 'object' && value.kind === 'literal') return hasMeaningfulValue(value.value)
    return true
  }
  function isRedundantResultMessage(descriptor, statement, kind, name) {
    if (kind !== 'input' || name !== 'message' || !resultMessageModules.has(descriptorId(descriptor, statement))) return false
    const id = descriptorId(descriptor, statement)
    const inputs = statement?.inputs
    const parameters = statement?.parameters
    // result.message keeps success as a parameter for compatibility; the
    // newer result modules carry it as an input. A dynamic success value is
    // kept editable because it may evaluate to failure at runtime. Existing
    // non-empty success text stays visible and editable.
    const defaultSuccess = id === 'result.message' && !own(parameters, 'success')
      ? definitionFor(descriptor, 'parameter', 'success')?.default
      : undefined
    return (isLiteralTrue(inputs?.success) || isLiteralTrue(parameters?.success) || isLiteralTrue(defaultSuccess))
      && !hasAuthoredResultMessage(statement)
  }

  /**
   * Return whether an input/parameter is meaningful in the current draft.
   * This is intentionally read-only: an unavailable dependent slot is hidden
   * while any authored value remains in the statement for the UI to diagnose.
   * `allowUnsetOptional` is internal and is used when building the optional
   * supplement list; normal callers should use the four-argument form.
   */
  function isSlotAvailable(descriptor, statement = {}, kind, name, options = {}) {
    const id = descriptorId(descriptor, statement)
    const summonDeclaration = id === 'author.effect.summon'
      && String(statement.version || descriptor?.version) === '2'
      && statement.parameters?.mode === 'declaration'
    if (summonDeclaration && kind === 'input' && (name === 'template' || name === 'display')) return false
    // v2 keeps one serialized call shape for the unified assignment sentence,
    // but only the selected target is meaningful. The hidden input remains
    // intact for diagnostics/round-trips; it is never rendered as a second
    // empty target. v1 intentionally keeps its original piece input rules.
    if (id === 'piece.write-field' && String(statement.version || descriptor?.version) === '2'
      && kind === 'input' && (name === 'piece' || name === 'id')) {
      const scopeDefinition = definitionFor(descriptor, 'parameter', 'scope')
      const scope = own(statement.parameters, 'scope') ? statement.parameters.scope : scopeDefinition?.default
      if (scope === 'stored') return name === 'id'
      if (scope === 'live') return name === 'piece'
      // An invalid scope should remain diagnosable/editable instead of making
      // both target controls disappear from the sentence editor.
      return true
    }
    if (isRedundantResultMessage(descriptor, statement, kind, name) && !options.allowUnsetOptional) return false
    if (kind === 'parameter') {
      if (/^author\.effect\.(damage|heal)$/.test(id) && String(statement.version || descriptor?.version) === '2' && (['sourceType', 'targetType', 'amountType', 'resultType', 'legacyNormalSpelling'].includes(name) || id === 'author.effect.heal' && name === 'damageType')) return false
      if (['author.effect.summon', 'author.piece.display'].includes(id) && ['sourceType', 'templateType', 'destinationType', 'displayType'].includes(name)) return false
      if (id === 'author.card.gain' && name === 'extensionType' || id === 'local.write' && name === 'valueType') return false
      if (id === 'author.cluster.acquire' && name === 'definitionType') return false
      if (id === 'code-block.invoke' && ['blockType', 'argsType'].includes(name)) return false
      if (isDerivedParameter(descriptor, statement, name)) return false
      if ((/^set\.(create|contains|add|delete|items|count)$/.test(id) || /^map\.(create|get|set|delete|count)$/.test(id) || /^map\.(has-key|keys|values)$/.test(id) && String(statement.version || descriptor?.version) === '2') && ['containerType', 'keyType', 'valueType', 'keysType', 'valuesType', 'itemsType'].includes(name)) return false
    }
    const definition = definitionFor(descriptor, kind, name)
    if (!definition) return false
    const needsSummonTemplate = id === 'author.effect.summon' && kind === 'input' && name === 'template' && !summonDeclaration
    if (definition.optional && !needsSummonTemplate && !options.allowUnsetOptional && !configured(statement, kind, name)) return false
    const stack = new Set([keyOf(kind, name)])
    return dependencyNames(descriptor, statement, name).every(dependency => valueForDependency(descriptor, statement, dependency, stack))
  }

  function isDerivedParameter(descriptor, statement = {}, name) {
    const id = descriptorId(descriptor, statement)
    return own(descriptor?.ui?.parameterTypeBindings, name) || Boolean(metadata[id]?.derivedParameters?.includes(name))
  }

  function derivedParameterValues(descriptor, statement = {}) {
    const result = {}
    for (const [name, binding] of Object.entries(descriptor?.ui?.parameterTypeBindings || {})) {
      const selected = statement.parameters?.[binding.parameter]
      if (!own(binding.types, selected)) continue
      const type = binding.types[selected]
      result[name] = typeof type === 'string' ? type : JSON.stringify(type)
    }
    return result
  }

  function extensionParts(ctx, action) {
    const declaration = action === 'declare'
    const reading = action === 'read'
    const name = ctx.parameter('name')
    if (declaration) ctx.parts('在', ctx.input('owner'), '上声明扩展变量', name)
    else if (reading) ctx.parts('读取', ctx.input('owner'), '的扩展变量', name)
    else if (ctx.isVisible('input', 'value')) ctx.parts('将', ctx.input('value'), '写入', ctx.input('owner'), '的扩展变量', name)
    else ctx.parts('写入', ctx.input('owner'), '的扩展变量', name)
    if (ctx.isVisible('parameter', 'namespace')) ctx.parts('，分组为', ctx.parameter('namespace'))
    if (ctx.isVisible('parameter', 'path')) ctx.parts('，字段路径为', ctx.parameter('path'))
    if (declaration && ctx.isVisible('input', 'value')) ctx.parts('，初始值为', ctx.input('value'))
    if (ctx.isVisible('parameter', 'valueType')) ctx.parts('，类型为', ctx.parameter('valueType'))
  }

  define('author.effect.damage', ctx => {
    // The default current-context policy stays folded into the ordinary
    // sentence. An explicit unattributed choice remains visible and editable
    // in Chinese while its stable graph ID stays `unattributed`.
    const hasExplicitAttribution = Boolean(ctx.statement?.parameters && Object.prototype.hasOwnProperty.call(ctx.statement.parameters, 'attribution'))
    const showAttribution = ctx.isVisible('parameter', 'attribution') && hasExplicitAttribution && ctx.statement.parameters.attribution !== 'current'
    const attributionSlot = ctx.isVisible('parameter', 'attribution') ? ctx.slot('parameter', 'attribution') : null
    return ctx.parts(
      '对', ctx.input('target'), '造成', ctx.input('amount'), '点', ctx.parameter('damageType'), '伤害，来源为', ctx.input('source'),
      ...(showAttribution && attributionSlot ? ['，归属方式为', attributionSlot] : []),
      ...(ctx.isVisible('parameter', 'skillId') ? ['，技能为', ctx.parameter('skillId')] : []),
      ...(ctx.isVisible('input', 'killerPlayer') ? ['，击杀归属于', ctx.input('killerPlayer')] : []),
    )
  }, { slotOrder: ['target', 'amount', 'damageType', 'source', 'attribution', 'skillId', 'killerPlayer'], category: 'combat' })

  define('rule.remove-id-raw', ctx => {
    const captured = String(ctx.statement?.version) === '2' && ctx.statement?.parameters?.targetType === 'record'
    return ctx.parts(captured ? '从本次执行来源' : '从棋子记录', ctx.input('target'), '中移除规则', ctx.parameter('ruleId'))
  }, { slotOrder: ['target', 'ruleId'], derivedParameters: ['targetType'], category: 'status-rule' })

  define('piece.write-field', ctx => {
    if (String(ctx.statement.version) !== '2') return ctx.parts('将', ctx.input('piece'), '的', ctx.parameter('field'), '设为', ctx.input('value'))
    const stored = ctx.statement.parameters?.scope === 'stored'
    // Consume the selector in sentence metadata while presenting a Chinese
    // target label. The selector remains editable in the inspector and the
    // stable scope IDs stay in the graph.
    ctx.slot('parameter', 'scope')
    return ctx.parts(
      stored ? '将已保存棋子记录' : '将当前棋子',
      stored ? ctx.input('id') : ctx.input('piece'),
      '的', ctx.parameter('field'), '设为', ctx.input('value'),
    )
  }, { slotOrder: ['scope', 'piece', 'id', 'field', 'value'], category: 'data' })
  define('source.capture', ctx => ctx.parts('保留', ctx.input('source'), '作为本次结算来源'),
    { slotOrder: ['source'], category: 'context' })
  define('source.capture-event-piece', ctx => ctx.parts('保留事件中的', ctx.parameter('field'), '作为本次结算来源'),
    { slotOrder: ['field'], category: 'context' })
  define('status.write-field', ctx => ctx.parts('将状态', ctx.input('status'), '的', ctx.parameter('field'), '设为', ctx.input('value')),
    { slotOrder: ['status', 'field', 'value'], category: 'data' })
  define('ref.card-template', ctx => ctx.parts('卡牌模板', ctx.parameter('templateId')),
    { slotOrder: ['templateId'], category: 'card-ability' })
  define('content.materialize-template', ctx => {
    if (String(ctx.statement.version) !== '2') return
    ctx.parts('使用模板', ctx.input('template'), '创建卡牌', ctx.input('name'), '，标识为', ctx.input('cardId'))
    if (ctx.isVisible('input', 'description')) ctx.parts('，说明为', ctx.input('description'))
    if (ctx.isVisible('input', 'owner')) ctx.parts('，归属', ctx.input('owner'))
    if (ctx.isVisible('input', 'fields')) ctx.parts('，字段为', ctx.input('fields'))
    if (ctx.isVisible('input', 'extension')) ctx.parts('，扩展变量为', ctx.input('extension'))
    if (ctx.isVisible('input', 'omitFields')) ctx.parts('，省略展示字段', ctx.input('omitFields'))
  }, { slotOrder: ['template', 'name', 'cardId', 'description', 'owner', 'fields', 'extension', 'omitFields'],
    derivedParameters: ['fieldsType', 'extensionType'], category: 'card-ability' })

  define('content.copy-card', ctx => ctx.parts(
    '复制', ctx.input('sourceId'), '的卡牌定义，序号为', ctx.input('index'),
    ...(ctx.isVisible('parameter', 'idPrefix') ? ['，新卡牌标识前缀为', ctx.parameter('idPrefix')] : []),
  ), { slotOrder: ['sourceId', 'index', 'idPrefix'], category: 'card-ability' })

  define('effect.heal', ctx => ctx.parts(
    '对', ctx.input('target'), '恢复', ctx.input('amount'), '点生命值，来源为', ctx.input('source'),
    ...(ctx.isVisible('parameter', 'skillId') ? ['，技能为', ctx.parameter('skillId')] : []),
  ), { slotOrder: ['target', 'amount', 'source', 'skillId'], category: 'combat' })
  define('effect.heal-many', ctx => ctx.parts(
    '由', ctx.input('source'), '为', ctx.input('targets'), '中的目标恢复', ctx.input('amount'), '点生命值',
    ...(ctx.isVisible('parameter', 'skillId') ? ['，技能为', ctx.parameter('skillId')] : []),
  ), { slotOrder: ['source', 'targets', 'amount', 'skillId'], category: 'combat' })

  define(['author.choice.option'], ctx => ctx.parts(
    '从', ctx.input('options'), '中选择一个', ctx.parameter('valueType'), '类型的选项',
    ...(ctx.isVisible('parameter', 'selectionMode') ? ['，选择方式为', ctx.parameter('selectionMode')] : []),
    ...(ctx.isVisible('parameter', 'title') ? ['，提示为', ctx.parameter('title')] : []),
    ...(ctx.isVisible('parameter', 'canCancel') ? ['，允许取消为', ctx.parameter('canCancel')] : []),
    ...(ctx.isVisible('input', 'cancelValue') ? ['，取消后继续并返回', ctx.input('cancelValue')] : []),
  ), { slotOrder: ['options', 'valueType', 'title', 'canCancel', 'cancelValue', 'selectionMode'], derivedParameters: ['optionsType'], category: 'selection' })
  define(['author.choice.target-piece'], ctx => ctx.parts(
    '在', ctx.parameter('range'), '格内选择', ctx.parameter('filter'), '的棋子目标',
    ...(ctx.isVisible('parameter', 'title') ? ['，提示为', ctx.parameter('title')] : []),
    ...(ctx.isVisible('parameter', 'canCancel') ? ['，允许取消为', ctx.parameter('canCancel')] : []),
  ), { slotOrder: ['range', 'filter', 'title', 'canCancel'], category: 'selection' })
  define(['author.choice.target-cell'], ctx => ctx.parts(
    '在', ctx.parameter('range'), '格内选择一个地格，阵营筛选为', ctx.parameter('filter'),
    '，要求可行走为', ctx.parameter('requireWalkable'), '，要求为空地为', ctx.parameter('requireUnoccupied'),
    ...(ctx.isVisible('parameter', 'title') ? ['，提示为', ctx.parameter('title')] : []),
    ...(ctx.isVisible('parameter', 'canCancel') ? ['，允许取消为', ctx.parameter('canCancel')] : []),
  ), { slotOrder: ['range', 'filter', 'requireWalkable', 'requireUnoccupied', 'title', 'canCancel'], category: 'selection' })

  define('local.declare', ctx => ctx.parts(
    '新建', ctx.parameter('valueType'), '变量', ...(ctx.isVisible('parameter', 'name') ? [ctx.parameter('name')] : []),
    ...(ctx.isVisible('input', 'initial') ? [' = ', ctx.input('initial')] : []),
  ), { slotOrder: ['valueType', 'name', 'initial'], category: 'data' })
  define('local.read', ctx => ctx.parts(
    '读取本次执行变量', ctx.input('handle'), '中的', ctx.parameter('valueType'), '值',
  ), { slotOrder: ['handle', 'valueType'], category: 'data' })
  define('local.write', ctx => ctx.parts(
    ctx.input('handle'), ' = ', ctx.input('value'),
  ), { slotOrder: ['handle', 'valueType', 'value'], category: 'data' })
  define('author.skill-instance.write', ctx => ctx.parts(ctx.input('instance'), '.', ctx.parameter('field'), ' = ', ctx.input('value')), { slotOrder: ['instance', 'field', 'value'], category: 'data' })
  define('author.skill-instance.field', ctx => ctx.parts(ctx.input('instance'), '.', ctx.parameter('field')), { slotOrder: ['instance', 'field'], category: 'data' })
  define('ref.current-skill', ctx => ctx.parts('当前技能'), { category: 'data' })
  define('author.cluster.acquire', ctx => ctx.parts('让', ctx.input('piece'), '获得能力组', ctx.input('definition')), { slotOrder: ['piece', 'definition'], category: 'effect' })
  define('author.cluster.remove', ctx => ctx.parts('移除', ctx.input('group')), { slotOrder: ['group'], category: 'effect' })
  define('author.cluster.list', ctx => ctx.parts(ctx.input('piece'), '.能力组'), { slotOrder: ['piece'], category: 'data' })
  define('code-block.invoke', ctx => ctx.parts('执行', ctx.input('block'), '，传入', ctx.input('args')), { slotOrder: ['block', 'args', 'resultType'], category: 'control' })
  define('map.create', ctx => ctx.parts('用键', ctx.input('keys'), '与对应的值', ctx.input('values'), '创建映射'), { slotOrder: ['keys', 'values'], category: 'calculation' })
  define('set.create', ctx => ctx.parts('将', ctx.input('items'), '去重为集合'), { slotOrder: ['items'], category: 'calculation' })
  for (const [id, receiver, method, args] of [
    ['map.has-key', 'map', '包含键', ['key']], ['map.get', 'map', '读取', ['key']],
    ['map.set', 'map', '写入', ['key', 'value']], ['map.delete', 'map', '移除', ['key']],
    ['map.keys', 'map', '键列表', []], ['map.values', 'map', '值列表', []], ['map.count', 'map', '数量', []],
    ['set.contains', 'set', '包含', ['value']], ['set.add', 'set', '加入', ['value']], ['set.delete', 'set', '移除', ['value']],
    ['set.items', 'set', '转元组', []], ['set.count', 'set', '数量', []],
  ]) define(id, ctx => {
    ctx.parts(ctx.input(receiver), '.', method, '（')
    args.forEach((name, index) => { if (index) ctx.parts('，'); ctx.parts(ctx.input(name)) })
    return ctx.parts('）')
  }, { slotOrder: [receiver, ...args], category: 'calculation' })
  define('author.effect.summon', ctx => {
    if (String(ctx.statement?.version) === '2' && ctx.statement?.parameters?.mode === 'declaration') {
      // The mode is still edited through the structured parameter inspector,
      // but the selected declaration wording already conveys it. Mark it as
      // consumed so finalize() does not append a raw parameter slot.
      ctx.slot('parameter', 'mode')
      return ctx.parts('在', ctx.input('destination'), '使用当前内容声明召唤，来源为', ctx.input('source'))
    }
    return ctx.parts('在', ctx.input('destination'), '召唤', ctx.input('template'),
      ...(ctx.isVisible('input', 'display') ? ['，显示为', ctx.input('display')] : []), '，来源为', ctx.input('source'),
      ...(String(ctx.statement?.version) === '2' ? ['，召唤方式为', ctx.parameter('mode')] : []))
  }, { slotOrder: ['template', 'destination', 'display', 'source'], category: 'effect' })
  define('lifecycle.destroy', ctx => ctx.parts(
    '消灭', ctx.input('target'),
    ...(ctx.isVisible('input', 'source') ? ['，来源为', ctx.input('source')] : []),
  ), { slotOrder: ['target', 'source'], derivedParameters: ['targetType'], category: 'board' })
  define('lifecycle.remove-enemy', ctx => ctx.parts('使', ctx.input('target'), '出局'), { slotOrder: ['target'], category: 'board' })
  define('piece.detach-active', ctx => ctx.parts('将', ctx.input('piece'), '安全移除，状态处理为', ctx.parameter('flowStatePolicy')), { slotOrder: ['piece', 'flowStatePolicy'], category: 'board' })
  define('author.piece.display', ctx => ctx.parts('将', ctx.input('target'), '的显示设置为', ctx.input('display')), { slotOrder: ['target', 'display'], category: 'effect' })
  define('spatial.relative-cells', ctx => ctx.parts('以', ctx.input('center'), '为原点，按', ctx.input('offsets'), '取得地格范围'), { slotOrder: ['center', 'offsets'], category: 'board' })
  define('record.empty', ctx => ctx.parts('创建一份空记录'), { category: 'data' })
  define('record.set-field', ctx => ctx.parts(
    '将记录', ctx.input('record'), '中的', ctx.parameter('field'), '设为', ctx.input('value'),
    '，字段类型为', ctx.parameter('valueType'), '，得到新记录',
  ), { slotOrder: ['record', 'field', 'valueType', 'value'], category: 'data' })
  define('piece.resolve-including-graveyard', ctx => ctx.parts(
    '读取棋子', ctx.input('piece'), '的场上或墓地身份信息',
  ), { slotOrder: ['piece'], category: 'selection' })
  define('extension.commit-root-with-tiles', ctx => ctx.parts(
    '将扩展记录', ctx.input('root'), '保存至', ctx.parameter('storageKey'),
    '，并将地格附着更新为', ctx.input('tiles'),
  ), { slotOrder: ['storageKey', 'root', 'tiles'], category: 'data' })

  for (const [id, action, host] of [
    ['extension.declare-player', 'declare', 'player'], ['extension.declare-piece', 'declare', 'piece'], ['extension.declare-battle', 'declare', 'battle'],
    ['extension.read-player', 'read', 'player'], ['extension.read-piece', 'read', 'piece'], ['extension.read-battle', 'read', 'battle'],
    ['extension.write-player', 'write', 'player'], ['extension.write-piece', 'write', 'piece'], ['extension.write-battle', 'write', 'battle'],
  ]) {
    define(id, ctx => {
      if (host === 'battle') {
        const declaration = action === 'declare'
        const reading = action === 'read'
        const name = ctx.parameter('name')
        if (declaration) ctx.parts('声明全局扩展变量', name)
        else if (reading) ctx.parts('读取全局扩展变量', name)
        else if (ctx.isVisible('input', 'value')) ctx.parts('将', ctx.input('value'), '写入全局扩展变量', name)
        else ctx.parts('写入全局扩展变量', name)
        if (ctx.isVisible('parameter', 'namespace')) ctx.parts('，分组为', ctx.parameter('namespace'))
        if (ctx.isVisible('input', 'path')) ctx.parts('，字段路径为', ctx.input('path'))
        else if (ctx.isVisible('parameter', 'path')) ctx.parts('，字段路径为', ctx.parameter('path'))
        if (declaration && ctx.isVisible('input', 'value')) ctx.parts('，初始值为', ctx.input('value'))
        if (ctx.isVisible('parameter', 'valueType')) ctx.parts('，类型为', ctx.parameter('valueType'))
      } else extensionParts(ctx, action)
    }, { slotOrder: ['owner', 'namespace', 'name', 'path', 'valueType', 'value'], dependencies: extensionDependencies, category: 'data' })
  }
  for (const [id, action] of [
    ['extension.declare-instance', 'declare'], ['extension.read-instance', 'read'], ['extension.write-instance', 'write'],
  ]) define(id, ctx => {
    const declaration = action === 'declare'
    const reading = action === 'read'
    const name = ctx.parameter('name')
    if (declaration) ctx.parts('在', ctx.input('entity'), '上声明扩展变量', name)
    else if (reading) ctx.parts('读取', ctx.input('entity'), '的扩展变量', name)
    else if (ctx.isVisible('input', 'value')) ctx.parts('将', ctx.input('value'), '写入', ctx.input('entity'), '的扩展变量', name)
    else ctx.parts('写入', ctx.input('entity'), '的扩展变量', name)
    if (ctx.isVisible('parameter', 'namespace')) ctx.parts('，分组为', ctx.parameter('namespace'))
    if (ctx.isVisible('parameter', 'path')) ctx.parts('，字段路径为', ctx.parameter('path'))
    if (declaration && ctx.isVisible('input', 'value')) ctx.parts('，初始值为', ctx.input('value'))
    if (ctx.isVisible('parameter', 'valueType')) ctx.parts('，类型为', ctx.parameter('valueType'))
  }, {
    slotOrder: ['entity', 'namespace', 'name', 'path', 'valueType', 'value'],
    dependencies: extensionDependencies,
    derivedParameters: ['entityKind'],
    category: 'data',
  })
  for (const [id, action] of [
    ['extension.map-declare', '声明'], ['extension.map-items', '读取'], ['extension.map-put', '写入'], ['extension.map-remove', '删除'],
  ]) {
    define(id, ctx => {
      ctx.parts(action, '玩家', ctx.input('player'), '的扩展映射')
      if (ctx.isVisible('parameter', 'name')) ctx.parts('，名称为', ctx.parameter('name'))
      if (ctx.isVisible('parameter', 'namespace')) ctx.parts('，分组为', ctx.parameter('namespace'))
      if (ctx.isVisible('parameter', 'schema')) ctx.parts('，记录类型为', ctx.parameter('schema'))
      if (ctx.isVisible('parameter', 'keyField')) ctx.parts('，键字段为', ctx.parameter('keyField'))
      if (action === '写入' && ctx.isVisible('input', 'item')) ctx.parts('，记录为', ctx.input('item'))
      return ctx.fragments
    }, { slotOrder: ['player', 'namespace', 'name', 'schema', 'keyField', 'item'], dependencies: extensionMapDependencies, category: 'data' })
  }

  define(['math.add', 'math.subtract', 'math.multiply', 'math.divide', 'math.modulo', 'math.power', 'math.min', 'math.max'], ctx => {
    const left = ctx.input('left')
    const right = ctx.input('right')
    if (ctx.id === 'math.subtract') return ctx.parts('将', left, '减去', right)
    if (ctx.id === 'math.divide') return ctx.parts('将', left, '除以', right)
    if (ctx.id === 'math.power') return ctx.parts('计算', left, '的', right, '次幂')
    if (ctx.id === 'math.modulo') return ctx.parts('计算', left, '除以', right, '的余数')
    if (ctx.id === 'math.min') return ctx.parts('取', left, '与', right, '中的较小值')
    if (ctx.id === 'math.max') return ctx.parts('取', left, '与', right, '中的较大值')
    const word = arithmeticWords[ctx.id] || '计算'
    return ctx.parts('将', left, '与', right, word)
  }, { slotOrder: ['left', 'right'], category: 'calculation' })
  define(['math.floor', 'math.abs'], ctx => ctx.parts(ctx.id === 'math.floor' ? '将' : '取得', ctx.input('value'), ctx.id === 'math.floor' ? '向下取整' : '的绝对值'), { slotOrder: ['value'], category: 'calculation' })
  define(['compare.equal', 'compare.not-equal', 'compare.equal-string', 'compare.not-equal-string', 'compare.equal-string-nullable', 'compare.equal-boolean', 'compare.not-equal-boolean', 'compare.equal-piece', 'compare.not-equal-piece', 'compare.equal-piece-nullable', 'compare.equal-player', 'compare.not-equal-player', 'compare.player-reference', 'compare.text', 'compare.less-than', 'compare.less-or-equal', 'compare.greater-than', 'compare.greater-or-equal'], ctx => {
    const left = ctx.input('left')
    const right = ctx.input('right')
    const operator = comparisonOperators[ctx.id]
    if (operator) return ctx.parts(left, ` ${operator} `, right)
    return ctx.parts(
      ...(ctx.id === 'compare.less-than' || ctx.id === 'compare.less-or-equal' || ctx.id === 'compare.greater-than' || ctx.id === 'compare.greater-or-equal'
        ? ['判断', left, comparisonWords[ctx.id] || '是否满足条件', right]
        : ['判断', left, '与', right, comparisonWords[ctx.id] || '是否满足条件']),
    )
  }, { slotOrder: ['left', 'right'], category: 'calculation' })
  define(['logic.and', 'logic.or'], ctx => ctx.parts('判断条件', ctx.input('left'), logicWords[ctx.id], ctx.input('right')), { slotOrder: ['left', 'right'], category: 'calculation' })
  define('logic.not', ctx => ctx.parts('判断', ctx.input('value'), '是否不成立'), { slotOrder: ['value'], category: 'calculation' })
  define('compare.values', ctx => ctx.parts(ctx.input('left'), ctx.parameter('operator'), ctx.input('right')), { slotOrder: ['left', 'operator', 'right'], category: 'calculation' })
  define(['logic.select-number', 'logic.select'], ctx => ctx.parts(
    '若', ctx.input('condition'), '成立则取', ctx.input('whenTrue'), '，否则取', ctx.input('whenFalse'),
  ), { slotOrder: ['condition', 'whenTrue', 'whenFalse'], category: 'calculation' })
  define('text.concat', ctx => ctx.parts('把', ctx.input('left'), '和', ctx.input('right'), '拼接为文本'), { slotOrder: ['left', 'right'], category: 'calculation' })
  define('text.starts-with', ctx => ctx.parts('判断', ctx.input('text'), '是否以', ctx.input('value'), '开头'), { slotOrder: ['text', 'value'], category: 'calculation' })
  define('text.contains', ctx => ctx.parts('判断', ctx.input('text'), '是否包含', ctx.input('value')), { slotOrder: ['text', 'value'], category: 'calculation' })
  define('collection.distinct', ctx => ctx.parts('去除', ctx.input('items'), '中的重复项'), { slotOrder: ['items'], category: 'calculation' })
  define(['text.from-number', 'text.from-value'], ctx => ctx.parts('把', ctx.input('value'), '转换为文本'), { slotOrder: ['value'], category: 'calculation' })
  define('value.coalesce', ctx => ctx.parts('取', ctx.input('value'), '，为空时取', ctx.input('defaultValue')), { slotOrder: ['value', 'defaultValue'], category: 'calculation' })
  define('observation.field', ctx => ctx.parts('读取', ctx.input('record'), '的', ctx.parameter('field')), { slotOrder: ['record', 'field'], category: 'data' })
  define('text.join-list', ctx => ctx.parts('用', ctx.parameter('separator'), '连接', ctx.input('items'), '中的文本'), { slotOrder: ['items', 'separator'], category: 'calculation' })

  define(['ref.holder', 'ref.source', 'ref.target', 'ref.player', 'ref.event-player', 'ref.event-piece', 'ref.rule-piece'], ctx => {
    const words = { 'ref.holder': '当前持有者', 'ref.source': '来源棋子', 'ref.target': '当前目标', 'ref.player': '所属玩家', 'ref.event-player': '事件玩家', 'ref.event-piece': '当前事件棋子', 'ref.rule-piece': '当前规则持有棋子' }
    return ctx.parts('引用', words[ctx.id] || ctx.label || '上下文对象')
  }, { category: 'data' })
  define(['turn.number', 'turn.current-player', 'event.type', 'event.player', 'event.actual-damage', 'event.movement-kind', 'event.skill-id', 'event.reserved-cells', 'event.target-cell', 'event.single-piece-target-action', 'skill.power-multiplier'], ctx => ctx.parts('读取', ctx.label || '当前上下文值'), { category: 'data' })

  define(['resource.read', 'resource.limit'], ctx => ctx.parts('读取', ctx.input('player'), '的', ctx.parameter('resource'), '数值'), { slotOrder: ['player', 'resource'], category: 'combat' })
  define('resource.adjust', ctx => ctx.parts('将', ctx.input('player'), '的', ctx.parameter('resource'), '调整', ctx.input('amount')), { slotOrder: ['player', 'resource', 'amount'], category: 'combat' })
  define('effect.force-defeat', ctx => ctx.parts('令', ctx.input('target'), '立即出局'), { slotOrder: ['target'], category: 'combat' })
  define(['damage.killed', 'damage.batch-kill-count', 'damage.batch-total'], ctx => ctx.parts('读取', ctx.input('result'), '中的伤害结算结果'), { slotOrder: ['result'], category: 'combat' })

  define('status.query-instances', ctx => ctx.parts('在', ctx.input('piece'), '上查询', ctx.parameter('statusType'), '状态实例', ...(ctx.isVisible('input', 'source') ? ['，来源为', ctx.input('source')] : [])), { slotOrder: ['piece', 'source', 'statusType'], category: 'status-rule' })
  define('status.remove-instance', ctx => ctx.parts('移除', ctx.input('status'), '状态实例'), { slotOrder: ['status'], category: 'status-rule' })
  define(['status.has-piece', 'status.count-piece'], ctx => ctx.parts('读取', ctx.input('piece'), '上的', ctx.parameter('statusType'), '状态'), { slotOrder: ['piece', 'statusType'], category: 'status-rule' })
  define('status.has-player', ctx => ctx.parts('判断', ctx.input('player'), '是否具有', ctx.parameter('statusType'), '状态'), { slotOrder: ['player', 'statusType'], category: 'status-rule' })
  define('status.find-instance', ctx => ctx.parts('在', ctx.input('piece'), '上查找', ctx.parameter('statusType'), '状态实例'), { slotOrder: ['piece', 'statusType'], category: 'status-rule' })
  define('status.apply-record', ctx => ctx.parts('向', ctx.input('target'), '附加结构化状态', ctx.input('record'), '，输入策略为', ctx.parameter('inputPolicy')), { slotOrder: ['target', 'record', 'inputPolicy'], category: 'status-rule' })
  define('status.apply-player-record', ctx => ctx.parts('向', ctx.input('player'), '附加结构化状态', ctx.input('record')), { slotOrder: ['player', 'record'], category: 'status-rule' })
  define(['status.remove-piece', 'status.remove-player'], ctx => ctx.parts('从', ctx.input('target'), '移除状态', ctx.parameter('statusId')), { slotOrder: ['target', 'statusId'], category: 'status-rule' })
  define('status.make-id', ctx => ctx.parts('为', ctx.input('target'), '生成状态标识，前缀为', ctx.parameter('prefix')), { slotOrder: ['target', 'prefix'], category: 'status-rule' })
  define(['status.read-number-instance', 'status.set-number-instance'], ctx => ctx.parts(
    ctx.id === 'status.read-number-instance' ? '读取' : '设定', ctx.input('status'), '状态实例的', ctx.parameter('field'), ...(ctx.id === 'status.set-number-instance' ? ['为', ctx.input('value')] : ['，缺省值为', ctx.input('fallback')]),
  ), { slotOrder: ['status', 'field', 'fallback', 'value'], category: 'status-rule' })
  define(['rule.apply-piece', 'rule.apply-player'], ctx => ctx.parts('向', ctx.input('target'), '附加规则', ctx.parameter('ruleId')), { slotOrder: ['target', 'ruleId'], category: 'status-rule' })
  define(['rule.remove-piece', 'rule.remove-player'], ctx => ctx.parts('从', ctx.input('target'), '移除规则', ctx.parameter('ruleId')), { slotOrder: ['target', 'ruleId'], category: 'status-rule' })
  define('rule.has-piece', ctx => ctx.parts('判断', ctx.input('piece'), '是否具有规则', ctx.parameter('ruleId')), { slotOrder: ['piece', 'ruleId'], category: 'status-rule' })
  define('event.block', ctx => ctx.parts('阻挡当前事件，原因是', ctx.input('message')), { slotOrder: ['message'], category: 'status-rule' })
  define('event.enqueue-damage-redirect', ctx => ctx.parts('将当前伤害的承受者改为', ctx.input('target')), { slotOrder: ['target'], category: 'status-rule' })
  define('query.all-pieces', ctx => ctx.parts('依次读取战场与墓地中的棋子记录标识'), { category: 'selection' })
  define(['event.read-number', 'event.read-string'], ctx => ctx.parts('读取事件字段', ctx.parameter('field'), '，缺省值为', ctx.input('fallback')), { slotOrder: ['field', 'fallback'], category: 'status-rule' })
  define('event.write-number', ctx => ctx.parts('把事件字段', ctx.parameter('field'), '改写为', ctx.input('value'), '，策略为', ctx.parameter('inputPolicy')), { slotOrder: ['field', 'value', 'inputPolicy'], category: 'status-rule' })

  define(['card.hand-count'], ctx => ctx.parts('读取', ctx.input('player'), '的手牌数量'), { slotOrder: ['player'], category: 'card-ability' })
  define('card.hand-instances', ctx => ctx.parts('查询', ctx.input('player'), '的手牌实例', ...(ctx.isVisible('parameter', 'cardId') ? ['，卡牌为', ctx.parameter('cardId')] : [])), { slotOrder: ['player', 'cardId'], category: 'card-ability' })
  define('card.hand-add', ctx => ctx.parts('向', ctx.input('player'), '加入卡牌', ctx.parameter('cardId')), { slotOrder: ['player', 'cardId'], category: 'card-ability' })
  define('card.discard-instance', ctx => ctx.parts('弃置手牌实例', ctx.input('card')), { slotOrder: ['card'], category: 'card-ability' })
  define('skill.identifiers', ctx => ctx.parts('读取', ctx.input('piece'), '拥有的技能标识'), { slotOrder: ['piece'], category: 'card-ability' })
  define(['skill.add', 'skill.remove'], ctx => ctx.parts(ctx.id === 'skill.add' ? '为' : '从', ctx.input('owner') || ctx.input('piece'), ctx.id === 'skill.add' ? '添加技能' : '移除技能', ctx.input('skill') || ctx.parameter('skillId')), { slotOrder: ['owner', 'piece', 'skill', 'skillId'], derivedParameters: ['ownerType'], category: 'card-ability' })
  define('ref.skill-definition', ctx => ctx.parts('技能', ctx.parameter('skillId')), { slotOrder: ['skillId'], category: 'card-ability' })
  define('skill.adjust-cooldown', ctx => ctx.parts('调整', ctx.input('piece'), '的技能', ctx.input('skillId'), '冷却', ctx.input('amount'), '回合，模式为', ctx.parameter('mode')), { slotOrder: ['piece', 'skillId', 'amount', 'mode'], category: 'card-ability' })

  define('lifecycle.queue-summon', ctx => ctx.parts('让', ctx.input('source'), '在', ctx.input('destination'), '排队召唤变体', ctx.input('variant')), { slotOrder: ['source', 'destination', 'variant'], category: 'board' })
  define('effect.displace-one', ctx => ctx.parts('让', ctx.input('piece'), '位移到', ctx.input('destination'), '，方式为', ctx.parameter('kind')), { slotOrder: ['piece', 'destination', 'kind'], category: 'board' })
  define('effect.displace-policy', ctx => ctx.parts(
    '让', ctx.input('piece'), '按路径策略位移到', ctx.input('destination'), '，方式为', ctx.parameter('kind'), '，友方可穿越为', ctx.parameter('passAllies'), '，敌方可穿越为', ctx.parameter('passEnemies'), '，地形为', ctx.parameter('terrain'), '，屏蔽地形为', ctx.parameter('blockedTerrainTypes'),
  ), { slotOrder: ['piece', 'destination', 'kind', 'passAllies', 'passEnemies', 'terrain', 'blockedTerrainTypes'], category: 'board' })
  define('effect.swap-pieces', ctx => ctx.parts('交换', ctx.input('first'), '与', ctx.input('second'), '的位置'), { slotOrder: ['first', 'second'], category: 'board' })
  define('effect.displace-many', ctx => ctx.parts('让', ctx.input('pieces'), '按', ctx.input('destinations'), '批量位移，方式为', ctx.parameter('kind')), { slotOrder: ['pieces', 'destinations', 'kind'], category: 'board' })
  define('effect.free-move', ctx => ctx.parts('让', ctx.input('piece'), '免费移动到', ctx.input('destination')), { slotOrder: ['piece', 'destination'], category: 'board' })
  define('effect.destroy-walls', ctx => ctx.parts('破坏', ctx.input('cells'), '中的墙体，包含掩体为', ctx.parameter('includeCover')), { slotOrder: ['cells', 'includeCover'], category: 'board' })
  define('spatial.cell', ctx => ctx.parts('构造坐标为', ctx.input('x'), '、', ctx.input('y'), '的地格'), { slotOrder: ['x', 'y'], category: 'board' })
  define(['spatial.cell-coordinates', 'spatial.piece-position'], ctx => ctx.parts('读取', ctx.input('cell') || ctx.input('piece'), '的位置坐标'), { category: 'board' })
  define('spatial.cell-distance', ctx => ctx.parts('计算', ctx.input('from'), '到', ctx.input('to'), '的地格距离'), { slotOrder: ['from', 'to'], category: 'board' })
  define('spatial.cell-landing-legal', ctx => ctx.parts('判断', ctx.input('cell'), '是否为合法落点，地形策略为', ctx.parameter('terrainPolicy'), ...(ctx.isVisible('input', 'ignoreA') ? ['，忽略', ctx.input('ignoreA')] : []), ...(ctx.isVisible('input', 'ignoreB') ? ['和', ctx.input('ignoreB')] : [])), { slotOrder: ['cell', 'ignoreA', 'ignoreB', 'terrainPolicy'], category: 'board' })
  define('spatial.cell-in-list', ctx => ctx.parts('判断', ctx.input('cell'), '是否在', ctx.input('cells'), '中'), { slotOrder: ['cell', 'cells'], category: 'board' })
  define('spatial.cell-equal', ctx => ctx.parts('判断地格', ctx.input('left'), '与', ctx.input('right'), '是否相同'), { slotOrder: ['left', 'right'], category: 'board' })
  define(['spatial.cardinal-cells', 'spatial.adjacent-cells-ordered'], ctx => ctx.parts('生成', ctx.input('target') || ctx.input('center'), '的正交相邻地格'), { category: 'board' })
  define('spatial.map-cells', ctx => ctx.parts('读取棋盘上的全部地格'), { category: 'board' })
  define('spatial.ray-cells', ctx => ctx.parts('从', ctx.input('source'), '沿', ctx.input('direction'), '读取射线地格，最多', ctx.parameter('maxDistance'), '格'), { slotOrder: ['source', 'direction', 'maxDistance'], category: 'board' })
  define('projectile.trace', ctx => ctx.parts('从', ctx.input('source'), '向', ctx.input('target'), '记录弹道，最多', ctx.parameter('maxDistance'), '格'), { slotOrder: ['source', 'target', 'maxDistance'], category: 'board' })
  define('movement.trace', ctx => ctx.parts('读取', ctx.input('source'), '沿', ctx.input('direction'), '的位移路径，最多', ctx.input('maxDistance'), '格'), { slotOrder: ['source', 'direction', 'maxDistance'], category: 'board' })
  define('movement.actual-path-enemies', ctx => ctx.parts('从', ctx.input('movement'), '的实际路径读取', ctx.input('source'), '接触的敌人'), { slotOrder: ['source', 'movement'], category: 'board' })
  define('movement.first-trace-obstruction', ctx => ctx.parts('从', ctx.input('events'), '中读取', ctx.input('source'), '射线上的首个阻挡'), { slotOrder: ['source', 'events'], category: 'board' })
  define('query.random-cell', ctx => ctx.parts('从', ctx.input('items'), '中确定性随机选择地格'), { slotOrder: ['items'], category: 'selection' })
  define('tile.has-effect', ctx => ctx.parts('判断', ctx.input('cell'), '是否具有地格效果', ctx.parameter('effectType')), { slotOrder: ['cell', 'effectType'], category: 'board' })
  define('tile.add-source-effect', ctx => ctx.parts('在', ctx.input('cell'), '添加来源效果', ctx.input('id'), '，来源为', ctx.input('sourceId'), '，持有玩家为', ctx.input('owner'), '，类型为', ctx.parameter('tileType')), { slotOrder: ['cell', 'id', 'sourceId', 'owner', 'tileType'], category: 'board' })
  define('tile.remove-source-effects', ctx => ctx.parts('清理来源为', ctx.input('sourceId'), '的地格效果，类型为', ctx.parameter('tileType')), { slotOrder: ['sourceId', 'tileType'], category: 'board' })

  define('query.pieces', ctx => ctx.parts('查询', ctx.parameter('relation'), '棋子', ...(ctx.isVisible('input', 'originId') ? ['，中心为', ctx.input('originId')] : []), ...(ctx.isVisible('input', 'ownerId') ? ['，所属玩家为', ctx.input('ownerId')] : []), ...(ctx.isVisible('parameter', 'range') ? ['，范围为', ctx.parameter('range'), '格'] : []), '，包含死亡棋子为', ctx.parameter('includeDead')), { slotOrder: ['relation', 'originId', 'ownerId', 'range', 'includeDead'], category: 'selection' })
  define('query.normal-move-cells', ctx => ctx.parts('按宿主普通移动规则查询', ctx.input('piece'), '的合法落点'), { slotOrder: ['piece'], category: 'board' })
  define('query.pieces-around-cell', ctx => ctx.parts('查询', ctx.input('center'), '周围', ctx.parameter('relation'), '棋子，所属玩家为', ctx.input('owner'), '，距离范围为', ctx.parameter('minimum'), '至', ctx.parameter('maximum'), '，度量为', ctx.parameter('metric')), { slotOrder: ['center', 'owner', 'relation', 'metric', 'minimum', 'maximum'], category: 'selection' })
  define('query.distance', ctx => ctx.parts('计算', ctx.input('from'), '到', ctx.input('to'), '的棋子距离'), { slotOrder: ['from', 'to'], category: 'selection' })
  define('query.players', ctx => ctx.parts('按对局顺序查询玩家'), { category: 'selection' })
  define('piece.owner', ctx => ctx.parts('读取', ctx.input('piece'), '的所属玩家'), { slotOrder: ['piece'], category: 'selection' })
  define(['piece.identifier', 'piece.alive', 'piece.is-core'], ctx => ctx.parts('读取', ctx.input('piece') || '棋子', '的', ctx.label || '棋子事实'), { category: 'selection' })
  define('attribute.read', ctx => ctx.parts('读取', ctx.input('piece'), '的', ctx.parameter('attribute'), '属性'), { slotOrder: ['piece', 'attribute'], category: 'data' })
  for (const [id, input] of [['piece.field', 'piece'], ['player.field', 'player'], ['data.field', 'record'], ['data.optional-field', 'record'], ['result.field', 'record']]) {
    define(id, ctx => ctx.parts('读取', ctx.input(input), '的', ctx.parameter('field')), { slotOrder: [input, 'field'], category: 'data' })
  }
  define(['event.field', 'context.field'], ctx => ctx.parts('读取当前事件的', ctx.parameter('field')), { slotOrder: ['field'], category: 'data' })
  define('skill.field', ctx => ctx.parts('读取当前技能的', ctx.parameter('field')), { slotOrder: ['field'], category: 'data' })
  for (const [id, input] of [['preview.piece-field', 'piece'], ['preview.skill-field', 'skill'], ['preview.record-field', 'record']]) {
    define(id, ctx => ctx.parts('预览', ctx.input(input), '的', ctx.parameter('field')), { slotOrder: [input, 'field'], category: 'data' })
  }
  define('value.to-number', ctx => ctx.parts('将', ctx.input('value'), '转换为数值'), { slotOrder: ['value'], category: 'calculation' })
  define('value.to-boolean', ctx => ctx.parts('将', ctx.input('value'), '转换为真假值'), { slotOrder: ['value'], category: 'calculation' })
  define('battle.field', ctx => ctx.parts('读取当前对局的', ctx.parameter('field')), { slotOrder: ['field'], category: 'data' })
  define('content.field', ctx => ctx.parts('读取当前内容库的', ctx.parameter('field')), { slotOrder: ['field'], category: 'data' })
  define('skill.definition-field', ctx => ctx.parts('读取技能定义', ctx.input('skillId'), '的', ctx.parameter('field')), { slotOrder: ['skillId', 'field'], category: 'card-ability' })
  define('source.fields', ctx => ctx.parts('读取', ctx.input('source'), '的来源信息'), { slotOrder: ['source'], category: 'data' })
  define('source.field', ctx => ctx.parts('读取', ctx.input('source'), '的来源', ctx.parameter('field'), '字段'), { slotOrder: ['source', 'field'], category: 'data' })
  define('source.write-field', ctx => ctx.parts('将', ctx.input('source'), '的来源', ctx.parameter('field'), '设为', ctx.input('value')), { slotOrder: ['source', 'field', 'value'], category: 'data' })
  define('status.fields', ctx => ctx.parts('读取', ctx.input('status'), '的状态信息'), { slotOrder: ['status'], category: 'data' })
  define(['attribute.text', 'attribute.player-text'], ctx => ctx.parts(
    '读取', ctx.input(ctx.id === 'attribute.player-text' ? 'player' : 'piece'), '的文本字段', ctx.parameter('attribute'),
  ), { slotOrder: ['piece', 'player', 'attribute'], category: 'data' })
  define('attribute.adjust', ctx => ctx.parts('将', ctx.input('piece'), '的', ctx.parameter('attribute'), '增加', ctx.input('amount')), { slotOrder: ['piece', 'attribute', 'amount'], category: 'data' })
  define('attribute.set', ctx => ctx.parts('将', ctx.input('piece'), '的', ctx.parameter('attribute'), '设为', ctx.input('value')), { slotOrder: ['piece', 'attribute', 'value'], category: 'data' })

  define('collection.length', ctx => ctx.parts('读取集合', ctx.input('items'), '的长度'), { slotOrder: ['items'], category: 'calculation' })
  define('collection.at', ctx => ctx.parts('读取集合', ctx.input('items'), '的第', ctx.input('position'), '项'), { slotOrder: ['items', 'position'], category: 'calculation' })
  define('collection.random', ctx => ctx.parts('从', ctx.input('items'), '中随机选择一项'), { slotOrder: ['items'], category: 'calculation' })
  define('collection.singleton', ctx => ctx.parts('把', ctx.input('value'), '放入一个新元组'), { slotOrder: ['valueType', 'value'], category: 'calculation' })
  define('collection.concat', ctx => ctx.parts('把', ctx.input('right'), '接在', ctx.input('left'), '后面，得到新元组'), { slotOrder: ['valueType', 'left', 'right'], category: 'calculation' })
  define('collection.reverse', ctx => ctx.parts('将', ctx.input('items'), '按相反顺序排列，得到新元组'), { slotOrder: ['items'], category: 'calculation' })
  define('skill.instances', ctx => ctx.parts('获取', ctx.input('piece'), '身上的技能实例'), { slotOrder: ['piece'], category: 'card-ability' })
  define('skill.instance-field', ctx => ctx.parts('读取技能实例', ctx.input('instance'), '的', ctx.parameter('field')), { slotOrder: ['instance', 'field'], category: 'card-ability' })
  define('skill.set-instance-cooldown', ctx => ctx.parts('将技能实例', ctx.input('instance'), '的冷却设为', ctx.input('value')), { slotOrder: ['instance', 'value'], category: 'card-ability' })
  define('data.omit-key', ctx => ctx.parts('从', ctx.input('record'), '的副本中删除字段', ctx.input('key')), { slotOrder: ['record', 'key'], category: 'data' })
  define('data.read-key', ctx => ctx.parts('读取', ctx.input('record'), '中的字段', ...(ctx.isVisible('input', 'key') ? [ctx.input('key')] : [ctx.parameter('key')])), { slotOrder: ['record', 'key', 'valueType'], category: 'data' })
  define('text.trim', ctx => ctx.parts('去掉', ctx.input('text'), '首尾的空白'), { slotOrder: ['text'], category: 'calculation' })
  define('text.lowercase', ctx => ctx.parts('把', ctx.input('text'), '转成小写文本'), { slotOrder: ['text'], category: 'calculation' })
  define('collection.sort', ctx => ctx.parts('按', ctx.input('keys'), '对', ctx.input('items'), '排序，顺序为', ctx.parameter('order'), ...(ctx.isVisible('parameter', 'comparison') ? ['，比较方式为', ctx.parameter('comparison')] : [])), { slotOrder: ['items', 'keys', 'comparison', 'order'], category: 'calculation' })

  define('preview.piece-number', ctx => ctx.parts('预览', ctx.input('piece'), '的数值属性', ctx.parameter('attribute')), { slotOrder: ['piece', 'attribute'], category: 'data' })
  define('preview.skill-number', ctx => ctx.parts('预览技能', ctx.input('skill'), '的数值属性', ctx.parameter('attribute')), { slotOrder: ['skill', 'attribute'], category: 'data' })
  define('preview.result', ctx => ctx.parts('返回预览说明', ctx.input('description'), ...(ctx.isVisible('input', 'damage') ? ['，伤害为', ctx.input('damage')] : []), ...(ctx.isVisible('input', 'heal') ? ['，治疗为', ctx.input('heal')] : []), ...(ctx.isVisible('input', 'attackBonus') ? ['，攻击加成为', ctx.input('attackBonus')] : []), ...(ctx.isVisible('input', 'selfDamage') ? ['，自伤为', ctx.input('selfDamage')] : [])), { slotOrder: ['description', 'damage', 'heal', 'attackBonus', 'selfDamage'], category: 'data' })
  define('result.action', ctx => ctx.parts('构造行动结果：成功为', ctx.input('success'), ...(ctx.isVisible('input', 'message') ? ['，消息为', ctx.input('message')] : [])), { slotOrder: ['success', 'message'], category: 'control' })
  define('log.trigger-effect', ctx => ctx.parts('为', ctx.input('player'), '记录触发消息：', ctx.input('message')), { slotOrder: ['player', 'message'], category: 'control' })
  define('instance.copy-piece', ctx => ctx.parts('复制', ctx.input('piece'), '的棋子实例信息'), { slotOrder: ['piece'], derivedParameters: ['snapshotType'], category: 'data' })
  define('instance.apply-piece', ctx => ctx.parts('将实例副本', ctx.input('snapshot'), '应用到', ctx.input('piece')), { slotOrder: ['piece', 'snapshot'], category: 'data' })

  define('status.count-piece', ctx => ctx.parts('统计', ctx.input('piece'), '上的', ctx.parameter('statusType'), '状态数量'), { slotOrder: ['piece', 'statusType'], category: 'status-rule' })

  const genericModuleLabels = Object.freeze({
    'author.effect.summon': '召唤棋子', 'author.piece.display': '设置棋子显示',
    'author.effect.damage': '造成伤害', 'author.effect.heal': '进行治疗',
    'record.create': '创建记录', 'record.get': '读取记录字段', 'record.with': '更新记录',
    'record.empty': '创建空记录', 'collection.map': '映射集合', 'collection.filter': '筛选集合',
    'collection.reduce': '汇总集合', 'collection.find': '查找集合', 'code-block.invoke': '执行代码块',
  })
  const genericSlotLabels = Object.freeze({
    source: '来源', target: '目标', template: '棋子模板', display: '显示内容', destination: '目标地格',
    record: '记录', field: '字段', value: '值', amount: '数量', condition: '条件', items: '集合',
    item: '当前项目', index: '当前索引', accumulator: '累计值', schema: '记录结构', keyField: '键字段',
    mode: '模式', audience: '可见对象', message: '提示文字', title: '标题', filter: '筛选条件',
    selectionMode: '选择方式', min: '最少数量', max: '最多数量', canCancel: '允许中止',
    resumeOnCancel: '中止后继续', description: '说明', success: '是否成功', player: '玩家', piece: '棋子',
  })
  function isInternalLabel(value, id = '') {
    const text = String(value || '').trim()
    return !text || text === id || /^[a-z][a-z0-9]*(?:[.-][a-z0-9_-]+)+$/i.test(text)
  }
  function moduleDisplayLabel(id, label) {
    if (!isInternalLabel(label, id)) return String(label)
    return genericModuleLabels[id] || (id ? `未注册模块（${id}）` : '未注册模块')
  }
  function slotDisplayLabel(definition) {
    return definition?.label || genericSlotLabels[definition?.name] || '字段'
  }

  function genericBuild(ctx) {
    const id = ctx.id
    const label = moduleDisplayLabel(id, ctx.label)
    if (!ctx.registered) ctx.parts('暂不支持结构化句式，保留模块“', label, '”供兼容查看')
    else if (ctx.authoring === 'compatibility') ctx.parts(label)
    else if (ctx.category === 'calculation') ctx.parts('计算“', label, '”')
    else if (ctx.category === 'selection') ctx.parts('查询“', label, '”')
    else if (ctx.category === 'board') ctx.parts('执行棋盘操作“', label, '”')
    else if (ctx.category === 'combat') ctx.parts('执行战斗效果“', label, '”')
    else if (ctx.category === 'status-rule') ctx.parts('处理状态或规则“', label, '”')
    else if (ctx.category === 'card-ability') ctx.parts('处理卡牌或能力“', label, '”')
    else ctx.parts('执行“', label, '”')
    for (const definition of ctx.inputs) if (ctx.isVisible('input', definition.name)) ctx.parts('，', slotDisplayLabel(definition), '为', ctx.input(definition.name))
    for (const definition of ctx.parameters) if (ctx.isVisible('parameter', definition.name)) ctx.parts('，', slotDisplayLabel(definition), '为', ctx.parameter(definition.name))
  }

  function createCallContext(descriptor, statement, fragments) {
    const inputs = array(descriptor?.inputs)
    const parameters = array(descriptor?.parameters)
    const used = new Set()
    const context = {
      id: descriptorId(descriptor, statement),
      label: moduleDisplayLabel(descriptorId(descriptor, statement), descriptor?.label || descriptor?.uiDescription || descriptor?.description || statement?.module || ''),
      category: descriptor?.ui?.category || '',
      authoring: descriptor?.ui?.authoring || '',
      registered: Boolean(descriptor?.id),
      inputs,
      parameters,
      statement: object(statement),
      fragments,
      has(kind, name) { return Boolean(definitionFor(descriptor, kind, name)) },
      isVisible(kind, name) {
        return isSlotAvailable(descriptor, statement, kind, name)
      },
      input(name) { return context.slot('input', name) },
      parameter(name) { return context.slot('parameter', name) },
      slot(kind, name) {
        const definition = definitionFor(descriptor, kind, name)
        if (!definition || !isSlotAvailable(descriptor, statement, kind, name)) return null
        const key = keyOf(kind, name)
        if (used.has(key)) return null
        used.add(key)
        return { kind, name }
      },
      parts(...parts) {
        for (const part of parts) {
          if (part === null || part === undefined || part === '') continue
          if (typeof part === 'string') fragments.push(part)
          else if (part.kind === 'input' || part.kind === 'parameter') fragments.push(part)
        }
        return fragments
      },
      finalize() {
        // A custom phrase may be intentionally concise, but it must never
        // hide an actual required declaration field.  Add anything missed in
        // declaration order with a readable Chinese continuation.
        for (const definition of inputs) if (context.isVisible('input', definition.name) && !used.has(keyOf('input', definition.name))) context.parts('，输入为', context.input(definition.name))
        for (const definition of parameters) if (context.isVisible('parameter', definition.name) && !used.has(keyOf('parameter', definition.name))) context.parts('，参数为', context.parameter(definition.name))
        return fragments
      },
    }
    return context
  }

  function optionalSlots(descriptor, statement) {
    return [
      ...array(descriptor?.inputs).filter(item => item?.optional && isSlotAvailable(descriptor, statement, 'input', item.name, { allowUnsetOptional: true })).map(item => ({ kind: 'input', name: item.name })),
      ...array(descriptor?.parameters).filter(item => item?.optional && isSlotAvailable(descriptor, statement, 'parameter', item.name, { allowUnsetOptional: true })).map(item => ({ kind: 'parameter', name: item.name })),
    ]
  }

  function addArrayMetadata(fragments, descriptor, statement, id) {
    const optional = optionalSlots(descriptor, statement)
    const info = metadata[id] || {}
    const actualSlots = fragments.filter(item => item && typeof item === 'object' && (item.kind === 'input' || item.kind === 'parameter')).map(item => ({ ...item }))
    const slotOrder = array(info.slotOrder).filter(name => actualSlots.some(item => item.name === name))
    for (const item of actualSlots) if (!slotOrder.includes(item.name)) slotOrder.push(item.name)
    const meta = Object.freeze({
      id,
      version: descriptor?.version || statement?.version || '',
      category: info.category || descriptor?.ui?.category || '',
      slotOrder: Object.freeze(slotOrder),
      slots: Object.freeze(actualSlots),
      optional: Object.freeze(optional),
      dependencies: Object.freeze({ ...(info.dependencies || {}) }),
    })
    // Non-enumerable properties keep the public result an ordinary fragments
    // array while still giving the UI a way to render optional parameters.
    Object.defineProperty(fragments, 'optional', { value: optional, enumerable: false })
    Object.defineProperty(fragments, 'optionalSlots', { value: optional, enumerable: false })
    Object.defineProperty(fragments, 'meta', { value: meta, enumerable: false })
    return fragments
  }

  function describeCall(descriptor, statement = {}, context = {}) {
    const fragments = []
    const id = descriptorId(descriptor, statement)
    const ctx = createCallContext(descriptor, statement, fragments)
    const build = specs[id] || genericBuild
    try { build(ctx, context) } catch {
      // A malformed optional template must not hide the graph.  Rebuild the
      // generic sentence using a fresh slot tracker, so a partially rendered
      // custom phrase cannot suppress a required declaration field.
      const fallbackFragments = []
      const fallback = createCallContext(descriptor, statement, fallbackFragments)
      fallback.parts('暂不支持结构化句式，保留模块“', moduleDisplayLabel(id, fallback.label || id), '”')
      fallback.finalize()
      return addArrayMetadata(fallbackFragments, descriptor, statement, id)
    }
    ctx.finalize()
    return addArrayMetadata(fragments, descriptor, statement, id)
  }

  function structuralContext(statement, fragments) {
    const used = new Set()
    const hasValue = name => own(statement, name) || (name.startsWith('return:') && own(statement.values, name))
    const add = (kind, name, required = false) => {
      if (!required && !hasValue(name)) return null
      const key = keyOf(kind, name)
      if (used.has(key)) return null
      used.add(key)
      return { kind, name }
    }
    const parts = (...items) => {
      for (const item of items) {
        if (item === null || item === undefined || item === '') continue
        if (typeof item === 'string') fragments.push(item)
        else if (item.kind === 'input' || item.kind === 'parameter') fragments.push(item)
      }
      return fragments
    }
    return { add, parts, used, hasValue }
  }

  function describeStatement(statement = {}, context = {}) {
    void context
    const fragments = []
    const kind = String(statement?.kind || '')
    const ctx = structuralContext(statement, fragments)
    const input = name => ctx.add('input', name, true)
    const parameter = name => ctx.add('parameter', name, true)
    if (kind === 'if') ctx.parts('如果', input('condition'), '，执行满足条件的分支。')
    else if (kind === 'foreach') ctx.parts('依次处理', input('items'), '中的每一项。')
    else if (kind === 'while') ctx.parts('最多循环', parameter('budget'), '次，并按条件继续执行。', ...(ctx.hasValue('index') ? ['索引变量为', parameter('index')] : []))
    else if (kind === 'record.create') {
      ctx.parts('创建', parameter('schema'), '记录。')
      for (const name of Object.keys(object(statement.fields))) ctx.parts('字段', { kind: 'input', name: `field:${name}` })
    } else if (kind === 'record.get') ctx.parts('从', input('record'), '中读取字段', parameter('field'), '。')
    else if (kind === 'record.with') {
      ctx.parts('基于', input('record'), '更新记录。')
      for (const name of Object.keys(object(statement.fields))) ctx.parts('字段', { kind: 'input', name: `field:${name}` })
    } else if (kind === 'collection' || kind === 'collection.map' || kind === 'collection.filter' || kind === 'collection.reduce' || kind === 'collection.find') {
      const method = statement.method || kind.split('.')[1] || 'map'
      const words = { map: '映射', filter: '筛选', reduce: '汇总', find: '查找第一项，来源为' }
      ctx.parts(words[method] || '处理', input('items'), '集合')
      for (const name of ['item', 'index', 'accumulator']) if (ctx.hasValue(name)) ctx.parts('，变量为', parameter(name))
      if (method === 'reduce') ctx.parts('，初始值为', input('initial'))
      for (const name of Object.keys(object(statement.inputs))) ctx.parts('，局部输入', input(name))
    } else if (kind === 'return') {
      ctx.parts('返回')
      const values = object(statement.values)
      for (const name of Object.keys(values)) ctx.parts('输出', input(`return:${name}`))
      if (own(statement, 'value')) ctx.parts(input('value'))
      ctx.parts('。')
    } else if (kind === 'defer-choice') {
      ctx.parts('等待选择并进入续接', parameter('graph'), '，载荷为', input('payload'))
      for (const name of ['player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message']) {
        if (ctx.hasValue(name)) ctx.parts('，', parameter(name))
      }
    } else {
      ctx.parts('保留未注册结构语句，请在高级视图中检查。')
    }
    const optional = []
    for (const name of ['item', 'index', 'accumulator', 'presentation', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message']) {
      if (ctx.hasValue(name)) continue
      optional.push({ kind: name === 'item' || name === 'index' || name === 'accumulator' ? 'parameter' : 'input', name })
    }
    const meta = Object.freeze({ kind, slots: Object.freeze(fragments.filter(item => item && typeof item === 'object')), optional: Object.freeze(optional) })
    Object.defineProperty(fragments, 'optional', { value: optional, enumerable: false })
    Object.defineProperty(fragments, 'optionalSlots', { value: optional, enumerable: false })
    Object.defineProperty(fragments, 'meta', { value: meta, enumerable: false })
    return fragments
  }

  function getTemplate(id, version) {
    const key = String(id || '')
    const info = metadata[key] || {}
    return Object.freeze({
      id: key,
      version: version || '',
      category: info.category || '',
      slotOrder: Object.freeze(array(info.slotOrder).slice()),
      dependencies: Object.freeze({ ...(info.dependencies || {}) }),
      derivedParameters: Object.freeze(array(info.derivedParameters).slice()),
    })
  }

  const templateMetadata = Object.freeze(Object.fromEntries(Object.keys(metadata).map(id => [id, getTemplate(id)])))
  const api = {
    describeCall,
    describeStatement,
    getTemplate,
    isDerivedParameter,
    derivedParameterValues,
    isRedundantResultMessage,
    isSlotAvailable,
    templates: templateMetadata,
    TEMPLATES: templateMetadata,
  }
  return Object.freeze(api)
})
