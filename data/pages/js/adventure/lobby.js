let adventureLobby, adventureLobbyView, adventureFamilies = [], selectedFamily = 'skirmish', lobbyBusy = false
const lobbyElement = id => document.getElementById(id)
const lobbyStatus = message => { lobbyElement('lobbyStatus').textContent = message }
function lobbyNode(tag, text, className) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}
function renderAdventureTeam() {
  const tabs = lobbyElement('families'); tabs.replaceChildren()
  for (const family of adventureFamilies) {
    const button = lobbyNode('button', family.name)
    button.setAttribute('aria-pressed', String(family.id === selectedFamily))
    button.onclick = async () => {
      try {
        if (adventureLobby) await adventureLobby.request('selectTeam', { familyId: family.id })
        selectedFamily = family.id; renderAdventureTeam()
      } catch (error) { lobbyStatus(error.message) }
    }
    tabs.append(button)
  }
  const preview = lobbyElement('teamPreview'); preview.replaceChildren()
  for (const member of adventureFamilies.find(f => f.id === selectedFamily)?.team || []) {
    const card = lobbyNode('article', '', 'piece-card'), image = lobbyNode('img')
    image.src = 'images/' + member.image; image.alt = member.name
    const copy = lobbyNode('div', '', 'piece-copy')
    copy.append(lobbyNode('span', member.role, 'piece-role'), lobbyNode('h3', member.name), lobbyNode('p', member.description))
    card.append(image, copy); preview.append(card)
  }
}
function renderAdventureLobby(value) {
  adventureLobbyView = value
  lobbyElement('roomInfo').hidden = false
  lobbyElement('roomLabel').textContent = '房间 ' + value.roomId
  const seats = lobbyElement('seats'); seats.replaceChildren()
  for (let i = 0; i < 4; i++) {
    const row = lobbyNode('article', '', 'room-seat'), seat = value.seats[i]
    if (seat) {
      const family = adventureFamilies.find(f => f.id === seat.familyId), copy = lobbyNode('div')
      if (family) {
        const image = lobbyNode('img'); image.src = 'images/' + family.team[0].image; image.alt = family.team[0].name; row.append(image)
      }
      copy.append(lobbyNode('strong', seat.name + (seat.playerId === value.hostId ? ' · 房主' : '')),
        lobbyNode('p', (family?.name || '初始队伍') + ' · ' + (!seat.connected ? '离线' : seat.ready ? '已准备' : '选队中')))
      row.append(copy)
    } else row.append(lobbyNode('span', '＋ 等待同行者'))
    seats.append(row)
  }
  const mine = value.seats.find(s => s.playerId === adventureLobby.playerId), host = value.hostId === adventureLobby.playerId
  lobbyElement('ready').textContent = mine?.ready ? '取消准备' : '准备'
  lobbyElement('ready').hidden = !mine || Boolean(value.snapshot)
  if (!mine) lobbyStatus('已申请加入，等待房主在节点结算后接纳。')
  lobbyElement('start').hidden = !host
  lobbyElement('start').disabled = value.seats.some(s => !s.connected || s.playerId !== value.hostId && !s.ready)
  lobbyElement('partyDifficulty').textContent = value.seats.length + ' 人同行 · 敌方随参战人数增加援兵与首领生命。'
  if (value.snapshot) location.href = 'battle.html?mode=adventure&roomId=' + encodeURIComponent(value.roomId) + '&server=' + encodeURIComponent(adventureLobby.server)
}
async function connectAdventureLobby(join) {
  if (lobbyBusy) return false
  lobbyBusy = true
  try {
    if (!adventureFamilies.length) throw new Error('队伍资料尚未加载，请稍后重试')
    if (adventureLobby) await adventureLobby.dispose()
    adventureLobby = undefined
    lobbyStatus('正在连接冒险服务…')
    adventureLobby = await RvBAdventureNetwork.connect({ server: lobbyElement('server').value.trim() || undefined,
      familyId: selectedFamily, roomId: join ? lobbyElement('roomCode').value.trim() : undefined })
    adventureLobby.subscribe(renderAdventureLobby)
    adventureLobby.onConnection((connected, message) => { if (!connected) lobbyStatus(message) })
    lobbyStatus('房间已建立。将房间号发给队友，准备好后即可出发。')
    return true
  } catch (error) { lobbyStatus(error.message); return false }
  finally { lobbyBusy = false }
}
async function startAdventure(saveId) {
  try { await adventureLobby.request('start', saveId ? { saveId } : {}) }
  catch (error) { lobbyStatus(error.message) }
}
async function listAdventureSaves() {
  if (!adventureLobby && !await connectAdventureLobby(false)) return
  lobbyElement('saveDialog').showModal()
  const list = lobbyElement('saves'); list.textContent = '正在读取存档…'
  try {
    const saves = await adventureLobby.request('saves'); list.replaceChildren()
    if (!saves.length) { list.textContent = '还没有这台服务器上的旅途存档。'; return }
    for (const save of saves) {
      const button = lobbyNode('button', (save.kind === 'manual' ? '手动存档' : '自动存档') + ' · 第 ' + save.actNumber + ' 幕 · ' + new Date(save.savedAt).toLocaleString() + ' · 进度 ' + save.revision)
      button.onclick = () => { lobbyElement('saveDialog').close(); void startAdventure(save.runId) }; list.append(button)
    }
  } catch (error) { list.textContent = error.message }
}
lobbyElement('solo').onclick = async () => { if (await connectAdventureLobby(false)) await startAdventure() }
lobbyElement('create').onclick = () => connectAdventureLobby(false)
lobbyElement('openJoin').onclick = () => lobbyElement('joinDialog').showModal()
lobbyElement('joinForm').onsubmit = async event => { event.preventDefault(); lobbyElement('joinDialog').close(); await connectAdventureLobby(true) }
lobbyElement('resume').onclick = listAdventureSaves
lobbyElement('start').onclick = () => startAdventure()
lobbyElement('ready').onclick = async () => {
  try { await adventureLobby.request('ready', { ready: !adventureLobbyView?.seats.find(s => s.playerId === adventureLobby.playerId)?.ready }) }
  catch (error) { lobbyStatus(error.message) }
}
lobbyElement('copyRoom').onclick = async () => {
  try { await navigator.clipboard.writeText(adventureLobby.roomId); lobbyStatus('房间号已复制。') }
  catch { lobbyStatus('房间号：' + adventureLobby.roomId) }
}
lobbyElement('leave').onclick = async () => {
  if (adventureLobby) await adventureLobby.dispose()
  adventureLobby = undefined; adventureLobbyView = undefined; lobbyElement('roomInfo').hidden = true; lobbyStatus('已离开房间。')
}
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close()
fetch('./data/pve/roguelike/builds.json', { cache: 'no-store' }).then(response => {
  if (!response.ok) throw new Error('无法加载队伍资料')
  return response.json()
}).then(data => { adventureFamilies = data.families; renderAdventureTeam() }).catch(error => lobbyStatus(error.message))
async function refreshAdventureRooms() {
  const status = lobbyElement('roomsStatus'), list = lobbyElement('roomCatalog'), refresh = lobbyElement('refreshRooms')
  refresh.disabled = true; status.textContent = '正在寻找冒险房间…'
  try {
    const server = String(lobbyElement('server').value.trim() || window.RvBUtils?.getServerUrl?.() || 'http://127.0.0.1:2567').replace(/\/+$/, '').replace(/^ws/, 'http')
    const response = await fetch(server + '/rooms?mode=pve', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('房间列表读取失败（' + response.status + '）')
    const { rooms } = await response.json(); list.replaceChildren()
    for (const room of rooms) {
      const card = lobbyNode('article', '', 'catalog-room'), portraits = lobbyNode('div', '', 'catalog-portraits')
      for (const team of room.teams || []) {
        const family = adventureFamilies.find(f => f.id === team.familyId)
        if (family) { const image = lobbyNode('img'); image.src = 'images/' + family.team[0].image; image.alt = team.name + ' · ' + family.name; portraits.append(image) }
      }
      const join = lobbyNode('button', !room.joinable ? '暂不可加入' : room.players >= room.maxPlayers && room.takeoverAvailable ? '申请接管缺席队伍' : room.status === 'playing' ? '申请中途加入' : '加入房间')
      join.disabled = !room.joinable
      join.onclick = async () => { lobbyElement('roomCode').value = room.id; if (await connectAdventureLobby(true)) lobbyElement('roomInfo').scrollIntoView({ behavior: 'smooth', block: 'center' }) }
      card.append(lobbyNode('h3', room.name), lobbyNode('p', room.players + ' / ' + room.maxPlayers + ' 人 · ' + (room.status === 'playing' ? '冒险中' : '准备中')), portraits, join)
      list.append(card)
    }
    status.textContent = rooms.length ? '加入准备房间，或在队伍结算后申请中途加入。' : '还没有公开的冒险房间。可以创建房间邀请队友。'
  } catch (error) {
    list.replaceChildren(); status.textContent = '暂时无法连接冒险服务器。请检查连接设置或启动本机服务。'
    status.title = error.message
  } finally { refresh.disabled = false }
}
lobbyElement('refreshRooms').onclick = refreshAdventureRooms
lobbyElement('server').onchange = refreshAdventureRooms
void refreshAdventureRooms()
