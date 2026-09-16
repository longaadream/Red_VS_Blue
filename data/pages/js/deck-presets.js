(function (root) {
  'use strict'

  const STORAGE_KEY = 'rvb_piece_deck_presets'
  const SCHEMA_VERSION = 1
  const PIECE_ROLES = Object.freeze({
    ana: '远程治疗 / 控制', anduin: '群体治疗 / 保护', 'blue-ichigo': '近战爆发 / 追击',
    'blue-kenshin': '机动刺客 / 终结', 'blue-minato': '传送突进 / 标记', 'blue-naruto': '近程爆发 / 分身',
    'blue-tirion-fordring': '前排战士 / 真实伤害', 'blue-watcher': '姿态战士 / 应变',
    'hashirama-edo': '范围控制 / 支援', jaina: '范围法师 / 控制', liadrin: '圣光成长 / 群体恢复',
    tracer: '机动射手 / 骚扰', turalyon: '团队支援 / 协同移动', tyrande: '远程支援 / 圣光强化',
    sonic: '高速突进 / 收割', tails: '机动支援 / 位移救援', uther: '前排保护 / 增益', velen: '延迟治疗 / 预判',
    arthas: '前排控制 / 复生', 'dark-aizen': '幻术控制 / 压制', 'dark-grimmjow': '追猎战士 / 多段攻击',
    'dark-ulquiorra': '持续作战 / 再生', guldan: '远程法师 / 灵魂资源', kiljaedan: '后期法师 / 斩杀',
    reaper: '近战刺客 / 自我恢复', 'red-blackwidow': '远程狙击 / 持续伤害',
    'red-doomsday-fist': '突进战士 / 范围攻击', 'red-hidan': '反伤战士 / 诅咒',
    'red-illidan': '机动战士 / 持续输出', 'red-itachi': '技能控制 / 地格压制',
    'red-obito': '位移控制 / 阵型重塑', 'red-rafaam': '诅咒法师 / 时间控制',
    'red-sasuke': '成长输出 / 地格压制', 'red-shishio': '近战爆发 / 自损',
    'red-venom': '位移控制 / 定身', shadow: '爆发刺客 / 时空操控'
  })
  const RECOMMENDED_PRESETS = Object.freeze([
    Object.freeze({
      id: 'recommended-good-steady', name: '光方 · 稳健入门', alignment: 'good',
      pieceIds: Object.freeze(['turalyon', 'uther', 'anduin', 'ana', 'jaina', 'blue-tirion-fordring', 'velen', 'blue-naruto']),
      style: '保护核心，稳步换血',
      opening: '鸣人作为先遣先占安全位置，再用前排接应；治疗与法师留在后方维持阵线。',
      pairing: '图拉扬、乌瑟尔负责保护；安度因、安娜和维伦维持队伍；吉安娜与鸣人完成输出。',
      replacement: '想提高机动性，可用索尼克或猎空替换一名治疗或前排。'
    }),
    Object.freeze({
      id: 'recommended-good-mobile', name: '光方 · 机动突击', alignment: 'good',
      pieceIds: Object.freeze(['sonic', 'tails', 'tracer', 'blue-minato', 'blue-kenshin', 'blue-ichigo', 'tyrande', 'hashirama-edo']),
      style: '快速转线，集中突破',
      opening: '先确认一条安全推进线，再让高速棋子集中攻击同一目标。',
      pairing: '索尼克、猎空与水门负责转线；剑心、一护承担近身输出；泰兰德和柱间补控制与支援。',
      replacement: '容易减员时，可用乌瑟尔、安娜或维伦替换一名突击棋子。'
    }),
    Object.freeze({
      id: 'recommended-evil-pressure', name: '暗方 · 压制入门', alignment: 'evil',
      pieceIds: Object.freeze(['arthas', 'guldan', 'kiljaedan', 'red-rafaam', 'red-blackwidow', 'red-doomsday-fist', 'red-illidan', 'red-venom']),
      style: '正面压制，持续消耗',
      opening: '用前排封住主要通路，远程角色从安全位置持续制造压力。',
      pairing: '阿尔萨斯、末日铁拳和伊利丹顶住前线；古尔丹、基尔加丹、拉法姆与黑百合提供远程压制。',
      replacement: '需要更强追击时，可用夏特、葛力姆乔或死神替换一名远程棋子。'
    }),
    Object.freeze({
      id: 'recommended-evil-hunt', name: '暗方 · 高速追猎', alignment: 'evil',
      pieceIds: Object.freeze(['shadow', 'dark-aizen', 'dark-grimmjow', 'dark-ulquiorra', 'red-obito', 'red-itachi', 'red-sasuke', 'reaper']),
      style: '控制落点，追击后排',
      opening: '不要平均分散伤害，先用控制创造缺口，再集中处理一枚关键棋子。',
      pairing: '蓝染、带土和鼬负责干扰；夏特、葛力姆乔、乌尔奇奥拉、佐助与死神完成追击。',
      replacement: '正面承伤不足时，可用阿尔萨斯或伊利丹替换一名追击棋子。'
    })
  ])

  function emptyStore() {
    return { version: SCHEMA_VERSION, presets: [] }
  }

  function normalizePreset(preset) {
    if (!preset || typeof preset !== 'object') return null
    const id = typeof preset.id === 'string' ? preset.id.trim() : ''
    const name = typeof preset.name === 'string' ? preset.name.trim().slice(0, 24) : ''
    const alignment = preset.alignment
    const pieceIds = Array.isArray(preset.pieceIds)
      ? preset.pieceIds.filter(function (pieceId) { return typeof pieceId === 'string' && pieceId.length > 0 })
      : []
    if (!id || !name || (alignment !== 'good' && alignment !== 'evil')) return null
    if (pieceIds.length !== 8 || new Set(pieceIds).size !== 8) return null
    return {
      id: id,
      name: name,
      alignment: alignment,
      pieceIds: pieceIds.slice(),
      updatedAt: Number.isFinite(preset.updatedAt) ? preset.updatedAt : 0
    }
  }

  function parse(raw) {
    try {
      const value = JSON.parse(raw || 'null')
      if (!value || value.version !== SCHEMA_VERSION || !Array.isArray(value.presets)) return emptyStore()
      return {
        version: SCHEMA_VERSION,
        presets: value.presets.map(normalizePreset).filter(Boolean)
      }
    } catch {
      return emptyStore()
    }
  }

  function serialize(store) {
    const presets = Array.isArray(store && store.presets)
      ? store.presets.map(normalizePreset).filter(Boolean)
      : []
    return JSON.stringify({ version: SCHEMA_VERSION, presets: presets })
  }

  function upsert(store, input) {
    const preset = normalizePreset(input)
    if (!preset) throw new Error('Invalid deck preset')
    const next = parse(serialize(store))
    const index = next.presets.findIndex(function (entry) { return entry.id === preset.id })
    if (index === -1) next.presets.push(preset)
    else next.presets[index] = preset
    return next
  }

  function remove(store, id) {
    const next = parse(serialize(store))
    next.presets = next.presets.filter(function (entry) { return entry.id !== id })
    return next
  }

  function isValidSelection(pieceIds, alignment, pieces) {
    if (alignment !== 'good' && alignment !== 'evil') return false
    if (!Array.isArray(pieceIds) || pieceIds.length !== 8 || new Set(pieceIds).size !== 8) return false
    if (!Array.isArray(pieces)) return false
    const factionById = new Map(pieces.map(function (piece) { return [piece && piece.id, piece && piece.faction] }))
    return pieceIds.every(function (pieceId) { return factionById.get(pieceId) === alignment })
  }

  function recommended(alignment, pieces) {
    return RECOMMENDED_PRESETS.filter(function (preset) {
      return preset.alignment === alignment
    }).map(function (preset) {
      const available = !Array.isArray(pieces) || isValidSelection(preset.pieceIds, alignment, pieces)
      return Object.assign({}, preset, { pieceIds: preset.pieceIds.slice(), available: available })
    })
  }

  function roleFor(piece) {
    if (!piece || typeof piece !== 'object') return ''
    return PIECE_ROLES[piece.id] || String(piece.description || '').split(/[。；]/)[0].slice(0, 18)
  }

  root.RvBDeckPresets = Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    emptyStore: emptyStore,
    parse: parse,
    serialize: serialize,
    upsert: upsert,
    remove: remove,
    isValidSelection: isValidSelection,
    recommended: recommended,
    roleFor: roleFor
  })
})(typeof window !== 'undefined' ? window : globalThis)
