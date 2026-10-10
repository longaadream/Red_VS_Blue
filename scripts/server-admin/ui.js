(() => {
  const embedded = Boolean(document.getElementById('remote-ops'))
  const ids = embedded
    ? { section: 'remote-ops', notice: 'ops-notice', state: 'ops-state', toolVersion: 'ops-tool-version', toolConnection: null, footer: null, output: 'ops-output', logTime: 'ops-log-time', maintenance: 'ops-maintenance', panelToken: 'ops-panelToken' }
    : { section: null, notice: 'notice', state: 'state', toolVersion: 'tool-version', toolConnection: 'tool-connection', footer: 'footer-service', output: 'output', logTime: 'log-time', maintenance: 'maintenance', panelToken: 'panelToken' }
  const sessionToken = location.hash.slice(1) || sessionStorage.getItem('rvb-admin-session') || ''
  if (sessionToken) sessionStorage.setItem('rvb-admin-session', sessionToken)
  history.replaceState(null, '', location.pathname)

  const $ = id => document.getElementById(id)
  const fieldId = name => embedded ? `ops-${name}` : name
  const fields = ['host', 'port', 'user', 'key', 'service', 'database', 'directory', 'release', 'panelPort', 'panelToken']
  const persistedFields = ['host', 'port', 'user', 'key', 'service', 'database']
  const settingsKey = 'rvb-server-admin.connection.v1'
  const output = $(ids.output)
  let busy = false

  if (!embedded && sessionToken && $('panel-link')) $('panel-link').href = '/#' + sessionToken

  function setState(text, type = '') {
    const element = $(ids.state)
    if (element) {
      if (embedded) element.textContent = text
      else if (element.lastChild) element.lastChild.textContent = text
      else element.textContent = text
      element.dataset.state = type
    }
    if ($(ids.toolConnection)) $(ids.toolConnection).textContent = type === 'ready' ? '远程连接已建立' : type === 'error' ? '连接需要检查' : '本机工具在线'
    if ($(ids.footer)) $(ids.footer).textContent = type === 'ready' ? '远程服务已连接' : '等待连接'
  }

  function notice(text = '') { const element = $(ids.notice); if (element) element.textContent = text }

  function clearStaleConnectionNotice() {
    const stale = /尚未连接服务器|连接或读取失败|连接失败|缺少本机管理会话|管理会话失效/
    const elements = [$(ids.notice), document.getElementById('notice')]
    for (const element of elements) if (element && stale.test(element.textContent || '')) element.textContent = ''
  }

  function markRemoteBusy(active) {
    if (document.documentElement?.dataset) document.documentElement.dataset.remoteOpsBusy = active ? 'true' : 'false'
  }

  function selectOpsView(view) {
    if (embedded) {
      document.querySelectorAll('main section').forEach(section => { section.hidden = section.id !== view })
      document.querySelectorAll('[data-view]').forEach(button => {
        if (button.dataset.view === view) button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
      })
      if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    document.querySelectorAll('[data-ops-section]').forEach(section => { section.hidden = section.dataset.opsSection !== view })
    document.querySelectorAll('[data-ops-view]').forEach(button => {
      if (button.dataset.opsView === view) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function readForm() {
    const input = Object.fromEntries(fields.map(name => [name, $(fieldId(name))?.value.trim() || '']))
    input.action = ''
    input.maintenance = Boolean($(ids.maintenance)?.checked)
    return input
  }

  function saveLocalConnection(input) {
    try {
      const safe = Object.fromEntries(persistedFields.map(name => [name, String(input[name] || '')]))
      localStorage.setItem(settingsKey, JSON.stringify(safe))
    } catch { /* Private browsing and storage quotas must not block a connection. */ }
  }

  function restoreLocalConnection() {
    try {
      const stored = JSON.parse(localStorage.getItem(settingsKey) || '{}')
      persistedFields.forEach(name => { const element = $(fieldId(name)); if (element && typeof stored[name] === 'string' && stored[name]) element.value = stored[name] })
    } catch { /* Ignore a stale or unavailable local setting. */ }
  }

  async function request(url, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${sessionToken}` }
    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } })
    const text = await response.text()
    let result
    try { result = JSON.parse(text) } catch { result = { output: text } }
    if (!response.ok) throw Error(result.error || result.output || '请求未完成')
    return result
  }

  async function loadLocalStatus() {
    if (!sessionToken) {
      setState('缺少管理会话', 'error')
      notice('请运行管理工具输出的完整链接打开面板。')
      return
    }
    try {
      const result = await request('/api/local-status')
      if ($(ids.toolVersion)) $(ids.toolVersion).textContent = '工具版本 ' + (result.toolVersion || '未知')
      if (result.connection) {
        persistedFields.forEach(name => { const element = $(fieldId(name)); if (element && typeof result.connection[name] === 'string' && result.connection[name]) element.value = result.connection[name] })
        saveLocalConnection(result.connection)
      }
      clearStaleConnectionNotice()
      setState(result.connected ? '远程连接已建立' : '尚未连接', result.connected ? 'ready' : '')
      if (!result.connected) {
        const connection = document.getElementById('connection')
        if (connection && !document.documentElement?.dataset?.remoteOpsBusy) connection.textContent = '尚未连接本机服务器 · 请先连接指挥台'
      }
      if (embedded && !result.connected) selectOpsView('remote-ops')
    } catch (error) {
      if ($(ids.toolVersion)) $(ids.toolVersion).textContent = '工具版本不可用'
      setState('本机工具在线', '')
      if (error.message && !/403|Forbidden/i.test(error.message)) notice(error.message)
    }
  }

  function operationLabel(button) { return button.textContent.trim() || '操作' }

  async function run(button) {
    if (busy) return
    const input = readForm()
    input.action = button.dataset[embedded ? 'opsAction' : 'action']
    if (input.action === 'activate' && !input.maintenance) {
      notice('启用或回退前请确认现有对局已结束，并勾选维护确认。')
      if (!embedded) selectOpsView('deploy')
      $(ids.maintenance)?.focus()
      return
    }
    if (input.action === 'activate' && !window.confirm(`将停止 ${input.service} 并切换到 ${input.release || '所填版本'}。确认执行？`)) return

    saveLocalConnection(input)
    busy = true
    markRemoteBusy(true)
    document.querySelectorAll('button').forEach(element => { element.disabled = true })
    setState('正在执行…')
    const started = new Date()
    if ($(ids.logTime)) $(ids.logTime).textContent = started.toLocaleTimeString('zh-CN')
    if (output) output.textContent = `${started.toLocaleTimeString('zh-CN')} · ${operationLabel(button)}\n正在连接服务器…`
    notice('正在执行，请稍候…')
    try {
      const result = await request('/api', { method: 'POST', body: JSON.stringify(input) })
      if (output) output.textContent = result.output || JSON.stringify(result, null, 2)
      setState('操作完成', 'ready')
      notice('操作完成。')
      if (input.action === 'connect-panel') {
        const panelTokenElement = $(fieldId('panelToken')); if (panelTokenElement) panelTokenElement.value = ''
        if (embedded) selectOpsView('overview')
        // This standalone Node-served tool has no Next.js client router.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        else window.location.assign('/#' + sessionToken)
        return
      }
      selectOpsView(embedded ? 'remote-ops' : 'activity')
    } catch (error) {
      if (output) output.textContent = error.message || '操作未完成'
      setState('未完成', 'error')
      notice(error.message || '操作未完成，请检查 SSH、服务器日志和网络状态。')
      selectOpsView(embedded ? 'remote-ops' : 'activity')
    } finally {
      busy = false
      markRemoteBusy(false)
      document.querySelectorAll('button').forEach(element => { element.disabled = false })
    }
  }

  const actionSelector = embedded ? '[data-ops-action]' : '[data-action]'
  const viewSelector = embedded ? '[data-view="remote-ops"]' : '[data-ops-view]'
  document.querySelectorAll(viewSelector).forEach(button => { button.addEventListener('click', () => { if (!embedded) selectOpsView(button.dataset.opsView) }) })
  document.querySelectorAll(actionSelector).forEach(button => { button.addEventListener('click', () => { void run(button) }) })
  restoreLocalConnection()
  void loadLocalStatus()
})()
