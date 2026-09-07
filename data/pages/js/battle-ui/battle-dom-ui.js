;(function (root) {
  'use strict'

  // Opt-in player-facing effects. Background trigger rules stay out of the HUD.
  const PLAYER_EFFECTS = Object.freeze([
    { id: 'elune-protection', statusType: 'elune-protection', label: '艾露恩的守护', icon: 'images/effect-icons/player-elune.svg', description: '免疫友方棋子的一次致命伤害，并恢复5点生命。全队共用一次。' },
    { id: 'elune-blessing', buffId: 'elune-blessing-buff', label: '月神赐福', icon: 'images/effect-icons/player-elune-blessing.svg', description: '下一张圣光手牌的效果提高100%，使用后消耗。' },
    { id: 'soul-fracture', ruleId: 'rule-soul-fracture-player', label: '裂魂', icon: 'images/effect-icons/player-soul-fracture.svg', description: '本局中，每有一个棋子死亡，你获得1张灵魂残片。' },
  ])

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

  function statusIcon(status) {
    return String(status && (status.iconPath || status.assetPath) || 'images/effect-icons/fallback.svg')
  }

  function statusBadge(status) {
    const presentation = root.BattleEffectIcons
    const values = presentation && typeof presentation.badge === 'function'
      ? presentation.badge(status)
      : status || {}
    const stacks = Number(values.stacks)
    const uses = Number(values.uses)
    const duration = Number(values.duration)
    const intensity = Number(values.intensity)
    if (Number.isFinite(stacks) && stacks > 1) return String(stacks)
    if (Number.isFinite(uses) && uses > 0) return String(uses)
    if (Number.isFinite(duration) && duration > 0) return String(duration)
    if (Number.isFinite(intensity) && intensity > 1) return String(intensity)
    return ''
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
        const currentLabel = player.isCurrent ? '，当前行动方' : ''
        const tags = PLAYER_EFFECTS.filter(function (effect) {
          return effect.statusType ? (player.statusSummary || []).some(function (status) { return status.type === effect.statusType })
            : effect.buffId ? (player.buffSummary || []).some(function (buff) { return buff.id === effect.buffId && buff.uses > 0 })
            : (player.ruleSummary || []).some(function (rule) { return rule.id === effect.ruleId })
        }).map(function (effect) {
          return '<span class="player-effect-icon" tabindex="0" aria-label="' + escapeHtml(effect.label + '：' + effect.description) + '"><img src="' + effect.icon + '" alt=""><span class="player-effect-tip" role="tooltip"><b>' + escapeHtml(effect.label) + '</b><span>' + escapeHtml(effect.description) + '</span></span></span>'
        }).join('')
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
          + '<div class="player-state-tags">' + tags + '</div>' + '</div>'
      }).join('')
    }

    function update(model) {
      if (!model) return
      updateHud(model)
    }

    function dispose() { previousTurnPlayerId = null }

    return { update: update, dispose: dispose }
  }

  root.BattleDomUI = { playerEffectRegistry: PLAYER_EFFECTS, create: create }
})(typeof window !== 'undefined' ? window : globalThis)
