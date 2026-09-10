/* Task-centred UI. All comparisons and reports come from the trusted main process. */
(() => {
  const api = window.editorAPI
  const root = document.getElementById('tab-workbench')
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character])
  const date = value => new Date(value).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
  const format = value => value === null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  const fieldLabel = field => ({ name:'名称', description:'描述', 'stats.maxHp':'最大生命', 'stats.attack':'攻击力', 'stats.defense':'防御力', 'stats.moveRange':'移动范围', skills:'关联技能', rules:'关联规则', keywords:'机制关键词', effectTags:'效果分类', code:'技能逻辑', previewCode:'预览逻辑' })[field] || field
  let tasks = [], state = null, section = 'changes', busy = false, status = '', feedbackDraft = ''
  let selected = new Set(), polling = false, generation = 0, releaseDraft = ''
  const scenarioDraft = { setup:'', action:'', expected:'' }
  const hasDrafts = () => Boolean(feedbackDraft || Object.values(scenarioDraft).some(Boolean))
  const discardDrafts = () => !hasDrafts() || window.confirm('当前反馈或场景尚未保存。继续会丢弃这些草稿，是否继续？')
  window.workbenchHasDrafts = hasDrafts
  const current = () => state?.task.id
  const errorMessage = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '')
  function checkLabel() {
    if (!state.check) return state.hasOlderChecks ? '内容已变化 · 需要重检' : '尚未检查'
    return state.check.issues.some(issue => issue.severity === 'error') ? '发现待修复问题' : '结构与引用检查通过'
  }
  function issues() {
    if (!state.check) return `<div class="wb-note">${state.hasOlderChecks ? '上次检查属于另一个内容版本，不能用于当前修改。' : '先运行内容检查，确认结构、manifest 和资源引用。'} 技能执行需要单独验证。</div>`
    const rows = state.check.issues.map(issue => `<div class="wb-note ${issue.severity === 'error' ? 'wb-error' : 'wb-warning'}"><strong>${escape(issue.message)}</strong><div class="wb-path">${escape(issue.path)}</div></div>`).join('')
    return rows || '<div class="wb-note">当前版本没有发现结构或引用错误。技能执行、平衡性和客户端兼容性尚未据此验证。</div>'
  }
  function changes() {
    return `<div class="wb-metrics">
      <div class="wb-metric"><strong>${state.changes.length}</strong><span>实际变更文件</span></div>
      <div class="wb-metric"><strong>${state.check ? state.check.issues.filter(issue => issue.severity === 'error').length : '—'}</strong><span>当前检查错误</span></div>
      <div class="wb-metric"><strong>${state.versions.filter(version => version.status === 'accepted').length}</strong><span>已接受的本地版本</span></div>
    </div>${issues()}
    ${state.changes.length ? `<div class="wb-selection"><label><input type="checkbox" data-select-all ${selected.size === state.changes.length ? 'checked' : ''}/> 全选修改</label><span>已选择 ${selected.size} 项</span><button class="btn btn-primary" data-wb="accept" ${busy || !selected.size ? 'disabled' : ''}>接受选中修改</button><button class="btn btn-ghost" data-wb="revert" ${busy || !selected.size ? 'disabled' : ''}>撤销选中修改</button></div><p class="wb-copy">按内容文件分别处理；未选中的修改继续保留。接受时检查关联依赖，不会发布。</p>` : ''}
    ${state.changes.length ? state.changes.map(change => `<article class="wb-card">
      <div class="wb-card-header"><label class="wb-choice"><input type="checkbox" data-select-path="${escape(change.path)}" ${selected.has(change.path) ? 'checked' : ''}/><span><strong>${escape(change.name)}</strong><span class="wb-path">${escape(change.path)}</span></span></label><span class="wb-tag">${({ added:'新增', modified:'修改', deleted:'删除' })[change.kind]}</span></div>
      ${change.path.startsWith('images/') ? `<div class="wb-image-pair" data-image-path="${escape(change.path)}"><figure><figcaption>修改前 · ${change.beforeBytes || 0} 字节</figcaption><div data-image-before>加载预览…</div></figure><figure><figcaption>现在 · ${change.afterBytes || 0} 字节</figcaption><div data-image-after>加载预览…</div></figure></div>` : ''}
      ${change.fields.length ? `<table class="wb-fields"><thead><tr><th>变化项</th><th>修改前</th><th>现在</th></tr></thead><tbody>${change.fields.map(field => `<tr><td title="${escape(field.field)}">${escape(fieldLabel(field.field))}</td><td class="wb-before"><pre class="wb-code">${escape(format(field.before))}</pre></td><td class="wb-after"><pre class="wb-code">${escape(format(field.after))}</pre></td></tr>`).join('')}</tbody></table>` : '<p class="wb-copy">文件字节发生变化。图片或无法解析的 JSON 请在对应资源工具查看。</p>'}
      ${change.fieldsTruncated ? '<div class="wb-note wb-warning">变化超过 200 项，此处仅显示前 200 项，请结合源码检查完整改动。</div>' : ''}
      ${change.affected.length ? `<details style="margin-top:12px"><summary class="wb-copy">${change.affected.length} 个内容文件提及该 ID，需要留意影响</summary><div class="wb-path">${change.affected.map(escape).join('<br/>')}</div></details>` : ''}
    </article>`).join('') : '<div class="wb-card"><h3>没有待接受的修改</h3><p class="wb-copy">让你使用的 AI 修改内容文件夹，变化会自动出现在这里。已接受版本可以在“版本与发布”中查看。</p></div>'}`
  }
  function tests() {
    return `<div class="wb-card"><h3>训练营试玩</h3><p class="wb-copy">打开已接受版本，在独立训练营窗口中自行配置场景。</p><div class="wb-actions"><button class="btn btn-primary" data-wb="training" ${busy ? 'disabled' : ''}>打开训练营</button></div><p class="wb-copy">试玩版本：${escape(state.acceptedHash.slice(0, 12))}。未接受的修改不会进入试玩；改完后接受修改，再重新打开即可。关闭窗口结束本次试玩，不影响玩家客户端。</p></div>
      <div class="wb-card"><h3>把想验证的玩法留下来</h3><p class="wb-copy">场景条件、操作和预期会随反馈交给 AI，后续无需重新描述。</p>
      <form class="wb-form" id="wb-scenario-form" style="margin-top:16px">
        <label>场景条件<textarea name="setup" required maxlength="12000" placeholder="例如：战士 40/100 血量，敌人相邻且没有护盾">${escape(scenarioDraft.setup)}</textarea></label>
        <label>操作<textarea name="action" required maxlength="12000" placeholder="例如：战士对相邻敌人执行一次普攻">${escape(scenarioDraft.action)}</textarea></label>
        <label>预期结果<textarea name="expected" required maxlength="12000" placeholder="例如：按实际伤害的 30% 恢复血量，不能超过生命上限">${escape(scenarioDraft.expected)}</textarea></label>
        <div><button class="btn btn-primary" ${busy ? 'disabled' : ''}>保存场景并加入 AI 上下文</button></div>
      </form></div>
      ${state.scenarios.map(scene => `<div class="wb-card"><div class="wb-card-header"><h3>已保存场景</h3><span class="wb-tag">未执行</span></div><p class="wb-copy">${escape(scene.setup)}\n\n操作：${escape(scene.action)}\n预期：${escape(scene.expected)}</p><div class="wb-version">${escape(scene.contentHash)} · ${date(scene.createdAt)}</div></div>`).join('')}
      <div class="wb-card"><h3>交给 AI 的反馈</h3><form class="wb-form" id="wb-feedback-form"><label>需要怎样调整<textarea name="message" required maxlength="12000" placeholder="描述不符合预期的地方。当前版本、差异、检查和已保存场景会自动附上。">${escape(feedbackDraft)}</textarea></label><div><button class="btn btn-primary" ${busy ? 'disabled' : ''}>记录反馈</button></div></form></div>
      ${state.feedback.map(item => `<div class="wb-card"><p class="wb-copy">${escape(item.message)}</p><div class="wb-version">人工反馈 · ${date(item.createdAt)} · ${escape(item.contentHash)}</div></div>`).join('')}`
  }
  function versions() {
    return `<div class="wb-card"><h3>发布测试更新</h3><p class="wb-copy">发布最近一次已接受的内容。工作区里尚未接受的改动不会被打包。</p><label class="wb-form">更新说明<textarea id="wb-release-notes" maxlength="4000" placeholder="填写这次希望玩家关注的变化">${escape(releaseDraft)}</textarea></label><div class="wb-actions"><button class="btn btn-primary" data-wb="publish" ${busy || !state.acceptedVersionId ? 'disabled' : ''}>发布测试更新</button><button class="btn btn-ghost" data-wb="export" ${busy || !state.acceptedVersionId ? 'disabled' : ''}>导出本地资源包</button><button class="btn btn-ghost" data-wb="settings" ${busy ? 'disabled' : ''}>发布设置</button></div><p class="wb-copy">本地导出不等于发布。正式分发仍需签名及兼容性校验；首次发布需配置仓库与凭据。</p></div>
      ${state.versions.map((version, index) => `<div class="wb-card"><div class="wb-card-header"><h3>${version.status === 'accepted' ? '已接受版本' : '候选快照'} ${state.versions.length - index}</h3><span class="wb-tag">本地保存 · 不代表已发布</span></div><p class="wb-copy">${date(version.createdAt)} · ${Object.keys(version.snapshot || {}).length} 个内容文件</p><div class="wb-version">${escape(version.contentHash)}</div></div>`).join('')}`
  }
  function render() {
    root.innerHTML = `<div class="wb-shell"><aside class="wb-rail"><div class="wb-kicker">HUMAN + AI</div><h2>创作任务</h2><p class="wb-copy">从一个玩法想法开始，\n把修改和验证留在一起。</p><button class="btn btn-primary wb-new" data-wb="new" ${busy ? 'disabled' : ''}>＋ 新的创作任务</button>${tasks.map(task => `<button class="wb-task ${current() === task.id ? 'active' : ''}" data-task="${task.id}" ${busy ? 'disabled' : ''}><strong>${escape(task.title)}</strong><span>${date(task.createdAt)}</span></button>`).join('')}</aside>
    <main class="wb-main"><div class="wb-status" role="status" aria-live="polite">${escape(status)}</div>${state ? `
      <div class="wb-topline"><div><div class="wb-kicker">当前创作任务</div><h2>${escape(state.task.title)}</h2></div><span class="wb-tag">${checkLabel()}</span></div>
      <p class="wb-copy">${escape(state.task.brief)}</p><details style="margin-top:12px"><summary class="wb-copy">验收条件与任务交接位置</summary><p class="wb-copy" style="margin-top:10px">${escape(state.task.criteria)}</p><div class="wb-path">${escape(state.handoffPath)}</div></details>
      <div class="wb-actions"><button class="btn btn-primary" data-wb="handoff" ${busy ? 'disabled' : ''}>复制任务入口，交给 AI</button><button class="btn btn-ghost" data-wb="refresh" ${busy ? 'disabled' : ''}>立即刷新</button><button class="btn btn-ghost" data-wb="check" ${busy ? 'disabled' : ''}>检查内容</button><span class="wb-copy">自动检测外部修改</span></div>
      <nav class="wb-sections" aria-label="任务流程">${[['changes','01 待接受修改'], ['tests','02 训练营与反馈'], ['versions','03 版本与发布']].map(([key, label]) => `<button class="wb-section ${section === key ? 'active' : ''}" data-section="${key}">${label}</button>`).join('')}</nav>
      ${section === 'changes' ? changes() : section === 'tests' ? tests() : versions()}
    ` : `<div class="wb-empty"><div class="wb-kicker">让一个想法，变成可以验证的内容</div><h2>这次想做什么？</h2><p>新增一个角色，调整一个技能，或者改进一段 PVE。建立任务后，让你现有的 AI 实现，在这里查看真实变化、整理验证场景和反馈。</p><div class="wb-flow"><div><strong>你定义玩法，AI 负责实现</strong><p class="wb-copy">需求和验收条件随任务保留，不必在聊天与文件之间反复搬运。</p></div><div><strong>以实际改动和证据判断结果</strong><p class="wb-copy">文件比较、引用检查与版本记录由程序生成，AI 的完成说明不代替验证。</p></div></div><button class="btn btn-primary" data-wb="new" ${busy ? 'disabled' : ''}>开始一个创作任务</button></div>`}</main></div>`
    root.querySelectorAll('input, textarea, select').forEach(input => { input.disabled = busy })
    void loadImages(++generation)
  }
  async function loadImages(version) {
    if (!state || !api.workbenchImage || busy) return
    const id = current(), hash = state.contentHash, acceptedHash = state.acceptedHash
    for (const pair of root.querySelectorAll('[data-image-path]')) {
      for (const side of ['before', 'after']) {
        try {
          const data = await api.workbenchImage(id, pair.dataset.imagePath, side, hash, acceptedHash)
          if (generation !== version) return
          const container = pair.querySelector('[data-image-' + side + ']')
          container.textContent = data ? '' : '无图片或超出内嵌预览范围'
          if (data) { const image = new Image(); image.src = data; image.alt = side === 'before' ? '修改前图片' : '修改后图片'; container.append(image) }
        } catch { if (generation === version) pair.querySelector('[data-image-' + side + ']').textContent = '内容已变化，请等待刷新' }
      }
    }
  }
  async function run(operation, success = '') {
    if (busy) return
    generation++
    busy = true; status = '正在处理…'; render()
    try { await operation(); if (success) status = success; else if (status === '正在处理…') status = '' }
    catch (error) { status = errorMessage(error) }
    finally { busy = false; render() }
  }
  function createDialog() {
    if (!discardDrafts()) return
    const dialog = document.createElement('dialog')
    dialog.className = 'wb-modal'
    dialog.innerHTML = `<h2>开始一个创作任务</h2><p class="wb-copy">描述你想要的玩法。创建时会保存当前内容作为比较基准。</p><form class="wb-form"><label>任务名称<input name="title" required maxlength="120" placeholder="例如：新增吸血战士"/></label><label>想要的玩法<textarea name="brief" required maxlength="12000" placeholder="描述角色定位、技能效果和需要保留的行为"></textarea></label><label>怎样算符合预期<textarea name="criteria" required maxlength="12000" placeholder="例如：普攻按实际伤害恢复生命；不能超过生命上限"></textarea></label><div class="wb-status" role="alert"></div><div class="wb-actions"><button class="btn btn-primary">建立任务</button><button class="btn btn-ghost" type="button" data-close>取消</button></div></form>`
    document.body.append(dialog)
    dialog.querySelector('[data-close]').onclick = () => dialog.close()
    dialog.addEventListener('close', () => dialog.remove())
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault()
      const form = event.currentTarget
      const input = Object.fromEntries(new FormData(form))
      form.querySelectorAll('button').forEach(button => { button.disabled = true })
      try { state = await api.workbenchCreate(input); tasks = await api.workbenchList(); feedbackDraft = ''; Object.keys(scenarioDraft).forEach(key => { scenarioDraft[key] = '' }); section = 'changes'; status = '任务已建立，修改前的内容已保存。'; dialog.close(); render() }
      catch (error) { dialog.querySelector('[role="alert"]').textContent = errorMessage(error); form.querySelectorAll('button').forEach(button => { button.disabled = false }) }
    }
    dialog.showModal()
  }
  root.addEventListener('input', event => {
    if (event.target.id === 'wb-release-notes') releaseDraft = event.target.value
    if (event.target.closest('#wb-feedback-form')) feedbackDraft = event.target.value
    if (event.target.closest('#wb-scenario-form')) scenarioDraft[event.target.name] = event.target.value
  })
  root.addEventListener('change', event => {
    if (event.target.hasAttribute('data-select-path')) {
      const file = event.target.dataset.selectPath
      if (event.target.checked) selected.add(file); else selected.delete(file)
      render()
    }
    if (event.target.hasAttribute('data-select-all')) { selected = new Set(event.target.checked ? state.changes.map(change => change.path) : []); render() }
  })
  root.addEventListener('submit', event => {
    event.preventDefault()
    const form = event.target
    const input = { ...Object.fromEntries(new FormData(form)), expectedHash: state.contentHash }
    if (form.id === 'wb-feedback-form') void run(async () => { state = await api.workbenchFeedback(current(), input); feedbackDraft = '' }, '反馈已保存，AI 上下文已更新。')
    if (form.id === 'wb-scenario-form') void run(async () => { state = await api.workbenchScenario(current(), input); Object.keys(scenarioDraft).forEach(key => { scenarioDraft[key] = '' }) }, '场景已保存，尚未执行。')
  })
  root.addEventListener('click', event => {
    const button = event.target.closest('button')
    if (!button || button.disabled || busy) return
    if (button.dataset.section) { section = button.dataset.section; render(); return }
    if (button.dataset.task) { if (!discardDrafts()) return; void run(async () => { state = await api.workbenchInspect(button.dataset.task); selected.clear(); feedbackDraft = ''; Object.keys(scenarioDraft).forEach(key => { scenarioDraft[key] = '' }) }); return }
    switch (button.dataset.wb) {
      case 'accept':
      case 'revert': {
        const action = button.dataset.wb
        if (action === 'revert' && !window.confirm(`撤销选中的 ${selected.size} 个内容文件，恢复到已接受版本？未选中的改动保留。`)) return
        const input = { paths: [...selected], expectedHash: state.contentHash, expectedAcceptedHash: state.acceptedHash }
        void run(async () => { state = await api[action === 'accept' ? 'workbenchAccept' : 'workbenchRevert'](current(), input); selected.clear() }, action === 'accept' ? '已接受选中修改并保存本地版本；没有发布。' : '选中修改已撤销，原文件保留在恢复记录中。')
        break
      }
      case 'export': void run(async () => { const result = await api.workbenchExport(current(), state.acceptedHash, releaseDraft); status = result.path }, ''); break
      case 'training': void run(async () => { status = '正在准备已接受资源并打开训练营…'; const result = await api.workbenchTraining(current(), state.acceptedHash); status = `已打开训练营 · 版本 ${result.contentHash.slice(0, 12)}。请在试玩窗口配置场景，完成后在这里记录反馈。` }, ''); break
      case 'publish': void run(() => window.openContentPublication(api, { id: current(), acceptedHash: state.acceptedHash, notes: releaseDraft.trim() || state.task.title, pendingCount: state.changes.length })); break
      case 'settings': void run(() => window.openPublicationSettings(api)); break
      case 'new': createDialog(); break
      case 'refresh': void run(async () => { state = await api.workbenchInspect(current()) }, '已读取实际内容变化。'); break
      case 'check': void run(async () => { state = await api.workbenchCheck(current()) }, '结构与引用检查完成；实战验证独立记录。'); break
      case 'handoff': void run(async () => { const result = await api.workbenchHandoff(current()); state = await api.workbenchInspect(current()); status = result.path }, '任务入口已复制。交给现有 AI 读取，最新差异与反馈已附上。'); break
      case 'keep': void run(async () => { state = await api.workbenchKeep(current(), state.contentHash) }, '候选快照已保留，没有发布。'); break
    }
  })
  render()
  document.getElementById('open-resource-publication').onclick = () => {
    document.querySelector('[data-tab="workbench"]').click()
    if (!root.classList.contains('active')) return
    section = 'versions'; render()
  }
  void run(async () => { tasks = await api.workbenchList(); if (tasks.length) state = await api.workbenchInspect(tasks[0].id) })
  async function poll() {
    if (busy || polling || !state || document.hidden || !root.classList.contains('active') || document.querySelector('dialog[open]') || hasDrafts() || root.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return
    polling = true
    const id = current(), hash = state.contentHash, acceptedHash = state.acceptedHash, observedGeneration = generation
    try {
      const next = await api.workbenchInspect(id)
      if (!busy && generation === observedGeneration && id === current() && (next.contentHash !== hash || next.acceptedHash !== acceptedHash)) {
        state = next; selected.clear(); status = '发现外部修改，差异已更新。原有检查仅适用于对应内容版本。'; render()
      }
    } catch (error) { if (!busy && id === current()) { status = errorMessage(error); const label = root.querySelector('[role="status"]'); if (label) label.textContent = status } }
    finally { polling = false }
  }
  setInterval(() => void poll(), 4000)
  window.addEventListener('focus', () => void poll())
})()
