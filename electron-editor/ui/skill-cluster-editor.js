/*
 * Author-facing Skill Cluster overview.
 *
 * This surface is deliberately a projection of the shared Cluster builder.
 * It does not infer ownership from names and it never becomes a second rule
 * executor.  Editing an inline status is delegated to the document editor so
 * the original object shape (including extension fields) can be preserved.
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

  const kindLabels = { skill: '技能', piece: '棋子', rule: '规则', status: '状态', card: '卡牌', continuation: '续接', presentation: '表现' }
  const roleLabels = { root: '能力根', dependency: '明确依赖', related: '相关内容' }
  const evidenceLabels = {
    semantic: '语义来源', compatibility: '兼容来源', declarative: '声明来源', explicit: '显式关联', inline: '内联定义', generated: '生成来源',
  }
  const stateLabels = { complete: '完整覆盖', partial: '部分覆盖', missing: '未覆盖' }
  const stateClasses = { complete: 'is-complete', partial: 'is-partial', missing: 'is-missing' }
  function memberIdentity(member) {
    const source = member?.source || {}
    return JSON.stringify([
      member?.kind || '', member?.id || '', source.collection || '', source.id || '',
      source.path || source.field || '',
    ])
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

  function buildCatalog(options) {
    if (typeof options.getCatalogResult === 'function') return normalizeResult(options.getCatalogResult())
    if (options.catalogResult) return normalizeResult(options.catalogResult)
    const catalog = typeof options.getCatalog === 'function' ? options.getCatalog() : options.catalog
    const core = coreFor(options)
    const singleBuilder = core?.buildSkillCluster || core?.createSkillCluster
    if (typeof singleBuilder === 'function') {
      try {
        const cluster = singleBuilder(catalog || { skills: {}, rules: {}, pieces: {}, cards: {} }, options.root, options.clusterOptions)
        return cluster ? { clusters: [cluster], diagnostics: cluster.diagnostics || [] } : { clusters: [], diagnostics: [] }
      } catch (error) {
        return { clusters: [], diagnostics: [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }] }
      }
    }
    const builder = core?.buildSkillClusterCatalog || core?.createSkillClusterCatalog || core?.getSkillClusterCatalog
    if (typeof builder !== 'function') return { clusters: [], diagnostics: [{ severity: 'info', message: '共享 Cluster 目录尚未加载。' }] }
    try { return normalizeResult(builder(catalog || { skills: {}, rules: {}, pieces: {}, cards: {} }, options.clusterOptions)) }
    catch (error) { return { clusters: [], diagnostics: [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }] } }
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
      || null
  }

  function coverageCard(title, coverage) {
    const card = node('div', undefined, 'skill-cluster-coverage-card')
    const status = coverage?.status || 'missing'
    card.append(node('span', title, 'skill-cluster-eyebrow'))
    card.append(node('strong', stateLabels[status] || status, `skill-cluster-state ${stateClasses[status] || ''}`))
    const covered = Number.isFinite(coverage?.covered) ? coverage.covered : 0
    const total = Number.isFinite(coverage?.total) ? coverage.total : 0
    card.append(node('span', `${covered} / ${total} 项`, 'skill-cluster-muted'))
    return card
  }

  function evidenceStates(member) {
    const evidence = member?.evidence
    const semantic = evidence === 'semantic' ? '已映射' : '未映射'
    const compatibility = evidence === 'compatibility' || evidence === 'generated' ? evidence === 'generated' ? '生成来源' : '已记录' : '未标记'
    const declarative = ['explicit', 'inline', 'declarative'].includes(evidence) ? '已声明' : '未声明'
    return [
      ['语义', semantic, evidence === 'semantic' ? 'is-complete' : 'is-missing'],
      ['兼容', compatibility, evidence === 'compatibility' || evidence === 'generated' ? 'is-partial' : 'is-missing'],
      ['声明', declarative, ['explicit', 'inline', 'declarative'].includes(evidence) ? 'is-complete' : 'is-missing'],
    ]
  }

  function sourceCollection(member) {
    const collection = member?.source?.collection
    if (collection === 'statuses') return 'skills'
    return collection
  }

  function renderInlineStatusEditor(host, member, options, report) {
    const definition = record(member?.definition) ? member.definition : {}
    const source = member?.source
    const editor = node('section', undefined, 'skill-cluster-inline-editor')
    editor.append(node('h4', '状态参数', 'skill-cluster-inline-editor-title'))
    editor.append(node('p', '保留未展示的扩展字段；这里只编辑已存在的结构化字段。', 'skill-cluster-muted'))
    const fields = [
      ['id', '状态 ID', 'text'], ['type', '类型', 'text'], ['duration', '持续回合', 'number'], ['turns', '回合数', 'number'],
      ['stacks', '层数', 'number'], ['amount', '数值', 'number'], ['description', '说明', 'textarea'],
    ].filter(([key]) => own(definition, key))
    if (!fields.length) editor.append(node('p', '该状态没有可编辑的已声明参数。', 'skill-cluster-muted'))
    for (const [key, title, type] of fields) {
      const wrapper = node('label', undefined, 'skill-cluster-inline-field')
      wrapper.append(node('span', title))
      const control = type === 'textarea' ? node('textarea') : node('input')
      if (type !== 'textarea') control.type = type
      control.value = definition[key] === undefined || definition[key] === null ? '' : String(definition[key])
      control.dataset.skillClusterStatusField = key
      control.onchange = () => {
        const raw = control.value
        const value = type === 'number' ? (raw === '' ? null : Number(raw)) : raw
        try {
          if (typeof options.onMemberChange !== 'function') throw new Error('当前文档不支持状态编辑。')
          options.onMemberChange(member, { [key]: value })
          report('状态草稿已更新。', 'success')
        } catch (error) { report(error instanceof Error ? error.message : String(error), 'error') }
      }
      wrapper.append(control)
      editor.append(wrapper)
    }
    if (source && member.editable !== false) editor.append(node('p', '修改仅进入对应内容的草稿；保存仍由内容编辑器统一执行。', 'skill-cluster-muted'))
    return editor
  }

  function mount(container, options = {}) {
    if (!container) return { refresh() {}, destroy() {} }
    const root = options.root || { collection: 'skills', id: '' }
    let selectedId = null
    let selectedMember = null
    let statusMessage = null
    let currentResult = null
    let destroyed = false

    const report = (message, kind = 'info') => {
      statusMessage = { message, kind }
      render()
    }
    const openMember = member => {
      selectedMember = member
      selectedId = member?.kind && member?.id ? memberIdentity(member) : null
      render()
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

    function renderMember(member) {
      const row = node('button', undefined, `skill-cluster-member${selectedId === memberIdentity(member) ? ' is-selected' : ''}`)
      row.type = 'button'
      row.dataset.skillClusterMember = `${member.kind}:${member.id}`
      row.dataset.skillClusterMemberKey = memberIdentity(member)
      const top = node('span', undefined, 'skill-cluster-member-top')
      top.append(node('strong', member.definition?.name || member.id), node('span', kindLabels[member.kind] || member.kind, 'skill-cluster-kind'))
      row.append(top)
      const summary = member.definition?.description || (member.role === 'root' ? '当前能力' : `${roleLabels[member.role] || '关联内容'}，点击查看说明。`)
      row.append(node('span', summary, 'skill-cluster-member-summary'))
      row.onclick = () => openMember(member)
      return row
    }

    function renderDetail() {
      const panel = node('aside', undefined, 'skill-cluster-detail')
      if (!selectedMember) {
        panel.append(node('h3', '选择一项关联内容'))
        panel.append(node('p', '查看来源、覆盖状态或打开对应内容编辑器。', 'skill-cluster-muted'))
        return panel
      }
      const member = selectedMember
      panel.append(node('span', kindLabels[member.kind] || member.kind, 'skill-cluster-eyebrow'))
      panel.append(node('h3', member.definition?.name || member.id))
      panel.append(node('p', member.definition?.description || '当前定义没有描述。', 'skill-cluster-detail-description'))
      const source = member.source
      if (source) {
        panel.append(action(`打开${kindLabels[member.kind] || '来源'}`, () => navigate(member), 'skill-cluster-action secondary'))
      }
      if (member.kind === 'status' && member.editable !== false) panel.append(renderInlineStatusEditor(panel, member, options, report))
      else if (member.kind === 'status') panel.append(node('p', '该状态来自兼容或生成来源，当前仅供查看。', 'skill-cluster-muted'))
      return panel
    }

    function renderAdvanced(cluster) {
      const details = document.createElement('details')
      details.className = 'skill-cluster-advanced'
      details.append(node('summary', '高级信息'))
      const body = node('div', undefined, 'skill-cluster-advanced-body')
      const identity = node('p', undefined, 'skill-cluster-advanced-identity')
      identity.append(node('span', `Cluster ${cluster.clusterId || root.id}`), node('span', `版本 ${cluster.version || '未知'}`), node('span', `执行边界 ${cluster.execution || 'reference-only'}`))
      body.append(identity)
      const coverage = node('section', undefined, 'skill-cluster-coverage')
      coverage.append(node('h3', '覆盖状态'))
      const coverageGrid = node('div', undefined, 'skill-cluster-coverage-grid')
      coverageGrid.append(coverageCard('语义模块', cluster.semanticCoverage || cluster.coverage?.semantic))
      coverageGrid.append(coverageCard('兼容来源', cluster.compatibilityCoverage || cluster.coverage?.compatibility))
      coverageGrid.append(coverageCard('声明关系', cluster.declarativeCoverage || cluster.coverage?.declarative))
      coverage.append(coverageGrid)
      body.append(coverage)
      const members = Array.isArray(cluster.members?.all) ? cluster.members.all : []
      const provenance = node('section', undefined, 'skill-cluster-advanced-provenance')
      provenance.append(node('h3', '成员来源'))
      if (!members.length) provenance.append(node('p', '当前没有成员来源记录。', 'skill-cluster-muted'))
      for (const member of members) {
        const entry = node('div', undefined, 'skill-cluster-provenance-entry')
        const title = node('strong', `${member.definition?.name || member.id} · ${kindLabels[member.kind] || member.kind}`)
        const source = member.source ? `${member.source.collection} · ${member.source.id} · ${member.source.path || 'root'}` : '来源未确定'
        entry.append(title, node('span', `${roleLabels[member.role] || member.role} · ${evidenceLabels[member.evidence] || member.evidence} · ${source}`, 'skill-cluster-muted'))
        const states = node('span', undefined, 'skill-cluster-member-states')
        for (const [label, value, state] of evidenceStates(member)) states.append(node('span', `${label} · ${value}`, `skill-cluster-mini-state ${state}`))
        entry.append(states)
        if (member.provenance?.length > 1) {
          for (const item of member.provenance.slice(1)) entry.append(node('span', `另有来源：${item.collection} · ${item.id} · ${item.path}`, 'skill-cluster-muted'))
        }
        provenance.append(entry)
      }
      body.append(provenance)
      const diagnostics = Array.isArray(cluster.diagnostics) ? cluster.diagnostics : []
      if (diagnostics.length) {
        const diagnosticPanel = node('section', undefined, 'skill-cluster-diagnostics')
        diagnosticPanel.append(node('h3', `检查信息（${diagnostics.length}）`))
        for (const item of diagnostics) diagnosticPanel.append(node('p', item.message || String(item), `is-${item.severity || 'info'}`))
        body.append(diagnosticPanel)
      }
      details.append(body)
      return details
    }

    function render() {
      if (destroyed) return
      currentResult = buildCatalog(options)
      const cluster = findCluster(currentResult, root)
      if (selectedMember && cluster) {
        const latest = cluster.members?.all?.find(item => memberIdentity(item) === memberIdentity(selectedMember))
        if (latest) selectedMember = latest
        else selectedMember = null
      }
      if (!cluster) {
        container.replaceChildren()
        const empty = node('section', undefined, 'skill-cluster-editor')
        empty.dataset.skillClusterEditor = 'true'
        empty.append(node('div', 'Cluster 目录正在加载，或当前内容还没有明确的 Cluster 根。', 'skill-cluster-empty'))
        if (currentResult?.diagnostics?.length) {
          const diagnostics = node('div', undefined, 'skill-cluster-diagnostics')
          for (const item of currentResult.diagnostics.slice(0, 4)) diagnostics.append(node('p', item.message || String(item), `is-${item.severity || 'info'}`))
          empty.append(diagnostics)
        }
        container.append(empty)
        return
      }
      const rootItem = rootMember(cluster)
      const view = node('section', undefined, 'skill-cluster-editor')
      view.dataset.skillClusterEditor = 'true'
      view.dataset.skillClusterOverview = 'true'
      view.dataset.skillClusterKind = cluster.kind
      const header = node('header', undefined, 'skill-cluster-header')
      const title = node('div', undefined, 'skill-cluster-title')
      title.append(node('span', '技能总览', 'skill-cluster-kicker'))
      title.append(node('h2', rootItem?.definition?.name || root.id))
      title.append(node('p', cluster.kind === 'active' ? '主动能力' : '被动能力', 'skill-cluster-subtitle'))
      header.append(title)
      const headerActions = node('div', undefined, 'skill-cluster-header-actions')
      headerActions.append(node('span', cluster.kind === 'active' ? '主动' : '被动', `skill-cluster-kind-badge ${cluster.kind}`))
      if (typeof options.openAdvanced === 'function') {
        const advanced = action('高级：打开流程图', options.openAdvanced, 'skill-cluster-action secondary')
        advanced.dataset.skillClusterAdvanced = 'true'
        headerActions.append(advanced)
      }
      header.append(headerActions)
      view.append(header)

      const description = rootItem?.definition && own(rootItem.definition, 'description') ? rootItem.definition.description : ''
      const descriptionCard = node('section', undefined, 'skill-cluster-description-card')
      descriptionCard.append(node('span', '当前效果说明', 'skill-cluster-eyebrow'))
      descriptionCard.append(node('p', description === '' ? '未填写描述。' : description, 'skill-cluster-description'))
      view.append(descriptionCard)

      const layout = node('div', undefined, 'skill-cluster-layout')
      const membersPanel = node('section', undefined, 'skill-cluster-members')
      membersPanel.append(node('h3', '能力组成'))
      const members = Array.isArray(cluster.members?.all) ? cluster.members.all : []
      if (!members.length) membersPanel.append(node('p', '当前没有可展示的明确关联。', 'skill-cluster-muted'))
      else {
        const groups = [
          ['能力与依赖', members.filter(item => item.kind === 'skill' || item.kind === 'piece' || item.kind === 'card')],
          ['状态与规则', members.filter(item => item.kind === 'status' || item.kind === 'rule')],
          ['续接与表现', members.filter(item => item.kind === 'continuation' || item.kind === 'presentation')],
        ]
        for (const [label, entries] of groups) {
          if (!entries.length) continue
          const group = node('div', undefined, 'skill-cluster-member-group')
          group.append(node('h4', label))
          for (const member of entries) group.append(renderMember(member))
          membersPanel.append(group)
        }
      }
      layout.append(membersPanel, renderDetail())
      view.append(layout)

      const continuations = cluster.members?.continuations || []
      const continuationNote = node('section', undefined, 'skill-cluster-continuations')
      continuationNote.append(node('h3', '续接与表现'))
      continuationNote.append(node('p', continuations.length ? `已读取 ${continuations.length} 个明确续接。` : '当前定义没有明确声明的续接或表现配置。', 'skill-cluster-muted'))
      view.append(continuationNote)
      view.append(renderAdvanced(cluster))
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
      destroy() { destroyed = true; container.replaceChildren() },
      getCluster() { return findCluster(currentResult, root) },
    }
  }

  window.SkillClusterEditor = { mount }
})()
