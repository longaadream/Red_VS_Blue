(async function () {
  'use strict'
  const el = id => document.getElementById(id)
  const presets = RvBDeckPresets.parse(localStorage.getItem(RvBDeckPresets.STORAGE_KEY)).presets
  let client, catalog, busy = false, dead = false
  const selected = { human: [], ai: [] }
  const seed = () => crypto.getRandomValues(new Uint32Array(1))[0]
  const alignment = side => el(side + 'Alignment').value
  function message(text, error) { el('setupStatus').textContent = text; el('setupStatus').classList.toggle('error', !!error) }
  function validPresets(side) { return presets.filter(p => p.alignment === alignment(side) && RvBDeckPresets.isValidSelection(p.pieceIds, p.alignment, catalog.pieces)) }
  function render(side) {
    const auto = side === 'ai' && el('aiMode').value === 'auto'
    const pieces = catalog.pieces.filter(p => p.faction === alignment(side) && (!auto || selected.ai.includes(p.id)))
    el(side + 'Count').textContent = selected[side].length + ' / 8'
    el(side + 'Pieces').replaceChildren(...pieces.map(piece => {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'piece-choice' + (selected[side].includes(piece.id) ? ' selected' : '')
      button.setAttribute('aria-pressed', String(selected[side].includes(piece.id)))
      if (auto) button.setAttribute('aria-disabled', 'true')
      if (piece.image && /^[a-zA-Z0-9_./-]+$/.test(piece.image) && !piece.image.includes('..')) {
        const image = document.createElement('img'); image.src = 'images/' + piece.image; image.alt = ''; image.loading = 'lazy'
        image.onerror = () => { image.hidden = true }; button.append(image)
      }
      const name = document.createElement('span'); name.textContent = piece.name; button.append(name)
      const stats = document.createElement('small'); stats.textContent = '攻 ' + piece.stats.attack + ' · 血 ' + piece.stats.maxHp; button.append(stats)
      button.onclick = () => {
        if (busy || auto) return
        if (selected[side].includes(piece.id)) selected[side] = selected[side].filter(id => id !== piece.id)
        else if (selected[side].length < 8) selected[side].push(piece.id)
        else { message('每组最多8枚棋子，请先取消一枚'); return }
        el(side + 'Preset').value = ''; render(side); ready()
      }
      return button
    }))
  }
  function updatePresets(side) {
    el(side + 'Preset').replaceChildren(new Option('手动选棋', ''), ...validPresets(side).map(p => new Option(p.name, p.id)))
  }
  function ready() {
    el('startPractice').disabled = busy || !['human', 'ai'].every(side => RvBDeckPresets.isValidSelection(selected[side], alignment(side), catalog.pieces))
    if (!el('startPractice').disabled) message('棋组已就位，可以开始练习。')
  }
  function setBusy(value) {
    busy = value
    document.querySelectorAll('.roster-columns select, .roster-columns button').forEach(control => { control.disabled = value })
    ready()
  }
  async function choose(side) {
    if (busy) return
    setBusy(true)
    try { selected[side] = (await client.request('choose', { alignment: alignment(side), seed: seed(), presets: validPresets(side) })).pieceIds; render(side) }
    catch (error) { message(error.message, true) }
    finally { setBusy(false) }
  }
  window.addEventListener('pagehide', () => { dead = true; client?.dispose() })
  try {
    client = await RvBPracticeClient.create()
    if (dead) { client.dispose(); return }
    catalog = await client.request('catalog')
    el('mapId').replaceChildren(...catalog.maps.map(map => new Option(map.name, map.id)))
    for (const side of ['human', 'ai']) {
      updatePresets(side)
      el(side + 'Alignment').onchange = async () => {
        selected[side] = []; updatePresets(side); render(side); ready()
        if (side === 'ai' && el('aiMode').value === 'auto') await choose(side)
      }
      el(side + 'Preset').onchange = () => {
        const preset = validPresets(side).find(p => p.id === el(side + 'Preset').value)
        if (preset) selected[side] = [...preset.pieceIds]
        render(side); ready()
      }
      render(side)
    }
    el('humanFill').onclick = () => choose('human')
    el('aiReroll').onclick = () => choose('ai')
    el('aiMode').onchange = async () => {
      const auto = el('aiMode').value === 'auto'
      el('aiAutoTools').hidden = !auto; el('aiPresetField').hidden = auto
      if (auto) await choose('ai'); else render('ai')
    }
    el('startPractice').onclick = () => {
      if (el('startPractice').disabled) return
      const config = { human: { alignment: alignment('human'), pieceIds: selected.human }, ai: { alignment: alignment('ai'), pieceIds: selected.ai },
        humanFirst: el('humanFirst').value === 'true', mapId: el('mapId').value, seed: seed() }
      sessionStorage.setItem('rvb_practice_setup', JSON.stringify(config))
      location.href = 'battle.html?mode=practice'
    }
    await choose('ai')
    message('选择你的8枚棋子，也可以加载已保存的棋组。')
  } catch (error) { message('无法准备练习：' + error.message, true); client?.dispose() }
})()
