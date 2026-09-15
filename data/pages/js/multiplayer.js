;(function () {
  'use strict'
  var published = null
  var busy = false
  var lastDiagnosis = ''
  var lastFailure = ''
  var officialUrl = 'https://play.redvsblue.top'
  var candidate = { version: '0.1.0', relayUrl: officialUrl }
  fetch('config/multiplayer.json').then(function (response) { return response.json() }).then(function (value) { candidate = value; if (!byId('relayUrl').value && value.relayUrl) byId('relayUrl').value = value.relayUrl }).catch(function () {})
  var byId = function (id) { return document.getElementById(id) }
  byId('relayUrl').value = localStorage.getItem('rvb_relay_url') || ''
  var identity = RvBIdentity.getIdentity()
  byId('hostName').value = (identity && identity.displayName || '玩家') + ' 的主机'
  byId('serverKind').onchange = function () { byId('relayUrl').hidden = byId('serverKind').value === 'official'; byId('customSettings').hidden = byId('serverKind').value === 'official' }
  function rootUrl() {
    var url = new URL(byId('serverKind').value === 'official' ? officialUrl : byId('relayUrl').value.trim())
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || !/^https?:$/.test(url.protocol)) throw new Error('请输入转发服务器根地址')
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('公网转发地址需要 HTTPS')
    localStorage.setItem('rvb_relay_url', url.origin)
    return url.origin
  }
  async function json(url) {
    var response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(response.status === 404 ? '主机不存在或已离线' : '服务器请求失败：' + response.status)
    return response.json()
  }
  async function run(task) {
    if (busy) return
    busy = true; byId('error').textContent = ''; document.querySelectorAll('.modalError').forEach(function (el) { el.textContent = '' })
    var controls = Array.from(document.querySelectorAll('button, select, input')).map(function (control) { return { control: control, disabled: control.disabled } })
    controls.forEach(function (item) { item.control.disabled = true })
    try { await task() } catch (error) { lastFailure = error.message || String(error); byId('error').textContent = lastFailure; document.querySelectorAll('.modalError').forEach(function (el) { el.textContent = lastFailure }) }
    finally { busy = false; controls.forEach(function (item) { item.control.disabled = item.disabled }) }
  }
  function showPublication(value) {
    published = value
    byId('publicationControls').hidden = !value
    byId('publication').textContent = value ? '房间共享已开启' : ''
    byId('share').textContent = value ? '邀请码：' + value.inviteCode : ''
    byId('copy').hidden = !value
  }
  async function enter(url, local, mode, roomId) {
    var address = new URL(url)
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.hash || address.search) throw new Error('无效主机地址')
    await RvBIdentity.ensureIdentity()
    var health = await json(url + '/healthz')
    if (!health.ok || health.protocol !== 'rvb-colyseus') throw new Error('玩家主机尚未就绪')
    var remote = await RvBColyseus.requestCatalogIdentityAt(url, 'remote-server')
    var hostMode = (window.RvBHost || window.electronAPI) ? await (window.RvBHost || window.electronAPI).getMode() : null
    var installed = hostMode ? (local ? hostMode.localAuthorityProfileIdentity : hostMode.profileIdentity) : remote.profileIdentity
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
      var localProfile = await fetch('__tutorial-profile.json', { cache: 'no-store' })
      if (!localProfile.ok) throw new Error('本地资源不可用，请恢复内置资源或安装兼容资源包')
      installed = await localProfile.json()
    }
    if (!installed || !remote.profileIdentity) throw new Error('资源版本不可用，请检查资源包')
    for (var key of ['schemaVersion', 'engineAbi', 'runnerRevision', 'resolvedProfileHash', 'authorityContentHash']) {
      if (installed[key] !== remote.profileIdentity[key]) throw new Error('主机和本机资源版本不同，请安装相同版本后重试')
    }
    localStorage.setItem('rvb_game_profile_identity', JSON.stringify(installed))
    localStorage.setItem('rvb_server_profile_identity', JSON.stringify(remote.profileIdentity))
    RvBUtils.saveServerConfig({ mode: local ? 'local' : 'remote', url: url })
    var params = RvBUtils.appendServerParams(new URLSearchParams())
    params.set('server', local ? 'local' : 'remote')
    params.set('lobbyContext', 'public')
    // Static Electron HTML pages are not Next.js routes.
    if (mode === 'pve') {
      params = new URLSearchParams({ server: url })
      if (roomId) params.set('joinRoom', roomId)
      location.href = 'adventure.html?' + params.toString()
    } else {
      if (roomId) params.set('joinRoom', roomId)
      else if (local) params.set('create', '1')
      location.href = 'lobby.html?' + params.toString()
    }
  }
  byId('publish').onclick = function () { run(async function () {
    if (!(window.RvBHost || window.electronAPI) || !(window.RvBHost || window.electronAPI).relayControl) throw new Error('发布主机需要支持开房的安卓或 Windows 客户端')
    var ready = await (window.RvBHost || window.electronAPI).ensureLocalAuthority()
    if (!ready.ok) throw new Error(ready.error)
    var result = await (window.RvBHost || window.electronAPI).relayControl({ action: 'publish', relayUrl: rootUrl(), name: byId('hostName').value.trim(), visible: byId('visible').checked, publishKey: byId('serverKind').value === 'custom' ? byId('publishKey').value : '' })
    if (!result.ok) throw new Error(result.error)
    byId('publishKey').value = ''
    showPublication(result.published)
    await enter((await (window.RvBHost || window.electronAPI).getMode()).localUrl, true, byId('gameMode').value)
  }) }
  byId('stop').onclick = function () { run(async function () {
    if (!(window.RvBHost || window.electronAPI)) throw new Error('需要支持开房的安卓或 Windows 客户端')
    if (published && !confirm('停止发布会断开通过公网转发加入的玩家。继续吗？')) return
    var result = await (window.RvBHost || window.electronAPI).relayControl({ action: 'stop' })
    if (!result.ok) throw new Error(result.error)
    showPublication(null)
  }) }
  byId('copy').onclick = function () { run(async function () {
    if (published) await navigator.clipboard.writeText('Red VS Blue\n转发服务器：' + rootUrl() + '\n邀请码：' + published.inviteCode + '\n主机地址：' + published.url)
  }) }
  function publishedAddress(host) {
    var address = new URL(host.url)
    if (address.origin !== rootUrl() || !/^\/hosts\/[a-f0-9]+$/.test(address.pathname)) throw new Error('转发服务器返回了无效主机地址')
    return address.href
  }
  byId('joinInvite').onclick = function () { run(async function () {
    var code = byId('invite').value.trim().toUpperCase()
    if (!/^[A-F0-9]{8}$/.test(code)) throw new Error('请输入完整的 8 位邀请码')
    var host = await json(rootUrl() + '/invites/' + code)
    await enter(publishedAddress(host), false, byId('inviteMode').value)
  }) }
  byId('refresh').onclick = function () { run(async function () {
    var result = await json(rootUrl() + '/hosts')
    var container = byId('hosts'); container.replaceChildren()
    if (!result.hosts.length) { container.textContent = '还没有公开房间。创建一个邀请朋友吧。'; return }
    for (var host of result.hosts) {
      var address = publishedAddress(host)
      try {
        var catalogs = await Promise.all([json(address + '/rooms'), json(address + '/rooms?mode=pve')])
        for (var entry of catalogs.flatMap(function (catalog, index) { return (catalog.rooms || []).map(function (room) { return { room: room, mode: index ? 'pve' : 'pvp' } }) })) {
          var room = entry.room
          var roomMode = entry.mode === 'pve' ? 'pve' : room.mode || (room.maxPlayers === 4 ? '2v2' : '1v1')
          var filter = byId('publicModeFilter').value || 'all'
          if (filter !== 'all' && filter !== roomMode) continue
          var row = document.createElement('div'); row.className = 'host'
          var label = document.createElement('span'); label.textContent = (room.name || host.name) + ' · ' + (entry.mode === 'pve' ? 'PVE' : room.mode || 'PVP') + ' · ' + (Array.isArray(room.players) ? room.players.length : room.players || 0) + '/' + (room.maxPlayers || (room.mode === '2v2' || entry.mode === 'pve' ? 4 : 2))
          var button = document.createElement('button'); button.textContent = '加入房间'
          button.disabled = room.joinable === false || (entry.mode === 'pvp' && (room.status === 'playing' || room.status === 'ended' || (Array.isArray(room.players) ? room.players.length : room.players || 0) >= (room.maxPlayers || 2)))
          button.onclick = (function (url, mode, id) { return function () { run(function () { return enter(url, false, mode, id) }) } })(address, entry.mode, room.id || room.roomId)
          row.append(label, button); container.append(row)
        }
      } catch { var unavailable = document.createElement('p'); unavailable.textContent = host.name + ' · 暂时无法连接'; container.append(unavailable) }
    }
    if (!container.children.length) container.textContent = '还没有公开房间，创建一个邀请朋友吧。'

  }) }
  byId('publicModeFilter').onchange = function () { byId('refresh').onclick() }
  byId('diagnose').onclick = function () { run(async function () {
    var report = { format: 'rvb-network-diagnostic-v1', at: new Date().toISOString(), version: candidate.version, candidate: candidate.candidateId || 'development', lastError: lastFailure, checks: [] }
    if ((window.RvBHost || window.electronAPI)) {
      var mode = await (window.RvBHost || window.electronAPI).getMode()
      report.localAuthority = { ready: mode.ready, recovery: mode.localAuthorityRecovery, profileIdentity: mode.localAuthorityProfileIdentity }
    }
    var addresses = [rootUrl()]
    for (var address of addresses) {
      var started = Date.now()
      var safeAddress = '(无效地址，已省略)'
      try {
        var parsed = new URL(address)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('地址不能包含账号、密码或查询参数')
        safeAddress = parsed.origin + parsed.pathname.replace(/\/+$/, '')
        var health = await json(safeAddress + '/healthz')
        report.checks.push({ address: safeAddress, ok: health.ok === true, protocol: health.protocol, elapsedMs: Date.now() - started })
      } catch (error) { report.checks.push({ address: safeAddress, ok: false, elapsedMs: Date.now() - started, error: error.message }) }
    }
    lastDiagnosis = JSON.stringify(report, null, 2)
    byId('diagnosis').textContent = lastDiagnosis
    byId('copyDiagnosis').hidden = false
  }) }
  byId('copyDiagnosis').onclick = function () { run(function () { return navigator.clipboard.writeText(lastDiagnosis) }) }
  if ((window.RvBHost || window.electronAPI) && (window.RvBHost || window.electronAPI).relayControl) {
    (window.RvBHost || window.electronAPI).relayControl({ action: 'status' }).then(function (result) { if (result.ok) showPublication(result.published) }).catch(function (error) { byId('error').textContent = error.message })
    setInterval(function () { if (!busy) (window.RvBHost || window.electronAPI).relayControl({ action: 'status' }).then(function (result) { if (result.ok) showPublication(result.published); else showPublication(null) }).catch(function () { showPublication(null) }) }, 5000)
  }
})()
