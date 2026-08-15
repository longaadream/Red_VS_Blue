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
    const extra = status.stacks ? 'x' + status.stacks : (status.duration ? status.duration + 'T' : '')
    return status.label + extra
  }

  function create(options) {
    const input = options || {}
    const doc = input.document || root.document
    const announce = typeof input.onTurnAnnounce === 'function' ? input.onTurnAnnounce : function () {}
    let previousTurnPlayerId = null

    function byId(id) { return doc && doc.getElementById ? doc.getElementById(id) : null }

    function updateSelectedPiece(model) {
      const element = byId('selectedPieceStatus')
      if (!element) return
      const piece = model.selection && model.selection.piece
      if (!piece) {
        element.className = 'selected-status-empty'
        element.textContent = '未选中棋子'
        return
      }
      const tags = piece.statusSummary || []
      const tagsHtml = tags.length
        ? tags.map(function (status) {
            return '<span class="status-tag" title="' + escapeHtml(status.id) + '">' + escapeHtml(statusLabel(status)) + '</span>'
          }).join('')
        : '<span class="status-empty">无状态</span>'
      element.className = 'selected-status-card'
      element.innerHTML = '<div class="selected-piece-name">' + escapeHtml(piece.name) + '</div>'
        + '<div class="selected-piece-hp">HP ' + piece.health.current + ' / ' + piece.health.max + '</div>'
        + '<div class="selected-status-title">状态</div>'
        + '<div class="selected-status-tags">' + tagsHtml + '</div>'
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
