;(function () {
  'use strict'

  var activeMatchGate = document.getElementById('activeMatchGate')
  var activeMatchLabel = document.getElementById('activeMatchLabel')
  var replayToolFieldset = document.getElementById('replayToolFieldset')
  var scenarioToolFieldset = document.getElementById('scenarioToolFieldset')
  var traceDropZone = document.getElementById('traceDropZone')
  var traceFileInput = document.getElementById('traceFileInput')
  var traceStatus = document.getElementById('traceStatus')
  var scenarioStatus = document.getElementById('scenarioStatus')
  var storedTrace = null
  var locked = false

  function refreshActiveMatchGate() {
    var activeBattle = RvBDeveloperTools.readActiveBattle()
    locked = !!activeBattle
    activeMatchGate.hidden = !locked
    replayToolFieldset.disabled = locked
    scenarioToolFieldset.disabled = locked
    traceDropZone.setAttribute('aria-disabled', locked ? 'true' : 'false')
    activeMatchLabel.textContent = locked && activeBattle.roomId
      ? '当前房间：' + activeBattle.roomId
      : ''
    return locked
  }

  function setStatus(element, message, isError) {
    element.textContent = message || ''
    element.classList.toggle('error', !!isError)
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value == null || value === '' ? '—' : String(value)
  }

  function renderStoredTrace() {
    var available = !!storedTrace
    document.getElementById('traceEmpty').hidden = available
    document.getElementById('traceFacts').hidden = !available
    document.getElementById('traceFormatBadge').hidden = !available
    document.getElementById('openReplayButton').disabled = !available || locked
    document.getElementById('downloadStoredTraceButton').disabled = !available || locked
    document.getElementById('clearStoredTraceButton').disabled = !available || locked
    if (!available) return

    setText('traceRoom', storedTrace.roomId || '本地对局')
    setText('traceResult', (storedTrace.final.winnerPlayerId || '平局') + ' · ' + (storedTrace.final.reason || 'finished'))
    setText('traceMapTurn', (storedTrace.final.mapId || '未知地图') + ' · ' + (storedTrace.final.turnNumber || '?') + ' 回合')
    setText('traceCommands', storedTrace.summary.commandCount + ' 命令 · ' + (storedTrace.summary.eventCount || 0) + ' 事件')
    setText('traceHash', storedTrace.final.stateHash || storedTrace.final.checkpointHash)
    setText('traceTime', storedTrace.exportedAt || '未知')
  }

  async function refreshStoredTrace() {
    storedTrace = await RvBDeveloperTools.readStoredTrace()
    renderStoredTrace()
  }

  async function importFile(file) {
    if (refreshActiveMatchGate()) {
      setStatus(traceStatus, '正在对局，Trace 导入与回放已锁定。', true)
      return
    }
    setStatus(traceStatus, '正在读取并验证 Trace v2 的状态帧与 Hash 链…')
    try {
      storedTrace = await RvBDeveloperTools.importTraceFile(file)
      renderStoredTrace()
      setStatus(traceStatus, '导入成功：已验证 ' + storedTrace.frames.length + ' 个权威命令帧，可以打开回放。')
    } catch (error) {
      setStatus(traceStatus, '导入失败：' + ((error && error.message) || error), true)
    } finally {
      traceFileInput.value = ''
    }
  }

  function requestFile() {
    if (refreshActiveMatchGate()) return
    traceFileInput.click()
  }

  document.getElementById('chooseTraceButton').addEventListener('click', requestFile)
  traceDropZone.addEventListener('click', requestFile)
  traceDropZone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      requestFile()
    }
  })
  traceFileInput.addEventListener('change', function () {
    if (traceFileInput.files && traceFileInput.files[0]) importFile(traceFileInput.files[0])
  })

  ;['dragenter', 'dragover'].forEach(function (eventName) {
    traceDropZone.addEventListener(eventName, function (event) {
      event.preventDefault()
      if (!locked) traceDropZone.classList.add('is-dragging')
    })
  })
  ;['dragleave', 'drop'].forEach(function (eventName) {
    traceDropZone.addEventListener(eventName, function (event) {
      event.preventDefault()
      traceDropZone.classList.remove('is-dragging')
    })
  })
  traceDropZone.addEventListener('drop', function (event) {
    if (locked) return
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
    if (file) importFile(file)
  })

  document.getElementById('openReplayButton').addEventListener('click', function () {
    if (!storedTrace || refreshActiveMatchGate()) return
    window.location.href = 'replay.html'
  })

  document.getElementById('downloadStoredTraceButton').addEventListener('click', function () {
    if (!storedTrace || refreshActiveMatchGate()) return
    var fileName = RvBDeveloperTools.downloadTrace(storedTrace)
    setStatus(traceStatus, '已下载：' + fileName)
  })

  document.getElementById('clearStoredTraceButton').addEventListener('click', async function () {
    if (refreshActiveMatchGate()) return
    await RvBDeveloperTools.clearStoredTrace()
    storedTrace = null
    renderStoredTrace()
    setStatus(traceStatus, '本地 Trace 已清除；真实房间、账号和战绩没有变化。')
  })

  function developerToolsFetch(path, options) {
    var hasConfiguredServer = RvBUtils.getServerUrl && RvBUtils.getServerUrl()
    var canUseSameOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:'
    if (!hasConfiguredServer && canUseSameOrigin) return fetch(path, options)
    return RvBUtils.serverFetch(path, options)
  }

  document.getElementById('scenarioForm').addEventListener('submit', async function (event) {
    event.preventDefault()
    if (refreshActiveMatchGate()) {
      setStatus(scenarioStatus, '正在对局，隔离场景已锁定。', true)
      return
    }

    var submitButton = document.getElementById('runScenarioButton')
    submitButton.disabled = true
    setStatus(scenarioStatus, '正在通过正式规则 Runner 运行隔离场景…')
    try {
      var response = await developerToolsFetch('/api/developer-tools/scenario', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seed: Number(document.getElementById('scenarioSeed').value),
          mapId: document.getElementById('scenarioMap').value.trim(),
          firstAlignment: document.getElementById('firstAlignment').value,
          secondAlignment: document.getElementById('secondAlignment').value,
        }),
        timeoutMs: 15000,
      })
      var result = await response.json().catch(function () { return {} })
      if (!response.ok) throw new Error(result.error || ('HTTP ' + response.status))
      document.getElementById('scenarioFacts').hidden = false
      setText('factMap', result.map.id + ' · ' + result.map.width + '×' + result.map.height)
      setText('factTurn', result.turn.number + ' / ' + result.turn.phase)
      setText('factActor', result.turn.currentPlayerId)
      setText('factHash', result.stateHash)
      setText('factSeed', result.seed)
      setText('factCommands', result.actionTrace.length)
      var output = document.getElementById('scenarioOutput')
      output.textContent = JSON.stringify(result, null, 2)
      output.style.display = 'block'
      setStatus(scenarioStatus, '隔离场景已完成；没有创建真实房间或结算数据。')
    } catch (error) {
      setStatus(scenarioStatus, '运行失败：' + ((error && error.message) || error), true)
    } finally {
      submitButton.disabled = false
    }
  })

  window.addEventListener('focus', function () {
    refreshActiveMatchGate()
    renderStoredTrace()
  })
  window.addEventListener('storage', function () {
    refreshActiveMatchGate()
    refreshStoredTrace()
  })

  refreshActiveMatchGate()
  refreshStoredTrace().catch(function (error) {
    setStatus(traceStatus, '读取最近 Trace 失败：' + ((error && error.message) || error), true)
  })
})()
