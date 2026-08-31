;(function (root) {
  'use strict'

  const MAX_BOARD_STATUSES = 2

  // Display-only priority. This never changes status rules, stacks, or duration.
  const NEGATIVE_STATUS_PRIORITY = [
    {
      keys: ['stun', 'sleep', 'freeze', 'frozen', '眩晕', '麻醉', '冰冻'],
      priority: 500,
      color: '#e879f9',
      glyph: '◆',
      description: '控制类负面状态，具体限制以当前权威快照为准。',
    },
    {
      keys: ['silence', 'anti-heal', 'healing-reduction', '沉默', '禁疗'],
      priority: 400,
      color: '#fb7185',
      glyph: '×',
      description: '能力或治疗受限状态，具体效果以当前权威快照为准。',
    },
    {
      keys: ['immobile', 'root', 'slow', 'cripple', '无法移动', '定身', '减速'],
      priority: 300,
      color: '#facc15',
      glyph: '↓',
      description: '行动或移动受限状态，具体效果以当前权威快照为准。',
    },
    {
      keys: ['bleed', 'bleeding', 'burn', 'poison', 'toxin', 'amaterasu', '流血', '灼烧', '中毒', '天照'],
      priority: 200,
      color: '#fb923c',
      glyph: '•',
      description: '持续伤害类负面状态，具体结算以当前权威快照为准。',
    },
    {
      keys: ['weak', 'vulnerable', 'curse', 'debuff', '虚弱', '易伤', '诅咒'],
      priority: 100,
      color: '#a78bfa',
      glyph: '!',
      description: '其他高优先级负面状态，具体效果以当前权威快照为准。',
    },
  ]

  const DEFAULT_DETAIL = {
    priority: 0,
    color: '#94a3b8',
    glyph: '•',
    description: '状态详情由当前权威快照提供。',
    negative: false,
  }

  function statusSearchText(status) {
    return [status && status.id, status && status.type, status && status.label, status && status.name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
  }

  function resolve(status) {
    const searchText = statusSearchText(status)
    const configured = NEGATIVE_STATUS_PRIORITY.find(function (entry) {
      return entry.keys.some(function (key) { return searchText.includes(key) })
    })
    return configured
      ? Object.assign({}, configured, { negative: true })
      : DEFAULT_DETAIL
  }

  function boardSummary(statuses) {
    return (statuses || [])
      .map(function (status, index) {
        return { status: status, meta: resolve(status), index: index }
      })
      .filter(function (entry) { return entry.meta.negative })
      .sort(function (left, right) {
        return right.meta.priority - left.meta.priority || left.index - right.index
      })
      .slice(0, MAX_BOARD_STATUSES)
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
    negativePriority: NEGATIVE_STATUS_PRIORITY,
    resolve: resolve,
    boardSummary: boardSummary,
    durationValue: durationValue,
    detailText: detailText,
  }
})(typeof window !== 'undefined' ? window : globalThis)
