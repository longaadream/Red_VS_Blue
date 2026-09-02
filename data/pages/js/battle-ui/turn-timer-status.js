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
    const pendingTimer = input.pendingTimer
    const now = Number(input.now)
    const activeTimer = pendingTimer && pendingTimer.status === 'running' ? pendingTimer : timer
    const visible = !!activeTimer && activeTimer.status === 'running' && Number.isFinite(now)
    if (!visible) {
      return {
        visible: false,
        remainingSeconds: 0,
        clockText: '--:--',
        frozenClockText: '--:--',
        burning: false,
        fast: false,
        label: '回合计时',
      }
    }

    const responseActive = activeTimer === pendingTimer
    const remainingMs = Math.max(0, Number(activeTimer.deadlineAt) - now)
    const remainingSeconds = Math.ceil(remainingMs / 1000)
    const burning = !responseActive && (timer.burning === true || now >= Number(timer.burnStartsAt))
    const fast = !responseActive && timer.fast === true
    const frozenSeconds = timer && timer.paused
      ? Math.ceil(Math.max(0, Number(timer.remainingMs) || 0) / 1000)
      : 0
    const label = responseActive
      ? '响应计时（回合计时已冻结 ' + formatClock(frozenSeconds) + '）'
      : fast ? '快速烧绳' : (burning ? '烧绳阶段' : '回合计时')
    return {
      visible: true,
      remainingSeconds,
      clockText: formatClock(remainingSeconds),
      frozenClockText: responseActive ? formatClock(frozenSeconds) : '--:--',
      burning,
      fast,
      label,
    }
  }

  root.RvBTurnTimerStatus = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
