;(function () {
  'use strict'
  var published = null
  var busy = false
  var byId = function (id) { return document.getElementById(id) }
  byId('relayUrl').value = localStorage.getItem('rvb_relay_url') || ''
  var identity = RvBIdentity.getIdentity()
  byId('hostName').value = (identity && identity.displayName || '玩家') + ' 的主机'
  function rootUrl() {
    var url = new URL(byId('relayUrl').value.trim())
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
    busy = true; byId('error').textContent = ''
    document.querySelectorAll('button').forEach(function (button) { button.disabled = true })
    try { await task() } catch (error) { byId('error').textContent = error.message || String(error) }
    finally { busy = false; document.querySelectorAll('button').forEach(function (button) { button.disabled = false }) }
  }
  function showPublication(value) {
    published = value
    byId('publication').textContent = value ? '主机已发布。进入本机大厅创建房间，朋友即可加入。' : '尚未发布或主机连接已断开'
    byId('share').textContent = value ? '邀请码：' + value.inviteCode : ''
    byId('copy').hidden = !value
  }
  async function enter(url, local) {
    var address = new URL(url)
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.hash || address.search) throw new Error('无效主机地址')
    await RvBIdentity.ensureIdentity()
    var health = await json(url + '/healthz')
    if (!health.ok || health.protocol !== 'rvb-colyseus') throw new Error('玩家主机尚未就绪')
    var remote = await RvBColyseus.requestCatalogIdentityAt(url, 'remote-server')
    var mode = window.electronAPI ? await window.electronAPI.getMode() : null
    var installed = mode ? (local ? mode.localAuthorityProfileIdentity : mode.profileIdentity) : remote.profileIdentity
    if (!installed || !remote.profileIdentity) throw new Error('资源版本不可用，请检查资源包')
    for (var key of ['schemaVersion', 'engineAbi', 'runnerRevision', 'resolvedProfileHash', 'authorityContentHash']) {
      if (installed[key] !== remote.profileIdentity[key]) throw new Error('主机和本机资源版本不同，请安装相同版本后重试')
    }
    localStorage.setItem('rvb_game_profile_identity', JSON.stringify(installed))
    localStorage.setItem('rvb_server_profile_identity', JSON.stringify(remote.profileIdentity))
    RvBUtils.saveServerConfig({ mode: local ? 'local' : 'remote', url: url })
    var params = RvBUtils.appendServerParams(new URLSearchParams())
    params.set('server', local ? 'local' : 'remote')
    location.href = 'lobby.html?' + params.toString()
  }
  byId('publish').onclick = function () { run(async function () {
    if (!window.electronAPI || !window.electronAPI.relayControl) throw new Error('发布主机需要本次 Windows 客户端')
    var ready = await window.electronAPI.ensureLocalAuthority()
    if (!ready.ok) throw new Error(ready.error)
    var result = await window.electronAPI.relayControl({ action: 'publish', relayUrl: rootUrl(), name: byId('hostName').value.trim(), visible: byId('visible').checked, publishKey: byId('publishKey').value })
    if (!result.ok) throw new Error(result.error)
    byId('publishKey').value = ''
    showPublication(result.published)
  }) }
  byId('stop').onclick = function () { run(async function () {
    if (!window.electronAPI) throw new Error('需要 Windows 客户端')
    if (published && !confirm('停止发布会断开通过公网转发加入的玩家。继续吗？')) return
    var result = await window.electronAPI.relayControl({ action: 'stop' })
    if (!result.ok) throw new Error(result.error)
    showPublication(null)
  }) }
  byId('copy').onclick = function () { run(async function () {
    if (published) await navigator.clipboard.writeText('Red VS Blue\n转发服务器：' + rootUrl() + '\n邀请码：' + published.inviteCode + '\n主机地址：' + published.url)
  }) }
  byId('localLobby').onclick = function () { run(async function () {
    if (!window.electronAPI) throw new Error('需要 Windows 客户端')
    var ready = await window.electronAPI.ensureLocalAuthority()
    if (!ready.ok) throw new Error(ready.error)
    await enter((await window.electronAPI.getMode()).localUrl, true)
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
    await enter(publishedAddress(host), false)
  }) }
  byId('joinDirect').onclick = function () { run(function () { return enter(byId('directUrl').value.trim().replace(/\/+$/, ''), false) }) }
  byId('refresh').onclick = function () { run(async function () {
    var result = await json(rootUrl() + '/hosts')
    var container = byId('hosts'); container.replaceChildren()
    if (!result.hosts.length) { container.textContent = '暂无公开主机。可以自己发布，或输入朋友的邀请码。'; return }
    result.hosts.forEach(function (host) {
      var row = document.createElement('div'); row.className = 'host'
      var label = document.createElement('span'); label.textContent = host.name + ' · ' + host.inviteCode
      var button = document.createElement('button'); button.textContent = '进入主机大厅'
      button.onclick = function () { run(function () { return enter(publishedAddress(host), false) }) }
      row.append(label, button); container.append(row)
    })
  }) }
  if (window.electronAPI && window.electronAPI.relayControl) {
    window.electronAPI.relayControl({ action: 'status' }).then(function (result) { if (result.ok) showPublication(result.published) }).catch(function (error) { byId('error').textContent = error.message })
    setInterval(function () { if (!busy) window.electronAPI.relayControl({ action: 'status' }).then(function (result) { if (result.ok) showPublication(result.published); else showPublication(null) }).catch(function () { showPublication(null) }) }, 5000)
  }
})()
