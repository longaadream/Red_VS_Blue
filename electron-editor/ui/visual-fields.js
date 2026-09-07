/* Structured controls edit the existing document without dropping extension fields. */
(() => {
  let sequence = 0
  const element = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  window.ContentVisualFields = {
    mount(container, { subdir, catalog, getDraft, onChange, openSkill, openRule }) {
      container.className = 'visual-fields'
      const commit = (key, value) => { onChange({ ...getDraft(), [key]: value }); refresh() }
      const button = (label, action) => {
        const node = element('button', label, 'btn btn-sm')
        node.type = 'button'
        node.onclick = action
        return node
      }
      const section = (label, key) => {
        const node = element('section', undefined, 'vf-section')
        node.dataset.visualField = key
        node.append(element('h3', label))
        container.append(node)
        return node
      }
      const problem = node => node.append(element('p', '当前字段格式不符合要求，请先在 JSON 中修正；原始内容已保留。', 'vf-error'))
      const chooser = (node, choices, placeholder, add) => {
        const row = element('div', undefined, 'vf-row')
        const input = element('input')
        input.placeholder = placeholder
        input.setAttribute('aria-label', placeholder)
        const list = element('datalist')
        list.id = `visual-options-${++sequence}`
        input.setAttribute('list', list.id)
        for (const choice of choices) {
          const option = element('option', choice.label)
          option.value = choice.value
          list.append(option)
        }
        const submit = () => { if (input.value.trim()) add(input.value.trim()) }
        input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }
        row.append(input, list, button('添加', submit))
        node.append(row)
      }
      const chips = (key, title, choices) => {
        const node = section(title, key)
        const values = getDraft()[key] ?? []
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) { problem(node); return }
        const row = element('div', undefined, 'vf-chips')
        values.forEach((value, index) => {
          const chip = element('span', undefined, 'vf-chip')
          chip.append(element('span', choices.find(choice => choice.value === value)?.label || value))
          const remove = button('×', () => commit(key, values.filter((_, position) => position !== index)))
          remove.setAttribute('aria-label', `移除 ${value}`)
          chip.append(remove)
          row.append(chip)
        })
        node.append(row)
        if (!values.length) node.append(element('p', '尚未设置', 'vf-muted'))
        chooser(node, choices, '搜索或输入标签', value => { if (!values.includes(value)) commit(key, [...values, value]) })
      }
      const associations = () => {
        const node = section('角色技能', 'skills')
        const values = getDraft().skills ?? []
        if (!Array.isArray(values) || values.some(value => !value || typeof value !== 'object' || Array.isArray(value) || typeof value.skillId !== 'string')) { problem(node); return }
        values.forEach((value, index) => {
          const skill = catalog.skills.find(item => item.id === value.skillId)
          const card = element('div', undefined, 'vf-card')
          card.append(element('strong', skill ? skill.name || skill.id : `${value.skillId}（未找到技能）`))
          card.append(element('p', value.skillId, 'vf-muted'))
          const keywords = Array.isArray(skill?.keywords) ? skill.keywords.filter(item => typeof item === 'string') : []
          if (keywords.length) card.append(element('p', keywords.join(' · '), 'vf-tags'))
          const row = element('div', undefined, 'vf-row')
          const label = element('label', '等级 ')
          const level = element('input')
          level.type = 'number'; level.min = '1'; level.step = '1'; level.value = value.level ?? 1
          level.setAttribute('aria-label', `${value.skillId} 等级`)
          level.onchange = () => {
            if (!level.checkValidity() || !level.value) { level.reportValidity(); return }
            commit('skills', values.map((item, position) => position === index ? { ...item, level: Number(level.value) } : item))
          }
          label.append(level)
          row.append(label, button('编辑技能与标签', () => openSkill(value.skillId)), button('移除关联', () => commit('skills', values.filter((_, position) => position !== index))))
          card.append(row); node.append(card)
        })
        chooser(node, catalog.skills.map(skill => ({ value: skill.id, label: skill.name || skill.id })), '搜索技能名称或 ID', input => {
          const skill = catalog.skills.find(item => item.id === input) || catalog.skills.find(item => item.name === input)
          if (!skill) { const notice = element('p', '请选择目录中已有的技能。', 'vf-error'); node.append(notice); return }
          if (!values.some(item => item.skillId === skill.id)) commit('skills', [...values, { skillId: skill.id, level: 1 }])
        })
      }
      const ruleAssociations = (key, title, description) => {
        const node = section(title, key)
        node.append(element('p', description, 'vf-muted'))
        const values = getDraft()[key] === undefined ? [] : getDraft()[key]
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) { problem(node); return }
        const rules = catalog.rules.filter(rule => typeof rule.id === 'string' && rule.id.trim())
        values.forEach((id, index) => {
          const rule = rules.find(item => item.id === id)
          const card = element('div', undefined, 'vf-card')
          card.append(element('strong', rule ? rule.name || id : `${id}（未找到规则）`), element('p', id, 'vf-muted'))
          const row = element('div', undefined, 'vf-row')
          const edit = button('编辑规则', () => openRule(id))
          edit.disabled = !rule
          row.append(edit, button('移除关联', () => commit(key, values.filter((_, position) => position !== index))))
          card.append(row); node.append(card)
        })
        if (!values.length) node.append(element('p', '尚未关联规则', 'vf-muted'))
        chooser(node, rules.map(rule => ({ value: rule.id, label: rule.name || rule.id })), '搜索规则名称或 ID', input => {
          const matches = rules.filter(rule => rule.id === input)
          const choices = matches.length ? matches : rules.filter(rule => rule.name === input)
          if (choices.length !== 1) { node.append(element('p', choices.length ? '有重名规则，请选择具体 ID。' : '请选择目录中已有的规则。', 'vf-error')); return }
          const id = choices[0].id
          if (!values.includes(id)) commit(key, [...values, id])
        })
      }
      const statuses = (key, title) => {
        const node = section(title, key)
        const original = getDraft()[key]
        const values = original === undefined || (key === 'statusTag' && original === null) ? [] : Array.isArray(original) ? original : [original]
        if ((key === 'initialStatusTags' && original !== undefined && !Array.isArray(original)) || values.some(value => !value || typeof value !== 'object' || Array.isArray(value))) { problem(node); return }
        const save = next => commit(key, key === 'statusTag' && !Array.isArray(original) && next.length === 1 ? next[0] : next)
        values.forEach((value, index) => {
          const card = element('div', undefined, 'vf-card')
          const update = (field, next) => save(values.map((item, position) => position === index ? { ...item, [field]: next } : item))
          const fields = element('div', undefined, 'vf-grid')
          const specification = key === 'statusTag'
            ? [['id', '状态 ID'], ['type', '类型'], ['name', '名称'], ['rule', '规则 ID'], ['rules', '关联规则（逗号分隔）', 'array']]
            : [['id', '状态 ID'], ['type', '类型'], ['name', '名称'], ['relatedRules', '关联规则（逗号分隔）', 'array'], ['currentDuration', '持续回合', 'number'], ['stacks', '层数', 'number'], ['value', '数值', 'number']]
          for (const [field, title, type] of specification) {
            const label = element('label', title)
            const input = element('input')
            input.type = type === 'number' ? 'number' : 'text'
            input.setAttribute('aria-label', `${key} ${index + 1} ${title}`)
            const current = value[field]
            if (current !== undefined && (type === 'array' ? !Array.isArray(current) || current.some(item => typeof item !== 'string') : typeof current !== (type === 'number' ? 'number' : 'string'))) {
              input.disabled = true; input.placeholder = '格式异常，请在 JSON 中修正'
            } else input.value = type === 'array' ? (current || []).join(', ') : current ?? ''
            input.onchange = () => {
              if (!input.checkValidity()) { input.reportValidity(); return }
              if (type === 'number' && input.value === '') {
                const next = { ...value }; delete next[field]
                save(values.map((item, position) => position === index ? next : item)); return
              }
              update(field, type === 'array' ? input.value.split(/[,，]/).map(item => item.trim()).filter(Boolean) : type === 'number' ? Number(input.value) : input.value)
            }
            label.append(input); fields.append(label)
          }
          card.append(fields, button('移除状态标签', () => save(values.filter((_, position) => position !== index))))
          node.append(card)
        })
        node.append(button('新增状态标签', () => save([...values, { id: '', type: key === 'statusTag' ? 'skill-rule' : 'status', name: '' }])))
      }
      function refresh() {
        container.replaceChildren()
        if (catalog.errors?.length) container.append(element('p', `部分目录读取失败：${catalog.errors.join('；')}`, 'vf-error'))
        if (subdir === 'pieces') {
          associations()
          ruleAssociations('rules', '棋子规则', '作用于这枚棋子的可执行规则。')
          ruleAssociations('playerRules', '玩家规则', '开局时授予所属玩家一次，不依赖棋子是否部署或存活。')
          statuses('initialStatusTags', '角色初始状态')
        }
        if (subdir === 'skills' || subdir === 'cards') {
          chips('keywords', '技能关键词', catalog.keywords.filter(item => item && typeof item.name === 'string').map(item => ({ value: item.name, label: item.name })))
          const labels = { damage: '伤害', recovery: '恢复', control: '控制', summon: '召唤', movement: '移动' }
          chips('effectTags', '效果分类', catalog.effects.map(value => ({ value, label: labels[value] ? `${labels[value]} · ${value}` : value })))
          container.append(element('p', '关键词和效果分类用于描述与展示；实际效果仍由技能代码决定。', 'vf-muted'))
          if (subdir === 'skills') statuses('statusTag', '技能状态标签')
        }
      }
      refresh()
      return { refresh }
    },
  }
})()
