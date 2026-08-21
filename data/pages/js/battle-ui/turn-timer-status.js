;(function (root) {
  'use strict'

  function formatClock(seconds) {
    const safe = Math.max(0, Math.ceil(Number(seconds) || 0))
    const minutes = Math.floor(safe / 60)
    const remainder = safe % 60
    return String(minutes).padStart(2, '0') + ':' + String(remainder).padStart(2, '0')
  }

  function create(options) {
    const input = options || {}
    const timer = input.timer
    const now = Number(input.now)
    const visible = !!timer && timer.status === 'running' && Number.isFinite(now)
    if (!visible) {
      return {
        visible: false,
        remainingSeconds: 0,
        clockText: '--:--',
        burning: false,
        fast: false,
        label: '回合计时',
      }
    }

    const remainingMs = Math.max(0, Number(timer.deadlineAt) - now)
    const remainingSeconds = Math.ceil(remainingMs / 1000)
    const burning = timer.burning === true || now >= Number(timer.burnStartsAt)
    const fast = timer.fast === true
    const label = fast ? '快速烧绳' : (burning ? '烧绳阶段' : '回合计时')
    return {
      visible: true,
      remainingSeconds,
      clockText: formatClock(remainingSeconds),
      burning,
      fast,
      label,
    }
  }

  root.RvBTurnTimerStatus = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
