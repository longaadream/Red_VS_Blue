/* Official ranked uses the existing roster renderer, presets, portraits and details. */
;(function () {
  'use strict'
  if (params.get('ranked') !== '1') return
  var state, offset = 0, hydrating = true, dirty = false, busy = false, revision = 0, submitted = false
  function message(text) { var target = document.getElementById('rankedRosterError'); if (target) target.textContent = text }
  function me() { return state && state.players && state.players.find(function (p) { return p.id === playerId }) }
  function endpoint() { return '/official/pregame/' + encodeURIComponent(roomId) }
  function clock() { if (!state) return; var target = document.getElementById('rankedRosterClock'); if (target) { var s = Math.max(0, Math.ceil((state.deadlineAt - Date.now() - offset) / 1000)); target.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') } }
  async function apply(next) {
    state = next; offset = state.serverNow - Date.now()
    if (state.phase === 'battle') { navigateBattle(); return }
    if (state.phase === 'finished' || state.phase === 'veto') { location.replace('ranked-match.html?matchId=' + encodeURIComponent(roomId)); return }
    var mine = me()
    if (!mine) throw new Error('没有本局参赛资格')
    playerFaction = mine.seat
    if (hydrating || mine.locked) {
      playerAlignment = mine.alignment; selectedIds = new Set(mine.pieces); submitted = mine.locked
      hydrating = true; updateFactionBadge(); await loadPieces(); updateConfirmBar(); hydrating = false
    }
    if (submitted || state.phase === 'starting') {
      document.getElementById('waitOverlay').classList.add('show')
      document.getElementById('waitSub').textContent = mine.autoFilled ? '服务器已随机补齐你的阵容，等待对手完成。' : '阵容已锁定，等待对手完成。'
    }
    document.getElementById('rankedRosterMap').textContent = state.maps.find(function (m) { return m.id === state.mapId }).name
    clock()
  }
  async function poll() {
    if (busy) return
    busy = true
    try {
      if (dirty && playerAlignment && !submitted) {
        var sent = revision
        await apply(await RvBRanked.api(endpoint(), { action: 'draft', revision: me().revision, alignment: playerAlignment, pieces: Array.from(selectedIds) }))
        if (revision === sent) dirty = false
      } else await apply(await RvBRanked.api(endpoint()))
      message('')
    } catch (e) { if (e.status === 409) { dirty = false; hydrating = true }; message(e.message + '，将重试同步。') }
    finally { busy = false }
  }
  window.RvBRankedSelection = {
    init: async function () {
      var saved = RvBRanked.session()
      if (saved.account.id !== playerId) throw new Error('账号与比赛身份不一致')
      RvBUtils.saveRemoteServerUrl(saved.url); RvBUtils.switchServerMode('remote')
      var strip = document.createElement('div'); strip.className = 'ranked-roster-strip'
      strip.innerHTML = '<strong>官方排位</strong><span id="rankedRosterMap">读取地图…</span><small>超时随机补齐，不自动部署</small><span id="rankedRosterClock">02:00</span><button id="rankedViewMap" type="button">查看地图</button><div id="rankedRosterError" class="ranked-roster-error" role="status"></div>'
      document.querySelector('.topbar').after(strip)
      document.getElementById('rankedViewMap').onclick = window.RvBRankedSelection.viewMap
      document.getElementById('serverLabel').textContent = '官方排位 · 阵容实时保存'
      document.getElementById('pageTitle').textContent = '排位 · 选择阵营与阵容'
      await poll(); setInterval(poll, 800); setInterval(clock, 250)
    },
    changed: function () { if (!hydrating && !submitted) { dirty = true; revision++ } },
    viewMap: async function () {
      if (busy) { setTimeout(window.RvBRankedSelection.viewMap, 100); return }
      await poll()
      if (dirty && !submitted) { message('阵容尚未保存，请等同步成功后返回。'); return }
      location.href = 'ranked-match.html?matchId=' + encodeURIComponent(roomId)
    },
    confirm: async function () {
      if (submitted) return
      if (busy) { setTimeout(function () { window.RvBRankedSelection.confirm() }, 100); return }
      busy = true
      try { await apply(await RvBRanked.api(endpoint(), { action: 'lock', revision: me().revision, alignment: playerAlignment, pieces: Array.from(selectedIds) })); dirty = false; message('') }
      catch (e) { message(e.message); document.getElementById('confirmBtn').disabled = false }
      finally { busy = false }
    }
  }
})()
