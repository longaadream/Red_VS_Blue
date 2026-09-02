;(function (root) {
  'use strict'

  function normalizeId(value) {
    return String(value || '').trim().toLowerCase()
  }

  function formatClock(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0)
    const minutesPart = Math.floor(seconds / 60)
    const secondsPart = seconds % 60
    return String(minutesPart).padStart(2, '0') + ':' + String(secondsPart).padStart(2, '0')
  }

  function matchingKey(record, playerId) {
    const normalizedPlayerId = normalizeId(playerId)
    return Object.keys(record || {}).find(function (candidate) {
      return normalizeId(candidate) === normalizedPlayerId
    })
  }

  function createProgressiveView(input, deployment) {
    const status = deployment.status
    if (status !== 'awaiting-reserve-deploy') {
      return {
        visible: false,
        mode: 'progressive-reserve-v1',
        phase: status,
        stateText: '',
        clockText: '',
        remainingSeconds: 0,
        urgent: false,
      }
    }

    const playerId = normalizeId(input.playerId)
    const ownsStep = !input.spectating && normalizeId(deployment.activePlayerId) === playerId
    const offerPieces = ownsStep && Array.isArray(deployment.offerPieces)
      ? deployment.offerPieces.map(function (piece) {
          return {
            instanceId: String(piece && piece.instanceId || ''),
            templateId: String(piece && piece.templateId || ''),
            name: String(piece && piece.name || piece && piece.templateId || '未知棋子'),
          }
        }).filter(function (piece) { return piece.instanceId })
      : []
    const reserveCounts = deployment.reserveCounts || {}
    const reserveKey = matchingKey(reserveCounts, deployment.activePlayerId)
    const reserveCount = reserveKey ? Math.max(0, Number(reserveCounts[reserveKey]) || 0) : 0
    const legalPositions = ownsStep && Array.isArray(deployment.legalPositions)
      ? deployment.legalPositions
      : []

    let stateText = '等待当前玩家完成部署'
    if (input.spectating) stateText = '观战 · 等待当前玩家完成部署'
    else if (!ownsStep) stateText = '等待对方完成部署'
    else if (input.selectedPieceName && legalPositions.length) stateText = '已选择 ' + input.selectedPieceName + ' · 请选择高亮落点'
    else if (legalPositions.length) stateText = '选择一名预备棋子，再选择高亮落点'
    else stateText = '选择一名预备棋子 · 将由规则随机落位'

    return {
      visible: true,
      mode: 'progressive-reserve-v1',
      phase: status,
      ownsStep: ownsStep,
      offerPieces: offerPieces,
      reserveCount: reserveCount,
      legalPositions: legalPositions,
      showCandidates: ownsStep,
      stateText: stateText,
      clockText: '',
      remainingSeconds: 0,
      urgent: false,
    }
  }

  function create(input) {
    input = input || {}
    const deployment = input.deployment
    if (deployment && deployment.mode === 'progressive-reserve-v1') {
      return createProgressiveView(input, deployment)
    }
    if (!deployment || deployment.status !== 'awaiting-locks') {
      return { visible: false, clockText: '00:00', remainingSeconds: 0, stateText: '', urgent: false }
    }

    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()
    const deadlineAt = Number(deployment.deadlineAt || 0)
    const remainingSeconds = Math.max(0, Math.ceil((deadlineAt - now) / 1000))
    const locks = deployment.locks || {}
    const playerId = normalizeId(input.playerId)
    const playerIds = Object.keys(locks)
    const localKey = playerIds.find(function (candidate) { return normalizeId(candidate) === playerId })
    const localLocked = !!(localKey && locks[localKey] && locks[localKey].locked)
    const opponentLocked = playerIds.some(function (candidate) {
      return normalizeId(candidate) !== playerId && locks[candidate] && locks[candidate].locked
    })
    const allLocked = playerIds.length > 0 && playerIds.every(function (candidate) {
      return locks[candidate] && locks[candidate].locked
    })

    let stateText = '选择一枚核心棋子重投，或直接保留'
    if (input.spectating) stateText = allLocked ? '双方已锁定 · 正在确认' : '观战 · 等待双方确认'
    else if (allLocked) stateText = '双方已锁定 · 正在确认'
    else if (localLocked) stateText = '已锁定 · 等待对方'
    else if (opponentLocked) stateText = '对方已锁定 · 请确认部署'
    else if (input.selectedPieceName) stateText = '已选择重投：' + input.selectedPieceName

    return {
      visible: true,
      clockText: formatClock(remainingSeconds),
      remainingSeconds: remainingSeconds,
      stateText: stateText,
      urgent: remainingSeconds <= 10,
    }
  }

  root.RvBDeploymentStatus = { create: create, formatClock: formatClock }
})(typeof window !== 'undefined' ? window : globalThis)
