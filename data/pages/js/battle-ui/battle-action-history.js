;(function (root) {
  'use strict'

  const MAX_ROOTS = 20
  const VISIBLE_ROOTS = 5
  const HIGHLIGHT_TIMEOUT_MS = 2600
  const COLLAPSE_WIDTH = 980
  const KIND_LABELS = Object.freeze({
    move: '移动', deploy: '部署', skill: '技能', chargeSkill: '充能技能', card: '使用卡牌',
    endTurn: '结束回合', automatic: '自动结算', choiceResolved: '选择', passive: '触发',
    damage: '伤害', heal: '治疗', death: '死亡', statusAdded: '获得状态', statusRemoved: '移除状态',
    block: '阻止', forceMove: '强制位移', spawn: '生成', actionPoints: '行动点变化',
    chargePoints: '充能点变化', cardGained: '获得手牌', cardDiscarded: '弃置手牌',
    cardChanged: '手牌变化', tileChanged: '地格变化', tileEffectAdded: '添加地格效果',
    tileEffectRemoved: '移除地格效果', statChanged: '属性变化', eliminated: '出局',
    redirect: '改换目标', concealed: '结果保密',
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
    if (value == null || value === '') return null
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
      // A repeated root is an authoritative replacement, not an additive patch.
      // This matters when the same training history is re-projected for another
      // viewer: actor-only target data must not survive in the local cache.
      existing.root = incoming.root
      existing.children = incoming.children.slice().sort(eventOrder)
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
    if (state.dialog) reasons.push('dialog')
    return reasons
  }

  function resultBadge(event) {
    const result = event && event.result || {}
    const candidates = [result.amount, result.absorbed, result.count, result.stacks]
    for (let index = 0; index < candidates.length; index += 1) {
      const value = finite(candidates[index])
      if (value != null && value !== 0) {
        const signedKinds = new Set(['actionPoints', 'chargePoints', 'statChanged'])
        return signedKinds.has(event && event.kind)
          ? (value > 0 ? '+' : '') + String(value)
          : String(Math.abs(value))
      }
    }
    return ''
  }

  function create(options) {
    const input = options || {}
    const doc = input.document || root.document
    const win = input.window || root
    const icons = input.icons || root.BattleEffectIcons
    const actionIdentity = input.actionIdentity || root.BattleActionIdentity
    const scheduleTimeout = input.setTimeout || root.setTimeout
    const cancelTimeout = input.clearTimeout || root.clearTimeout
    let dock = null
    let list = null
    let setHistoryHighlight = null
    let model = null
    let roots = []
    let activeRootId = null
    let pinnedRootId = null
    let highlightTimer = null
    let observer = null
    let userExpanded = false
    const missingEffectDisplayMetadata = new Set()
    const pieceArchive = new Map()

    function rememberPieces(nextModel) {
      ;((nextModel && nextModel.pieces) || []).forEach(function (piece) {
        if (!piece || !piece.id) return
        const pieceId = String(piece.id)
        pieceArchive.set(pieceId, Object.assign({}, pieceArchive.get(pieceId) || {}, piece))
      })
      ;((nextModel && nextModel.presentationEvents) || []).forEach(function (event) {
        if (!event || event.kind !== 'death') return
        ;(event.targetPieceIds || []).forEach(function (pieceId) {
          const archived = pieceArchive.get(String(pieceId))
          if (archived) pieceArchive.set(String(pieceId), Object.assign({}, archived, { alive: false, visible: false }))
        })
      })
    }

    function pieceForDisplay(pieceId) {
      return pieceById(model, pieceId) || pieceArchive.get(String(pieceId)) || null
    }

    function identityModel() {
      if (!model || pieceArchive.size === 0) return model
      return Object.assign({}, model, { pieces: Array.from(pieceArchive.values()) })
    }

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

    function resolveIdentity(event) {
      return actionIdentity && typeof actionIdentity.resolve === 'function'
        ? actionIdentity.resolve(event, identityModel())
        : { isSkill: false, skillName: '', sourceName: '', portraitSrc: '', portraitFallback: '?', faction: '' }
    }

    function renderPortrait(identity) {
      const portrait = identity || {}
      return '<span class="action-history-portrait" data-faction="' + escapeHtml(portrait.faction || '')
        + '" role="img" aria-label="' + escapeHtml(portrait.sourceName || '未知棋子') + '">'
        + '<span class="action-history-portrait-fallback" aria-hidden="true">'
        + escapeHtml(portrait.portraitFallback || '?') + '</span>'
        + (portrait.portraitSrc
          ? '<img src="' + escapeHtml(portrait.portraitSrc) + '" alt="" aria-hidden="true" onerror="this.style.display=\'none\'">'
          : '')
        + '</span>'
    }

    function displayPiece(pieceId) {
      const piece = pieceForDisplay(pieceId)
      if (!piece) return ''
      const isDead = piece.alive === false
      const initial = String(piece.name || '?').slice(0, 1)
      const portraitSrc = actionIdentity && typeof actionIdentity.portraitUrl === 'function'
        ? actionIdentity.portraitUrl(piece.portraitId)
        : ''
      const title = String(piece.name || '') + (isDead ? '（已死亡）' : '')
      return '<span class="action-history-entity is-piece' + (isDead ? ' is-dead' : '') + '" data-piece-id="' + escapeHtml(piece.id) + '" title="' + escapeHtml(title) + '">'
        + '<i class="action-history-avatar" data-faction="' + escapeHtml(piece.faction || '') + '"><span aria-hidden="true">' + escapeHtml(initial) + '</span>'
        + (portraitSrc ? '<img src="' + escapeHtml(portraitSrc) + '" alt="" aria-hidden="true" onerror="this.style.display=\'none\'">' : '')
        + '</i>'
        + '<span>' + escapeHtml(piece.name) + '</span>'
        + (isDead ? '<b class="action-history-dead-badge">已死亡</b>' : '')
        + '</span>'
    }

    function displayPlayer(playerId) {
      const player = ((model && model.players) || []).find(function (entry) {
        return String(entry.id || '').toLowerCase() === String(playerId || '').toLowerCase()
      })
      return player ? '<span class="action-history-entity is-player">' + escapeHtml(player.name || player.id) + '</span>' : ''
    }

    function displayCard(cardId) {
      return cardId ? '<span class="action-history-entity is-card" title="' + escapeHtml(cardId) + '"><i></i><span>手牌</span></span>' : ''
    }

    function displayObject(event) {
      if (event.kind === 'move') return ''
      if (event.targetPieceIds && event.targetPieceIds[0]) return displayPiece(event.targetPieceIds[0])
      if (event.kind === 'cardGained' || event.kind === 'cardDiscarded' || event.kind === 'cardChanged') return displayCard(event.cardId || 'hidden')
      if (event.kind === 'actionPoints' || event.kind === 'chargePoints') return ''
      if (event.targetPlayerIds && event.targetPlayerIds[0]) return displayPlayer(event.targetPlayerIds[0])
      if (event.targetCell) return '<span class="action-history-entity is-tile">地格</span>'
      if (event.cardId && (event.kind === 'cardGained' || event.kind === 'cardDiscarded' || event.kind === 'cardChanged')) return displayCard(event.cardId)
      return ''
    }

    function displaySubject(event, rootEvent) {
      if ((event.kind === 'actionPoints' || event.kind === 'chargePoints') && event.targetPlayerIds && event.targetPlayerIds[0]) {
        return displayPlayer(event.targetPlayerIds[0])
      }
      if ((event.kind === 'cardGained' || event.kind === 'cardDiscarded' || event.kind === 'cardChanged') && event.targetPlayerIds && event.targetPlayerIds[0]) {
        return displayPlayer(event.targetPlayerIds[0])
      }
      if (event.sourcePieceId) return displayPiece(event.sourcePieceId)
      if (rootEvent && rootEvent.sourcePieceId) return displayPiece(rootEvent.sourcePieceId)
      if (event.cardId && event.kind === 'card') return displayCard(event.cardId)
      return displayPlayer(event.actorPlayerId || (rootEvent && rootEvent.actorPlayerId))
    }

    function displayComplement(event) {
      const complement = event.complement || {}
      if (complement.kind === 'concealed') return ''
      if (complement.kind === 'option') return '<span class="action-history-complement">“' + escapeHtml(complement.label) + '”</span>'
      if (complement.kind === 'status' || complement.kind === 'tileEffect') {
        const meta = resolveIcon({ statusType: complement.type, iconId: event.iconId })
        const explicitLabel = typeof complement.label === 'string' ? complement.label.trim() : ''
        const registeredLabel = typeof meta.label === 'string' ? meta.label.trim() : ''
        const displayName = explicitLabel || registeredLabel || (complement.kind === 'tileEffect' ? '未知地格效果' : '未知状态')
        if (!explicitLabel && !registeredLabel) {
          const diagnosticKey = String(event.eventId || '') + ':' + String(complement.kind || '') + ':' + String(complement.type || '')
          if (!missingEffectDisplayMetadata.has(diagnosticKey)) {
            missingEffectDisplayMetadata.add(diagnosticKey)
            if (typeof console !== 'undefined' && console.error) {
              console.error('[battle-action-history] missing effect display metadata', {
                eventId: String(event.eventId || ''),
                effectKind: String(complement.kind || ''),
                effectType: String(complement.type || ''),
              })
            }
          }
        }
        return '<span class="action-history-complement is-effect"><img src="' + escapeHtml(meta.assetPath) + '" alt="">' + escapeHtml(displayName) + '</span>'
      }
      if (complement.kind === 'attribute') return '<span class="action-history-complement">' + escapeHtml(complement.attribute) + ' ' + (complement.amount > 0 ? '+' : '') + escapeHtml(complement.amount) + '</span>'
      const badge = resultBadge(event)
      return badge ? '<span class="action-history-complement is-amount">' + escapeHtml(badge) + '</span>' : ''
    }

    function renderSentence(event, rootEvent, isRoot) {
      const meta = resolveIcon(event)
      const isSkillRelease = isRoot && (event.kind === 'skill' || event.kind === 'chargeSkill')
      const identity = isSkillRelease ? resolveIdentity(event) : null
      const predicate = isSkillRelease
        ? '<span class="action-history-predicate is-skill-release"><span>释放</span><strong>' + escapeHtml(identity.skillName) + '</strong></span>'
        : '<span class="action-history-predicate" style="--history-accent:' + escapeHtml(meta.color || '#94a3b8') + '"><img src="' + escapeHtml(meta.assetPath || 'images/effect-icons/fallback.svg') + '" alt=""><span>' + escapeHtml(meta.label || KIND_LABELS[event.kind] || '动作') + '</span></span>'
      return '<span class="action-history-sentence' + (isRoot ? ' is-root' : '') + '">'
        + displaySubject(event, rootEvent)
        + predicate
        + displayObject(event)
        + displayComplement(event)
        + '</span>'
    }

    function render() {
      if (!dock || !list) return
      const entries = visibleRoots(roots, userExpanded ? MAX_ROOTS : VISIBLE_ROOTS)
      dock.hidden = entries.length === 0
      list.innerHTML = entries.map(function (group, index) {
        const meta = resolveIcon(group.root)
        const identity = resolveIdentity(group.root)
        const children = group.children || []
        const visibleChildren = children.slice(0, 2)
        const overflow = Math.max(0, children.length - visibleChildren.length)
        const actor = ((model && model.players) || []).find(function (player) {
          return String(player.id || '').toLowerCase() === String(group.root.actorPlayerId || '').toLowerCase()
        })
        const current = index === 0
        const selected = group.rootEventId === activeRootId
        const isSkillRelease = identity.isSkill
        const actionLabel = isSkillRelease
          ? identity.skillName
          : String(meta.label || KIND_LABELS[group.root.kind] || '未知动作')
        const label = actionLabel + (children.length ? '，包含 ' + children.length + ' 个结果' : '')
        const rootMark = isSkillRelease
          ? renderPortrait(identity)
          : '<img src="' + escapeHtml(meta.assetPath || 'images/effect-icons/fallback.svg') + '" alt="" aria-hidden="true">'
        return '<button type="button" class="action-history-item' + (isSkillRelease ? ' has-skill' : '') + (current ? ' is-current' : '') + (selected ? ' is-selected' : '') + '"'
          + ' data-history-root-id="' + escapeHtml(group.rootEventId) + '"'
          + ' data-faction="' + escapeHtml(actor && actor.faction || '') + '"'
          + ' aria-label="' + escapeHtml(label + '，点击高亮来源与目标') + '"'
          + ' aria-pressed="' + String(selected) + '" title="' + escapeHtml(actionLabel) + '"'
          + ' style="--history-accent:' + escapeHtml(meta.color || '#94a3b8') + '">'
          + '<span class="action-history-root-icon' + (isSkillRelease ? ' is-portrait' : '') + '">' + rootMark + '</span>'
          + (isSkillRelease ? '<span class="action-history-skill-label" aria-hidden="true">' + escapeHtml(actionLabel) + '</span>' : '')
          + (children.length ? '<span class="action-history-branch" aria-hidden="true">' + visibleChildren.map(renderChild).join('')
            + (overflow ? '<b class="action-history-overflow">+' + overflow + '</b>' : '') + '</span>' : '')
          + '<span class="action-history-chain">' + renderSentence(group.root, group.root, true)
          + children.map(function (event) { return renderSentence(event, group.root, false) }).join('') + '</span>'
          + '</button>'
      }).join('')
    }

    function overlayState() {
      const dialogIds = [
        'pieceInfoModal', 'cardDetailModal', 'optionPickerOverlay', 'trainingSetupOverlay',
        'resEditorSheet', 'surrenderConfirmOverlay', 'resultOverlay', 'logOverlay',
      ]
      return {
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
        dialog: overlays.dialog,
      })
      const forcedCollapsed = reasons.some(function (reason) {
        return reason !== 'narrow' && reason !== 'compact-landscape'
      })
      const expanded = userExpanded && !forcedCollapsed
      const collapsed = forcedCollapsed || (reasons.length > 0 && !userExpanded)
      dock.classList.toggle('is-collapsed', collapsed)
      dock.classList.toggle('is-user-expanded', expanded)
      dock.dataset.collapseReason = reasons.join(' ')
      const button = dock.querySelector('.action-history-collapsed-button')
      if (button) {
        button.setAttribute('aria-hidden', 'false')
        button.setAttribute('aria-label', expanded ? '收起动作历史' : '展开动作历史')
        button.setAttribute('title', expanded ? '收起动作历史' : '动作历史')
      }
    }

    function clearHighlight() {
      if (highlightTimer != null && cancelTimeout) cancelTimeout(highlightTimer)
      highlightTimer = null
      activeRootId = null
      pinnedRootId = null
      if (typeof setHistoryHighlight === 'function') setHistoryHighlight([])
      render()
    }

    function highlightOverlay() {
      if (!activeRootId || typeof setHistoryHighlight !== 'function' || !model) return
      const group = roots.find(function (entry) { return entry.rootEventId === activeRootId })
      if (!group) return clearHighlight()
      const cells = highlightCells(group, model)
      if (!cells.length) return clearHighlight()
      setHistoryHighlight(cells)
    }

    function activate(rootId, pin) {
      if (pin && pinnedRootId === rootId) return clearHighlight()
      if (pin) pinnedRootId = rootId
      if (activeRootId === rootId) {
        if (highlightTimer != null && cancelTimeout) cancelTimeout(highlightTimer)
        if (scheduleTimeout) highlightTimer = scheduleTimeout(clearHighlight, HIGHLIGHT_TIMEOUT_MS)
        return render()
      }
      activeRootId = rootId
      if (highlightTimer != null && cancelTimeout) cancelTimeout(highlightTimer)
      highlightOverlay()
      render()
      if (scheduleTimeout) highlightTimer = scheduleTimeout(clearHighlight, HIGHLIGHT_TIMEOUT_MS)
    }

    function handlePreview(event) {
      const button = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-history-root-id]')
        : null
      if (button && !pinnedRootId) activate(button.dataset.historyRootId, false)
    }

    function handlePreviewEnd(event) {
      const next = event && event.relatedTarget
      if (dock && next && typeof dock.contains === 'function' && dock.contains(next)) return
      if (pinnedRootId) return
      clearHighlight()
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
      if (rootButton) activate(rootButton.dataset.historyRootId, true)
      else {
        userExpanded = !userExpanded
        render()
        syncCollapse()
      }
    }

    function observeAvoidance() {
      if (!root.MutationObserver || !doc || !doc.getElementById) return
      observer = new root.MutationObserver(syncCollapse)
      ;[
        'pieceInfoModal', 'cardDetailModal',
        'optionPickerOverlay', 'trainingSetupOverlay', 'resEditorSheet', 'surrenderConfirmOverlay',
        'resultOverlay', 'logOverlay',
      ].forEach(function (id) {
        const element = doc.getElementById(id)
        if (element) observer.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-side'] })
      })
    }

    function mount(mountOptions) {
      const mountInput = mountOptions || {}
      dock = mountInput.element || (doc && doc.getElementById ? doc.getElementById('actionHistoryDock') : null)
      setHistoryHighlight = typeof mountInput.setHistoryHighlight === 'function' ? mountInput.setHistoryHighlight : null
      if (!dock) return
      dock.innerHTML = '<button type="button" class="action-history-collapsed-button" aria-label="展开动作历史" title="动作历史">'
        + '<span class="action-history-glyph" aria-hidden="true"><i></i><i></i><i></i></span></button>'
        + '<div class="action-history-list" role="list" aria-label="最近动作"></div>'
      list = dock.querySelector('.action-history-list')
      dock.addEventListener('pointerdown', stopBoardPointer)
      dock.addEventListener('wheel', stopBoardPointer)
      dock.addEventListener('click', handleClick)
      dock.addEventListener('pointerover', handlePreview)
      dock.addEventListener('pointerout', handlePreviewEnd)
      dock.addEventListener('focusin', handlePreview)
      dock.addEventListener('focusout', handlePreviewEnd)
      if (win && win.addEventListener) win.addEventListener('resize', resize)
      observeAvoidance()
      render()
      syncCollapse()
    }

    function update(nextModel) {
      if (!nextModel) return
      rememberPieces(nextModel)
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
        dock.removeEventListener('wheel', stopBoardPointer)
        dock.removeEventListener('click', handleClick)
        dock.removeEventListener('pointerover', handlePreview)
        dock.removeEventListener('pointerout', handlePreviewEnd)
        dock.removeEventListener('focusin', handlePreview)
        dock.removeEventListener('focusout', handlePreviewEnd)
        dock.innerHTML = ''
      }
      dock = null
      list = null
      setHistoryHighlight = null
      model = null
      roots = []
      pieceArchive.clear()
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
