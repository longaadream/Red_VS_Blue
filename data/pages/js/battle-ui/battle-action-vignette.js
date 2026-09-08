;(function (root) {
  'use strict'

  const NORMAL_DURATION_MS = 1100
  const CARD_DURATION_MS = 1800
  const REDUCED_DURATION_MS = 120
  const SKIP_SETTLE_MS = 60
  const MAX_PLAYED_ROOTS = 256

  function actionDuration(group) {
    return group && group.root && group.root.kind === 'card' ? CARD_DURATION_MS : NORMAL_DURATION_MS
  }

  function phaseTime(phase, group) {
    return phase === 'settle' ? actionDuration(group) - 320 : ({ path: 120, result: 420 }[phase] || 0)
  }

  function eventOrder(left, right) {
    return Number(left && left.sequence || 0) - Number(right && right.sequence || 0)
      || String(left && left.eventId || '').localeCompare(String(right && right.eventId || ''))
  }

  function groupEvents(events) {
    const byRoot = new Map()
    const rootOrder = new Map()
    ;(Array.isArray(events) ? events : []).forEach(function (event) {
      if (event && event.rootEventId && !rootOrder.has(String(event.rootEventId))) rootOrder.set(String(event.rootEventId), rootOrder.size)
    })
    ;(Array.isArray(events) ? events : []).slice().sort(eventOrder).forEach(function (event) {
      if (!event || !event.eventId || !event.rootEventId) return
      const rootId = String(event.rootEventId)
      let group = byRoot.get(rootId)
      if (!group) {
        group = { rootEventId: rootId, root: null, children: [], eventIds: new Set() }
        byRoot.set(rootId, group)
      }
      const eventId = String(event.eventId)
      if (group.eventIds.has(eventId)) return
      group.eventIds.add(eventId)
      if (!event.parentEventId || eventId === rootId) {
        if (!group.root) group.root = event
        return
      }
      group.children.push(event)
    })
    return Array.from(byRoot.values())
      .filter(function (group) { return !!group.root })
      .map(function (group) {
        return {
          rootEventId: group.rootEventId,
          root: group.root,
          children: group.children.sort(eventOrder),
        }
      })
      .sort(function (left, right) {
        return Number(left.root.sequence || 0) - Number(right.root.sequence || 0)
          || rootOrder.get(left.rootEventId) - rootOrder.get(right.rootEventId)
      })
      .flatMap(function (group) {
        const beats = []
        ;[group.root].concat(group.children).forEach(function (event) {
          const previous = beats[beats.length - 1]
          const simultaneous = ['damage', 'heal', 'spawn', 'death', 'statusAdded', 'statusRemoved', 'tileEffectAdded', 'tileEffectRemoved'].includes(event.kind)
            && event.batchId && previous && previous.root.kind === event.kind
            && previous.root.batchId === event.batchId
          if (simultaneous) previous.children.push(event)
          else beats.push({ rootEventId: event.eventId, root: event, children: [], identityEvents: [group.root].concat(group.children) })
        })
        return beats
      })
  }

  function createQueue(options) {
    const input = options || {}
    const schedule = input.setTimeout || root.setTimeout
    const cancel = input.clearTimeout || root.clearTimeout
    const now = typeof input.now === 'function' ? input.now : Date.now
    const onPhase = typeof input.onPhase === 'function' ? input.onPhase : function () {}
    const onIdle = typeof input.onIdle === 'function' ? input.onIdle : function () {}
    const reducedMotion = input.reducedMotion === true
    const forcePlayback = input.forcePlayback === true
    const playedRoots = new Set()
    const playedOrder = []
    let primed = false
    let active = null
    let pending = []
    let timers = []
    let speed = 1
    let disposed = false
    let lastIsViewerTurn = null
    let activeProgressMs = 0
    let activeTimelineStartedAt = 0
    let skipSettling = false

    function remember(rootId) {
      if (playedRoots.has(rootId)) return false
      playedRoots.add(rootId)
      playedOrder.push(rootId)
      if (playedOrder.length > MAX_PLAYED_ROOTS) playedRoots.delete(playedOrder.shift())
      return true
    }

    function clearTimers() {
      timers.splice(0).forEach(function (timer) { if (cancel) cancel(timer) })
    }

    function later(callback, delay) {
      if (!schedule) return null
      const timer = schedule(function () {
        timers = timers.filter(function (entry) { return entry !== timer })
        callback()
      }, Math.max(0, delay))
      timers.push(timer)
      return timer
    }

    function completeActive() {
      clearTimers()
      active = null
      activeProgressMs = 0
      activeTimelineStartedAt = 0
      skipSettling = false
      startNext()
    }

    function scheduleActiveTimeline() {
      if (!active) return
      clearTimers()
      activeTimelineStartedAt = now()
      const duration = reducedMotion ? REDUCED_DURATION_MS : actionDuration(active)
      if (!reducedMotion) {
        ;[
          { at: 120, phase: 'path' },
          { at: 420, phase: 'result' },
          { at: phaseTime('settle', active), phase: 'settle' },
        ].forEach(function (entry) {
          if (entry.at <= activeProgressMs) return
          later(function () { if (active) onPhase(entry.phase, active) }, (entry.at - activeProgressMs) / speed)
        })
      }
      later(completeActive, Math.max(0, duration - activeProgressMs) / speed)
    }

    function startNext() {
      if (disposed || active) return
      active = pending.shift() || null
      if (!active) {
        onIdle()
        return
      }
      activeProgressMs = 0
      activeTimelineStartedAt = now()
      if (reducedMotion) {
        onPhase('static', active)
        activeProgressMs = 0
        scheduleActiveTimeline()
        return
      }
      onPhase('focus', active)
      activeProgressMs = 0
      scheduleActiveTimeline()
    }

    function settleAll() {
      if (active) onPhase('settle', active)
      clearTimers()
      active = null
      activeProgressMs = 0
      activeTimelineStartedAt = 0
      skipSettling = false
      pending = []
      onIdle()
    }

    function update(model) {
      if (disposed || !model) return
      const groups = groupEvents(model.presentationEvents)
      const isViewerTurn = !!(model.turn && model.turn.isViewerTurn)
      if (!primed) {
        groups.forEach(function (group) { remember(group.root.rootEventId) })
        primed = true
        lastIsViewerTurn = isViewerTurn
        return
      }
      const freshRoots = new Set()
      groups.forEach(function (group) { if (remember(group.root.rootEventId)) freshRoots.add(group.root.rootEventId) })
      const incoming = groups.filter(function (group) { return freshRoots.has(group.root.rootEventId) })
      const controlReturnedToViewer = !forcePlayback && lastIsViewerTurn === false && isViewerTurn
      lastIsViewerTurn = isViewerTurn
      const hasPendingBanner = [active].concat(pending, incoming).some(function (group) {
        return group && group.root && group.root.result && group.root.result.pending === true
      })
      if (controlReturnedToViewer && !hasPendingBanner) {
        settleAll()
      }
      pending.push.apply(pending, incoming)
      startNext()
    }

    function skip() {
      if (disposed || !active) return false
      if (skipSettling) {
        completeActive()
        if (!active) return true
      }
      clearTimers()
      skipSettling = true
      onPhase('settle', active)
      later(completeActive, SKIP_SETTLE_MS)
      return true
    }

    function setSpeed(nextSpeed) {
      const normalized = Number(nextSpeed) === 2 ? 2 : 1
      if (normalized === speed) return
      if (active) {
        activeProgressMs += Math.max(0, now() - activeTimelineStartedAt) * speed
        activeProgressMs = Math.min(reducedMotion ? REDUCED_DURATION_MS : actionDuration(active), activeProgressMs)
      }
      speed = normalized
      if (active) scheduleActiveTimeline()
    }

    function dispose() {
      disposed = true
      clearTimers()
      active = null
      activeProgressMs = 0
      activeTimelineStartedAt = 0
      skipSettling = false
      pending = []
      playedRoots.clear()
      playedOrder.length = 0
    }

    return {
      update: update,
      reset: function (model) {
        settleAll(); playedRoots.clear(); playedOrder.length = 0; primed = false
        update(model)
      },
      skip: skip,
      setSpeed: setSpeed,
      settleAll: settleAll,
      dispose: dispose,
      getDiagnostics: function () {
        return {
          activeRootId: active ? active.rootEventId : null,
          pendingRootIds: pending.map(function (group) { return group.rootEventId }),
          speed: speed,
          playedRootCount: playedRoots.size,
          timerCount: timers.length,
          activeProgressMs: active ? Math.min(actionDuration(active), activeProgressMs + Math.max(0, now() - activeTimelineStartedAt) * speed) : 0,
        }
      },
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function finite(value) {
    return value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
  }

  function pieceById(model, pieceId) {
    return ((model && model.pieces) || []).find(function (piece) { return piece.id === pieceId }) || null
  }

  function pieceCell(model, pieceId) {
    const piece = pieceById(model, pieceId)
    const x = finite(piece && piece.x)
    const y = finite(piece && piece.y)
    return x == null || y == null ? null : { x: x, y: y }
  }

  function eventCells(group, model) {
    const rootEvent = group && group.root || {}
    const presentation = rootEvent.presentation || {}
    const result = rootEvent.result || {}
    const source = finite(result.fromX) != null && finite(result.fromY) != null
      ? { x: finite(result.fromX), y: finite(result.fromY) }
      : pieceCell(model, rootEvent.sourcePieceId)
    const selected = presentation.selectedCell || null
    const end = presentation.endPoint || null
    const path = Array.isArray(presentation.pathCells) ? presentation.pathCells : []
    const area = Array.isArray(presentation.areaCells) ? presentation.areaCells : []
    const targetCells = []
    ;[rootEvent].concat(group.children || []).forEach(function (event) {
      ;(event.targetPieceIds || []).forEach(function (pieceId) {
        const cell = pieceCell(model, pieceId)
        if (cell) targetCells.push(cell)
      })
      if (event.targetCell) targetCells.push(event.targetCell)
    })
    if (end) targetCells.push(end)
    return { source: source, selected: selected, end: end, path: path, area: area, targets: targetCells }
  }

  function create(options) {
    const input = options || {}
    const doc = input.document || root.document
    const win = input.window || root
    const icons = input.icons || root.BattleEffectIcons
    const actionIdentity = input.actionIdentity || root.BattleActionIdentity
    const cardFace = input.cardFace || root.HandCardFace
    const getCardDefinition = input.getCardDefinition
    const reducedMotion = input.reducedMotion === true
      || !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const now = typeof input.now === 'function' ? input.now : Date.now
    let boardContainer = null
    let floatLayer = null
    let layer = null
    let speedControl = null
    let showAreaFlash = null
    let clearAreaFlash = null
    let showPath = null
    let clearPath = null
    let projectCell = null
    let model = null
    let currentPhase = null
    let currentGroup = null
    let suppressClickUntil = 0
    let speed = 1
    let displayedCard = null
    let playbackPhase = null
    let playbackIdle = null
    let getPlaybackModel = null

    const queue = createQueue({
      reducedMotion: reducedMotion,
      forcePlayback: input.forcePlayback === true,
      now: now,
      setTimeout: input.setTimeout || root.setTimeout,
      clearTimeout: input.clearTimeout || root.clearTimeout,
      onPhase: function (phase, group) {
        currentPhase = phase
        currentGroup = group
        if (playbackPhase) playbackPhase(phase, group)
        render()
      },
      onIdle: function () {
        currentPhase = null
        currentGroup = null
        displayedCard = null
        if (clearAreaFlash) clearAreaFlash()
        if (clearPath) clearPath()
        if (layer) layer.hidden = true
        if (playbackIdle) playbackIdle()
      },
    })

    function resolveIcon(event) {
      if (event && event.statusType && icons && typeof icons.resolveStatusType === 'function') {
        return icons.resolveStatusType(event.statusType)
      }
      return icons && typeof icons.resolveAction === 'function'
        ? icons.resolveAction(event && event.iconId)
        : { assetPath: 'images/effect-icons/fallback.svg', label: '未知动作', color: '#94a3b8' }
    }

    function resolveIdentity(event) {
      return actionIdentity && typeof actionIdentity.resolve === 'function'
        ? actionIdentity.resolve(event, Object.assign({}, model, {
          presentationEvents: currentGroup ? currentGroup.identityEvents || [currentGroup.root].concat(currentGroup.children || []) : [],
        }))
        : { isSkill: false, skillName: '', sourceName: '', portraitSrc: '', portraitFallback: '?', faction: '' }
    }

    function renderPortrait(identity) {
      const portrait = identity || {}
      return '<span class="battle-vignette-avatar" data-faction="' + escapeHtml(portrait.faction || '')
        + '" role="img" aria-label="' + escapeHtml(portrait.sourceName || '未知棋子') + '">'
        + '<span class="battle-vignette-avatar-fallback" aria-hidden="true">'
        + escapeHtml(portrait.portraitFallback || '?') + '</span>'
        + (portrait.portraitSrc
          ? '<img src="' + escapeHtml(portrait.portraitSrc) + '" alt="" aria-hidden="true" onerror="this.style.display=\'none\'">'
          : '')
        + '</span>'
    }

    function cardDisplay(event) {
      if (event.kind !== 'card' || !event.cardId || !cardFace) return null
      if (displayedCard && displayedCard.eventId === event.eventId) return displayedCard.definition
      const snapshot = { eventId: event.eventId, definition: { name: '已打出的手牌', actionPointCost: '?', description: '卡牌资料暂不可用' } }
      displayedCard = snapshot
      const definition = typeof getCardDefinition === 'function' ? getCardDefinition(event.cardId) : null
      function accept(value) {
        if (value && value.name) snapshot.definition = value
      }
      if (definition && typeof definition.then === 'function') {
        definition.then(function (value) {
          accept(value)
          if (displayedCard === snapshot && currentGroup && currentGroup.root.eventId === snapshot.eventId) render()
        }).catch(function (error) {
          console.error('[battle-action-vignette] card metadata unavailable', { eventId: event.eventId, cardId: event.cardId, error: error })
        })
      } else accept(definition)
      return snapshot.definition
    }

    function renderCard(event, definition) {
      return '<div class="battle-card-reveal"><span class="battle-card-reveal-kicker">打出手牌</span>'
        + '<article class="card-item battle-played-card' + (definition.type === 'reactive' ? ' card-reactive' : '')
        + '" aria-label="' + escapeHtml(definition.name) + '">'
        + cardFace.render({ cardId: event.cardId }, definition) + '</article></div>'
    }

    function render() {
      if (!layer || !currentGroup || !model) return
      const rootEvent = currentGroup.root
      const meta = resolveIcon(rootEvent)
      const identity = resolveIdentity(rootEvent)
      const card = cardDisplay(rootEvent)
      const cells = eventCells(currentGroup, getPlaybackModel ? getPlaybackModel() : model)
      const cue = rootEvent.presentation && rootEvent.presentation.cue || 'directional'
      const actionLabel = identity.isSkill ? identity.skillName : (meta.label || '战场动作')
      const resultVisible = currentPhase === 'result' || currentPhase === 'settle' || currentPhase === 'static'
      const pathVisible = currentPhase === 'path' || resultVisible
      const travelVisible = pathVisible && cue !== 'area'
      const areaCells = cells.area.length ? cells.area : cells.targets
      if (cue === 'area' && pathVisible) {
        if (showPath) showPath({ selected: cells.selected })
        if (showAreaFlash) showAreaFlash(areaCells)
      } else {
        if (clearAreaFlash) clearAreaFlash()
        if (travelVisible && showPath) {
          showPath({ source: cells.source, end: cells.end || cells.targets[0], selected: cells.selected })
        } else if (clearPath) clearPath()
      }
      layer.hidden = false
      layer.className = 'battle-vignette-layer is-phase-' + currentPhase + ' is-cue-' + cue
        + (card ? ' is-card-reveal' : identity.isSkill ? ' is-skill-banner' : ' is-action-banner')
      layer.dataset.phase = currentPhase
      layer.dataset.rootId = currentGroup.rootEventId
      layer.innerHTML = '<div class="battle-vignette-veil" aria-hidden="true"></div>'
        + '<div class="battle-vignette-status" data-action="' + escapeHtml(rootEvent.kind) + '" data-faction="' + escapeHtml(identity.faction) + '" role="status" aria-live="polite"'
        + ' style="--banner-duration:' + (actionDuration(currentGroup) / speed) + 'ms;--banner-elapsed:-'
        + (Math.max(phaseTime(currentPhase, currentGroup), queue.getDiagnostics().activeProgressMs) / speed) + 'ms">'
        + (card ? renderCard(rootEvent, card) : '<span class="battle-vignette-label">'
        + (identity.isSkill ? renderPortrait(identity) : '<span class="battle-vignette-action-icon" aria-hidden="true"><img src="' + escapeHtml(meta.assetPath) + '" alt=""></span>')
        + '<span class="battle-vignette-copy">'
        + (identity.isSkill ? '<span class="battle-vignette-kicker">'
          + (rootEvent.result && rootEvent.result.pending ? '连锁触发' : rootEvent.kind === 'choiceResolved' ? '响应技能' : rootEvent.kind === 'chargeSkill' ? '充能释放' : '技能释放')
          + ' · ' + escapeHtml(identity.sourceName) + '</span>' : '')
        + '<span class="battle-vignette-action-name" title="' + escapeHtml(actionLabel) + '">'
        + escapeHtml(actionLabel) + '</span></span></span>')
        + '<span class="battle-vignette-skip-hint">点按战场略过</span></div>'
        + renderComicBeat(resultVisible)
    }

    // One accent per root, derived only from a visible atomic result. Never
    // infer damage/critical hits from a skill name or a hidden outcome.
    function renderComicBeat(resultVisible) {
      if (!resultVisible || currentPhase === 'settle' || !projectCell) return ''
      const labels = { death: '退场!', summon: '登场!', move: '嗖!' }
      const events = (currentGroup.children || []).concat([currentGroup.root])
      const event = events.find(function (entry) {
        return entry && labels[entry.kind] && entry.visibility !== 'actorOnly'
          && (entry.targetCell || (entry.targetPieceIds || []).length)
      })
      if (!event) return ''
      const cell = event.targetCell || pieceCell(model, event.targetPieceIds[0])
      if (!cell) return ''
      const point = projectCell(cell.x, cell.y, 0.65)
      if (!point || !Number.isFinite(point.left) || !Number.isFinite(point.top)) return ''
      const bounds = floatLayer && floatLayer.getBoundingClientRect && floatLayer.getBoundingClientRect()
      if (!bounds || bounds.width < 220 || bounds.height < 200) return ''
      // Keep the label beside the result, with room for HUD and hand cards.
      const left = Math.max(90, Math.min(bounds.width - 90, point.left + 48))
      const top = Math.max(100, Math.min(bounds.height - 100, point.top - 44))
      return '<div class="battle-comic-beat is-' + event.kind + '" aria-hidden="true" style="left:'
        + left + 'px;top:' + top + 'px"><span>' + labels[event.kind] + '</span></div>'
    }

    function consume(event) {
      if (!event) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
    }

    function handlePointerDown(event) {
      if (!currentGroup) return
      if (event.target && typeof event.target.closest === 'function' && event.target.closest('[data-vignette-control]')) {
        consume(event)
        return
      }
      consume(event)
      suppressClickUntil = now() + 160
      queue.skip()
    }

    function syncSpeedControl() {
      if (!speedControl) return
      const nextSpeed = speed === 2 ? 1 : 2
      speedControl.innerHTML = speed + '×'
      speedControl.setAttribute('aria-pressed', String(speed === 2))
      speedControl.setAttribute('aria-label', '动作演出速度：' + speed + ' 倍，点击切换为 ' + nextSpeed + ' 倍')
      speedControl.setAttribute('title', '动作演出速度 ' + speed + '×')
    }

    function setSpeed(nextSpeed) {
      speed = Number(nextSpeed) === 2 ? 2 : 1
      queue.setSpeed(speed)
      syncSpeedControl()
      if (currentGroup) render()
    }

    function handleSpeedPointerDown(event) {
      consume(event)
    }

    function handleSpeedClick(event) {
      consume(event)
      setSpeed(speed === 2 ? 1 : 2)
    }

    function consumeTrailingClick(event) {
      if (now() > suppressClickUntil || !boardContainer || !event || !event.target) return
      if (typeof boardContainer.contains === 'function' && !boardContainer.contains(event.target)) return
      consume(event)
    }

    function mount(mountOptions) {
      const mountInput = mountOptions || {}
      playbackPhase = typeof mountInput.onPlaybackPhase === 'function' ? mountInput.onPlaybackPhase : null
      playbackIdle = typeof mountInput.onPlaybackIdle === 'function' ? mountInput.onPlaybackIdle : null
      getPlaybackModel = typeof mountInput.getPlaybackModel === 'function' ? mountInput.getPlaybackModel : null
      boardContainer = mountInput.boardContainer || null
      floatLayer = mountInput.floatLayer || null
      showAreaFlash = typeof mountInput.showAreaFlash === 'function' ? mountInput.showAreaFlash : null
      clearAreaFlash = typeof mountInput.clearAreaFlash === 'function' ? mountInput.clearAreaFlash : null
      showPath = typeof mountInput.showPath === 'function' ? mountInput.showPath : null
      clearPath = typeof mountInput.clearPath === 'function' ? mountInput.clearPath : null
      projectCell = typeof mountInput.projectCell === 'function' ? mountInput.projectCell : null
      if (!doc || !doc.createElement || !floatLayer || !floatLayer.appendChild) return
      layer = doc.createElement('div')
      layer.className = 'battle-vignette-layer'
      layer.hidden = true
      layer.setAttribute('data-battle-ui-region', 'action-vignette')
      layer.addEventListener('pointerdown', handlePointerDown)
      floatLayer.appendChild(layer)

      speedControl = doc.createElement('button')
      speedControl.className = 'battle-vignette-speed-control'
      speedControl.hidden = false
      speedControl.setAttribute('type', 'button')
      speedControl.setAttribute('data-battle-ui-region', 'action-vignette-speed')
      speedControl.addEventListener('pointerdown', handleSpeedPointerDown)
      speedControl.addEventListener('click', handleSpeedClick)
      syncSpeedControl()
      floatLayer.appendChild(speedControl)
      if (win && win.addEventListener) win.addEventListener('click', consumeTrailingClick, true)
    }

    function update(nextModel) {
      if (!nextModel) return
      model = nextModel
      queue.update(nextModel)
      if (currentGroup) render()
    }

    function resize() { if (currentGroup) render() }

    function dispose() {
      queue.dispose()
      if (clearAreaFlash) clearAreaFlash()
      if (clearPath) clearPath()
      if (win && win.removeEventListener) win.removeEventListener('click', consumeTrailingClick, true)
      if (layer) {
        layer.removeEventListener('pointerdown', handlePointerDown)
        if (layer.remove) layer.remove()
      }
      if (speedControl) {
        speedControl.removeEventListener('pointerdown', handleSpeedPointerDown)
        speedControl.removeEventListener('click', handleSpeedClick)
        if (speedControl.remove) speedControl.remove()
      }
      boardContainer = null
      floatLayer = null
      layer = null
      speedControl = null
      showAreaFlash = null
      clearAreaFlash = null
      showPath = null
      clearPath = null
      projectCell = null
      model = null
      currentPhase = null
      currentGroup = null
      displayedCard = null
      playbackPhase = null
      playbackIdle = null
      getPlaybackModel = null
    }

    return {
      mount: mount,
      update: update,
      reset: function (nextModel) { model = nextModel; queue.reset(nextModel) },
      resize: resize,
      dispose: dispose,
      skip: queue.skip,
      settleAll: queue.settleAll,
      setSpeed: setSpeed,
      getDiagnostics: queue.getDiagnostics,
      sequencesBoard: true,
    }
  }

  root.BattleActionVignette = {
    create: create,
    createQueue: createQueue,
    groupEvents: groupEvents,
    eventCells: eventCells,
    constants: Object.freeze({
      normalDurationMs: NORMAL_DURATION_MS,
      cardDurationMs: CARD_DURATION_MS,
      reducedDurationMs: REDUCED_DURATION_MS,
      skipSettleMs: SKIP_SETTLE_MS,
    }),
  }
})(typeof window !== 'undefined' ? window : globalThis)
