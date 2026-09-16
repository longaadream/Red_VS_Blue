;(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }
  var busy = false
  function base() {
    var url = new URL($('homeAccountServer').value.trim())
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('账号登录须使用 HTTPS，只有本机地址可使用 HTTP')
    return url.href.replace(/\/+$/, '')
  }
  function savedBase() { return localStorage.getItem('rvb_official_url') || 'https://play.redvsblue.top' }
  function refresh() {
    var saved = window.RvBUtils.readOfficialSession(savedBase())
    $('userName').textContent = saved ? saved.account.name : '登录账号'
    $('userDot').style.background = saved ? '#22c55e' : '#a58d68'
  }
  function showSession() {
    var saved = window.RvBUtils.readOfficialSession(base())
    $('homeLoginFields').hidden = !!saved
    $('homeLogout').hidden = !saved
    $('homeAccountEmail').required = !saved
    $('homeAccountPassword').required = !saved
    $('homeAccountStatus').textContent = saved ? '当前账号：' + saved.account.name : '未登录，可继续离线游玩'
  }
  async function request(origin, route, body, token) {
    var headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = 'Bearer ' + token
    var response = await fetch(origin + route, { method: 'POST', headers: headers, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(20000) })
    var result = await response.json()
    if (!response.ok) throw new Error(result.error || '请求失败')
    return result
  }
  async function run(work) {
    if (busy) return
    busy = true
    ;['homeLoginSubmit', 'homeLogout', 'homeAccountServer', 'homeAccountManage'].forEach(function (id) { $(id).disabled = true })
    try { await work() } catch (error) { $('homeAccountStatus').textContent = error.message }
    finally {
      busy = false
      ;['homeLoginSubmit', 'homeLogout', 'homeAccountServer', 'homeAccountManage'].forEach(function (id) { $(id).disabled = false })
      refresh()
    }
  }
  $('homeLoginForm').onsubmit = function (event) {
    event.preventDefault()
    void run(async function () {
      var origin = base()
      $('homeAccountStatus').textContent = '正在登录…'
      var result = await request(origin, '/official/auth/login', { email: $('homeAccountEmail').value.trim(), password: $('homeAccountPassword').value })
      if (!window.RvBUtils.saveOfficialSession({ url: origin, token: result.token, account: result.account })) throw new Error('登录状态保存失败，请检查本机存储')
      localStorage.setItem('rvb_official_url', origin)
      window.RvBUtils.saveRemoteServerUrl(origin)
      $('homeAccountPassword').value = ''
      showSession()
    })
  }
  $('homeLogout').onclick = function () {
    void run(async function () {
      var origin = base(), saved = window.RvBUtils.readOfficialSession(origin)
      try { if (saved) await request(origin, '/official/auth/logout', {}, saved.token) }
      finally { window.RvBUtils.clearOfficialSession(origin); showSession() }
    })
  }
  $('homeAccountServer').onchange = function () { try { showSession() } catch (error) { $('homeAccountStatus').textContent = error.message } }
  $('homeAccountManage').onclick = function () {
    try { localStorage.setItem('rvb_official_url', base()); window.location.href = 'official.html?account=1' }
    catch (error) { $('homeAccountStatus').textContent = error.message }
  }
  $('homeGuestSave').onclick = function () {
    try {
      var name = $('homeGuestName').value.trim()
      if (!name) throw new Error('请输入昵称')
      window.RvBIdentity.setDisplayName(name)
      $('homeAccountStatus').textContent = '离线 / LAN 昵称已保存'
    } catch (error) { $('homeAccountStatus').textContent = error.message }
  }
  $('homeAccountClose').onclick = function () { $('accountDialog').close() }
  $('accountDialog').addEventListener('close', function () { $('homeAccountPassword').value = '' })
  window.RvBHomeAccount = {
    refresh: refresh,
    open: function () {
      if (!busy) {
        $('homeAccountServer').value = savedBase()
        var guest = window.RvBIdentity.getIdentity()
        $('homeGuestName').value = guest ? guest.displayName || '玩家' : '玩家'
        try { showSession() } catch (error) { $('homeAccountStatus').textContent = error.message }
      }
      $('accountDialog').showModal()
    },
  }
  window.addEventListener('storage', refresh)
  refresh()
})()
