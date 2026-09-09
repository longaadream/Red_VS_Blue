;(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }, id = new URLSearchParams(location.search).get('matchId'), state, selected = null, pending = false, loading = false, offset = 0, built = false
  function message(text) { $('matchMessage').textContent = text }
  function clock() { if (!state || !state.deadlineAt) return; var seconds = Math.max(0, Math.ceil((state.deadlineAt - (Date.now() + offset)) / 1000)); $('deadline').textContent = state.phase === 'veto' ? String(seconds) : Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') }
  function detail(map) { $('detailName').textContent = map.name; RvBRanked.drawMap($('detailMap'), map); $('mapDialog').showModal() }
  function render() {
    if (state.phase === 'battle') { location.replace(RvBRanked.url(state.legacy ? 'room.html' : 'battle.html', id, state.players && state.players.find(function (p) { return p.id === RvBRanked.session().account.id }).alignment)); return }
    if (state.phase === 'finished') { $('withdraw').hidden = true; $('stageTitle').textContent = state.status === 'void' ? '本局已取消' : '本局已结算'; $('stageHint').textContent = '返回排位大厅查看记录。'; $('vetoStage').hidden = $('mapStage').hidden = true; $('confirmBan').hidden = $('chooseRoster').hidden = true; $('returnLobby').hidden = false; return }
    var me = state.players.find(function (p) { return p.id === RvBRanked.session().account.id }), veto = state.phase === 'veto'
    $('stageTitle').textContent = veto ? '禁用一张地图' : state.phase === 'starting' ? '双方阵容已锁定' : '本局地图已确定'
    $('stageHint').textContent = veto ? '双方秘密选择，提交后锁定；允许禁用同一张地图。' : '阵容选择已开始计时，请尽快进入选人。'
    $('stepVeto').className = veto ? 'active' : 'done'; $('stepMap').className = veto ? '' : 'active'
    $('deadlineLabel').textContent = veto ? '禁图剩余时间' : '阵容剩余时间'
    $('players').replaceChildren()
    state.players.forEach(function (p, i) {
      if (i) { var vs = document.createElement('span'); vs.className = 'ranked-versus'; vs.textContent = 'VS'; $('players').appendChild(vs) }
      var seat = document.createElement('div'), name = document.createElement('strong'), status = document.createElement('small'); seat.className = 'ranked-player ' + p.seat; name.textContent = p.name + (p.id === me.id ? ' · 你' : '')
      status.textContent = veto ? p.banSubmitted ? '已提交 · 选择保密' : '正在选择' : p.locked ? '阵容已锁定' : '正在准备阵容'; seat.append(name, status); $('players').appendChild(seat)
    })
    $('vetoStage').hidden = !veto; $('mapStage').hidden = veto; $('confirmBan').hidden = !veto; $('chooseRoster').hidden = veto || state.phase === 'starting'
    if (!built) {
      state.maps.forEach(function (map) {
        var card = document.createElement('article'), canvas = document.createElement('canvas'), title = document.createElement('h3'), size = document.createElement('p'), choose = document.createElement('button'), zoom = document.createElement('button')
        card.className = 'ranked-map-card'; card.dataset.mapId = map.id; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', map.name + '地形'); title.textContent = map.name; size.textContent = map.width + ' × ' + map.height
        choose.className = 'button choose-map'; choose.textContent = '选择禁用'; choose.onclick = function () { selected = map.id; render() }
        zoom.className = 'button map-zoom'; zoom.textContent = '放大地图'; zoom.onclick = function () { detail(map) }
        card.append(canvas, title, size, choose, zoom); $('mapCards').appendChild(card); RvBRanked.drawMap(canvas, map)
      }); built = true
    }
    document.querySelectorAll('.ranked-map-card').forEach(function (card) { var chosen = card.dataset.mapId === (me.banSubmitted ? me.ban : selected); card.classList.toggle('selected', chosen); var button = card.querySelector('.choose-map'); button.disabled = pending || me.banSubmitted || !veto; button.setAttribute('aria-pressed', String(chosen)); button.textContent = chosen ? me.banSubmitted ? '已禁用' : '已选，待确认' : '选择禁用' })
    $('confirmBan').disabled = pending || me.banSubmitted || selected === null; $('confirmBan').textContent = me.banSubmitted ? '等待对方提交' : pending ? '正在提交…' : '确认禁用'
    $('dockTitle').textContent = veto ? me.banSubmitted ? '你的禁图已提交' : '选择地图后确认禁用' : state.phase === 'starting' ? '服务器正在创建对局' : '根据地图组建你的阵容'
    $('dockHint').textContent = veto ? '30 秒未提交视为放弃禁图；双方提交后立即抽图。' : '120 秒结束后，保留已选棋子并随机补齐。'
    if (state.mapId) { var map = state.maps.find(function (m) { return m.id === state.mapId }); $('chosenName').textContent = map.name; RvBRanked.drawMap($('chosenMap'), map); $('banSummary').textContent = state.players.map(function (p) { return p.name + '：' + (p.ban ? '禁用 ' + state.maps.find(function (m) { return m.id === p.ban }).name : '放弃禁图') }).join('\n') }
    clock()
  }
  async function refresh() { if (loading || pending) return; loading = true; try { state = await RvBRanked.api('/official/pregame/' + encodeURIComponent(id)); offset = state.serverNow - Date.now(); render(); message('') } catch (e) { message(e.message + '；正在重试，不会重新分配比赛。') } finally { loading = false } }
  $('confirmBan').onclick = async function () { if (pending || loading || selected === null) return; pending = true; render(); try { state = await RvBRanked.api('/official/pregame/' + encodeURIComponent(id), { action: 'ban', mapId: selected }); message('') } catch (e) { message(e.message) } finally { pending = false; render() } }
  $('chooseRoster').onclick = function () { location.href = RvBRanked.url('piece-selection.html', id) }
  $('withdraw').onclick = function () { $('withdrawDialog').showModal() }
  $('withdrawDialog').addEventListener('close', async function () {
    if ($('withdrawDialog').returnValue !== 'withdraw' || pending) return
    pending = true
    try { await RvBRanked.api('/official/pregame/' + encodeURIComponent(id) + '/withdraw', {}); location.replace('official.html') }
    catch (e) { message(e.message) } finally { pending = false }
  })
  void refresh(); setInterval(refresh, 1000); setInterval(clock, 250)
})()
