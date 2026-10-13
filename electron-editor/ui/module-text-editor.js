/* Shared author text templates: parameter choices come from the compiler core. */
;(function () {
  const clone = value => JSON.parse(JSON.stringify(value))
  const element = (tag, text, className) => {
    const item = document.createElement(tag)
    if (text !== undefined) item.textContent = text
    if (className) item.className = className
    return item
  }
  function mount(container, options) {
    const core = options.core || window.ContentGraphCore
    let buffer = null
    let renderedSource = ''
    let expanded = false
    let destroyed = false
    const signatureOf = draft => JSON.stringify([draft.gameplayModules?.entries, draft.gameplayModules?.textBindings, draft.description, draft.targetText])
    // Text edits share the document draft. Switching members or pressing the
    // workbench Save button must never silently discard a local form buffer.
    function publish(error) {
      const draft = options.getDraft()
      let next
      try {
        next = core.applyGameplayModuleTextBindings(draft, buffer)
        if (error) error.textContent = ''
      } catch (failure) {
        next = clone(draft)
        next.gameplayModules.textBindings = clone(buffer)
        if (error) error.textContent = failure.message || String(failure)
      }
      renderedSource = signatureOf(next)
      options.onChange?.(next)
    }
    const button = (label, action) => {
      const item = element('button', label, 'btn btn-ghost')
      item.type = 'button'; item.onclick = action
      return item
    }
    function render(force = false) {
      if (destroyed) return
      const draft = options.getDraft?.() || {}
      const entries = draft.gameplayModules?.entries
      if (!entries || !core?.getGameplayModuleTextSources) { container.replaceChildren(); return }
      const signature = signatureOf(draft)
      if (!force && signature === renderedSource) return
      if (signature !== renderedSource) buffer = null
      renderedSource = signature
      if (!buffer) buffer = clone(draft.gameplayModules.textBindings || {})
      const sources = core.getGameplayModuleTextSources(entries)
      const panel = element('details', undefined, 'module-text-editor')
      panel.open = expanded
      panel.ontoggle = () => { expanded = panel.open }
      panel.append(element('summary', '说明文字 · 关联效果参数'))
      panel.append(element('p', '插入效果中的参数后，参数修改会同步更新说明文字。战斗时才确定的结果不会被猜测为固定数值。', 'module-text-hint'))
      const error = element('p', '', 'module-text-error'); error.setAttribute('role', 'alert')
      try { core.renderGameplayModuleText(entries, buffer) }
      catch (failure) { error.textContent = failure.message || String(failure) }
      for (const [field, label] of [['description', '内容说明'], ['targetText', '目标提示']]) {
        const section = element('section')
        const heading = element('label', label)
        const template = element('textarea')
        template.dataset.moduleTextTemplate = field
        template.value = buffer[field]?.template ?? draft[field] ?? ''
        template.setAttribute('aria-label', label + '模板')
        const ensure = () => (buffer[field] ||= { template: template.value, values: {} })
        template.oninput = () => { ensure().template = template.value; publish(error) }
        heading.append(template); section.append(heading)
        const controls = element('div', undefined, 'module-text-controls')
        const chooser = element('select')
        chooser.dataset.moduleTextSource = field
        chooser.setAttribute('aria-label', label + '可关联的效果参数')
        chooser.append(new Option('选择要插入的参数', ''))
        sources.forEach((item, index) => {
          const option = new Option(`${item.label} = ${String(item.value)}`, String(index))
          option.dataset.moduleTextNode = item.source.node || ''
          option.dataset.moduleTextParameter = item.source.parameter || item.source.input || ''
          chooser.append(option)
        })
        const insert = button('插入参数', () => {
          if (chooser.value === '') return
          const value = ensure()
          let index = 1
          while (Object.hasOwn(value.values, `value${index}`)) index++
          const token = `value${index}`
          value.values[token] = clone(sources[Number(chooser.value)].source)
          const start = template.selectionStart ?? template.value.length
          const end = template.selectionEnd ?? start
          value.template = template.value.slice(0, start) + `{{${token}}}` + template.value.slice(end)
          publish(error); expanded = true; render(true)
        })
        insert.dataset.moduleTextInsert = field
        controls.append(chooser, insert); section.append(controls)
        for (const [token, source] of Object.entries(buffer[field]?.values || {})) {
          const row = element('div', undefined, 'module-text-controls')
          const item = sources.find(candidate => JSON.stringify(candidate.source) === JSON.stringify(source))
          row.append(element('span', `{{${token}}} ← ${item?.label || '关联参数已失效'}`))
          row.append(button('移除关联', () => {
            const binding = ensure()
            binding.template = template.value.split(`{{${token}}}`).join(item ? String(item.value) : '')
            delete binding.values[token]; publish(error); render(true)
          }))
          section.append(row)
        }
        panel.append(section)
      }
      const actions = element('div', undefined, 'module-text-controls')
      const apply = button('检查说明', () => {
        try {
          const next = core.applyGameplayModuleTextBindings(options.getDraft(), buffer)
          buffer = null
          options.onChange?.(next)
          options.notify?.('说明有效，已加入当前文档草稿。', 'success')
          render(true)
        } catch (failure) { error.textContent = failure.message || String(failure) }
      })
      apply.dataset.moduleTextApply = ''
      actions.append(apply)
      panel.append(error, actions); container.replaceChildren(panel)
    }
    render()
    return { refresh: () => render(), destroy: () => { destroyed = true; container.replaceChildren() } }
  }
  window.ModuleTextEditor = { mount }
})()
