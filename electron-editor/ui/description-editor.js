/* Description-only expression insertion for the JSON-first content editor. */
(() => {
  const PURE_MATH_MODULES = new Set([
    'math.add', 'math.subtract', 'math.multiply', 'math.divide', 'math.modulo', 'math.power',
    'math.floor', 'math.abs', 'math.min', 'math.max',
  ])
  const SURFACES = { skills: 'skill', cards: 'card', rules: 'rule', pieces: 'pending' }
  const DECLARATION_PATTERN = /^extension\.declare-(player|piece|battle|instance)$/u
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const text = value => value === null || value === undefined ? '' : String(value)

  function typeFromValue(value) {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return typeof value
    if (Array.isArray(value)) return { kind: 'list', element: value.length ? typeFromValue(value[0]) : 'unknown' }
    if (record(value)) return 'record'
    return 'unknown'
  }

  function parseDeclaredType(value) {
    if (typeof value !== 'string') return value || 'record'
    const source = value.trim()
    if (!source) return 'record'
    if (source[0] === '{' || source[0] === '[') {
      try { return JSON.parse(source) } catch { return source }
    }
    return source
  }

  function extensionDeclaration(statement) {
    if (!record(statement) || statement.kind !== 'call') return null
    const parameters = record(statement.parameters) ? statement.parameters : {}
    if (statement.module === 'extension.map-declare') {
      const name = text(parameters.name).trim()
      if (!name) return null
      return { scope: 'card', namespace: text(parameters.namespace).trim() || 'content', name, type: 'record' }
    }
    const match = text(statement.module).match(DECLARATION_PATTERN)
    if (!match) return null
    const name = text(parameters.name).trim()
    if (!name) return null
    const scope = match[1] === 'instance' ? text(parameters.entityKind).trim() : match[1]
    if (!scope) return null
    return {
      scope,
      namespace: text(parameters.namespace).trim() || 'content',
      name,
      type: parseDeclaredType(parameters.valueType),
    }
  }

  function collectDeclarations(value, result, seen) {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach(item => collectDeclarations(item, result, seen))
      return
    }
    const declaration = extensionDeclaration(value)
    if (declaration) result.push(declaration)
    for (const child of Object.values(value)) collectDeclarations(child, result, seen)
  }

  function extensionMetadata(draft, surface) {
    const values = []
    collectDeclarations(draft?.gameplayModules, values, new Set())
    collectDeclarations(draft?.contentGraph, values, new Set())
    for (const entry of Object.values(draft?.contentGraphEntries || {})) collectDeclarations(entry?.graph, values, new Set())
    // Existing document extensions are safe completion metadata. Their values
    // are never read by this editor and are never used to preview a result.
    if (record(draft?.extension)) {
      const extensionScope = surface === 'pending' ? 'piece' : surface
      for (const [name, value] of Object.entries(draft.extension)) {
        if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) values.push({ scope: extensionScope, namespace: 'content', name, type: typeFromValue(value) })
      }
    }
    const unique = new Map()
    for (const item of values) {
      if (!item?.name || !item?.scope) continue
      const key = `${item.scope}\u0000${item.namespace || 'content'}\u0000${item.name}`
      if (!unique.has(key)) unique.set(key, { ...item, namespace: item.namespace || 'content' })
    }
    return [...unique.values()]
  }

  function normaliseExpression(value) {
    const source = text(value).trim()
    if (source.length >= 2 && source.startsWith('{') && source.endsWith('}')) return source.slice(1, -1).trim()
    return source
  }

  function pureCandidate(candidate, core) {
    if (!candidate || !/函数|方法|function/i.test(text(candidate.kind))) return true
    const name = text(candidate.value || candidate.label).replace(/\s*\([^()]*\)\s*$/u, '').trim()
    const spec = core?.authorFunctionSpecs?.[name]
    if (!spec || !PURE_MATH_MODULES.has(spec.module)) return false
    const descriptor = typeof core?.getGameplayModule === 'function' ? core.getGameplayModule(spec.module) : null
    return descriptor?.effects?.pure === true
  }

  function mount(container, options = {}) {
    if (!container || typeof container.querySelector !== 'function') return { destroy() {} }
    const textarea = container.querySelector('[data-description-input]')
    const openButton = container.querySelector('[data-description-expression-open]')
    const panel = container.querySelector('[data-description-expression-panel]')
    const inputHost = container.querySelector('[data-description-expression-input]')
    const status = container.querySelector('[data-description-expression-status]')
    const typeHint = container.querySelector('[data-description-expression-type]')
    const applyButton = container.querySelector('[data-description-expression-apply]')
    const closeButton = container.querySelector('[data-description-expression-close]')
    if (!textarea || !openButton || !panel || !inputHost || !applyButton || !closeButton) return { destroy() {} }
    const core = options.core || globalThis.ContentGraphCore
    let widget = null
    let destroyed = false
    let composition = false
    let expression = ''
    let selection = null

    const context = () => {
      const draft = typeof options.getDraft === 'function' ? options.getDraft() : options.draft
      const surface = options.surface || SURFACES[options.subdir] || 'pending'
      return {
        surface,
        schemas: Array.isArray(draft?.schemas) ? draft.schemas : undefined,
        extensions: extensionMetadata(draft, surface),
      }
    }

    const suggestions = (_query, details = {}) => {
      if (typeof core?.completeAuthorExpression !== 'function') return []
      try {
        const result = core.completeAuthorExpression(text(details.prefix), context())
        return (Array.isArray(result) ? result : []).filter(candidate => pureCandidate(candidate, core))
      } catch {
        return []
      }
    }

    const parse = value => {
      const source = normaliseExpression(value)
      if (!source) return { source, valid: false, message: '请输入表达式。' }
      if (typeof core?.parseAuthorExpression !== 'function') return { source, valid: false, message: '表达式解析器尚未加载。' }
      try {
        core.parseAuthorExpression(source)
        return { source, valid: true, message: '语法有效；插入时不会读取实例数值。' }
      } catch (error) {
        return { source, valid: false, message: text(error?.message || error) }
      }
    }

    const refreshState = value => {
      expression = text(value)
      const result = parse(expression)
      status.textContent = result.message
      status.dataset.valid = result.valid ? 'true' : 'false'
      applyButton.disabled = !result.valid || composition
      typeHint.textContent = ''
      if (typeof core?.authorExpressionParameterHint === 'function') {
        try {
          const hint = core.authorExpressionParameterHint(expression, context())
          if (hint?.type) typeHint.textContent = hint.label ? `${hint.label} · ${hint.type}` : hint.type
        } catch { /* Syntax status already explains an incomplete expression. */ }
      }
    }

    const close = () => {
      if (widget) widget.destroy()
      widget = null
      inputHost.replaceChildren()
      panel.hidden = true
      status.textContent = ''
      typeHint.textContent = ''
      expression = ''
      selection = null
    }

    const open = () => {
      if (destroyed) return
      selection = {
        start: Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length,
        end: Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : textarea.value.length,
      }
      panel.hidden = false
      inputHost.replaceChildren()
      expression = ''
      widget = typeof globalThis.ExpressionInput?.mount === 'function' ? globalThis.ExpressionInput.mount(inputHost, {
        label: '表达式',
        placeholder: '例如 当前手牌.extension.伤害量 * 2',
        getSuggestions: suggestions,
        getParameterHint: details => typeof core?.authorExpressionParameterHint === 'function' ? core.authorExpressionParameterHint(text(details?.prefix), context()) : null,
        onChange: value => { if (!composition) refreshState(value) },
        onCompositionStart: () => { composition = true; applyButton.disabled = true },
        onCompositionEnd: () => { composition = false; refreshState(widget?.getText?.() || expression) },
      }) : null
      if (!widget) {
        status.textContent = '表达式联想控件尚未加载。'
        applyButton.disabled = true
        return
      }
      refreshState('')
      widget.focus()
    }

    const apply = () => {
      if (destroyed || composition || !selection) return
      const result = parse(expression)
      if (!result.valid) { refreshState(expression); return }
      const before = textarea.value.slice(0, selection.start)
      const after = textarea.value.slice(selection.end)
      const inserted = `{${result.source}}`
      textarea.value = before + inserted + after
      const caret = before.length + inserted.length
      textarea.focus()
      textarea.setSelectionRange(caret, caret)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      close()
    }

    openButton.addEventListener('click', open)
    closeButton.addEventListener('click', close)
    applyButton.addEventListener('click', apply)
    const onDocumentPointerDown = event => {
      if (!panel.hidden && !container.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', onDocumentPointerDown)

    return {
      destroy() {
        if (destroyed) return
        destroyed = true
        openButton.removeEventListener('click', open)
        closeButton.removeEventListener('click', close)
        applyButton.removeEventListener('click', apply)
        document.removeEventListener('pointerdown', onDocumentPointerDown)
        close()
      },
      open,
      close,
    }
  }

  globalThis.DescriptionEditor = { mount }
})()
