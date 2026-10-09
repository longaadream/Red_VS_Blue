/*
 * Author-facing gameplay module editor.
 *
 * The editor intentionally only creates the structured module document from
 * module-types.ts.  It does not expose JavaScript, object paths, or a JSON
 * escape hatch.  The trusted compiler remains the save boundary; incomplete
 * drafts are kept in memory so an author can repair them.
 */
(() => {
  'use strict'

  const GRAPH_VERSION = 'rvb-gameplay-modules/v1'
  const DOCUMENT_VERSION = 'rvb-gameplay-module-document/v1'
  const surfaces = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
  const typeNames = ['number', 'boolean', 'string', 'piece', 'player', 'cell', 'path', 'card', 'content', 'status', 'event', 'choice', 'record', 'null', 'unknown', 'any']
  const typeLabels = {
    number: '数字', boolean: '布尔值', string: '文本', piece: '棋子引用', player: '玩家引用',
    cell: '地格引用', path: '路径', card: '卡牌实例', content: '内容定义', status: '状态实例',
    event: '事件事实', choice: '选择结果', record: '记录句柄', null: '空值', unknown: '未知值', any: '任意值',
  }
  const statementLabels = { call: '调用模块', if: '条件分支', foreach: '逐项执行', return: '返回结果' }
  const categoryFields = { skills: 'code', cards: 'code', rules: 'skillCode', triggerSkills: 'code', pending: 'effectCode', preview: 'previewCode' }

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
  const record = value => value && typeof value === 'object' && !Array.isArray(value)
  const clone = value => {
    try { return JSON.parse(JSON.stringify(value)) } catch { return value }
  }
  const node = (tag, value, className) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (value !== undefined && value !== null) element.textContent = value
    return element
  }
  const button = (label, action, className = 'gameplay-module-button') => {
    const element = node('button', label, className)
    element.type = 'button'
    element.onclick = action
    return element
  }
  const label = (title, control, className = '') => {
    const wrapper = node('label', undefined, className)
    wrapper.append(node('span', title, 'gameplay-module-label'))
    wrapper.append(control)
    return wrapper
  }
  const jsonValue = value => JSON.stringify(value)
  const errorText = error => error instanceof Error ? error.message : String(error)

  function getCore() {
    return window.ContentGraphCore || window.GameplayModuleCore || null
  }

  function compilerRegistrySource(core) {
    if (!core) return null
    if (typeof core.getGameplayModuleRegistry === 'function') {
      try { return core.getGameplayModuleRegistry() } catch { /* use the exported registry below */ }
    }
    return core.GAMEPLAY_MODULE_REGISTRY || core.moduleRegistry || null
  }

  function metadataSource(core) {
    if (!core) return null
    try {
      if (typeof core.getGameplayModuleCatalog === 'function') return core.getGameplayModuleCatalog()
    } catch { /* catalogue loading is reported by the empty palette */ }
    return core.GAMEPLAY_MODULE_CATALOG || core.GAMEPLAY_MODULES || compilerRegistrySource(core)
  }

  function descriptorsFrom(source) {
    if (!source) return []
    if (source instanceof Map) {
      return [...source.values()].flatMap(value => Array.isArray(value) ? value : [value]).filter(record)
    }
    if (Array.isArray(source)) return source.filter(record)
    if (record(source) && Array.isArray(source.descriptors)) return source.descriptors.filter(record)
    if (record(source) && typeof source.values === 'function') {
      try { return [...source.values()].flatMap(value => Array.isArray(value) ? value : [value]).filter(record) } catch { /* fall through */ }
    }
    if (record(source)) return Object.values(source).flatMap(value => Array.isArray(value) ? value : [value]).filter(record)
    return []
  }

  function catalog(core, graph) {
    const values = descriptorsFrom(metadataSource(core))
    const byKey = new Map()
    for (const descriptor of values) {
      if (typeof descriptor.id !== 'string' || typeof descriptor.version !== 'string') continue
      const key = `${descriptor.id}@${descriptor.version}`
      if (!byKey.has(key)) byKey.set(key, descriptor)
    }
    for (const composite of Array.isArray(graph?.composites) ? graph.composites : []) {
      if (!record(composite) || typeof composite.id !== 'string' || typeof composite.version !== 'string') continue
      const key = `${composite.id}@${composite.version}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        ...composite,
        label: composite.label || composite.id,
        description: composite.description || '当前模块图中的组合模块',
        inputs: Array.isArray(composite.inputs) ? composite.inputs : [],
        outputs: Array.isArray(composite.outputs) ? composite.outputs : [],
        parameters: Array.isArray(composite.parameters) ? composite.parameters : [],
        allowedSurfaces: Array.isArray(composite.allowedSurfaces) ? composite.allowedSurfaces : surfaces,
        effects: { description: '组合模块由当前图中的结构化子流程组成' },
        __composite: true,
      })
    }
    return [...byKey.values()]
  }

  function descriptorFor(core, graph, id, version) {
    return catalog(core, graph).find(item => item.id === id && (!version || item.version === version)) || null
  }

  function surfaceFor(category, field, graph) {
    if (typeof graph?.surface === 'string' && surfaces.includes(graph.surface)) return graph.surface
    if (field === 'previewCode') return 'preview'
    return ({ skills: 'skill', cards: 'card', rules: 'rule', triggerSkills: 'triggerSkill', pending: 'pending' })[category] || 'skill'
  }

  function graphFromDraft(draft, core, field) {
    try {
      if (typeof core?.getGameplayModuleGraph === 'function') {
        const value = core.getGameplayModuleGraph(draft, field)
        if (record(value)) return value
      }
    } catch { /* malformed drafts are still shown through the raw fallback */ }
    const entry = draft?.gameplayModules?.entries?.[field]
    if (record(entry) && record(entry.graph)) return entry.graph
    if (record(draft?.gameplayModuleGraph) && (!draft.gameplayModuleField || draft.gameplayModuleField === field)) return draft.gameplayModuleGraph
    return null
  }

  function starterGraph(surface, core) {
    let generated
    try {
      if (typeof core?.createGameplayModuleGraph === 'function') {
        generated = core.createGameplayModuleGraph(surface)
      }
    } catch { /* use the conservative local starter below */ }
    const result = record(generated) ? clone(generated) : {
      version: core?.GAMEPLAY_MODULE_GRAPH_VERSION || GRAPH_VERSION,
      surface,
      inputs: [],
      outputs: [],
      body: [{ kind: 'return', id: 'return-1' }],
      composites: [],
    }
    if (!Array.isArray(result.body) || !result.body.length) result.body = [{ kind: 'return', id: 'return-1' }]
    if (!Array.isArray(result.composites)) result.composites = []
    return result
  }

  function graphFields(draft, selected, fallback) {
    const entries = record(draft?.gameplayModules?.entries) ? Object.keys(draft.gameplayModules.entries) : []
    const result = [...new Set([selected, ...entries, fallback].filter(Boolean))]
    return result.length ? result : ['code']
  }

  function defaultForType(definition = {}) {
    if (own(definition, 'default')) return clone(definition.default)
    if (Array.isArray(definition.enum) && definition.enum.length) return clone(definition.enum[0])
    const type = typeof definition.type === 'string' ? definition.type : definition.valueType
    if (type === 'number') return 0
    if (type === 'boolean') return false
    if (type === 'string') return ''
    if (record(type) && type.kind === 'list') return []
    return null
  }

  function typeName(type) {
    if (typeof type === 'string') return type
    if (record(type) && type.kind === 'list') return `list<${typeName(type.element)}>`
    if (record(type) && type.kind === 'nullable') return `${typeName(type.value)}?`
    return 'unknown'
  }

  function typeLabel(type) { return typeLabels[type] || typeName(type) }

  function editableType(type) {
    return record(type) && type.kind === 'nullable' ? type.value : type
  }

  function literalType(type) {
    const value = editableType(type)
    if (typeof value === 'string') return ['number', 'boolean', 'string', 'null'].includes(value)
    return record(value) && value.kind === 'list' && literalType(value.element)
  }

  function compatible(source, target) {
    if (!target || target === 'any' || target === 'unknown') return true
    if (!source || source === 'any' || source === 'unknown') return true
    if (source === target) return true
    if (record(source) && record(target) && source.kind === target.kind) return compatible(source.element || source.value, target.element || target.value)
    if (record(target) && target.kind === 'nullable') return compatible(source, target.value)
    return false
  }

  function portType(port) { return port?.type ?? port?.valueType ?? 'unknown' }

  function encodeValue(value) { return value ? jsonValue(value) : '' }
  function decodeValue(value) {
    if (!value) return null
    try { const parsed = JSON.parse(value); return record(parsed) ? parsed : null } catch { return null }
  }

  function refLabel(value, graph, core) {
    if (!value) return '请选择数据来源'
    if (value.kind === 'input') return `输入 · ${value.name}`
    if (value.kind === 'output') {
      const descriptor = statementById(graph, value.node)
      const output = callOutputs(descriptor, graph, core).find(port => port.name === value.port)
      return `输出 · ${value.node}.${value.port}${output ? ` · ${output.label || typeLabel(portType(output))}` : ''}`
    }
    if (value.kind === 'literal') return '常量'
    return '未知来源'
  }

  function statementById(graph, id) {
    const search = statements => {
      for (const statement of Array.isArray(statements) ? statements : []) {
        if (statement?.id === id) return statement
        const nested = search(statement?.then) || search(statement?.else) || search(statement?.body)
        if (nested) return nested
      }
      return null
    }
    return search(graph?.body) || (Array.isArray(graph?.composites) ? graph.composites.reduce((found, item) => found || search(item?.body), null) : null)
  }

  function callOutputs(statement, graph, core) {
    if (!statement || statement.kind !== 'call') return []
    return descriptorFor(core, graph, statement.module, statement.version)?.outputs || []
  }

  function collectRefs(graph, core, statements, beforeIndex, path) {
    const refs = []
    const addInputs = inputs => { for (const input of Array.isArray(inputs) ? inputs : []) {
      if (typeof input?.name === 'string') refs.push({ value: { kind: 'input', name: input.name }, type: portType(input), label: `输入 · ${input.label || input.name}` })
    } }
    const addOutputs = before => { for (const item of Array.isArray(before) ? before : []) {
      for (const output of callOutputs(item, graph, core)) refs.push({ value: { kind: 'output', node: item.id, port: output.name }, type: portType(output), label: `输出 · ${item.id}.${output.label || output.name}` })
    } }
    let body = Array.isArray(graph?.body) ? graph.body : []
    addInputs(graph?.inputs)
    for (const frame of Array.isArray(path) ? path : []) {
      if (frame.kind === 'composite') {
        const composite = Array.isArray(graph?.composites) ? graph.composites.find(item => item?.id === frame.id) : null
        refs.length = 0
        addInputs(composite?.inputs)
        body = Array.isArray(composite?.body) ? composite.body : []
        continue
      }
      if (frame.kind !== 'child') continue
      const ownerIndex = body.findIndex(item => item?.id === frame.id)
      if (ownerIndex >= 0) {
        addOutputs(body.slice(0, ownerIndex))
        const owner = body[ownerIndex]
        if (owner?.kind === 'foreach') {
          if (owner.item) refs.push({ value: { kind: 'output', node: owner.id, port: 'item' }, type: 'unknown', label: `循环项 · ${owner.item}` })
          if (owner.index) refs.push({ value: { kind: 'output', node: owner.id, port: 'index' }, type: 'number', label: `循环序号 · ${owner.index}` })
        }
        body = Array.isArray(owner[frame.slot]) ? owner[frame.slot] : []
      }
    }
    addOutputs(Array.isArray(statements) ? statements.slice(0, Math.max(0, beforeIndex)) : body.slice(0, Math.max(0, beforeIndex)))
    return refs
  }

  function literalControl(current, definition, onChange, disabled) {
    const type = editableType(definition?.type || definition?.valueType || 'unknown')
    const enumValues = Array.isArray(definition?.enum) ? definition.enum : null
    let control
    if (enumValues) {
      control = document.createElement('select')
      for (const value of enumValues) { const option = node('option', String(value)); option.value = jsonValue(value); control.append(option) }
      control.value = jsonValue(current)
      control.onchange = () => onChange(JSON.parse(control.value))
    } else if (type === 'boolean') {
      control = document.createElement('input'); control.type = 'checkbox'; control.checked = current === true
      control.onchange = () => onChange(control.checked)
    } else if (type === 'number') {
      control = document.createElement('input'); control.type = 'number'; control.step = 'any'
      if (Number.isFinite(definition?.minimum)) control.min = String(definition.minimum)
      if (Number.isFinite(definition?.maximum)) control.max = String(definition.maximum)
      control.value = Number.isFinite(current) ? String(current) : ''
      control.onchange = () => onChange(control.value === '' ? null : Number(control.value))
    } else if (record(type) && type.kind === 'list') {
      control = document.createElement('input'); control.type = 'text'; control.placeholder = '用逗号分隔'
      control.value = Array.isArray(current) ? current.join(', ') : ''
      control.onchange = () => {
        const itemType = typeName(type.element)
        const values = control.value.split(',').map(item => item.trim()).filter(Boolean)
        onChange(values.map(item => itemType === 'number' ? Number(item) : itemType === 'boolean' ? item === 'true' : item))
      }
    } else if (type === 'null') {
      control = document.createElement('input'); control.type = 'text'; control.value = '空值'; control.disabled = true
    } else if (!literalType(type)) {
      control = document.createElement('input'); control.type = 'text'; control.value = '实体引用需从数据端口选择'; control.disabled = true
    } else {
      control = document.createElement('input'); control.type = 'text'; control.maxLength = 500
      control.value = typeof current === 'string' ? current : current == null ? '' : String(current)
      control.onchange = () => onChange(control.value)
    }
    control.classList.add('gameplay-module-literal')
    control.disabled = Boolean(disabled) || control.disabled
    return control
  }

  function valueEditor(title, current, expectedType, refs, onChange, disabled, definition = {}) {
    const wrapper = node('div', undefined, 'gameplay-module-value-editor')
    const source = document.createElement('select')
    source.setAttribute('aria-label', title)
    source.dataset.gameplayModuleValue = 'true'
    const values = [['', '请选择数据来源']]
    for (const ref of refs || []) if (compatible(ref.type, expectedType)) values.push([encodeValue(ref.value), ref.label])
    const literalAllowed = literalType(expectedType)
    if (literalAllowed) values.push(['literal', `常量 · ${typeLabel(expectedType)}`])
    const currentKind = current?.kind
    if (currentKind === 'input' || currentKind === 'output') {
      const encoded = encodeValue(current)
      if (!values.some(item => item[0] === encoded)) values.push([encoded, `当前引用 · ${refLabel(current)}`])
      source.value = encoded
    } else if (currentKind === 'literal') source.value = 'literal'
    else source.value = ''
    for (const [value, text] of values) { const option = node('option', text); option.value = value; source.append(option) }
    source.value = currentKind === 'literal' ? 'literal' : currentKind ? encodeValue(current) : ''
    source.disabled = Boolean(disabled)
    const literal = literalControl(current?.kind === 'literal' ? current.value : defaultForType(definition), definition.type ? definition : { type: expectedType }, value => onChange({ kind: 'literal', value }), disabled || source.value !== 'literal')
    source.onchange = () => {
      if (source.value === 'literal') { literal.disabled = Boolean(disabled); onChange({ kind: 'literal', value: literalValue(literal, definition, expectedType) }) }
      else { literal.disabled = true; onChange(decodeValue(source.value)) }
    }
    wrapper.append(node('span', title, 'gameplay-module-label'), source, literal)
    return wrapper
  }

  function literalValue(control, definition, expectedType) {
    const type = definition?.type || expectedType
    if (type === 'boolean') return control.checked
    if (type === 'number') return control.value === '' ? null : Number(control.value)
    if (record(editableType(type)) && editableType(type).kind === 'list') {
      const itemType = editableType(type).element
      return control.value.split(',').map(item => item.trim()).filter(Boolean).map(item => itemType === 'number' ? Number(item) : itemType === 'boolean' ? item === 'true' : item)
    }
    return control.value
  }

  function portTypeControl(current, onChange, disabled) {
    const select = document.createElement('select')
    const editableTypes = typeNames.filter(type => !['unknown', 'any'].includes(type))
    for (const type of editableTypes) { const option = node('option', typeLabel(type)); option.value = type; select.append(option) }
    if (typeof current === 'string' && !editableTypes.includes(current)) {
      const invalid = node('option', `当前类型不可保存 · ${current}`); invalid.value = current; select.append(invalid)
    }
    select.value = typeof current === 'string' && typeNames.includes(current) ? current : 'string'
    select.onchange = () => onChange(select.value)
    select.disabled = Boolean(disabled)
    return select
  }

  window.GameplayModuleEditor = {
    mount(container, options = {}) {
      const getDraft = typeof options.getDraft === 'function' ? options.getDraft : () => ({})
      const onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
      const category = options.category || 'skills'
      const initialField = options.field || categoryFields[category] || 'code'
      let selectedField = initialField
      let selectedId = null
      let path = []
      let message = ''
      let locked = false
      let destroyed = false
      let search = ''

      const editingLocked = () => locked || Boolean(container.closest('[data-saving="true"]'))
      const core = () => getCore()
      const draft = () => getDraft() || {}
      const currentGraph = () => graphFromDraft(draft(), core(), selectedField)
      const fields = () => graphFields(draft(), selectedField, initialField)

      function activeScope(graph, createMissing = false) {
        if (!record(graph)) return { body: [], label: '主流程', frame: null }
        let scope = { body: Array.isArray(graph.body) ? graph.body : [], label: '主流程', frame: null, composite: null }
        for (const frame of path) {
          if (frame.kind === 'composite') {
            const composite = Array.isArray(graph.composites) ? graph.composites.find(item => item?.id === frame.id) : null
            if (!composite) return { body: [], label: frame.id, frame, composite: null }
            if (!Array.isArray(composite.body) && createMissing) composite.body = []
            scope = { body: Array.isArray(composite.body) ? composite.body : [], label: composite.label || composite.id, frame, composite }
          } else if (frame.kind === 'child') {
            const owner = scope.body.find(item => item?.id === frame.id)
            if (!owner) return { body: [], label: frame.slot, frame, composite: scope.composite }
            if (!Array.isArray(owner[frame.slot]) && createMissing) owner[frame.slot] = []
            scope = { body: Array.isArray(owner[frame.slot]) ? owner[frame.slot] : [], label: frame.slot === 'then' ? '条件成立' : frame.slot === 'else' ? '条件不成立' : '循环体', frame, composite: scope.composite }
          }
        }
        return scope
      }

      function selectedStatement(graph) {
        const scope = activeScope(graph)
        return scope.body.find(item => item?.id === selectedId) || null
      }

      function interfaceOwner(graph) { return activeScope(graph).composite || graph }

      function rawGraphDraft(value) {
        const next = clone(draft())
        const modules = record(next.gameplayModules) ? clone(next.gameplayModules) : { version: DOCUMENT_VERSION, entries: {} }
        modules.version = core()?.GAMEPLAY_MODULE_DOCUMENT_VERSION || DOCUMENT_VERSION
        modules.entries = record(modules.entries) ? modules.entries : {}
        const prior = record(modules.entries[selectedField]) ? modules.entries[selectedField] : {}
        modules.entries[selectedField] = { ...prior, graph: clone(value) }
        delete modules.entries[selectedField].compilerVersion
        next.gameplayModules = modules
        return next
      }

      function validateGraph(value) {
        const compiler = core()
        if (!compiler || !record(value)) return ''
        try {
          if (typeof compiler.compileGameplayModuleGraph === 'function') {
            compiler.compileGameplayModuleGraph(value, compilerRegistrySource(compiler) || undefined)
            return ''
          }
          if (typeof compiler.assertGameplayModuleGraph === 'function') compiler.assertGameplayModuleGraph(value)
          return ''
        } catch (error) { return errorText(error) }
      }

      function writeGraph(value) {
        if (editingLocked() || !record(value)) return
        const compiler = core()
        try {
          if (typeof compiler?.applyGameplayModuleGraph === 'function') {
            const next = compiler.applyGameplayModuleGraph(draft(), value, selectedField)
            onChange(next)
            message = '模块图已通过类型检查，生成字段会随文档一起保存。'
          } else {
            onChange(rawGraphDraft(value))
            message = '已更新模块图；可信编译器加载后会在保存时校验。'
          }
        } catch (error) {
          onChange(rawGraphDraft(value))
          message = errorText(error)
        }
        render()
      }

      function updateGraph(mutator) {
        const current = currentGraph()
        if (!record(current) || editingLocked()) return
        const next = clone(current)
        mutator(next)
        writeGraph(next)
      }

      function updateStatement(id, mutator) {
        updateGraph(graph => {
          const scope = activeScope(graph, true)
          const statement = scope.body.find(item => item?.id === id)
          if (statement) mutator(statement, scope.body, graph)
        })
      }

      function nextId(graph, kind) {
        const all = []
        const gather = body => { for (const item of Array.isArray(body) ? body : []) { all.push(item.id); gather(item.then); gather(item.else); gather(item.body) } }
        gather(graph.body); for (const composite of Array.isArray(graph.composites) ? graph.composites : []) gather(composite.body)
        const prefix = `${kind}-`
        let index = 1; while (all.includes(`${prefix}${index}`)) index++
        return `${prefix}${index}`
      }

      function addStatement(kind, descriptor) {
        updateGraph(graph => {
          if (!Array.isArray(graph.body)) graph.body = []
          const scope = activeScope(graph, true)
          const outputs = interfaceOwner(graph).outputs || []
          const id = nextId(graph, kind)
          let statement
          if (kind === 'call') {
            statement = { kind, id, module: descriptor?.id || '', version: descriptor?.version || '', inputs: {}, parameters: {} }
            for (const parameter of Array.isArray(descriptor?.parameters) ? descriptor.parameters : []) if (own(parameter, 'default')) statement.parameters[parameter.name] = clone(parameter.default)
          } else if (kind === 'if') statement = { kind, id, condition: { kind: 'literal', value: true }, then: [], else: [] }
          else if (kind === 'foreach') statement = { kind, id, items: { kind: 'literal', value: [] }, item: 'item', index: 'index', body: [] }
          else if (outputs.length === 1) statement = { kind: 'return', id, value: { kind: 'literal', value: defaultForType(outputs[0]) } }
          else if (outputs.length > 1) statement = { kind: 'return', id, values: {} }
          else statement = { kind: 'return', id }
          const terminal = scope.body.findIndex(item => item.kind === 'return')
          if (kind !== 'return' && terminal >= 0) scope.body.splice(terminal, 0, statement)
          else scope.body.push(statement)
          selectedId = id
        })
      }

      function copyStatement(graph, original) {
        const copy = clone(original)
        const renamed = new Map()
        const reserved = clone(graph)
        const visit = (statement, action) => {
          action(statement)
          for (const key of ['then', 'else', 'body']) for (const child of statement[key] || []) visit(child, action)
        }
        visit(copy, statement => {
          const id = nextId(reserved, statement.kind || 'node')
          renamed.set(statement.id, id)
          statement.id = id
          reserved.body.push({ id })
        })
        const remap = value => {
          if (value?.kind === 'output' && renamed.has(value.node)) value.node = renamed.get(value.node)
        }
        visit(copy, statement => {
          for (const value of Object.values(statement.inputs || {})) remap(value)
          for (const value of Object.values(statement.values || {})) remap(value)
          for (const key of ['condition', 'items', 'value']) remap(statement[key])
        })
        return copy
      }

      function addComposite() {
        updateGraph(graph => {
          if (!Array.isArray(graph.composites)) graph.composites = []
          const used = new Set(graph.composites.map(item => item?.id))
          let index = 1; while (used.has(`composite-${index}`)) index++
          graph.composites.push({ id: `composite-${index}`, version: 'v1', label: `组合模块 ${index}`, inputs: [], outputs: [], body: [], allowedSurfaces: [surfaceFor(category, selectedField, graph)] })
        })
      }

      function addPort(kind) {
        updateGraph(graph => {
          const owner = interfaceOwner(graph)
          const key = kind === 'input' ? 'inputs' : 'outputs'
          if (!Array.isArray(owner[key])) owner[key] = []
          const used = new Set(owner[key].map(item => item?.name))
          let index = 1; while (used.has(`${kind}${index}`)) index++
          const port = { name: `${kind}${index}`, type: 'string', label: `${kind === 'input' ? '输入' : '输出'} ${index}` }
          owner[key].push(port)
          if (kind === 'input' && owner === graph) graph.inputBindings = { ...(graph.inputBindings || {}), [port.name]: '' }
        })
      }

      function mutateBody(action) {
        updateGraph(graph => action(activeScope(graph, true).body, graph))
      }

      function compatibleRefs(graph, scope, statementIndex, expected) {
        return collectRefs(graph, core(), scope.body, statementIndex, path).filter(ref => compatible(ref.type, expected))
      }

      function renderValueEditor(parent, title, value, expected, graph, scope, index, change, definition = {}) {
        parent.append(valueEditor(title, value, expected, compatibleRefs(graph, scope, index, expected), change, editingLocked(), definition))
      }

      function renderCallInspector(parent, statement, graph, scope, statementIndex) {
        const descriptors = catalog(core(), graph).filter(item => !Array.isArray(item.allowedSurfaces) || item.allowedSurfaces.includes(surfaceFor(category, selectedField, graph)))
        const current = descriptorFor(core(), graph, statement.module, statement.version)
        const moduleSelect = document.createElement('select')
        moduleSelect.setAttribute('aria-label', '模块引用')
        moduleSelect.dataset.gameplayModuleModule = 'true'
        for (const descriptor of descriptors) { const option = node('option', `${descriptor.label || descriptor.id} · ${descriptor.id}@${descriptor.version}`); option.value = `${descriptor.id}\0${descriptor.version}`; moduleSelect.append(option) }
        if (current && !descriptors.some(item => item.id === current.id && item.version === current.version)) { const option = node('option', `当前引用 · ${statement.module}@${statement.version}`); option.value = `${statement.module}\0${statement.version}`; moduleSelect.append(option) }
        moduleSelect.value = `${statement.module}\0${statement.version}`
        moduleSelect.disabled = editingLocked()
        moduleSelect.onchange = () => {
          const [id, version] = moduleSelect.value.split('\0')
          updateStatement(statement.id, item => { item.module = id; item.version = version; item.inputs = {}; item.parameters = {} })
        }
        parent.append(label('调用模块', moduleSelect))
        if (!current) { parent.append(node('p', `未注册模块：${statement.module || '（空）'}@${statement.version || '（空）'}`, 'gameplay-module-error')); return }
        if (current.description || current.uiDescription || current.effects?.description) parent.append(node('p', current.uiDescription || current.description || current.effects.description, 'gameplay-module-description'))
        const inputs = Array.isArray(current.inputs) ? current.inputs : []
        if (inputs.length) parent.append(node('h4', '输入端口'))
        for (const input of inputs) {
          const value = statement.inputs?.[input.name]
          renderValueEditor(parent, `${input.label || input.name} · ${typeLabel(portType(input))}`, value, portType(input), graph, scope, statementIndex, next => updateStatement(statement.id, item => { item.inputs = { ...(item.inputs || {}) }; if (next) item.inputs[input.name] = next; else delete item.inputs[input.name] }), input)
        }
        const unknownInputs = Object.keys(statement.inputs || {}).filter(name => !inputs.some(input => input.name === name))
        for (const name of unknownInputs) {
          const row = node('div', undefined, 'gameplay-module-invalid-row'); row.append(node('span', `未登记输入：${name}`), button('移除', () => updateStatement(statement.id, item => { delete item.inputs[name] }), 'gameplay-module-button danger')); parent.append(row)
        }
        const parameters = Array.isArray(current.parameters) ? current.parameters : []
        if (parameters.length) parent.append(node('h4', '参数'))
        for (const parameter of parameters) {
          const control = literalControl(statement.parameters?.[parameter.name] ?? defaultForType(parameter), parameter, value => updateStatement(statement.id, item => { item.parameters = { ...(item.parameters || {}), [parameter.name]: value } }), editingLocked())
          parent.append(label(`${parameter.label || parameter.name} · ${typeLabel(portType(parameter))}`, control))
        }
        const unknownParameters = Object.keys(statement.parameters || {}).filter(name => !parameters.some(parameter => parameter.name === name))
        for (const name of unknownParameters) {
          const row = node('div', undefined, 'gameplay-module-invalid-row'); row.append(node('span', `未登记参数：${name}`), button('移除', () => updateStatement(statement.id, item => { delete item.parameters[name] }), 'gameplay-module-button danger')); parent.append(row)
        }
        if (Array.isArray(current.outputs) && current.outputs.length) {
          parent.append(node('h4', '输出端口'))
          for (const output of current.outputs) parent.append(node('p', `${output.name} · ${typeLabel(portType(output))}${output.label ? ` · ${output.label}` : ''}`, 'gameplay-module-output'))
        }
      }

      function renderStatementInspector(parent, statement, graph, scope, index) {
        parent.append(node('h3', `${statementLabels[statement.kind] || '未知节点'} · ${statement.id}`))
        if (statement.kind === 'call') renderCallInspector(parent, statement, graph, scope, index)
        else if (statement.kind === 'if') {
          renderValueEditor(parent, '判断条件 · 布尔值', statement.condition, 'boolean', graph, scope, index, value => updateStatement(statement.id, item => { item.condition = value }), { type: 'boolean', default: true })
          const enter = node('div', undefined, 'gameplay-module-subflows')
          enter.append(button('进入“条件成立”', () => { path.push({ kind: 'child', id: statement.id, slot: 'then' }); selectedId = null; render() }, 'gameplay-module-button secondary'))
          enter.append(button('进入“条件不成立”', () => { path.push({ kind: 'child', id: statement.id, slot: 'else' }); selectedId = null; render() }, 'gameplay-module-button secondary'))
          parent.append(enter)
        } else if (statement.kind === 'foreach') {
          renderValueEditor(parent, '遍历集合', statement.items, { kind: 'list', element: 'unknown' }, graph, scope, index, value => updateStatement(statement.id, item => { item.items = value }), { type: { kind: 'list', element: 'unknown' } })
          const item = document.createElement('input'); item.type = 'text'; item.value = statement.item || ''; item.maxLength = 48; item.disabled = editingLocked(); item.onchange = () => updateStatement(statement.id, value => { value.item = item.value })
          parent.append(label('循环项名称', item))
          const loopIndex = document.createElement('input'); loopIndex.type = 'text'; loopIndex.value = statement.index || ''; loopIndex.maxLength = 48; loopIndex.disabled = editingLocked(); loopIndex.onchange = () => updateStatement(statement.id, value => { value.index = loopIndex.value })
          parent.append(label('循环序号名称', loopIndex))
          parent.append(button('进入循环体', () => { path.push({ kind: 'child', id: statement.id, slot: 'body' }); selectedId = null; render() }, 'gameplay-module-button secondary'))
        } else if (statement.kind === 'return') {
          const outputs = interfaceOwner(graph).outputs || []
          if (outputs.length > 1) {
            parent.append(node('h4', '图输出'))
            for (const output of outputs) renderValueEditor(parent, `${output.label || output.name} · ${typeLabel(portType(output))}`, statement.values?.[output.name], portType(output), graph, scope, index, value => updateStatement(statement.id, item => { item.values = { ...(item.values || {}) }; if (value) item.values[output.name] = value; else delete item.values[output.name] }), output)
          } else if (outputs.length === 1) renderValueEditor(parent, `返回值 · ${outputs[0].label || outputs[0].name}`, statement.value, portType(outputs[0]), graph, scope, index, value => updateStatement(statement.id, item => { item.value = value }), outputs[0])
          else parent.append(node('p', '当前图没有声明输出，返回语句只表示流程完成。', 'gameplay-module-muted'))
        } else {
          parent.append(node('p', `未知语句类型“${statement.kind || '（空）'}”。删除或修复该语句后才能保存。`, 'gameplay-module-error'))
        }
        if (statement.kind !== 'return' || scope.body.length > 1) parent.append(button('删除语句', () => { mutateBody(body => { const at = body.findIndex(item => item?.id === statement.id); if (at >= 0) body.splice(at, 1); if (selectedId === statement.id) selectedId = null }); }, 'gameplay-module-button danger'))
      }

      function renderInterface(parent, graph) {
        const owner = interfaceOwner(graph)
        const details = document.createElement('details'); details.open = true; details.dataset.gameplayGraphInterface = 'true'
        details.append(node('summary', '图输入与输出'))
        const columns = node('div', undefined, 'gameplay-module-port-columns')
        for (const kind of ['inputs', 'outputs']) {
          const column = node('section', undefined, 'gameplay-module-port-list'); column.append(node('h4', kind === 'inputs' ? '输入端口' : '输出端口'))
          const ports = Array.isArray(owner[kind]) ? owner[kind] : []
          ports.forEach((port, index) => {
            const row = node('div', undefined, 'gameplay-module-port-row')
            const name = document.createElement('input'); name.type = 'text'; name.value = port.name || ''; name.placeholder = '名称'; name.disabled = editingLocked(); name.setAttribute('aria-label', `${kind} 端口名称`)
            name.onchange = () => updateGraph(next => {
              const target = interfaceOwner(next)
              const oldName = target[kind][index].name
              target[kind][index].name = name.value
              if (target === next && kind === 'inputs' && oldName !== name.value && record(next.inputBindings) && own(next.inputBindings, oldName)) {
                next.inputBindings = { ...next.inputBindings, [name.value]: next.inputBindings[oldName] }
                delete next.inputBindings[oldName]
              }
            })
            row.append(name, portTypeControl(portType(port), value => updateGraph(next => { interfaceOwner(next)[kind][index].type = value }), editingLocked()))
            row.append(button('删除', () => updateGraph(next => { const target = interfaceOwner(next); const removed = target[kind].splice(index, 1)[0]; if (target === next && kind === 'inputs' && removed?.name && record(next.inputBindings)) { next.inputBindings = { ...next.inputBindings }; delete next.inputBindings[removed.name] } }), 'gameplay-module-button danger'))
            column.append(row)
            if (kind === 'inputs' && owner === graph) {
              const bindings = record(graph.inputBindings) ? graph.inputBindings : {}
              const binding = literalControl(bindings[port.name] ?? defaultForType(port), port, value => updateGraph(next => { next.inputBindings = { ...(next.inputBindings || {}), [port.name]: value } }), editingLocked())
              column.append(label(`${port.name} · 静态输入绑定`, binding, 'gameplay-module-port-binding'))
            }
          })
          column.append(button(`新增${kind === 'inputs' ? '输入' : '输出'}端口`, () => addPort(kind === 'inputs' ? 'input' : 'output'), 'gameplay-module-button secondary'))
          columns.append(column)
        }
        details.append(columns); parent.append(details)
      }

      function renderPalette(parent, graph) {
        const currentSurface = surfaceFor(category, selectedField, graph)
        const descriptors = catalog(core(), graph).filter(item => !Array.isArray(item.allowedSurfaces) || item.allowedSurfaces.includes(currentSurface)).filter(item => {
          const query = search.trim().toLowerCase(); return !query || `${item.id} ${item.label || ''} ${item.description || ''}`.toLowerCase().includes(query)
        })
        const palette = node('aside', undefined, 'gameplay-module-palette'); palette.dataset.gameplayModulePalette = 'true'
        palette.append(node('h3', '模块目录'))
        const query = document.createElement('input'); query.type = 'search'; query.placeholder = '搜索已登记模块'; query.value = search; query.disabled = editingLocked(); query.setAttribute('aria-label', '搜索模块目录'); query.oninput = () => { search = query.value; render() }; palette.append(query)
        if (!descriptors.length) palette.append(node('p', '当前入口没有可用的已登记模块。', 'gameplay-module-muted'))
        for (const descriptor of descriptors) {
          const item = button('', () => addStatement('call', descriptor), 'gameplay-module-palette-item'); item.dataset.gameplayModule = descriptor.id; item.dataset.gameplayModuleVersion = descriptor.version
          item.append(node('strong', descriptor.label || descriptor.id), node('small', `${descriptor.id}@${descriptor.version}`))
          if (descriptor.description || descriptor.uiDescription) item.append(node('span', descriptor.uiDescription || descriptor.description, 'gameplay-module-muted'))
          palette.append(item)
        }
        palette.append(node('h4', '结构语句'))
        palette.append(button('新增条件分支', () => addStatement('if'), 'gameplay-module-palette-item'))
        palette.append(button('新增逐项执行', () => addStatement('foreach'), 'gameplay-module-palette-item'))
        palette.append(button('新增返回结果', () => addStatement('return'), 'gameplay-module-palette-item'))
        if (!path.length) palette.append(button('新增组合模块', addComposite, 'gameplay-module-palette-item'))
        return palette
      }

      function renderComposites(parent, graph) {
        if (!Array.isArray(graph.composites) || !graph.composites.length) return
        const section = node('section', undefined, 'gameplay-module-composites'); section.append(node('h3', '组合模块'))
        for (const composite of graph.composites) {
          const row = node('div', undefined, 'gameplay-module-composite-row')
          row.append(node('span', `${composite.label || composite.id} · ${composite.id}@${composite.version}`))
          row.append(button('进入', () => { path.push({ kind: 'composite', id: composite.id }); selectedId = null; render() }, 'gameplay-module-button secondary'))
          row.append(button('删除', () => updateGraph(next => { next.composites = (next.composites || []).filter(item => item.id !== composite.id) }), 'gameplay-module-button danger'))
          section.append(row)
        }
        parent.append(section)
      }

      function renderBody(parent, graph, scope) {
        const body = node('section', undefined, 'gameplay-module-body'); body.dataset.gameplayModuleBody = 'true'
        const heading = node('div', undefined, 'gameplay-module-body-heading')
        heading.append(node('h3', `${scope.label} · ${scope.body.length} 个语句`))
        heading.append(button('返回上一级', () => { if (path.length) path.pop(); selectedId = null; render() }, 'gameplay-module-button secondary'))
        body.append(heading)
        if (!scope.body.length) body.append(node('p', '此子流程为空。请从左侧加入结构语句或模块调用。', 'gameplay-module-empty'))
        scope.body.forEach((statement, index) => {
          const row = node('article', undefined, 'gameplay-module-statement' + (statement.id === selectedId ? ' selected' : ''))
          row.dataset.gameplayModuleStatement = statement.id || ''
          const main = button('', () => { selectedId = statement.id; render() }, 'gameplay-module-statement-main')
          main.append(node('strong', statementLabels[statement.kind] || `未知 · ${statement.kind || '空'}`), node('code', statement.id || '无 ID'))
          if (statement.kind === 'call') {
            const descriptor = descriptorFor(core(), graph, statement.module, statement.version)
            main.append(node('span', descriptor ? `${descriptor.label || descriptor.id} · ${descriptor.id}@${descriptor.version}` : `未注册模块 · ${statement.module || '（空）'}`, descriptor ? 'gameplay-module-summary' : 'gameplay-module-error'))
          } else if (statement.kind === 'if') main.append(node('span', '进入 then / else 编辑子流程', 'gameplay-module-summary'))
          else if (statement.kind === 'foreach') main.append(node('span', `循环项 ${statement.item || 'item'} · 进入 body 编辑子流程`, 'gameplay-module-summary'))
          else main.append(node('span', '图流程结束或返回值', 'gameplay-module-summary'))
          const actions = node('div', undefined, 'gameplay-module-statement-actions')
          actions.append(button('↑', () => mutateBody(items => { if (index > 0) [items[index - 1], items[index]] = [items[index], items[index - 1]] }), 'gameplay-module-icon-button'))
          actions.append(button('↓', () => mutateBody(items => { if (index < items.length - 1) [items[index + 1], items[index]] = [items[index], items[index + 1]] }), 'gameplay-module-icon-button'))
          actions.append(button('复制', () => mutateBody(items => { const copy = copyStatement(graph, items[index]); items.splice(index + 1, 0, copy); selectedId = copy.id }), 'gameplay-module-icon-button'))
          row.append(main, actions); body.append(row)
        })
        return body
      }

      function breadcrumbs(parent) {
        const nav = node('nav', undefined, 'gameplay-module-breadcrumbs'); nav.setAttribute('aria-label', '模块图位置')
        const rootButton = button('主流程', () => { path = []; selectedId = null; render() }, 'gameplay-module-breadcrumb')
        nav.append(rootButton)
        for (let index = 0; index < path.length; index++) {
          const frame = path[index]
          nav.append(node('span', ' / ', 'gameplay-module-breadcrumb-separator'))
          const title = frame.kind === 'composite' ? `组合 · ${frame.id}` : frame.slot === 'then' ? '条件成立' : frame.slot === 'else' ? '条件不成立' : '循环体'
          nav.append(button(title, () => { path = path.slice(0, index + 1); selectedId = null; render() }, 'gameplay-module-breadcrumb'))
        }
        parent.append(nav)
      }

      function render() {
        if (destroyed) return
        const currentFields = fields()
        if (!currentFields.includes(selectedField)) selectedField = currentFields[0]
        const current = currentGraph()
        container.className = 'gameplay-module-editor'
        container.dataset.gameplayModuleEditor = 'true'
        container.replaceChildren()
        const heading = node('div', undefined, 'gameplay-module-header')
        heading.append(node('h2', `玩法模块图 · ${category}/${selectedField}`))
        heading.append(node('p', '使用已登记模块、类型化参数和数据引用组合玩法；修复完成前的草稿仍可留在编辑器中。', 'gameplay-module-help'))
        const toolbar = node('div', undefined, 'gameplay-module-toolbar')
        if (currentFields.length > 1 || currentFields[0] !== initialField) {
          const fieldSelect = document.createElement('select'); fieldSelect.setAttribute('aria-label', '模块图入口')
          for (const field of currentFields) { const option = node('option', `${field === 'previewCode' ? '预览入口' : '执行入口'} · ${field}`); option.value = field; fieldSelect.append(option) }
          fieldSelect.value = selectedField; fieldSelect.disabled = editingLocked(); fieldSelect.onchange = () => { selectedField = fieldSelect.value; path = []; selectedId = null; message = ''; render() }; toolbar.append(fieldSelect)
        }
        if (current) toolbar.append(button('重新检查图', () => { message = validateGraph(current) || '模块图检查通过。'; render() }, 'gameplay-module-button secondary'))
        else toolbar.append(button('建立模块图', () => { selectedId = null; path = []; writeGraph(starterGraph(surfaceFor(category, selectedField, null), core())) }, 'gameplay-module-button primary'))
        container.append(heading, toolbar)
        if (!current) { container.append(node('section', undefined, 'gameplay-module-empty-state')); const empty = container.lastChild; empty.append(node('h3', '这个内容还没有作者层模块图'), node('p', '建立后可从模块目录加入调用、分支、逐项执行和返回语句。旧脚本字段不会在这里编辑。')); return }
        const validation = validateGraph(current)
        const notice = node('p', message || validation || '模块图已载入。选择语句后编辑参数与数据端口。', message && validation ? 'gameplay-module-error' : validation ? 'gameplay-module-error' : 'gameplay-module-notice'); notice.setAttribute('role', 'status'); container.append(notice)
        breadcrumbs(container)
        renderInterface(container, current)
        renderComposites(container, current)
        const scope = activeScope(current)
        const layout = node('div', undefined, 'gameplay-module-layout')
        layout.append(renderPalette(layout, current), renderBody(layout, current, scope))
        const inspector = node('aside', undefined, 'gameplay-module-inspector'); inspector.dataset.gameplayModuleInspector = 'true'
        const statement = selectedStatement(current)
        if (statement) {
          const index = scope.body.findIndex(item => item?.id === statement.id)
          renderStatementInspector(inspector, statement, current, scope, index)
        } else inspector.append(node('h3', '语句检查器'), node('p', '从流程中选择一个语句来编辑参数、数据引用和子流程。', 'gameplay-module-muted'))
        layout.append(inspector); container.append(layout)
      }

      const api = {
        refresh: () => { message = ''; render() },
        setLocked: value => { locked = Boolean(value); render() },
        destroy: () => { destroyed = true; container.replaceChildren() },
      }
      render()
      return api
    },
  }
})()
