;(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var ROOT = '/official/community'
  var state = {
    origin: '', token: '', account: null, connected: false, epoch: 0,
    friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
    search: [], announcement: null, posts: [], boardCursor: null, boardRequestId: 0,
    replies: Object.create(null), replyDrafts: Object.create(null), postRequest: false,
  }
  var busy = Object.create(null)

  function node(id) { return $(id) }
  function setText(id, value) { var element = node(id); if (element) element.textContent = value == null ? '' : String(value) }
  function clear(element) {
    if (!element) return
    if (typeof element.replaceChildren === 'function') element.replaceChildren()
    else while (element.firstChild) element.removeChild(element.firstChild)
  }
  function make(tag, className, value) {
    var element = document.createElement(tag)
    if (className) element.className = className
    if (value !== undefined) element.textContent = value
    return element
  }
  function addButton(parent, label, handler, className) {
    var button = make('button', 'button' + (className ? ' ' + className : ''), label)
    button.type = 'button'
    button.addEventListener('click', handler)
    parent.appendChild(button)
    return button
  }
  function signal() { return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20000) : undefined }
  function currentSession(origin) {
    try { return window.RvBUtils.readOfficialSession(origin) } catch { return null }
  }
  function sameSession(origin, token) {
    var session = currentSession(origin)
    return !!(session && session.token === token)
  }
  function localServerOrigin() {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname || '') ? location.origin : ''
  }
  function savedOrigin() {
    try { return normalizeOrigin(localStorage.getItem('rvb_official_url') || '') || localServerOrigin() || 'https://play.redvsblue.top' }
    catch { return localServerOrigin() || 'https://play.redvsblue.top' }
  }
  function normalizeOrigin(raw) {
    var value = String(raw || '').trim()
    if (!value) return ''
    var url = new URL(value)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('账号登录须使用 HTTPS，只有本机地址可使用 HTTP')
    return url.href.replace(/\/+$/, '')
  }
  function snapshot() { return { origin: state.origin, token: state.token, epoch: state.epoch } }
  function currentSnapshot(snap) { return !!(snap && snap.epoch === state.epoch && snap.origin === state.origin && snap.token && sameSession(snap.origin, snap.token)) }
  function stopHeartbeat() {
    if (window.RvBUtils && typeof window.RvBUtils.stopOfficialPresence === 'function') window.RvBUtils.stopOfficialPresence()
  }
  function handlePresenceStatus(event) {
    var detail = event && event.detail
    if (!detail || detail.origin !== state.origin || detail.token !== state.token) return
    if (detail.status === 'connected') {
      state.connected = true
      setConnection('已连接 · ' + ((state.account && state.account.name) || '社区'), true)
      return
    }
    if (detail.status === 'unauthorized') {
      clearAuthIfCurrent(detail.origin, detail.token)
      return
    }
    setConnection(detail.status === 'unsupported' ? '社区服务暂不可用' : '连接失败 · 点击刷新重试', false)
  }
  function resetCommunityData() {
    state.friends = { friends: [], incoming: [], outgoing: [], blocked: [] }
    state.search = []
    state.announcement = null
    state.posts = []
    state.boardCursor = null
    state.boardRequestId += 1
    state.replies = Object.create(null)
    state.replyDrafts = Object.create(null)
    ;['postTitle', 'postBody', 'postRoomCode'].forEach(function (id) {
      var field = node(id)
      if (field) field.value = ''
    })
    renderSearch()
    renderFriends()
    renderBoard()
  }
  function setConnection(message, connected) {
    state.connected = connected === true
    setText('communityConnection', message)
    setText('communityFooterStatus', '官方社区 · ' + message)
  }
  function setStatus(id, message) { setText(id, message || '') }
  function setBusy(key, control, value) {
    busy[key] = value
    if (control) control.disabled = value
    var content = node('communityContent')
    if (content) content.setAttribute('aria-busy', Object.keys(busy).some(function (name) { return busy[name] }) ? 'true' : 'false')
  }
  async function runBusy(key, control, work) {
    if (busy[key]) return
    setBusy(key, control, true)
    try { return await work() } finally { setBusy(key, control, false) }
  }

  function clearAuthIfCurrent(origin, token) {
    if (!sameSession(origin, token)) return false
    window.RvBUtils.clearOfficialSession(origin)
    if (state.origin === origin && state.token === token) {
      state.epoch += 1
      state.token = ''
      state.account = null
      state.connected = false
      stopHeartbeat()
      resetCommunityData()
      renderAuth()
    }
    return true
  }

  async function request(origin, path, body, token, method) {
    var headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = 'Bearer ' + token
    var options = { method: method || (body === undefined ? 'GET' : 'POST'), headers: headers, cache: 'no-store' }
    var requestSignal = signal()
    if (requestSignal) options.signal = requestSignal
    if (body !== undefined) options.body = JSON.stringify(body)
    var response = await fetch(origin + path, options)
    var result = {}
    try { result = await response.json() } catch {}
    if (!response.ok) {
      var error = new Error(result.error || (response.status === 401 ? '登录状态已过期' : '请求失败'))
      error.status = response.status
      throw error
    }
    return result
  }

  async function communityRequest(path, body, method, snap) {
    var active = snap || snapshot()
    if (!active.token) throw new Error('请先登录社区')
    try { return await request(active.origin, ROOT + path, body, active.token, method) }
    catch (error) {
      if (error && error.status === 401) clearAuthIfCurrent(active.origin, active.token)
      throw error
    }
  }

  function renderAuth() {
    var session = state.origin ? currentSession(state.origin) : null
    var loggedIn = !!(session && state.token && session.token === state.token)
    var auth = node('communityAuth'), content = node('communityContent'), logout = node('communityLogout'), accountButton = node('communityAccountButton')
    if (auth) auth.hidden = loggedIn
    if (content) content.hidden = !loggedIn
    if (logout) logout.hidden = !loggedIn
    if (accountButton) renderAccountIdentity(accountButton, loggedIn ? (state.account || session.account) : null, loggedIn ? ((state.account && state.account.name) || (session.account && session.account.name) || '已登录') : '登录账号')
    if (loggedIn) {
      if (state.account == null) state.account = session.account
      setStatus('communityAuthStatus', '')
    }
    setConnection(loggedIn ? (state.connected ? '已连接 · ' + ((state.account && state.account.name) || '已登录') : '已登录 · 正在连接') : '未连接', state.connected)
  }

  function displayName(value) {
    if (value && typeof value.name === 'string' && value.name.trim()) return value.name.trim()
    if (value && typeof value.id === 'string' && value.id) return value.id
    return '未知玩家'
  }
  function displayId(value) { return value && typeof value.id === 'string' ? value.id : '' }
  function renderAccountIdentity(element, account, fallback) {
    if (!element) return
    if (account && account.id && window.RvBPlayerProfile && typeof window.RvBPlayerProfile.renderIdentity === 'function') {
      window.RvBPlayerProfile.renderIdentity(element, account, 'rvb-community-avatar', fallback)
    } else element.textContent = fallback || '登录账号'
  }
  function dateText(value) {
    var date = value ? new Date(value) : null
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : ''
  }
  function emptyList(list, message) { var row = make('li', 'empty-row', message); list.appendChild(row) }

  function friendRow(value, type) {
    var row = make('li', 'friend-row')
    var copy = make('span', 'friend-row-copy')
    copy.appendChild(make('span', 'friend-row-name', displayName(value)))
    var playerName = copy.lastChild || (copy.children && copy.children[copy.children.length - 1])
    if (window.RvBPlayerProfile && displayId(value)) window.RvBPlayerProfile.decoratePlayer(playerName, { id: displayId(value), name: displayName(value), avatar: value && value.avatar })
    if (displayId(value)) copy.appendChild(make('span', 'friend-row-meta', displayId(value)))
    row.appendChild(copy)
    var actions = make('span', 'friend-row-actions')
    var id = displayId(value)
    if (type === 'friend') {
      var online = value && value.online === true
      actions.appendChild(make('span', online ? 'friend-online' : 'friend-offline', online ? '在线' : '离线'))
      addButton(actions, '移除', function (event) { void friendAction('remove', id, event.currentTarget) })
      addButton(actions, '屏蔽', function (event) { void friendAction('block', id, event.currentTarget, '好友已屏蔽') })
    } else if (type === 'incoming') {
      addButton(actions, '接受', function (event) { void friendAction('accept', id, event.currentTarget, '好友申请已接受') })
      addButton(actions, '拒绝', function (event) { void friendAction('reject', id, event.currentTarget, '好友申请已拒绝') })
      addButton(actions, '屏蔽', function (event) { void friendAction('block', id, event.currentTarget, '玩家已屏蔽') })
    } else if (type === 'outgoing') {
      addButton(actions, '撤回', function (event) { void friendAction('withdraw', id, event.currentTarget, '好友申请已撤回') })
      addButton(actions, '屏蔽', function (event) { void friendAction('block', id, event.currentTarget, '玩家已屏蔽') })
    } else if (type === 'blocked') {
      addButton(actions, '解除屏蔽', function (event) { void friendAction('unblock', id, event.currentTarget, '已解除屏蔽') })
    } else {
      addButton(actions, '加好友', function (event) { void friendAction('request', id, event.currentTarget, '好友申请已发送') })
    }
    row.appendChild(actions)
    return row
  }

  function renderSearch() {
    var list = node('searchResults'); clear(list)
    if (!state.search.length) { emptyList(list, '输入至少两个字符后搜索'); return }
    state.search.forEach(function (entry) { list.appendChild(friendRow(entry, 'search')) })
  }
  function renderFriends() {
    var groups = [['friendsList', state.friends.friends, 'friend', '暂无好友'], ['incomingList', state.friends.incoming, 'incoming', '暂无收到的申请'], ['outgoingList', state.friends.outgoing, 'outgoing', '暂无发出的申请'], ['blockedList', state.friends.blocked, 'blocked', '暂无屏蔽玩家']]
    groups.forEach(function (group) {
      var list = node(group[0]); clear(list)
      if (!group[1].length) emptyList(list, group[3])
      else group[1].forEach(function (entry) { list.appendChild(friendRow(entry, group[2])) })
    })
  }
  async function loadFriends(snap) {
    var active = snap || snapshot()
    if (!active.token) return
    setStatus('friendStatus', '正在读取好友…')
    try {
      var result = await communityRequest('/friends', undefined, 'GET', active)
      if (!currentSnapshot(active)) return
      state.friends = {
        friends: Array.isArray(result.friends) ? result.friends : [],
        incoming: Array.isArray(result.incoming) ? result.incoming : [],
        outgoing: Array.isArray(result.outgoing) ? result.outgoing : [],
        blocked: Array.isArray(result.blocked) ? result.blocked : [],
      }
      renderFriends()
      setStatus('friendStatus', '')
    } catch (error) {
      if (currentSnapshot(active)) setStatus('friendStatus', '好友读取失败：' + (error.message || '请点击刷新重试'))
      throw error
    }
  }
  async function friendAction(action, targetAccountId, control, successMessage) {
    if (!targetAccountId) return
    var active = snapshot()
    await runBusy('friend:' + action + ':' + targetAccountId, control, async function () {
      try {
        await communityRequest('/friends/' + encodeURIComponent(action), { targetAccountId: targetAccountId }, 'POST', active)
        if (!currentSnapshot(active)) return
        await loadFriends(active)
        if (currentSnapshot(active)) setStatus('friendStatus', successMessage || '好友关系已更新')
      } catch (error) { if (currentSnapshot(active)) setStatus('friendStatus', error.message || '好友操作失败，请重试') }
    })
  }

  async function searchAccounts() {
    var query = node('friendSearch').value.trim()
    if (query.length < 2) { setStatus('friendStatus', '请输入至少两个字符或 UID'); return }
    var active = snapshot()
    await runBusy('friend-search', node('friendSearchForm').querySelector('button'), async function () {
      try {
        var result = await communityRequest('/accounts?q=' + encodeURIComponent(query), undefined, 'GET', active)
        if (!currentSnapshot(active)) return
        state.search = Array.isArray(result.accounts) ? result.accounts : []
        renderSearch()
        setStatus('friendStatus', state.search.length ? '' : '没有找到玩家')
      } catch (error) { if (currentSnapshot(active)) setStatus('friendStatus', error.message || '玩家搜索失败，请重试') }
    })
  }

  function announcementParts(value) {
    if (typeof value === 'string') return { title: '官方公告', body: value }
    if (value && typeof value === 'object') return { title: value.title || '官方公告', body: value.body || value.message || '' }
    return { title: '官方公告', body: '暂无官方公告' }
  }
  function renderAnnouncement() {
    var parts = announcementParts(state.announcement)
    setText('announcementTitle', parts.title)
    setText('announcementBody', parts.body || '暂无官方公告')
  }
  function postOwn(post) { return !!(state.account && post && post.author && post.author.id && post.author.id === state.account.id) }
  function replyOwn(reply) { return !!(state.account && reply && reply.author && reply.author.id && reply.author.id === state.account.id) }
  function replyState(id) { return state.replies[id] || (state.replies[id] = { replies: [], cursor: null, open: false, loading: false }) }
  function makeReply(post, reply) {
    var row = make('li', 'reply-row')
    var meta = make('div', 'reply-meta')
    var replyAuthor = make('span', '', displayName(reply.author))
    meta.appendChild(replyAuthor)
    if (window.RvBPlayerProfile && displayId(reply.author)) window.RvBPlayerProfile.decoratePlayer(replyAuthor, { id: displayId(reply.author), name: displayName(reply.author), avatar: reply.author && reply.author.avatar })
    meta.appendChild(make('span', '', dateText(reply.createdAt)))
    row.appendChild(meta)
    row.appendChild(make('p', 'reply-body', reply.body || ''))
    if (replyOwn(reply)) {
      var tools = make('div', 'board-post-tools')
      addButton(tools, '删除回复', function (event) { void deleteReply(post.id, reply.id, event.currentTarget) }, 'danger')
      row.appendChild(tools)
    }
    return row
  }
  function makePost(post) {
    var article = make('article', 'board-post')
    article.dataset.postId = post.id || ''
    var header = make('header', 'board-post-header')
    var heading = make('div')
    heading.appendChild(make('span', 'board-post-kind', post.kind === 'meetup' ? '约桌' : '讨论'))
    heading.appendChild(make('h3', '', post.title || '无标题'))
    header.appendChild(heading)
    var author = make('span', 'board-post-meta')
    var authorName = make('span', 'board-post-author', displayName(post.author))
    author.appendChild(authorName)
    if (window.RvBPlayerProfile && displayId(post.author)) window.RvBPlayerProfile.decoratePlayer(authorName, { id: displayId(post.author), name: displayName(post.author), avatar: post.author && post.author.avatar })
    if (dateText(post.createdAt)) author.appendChild(make('span', 'board-post-date', ' · ' + dateText(post.createdAt)))
    header.appendChild(author)
    article.appendChild(header)
    article.appendChild(make('p', 'board-post-body', post.body || ''))
    var tools = make('div', 'board-post-tools')
    if (typeof post.roomCode === 'string' && post.roomCode.trim()) {
      tools.appendChild(make('span', 'room-code', post.roomCode))
      addButton(tools, '复制房间码', function (event) { void copyRoomCode(post.roomCode, event.currentTarget) })
    }
    var replies = replyState(post.id)
    addButton(tools, replies.open ? '收起回复' : '回复（' + (post.replyCount || 0) + '）', function (event) { void toggleReplies(post.id, event.currentTarget) })
    if (postOwn(post)) addButton(tools, '删除帖子', function (event) { void deletePost(post.id, event.currentTarget) }, 'danger')
    article.appendChild(tools)
    if (replies.open) {
      var replyList = make('ul', 'reply-list')
      if (!replies.replies.length) emptyList(replyList, '还没有回复')
      else replies.replies.forEach(function (reply) { replyList.appendChild(makeReply(post, reply)) })
      article.appendChild(replyList)
      if (replies.cursor) addButton(article, '加载更多回复', function (event) { void loadReplies(post.id, event.currentTarget, true) })
      var form = make('form', 'reply-form')
      var textarea = make('textarea')
      textarea.setAttribute('aria-label', '回复内容')
      textarea.maxLength = 500
      textarea.rows = 2
      textarea.required = true
      textarea.placeholder = '写一条回复…'
      textarea.value = state.replyDrafts[post.id] || ''
      textarea.addEventListener('input', function () { state.replyDrafts[post.id] = textarea.value })
      form.appendChild(textarea)
      var submit = make('button', 'button primary', '回复')
      submit.type = 'submit'
      form.appendChild(submit)
      form.addEventListener('submit', function (event) { event.preventDefault(); void submitReply(post.id, textarea, submit) })
      article.appendChild(form)
    }
    return article
  }
  function renderBoard() {
    renderAnnouncement()
    var list = node('boardPosts'); clear(list)
    if (!state.posts.length) emptyList(list, '还没有帖子，发布第一条约桌或讨论吧')
    else state.posts.forEach(function (post) { list.appendChild(makePost(post)) })
    var more = node('boardMore')
    if (more) more.hidden = !state.boardCursor
  }
  async function loadBoard(append, control) {
    var active = snapshot()
    if (!active.token) return
    if (append && !state.boardCursor) return
    var requestId = append ? state.boardRequestId : ++state.boardRequestId
    var query = '?limit=20' + (append && state.boardCursor ? '&cursor=' + encodeURIComponent(state.boardCursor) : '')
    await runBusy(append ? 'board-more' : 'board-load', control || node(append ? 'boardMore' : 'boardRefresh'), async function () {
      try {
        var result = await communityRequest('/board' + query, undefined, 'GET', active)
        if (!currentSnapshot(active) || requestId !== state.boardRequestId) return
        state.announcement = result.announcement
        var posts = Array.isArray(result.posts) ? result.posts : []
        state.posts = append ? state.posts.concat(posts) : posts
        state.boardCursor = result.nextCursor || null
        renderBoard()
        setStatus('boardStatus', '')
      } catch (error) { if (currentSnapshot(active)) setStatus('boardStatus', '公告板读取失败：' + (error.message || '请点击刷新重试')) }
    })
  }
  async function loadReplies(postId, control, append) {
    var active = snapshot(), replies = replyState(postId)
    if (!active.token || replies.loading || (append && !replies.cursor)) return
    replies.loading = true
    if (control) control.disabled = true
    try {
      var query = '?limit=20' + (append && replies.cursor ? '&cursor=' + encodeURIComponent(replies.cursor) : '')
      var result = await communityRequest('/posts/' + encodeURIComponent(postId) + '/replies' + query, undefined, 'GET', active)
      if (!currentSnapshot(active)) return
      replies.replies = append ? replies.replies.concat(Array.isArray(result.replies) ? result.replies : []) : (Array.isArray(result.replies) ? result.replies : [])
      replies.cursor = result.nextCursor || null
      replies.open = true
      renderBoard()
    } catch (error) { if (currentSnapshot(active)) setStatus('boardStatus', '回复读取失败：' + (error.message || '请重试')) }
    finally { replies.loading = false; if (control) control.disabled = false }
  }
  async function toggleReplies(postId, control) {
    var replies = replyState(postId)
    if (replies.open) { replies.open = false; renderBoard(); return }
    await loadReplies(postId, control, false)
  }
  async function submitReply(postId, textarea, control) {
    var body = textarea.value.trim()
    if (!body) return
    if (body.length > 500) { setStatus('boardStatus', '回复不能超过 500 个字符'); return }
    var active = snapshot()
    await runBusy('reply:' + postId, control, async function () {
      try {
        await communityRequest('/posts/' + encodeURIComponent(postId) + '/replies', { body: body }, 'POST', active)
        if (!currentSnapshot(active)) return
        state.replyDrafts[postId] = ''
        await loadReplies(postId, null, false)
        if (currentSnapshot(active)) setStatus('boardStatus', '回复已发布')
      } catch (error) { if (currentSnapshot(active)) setStatus('boardStatus', error.message || '回复发布失败，请重试') }
    })
  }
  async function deletePost(postId, control) {
    var active = snapshot()
    await runBusy('delete-post:' + postId, control, async function () {
      try {
        await communityRequest('/posts/' + encodeURIComponent(postId) + '/delete', {}, 'POST', active)
        if (!currentSnapshot(active)) return
        delete state.replies[postId]
        await loadBoard(false)
        if (currentSnapshot(active)) setStatus('boardStatus', '帖子已删除')
      } catch (error) { if (currentSnapshot(active)) setStatus('boardStatus', error.message || '帖子删除失败，请重试') }
    })
  }
  async function deleteReply(postId, replyId, control) {
    var active = snapshot()
    await runBusy('delete-reply:' + replyId, control, async function () {
      try {
        await communityRequest('/replies/' + encodeURIComponent(replyId) + '/delete', {}, 'POST', active)
        if (!currentSnapshot(active)) return
        var replies = replyState(postId)
        replies.replies = replies.replies.filter(function (reply) { return reply.id !== replyId })
        renderBoard()
        setStatus('boardStatus', '回复已删除')
      } catch (error) { if (currentSnapshot(active)) setStatus('boardStatus', error.message || '回复删除失败，请重试') }
    })
  }
  async function copyRoomCode(code) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') await navigator.clipboard.writeText(String(code))
      else {
        var field = make('textarea')
        field.value = String(code)
        field.setAttribute('readonly', 'readonly')
        field.style.position = 'fixed'
        field.style.opacity = '0'
        document.body.appendChild(field)
        field.select()
        if (document.execCommand) document.execCommand('copy')
        field.remove()
      }
      setStatus('boardStatus', '房间码已复制；请按正常联机流程进入房间')
    } catch { setStatus('boardStatus', '无法自动复制，请手动选择房间码') }
  }
  async function submitPost() {
    var title = node('postTitle').value.trim(), body = node('postBody').value.trim(), roomCode = node('postRoomCode').value.trim(), kind = node('postKind').value
    if (!title || !body) { setStatus('boardStatus', '标题和内容不能为空'); return }
    if (title.length > 80 || body.length > 2000 || roomCode.length > 80) { setStatus('boardStatus', '标题、内容或房间码超过长度限制'); return }
    var active = snapshot()
    await runBusy('post-submit', node('postSubmit'), async function () {
      try {
        var payload = { kind: kind === 'discussion' ? 'discussion' : 'meetup', title: title, body: body }
        if (roomCode) payload.roomCode = roomCode
        await communityRequest('/posts', payload, 'POST', active)
        if (!currentSnapshot(active)) return
        node('postTitle').value = ''
        node('postBody').value = ''
        node('postRoomCode').value = ''
        state.boardCursor = null
        await loadBoard(false)
        if (currentSnapshot(active)) setStatus('boardStatus', '帖子已发布')
      } catch (error) { if (currentSnapshot(active)) setStatus('boardStatus', error.message || '帖子发布失败，请重试') }
    })
  }

  async function startHeartbeat(active) {
    if (window.RvBUtils && typeof window.RvBUtils.startOfficialPresence === 'function') {
      return await window.RvBUtils.startOfficialPresence(active.origin, active.token)
    }
    await request(active.origin, '/official/community/heartbeat', {}, active.token, 'POST')
    return true
  }
  async function connect(active) {
    var snap = active || snapshot()
    if (!snap.token) return false
    setConnection('正在连接…', false)
    try {
      var me = await request(snap.origin, '/official/me', undefined, snap.token, 'GET')
      if (!currentSnapshot(snap)) return false
      if (me && me.account) { state.account = me.account; window.RvBUtils.saveOfficialSession({ url: snap.origin, token: snap.token, account: me.account }) }
      var presence = await startHeartbeat(snap)
      if (!currentSnapshot(snap)) return false
      if (presence === false) { setConnection('连接失败 · 点击刷新重试', false); return false }
      state.connected = true
      renderAuth()
      await Promise.allSettled([loadFriends(snap), loadBoard(false)])
      if (currentSnapshot(snap)) setConnection('已连接 · ' + ((state.account && state.account.name) || '社区'), true)
      return true
    } catch (error) {
      if (error && error.status === 401) clearAuthIfCurrent(snap.origin, snap.token)
      else if (currentSnapshot(snap)) setConnection('连接失败 · 点击刷新重试', false)
      if (currentSnapshot(snap)) setStatus('communityAuthStatus', '服务器暂时不可用；点击刷新重试，仍可返回离线游戏')
      return false
    }
  }
  async function login() {
    var origin, operationEpoch
    try {
      origin = normalizeOrigin(node('communityServer').value)
      operationEpoch = ++state.epoch
      state.origin = origin
      state.token = ''
      state.account = null
      state.connected = false
      stopHeartbeat()
      resetCommunityData()
      renderAuth()
      setStatus('communityAuthStatus', '正在登录…')
      var result = await request(origin, '/official/auth/login', { email: node('communityEmail').value.trim(), password: node('communityPassword').value }, undefined, 'POST')
      if (state.epoch !== operationEpoch) return
      if (!window.RvBUtils.saveOfficialSession({ url: origin, token: result.token, account: result.account })) throw new Error('登录状态保存失败，请检查本机存储')
      localStorage.setItem('rvb_official_url', origin)
      if (window.RvBUtils.saveRemoteServerUrl) window.RvBUtils.saveRemoteServerUrl(origin)
      node('communityPassword').value = ''
      resetCommunityData()
      state.token = result.token
      state.account = result.account
      renderAuth()
      await connect(snapshot())
      setStatus('communityAuthStatus', state.connected ? '' : '登录成功；服务器暂时不可用，可稍后重试')
    } catch (error) { setStatus('communityAuthStatus', error.message || '登录失败，请重试') }
  }
  async function logout() {
    var snap = snapshot(), operationEpoch = ++state.epoch
    stopHeartbeat()
    try { if (snap.token) await request(snap.origin, '/official/auth/logout', {}, snap.token, 'POST') }
    catch (error) { if (error && error.status === 401) clearAuthIfCurrent(snap.origin, snap.token) }
    finally {
      if (state.epoch === operationEpoch && sameSession(snap.origin, snap.token)) window.RvBUtils.clearOfficialSession(snap.origin)
      if (state.epoch === operationEpoch) { state.token = ''; state.account = null; state.connected = false; state.epoch += 1; resetCommunityData(); renderAuth(); setStatus('communityAuthStatus', '已退出，可继续离线游戏') }
    }
  }
  async function refreshAll() {
    if (!state.token) { renderAuth(); node('communityEmail').focus(); return }
    var active = snapshot()
    await connect(active)
  }

  function bind() {
    node('communityLoginForm').addEventListener('submit', function (event) { event.preventDefault(); void runBusy('login', node('communityLoginSubmit'), login) })
    node('communityLogout').addEventListener('click', function (event) { void runBusy('logout', event.currentTarget, logout) })
    node('communityRefresh').addEventListener('click', function (event) { void runBusy('connect', event.currentTarget, refreshAll) })
    node('friendsRefresh').addEventListener('click', function (event) { void runBusy('friends-refresh', event.currentTarget, function () { return loadFriends() }) })
    node('boardRefresh').addEventListener('click', function (event) { void runBusy('board-refresh', event.currentTarget, function () { state.boardCursor = null; return loadBoard(false, event.currentTarget) }) })
    node('boardMore').addEventListener('click', function (event) { void loadBoard(true, event.currentTarget) })
    node('friendSearchForm').addEventListener('submit', function (event) { event.preventDefault(); void searchAccounts() })
    node('postForm').addEventListener('submit', function (event) { event.preventDefault(); void submitPost() })
    node('communityAccountButton').addEventListener('click', function () {
      if (state.token && state.account && state.account.id && window.RvBPlayerProfile) void window.RvBPlayerProfile.open(state.account.id)
      else if (!state.token) { node('communityEmail').focus(); node('communityAuth').scrollIntoView({ block: 'center', behavior: 'smooth' }) }
    })
    node('communityServer').addEventListener('change', function () {
      try { state.origin = normalizeOrigin(node('communityServer').value); state.token = ''; state.account = null; state.connected = false; state.epoch += 1; stopHeartbeat(); resetCommunityData(); renderAuth(); setStatus('communityAuthStatus', '服务器已更改，请重新登录') }
      catch (error) { setStatus('communityAuthStatus', error.message) }
    })
  }
  function initialize() {
    state.origin = savedOrigin()
    node('communityServer').value = state.origin
    var session = currentSession(state.origin)
    if (session) { state.token = session.token; state.account = session.account; renderAuth(); void connect(snapshot()) }
    else { renderAuth(); setStatus('communityAuthStatus', '登录后连接好友和公告板；可返回离线游戏') }
    renderSearch(); renderFriends(); renderBoard()
  }
  window.RvBCommunity = { state: state, login: login, logout: logout, refresh: refreshAll, loadFriends: loadFriends, loadBoard: loadBoard, searchAccounts: searchAccounts }
  window.addEventListener('rvb-official-presence', handlePresenceStatus)
  bind()
  initialize()
})()
