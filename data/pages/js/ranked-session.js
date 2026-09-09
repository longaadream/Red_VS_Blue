;(function () {
  'use strict'
  function session() {
    var saved
    try { saved = JSON.parse(sessionStorage.getItem('rvb_official_session') || 'null') } catch {}
    if (!saved || !saved.token || !saved.account) throw new Error('请先登录官方服务器账号')
    var url = new URL(saved.url)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('官方服务器地址不安全')
    return saved
  }
  async function api(route, body) {
    var saved = session(), response = await fetch(saved.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + saved.token }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(15000) })
    var result = await response.json()
    if (!response.ok) { var error = new Error(result.error || '请求失败'); error.status = response.status; throw error }
    return result
  }
  function url(page, id, alignment) {
    var saved = session(), p = new URLSearchParams({ roomId: id, matchId: id, playerId: saved.account.id, accountId: saved.account.id, playerName: saved.account.name, ranked: '1' })
    if (alignment) p.set('alignment', alignment)
    return page + '?' + p.toString()
  }
  function drawMap(canvas, map) {
    var context = canvas.getContext('2d'), scale = 18
    canvas.width = map.width * scale; canvas.height = map.height * scale
    var colors = { floor: '#c7b18a', wall: '#554e3e', hole: '#58666a', cover: '#aa7c43' }
    map.tiles.forEach(function (t) {
      context.fillStyle = colors[t.type] || colors.floor; context.fillRect(t.x * scale, t.y * scale, scale, scale)
      context.strokeStyle = '#5b493866'; context.strokeRect(t.x * scale, t.y * scale, scale, scale)
      if (t.type === 'cover' || t.type === 'wall') { context.fillStyle = '#ead1a326'; context.fillRect(t.x * scale + 2, t.y * scale + 2, scale - 4, 3) }
    })
  }
  window.RvBRanked = { session: session, api: api, url: url, drawMap: drawMap }
})()
