;(function () {
  'use strict'
  var dialog, body, message, trigger, generation = 0, refreshing = false
  var INTENT = 'rvb_room_invitation_intent_v1'
  function context() {
    var utils = window.RvBUtils
    if (!utils) throw new Error('账号服务尚未就绪')
    var origin = utils.normalizeOfficialOrigin(localStorage.getItem('rvb_official_url') || 'https://play.redvsblue.top')
    var session = origin && utils.readOfficialSession(origin)
    if (!session) throw new Error('请先登录在线社区')
    return { origin: origin, token: session.token, accountId: session.account.id }
  }
  function same(c) {
    try { var now = context(); return now.origin === c.origin && now.token === c.token && now.accountId === c.accountId } catch { return false }
  }
  async function api(c, path, data) {
    if (!same(c)) throw new Error('登录账号已变化，请重新打开邀请')
    var response = await fetch(c.origin + '/official/community/' + path, {
      method: data === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
    var value = await response.json()
    if (!same(c)) throw new Error('登录账号已变化，请重新打开邀请')
    if (!response.ok) throw new Error(value.error || '邀请服务暂不可用')
    return value
  }
  function element(tag, text) { var el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el }
  function button(text, fn) {
    var el = element('button', text); el.type = 'button'; el.className = 'button'
    el.onclick = async function () { el.disabled = true; try { await fn() } catch (error) { message.textContent = error.message } finally { el.disabled = false } }
    return el
  }
  function show(title) {
    if (!dialog) {
      dialog = element('dialog'); dialog.className = 'game-dialog room-invitations-dialog'; dialog.setAttribute('aria-labelledby', 'roomInvitationsTitle')
      dialog.style.cssText = 'width:min(560px,90vw);max-height:80vh;overflow:auto'
      var heading = element('h2'); heading.id = 'roomInvitationsTitle'
      var close = button('关闭', function () { dialog.close() }); close.className = 'button dialog-close'; close.setAttribute('aria-label', '关闭约局邀请')
      body = element('div'); message = element('p'); message.setAttribute('role', 'status')
      dialog.append(close, heading, body, message); document.body.append(dialog)
      dialog.addEventListener('close', function () { generation++ })
    }
    generation++; dialog.querySelector('h2').textContent = title; body.replaceChildren(); message.textContent = ''
    if (!dialog.open) dialog.showModal()
    return generation
  }
  async function inbox() {
    var ticket = show('约局邀请'), c = context()
    message.textContent = '正在查看邀请…'
    var result = await api(c, 'invitations')
    if (ticket !== generation || !same(c)) return
    message.textContent = result.invitations.length ? '接受后检查房间和资源版本，再选择阵营入座。' : '暂无邀请。好友可以在房间中邀请你。'
    result.invitations.forEach(function (invite) {
      var row = element('section'); row.style.cssText = 'padding:12px 0;border-bottom:1px dashed currentColor'
      row.append(element('p', invite.sender.name + ' 邀你入座 · ' + new Date(invite.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' 前有效'))
      row.append(button('接受邀请', async function () {
        if (!same(c)) throw new Error('登录账号已变化')
        sessionStorage.setItem(INTENT, JSON.stringify({ id: invite.id, origin: c.origin, accountId: c.accountId }))
        location.href = 'multiplayer.html?acceptedInvite=1'
      }), button('婉拒', async function () { await api(c, 'invitations/' + encodeURIComponent(invite.id) + '/decline', {}); await inbox() }))
      body.append(row)
    })
  }
  async function inviteCurrentRoom() {
    var ticket = show('邀请好友入座'), c = context()
    var params = new URLSearchParams(location.search), roomId = params.get('roomId')
    if (!roomId || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) throw new Error('请先进入等待中的房间')
    var server = window.RvBUtils.getServerUrl()
    var parsed = new URL(server), hostId
    if (parsed.origin === c.origin && /^\/hosts\/[a-f0-9]{1,128}$/.test(parsed.pathname)) hostId = parsed.pathname.split('/').pop()
    else {
      var native = window.RvBHost || window.electronAPI
      if (!native || !native.relayControl) throw new Error('请先开启房间共享；局域网房间无法发送在线邀请')
      var status = await native.relayControl({ action: 'status' })
      var published = status.ok && status.published && new URL(status.published.url)
      if (!published || published.origin !== c.origin || !/^\/hosts\/[a-f0-9]{1,128}$/.test(published.pathname)) throw new Error('请先在当前账号服务器开启房间共享')
      hostId = published.pathname.split('/').pop()
    }
    var result = await api(c, 'friends')
    if (ticket !== generation || !same(c)) return
    message.textContent = result.friends.length ? '邀请五分钟内有效；对方接受后仍须通过房间检查。' : '还没有好友，先去社区添加好友吧。'
    result.friends.forEach(function (friend) {
      var row = element('p')
      row.append(element('span', friend.name + (friend.online ? ' · 在线 ' : ' · 离线 ')), button('邀请', async function () {
        await api(c, 'invitations', { targetAccountId: friend.id, hostId: hostId, roomId: roomId })
        if (ticket === generation) message.textContent = '已向 ' + friend.name + ' 发出邀请'
      })); body.append(row)
    })
  }
  async function refresh() {
    if (refreshing || document.hidden || !trigger) return
    var c
    try { c = context() } catch { trigger.hidden = true; return }
    trigger.hidden = false; refreshing = true
    try { var result = await api(c, 'invitations'); if (same(c)) trigger.textContent = '约局邀请' + (result.invitations.length ? ' · ' + result.invitations.length : '') }
    catch { trigger.textContent = '约局邀请 · 未连接' }
    finally { refreshing = false }
  }
  window.RvBRoomInvitations = {
    open: inbox,
    inviteCurrentRoom: async function () { try { await inviteCurrentRoom() } catch (error) { if (message) message.textContent = error.message } },
    takeIntent: async function () {
      var raw = sessionStorage.getItem(INTENT); sessionStorage.removeItem(INTENT)
      if (!raw) throw new Error('邀请已失效，请从约局邀请重新接受')
      var intent = JSON.parse(raw), c = context()
      if (intent.origin !== c.origin || intent.accountId !== c.accountId || !/^[A-Za-z0-9_-]{1,128}$/.test(intent.id)) throw new Error('邀请账号已变化，请重新接受')
      var destination = await api(c, 'invitations/' + encodeURIComponent(intent.id) + '/accept', {})
      if (!/^[a-f0-9]{1,128}$/.test(destination.hostId) || !/^[A-Za-z0-9_-]{1,128}$/.test(destination.roomId)) throw new Error('邀请目的地无效')
      return { origin: c.origin, hostId: destination.hostId, roomId: destination.roomId }
    },
  }
  if (!/\/room\.html$/.test(location.pathname)) {
    var parent = document.querySelector('.header-end, .topbar-actions, .lobby-header-actions, .toolbar, .topbar, .account-panel, header.header')
    if (parent) { trigger = button('约局邀请', inbox); trigger.hidden = true; parent.append(trigger); refresh(); setInterval(refresh, 15000) }
  }
})()
