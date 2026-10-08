;(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var busy = false
  var autoAttempted = false
  var connected = false
  var sessionEpoch = 0
  var promptPending = false
  var suppressPrompt = false
  var connectionMessage = ''
  var activePresenceOrigin = ''
  var activePresenceToken = ''

  function node(id) { return $(id) }
  function setText(id, value) { var element = node(id); if (element) element.textContent = value }
  function renderHomeIdentity(saved, fallback) {
    var element = node('userName')
    var account = saved && saved.account
    if (element && account && account.id && window.RvBPlayerProfile && typeof window.RvBPlayerProfile.renderIdentity === 'function') {
      window.RvBPlayerProfile.renderIdentity(element, account, 'rvb-home-avatar', fallback)
    } else if (element) element.textContent = fallback || '登录账号'
  }
  function setHidden(id, value) { var element = node(id); if (element) element.hidden = value }
  function signal() { return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20000) : undefined }

  function normalizeOrigin(raw) {
    if (window.RvBUtils && typeof window.RvBUtils.normalizeOfficialOrigin === 'function') return window.RvBUtils.normalizeOfficialOrigin(raw)
    try {
      var url = new URL(String(raw || '').trim())
      var loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname || '')
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) return ''
      return url.href.replace(/\/+$/, '')
    } catch { return '' }
  }

  function base() {
    var field = node('homeAccountServer')
    var raw = field ? field.value.trim() : savedBase()
    var origin = normalizeOrigin(raw)
    if (!origin) throw new Error('账号登录须使用 HTTPS，只有本机地址可使用 HTTP')
    return origin
  }

  function savedBase() {
    var stored = localStorage.getItem('rvb_official_url')
    var saved = normalizeOrigin(stored)
    if (saved) return saved
    if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
      var local = normalizeOrigin(location.origin)
      if (local && /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(location.hostname || '')) return local
    }
    return 'https://play.redvsblue.top'
  }

  function sessionFor(origin) {
    try { return window.RvBUtils.readOfficialSession(origin) } catch { return null }
  }

  function sameSession(origin, token) {
    var saved = sessionFor(origin)
    return !!(saved && saved.token === token)
  }

  function stopHeartbeat() {
    if (window.RvBUtils && typeof window.RvBUtils.stopOfficialPresence === 'function') window.RvBUtils.stopOfficialPresence()
    activePresenceOrigin = ''
    activePresenceToken = ''
  }

  function handlePresenceStatus(event) {
    var detail = event && event.detail
    if (!detail || detail.origin !== activePresenceOrigin || detail.token !== activePresenceToken) return
    if (detail.status === 'connected') {
      connected = true
      connectionMessage = ''
      refresh()
      return
    }
    connected = false
    if (detail.status === 'unauthorized') {
      clearCurrentSession(detail.origin, detail.token)
      return
    }
    setConnectionMessage(detail.status === 'unsupported'
      ? '社区服务暂不可用；仍可离线游玩'
      : '社区连接失败；打开账号窗口可重新连接，仍可离线游玩')
  }

  function clearCurrentSession(origin, token) {
    if (!sameSession(origin, token)) return false
    window.RvBUtils.clearOfficialSession(origin)
    sessionEpoch += 1
    connected = false
    stopHeartbeat()
    connectionMessage = ''
    refresh()
    try { showSession() } catch {}
    promptPending = true
    return true
  }

  function refresh() {
    var origin = savedBase()
    var saved = sessionFor(origin)
    var name = saved && saved.account && saved.account.name ? saved.account.name : '登录账号'
    renderHomeIdentity(saved, name)
    var dot = node('userDot')
    if (dot) dot.style.background = saved ? '#22c55e' : '#a58d68'
    setText('communityStatus', saved
      ? (connected ? '社区已连接 · 好友与公告板可用' : (connectionMessage || '已登录 · 打开社区以连接'))
      : '未连接 · 可继续离线游玩')
  }

  function showSession() {
    var saved = sessionFor(base())
    setHidden('homeLoginFields', !!saved)
    setHidden('homeCommunityRetry', !saved)
    setHidden('homeLogout', !saved)
    var email = node('homeAccountEmail'), password = node('homeAccountPassword')
    if (email) email.required = !saved
    if (password) password.required = !saved
    setText('homeAccountStatus', saved
      ? '当前账号：' + ((saved.account && saved.account.name) || '服务器玩家')
      : '未登录，可继续离线游玩；登录后可使用好友和公告板')
  }

  async function request(origin, route, body, token, method) {
    var headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = 'Bearer ' + token
    var options = { method: method || (body === undefined ? 'GET' : 'POST'), headers: headers, cache: 'no-store' }
    var requestSignal = signal()
    if (requestSignal) options.signal = requestSignal
    if (body !== undefined) options.body = JSON.stringify(body)
    var response = await fetch(origin + route, options)
    var result = {}
    try { result = await response.json() } catch {}
    if (!response.ok) {
      var error = new Error(result.error || (response.status === 401 ? '登录状态已过期' : '请求失败'))
      error.status = response.status
      throw error
    }
    return result
  }

  function setConnectionMessage(message) {
    connectionMessage = message
    setText('homeAccountStatus', message)
    setText('communityStatus', message)
  }

  async function startHeartbeat(origin, token) {
    activePresenceOrigin = origin
    activePresenceToken = token
    if (window.RvBUtils && typeof window.RvBUtils.startOfficialPresence === 'function') {
      return await window.RvBUtils.startOfficialPresence(origin, token)
    }
    await request(origin, '/official/community/heartbeat', {}, token, 'POST')
    return true
  }

  async function authenticate(origin, token) {
    var epoch = sessionEpoch
    try {
      var me = await request(origin, '/official/me', undefined, token, 'GET')
      if (!sameSession(origin, token) || epoch !== sessionEpoch) return false
      var account = me && me.account
      var saved = sessionFor(origin)
      if (account && saved) window.RvBUtils.saveOfficialSession({ url: origin, token: token, account: account })
      var presence = await startHeartbeat(origin, token)
      if (!sameSession(origin, token) || epoch !== sessionEpoch) return false
      if (presence === false) {
        connected = false
        setConnectionMessage('社区连接失败；打开账号窗口可重新连接，仍可离线游玩')
        return false
      }
      connected = true
      connectionMessage = ''
      refresh()
      return true
    } catch (error) {
      if (error && error.status === 401) clearCurrentSession(origin, token)
      else if (sameSession(origin, token)) {
        connected = false
        setConnectionMessage('服务器暂时不可用；打开账号窗口可重试，仍可离线游玩')
      }
      throw error
    }
  }

  async function autoConnect() {
    if (autoAttempted) return false
    autoAttempted = true
    var origin = savedBase(), saved = sessionFor(origin)
    if (!saved) return false
    try { return await authenticate(origin, saved.token) } catch { return false }
  }

  function disableControls(disabled) {
    ;['homeLoginSubmit', 'homeLogout', 'homeCommunityRetry', 'homeAccountServer', 'homeAccountManage', 'homeGuestSave'].forEach(function (id) {
      var element = node(id); if (element) element.disabled = disabled
    })
  }

  async function run(work) {
    if (busy) return
    busy = true
    disableControls(true)
    try { await work() } catch (error) { setText('homeAccountStatus', error && error.message ? error.message : '请求失败') }
    finally {
      busy = false
      disableControls(false)
      refresh()
    }
  }

  function launchMarker() {
    try {
      if (window.electronAPI && typeof window.electronAPI.getCommunityLaunchId === 'function') {
        var nativeMarker = window.electronAPI.getCommunityLaunchId()
        if (typeof nativeMarker === 'string' && /^[a-f0-9]{32}$/.test(nativeMarker)) return nativeMarker
      }
    } catch {}
    try {
      if (window.sessionStorage) {
        var marker = window.sessionStorage.getItem('rvb_community_browser_launch')
        if (!marker) { marker = 'browser-session'; window.sessionStorage.setItem('rvb_community_browser_launch', marker) }
        return marker
      }
    } catch {}
    return 'browser-session'
  }

  function dialogOpen() {
    return !!(document.querySelector && document.querySelector('dialog[open]'))
  }

  function maybePromptLogin() {
    if (suppressPrompt) return
    if (sessionFor(savedBase())) return
    var key = 'rvb_community_prompted:' + encodeURIComponent(launchMarker())
    if (localStorage.getItem(key)) return
    if (dialogOpen()) { promptPending = true; return }
    var dialog = node('accountDialog')
    if (!dialog || typeof dialog.showModal !== 'function') return
    try {
      dialog.showModal()
      localStorage.setItem(key, 'shown')
      promptPending = false
      setText('homeAccountStatus', '登录后可使用好友和公告板；也可以关闭窗口继续离线游玩')
    } catch {}
  }

  function schedulePrompt() {
    var waitingForUpdate = false
    var updateObserver = null
    function stopUpdateObserver() {
      if (updateObserver && typeof updateObserver.disconnect === 'function') updateObserver.disconnect()
      updateObserver = null
    }
    function watchForUpdateDialog() {
      if (typeof MutationObserver !== 'function' || !document.body) return
      updateObserver = new MutationObserver(function () {
        if (dialogOpen()) promptPending = true
      })
      updateObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
    }
    var callback = function () {
      if (!promptPending && dialogOpen()) { promptPending = true; return }
      if (waitingForUpdate) return
      if (promptPending || !dialogOpen()) maybePromptLogin()
    }
    if (document.addEventListener) document.addEventListener('close', function () {
      if (waitingForUpdate && !dialogOpen()) {
        waitingForUpdate = false
        stopUpdateObserver()
      }
      if (typeof setTimeout === 'function') setTimeout(callback, 0)
      else callback()
    }, true)
    var updateApi = window.electronAPI && typeof window.electronAPI.getOfficialUpdateStatus === 'function'
    if (updateApi) {
      Promise.resolve().then(function () { return window.electronAPI.getOfficialUpdateStatus() }).catch(function () { return null }).then(function (status) {
        waitingForUpdate = !!(status && status.startupPending === true)
        if (waitingForUpdate && !dialogOpen()) watchForUpdateDialog()
        else if (dialogOpen()) promptPending = true
        else waitingForUpdate = false
        if (typeof setTimeout === 'function') setTimeout(callback, 0)
        else callback()
      })
    } else if (typeof setTimeout === 'function') setTimeout(callback, 0)
    else callback()
  }

  node('homeLoginForm').onsubmit = function (event) {
    event.preventDefault()
    void run(async function () {
      var origin = base()
      var operationEpoch = ++sessionEpoch
      setText('homeAccountStatus', '正在登录…')
      var result = await request(origin, '/official/auth/login', { email: node('homeAccountEmail').value.trim(), password: node('homeAccountPassword').value })
      if (sessionEpoch !== operationEpoch) return
      if (!window.RvBUtils.saveOfficialSession({ url: origin, token: result.token, account: result.account })) throw new Error('登录状态保存失败，请检查本机存储')
      localStorage.setItem('rvb_official_url', origin)
      window.RvBUtils.saveRemoteServerUrl(origin)
      node('homeAccountPassword').value = ''
      try { await authenticate(origin, result.token) } catch {}
      showSession()
      if (sessionEpoch === operationEpoch) setText('homeAccountStatus', connected ? '登录成功，社区已连接' : '登录成功；服务器暂时不可用，可稍后重试')
    })
  }

  node('homeLogout').onclick = function () {
    void run(async function () {
      var origin = base(), saved = sessionFor(origin), token = saved && saved.token
      sessionEpoch += 1
      stopHeartbeat()
      try { if (token) await request(origin, '/official/auth/logout', {}, token, 'POST') }
      finally {
        if (token) clearCurrentSession(origin, token)
        else { connected = false; window.RvBUtils.clearOfficialSession(origin); showSession() }
      }
      var current = sessionFor(origin)
      if (!current || !token || current.token === token) setText('homeAccountStatus', '已退出，可继续离线游玩')
    })
  }

  node('homeCommunityRetry').onclick = function () {
    void run(async function () {
      var origin = base(), saved = sessionFor(origin)
      if (!saved) { showSession(); return }
      var operationEpoch = ++sessionEpoch
      stopHeartbeat()
      localStorage.setItem('rvb_official_url', origin)
      if (window.RvBUtils.saveRemoteServerUrl) window.RvBUtils.saveRemoteServerUrl(origin)
      connected = false
      setConnectionMessage('正在连接社区…')
      try {
        var result = await authenticate(origin, saved.token)
        if (sessionEpoch === operationEpoch) setText('homeAccountStatus', result ? '社区已连接' : '社区连接失败；仍可离线游玩')
      } catch {}
    })
  }

  node('homeAccountServer').onchange = function () {
    try {
      var selected = base()
      if (selected !== normalizeOrigin(localStorage.getItem('rvb_official_url') || '')) stopHeartbeat()
      showSession()
    } catch (error) { setText('homeAccountStatus', error.message) }
  }
  node('homeAccountManage').onclick = function () {
    try { localStorage.setItem('rvb_official_url', base()); window.location.href = 'official.html?account=1' }
    catch (error) { setText('homeAccountStatus', error.message) }
  }
  node('homeGuestSave').onclick = function () {
    try {
      var name = node('homeGuestName').value.trim()
      if (!name) throw new Error('请输入昵称')
      window.RvBIdentity.setDisplayName(name)
      setText('homeAccountStatus', '离线 / LAN 昵称已保存')
    } catch (error) { setText('homeAccountStatus', error.message) }
  }
  node('homeAccountClose').onclick = function () { node('accountDialog').close() }
  node('accountDialog').addEventListener('close', function () { if (node('homeAccountPassword')) node('homeAccountPassword').value = '' })
  window.RvBHomeAccount = {
    refresh: refresh,
    autoConnect: autoConnect,
    open: function () {
      suppressPrompt = true
      if (!busy) {
        node('homeAccountServer').value = savedBase()
        var guest = window.RvBIdentity.getIdentity()
        node('homeGuestName').value = guest ? guest.displayName || '玩家' : '玩家'
        try { showSession() } catch (error) { setText('homeAccountStatus', error.message) }
      }
      node('accountDialog').showModal()
    },
  }
  window.addEventListener('storage', refresh)
  window.addEventListener('rvb-official-presence', handlePresenceStatus)
  refresh()
  void autoConnect()
  schedulePrompt()
})()
