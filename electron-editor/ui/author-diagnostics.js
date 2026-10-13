/*
 * Author-facing diagnostics for the gameplay-module compiler and document
 * validator.
 *
 * This file is deliberately independent from the editor bundle.  The bundle
 * can pass the registry/catalog that it already has, while this small adapter
 * remains safe to load before the bundle and in a test VM.
 */
(() => {
  'use strict'

  const own = (value, key) => Boolean(value) && Object.prototype.hasOwnProperty.call(value, key)
  const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

  const TYPE_LABELS = Object.freeze({
    number: '数字',
    boolean: '布尔值',
    string: '文本',
    text: '文本',
    piece: '棋子',
    player: '玩家',
    cell: '地格',
    path: '路径',
    card: '卡牌',
    content: '内容',
    status: '状态',
    event: '事件',
    choice: '选项',
    record: '记录',
    json: '任意数据',
    null: '空值',
    never: '空集合类型',
    unknown: '未知类型',
    any: '任意类型',
  })

  // These are stable semantic names used by the first authoring catalogue.
  // A registry label always wins; the table is only a fallback for a catalog
  // that has not been passed to the formatter yet.
  const BUILTIN_FIELD_LABELS = Object.freeze({
    source: '来源',
    target: '目标',
    amount: '数量',
    amountType: '数量类型',
    sourceType: '来源类型',
    targetType: '目标类型',
    resultType: '结果类型',
    damageType: '伤害类型',
    skillId: '技能',
    template: '棋子模板',
    destination: '落点',
    message: '提示文字',
    display: '显示选项',
    summonCapability: '召唤能力声明',
    code: '代码',
    skillCode: '技能代码',
    effectCode: '效果代码',
    previewCode: '预览代码',
    triggerSkillCode: '触发技能代码',
    contentGraph: '内容图',
    gameplayModules: '模块文档',
    compilerVersion: '编译器版本',
    fallback: '回退定义',
    faction: '阵营',
    skills: '技能列表',
    relatedRules: '关联规则',
    rules: '规则',
    storageExtensionKey: '存储扩展键',
    ownerScopedStorageExtensionKey: '所有者范围存储扩展键',
    uniqueTemplateId: '唯一模板标识',
    maxSummons: '最大召唤数',
    recipe: '配方',
    entries: '条目',
    graph: '模块图',
    ports: '端口',
    allowedSurfaces: '适用内容类型',
    inspectReferences: '检查引用',
    livingReferences: '存活引用',
    composites: '组合模块',
    continuations: '继续流程',
    layout: '布局',
    dependencies: '依赖',
    effects: '效果声明',
    options: '编译器选项',
    version: '版本',
    field: '字段',
    fields: '字段',
    inputs: '输入',
    outputs: '输出',
    parameters: '参数',
    schema: '记录结构',
    surface: '内容类型',
    skill: '技能',
    card: '卡牌',
    rule: '规则',
    triggerSkill: '触发技能',
    pending: '待处理流程',
    preview: '预览',
    module: '模块',
    type: '类型',
    value: '值',
    enum: '枚举选项',
    body: '语句体',
    'compiler option': '编译器选项',
    'graph.body': '模块图语句体',
    'graph.inputs': '模块图输入',
    'graph.outputs': '模块图输出',
    'graph.schemas': '模块图记录结构',
    'graph.composites': '模块图组合模块',
    'graph.continuations': '模块图继续流程',
    'graph.inputBindings': '模块图输入绑定',
    'graph.hostBindings': '模块图宿主绑定',
    'graph.version': '模块图版本',
    'graph.surface': '模块图内容类型',
    'collection.body': '集合处理体',
    'while.body': '循环体',
    'while.condition.body': '循环条件体',
    'if.then': '如果分支',
    'if.else': '否则分支',
    'foreach.body': '遍历体',
  })

  const SUPPORTED_CODES = Object.freeze([
    'GAMEPLAY_MODULE_AMBIGUOUS_CONTINUATION', 'GAMEPLAY_MODULE_AMBIGUOUS_MODULE', 'GAMEPLAY_MODULE_AMBIGUOUS_SCHEMA',
    'GAMEPLAY_MODULE_BUDGET_EXCEEDED', 'GAMEPLAY_MODULE_COLLECTION_EFFECT', 'GAMEPLAY_MODULE_COMPOSITE_CYCLE',
    'GAMEPLAY_MODULE_CONFLICTING_REFERENCE_METADATA', 'GAMEPLAY_MODULE_CONTINUATION_CYCLE',
    'GAMEPLAY_MODULE_DUPLICATE_CONTINUATION', 'GAMEPLAY_MODULE_DUPLICATE_FIELD', 'GAMEPLAY_MODULE_DUPLICATE_ID',
    'GAMEPLAY_MODULE_DUPLICATE_LIVING_REFERENCE', 'GAMEPLAY_MODULE_DUPLICATE_MODULE', 'GAMEPLAY_MODULE_DUPLICATE_PARAMETER',
    'GAMEPLAY_MODULE_DUPLICATE_PORT', 'GAMEPLAY_MODULE_DUPLICATE_REFERENCE_INSPECTION', 'GAMEPLAY_MODULE_DUPLICATE_SCHEMA',
    'GAMEPLAY_MODULE_GRAPH_VERSION', 'GAMEPLAY_MODULE_INTERNAL_ERROR', 'GAMEPLAY_MODULE_INVALID',
    'GAMEPLAY_MODULE_INVALID_BOOLEAN', 'GAMEPLAY_MODULE_INVALID_CONTINUATION', 'GAMEPLAY_MODULE_INVALID_EFFECTS',
    'GAMEPLAY_MODULE_INVALID_HOST_BINDING', 'GAMEPLAY_MODULE_INVALID_LIVING_REFERENCE', 'GAMEPLAY_MODULE_INVALID_NAME',
    'GAMEPLAY_MODULE_INVALID_OPTION', 'GAMEPLAY_MODULE_INVALID_PARAMETER', 'GAMEPLAY_MODULE_INVALID_REFERENCE_INSPECTION',
    'GAMEPLAY_MODULE_INVALID_RETURN', 'GAMEPLAY_MODULE_INVALID_STATEMENT', 'GAMEPLAY_MODULE_INVALID_SURFACE',
    'GAMEPLAY_MODULE_INVALID_TYPE', 'GAMEPLAY_MODULE_INVALID_TYPE_BINDING', 'GAMEPLAY_MODULE_INVALID_VALUE',
    'GAMEPLAY_MODULE_LOWERING_FAILED', 'GAMEPLAY_MODULE_MISSING_FIELD', 'GAMEPLAY_MODULE_MISSING_OUTPUT',
    'GAMEPLAY_MODULE_MISSING_PARAMETER', 'GAMEPLAY_MODULE_MISSING_PORT', 'GAMEPLAY_MODULE_OUTPUT_SCOPE',
    'GAMEPLAY_MODULE_PARAMETER_TYPE', 'GAMEPLAY_MODULE_PARAMETER_VALUE', 'GAMEPLAY_MODULE_PENDING_NESTING',
    'GAMEPLAY_MODULE_PORT_TYPE', 'GAMEPLAY_MODULE_PREVIEW_EFFECT', 'GAMEPLAY_MODULE_REGISTRY_INVALID',
    'GAMEPLAY_MODULE_ROOT_INPUT', 'GAMEPLAY_MODULE_SHAPE', 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN',
    'GAMEPLAY_MODULE_UNKNOWN_CONTINUATION', 'GAMEPLAY_MODULE_UNKNOWN_FIELD', 'GAMEPLAY_MODULE_UNKNOWN_INPUT',
    'GAMEPLAY_MODULE_UNKNOWN_OUTPUT', 'GAMEPLAY_MODULE_UNKNOWN_PARAMETER', 'GAMEPLAY_MODULE_UNKNOWN_PORT',
    'GAMEPLAY_MODULE_UNKNOWN_SCHEMA', 'GAMEPLAY_MODULE_UNSAFE_VALUE', 'GAMEPLAY_MODULE_UNSUPPORTED_PARAMETER',
    'GAMEPLAY_MODULE_UNSUPPORTED_STATEMENT', 'GAMEPLAY_MODULE_UNTYPED_RECORD', 'GAMEPLAY_MODULE_VERSION_MISMATCH',
    'GAMEPLAY_MODULE_WRONG_PAYLOAD_TYPE', 'GAMEPLAY_MODULE_DOCUMENT', 'GAMEPLAY_MODULE_INVALID_ENTRY',
  ])

  const CODE_LABELS = Object.freeze({
    GAMEPLAY_MODULE_SHAPE: '数据结构无效',
    GAMEPLAY_MODULE_UNSAFE_VALUE: '值不安全',
    GAMEPLAY_MODULE_INVALID_TYPE: '值类型无效',
    GAMEPLAY_MODULE_INVALID_NAME: '名称无效',
    GAMEPLAY_MODULE_INVALID_BOOLEAN: '布尔值无效',
    GAMEPLAY_MODULE_MISSING_PORT: '缺少输入',
    GAMEPLAY_MODULE_UNKNOWN_PORT: '输入不存在',
    GAMEPLAY_MODULE_PORT_TYPE: '输入类型不匹配',
    GAMEPLAY_MODULE_UNKNOWN_INPUT: '输入不存在',
    GAMEPLAY_MODULE_UNKNOWN_OUTPUT: '输出不存在',
    GAMEPLAY_MODULE_MISSING_OUTPUT: '缺少输出',
    GAMEPLAY_MODULE_UNKNOWN_FIELD: '字段不存在',
    GAMEPLAY_MODULE_MISSING_FIELD: '缺少字段',
    GAMEPLAY_MODULE_UNKNOWN_SCHEMA: '记录结构不存在',
    GAMEPLAY_MODULE_AMBIGUOUS_SCHEMA: '记录结构版本不明确',
    GAMEPLAY_MODULE_VERSION_MISMATCH: '模块图版本不支持',
    GAMEPLAY_MODULE_INVALID_PARAMETER: '参数声明无效',
    GAMEPLAY_MODULE_UNKNOWN_PARAMETER: '参数不存在',
    GAMEPLAY_MODULE_MISSING_PARAMETER: '缺少参数',
    GAMEPLAY_MODULE_PARAMETER_TYPE: '参数类型不匹配',
    GAMEPLAY_MODULE_PARAMETER_VALUE: '参数值无效',
    GAMEPLAY_MODULE_INVALID_STATEMENT: '语句结构无效',
    GAMEPLAY_MODULE_UNSUPPORTED_STATEMENT: '语句类型不支持',
    GAMEPLAY_MODULE_INVALID_RETURN: '返回值无效',
    GAMEPLAY_MODULE_ROOT_INPUT: '根输入绑定无效',
    GAMEPLAY_MODULE_OUTPUT_SCOPE: '输出不在当前作用域',
    GAMEPLAY_MODULE_INVALID_SURFACE: '内容类型无效',
    GAMEPLAY_MODULE_SURFACE_FORBIDDEN: '内容类型不支持此模块',
    GAMEPLAY_MODULE_PREVIEW_EFFECT: '预览不允许此效果',
    GAMEPLAY_MODULE_COLLECTION_EFFECT: '集合处理中不允许此效果',
    GAMEPLAY_MODULE_INVALID_TYPE_BINDING: '类型绑定无效',
    GAMEPLAY_MODULE_UNTYPED_RECORD: '记录没有确定结构',
    GAMEPLAY_MODULE_WRONG_PAYLOAD_TYPE: '继续执行载荷类型不匹配',
    GAMEPLAY_MODULE_INVALID_CONTINUATION: '继续流程无效',
    GAMEPLAY_MODULE_UNKNOWN_CONTINUATION: '继续流程不存在',
    GAMEPLAY_MODULE_AMBIGUOUS_CONTINUATION: '继续流程版本不明确',
    GAMEPLAY_MODULE_CONTINUATION_CYCLE: '继续流程存在循环',
    GAMEPLAY_MODULE_PENDING_NESTING: '待处理流程嵌套无效',
    GAMEPLAY_MODULE_DUPLICATE_CONTINUATION: '继续流程重复',
    GAMEPLAY_MODULE_DUPLICATE_SCHEMA: '记录结构重复',
    GAMEPLAY_MODULE_DUPLICATE_MODULE: '模块重复',
    GAMEPLAY_MODULE_DUPLICATE_PARAMETER: '参数重复',
    GAMEPLAY_MODULE_DUPLICATE_PORT: '端口重复',
    GAMEPLAY_MODULE_DUPLICATE_FIELD: '字段重复',
    GAMEPLAY_MODULE_DUPLICATE_ID: '语句编号重复',
    GAMEPLAY_MODULE_DUPLICATE_REFERENCE_INSPECTION: '引用检查项重复',
    GAMEPLAY_MODULE_DUPLICATE_LIVING_REFERENCE: '存活引用重复',
    GAMEPLAY_MODULE_COMPOSITE_CYCLE: '组合模块存在循环',
    GAMEPLAY_MODULE_BUDGET_EXCEEDED: '模块规模超过限制',
    GAMEPLAY_MODULE_CONFLICTING_REFERENCE_METADATA: '引用元数据冲突',
    GAMEPLAY_MODULE_INVALID_REFERENCE_INSPECTION: '引用检查声明无效',
    GAMEPLAY_MODULE_INVALID_LIVING_REFERENCE: '存活引用声明无效',
    GAMEPLAY_MODULE_INVALID_HOST_BINDING: '宿主绑定无效',
    GAMEPLAY_MODULE_REGISTRY_INVALID: '模块目录无效',
    GAMEPLAY_MODULE_INTERNAL_ERROR: '模块编译内部诊断',
    GAMEPLAY_MODULE_LOWERING_FAILED: '模块生成失败',
    GAMEPLAY_MODULE_DOCUMENT: '内容流程文档无效',
    GAMEPLAY_MODULE_INVALID_ENTRY: '模块文档条目无效',
  })

  const REMAINING_GAPS = Object.freeze([
    '未来新增错误码会显示中文诊断编号和位置；完整原始文案仅保存在复制诊断数据中。',
    '未注册的模块、字段和记录结构名称无法推断显示名称，会保留作者填写的名称。',
  ])

  function asArray(value) {
    if (Array.isArray(value)) return value
    if (value && typeof value.values === 'function') {
      try { return Array.from(value.values()) } catch { return [] }
    }
    return []
  }

  function catalogDescriptors(catalog) {
    if (!catalog) return []
    if (Array.isArray(catalog)) return catalog.filter(record)
    const result = []
    const add = value => {
      if (Array.isArray(value)) for (const entry of value) if (record(entry)) result.push(entry)
      else if (record(value)) {
        if (typeof value.id === 'string') result.push(value)
        else for (const entry of Object.values(value)) if (record(entry) && typeof entry.id === 'string') result.push(entry)
      }
    }
    for (const key of ['descriptors', 'modules', 'entries', 'items']) if (own(catalog, key)) add(catalog[key])
    for (const key of ['registry', 'catalog']) if (own(catalog, key)) for (const entry of catalogDescriptors(catalog[key])) result.push(entry)
    if (typeof catalog.id === 'string') result.push(catalog)
    if (!result.length && record(catalog)) {
      for (const entry of Object.values(catalog)) if (record(entry) && typeof entry.id === 'string') result.push(entry)
    }
    return result
  }

  function descriptorReference(reference, version) {
    const text = String(reference || '')
    if (version !== undefined && version !== null && String(version).length > 0) return { id: text, version: String(version) }
    const index = text.lastIndexOf('@')
    if (index > 0) return { id: text.slice(0, index), version: text.slice(index + 1) }
    return { id: text, version: undefined }
  }

  function descriptorFor(reference, version, catalog) {
    const target = descriptorReference(reference, version)
    if (!target.id) return null
    const candidates = catalogDescriptors(catalog)
    const exact = candidates.find(entry => entry.id === target.id && (target.version === undefined || String(entry.version) === target.version))
    if (exact) return exact

    // Registry adapters are allowed to expose a resolver instead of a
    // materialized descriptor list.  Resolver failures must not hide a
    // compiler diagnostic, so they intentionally fall through.
    for (const method of ['resolve', 'get']) {
      if (!catalog || typeof catalog[method] !== 'function') continue
      for (const args of target.version === undefined
        ? [[target.id], [reference]]
        : [[target.id, target.version], [reference]]) {
        try {
          const value = catalog[method](...args)
          if (record(value) && typeof value.id === 'string') return value
          const values = asArray(value)
          const match = values.find(entry => record(entry) && entry.id === target.id && (target.version === undefined || String(entry.version) === target.version))
          if (match) return match
        } catch {
          // A catalog is display metadata.  It must never make an error
          // formatter throw while the editor is trying to show the error.
        }
      }
    }
    return null
  }

  function humanLabel(value) {
    const text = String(value ?? '')
    return text.trim() ? text : ''
  }

  function catalogPortLabel(name, role, catalog) {
    const labels = []
    for (const entry of catalogDescriptors(catalog)) {
      const ports = Array.isArray(entry[role]) ? entry[role] : []
      const port = ports.find(item => record(item) && item.name === name)
      if (port && humanLabel(port.label)) {
        const label = humanLabel(port.label)
        if (!labels.includes(label)) labels.push(label)
      }
      for (const schema of Array.isArray(entry.recordSchemas) ? entry.recordSchemas : []) {
        const field = record(schema) && Array.isArray(schema.fields)
          ? schema.fields.find(item => record(item) && item.name === name)
          : null
        if (field && humanLabel(field.label) && !labels.includes(humanLabel(field.label))) labels.push(humanLabel(field.label))
      }
    }
    return labels.length === 1 ? labels[0] : ''
  }

  function portLabel(name, descriptor, role, catalog) {
    const text = String(name ?? '')
    const list = descriptor && Array.isArray(descriptor[role]) ? descriptor[role] : []
    const port = list.find(entry => record(entry) && entry.name === text)
    if (port && humanLabel(port.label)) return humanLabel(port.label)
    // Parameters are sometimes exposed through the UI metadata instead of
    // the descriptor's parameters array.
    if (descriptor && descriptor.ui && record(descriptor.ui.fields)) {
      const uiField = descriptor.ui.fields[text]
      if (record(uiField) && humanLabel(uiField.label)) return humanLabel(uiField.label)
    }
    // Input/output names are allowed to be author-defined.  When a catalog is
    // available it is authoritative; otherwise the small built-in fallback
    // keeps the stable semantic names usable for a bare error string.
    const catalogLabel = catalogPortLabel(text, role, catalog)
    if (catalogLabel) return catalogLabel
    const descriptors = catalogDescriptors(catalog)
    const knownPort = descriptors.some(entry => Array.isArray(entry[role]) && entry[role].some(item => item.name === text))
    if ((!catalog || descriptors.length === 0 || knownPort) && own(BUILTIN_FIELD_LABELS, text)) return BUILTIN_FIELD_LABELS[text]
    return text
  }

  function moduleLabel(id, catalog) {
    const descriptor = descriptorFor(id, undefined, catalog)
    if (descriptor && humanLabel(descriptor.label)) return humanLabel(descriptor.label)
    return String(id ?? '')
  }

  function splitGeneric(text) {
    const values = []
    let depth = 0
    let start = 0
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]
      if (character === '<' || character === '(' || character === '[') depth += 1
      else if (character === '>' || character === ')' || character === ']') depth = Math.max(0, depth - 1)
      else if (character === ',' && depth === 0) {
        values.push(text.slice(start, index).trim())
        start = index + 1
      }
    }
    values.push(text.slice(start).trim())
    return values
  }

  function typeLabel(value) {
    if (value && typeof value === 'object') {
      if (value.kind === 'list') return `列表<${typeLabel(value.element)}>`
      if (value.kind === 'set') return `集合<${typeLabel(value.element)}>`
      if (value.kind === 'map') return `映射<${typeLabel(value.key)}，${typeLabel(value.value)}>`
      if (value.kind === 'nullable') return `可空<${typeLabel(value.value)}>`
      if (value.kind === 'record') return `记录（${String(value.schema || '')}）`
      return String(value)
    }
    let text = String(value ?? '').trim()
    if (!text) return text
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) text = text.slice(1, -1)
    const generic = text.match(/^(list|set|map|nullable)<(.*)>$/iu)
    if (generic) {
      const kind = generic[1].toLowerCase()
      const inner = splitGeneric(generic[2])
      if (kind === 'list') return `列表<${typeLabel(inner[0])}>`
      if (kind === 'set') return `集合<${typeLabel(inner[0])}>`
      if (kind === 'nullable') return `可空<${typeLabel(inner[0])}>`
      return `映射<${typeLabel(inner[0])}，${typeLabel(inner[1])}>`
    }
    const recordType = text.match(/^record<(.*)>$/iu)
    if (recordType) return `记录（${recordType[1]}）`
    return own(TYPE_LABELS, text.toLowerCase()) ? TYPE_LABELS[text.toLowerCase()] : text
  }

  function quote(value) { return `“${String(value ?? '')}”` }

  function pathTail(path) {
    const text = String(path ?? '')
    const match = text.match(/\(\s*((?:graph|options|registry|document)\.[^()]*)\s*\)\s*$/iu)
    if (!match) return { path: '', cause: text }
    return { path: match[1].trim(), cause: text.slice(0, match.index).trim() }
  }

  function normalizeError(error) {
    if (typeof error === 'string') {
      const extracted = pathTail(error)
      return { original: error, message: extracted.cause, path: extracted.path, code: '', name: '' }
    }
    if (error && typeof error === 'object') {
      const original = typeof error.message === 'string' ? error.message : String(error)
      const extracted = pathTail(original)
      return {
        original,
        message: extracted.cause,
        path: typeof error.path === 'string' && error.path ? error.path : extracted.path,
        code: typeof error.code === 'string' ? error.code : '',
        name: typeof error.name === 'string' ? error.name : '',
      }
    }
    return { original: String(error ?? ''), message: String(error ?? ''), path: '', code: '', name: '' }
  }

  function appendLocation(text, path, descriptor, catalog) {
    const location = formatLocation(path, descriptor, catalog)
    return location ? `${text}（位置：${location}）` : text
  }

  function consumePathName(rest) {
    const match = rest.match(/^\.([A-Za-z_$][\w$-]*)/u)
    return match ? { value: match[1], rest: rest.slice(match[0].length) } : { value: '', rest }
  }

  function formatLocation(path, descriptor, catalog) {
    let rest = String(path || '')
    if (!rest) return ''
    if (rest.startsWith('graph.')) rest = rest.slice('graph.'.length)
    else if (rest.startsWith('graph')) rest = rest.slice('graph'.length)
    let location = ''
    const append = value => { location = location ? `${location}${value}` : value }
    let sawBody = false
    while (rest) {
      let match = rest.match(/^body\[(\d+)\]/u)
      if (match) {
        append(location ? `中的第${Number(match[1]) + 1}条语句` : `第${Number(match[1]) + 1}条语句`)
        sawBody = true
        rest = rest.slice(match[0].length)
        continue
      }
      match = rest.match(/^body\b/u)
      if (match) {
        append('语句体')
        sawBody = true
        rest = rest.slice(match[0].length)
        continue
      }
      match = rest.match(/^\.?condition\.body(?:\[(\d+)\])?/u)
      if (match) {
        append('的循环条件')
        if (match[1] !== undefined) append(`中的第${Number(match[1]) + 1}条语句`)
        sawBody = true
        rest = rest.slice(match[0].length)
        continue
      }
      match = rest.match(/^\.?(then|else|composite)\b/u)
      if (match) {
        const name = match[1] === 'then' ? '“如果”分支' : match[1] === 'else' ? '“否则”分支' : '组合模块'
        append(`的${name}`)
        rest = rest.slice(match[0].length)
        continue
      }
      match = rest.match(/^\.?(inputs|parameters|fields|values|module|record|schema|output|item|index|condition|presentation|body)\b/u)
      if (match) {
        const key = match[1]
        const labels = { inputs: '输入', parameters: '参数', fields: '字段', values: '返回值', module: '模块', record: '记录', schema: '记录结构', output: '输出', item: '项目', index: '序号', condition: '条件', presentation: '表现', body: '循环体' }
        append(location ? `的${labels[key] || key}` : (labels[key] || key))
        rest = rest.slice(match[0].length)
        const named = consumePathName(rest)
        if (named.value) {
          const role = key === 'inputs' ? 'inputs' : key === 'parameters' ? 'parameters' : key === 'outputs' ? 'outputs' : 'inputs'
          append(quote(portLabel(named.value, descriptor, role, catalog)))
          rest = named.rest
        }
        continue
      }
      match = rest.match(/^\.([A-Za-z_$][\w$-]*)/u)
      if (match) {
        const name = match[1]
        // User-defined node and variable names remain intact.  Only known
        // semantic fields use the fallback label table.
        const labels = { name: '名称', type: '类型', version: '版本', surface: '内容类型', value: '值', kind: '类型', schema: '记录结构' }
        append(`的${labels[name] || portLabel(name, descriptor, 'inputs', catalog)}`)
        rest = rest.slice(match[0].length)
        continue
      }
      match = rest.match(/^\[(\d+)\]/u)
      if (match) {
        append(sawBody ? `中的第${Number(match[1]) + 1}条语句` : `中的第${Number(match[1]) + 1}项`)
        rest = rest.slice(match[0].length)
        continue
      }
      match = rest.match(/^([A-Za-z_$][\w$-]*)/u)
      if (match) {
        const key = match[1]
        const labels = { inputs: '输入', inputBindings: '输入绑定', outputs: '输出', schemas: '记录结构', composites: '组合模块', version: '版本', surface: '内容类型', type: '类型', body: '语句体', fields: '字段', parameters: '参数', values: '返回值' }
        append(labels[key] || key)
        rest = rest.slice(match[0].length)
        continue
      }
      break
    }
    if (!sawBody && !location) return String(path).replace(/^graph\.?/iu, '图')
    return location || String(path).replace(/^graph\.?/iu, '图')
  }

  function entryLabel(value) {
    return own(BUILTIN_FIELD_LABELS, String(value)) ? BUILTIN_FIELD_LABELS[String(value)] : String(value)
  }

  function collectionMethodLabel(value) {
    const labels = { map: '映射', filter: '筛选', reduce: '归并', find: '查找' }
    return own(labels, String(value)) ? labels[String(value)] : String(value)
  }

  function statementKindLabel(value) {
    const labels = { call: '模块调用', collection: '集合处理', foreach: '遍历', while: '循环', if: '条件分支', 'defer-choice': '待处理选择', 'presentation-group': '表现分组', return: '返回' }
    return own(labels, String(value)) ? labels[String(value)] : String(value)
  }

  function documentMessage(message) {
    const prefix = message.replace(/^Gameplay module document:\s*/iu, '')
    let match = prefix.match(/^invalid gameplayModules version or entries$/iu)
    if (match) return '内容流程文档的版本或条目结构无效。请检查文档版本和条目列表。'
    match = prefix.match(/^unknown gameplayModules metadata$/iu)
    if (match) return '内容流程文档包含未知的元数据。请删除不支持的元数据字段。'
    match = prefix.match(/^gameplayModules needs at least one entry$/iu)
    if (match) return '内容流程文档至少需要一个条目。请添加模块图条目。'
    match = prefix.match(/^content must be an object$/iu)
    if (match) return '内容必须是对象。请检查导入的数据结构。'
    match = prefix.match(/^invalid entry\s+(.+)$/iu)
    if (match) return `模块文档条目${quote(entryLabel(match[1]))}无效。请检查该条目的模块图和编译器版本。`
    match = prefix.match(/^unsupported compiler version for\s+(.+)$/iu)
    if (match) return `条目${quote(entryLabel(match[1]))}使用了不支持的编译器版本。请重新生成该条目。`
    match = prefix.match(/^generated\s+(.+?)\s+does not match its module graph$/iu)
    if (match) return `生成的${quote(entryLabel(match[1]))}与模块图不同步。请重新生成内容。`
    match = prefix.match(/^generated\s+(.+?)\s+does not match its text binding$/iu)
    if (match) return `生成的${quote(entryLabel(match[1]))}与文字绑定不同步。请重新生成内容。`
    match = prefix.match(/^field\s+(.+?)\s+is incompatible with\s+(.+)$/iu)
    if (match) return `字段${quote(entryLabel(match[1]))}与内容类型${quote(entryLabel(match[2]))}不匹配。请检查该字段对应的模块图。`
    match = prefix.match(/^multiple authoring sources for\s+(.+)$/iu)
    if (match) return `字段${quote(entryLabel(match[1]))}存在多个作者来源。请只保留一个来源。`
    match = prefix.match(/^invalid summonCapability:\s*summonCapability must be a plain object$/iu)
    if (match) return '召唤能力声明无效：该字段必须填写对象结构，或移除空值。'
    match = prefix.match(/^legacy skillGraph cannot coexist with gameplay modules$/iu)
    if (match) return '旧版技能图不能与模块文档同时存在。请先完成迁移，再保存模块文档。'
    match = prefix.match(/^legacy skillGraph must be explicitly migrated first$/iu)
    if (match) return '旧版技能图必须先明确迁移，才能使用模块图编辑。'
    match = prefix.match(/^cannot detach module-owned field\s+(.+)$/iu)
    if (match) return `不能移除模块文档拥有的字段${quote(entryLabel(match[1]))}。请通过模块图更新该字段。`
    match = prefix.match(/^invalid legacy graph entry\s+(.+)$/iu)
    if (match) return `旧版模块图条目${quote(entryLabel(match[1]))}无效。请检查条目内容。`
    match = prefix.match(/^target binding preview entry is missing$/iu)
    if (match) return '目标绑定所需的预览条目缺失。请重新生成预览模块图。'
    match = prefix.match(/^text bindings require a module document$/iu)
    if (match) return '文字绑定需要模块文档。请先创建模块图条目。'
    match = prefix.match(/^invalid summonCapability:\s*(.+)$/iu)
    if (match) return `召唤能力声明无效：${capabilityMessage(match[1])}`
    return null
  }

  const CAPABILITY_FIELD_LABELS = Object.freeze({
    'source-mirror status': '来源镜像状态',
    'source-mirror status.relatedRules': '来源镜像状态的关联规则',
    'source-mirror capability': '来源镜像能力',
    'stored piece fallback': '存储棋子回退定义',
    'stored piece fallback.skills': '存储棋子回退定义的技能列表',
    'stored piece fallback.faction': '存储棋子回退定义的阵营',
    'stored-or-declared-piece storageExtensionKey': '存储或声明棋子的存储扩展键',
    'stored-or-declared-piece ownerScopedStorageExtensionKey': '存储或声明棋子的所有者范围存储扩展键',
    'stored-or-declared-piece uniqueTemplateId': '存储或声明棋子的唯一模板标识',
    'stored-or-declared-piece maxSummons': '存储或声明棋子的最大召唤数',
    'fallback.templateId': '回退棋子模板标识',
    'authored-piece': '作者棋子',
    summonCapability: '召唤能力声明',
    'summonCapability.version': '召唤能力声明的版本',
    'summonCapability.recipe': '召唤能力声明的配方',
  })

  function capabilityFieldLabel(value) {
    const text = String(value ?? '')
    if (own(CAPABILITY_FIELD_LABELS, text)) return CAPABILITY_FIELD_LABELS[text]
    const skill = text.match(/^stored piece fallback\.skills\[(\d+)\]$/u)
    if (skill) return `存储棋子回退定义的技能列表第${Number(skill[1]) + 1}项`
    return text
  }

  function capabilityMessage(message) {
    let value = String(message || '').trim()
    let match = value.match(/^(.+?) contains fields outside the closed capability schema$/iu)
    if (match) return `字段${quote(capabilityFieldLabel(match[1]))}不在允许的召唤能力结构中。请删除该字段。`
    match = value.match(/^(.+?) must be a non-empty string$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须填写非空文本。`
    match = value.match(/^(.+?) is outside the supported numeric range$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}超出允许的数值范围。`
    match = value.match(/^(.+?) must be boolean$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须是布尔值。`
    match = value.match(/^(.+?) must be a non-empty string array$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须是非空文本列表。`
    match = value.match(/^(.+?) must not contain duplicates$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}不能包含重复项。`
    match = value.match(/^(.+?) must be a plain object$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须是对象。`
    match = value.match(/^(.+?) must contain 1 to 32 declarations$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须包含1到32项声明。`
    match = value.match(/^(.+?)\[(\d+)\] must be a plain object$/iu)
    if (match) return `${quote(capabilityFieldLabel(`${match[1]}[${match[2]}]`))}必须是对象。`
    match = value.match(/^(.+?) must match (.+)$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须与${quote(capabilityFieldLabel(match[2]))}一致。`
    match = value.match(/^(.+?) must be red or blue$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须是红方或蓝方。`
    match = value.match(/^(.+?) is unsafe$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}包含不安全内容。`
    match = value.match(/^(.+?) must be exactly 1$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}必须正好为1。`
    match = value.match(/^(.+?) is not supported$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}当前不支持。`
    match = value.match(/^(.+?) exceeds the sealed collection limit$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1]))}超过了封闭集合上限。`
    if (/^source-mirror status\.relatedRules must exactly match capability rules$/iu.test(value)) return '来源镜像状态的关联规则必须与召唤能力规则完全一致。'
    match = value.match(/^(.+?) storageExtensionKey is unsafe$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1] + ' storageExtensionKey'))}包含不安全内容。`
    match = value.match(/^(.+?) ownerScopedStorageExtensionKey is unsafe$/iu)
    if (match) return `${quote(capabilityFieldLabel(match[1] + ' ownerScopedStorageExtensionKey'))}包含不安全内容。`
    if (/^stored-or-declared-piece uniqueTemplateId must match fallback\.templateId$/iu.test(value)) return '存储或声明棋子的唯一模板标识必须与回退棋子模板标识一致。'
    if (/^summonCapability\.version must be 1$/iu.test(value)) return '召唤能力声明的版本必须为1。'
    if (/^summonCapability\.recipe is not supported$/iu.test(value)) return '召唤能力声明的配方当前不支持。'
    match = value.match(/^authored-piece modes or batch size is invalid$/iu)
    if (match) return '作者棋子模式或批量大小无效。请检查召唤能力配置。'
    return '包含未识别的结构错误。请检查召唤能力字段和取值。'
  }

  function moduleFromMessage(message, catalog) {
    const match = message.match(/\bmodule\s+([A-Za-z_$][\w$.-]*(?:@[\w.-]+)?)/iu)
    if (!match) return { descriptor: null, id: '' }
    return { descriptor: descriptorFor(match[1], undefined, catalog), id: match[1] }
  }

  function defaultDescriptor(catalog) {
    const descriptors = catalogDescriptors(catalog)
    return descriptors.length === 1 ? descriptors[0] : null
  }

  function compilerMessage(message, code, catalog, descriptor) {
    let match
    const moduleInfo = moduleFromMessage(message, catalog)
    const activeDescriptor = descriptor || moduleInfo.descriptor
    if ((code === 'GAMEPLAY_MODULE_MISSING_PORT' || /missing (?:input port|composite input)/iu.test(message))) {
      match = message.match(/missing (?:input port|composite input)\s+["']([^"']+)["']/iu)
      if (match) return `缺少输入${quote(portLabel(match[1], activeDescriptor, 'inputs', catalog))}。请填写该输入，或确认它应为可选项。`
      if (/type binding requires an input/iu.test(message)) return '类型绑定需要一个输入。请填写输入后再编译。'
    }
    if ((code === 'GAMEPLAY_MODULE_UNKNOWN_PORT' || /unknown (?:input|composite input) port/iu.test(message))) {
      match = message.match(/unknown (?:input|composite input) port\s+["']([^"']+)["']/iu)
      if (match) return `未知输入${quote(portLabel(match[1], activeDescriptor, 'inputs', catalog))}。请从该模块支持的输入中选择。`
      match = message.match(/unknown composite input\s+["']([^"']+)["']/iu)
      if (match) return `未知组合输入${quote(portLabel(match[1], activeDescriptor, 'inputs', catalog))}。请检查组合模块的输入名称。`
    }
    if (code === 'GAMEPLAY_MODULE_UNKNOWN_INPUT' || /^unknown input\s+/iu.test(message)) {
      match = message.match(/^unknown input\s+["']([^"']+)["']/iu)
      if (match) return `未知输入${quote(portLabel(match[1], activeDescriptor, 'inputs', catalog))}。请检查输入名称或绑定。`
    }
    if (code === 'GAMEPLAY_MODULE_UNKNOWN_OUTPUT' || /unknown output(?: port)?/iu.test(message)) {
      if (/^unknown output port$/iu.test(message)) return '未知输出端口。请检查节点和输出端口名称。'
      match = message.match(/unknown output(?: port)?\s+["']?([^"']+?)["']?$/iu)
      if (match) return `未知输出${quote(portLabel(match[1], activeDescriptor, 'outputs', catalog))}。请检查节点是否提供该输出。`
      if (/unknown output(?: port)?/iu.test(message)) return '未知输出。请检查节点的输出声明。'
    }
    if (code === 'GAMEPLAY_MODULE_PORT_TYPE' || /expects\s+.+,\s+got\s+/iu.test(message)) {
      match = message.match(/^(input|parameter|return output|record field|pending field|root input binding|enum value|default)\s+["']([^"']+)["']?\s+expects\s+(.+?),\s+got\s+(.+)$/iu)
      if (match) {
        const kind = match[1].toLowerCase()
        const role = kind === 'parameter' || kind === 'enum value' || kind === 'default' ? 'parameters' : kind === 'return output' ? 'outputs' : 'inputs'
        const label = portLabel(match[2], activeDescriptor, role, catalog)
        const noun = kind === 'record field' ? '记录字段' : kind === 'parameter' ? '参数' : kind === 'return output' ? '返回输出' : kind === 'pending field' ? '待处理字段' : '输入'
        return `${noun}${quote(label)}需要${typeLabel(match[3])}，当前是${typeLabel(match[4])}。请调整值的类型。`
      }
      if (/composite input type mismatch/iu.test(message)) return '组合模块输入类型不匹配。请检查输入绑定和组合模块声明。'
      if (/if condition must be boolean/iu.test(message)) return '“如果”条件必须是布尔值。请提供真或假条件。'
      if (/while condition must return a boolean/iu.test(message)) return '循环条件必须返回布尔值。请检查条件语句的返回值。'
      if (/(?:foreach|collection) items must be a list/iu.test(message)) return '循环项目必须是列表。请提供列表值。'
      if (/input must use declared record schema/iu.test(message)) return '输入必须使用已声明的记录结构。请选择已注册的结构。'
      if (/continuation payload type mismatch/iu.test(message)) return '继续执行的载荷类型不匹配。请检查载荷结构。'
      match = message.match(/^root input binding expects\s+(.+?),\s+got\s+(.+)$/iu)
      if (match) return `根输入绑定需要${typeLabel(match[1])}，当前是${typeLabel(match[2])}。请调整输入绑定的类型。`
      match = message.match(/^return value expects\s+(.+?),\s+got\s+(.+)$/iu)
      if (match) return `返回值需要${typeLabel(match[1])}，当前是${typeLabel(match[2])}。请调整返回值的类型。`
    }
    if (code === 'GAMEPLAY_MODULE_UNKNOWN_FIELD' || /unknown (?:record )?field/iu.test(message)) {
      match = message.match(/unknown record field\s+["']([^"']+)["']/iu)
      if (match) return `未知记录字段${quote(portLabel(match[1], activeDescriptor, 'inputs', catalog))}。请检查记录结构中的字段。`
      match = message.match(/unknown field\s+["']([^"']+)["']/iu)
      if (match) return `未知字段${quote(portLabel(match[1], activeDescriptor, 'inputs', catalog))}。请检查字段名称和当前版本的结构。`
    }
    if (code === 'GAMEPLAY_MODULE_MISSING_FIELD' || /missing record field/iu.test(message)) {
      match = message.match(/missing record field\s+["']([^"']+)["']/iu)
      if (match) return `缺少记录字段${quote(portLabel(match[1], activeDescriptor, 'inputs', catalog))}。请补充该字段。`
    }
    if (code === 'GAMEPLAY_MODULE_MISSING_OUTPUT' || /missing graph output/iu.test(message)) {
      match = message.match(/missing graph output\s+["']([^"']+)["']/iu)
      if (match) return `缺少图输出${quote(portLabel(match[1], activeDescriptor, 'outputs', catalog))}。请补充该输出，或将其声明为可选。`
      if (/graph can fall through/iu.test(message)) return '模块图可能没有返回必需的输出。请检查所有分支是否都返回结果。'
    }
    if (code === 'GAMEPLAY_MODULE_UNKNOWN_SCHEMA' || /unknown record schema/iu.test(message)) {
      match = message.match(/unknown record schema\s+["']([^"']+)["']/iu)
      if (match) return `未知记录结构${quote(match[1])}。请确认结构已声明，并使用正确的版本。`
    }
    if (code === 'GAMEPLAY_MODULE_AMBIGUOUS_SCHEMA' || /record schema id is ambiguous/iu.test(message)) {
      return '记录结构名称对应多个版本，请使用“结构名@版本”明确指定版本。'
    }
    if (code === 'GAMEPLAY_MODULE_VERSION_MISMATCH' || /unsupported graph version/iu.test(message)) {
      match = message.match(/unsupported graph version\s+["']([^"']+)["']/iu)
      return match ? `不支持的模块图版本${quote(match[1])}。请使用当前编辑器支持的版本。` : '不支持的模块图版本。请使用当前编辑器支持的版本。'
    }
    if (code === 'GAMEPLAY_MODULE_LOWERING_FAILED' || /native lowering/iu.test(message)) {
      let cause = message.replace(/^native lowering failed:\s*/iu, '').trim()
      cause = cause.replace(/\bmodule\s+([A-Za-z_$][\w$.-]*(?:@[\w.-]+)?)/iu, (_all, id) => `模块${quote(moduleLabel(id, catalog))}`)
      cause = cause.replace(/^模块“([^”]+)”:\s*/u, '模块“$1”：')
      cause = cause.replace(/\bmissing input\s+["']?([^"'\s]+)["']?/iu, (_all, name) => `缺少输入${quote(portLabel(name, activeDescriptor, 'inputs', catalog))}`)
      cause = cause.replace(/\bmissing parameter\s+["']?([^"'\s]+)["']?/iu, (_all, name) => `缺少参数${quote(portLabel(name, activeDescriptor, 'parameters', catalog))}`)
      cause = cause.replace(/\bparameter\s+["']?([^"'\s]+)["']?\s+must be (?:a\s+)?(text|string|boolean|number)/iu, (_all, name, kind) => `参数${quote(portLabel(name, activeDescriptor, 'parameters', catalog))}必须是${typeLabel(kind)}`)
      cause = cause.replace(/\bparameter\s+["']?([^"'\s]+)["']?\s+is missing/iu, (_all, name) => `缺少参数${quote(portLabel(name, activeDescriptor, 'parameters', catalog))}`)
      const untranslated = /(?<![A-Za-z0-9_$\.])(?:missing|unknown|invalid|unsupported|must|expects|got|parameter|input|output|module|native|returned|result|failed|needs|attention|error|cannot|does|not|is|are|requires|value|type|source|statement)(?![A-Za-z0-9_$])/iu.test(cause)
      if (untranslated) return '模块生成失败：该模块的输入、参数或生成结果不符合要求。请根据当前位置检查模块定义。'
      const detail = cause || '模块没有返回可执行代码。'
      return `模块生成失败：${detail}${/[。！？]$/u.test(detail) ? '' : '。'}请检查该模块的输入和参数。`
    }
    return null
  }

  function genericMessage(message, catalog, descriptor) {
    let match = message.match(/^unknown input port\s+["']([^"']+)["']/iu)
    if (match) return `未知输入${quote(portLabel(match[1], descriptor, 'inputs', catalog))}。请检查输入名称。`
    match = message.match(/^missing input port\s+["']([^"']+)["']/iu)
    if (match) return `缺少输入${quote(portLabel(match[1], descriptor, 'inputs', catalog))}。请填写该输入。`
    match = message.match(/^unknown field\s+["']([^"']+)["']/iu)
    if (match) return `未知字段${quote(entryLabel(match[1]))}。请检查字段名称。`
    match = message.match(/^unsupported statement kind\s+["']([^"']+)["']/iu)
    if (match) return `不支持的语句类型${quote(match[1])}。请更换为编辑器支持的语句。`
    match = message.match(/^unsupported value type\s+["']([^"']+)["']/iu)
    if (match) return `不支持的值类型${quote(typeLabel(match[1]))}。请更换为编辑器支持的类型。`
    if (/^unsupported value type descriptor$/iu.test(message)) return '不支持的值类型描述。请使用编辑器支持的类型结构。'
    if (/^expected a plain object$/iu.test(message)) return '此处需要对象。请检查输入结构。'
    if (/^must be a non-empty string$/iu.test(message)) return '此处需要非空文本。请填写内容。'
    if (/^must be a boolean$/iu.test(message)) return '此处需要布尔值。请填写真或假。'
    if (/^graph\.body must be an array$/iu.test(message)) return '模块图的语句列表必须是数组。请检查模块图结构。'
    if (/^graph\.body\s+.*array/iu.test(message)) return '模块图的语句列表结构无效。请检查模块图结构。'
    if (/^type binding requires an input$/iu.test(message)) return '类型绑定需要一个输入。请填写输入后再编译。'
    match = message.match(/^([A-Za-z][\w.]*) must be an array$/iu)
    if (match) return `${entryLabel(match[1])}必须是列表。请检查数据结构。`
    match = message.match(/^([A-Za-z][\w.]*) must be a string$/iu)
    if (match) return `${entryLabel(match[1])}必须是文本。请检查数据结构。`
    match = message.match(/^([A-Za-z][\w.]*) must be a boolean$/iu)
    if (match) return `${entryLabel(match[1])}必须是布尔值。请检查数据结构。`
    if (/^universal value types are not allowed$/iu.test(message)) return '不允许使用任意值类型。请改用明确的类型。'
    if (/^field type binding parameter must be a string parameter$/iu.test(message)) return '字段类型绑定参数必须是文本参数。请检查参数声明。'
    if (/^module is not allowed on\s+/iu.test(message)) return message.replace(/^module is not allowed on\s+(.+)$/iu, (_all, surface) => `该模块不支持${entryLabel(surface)}内容类型。请更换模块或内容类型。`)
    return null
  }

  function compilerCoverageMessage(message, code, catalog, descriptor) {
    let match
    const text = String(message || '')
    const named = value => quote(portLabel(value, descriptor, 'inputs', catalog))
    const parameter = value => quote(portLabel(value, descriptor, 'parameters', catalog))
    const output = value => quote(portLabel(value, descriptor, 'outputs', catalog))

    if (/^symbol keys are not allowed$/iu.test(text)) return '不能使用符号键。请只使用可保存的文本键。'
    if (/^accessor properties are not allowed$/iu.test(text)) return '不能使用访问器属性。请填写普通数据值。'
    if (/^non-enumerable properties are not allowed$/iu.test(text)) return '不能使用不可枚举属性。请填写普通数据字段。'
    if (/^lone surrogate is not allowed$/iu.test(text)) return '文本包含无效的孤立代理字符。请重新输入该文本。'
    if (/^numbers must be finite$/iu.test(text)) return '数字必须是有限数值。请检查输入数值。'
    if (/^functions and non-JSON values are not allowed$/iu.test(text)) return '不能保存函数或非 JSON 值。请使用文本、数字、布尔值、列表或对象。'
    if (/^array properties are not allowed$/iu.test(text)) return '数组不能包含额外属性。请只保留数组项。'
    if (/^sparse arrays are not allowed$/iu.test(text)) return '数组不能有空缺项。请补齐数组中的每一项。'
    match = text.match(/^unsafe (?:name|object key)\s+["']([^"']+)["']/iu)
    if (match) return `名称${named(match[1])}不能使用系统保留字。请换一个名称。`
    if (/^literal cannot be serialized$/iu.test(text)) return '字面值无法保存。请使用可序列化的 JSON 值。'
    if (/^structured literal requires a registered record schema$/iu.test(text)) return '结构化字面值需要已注册的记录结构。请先声明记录结构。'
    if (/^literal budget exceeded$/iu.test(text)) return '字面值大小超过限制。请减少文本、字段或列表项。'
    if (/^literal requires value$/iu.test(text)) return '字面值必须填写值。请补充该值。'
    match = text.match(/^unsupported value kind\s+["']([^"']+)["']/iu)
    if (match) return `不支持的值种类${quote(match[1])}。请使用编辑器支持的值种类。`
    if (/^unsupported value type descriptor$/iu.test(text)) return '值类型描述无效。请使用编辑器支持的类型结构。'
    if (/^universal value types are not allowed$/iu.test(text)) return '不能使用任意值类型。请改用明确的类型。'
    match = text.match(/^unsupported value type\s+["']([^"']+)["']/iu)
    if (match) return `不支持的值类型${quote(typeLabel(match[1]))}。请改用编辑器支持的类型。`
    if (/^list type requires element$/iu.test(text)) return '列表类型需要指定元素类型。'
    if (/^set type requires element$/iu.test(text)) return '集合类型需要指定元素类型。'
    if (/^map type requires key and value$/iu.test(text)) return '映射类型需要指定键类型和值类型。'
    if (/^nullable type requires value$/iu.test(text)) return '可空类型需要指定内部类型。'
    if (/^ports must be an array$/iu.test(text)) return '端口列表必须是数组。请检查模块声明。'
    if (/^parameters must be an array$/iu.test(text)) return '参数列表必须是数组。请检查模块声明。'
    if (/^schemas must be an array$/iu.test(text)) return '记录结构列表必须是数组。请检查模块声明。'
    if (/^continuations must be an array or object map$/iu.test(text)) return '继续流程必须是列表或对象映射。请检查模块声明。'
    if (/^record schema requires fields$/iu.test(text)) return '记录结构必须声明字段。请补充字段列表。'
    if (/^graph\.composites must be an array$/iu.test(text)) return '模块图的组合模块列表必须是数组。请检查模块图结构。'
    if (/^host binding port name must match its key$/iu.test(text)) return '宿主绑定中的端口名称必须与字段名一致。请检查宿主绑定。'

    match = text.match(/^duplicate field type binding\s+["']([^"']+)["']/iu)
    if (match) return `字段类型绑定${quote(match[1])}重复。请只保留一个绑定。`
    match = text.match(/^duplicate (port|parameter|statement id|record schema|continuation|composite|input|field)\s+["']?([^"']+?)["']?$/iu)
    if (match) {
      const labels = { port: '端口', parameter: '参数', 'statement id': '语句编号', 'record schema': '记录结构', continuation: '继续流程', composite: '组合模块', input: '输入', field: '字段' }
      return `${labels[match[1].toLowerCase()] || '名称'}${quote(match[2])}重复。请只保留一个声明。`
    }
    if (/^duplicate (?:port|parameter|record schema|continuation|composite|input|field|statement id)/iu.test(text)) return '声明中存在重复项目。请删除重复项。'
    match = text.match(/^(.+?) must be an array$/iu)
    if (match) return `${entryLabel(match[1])}必须是列表。请检查数据结构。`
    match = text.match(/^(.+?) must be an array or object map$/iu)
    if (match) return `${entryLabel(match[1])}必须是列表或对象映射。`
    match = text.match(/^(.+?) must be a non-empty array$/iu)
    if (match) return `${entryLabel(match[1])}必须是非空列表。请至少填写一项。`
    match = text.match(/^(.+?) requires fields$/iu)
    if (match) return `${entryLabel(match[1])}必须声明字段。请补充字段列表。`
    match = text.match(/^(.+?) must be a finite number$/iu)
    if (match) return `${entryLabel(match[1])}必须是有限数字。`
    match = text.match(/^(.+?) must be a positive integer$/iu)
    if (match) return `${entryLabel(match[1])}必须是正整数。`
    if (/^expected a plain object$/iu.test(text)) return '此处需要对象。请检查模块图结构。'
    if (/^must be a non-empty string$/iu.test(text)) return '此处需要非空文本。请填写内容。'
    if (/^must be a boolean$/iu.test(text)) return '此处需要布尔值。请填写真或假。'
    if (/^body must be an array$/iu.test(text)) return '语句体必须是数组。请检查模块图结构。'
    if (/^continuation redeclares a record schema with different fields$/iu.test(text)) return '继续流程重新声明了字段不同的记录结构。请统一记录结构定义。'
    if (/^descriptor redeclares a record schema with different fields$/iu.test(text)) return '模块描述重新声明了字段不同的记录结构。请统一记录结构定义。'

    match = text.match(/^default expects\s+(.+?),\s+got\s+(.+)$/iu)
    if (match) return `默认值需要${typeLabel(match[1])}，当前是${typeLabel(match[2])}。请修改默认值。`
    match = text.match(/^enum value expects\s+(.+?),\s+got\s+(.+)$/iu)
    if (match) return `枚举值需要${typeLabel(match[1])}，当前是${typeLabel(match[2])}。请修改枚举值。`
    match = text.match(/^default is outside its enum$/iu)
    if (match) return '默认值不在允许的枚举选项中。请改用枚举中的值。'
    match = text.match(/^default is below minimum$/iu)
    if (match) return '默认值低于允许的最小值。请调大默认值。'
    match = text.match(/^default is above maximum$/iu)
    if (match) return '默认值高于允许的最大值。请调小默认值。'
    match = text.match(/^parameter\s+["']([^"']+)["']\s+is outside its enum$/iu)
    if (match) return `参数${parameter(match[1])}的值不在允许的枚举选项中。`
    match = text.match(/^parameter\s+["']([^"']+)["']\s+is below minimum$/iu)
    if (match) return `参数${parameter(match[1])}低于允许的最小值。`
    match = text.match(/^parameter\s+["']([^"']+)["']\s+is above maximum$/iu)
    if (match) return `参数${parameter(match[1])}高于允许的最大值。`
    if (/^minimum cannot exceed maximum$/iu.test(text)) return '最小值不能大于最大值。请调整参数范围。'
    match = text.match(/^parameter\s+["']([^"']+)["']\s+expects\s+(.+?),\s+got\s+(.+)$/iu)
    if (match) return `参数${parameter(match[1])}需要${typeLabel(match[2])}，当前是${typeLabel(match[3])}。`
    match = text.match(/^missing parameter\s+["']([^"']+)["']/iu)
    if (match) return `缺少参数${parameter(match[1])}。请填写该参数或确认它应为可选项。`
    match = text.match(/^unknown parameter\s+["']([^"']+)["']/iu)
    if (match) return `未知参数${parameter(match[1])}。请检查参数名称。`
    if (/^parameters must be an array$/iu.test(text)) return '参数列表必须是数组。请检查模块声明。'
    if (/^enum must be an array$/iu.test(text)) return '枚举选项必须是列表。请检查参数配置。'

    match = text.match(/^inspectReferences names unknown input\s+["']([^"']+)["']/iu)
    if (match) return `引用检查使用了不存在的输入${named(match[1])}。请检查输入名称。`
    match = text.match(/^livingReferences names unknown input\s+["']([^"']+)["']/iu)
    if (match) return `存活引用使用了不存在的输入${named(match[1])}。请检查输入名称。`
    match = text.match(/^inspectReferences input\s+["']([^"']+)["'] must be a piece or player reference or a trusted value binding$/iu)
    if (match) return `引用检查输入${named(match[1])}必须是棋子、玩家引用或受信任值绑定。`
    match = text.match(/^livingReferences input\s+["']([^"']+)["'] must be a piece reference$/iu)
    if (match) return `存活引用输入${named(match[1])}必须是棋子引用。`
    if (/^inspectReferences must be an array$/iu.test(text)) return '引用检查列表必须是数组。'
    if (/^livingReferences must be an array$/iu.test(text)) return '存活引用列表必须是数组。'
    if (/^duplicate inspected input/iu.test(text)) return '引用检查列表中有重复输入。请删除重复项。'
    if (/^duplicate living input/iu.test(text)) return '存活引用列表中有重复输入。请删除重复项。'

    if (/^field type binding must name an output port$/iu.test(text)) return '字段类型绑定必须指定输出端口。请检查输出名称。'
    if (/^field type binding parameter must be a string parameter$/iu.test(text)) return '字段类型绑定参数必须是文本参数。请检查参数声明。'
    if (/^field type binding requires at least one field$/iu.test(text)) return '字段类型绑定至少需要一个字段。请补充字段映射。'
    if (/^field type binding parameter must select a string field$/iu.test(text)) return '字段类型绑定参数必须选择文本字段。请检查参数值。'
    if (/^field type does not match its output declaration$/iu.test(text)) return '字段类型与输出声明不匹配。请检查类型绑定。'
    if (/^inferred output type does not match its declaration$/iu.test(text)) return '推导出的输出类型与声明不匹配。请检查类型绑定。'
    if (/^type binding requires an input$/iu.test(text)) return '类型绑定需要一个输入。请补充输入绑定。'
    if (/^element type binding requires a collection$/iu.test(text)) return '元素类型绑定需要列表或其他集合输入。'
    if (/^duplicate field type binding/iu.test(text)) return '字段类型绑定中有重复字段。请删除重复绑定。'

    match = text.match(/^unsupported collection method\s+["']([^"']+)["']/iu)
    if (match) return `不支持集合方法${quote(collectionMethodLabel(match[1]))}。请使用编辑器支持的集合方法。`
    if (/^collection discriminator conflicts with method fields$/iu.test(text)) return '集合类型标识与方法字段冲突。请只保留一种集合声明方式。'
    if (/^map\/filter collections cannot declare accumulator or initial$/iu.test(text)) return '映射或筛选集合不能声明累加器或初始值。'
    if (/^collection\.body must be an array$/iu.test(text)) return '集合处理体必须是语句列表。'
    if (/^collection items must be a list$/iu.test(text)) return '集合项目必须是列表。请提供列表值。'
    if (/^while\.condition\.body must be an array$/iu.test(text)) return '循环条件体必须是语句列表。'
    if (/^while\.body must be an array$/iu.test(text)) return '循环体必须是语句列表。'
    if (/^if\.then must be an array$/iu.test(text)) return '“如果”分支必须是语句列表。'
    if (/^if\.else must be an array$/iu.test(text)) return '“否则”分支必须是语句列表。'
    if (/^foreach\.body must be an array$/iu.test(text)) return '遍历体必须是语句列表。'
    if (/^foreach items must be a list$/iu.test(text)) return '遍历项目必须是列表。请提供列表值。'
    if (/^unsupported statement kind\s+["']([^"']+)["']/iu.test(text)) {
      match = text.match(/^unsupported statement kind\s+["']([^"']+)["']/iu)
      return `不支持语句类型${quote(statementKindLabel(match[1]))}。请更换为编辑器支持的语句。`
    }
    if (/^nested presentation groups are not supported$/iu.test(text)) return '表现分组不能嵌套。请将表现分组移到当前语句层级。'
    if (/^unknown presentation batch kind$/iu.test(text)) return '未知的表现批次类型。请重新选择表现类型。'
    if (/^defer-choice cannot contain both min and minSelections$/iu.test(text)) return '选择等待不能同时设置最小数量和最小选择数。请只保留一个字段。'
    if (/^defer-choice cannot contain both max and maxSelections$/iu.test(text)) return '选择等待不能同时设置最大数量和最大选择数。请只保留一个字段。'
    if (/^return cannot contain both values and value$/iu.test(text)) return '返回语句不能同时设置多个返回值和单个返回值。请只保留一种形式。'
    if (/^scalar return requires exactly one declared output$/iu.test(text)) return '单值返回必须正好声明一个输出。'
    if (/^return must provide all declared outputs$/iu.test(text)) return '返回语句必须提供所有必需输出。'
    if (/^collection body return must provide one scalar value$/iu.test(text)) return '集合处理体必须返回一个单值。'
    if (/^collection body must return a typed value$/iu.test(text)) return '集合处理体必须返回有明确类型的值。'
    if (/^while condition can fall through without returning a boolean$/iu.test(text)) return '循环条件存在不返回布尔值的路径。请确保每条路径都返回条件结果。'
    if (/^while condition must return a boolean$/iu.test(text)) return '循环条件必须返回布尔值。'
    if (/^if condition must be boolean$/iu.test(text)) return '“如果”条件必须是布尔值。请提供真或假条件。'
    if (/^while\.budget must be a positive safe integer$/iu.test(text)) return '循环预算必须是正的安全整数。请检查循环配置。'
    if (/^collection body returns inconsistent types$/iu.test(text)) return '集合处理体的不同返回路径类型不一致。'
    if (/^(?:filter|find) body must return boolean$/iu.test(text)) return '筛选条件必须返回布尔值。'
    if (/^reduce body must return the accumulator type$/iu.test(text)) return '归并处理体必须返回与累加器相同的类型。'
    if (/^collection local names must be distinct$/iu.test(text)) return '集合局部名称必须互不相同。请修改项目、序号或累加器名称。'
    if (/^collection capture shadows a local input$/iu.test(text)) return '集合捕获名称不能覆盖局部输入名称。请修改捕获名称。'
    if (/^while index shadows an input$/iu.test(text)) return '循环序号名称不能覆盖输入名称。请修改序号名称。'
    if (/^(?:foreach item|foreach index) shadows an input$/iu.test(text)) return '遍历局部名称不能覆盖输入名称。请修改局部名称。'

    match = text.match(/^unsupported surface\s+["']([^"']+)["']/iu)
    if (match) return `不支持内容类型${quote(entryLabel(match[1]))}。请使用技能、卡牌、规则或编辑器支持的其他类型。`
    if (/^allowedSurfaces must be a non-empty array$/iu.test(text)) return '适用内容类型必须是非空列表。请至少选择一种内容类型。'
    if (/^duplicate surface/iu.test(text)) return '适用内容类型不能重复。请删除重复项。'
    if (/^composite parameters are not supported; use typed inputs$/iu.test(text)) return '组合模块不支持参数，请改用有类型的输入。'
    if (/^hostBindings are only available on pending graphs$/iu.test(text)) return '宿主绑定只能用于待处理流程。请切换流程类型或移除宿主绑定。'
    if (/^module is not allowed on\s+(.+)$/iu.test(text)) {
      match = text.match(/^module is not allowed on\s+(.+)$/iu)
      return `该模块不支持${entryLabel(match[1])}内容类型。请更换模块或内容类型。`
    }
    if (/^composite is not allowed on\s+(.+)$/iu.test(text)) {
      match = text.match(/^composite is not allowed on\s+(.+)$/iu)
      return `该组合模块不支持${entryLabel(match[1])}内容类型。请更换组合模块或内容类型。`
    }
    if (/^module has effects forbidden in preview$/iu.test(text)) return '预览流程不能执行有副作用的模块。请改用预览安全模块。'
    if (/^presentation groups currently require a skill surface$/iu.test(text)) return '表现分组目前只能用于技能流程。'
    if (/^collection body cannot suspend into a pending choice$/iu.test(text)) return '集合处理体不能暂停到待处理选择。请将选择移到集合外。'
    if (/^defer-choice is not allowed on preview graphs$/iu.test(text)) return '预览流程不能使用待处理选择。'
    if (/^presentation group cannot return or suspend$/iu.test(text)) return '表现分组不能返回结果或暂停流程。'
    if (/^defer-choice cannot be nested in a composite or collection body$/iu.test(text)) return '待处理选择不能嵌套在组合模块或集合处理体中。'

    match = text.match(/^reserved root input name$/iu)
    if (match) return '根输入名称不能使用系统保留名称。请换一个名称。'
    if (/^root inputs require static inputBindings$/iu.test(text)) return '根输入必须配置静态输入绑定。请补充输入绑定。'
    if (/^root input requires a static binding or fixed preview host name$/iu.test(text)) return '根输入需要静态绑定，或需要固定的预览宿主名称。'
    if (/^pending root input requires a fixed host binding or static binding$/iu.test(text)) return '待处理流程的根输入需要固定宿主绑定或静态绑定。'
    if (/^pending host input cannot have a static binding$/iu.test(text)) return '待处理流程的宿主输入不能同时设置静态绑定。'
    if (/^pending host input\s+["']([^"']+)["'] has an incompatible type$/iu.test(text)) {
      match = text.match(/^pending host input\s+["']([^"']+)["'] has an incompatible type$/iu)
      return `待处理宿主输入${named(match[1])}的类型不匹配。请检查宿主声明。`
    }
    if (/^preview host input\s+["']([^"']+)["'] has an incompatible type$/iu.test(text)) {
      match = text.match(/^preview host input\s+["']([^"']+)["'] has an incompatible type$/iu)
      return `预览宿主输入${named(match[1])}的类型不匹配。请检查预览宿主类型。`
    }
    if (/^root input is not statically bound$/iu.test(text)) return '根输入没有静态绑定。请检查输入绑定。'
    if (/^unknown root input binding\s+["']([^"']+)["']/iu.test(text)) {
      match = text.match(/^unknown root input binding\s+["']([^"']+)["']/iu)
      return `未知根输入绑定${named(match[1])}。请检查输入声明。`
    }
    if (/^pending payload host binding must be a typed record$/iu.test(text)) return '待处理载荷宿主绑定必须是有明确结构的记录。'
    if (/^unsupported pending host binding\s+["']([^"']+)["']/iu.test(text)) {
      match = text.match(/^unsupported pending host binding\s+["']([^"']+)["']/iu)
      return `不支持的待处理宿主绑定${named(match[1])}。请检查宿主绑定名称。`
    }
    if (/^pending host binding\s+["']([^"']+)["'] has the wrong type$/iu.test(text)) {
      match = text.match(/^pending host binding\s+["']([^"']+)["'] has the wrong type$/iu)
      return `待处理宿主绑定${named(match[1])}的类型不正确。请检查宿主声明。`
    }
    if (/^pending minimum cannot exceed maximum$/iu.test(text)) return '待处理选择的最小数量不能大于最大数量。请调整选择范围。'
    if (/^targetType must be piece, cell, or grid$/iu.test(text)) return '目标类型必须是棋子、地格或棋盘。请检查待处理选择配置。'
    if (/^range must be a finite non-negative number$/iu.test(text)) return '范围必须是有限的非负数字。请检查待处理选择配置。'
    if (/^filter must be enemy, ally, or all$/iu.test(text)) return '筛选条件必须是敌方、友方或全部。请检查待处理选择配置。'
    if (/^selectionMode must be single or multi$/iu.test(text)) return '选择模式必须是单选或多选。请检查待处理选择配置。'
    if (/^selection bounds must be non-negative integers$/iu.test(text)) return '选择数量范围必须是非负整数。请检查待处理选择配置。'

    match = text.match(/^unknown graph output\s+["']([^"']+)["']/iu)
    if (match) return `未知图输出${output(match[1])}。请检查输出声明。`
    if (/^output is not in scope during code generation$/iu.test(text)) return '代码生成时找不到该输出的作用域。请检查节点顺序和分支返回。'
    if (/^output is not in scope or does not dominate this statement$/iu.test(text)) return '该输出不在当前语句作用域内，或当前语句不能保证它已生成。请检查节点顺序和分支。'
    if (/^unknown output port$/iu.test(text)) return '未知输出端口。请检查节点和输出端口名称。'
    if (/^return output\s+["']([^"']+)["'] expects\s+(.+?),\s+got\s+(.+)$/iu.test(text)) {
      match = text.match(/^return output\s+["']([^"']+)["'] expects\s+(.+?),\s+got\s+(.+)$/iu)
      return `返回输出${output(match[1])}需要${typeLabel(match[2])}，当前是${typeLabel(match[3])}。`
    }
    if (/^return value expects\s+(.+?),\s+got\s+(.+)$/iu.test(text)) {
      match = text.match(/^return value expects\s+(.+?),\s+got\s+(.+)$/iu)
      return `返回值需要${typeLabel(match[1])}，当前是${typeLabel(match[2])}。`
    }

    if (/^record\.get requires a typed record$/iu.test(text)) return '读取记录字段需要有明确结构的记录。请先声明或绑定记录结构。'
    if (/^record\.with requires a typed record$/iu.test(text)) return '修改记录字段需要有明确结构的记录。请先声明或绑定记录结构。'
    if (/^continuation payload must be a typed record$/iu.test(text)) return '继续流程载荷必须是有明确结构的记录。'
    if (/^continuation payload type mismatch$/iu.test(text)) return '继续流程载荷类型不匹配。请检查载荷结构。'
    if (/^continuation payload type does not match pending payload host binding$/iu.test(text)) return '继续流程载荷与待处理宿主绑定的类型不匹配。'
    if (/^continuation requires a pending graph$/iu.test(text)) return '继续流程必须引用待处理流程图。'
    if (/^continuation cannot contain both payloadType and payload$/iu.test(text)) return '继续流程不能同时声明载荷类型和载荷内容。请只保留一种载荷声明。'
    if (/^continuation graph must use the pending surface$/iu.test(text)) return '继续流程图必须使用待处理流程类型。'
    if (/^unknown continuation graph\s+["']([^"']+)["']/iu.test(text)) {
      match = text.match(/^unknown continuation graph\s+["']([^"']+)["']/iu)
      return `未知继续流程${quote(match[1])}。请检查继续流程名称和版本。`
    }
    if (/^continuation graph id is ambiguous; use id@version$/iu.test(text)) return '继续流程名称对应多个版本，请使用“名称@版本”明确指定版本。'
    if (/^continuation graph cycle detected$/iu.test(text)) return '继续流程存在循环引用。请移除循环依赖。'
    if (/^continuation graph can fall through without returning its required outputs$/iu.test(text)) return '继续流程图可能没有返回必需的输出。请检查所有分支是否都返回结果。'
    if (/^composite cycle detected$/iu.test(text)) return '组合模块存在循环引用。请移除循环依赖。'
    if (/^composite expansion depth exceeded$/iu.test(text)) return '组合模块嵌套层级超过限制。请减少组合模块嵌套。'
    if (/^composite can fall through without returning its required outputs$/iu.test(text)) return '组合模块存在没有返回必需输出的路径。请检查所有分支。'
    if (/^module call budget exceeded$/iu.test(text)) return '模块调用次数超过限制。请减少模块调用或组合嵌套。'
    if (/^statement budget exceeded$/iu.test(text)) return '语句数量超过限制。请减少语句或拆分模块图。'
    if (/^collection iteration budget exceeded$/iu.test(text)) return '集合迭代次数超过限制。请减少集合大小或迭代次数。'
    if (/^while iteration budget exceeded$/iu.test(text)) return '循环迭代次数超过限制。请检查循环条件或预算。'
    if (/^collection body cannot call effectful module\s+["']([^"']+)["']/iu.test(text)) {
      match = text.match(/^collection body cannot call effectful module\s+["']([^"']+)["']/iu)
      return `集合处理体不能调用有副作用的模块${quote(moduleLabel(match[1], catalog))}。请移除该调用。`
    }
    if (/^inferred output type does not match its declaration$/iu.test(text)) return '推导出的输出类型与声明不匹配。请检查类型绑定。'
    if (/^module is ambiguous$/iu.test(text)) return '模块名称同时匹配多个模块。请使用明确的模块版本。'

    if (/^registry returned an invalid descriptor$/iu.test(text)) return '模块目录返回了无效模块描述。请重新加载模块目录。'
    match = text.match(/^registry descriptor is missing\s+(.+)$/iu)
    if (match) return `模块目录缺少必需的${entryLabel(match[1])}。请检查模块目录定义。`
    if (/^registry descriptor does not match requested module$/iu.test(text)) return '模块目录返回的模块与请求不匹配。请重新加载模块目录。'
    if (/^registry must expose get, resolve, descriptors, or Map lookup$/iu.test(text)) return '模块目录没有提供可用的查找接口。请检查模块目录。'
    if (/^registry descriptor lower must be a function$/iu.test(text)) return '模块目录的生成器无效。请联系开发者检查模块定义。'
    if (/^universal input types are not allowed$/iu.test(text)) return '模块输入不能使用任意类型。请声明明确的输入类型。'
    if (/^unbound universal output types are not allowed$/iu.test(text)) return '模块输出的任意类型没有绑定具体类型。请补充输出类型绑定。'
    if (/^an input cannot be listed in both livingReferences and inspectReferences$/iu.test(text)) return '同一个输入不能同时列为存活引用和引用检查项。请只保留一种声明。'
    if (/^type binding must name an output and a required input$/iu.test(text)) return '类型绑定必须指定输出和必需输入。请检查绑定配置。'
    if (/^unknown type binding projection$/iu.test(text)) return '未知类型绑定投影方式。请重新选择投影方式。'
    if (/^schema binding must name a port and a string parameter$/iu.test(text)) return '结构绑定必须指定端口和文本参数。请检查绑定配置。'
    if (/^value type binding must name a port and a string parameter$/iu.test(text)) return '值类型绑定必须指定端口和文本参数。请检查绑定配置。'
    if (/^nullable binding must be boolean$/iu.test(text)) return '可空绑定必须是布尔值。'
    if (/^compiler option must be a positive integer$/iu.test(text)) return '编译器选项必须是正整数。请检查编译器设置。'
    if (/^unknown compiler option$/iu.test(text)) return '未知编译器选项。请删除不支持的选项。'

    if (/^missing collection call metadata$/iu.test(text)) return '缺少集合调用元数据。请重新生成模块图。'
    if (/^missing call metadata$/iu.test(text)) return '缺少模块调用元数据。请重新生成模块图。'
    if (/^native lowering returned empty source$/iu.test(text)) return '模块生成器返回了空代码。请检查模块定义。'
    if (/^native lowering returned empty expression$/iu.test(text)) return '模块生成器返回了空表达式。请检查模块定义。'
    if (/^native lowering returned empty statements$/iu.test(text)) return '模块生成器返回了空语句。请检查模块定义。'
    if (/^native lowering returned an invalid result$/iu.test(text)) return '模块生成器返回了无效结果。请检查模块定义。'
    if (/^native lowering failed:/iu.test(text)) return '模块生成失败：该模块的输入、参数或生成结果不符合要求。请根据当前位置检查模块定义。'
    if (/^internal error$/iu.test(text)) return '模块编译遇到内部诊断。请复制完整诊断供排查。'

    if (code && own(CODE_LABELS, code)) return `${CODE_LABELS[code]}。请根据当前位置检查模块图。`
    return null
  }

  function diagnosticCode(data) {
    if (data.code) return data.code
    if (data.name === 'AuthorExpressionError') return 'AUTHOR_EXPRESSION'
    if (/^Gameplay module document:/iu.test(data.message)) return 'GAMEPLAY_MODULE_DOCUMENT'
    return 'UNKNOWN'
  }

  function containsChinese(text) {
    return /[\u3400-\u9fff]/u.test(String(text || ''))
  }

  function containsUntranslatedEnglish(text) {
    return /(?<![A-Za-z0-9_$\.])(?:Gameplay|module|document|missing|unknown|invalid|unsupported|must|expects|got|parameter|input|output|record|schema|native|lowering|returned|result|failed|needs|attention|error|cannot|does|not|is|are|requires|value|type|source|statement|compiler|diagnostic)(?![A-Za-z0-9_$])/iu.test(String(text || ''))
  }

  function unknownMessage(data) {
    if (data.name === 'AuthorExpressionError') return data.message
    if (containsChinese(data.message) && !containsUntranslatedEnglish(data.message)) return data.message
    const code = diagnosticCode(data)
    const label = own(CODE_LABELS, code) ? CODE_LABELS[code] : '未识别错误'
    return `模块诊断：${label}。请根据当前位置检查模块图；如需排查，请复制完整诊断。（诊断编号：${code}）`
  }

  function formatDetailed(error, catalog) {
    const data = normalizeError(error)
    const descriptorInfo = moduleFromMessage(data.message, catalog)
    if (!descriptorInfo.descriptor) descriptorInfo.descriptor = defaultDescriptor(catalog)
    let localized = documentMessage(data.message)
    if (!localized) localized = compilerMessage(data.message, data.code, catalog, descriptorInfo.descriptor)
    if (!localized) localized = compilerCoverageMessage(data.message, data.code, catalog, descriptorInfo.descriptor)
    if (!localized) localized = genericMessage(data.message, catalog, descriptorInfo.descriptor)
    const preservedChinese = !localized && (data.name === 'AuthorExpressionError' || (containsChinese(data.message) && !containsUntranslatedEnglish(data.message)))
    const usedFallback = !localized && !preservedChinese
    if (!localized) localized = unknownMessage(data)
    const text = appendLocation(localized, data.path, descriptorInfo.descriptor, catalog)
    const code = diagnosticCode(data)
    const metadata = [`诊断编号：${code}`, data.path ? `原始位置：${data.path}` : ''].filter(Boolean).join('\n')
    return Object.freeze({
      text,
      copyText: metadata ? `${metadata}\n${data.original}` : data.original,
      code,
      path: data.path,
      localized: !usedFallback,
    })
  }

  function format(error, catalog) {
    return formatDetailed(error, catalog).text
  }

  const coverage = Object.freeze({
    supportedCodes: SUPPORTED_CODES,
    remainingGaps: REMAINING_GAPS,
  })
  const api = Object.freeze({ format, formatDetailed, coverage })
  const root = typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null
  if (root) root.AuthorDiagnostics = api
})()
