;(function (root) {
  'use strict'

  const MAX_BOARD_STATUSES = 2

  const DEFAULT_DETAIL = {
    priority: 0,
    color: '#94a3b8',
    glyph: '•',
    description: '状态详情由当前权威快照提供。',
    negative: false,
    visibility: 'board',
  }

  function resolve(status) {
    const registry = root.BattleEffectIcons
    return registry && typeof registry.resolveStatus === 'function'
      ? registry.resolveStatus(status)
      : DEFAULT_DETAIL
  }

  function boardEntries(statuses) {
    return (statuses || [])
      .map(function (status, index) {
        return { status: status, meta: resolve(status), index: index }
      })
      .filter(function (entry) { return entry.meta.visibility === 'board' })
      .sort(function (left, right) {
        return right.meta.priority - left.meta.priority || left.index - right.index
      })
  }

  function boardOverview(statuses) {
    const all = boardEntries(statuses)
    return {
      items: all.slice(0, MAX_BOARD_STATUSES),
      all: all,
      overflowCount: Math.max(0, all.length - MAX_BOARD_STATUSES),
    }
  }

  function boardSummary(statuses) {
    return boardOverview(statuses).items
  }

  function durationValue(status) {
    const raw = status && (status.remainingDuration !== undefined
      ? status.remainingDuration
      : (status.currentDuration !== undefined ? status.currentDuration : status.duration))
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  }

  function detailText(status) {
    const parts = []
    const stacks = Number(status && status.stacks)
    const duration = durationValue(status)
    const uses = Number(status && (status.uses !== undefined
      ? status.uses
      : (status.remainingUses !== undefined ? status.remainingUses : status.currentUses)))
    const intensity = Number(status && status.intensity)
    if (Number.isFinite(stacks) && stacks > 0) parts.push(stacks + '层')
    if (duration < 0) parts.push('持续：永久')
    else if (duration > 0) parts.push('剩余：' + duration + '回合')
    if (Number.isFinite(uses) && uses > 0) parts.push('剩余：' + uses + '次')
    if (Number.isFinite(intensity) && intensity > 0 && intensity !== 1) parts.push('强度：' + intensity)
    return parts.join(' · ')
  }

  root.BattleStatusPresentation = {
    MAX_BOARD_STATUSES: MAX_BOARD_STATUSES,
    resolve: resolve,
    boardEntries: boardEntries,
    boardOverview: boardOverview,
    boardSummary: boardSummary,
    durationValue: durationValue,
    detailText: detailText,
  }
})(typeof window !== 'undefined' ? window : globalThis)
