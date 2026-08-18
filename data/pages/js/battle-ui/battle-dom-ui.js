;(function (root) {
  'use strict'

  const PHASE_LABELS = { start: '开始阶段', action: '行动阶段', end: '结束阶段' }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }


  function statusLabel(status) {
    return String(status && (status.label || status.name || status.id || status.type) || '未知状态')
  }

  function statusDetailText(status) {
    const presentation = root.BattleStatusPresentation
    if (presentation && typeof presentation.detailText === 'function') {
      return presentation.detailText(status)
    }
    const parts = []
    const stacks = Number(status && status.stacks)
    const duration = Number(status && status.duration)
    const uses = Number(status && status.uses)
    const intensity = Number(status && status.intensity)
    if (Number.isFinite(stacks) && stacks > 0) parts.push(stacks + '层')
    if (duration < 0) parts.push('持续：永久')
    else if (duration > 0) parts.push('剩余：' + duration + '回合')
    if (Number.isFinite(uses) && uses > 0) parts.push('剩余：' + uses + '次')
    if (Number.isFinite(intensity) && intensity > 0 && intensity !== 1) parts.push('强度：' + intensity)
    return parts.join(' · ')
  }

  function statusColor(status) {
    const presentation = root.BattleStatusPresentation
    const meta = presentation && typeof presentation.resolve === 'function'
      ? presentation.resolve(status)
      : null
    return meta && meta.color ? meta.color : '#a78bfa'
  }
  function formatTimer(seconds) {
    if (seconds == null || seconds === '' || !Number.isFinite(Number(seconds))) return '--:--'
    const total = Math.max(0, Math.floor(Number(seconds)))
    const minutes = Math.floor(total / 60)
    const remainder = total % 60
    return String(minutes).padStart(2, '0') + ':' + String(remainder).padStart(2, '0')
  }

  function playerInitial(player) {
    const label = String(player.name || player.id || '?').trim()
    return label ? label.slice(0, 1).toUpperCase() : '?'
  }

  function create(options) {
    const input = options || {}
    const doc = input.document || root.document
    const announce = typeof input.onTurnAnnounce === 'function' ? input.onTurnAnnounce : function () {}
    let previousTurnPlayerId = null

    function byId(id) { return doc && doc.getElementById ? doc.getElementById(id) : null }


    function updateSelectedStatus(model) {
      const element = byId('selectedStatusOverlay')
      if (!element) return
      const selection = model.selection || {}
      const piece = selection.piece
      const visible = !!piece && selection.mode === 'inspect'
      element.hidden = !visible
      if (!visible) {
        if (element.dataset) delete element.dataset.pieceId
        element.innerHTML = ''
        return
      }

      const statuses = piece.statuses || piece.statusSummary || []
      const statusHtml = statuses.length
        ? statuses.map(function (status) {
            const detail = statusDetailText(status)
            return '<article class="selected-status-item">'
              + '<span class="selected-status-dot" style="--selected-status-color:' + escapeHtml(statusColor(status)) + '"></span>'
              + '<span class="selected-status-copy"><strong>' + escapeHtml(statusLabel(status)) + '</strong>'
              + (detail ? '<small>' + escapeHtml(detail) + '</small>' : '')
              + (status.description ? '<span>' + escapeHtml(status.description) + '</span>' : '')
              + '</span></article>'
          }).join('')
        : '<div class="selected-status-zero">无特殊状态</div>'

      if (element.dataset) element.dataset.pieceId = piece.id
      element.setAttribute('aria-label', piece.name + '，特殊状态 ' + statuses.length + ' 个')
      element.setAttribute('aria-live', 'polite')
      element.innerHTML = '<div class="selected-status-heading">'
        + '<span>' + escapeHtml(piece.name) + '</span>'
        + '<strong>特殊状态 <b>' + statuses.length + '</b></strong>'
        + '</div><div class="selected-status-list">' + statusHtml + '</div>'
    }
    function updateHud(model) {
      const turnBadge = byId('turnBadge')
      if (turnBadge) {
        turnBadge.textContent = model.turn.isViewerTurn ? '我方回合' : '对方回合'
        turnBadge.className = 'turn-badge ' + (model.turn.isViewerTurn ? 'my-turn' : 'opp-turn')
      }
      if (model.turn.currentPlayerId && model.turn.currentPlayerId !== previousTurnPlayerId) {
        previousTurnPlayerId = model.turn.currentPlayerId
        announce(model.turn.isViewerTurn ? '你的回合' : '对方回合', model.turn.isViewerTurn ? '#4ade80' : '#f87171')
      }
      const roundLabel = byId('roundLabel')
      if (roundLabel) roundLabel.textContent = '第 ' + model.turn.number + ' 回合'
      const phaseLabel = byId('phaseLabel')
      if (phaseLabel) phaseLabel.textContent = PHASE_LABELS[model.turn.phase] || model.turn.phase
      const turnClock = byId('turnClock')
      if (turnClock) {
        turnClock.textContent = formatTimer(model.turn.remainingSeconds)
        turnClock.setAttribute('aria-label', model.turn.remainingSeconds == null
          ? '当前对局未提供回合计时'
          : '回合剩余 ' + Math.floor(model.turn.remainingSeconds) + ' 秒')
      }

      const viewer = model.viewer || model.players.find(function (player) { return player.isCurrent }) || model.players[0]
      const apDisplay = byId('resApDisplay')
      const cpDisplay = byId('resCpDisplay')
      if (apDisplay && viewer) apDisplay.style.display = ''
      if (cpDisplay && viewer) cpDisplay.style.display = ''
      const values = {
        resApVal: viewer && viewer.resources.action,
        resApMax: viewer && viewer.resources.maxAction,
        resCpVal: viewer && viewer.resources.charge,
        resCpMax: viewer && viewer.resources.maxCharge,
      }
      Object.keys(values).forEach(function (id) {
        const element = byId(id)
        if (element && values[id] != null) element.textContent = String(values[id])
      })

      const players = byId('playerResCards')
      if (!players) return
      players.className = 'player-state-strip'
      players.innerHTML = model.players.map(function (player) {
        const isLocal = !!(model.viewer && String(model.viewer.id).toLowerCase() === String(player.id).toLowerCase())
        const sideName = player.faction === 'blue' ? '蓝方 · 后手' : '红方 · 先手'
        const tags = (player.statusSummary || []).map(function (status) {
          return '<span class="status-tag" title="' + escapeHtml(status.id) + '">' + escapeHtml(statusLabel(status)) + '</span>'
        }).join('')
        const currentLabel = player.isCurrent ? '，当前行动方' : ''
        const localLabel = isLocal ? '，你' : ''
        return '<div class="player-state-chip ' + player.faction + (player.isCurrent ? ' active' : '') + (isLocal ? ' is-local-player' : '')
          + '" role="group" aria-label="' + escapeHtml(player.name + '，' + sideName + localLabel + currentLabel) + '" title="' + escapeHtml(player.id) + '">'
          + '<span class="player-avatar" aria-hidden="true">' + escapeHtml(playerInitial(player)) + '</span>'
          + (isLocal ? '<span class="local-player-mark" aria-hidden="true">你</span>' : '')
          + '<span class="player-state-copy"><span class="player-display-name">' + escapeHtml(player.name) + '</span>'
          + '<span class="player-side-name">' + sideName + '</span></span>'
          + '<span class="player-state-resources">'
          + '<span class="resource-orb action" title="行动点"><span class="resource-glyph action"></span>' + player.resources.action + '</span>'
          + '<span class="resource-orb charge" title="充能点"><span class="resource-glyph charge"></span>' + player.resources.charge + '</span>'
          + '</span>'
          + (player.isCurrent ? '<span class="current-player-marker" aria-hidden="true">◆</span>' : '')
          + '<div class="player-state-tags">' + tags + '</div></div>'
      }).join('')
    }

    function update(model) {
      if (!model) return
      updateHud(model)
      updateSelectedStatus(model)
    }

    function dispose() { previousTurnPlayerId = null }

    return { update: update, dispose: dispose }
  }

  root.BattleDomUI = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
