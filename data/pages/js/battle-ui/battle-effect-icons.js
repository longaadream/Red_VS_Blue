;(function (root) {
  'use strict'

  const VISIBILITY = Object.freeze({ BOARD: 'board', DETAIL: 'detail', HIDDEN: 'hidden' })

  const categories = Object.freeze({
    'damage-over-time': { iconId: 'burn', assetPath: 'images/effect-icons/burn.svg', color: '#fb923c', tone: 'danger', negative: true, priority: 220 },
    control: { iconId: 'immobile', assetPath: 'images/effect-icons/immobile.svg', color: '#facc15', tone: 'warning', negative: true, priority: 340 },
    disable: { iconId: 'silence', assetPath: 'images/effect-icons/silence.svg', color: '#fb7185', tone: 'danger', negative: true, priority: 420 },
    curse: { iconId: 'curse', assetPath: 'images/effect-icons/curse.svg', color: '#c084fc', tone: 'danger', negative: true, priority: 280 },
    buff: { iconId: 'buff', assetPath: 'images/effect-icons/buff.svg', color: '#4ade80', tone: 'positive', negative: false, priority: 80 },
    shield: { iconId: 'shield', assetPath: 'images/effect-icons/shield.svg', color: '#60a5fa', tone: 'positive', negative: false, priority: 100 },
    stance: { iconId: 'stance', assetPath: 'images/effect-icons/stance.svg', color: '#fbbf24', tone: 'positive', negative: false, priority: 70 },
    charge: { iconId: 'charge', assetPath: 'images/effect-icons/charge.svg', color: '#f59e0b', tone: 'positive', negative: false, priority: 70 },
    transformation: { iconId: 'transformation', assetPath: 'images/effect-icons/transformation.svg', color: '#a78bfa', tone: 'positive', negative: false, priority: 90 },
    revive: { iconId: 'revive', assetPath: 'images/effect-icons/revive.svg', color: '#34d399', tone: 'positive', negative: false, priority: 100 },
    time: { iconId: 'time', assetPath: 'images/effect-icons/time.svg', color: '#38bdf8', tone: 'neutral', negative: false, priority: 60 },
    counter: { iconId: 'counter', assetPath: 'images/effect-icons/counter.svg', color: '#f472b6', tone: 'neutral', negative: false, priority: 50 },
    mark: { iconId: 'mark', assetPath: 'images/effect-icons/mark.svg', color: '#22d3ee', tone: 'neutral', negative: false, priority: 50 },
    internal: { iconId: 'internal', assetPath: 'images/effect-icons/internal.svg', color: '#64748b', tone: 'muted', negative: false, priority: -1 },
    unknown: { iconId: 'fallback', assetPath: 'images/effect-icons/fallback.svg', color: '#94a3b8', tone: 'neutral', negative: false, priority: 0 },
  })

  function entry(category, visibility, overrides) {
    return Object.freeze(Object.assign({}, categories[category], {
      category: category,
      visibility: visibility,
    }, overrides || {}))
  }

  const statusDefinitions = Object.freeze({
    'amaterasu-burn': entry('damage-over-time', VISIBILITY.BOARD, { iconId: 'amaterasu', assetPath: 'images/tile-effects/amaterasu.svg', label: '天照', priority: 260 }),
    'anti-heal': entry('disable', VISIBILITY.BOARD, { iconId: 'anti-heal', assetPath: 'images/effect-icons/anti-heal.svg', label: '禁疗', priority: 440 }),
    'arthas-slow': entry('control', VISIBILITY.BOARD, { iconId: 'slow', assetPath: 'images/effect-icons/slow.svg', label: '减速', priority: 320 }),
    'aizen-kyoka-active': entry('internal', VISIBILITY.HIDDEN),
    'aizen-kyoka-secret': entry('internal', VISIBILITY.HIDDEN),
    blizzard: entry('control', VISIBILITY.DETAIL, { iconId: 'freeze', assetPath: 'images/tile-effects/blizzard.svg', label: '暴风雪' }),
    'blood-oath': entry('curse', VISIBILITY.BOARD, { label: '血誓' }),
    buff: entry('buff', VISIBILITY.DETAIL),
    'calm-shield': entry('shield', VISIBILITY.DETAIL),
    'calm-stance': entry('stance', VISIBILITY.DETAIL),
    'chidori-immobile': entry('control', VISIBILITY.BOARD, { label: '千鸟定身' }),
    'curse-ward-used': entry('internal', VISIBILITY.HIDDEN),
    'damage-buff': entry('buff', VISIBILITY.DETAIL, { iconId: 'empowered', assetPath: 'images/effect-icons/empowered.svg', label: '强化' }),
    'damage-multiplier': entry('buff', VISIBILITY.DETAIL, { iconId: 'damage-multiplier', assetPath: 'images/effect-icons/damage-multiplier.svg', label: '飞天御剑流' }),
    'deployment-first-move-free': entry('buff', VISIBILITY.DETAIL, { iconId: 'free-move', assetPath: 'images/effect-icons/free-move.svg', label: '首次移动免费' }),
    'demon-strike-charges': entry('charge', VISIBILITY.DETAIL),
    'divine-shield': entry('shield', VISIBILITY.DETAIL, { iconId: 'divine-shield', assetPath: 'images/effect-icons/divine-shield.svg', label: '圣盾' }),
    'elune-protection': entry('shield', VISIBILITY.DETAIL, { iconId: 'ward', assetPath: 'images/effect-icons/ward.svg', label: '艾露恩庇护' }),
    'flying-raijin-mark': entry('mark', VISIBILITY.DETAIL, { iconId: 'flying-raijin-mark', assetPath: 'images/tile-effects/flying-raijin-anchor.svg', label: '飞雷神印记' }),
    freeze: entry('control', VISIBILITY.BOARD, { iconId: 'freeze', assetPath: 'images/tile-effects/blizzard.svg', label: '冰冻', priority: 500 }),
    'hardy-block': entry('shield', VISIBILITY.DETAIL),
    'hidan-dying': entry('revive', VISIBILITY.BOARD, { iconId: 'dying', assetPath: 'images/effect-icons/dying.svg', label: '濒死', color: '#fb7185', tone: 'danger', negative: true, priority: 480 }),
    'hidan-undying-used': entry('internal', VISIBILITY.HIDDEN),
    'icebound-fortitude': entry('shield', VISIBILITY.DETAIL),
    'ichigo-bankai': entry('transformation', VISIBILITY.DETAIL),
    imprisoned: entry('control', VISIBILITY.BOARD, { iconId: 'imprisoned', assetPath: 'images/effect-icons/imprisoned.svg', label: '禁锢', priority: 360 }),
    'itachi-tsukuyomi': entry('curse', VISIBILITY.BOARD, { label: '月读', priority: 400 }),
    'kamui-shield': entry('shield', VISIBILITY.DETAIL),
    'lethal-toxin': entry('damage-over-time', VISIBILITY.BOARD, { iconId: 'lethal-toxin', assetPath: 'images/tile-effects/lethal-toxin.svg', label: '致命毒素', priority: 240 }),
    'lich-covenant': entry('revive', VISIBILITY.DETAIL),
    'nano-boost': entry('buff', VISIBILITY.DETAIL),
    'obito-grudge': entry('counter', VISIBILITY.DETAIL),
    'rafaam-temporal-distortion': entry('time', VISIBILITY.DETAIL, { label: '时空扭曲' }),
    'rage-stance': entry('stance', VISIBILITY.DETAIL),
    resurreccion: entry('transformation', VISIBILITY.DETAIL, { iconId: 'resurreccion', assetPath: 'images/effect-icons/resurreccion.svg', label: '归刃' }),
    'sage-mode': entry('transformation', VISIBILITY.DETAIL),
    'sage-mode-shield': entry('shield', VISIBILITY.DETAIL),
    'shadow-step': entry('buff', VISIBILITY.DETAIL, { iconId: 'shadow-step', assetPath: 'images/tile-effects/shadow-step.svg', label: '暗影步' }),
    'shishio-cooldown-fired': entry('internal', VISIBILITY.HIDDEN),
    'shishio-dmg-counter': entry('internal', VISIBILITY.HIDDEN),
    'shishio-kills': entry('counter', VISIBILITY.DETAIL),
    silenced: entry('disable', VISIBILITY.BOARD, { iconId: 'silence', label: '沉默', priority: 450 }),
    sleep: entry('control', VISIBILITY.BOARD, { iconId: 'sleep', assetPath: 'images/effect-icons/sleep.svg', label: '睡眠', color: '#e879f9', priority: 510 }),
    'susanoo-active': entry('transformation', VISIBILITY.DETAIL),
    'undead-body': entry('revive', VISIBILITY.DETAIL),
    'velen-fate-shelter': entry('shield', VISIBILITY.DETAIL),
    'venom-corrosion-immobile': entry('control', VISIBILITY.BOARD, { label: '腐蚀定身' }),
  })

  // Every player-meaningful status has a battlefield entry. The renderer
  // controls density with two icon slots plus an overflow disclosure; only
  // bookkeeping markers remain hidden.
  const statusRegistry = Object.freeze(Object.keys(statusDefinitions).reduce(function (registry, type) {
    const definition = statusDefinitions[type]
    registry[type] = definition.visibility === VISIBILITY.HIDDEN
      ? definition
      : Object.freeze(Object.assign({}, definition, { visibility: VISIBILITY.BOARD }))
    return registry
  }, {}))

  const actionRegistry = Object.freeze({
    'action-move': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-move.svg', label: '移动' }),
    'action-deploy': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-deploy.svg', label: '部署' }),
    'action-skill': entry('transformation', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-skill.svg', label: '使用技能' }),
    'action-charge-skill': entry('charge', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-charge-skill.svg', label: '使用充能技能' }),
    'action-card': entry('buff', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-play-card.svg', label: '使用卡牌' }),
    'action-end-turn': entry('time', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-end-turn.svg', label: '结束回合' }),
    'action-automatic': entry('time', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-change.svg', label: '自动结算' }),
    'action-choice': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-choice.svg', label: '选择' }),
    'action-passive': entry('time', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-change.svg', label: '触发' }),
    'action-block': entry('shield', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-block.svg', label: '阻止' }),
    'action-damage': entry('damage-over-time', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-damage.svg', label: '造成伤害' }),
    'action-heal': entry('revive', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-heal.svg', label: '恢复生命' }),
    'action-force-move': entry('control', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-force-move.svg', label: '强制位移' }),
    'action-spawn': entry('revive', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-spawn.svg', label: '生成' }),
    'action-death': entry('revive', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-death.svg', label: '死亡', color: '#fb7185', tone: 'danger' }),
    'action-eliminated': entry('revive', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-eliminate.svg', label: '出局', color: '#fb7185', tone: 'danger' }),
    'action-action-points': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-action-points.svg', label: '行动点变化' }),
    'action-charge-points': entry('charge', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-charge-points.svg', label: '充能点变化' }),
    'action-card-gain': entry('buff', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-card-gain.svg', label: '获得手牌' }),
    'action-card-discard': entry('curse', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-card-discard.svg', label: '弃置手牌' }),
    'action-card-change': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-card-change.svg', label: '手牌信息变化' }),
    'action-tile-change': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-change.svg', label: '地格变化' }),
    'action-tile-effect-add': entry('buff', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-add.svg', label: '添加地格效果' }),
    'action-tile-effect-remove': entry('unknown', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-remove.svg', label: '移除地格效果' }),
    'action-stat-change': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-change.svg', label: '属性变化' }),
    'action-redirect': entry('mark', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-redirect.svg', label: '改换目标' }),
    'status-add': entry('buff', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-add.svg', label: '添加状态' }),
    'status-remove': entry('unknown', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/verb-remove.svg', label: '移除状态' }),
    'result-hidden': entry('unknown', VISIBILITY.DETAIL, { assetPath: 'images/effect-icons/complement-hidden.svg', label: '结果保密' }),
  })

  const statusFallback = entry('unknown', VISIBILITY.BOARD)
  const actionFallback = entry('unknown', VISIBILITY.DETAIL)
  const forcedHidden = entry('internal', VISIBILITY.HIDDEN)

  function statusType(status) {
    if (typeof status === 'string') return status
    return String(status && (status.type || status.id || status.name) || '')
  }

  function resolveStatusType(type) {
    return statusRegistry[String(type || '')] || statusFallback
  }

  function resolveStatus(status) {
    if (status && typeof status === 'object' && status.visible === false) return forcedHidden
    return resolveStatusType(statusType(status))
  }

  function resolveAction(iconId) {
    const key = String(iconId || '')
    const resolved = actionRegistry[key]
    return resolved ? Object.assign({}, resolved, { iconId: key }) : actionFallback
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
