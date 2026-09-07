/* Task-centred UI. All comparisons and reports come from the trusted main process. */
(() => {
  const api = window.editorAPI
  const root = document.getElementById('tab-workbench')
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character])
  const date = value => new Date(value).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
  const format = value => value === null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  const fieldLabel = field => ({ name:'名称', description:'描述', 'stats.maxHp':'最大生命', 'stats.attack':'攻击力', 'stats.defense':'防御力', 'stats.moveRange':'移动范围', skills:'关联技能', rules:'关联规则', keywords:'机制关键词', effectTags:'效果分类', code:'技能逻辑', previewCode:'预览逻辑' })[field] || field
  let tasks = [], state = null, section = 'changes', busy = false, status = '', feedbackDraft = ''
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
      <div class="wb-metric"><strong>${state.versions.length}</strong><span>保留的候选快照</span></div>
    </div>${issues()}
    ${state.changes.length ? state.changes.map(change => `<article class="wb-card">
      <div class="wb-card-header"><div><h3>${escape(change.name)}</h3><div class="wb-path">${escape(change.path)}</div></div><span class="wb-tag">${({ added:'新增', modified:'修改', deleted:'删除' })[change.kind]}</span></div>
      ${change.fields.length ? `<table class="wb-fields"><thead><tr><th>变化项</th><th>修改前</th><th>现在</th></tr></thead><tbody>${change.fields.map(field => `<tr><td title="${escape(field.field)}">${escape(fieldLabel(field.field))}</td><td class="wb-before"><pre class="wb-code">${escape(format(field.before))}</pre></td><td class="wb-after"><pre class="wb-code">${escape(format(field.after))}</pre></td></tr>`).join('')}</tbody></table>` : '<p class="wb-copy">文件字节发生变化。图片或无法解析的 JSON 请在对应资源工具查看。</p>'}
      ${change.fieldsTruncated ? '<div class="wb-note wb-warning">变化超过 200 项，此处仅显示前 200 项，请结合源码检查完整改动。</div>' : ''}
      ${change.affected.length ? `<details style="margin-top:12px"><summary class="wb-copy">${change.affected.length} 个内容文件提及该 ID，需要留意影响</summary><div class="wb-path">${change.affected.map(escape).join('<br/>')}</div></details>` : ''}
    </article>`).join('') : '<div class="wb-card"><h3>先把需求交给 AI</h3><p class="wb-copy">任务已保留修改前的基准。AI 改完内容后，点击“接收 AI 改动”，这里会显示实际差异。</p></div>'}`
  }
  function tests() {
    return `<div class="wb-note wb-warning"><strong>实战试验场尚未接通</strong><br/>目前可以保存复现场景并交给 AI，但不会执行外部技能代码，也不会生成“实战通过”记录。结构检查不代表玩法验证。</div>
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
    return `<div class="wb-card"><h3>保留当前候选</h3><p class="wb-copy">保存完整内容快照和对应检查结果，之后的 AI 修改不会改变这份快照。当前尚未完成实战验证，保存不会发布，也不会更新玩家客户端。</p><div class="wb-actions"><button class="btn btn-primary" data-wb="keep" ${busy || !state.check || state.check.issues.some(issue => issue.severity === 'error') ? 'disabled' : ''}>保留候选快照</button></div></div>
      ${state.versions.map((version, index) => `<div class="wb-card"><div class="wb-card-header"><h3>候选 ${state.versions.length - index}</h3><span class="wb-tag">未发布 · 未实战验证</span></div><p class="wb-copy">${date(version.createdAt)} · ${Object.keys(version.snapshot || {}).length} 个内容文件</p><div class="wb-version">${escape(version.contentHash)}</div></div>`).join('')}`
  }
  function render() {
    root.innerHTML = `<div class="wb-shell"><aside class="wb-rail"><div class="wb-kicker">HUMAN + AI</div><h2>创作任务</h2><p class="wb-copy">从一个玩法想法开始，\n把修改和验证留在一起。</p><button class="btn btn-primary wb-new" data-wb="new" ${busy ? 'disabled' : ''}>＋ 新的创作任务</button>${tasks.map(task => `<button class="wb-task ${current() === task.id ? 'active' : ''}" data-task="${task.id}" ${busy ? 'disabled' : ''}><strong>${escape(task.title)}</strong><span>${date(task.createdAt)}</span></button>`).join('')}</aside>
    <main class="wb-main"><div class="wb-status" role="status" aria-live="polite">${escape(status)}</div>${state ? `
      <div class="wb-topline"><div><div class="wb-kicker">当前创作任务</div><h2>${escape(state.task.title)}</h2></div><span class="wb-tag">${checkLabel()}</span></div>
      <p class="wb-copy">${escape(state.task.brief)}</p><details style="margin-top:12px"><summary class="wb-copy">验收条件与任务交接位置</summary><p class="wb-copy" style="margin-top:10px">${escape(state.task.criteria)}</p><div class="wb-path">${escape(state.handoffPath)}</div></details>
      <div class="wb-actions"><button class="btn btn-primary" data-wb="handoff" ${busy ? 'disabled' : ''}>复制任务入口，交给 AI</button><button class="btn btn-ghost" data-wb="refresh" ${busy ? 'disabled' : ''}>接收 AI 改动</button><button class="btn btn-ghost" data-wb="check" ${busy ? 'disabled' : ''}>检查内容</button></div>
      <nav class="wb-sections" aria-label="任务流程">${[['changes','01 看懂变化'], ['tests','02 场景与反馈'], ['versions','03 保留版本']].map(([key, label]) => `<button class="wb-section ${section === key ? 'active' : ''}" data-section="${key}">${label}</button>`).join('')}</nav>
      ${section === 'changes' ? changes() : section === 'tests' ? tests() : versions()}
    ` : `<div class="wb-empty"><div class="wb-kicker">让一个想法，变成可以验证的内容</div><h2>这次想做什么？</h2><p>新增一个角色，调整一个技能，或者改进一段 PVE。建立任务后，让你现有的 AI 实现，在这里查看真实变化、整理验证场景和反馈。</p><div class="wb-flow"><div><strong>你定义玩法，AI 负责实现</strong><p class="wb-copy">需求和验收条件随任务保留，不必在聊天与文件之间反复搬运。</p></div><div><strong>以实际改动和证据判断结果</strong><p class="wb-copy">文件比较、引用检查与版本记录由程序生成，AI 的完成说明不代替验证。</p></div></div><button class="btn btn-primary" data-wb="new" ${busy ? 'disabled' : ''}>开始一个创作任务</button></div>`}</main></div>`
    root.querySelectorAll('input, textarea, select').forEach(input => { input.disabled = busy })
  }
  async function run(operation, success = '') {
    if (busy) return
    busy = true; status = '正在处理…'; render()
    try { await operation(); status = success }
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
    if (event.target.closest('#wb-feedback-form')) feedbackDraft = event.target.value
    if (event.target.closest('#wb-scenario-form')) scenarioDraft[event.target.name] = event.target.value
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
    if (button.dataset.task) { if (!discardDrafts()) return; void run(async () => { state = await api.workbenchInspect(button.dataset.task); feedbackDraft = ''; Object.keys(scenarioDraft).forEach(key => { scenarioDraft[key] = '' }) }); return }
    switch (button.dataset.wb) {
      case 'new': createDialog(); break
      case 'refresh': void run(async () => { state = await api.workbenchInspect(current()) }, '已读取实际内容变化。'); break
      case 'check': void run(async () => { state = await api.workbenchCheck(current()) }, '结构与引用检查完成；实战验证独立记录。'); break
      case 'handoff': void run(async () => { const result = await api.workbenchHandoff(current()); state = await api.workbenchInspect(current()); status = result.path }, '任务入口已复制。交给现有 AI 读取，最新差异与反馈已附上。'); break
      case 'keep': void run(async () => { state = await api.workbenchKeep(current(), state.contentHash) }, '候选快照已保留，没有发布。'); break
    }
  })
  render()
  void run(async () => { tasks = await api.workbenchList(); if (tasks.length) state = await api.workbenchInspect(tasks[0].id) })
})()
