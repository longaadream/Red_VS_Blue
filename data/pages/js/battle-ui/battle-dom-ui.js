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

  function statusMeta(status) {
    const parts = []
    if (status.stacks > 0) parts.push(status.stacks + ' 层')
    if (status.duration > 0) parts.push('剩余 ' + status.duration + ' 回合')
    if (status.duration < 0) parts.push('永久')
    if (status.uses > 0) parts.push('剩余 ' + status.uses + ' 次')
    if (status.intensity && status.intensity !== 1) parts.push('强度 ' + status.intensity)
    return parts.join(' · ')
  }

  function skillTypeLabel(skill) {
    if (skill.kind === 'passive' || skill.type === 'passive') return '被动'
    if (skill.type === 'super') return '充能'
    return '主动'
  }

  function skillCostHtml(skill) {
    const cooldown = skill.cooldown || { current: 0, max: 0 }
    return '<span class="selected-skill-cost action">行动 ' + skill.actionCost + '</span>'
      + '<span class="selected-skill-cost charge">充能 ' + skill.chargeCost + '</span>'
      + '<span class="selected-skill-cooldown">冷却 ' + cooldown.current + '/' + cooldown.max + '</span>'
  }

  function create(options) {
    const input = options || {}
    const doc = input.document || root.document
    const announce = typeof input.onTurnAnnounce === 'function' ? input.onTurnAnnounce : function () {}
    let onIntent = typeof input.onIntent === 'function' ? input.onIntent : function () {}
    let previousTurnPlayerId = null

    function byId(id) { return doc && doc.getElementById ? doc.getElementById(id) : null }

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
        return
      }
      const statuses = piece.statuses || piece.statusSummary || []
      const statusesHtml = statuses.length
        ? statuses.map(function (status) {
            const meta = statusMeta(status)
            return '<article class="selected-status-item">'
              + '<div class="selected-status-item-name">' + escapeHtml(status.label) + '</div>'
              + (meta ? '<div class="selected-status-item-meta">' + escapeHtml(meta) + '</div>' : '')
              + (status.description ? '<div class="selected-status-item-desc">' + escapeHtml(status.description) + '</div>' : '')
              + '</article>'
          }).join('')
        : '<div class="selected-detail-zero">无可见状态</div>'
      const skills = piece.skills || []
      const skillsHtml = skills.length
        ? skills.map(function (skill) {
            const disabled = !skill.available
            const reason = skill.unavailableReason || ''
            return '<button type="button" class="selected-skill-item' + (disabled ? ' is-disabled' : ' is-available') + '"'
              + ' data-skill-id="' + escapeHtml(skill.id) + '"'
              + (disabled ? ' disabled aria-disabled="true"' : '') + '>'
              + '<span class="selected-skill-head"><span class="selected-skill-icon" aria-hidden="true">'
              + escapeHtml(skill.icon || 'S') + '</span><span class="selected-skill-name">'
              + escapeHtml(skill.name) + '</span><span class="selected-skill-type">'
              + escapeHtml(skillTypeLabel(skill)) + '</span></span>'
              + '<span class="selected-skill-desc">' + escapeHtml(skill.description) + '</span>'
              + '<span class="selected-skill-meta">' + skillCostHtml(skill) + '</span>'
              + (reason ? '<span class="selected-skill-reason">' + escapeHtml(reason) + '</span>' : '')
              + '</button>'
          }).join('')
        : '<div class="selected-detail-zero">无公开技能</div>'
      const portrait = piece.portraitSrc
        ? '<img src="' + escapeHtml(piece.portraitSrc) + '" alt="" loading="lazy">'
        : '<span aria-hidden="true">' + escapeHtml((piece.name || '?').slice(0, 1)) + '</span>'
      element.className = 'selected-status-card has-selection' + (targetMode ? ' target-mode' : '')
      if (element.dataset) element.dataset.pieceId = piece.id
      if (element.setAttribute) {
        element.setAttribute('aria-label', piece.name + '详情')
        element.setAttribute('aria-live', 'polite')
      }
      element.innerHTML = '<div class="selected-detail-header">'
        + '<div class="selected-detail-portrait">' + portrait + '</div>'
        + '<div class="selected-detail-identity"><div class="selected-piece-name">' + escapeHtml(piece.name) + '</div>'
        + '<div class="selected-detail-access">' + (piece.readOnly ? '敌方公开详情 · 只读' : '我方棋子 · 可操作') + '</div>'
        + '<div class="selected-piece-hp">生命 ' + piece.health.current + ' / ' + piece.health.max + '</div></div>'
        + '<button type="button" class="selected-detail-close" data-battle-action="clear-selection" aria-label="关闭棋子详情">×</button>'
        + '</div>'
        + '<div class="selected-detail-stats" role="list" aria-label="基础属性">'
        + '<div role="listitem"><strong>' + piece.stats.attack + '</strong><span>攻击</span></div>'
        + '<div role="listitem"><strong>' + piece.stats.defense + '</strong><span>防御</span></div>'
        + '<div role="listitem"><strong>' + piece.stats.moveRange + '</strong><span>移动</span></div></div>'
        + '<section class="selected-detail-section"><div class="selected-status-title">可见状态 <span>' + statuses.length + '</span></div>'
        + '<div class="selected-status-list">' + statusesHtml + '</div></section>'
        + '<section class="selected-detail-section"><div class="selected-status-title">技能 <span>' + skills.length + '</span></div>'
        + '<div class="selected-skill-list">' + skillsHtml + '</div></section>'

      if (element.querySelectorAll) {
        element.querySelectorAll('[data-skill-id]:not([disabled])').forEach(function (button) {
          button.addEventListener('click', function () {
            onIntent({ type: 'select-skill', skillId: button.getAttribute('data-skill-id') })
          })
        })
        element.querySelectorAll('[data-battle-action="clear-selection"]').forEach(function (button) {
          button.addEventListener('click', function () { onIntent({ type: 'clear-selection' }) })
        })
      }
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
    function setOnIntent(handler) {
      onIntent = typeof handler === 'function' ? handler : function () {}
    }

    return { update: update, dispose: dispose, setOnIntent: setOnIntent }
  }

  root.BattleDomUI = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
