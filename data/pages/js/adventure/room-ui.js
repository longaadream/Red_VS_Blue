window.renderAdventureRoomStatus = function (value) {
  ensureAdventureUI()
  let button = document.getElementById('adventureRoomButton')
  if (!button) {
    button = adventureButton('同行者', () => {})
    button.id = 'adventureRoomButton'; document.getElementById('adventureWallet').append(button)
  }
  button.textContent = '同行者 ' + value.seats.filter(s => s.connected).length + '/' + value.seats.length
  button.onclick = () => {
    const dialog = document.getElementById('adventureDialog'), body = document.getElementById('adventureDialogContent')
    adventureDialogKind = null
    document.getElementById('adventureDialogTitle').textContent = '同行者 · ' + value.roomId
    body.replaceChildren()
    for (const seat of value.seats) {
      const row = document.createElement('p'); row.textContent = seat.name + (seat.connected ? ' · 已连接' : ' · 离线')
      body.append(row)
    }
    const order = document.createElement('p'); order.textContent = '本轮顺序：' + (value.snapshot?.world.order || []).map(id => value.seats.find(s => s.playerId === id)?.name || id).join(' → ') + ' → 敌方'
    const saved = document.createElement('p'); saved.textContent = value.savedAt ? '上次保存：' + new Date(value.savedAt).toLocaleString() : '尚未保存'
    const save = adventureButton('保存冒险', async () => {
      save.disabled = true
      try { await adventureClient.network.request('save'); saved.textContent = '已保存' }
      catch (error) { saved.textContent = error.message; save.disabled = false }
    })
    save.disabled = value.hostId !== value.playerId || !adventureSnapshot?.world.canSave
    const hint = document.createElement('p'); hint.textContent = '所有战区和奖励结算后由房主保存。房主服务关闭后，从最近存档继续。'
    body.append(order, saved, save, hint)
    if(value.hostId===value.playerId)for(const incoming of value.waiting || []) {
      const row=document.createElement('p');row.textContent=incoming.name+' 希望加入'
      const admit=adventureButton('接纳新队伍',async()=>{
        try{await adventureClient.network.request('admit',{playerId:incoming.playerId});dialog.close()}catch(error){hint.textContent=error.message}
      });admit.disabled=!adventureSnapshot?.world.canSave||value.seats.length>=4
      row.append(admit)
      for(const seat of value.seats.filter(s=>!s.connected)){
        const takeover=adventureButton('接管 '+seat.name,async()=>{
          try{await adventureClient.network.request('takeover',{playerId:incoming.playerId,seatId:seat.playerId});dialog.close()}catch(error){hint.textContent=error.message}
        });takeover.disabled=!adventureSnapshot?.world.canSave;row.append(takeover)
      }
      body.append(row)
    }
    if (!dialog.open) dialog.showModal()
  }
}
