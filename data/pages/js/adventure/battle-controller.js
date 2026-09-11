/* Shared battle presentation, separate ownership/authority from free training. */
let adventureClient = null
let adventureSnapshot = null
let adventureBusy = false
let adventureStopped = false
let adventureTimer = null
let adventureEvents = []
const adventureWaitByTurn = new Map()

function disposeAdventureBattle() {
  adventureStopped = true
  clearTimeout(adventureTimer)
  adventureClient?.dispose()
  disposeAdventureWorld()
}
function adventureStatus(message, failed) {
  const bar = document.getElementById('adventureStatus')
  if (bar) { bar.textContent = message; bar.style.color = failed ? '#ffd0af' : '#ddc9a4' }
}
function pauseAdventure(error) {
  adventureStopped = true
  adventureStatus('冒险已暂停：' + (error.message || error) + ' · 可返回重新开局', true)
  clearPendingActionFeedback('adventure-paused')
  render()
}
function acceptAdventureSnapshot(result) {
  const old = G
  if (result.content) {
    const files = {}
    for (const template of result.content.templates) { PIECES_BY_ID[template.id] = template; files['data/pieces/' + template.id + '.json'] = template }
    for (const [id, skill] of Object.entries(result.content.skills)) { skillsById[id] = skill; files['data/skills/' + id + '.json'] = skill }
    RvBGameEngine.primeJsonFiles(files)
  }
  adventureSnapshot = result
  if (result.world?.name) {
    document.title = result.world.name + ' · PVE - RED vs BLUE'
    const roomLabel = document.getElementById('roomNameLabel'); if (roomLabel) roomLabel.textContent = 'PVE · ' + result.world.name
  }
  if (result.action?.type === 'deployReservePiece' || !result.deployment?.cells?.length) adventureDeployPieceId = null
  if (result.diagnostics) {
    const turn = result.diagnostics.turn
    adventureWaitByTurn.set(turn, (adventureWaitByTurn.get(turn) || 0) + result.requestMs)
  }
  console.info('[adventure] receipt', JSON.stringify({ revision: result.revision, owner: result.inputOwner,
    type: result.action?.type, diagnostics: result.diagnostics, timings: result.timings, paused: result.paused,
    requestMs: result.requestMs, turnRequestMs: Object.fromEntries(adventureWaitByTurn) }))
  G = result.state
  G.skillsById = Object.assign({}, skillsById)
  myPlayerId = result.humanPlayerId
  myFaction = G.players.find(p => p.playerId === myPlayerId).faction
  adventureEvents = adventureEvents.concat(result.events || []).slice(-250)
  latestBattlePresentationEvents = adventureEvents
  if (old && result.action) {
    if (_use3d && battlePresentation) battlePresentation.animateAction(
      Object.assign({}, result.action, { motionEventKey: 'adventure:' + result.revision }),
      createBattlePresentationModel(old), createBattlePresentationModel(G))
    spawnStateFloaters(old, G)
    reconcileBattleInteractionState(old, G)
  }
  clearPendingActionFeedback('adventure-applied')
  selectedPieceId = selectedPieceId && G.pieces.some(p => p.instanceId === selectedPieceId) ? selectedPieceId : null
  // Reset the menu before render derives legal moves from the new state.
  if (result.action?.playerId === result.humanPlayerId) restoreSelectedPieceMenu({ reopen: result.action.type === 'move' })
  render()
  renderAdventureWorld()
  if (G.terminalResult) showAdventureResult()
  else if (result.paused) pauseAdventure(new Error(result.paused))
  else if (result.diagnostics && adventureWaitByTurn.get(result.diagnostics.turn) >= 10000)
    pauseAdventure(new Error('AI 本回合累计等待超过10秒'))
  else adventureStatus(result.inputOwner === result.aiPlayerId ? '敌方按预告行动…' : '轮到你了')
  window.__RVB_ADVENTURE__ = { revision: result.revision, inputOwner: result.inputOwner, paused: result.paused, timings: result.timings }
}
async function initAdventureBattle() {
  try {
    document.title = '旧城边境 · PVE - RED vs BLUE'
    const seedText = new URLSearchParams(location.search).get('seed')
    const setup = seedText === null ? {} : { seed: /^\d+$/.test(seedText) ? Number(seedText) : -1 }

    for (const id of ['btnSwitchPov', 'btnResetCD', 'trainingTools']) {
      const element = document.getElementById(id); if (element) element.style.display = 'none'
    }
    document.getElementById('roomNameLabel').textContent = 'PVE · 旧城边境'
    const status = document.createElement('div')
    status.id = 'adventureStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
    status.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);max-width:90vw;padding:8px 14px;border:2px solid #69543a;border-radius:8px;background:#382e25;color:#ddc9a4;z-index:160;text-align:center;font-size:12px;pointer-events:none'
    document.body.append(status)
    adventureStatus('正在准备冒险战局…')
    adventureClient = await RvBAdventureClient.create()
    if (adventureStopped) { adventureClient.dispose(); return }
    const files = adventureClient.files
    RvBGameEngine.primeJsonFiles(files)
    for (const [directory, target] of [['pieces', PIECES_BY_ID], ['skills', skillsById], ['cards', cardsById]]) {
      for (const id of files['data/' + directory + '/manifest.json']) target[id] = files['data/' + directory + '/' + id + '.json']
    }
    keywordGlossaryByName = Object.fromEntries((files['data/skill-keywords.json'] || []).map(item => [item.name, item]))
    await RvBGameEngine.ensure()
    playerNames['adventure-human'] = '你'; playerNames['adventure-enemy'] = '据点守卫'
    acceptAdventureSnapshot(await adventureClient.request('start', setup))
    if (adventureClient.network) {
      adventureClient.network.subscribe(value => {
        if (value.snapshot && value.snapshot.revision > (adventureSnapshot?.revision ?? -1)) acceptAdventureSnapshot(value.snapshot)
        renderAdventureRoomStatus(value)
      })
      adventureClient.network.onConnection((connected, message) => {
        adventureBusy = !connected
        adventureStatus(message || '连接已恢复', !connected)
        render()
      })
    }
    document.getElementById('loadingOverlay').style.display = 'none'
    scheduleAdventureAI()
  } catch (error) {
    adventureStopped = true
    document.getElementById('loadingOverlay').style.display = 'none'
    showMsg('冒险初始化失败：' + error.message + '，请返回重试', 'err')
    adventureStatus(error.message, true)
    adventureClient?.dispose()
  }
}
function scheduleAdventureAI() {
  clearTimeout(adventureTimer)
  if (adventureClient?.network) return
  if (adventureStopped || adventureBusy || !adventureSnapshot || G?.terminalResult) return
  if (adventureHasSupplyChoice() && !G.pendingOptionSelection && !G.pendingTargetSelection) return
  const ai = adventureSnapshot.inputOwner === adventureSnapshot.aiPlayerId
  const phase = !G.pendingOptionSelection && !G.pendingTargetSelection && !progressiveDeploymentPending(G)
    && (G.turn.phase === 'start' || G.turn.phase === 'end')
  if (!ai && !phase) return
  adventureTimer = setTimeout(async () => {
    if (adventureStopped) return
    adventureBusy = true
    try {
      const result = await adventureClient.request(ai ? 'step' : 'human', ai
        ? { revision: adventureSnapshot.revision }
        : { action: { type: 'beginPhase', playerId: myPlayerId }, revision: adventureSnapshot.revision })
      if (!adventureStopped) acceptAdventureSnapshot(result)
    } catch (error) { if (!adventureStopped) pauseAdventure(error) }
    finally { adventureBusy = false; renderAdventureWorld(); scheduleAdventureAI() }
  }, ai ? 350 : 0)
}
async function adventureDoAction(rawAction) {
  if (adventureStopped || adventureBusy || !G || G.terminalResult) return
  const action = withClientActionId(Object.assign({}, rawAction, { playerId: myPlayerId }))
  adventureBusy = true; clearTimeout(adventureTimer)
  if (!beginPendingActionFeedback(action)) { adventureBusy = false; scheduleAdventureAI(); return }
  try {
    const result = await adventureClient.request('human', { action, revision: adventureSnapshot.revision })
    if (adventureStopped) return
    applyAuthorityReceipt({ clientActionId: action.clientActionId, status: 'applied' }, null, null, { deferRender: true, deferPerformance: true })
    pendingSkill = null; pendingCardAction = null
    acceptAdventureSnapshot(result)
  } catch (error) {
    clearPendingActionFeedback('adventure-rejected')
    if (error.adventurePaused) { pauseAdventure(error); return }
    if (error.needsTargetSelection) enterActionTargetMode(action, targetPreparationFromError(error))
    else if (error.needsOptionSelection) {
      const retry = Object.assign({}, action)
      if (error.preparation) { retry.selectionId = error.preparation.selectionId; retry.stateRevision = error.preparation.stateRevision }
      showOptionPicker(error.title || '请选择', error.options || [], retry)
    } else {
      rejectPendingActionFeedback('adventure-rejected', error.message)
      setStatusMsg(error.message)
    }
    render()
  } finally { adventureBusy = false; renderAdventureWorld(); scheduleAdventureAI() }
}
function showAdventureResult() {
  if (!G?.terminalResult || recordSaved) return
  const winner = G.terminalResult.winnerPlayerId
  const won = winner === myPlayerId || G.terminalResult.winnerPlayerIds?.includes(myPlayerId)
  // Terminal combat has stopped already; keep reward authority usable until the final choice settles.
  if (won && adventureHasSupplyChoice()) return
  recordSaved = true; adventureStopped = true; clearTimeout(adventureTimer)
  document.getElementById('resultIcon').textContent = !winner ? '=' : won ? 'WIN' : 'LOSE'
  document.getElementById('resultTitle').textContent = !winner ? '平局' : won ? '胜利' : '失败'
  document.getElementById('resultSub').textContent = (won ? '冒险完成' : '冒险止步于第 ' + (adventureSnapshot.world.actNumber || 1) + ' 幕') + ' · 金币 ' + adventureSnapshot.world.coins + (won && adventureSnapshot.world.lastReward ? ' · 最后一战奖励 +' + adventureSnapshot.world.lastReward.coins + ' 已入账' : '')
  document.getElementById('recordStatus').textContent = ''
  const back = document.getElementById('resultOverlay').querySelector('button[onclick="goBack()"]')
  if (back) back.textContent = '再来一局'
  document.getElementById('resultOverlay').style.display = 'flex'
  adventureStatus('冒险结束，返回准备页可以再来一局。')
}
Object.assign(window, { disposeAdventureBattle, initAdventureBattle, adventureDoAction, showAdventureResult })
