/*
 * Author-facing Skill Cluster overview.
 *
 * This surface is deliberately a projection of the shared Cluster builder.
 * It does not infer ownership from names and it never becomes a second rule
 * executor. Editing an inline status is delegated to the owning document
 * editor so the original object shape (including extension fields) survives.
 */
(() => {
  'use strict'

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
  const record = value => value && typeof value === 'object' && !Array.isArray(value)
  const node = (tag, text, className) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined && text !== null) element.textContent = String(text)
    return element
  }
  const action = (text, handler, className = 'skill-cluster-action') => {
    const button = node('button', text, className)
    button.type = 'button'
    button.onclick = handler
    return button
  }

  const kindLabels = { skill: '技能', piece: '棋子', rule: '规则', status: '状态', card: '卡牌', extension: '扩展字段', continuation: '续接流程', presentation: '表现' }
  const memberTabSpecs = [
    ['skill', '技能成员', '主动技能'],
    ['rule', '规则成员', '规则'],
    ['status', '状态成员', '状态'],
    ['card', '卡牌成员', '卡牌'],
    ['extension', '扩展字段成员', '扩展字段'],
  ]

  // A few legacy Skill documents were authored with kind:passive before
  // passive effects became first-class Rule documents. Keep those source
  // definitions visible, but make the compatibility role explicit instead
  // of presenting them as active skills. Mixed buckets stay neutral because
  // their individual rows carry the precise role.
  function skillDefinitionKind(member) {
    const kind = member?.definition?.kind
    return kind === 'active' || kind === 'passive' ? kind : null
  }

  function skillMemberLabel(member) {
    const kind = skillDefinitionKind(member)
    if (kind === 'active') return '主动技能'
    if (kind === 'passive') return '被动入口（兼容）'
    return '技能入口'
  }

  function skillBucketLabel(entries) {
    if (!entries.length) return '主动技能'
    const kinds = entries.map(skillDefinitionKind)
    if (kinds.length > 0 && kinds.every(kind => kind === 'active')) return '主动技能'
    if (kinds.length > 0 && kinds.every(kind => kind === 'passive')) return '被动入口（兼容）'
    return '技能入口'
  }

  const roleLabels = { root: '能力根', dependency: '明确依赖', related: '相关内容' }
  const stateLabels = { complete: '完整覆盖', partial: '部分覆盖', missing: '未覆盖' }
  const stateClasses = { complete: 'is-complete', partial: 'is-partial', missing: 'is-missing' }
  const collectionLabels = { skills: '技能文档', pieces: '棋子文档', rules: '规则文档', cards: '卡牌文档', statuses: '状态定义' }
  const relationLabels = { root: '根成员', dependency: '明确依赖', related: '相关成员', shared: '共享引用', member: '成员引用' }
  const statusEnumLabels = {
    replace: '替换', stack: '叠加', add: '叠加', refresh: '刷新持续时间', refreshDuration: '刷新持续时间',
    permanent: '永久', turn: '按回合', untilRemoved: '直到移除', finite: '有限持续',
  }
  function statusEnumDisplay(value) {
    if (value === null || value === undefined || value === '') return '未填写'
    return statusEnumLabels[value] || '自定义选项'
  }
  function sourceLabel(member) {
    const source = member?.source || {}
    const owner = member?.definition?.name || (source.collection ? collectionLabels[source.collection] || '所属文档' : '来源文档')
    if (member?.kind === 'extension') return `${owner}的扩展字段`
    if (member?.kind === 'status') return `${owner}的状态定义`
    return `${owner}中的${kindLabels[member?.kind] || '成员'}`
  }
  const pieceStatFields = [
    ['maxHp', '生命', 'number'],
    ['attack', '攻击', 'number'],
    ['defense', '防御', 'number'],
    ['moveRange', '移动', 'number'],
    ['speed', '速度', 'number'],
  ]

  function memberIdentity(member) {
    const source = member?.source || {}
    return JSON.stringify([
      member?.kind || '', member?.id || '', source.collection || '', source.id || '',
      source.path || source.field || '',
    ])
  }

  function memberMatch(candidate, target) {
    if (!candidate || !target || candidate.kind !== target.kind || candidate.id !== target.id) return false
    if (memberIdentity(candidate) === memberIdentity(target)) return true
    const left = candidate.source || {}
    const right = target.source || {}
    // Statuses are owner-scoped. Do not collapse two equal status IDs from
    // different skills/pieces when a caller only has a catalog projection.
    if (candidate.kind === 'status') return left.collection === right.collection && left.id === right.id
    // Extensions are scoped to the exact persisted owner path; two owners may
    // legitimately expose the same extension field name.
    if (candidate.kind === 'extension') return left.collection === right.collection && left.id === right.id && left.path === right.path
    return !left.id || !right.id || (left.collection === right.collection && left.id === right.id)
  }

  function coreFor(options) {
    return options.core || window.SkillClusterCore || window.ContentGraphCore || null
  }

  function normalizeResult(value) {
    if (!value) return { clusters: [], diagnostics: [] }
    if (Array.isArray(value)) return { clusters: value, diagnostics: [] }
    if (Array.isArray(value.clusters)) return value
    if (Array.isArray(value.definitions)) return { ...value, clusters: value.definitions }
    return { clusters: [], diagnostics: [] }
  }

  function buildCatalog(options, targetRoot = options.root) {
    if (typeof options.getCatalogResult === 'function') return normalizeResult(options.getCatalogResult())
    if (options.catalogResult) return normalizeResult(options.catalogResult)
    const catalog = typeof options.getCatalog === 'function' ? options.getCatalog() : options.catalog
    const core = coreFor(options)
    const singleBuilder = core?.buildSkillCluster || core?.createSkillCluster
    // Rendering fields can happen many times while a document is being
    // edited. Prefer the root builder so one editor refresh does not scan the
    // entire catalog. A full catalog result remains supported for callers
    // that explicitly provide getCatalogResult/catalogResult.
    if (typeof singleBuilder === 'function' && targetRoot?.collection && targetRoot?.id) {
      try {
        const cluster = singleBuilder(catalog || { skills: {}, rules: {}, pieces: {}, cards: {} }, targetRoot, options.clusterOptions)
        return cluster ? { clusters: [cluster], diagnostics: cluster.diagnostics || [] } : { clusters: [], diagnostics: [] }
      } catch (error) {
        return { clusters: [], diagnostics: [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }] }
      }
    }
    const builder = core?.buildSkillClusterCatalog || core?.createSkillClusterCatalog || core?.getSkillClusterCatalog
    if (typeof builder === 'function') {
      try { return normalizeResult(builder(catalog || { skills: {}, rules: {}, pieces: {}, cards: {} }, options.clusterOptions)) }
      catch (error) { return { clusters: [], diagnostics: [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }] } }
    }
    return { clusters: [], diagnostics: [{ severity: 'info', message: '共享能力组目录尚未加载。' }] }
  }

  function findCluster(result, root) {
    const clusters = Array.isArray(result?.clusters) ? result.clusters : []
    return clusters.find(cluster => cluster?.clusterId === `${root.collection}:${root.id}`)
      || clusters.find(cluster => cluster?.root?.collection === root.collection && cluster?.root?.id === root.id)
      || null
  }

  function rootMember(cluster) {
    return cluster?.members?.all?.find(member => member.role === 'root')
      || cluster?.members?.skills?.find(member => member.role === 'root')
      || cluster?.members?.pieces?.find(member => member.role === 'root')
      || cluster?.members?.rules?.find(member => member.role === 'root')
      || cluster?.members?.cards?.find(member => member.role === 'root')
      || null
  }

  function coverageCard(title, coverage) {
    const card = node('div', undefined, 'skill-cluster-coverage-card')
    const status = coverage?.status || 'missing'
    card.append(node('span', title, 'skill-cluster-eyebrow'))
    card.append(node('strong', stateLabels[status] || '未知状态', `skill-cluster-state ${stateClasses[status] || ''}`))
    const covered = Number.isFinite(coverage?.covered) ? coverage.covered : 0
    const total = Number.isFinite(coverage?.total) ? coverage.total : 0
    card.append(node('span', `${covered} / ${total} 项`, 'skill-cluster-muted'))
    return card
  }

  function sourceCollection(member) {
    const collection = member?.source?.collection
    if (collection === 'statuses') return 'skills'
    return collection
  }

  function cloneStructured(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return seen.get(value)
    if (Array.isArray(value)) {
      const output = []
      seen.set(value, output)
      value.forEach(item => output.push(cloneStructured(item, seen)))
      return output
    }
    const output = {}
    seen.set(value, output)
    Object.keys(value).forEach(key => {
      Object.defineProperty(output, key, {
        value: cloneStructured(value[key], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    })
    return output
  }

  function safeMemberKey(key) {
    return typeof key === 'string' && key.length > 0
      && key !== '__proto__' && key !== 'prototype' && key !== 'constructor'
  }

  function setStructuredValue(target, key, value) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }

  const structuredTypeLabels = {
    string: '文本', number: '数字', boolean: '布尔', null: '空值', object: '对象', array: '列表',
  }

  function structuredType(value) {
    if (value === null || value === undefined) return 'null'
    if (Array.isArray(value)) return 'array'
    if (record(value)) return 'object'
    if (typeof value === 'number' && Number.isFinite(value)) return 'number'
    if (typeof value === 'boolean') return 'boolean'
    return 'string'
  }

  function structuredDefault(type) {
    if (type === 'number') return 0
    if (type === 'boolean') return false
    if (type === 'object') return {}
    if (type === 'array') return []
    if (type === 'null') return null
    return ''
  }

  function updateStructuredValue(root, path, updater) {
    const next = cloneStructured(root)
    if (!path.length) return updater(next)
    let current = next
    for (let index = 0; index < path.length - 1; index += 1) {
      if (!current || typeof current !== 'object' || !own(current, path[index])) return next
      current = current[path[index]]
    }
    if (!current || typeof current !== 'object') return next
    const key = path[path.length - 1]
    const value = updater(current[key])
    if (value === undefined && Array.isArray(current)) current.splice(Number(key), 1)
    else if (value === undefined) delete current[key]
    else if (Array.isArray(current)) current[Number(key)] = value
    else if (safeMemberKey(key)) setStructuredValue(current, key, value)
    return next
  }

  function normalizeAssetPath(value) {
    if (typeof value !== 'string') return ''
    let path = value.trim().replaceAll('\\', '/')
    if (path.startsWith('images/')) path = path.slice('images/'.length)
    if (path.startsWith('./')) path = path.slice(2)
    if (!path || path.startsWith('/') || path.includes('..') || path.includes(':') || path.startsWith('data:')) return ''
    return path
  }

  function storedAssetPath(value) {
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

  function materialDisplayName(file, index = 0) {
    const metadata = file && typeof file === 'object'
      ? [file.displayName, file.title, file.label, file.name].find(value => typeof value === 'string' && value.trim())
      : ''
    if (metadata) return metadata.trim()
    const relative = normalizeAssetPath(typeof file === 'string' ? file : file?.path)
    const basename = relative.split('/').pop() || ''
    return materialLabels[basename] || `图片素材 ${index + 1}`
  }

  function materialDisplayNameForPath(value) {
    const relative = normalizeAssetPath(value)
    if (!relative) return '未选择图标'
    const basename = relative.split('/').pop() || ''
    return materialLabels[basename] || '当前图标（素材暂不可用）'
  }

  function appendAssetPreview(host, value, options, className, emptyMessage, failureMessage = '图片资源不可用。') {
    const relative = normalizeAssetPath(value)
    const preview = node('div', undefined, className || 'skill-cluster-asset-preview')
    if (!relative) {
      preview.append(node('span', emptyMessage || '没有选择图片资源。', 'skill-cluster-asset-note'))
      host.append(preview)
      return preview
    }
    if (typeof options.readAsset !== 'function') {
      preview.append(node('span', '当前没有可用的图片读取接口。', 'skill-cluster-asset-note'))
      host.append(preview)
      return preview
    }
    const image = node('img', undefined, 'skill-cluster-asset-image')
    image.alt = ''
    image.hidden = true
    const note = node('span', '正在读取图片…', 'skill-cluster-asset-note')
    preview.append(image, note)
    host.append(preview)
    Promise.resolve()
      .then(() => options.readAsset(relative))
      .then(source => {
        if (!image.isConnected) return
        if (typeof source !== 'string' || !/^data:image\//i.test(source)) throw new Error('图片资源返回格式无效。')
        image.src = source
        image.hidden = false
        note.remove()
      })
      .catch(() => {
        if (!image.isConnected) return
        image.remove()
        // Keep filesystem and IPC details out of the author-facing overview.
        note.textContent = failureMessage
        note.className = 'skill-cluster-asset-note'
      })
    return preview
  }

  function assetPromiseFor(options, cache) {
    if (cache.promise) return cache.promise
    if (typeof options.listAssets !== 'function') {
      cache.promise = Promise.resolve([])
      return cache.promise
    }
    cache.promise = Promise.resolve()
      .then(() => options.listAssets())
      .then(files => (Array.isArray(files) ? files : [])
        .map((file, index) => ({
          path: normalizeAssetPath(typeof file === 'string' ? file : file?.path),
          label: materialDisplayName(file, index),
        }))
        .filter(entry => entry.path)
        .filter((entry, index, values) => values.findIndex(item => item.path === entry.path) === index)
        .sort((left, right) => left.path.localeCompare(right.path)))
      .catch(() => [])
    return cache.promise
  }

  function readFieldValue(control, type) {
    if (type === 'boolean') return control.value === 'true'
    if (type === 'number') return control.value === '' ? null : Number(control.value)
    return control.value
  }

  function renderStructuredExtensionEditor(host, member, options, report) {
    const editor = node('section', undefined, 'skill-cluster-inline-editor skill-cluster-extension-editor')
    editor.dataset.skillClusterExtensionEditor = 'true'
    editor.append(node('h4', '扩展字段', 'skill-cluster-inline-editor-title'))
    editor.append(node('p', '编辑实际所属文档的扩展字段；未知字段与嵌套容器会原样保留。删除字段不会授予或撤销运行时能力。', 'skill-cluster-muted'))
    const source = member?.source
    let value = record(member?.definition) ? cloneStructured(member.definition) : {}
    const commit = next => {
      try {
        if (typeof options.onMemberChange !== 'function') throw new Error('当前文档不支持扩展字段编辑。')
        value = cloneStructured(next)
        // The document bridge receives the marker with the actual owner path;
        // it must replace that object rather than shallow merge it. This keeps
        // deliberate deletes from being resurrected on save.
        const replacement = { __skillClusterReplace: true, value: cloneStructured(next) }
        options.onMemberChange(member, replacement, { replace: true, memberKind: 'extension', source })
        report('扩展字段草稿已更新。', 'success')
      } catch (error) { report(error instanceof Error ? error.message : String(error), 'error') }
    }
    if (window.AuthorObjectEditor?.mount) {
      const host = node('div', undefined, 'skill-cluster-object-editor-host')
      window.AuthorObjectEditor.mount(host, {
        value,
        type: 'record',
        label: '扩展字段',
        description: '未知字段与嵌套容器会原样保留；删除字段不会改变运行时能力。',
        readonly: member?.editable === false,
        maxDepth: 10,
        onChange: next => commit(next),
      })
      editor.append(host)
      if (source) editor.append(node('p', `定义来源：${sourceLabel(member)}`, 'skill-cluster-source-line'))
      return editor
    }
    const pathText = path => path.length ? path.join('.') : '扩展字段'
    const renderValue = (current, path, label) => {
      if (Array.isArray(current)) {
        const section = node('section', undefined, 'skill-cluster-structured-container')
        const heading = node('div', undefined, 'skill-cluster-structured-heading')
        heading.append(node('strong', label || '数组'))
        heading.append(node('span', `${current.length} 项`, 'skill-cluster-muted'))
        section.append(heading)
        current.forEach((item, index) => {
          const row = node('div', undefined, 'skill-cluster-structured-row')
          const copy = node('div', undefined, 'skill-cluster-structured-index')
          // Display tuple-like positions for authors from one while retaining
          // zero-based JSON paths internally.
          copy.append(node('span', `[${index + 1}]`, 'skill-cluster-structured-key'))
          copy.append(renderValue(item, [...path, String(index)], `[${index + 1}]`))
          row.append(copy)
          row.append(action('删除', () => commit(updateStructuredValue(value, [...path, String(index)], () => undefined)), 'skill-cluster-action secondary skill-cluster-structured-remove'))
          section.append(row)
        })
        const addType = node('select')
        addType.dataset.skillClusterExtensionAddType = pathText(path)
        Object.entries(structuredTypeLabels).forEach(([type, label]) => {
          const option = node('option', label)
          option.value = type
          addType.append(option)
        })
        const addItem = action('添加项', () => commit(updateStructuredValue(value, path, list => [...(Array.isArray(list) ? list : []), structuredDefault(addType.value)])), 'skill-cluster-action secondary')
        const addArrayRow = node('div', undefined, 'skill-cluster-structured-add')
        addArrayRow.append(addType, addItem)
        section.append(addArrayRow)
        return section
      }
      if (record(current)) {
        const section = node('section', undefined, 'skill-cluster-structured-container')
        const heading = node('div', undefined, 'skill-cluster-structured-heading')
        heading.append(node('strong', label || '对象'))
        heading.append(node('span', `${Object.keys(current).length} 个字段`, 'skill-cluster-muted'))
        section.append(heading)
        Object.keys(current).forEach(key => {
          const row = node('div', undefined, 'skill-cluster-structured-row')
          const copy = node('div', undefined, 'skill-cluster-structured-copy')
          copy.append(node('span', key, 'skill-cluster-structured-key'))
          copy.append(renderValue(current[key], [...path, key], key))
          row.append(copy)
          row.append(action('删除', () => commit(updateStructuredValue(value, [...path, key], () => undefined)), 'skill-cluster-action secondary skill-cluster-structured-remove'))
          section.append(row)
        })
        const addRow = node('div', undefined, 'skill-cluster-structured-add')
        const keyInput = node('input')
        keyInput.type = 'text'
        keyInput.placeholder = '新字段名'
        keyInput.dataset.skillClusterExtensionAdd = pathText(path)
        const addType = node('select')
        addType.dataset.skillClusterExtensionAddType = pathText(path)
        Object.entries(structuredTypeLabels).forEach(([type, label]) => {
          const option = node('option', label)
          option.value = type
          addType.append(option)
        })
        const addButton = action('添加字段', () => {
          const key = keyInput.value.trim()
          if (!safeMemberKey(key)) { report('字段名不能使用空值或原型保留字。', 'error'); return }
          if (own(current, key)) { report('该字段已经存在。', 'error'); return }
          commit(updateStructuredValue(value, path, object => {
            const next = record(object) ? object : {}
            setStructuredValue(next, key, structuredDefault(addType.value))
            return next
          }))
        }, 'skill-cluster-action secondary')
        addRow.append(keyInput, addType, addButton)
        section.append(addRow)
        return section
      }
      const field = node('label', undefined, 'skill-cluster-inline-field skill-cluster-structured-leaf')
      field.append(node('span', label || '值'))
      const typeSelect = node('select')
      typeSelect.dataset.skillClusterExtensionType = pathText(path)
      Object.entries(structuredTypeLabels).forEach(([type, typeLabel]) => {
        const option = node('option', typeLabel)
        option.value = type
        typeSelect.append(option)
      })
      typeSelect.value = structuredType(current)
      typeSelect.onchange = () => commit(updateStructuredValue(value, path, () => structuredDefault(typeSelect.value)))
      field.append(typeSelect)
      let control
      if (typeof current === 'boolean') {
        control = node('select')
        control.append(node('option', '是')); control.lastChild.value = 'true'
        control.append(node('option', '否')); control.lastChild.value = 'false'
        control.value = current ? 'true' : 'false'
      } else if (typeof current === 'number') {
        control = node('input'); control.type = 'number'; control.value = String(current)
      } else if (typeof current === 'string' || current === null || current === undefined) {
        control = node('input'); control.type = 'text'; control.value = current === null ? '' : String(current)
        if (current === null) control.placeholder = '空值'
      } else {
        control = node('input'); control.type = 'text'; control.value = String(current)
      }
      if (current === null || current === undefined) control.disabled = true
      control.dataset.skillClusterExtensionPath = pathText(path)
      control.onchange = () => {
        let next = control.value
        if (typeof current === 'boolean') next = control.value === 'true'
        else if (typeof current === 'number') next = control.value === '' ? null : Number(control.value)
        commit(updateStructuredValue(value, path, () => next))
      }
      field.append(control)
      return field
    }
    editor.append(renderValue(value, [], '扩展字段'))
    if (source) editor.append(node('p', `定义来源：${sourceLabel(member)}`, 'skill-cluster-source-line'))
    host.append(editor)
    return editor
  }

  function renderInlineStatusEditor(host, member, options, report, assetCache) {
    const definition = record(member?.definition) ? member.definition : {}
    const source = member?.source
    const editor = node('section', undefined, 'skill-cluster-inline-editor')
    editor.append(node('h4', '状态参数', 'skill-cluster-inline-editor-title'))
    editor.append(node('p', '保留未展示的扩展字段；这里只编辑已声明字段与状态图标。', 'skill-cluster-muted'))
    const fields = [
      ['id', '内部标识', 'system'], ['type', '状态类别', 'system'], ['name', '名称', 'text'],
      ['duration', '持续回合', 'number'], ['turns', '回合数', 'number'], ['currentDuration', '当前回合', 'number'],
      ['remainingDuration', '剩余回合', 'number'], ['currentUses', '剩余次数', 'number'], ['stacks', '层数', 'number'],
      ['intensity', '强度', 'number'], ['amount', '数值', 'number'], ['description', '说明', 'textarea'],
      // Visibility is part of the actual PieceStatusTag shape. Do not add it
      // to definitions which never declared it.
      ['visible', '可见', 'boolean'],
      ['stacking', '叠加方式', 'text'], ['lifetime', '生命周期', 'text'],
    ].filter(([key]) => own(definition, key))
    if (!fields.length) editor.append(node('p', '该状态没有可编辑的已声明参数。', 'skill-cluster-muted'))
    for (const [key, title, type] of fields) {
      const wrapper = node('label', undefined, `skill-cluster-inline-field${type === 'system' ? ' skill-cluster-system-field' : ''}`)
      wrapper.append(node('span', title))
      if (type === 'system') {
        wrapper.append(node('span', key === 'id' ? '由所属文档保留' : statusEnumDisplay(definition[key]), 'skill-cluster-system-value'))
        wrapper.dataset.skillClusterStatusSystemField = key
        editor.append(wrapper)
        continue
      }
      const enumField = ['stacking', 'lifetime'].includes(key)
      const control = type === 'textarea' ? node('textarea') : type === 'boolean' || enumField ? node('select') : node('input')
      if (type === 'boolean') {
        control.append(node('option', '是')); control.lastChild.value = 'true'
        control.append(node('option', '否')); control.lastChild.value = 'false'
      } else if (enumField) {
        const currentValue = definition[key]
        const values = [...new Set([...Object.keys(statusEnumLabels), ...(currentValue === undefined || currentValue === null ? [] : [String(currentValue)])])]
        for (const value of values) { const option = node('option', statusEnumDisplay(value)); option.value = value; control.append(option) }
      } else if (type !== 'textarea') control.type = type
      control.value = definition[key] === undefined || definition[key] === null ? '' : String(definition[key])
      control.dataset.skillClusterStatusField = key
      control.onchange = () => {
        const value = readFieldValue(control, type)
        try {
          if (typeof options.onMemberChange !== 'function') throw new Error('当前文档不支持状态编辑。')
          options.onMemberChange(member, { [key]: value })
          report('状态草稿已更新。', 'success')
        } catch (error) { report(error instanceof Error ? error.message : String(error), 'error') }
      }
      wrapper.append(control)
      editor.append(wrapper)
    }

    // `iconPath` is an authoring field consumed by the status presentation
    // layer. It is intentionally available even when an old definition did
    // not contain it, while the unrelated legacy `icon` field is untouched.
    const iconWrapper = node('label', undefined, 'skill-cluster-inline-field skill-cluster-status-icon-field')
    iconWrapper.append(node('span', '状态图标'))
    // Keep the persisted path in a non-author-facing field for compatibility
    // with the document bridge; authors choose a material by its display name.
    const iconInput = node('input')
    iconInput.type = 'hidden'
    iconInput.value = storedAssetPath(definition.iconPath)
    iconInput.dataset.skillClusterStatusField = 'iconPath'
    const iconNameInput = node('input')
    iconNameInput.type = 'text'
    iconNameInput.readOnly = true
    iconNameInput.placeholder = '从素材库选择状态图标'
    iconNameInput.setAttribute('aria-label', '状态图标名称（由素材库选择）')
    iconNameInput.value = materialDisplayNameForPath(definition.iconPath)
    const commitIcon = value => {
      const normalized = storedAssetPath(value)
      iconInput.value = normalized
      iconNameInput.value = normalized ? materialDisplayNameForPath(normalized) : '未选择图标'
      try {
        if (typeof options.onMemberChange !== 'function') throw new Error('当前文档不支持状态编辑。')
        options.onMemberChange(member, { iconPath: normalized })
        report('状态图标草稿已更新。', 'success')
      } catch (error) { report(error instanceof Error ? error.message : String(error), 'error') }
    }
    iconWrapper.append(iconNameInput, iconInput)
    const assetSelect = node('select')
    assetSelect.dataset.skillClusterStatusAsset = 'true'
    assetSelect.setAttribute('aria-label', '状态图标素材')
    assetSelect.append(node('option', '从素材中选择…'))
    assetSelect.firstChild.value = ''
    assetSelect.onchange = () => {
      commitIcon(assetSelect.value)
    }
    iconWrapper.append(assetSelect)
    editor.append(iconWrapper)
    assetPromiseFor(options, assetCache).then(entries => {
      if (!assetSelect.isConnected) return
      const current = storedAssetPath(iconInput.value)
      const paths = entries.map(entry => entry.path)
      assetSelect.replaceChildren()
      const blank = node('option', paths.length ? '从素材中选择…' : '没有可用图片素材')
      blank.value = ''
      assetSelect.append(blank)
      if (current && !paths.includes(normalizeAssetPath(current))) {
        const missing = node('option', '当前图标（素材暂不可用）')
        missing.value = current
        assetSelect.append(missing)
      }
      for (const entry of entries) {
        const option = node('option', entry.label)
        option.value = `images/${entry.path}`
        assetSelect.append(option)
      }
      assetSelect.value = current
      if (current && paths.includes(normalizeAssetPath(current))) iconNameInput.value = entries.find(entry => `images/${entry.path}` === current)?.label || materialDisplayNameForPath(current)
    })
    const iconPreview = node('div', undefined, 'skill-cluster-status-icon-preview')
    if (definition.visible === false) iconPreview.append(node('span', '该状态当前不可见，不显示图标预览。', 'skill-cluster-asset-note'))
    else appendAssetPreview(iconPreview, iconInput.value, options, 'skill-cluster-asset-preview', '未选择图标资源。')
    editor.append(iconPreview)

    if (source && member.editable !== false) editor.append(node('p', '修改仅进入对应内容的草稿；保存仍由内容编辑器统一执行。', 'skill-cluster-muted'))
    return editor
  }

  function renderMember(member, selectedId, openMember) {
    const row = node('button', undefined, `skill-cluster-member${selectedId === memberIdentity(member) ? ' is-selected' : ''}`)
    row.type = 'button'
    row.dataset.skillClusterMember = `${member.kind}:${member.id}`
    row.dataset.skillClusterMemberKey = memberIdentity(member)
    const top = node('span', undefined, 'skill-cluster-member-top')
    const label = member.kind === 'skill' ? skillMemberLabel(member) : kindLabels[member.kind] || '关联成员'
    top.append(node('strong', member.definition?.name || `未命名${kindLabels[member.kind] || '成员'}`), node('span', label, 'skill-cluster-kind'))
    row.append(top)
    const summary = member.definition?.description || (member.role === 'root' ? '当前能力' : `${roleLabels[member.role] || '关联内容'}，点击查看说明。`)
    row.append(node('span', summary, 'skill-cluster-member-summary'))
    row.onclick = () => openMember(member)
    return row
  }

  // Status navigation can select a member whose owner is a rule or card
  // document rather than the currently mounted skill/piece root. Keep this
  // fallback deliberately small: the owning document still supplies the
  // patch callback, while this editor reuses the same field and asset UI.
  function mountStatus(container, member, options = {}) {
    if (!container || !member) return { refresh() {}, destroy() {}, selectMember() {} }
    let currentMember = member
    let statusMessage = null
    let destroyed = false
    const assetCache = { promise: null }
    const report = (message, kind = 'info') => {
      statusMessage = { message, kind }
      render()
    }
    const render = () => {
      if (destroyed) return
      if (typeof options.getMember === 'function') currentMember = options.getMember(currentMember) || currentMember
      const view = node('section', undefined, 'skill-cluster-editor skill-cluster-status-editor')
      view.dataset.skillClusterEditor = 'true'
      view.dataset.skillClusterStatusEditor = 'true'
      const definition = record(currentMember.definition) ? currentMember.definition : {}
      const header = node('header', undefined, 'skill-cluster-header')
      const title = node('div', undefined, 'skill-cluster-title')
      title.append(node('span', '状态编辑', 'skill-cluster-kicker'))
      title.append(node('h2', definition.name || '未命名状态'))
      title.append(node('p', '编辑原始状态定义；扩展字段仍由所属文档保存。', 'skill-cluster-subtitle'))
      header.append(title)
      const source = currentMember.source
      if (source) {
        const actions = node('div', undefined, 'skill-cluster-header-actions')
        actions.append(node('span', kindLabels[currentMember.kind] || '关联成员', 'skill-cluster-kind-badge passive'))
        if (typeof options.navigate === 'function') {
          actions.append(action('打开来源', () => options.navigate(sourceCollection(currentMember), source.id, { member: currentMember }), 'skill-cluster-action secondary'))
        }
        header.append(actions)
      }
      view.append(header)
      const description = node('section', undefined, 'skill-cluster-description-card')
      description.append(node('span', '状态说明', 'skill-cluster-eyebrow'))
      description.append(node('p', definition.description || '未填写描述。', 'skill-cluster-description'))
      view.append(description)
      if (currentMember.kind === 'status' && currentMember.editable !== false) {
        view.append(renderInlineStatusEditor(view, currentMember, options, report, assetCache))
      } else {
        view.append(node('p', currentMember.editable === false ? '该状态来自兼容或生成来源，当前仅供查看。' : '当前成员不是可编辑状态。', 'skill-cluster-muted'))
      }
      if (statusMessage) {
        const message = node('p', statusMessage.message, `skill-cluster-message ${statusMessage.kind}`)
        message.setAttribute('role', 'status')
        view.append(message)
      }
      container.replaceChildren(view)
    }
    render()
    return {
      refresh() { render() },
      selectMember(next) {
        if (!next) return false
        currentMember = next
        statusMessage = null
        render()
        return true
      },
      destroy() { destroyed = true; container.replaceChildren() },
    }
  }

  // Thin adapter for ordinary property panels. It deliberately delegates to
  // the same status editor above, while keeping the caller's stable source
  // reference and exposing only the edited value through onChange.
  function mountStatusValue(container, options = {}) {
    let hasOverride = false
    let overrideValue
    const read = () => hasOverride
      ? overrideValue
      : typeof options.getValue === 'function' ? options.getValue() : options.value
    const source = options.source || {
      collection: options.collection || 'statuses',
      id: options.sourceId || options.memberId || options.id || 'status',
    }
    const memberId = options.memberId || options.id || 'status'
    const makeMember = () => ({
      kind: 'status',
      id: memberId,
      definition: cloneStructured(read() || {}),
      source: cloneStructured(source),
      editable: options.readonly !== true && options.editable !== false,
    })
    const statusOptions = { ...options }
    delete statusOptions.getValue
    delete statusOptions.value
    delete statusOptions.onChange
    delete statusOptions.memberId
    delete statusOptions.id
    delete statusOptions.source
    delete statusOptions.sourceId
    delete statusOptions.collection
    delete statusOptions.editable
    delete statusOptions.readonly
    statusOptions.getMember = makeMember
    statusOptions.onMemberChange = (member, patch, metadata) => {
      const next = { ...cloneStructured(member.definition || {}), ...cloneStructured(patch || {}) }
      if (typeof options.onChange === 'function') options.onChange(next, { member: { ...member, definition: cloneStructured(next) }, patch: cloneStructured(patch || {}), ...metadata })
    }
    const mounted = mountStatus(container, makeMember(), statusOptions)
    return {
      ...mounted,
      getValue: () => cloneStructured(read() || {}),
      setValue: next => { hasOverride = true; overrideValue = cloneStructured(next); mounted.refresh?.() },
    }
  }

  function mount(container, options = {}) {
    if (!container) return { refresh() {}, destroy() {}, selectMember() {} }
    const root = options.root || { collection: 'skills', id: '' }
    let selectedId = null
    let selectedMember = null
    let activeMemberKind = null
    let statusMessage = null
    let currentResult = null
    let destroyed = false
    const assetCache = { promise: null }
    const linkedClusterCache = new Map()

    const clusterForRoot = target => {
      if (!target?.collection || !target?.id) return null
      const key = `${target.collection}:${target.id}`
      const current = findCluster(currentResult, target)
      if (current) return current
      if (linkedClusterCache.has(key)) return linkedClusterCache.get(key)
      const result = buildCatalog(options, target)
      const cluster = findCluster(result, target)
      linkedClusterCache.set(key, cluster || null)
      return cluster
    }

    const report = (message, kind = 'info') => {
      statusMessage = { message, kind }
      render()
    }
    const openMember = member => {
      selectedMember = member || null
      selectedId = member ? memberIdentity(member) : null
      activeMemberKind = member && memberTabSpecs.some(spec => spec[0] === member.kind) ? member.kind : activeMemberKind
      if (member && typeof options.onSelectMember === 'function') options.onSelectMember(member, { root, cluster: findCluster(currentResult, root) })
      render()
    }
    const latestMember = (cluster, member) => {
      const members = Array.isArray(cluster?.members?.all) ? cluster.members.all : []
      return members.find(candidate => memberMatch(candidate, member)) || null
    }
    const selectMember = member => {
      if (!member) return false
      const cluster = findCluster(currentResult, root) || findCluster(buildCatalog(options, root), root)
      const latest = latestMember(cluster, member)
      selectedMember = latest || member
      selectedId = selectedMember ? memberIdentity(selectedMember) : null
      activeMemberKind = selectedMember && memberTabSpecs.some(spec => spec[0] === selectedMember.kind) ? selectedMember.kind : activeMemberKind
      if (selectedMember && typeof options.onSelectMember === 'function') options.onSelectMember(selectedMember, { root, cluster })
      render()
      return Boolean(latest)
    }
    const navigate = member => {
      const source = member?.source
      const collection = sourceCollection(member)
      if (!source || !collection || typeof options.navigate !== 'function') {
        report('该关联没有可用的明确来源。', 'error')
        return
      }
      options.navigate(collection, source.id, { member, root })
    }

    const notifyRootChange = (patch, cluster, rootItem) => {
      try {
        if (typeof options.onRootChange === 'function') {
          options.onRootChange(patch, { root, cluster, member: rootItem })
        } else if (typeof options.onChange === 'function') {
          const current = record(options.getDraft?.()) ? options.getDraft() : rootItem?.definition || {}
          const next = cloneStructured(current)
          Object.entries(patch).forEach(([key, value]) => setStructuredValue(next, key, value))
          options.onChange(next)
        } else throw new Error('当前文档不支持根定义编辑。')
        statusMessage = { message: '能力组根定义草稿已更新。', kind: 'success' }
        render()
      } catch (error) { report(error instanceof Error ? error.message : String(error), 'error') }
    }

    const clusterEnvelopeFor = (cluster, rootItem) => {
      const persisted = record(rootItem?.definition?.cluster) ? rootItem.definition.cluster : {}
      const metadata = record(cluster?.metadata) ? cluster.metadata : {}
      return { ...cloneStructured(persisted), ...cloneStructured(metadata) }
    }

    const notifyClusterChange = (patch, cluster, rootItem) => {
      try {
        const envelope = clusterEnvelopeFor(cluster, rootItem)
        if (typeof options.onClusterChange === 'function') {
          options.onClusterChange(patch, { root, cluster, member: rootItem, envelope })
        } else if (typeof options.onRootChange === 'function') {
          // The shell may not expose a dedicated Cluster callback yet. Keep
          // group metadata separate from name/description and let that bridge
          // merge it into the persisted cluster envelope with its version/id.
          options.onRootChange({ cluster: { ...envelope, ...patch } }, { root, cluster, member: rootItem, clusterPatch: patch, envelope })
        } else throw new Error('当前文档不支持能力组信息编辑。')
        statusMessage = { message: '能力组信息草稿已更新。', kind: 'success' }
        render()
      } catch (error) { report(error instanceof Error ? error.message : String(error), 'error') }
    }

    const notifyLinkChange = (operation, link, cluster, member) => {
      try {
        if (typeof options.onLinkChange !== 'function' && typeof options.onClusterLinkChange !== 'function') throw new Error('当前文档不支持能力组引用编辑。')
        const callback = options.onLinkChange || options.onClusterLinkChange
        callback({ operation, link, root, cluster, member, execution: 'reference-only' })
        statusMessage = { message: operation === 'attach' ? '已加入引用成员；不会授予运行时能力。' : '已移除引用成员；不会改变运行时规则。', kind: 'success' }
        render()
      } catch (error) { report(error instanceof Error ? error.message : String(error), 'error') }
    }

    function renderRootFields(cluster, rootItem) {
      const draft = record(options.getDraft?.()) ? options.getDraft() : rootItem?.definition || {}
      const envelope = clusterEnvelopeFor(cluster, rootItem)
      const section = node('section', undefined, 'skill-cluster-root-fields')
      section.append(node('span', '能力组信息', 'skill-cluster-eyebrow'))
      section.append(node('p', '分组名称与根成员定义分开保存；修改分组不会改名技能、规则或卡牌。', 'skill-cluster-muted'))
      const groupName = node('input')
      const fallbackRootName = root.collection === 'pieces' ? '未命名棋子' : '未命名能力组'
      groupName.type = 'text'; groupName.value = typeof envelope.name === 'string' ? envelope.name : (rootItem?.definition?.name || fallbackRootName)
      groupName.placeholder = rootItem?.definition?.name || fallbackRootName
      groupName.dataset.skillClusterGroupField = 'name'
      groupName.onchange = () => notifyClusterChange({ name: groupName.value }, cluster, rootItem)
      const groupNameLabel = node('label', undefined, 'skill-cluster-root-field')
      groupNameLabel.append(node('span', '分组名称')); groupNameLabel.append(groupName)
      const groupDescription = node('textarea')
      groupDescription.value = typeof envelope.description === 'string' ? envelope.description : (rootItem?.definition?.description || '')
      groupDescription.dataset.skillClusterGroupField = 'description'
      groupDescription.onchange = () => notifyClusterChange({ description: groupDescription.value }, cluster, rootItem)
      const groupDescriptionLabel = node('label', undefined, 'skill-cluster-root-field')
      groupDescriptionLabel.append(node('span', '分组说明')); groupDescriptionLabel.append(groupDescription)
      section.append(groupNameLabel, groupDescriptionLabel)
      const rootHeading = node('span', '根文档定义', 'skill-cluster-eyebrow')
      rootHeading.className = 'skill-cluster-eyebrow skill-cluster-root-definition-heading'
      section.append(rootHeading)
      const name = node('input')
      name.type = 'text'; name.value = draft?.name === undefined || draft?.name === null ? '' : String(draft.name)
      name.placeholder = fallbackRootName
      name.dataset.skillClusterRootField = 'name'
      name.onchange = () => notifyRootChange({ name: name.value }, cluster, rootItem)
      const nameLabel = node('label', undefined, 'skill-cluster-root-field')
      nameLabel.append(node('span', `${kindLabels[root.collection === 'skills' ? 'skill' : root.collection === 'rules' ? 'rule' : root.collection === 'cards' ? 'card' : 'piece'] || '根定义'}名称`)); nameLabel.append(name)
      const description = node('textarea')
      description.value = draft?.description === undefined || draft?.description === null ? '' : String(draft.description)
      description.dataset.skillClusterRootField = 'description'
      description.onchange = () => notifyRootChange({ description: description.value }, cluster, rootItem)
      const descriptionLabel = node('label', undefined, 'skill-cluster-root-field')
      descriptionLabel.append(node('span', '根文档说明')); descriptionLabel.append(description)
      section.append(nameLabel, descriptionLabel)
      return section
    }

    function renderMemberLinkActions(panel, cluster, member) {
      const source = member?.source
      if (!source || !['skills', 'pieces', 'rules', 'cards'].includes(source.collection) || !member.relation) return
      const link = { collection: source.collection, id: source.id, relation: member.relation }
      panel.append(node('p', `这是${relationLabels[member.relation] || '关联'}关系；它不会授予运行时能力。`, 'skill-cluster-reference-note'))
      panel.append(action('移除引用成员（不改变运行时规则）', () => notifyLinkChange('remove', link, cluster, member), 'skill-cluster-action secondary'))
    }

    function renderDetail(cluster = findCluster(currentResult, root)) {
      const panel = node('aside', undefined, 'skill-cluster-detail')
      panel.dataset.skillClusterMemberEditor = 'true'
      if (!selectedMember) {
        panel.append(node('h3', '选择一项关联内容'))
        panel.append(node('p', '从上方选择技能、规则、状态、卡牌或扩展字段，在这里编辑。', 'skill-cluster-muted'))
        return panel
      }
      const member = selectedMember
      panel.dataset.skillClusterDetail = member.kind
      const editingRoot = member.role === 'root' && root.collection !== 'pieces'
      if (!editingRoot) {
        panel.append(node('span', kindLabels[member.kind] || '关联成员', 'skill-cluster-eyebrow'))
        panel.append(node('h3', member.definition?.name || `未命名${kindLabels[member.kind] || '成员'}`))
        panel.append(node('p', member.definition?.description || '当前定义没有描述。', 'skill-cluster-detail-description'))
      } else panel.dataset.editingRoot = 'true'
      const source = member.source
      if (source && !editingRoot) {
        const sourceDetails = node('details', undefined, 'skill-cluster-source-details')
        sourceDetails.append(node('summary', '定义来源'))
        const sourceText = sourceLabel(member)
        sourceDetails.append(node('p', sourceText, 'skill-cluster-source-line'))
        if (member.kind !== 'extension' || typeof options.renderEffect !== 'function') sourceDetails.append(action('打开所属文档', () => navigate(member), 'skill-cluster-action secondary'))
        panel.append(sourceDetails)
      }
      if (member.kind === 'status' && member.editable !== false) panel.append(renderInlineStatusEditor(panel, member, options, report, assetCache))
      else if (member.kind === 'status') panel.append(node('p', '该状态来自兼容或生成来源，当前仅供查看。', 'skill-cluster-muted'))
      else if (member.kind === 'extension') {
        if (member.editable === false) panel.append(node('p', '该扩展来自兼容或生成来源，当前仅供查看。', 'skill-cluster-muted'))
        else renderStructuredExtensionEditor(panel, member, options, report)
      } else if (['skill', 'rule', 'card'].includes(member.kind)) {
        const effectHost = node('div', undefined, 'skill-cluster-effect-host')
        effectHost.dataset.skillClusterEffect = member.kind
        if (typeof options.renderEffect === 'function') {
          try {
            const rendered = options.renderEffect(effectHost, member, { root, cluster, selectMember, navigate })
            if (rendered && rendered.nodeType && rendered !== effectHost && !rendered.isConnected) effectHost.append(rendered)
          } catch (error) { effectHost.append(node('p', error instanceof Error ? error.message : String(error), 'skill-cluster-message error')) }
        } else effectHost.append(node('p', '当前工作区没有注入定义编辑器。', 'skill-cluster-muted'))
        panel.append(effectHost)
      }
      renderMemberLinkActions(panel, cluster, member)
      return panel
    }

    function renderPieceStats(draft) {
      const section = node('section', undefined, 'skill-cluster-piece-stats')
      const heading = node('div', undefined, 'skill-cluster-section-heading')
      heading.append(node('h3', '基础属性'), node('span', '可直接编辑草稿', 'skill-cluster-muted'))
      if (typeof options.openFields === 'function') heading.append(action('编辑全部字段', options.openFields, 'skill-cluster-action secondary'))
      section.append(heading)
      const grid = node('div', undefined, 'skill-cluster-piece-stat-strip')
      const stats = record(draft?.stats) ? draft.stats : {}
      const fields = pieceStatFields.filter(([key]) => own(stats, key))
      if (!fields.length) grid.append(node('p', '当前棋子没有声明基础属性。', 'skill-cluster-muted'))
      for (const [key, label, type] of fields) {
        const item = node('label', undefined, 'skill-cluster-piece-stat')
        item.append(node('span', label))
        const control = node('input')
        control.type = type
        control.value = stats[key] === null || stats[key] === undefined ? '' : String(stats[key])
        control.dataset.skillClusterPieceStat = key
        control.disabled = typeof options.onChange !== 'function'
        control.onchange = () => {
          const current = record(options.getDraft?.()) ? options.getDraft() : draft
          const currentStats = record(current?.stats) ? current.stats : {}
          const value = control.value === '' ? null : Number(control.value)
          const next = { ...current, stats: { ...currentStats, [key]: value } }
          if (typeof options.onChange !== 'function') return
          options.onChange(next)
          statusMessage = { message: '棋子属性草稿已更新。', kind: 'success' }
          render()
        }
        item.append(control)
        grid.append(item)
      }
      section.append(grid)
      return section
    }

    function catalogLinkTargets() {
      const catalog = typeof options.getCatalog === 'function' ? options.getCatalog() : options.catalog
      const targets = []
      for (const collection of ['skills', 'rules', 'cards']) {
        const entries = record(catalog?.[collection]) ? catalog[collection] : {}
        Object.entries(entries).forEach(([id, definition]) => targets.push({
          collection,
          id,
          name: definition?.name || '未命名内容',
        }))
      }
      return targets
    }

    function renderAttachControl(cluster) {
      const section = node('section', undefined, 'skill-cluster-link-editor')
      const heading = node('div', undefined, 'skill-cluster-section-heading')
      heading.append(node('h3', '加入引用成员'), node('span', '不会授予运行时能力', 'skill-cluster-muted'))
      section.append(heading)
      const row = node('div', undefined, 'skill-cluster-link-add-row')
      const select = node('select')
      select.dataset.skillClusterAttach = 'true'
      const targets = catalogLinkTargets()
      if (!targets.length) {
        const option = node('option', '没有可用的技能或规则定义')
        option.value = ''
        select.append(option)
      } else {
        targets.forEach(target => {
          const label = collectionLabels[target.collection] || '内容文档'
          const option = node('option', `${label} · ${target.name}`)
          option.value = `${target.collection}:${target.id}`
          select.append(option)
        })
      }
      const attach = action('附加引用成员', () => {
        const [collection, id] = String(select.value || '').split(':')
        if (!collection || !id) { report('请选择要附加的技能或规则。', 'error'); return }
        notifyLinkChange('attach', { collection, id, relation: 'shared' }, cluster, null)
      }, 'skill-cluster-action')
      attach.dataset.skillClusterAttachAction = 'true'
      row.append(select, attach)
      section.append(row)
      section.append(node('p', '引用关系只改变能力组成员投影；运行时规则仍由原定义负责。', 'skill-cluster-reference-note'))
      return section
    }

    function renderClusterCards(cluster) {
      const section = node('section', undefined, 'skill-cluster-cluster-cards')
      const heading = node('div', undefined, 'skill-cluster-section-heading')
      heading.append(node('h3', '关联能力组'), node('span', '主动 / 被动与成员数量', 'skill-cluster-muted'))
      section.append(heading)
      const draft = options.getDraft?.() || {}
      const directRules = new Set((Array.isArray(draft.rules) ? draft.rules : []).map(rule => typeof rule === 'string' ? rule : rule?.ruleId || rule?.id))
      const members = [...(cluster?.members?.skills || []), ...(cluster?.members?.rules || []).filter(member => directRules.has(member.source?.id || member.id) || record(member.definition?.cluster))]
      if (!members.length) section.append(node('p', '当前棋子没有已关联的能力组。', 'skill-cluster-muted'))
      for (const member of members) {
        const linked = clusterForRoot({ collection: member.source?.collection || 'skills', id: member.source?.id || member.id })
        const card = node('article', undefined, 'skill-cluster-linked-card')
        card.dataset.skillClusterLinkedRoot = `${member.source?.collection || 'skills'}:${member.id}`
        const top = node('div', undefined, 'skill-cluster-linked-card-top')
        top.append(node('strong', member.definition?.name || `未命名${kindLabels[member.kind] || '成员'}`))
        top.append(node('span', linked?.kind === 'active' ? '主动能力组' : '被动能力组', `skill-cluster-kind-badge ${linked?.kind === 'active' ? 'active' : 'passive'}`))
        card.append(top)
        const counts = node('div', undefined, 'skill-cluster-linked-card-counts')
        const linkedMembers = linked?.members || {}
        for (const [kind, label] of [['skills', '技能'], ['rules', '规则'], ['statuses', '状态'], ['cards', '卡牌'], ['extensions', '扩展字段']]) {
          counts.append(node('span', `${label} ${Array.isArray(linkedMembers[kind]) ? linkedMembers[kind].length : 0}`, 'skill-cluster-linked-card-count'))
        }
        card.append(counts)
        const actions = node('div', undefined, 'skill-cluster-linked-card-actions')
        actions.append(action('在本能力组中查看', () => openMember(member), 'skill-cluster-action secondary'))
        if (member.source) actions.append(action('打开能力组', event => { event?.stopPropagation?.(); navigate(member) }, 'skill-cluster-action secondary'))
        card.append(actions)
        section.append(card)
      }
      return section
    }

    function renderMemberTabs(cluster, rootItem) {
      const section = node('section', undefined, 'skill-cluster-member-workspace')
      const tabbar = node('nav', undefined, 'skill-cluster-member-tabs')
      tabbar.setAttribute('aria-label', '能力组成员类型')
      const buckets = {
        skill: cluster?.members?.skills || [],
        rule: cluster?.members?.rules || [],
        status: cluster?.members?.statuses || [],
        card: cluster?.members?.cards || [],
        extension: cluster?.members?.extensions || [],
      }
      const overview = node('button', '概览', `skill-cluster-member-tab${activeMemberKind === 'overview' ? ' is-selected' : ''}`)
      overview.type = 'button'
      overview.dataset.skillClusterMemberTab = 'overview'
      overview.onclick = () => {
        activeMemberKind = 'overview'
        selectedMember = null
        selectedId = null
        render()
      }
      tabbar.append(overview)
      const firstAvailable = memberTabSpecs.find(spec => buckets[spec[0]]?.length)?.[0] || 'skill'
      if (!activeMemberKind) activeMemberKind = 'overview'
      if (activeMemberKind !== 'overview' && !buckets[activeMemberKind]?.length && activeMemberKind !== 'extension') activeMemberKind = firstAvailable
      for (const [kind, english, label] of memberTabSpecs) {
        const entries = buckets[kind] || []
        const tabLabel = kind === 'skill' ? skillBucketLabel(entries) : label
        const tab = node('button', `${tabLabel} ${entries.length}`, `skill-cluster-member-tab${activeMemberKind === kind ? ' is-selected' : ''}`)
        tab.title = english
        tab.type = 'button'
        tab.dataset.skillClusterMemberTab = kind
        const canCreateExtension = kind === 'extension' && !entries.length && rootItem && (typeof options.onRootChange === 'function' || typeof options.onChange === 'function')
        tab.disabled = !entries.length && !canCreateExtension
        tab.onclick = () => {
          activeMemberKind = kind
          const current = entries.find(member => memberIdentity(member) === selectedId)
          if (!current && entries[0]) {
            selectedMember = entries[0]
            selectedId = memberIdentity(entries[0])
            if (typeof options.onSelectMember === 'function') options.onSelectMember(entries[0], { root, cluster })
          } else if (!current) { selectedMember = null; selectedId = null }
          render()
        }
        tab.setAttribute('aria-label', `${tabLabel}成员 ${entries.length} 项`)
        tabbar.append(tab)
      }
      section.append(tabbar)
      const list = node('div', undefined, 'skill-cluster-member-tab-list')
      const entries = buckets[activeMemberKind] || []
      const singleRoot = root.collection !== 'pieces' && entries.length === 1 && entries[0].role === 'root'
      if (activeMemberKind === 'overview') list.append(node('p', '概览包含能力组信息与引用操作；选择成员标签后，定义编辑器会在下方展开。', 'skill-cluster-muted'))
      else if (!entries.length && activeMemberKind === 'extension' && rootItem && (typeof options.onRootChange === 'function' || typeof options.onChange === 'function')) {
        const addExtension = action('添加扩展字段', () => notifyRootChange({ extension: {} }, cluster, rootItem), 'skill-cluster-action')
        addExtension.dataset.skillClusterCreateExtension = 'true'
        list.append(addExtension, node('p', '当前根文档尚未声明扩展字段；创建空对象后可继续添加文本、数字、布尔、空值、对象或列表字段。', 'skill-cluster-muted'))
      } else if (!entries.length) list.append(node('p', '当前标签没有成员。', 'skill-cluster-muted'))
      else if (!singleRoot) entries.forEach(member => list.append(renderMember(member, selectedId, openMember)))
      if (!singleRoot) section.append(list)
      return section
    }

    function renderUnifiedWorkspace(view, cluster, rootItem, className = '') {
      const layout = node('section', undefined, `skill-cluster-layout skill-cluster-unified-layout ${className}`.trim())
      layout.append(renderMemberTabs(cluster, rootItem))
      if (activeMemberKind === 'overview') {
        layout.append(renderRootFields(cluster, rootItem), renderAttachControl(cluster))
      } else {
        // Keep the injected Skill/Rule/Card editor below the compact member
        // picker. The shell already owns the right context panel, so this
        // detail surface must remain full width inside the editor column.
        layout.append(renderDetail(cluster))
      }
      view.append(layout)
    }

    function renderPieceOverview(view, cluster, rootItem) {
      const draft = record(options.getDraft?.()) ? options.getDraft() : rootItem?.definition || {}
      if (!activeMemberKind || activeMemberKind === 'overview') view.append(renderPieceStats(draft), renderClusterCards(cluster))
      // The shell's context panel already renders the piece image and basic
      // preview. Keep Cluster membership and definition editing in this one
      // workspace rather than rendering a second, narrower preview column.
      renderUnifiedWorkspace(view, cluster, rootItem, 'skill-cluster-piece-workspace')
    }

    function renderSkillOverview(view, cluster, rootItem) {
      const envelope = clusterEnvelopeFor(cluster, rootItem)
      const description = typeof envelope.description === 'string'
        ? envelope.description
        : rootItem?.definition && own(rootItem.definition, 'description') ? rootItem.definition.description : ''
      const descriptionCard = node('section', undefined, 'skill-cluster-description-card')
      descriptionCard.append(node('span', '能力说明', 'skill-cluster-eyebrow'))
      descriptionCard.append(node('p', description === '' ? '未填写描述。' : description, 'skill-cluster-description'))
      if (!activeMemberKind || activeMemberKind === 'overview') view.append(descriptionCard)
      renderUnifiedWorkspace(view, cluster, rootItem)
      const coverage = node('details', undefined, 'skill-cluster-coverage skill-cluster-coverage-inline')
      coverage.append(node('summary', '兼容诊断'))
      const grid = node('div', undefined, 'skill-cluster-coverage-grid')
      grid.append(coverageCard('语义模块', cluster.semanticCoverage || cluster.coverage?.semantic))
      grid.append(coverageCard('兼容来源', cluster.compatibilityCoverage || cluster.coverage?.compatibility))
      grid.append(coverageCard('声明关系', cluster.declarativeCoverage || cluster.coverage?.declarative))
      coverage.append(grid)
      view.append(coverage)
    }

    function render() {
      if (destroyed) return
      const viewport = container.closest('.detail-col')
      const previousScroll = viewport?.scrollTop
      currentResult = buildCatalog(options, root)
      const cluster = findCluster(currentResult, root)
      if (selectedMember && cluster) {
        const latest = latestMember(cluster, selectedMember)
        if (latest) selectedMember = latest
        else { selectedMember = null; selectedId = null }
      }
      if (!cluster) {
        container.replaceChildren()
        const empty = node('section', undefined, 'skill-cluster-editor')
        empty.dataset.skillClusterEditor = 'true'
        empty.append(node('div', '能力组目录正在加载，或当前内容还没有明确的能力组根。', 'skill-cluster-empty'))
        if (currentResult?.diagnostics?.length) {
          const diagnostics = node('div', undefined, 'skill-cluster-diagnostics')
          for (const item of currentResult.diagnostics.slice(0, 4)) diagnostics.append(node('p', item.message || String(item), `is-${item.severity || 'info'}`))
          empty.append(diagnostics)
        }
        container.append(empty)
        return
      }
      const rootItem = rootMember(cluster)
      const clusterEnvelope = clusterEnvelopeFor(cluster, rootItem)
      const view = node('section', undefined, 'skill-cluster-editor')
      view.dataset.skillClusterEditor = 'true'
      view.dataset.skillClusterOverview = 'true'
      view.dataset.skillClusterKind = cluster.kind
      view.dataset.skillClusterRootCollection = root.collection
      if (root.collection === 'pieces') view.classList.add('is-piece-root', 'skill-cluster-piece-root')
      const header = node('header', undefined, 'skill-cluster-header')
      const title = node('div', undefined, 'skill-cluster-title')
      title.append(node('span', `能力组 · ${collectionLabels[root.collection] || '内容文档'}`, 'skill-cluster-kicker'))
      const clusterTitle = typeof clusterEnvelope.name === 'string' && clusterEnvelope.name
        ? clusterEnvelope.name
        : rootItem?.definition?.name || (root.collection === 'pieces' ? '未命名棋子' : '未命名能力组')
      title.append(node('h2', clusterTitle))
      title.append(node('p', `${cluster.kind === 'active' ? '主动' : '被动'}能力组 · 成员关系仅供引用投影`, 'skill-cluster-subtitle'))
      header.append(title)
      const headerActions = node('div', undefined, 'skill-cluster-header-actions')
      headerActions.append(node('span', cluster.kind === 'active' ? '主动' : '被动', `skill-cluster-kind-badge ${cluster.kind}`))
      if (typeof options.openAdvanced === 'function') {
        const advanced = action('旧格式兼容诊断', options.openAdvanced, 'skill-cluster-action secondary')
        advanced.dataset.skillClusterAdvanced = 'true'
        headerActions.append(advanced)
      }
      header.append(headerActions)
      view.append(header)
      const description = rootItem?.definition && own(rootItem.definition, 'description') ? rootItem.definition.description : ''
      if (root.collection === 'pieces') {
        const descriptionCard = node('section', undefined, 'skill-cluster-description-card')
        descriptionCard.append(node('span', '棋子说明', 'skill-cluster-eyebrow'))
        descriptionCard.append(node('p', description === '' ? '未填写描述。' : description, 'skill-cluster-description'))
        view.append(descriptionCard)
        renderPieceOverview(view, cluster, rootItem)
      } else renderSkillOverview(view, cluster, rootItem)
      if (statusMessage) {
        const message = node('p', statusMessage.message, `skill-cluster-message ${statusMessage.kind}`)
        message.setAttribute('role', 'status')
        view.append(message)
      }
      container.replaceChildren(view)
      if (viewport && previousScroll !== undefined) viewport.scrollTop = previousScroll
    }

    render()
    return {
      refresh() { linkedClusterCache.clear(); render() },
      selectMember,
      destroy() { destroyed = true; container.replaceChildren() },
      getCluster() { return findCluster(currentResult, root) },
    }
  }

  window.SkillClusterEditor = { mount, mountStatus, mountStatusValue }
})()
