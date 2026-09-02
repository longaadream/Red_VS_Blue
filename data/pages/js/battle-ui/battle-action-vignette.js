;(function (root) {
  'use strict'

  const NORMAL_DURATION_MS = 1100
  const REDUCED_DURATION_MS = 120
  const SKIP_SETTLE_MS = 60
  const MAX_PLAYED_ROOTS = 256

  function eventOrder(left, right) {
    return Number(left && left.sequence || 0) - Number(right && right.sequence || 0)
      || String(left && left.eventId || '').localeCompare(String(right && right.eventId || ''))
  }

  function groupEvents(events) {
    const byRoot = new Map()
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
      .sort(function (left, right) { return eventOrder(left.root, right.root) })
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
      const duration = reducedMotion ? REDUCED_DURATION_MS : NORMAL_DURATION_MS
      if (!reducedMotion) {
        ;[
          { at: 120, phase: 'path' },
          { at: 420, phase: 'result' },
          { at: 780, phase: 'settle' },
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
      if (!primed) {
        groups.forEach(function (group) { remember(group.rootEventId) })
        primed = true
        return
      }
      const incoming = groups.filter(function (group) { return remember(group.rootEventId) })
      if (!forcePlayback && model.turn && model.turn.isViewerTurn) {
        settleAll()
        return
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
        activeProgressMs = Math.min(reducedMotion ? REDUCED_DURATION_MS : NORMAL_DURATION_MS, activeProgressMs)
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
    return Number.isFinite(Number(value)) ? Number(value) : null
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
    const reducedMotion = input.reducedMotion === true
      || !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const now = typeof input.now === 'function' ? input.now : Date.now
    let boardContainer = null
    let floatLayer = null
    let layer = null
    let showAreaFlash = null
    let clearAreaFlash = null
    let showPath = null
    let clearPath = null
    let model = null
    let currentPhase = null
    let currentGroup = null
    let suppressClickUntil = 0
    let speed = 1

    const queue = createQueue({
      reducedMotion: reducedMotion,
      forcePlayback: input.forcePlayback === true,
      now: now,
      setTimeout: input.setTimeout || root.setTimeout,
      clearTimeout: input.clearTimeout || root.clearTimeout,
      onPhase: function (phase, group) {
        currentPhase = phase
        currentGroup = group
        render()
      },
      onIdle: function () {
        currentPhase = null
        currentGroup = null
        if (clearAreaFlash) clearAreaFlash()
        if (clearPath) clearPath()
        if (layer) layer.hidden = true
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

    function render() {
      if (!layer || !currentGroup || !model) return
      const rootEvent = currentGroup.root
      const meta = resolveIcon(rootEvent)
      const cells = eventCells(currentGroup, model)
      const cue = rootEvent.presentation && rootEvent.presentation.cue || 'directional'
      const usesSkillText = rootEvent.kind === 'skill' || rootEvent.kind === 'chargeSkill'
      const actionLabel = usesSkillText ? '使用技能' : (meta.label || '战场动作')
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
      layer.dataset.phase = currentPhase
      layer.dataset.rootId = currentGroup.rootEventId
      layer.innerHTML = '<div class="battle-vignette-veil" aria-hidden="true"></div>'
        + '<div class="battle-vignette-status" role="status" aria-live="polite">'
        + '<span class="battle-vignette-label">'
        + (usesSkillText ? '' : '<img src="' + escapeHtml(meta.assetPath) + '" alt="">')
        + escapeHtml(actionLabel) + '</span>'
        + '<span class="battle-vignette-skip-hint">点按战场略过</span>'
        + '<button type="button" class="battle-vignette-speed" data-vignette-control="speed" aria-label="切换演出速度" aria-pressed="'
        + String(speed === 2) + '">' + speed + '×</button></div>'
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

    function handleClick(event) {
      if (!currentGroup) return
      const control = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-vignette-control="speed"]')
        : null
      consume(event)
      if (!control) return
      speed = speed === 2 ? 1 : 2
      queue.setSpeed(speed)
      render()
    }

    function consumeTrailingClick(event) {
      if (now() > suppressClickUntil || !boardContainer || !event || !event.target) return
      if (typeof boardContainer.contains === 'function' && !boardContainer.contains(event.target)) return
      consume(event)
    }

    function mount(mountOptions) {
      const mountInput = mountOptions || {}
      boardContainer = mountInput.boardContainer || null
      floatLayer = mountInput.floatLayer || null
      showAreaFlash = typeof mountInput.showAreaFlash === 'function' ? mountInput.showAreaFlash : null
      clearAreaFlash = typeof mountInput.clearAreaFlash === 'function' ? mountInput.clearAreaFlash : null
      showPath = typeof mountInput.showPath === 'function' ? mountInput.showPath : null
      clearPath = typeof mountInput.clearPath === 'function' ? mountInput.clearPath : null
      if (!doc || !doc.createElement || !floatLayer || !floatLayer.appendChild) return
      layer = doc.createElement('div')
      layer.className = 'battle-vignette-layer'
      layer.hidden = true
      layer.setAttribute('data-battle-ui-region', 'action-vignette')
      layer.addEventListener('pointerdown', handlePointerDown)
      layer.addEventListener('click', handleClick)
      floatLayer.appendChild(layer)
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
        layer.removeEventListener('click', handleClick)
        if (layer.remove) layer.remove()
      }
      boardContainer = null
      floatLayer = null
      layer = null
      showAreaFlash = null
      clearAreaFlash = null
      showPath = null
      clearPath = null
      model = null
      currentPhase = null
      currentGroup = null
    }

    return {
      mount: mount,
      update: update,
      resize: resize,
      dispose: dispose,
      skip: queue.skip,
      settleAll: queue.settleAll,
      setSpeed: function (nextSpeed) {
        speed = Number(nextSpeed) === 2 ? 2 : 1
        queue.setSpeed(speed)
        if (currentGroup) render()
      },
      getDiagnostics: queue.getDiagnostics,
    }
  }

  root.BattleActionVignette = {
    create: create,
    createQueue: createQueue,
    groupEvents: groupEvents,
    eventCells: eventCells,
    constants: Object.freeze({
      normalDurationMs: NORMAL_DURATION_MS,
      reducedDurationMs: REDUCED_DURATION_MS,
      skipSettleMs: SKIP_SETTLE_MS,
    }),
  }
})(typeof window !== 'undefined' ? window : globalThis)
