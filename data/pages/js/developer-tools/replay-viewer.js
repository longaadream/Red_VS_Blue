;(function () {
  'use strict'

  var trace = null
  var currentIndex = 0
  var selectedPieceId = null
  var currentModel = null
  var playing = false
  var playTimer = null
  var pieceTemplates = {}
  var skillsById = {}

  var workspace = document.getElementById('replayWorkspace')
  var errorBox = document.getElementById('replayError')
  var timeline = document.getElementById('replayTimeline')
  var playButton = document.getElementById('replayPlayButton')
  var previousButton = document.getElementById('replayPreviousButton')
  var nextButton = document.getElementById('replayNextButton')
  var speedSelect = document.getElementById('replaySpeed')
  var perspectiveSelect = document.getElementById('replayPerspective')

  function showError(message) {
    stopPlayback()
    workspace.hidden = true
    errorBox.hidden = false
    errorBox.textContent = message
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function createElement(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function safeJson(value, maxLength) {
    var serialized
    try {
      serialized = JSON.stringify(value, null, 2)
    } catch (_error) {
      serialized = String(value)
    }
    maxLength = maxLength || 1000
    return serialized.length > maxLength ? serialized.slice(0, maxLength) + '…' : serialized
  }

  function buildContentLookup(record) {
    pieceTemplates = {}
    skillsById = {}
    ;(record.content.pieces || []).forEach(function (piece) {
      if (!piece || !piece.templateId) return
      pieceTemplates[piece.templateId] = {
        name: piece.name || piece.templateId,
        image: piece.imageId || piece.templateId,
        stats: piece.stats || {},
      }
    })
    ;(record.content.skills || []).forEach(function (skill) {
      if (skill && skill.skillId) skillsById[skill.skillId] = skill
    })
  }

  function stateAt(index) {
    if (index <= 0) return trace.initialState
    return trace.frames[index - 1].postState
  }

  function frameAt(index) {
    return index > 0 ? trace.frames[index - 1] : null
  }

  function resolveViewerId(snapshot) {
    var perspective = perspectiveSelect.value
    if (perspective === 'omniscient') return ''
    var players = Array.isArray(snapshot.players) ? snapshot.players : []
    var direct = players.find(function (player) { return player && player.faction === perspective })
    if (direct) return direct.playerId || ''
    var pieces = Array.isArray(snapshot.pieces) ? snapshot.pieces : []
    var piece = pieces.find(function (candidate) { return candidate && candidate.faction === perspective })
    return piece ? piece.ownerPlayerId || '' : ''
  }

  function createModel(snapshot) {
    return BattleViewModel.create({
      snapshot: snapshot,
      viewerId: resolveViewerId(snapshot),
      selectedPieceId: selectedPieceId,
      interactionMode: 'inspect',
      pieceTemplates: pieceTemplates,
      interaction: {},
      legal: { moveCells: [], targetCells: [], placementCells: [] },
    })
  }

  function setFrame(nextIndex, animate) {
    if (!trace) return
    nextIndex = Math.max(0, Math.min(trace.frames.length, Number(nextIndex) || 0))
    var previousIndex = currentIndex
    var previousModel = currentModel
    var snapshot = stateAt(nextIndex)
    var nextModel = createModel(snapshot)
    var frame = frameAt(nextIndex)

    if (animate && nextIndex === previousIndex + 1 && previousModel && frame) {
      var motionAction = Object.assign({}, frame.action || {}, {
        type: frame.actionType || (frame.action && frame.action.type) || 'stateUpdate',
        motionEventKey: 'trace:' + nextIndex + ':' + frame.postCheckpointHash,
      })
      BattleRenderer3D.animateAction(motionAction, previousModel, nextModel)
    }

    currentIndex = nextIndex
    currentModel = nextModel
    BattleRenderer3D.update(nextModel)
    renderInspector(snapshot, frame)
    timeline.value = String(currentIndex)
    document.getElementById('replayTimelinePosition').textContent = currentIndex + ' / ' + trace.frames.length
    previousButton.disabled = currentIndex === 0
    nextButton.disabled = currentIndex === trace.frames.length
    if (currentIndex === trace.frames.length && playing) stopPlayback()
  }

  function renderInspector(snapshot, frame) {
    var title = frame ? commandLabel(frame.actionType) : '完整初始状态'
    document.getElementById('replayFrameTitle').textContent = title
    document.getElementById('replayFrameMeta').textContent = frame
      ? '第 ' + currentIndex + ' 帧 · 回合 ' + frame.turnAfter + ' · ' + phaseLabel(frame.phaseAfter)
      : '第 0 帧 · 回合 ' + (snapshot.turn && snapshot.turn.turnNumber || 1) + ' · ' + phaseLabel(snapshot.turn && snapshot.turn.phase)

    renderCommandDetails(snapshot, frame)
    renderPieceDetails(snapshot)
    renderHashDetails(frame)
    renderEvents(frame)
    renderDiffs(frame)
    renderRandomStreams(frame)
  }

  function commandLabel(type) {
    var labels = {
      initializeBattle: '初始化比赛',
      beginPhase: '开始阶段',
      move: '移动',
      useSkill: '使用技能',
      useCard: '使用卡牌',
      endTurn: '结束回合',
      surrender: '投降',
      deploymentChoice: '选择部署位置',
      deploymentLock: '锁定部署',
      deploymentTimeout: '部署超时',
      turnTimeout: '回合超时',
      turnTimerSync: '同步回合计时',
      turnTimerBurn: '结算回合计时',
      selectOption: '提交规则选项',
      selectTarget: '提交规则目标',
    }
    return labels[type] || ('通用命令 · ' + String(type || 'unknown'))
  }

  function phaseLabel(phase) {
    var labels = { start: '开始阶段', action: '行动阶段', end: '结束阶段' }
    return labels[phase] || String(phase || '未知阶段')
  }

  function addDetail(container, label, value) {
    var item = createElement('div', 'detail')
    item.appendChild(createElement('span', '', label))
    item.appendChild(createElement('strong', '', value == null || value === '' ? '—' : value))
    container.appendChild(item)
  }

  function renderCommandDetails(snapshot, frame) {
    var container = document.getElementById('replayCommandDetails')
    clearNode(container)
    addDetail(container, '命令', frame ? commandLabel(frame.actionType) : '初始状态')
    addDetail(container, '执行者', frame ? frame.playerId : 'system')
    addDetail(container, '回合', frame ? frame.turnBefore + ' → ' + frame.turnAfter : snapshot.turn.turnNumber)
    addDetail(container, '阶段', frame ? phaseLabel(frame.phaseBefore) + ' → ' + phaseLabel(frame.phaseAfter) : phaseLabel(snapshot.turn.phase))
    addDetail(container, '视角', perspectiveSelect.options[perspectiveSelect.selectedIndex].textContent)
    if (snapshot.terminalResult) {
      addDetail(container, '终局', (snapshot.terminalResult.winnerPlayerId || '平局') + ' · ' + (snapshot.terminalResult.reason || 'finished'))
    }
  }

  function findRecordedPiece(snapshot, pieceId) {
    var all = []
    if (Array.isArray(snapshot.pieces)) all = all.concat(snapshot.pieces)
    if (Array.isArray(snapshot.graveyard)) all = all.concat(snapshot.graveyard)
    return all.find(function (piece) {
      return String(piece && (piece.instanceId || piece.id)) === String(pieceId)
    }) || null
  }

  function renderPieceDetails(snapshot) {
    var container = document.getElementById('replayPieceDetails')
    clearNode(container)
    var piece = selectedPieceId ? findRecordedPiece(snapshot, selectedPieceId) : null
    if (!piece) {
      container.className = 'empty'
      container.textContent = selectedPieceId
        ? '该棋子在当前帧不存在或尚未登场。'
        : '尚未选择棋子。'
      return
    }

    container.className = ''
    var template = pieceTemplates[piece.templateId] || {}
    var grid = createElement('div', 'detail-grid')
    addDetail(grid, '名称', piece.name || template.name || piece.templateId || piece.instanceId)
    addDetail(grid, '实例 ID', piece.instanceId || piece.id)
    addDetail(grid, '所属玩家', piece.ownerPlayerId || '—')
    addDetail(grid, '阵营', piece.faction || '—')
    addDetail(grid, '位置', piece.x == null || piece.y == null ? '墓地 / 场外' : piece.x + ', ' + piece.y)
    addDetail(grid, '生命', valueOr(piece.currentHp, 0) + ' / ' + valueOr(piece.maxHp || (piece.stats && piece.stats.maxHp), '?'))
    addDetail(grid, '攻击 / 防御', valueOr(piece.attack || (piece.stats && piece.stats.attack), 0) + ' / ' + valueOr(piece.defense || (piece.stats && piece.stats.defense), 0))
    addDetail(grid, '移动', valueOr(piece.moveRange || (piece.stats && piece.stats.moveRange), 0))
    container.appendChild(grid)

    var skills = normalizeSkillIds(piece.skills)
    var skillList = createElement('ul', 'data-list')
    skills.forEach(function (skillId) {
      var definition = skillsById[skillId] || {}
      var used = Array.isArray(piece.usedSkills) && piece.usedSkills.indexOf(skillId) !== -1
      appendDataItem(skillList, definition.name || skillId, (definition.description || '记录技能 ID：' + skillId) + (used ? '\n当前帧：已使用 / 冷却中' : ''))
    })
    if (skills.length) {
      container.appendChild(createElement('h3', 'data-item-title', '技能与冷却'))
      container.appendChild(skillList)
    }

    var statuses = [].concat(piece.statusTags || [], piece.buffs || [], piece.debuffs || [])
    if (statuses.length) {
      var statusList = createElement('ul', 'data-list')
      statuses.forEach(function (status) {
        var label = typeof status === 'string' ? status : status.name || status.type || status.id || '未知状态'
        appendDataItem(statusList, label, typeof status === 'string' ? '' : safeJson(status, 600))
      })
      container.appendChild(createElement('h3', 'data-item-title', '状态'))
      container.appendChild(statusList)
    }
  }

  function normalizeSkillIds(skills) {
    return (Array.isArray(skills) ? skills : []).map(function (skill) {
      return typeof skill === 'string' ? skill : String(skill && (skill.skillId || skill.id) || '')
    }).filter(Boolean)
  }

  function valueOr(value, fallback) {
    return value === undefined || value === null ? fallback : value
  }

  function renderHashDetails(frame) {
    var container = document.getElementById('replayHashDetails')
    clearNode(container)
    if (!frame) {
      container.appendChild(createElement('div', 'panel-subtitle', '初始权威状态 Hash'))
      container.appendChild(createElement('div', 'hash', trace.initialStateHash))
      container.appendChild(createElement('div', 'panel-subtitle', '初始检查点 Hash'))
      container.appendChild(createElement('div', 'hash', trace.initialCheckpointHash))
      return
    }
    container.appendChild(createElement('div', 'panel-subtitle', '权威 Hash · 前 → 后'))
    container.appendChild(createElement('div', 'hash', frame.preStateHash + '\n↓\n' + frame.postStateHash))
    container.appendChild(createElement('div', 'panel-subtitle', '脱敏检查点 Hash · 前 → 后'))
    container.appendChild(createElement('div', 'hash', frame.preCheckpointHash + '\n↓\n' + frame.postCheckpointHash))
  }

  function appendDataItem(list, title, body) {
    var item = createElement('li', 'data-item')
    item.appendChild(createElement('div', 'data-item-title', title))
    if (body) item.appendChild(createElement('div', 'data-item-body', body))
    list.appendChild(item)
  }

  function renderEvents(frame) {
    var list = document.getElementById('replayEventList')
    clearNode(list)
    var events = frame && Array.isArray(frame.events) ? frame.events : []
    if (!events.length) {
      appendDataItem(list, '没有记录到内部语义事件', frame ? '该命令只改变命令边界状态，或没有产生战斗日志事件。' : '第 0 帧没有命令事件。')
      return
    }
    events.forEach(function (event, index) {
      var type = event && event.type || 'unknown'
      var message = event && event.payload && event.payload.message
      appendDataItem(list, (index + 1) + '. ' + eventLabel(type), message || safeJson(event, 900))
    })
  }

  function eventLabel(type) {
    var labels = {
      move: '移动',
      damage: '伤害',
      heal: '治疗',
      death: '死亡',
      status: '状态变化',
      triggerEffect: '规则触发',
      useSkill: '技能结算',
      useCard: '卡牌结算',
      drawCard: '抽牌',
      discardCard: '弃牌',
      resource: '资源变化',
      gameOver: '终局结算',
    }
    return labels[type] || ('通用事件 · ' + String(type || 'unknown'))
  }

  function renderDiffs(frame) {
    var list = document.getElementById('replayDiffList')
    clearNode(list)
    if (!frame) {
      appendDataItem(list, '初始状态', '从第 1 个命令开始显示命令前后的关键状态差异。')
      return
    }
    var beforeState = currentIndex <= 1 ? trace.initialState : trace.frames[currentIndex - 2].postState
    var diffs = collectKeyDiffs(beforeState, frame.postState)
    if (!diffs.length) {
      appendDataItem(list, '没有关键字段变化', '命令可能只改变了未列出的诊断字段；完整前后状态仍保存在 Trace 中。')
      return
    }
    diffs.slice(0, 100).forEach(function (diff) {
      appendDataItem(list, diff.path, formatCompact(diff.before) + ' → ' + formatCompact(diff.after))
    })
  }

  function collectKeyDiffs(before, after) {
    var diffs = []
    compareField(diffs, '回合.当前玩家', before.turn && before.turn.currentPlayerId, after.turn && after.turn.currentPlayerId)
    compareField(diffs, '回合.编号', before.turn && before.turn.turnNumber, after.turn && after.turn.turnNumber)
    compareField(diffs, '回合.阶段', before.turn && before.turn.phase, after.turn && after.turn.phase)

    var beforePieces = indexById(before.pieces)
    var afterPieces = indexById(after.pieces)
    unionKeys(beforePieces, afterPieces).forEach(function (id) {
      var left = beforePieces[id]
      var right = afterPieces[id]
      if (!left || !right) {
        diffs.push({ path: '棋子.' + id, before: left ? '场上' : '不存在', after: right ? '场上' : '离场' })
        return
      }
      ;['x', 'y', 'currentHp', 'maxHp', 'attack', 'defense', 'actionPoints', 'chargePoints'].forEach(function (field) {
        compareField(diffs, '棋子.' + id + '.' + field, left[field], right[field])
      })
      compareField(diffs, '棋子.' + id + '.状态', normalizeStatuses(left), normalizeStatuses(right))
      compareField(diffs, '棋子.' + id + '.已用技能', left.usedSkills || [], right.usedSkills || [])
    })

    var beforePlayers = indexPlayers(before.players)
    var afterPlayers = indexPlayers(after.players)
    unionKeys(beforePlayers, afterPlayers).forEach(function (id) {
      var left = beforePlayers[id] || {}
      var right = afterPlayers[id] || {}
      ;['actionPoints', 'maxActionPoints', 'chargePoints', 'maxChargePoints'].forEach(function (field) {
        compareField(diffs, '玩家.' + id + '.' + field, left[field], right[field])
      })
      compareField(diffs, '玩家.' + id + '.手牌数', arrayLength(left.hand), arrayLength(right.hand))
      compareField(diffs, '玩家.' + id + '.牌库数', arrayLength(left.deck), arrayLength(right.deck))
      compareField(diffs, '玩家.' + id + '.弃牌数', arrayLength(left.discardPile), arrayLength(right.discardPile))
    })

    compareField(diffs, '终局结果', before.terminalResult || null, after.terminalResult || null)
    return diffs
  }

  function indexById(pieces) {
    var result = {}
    ;(Array.isArray(pieces) ? pieces : []).forEach(function (piece) {
      var id = piece && (piece.instanceId || piece.id)
      if (id) result[id] = piece
    })
    return result
  }

  function indexPlayers(players) {
    var result = {}
    ;(Array.isArray(players) ? players : []).forEach(function (player) {
      if (player && player.playerId) result[player.playerId] = player
    })
    return result
  }

  function unionKeys(left, right) {
    var seen = {}
    Object.keys(left).forEach(function (key) { seen[key] = true })
    Object.keys(right).forEach(function (key) { seen[key] = true })
    return Object.keys(seen).sort()
  }

  function normalizeStatuses(piece) {
    return [].concat(piece.statusTags || [], piece.buffs || [], piece.debuffs || [])
  }

  function arrayLength(value) {
    return Array.isArray(value) ? value.length : 0
  }

  function compareField(diffs, path, before, after) {
    if (RvBDeveloperTools.stableJson(before) !== RvBDeveloperTools.stableJson(after)) {
      diffs.push({ path: path, before: before, after: after })
    }
  }

  function formatCompact(value) {
    if (value === undefined) return '未记录'
    if (value === null) return '无'
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
    return safeJson(value, 360).replace(/\s+/g, ' ')
  }

  function renderRandomStreams(frame) {
    var list = document.getElementById('replayRandomStreams')
    clearNode(list)
    var streams = frame && Array.isArray(frame.randomStreams) ? frame.randomStreams : []
    if (!streams.length) {
      appendDataItem(list, '本命令没有随机读取', '随机流游标未推进。')
      return
    }
    streams.forEach(function (stream) {
      var range = String(stream.startCursor) + ' → ' + String(stream.endCursor)
      appendDataItem(list, stream.name || 'unnamed stream', '游标 ' + range + (stream.values ? '\n记录值：' + safeJson(stream.values, 400) : ''))
    })
  }

  function stopPlayback() {
    playing = false
    if (playTimer) window.clearTimeout(playTimer)
    playTimer = null
    if (playButton) playButton.textContent = '播放'
  }

  function scheduleNextFrame() {
    if (!playing || !trace) return
    if (currentIndex >= trace.frames.length) {
      stopPlayback()
      return
    }
    var speed = Number(speedSelect.value) || 1
    playTimer = window.setTimeout(function () {
      setFrame(currentIndex + 1, true)
      scheduleNextFrame()
    }, Math.max(160, 900 / speed))
  }

  function togglePlayback() {
    if (playing) {
      stopPlayback()
      return
    }
    if (currentIndex >= trace.frames.length) setFrame(0, false)
    playing = true
    playButton.textContent = '暂停'
    scheduleNextFrame()
  }

  function bindControls() {
    playButton.addEventListener('click', togglePlayback)
    previousButton.addEventListener('click', function () {
      stopPlayback()
      setFrame(currentIndex - 1, false)
    })
    nextButton.addEventListener('click', function () {
      stopPlayback()
      setFrame(currentIndex + 1, true)
    })
    timeline.addEventListener('input', function () {
      stopPlayback()
      setFrame(Number(timeline.value), false)
    })
    perspectiveSelect.addEventListener('change', function () {
      setFrame(currentIndex, false)
    })
    document.getElementById('replayResetViewButton').addEventListener('click', function () {
      BattleRenderer3D.resetView()
    })
    window.addEventListener('beforeunload', function () {
      stopPlayback()
      BattleRenderer3D.dispose()
    })
  }

  async function initialize() {
    if (RvBDeveloperTools.readActiveBattle()) {
      showError('检测到尚未结束的真实对局。回放器严格限制为局外工具，请先完成或离开当前对局。')
      return
    }

    try {
      trace = await RvBDeveloperTools.readStoredTrace()
      if (!trace) throw new Error('没有可回放的 Trace v2。请返回开发者中心导入一份合法文件。')
      RvBDeveloperTools.assertTraceRecord(trace)
      buildContentLookup(trace)

      document.getElementById('replayHeaderMeta').textContent =
        (trace.roomId || '本地对局') + ' · ' + (trace.final.mapId || '未知地图') + ' · ' + trace.frames.length + ' 个命令帧'
      timeline.max = String(trace.frames.length)
      timeline.value = '0'
      workspace.hidden = false
      errorBox.hidden = true

      BattleRenderer3D.init({
        container: document.getElementById('replayBoardStage'),
        floatLayer: document.getElementById('replayFloatLayer'),
        onIntent: function (intent) {
          if (!intent) return
          if (intent.type === 'inspect-piece' && intent.pieceId) {
            selectedPieceId = intent.pieceId
            setFrame(currentIndex, false)
            return
          }
          if (intent.type === 'activate-cell') {
            var snapshot = stateAt(currentIndex)
            var piece = (Array.isArray(snapshot.pieces) ? snapshot.pieces : []).find(function (candidate) {
              return candidate && candidate.x === intent.x && candidate.y === intent.y && candidate.currentHp > 0
            })
            if (piece) {
              selectedPieceId = piece.instanceId || piece.id
              setFrame(currentIndex, false)
            }
          }
        },
      })
      bindControls()
      setFrame(0, false)
    } catch (error) {
      showError('无法打开回放：' + ((error && error.message) || error))
    }
  }

  initialize()
})()
