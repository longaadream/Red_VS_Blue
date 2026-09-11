let adventureSiteId = null
let adventureDeployPieceId = null
let adventureCampTargetId = null
let adventureDialogKind = null
let adventureDecorationKey = null
let adventureFocusedAct = null
let adventureFocusedRegion = null
let adventureSupplyPromptRevision = -1
const adventureStampCache = new Map()
const adventureIconPaths = {
  camp: '<path d="M3 20 11 4l10 16H3Zm8-16 2 16m-6 0 5-8 5 8M8 4l7-2"/>',
  supply: '<path d="m8 4 8 1-1 4c5 3 6 11 2 12H6C2 20 3 13 8 9L8 4Zm0 5h7m-6 5h5m-6 3h8"/>',
  cart: '<path d="M3 7h16l-2 10H6L3 4H1m6 3V3h7v4m-4 1v7m5-7-1 7"/><circle cx="7" cy="21" r="1.5"/><circle cx="17" cy="21" r="1.5"/>',
  gate: '<path d="M6 22V3m0 1 13 2-3 4 3 4-13-2M2 22h9"/>',
  keep: '<path d="M3 21V5h4v4h3V3h4v6h3V5h4v16H3Zm6 0v-6q3-4 6 0v6M2 22h20"/>',
  exit: '<path d="M4 22V3h13v19M4 3l9 4v15M9 13h1m7-3 5 3-5 3m-4-3h9"/>',
  recruit: '<circle cx="9" cy="7" r="4"/><path d="M2 22v-4a7 7 0 0 1 14 0v4M19 8v8m-4-4h8"/>',
}
function adventureSiteIcon(site) {
  return adventureIconPaths[site.id] ? site.id : ({loot:'supply',encounter:'gate'}[site.kind] || site.kind)
}
function adventureIcon(id) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + adventureIconPaths[id] + '</svg>'
}
function adventurePortrait(piece, onClick, badge) {
  const button = document.createElement('button'); button.className = 'adventure-portrait'
  const template = PIECES_BY_ID[piece.templateId] || {}
  const img = document.createElement('img'); img.src = '/images/' + (template.image || 'reaper.jpg'); img.alt = piece.name
  const name = document.createElement('span'); name.textContent = piece.name
  const health = document.createElement('meter'); health.min = 0; health.max = piece.maxHp; health.value = piece.currentHp
  const stamp = document.createElement('b'); stamp.textContent = badge || ''; stamp.className = 'adventure-stamp'
  button.title = piece.name + ' · ' + piece.currentHp + '/' + piece.maxHp + ' · ' + (window.adventurePieceWarning?.(piece) || '')
  button.setAttribute('aria-label', (badge === '+' ? '部署 ' : '查看 ') + piece.name + '，生命 ' + piece.currentHp + '/' + piece.maxHp)
  button.append(img,stamp,name,health); button.onclick = onClick
  button.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); showPieceInfo(piece.instanceId) }
  return button
}
function adventureButton(label, action, className) {
  const button = document.createElement('button')
  button.type = 'button'; button.textContent = label; button.onclick = action
  if (className) button.className = className
  return button
}
function adventureActor() {
  return G?.pieces.find(p => p.instanceId === selectedPieceId && p.ownerPlayerId === myPlayerId && p.currentHp > 0)
    || G?.pieces.find(p => p.instanceId === adventureSnapshot?.world.captainId && p.currentHp > 0)
}
function ensureAdventureUI() {
  if (document.getElementById('adventureWallet')) return
  const wallet = document.createElement('nav'); wallet.id = 'adventureWallet'; wallet.setAttribute('aria-label', '冒险资源与菜单')
  const coins = document.createElement('output'); coins.id = 'adventureCoins'; coins.setAttribute('aria-live', 'polite')
  const mobileAp = document.createElement('output'); mobileAp.id = 'adventureMobileAp'; mobileAp.setAttribute('aria-label', '行动点')
  const supplies = adventureButton('构筑', () => openAdventureDialog('supplies')); supplies.id = 'adventureSuppliesButton'
  const act = adventureButton('', () => openAdventureDialog('sites')); act.id = 'adventureAct'
  const reward = adventureButton('战利品', () => openAdventureDialog('rewards')); reward.id = 'adventureRewardButton'; reward.hidden = true
  wallet.append(act, coins, mobileAp, reward, adventureButton('地点', () => openAdventureDialog('sites')), supplies, adventureButton('手记', () => openAdventureDialog('notes')))
  const partyToggle = adventureButton('队伍', () => {
    const open = document.body.classList.toggle('adventure-party-open')
    partyToggle.setAttribute('aria-expanded', String(open))
  }); partyToggle.id = 'adventurePartyToggle'; partyToggle.setAttribute('aria-expanded', 'false'); partyToggle.setAttribute('aria-controls', 'adventurePartyDock')
  const menuToggle = adventureButton('冒险', () => {
    const open = wallet.classList.toggle('is-expanded'); menuToggle.setAttribute('aria-expanded', String(open))
  }); menuToggle.id = 'adventureMenuToggle'; menuToggle.setAttribute('aria-expanded', 'false')
  wallet.append(partyToggle, menuToggle)
  const dock = document.createElement('aside'); dock.id = 'adventurePartyDock'; dock.setAttribute('aria-label', '冒险队伍')
  const encounter = adventureButton('', () => openAdventureDialog('site', adventureSnapshot.world.active)); encounter.id = 'adventureEncounter'
  const dialog = document.createElement('dialog'); dialog.id = 'adventureDialog'; dialog.setAttribute('aria-labelledby', 'adventureDialogTitle')
  const header = document.createElement('header'), title = document.createElement('h2'); title.id = 'adventureDialogTitle'
  const close = adventureButton('×', () => dialog.close()); close.setAttribute('aria-label', '关闭冒险弹窗'); close.autofocus = true
  header.append(title, close)
  const content = document.createElement('div'); content.id = 'adventureDialogContent'
  dialog.append(header, content)
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if(event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close() } })
  dialog.addEventListener('close', () => { adventureDialogKind = null; adventureSiteId = null; syncAdventureBoard() })
  const interaction = document.createElement('nav'); interaction.id = 'adventureSiteActions'; interaction.setAttribute('aria-label', '附近地点操作')
  document.body.append(wallet, dock, encounter, dialog, interaction)
}
function openAdventureDialog(kind, siteId) {
  ensureAdventureUI()
  document.getElementById('adventureWallet').classList.remove('is-expanded')
  document.getElementById('adventureMenuToggle').setAttribute('aria-expanded', 'false')
  adventureDialogKind = kind; adventureSiteId = siteId || null
  renderAdventureDialog(); syncAdventureBoard()
  const dialog = document.getElementById('adventureDialog')
  if (!dialog.open) dialog.showModal()
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Called by battle.html's board click handler.
function adventureOpenCell(x, y) {
  if (pendingSkill || pendingCardAction || pendingActionFeedback || targetSubmissionPending || adventureBusy) return false
  if (G.pendingTargetSelection || G.pendingOptionSelection) return false
  const occupant = G.pieces.find(p => p.currentHp > 0 && p.x === x && p.y === y)
  // A piece click must retain the native selection/movement menu, even on a site.
  if (occupant) return false
  // Legal moves and deployment keep their native click/drag behavior.
  if (!occupant && pendingMove && validMoves.has(x + ',' + y)) return false
  const site = adventureSnapshot?.world.sites.find(s => s.x === x && s.y === y)
  if (!site) return false
  openAdventureDialog('site', site.id); return true
}
// Refreshed by battle.html after native selection changes.
function refreshAdventureSiteActions() {
  const container = document.getElementById('adventureSiteActions'), world = adventureSnapshot?.world
  if (!container || !world) return
  container.replaceChildren()
  const actor = adventureActor()
  const blocked = world.active || adventureBusy || adventureStopped || pendingSkill || pendingCardAction || pendingActionFeedback || targetSubmissionPending || adventureDeployPieceId || G.pendingTargetSelection || G.pendingOptionSelection
  if (blocked || !actor || actor.x === null || actor.y === null) { container.hidden = true; return }
  const sites = world.sites.filter(site => site.kind !== 'encounter' && Math.abs(site.x - actor.x) + Math.abs(site.y - actor.y) <= 1)
  container.hidden = !sites.length
  for (const site of sites) container.append(adventureButton('交互 · ' + site.name, () => openAdventureDialog('site', site.id)))
}
function renderAdventureReward(content) {
  const reward = adventureSnapshot.world.lastReward
  if (!reward) { const empty = document.createElement('p'); empty.textContent = '击败敌人后在此查看战利品。'; content.append(empty); return }
  const heading = document.createElement('h3'); heading.textContent = (reward.kind === 'roaming' ? '游敌击败 · ' : '据点攻克 · ') + reward.name
  const coins = document.createElement('p'); coins.className = 'adventure-reward-coins'; coins.textContent = '＋' + reward.coins + ' 金币 · 已入账'
  content.append(heading, coins)
}
function focusAdventureAct(force = false) {
  const world = adventureSnapshot?.world, key = world && [world.seed, world.actNumber || 1, G.map.id, adventureSnapshot.revision].join(':')
  if (!world || !force && key === adventureFocusedAct) return
  const zone = world.zones?.find(zone => zone.id === world.active)
  const region = [world.seed, world.actNumber || 1, world.active || 'explore'].join(':')
  if (zone && !force && region === adventureFocusedRegion) { adventureFocusedAct = key; return }
  const cellPixels = window.matchMedia('(orientation: landscape) and (max-height: 600px)').matches && (force || region !== adventureFocusedRegion) ? 44 : undefined
  if (zone && window.BattleRenderer3D?.focusCell?.(zone.x + (zone.width - 1) / 2, zone.y + (zone.height - 1) / 2, cellPixels)) { adventureFocusedAct = key; adventureFocusedRegion = region; return }
  const captain = G.pieces.find(p => p.instanceId === world.captainId && p.currentHp > 0)
  if (captain && captain.x !== null && captain.y !== null && window.BattleRenderer3D?.focusCell?.(captain.x, captain.y, cellPixels)) { adventureFocusedAct = key; adventureFocusedRegion = region }
}
window.focusAdventureContext = () => { if (!adventureSnapshot?.world) return false; focusAdventureAct(true); return true }
function selectAdventurePartyPiece(piece) {
  selectPiece(piece.instanceId)
  if (piece.x !== null && piece.y !== null) window.BattleRenderer3D?.focusCell?.(piece.x, piece.y)
}
function renderAdventureWorld() {
  const world = adventureSnapshot?.world
  if (!world) return
  ensureAdventureUI()
  document.querySelector('#boardStage3d canvas')?.setAttribute('aria-label','冒险棋盘，' + G.map.width + '×' + G.map.height + ' 格，可拖动平移、滚轮或双指缩放')
  document.getElementById('adventureAct').textContent = world.name || '第 ' + (world.actNumber || 1) + ' 幕 · 旧城边境'
  document.getElementById('adventureRewardButton').hidden = !world.lastReward
  document.getElementById('adventureCoins').textContent = '◉ 金币 ' + world.coins
  document.getElementById('adventureMobileAp').textContent = '⚡ ' + (G.players.find(p => p.playerId === myPlayerId)?.actionPoints ?? 0)
  const dock = document.getElementById('adventurePartyDock'); dock.replaceChildren()
  const title = document.createElement('strong'); title.textContent = '冒险队伍'; dock.append(title)
  const row = document.createElement('div'); row.className = 'adventure-party'
  for (const piece of G.pieces.filter(p => p.ownerPlayerId === myPlayerId && p.currentHp > 0)) {
    row.append(adventurePortrait(piece, () => selectAdventurePartyPiece(piece), piece.instanceId === world.captainId ? '♛' : ''))
  }
  const reserve = adventureSnapshot.deployment
  for (const piece of reserve.pieces) {
    const unavailable = !!world.active && (!reserve.cells.length || adventureBusy || adventureStopped)
    const card = adventurePortrait(piece, () => {
      if (unavailable) return
      if (!world.active) { adventureCampTargetId = piece.instanceId; openAdventureDialog('reserve'); return }
      adventureDeployPieceId = adventureDeployPieceId === piece.instanceId ? null : piece.instanceId
      document.body.classList.remove('adventure-party-open')
      document.getElementById('adventurePartyToggle').setAttribute('aria-expanded', 'false')
      pendingSkill = null; pendingCardAction = null; selectedPieceId = null
      render(); renderAdventureWorld(); setStatusMsg(adventureDeployPieceId ? '点击高亮格 · 免费部署' : '已取消部署')
    }, world.active ? (adventureDeployPieceId === piece.instanceId ? '×' : '+') : '备')
    card.classList.toggle('is-picked', adventureDeployPieceId === piece.instanceId)
    card.setAttribute('aria-disabled', String(unavailable))
    const entry = document.createElement('div'); entry.className = 'adventure-reserve-entry'
    const details = adventureButton('详情', () => showPieceInfo(piece.instanceId), 'adventure-reserve-details')
    details.setAttribute('aria-label', '查看 ' + piece.name + ' 详情')
    entry.append(card, details); row.append(entry)
  }
  dock.append(row)
  const hint = document.createElement('small'); hint.textContent = world.active ? (reserve.used ? '本轮已部署' : '每轮免费部署 1 枚') : '探索 · 每回合 3 行动点'; dock.append(hint)
  const encounter = document.getElementById('adventureEncounter'); encounter.hidden = !world.active
  encounter.textContent = world.active ? '⚔ 第 ' + world.battleRound + ' 轮 · 查看敌方预告' : ''
  if (document.getElementById('adventureDialog').open) renderAdventureDialog()
  document.getElementById('adventureSuppliesButton').textContent = adventureHasSupplyChoice() ? '补给待选' : '构筑'
  if (adventureHasSupplyChoice() && !G.pendingOptionSelection && !G.pendingTargetSelection && adventureSupplyPromptRevision !== adventureSnapshot.revision) {
    adventureSupplyPromptRevision = adventureSnapshot.revision; openAdventureDialog('supplies')
  }
  if (world.forecast && !world.forecast.complete) { const note = document.createElement('small'); note.textContent = '死亡预测暂不可用'; note.title = world.forecast.note; dock.append(note) }
  refreshAdventureControls(); refreshAdventureSiteActions(); syncAdventureBoard(); focusAdventureAct()
}
function adventureEnemyPlans(piece) {
  const snapshot = adventureSnapshot, world = snapshot?.world
  if (!world || piece.ownerPlayerId !== (snapshot.aiPlayerId || G.extensions?.adventureWorld?.coop?.enemyId || 'adventure-enemy')) return null
  return (world.plans || []).filter(plan => plan.sourceId === piece.instanceId)
}
function adventurePlanLabel(plan) {
  if (plan.kind === 'move') return '移动'
  const sid = plan.action?.skillId
  const name = sid && typeof skillDefOf === 'function' ? skillDefOf(sid)?.name : null
  return (name || sid || (plan.kind === 'summon' ? '召唤' : '攻击')) + (plan.trackingTargetId ? '（锁定）' : '')
}
window.adventureEnemyLevel = piece => adventureEnemyPlans(piece) === null ? null : 1 + (G.extensions?.adventureWorld?.enemyLevels?.[piece.instanceId]?.level || 0)
window.adventureEnemyIntent = piece => {
  const plans = adventureEnemyPlans(piece)
  if (!plans) return ''
  return plans.length ? '下次行动：' + plans.map(adventurePlanLabel).join(' → ') : '暂无行动预告'
}
window.adventureSkillIntent = (piece, skillId, passive) => {
  const plans = adventureEnemyPlans(piece)
  if (!plans) return null
  if (passive) return '条件触发'
  if (plans.some(plan => plan.action?.skillId === skillId)) return '即将使用'
  return plans.length ? '本轮不使用' : '未列入预告'
}
function renderAdventureEnemies(section, site) {
  const world = adventureSnapshot.world, enemies = document.createElement('div'); enemies.className = 'adventure-enemies'
  const members = [...world.enemies.filter(p => p.zone === site.id)]
  const zone = world.zones?.find(zone => zone.id === site.id)
  if (world.active === site.id && zone) for (const p of G.pieces.filter(p => adventureEnemyPlans(p) !== null && p.currentHp > 0 && p.x !== null && p.y !== null && p.x >= zone.x && p.y >= zone.y && p.x < zone.x + zone.width && p.y < zone.y + zone.height && !world.enemies.some(m => m.id === p.instanceId))) members.push({id:p.instanceId,tier:'minion',ip:'魔兽世界',role:'召唤物'})
  for (const member of members) {
    const piece = G.pieces.find(p => p.instanceId === member.id && p.currentHp > 0)
    if (!piece) continue
    const card = adventurePortrait(piece, () => { document.getElementById('adventureDialog').close(); selectedPieceId = piece.instanceId; render() }, member.tier === 'boss' ? '♛' : member.tier === 'elite' ? '◆' : '')
    card.title = piece.name + ' · ' + member.ip + ' · ' + member.role + (member.core ? ' · 核心' : '')
    card.classList.add('tier-' + member.tier)
    const plans = adventureEnemyPlans(piece)
    if (plans?.length) { const intent = document.createElement('small'); intent.className = 'adventure-intent-chip'; intent.textContent = '等级 ' + window.adventureEnemyLevel(piece) + ' · 下次：' + plans.map(adventurePlanLabel).join(' → '); card.append(intent) }
    enemies.append(card)
  }
  section.append(enemies)
}
function renderAdventureDialog() {
  const world = adventureSnapshot.world, content = document.getElementById('adventureDialogContent'), title = document.getElementById('adventureDialogTitle')
  const focused = document.activeElement, focusKey = focused?.dataset.operation
  content.replaceChildren()
  if (adventureDialogKind === 'supplies') {
    title.textContent = '随身遗物与补给'; if (world.lastReward) renderAdventureReward(content); renderAdventureSupplies(content)
  } else if (adventureDialogKind === 'rewards') {
    title.textContent = '战利品'; renderAdventureReward(content)
    if (adventureHasSupplyChoice()) content.append(adventureButton('选择卡牌与遗物', () => openAdventureDialog('supplies'), 'adventure-supply-choice'))
  } else if (adventureDialogKind === 'sites') {
    title.textContent = '第 ' + (world.actNumber || 1) + ' / ' + (world.actCount || 3) + ' 幕 · ' + (world.name || '旧城边境')
    const progress = document.createElement('p'); progress.textContent = '据点 ' + world.cleared.length + ' / ' + world.zones.length; content.append(progress)
    const list = document.createElement('div'); list.className = 'adventure-site-list'
    for (const site of world.sites) {
      const button = adventureButton('', () => openAdventureDialog('site', site.id))
      button.innerHTML = adventureIcon(adventureSiteIcon(site))
      const label = document.createElement('span'); label.textContent = site.name
      const status = document.createElement('small'); status.textContent = world.claimed.includes(site.id) || world.cleared.includes(site.id) ? '已完成' : site.kind === 'exit' ? (world.actReady ? '可前往下一幕' : '先攻克本幕据点') : site.kind === 'camp' ? '休整 / 强化' : site.kind === 'encounter' ? '遭遇战' : site.kind === 'recruit' ? '招募同行者' : '物资'
      button.append(label, status); list.append(button)
    }
    content.append(list)
  } else if (adventureDialogKind === 'notes') {
    title.textContent = '冒险手记'
    const seed = document.createElement('p'); seed.textContent = '地图种子：' + world.seed + ' · 同一幕中保持原图'; content.append(seed)
    for (const text of ['探索 3 点；战斗从 1 点增长至 10 点。每轮免费部署 1 枚。', '获胜后收队。阵亡队长以 1 点生命复活。', '敌方按预告顺序行动，不消耗行动点，不重新瞄准。攻击格无人时落空；来源死亡、移动路径或召唤格被占时取消。', ...world.log.slice(0, 6)]) { const p = document.createElement('p'); p.textContent = text; content.append(p) }
  } else if (adventureDialogKind === 'reserve') {
    const piece = adventureSnapshot.deployment.pieces.find(p => p.instanceId === adventureCampTargetId)
    title.textContent = piece?.name || '预备队员'
    const p = document.createElement('p'); p.textContent = piece ? '生命 ' + piece.currentHp + '/' + piece.maxHp + ' · 攻击 ' + piece.attack + ' · 防御 ' + piece.defense : ''
    const hint = document.createElement('p'); hint.textContent = '进入战斗后，可在队长附近免费部署。'; content.append(p, hint)
  } else {
    const site = world.sites.find(s => s.id === adventureSiteId)
    if (!site) return
    title.textContent = site.name
    const description = document.createElement('p'); description.textContent = site.detail; content.append(description)
    if (site.kind === 'encounter') renderAdventureEnemies(content, site)
    else if (site.kind === 'exit') {
      const operations = document.createElement('div'); operations.className = 'adventure-operations'
      const advance = adventureButton('前往下一幕', () => adventureInteract(site.id, 'advance')); advance.dataset.operation = 'advance'; operations.append(advance)
      const hint = document.createElement('p'); hint.id = 'adventureInteractionHint'; content.append(operations, hint)
    }
    else if (world.claimed.includes(site.id)) { const p = document.createElement('p'); p.textContent = site.kind === 'recruit' ? '✓ 同行者已加入队伍' : '✓ 已领取'; content.append(p) }
    else if (site.kind === 'recruit') renderAdventureRecruitment(content, site)
    else {
      if (site.kind === 'camp') {
        const select = document.createElement('select'); select.setAttribute('aria-label', '强化队员')
        const targets = [...G.pieces, ...adventureSnapshot.deployment.pieces].filter(p => p.ownerPlayerId === myPlayerId && p.currentHp > 0)
        if (!targets.some(p => p.instanceId === adventureCampTargetId)) adventureCampTargetId = world.captainId
        for (const piece of targets) { const option = document.createElement('option'); option.value = piece.instanceId; option.textContent = piece.name; select.append(option) }
        select.value = adventureCampTargetId; select.onchange = () => { adventureCampTargetId = select.value; refreshAdventureControls() }; content.append(select)
      }
      const operations = site.kind === 'camp' ? [['heal','休整','全队恢复 40% 生命'],['attack','攻击 +1','20 金币'],['maxHp','生命 +1','20 金币'],['defense','防御 +1','20 金币']] : [['search','搜索','15 金币 · 消耗 1 行动点']]
      const buttons = document.createElement('div'); buttons.className = 'adventure-operations'
      for (const [operation,label,hint] of operations) {
        const button = adventureButton(label, () => adventureInteract(site.id, operation)); button.dataset.operation = operation
        const cost = document.createElement('small'); cost.textContent = hint; button.append(cost); buttons.append(button)
      }
      if (site.kind === 'camp' && world.recruitment) {
        const dismiss = adventureButton('遣散所选队员', () => adventureInteract(site.id, 'dismiss'))
        dismiss.dataset.operation = 'dismiss'
        const cost = document.createElement('small'); cost.textContent = world.recruitment.dismissPrice + ' 金币 · 队长不可遣散'; dismiss.append(cost); buttons.append(dismiss)
      }
      const hint = document.createElement('p'); hint.id = 'adventureInteractionHint'; content.append(buttons, hint)
    }
  }
  refreshAdventureControls()
  if (focusKey) content.querySelector('[data-operation="' + focusKey + '"]')?.focus({preventScroll:true})
}
function refreshAdventureControls() {
  const world = adventureSnapshot?.world
  if (!world) return
  const site = world.sites.find(s => s.id === adventureSiteId), actor = adventureActor()
  const near = site && actor && actor.x !== null && actor.y !== null && Math.abs(actor.x - site.x) + Math.abs(actor.y - site.y) <= 1
  const blocked = !near || !!world.active || adventureBusy || adventureStopped || G.turn.phase !== 'action' || adventureSnapshot.inputOwner !== myPlayerId
  document.querySelectorAll('#adventureDialog .adventure-operations button').forEach(button => {
    const unaffordable = ['attack','maxHp','defense'].includes(button.dataset.operation) ? world.coins < 20
      : button.dataset.operation === 'recruit' ? world.coins < world.recruitment.cost
      : button.dataset.operation === 'dismiss' ? world.coins < world.recruitment.dismissPrice || adventureCampTargetId === world.captainId
      : button.dataset.operation === 'search' && G.players.find(p => p.playerId === myPlayerId).actionPoints < 1
    button.disabled = blocked || world.claimed.includes(site?.id) || unaffordable || (button.dataset.operation === 'advance' && !world.actReady)
  })
  const hint = document.getElementById('adventureInteractionHint')
  if (hint) hint.textContent = world.active ? '战斗中无法使用设施' : site?.kind === 'exit' && !world.actReady ? '击败本幕首领后开放' : !near ? '队长或选中队员靠近后可使用' : ' '
}
function adventureStamp(kind, label, done) {
  const key = kind + ':' + label + ':' + done
  if (adventureStampCache.has(key)) return adventureStampCache.get(key)
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256
  const ctx = canvas.getContext('2d'), site = adventureIconPaths[kind]
  ctx.fillStyle = site ? (done ? '#abb18b' : '#d6c197') : ({move:'#537f8844',attack:'#ba553d66',summon:'#86609366'}[kind])
  ctx.strokeStyle = site ? '#49382b' : ({move:'#366a79',attack:'#923a2c',summon:'#6a477c'}[kind])
  ctx.lineWidth = 7
  if (site) { ctx.beginPath(); ctx.arc(128,128,116,0,Math.PI*2); ctx.fill(); ctx.stroke(); ctx.save(); ctx.translate(40,36); ctx.scale(7.2,7.2); ctx.lineWidth=1.8; ctx.lineCap='round'; ctx.lineJoin='round'
    for (const match of site.matchAll(/<path d="([^"]+)"/g)) ctx.stroke(new Path2D(match[1]))
    for (const match of site.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g)) { ctx.beginPath(); ctx.arc(+match[1],+match[2],+match[3],0,Math.PI*2); ctx.stroke() }
    ctx.restore()
    if (done) { ctx.fillStyle='#395833'; ctx.font='bold 70px sans-serif'; ctx.fillText('✓',170,77) }
  } else { ctx.fillRect(8,8,240,240); if(kind==='move')ctx.setLineDash([15,9]); ctx.strokeRect(8,8,240,240); ctx.setLineDash([]); ctx.fillStyle='#352d24'; ctx.strokeStyle='#eddbb6'; ctx.lineWidth=9; ctx.font='bold 80px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.strokeText(label,128,128); ctx.fillText(label,128,128) }
  adventureStampCache.set(key,canvas); return canvas
}
function syncAdventureBoard() {
  const world = adventureSnapshot?.world
  if (!world || !window.BattleRenderer3D?.setBoardDecorations) return
  const key = JSON.stringify([world.sites,world.claimed,world.cleared,world.active,world.zones,world.encounters,adventureSiteId,world.plans])
  if (key === adventureDecorationKey) return
  adventureDecorationKey = key
  const cells = [], lines = []
  for (const site of world.sites) cells.push({id:site.id,x:site.x,y:site.y,size:.85,lift:.035,image:adventureStamp(adventureSiteIcon(site),'',world.claimed.includes(site.id)||world.cleared.includes(site.id))})
  for (const [index,plan] of (world.plans || []).entries()) {
    for (const [i,cell] of plan.cells.entries()) cells.push({x:cell.x,y:cell.y,image:adventureStamp(plan.kind,i===plan.cells.length-1?String(index+1):'',false)})
    if (plan.kind === 'move') lines.push({points:[plan.origin,...plan.cells],color:0x3e7180,width:.04})
  }
  for (const zone of world.zones) {
    if (world.cleared.includes(zone.id)) continue
    const x=zone.x-.48,y=zone.y-.48,right=zone.x+zone.width-.52,bottom=zone.y+zone.height-.52
    const points=[]
    for(let px=x;px<right;px+=1)points.push({x:px,y})
    points.push({x:right,y})
    for(let py=y;py<bottom;py+=1)points.push({x:right,y:py})
    points.push({x:right,y:bottom})
    for(let px=right;px>x;px-=1)points.push({x:px,y:bottom})
    points.push({x,y:bottom})
    for(let py=bottom;py>y;py-=1)points.push({x,y:py})
    points.push({x,y})
    const sealed = world.active === zone.id || world.encounters?.some(e=>e.id===zone.id)
    lines.push({points,color:0x38251c,width:sealed ? .32 : .20,lift:.035})
    lines.push({points,color:sealed ? 0xe16b39 : 0xc49a5d,width:sealed ? .22 : .12,lift:.048,wallHeight:sealed ? .42 : 0,posts:sealed})
  }
  BattleRenderer3D.setBoardDecorations({cells,lines})
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Called by adventure/battle-controller.js.
function disposeAdventureWorld() {
  BattleRenderer3D.setBoardDecorations(null)
  adventureStampCache.clear(); adventureDecorationKey = null; adventureFocusedAct = null
  for (const id of ['adventureDialog','adventureWallet','adventurePartyDock','adventureEncounter','adventureSiteActions']) document.getElementById(id)?.remove()
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Called by battle.html's deployment click handler.
function adventurePlaceAt(x, y) {
  if (adventureBusy || adventureStopped || !adventureDeployPieceId) return
  if (!adventureSnapshot.deployment.cells.some(cell => cell.x === x && cell.y === y)) { setStatusMsg('请选择队长周围高亮的合法部署格'); return }
  void adventureDoAction({ type: 'deployReservePiece', expectedDeploymentRevision: adventureSnapshot.deployment.revision, pieceId: adventureDeployPieceId, toX: x, toY: y })
}
async function adventureInteract(siteId, operation, choice = adventureCampTargetId) {
  if (adventureBusy || adventureStopped) return
  adventureBusy = true; clearTimeout(adventureTimer)
  try {
    if (operation === 'advance') document.getElementById('adventureDialog').close()
    acceptAdventureSnapshot(await adventureClient.request('interact', { siteId, operation, pieceId: adventureActor()?.instanceId, targetPieceId: choice, revision: adventureSnapshot.revision }))
  } catch (error) { showMsg(error.message, 'err') }
  finally { adventureBusy = false; renderAdventureWorld(); scheduleAdventureAI() }
}

function adventureHasSupplyChoice() {
  const run = adventureSnapshot?.world.cardProgress
  return !!(run?.reward || run?.players[myPlayerId]?.overflow.length)
}

function renderAdventureRecruitment(content, site) {
  const recruitment = adventureSnapshot.world.recruitment
  const row = document.createElement('div'); row.className = 'adventure-operations adventure-recruits'
  for (const id of recruitment.offers[site.id] || []) {
    const piece = PIECES_BY_ID[id]
    if (!piece) continue
    const card = document.createElement('article')
    const img = document.createElement('img'); img.src = '/images/' + piece.image; img.alt = piece.name
    const title = document.createElement('h3'); title.textContent = piece.name
    const stats = document.createElement('small'); stats.textContent = '攻 ' + piece.stats.attack + ' · 生 ' + piece.stats.maxHp + ' · 防 ' + piece.stats.defense
    const skills = document.createElement('p'); skills.textContent = piece.skills.map(s => skillsById[s.skillId]?.name || s.skillId).join(' · ')
    const button = adventureButton('招募 · ' + recruitment.cost + ' 金币', () => adventureInteract(site.id, 'recruit', id)); button.dataset.operation = 'recruit'
    card.append(img, title, stats, skills, button); row.append(card)
  }
  const hint = document.createElement('p'); hint.id = 'adventureInteractionHint'
  content.append(row, hint)
}
async function adventureChooseSupply(operation, choice) {
  if (adventureBusy || adventureStopped) return
  adventureBusy = true; clearTimeout(adventureTimer); renderAdventureDialog()
  try {
    acceptAdventureSnapshot(await adventureClient.request('supply', { operation, choice, revision: adventureSnapshot.revision }))
  } catch (error) { showMsg(error.message, 'err') }
  finally { adventureBusy = false; renderAdventureWorld(); scheduleAdventureAI() }
}
function worldCardPower(id) { const value = adventureSnapshot?.world?.counters?.cards?.[id]; return value ? '当前牌面伤害 ' + value.damage + ' · ' : '' }
function renderAdventureSupplies(content) {
  const run = adventureSnapshot.world.cardProgress, config = adventureSnapshot.world.supplies
  if (!run || !config) { const p = document.createElement('p'); p.textContent = '此冒险未配置供牌遗物。'; content.append(p); return }
  const ledger = run.players[myPlayerId], reward = run.reward
  const text = value => { const p = document.createElement('p'); p.textContent = value; content.append(p) }
  const choiceButton = (name, detail, operation, choice) => {
    const button = adventureButton(name, () => adventureChooseSupply(operation, choice), 'adventure-supply-choice')
    const small = document.createElement('small'); small.textContent = detail; button.append(small)
    button.disabled = adventureBusy; content.append(button)
  }
  const cardText = id => (worldCardPower(id) + (cardsById[id]?.description || id)) + (ledger.growth[id] ? ' · 后续同名牌伤害 +' + ledger.growth[id] : '')
  if (ledger.overflow.length) {
    text('手牌已满（10张）。选择弃置一张，也可以放弃新牌。还有 ' + ledger.overflow.length + ' 张待处理。')
    const incoming = ledger.overflow[0]
    choiceButton('放弃新牌 · ' + (incoming.name || incoming.cardId), cardText(incoming.cardId), 'discard', incoming.instanceId)
    for (const card of G.players.find(p => p.playerId === myPlayerId).hand) choiceButton('弃置 · ' + (card.name || cardsById[card.cardId]?.name || card.cardId), cardText(card.cardId), 'discard', card.instanceId)
    return
  }
  if (reward?.relicIds.length) {
    text('选择一件遗物。下场战斗开始供牌。')
    for (const id of reward.relicIds) { const relic = config.relics.find(r => r.id === id); choiceButton(relic.icon + ' ' + relic.name, relic.description, 'relic', id) }
    choiceButton('跳过遗物', '继续选择卡牌补给', 'skip-relic', '')
  }
  if (reward?.cardIds.length) {
    text('选择一种卡牌，获得 ' + config.rewardCopies + ' 张；未使用的卡可带到后续战斗。')
    for (const id of reward.cardIds) choiceButton(cardsById[id]?.name || id, cardText(id), 'cards', id)
    choiceButton('跳过卡牌', '不领取本次卡牌', 'skip-cards', '')
  }
  text('当前计数（随行动更新）')
  for (const [id, value] of Object.entries(adventureSnapshot.world.counters?.cards || {})) text((cardsById[id]?.name || id) + '：威力 ' + value.damage + ' = 基础 ' + value.baseDamage + ' + 成长 ' + value.growth)
  for (const [id, count] of Object.entries(adventureSnapshot.world.counters?.passiveHits || {})) text((G.pieces.find(p => p.instanceId === id)?.name || id) + '：本场受你方被动命中 ' + count + ' 次')
  text('牌面威力未扣除目标防御、护盾，也未包含施放者增减伤。')
  text('已持有遗物 · ' + ledger.relicIds.length)
  for (const id of ledger.relicIds) {
    const relic = config.relics.find(r => r.id === id), tile = document.createElement('article'); tile.className = 'adventure-relic'
    const heading = document.createElement('h3'); heading.textContent = relic.icon + ' ' + relic.name
    const detail = document.createElement('p'); detail.textContent = relic.description; tile.append(heading, detail); content.append(tile)
  }
  for (const [id, growth] of Object.entries(ledger.growth)) text((cardsById[id]?.name || id) + ' · 后续同名牌伤害 +' + growth)
  if (!Object.keys(ledger.growth).length) text('成长会记录在本次冒险中，新获得的同名牌继续继承。')
}

window.adventureCardPresentation = (card, definition) => {
  const value = adventureSnapshot?.world?.counters?.cards?.[card.cardId || definition.id]
  if (!value) return card
  const brief = {
    'pve-skirmish-calibrate': '友方对3格内敌人造成伤害。\n目标本场受过己方被动伤害：后续同名牌伤害+3。',
    'pve-skirmish-cover': '友方对3格内敌人造成伤害。',
    'pve-light-spark': '友方对3格内敌人造成伤害。\n本局同名牌伤害+2。',
    'pve-blood-curse': '友方自伤1，再对3格内敌人造成伤害。\n付出生命：本局同名牌伤害+3。'
  }
  return {...card,presentation:{...card.presentation,badge:'威力 ' + value.damage,description:brief[card.cardId || definition.id] || definition.description || ''}}
}
window.adventureCardDetail = (cardId, description) => {
  const value = adventureSnapshot?.world?.counters?.cards?.[cardId]
  return value ? '威力 ' + value.damage + '（基础 ' + value.baseDamage + '＋成长 ' + value.growth + '）\n\n' + description : description
}
window.adventurePieceWarning = piece => {
  const world = adventureSnapshot?.world
  if (!world) return ''
  if (adventureEnemyPlans(piece) !== null) return '本场受你方被动命中：' + (world.counters?.passiveHits?.[piece.instanceId] || 0) + ' 次'
  const forecast = world.forecast, result = forecast?.pieces?.[piece.instanceId]
  if (!result) return ''
  return (result.dies ? '⚠ 保持当前站位，按预告预计阵亡' : '按当前预告预计受伤') + ' · 生命 ' + result.hp + ' → ' + result.remainingHp
}

window.adventureBoardWarning = id => {
  const world = adventureSnapshot?.world
  return world?.forecast?.complete && world.forecast.pieces?.[id]?.dies ? '⚠ 预计阵亡' : ''
}
