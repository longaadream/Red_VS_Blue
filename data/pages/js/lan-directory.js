;(function () {
  const params = new URLSearchParams(location.search)
  const server = (params.get('serverUrl') || '').replace(/\/+$/, '')
  const mode = params.get('server') === 'local' ? 'local' : 'lan'
  const $ = id => document.getElementById(id)
  let rooms = []
  function target(page, extra = {}) {
    return page + '?' + new URLSearchParams({server: mode, serverUrl: server, lobbyContext: 'lan', ...extra})
  }
  function render() {
    $('rooms').replaceChildren()
    for (const room of rooms.filter(r => $('filter').value === 'all' || r.mode === $('filter').value)) {
      const card = document.createElement('article'); card.className = 'lan-room'
      const title = document.createElement('h2'); title.textContent = room.name || '局域网房间'
      const info = document.createElement('span'); info.textContent = `${room.mode} · ${Array.isArray(room.players) ? room.players.length : room.players}/${room.maxPlayers || (room.mode === '2v2' || room.mode === 'pve' ? 4 : 2)}`
      const join = document.createElement('button'); join.textContent = '加入'
      join.onclick = () => {
        if (room.mode === 'pve') location.href = 'adventure.html?' + new URLSearchParams({ party:'lan', server, joinRoom:room.id })
        else location.href = target('lobby.html', { joinRoom:room.id })
      }
      card.append(title, info, join); $('rooms').append(card)
    }
  }
  async function refresh() {
    $('refresh').disabled = true; $('status').textContent = '正在读取当前局域网主机…'
    try {
      const url = new URL(server)
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password) throw new Error('请从主页重新选择局域网主机')
      const results = await Promise.all(['', '?mode=pve'].map(async query => {
        const response = await fetch(server + '/rooms' + query, {cache:'no-store', signal:AbortSignal.timeout(8000)})
        if (!response.ok) throw new Error('主机连接失败：' + response.status)
        return (await response.json()).rooms || []
      }))
      rooms = [...new Map(results.flat().map(room => [room.id, room])).values()]
      render(); $('status').textContent = rooms.length ? '仅显示此局域网主机的房间' : '此主机暂无房间'
    } catch (error) { rooms=[]; render(); $('status').textContent=error.message }
    finally { $('refresh').disabled=false }
  }
  $('address').textContent = '局域网主机：' + (server || '未选择')
  $('filter').onchange=render; $('refresh').onclick=refresh
  $('create').onclick=()=>{
    if ($('filter').value === 'pve') location.href = 'adventure.html?' + new URLSearchParams({party:'lan',server,create:'1'})
    else location.href=target('lobby.html',{create:'1',matchMode:$('filter').value==='2v2'?'2v2':'1v1'})
  }
  void refresh()
})()
