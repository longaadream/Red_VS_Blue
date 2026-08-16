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

  function statusMeta(status) {
    const parts = []
    if (status.stacks > 0) parts.push(status.stacks + ' 层')
    if (status.duration > 0) parts.push('剩余 ' + status.duration + ' 回合')
    if (status.duration < 0) parts.push('永久')
    if (status.uses > 0) parts.push('剩余 ' + status.uses + ' 次')
    if (status.intensity && status.intensity !== 1) parts.push('强度 ' + status.intensity)
    return parts.join(' · ')
  }

  function create(options) {
    const input = options || {}
    const doc = input.document || root.document
    const announce = typeof input.onTurnAnnounce === 'function' ? input.onTurnAnnounce : function () {}
    let previousTurnPlayerId = null

    function byId(id) { return doc && doc.getElementById ? doc.getElementById(id) : null }

    function statusDetailHtml(status) {
      const presentation = root.BattleStatusPresentation
      const meta = presentation
        ? presentation.resolve(status)
        : { color: '#94a3b8', glyph: '\u2022', description: '\u72b6\u6001\u8be6\u60c5\u7531\u5f53\u524d\u6743\u5a01\u5feb\u7167\u63d0\u4f9b\u3002' }
      const detail = presentation ? presentation.detailText(status) : statusMeta(status)
      const description = status.description || meta.description
      return '<div class="selected-status-row" data-status-id="' + escapeHtml(status.id || '') + '">'
        + '<span class="selected-status-icon" style="--status-color:' + escapeHtml(meta.color) + '">' + escapeHtml(meta.glyph) + '</span>'
        + '<span class="selected-status-copy"><span class="selected-status-name">' + escapeHtml(status.label || status.id || '?') + '</span>'
        + (detail ? '<span class="selected-status-meta">' + escapeHtml(detail) + '</span>' : '')
        + (description ? '<span class="selected-status-description">' + escapeHtml(description) + '</span>' : '')
        + '</span></div>'
    }

    function updateSelectedPiece(model) {
      const element = byId('selectedPieceStatus')
      if (!element) return
      const piece = model.selection && model.selection.piece
      const rail = element.closest ? element.closest('.board-side-rail') : null
      const targetMode = !!(model.selection && model.selection.mode === 'target')
      if (rail && rail.classList) {
        rail.classList.toggle('has-selection', !!piece)
        rail.classList.toggle('target-mode', targetMode)
      }
      if (!piece) {
        element.className = 'selected-status-empty'
        element.textContent = '未选中棋子'
        if (element.dataset) delete element.dataset.pieceId
        if (element.removeAttribute) element.removeAttribute('aria-label')
        return
      }
      const statuses = piece.statuses || piece.statusSummary || []
      const statusesHtml = statuses.length
        ? statuses.map(statusDetailHtml).join('')
        : '<div class="selected-status-zero">无特殊状态</div>'
      element.className = 'selected-status-card has-selection' + (targetMode ? ' target-mode' : '')
      if (element.dataset) element.dataset.pieceId = piece.id
      if (element.setAttribute) {
        element.setAttribute('aria-label', '特殊状态，共 ' + statuses.length + ' 个')
        element.setAttribute('aria-live', 'polite')
      }
      element.innerHTML = '<div class="selected-status-title">特殊状态 <span>' + statuses.length + '</span></div>'
        + '<div class="selected-status-list">' + statusesHtml + '</div>'
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
        const sideName = player.faction === 'blue' ? '🔵后手' : '🔴先手'
        const tags = player.statusSummary.map(function (status) {
          return '<span class="status-tag" title="' + escapeHtml(status.id) + '">' + escapeHtml(statusLabel(status)) + '</span>'
        }).join('')
        return '<div class="player-state-chip ' + player.faction + (player.isCurrent ? ' active' : '') + '" title="' + escapeHtml(player.id) + '">'
          + '<div class="player-state-main"><span class="player-side-name">' + sideName + '</span>'
          + '<span class="resource-orb action" title="行动点"><span class="resource-glyph action"></span>' + player.resources.action + '</span>'
          + '<span class="resource-orb charge" title="充能点"><span class="resource-glyph charge"></span>' + player.resources.charge + '</span>'
          + (player.isCurrent ? '<span>当前</span>' : '') + '</div>'
          + '<div class="player-state-tags">' + tags + '</div></div>'
      }).join('')
    }

    function update(model) {
      if (!model) return
      updateHud(model)
      updateSelectedPiece(model)
    }

    function dispose() { previousTurnPlayerId = null }

    return { update: update, dispose: dispose }
  }

  root.BattleDomUI = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
