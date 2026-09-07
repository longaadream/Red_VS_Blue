/* Shared battle presentation, separate ownership/authority from free training. */
let practiceClient = null
let practiceSnapshot = null
let practiceBusy = false
let practiceStopped = false
let practiceTimer = null
let practiceEvents = []
const practiceWaitByTurn = new Map()

function disposePracticeBattle() {
  practiceStopped = true
  clearTimeout(practiceTimer)
  practiceClient?.dispose()
}
function practiceStatus(message, failed) {
  const bar = document.getElementById('practiceStatus')
  if (bar) { bar.textContent = message; bar.style.color = failed ? '#ffd0af' : '#ddc9a4' }
}
function pausePractice(error) {
  practiceStopped = true
  practiceStatus('练习已暂停：' + (error.message || error) + ' · 可返回重新开局', true)
  clearPendingActionFeedback('practice-paused')
  render()
}
function acceptPracticeSnapshot(result) {
  const old = G
  practiceSnapshot = result
  if (result.diagnostics) {
    const turn = result.diagnostics.turn
    practiceWaitByTurn.set(turn, (practiceWaitByTurn.get(turn) || 0) + result.requestMs)
  }
  console.info('[practice] receipt', JSON.stringify({ revision: result.revision, owner: result.inputOwner,
    type: result.action?.type, diagnostics: result.diagnostics, timings: result.timings, paused: result.paused,
    requestMs: result.requestMs, turnRequestMs: Object.fromEntries(practiceWaitByTurn) }))
  G = result.state
  G.skillsById = Object.assign({}, skillsById)
  myPlayerId = result.humanPlayerId
  myFaction = G.players.find(p => p.playerId === myPlayerId).faction
  practiceEvents = practiceEvents.concat(result.events || []).slice(-250)
  latestBattlePresentationEvents = practiceEvents
  if (old && result.action) {
    if (_use3d && battlePresentation) battlePresentation.animateAction(
      Object.assign({}, result.action, { motionEventKey: 'practice:' + result.revision }),
      createBattlePresentationModel(old), createBattlePresentationModel(G))
    spawnStateFloaters(old, G)
    reconcileBattleInteractionState(old, G)
  }
  clearPendingActionFeedback('practice-applied')
  selectedPieceId = selectedPieceId && G.pieces.some(p => p.instanceId === selectedPieceId) ? selectedPieceId : null
  // Reset the menu before render derives legal moves from the new state.
  if (result.action?.playerId === result.humanPlayerId) restoreSelectedPieceMenu({ reopen: result.action.type === 'move' })
  render()
  if (G.terminalResult) showPracticeResult()
  else if (result.paused) pausePractice(new Error(result.paused))
  else if (result.diagnostics && practiceWaitByTurn.get(result.diagnostics.turn) >= 10000)
    pausePractice(new Error('AI 本回合累计等待超过10秒'))
  else practiceStatus(result.inputOwner === result.aiPlayerId ? 'AI 正在思考…' : '轮到你了')
  window.__RVB_PRACTICE__ = { revision: result.revision, inputOwner: result.inputOwner, paused: result.paused, timings: result.timings }
}
async function initPracticeBattle() {
  try {
    const setup = JSON.parse(sessionStorage.getItem('rvb_practice_setup') || 'null')
    if (!setup) { location.replace('practice.html'); return }
    for (const id of ['btnSwitchPov', 'btnResetCD', 'trainingTools']) {
      const element = document.getElementById(id); if (element) element.style.display = 'none'
    }
    document.getElementById('roomNameLabel').textContent = 'PVP 练习 · 实验 AI'
    const status = document.createElement('div')
    status.id = 'practiceStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
    status.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);max-width:90vw;padding:8px 14px;border:2px solid #69543a;border-radius:8px;background:#382e25;color:#ddc9a4;z-index:160;text-align:center;font-size:12px;pointer-events:none'
    document.body.append(status)
    practiceStatus('正在准备练习战局…')
    practiceClient = await RvBPracticeClient.create()
    if (practiceStopped) { practiceClient.dispose(); return }
    const files = practiceClient.files
    RvBGameEngine.primeJsonFiles(files)
    for (const [directory, target] of [['pieces', PIECES_BY_ID], ['skills', skillsById], ['cards', cardsById]]) {
      for (const id of files['data/' + directory + '/manifest.json']) target[id] = files['data/' + directory + '/' + id + '.json']
    }
    keywordGlossaryByName = Object.fromEntries((files['data/skill-keywords.json'] || []).map(item => [item.name, item]))
    await RvBGameEngine.ensure()
    playerNames['practice-human'] = '你'; playerNames['practice-ai'] = '实验 AI'
    acceptPracticeSnapshot(await practiceClient.request('start', setup))
    document.getElementById('loadingOverlay').style.display = 'none'
    schedulePracticeAI()
  } catch (error) {
    practiceStopped = true
    document.getElementById('loadingOverlay').style.display = 'none'
    showMsg('练习初始化失败：' + error.message + '，请返回重试', 'err')
    practiceStatus(error.message, true)
    practiceClient?.dispose()
  }
}
function schedulePracticeAI() {
  clearTimeout(practiceTimer)
  if (practiceStopped || practiceBusy || !practiceSnapshot || G?.terminalResult) return
  const ai = practiceSnapshot.inputOwner === practiceSnapshot.aiPlayerId
  const phase = !G.pendingOptionSelection && !G.pendingTargetSelection && !progressiveDeploymentPending(G)
    && (G.turn.phase === 'start' || G.turn.phase === 'end')
  if (!ai && !phase) return
  practiceTimer = setTimeout(async () => {
    if (practiceStopped) return
    practiceBusy = true
    try {
      const result = await practiceClient.request(ai ? 'step' : 'human', ai
        ? { revision: practiceSnapshot.revision }
        : { action: { type: 'beginPhase', playerId: myPlayerId }, revision: practiceSnapshot.revision })
      if (!practiceStopped) acceptPracticeSnapshot(result)
    } catch (error) { if (!practiceStopped) pausePractice(error) }
    finally { practiceBusy = false; schedulePracticeAI() }
  }, ai ? 350 : 0)
}
async function practiceDoAction(rawAction) {
  if (practiceStopped || practiceBusy || !G || G.terminalResult) return
  const action = withClientActionId(Object.assign({}, rawAction, { playerId: myPlayerId }))
  practiceBusy = true; clearTimeout(practiceTimer)
  if (!beginPendingActionFeedback(action)) { practiceBusy = false; schedulePracticeAI(); return }
  try {
    const result = await practiceClient.request('human', { action, revision: practiceSnapshot.revision })
    if (practiceStopped) return
    applyAuthorityReceipt({ clientActionId: action.clientActionId, status: 'applied' }, null, null, { deferRender: true, deferPerformance: true })
    pendingSkill = null; pendingCardAction = null
    acceptPracticeSnapshot(result)
  } catch (error) {
    clearPendingActionFeedback('practice-rejected')
    if (error.practicePaused) { pausePractice(error); return }
    if (error.needsTargetSelection) enterActionTargetMode(action, targetPreparationFromError(error))
    else if (error.needsOptionSelection) {
      const retry = Object.assign({}, action)
      if (error.preparation) { retry.selectionId = error.preparation.selectionId; retry.stateRevision = error.preparation.stateRevision }
      showOptionPicker(error.title || '请选择', error.options || [], retry)
    } else {
      rejectPendingActionFeedback('practice-rejected', error.message)
      setStatusMsg(error.message)
    }
    render()
  } finally { practiceBusy = false; schedulePracticeAI() }
}
function showPracticeResult() {
  if (!G?.terminalResult || recordSaved) return
  recordSaved = true; practiceStopped = true; clearTimeout(practiceTimer)
  const winner = G.terminalResult.winnerPlayerId
  const won = winner === myPlayerId
  document.getElementById('resultIcon').textContent = !winner ? '=' : won ? 'WIN' : 'LOSE'
  document.getElementById('resultTitle').textContent = !winner ? '平局' : won ? '胜利' : '失败'
  document.getElementById('resultSub').textContent = 'PVP 练习结束 · 不计入战绩'
  document.getElementById('recordStatus').textContent = ''
  const back = document.getElementById('resultOverlay').querySelector('button[onclick="goBack()"]')
  if (back) back.textContent = '再来一局'
  document.getElementById('resultOverlay').style.display = 'flex'
  practiceStatus('练习结束，返回准备页可以再来一局。')
}
Object.assign(window, { disposePracticeBattle, initPracticeBattle, practiceDoAction, showPracticeResult })
