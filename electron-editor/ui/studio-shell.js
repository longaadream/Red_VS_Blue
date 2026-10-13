/* Status library is a projection of source definitions, never a second store. */
window.renderStudioStatuses = function renderStudioStatuses() {
  const collections = window.__editorCollections || {}
  const catalog = window.__editorGetContentCatalog?.() || { skills:{}, pieces:{}, rules:{}, cards:{} }
  if (!Object.keys(catalog.skills || {}).length && !Object.keys(catalog.pieces || {}).length) {
    const list = document.getElementById('statuses-list')
    const retries = Number(list?.dataset.statusRetry || 0)
    if (retries < 600) {
      if (list) list.textContent = '请从能力组的状态标签进入编辑。'
      return
    }
  }
  const list = document.getElementById('statuses-list')
  const detail = document.getElementById('statuses-detail')
  let result
  try { result = window.ContentGraphCore.buildSkillClusterCatalog(catalog) }
  catch(error) { detail.textContent = `状态目录读取失败：${error.message}`; return }
  const entries = new Map()
  for (const cluster of result.clusters || []) {
    for (const member of cluster.members?.all || []) {
      if (member.kind !== 'status') continue
      const key = JSON.stringify(member.source || [cluster.clusterId, member.id])
      if (!entries.has(key)) entries.set(key, { member, root: cluster.root })
    }
  }
  function select(entry, button) {
    list.querySelectorAll('.entity-item').forEach(row => row.classList.toggle('selected',row === button))
    const { member,root } = entry
    const definition = member.definition || {}
    detail.replaceChildren()
    const title = document.createElement('h2');title.textContent = definition.name || member.id;detail.append(title)
    const description = document.createElement('p');description.className='studio-status-description';description.textContent=definition.description || '这个状态尚未填写说明。';detail.append(description)
    if (definition.iconPath) {
      const image=document.createElement('img');image.className='studio-status-icon';image.alt=title.textContent;detail.append(image)
      api.readAsset(String(definition.iconPath).replace(/^images\//,'')).then(src=>{if(image.isConnected)image.src=src}).catch(error=>{image.remove();const text=document.createElement('p');text.textContent=`图标不可用：${error.message}`;detail.append(text)})
    }
    const source=document.createElement('p');source.className='studio-status-description';source.textContent=`定义来源：${member.source?.collection || root.collection} / ${member.source?.id || root.id}`;detail.append(source)
    const edit=document.createElement('button');edit.className='btn btn-primary';edit.textContent='编辑状态与图标';edit.disabled=member.editable===false
    edit.onclick=()=>{
      const collection = member.source?.collection === 'statuses' ? root.collection : (member.source?.collection || root.collection)
      const id = member.source?.id || root.id
      openCollectionDocument(collection,id)
      const panel=document.getElementById(`${collection}-detail`)
      panel?.showStatusMember?.(member)
      panel?.querySelector('[data-skill-cluster]')?.scrollIntoView({block:'start'})
    }
    detail.append(edit)
    if (member.editable===false) { const note=document.createElement('p');note.className='studio-status-description';note.textContent='此状态来自生成内容，目前只能查看；需先迁移其声明后才能编辑。';detail.append(note) }
  }
  function filter() {
    list.replaceChildren()
    const query=document.getElementById('statuses-search').value.toLowerCase()
    for (const entry of entries.values()) {
      const name=entry.member.definition?.name || entry.member.id
      if(!`${name} ${entry.member.definition?.description || ''}`.toLowerCase().includes(query))continue
      const button=document.createElement('button');button.type='button';button.className='entity-item studio-status-row'
      const title=document.createElement('span');title.className='name';title.textContent=name
      const source=document.createElement('span');source.className='id';source.textContent=entry.member.source?.id || entry.root.id
      button.append(title,source);button.onclick=()=>select(entry,button);list.append(button)
    }
    if(!list.childElementCount) list.textContent = `没有匹配的状态（集群 ${result.clusters?.length || 0} · 状态 ${entries.size} · 技能 ${Object.keys(catalog.skills || {}).length} · 集合 ${Object.keys(collections).join(',') || '无'}）`
  }
  document.getElementById('statuses-search').oninput=filter
  filter()
}

/*
 * The shell owns navigation, context and package workflow chrome.  Content
 * editors remain the source of truth for drafts and all writes still travel
 * through the existing document/asset IPC.  Keeping this layer in one small
 * module lets the sentence and Cluster editors mount into any document kind
 * without learning about the surrounding workbench.
 */
;(() => {
  'use strict'

  const api = window.editorAPI
  const routeLabels = {
    workbench: '创作工作台', pieces: '棋子', skills: '能力组', cards: '卡牌',
    rules: '规则', assets: '素材', build: '资源包', statuses: '状态目录', pve: 'PVE 内容',
  }
  const collectionLabels = { pieces: '棋子', skills: '能力组', cards: '卡牌', rules: '规则' }
  const clone = value => {
    try { return JSON.parse(JSON.stringify(value)) } catch { return value }
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character])
  const record = value => value && typeof value === 'object' && !Array.isArray(value)
  const safePath = value => typeof value === 'string' && value && !value.startsWith('/') && !value.includes('..') ? value.replaceAll('\\', '/') : ''
  const parseDraft = detail => {
    const source = detail?.querySelector('[data-json-source]')
    if (source) {
      try { return JSON.parse(source.value) } catch { /* validation stays in the editor */ }
    }
    const sessionStore = window.__editorDraftSessions
    const session = sessionStore ? [...sessionStore.values()].find(item => item.detailEl === detail) : null
    return clone(session?.draft || {})
  }
  const activeRoute = () => document.querySelector('.tab-panel.active')?.id?.replace(/^tab-/, '') || 'pieces'
  const activeDetail = () => {
    const route = activeRoute()
    return document.getElementById(`${route}-detail`)
  }
  const activeDocumentId = detail => detail?.querySelector('[data-json-source]')?.value ? (() => {
    const file = detail.querySelector('.file-id')?.textContent || ''
    return file.replace(/^.*[\\/]/, '').replace(/\.json$/, '')
  })() : ''

  function setBreadcrumb(route = activeRoute(), id = '') {
    const breadcrumb = document.querySelector('[data-shell-breadcrumb]')
    if (!breadcrumb) return
    const title = breadcrumb.querySelector('#section-title')
    const detail = activeDetail()
    const name = id && activeDocumentId(detail) === id ? detail?.querySelector('[data-document-title]')?.textContent?.trim() : ''
    if (title) title.textContent = id ? `${routeLabels[route] || route} / ${name || id}` : (routeLabels[route] || route)
    breadcrumb.dataset.route = route
    breadcrumb.dataset.documentId = id
  }

  function collectionForDetail(detail) {
    if (!detail) return activeRoute()
    return detail.id.replace(/-detail$/, '')
  }

  function statCards(data) {
    const stats = record(data?.stats) ? data.stats : {}
    const fields = [['maxHp', '生命'], ['attack', '攻击'], ['defense', '防御'], ['moveRange', '移动']]
    return fields.filter(([key]) => stats[key] !== undefined && stats[key] !== null)
      .map(([key, label]) => `<span class="context-stat"><small>${label}</small><strong>${escape(stats[key])}</strong></span>`).join('')
  }

  function graphCount(data) {
    const walk = value => {
      if (!record(value)) return 0
      let count = Array.isArray(value.body) ? value.body.length : 0
      for (const key of ['body', 'then', 'else', 'condition', 'graph', 'continuations', 'composites']) count += Array.isArray(value[key]) ? value[key].reduce((sum, item) => sum + walk(item), 0) : walk(value[key])
      return count
    }
    const entries = data?.gameplayModules?.entries
    if (!record(entries)) return 0
    return Object.values(entries).reduce((sum, entry) => sum + walk(entry?.graph), 0)
  }

  function references(data) {
    const values = []
    const push = (kind, value) => {
      if (typeof value === 'string' && value) values.push([kind, value])
      if (Array.isArray(value)) value.forEach(item => push(kind, record(item) ? item.id || item.skillId || item.cardId : item))
      if (record(value)) Object.entries(value).forEach(([key, child]) => ['skillId', 'ruleId', 'cardId', 'statusId', 'pieceId', 'templateId'].includes(key) && push(key.replace(/Id$/, ''), child))
    }
    for (const field of ['skills', 'rules', 'relatedRules', 'relatedCards', 'initialStatusTags', 'statusTag', 'summonCapability', 'targeting', 'cluster', 'gameplayModules']) push(field, data?.[field])
    const seen = new Set()
    return values.filter(([kind, value]) => { const key = `${kind}:${value}`; if (seen.has(key)) return false; seen.add(key); return true }).slice(0, 12)
  }

  function expressionVariables(data) {
    const source = data?.variables || data?.parameters || data?.params
    if (!record(source)) return []
    return Object.entries(source).slice(0, 10).map(([name, value]) => [name, Array.isArray(value) ? `数组 · ${value.length}` : record(value) ? value.type || value.kind || '对象' : String(value ?? '空')])
  }

  function contextMarkup(route, data, detail) {
    const id = data?.id || detail?.querySelector('.file-id')?.textContent?.split(/[\\/]/).at(-1)?.replace(/\.json$/, '') || ''
    const name = data?.name || id || '未选择内容'
    const description = data?.description || '尚未填写描述。'
    const refs = references(data)
    const count = graphCount(data)
    const status = data?.statusTag || data?.initialStatusTags
    const statusCount = Array.isArray(status) ? status.length : status ? 1 : 0
    const editEffect = detail?.querySelector('[data-editor-mode="cluster"]') ? '<button type="button" class="context-action" data-context-open="cluster">编辑效果</button>' : ''
    const editGraph = detail?.querySelector('[data-editor-mode="graph"]') ? '<button type="button" class="context-action secondary" data-context-open="graph">高级模块视图</button>' : ''
    const editFields = detail?.querySelector('[data-editor-mode="fields"]') ? '<button type="button" class="context-action secondary" data-context-open="fields">编辑基础属性</button>' : ''
    const trial = route === 'skills' && detail?.querySelector('[data-sentence-trial]') ? '<button type="button" class="context-action" data-context-action="trial">试用技能</button>' : ''
    const referenceRows = refs.length ? refs.map(([kind, value]) => `<div class="context-reference-row"><span>${escape(kind)}</span><strong>${escape(value)}</strong></div>`).join('') : '<p class="context-muted">当前内容没有显式引用。</p>'
    const variableRows = expressionVariables(data)
    const variableCard = variableRows.length ? `<div class="context-card"><div class="context-card-heading"><span>表达式变量</span><span class="context-chip">${variableRows.length}</span></div><div class="context-reference-list context-variable-list">${variableRows.map(([name, value]) => `<div class="context-reference-row"><span>${escape(name)}</span><strong>${escape(value)}</strong></div>`).join('')}</div></div>` : ''
    const common = `<div class="context-card"><div class="context-card-heading"><span>当前内容</span><span class="context-chip">${escape(collectionLabels[route] || route)}</span></div><h2 data-context-title>${escape(name)}</h2><p class="context-description">${escape(description)}</p><p class="context-id">${escape(id)}</p></div>
      <div class="context-card"><div class="context-card-heading"><span>当前可用引用</span><span class="context-help" title="引用来自当前草稿及其能力组" role="img" aria-label="引用说明">?</span></div><div class="context-reference-list" data-context-reference-list>${referenceRows}</div></div>
      ${variableCard}
      <div class="context-card"><div class="context-card-heading"><span>高级信息</span><span class="context-status-dot ${count || route === 'pieces' ? 'is-ok' : 'is-neutral'}"></span></div><div class="context-facts"><span>效果语句<strong>${count || '—'}</strong></span><span>状态定义<strong>${statusCount}</strong></span><span>未知字段<strong>保留</strong></span></div><p class="context-muted">未显示字段会随保存一起保留。校验和引用错误会在编辑器中定位。</p></div>`
    if (route === 'pieces') {
      const image = safePath(data?.image)
      const imageNode = image ? `<div class="context-piece-image" data-context-image-host><span>正在读取预览…</span></div>` : '<div class="context-piece-image is-empty" data-context-image-host><span>未选择棋子图片</span></div>'
      const skillCount = Array.isArray(data?.skills) ? data.skills.length : 0
      const ruleCount = Array.isArray(data?.rules) ? data.rules.length : 0
      return `<div class="context-card context-piece-preview"><div class="context-card-heading"><span>棋子预览</span><span class="context-help" title="预览使用当前内容和素材 IPC" role="img" aria-label="预览说明">↗</span></div>${imageNode}<h2>${escape(name)}</h2><p class="context-muted">阵营：${escape(data?.faction || '未设置')} · 稀有度：${escape(data?.rarity || '未设置')}</p><div class="context-stats">${statCards(data) || '<span class="context-muted">尚未填写基础属性。</span>'}</div><div class="context-counts"><span>能力组成员<strong>${skillCount}</strong></span><span>规则依赖<strong>${ruleCount}</strong></span></div></div>${common}`
    }
    return `${common}<div class="context-actions" data-context-actions>${editEffect}${editFields}${editGraph}${trial}</div><div class="context-card context-preview-card"><div class="context-card-heading"><span>效果说明</span></div><p class="context-preview-copy">${escape(description)}</p>${trial ? '<p class="context-muted">试用将在训练营窗口打开。</p>' : ''}</div>`
  }

  async function hydratePieceImage(detail, data) {
    const host = detail?.querySelector('[data-context-image-host]')
    if (!host || !safePath(data?.image) || !api?.readAsset) return
    try {
      const source = await api.readAsset(safePath(data.image))
      if (!host.isConnected) return
      host.replaceChildren()
      const image = document.createElement('img')
      image.alt = data.name ? `${data.name} 预览` : '棋子预览'
      image.src = source
      host.append(image)
    } catch { if (host.isConnected) host.textContent = '图片预览不可用' }
  }

  function wireContext(detail) {
    const panel = detail?.querySelector('[data-context-panel]')
    if (!panel) return
    const route = collectionForDetail(detail)
    const source = detail.querySelector('[data-json-source]')
    const sourceValue = source?.value || ''
    const activePane = detail.querySelector('.editor-pane.active')?.dataset.editorPane || ''
    const selected = activePane === 'cluster' && detail.querySelector('.skill-cluster-effect-host') ? detail?.getSelectedMemberDraft?.() : null
    const signature = `${route}|${activeDocumentId(detail)}|${activePane}|${sourceValue}|${selected ? JSON.stringify(selected) : ''}`
    if (panel.dataset.contextSignature === signature && panel.querySelector('[data-context-title]')) return
    panel.dataset.contextSignature = signature
    const data = selected?.value || parseDraft(detail)
    const contextRoute = selected?.collection || route
    panel.innerHTML = contextMarkup(contextRoute, data, detail)
    panel.querySelectorAll('[data-context-open]').forEach(button => {
      button.onclick = () => detail.querySelector(`[data-editor-mode="${button.dataset.contextOpen}"]`)?.click()
    })
    panel.querySelector('[data-context-action="trial"]')?.addEventListener('click', () => detail.querySelector('[data-sentence-trial]')?.click())
    if (contextRoute === 'pieces') void hydratePieceImage(detail, data)
    panel.dataset.route = route
    panel.dataset.documentId = data?.id || activeDocumentId(detail)
  }

  function installEditorChrome(detail) {
    if (!detail || !detail.classList.contains('detail-col')) return
    const layout = detail.querySelector('[data-context-layout]')
    if (!layout) return
    const header = detail.querySelector('.editor-header')
    if (header && !header.querySelector('[data-focus-editor]')) {
      const actions = document.createElement('div')
      actions.className = 'editor-header-actions'
      const focus = document.createElement('button')
      focus.type = 'button'; focus.className = 'context-header-button'; focus.dataset.focusEditor = 'true'; focus.textContent = detail.closest('.split')?.classList.contains('is-focused') ? '返回列表' : '专注编辑'
      focus.onclick = () => {
        const split = detail.closest('.split')
        const focused = split?.classList.toggle('is-focused') || false
        focus.textContent = focused ? '返回列表' : '专注编辑'
        focus.setAttribute('aria-pressed', focused ? 'true' : 'false')
      }
      actions.append(focus)
      header.append(actions)
    }
    wireContext(detail)
    if (detail === activeDetail()) setBreadcrumb(collectionForDetail(detail), activeDocumentId(detail))
  }

  function updateShellRoute() {
    const route = activeRoute()
    document.body.dataset.shellRoute = route
    document.querySelectorAll('[data-shell-nav]').forEach(button => button.classList.toggle('active', button.dataset.shellNav === route))
    setBreadcrumb(route, route === 'pieces' || route === 'skills' || route === 'cards' || route === 'rules' ? activeDocumentId(activeDetail()) : '')
    document.querySelectorAll('.detail-col').forEach(installEditorChrome)
  }

  function installListControls() {
    document.querySelectorAll('[data-list-toggle]').forEach(button => {
      if (button.dataset.shellBound) return
      button.dataset.shellBound = 'true'
      button.onclick = () => {
        const split = button.closest('.split')
        const collapsed = split?.classList.toggle('is-focused') || false
        button.textContent = collapsed ? '›' : '‹'
        button.title = collapsed ? '展开列表' : '收起列表'
        button.setAttribute('aria-label', collapsed ? '展开列表' : '收起列表')
      }
    })
  }

  function setupPackageFlow() {
    const panel = document.getElementById('tab-build')
    if (!panel || panel.dataset.shellPackageBound) return
    panel.dataset.shellPackageBound = 'true'
    const stageButtons = [...panel.querySelectorAll('[data-package-stage]')]
    const contents = panel.querySelector('[data-package-contents-card]')
    const technical = panel.querySelector('#technical-pipeline-tools')
    const result = panel.querySelector('[data-package-result-card]')
    const buildForm = panel.querySelector('#pipeline-form-build')
    const advanced = panel.querySelector('.operation-nav')
    const selectStage = stage => {
      stageButtons.forEach(button => {
        const active = button.dataset.packageStage === stage
        button.classList.toggle('active', active)
        button.setAttribute('aria-current', active ? 'step' : 'false')
      })
      if (contents) contents.hidden = stage !== 'contents'
      if (result) result.hidden = stage !== 'result'
      if (technical) technical.open = stage !== 'contents'
      if (buildForm) buildForm.hidden = !(stage === 'settings' || stage === 'generate')
      if (advanced) advanced.hidden = stage !== 'settings' && stage !== 'generate'
      panel.dataset.packageStage = stage
      if (stage === 'contents') panel.querySelector('[data-refresh-workspace], #refresh-workspace')?.click()
    }
    stageButtons.forEach(button => button.onclick = () => selectStage(button.dataset.packageStage))
    panel.querySelectorAll('[data-package-next]').forEach(button => button.onclick = () => selectStage(button.dataset.packageNext))
    if (technical) technical.addEventListener('toggle', () => { if (technical.open && panel.dataset.packageStage === 'contents') selectStage('settings') })
    selectStage('contents')
  }

  // Public shell hook for the Cluster worker. The worker can mount its own
  // member tabs/effect host while the surrounding context stays stable.
  window.StudioShell = {
    mountClusterEditor(host, options = {}) {
      if (!host || !window.SkillClusterEditor?.mount) return null
      return window.SkillClusterEditor.mount(host, options)
    },
    renderContext(detail = activeDetail()) { wireContext(detail) },
    focusEditor(detail = activeDetail()) { detail?.querySelector('[data-focus-editor]')?.click() },
    setPackageStage(stage) { document.querySelector(`[data-package-stage="${stage}"]`)?.click() },
  }

  let routeRefreshQueued = false
  const observer = new MutationObserver(records => {
    // Context hydration and breadcrumb updates are shell-owned mutations. They
    // must not cause the observer to rebuild every document and re-read assets.
    const relevant = records.some(record => {
      if (record.target?.closest?.('[data-context-panel], [data-shell-breadcrumb]')) return false
      return [...record.addedNodes, ...record.removedNodes].some(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return false
        return !node.closest?.('[data-context-panel], [data-shell-breadcrumb]')
      })
    })
    if (!relevant || routeRefreshQueued) return
    routeRefreshQueued = true
    window.setTimeout(() => {
      routeRefreshQueued = false
      installListControls()
      updateShellRoute()
      setupPackageFlow()
    }, 0)
  })
  observer.observe(document.getElementById('content') || document.body, { childList: true, subtree: true })
  document.addEventListener('input', event => {
    if (event.target.closest('.detail-col')) window.setTimeout(() => wireContext(event.target.closest('.detail-col')), 0)
  })
  document.addEventListener('change', event => {
    if (event.target.closest('.detail-col')) window.setTimeout(() => wireContext(event.target.closest('.detail-col')), 0)
  })
  document.querySelectorAll('[data-shell-nav], .tab-btn').forEach(button => button.addEventListener('click', () => window.setTimeout(updateShellRoute, 0)))
  document.querySelector('[data-breadcrumb-root]')?.addEventListener('click', () => document.querySelector('[data-shell-nav="workbench"]')?.click())
  installListControls()
  setupPackageFlow()
  updateShellRoute()
})()
