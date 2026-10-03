(function (global) {
  'use strict'
  const STATUS_PREFIX = 'rvb_tutorial_status:'
  const TUTORIAL_AI_TRACE_LIMIT = 64
  const TUTORIAL_AI_TRACE_REASONS = ['evaluated', 'rejected', 'blocked', 'duplicate', 'candidate-limit']

  function tutorialAiTraceDiagnostics(trace) {
    const rows = Array.isArray(trace) ? trace : []
    const roots = rows.filter(function (row) {
      return row && row.depth === 0 && TUTORIAL_AI_TRACE_REASONS.includes(row.reason)
        && typeof row.candidateId === 'string' && typeof row.rootId === 'string'
    })
    const reasons = Object.fromEntries(TUTORIAL_AI_TRACE_REASONS.map(function (reason) { return [reason, 0] }))
    roots.forEach(function (row) { reasons[row.reason] += 1 })
    const relevant = roots.filter(function (row) { return row.reason === 'evaluated' || row.reason === 'rejected' })
    const other = roots.filter(function (row) { return row.reason !== 'evaluated' && row.reason !== 'rejected' })
    const selected = relevant.concat(other).slice(0, TUTORIAL_AI_TRACE_LIMIT)
    const entries = selected.map(function (row) {
      const entry = {
        depth: 0,
        candidateId: row.candidateId,
        rootId: row.rootId,
        reason: row.reason,
      }
      if (Number.isFinite(row.score)) entry.score = row.score
      if (row.reason === 'rejected' && typeof row.error === 'string') entry.error = row.error
      return entry
    })
    return {
      entries: entries,
      counts: {
        total: rows.length,
        roots: roots.length,
        reasons: reasons,
        returned: entries.length,
        truncated: roots.length > entries.length,
      },
    }
  }

  function copyTutorialAiContinuation(continuation) {
    if (!continuation || typeof continuation !== 'object') return null
    const copy = {}
    if (typeof continuation.turnKey === 'string') copy.turnKey = continuation.turnKey
    if (Number.isSafeInteger(continuation.nodes) && continuation.nodes >= 0) copy.nodes = continuation.nodes
    if (Number.isFinite(continuation.elapsedMs) && continuation.elapsedMs >= 0) copy.elapsedMs = continuation.elapsedMs
    return copy
  }

  function saveLessonStatus(storage, lessonId, status) {
    if (!storage || !lessonId || status !== 'completed') return
    try { storage.setItem(STATUS_PREFIX + lessonId, JSON.stringify({ status: status, updatedAt: Date.now() })) } catch {}
  }
  function create(lesson, hooks) {
    const root = document.createElement('aside')
    root.className = 'tutorial-dialog'
    root.id = 'tutorialLessonDialog'
    root.setAttribute('aria-label', '社长的教学提示')
    root.setAttribute('tabindex', '0')
    const title = document.createElement('h2')
    title.className = 'tutorial-dialog__scene'
    title.textContent = '第 ' + lesson.number + ' 局 · ' + lesson.title
    const header = document.createElement('div')
    header.className = 'tutorial-dialog__header'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'tutorial-dialog__toggle'
    toggle.textContent = '说明'
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', '展开教程说明')
    let collapsed = true
    function setCollapsed(next) {
      collapsed = !!next
      root.classList.toggle('is-collapsed', collapsed)
      toggle.textContent = collapsed ? '说明' : '收起'
      toggle.setAttribute('aria-expanded', String(!collapsed))
      toggle.setAttribute('aria-label', collapsed ? '展开教程提示' : '收起教程提示')
    }
    toggle.addEventListener('click', function () {
      setCollapsed(!collapsed)
      root.scrollTop = 0
    })
    header.append(title, toggle)
    const text = document.createElement('p')
    text.className = 'tutorial-dialog__text'
    text.setAttribute('aria-live', 'polite')
    const objective = document.createElement('p')
    objective.className = 'tutorial-dialog__objective'
    const actions = document.createElement('div')
    actions.className = 'tutorial-dialog__actions'
    root.append(header, text, objective, actions)
    document.body.appendChild(root)
    const bubble = document.createElement('div')
    bubble.id = 'tutorialActionBubble'
    bubble.setAttribute('role', 'status')
    document.body.appendChild(bubble)
    const seen = new Set()
    const history = []
    const review = document.createElement('details')
    const reviewLabel = document.createElement('summary')
    reviewLabel.textContent = '本局提示回看'
    const reviewItems = document.createElement('ol')
    review.append(reviewLabel, reviewItems)
    root.appendChild(review)
    let started = false
    let busy = false
    let opponentNote = ''
    let teachingCue = null
    function setTeachingCue(cue) { teachingCue = cue; hooks.setCue(cue) }
    let disposed = false
    const tacticalLesson = lesson.tactical === true
    const opening = tacticalLesson ? null : lesson.guidedOpening
    const practiceOnly = tacticalLesson && hooks.practiceOnly === true
    const tacticalWelcome = '先定目标 → 看预览 → 自由行动 → 观察结果。'
    const tacticalIntents = {
      protect: {
        label: '保护核心',
        copy: '保护核心：可以尝试撤退、护盾或治疗；先看合法预览，具体能否执行以当前规则和实际结算为准。',
      },
      attack: {
        label: '发起进攻',
        copy: '发起进攻：可以尝试调整距离、选择技能或集中火力；可行性与伤害只以合法预览和实际结算为准。',
      },
      reposition: {
        label: '调整站位',
        copy: '调整站位：可以尝试走到掩体、拉开距离或为下一次攻击找位置；只观察实际位置变化，不提前判断结果。',
      },
    }
    let failure = ''
    let message = tacticalLesson
      ? practiceOnly ? '开始实战，观察实际结算。' : tacticalWelcome
      : lesson.intro
    let terminalShown = false
    let openingStep = opening ? 'welcome' : 'free'
    let openingObjective = ''
    let tacticalStep = tacticalLesson ? 'welcome' : ''
    let tacticalIntent = null
    const tacticalIntentHistory = []
    let tacticalOwnTurns = 0
    let tacticalTipsReduced = false
    let tacticalResultSequence = 0
    let deployedPieceId = null
    let tutorialAiContinuation = null
    let tutorialAiActionsTaken = 0
    let tutorialAiTurnKey = ''
    const ordinaryTutorialAiActions = new Set(['move', 'useBasicSkill', 'useChargeSkill', 'playCard', 'endTurn'])
    function teaching() { return !!opening && openingStep !== 'free' }
    function tacticalGuidanceActive() {
      return tacticalLesson && !practiceOnly && started && !tacticalTipsReduced
    }
    function normalizePlayer(value) { return String(value || '').trim().toLowerCase() }
    function samePlayer(left, right) { return normalizePlayer(left) === normalizePlayer(right) }
    function tutorialClock() {
      return global.performance && typeof global.performance.now === 'function'
        ? global.performance.now() : Date.now()
    }
    function currentTurnKey(state) {
      const turn = state && state.turn || {}
      return String(turn.turnNumber) + ':' + normalizePlayer(turn.currentPlayerId)
    }
    function authorityStateToken(engine, state) {
      if (!engine || typeof engine.hashBattleState !== 'function') throw new Error('教程 AI 缺少权威状态哈希')
      return 'hash:' + engine.hashBattleState(state)
    }
    function resolveTutorialRootSeed(engine, state) {
      const lessonSeed = Number.isSafeInteger(lesson.rootSeed) && lesson.rootSeed >= 0 && lesson.rootSeed <= 0xffffffff
        ? lesson.rootSeed >>> 0 : undefined
      const tracedSeed = engine && typeof engine.getBattleRootSeed === 'function'
        ? engine.getBattleRootSeed(state) : undefined
      const normalizedTrace = Number.isSafeInteger(tracedSeed) && tracedSeed >= 0 && tracedSeed <= 0xffffffff
        ? tracedSeed >>> 0 : undefined
      if (lessonSeed !== undefined && normalizedTrace !== undefined && lessonSeed !== normalizedTrace) {
        throw new Error('教程权威根种子不一致')
      }
      const rootSeed = lessonSeed !== undefined ? lessonSeed : normalizedTrace
      if (rootSeed === undefined) throw new Error('教程缺少权威根种子')
      return rootSeed
    }
    function resetTutorialAiBudgetIfNeeded(state) {
      const nextKey = currentTurnKey(state)
      if (tutorialAiTurnKey !== nextKey) {
        tutorialAiTurnKey = nextKey
        tutorialAiContinuation = null
        tutorialAiActionsTaken = 0
      }
    }
    function includeTutorialAiSubmissionTime(decision, elapsedMs) {
      if (!decision || !decision.continuation || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return
      const previous = Number.isFinite(decision.continuation.elapsedMs) ? decision.continuation.elapsedMs : 0
      tutorialAiContinuation = Object.assign({}, decision.continuation, { elapsedMs: previous + elapsedMs })
    }
    function clearOpponentPresentation() {
      opponentNote = ''
      hooks.setCue(teachingCue)
    }
    function openingPiece(enemy) {
      return (hooks.getState().pieces || []).find(function (piece) {
        return piece.templateId === (enemy ? opening.targetTemplateId : opening.templateId)
          && (enemy ? piece.ownerPlayerId !== lesson.player.playerId : piece.ownerPlayerId === lesson.player.playerId)
      })
    }
    function teach(step, copy, goal) {
      openingStep = step; message = copy; openingObjective = goal
      history.push({ key: 'opening-' + step, text: copy })
      const own = openingPiece(false)
      const source = step === 'heal' || step === 'charge' ? (hooks.getState().pieces || []).find(function (p) { return p.templateId === (step === 'heal' ? 'anduin' : 'uther') && p.ownerPlayerId === lesson.player.playerId }) : own
      const target = step === 'attack' ? openingPiece(true) : own
      const skillId = step === 'charge' ? 'divine-blessing' : step === 'heal' ? 'light-of-the-light' : step === 'shield' ? 'shield-of-light' : step === 'attack' ? opening.skillId : null
      const cue = { step: step, cells: [], skillId: skillId }
      if (step === 'charge' && source) cue.cells = [{ x: source.x, y: source.y }]
      if (step === 'move' || step === 'terrain') cue.cells = [opening.moveTo]
      else if (['select', 'heal', 'shield', 'attack'].includes(step) && target) cue.cells = [{ x: target.x, y: target.y }]
      if (step === 'move' && own) cue.path = [{ x: own.x, y: own.y }, opening.moveTo]
      if (skillId && source && target) cue.path = [{ x: source.x, y: source.y }, { x: target.x, y: target.y }]
      setTeachingCue(cue)
      if (skillId && source && hooks.revealPieceSkills) hooks.revealPieceSkills(source.instanceId)
      render()
    }
    function begin() {
      started = true
      if (opening && ['deployment', 'charge', 'full-match'].includes(opening.kind)) {
        teach('deploy', '部署免费。落点须距场上所有棋子超过 5 格（横纵步数相加），只能选择高亮空格。', '选择增援 → 点击高亮落点')
      } else if (opening && opening.kind === 'protection') {
        teach('heal', '先补回生命，再用圣盾挡住下一次伤害。', '① 圣光闪耀 → ② 圣光盾')
      } else if (opening && opening.kind === 'terrain') {
        teach('terrain', '点击掩体查看地形。掩体可站立，阻挡弹射物。', '点击亮起的掩体格')
      } else if (opening) teach('select', '点击乌瑟尔，查看生命与技能。', '第一步：点击乌瑟尔')
      else if (tacticalLesson) {
        tacticalStep = practiceOnly ? 'free' : 'goal'
        openingObjective = practiceOnly ? '开始实战，观察实际结算' : tacticalWelcome
        message = practiceOnly ? '开始实战，观察实际结算。' : tacticalWelcome
        setTeachingCue(null)
        if (!practiceOnly) setCollapsed(false)
      } else { message = '接下来由你指挥，需要时点“给点思路”。'; setTeachingCue(null) }
      void pump()
    }

    function chooseTacticalIntent(key) {
      if (!tacticalGuidanceActive() || !tacticalIntents[key]) return
      const intent = tacticalIntents[key]
      tacticalIntent = key
      tacticalStep = 'action'
      openingObjective = '自由行动；完成后查看实际结果'
      const record = {
        key: 'tactical-intent-' + key + '-' + (tacticalIntentHistory.length + 1),
        text: '本回合意图：' + intent.label + '。' + intent.copy,
        intent: key,
      }
      tacticalIntentHistory.push({ intent: key, label: intent.label, text: intent.copy })
      history.push(record)
      message = intent.copy
      setCollapsed(true)
      render()
    }
    function openingAllows(action) {
      if (!teaching()) return true
      const piece = openingPiece(false)
      const target = openingPiece(true)
      if (!action || action.playerId !== lesson.player.playerId) return false
      if (['pendingOptionSelect', 'pendingTargetSelect', 'cancelPendingSelection'].includes(action.type)) return true
      if (openingStep === 'deploy') return action.type === 'deployReservePiece'
      if (openingStep === 'move-new') return action.type === 'move'
      if (openingStep === 'card') return action.type === 'playCard'
      if (['fight-crystal', 'collect', 'charge', 'practice-skill'].includes(openingStep)) return true
      if (openingStep === 'heal' || openingStep === 'shield') {
        const source = openingStep === 'heal' ? (hooks.getState().pieces || []).find(function (p) { return p.ownerPlayerId === lesson.player.playerId && p.templateId === 'anduin' }) : piece
        return action.type === 'useBasicSkill' && source && action.pieceId === source.instanceId
          && action.skillId === (openingStep === 'heal' ? 'light-of-the-light' : 'shield-of-light')
          && (!action.targetPieceId || piece && action.targetPieceId === piece.instanceId)
      }
      if (openingStep === 'move') return action.type === 'move' && piece && action.pieceId === piece.instanceId
        && action.toX === opening.moveTo.x && action.toY === opening.moveTo.y
      if (openingStep === 'attack') return action.type === 'useBasicSkill' && piece && action.pieceId === piece.instanceId
        && action.skillId === opening.skillId && (!action.targetPieceId || target && action.targetPieceId === target.instanceId)
      return openingStep === 'end-turn' && action.type === 'endTurn'
    }
    function observeOpening(action, before) {
      if (!teaching() || hooks.getState().terminalResult) return
      const state = hooks.getState()
      const piece = openingPiece(false)
      const own = state.players.find(function (p) { return p.playerId === lesson.player.playerId })
      const crystals = ((state.extensions || {}).tileEffects || []).filter(function (t) { return t.tileType === 'charge-crystal' })
      if (openingStep === 'fight-crystal' && crystals.length) {
        teach('collect', '移动到结晶格，拾取队伍充能。', '选择己方棋子，普通移动到结晶格')
        setTeachingCue({ cells: crystals })
      } else if (openingStep === 'collect' && !crystals.length && action.playerId !== lesson.player.playerId) {
        teach('fight-crystal', '结晶已被对手拿走，继续作战。', '继续作战，观察下一枚结晶')
      }
      if (action.playerId !== lesson.player.playerId) return
      if (openingStep === 'deploy' && action.type === 'deployReservePiece') {
        deployedPieceId = action.pieceId
        teach('deploy-result', '增援已上场，本回合首次普通移动免费。', '先看部署结果，再学习移动')
      } else if (openingStep === 'move-new' && action.type === 'move') {
        const previous = before.players.find(function (p) { return p.playerId === lesson.player.playerId })
        teach('new-move-result', '这次移动实际消耗 ' + (previous.actionPoints - own.actionPoints) + ' 点行动点。接下来学习手牌。', '观察行动点的变化')
      } else if (openingStep === 'card' && action.type === 'playCard') {
        teach('card-result', '卡牌已结算，查看效果与剩余行动点。', '查看手牌和资源变化')
      } else if (openingStep === 'heal' && action.type === 'useBasicSkill' && action.skillId === 'light-of-the-light') {
        const old = before.pieces.find(function (p) { return p.instanceId === piece.instanceId })
        if (piece.currentHp > old.currentHp) teach('heal-result', '乌瑟尔实际恢复了 ' + (piece.currentHp - old.currentHp) + ' 点生命。接下来学习圣盾。', '观察生命变化，再学习圣盾')
      } else if (openingStep === 'shield' && action.type === 'useBasicSkill' && action.skillId === 'shield-of-light') {
        teach('shield-result', '圣盾抵挡一次伤害。圣光盾消耗 2 行动点，对自己施放返还 1 点。', '查看圣盾状态与行动点')
      } else if (openingStep === 'collect' && action.type === 'move' && ((before.extensions || {}).tileEffects || []).some(function (t) { return t.tileType === 'charge-crystal' && t.x === action.toX && t.y === action.toY }) && own.chargePoints > before.players.find(function (p) { return p.playerId === lesson.player.playerId }).chargePoints) {
        teach('collect-result', '已拾取结晶，队伍充能增加。', '观察队伍充能点')
      } else if (openingStep === 'charge' && action.type === 'useChargeSkill') {
        teach('charge-result', '充能技能已结算，查看剩余资源与冷却。', '观察充能技能的实际效果')
      } else if (openingStep === 'practice-skill' && ['useBasicSkill', 'useChargeSkill'].includes(action.type)) {
        teach('attack-result', '技能已结算，查看目标生命、状态和剩余行动点。', '查看本次技能结果')
      } else if (openingStep === 'move' && action.type === 'move' && piece && piece.x === opening.moveTo.x && piece.y === opening.moveTo.y) {
        const previous = before.players.find(function (p) { return p.playerId === lesson.player.playerId })
        teach('move-result', '乌瑟尔已经走到这里。这次移动消耗了 ' + (previous.actionPoints - own.actionPoints) + ' 点行动点，现在剩下 ' + own.actionPoints + ' 点。', '查看行动点变化')
      } else if (openingStep === 'attack' && action.type === 'useBasicSkill' && action.skillId === opening.skillId) {
        const target = openingPiece(true)
        const previous = before.pieces.find(function (p) { return p.templateId === opening.targetTemplateId && p.ownerPlayerId !== lesson.player.playerId })
        const damage = previous ? previous.currentHp - (target ? target.currentHp : 0) : 0
        if (damage > 0) teach('attack-result', '命中了！' + previous.name + '实际减少了 ' + damage + ' 点生命。你还剩 ' + own.actionPoints + ' 点行动点。', '观察敌人生命和技能状态')
      } else if (openingStep === 'end-turn' && action.type === 'endTurn') {
        teach('watch', '观察对手的移动与攻击。', '观察对手行动，等待回合交还')
      }
    }

    function addButton(label, fn, primary) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tutorial-dialog__button' + (primary ? ' is-primary' : '')
      button.textContent = label
      button.addEventListener('click', fn)
      actions.appendChild(button)
    }
    function leave() { dispose(); hooks.exit() }
    function advanceOpeningResult() {
      if (!teaching() || disposed || failure || hooks.getState().terminalResult || hooks.getState().pendingTargetSelection || hooks.getState().pendingOptionSelection) return
      const completedStep = openingStep
      function nextWhen(step, next) {
        if (completedStep === step) next()
      }
      nextWhen('deploy-result', function () {
        teach('move-new', '选中新棋子，移动到高亮格。本回合首次普通移动免费。', '选中棋子，再点击可移动格')
        const piece = hooks.getState().pieces.find(function (p) { return p.instanceId === deployedPieceId })
        if (piece) setTeachingCue({ step: 'move-new', pieceId: piece.instanceId, cells: [{ x: piece.x, y: piece.y }] })
      })
      nextWhen('new-move-result', function () {
        teach('card', '点击“幸运币”查看，再点一次打出。', '点击幸运币查看，再点击打出')
      })
      nextWhen('card-result', function () {
        if (opening.kind === 'charge') teach('fight-crystal', '击败敌方核心，争夺留下的结晶。', '移动、使用技能作战，观察核心阵亡后的地面')
        else if (opening.kind === 'full-match') teach('practice-skill', '选中棋子，使用技能攻击合法目标。', '选棋子 → 查看技能 → 使用技能与合法目标')
        else teachEndTurn()
      })
      nextWhen('heal-result', function () {
        teach('shield', '生命补好了，用乌瑟尔的“圣光盾”保护自己。', '✓ 圣光闪耀 → ② 圣光盾')
      })
      nextWhen('shield-result', teachMove)
      nextWhen('collect-result', function () {
        teach('charge', '点击乌瑟尔的“赐福”，强化所有友军的下次伤害。场上圣盾越多，强化越高。', '乌瑟尔 → 赐福；行动点、充能点都要够')
      })
      nextWhen('charge-result', teachEndTurn)
      nextWhen('move-result', function () {
        const target = openingPiece(true)
        if (openingStep !== 'move-result') return
        teach('attack', '使用“祝福之锤”攻击' + target.name + '：消耗 1 行动点，范围 2 格。', '点击祝福之锤，再点击' + target.name)
      })
      nextWhen('attack-result', teachEndTurn)
    }
    function teachMove() {
      teach('move', opening.kind === 'terrain' ? '选中乌瑟尔，移动到亮起的掩体格。' : '选中乌瑟尔，点击或拖动到亮起的目标格。', '将乌瑟尔移到亮起的目标格')
    }
    function teachEndTurn() {
      teach('end-turn', '行动点从 1 点起，每次自己的新回合上限 +1，最多 10 点，并补满；剩余点数不累积。', '点击右下角“结束回合”，观察下回合行动点')
    }

    function statePlayer(state, playerId) {
      return state && Array.isArray(state.players)
        ? state.players.find(function (player) { return samePlayer(player.playerId, playerId) })
        : null
    }
    function statePieceLocation(state, instanceId) {
      if (!state || !instanceId) return null
      const boardPiece = (state.pieces || []).find(function (piece) { return piece.instanceId === instanceId })
      if (boardPiece) return { piece: boardPiece, zone: 'board' }
      const reserves = state.deployment && state.deployment.reserves || {}
      for (const ownerId of Object.keys(reserves)) {
        const reservePiece = (reserves[ownerId] || []).find(function (piece) { return piece.instanceId === instanceId })
        if (reservePiece) return { piece: reservePiece, zone: 'reserve' }
      }
      return null
    }
    function positionText(piece, zone) {
      if (zone === 'reserve') return '预备区'
      if (!piece || !Number.isFinite(piece.x) || !Number.isFinite(piece.y)) return '离场'
      return '(' + piece.x + ', ' + piece.y + ')'
    }
    function tacticalActionResult(action, before, after) {
      if (!tacticalLesson || !action || !samePlayer(action.playerId, lesson.player.playerId)) return ''
      const previousPlayer = statePlayer(before, lesson.player.playerId)
      const currentPlayer = statePlayer(after, lesson.player.playerId)
      const changes = []
      if (previousPlayer && currentPlayer) {
        changes.push('AP ' + previousPlayer.actionPoints + '→' + currentPlayer.actionPoints)
        changes.push('CP ' + previousPlayer.chargePoints + '→' + currentPlayer.chargePoints)
      }

      const ids = new Set()
      ;(before && before.pieces || []).forEach(function (piece) { ids.add(piece.instanceId) })
      ;(after && after.pieces || []).forEach(function (piece) { ids.add(piece.instanceId) })
      const previousOwnPieces = []
      let ownHealthObserved = false
      ids.forEach(function (instanceId) {
        const previousLocation = statePieceLocation(before, instanceId)
        const currentLocation = statePieceLocation(after, instanceId)
        const previous = previousLocation && previousLocation.piece
        const current = currentLocation && currentLocation.piece
        const piece = current || previous
        if (!piece) return
        const own = samePlayer(piece.ownerPlayerId, lesson.player.playerId)
        const oldHp = previous && Number.isFinite(previous.currentHp) ? previous.currentHp : null
        const newHp = current && Number.isFinite(current.currentHp) ? current.currentHp : null
        if (own) {
          if (oldHp !== null || newHp !== null) ownHealthObserved = true
          if (oldHp !== null && newHp !== null && oldHp !== newHp) {
            changes.push(piece.name + '生命 ' + oldHp + '→' + newHp)
          } else if (oldHp !== null && newHp === null) {
            changes.push(piece.name + '离场（离场前生命 ' + oldHp + '）')
          }
        } else if (oldHp !== null && newHp !== null && oldHp !== newHp) {
          changes.push(piece.name + '生命 ' + oldHp + '→' + newHp)
        } else if (oldHp !== null && newHp === null) {
          changes.push(piece.name + '离场（离场前生命 ' + oldHp + '）')
        }
        const oldPosition = previous && positionText(previous, previousLocation && previousLocation.zone)
        const newPosition = current ? positionText(current, currentLocation && currentLocation.zone) : '离场'
        if (own && previous && oldPosition !== newPosition) {
          changes.push(piece.name + '位置 ' + oldPosition + '→' + newPosition)
        }
        if (own && (oldHp !== null || newHp !== null)) previousOwnPieces.push(piece)
      })
      if (!ownHealthObserved && previousOwnPieces.length) changes.push('自身生命未变化')
      const text = changes.length ? '本次行动实际结果：' + changes.join('；') : '本次行动实际结果：没有可见状态变化。'
      tacticalResultSequence += 1
      history.push({
        key: 'tactical-result-' + tacticalResultSequence,
        text: text,
        action: action,
        intent: tacticalIntent,
      })
      if (action.type === 'endTurn') {
        tacticalOwnTurns += 1
        if (tacticalOwnTurns >= 2) tacticalTipsReduced = true
      }
      return text
    }
    function render() {
      if (disposed) return
      const terminal = hooks.getState().terminalResult
      root.classList.toggle('is-busy', busy)
      root.classList.toggle('is-guiding', started && !terminal && !failure && (teaching() || tacticalGuidanceActive()))
      root.classList.toggle('is-review', openingStep === 'review')
      root.classList.toggle('is-collapsed', started && collapsed && !terminal && !failure)
      text.textContent = failure || opponentNote || message
      const prompts = {
        deploy: '增援要离所有棋子超过 5 格，包括友军。横着、竖着各算一步；第 6 格才可部署。',
        'move-new': '先点新部署的棋子，再点可移动格；本回合首次移动免费。',
        card: '点幸运币查看，再点一次打出。',
        heal: '点“圣光闪耀”，再点受伤的乌瑟尔。',
        shield: '点“圣光盾”，给乌瑟尔自己加盾。',
        charge: '点乌瑟尔的“赐福”。它消耗行动点和充能点，强化全体友军。',
        'end-turn': '行动点从 1 点起。每次自己的新回合上限 +1，并补满；最多 10 点。',
        review: '行动点已补满。点上方“继续本局练习”，轮到你指挥了。',
        select: '点亮起的棋子，查看它的技能。',
        move: '点亮起的落点，也可以把棋子拖过去。',
        attack: '点箭头标出的技能，再点亮起的敌人。',
        collect: '走到结晶上，就能拾取充能点。',
        'fight-crystal': '击败敌方核心，地上会留下充能结晶。',
      }
      let bubbleText = prompts[openingStep] || ''
      let bubbleVisible = started && !busy && !terminal && !failure && !!bubbleText
      if (tacticalLesson) {
        bubbleText = tacticalIntent ? tacticalIntents[tacticalIntent].copy : tacticalWelcome
        bubbleVisible = false
      }
      bubble.hidden = !bubbleVisible
      bubble.textContent = bubbleText
      bubble.setAttribute('data-step', tacticalLesson ? tacticalStep : openingStep)
      objective.textContent = terminal
        ? '本局已结束'
        : failure
          ? '练习中断，可重开或返回课程'
          : !started
            ? tacticalLesson ? practiceOnly ? '开始实战，观察实际结算' : tacticalWelcome : '点击开始学习'
            : busy
              ? '等待对手行动'
              : teaching()
                ? openingObjective
                : tacticalGuidanceActive()
                  ? (tacticalIntent ? '目标：' + tacticalIntents[tacticalIntent].label + ' · 自由行动' : tacticalWelcome)
                  : '自由行动，按需查看帮助'
      actions.replaceChildren()
      reviewItems.replaceChildren()
      history.filter(function (notice) { return notice.key !== 'ai-rejected' }).forEach(function (notice) {
        const item = document.createElement('li')
        item.textContent = notice.text
        reviewItems.appendChild(item)
      })
      review.hidden = !reviewItems.children.length
      if (terminal || failure) {
        addButton('再试一次', function () { dispose(); hooks.restart() }, true)
        const nextLesson = global.RvBTutorialLessons.all[lesson.number]
        if (terminal && nextLesson && nextLesson.enabled !== false) addButton('下一局', function () { dispose(); hooks.next() })
      } else if (!started) {
        addButton(opening ? '开始学习' : tacticalLesson ? practiceOnly ? '开始实战' : '开始学习' : '开始本局', begin, true)
      } else if (teaching()) {
        if (openingStep === 'review') addButton('继续本局练习', function () {
          if (openingStep !== 'review') return
          openingStep = 'free'; message = '继续作战，消灭敌方场上核心。'; setTeachingCue(null); render()
        }, true)
      } else if (tacticalLesson) {
        if (!practiceOnly && !tacticalTipsReduced) {
          addButton(tacticalIntents.protect.label, function () { chooseTacticalIntent('protect') }, tacticalIntent === 'protect')
          addButton(tacticalIntents.attack.label, function () { chooseTacticalIntent('attack') }, tacticalIntent === 'attack')
          addButton(tacticalIntents.reposition.label, function () { chooseTacticalIntent('reposition') }, tacticalIntent === 'reposition')
        }
        if (!practiceOnly) addButton('给点思路', function () { message = lesson.help; render() })
      } else {
        addButton('给点思路', function () { message = lesson.help; render() })
      }
      addButton('返回课程', leave)
      if (hooks.positionGuide) hooks.positionGuide()
    }
    function observe(action, before) {
      const after = hooks.getState()
      const tacticalFeedback = tacticalActionResult(action, before, after)
      observeOpening(action, before)
      advanceOpeningResult()
      const previousPlayer = before && before.players && before.players.find(function (p) { return p.playerId === lesson.player.playerId })
      const currentPlayer = after.players && after.players.find(function (p) { return p.playerId === lesson.player.playerId })
      if (previousPlayer && currentPlayer && currentPlayer.maxActionPoints > previousPlayer.maxActionPoints && hooks.showResourceGrowth) {
        hooks.showResourceGrowth(previousPlayer.maxActionPoints, currentPlayer.maxActionPoints)
      }
      const notices = global.RvBTutorialLessons && typeof global.RvBTutorialLessons.observe === 'function'
        ? global.RvBTutorialLessons.observe(lesson, before, after, action, seen) : []
      notices.forEach(function (notice) { history.push(notice) })
      if (!teaching() && tacticalFeedback) {
        message = tacticalFeedback
        if (tacticalLesson && !practiceOnly) setCollapsed(false)
      }
      else if (!teaching() && notices.length) message = notices[0].text
      render()
    }
    function showResult() {
      const terminal = hooks.getState().terminalResult
      if (!terminal || disposed || terminalShown) return
      terminalShown = true
      const won = terminal.winnerPlayerId === lesson.player.playerId
      if (won) saveLessonStatus(global.localStorage, lesson.id, 'completed')
      const reasons = { 'core-eliminated': '一方场上核心全灭', 'mutual-core-elimination': '双方场上核心同时全灭', 'round-limit': '达到轮次上限', surrender: '投降', 'timeout-surrender': '超时投降' }
      message = (terminal.winnerPlayerId ? won ? '你赢下了本局。' : '本局失败。' : '本局平局。') + '原因：' + (reasons[terminal.reason] || terminal.reason) + '。'
      setTeachingCue(null)
      render()
    }
    function pause(ms) {
      return new Promise(function (resolve) { global.setTimeout(resolve, ms) })
    }
    function describeOpponentAction(action, state) {
      const pieces = state.pieces || []
      const source = pieces.find(function (p) { return p.instanceId === action.pieceId })
      const target = pieces.find(function (p) { return p.instanceId === action.targetPieceId })
      const name = source ? source.name : '对手'
      const skill = (state.skillsById || {})[action.skillId]
      if (action.type === 'move') return name + '移动到 (' + action.toX + ', ' + action.toY + ')'
      if (action.type === 'deployReservePiece') return '对手部署' + (source ? source.name : '增援')
      if (action.type === 'endTurn') return '对手结束回合'
      if (action.type === 'beginPhase') return '回合开始，结算效果'
      if (action.type === 'playCard') return '对手使用手牌'
      if (action.skillId) return name + '使用' + (skill && skill.name || '技能') + (target ? ' → ' + target.name : '')
      return name + '完成选择'
    }
    function opponentCue(action, state) {
      const cells = (state.pieces || []).filter(function (p) {
        return p.instanceId === action.pieceId || p.instanceId === action.targetPieceId
      }).filter(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 })
        .map(function (p) { return { x: p.x, y: p.y } })
      const x = action.toX ?? action.targetX, y = action.toY ?? action.targetY
      if (Number.isFinite(x) && Number.isFinite(y)) cells.push({ x: x, y: y })
      return cells.length ? { cells: cells } : null
    }
    function describeResult(before, after) {
      const changes = []
      ;(before.pieces || []).forEach(function (piece) {
        const next = (after.pieces || []).find(function (p) { return p.instanceId === piece.instanceId })
        if (!next && piece.currentHp > 0) { changes.push(piece.name + '离场'); return }
        const delta = next && next.currentHp - piece.currentHp
        if (delta) changes.push(piece.name + (delta < 0 ? '受到 ' + -delta + ' 点伤害' : '回复 ' + delta + ' 点生命'))
      })
      return changes.length ? '。' + changes.slice(0, 3).join('；') + (changes.length > 3 ? '等' : '') : ''
    }
    async function pumpTutorialSearchAction(engine, state, owner) {
      resetTutorialAiBudgetIfNeeded(state)
      const expectedState = state
      const expectedOwner = owner
      // Keep the exact input continuation/counter before the worker can return
      // the next continuation. Replay evidence must explain this decision,
      // rather than the state produced by the decision itself.
      const inputContinuation = copyTutorialAiContinuation(tutorialAiContinuation)
      const inputActionsTaken = tutorialAiActionsTaken
      const expectedToken = authorityStateToken(engine, state)
      const rootSeed = resolveTutorialRootSeed(engine, state)
      if (typeof hooks.search !== 'function') throw new Error('教程 AI 搜索客户端不可用')
      if (hooks.onAiDecisionStart) {
        hooks.onAiDecisionStart({
          state: expectedState,
          owner: expectedOwner,
          rootSeed: rootSeed,
          continuation: tutorialAiContinuation,
          actionsTakenThisTurn: tutorialAiActionsTaken,
        })
      }
      const decisionStarted = tutorialClock()
      let decision
      try {
        decision = await hooks.search({
          state: expectedState,
          playerId: expectedOwner,
          rootSeed: rootSeed,
          continuation: tutorialAiContinuation,
          actionsTakenThisTurn: tutorialAiActionsTaken,
        })
      } catch (error) {
        const reason = error && error.code ? ' [' + error.code + ']' : ''
        throw new Error('教程 AI 搜索失败' + reason + '：' + (error && error.message || String(error)))
      }
      const measuredDecisionElapsed = Math.max(0, tutorialClock() - decisionStarted)
      if (!decision || !decision.nextAction || !decision.nextAction.action) {
        const reason = decision && decision.stopReason ? '（' + decision.stopReason + '）' : ''
        throw new Error('教程 AI 未找到可执行指令' + reason)
      }
      if (!decision.continuation) throw new Error('教程 AI 未返回可继续的搜索预算')
      const decisionElapsed = Number.isFinite(decision.elapsedMs) ? decision.elapsedMs : 0
      // Preserve the search continuation before pacing. A stale authority
      // snapshot still consumed search work and must not silently reset it.
      tutorialAiContinuation = decision.continuation
      const action = decision.nextAction.action
      if (action.playerId !== undefined && !samePlayer(action.playerId, expectedOwner)) {
        throw new Error('教程 AI 选择了错误行动方的指令')
      }
      if (hooks.onAiDecisionResult) {
        const traceDiagnostics = tutorialAiTraceDiagnostics(decision.trace)
        const details = {
          action: action,
          owner: expectedOwner,
          turn: expectedState.turn,
          requestMs: measuredDecisionElapsed,
          decisionMs: decisionElapsed,
          nodes: decision.nodes,
          considered: decision.considered,
          score: Number.isFinite(decision.score) ? decision.score : undefined,
          trace: traceDiagnostics.entries,
          traceCounts: traceDiagnostics.counts,
          overTurnBudget: decision.overTurnBudget === true,
          overDecisionBudget: decision.overDecisionBudget === true,
          continuation: copyTutorialAiContinuation(decision.continuation),
          actionsTakenThisTurn: inputActionsTaken,
          stopReason: decision.stopReason,
        }
        const actingPlayer = (expectedState.players || []).find(function (player) {
          return player && samePlayer(player.playerId, expectedOwner)
        })
        const captureReplay = hooks.captureAiReplay === true
          && action.type === 'endTurn'
          && (inputActionsTaken === 0
            || (decision.stopReason === 'time-budget' && decision.overTurnBudget === true
              && Number(actingPlayer && actingPlayer.actionPoints) > 0))
        if (captureReplay) {
          details.replayInput = {
            state: expectedState,
            rootSeed: rootSeed,
            playerId: expectedOwner,
            continuation: inputContinuation,
            actionsTakenThisTurn: inputActionsTaken,
          }
          details.replayResult = {
            action: Object.assign({}, action),
            score: Number.isFinite(decision.score) ? decision.score : undefined,
            nodes: decision.nodes,
            considered: decision.considered,
            elapsedMs: decisionElapsed,
            overTurnBudget: decision.overTurnBudget === true,
            overDecisionBudget: decision.overDecisionBudget === true,
            stopReason: decision.stopReason,
            continuation: copyTutorialAiContinuation(decision.continuation),
          }
        }
        hooks.onAiDecisionResult(details)
      }
      const opponentAction = !samePlayer(owner, lesson.player.playerId)
      const phaseOnly = action.type === 'beginPhase'
      const description = describeOpponentAction(action, state)
      if (opponentAction) {
        opponentNote = '看这里：' + description
        hooks.setCue(opponentCue(action, state))
        render()
        await pause(phaseOnly ? 350 : 1000)
      }
      if (disposed) return 'disposed'
      const submissionStarted = tutorialClock()
      const latest = hooks.getState()
      const latestOwner = engine.getCurrentInputOwnerPlayerId(latest)
      const latestToken = authorityStateToken(engine, latest)
      if (latest !== expectedState || !samePlayer(latestOwner, expectedOwner)
        || latestToken !== expectedToken) {
        const submissionElapsed = Math.max(0, tutorialClock() - submissionStarted)
        includeTutorialAiSubmissionTime(decision, submissionElapsed + Math.max(0, measuredDecisionElapsed - decisionElapsed))
        if (hooks.onAiDecisionSettled) hooks.onAiDecisionSettled({ action: action, stale: true })
        clearOpponentPresentation()
        return 'stale'
      }
      const before = latest
      try {
        const result = await hooks.commit(action)
        if (result && result.accepted === false) throw new Error(result.error && result.error.message || '权威提交拒绝了行动')
      } catch (error) {
        const reason = error && error.code ? ' [' + error.code + ']' : ''
        throw new Error('教程 AI 选定行动被权威拒绝' + reason + '：' + (error && error.message || String(error)))
      }
      if (disposed) return 'disposed'
      const submissionElapsed = Math.max(0, tutorialClock() - submissionStarted)
      includeTutorialAiSubmissionTime(decision, submissionElapsed + Math.max(0, measuredDecisionElapsed - decisionElapsed))
      if (ordinaryTutorialAiActions.has(action.type) && action.playerId !== undefined
        && samePlayer(action.playerId, expectedOwner)) tutorialAiActionsTaken += 1
      if (hooks.onAiDecisionCommitted) {
        hooks.onAiDecisionCommitted({
          action: action,
          owner: expectedOwner,
          turn: expectedState.turn,
          actionsTakenThisTurn: tutorialAiActionsTaken,
        })
      }
      if (opponentAction) {
        opponentNote = description + describeResult(before, hooks.getState())
        render()
        await pause(phaseOnly ? 700 : 2000)
        if (disposed) return 'disposed'
        clearOpponentPresentation()
      }
      observe(action, before)
      if (hooks.onAiDecisionSettled) hooks.onAiDecisionSettled({ action: action, stale: false })
      return 'accepted'
    }
    async function pumpLegacyAction(engine, state, owner) {
      const plan = engine.planBotActions(state, owner)
      if (!plan || !Array.isArray(plan.actions) || !plan.actions.length) throw new Error('当前局面没有可执行的人机行动')
      const humanStructural = samePlayer(owner, lesson.player.playerId)
      if (humanStructural && plan.kind !== 'structural') throw new Error('旧 AI 只能推进人类结构阶段')
      let applied = false
      let stale = false
      for (const draft of plan.actions) {
        if (disposed) return 'disposed'
        const current = hooks.getState()
        if (current.terminalResult || !samePlayer(engine.getCurrentInputOwnerPlayerId(current), owner)) break
        const expectedToken = authorityStateToken(engine, current)
        const action = engine.prepareLegalBotAction(current, draft, owner)
        if (!action) continue
        if (humanStructural && ordinaryTutorialAiActions.has(action.type)) throw new Error('旧 AI 不得替代人类普通行动')
        const opponentAction = !samePlayer(owner, lesson.player.playerId)
        const phaseOnly = action.type === 'beginPhase'
        const description = describeOpponentAction(action, current)
        if (opponentAction) {
          opponentNote = '看这里：' + description
          hooks.setCue(opponentCue(action, current))
          render()
          await pause(phaseOnly ? 350 : 1000)
        }
        if (disposed) return 'disposed'
        const latest = hooks.getState()
        if (latest !== current || !samePlayer(engine.getCurrentInputOwnerPlayerId(latest), owner)
          || authorityStateToken(engine, latest) !== expectedToken) {
          clearOpponentPresentation()
          stale = true
          break
        }
        const before = latest
        try {
          await hooks.commit(action)
        } catch (error) {
          if (!error || error.name !== 'BattleRuleError') throw error
          history.push({ key: 'ai-rejected', text: error.message, turn: before.turn.turnNumber, action: action })
          continue
        }
        if (disposed) return 'disposed'
        applied = true
        if (opponentAction) {
          opponentNote = description + describeResult(before, hooks.getState())
          render()
          await pause(phaseOnly ? 700 : 2000)
          if (disposed) return 'disposed'
          clearOpponentPresentation()
        }
        observe(action, before)
      }
      if (stale) return 'stale'
      if (!applied) throw new Error('人机计划已失效，请重新开始本局')
      return 'accepted'
    }
    async function pumpTacticalStructuralPhase(engine, state, owner) {
      if (!state || !['start', 'end'].includes(state.turn && state.turn.phase)) return 'waiting'
      const expectedState = state
      const expectedToken = authorityStateToken(engine, state)
      const latest = hooks.getState()
      if (latest !== expectedState
        || !samePlayer(engine.getCurrentInputOwnerPlayerId(latest), owner)
        || authorityStateToken(engine, latest) !== expectedToken) return 'stale'
      const before = latest
      await hooks.commit({ type: 'beginPhase' })
      if (disposed) return 'disposed'
      observe({ type: 'beginPhase' }, before)
      return 'accepted'
    }
    async function pump(options) {
      if (busy || disposed || !started || failure) return
      const suppressIdleRender = !!(options && options.suppressIdleRender)
      let progressed = false
      busy = true
      if (!suppressIdleRender) render()
      try {
        const engine = await hooks.engine()
        if (disposed) return
        // Bound malfunctioning policies; interruption must never turn into a fabricated loss.
        for (let count = 0; count < 200; count++) {
          if (disposed) return
          const state = hooks.getState()
          if (state.terminalResult) { showResult(); return }
          const owner = engine.getCurrentInputOwnerPlayerId(state)
          const deployment = state.deployment
          const awaitingChoice = !!state.pendingOptionSelection || !!state.pendingTargetSelection
            || deployment && deployment.status === 'awaiting-reserve-deploy'
          const humanOwner = samePlayer(owner, lesson.player.playerId)
          if (humanOwner && (state.turn.phase === 'action' || awaitingChoice)) return

          // Staged openings retain their carefully paced demonstration. During free
          // play the new planner owns exactly one opponent action per iteration.
          const stagedOpponent = teaching() && !humanOwner
          const humanStructural = humanOwner && !awaitingChoice && state.turn.phase !== 'action'
          const legacyOpening = !tacticalLesson && (stagedOpponent || humanStructural)
          const tacticalStructural = tacticalLesson && humanStructural
          const result = legacyOpening
            ? await pumpLegacyAction(engine, state, owner)
            : tacticalStructural
              ? await pumpTacticalStructuralPhase(engine, state, owner)
              : humanOwner ? 'waiting' : await pumpTutorialSearchAction(engine, state, owner)
          if (result === 'disposed' || result === 'waiting') return
          if (result === 'stale') { progressed = true; continue }
          if (result === 'accepted') progressed = true
        }
        throw new Error('人机行动超过本次安全上限')
      } catch (error) {
        if (hooks.onAiDecisionError) hooks.onAiDecisionError(error)
        failure = '练习暂时中断：' + (error && error.message || String(error))
      } finally {
        busy = false
        opponentNote = ''
        if (!disposed && !failure && openingStep === 'watch' && !hooks.getState().terminalResult) {
          teach('review', '又轮到你了，行动点已补充。继续用刚学会的操作作战。', '观察新回合，再继续练习')
        }
        if (!disposed) {
          hooks.setCue(teachingCue)
          const terminal = !!hooks.getState().terminalResult
          if (!suppressIdleRender || progressed || failure || terminal) hooks.render()
          showResult()
          render()
        }
      }
    }
    function dispose() { disposed = true; setTeachingCue(null); root.remove(); bubble.remove() }
    render()
    setTeachingCue(lesson.cue || null)
    return Object.freeze({
      beforeAction: function (action) {
        if (!started || busy || disposed || failure || hooks.getState().terminalResult) return { allowed: false, message: failure || (!started ? '先点击开始学习。' : '等待当前行动结算。') }
        if (!openingAllows(action)) return { allowed: false, message: openingObjective || '先跟随引导完成这一项操作。' }
        return { allowed: true }
      },
      afterAcceptedAction: async function (action, before) {
        observe(action, before)
        showResult()
        await pump({ suppressIdleRender: true })
      },
      afterIntent: function (intent) {
        if (!started || busy || disposed || hooks.getState().terminalResult) return
        if (openingStep === 'terrain' && intent.type === 'activate-cell' && intent.x === opening.moveTo.x && intent.y === opening.moveTo.y) {
          teach('select', '这格是掩体，可以站人。接下来点击乌瑟尔，再把他移到刚才的掩体格。技能能否穿过地形，要看技能类型与合法目标。', '点击乌瑟尔')
          return
        }
        if (openingStep !== 'select') return
        const piece = openingPiece(false)
        if (piece && hooks.getSelectedPieceId && hooks.getSelectedPieceId() === piece.instanceId) {
          teachMove()
        }
      }, showResult: showResult, dispose: dispose,
      snapshot: function () {
        return {
          lessonId: lesson.id,
          started: started,
          busy: busy,
          failure: failure,
          openingStep: openingStep,
          tacticalStep: tacticalStep,
          tactical: tacticalLesson,
          practiceOnly: practiceOnly,
          goalIntent: tacticalIntent,
          goalIntents: tacticalIntentHistory.slice(),
          ownTurns: tacticalOwnTurns,
          activeTips: tacticalGuidanceActive(),
          tipsReduced: tacticalTipsReduced,
          notices: history.slice(),
        }
      },
    })
  }
  global.RvBTutorialLessonRuntime = Object.freeze({ create: create, saveLessonStatus: saveLessonStatus })
})(typeof window !== 'undefined' ? window : globalThis)
