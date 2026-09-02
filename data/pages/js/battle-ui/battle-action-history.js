;(function (root) {
  'use strict'

  const MAX_ROOTS = 20
  const VISIBLE_ROOTS = 5
  const HIGHLIGHT_TIMEOUT_MS = 2600
  const COLLAPSE_WIDTH = 980
  const KIND_LABELS = Object.freeze({
    move: '移动', skill: '技能', chargeSkill: '充能技能', card: '卡牌', passive: '被动触发',
    damage: '伤害', heal: '治疗', death: '死亡', statusAdded: '获得状态', statusRemoved: '移除状态',
    shield: '护盾',
  })

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

  function eventOrder(left, right) {
    return Number(left.sequence || 0) - Number(right.sequence || 0)
      || String(left.eventId || '').localeCompare(String(right.eventId || ''))
  }

  function groupEvents(events) {
    const groups = []
    const byRoot = new Map()
    ;(Array.isArray(events) ? events : []).forEach(function (event) {
      if (!event || !event.eventId || !event.rootEventId) return
      const rootId = String(event.rootEventId)
      let group = byRoot.get(rootId)
      if (!group) {
        group = { rootEventId: rootId, root: null, children: [], eventIds: new Set() }
        byRoot.set(rootId, group)
        groups.push(group)
      }
      const eventId = String(event.eventId)
      if (group.eventIds.has(eventId)) return
      group.eventIds.add(eventId)
      if (!event.parentEventId || eventId === rootId) {
        if (!group.root) group.root = event
        else group.children.push(event)
      } else {
        group.children.push(event)
      }
    })
    return groups.flatMap(function (group) {
      if (!group.root) return []
      return [{
        rootEventId: group.rootEventId,
        root: group.root,
        children: group.children.sort(eventOrder),
      }]
    })
  }

  function mergeRoots(previous, events, limit) {
    const maximum = Math.max(1, Number(limit) || MAX_ROOTS)
    const roots = (Array.isArray(previous) ? previous : []).map(function (group) {
      return { rootEventId: group.rootEventId, root: group.root, children: (group.children || []).slice() }
    })
    const indexes = new Map(roots.map(function (group, index) { return [group.rootEventId, index] }))

    groupEvents(events).forEach(function (incoming) {
      const existingIndex = indexes.get(incoming.rootEventId)
      if (existingIndex === undefined) {
        indexes.set(incoming.rootEventId, roots.length)
        roots.push(incoming)
        return
      }
      const existing = roots[existingIndex]
      const seen = new Set([existing.root.eventId].concat(existing.children.map(function (event) { return event.eventId })))
      incoming.children.forEach(function (event) {
        if (seen.has(event.eventId)) return
        seen.add(event.eventId)
        existing.children.push(event)
      })
      existing.children.sort(eventOrder)
    })

    return roots.slice(-maximum)
  }

  function visibleRoots(roots, count) {
    return (Array.isArray(roots) ? roots : [])
      .slice(-Math.max(1, Number(count) || VISIBLE_ROOTS))
      .reverse()
  }

  function pieceById(model, pieceId) {
    return ((model && model.pieces) || []).find(function (piece) { return piece.id === pieceId }) || null
  }

  function cellOfPiece(model, pieceId) {
    const piece = pieceById(model, pieceId)
    const x = finite(piece && piece.x)
    const y = finite(piece && piece.y)
    return x == null || y == null ? null : { x: x, y: y, pieceId: String(pieceId) }
  }

  function uniqueCells(cells) {
    const seen = new Set()
    return cells.flatMap(function (cell) {
      if (!cell) return []
      const key = cell.x + ',' + cell.y + ':' + String(cell.role || '')
      if (seen.has(key)) return []
      seen.add(key)
      return [cell]
    })
  }

  function highlightCells(group, model) {
    if (!group || !group.root) return []
    const events = [group.root].concat(group.children || [])
    const cells = []
    const moveResult = group.root.result || {}
    const fromX = finite(moveResult.fromX)
    const fromY = finite(moveResult.fromY)
    if (fromX != null && fromY != null) {
      cells.push({ x: fromX, y: fromY, role: 'source' })
    } else if (group.root.sourcePieceId) {
      const source = cellOfPiece(model, group.root.sourcePieceId)
      if (source) cells.push(Object.assign(source, { role: 'source' }))
    }

    events.forEach(function (event) {
      ;(event.targetPieceIds || []).forEach(function (pieceId) {
        const target = cellOfPiece(model, pieceId)
        if (target) cells.push(Object.assign(target, { role: 'target' }))
      })
      const targetCell = event.targetCell
      const targetX = finite(targetCell && targetCell.x)
      const targetY = finite(targetCell && targetCell.y)
      if (targetX != null && targetY != null) cells.push({ x: targetX, y: targetY, role: 'target' })
    })

    const toX = finite(moveResult.toX)
    const toY = finite(moveResult.toY)
    if (toX != null && toY != null) cells.push({ x: toX, y: toY, role: 'target' })
    return uniqueCells(cells)
  }

  function visibleByStyle(win, element) {
    if (!element || element.hidden || element.getAttribute && element.getAttribute('aria-hidden') === 'true') return false
    if (element.classList && (element.classList.contains('show') || element.classList.contains('is-open'))) return true
    if (element.style && element.style.display) return element.style.display !== 'none'
    if (!win || typeof win.getComputedStyle !== 'function') return false
    const style = win.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  function collapseReasons(input) {
    const state = input || {}
    const reasons = []
    const width = Math.max(0, Number(state.width) || 0)
    const height = Math.max(0, Number(state.height) || 0)
    if (width > 0 && width < COLLAPSE_WIDTH) reasons.push('narrow')
    if (width <= 900 && height > 0 && height <= 500) reasons.push('compact-landscape')
    if (state.interactionMode === 'target' || state.interactionMode === 'place') reasons.push('target-mode')
    if (state.sameSidePopover) reasons.push('same-side-popover')
    if (state.statusOverlay) reasons.push('status-overlay')
    if (state.dialog) reasons.push('dialog')
    return reasons
  }

  function resultBadge(event) {
    const result = event && event.result || {}
    const candidates = [result.amount, result.absorbed, result.count, result.stacks]
    for (let index = 0; index < candidates.length; index += 1) {
      const value = finite(candidates[index])
      if (value != null && value !== 0) return String(Math.abs(value))
    }
    return ''
  }

  function create(options) {
    const input = options || {}
    const doc = input.document || root.document
    const win = input.window || root
    const icons = input.icons || root.BattleEffectIcons
    const onOpenLog = typeof input.onOpenLog === 'function' ? input.onOpenLog : function () {}
    const scheduleTimeout = input.setTimeout || root.setTimeout
    const cancelTimeout = input.clearTimeout || root.clearTimeout
    let dock = null
    let list = null
    let floatLayer = null
    let projectCell = null
    let model = null
    let roots = []
    let activeRootId = null
    let highlightTimer = null
    let observer = null

    function resolveIcon(event) {
      if (event && event.statusType && icons && typeof icons.resolveStatusType === 'function') {
        return icons.resolveStatusType(event.statusType)
      }
      return icons && typeof icons.resolveAction === 'function'
        ? icons.resolveAction(event && event.iconId)
        : { iconId: 'fallback', assetPath: 'images/effect-icons/fallback.svg', label: '未知动作', color: '#94a3b8' }
    }

    function renderChild(event) {
      const meta = resolveIcon(event)
      const badge = resultBadge(event)
      return '<span class="action-history-child" style="--history-accent:' + escapeHtml(meta.color || '#94a3b8') + '" aria-hidden="true">'
        + '<img src="' + escapeHtml(meta.assetPath || 'images/effect-icons/fallback.svg') + '" alt="">'
        + (badge ? '<b>' + escapeHtml(badge) + '</b>' : '')
        + '</span>'
    }

    function render() {
      if (!dock || !list) return
      const entries = visibleRoots(roots, VISIBLE_ROOTS)
      dock.hidden = entries.length === 0
      list.innerHTML = entries.map(function (group, index) {
        const meta = resolveIcon(group.root)
        const children = group.children || []
        const visibleChildren = children.slice(0, 2)
        const overflow = Math.max(0, children.length - visibleChildren.length)
        const actor = ((model && model.players) || []).find(function (player) {
          return String(player.id || '').toLowerCase() === String(group.root.actorPlayerId || '').toLowerCase()
        })
        const current = index === 0
        const selected = group.rootEventId === activeRootId
        const label = String(meta.label || KIND_LABELS[group.root.kind] || '未知动作') + (children.length ? '，包含 ' + children.length + ' 个结果' : '')
        return '<button type="button" class="action-history-item' + (current ? ' is-current' : '') + (selected ? ' is-selected' : '') + '"'
          + ' data-history-root-id="' + escapeHtml(group.rootEventId) + '"'
          + ' data-faction="' + escapeHtml(actor && actor.faction || '') + '"'
          + ' aria-label="' + escapeHtml(label + '，点击高亮来源与目标') + '"'
          + ' aria-pressed="' + String(selected) + '" title="' + escapeHtml(meta.label || KIND_LABELS[group.root.kind] || '未知动作') + '"'
          + ' style="--history-accent:' + escapeHtml(meta.color || '#94a3b8') + '">'
          + '<span class="action-history-root-icon"><img src="' + escapeHtml(meta.assetPath || 'images/effect-icons/fallback.svg') + '" alt="" aria-hidden="true"></span>'
          + (children.length ? '<span class="action-history-branch" aria-hidden="true">' + visibleChildren.map(renderChild).join('')
            + (overflow ? '<b class="action-history-overflow">+' + overflow + '</b>' : '') + '</span>' : '')
          + '</button>'
      }).join('')
    }

    function overlayState() {
      const pieceMenu = doc && doc.getElementById ? doc.getElementById('pieceContextMenu') : null
      const sameSidePopover = !!(pieceMenu && pieceMenu.classList && pieceMenu.classList.contains('is-open') && pieceMenu.dataset.side === 'right')
      const status = doc && doc.getElementById ? doc.getElementById('selectedStatusOverlay') : null
      const dialogIds = [
        'pieceInfoModal', 'cardDetailModal', 'optionPickerOverlay', 'trainingSetupOverlay',
        'resEditorSheet', 'surrenderConfirmOverlay', 'resultOverlay', 'logOverlay', 'tileStatusPanel',
      ]
      return {
        sameSidePopover: sameSidePopover,
        statusOverlay: visibleByStyle(win, status),
        dialog: dialogIds.some(function (id) {
          return visibleByStyle(win, doc && doc.getElementById ? doc.getElementById(id) : null)
        }),
      }
    }

    function syncCollapse() {
      if (!dock) return
      const overlays = overlayState()
      const reasons = collapseReasons({
        width: win && win.innerWidth,
        height: win && win.innerHeight,
        interactionMode: model && model.selection && model.selection.mode,
        sameSidePopover: overlays.sameSidePopover,
        statusOverlay: overlays.statusOverlay,
        dialog: overlays.dialog,
      })
      const collapsed = reasons.length > 0
      dock.classList.toggle('is-collapsed', collapsed)
      dock.dataset.collapseReason = reasons.join(' ')
      const button = dock.querySelector('.action-history-collapsed-button')
      if (button) button.setAttribute('aria-hidden', collapsed ? 'false' : 'true')
    }

    function clearHighlight() {
      if (highlightTimer != null && cancelTimeout) cancelTimeout(highlightTimer)
      highlightTimer = null
      activeRootId = null
      if (floatLayer && floatLayer.querySelector) {
        const overlay = floatLayer.querySelector('.action-history-highlight')
        if (overlay && overlay.remove) overlay.remove()
      }
      render()
    }

    function highlightOverlay() {
      if (!activeRootId || !floatLayer || typeof projectCell !== 'function' || !model) return
      const group = roots.find(function (entry) { return entry.rootEventId === activeRootId })
      if (!group) return clearHighlight()
      const projected = highlightCells(group, model).flatMap(function (cell) {
        const point = projectCell(cell.x, cell.y, 0.86)
        return point ? [Object.assign({}, cell, { left: point.left, top: point.top })] : []
      })
      if (!projected.length) return clearHighlight()
      let overlay = floatLayer.querySelector && floatLayer.querySelector('.action-history-highlight')
      if (!overlay && doc && doc.createElement) {
        overlay = doc.createElement('div')
        overlay.className = 'action-history-highlight'
        overlay.setAttribute('aria-hidden', 'true')
        floatLayer.appendChild(overlay)
      }
      if (!overlay) return
      const source = projected.find(function (point) { return point.role === 'source' })
      const targets = projected.filter(function (point) { return point.role === 'target' })
      const lines = source ? targets.map(function (target) {
        const dx = target.left - source.left
        const dy = target.top - source.top
        const distance = Math.sqrt(dx * dx + dy * dy)
        const angle = Math.atan2(dy, dx) * 180 / Math.PI
        return '<i class="action-history-path" style="left:' + source.left + 'px;top:' + source.top + 'px;width:' + distance + 'px;transform:rotate(' + angle + 'deg)"></i>'
      }).join('') : ''
      overlay.innerHTML = lines + projected.map(function (point) {
        return '<i class="action-history-point is-' + point.role + '" style="left:' + point.left + 'px;top:' + point.top + 'px"></i>'
      }).join('')
    }

    function activate(rootId) {
      if (activeRootId === rootId) return clearHighlight()
      activeRootId = rootId
      if (highlightTimer != null && cancelTimeout) cancelTimeout(highlightTimer)
      highlightOverlay()
      render()
      if (scheduleTimeout) highlightTimer = scheduleTimeout(clearHighlight, HIGHLIGHT_TIMEOUT_MS)
    }

    function stopBoardPointer(event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
    }

    function handleClick(event) {
      if (!event || !event.target || typeof event.target.closest !== 'function') return
      const rootButton = event.target.closest('[data-history-root-id]')
      const collapsedButton = event.target.closest('.action-history-collapsed-button')
      if (!rootButton && !collapsedButton) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      if (rootButton) activate(rootButton.dataset.historyRootId)
      else onOpenLog()
    }

    function observeAvoidance() {
      if (!root.MutationObserver || !doc || !doc.getElementById) return
      observer = new root.MutationObserver(syncCollapse)
      ;[
        'pieceContextMenu', 'selectedStatusOverlay', 'pieceInfoModal', 'cardDetailModal',
        'optionPickerOverlay', 'trainingSetupOverlay', 'resEditorSheet', 'surrenderConfirmOverlay',
        'resultOverlay', 'logOverlay', 'tileStatusPanel',
      ].forEach(function (id) {
        const element = doc.getElementById(id)
        if (element) observer.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-side'] })
      })
    }

    function mount(mountOptions) {
      const mountInput = mountOptions || {}
      dock = mountInput.element || (doc && doc.getElementById ? doc.getElementById('actionHistoryDock') : null)
      floatLayer = mountInput.floatLayer || null
      projectCell = typeof mountInput.projectCell === 'function' ? mountInput.projectCell : null
      if (!dock) return
      dock.innerHTML = '<button type="button" class="action-history-collapsed-button" aria-label="打开完整战斗日志" title="战斗日志">'
        + '<span class="action-history-glyph" aria-hidden="true"><i></i><i></i><i></i></span></button>'
        + '<div class="action-history-list" role="list" aria-label="最近五个重要动作"></div>'
      list = dock.querySelector('.action-history-list')
      dock.addEventListener('pointerdown', stopBoardPointer)
      dock.addEventListener('click', handleClick)
      if (win && win.addEventListener) win.addEventListener('resize', resize)
      observeAvoidance()
      render()
      syncCollapse()
    }

    function update(nextModel) {
      if (!nextModel) return
      model = nextModel
      roots = mergeRoots(roots, nextModel.presentationEvents, MAX_ROOTS)
      render()
      syncCollapse()
      if (activeRootId) highlightOverlay()
    }

    function resize() {
      syncCollapse()
      if (activeRootId) highlightOverlay()
    }

    function dispose() {
      clearHighlight()
      if (observer) observer.disconnect()
      observer = null
      if (win && win.removeEventListener) win.removeEventListener('resize', resize)
      if (dock) {
        dock.removeEventListener('pointerdown', stopBoardPointer)
        dock.removeEventListener('click', handleClick)
        dock.innerHTML = ''
      }
      dock = null
      list = null
      floatLayer = null
      projectCell = null
      model = null
      roots = []
    }

    return {
      mount: mount,
      update: update,
      resize: resize,
      dispose: dispose,
      clearHighlight: clearHighlight,
      getRoots: function () { return roots.slice() },
      getActiveRootId: function () { return activeRootId },
    }
  }

  root.BattleActionHistory = {
    create: create,
    groupEvents: groupEvents,
    mergeRoots: mergeRoots,
    visibleRoots: visibleRoots,
    highlightCells: highlightCells,
    collapseReasons: collapseReasons,
    constants: Object.freeze({ maxRoots: MAX_ROOTS, visibleRoots: VISIBLE_ROOTS, highlightTimeoutMs: HIGHLIGHT_TIMEOUT_MS }),
  }
})(typeof window !== 'undefined' ? window : globalThis)
