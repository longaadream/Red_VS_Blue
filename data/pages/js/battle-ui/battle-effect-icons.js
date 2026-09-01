;(function (root) {
  'use strict'

  const VISIBILITY = Object.freeze({ BOARD: 'board', DETAIL: 'detail', HIDDEN: 'hidden' })

  const categories = Object.freeze({
    'damage-over-time': { iconId: 'burn', assetPath: '/effect-icons/burn.svg', color: '#fb923c', tone: 'danger', negative: true, priority: 220 },
    control: { iconId: 'immobile', assetPath: '/effect-icons/immobile.svg', color: '#facc15', tone: 'warning', negative: true, priority: 340 },
    disable: { iconId: 'silence', assetPath: '/effect-icons/silence.svg', color: '#fb7185', tone: 'danger', negative: true, priority: 420 },
    curse: { iconId: 'curse', assetPath: '/effect-icons/curse.svg', color: '#c084fc', tone: 'danger', negative: true, priority: 280 },
    buff: { iconId: 'buff', assetPath: '/effect-icons/buff.svg', color: '#4ade80', tone: 'positive', negative: false, priority: 80 },
    shield: { iconId: 'shield', assetPath: '/effect-icons/shield.svg', color: '#60a5fa', tone: 'positive', negative: false, priority: 100 },
    stance: { iconId: 'stance', assetPath: '/effect-icons/stance.svg', color: '#fbbf24', tone: 'positive', negative: false, priority: 70 },
    charge: { iconId: 'charge', assetPath: '/effect-icons/charge.svg', color: '#f59e0b', tone: 'positive', negative: false, priority: 70 },
    transformation: { iconId: 'transformation', assetPath: '/effect-icons/transformation.svg', color: '#a78bfa', tone: 'positive', negative: false, priority: 90 },
    revive: { iconId: 'revive', assetPath: '/effect-icons/revive.svg', color: '#34d399', tone: 'positive', negative: false, priority: 100 },
    time: { iconId: 'time', assetPath: '/effect-icons/time.svg', color: '#38bdf8', tone: 'neutral', negative: false, priority: 60 },
    counter: { iconId: 'counter', assetPath: '/effect-icons/counter.svg', color: '#f472b6', tone: 'neutral', negative: false, priority: 50 },
    mark: { iconId: 'mark', assetPath: '/effect-icons/mark.svg', color: '#22d3ee', tone: 'neutral', negative: false, priority: 50 },
    internal: { iconId: 'internal', assetPath: '/effect-icons/internal.svg', color: '#64748b', tone: 'muted', negative: false, priority: -1 },
    unknown: { iconId: 'fallback', assetPath: '/effect-icons/fallback.svg', color: '#94a3b8', tone: 'neutral', negative: false, priority: 0 },
  })

  function entry(category, visibility, overrides) {
    return Object.freeze(Object.assign({}, categories[category], {
      category: category,
      visibility: visibility,
    }, overrides || {}))
  }

  const statusRegistry = Object.freeze({
    'amaterasu-burn': entry('damage-over-time', VISIBILITY.BOARD, { iconId: 'amaterasu', assetPath: '/tile-effects/amaterasu.svg', label: '天照', priority: 260 }),
    'anti-heal': entry('disable', VISIBILITY.BOARD, { iconId: 'anti-heal', assetPath: '/effect-icons/anti-heal.svg', label: '禁疗', priority: 440 }),
    'arthas-slow': entry('control', VISIBILITY.BOARD, { iconId: 'slow', assetPath: '/effect-icons/slow.svg', label: '减速', priority: 320 }),
    blizzard: entry('control', VISIBILITY.DETAIL, { iconId: 'freeze', assetPath: '/tile-effects/blizzard.svg', label: '暴风雪' }),
    'blood-oath': entry('curse', VISIBILITY.BOARD, { label: '血誓' }),
    buff: entry('buff', VISIBILITY.DETAIL),
    'calm-shield': entry('shield', VISIBILITY.DETAIL),
    'calm-stance': entry('stance', VISIBILITY.DETAIL),
    'chidori-immobile': entry('control', VISIBILITY.BOARD, { label: '千鸟定身' }),
    'curse-ward-used': entry('internal', VISIBILITY.HIDDEN),
    'damage-buff': entry('buff', VISIBILITY.DETAIL),
    'deployment-first-move-free': entry('buff', VISIBILITY.DETAIL, { iconId: 'free-move', assetPath: '/effect-icons/free-move.svg', label: '首次移动免费' }),
    'demon-strike-charges': entry('charge', VISIBILITY.DETAIL),
    'divine-blessing-buff': entry('buff', VISIBILITY.DETAIL),
    'divine-shield': entry('shield', VISIBILITY.DETAIL, { iconId: 'divine-shield', assetPath: '/effect-icons/divine-shield.svg', label: '圣盾' }),
    'elune-protection': entry('shield', VISIBILITY.DETAIL, { iconId: 'ward', assetPath: '/effect-icons/ward.svg', label: '艾露恩庇护' }),
    'flying-raijin-mark': entry('mark', VISIBILITY.DETAIL, { iconId: 'flying-raijin-mark', assetPath: '/tile-effects/flying-raijin-anchor.svg', label: '飞雷神印记' }),
    freeze: entry('control', VISIBILITY.BOARD, { iconId: 'freeze', assetPath: '/tile-effects/blizzard.svg', label: '冰冻', priority: 500 }),
    'hardy-block': entry('shield', VISIBILITY.DETAIL),
    'hidan-dying': entry('revive', VISIBILITY.BOARD, { iconId: 'dying', assetPath: '/effect-icons/dying.svg', label: '濒死', color: '#fb7185', tone: 'danger', negative: true, priority: 480 }),
    'hidan-undying-used': entry('internal', VISIBILITY.HIDDEN),
    'icebound-fortitude': entry('shield', VISIBILITY.DETAIL),
    'ichigo-bankai': entry('transformation', VISIBILITY.DETAIL),
    'itachi-tsukuyomi': entry('curse', VISIBILITY.BOARD, { label: '月读', priority: 400 }),
    'kamui-shield': entry('shield', VISIBILITY.DETAIL),
    'lethal-toxin': entry('damage-over-time', VISIBILITY.BOARD, { iconId: 'lethal-toxin', assetPath: '/tile-effects/lethal-toxin.svg', label: '致命毒素', priority: 240 }),
    'lich-covenant': entry('revive', VISIBILITY.DETAIL),
    'nano-boost': entry('buff', VISIBILITY.DETAIL),
    'obito-grudge': entry('counter', VISIBILITY.DETAIL),
    'rafaam-temporal-distortion': entry('time', VISIBILITY.DETAIL, { label: '时空扭曲' }),
    'rage-stance': entry('stance', VISIBILITY.DETAIL),
    'sage-mode': entry('transformation', VISIBILITY.DETAIL),
    'sage-mode-shield': entry('shield', VISIBILITY.DETAIL),
    'shadow-step': entry('buff', VISIBILITY.DETAIL, { iconId: 'shadow-step', assetPath: '/tile-effects/shadow-step.svg', label: '暗影步' }),
    'shishio-cooldown-fired': entry('internal', VISIBILITY.HIDDEN),
    'shishio-dmg-counter': entry('internal', VISIBILITY.HIDDEN),
    'shishio-kills': entry('counter', VISIBILITY.DETAIL),
    silenced: entry('disable', VISIBILITY.BOARD, { iconId: 'silence', label: '沉默', priority: 450 }),
    sleep: entry('control', VISIBILITY.BOARD, { iconId: 'sleep', assetPath: '/effect-icons/sleep.svg', label: '睡眠', color: '#e879f9', priority: 510 }),
    'susanoo-active': entry('transformation', VISIBILITY.DETAIL),
    'tenken-charge': entry('charge', VISIBILITY.DETAIL),
    'undead-body': entry('revive', VISIBILITY.DETAIL),
    'velen-fate-shelter': entry('shield', VISIBILITY.DETAIL),
    'venom-corrosion-immobile': entry('control', VISIBILITY.BOARD, { label: '腐蚀定身' }),
  })

  const actionRegistry = Object.freeze({
    'action-move': entry('mark', VISIBILITY.DETAIL, { iconId: 'action-move', assetPath: '/effect-icons/action-move.svg', label: '移动' }),
    'action-skill': entry('transformation', VISIBILITY.DETAIL, { iconId: 'action-skill', assetPath: '/effect-icons/action-skill.svg', label: '技能' }),
    'action-charge-skill': entry('charge', VISIBILITY.DETAIL, { iconId: 'action-charge-skill', assetPath: '/effect-icons/action-charge-skill.svg', label: '充能技能' }),
    'action-card': entry('buff', VISIBILITY.DETAIL, { iconId: 'action-card', assetPath: '/effect-icons/action-card.svg', label: '卡牌' }),
    'action-passive': entry('time', VISIBILITY.DETAIL, { iconId: 'action-passive', assetPath: '/effect-icons/action-passive.svg', label: '被动触发' }),
    'action-damage': entry('damage-over-time', VISIBILITY.DETAIL, { iconId: 'action-damage', assetPath: '/effect-icons/action-damage.svg', label: '伤害' }),
    'action-heal': entry('revive', VISIBILITY.DETAIL, { iconId: 'action-heal', assetPath: '/effect-icons/action-heal.svg', label: '治疗' }),
    'action-death': entry('revive', VISIBILITY.DETAIL, { iconId: 'action-death', assetPath: '/effect-icons/action-death.svg', label: '死亡', color: '#fb7185', tone: 'danger' }),
    'status-add': entry('buff', VISIBILITY.DETAIL, { iconId: 'status-add', assetPath: '/effect-icons/status-add.svg', label: '获得状态' }),
    'status-remove': entry('unknown', VISIBILITY.DETAIL, { iconId: 'status-remove', assetPath: '/effect-icons/status-remove.svg', label: '移除状态' }),
    shield: entry('shield', VISIBILITY.DETAIL),
  })

  const fallback = entry('unknown', VISIBILITY.DETAIL)
  const forcedHidden = entry('internal', VISIBILITY.HIDDEN)

  function statusType(status) {
    if (typeof status === 'string') return status
    return String(status && (status.type || status.id || status.name) || '')
  }

  function resolveStatusType(type) {
    return statusRegistry[String(type || '')] || fallback
  }

  function resolveStatus(status) {
    if (status && typeof status === 'object' && status.visible === false) return forcedHidden
    return resolveStatusType(statusType(status))
  }

  function resolveAction(iconId) {
    return actionRegistry[String(iconId || '')] || fallback
  }

  function value(status, keys) {
    for (let index = 0; index < keys.length; index += 1) {
      const raw = status && status[keys[index]]
      if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
    }
    return 0
  }

  function badge(status) {
    return {
      stacks: value(status, ['stacks']),
      duration: value(status, ['remainingDuration', 'currentDuration', 'remainingTurns', 'duration']),
      uses: value(status, ['remainingUses', 'currentUses', 'uses']),
      intensity: value(status, ['intensity']),
    }
  }

  root.BattleEffectIcons = {
    visibility: VISIBILITY,
    categoryRegistry: categories,
    statusRegistry: statusRegistry,
    actionRegistry: actionRegistry,
    resolveStatusType: resolveStatusType,
    resolveStatus: resolveStatus,
    resolveAction: resolveAction,
    badge: badge,
  }
})(typeof window !== 'undefined' ? window : globalThis)
