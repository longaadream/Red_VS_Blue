/*
 * Generic author-facing editor for recursive values.
 *
 * The control deliberately knows nothing about a particular game object.  A
 * caller supplies a type or a schema registry and receives the same JSON
 * value back.  Presence is tracked separately from the value so omitted,
 * explicit null, zero, false, and empty containers survive an edit.
 */
(() => {
  'use strict'

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
  const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  const clone = value => {
    if (value === undefined) return undefined
    try { return JSON.parse(JSON.stringify(value)) } catch { return value }
  }
  const node = (tag, text, className) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined && text !== null) element.textContent = String(text)
    return element
  }
  const action = (text, handler, className = 'author-object-editor-action') => {
    const button = node('button', text, className)
    button.type = 'button'
    button.onclick = handler
    return button
  }

  const keyLabels = Object.freeze({
    id: '标识', type: '类型', name: '名称', description: '说明', value: '值', values: '取值',
    amount: '数量', count: '数量', source: '来源', target: '目标', owner: '归属对象', piece: '棋子', player: '玩家',
    fields: '字段', template: '棋子模板', display: '显示内容', extension: '扩展字段', destination: '目标地格',
    visible: '是否可见', description: '说明', duration: '持续时间', turns: '回合数', stacks: '层数', intensity: '强度',
    attack: '攻击力', defense: '防御力', moveRange: '移动范围', currentHp: '当前生命', maxHp: '最大生命',
    x: '横坐标', y: '纵坐标', faction: '阵营', momentum: '动量', shield: '护盾', skills: '技能列表',
    statusTags: '状态列表', rules: '规则列表', isCore: '核心棋子', result: '结果', mode: '方式', recipe: '配方',
    audiences: '可见对象', public: '公开', allies: '友方', enemies: '敌方', spectators: '观战者',
    identity: '身份', snapshot: '实例副本', baseSnapshot: '基础副本', flowState: '流程状态', schemaVersion: '版本',
    sourcePieceId: '来源棋子', kind: '类型', attribute: '属性', multiplier: '倍率', damage: '伤害', heal: '治疗',
    ownerPlayerId: '所属玩家', instanceId: '实例标识', templateId: '模板标识', sourceId: '来源标识', skillId: '技能标识',
    actionPoints: '行动点', chargePoints: '充能点', maxActionPoints: '行动点上限', maxUses: '最大次数',
    currentDuration: '当前持续时间', remainingDuration: '剩余持续时间', currentUses: '当前次数', remainingUses: '剩余次数',
    currentCooldown: '当前冷却', cooldown: '冷却', level: '等级', value: '值', values: '值列表', items: '项目列表',
    amountType: '数量类型', templateType: '模板类型', displayType: '显示类型', sourceType: '来源类型', targetType: '目标类型',
    destinationType: '目标地格类型', audience: '可见对象', stacking: '叠加方式', lifetime: '生命周期', iconPath: '图标路径',
  })
  const typeLabels = Object.freeze({
    string: '文本', text: '文本', number: '数字', integer: '整数', boolean: '布尔值',
    null: '空值', any: '任意值', unknown: '未指定类型', object: '对象', record: '记录',
    json: '任意数据',
    array: '列表', list: '列表', set: '集合', map: '映射', enum: '选项', cell: '地格', piece: '棋子', player: '玩家',
    status: '状态', card: '卡牌', skill: '技能', rule: '规则', extension: '扩展字段',
  })
  const AUTHOR_MAP_FORMAT = 'author-map/v1'
  const AUTHOR_SET_FORMAT = 'author-set/v1'
  const enumLabels = Object.freeze({
    teleport: '传送', dash: '冲刺', walk: '步行', push: '推动', pull: '拉拽', swap: '交换',
    walkable: '可通行', projectile: '弹道', any: '任意', current: '沿用当前归属',
    unattributed: '无技能归属', active: '主动', passive: '被动',
    replace: '替换', merge: '合并', append: '追加', remove: '移除',
    new: '新建', existing: '已有', self: '自身', enemy: '敌人', ally: '友军', all: '任意对象',
    'new-instance': '新建棋子', 'return-instance': '原实例回场', declaration: '使用当前内容声明',
    public: '公开', owner: '所属玩家', allies: '友方', enemies: '敌方', spectators: '观战者',
    red: '红方', blue: '蓝方', neutral: '中立', good: '善方', evil: '恶方', light: '光明', dark: '黑暗',
  })

  function humanKey(key) {
    if (keyLabels[key]) return keyLabels[key]
    const text = String(key || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
    return text ? `字段「${text}」` : '字段'
  }

  function typeKind(type) {
    if (record(type)) {
      if (type.kind === 'nullable') return 'nullable'
      if (type.kind === 'set') return 'set'
      if (type.kind === 'list' || type.kind === 'array') return 'list'
      if (type.kind === 'record' || type.kind === 'object') return 'record'
      if (type.kind === 'map') return 'map'
      if (type.kind === 'enum') return 'enum'
      if (type.kind === 'json') return 'json'
      if (type.type) return typeKind(type.type)
    }
    if (type === 'array') return 'list'
    if (type === 'set') return 'set'
    if (type === 'map') return 'map'
    if (type === 'object' || type === 'record') return 'record'
    if (type === 'integer') return 'number'
    return typeof type === 'string' ? type : 'unknown'
  }

  function typeLabel(type, metadata = {}) {
    if (metadata?.label) return String(metadata.label)
    if (record(type)) {
      if (type.label) return String(type.label)
      if (type.kind === 'record' && type.schema) {
        const schema = resolveSchema(type.schema, metadata)
        if (schema?.label || schema?.name) return String(schema.label || schema.name)
      }
      if (type.kind === 'nullable') return `${typeLabel(type.value, metadata)}（可为空）`
      if (type.kind === 'set') return `集合 · ${typeLabel(type.element, metadata)}`
      if (type.kind === 'list' || type.kind === 'array') return `列表 · ${typeLabel(type.element, metadata)}`
      if (type.kind === 'map') return `映射 · ${typeLabel(type.value, metadata)}`
      if (type.kind === 'enum') return '选项'
    }
    return typeLabels[typeKind(type)] || '值'
  }

  function schemaCandidates(root) {
    if (!root) return []
    if (Array.isArray(root)) return root
    if (Array.isArray(root.schemas)) return root.schemas
    if (record(root.schemas)) return Object.values(root.schemas)
    if (record(root)) return Object.values(root).filter(item => record(item) && Array.isArray(item.fields))
    return []
  }

  function resolveSchema(reference, options = {}) {
    if (record(reference) && Array.isArray(reference.fields)) return reference
    const ref = record(reference) ? (reference.schema || reference.id || reference.name) : reference
    if (!ref) return null
    const explicitVersion = String(ref).includes('@')
    const bareRef = String(ref).split('@')[0]
    const roots = [
      options.schemaRegistry,
      options.schemas,
      options.schemaCatalog,
      typeof window !== 'undefined' ? window.AuthorObjectSchemas : null,
      typeof window !== 'undefined' ? window.AuthoringSchemaRegistry : null,
    ]
    for (const root of roots) {
      if (!root) continue
      const candidates = schemaCandidates(root)
      const matchingCandidates = candidates.filter(schema => {
        const id = schema.id || schema.name || schema.key
        const versioned = schema.id && schema.version ? `${schema.id}@${schema.version}` : id
        return explicitVersion
          ? versioned === ref || schema.reference === ref
          : id === bareRef || schema.reference === ref
      })
      const matchingVersions = new Set(matchingCandidates.map(schema => {
        const id = schema.id || schema.name || schema.key
        return schema.id && schema.version ? `${schema.id}@${schema.version}` : id
      }))
      // A bare reference must not silently choose one version when the
      // registry exposes several versions of the same schema.
      if (!explicitVersion && matchingVersions.size > 1) continue
      const keys = explicitVersion ? [ref] : [bareRef]
      for (const key of keys) {
        if (typeof root.resolve === 'function') {
          try {
            const resolved = root.resolve(key, options)
            if (record(resolved) && Array.isArray(resolved.fields)) {
              const id = resolved.id || resolved.name || resolved.key
              const versioned = resolved.id && resolved.version ? `${resolved.id}@${resolved.version}` : id
              if (!explicitVersion || versioned === ref || resolved.reference === ref) return resolved
            }
          } catch { /* metadata providers are optional */ }
        }
        if (typeof root.get === 'function') {
          try {
            const resolved = root.get(key)
            if (record(resolved) && Array.isArray(resolved.fields)) {
              const id = resolved.id || resolved.name || resolved.key
              const versioned = resolved.id && resolved.version ? `${resolved.id}@${resolved.version}` : id
              if (!explicitVersion || versioned === ref || resolved.reference === ref) return resolved
            }
          } catch { /* metadata providers are optional */ }
        }
        if (record(root) && record(root[key]) && Array.isArray(root[key].fields)) return root[key]
      }
      if (matchingVersions.size === 1) return matchingCandidates[0]
    }
    return null
  }

  function schemaResolutionIssue(reference, options = {}) {
    const ref = record(reference) ? (reference.schema || reference.id || reference.name) : reference
    if (!ref) return null
    const explicitVersion = String(ref).includes('@')
    const bareRef = String(ref).split('@')[0]
    const roots = [
      options.schemaRegistry,
      options.schemas,
      options.schemaCatalog,
      typeof window !== 'undefined' ? window.AuthorObjectSchemas : null,
      typeof window !== 'undefined' ? window.AuthoringSchemaRegistry : null,
    ]
    const matches = new Set()
    for (const root of roots) {
      for (const schema of schemaCandidates(root)) {
        const id = schema.id || schema.name || schema.key
        const versioned = schema.id && schema.version ? `${schema.id}@${schema.version}` : id
        if (explicitVersion ? versioned === ref || schema.reference === ref : id === bareRef || schema.reference === ref) matches.add(versioned || schema.reference)
      }
    }
    if (!explicitVersion && matches.size > 1) return `记录结构版本不明确：${bareRef}`
    if (explicitVersion && matches.size === 0) return `找不到记录结构：${ref}`
    return null
  }

  function typeSchema(type, options) {
    if (record(type) && Array.isArray(type.fields)) return type
    if (record(type) && type.schema) return resolveSchema(type.schema, options)
    if (typeof type === 'string') return resolveSchema(type, options)
    return null
  }

  function descriptorType(definition) {
    if (!record(definition)) return definition
    if (definition.type !== undefined) return definition.type
    if (definition.kind) return definition
    return 'unknown'
  }

  function defaultValue(definition, options = {}, depth = 0) {
    if (depth > 12) return null
    if (record(definition) && own(definition, 'default')) return clone(definition.default)
    const type = descriptorType(definition)
    const kind = typeKind(type)
    if (kind === 'nullable') return null
    if (kind === 'list') return []
    if (kind === 'set') return { format: AUTHOR_SET_FORMAT, items: [] }
    if (kind === 'map') return { format: AUTHOR_MAP_FORMAT, entries: [] }
    if (kind === 'record') {
      const schema = typeSchema(type, options)
      const output = {}
      for (const field of Array.isArray(schema?.fields) ? schema.fields : []) {
        if (own(field, 'default')) output[field.name] = clone(field.default)
      }
      return output
    }
    if (kind === 'boolean') return false
    if (kind === 'number') return 0
    if (kind === 'string') return ''
    if (kind === 'null') return null
    if (kind === 'json') return {}
    if (kind === 'enum') return Array.isArray(type?.values) && type.values.length ? clone(type.values[0]) : null
    return null
  }

  function filledDefaultValue(definition, options = {}) {
    const type = descriptorType(definition)
    if (record(type) && type.kind === 'nullable') return defaultValue({ ...definition, type: type.value }, options)
    return defaultValue(definition, options)
  }

  function inferredType(value) {
    if (value === null) return 'null'
    if (Array.isArray(value)) return { kind: 'list', element: value.length ? inferredType(value[0]) : 'unknown' }
    if (record(value)) return 'record'
    if (typeof value === 'boolean') return 'boolean'
    if (typeof value === 'number') return 'number'
    if (typeof value === 'string') return 'string'
    return 'unknown'
  }

  function equalValue(left, right) {
    if (Object.is(left, right)) return true
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equalValue(item, right[index]))
    if (record(left) && record(right)) {
      const leftKeys = Object.keys(left)
      const rightKeys = Object.keys(right)
      return leftKeys.length === rightKeys.length && leftKeys.every(key => own(right, key) && equalValue(left[key], right[key]))
    }
    return false
  }

  function taggedCollection(value, format, property) {
    const label = property === 'entries' ? '映射' : '集合'
    if (!record(value)) throw new Error(`${label}数据必须是对象`)
    if (value.format !== format) throw new Error(`${label}格式无法识别`)
    if (!Array.isArray(value[property])) throw new Error(`${label}数据必须包含数组`)
    const keys = Object.keys(value)
    if (keys.length !== 2 || !keys.includes('format') || !keys.includes(property)) throw new Error(`${label}只能包含格式和项目数据`)
    return value[property]
  }

  function authorMapEntries(value) {
    const raw = taggedCollection(value, AUTHOR_MAP_FORMAT, 'entries')
    const entries = raw.map((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error(`映射第 ${index + 1} 项必须是键值二元组`)
      return [clone(entry[0]), clone(entry[1])]
    })
    for (let index = 0; index < entries.length; index += 1) {
      for (let previous = 0; previous < index; previous += 1) {
        if (equalValue(entries[previous][0], entries[index][0])) throw new Error(`映射键重复：第 ${index + 1} 项`)
      }
    }
    return entries
  }

  function authorSetItems(value) {
    const raw = taggedCollection(value, AUTHOR_SET_FORMAT, 'items')
    const items = raw.map(clone)
    for (let index = 0; index < items.length; index += 1) {
      for (let previous = 0; previous < index; previous += 1) {
        if (equalValue(items[previous], items[index])) throw new Error(`集合项目重复：第 ${index + 1} 项`)
      }
    }
    return items
  }

  function makeAuthorMap(entries) {
    return { format: AUTHOR_MAP_FORMAT, entries: entries.map(entry => [clone(entry[0]), clone(entry[1])]) }
  }

  function makeAuthorSet(items) {
    return { format: AUTHOR_SET_FORMAT, items: items.map(clone) }
  }

  function enumDisplay(value, definition, options = {}) {
    const labels = definition?.enumLabels || definition?.labels || options.enumLabels || {}
    if (record(labels) && labels[value]) return String(labels[value])
    if (enumLabels[value]) return enumLabels[value]
    // Custom enum values are author data. Keep their readable text when the
    // shared schema has no display metadata; registered builtins supply their
    // Chinese labels above or through `labels`.
    if (typeof value === 'string' && value.trim()) return value
    return `选项 ${String(Object.keys(labels).length + 1)}`
  }

  function valueState(value, definition, present, options) {
    void options
    if (!present) return { key: 'omitted', label: '未填写' }
    if (value === null) return { key: 'null', label: '空值' }
    const hasDefault = record(definition) && own(definition, 'default')
    if (hasDefault && equalValue(value, definition.default)) return { key: 'default', label: '默认值' }
    return { key: 'value', label: '已填写' }
  }

  function fieldLabel(field) {
    const provided = String(field?.label || field?.title || '').trim()
    if (provided && /[\u3400-\u9fff]/u.test(provided)) return provided
    return keyLabels[field?.name] || provided || humanKey(field?.name)
  }

  function normalizeField(field, name) {
    if (record(field)) return { ...field, name: field.name || name, type: field.type || field.valueType || 'unknown' }
    return { name, type: field || 'unknown' }
  }

  function schemaFields(schema) {
    return Array.isArray(schema?.fields)
      ? schema.fields.map(field => normalizeField(field, field?.name)).filter(field => field.name)
      : []
  }

  function schemaChoices(options) {
    const choices = []
    const roots = [options.schemaRegistry, options.schemas, options.schemaCatalog,
      typeof window !== 'undefined' ? window.AuthorObjectSchemas : null,
      typeof window !== 'undefined' ? window.AuthoringSchemaRegistry : null]
    for (const root of roots) {
      for (const schema of schemaCandidates(root)) {
        const id = schema.id ? `${schema.id}${schema.version ? `@${schema.version}` : ''}` : schema.name || schema.key
        if (!id || choices.some(item => item.id === id)) continue
        choices.push({ id, label: schema.label || schema.title || schema.name || '未命名结构', schema })
      }
    }
    return choices
  }

  const referenceCollectionLabels = Object.freeze({
    pieces: '棋子模板', skills: '技能', rules: '规则', statusTags: '状态', statuses: '状态',
    clusters: '能力组', cluster: '能力组', cards: '卡牌',
  })

  function contentCatalog(options = {}) {
    if (typeof options.getCatalog === 'function') {
      try {
        const catalog = options.getCatalog()
        if (catalog) return catalog
      } catch { /* fall back to the snapshot passed by the caller */ }
    }
    return options.catalog || null
  }

  function contentCatalogEntries(catalog, collection) {
    if (!record(catalog)) return []
    const requested = String(collection || '').trim()
    if (!requested) return []
    const aliases = requested === 'statusTags' ? ['statusTags', 'statuses', 'status-effects']
      : requested === 'clusters' || requested === 'cluster' ? ['clusters', 'cluster']
        : [requested]
    const source = aliases.map(key => catalog[key]).find(value => value !== undefined)
    if (source === undefined) return []
    const entries = []
    const seen = new Set()
    const add = (candidate, fallbackId) => {
      if (typeof candidate === 'string' && candidate.trim()) candidate = { id: candidate.trim() }
      if (!record(candidate)) return
      const id = [candidate.id, candidate.ruleId, candidate.skillId, candidate.statusId,
        candidate.templateId, candidate.clusterId, candidate.cardId, candidate.contentId]
        .find(item => typeof item === 'string' && item.trim()) || fallbackId
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) return
      seen.add(id)
      const label = [candidate.name, candidate.title, candidate.label, candidate.displayName]
        .find(item => typeof item === 'string' && item.trim())
        || `未命名${referenceCollectionLabels[requested] || '内容'}`
      entries.push({ id, label: String(label).trim(), document: candidate })
    }
    const addSource = (value, fallback = '') => {
      if (value instanceof Map) { value.forEach((item, id) => add(item, String(id))); return }
      if (Array.isArray(value)) { value.forEach(item => add(item)); return }
      if (!record(value)) return
      // Some hosts expose a collection as { items, dataMap, rawItems } while
      // older hosts expose the ID map directly. Read both shapes so the
      // author sees the same Chinese name without rewriting the stored ID.
      let expanded = false
      for (const key of ['items', 'rawItems', 'documents']) {
        if (value[key] !== undefined) { addSource(value[key]); expanded = true }
      }
      if (value.dataMap !== undefined) { addSource(value.dataMap); expanded = true }
      if (value.entries !== undefined) { addSource(value.entries); expanded = true }
      if (typeof value.id === 'string' || typeof value.ruleId === 'string' || typeof value.skillId === 'string'
        || typeof value.templateId === 'string' || typeof value.clusterId === 'string' || typeof value.cardId === 'string') {
        add(value, fallback); expanded = true
      }
      if (!expanded) Object.entries(value).forEach(([id, item]) => add(item, id))
    }
    addSource(source)
    const counts = new Map()
    for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) || 0) + 1)
    const positions = new Map()
    return entries.map(entry => {
      const count = counts.get(entry.label) || 0
      const position = (positions.get(entry.label) || 0) + 1
      positions.set(entry.label, position)
      return {
        ...entry,
        displayLabel: count > 1 ? `${entry.label}（第${position}项）` : entry.label,
      }
    })
  }

  function contentCatalogHasCollection(catalog, collection) {
    if (!record(catalog)) return false
    const requested = String(collection || '').trim()
    const aliases = requested === 'statusTags' ? ['statusTags', 'statuses', 'status-effects']
      : requested === 'clusters' || requested === 'cluster' ? ['clusters', 'cluster']
        : [requested]
    return aliases.some(key => own(catalog, key))
  }

  function makeTextInput(definition, current, onChange, readonly, path) {
    const input = document.createElement(definition?.multiline ? 'textarea' : 'input')
    if (input.tagName === 'INPUT') input.type = 'text'
    input.value = current == null ? '' : String(current)
    input.dataset.objectEditorValue = path; input.disabled = Boolean(readonly)
    input.onchange = () => onChange(input.value)
    return input
  }

  function makeReferenceInput(definition, current, options, onChange, readonly, path) {
    const collection = String(definition.referenceCollection || '').trim()
    const catalog = contentCatalog(options)
    const entries = contentCatalogEntries(catalog, collection)
    // A generic string remains editable while a caller is still loading its
    // catalog. A declared collection with data can use the controlled picker.
    if (!entries.length && !contentCatalogHasCollection(catalog, collection)) {
      return makeTextInput(definition, current, onChange, readonly, path)
    }
    const wrapper = node('div', undefined, 'author-object-editor-reference')
    wrapper.dataset.objectEditorReference = collection
    wrapper.setAttribute('aria-label', `${referenceCollectionLabels[collection] || '内容'}引用`)
    const select = document.createElement('select')
    select.dataset.objectEditorValue = path
    select.dataset.objectEditorReference = collection
    const blank = node('option', '未选择'); blank.value = ''; select.append(blank)
    for (const entry of entries) {
      const option = node('option', entry.displayLabel)
      option.value = entry.id
      option.title = entry.label
      select.append(option)
    }
    const currentValue = current == null ? '' : String(current)
    const known = entries.some(entry => entry.id === currentValue)
    if (currentValue && !known) {
      const missing = node('option', '引用内容不存在')
      missing.value = currentValue
      missing.title = `原始标识：${currentValue}`
      missing.dataset.objectEditorMissingReference = 'true'
      select.append(missing)
      wrapper.dataset.objectEditorReferenceMissing = 'true'
    }
    select.value = currentValue
    if (select.value !== currentValue) select.value = ''
    select.disabled = Boolean(readonly)
    select.onchange = () => onChange(select.value)
    wrapper.append(select)
    if (currentValue && !known) {
      const issue = node('small', '引用内容不存在', 'author-object-editor-reference-error')
      issue.title = `原始标识：${currentValue}`
      issue.dataset.objectEditorMissingReference = 'true'
      wrapper.append(issue)
    }
    return wrapper
  }

  function makeInput(definition, current, options, onChange, readonly, path) {
    const type = descriptorType(definition)
    const kind = typeKind(type)
    if (Array.isArray(definition?.enum) || (record(type) && type.kind === 'enum')) {
      const select = document.createElement('select')
      select.dataset.objectEditorValue = path
      const values = Array.isArray(definition?.enum) ? definition.enum : type.values || []
      values.forEach(value => {
        const option = node('option', enumDisplay(value, definition, options))
        option.value = JSON.stringify(value)
        select.append(option)
      })
      select.value = JSON.stringify(current)
      select.disabled = Boolean(readonly)
      select.onchange = () => onChange(parseValue(select.value))
      return select
    }
    if (kind === 'boolean') {
      const select = document.createElement('select')
      select.dataset.objectEditorValue = path
      const yes = node('option', '是'); yes.value = 'true'
      const no = node('option', '否'); no.value = 'false'
      select.append(yes, no); select.value = current === true ? 'true' : 'false'
      select.disabled = Boolean(readonly)
      select.onchange = () => onChange(select.value === 'true')
      return select
    }
    if (kind === 'number') {
      const input = document.createElement('input')
      input.type = 'number'; input.step = 'any'; input.value = typeof current === 'number' && Number.isFinite(current) ? String(current) : ''
      if (Number.isFinite(definition?.minimum)) input.min = String(definition.minimum)
      if (Number.isFinite(definition?.maximum)) input.max = String(definition.maximum)
      input.dataset.objectEditorValue = path; input.disabled = Boolean(readonly)
      input.onchange = () => onChange(input.value === '' ? null : Number(input.value))
      return input
    }
    if (kind === 'string') {
      if (definition?.referenceCollection) return makeReferenceInput(definition, current, options, onChange, readonly, path)
      return makeTextInput(definition, current, onChange, readonly, path)
    }
    if (kind === 'json') {
      const input = document.createElement('textarea')
      input.value = current === undefined ? '' : JSON.stringify(current, null, 2)
      input.dataset.objectEditorValue = path; input.disabled = Boolean(readonly)
      input.onchange = () => {
        try {
          const next = JSON.parse(input.value)
          input.removeAttribute?.('aria-invalid')
          onChange(next)
        } catch {
          input.setAttribute?.('aria-invalid', 'true')
        }
      }
      return input
    }
    const input = document.createElement('input')
    input.type = 'text'; input.value = current == null ? '' : String(current)
    input.dataset.objectEditorValue = path; input.disabled = Boolean(readonly)
    input.onchange = () => onChange(input.value)
    return input
  }

  function parseValue(value) {
    try { return JSON.parse(value) } catch { return value }
  }

  function mount(container, options = {}) {
    if (!container) return {
      refresh() {}, setValue() {}, setReadonly() {}, getValue() { return undefined },
      getEditorState() { return {} }, restoreEditorState() {}, destroy() {},
    }
    let value = clone(options.value)
    let type = options.type || options.definition?.type || options.schema || 'record'
    let destroyed = false
    let editorState = { version: 1, expanded: {} }
    let readonly = Boolean(options.readonly || options.disabled)
    const validationErrors = new Map()
    const report = typeof options.onChange === 'function' ? options.onChange : () => {}
    const emit = next => {
      value = clone(next)
      report(clone(value), { type: clone(type) })
    }
    const updateRecord = (source, key, next, present = true) => {
      const object = record(source) ? clone(source) : {}
      if (!present) delete object[key]
      else object[key] = clone(next)
      return object
    }
    const renderPrimitive = (host, definition, current, path, callback, isReadonly) => {
      const control = makeInput(definition, current, options, callback, isReadonly, path)
      host.append(control)
    }
    const renderValue = (host, current, definition, path = '', isReadonly = readonly, depth = 0, onValueChange = () => {}) => {
      if (depth > (Number.isFinite(options.maxDepth) ? options.maxDepth : 10)) {
        host.append(node('span', '结构层级过深。', 'author-object-editor-unavailable')); return
      }
      const typeValue = descriptorType(definition)
      const kind = typeKind(typeValue)
      if (kind === 'nullable') {
        const select = document.createElement('select')
        select.dataset.objectEditorNullable = path
        const empty = node('option', '空值'); empty.value = 'null'
        const filled = node('option', '有值'); filled.value = 'value'
        select.append(empty, filled); select.value = current === null || current === undefined ? 'null' : 'value'; select.disabled = Boolean(isReadonly)
        const inner = node('div', undefined, 'author-object-editor-nested')
        const renderInner = () => { inner.replaceChildren(); if (select.value === 'value') renderValue(inner, current === null || current === undefined ? defaultValue({ type: typeValue.value }, options) : current, { ...definition, type: typeValue.value }, path, isReadonly, depth + 1, onValueChange) }
        select.onchange = () => { current = select.value === 'null' ? null : defaultValue({ type: typeValue.value }, options); onValueChange(clone(current), path); renderInner() }
        renderInner(); host.append(select, inner); return
      }
      if (kind === 'list') {
        const list = Array.isArray(current) ? current : []
        const latestList = () => {
          const next = valueAt(path)
          return Array.isArray(next) ? next : []
        }
        const section = node('div', undefined, 'author-object-editor-list')
        section.dataset.objectEditorList = path
        list.forEach((item, index) => {
          const itemPath = path ? `${path}.${index}` : String(index)
          const row = node('div', undefined, 'author-object-editor-list-row'); row.dataset.objectEditorItem = itemPath
          const body = node('div', undefined, 'author-object-editor-list-value')
          const itemDefinition = { type: typeValue.element || 'unknown' }
          if (definition?.referenceCollection) itemDefinition.referenceCollection = definition.referenceCollection
          renderValue(body, item, itemDefinition, itemPath, isReadonly, depth + 1, onValueChange)
          row.append(node('span', `第 ${index + 1} 项`, 'author-object-editor-list-index'), body)
          if (!isReadonly) {
            const remove = action('删除', () => {
              const next = latestList().slice()
              if (index >= next.length) return
              next.splice(index, 1)
              requestFocus('objectEditorListAdd', path)
              onValueChange(next, path); render()
            }, 'author-object-editor-remove')
            remove.dataset.objectEditorListRemove = itemPath
            row.append(remove)
          }
          section.append(row)
        })
        if (!isReadonly) {
          const add = action('＋ 添加一项', () => {
            const latest = latestList()
            onValueChange([...latest, defaultValue({ type: typeValue.element || 'unknown' }, options)], path); render()
          }, 'author-object-editor-add')
          add.dataset.objectEditorListAdd = path
          section.append(add)
        }
        host.append(section); return
      }
      if (kind === 'map') {
        const section = node('div', undefined, 'author-object-editor-map')
        section.dataset.objectEditorMap = path
        let entries
        try {
          entries = authorMapEntries(current)
        } catch (error) {
          section.append(node('p', `映射数据无效：${error.message}`, 'author-object-editor-error'))
          host.append(section); return
        }
        const issue = validationErrors.get(path)
        if (issue) section.append(node('p', issue, 'author-object-editor-error'))
        const keyType = typeValue.key || 'unknown'
        const valueType = typeValue.value || 'unknown'
        const applyMapChange = (index, slot, next, changedPath) => {
          const latest = valueAt(path)
          let currentEntries
          try { currentEntries = authorMapEntries(latest) } catch { return }
          if (!currentEntries[index]) return
          const slotPath = `${path ? `${path}.` : ''}entries.${index}.${slot}`
          const localPath = changedPath === slotPath
            ? []
            : changedPath.startsWith(`${slotPath}.`)
              ? changedPath.slice(slotPath.length + 1).split('.')
              : []
          const oldSlot = currentEntries[index][slot]
          const nextSlot = localPath.length ? setAtPath(clone(oldSlot), localPath, next) : clone(next)
          const nextEntries = currentEntries.map((entry, entryIndex) => entryIndex === index
            ? [slot === 0 ? nextSlot : entry[0], slot === 1 ? nextSlot : entry[1]]
            : entry)
          try {
            const nextMap = makeAuthorMap(nextEntries)
            authorMapEntries(nextMap)
            const hadIssue = validationErrors.has(path)
            validationErrors.delete(path)
            onValueChange(nextMap, path)
            if (hadIssue) render()
          } catch (error) {
            validationErrors.set(path, error.message)
            render()
          }
        }
        entries.forEach((entry, index) => {
          const entryPath = `${path ? `${path}.` : ''}entries.${index}`
          const row = node('div', undefined, 'author-object-editor-map-row')
          row.dataset.objectEditorMapEntry = entryPath
          const keyHost = node('div', undefined, 'author-object-editor-map-key'); keyHost.dataset.objectEditorMapKey = entryPath
          const valueHost = node('div', undefined, 'author-object-editor-map-value'); valueHost.dataset.objectEditorMapValue = entryPath
          const keyDefinition = { type: keyType }
          const entryDefinition = { type: valueType }
          if (definition?.referenceCollection) entryDefinition.referenceCollection = definition.referenceCollection
          renderValue(keyHost, entry[0], keyDefinition, `${entryPath}.0`, isReadonly, depth + 1,
            (next, changedPath) => applyMapChange(index, 0, next, changedPath))
          renderValue(valueHost, entry[1], entryDefinition, `${entryPath}.1`, isReadonly, depth + 1,
            (next, changedPath) => applyMapChange(index, 1, next, changedPath))
          row.append(node('strong', '键'), keyHost, node('strong', '值'), valueHost)
          if (!isReadonly) {
            const remove = action('删除', () => {
              let latestEntries
              try { latestEntries = authorMapEntries(valueAt(path)) } catch { return }
              if (index >= latestEntries.length) return
              latestEntries.splice(index, 1)
              requestFocus('objectEditorMapAdd', path)
              validationErrors.delete(path)
              onValueChange(makeAuthorMap(latestEntries), path); render()
            }, 'author-object-editor-remove')
            remove.dataset.objectEditorMapRemove = entryPath
            row.append(remove)
          }
          section.append(row)
        })
        if (!isReadonly) {
          const add = action('＋ 添加映射', () => {
            let latestEntries
            try { latestEntries = authorMapEntries(valueAt(path)) } catch { return }
            const nextEntries = [...latestEntries, [defaultValue({ type: keyType }, options), defaultValue({ type: valueType }, options)]]
            try {
              const nextMap = makeAuthorMap(nextEntries)
              authorMapEntries(nextMap)
              validationErrors.delete(path)
              onValueChange(nextMap, path); render()
            } catch (error) {
              validationErrors.set(path, error.message); render()
            }
          }, 'author-object-editor-add')
          add.dataset.objectEditorMapAdd = path
          section.append(add)
        }
        host.append(section); return
      }
      if (kind === 'set') {
        const section = node('div', undefined, 'author-object-editor-set')
        section.dataset.objectEditorSet = path
        let items
        try {
          items = authorSetItems(current)
        } catch (error) {
          section.append(node('p', `集合数据无效：${error.message}`, 'author-object-editor-error'))
          host.append(section); return
        }
        const issue = validationErrors.get(path)
        if (issue) section.append(node('p', issue, 'author-object-editor-error'))
        const itemType = typeValue.element || 'unknown'
        const applySetChange = (index, next, changedPath) => {
          const latest = valueAt(path)
          let currentItems
          try { currentItems = authorSetItems(latest) } catch { return }
          if (index >= currentItems.length) return
          const itemPath = `${path ? `${path}.` : ''}items.${index}`
          const localPath = changedPath === itemPath
            ? []
            : changedPath.startsWith(`${itemPath}.`)
              ? changedPath.slice(itemPath.length + 1).split('.')
              : []
          const nextItem = localPath.length ? setAtPath(clone(currentItems[index]), localPath, next) : clone(next)
          const nextItems = currentItems.slice(); nextItems[index] = nextItem
          try {
            const nextSet = makeAuthorSet(nextItems)
            authorSetItems(nextSet)
            const hadIssue = validationErrors.has(path)
            validationErrors.delete(path)
            onValueChange(nextSet, path)
            if (hadIssue) render()
          } catch (error) {
            validationErrors.set(path, error.message); render()
          }
        }
        items.forEach((item, index) => {
          const itemPath = `${path ? `${path}.` : ''}items.${index}`
          const row = node('div', undefined, 'author-object-editor-set-row')
          row.dataset.objectEditorSetItem = itemPath
          const body = node('div', undefined, 'author-object-editor-set-value'); body.dataset.objectEditorSetValue = itemPath
          const itemDefinition = { type: itemType }
          if (definition?.referenceCollection) itemDefinition.referenceCollection = definition.referenceCollection
          renderValue(body, item, itemDefinition, itemPath, isReadonly, depth + 1,
            (next, changedPath) => applySetChange(index, next, changedPath))
          row.append(node('span', `第 ${index + 1} 项`, 'author-object-editor-list-index'), body)
          if (!isReadonly) {
            const remove = action('删除', () => {
              let latestItems
              try { latestItems = authorSetItems(valueAt(path)) } catch { return }
              if (index >= latestItems.length) return
              latestItems.splice(index, 1)
              requestFocus('objectEditorSetAdd', path)
              validationErrors.delete(path)
              onValueChange(makeAuthorSet(latestItems), path); render()
            }, 'author-object-editor-remove')
            remove.dataset.objectEditorSetRemove = itemPath
            row.append(remove)
          }
          section.append(row)
        })
        if (!isReadonly) {
          const add = action('＋ 添加集合项目', () => {
            let latestItems
            try { latestItems = authorSetItems(valueAt(path)) } catch { return }
            const nextItems = [...latestItems, defaultValue({ type: itemType }, options)]
            try {
              const nextSet = makeAuthorSet(nextItems)
              authorSetItems(nextSet)
              validationErrors.delete(path)
              onValueChange(nextSet, path); render()
            } catch (error) {
              validationErrors.set(path, error.message); render()
            }
          }, 'author-object-editor-add')
          add.dataset.objectEditorSetAdd = path
          section.append(add)
        }
        host.append(section); return
      }
      if (kind === 'record') {
        const schema = typeSchema(typeValue, options)
        const additionalType = schema?.additionalFields
        const object = record(current) ? current : {}
        const section = node('div', undefined, 'author-object-editor-record'); section.dataset.objectEditorRecord = path
        const schemaIssue = !schema && record(typeValue) && typeValue.schema
          ? schemaResolutionIssue(typeValue.schema, options)
          : null
        if (schemaIssue) section.append(node('p', schemaIssue, 'author-object-editor-error'))
        if (schema?.label || schema?.description) {
          const heading = node('div', undefined, 'author-object-editor-schema-heading')
          if (schema.label) heading.append(node('strong', schema.label))
          if (schema.description) heading.append(node('p', schema.description, 'author-object-editor-description'))
          section.append(heading)
        }
        const fields = schemaFields(schema)
        for (const field of fields) renderField(section, object, field, path, isReadonly, depth, undefined, onValueChange, typeValue?.schema)
        const known = new Set(fields.map(field => field.name))
        for (const key of Object.keys(object).filter(item => !known.has(item))) {
          const mapField = { type: additionalType || inferredType(object[key]), label: humanKey(key) }
          renderField(section, object, normalizeField(mapField, key), path, isReadonly, depth, key, onValueChange, typeValue?.schema)
        }
        if (!fields.length && !Object.keys(object).length) section.append(node('p', '暂无字段；可从下方添加。', 'author-object-editor-empty'))
        if (!isReadonly) renderAddField(section, path, additionalType)
        host.append(section); return
      }
      renderPrimitive(host, definition, current, path, next => onValueChange(clone(next), path), isReadonly)
    }
    const renderField = (section, object, field, parentPath, isReadonly, depth, forcedName, parentChange = () => {}, schemaReference) => {
      const name = forcedName || field.name
      const present = own(object, name)
      const current = present ? object[name] : undefined
      const path = parentPath ? `${parentPath}.${name}` : name
      let resolvedReference = field?.referenceCollection ? { collection: field.referenceCollection } : null
      if (typeof options.referenceResolver === 'function') {
        try {
          const resolved = options.referenceResolver(field, path, { schema: schemaReference, type: field?.type })
          if (typeof resolved === 'string') resolvedReference = { collection: resolved }
          else if (record(resolved) && typeof resolved.collection === 'string' && resolved.collection.trim()) resolvedReference = resolved
        } catch { /* optional UI metadata must not block ordinary value editing */ }
      }
      const effectiveField = resolvedReference
        ? { ...field, referenceCollection: resolvedReference.collection, ...(resolvedReference.label ? { referenceLabel: resolvedReference.label } : {}) }
        : field
      const state = valueState(current, effectiveField, present, options)
      const row = node('div', undefined, 'author-object-editor-field')
      row.dataset.objectEditorField = name; row.dataset.objectEditorFieldPath = path
      const header = node('div', undefined, 'author-object-editor-field-header')
      const title = node('div', undefined, 'author-object-editor-field-title')
      title.append(node('strong', fieldLabel(effectiveField)), node('span', typeLabel(effectiveField.type, { ...options, label: undefined, schemaRegistry: options.schemaRegistry }), 'author-object-editor-type'))
      if (effectiveField.description) title.append(node('p', effectiveField.description, 'author-object-editor-description'))
      const stateText = node('span', state.label, 'author-object-editor-field-state'); stateText.dataset.objectEditorFieldState = state.key
      header.append(title, stateText); row.append(header)
      const presence = document.createElement('select'); presence.dataset.objectEditorFieldInclude = path; presence.disabled = Boolean(isReadonly)
      for (const [key, label] of [['omitted', '未填写'], ['null', '空值'], ['value', '已填写']]) { const option = node('option', label); option.value = key; presence.append(option) }
      presence.value = state.key === 'default' ? 'value' : state.key
      presence.onchange = () => {
        const nextState = presence.value
        const next = nextState === 'omitted' ? updateRecord(valueAt(parentPath), name, undefined, false) : updateRecord(valueAt(parentPath), name, nextState === 'null' ? null : filledDefaultValue(effectiveField, options), true)
        emitAt(parentPath, next); render()
      }
      row.append(presence)
      if (state.key !== 'omitted' && state.key !== 'null') {
        const body = node('div', undefined, 'author-object-editor-field-value'); body.dataset.objectEditorFieldValue = path
        const fieldChange = (next, changedPath) => {
          if (changedPath !== path && changedPath !== name && !changedPath.startsWith(`${path}.`)) return
          const localPath = changedPath === path || changedPath === name ? [] : changedPath.slice(path.length + 1).split('.')
          const latestParent = valueAt(parentPath)
          const latestPresent = record(latestParent) && own(latestParent, name)
          const base = latestPresent ? clone(latestParent[name]) : filledDefaultValue(effectiveField, options)
          const nextValue = localPath.length ? setAtPath(base, localPath, next) : next
          parentChange(updateRecord(latestParent, name, nextValue, true), parentPath)
        }
        renderValue(body, current, effectiveField, path, isReadonly, depth + 1, fieldChange)
        row.append(body)
      } else if (state.key === 'null') row.append(node('p', effectiveField.nullDescription || '此字段明确为空。', 'author-object-editor-empty'))
      section.append(row)
    }
    const valueAt = path => {
      if (!path) return value
      return getAtPath(value, path.split('.'))
    }
    const emitAt = (path, next) => {
      if (!path) emit(next)
      else emit(setAtPath(value, path.split('.'), next))
    }
    const renderAddField = (section, path, additionalType) => {
      const row = node('div', undefined, 'author-object-editor-add-field')
      const input = document.createElement('input'); input.type = 'text'; input.placeholder = '新字段名'; input.dataset.objectEditorAddField = path
      const add = action('添加字段', () => {
        const name = input.value.trim()
        const latestObject = valueAt(path)
        if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype' || own(latestObject, name)) return
        const initial = additionalType === undefined ? '' : filledDefaultValue({ type: additionalType }, options)
        emitAt(path, updateRecord(latestObject, name, initial, true)); render()
      }, 'author-object-editor-add')
      row.append(input, add); section.append(row)
    }
    const focusDatasetKeys = [
      'objectEditorValue', 'objectEditorFieldInclude', 'objectEditorAddField',
      'objectEditorListAdd', 'objectEditorListRemove', 'objectEditorMapKey',
      'objectEditorMapValue', 'objectEditorMapAdd', 'objectEditorMapRemove',
      'objectEditorSetValue', 'objectEditorSetAdd', 'objectEditorSetRemove',
    ]
    let requestedFocus = null
    const requestFocus = (key, value) => { requestedFocus = { key, value: String(value) } }
    const containsNode = (root, target) => {
      if (!root || !target) return false
      if (root === target) return true
      return Array.from(root.children || []).some(child => containsNode(child, target))
    }
    const focusIdentity = element => {
      if (!element?.dataset) return null
      for (const key of focusDatasetKeys) {
        if (element.dataset[key] !== undefined) return { key, value: String(element.dataset[key]) }
      }
      return null
    }
    const focusedIdentity = () => {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      return containsNode(container, active) ? focusIdentity(active) : null
    }
    const restoreFocus = identity => {
      if (!identity) return
      const visit = current => {
        if (focusIdentity(current)?.key === identity.key && focusIdentity(current)?.value === identity.value) return current
        for (const child of Array.from(current?.children || [])) {
          const match = visit(child)
          if (match) return match
        }
        return null
      }
      visit(container)?.focus?.()
    }
    const render = () => {
      if (destroyed) return
      const focus = requestedFocus || focusedIdentity()
      requestedFocus = null
      container.replaceChildren()
      const root = node('section', undefined, 'author-object-editor')
      root.dataset.objectEditor = 'true'
      const header = node('header', undefined, 'author-object-editor-header')
      header.append(node('strong', options.label || typeLabel(type, options)))
      if (options.description) header.append(node('p', options.description, 'author-object-editor-description'))
      if (options.allowSchemaSelect && (type === 'record' || type === 'object' || !type)) {
        const choices = schemaChoices(options)
        if (choices.length) {
          const select = document.createElement('select'); select.dataset.objectEditorSchema = 'true'
          const blank = node('option', '选择记录结构'); blank.value = ''; select.append(blank)
          choices.forEach(choice => { const option = node('option', choice.label); option.value = choice.id; select.append(option) })
          const selected = record(type) ? type.schema : typeof type === 'string' && type !== 'record' ? type : ''
          const selectedChoice = choices.find(choice => choice.id === selected || choice.id.startsWith(`${selected}@`))
          select.value = selectedChoice?.id || selected || ''
          select.disabled = Boolean(readonly)
          select.onchange = () => { if (!select.value) return; type = { kind: 'record', schema: select.value }; value = defaultValue(type, options); emit(value); render() }
          header.append(select)
        }
      }
      root.append(header)
      const valueHost = node('div', undefined, 'author-object-editor-value')
      renderValue(valueHost, value, { type }, '', readonly, 0, (next, path) => {
        if (path) emitAt(path, next)
        else emit(next)
      })
      root.append(valueHost)
      container.append(root)
      restoreFocus(focus)
    }
    const getEditorState = () => ({ version: 1, type: clone(type), value: clone(value), editor: clone(editorState) })
    const restoreEditorState = state => {
      if (!record(state)) return
      if (own(state, 'type')) type = clone(state.type)
      if (own(state, 'value')) { value = clone(state.value); validationErrors.clear() }
      editorState = record(state.editor) ? clone(state.editor) : { version: 1, expanded: {} }
      render()
    }
    render()
    return {
      refresh(next) { if (arguments.length) { value = clone(next); validationErrors.clear() } render() },
      setValue(next) { value = clone(next); validationErrors.clear(); render() },
      setReadonly(next) { readonly = Boolean(next); render() },
      getValue() { return clone(value) },
      getEditorState,
      restoreEditorState,
      destroy() { destroyed = true; container.replaceChildren() },
    }
  }

  function getAtPath(value, path) {
    let current = value
    for (const key of Array.isArray(path) ? path : []) { if (current === null || current === undefined) return undefined; current = current[key] }
    return current
  }

  function setAtPath(source, path, next) {
    const output = clone(source)
    if (!path.length) return clone(next)
    let current = record(output) || Array.isArray(output) ? output : {}
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index]
      if (!record(current[key]) && !Array.isArray(current[key])) current[key] = /^\d+$/.test(path[index + 1]) ? [] : {}
      current = current[key]
    }
    current[path[path.length - 1]] = clone(next)
    return output
  }

  const api = { mount, clone, defaultValue, filledDefaultValue, resolveSchema, typeLabel, valueState }
  if (typeof window !== 'undefined') window.AuthorObjectEditor = api
})()
