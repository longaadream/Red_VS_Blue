;(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }
  var current = null, activeMatch = null, busy = false, polling = false
  function session() { try { return JSON.parse(sessionStorage.getItem('rvb_official_session') || 'null') } catch { return null } }
  function clearBattleReservations() {
    var prefix = 'rvb_colyseus_reconnect:' + base() + ':'
    Object.keys(sessionStorage).forEach(function (key) { if (key.startsWith(prefix)) sessionStorage.removeItem(key) })
  }
  function base() {
    var url = new URL($('server').value.trim())
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('账号登录必须使用 HTTPS；只有本机 localhost/127.0.0.1 可使用 HTTP')
    return url.href.replace(/\/+$/, '')
  }
  function message(text) { $('message').textContent = text }
  async function api(path, body) {
    var origin = base(), saved = session(), headers = { 'Content-Type': 'application/json' }
    if (saved && saved.url === origin) headers.Authorization = 'Bearer ' + saved.token
    var response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), cache: 'no-store' })
    var result = await response.json()
    if (!response.ok) { if (response.status === 401 && path === '/official/me') { sessionStorage.removeItem('rvb_official_session'); $('profile').hidden = true; $('auth').hidden = false }; throw new Error(result.error || '请求失败') }
    return result
  }
  function cell(row, text) { var td = document.createElement('td'); td.textContent = text; row.appendChild(td) }
  async function refresh() {
    if (polling || document.hidden) return
    polling = true
    try {
      var saved = session()
      if (saved && saved.url === base()) {
        current = await api('/official/me')
        activeMatch = current.matchId
        $('auth').hidden = true; $('profile').hidden = false
        $('welcome').textContent = current.account.name
        $('season').textContent = current.season.name + (current.season.test ? ' · 测试积分将在正式赛季重置' : '') + (current.testParticipant ? ' · 测试参与者' : '')
        $('rating').textContent = current.rating.rating + ' Elo'
        $('record').textContent = current.rating.games + ' 场 · ' + current.rating.wins + ' 胜'
        $('queueStatus').textContent = activeMatch ? '匹配成功，请进入比赛。比赛结果落盘后自动结算。' : current.queued ? '正在等待真人对手或空闲对局名额…' : current.cooldownUntil ? '匹配冷却至 ' + new Date(current.cooldownUntil).toLocaleString() : current.season.maintenance ? '排位维护中，正在进行的比赛可继续。' : '准备好后开始匹配。'
        $('join').hidden = !!activeMatch || current.queued; $('join').disabled = !!current.cooldownUntil || current.season.maintenance
        $('cancel').hidden = !current.queued; $('enter').hidden = !activeMatch
        $('history').replaceChildren()
        current.history.forEach(function (match) {
          var item = document.createElement('article'), result = match.result, mine = result && result.first ? (result.first.id === current.account.id ? result.first : result.second) : null
          item.textContent = new Date(match.created_at).toLocaleString() + ' · ' + match.season_id + '\n' + (mine ? (result.winnerId ? result.winnerId === current.account.id ? '胜利' : '失败' : '和局') + ' · ' + (mine.delta >= 0 ? '+' : '') + mine.delta + ' → ' + mine.after : match.status === 'void' ? '已作废 · ' + result.reason : '比赛进行中／等待结算')
          $('history').appendChild(item)
        })
      }
      else { current = null; activeMatch = null; $('profile').hidden = true; $('auth').hidden = false; $('history').replaceChildren() }
      var board = await api('/official/leaderboard'); $('leaderboard').replaceChildren()
      board.players.forEach(function (player) { var row = document.createElement('tr'); cell(row, player.name); cell(row, player.rating); cell(row, player.games); $('leaderboard').appendChild(row) })
    } catch (error) { message(error.message) } finally { polling = false }
  }
  async function connect() {
    var info = await api('/official/info')
    if (info.kind !== 'rvb-official-v1') throw new Error('此地址不是官方排位服务')
    localStorage.setItem('rvb_official_url', base())
    message('官方服务器已连接。')
    await refresh()
  }
  function run(work) { return async function (event) { if (event) event.preventDefault(); if (busy) return; busy = true; try { await work() } catch (error) { message(error.message) } finally { busy = false } } }
  $('connect').onclick = run(connect)
  $('authAction').onchange = function () {
    var action = $('authAction').value
    $('nameField').hidden = action !== 'register'; $('codeField').hidden = !['verify', 'reset'].includes(action)
    $('passwordField').hidden = !['register', 'login', 'reset'].includes(action)
    $('password').required = !$('passwordField').hidden; $('name').required = action === 'register'; $('code').required = !$('codeField').hidden
    $('password').autocomplete = action === 'login' ? 'current-password' : 'new-password'
  }
  $('authForm').onsubmit = run(async function () {
    var action = $('authAction').value
    var result = await api('/official/auth/' + action, { email: $('email').value, password: $('password').value, name: $('name').value, code: $('code').value })
    $('password').value = ''; $('code').value = ''
    if (action === 'login') { clearBattleReservations(); sessionStorage.setItem('rvb_official_session', JSON.stringify({ url: base(), token: result.token, account: result.account })); message('登录成功。'); await refresh() }
    else { message(result.message); $('authAction').value = action === 'register' ? 'verify' : action === 'forgot' ? 'reset' : 'login'; $('authAction').onchange() }
  })
  $('join').onclick = run(async function () { await api('/official/queue/join', {}); await refresh() })
  $('cancel').onclick = run(async function () { await api('/official/queue/cancel', {}); await refresh() })
  $('logout').onclick = run(async function () { await api('/official/queue/cancel', {}); await api('/official/auth/logout', {}); clearBattleReservations(); sessionStorage.removeItem('rvb_official_session'); current = null; $('profile').hidden = true; $('auth').hidden = false; message('已退出账号。') })
  $('enter').onclick = run(async function () {
    if (!activeMatch || !current) return
    var profile = await api('/catalog/identity')
    localStorage.setItem('rvb_game_profile_identity', JSON.stringify(profile.profileIdentity))
    window.RvBUtils.saveRemoteServerUrl(base()); window.RvBUtils.switchServerMode('remote')
    window.location.href = 'room.html?roomId=' + encodeURIComponent(activeMatch) + '&playerId=' + encodeURIComponent(current.account.id) + '&playerName=' + encodeURIComponent(current.account.name) + '&alignment=' + encodeURIComponent($('alignment').value)
  })
  $('server').value = localStorage.getItem('rvb_official_url') || (/^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:2568')
  $('authAction').onchange()
  void connect().catch(function (error) { message(error.message) })
  setInterval(refresh, 4000)
})()
