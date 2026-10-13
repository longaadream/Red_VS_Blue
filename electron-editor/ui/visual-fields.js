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
    mount(container, { subdir, catalog, getDraft, onChange, openSkill, openRule, listAssets, readAsset }) {
      container.className = 'visual-fields'
      const commit = (key, value) => { onChange({ ...getDraft(), [key]: value }); refresh() }
      const assetApi = {
        listAssets: listAssets || (() => window.editorAPI?.listAssets?.() || Promise.resolve([])),
        readAsset: readAsset || (path => window.editorAPI?.readAsset?.(path)),
      }
      const normalizeAssetPath = value => {
        if (typeof value !== 'string') return ''
        let path = value.trim().replaceAll('\\', '/')
        if (path.startsWith('images/')) path = path.slice('images/'.length)
        if (path.startsWith('./')) path = path.slice(2)
        if (!path || path.startsWith('/') || path.includes('..') || path.includes(':') || path.startsWith('data:')) return ''
        return path
      }
      const storedAssetPath = value => {
        const relative = normalizeAssetPath(value)
        return relative ? `images/${relative}` : ''
      }
      const materialLabels = {
        'player-soul-fracture.svg': '裂魂',
        'divine-shield.svg': '神圣护盾',
        'calm-shield.svg': '宁静护盾',
        'kamui-shield.svg': '神威护盾',
        'sage-mode-shield.svg': '仙人护盾',
        'shield.svg': '护盾',
        'burn.svg': '火焰',
        'blizzard.svg': '暴风雪',
        'fireball.svg': '火球',
      }
      const materialDisplayName = (file, index) => {
        const metadata = file && typeof file === 'object'
          ? [file.displayName, file.title, file.label, file.name].find(value => typeof value === 'string' && value.trim())
          : ''
        if (metadata) return metadata.trim()
        const relative = normalizeAssetPath(typeof file === 'string' ? file : file?.path)
        const basename = relative.split('/').pop() || ''
        return materialLabels[basename] || `图片素材 ${index + 1}`
      }
      const appendAssetPreview = (host, value) => {
        const relative = normalizeAssetPath(value)
        if (!relative) {
          host.append(element('p', '未选择图标素材。', 'vf-muted'))
          return
        }
        const note = element('p', '正在读取图标…', 'vf-muted')
        const image = element('img')
        image.alt = ''
        image.hidden = true
        image.style.maxWidth = '64px'
        image.style.maxHeight = '64px'
        image.style.objectFit = 'contain'
        host.append(image, note)
        Promise.resolve().then(() => assetApi.readAsset(relative)).then(source => {
          if (!image.isConnected) return
          if (typeof source !== 'string' || !/^data:image\//i.test(source)) throw new Error('图片资源返回格式无效。')
          image.src = source
          image.hidden = false
          note.remove()
        }).catch(() => {
          if (image.isConnected) note.textContent = '图片素材不可用。'
        })
      }
      const assetPicker = (node, key, title, description) => {
        const value = storedAssetPath(getDraft()[key])
        node.append(element('p', description, 'vf-muted'))
        const row = element('div', undefined, 'vf-row')
        const label = element('label', title)
        const select = element('select')
        select.setAttribute('aria-label', title)
        const loading = element('option', '正在读取素材…')
        loading.value = ''
        select.append(loading)
        select.onchange = () => commit(key, storedAssetPath(select.value))
        label.append(select)
        row.append(label)
        node.append(row)
        const preview = element('div', undefined, 'vf-asset-preview')
        preview.dataset.visualAssetPreview = key
        appendAssetPreview(preview, value)
        node.append(preview)
        Promise.resolve().then(() => assetApi.listAssets()).then(files => {
          if (!select.isConnected) return
          const entries = (Array.isArray(files) ? files : []).map((file, index) => ({
            path: normalizeAssetPath(typeof file === 'string' ? file : file?.path),
            label: materialDisplayName(file, index),
          })).filter(entry => entry.path)
            .filter((entry, index, values) => values.findIndex(item => item.path === entry.path) === index)
            .sort((left, right) => left.path.localeCompare(right.path))
          const paths = entries.map(entry => entry.path)
          select.replaceChildren()
          const blank = element('option', paths.length ? '不使用图标' : '没有可用图片素材')
          blank.value = ''
          select.append(blank)
          if (value && !paths.includes(normalizeAssetPath(value))) {
            const missing = element('option', '当前图标（素材暂不可用）')
            missing.value = value
            select.append(missing)
          }
          entries.forEach(entry => {
            const option = element('option', entry.label)
            option.value = `images/${entry.path}`
            select.append(option)
          })
          select.value = value
        }).catch(() => {
          if (select.isConnected) select.replaceChildren(element('option', '素材库读取失败'))
        })
      }
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
      const problem = node => node.append(element('p', '当前字段格式不符合要求；原始内容已保留。请检查该对象的字段类型。', 'vf-error'))
      const chooser = (node, choices, placeholder, add) => {
        const row = element('div', undefined, 'vf-row')
        const input = element('input')
        input.placeholder = placeholder
        input.setAttribute('aria-label', placeholder)
        const list = element('datalist')
        list.id = `visual-options-${++sequence}`
        input.setAttribute('list', list.id)
        const names = choices.map((choice, index) => ({ ...choice, display: choices.filter(item => item.label === choice.label).length > 1 ? `${choice.label}（第 ${index + 1} 项）` : choice.label }))
        for (const choice of names) {
          const option = element('option')
          option.value = choice.display
          list.append(option)
        }
        const submit = () => { if (input.value.trim()) add(names.find(choice => choice.display === input.value.trim())?.value ?? input.value.trim()) }
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
          remove.setAttribute('aria-label', `移除 ${choices.find(choice => choice.value === value)?.label || '该项'}`)
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
          card.append(element('strong', skill ? skill.name || '未命名技能' : '未找到关联技能'))
          const keywords = Array.isArray(skill?.keywords) ? skill.keywords.filter(item => typeof item === 'string') : []
          if (keywords.length) card.append(element('p', keywords.join(' · '), 'vf-tags'))
          const row = element('div', undefined, 'vf-row')
          const label = element('label', '等级 ')
          const level = element('input')
          level.type = 'number'; level.min = '1'; level.step = '1'; level.value = value.level ?? 1
          level.setAttribute('aria-label', `${skill?.name || '技能'} 等级`)
          level.onchange = () => {
            if (!level.checkValidity() || !level.value) { level.reportValidity(); return }
            commit('skills', values.map((item, position) => position === index ? { ...item, level: Number(level.value) } : item))
          }
          label.append(level)
          row.append(label, button('编辑技能与标签', () => openSkill(value.skillId)), button('移除关联', () => commit('skills', values.filter((_, position) => position !== index))))
          card.append(row); node.append(card)
        })
        chooser(node, catalog.skills.map(skill => ({ value: skill.id, label: skill.name || '未命名技能' })), '搜索技能名称', input => {
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
          card.append(element('strong', rule ? rule.name || '未命名规则' : '未找到关联规则'))
          const row = element('div', undefined, 'vf-row')
          const edit = button('编辑规则', () => openRule(id))
          edit.disabled = !rule
          row.append(edit, button('移除关联', () => commit(key, values.filter((_, position) => position !== index))))
          card.append(row); node.append(card)
        })
        if (!values.length) node.append(element('p', '尚未关联规则', 'vf-muted'))
        chooser(node, rules.map(rule => ({ value: rule.id, label: rule.name || '未命名规则' })), '搜索规则名称', input => {
          const matches = rules.filter(rule => rule.id === input)
          const choices = matches.length ? matches : rules.filter(rule => rule.name === input)
          if (choices.length !== 1) { node.append(element('p', choices.length ? '有重名规则，请从候选列表选择具体一项。' : '请选择目录中已有的规则。', 'vf-error')); return }
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
          const fields = element('div')
          window.SkillClusterEditor.mountStatusValue(fields, {
            memberId: value.id || `${key}:${index}`,
            source: { collection:subdir, id:getDraft().id },
            getValue: () => value,
            listAssets: assetApi.listAssets,
            readAsset: assetApi.readAsset,
            onChange: next => save(values.map((item, position) => position === index ? next : item)),
          })
          card.append(fields, button('移除状态标签', () => save(values.filter((_, position) => position !== index))))
          node.append(card)
        })
        node.append(button('新增状态标签', () => {
          const id = `status-${crypto.randomUUID()}`
          save([...values, { id, type:id, name:'新状态', visible:true, stacks:1, currentDuration:1 }])
        }))
      }
      function refresh() {
        container.replaceChildren()
        if (catalog.errors?.length) container.append(element('p', `部分目录读取失败：${catalog.errors.join('；')}`, 'vf-error'))
        if (['pieces', 'cards', 'skills', 'maps', 'rules'].includes(subdir)) {
          const draft = getDraft(), node = section('可用模式', 'availability')
          const availability = draft.availability
          if (availability && (!Array.isArray(availability.modes) || !['ready', 'draft'].includes(availability.status))) problem(node)
          else {
            const select = element('select'); select.setAttribute('aria-label', '可用模式')
            for (const [value, label] of [['pvp,pve', '玩家对战与冒险'], ['pvp', '仅玩家对战'], ['pve', '仅冒险']]) {
              const option = element('option', label); option.value = value; select.append(option)
            }
            select.value = availability?.modes.length === 1 ? availability.modes[0] : 'pvp,pve'
            select.onchange = () => commit('availability', { ...availability, modes: select.value.split(','), status: availability?.status || 'ready' })
            const status = element('select'); status.setAttribute('aria-label', '内容状态')
            for (const [value, label] of [['ready', '可用'], ['draft', '草案（不可上场）']]) { const option = element('option', label); option.value = value; status.append(option) }
            status.value = availability?.status || 'ready'
            status.onchange = () => commit('availability', { ...availability, modes: availability?.modes || ['pvp', 'pve'], status: status.value })
            node.append(select, status)
          }
        }
        if (subdir === 'cards' && getDraft().adventurePower !== undefined) {
          const power = getDraft().adventurePower, node = section('冒险卡牌威力', 'adventurePower')
          if (!power || typeof power.baseDamage !== 'number' || typeof power.usesGrowth !== 'boolean') problem(node)
          else {
            const base = element('input'); base.type = 'number'; base.min = '0'; base.step = 'any'; base.value = power.baseDamage; base.setAttribute('aria-label', '基础威力')
            base.onchange = () => { if (base.value !== '' && base.checkValidity()) commit('adventurePower', { ...power, baseDamage: Number(base.value) }) }
            const label = element('label', '使用同名牌成长'), growth = element('input'); growth.type = 'checkbox'; growth.checked = power.usesGrowth
            growth.onchange = () => commit('adventurePower', { ...power, usesGrowth: growth.checked })
            label.append(growth); node.append(base, label)
          }
        }
        if (subdir === 'rules') {
          const node = section('玩家规则表现', 'playerRulePresentation')
          assetPicker(node, 'iconPath', '玩家规则图标', '规则被挂到棋子的玩家规则后，局内玩家状态栏会显示此名称、说明和图标。图标只能从当前项目的素材库选择；清除后使用默认占位图标。')
        }
        if (subdir === 'pieces') {
          associations()
          ruleAssociations('rules', '棋子规则', '作用于这枚棋子的可执行规则。')
          ruleAssociations('playerRules', '玩家规则', '开局时授予所属玩家一次，不依赖棋子是否部署或存活。')
          statuses('initialStatusTags', '角色初始状态')
        }
        if (subdir === 'skills' || subdir === 'cards') {
          chips('keywords', '技能关键词', catalog.keywords.filter(item => item && typeof item.name === 'string').map(item => ({ value: item.name, label: item.name })))
          const labels = { damage: '伤害', recovery: '恢复', heal:'治疗', control: '控制', summon: '召唤', movement: '移动', position:'位移', buff:'增益', debuff:'减益', special:'特殊效果' }
          chips('effectTags', '效果分类', catalog.effects.map(value => ({ value, label: labels[value] || (/^[\x00-\x7f]+$/.test(value) ? '自定义分类' : value) })))
          container.append(element('p', '关键词和效果分类用于描述与展示；实际效果仍由技能代码决定。', 'vf-muted'))
          if (subdir === 'skills') statuses('statusTag', '技能状态标签')
        }
      }
      refresh()
      return { refresh }
    },
  }
})()
