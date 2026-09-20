(function (root) {
  'use strict'

  const STORAGE_KEY = 'rvb_piece_deck_presets'
  const SCHEMA_VERSION = 1
  const PIECE_ROLES = Object.freeze({
    ana: '治疗 / 控制', anduin: '治疗 / 辅助', 'blue-ichigo': '输出 / 机动',
    'blue-kenshin': '输出 / 机动', 'blue-minato': '机动 / 控制', 'blue-naruto': '输出 / 辅助',
    'blue-tirion-fordring': '输出 / 辅助', 'blue-watcher': '输出 / 控制',
    'hashirama-edo': '控制 / 辅助', jaina: '输出 / 控制', liadrin: '治疗 / 辅助',
    tracer: '输出 / 机动', turalyon: '辅助 / 机动', tyrande: '辅助 / 治疗',
    sonic: '输出 / 机动', tails: '辅助 / 机动', uther: '辅助 / 治疗', velen: '治疗 / 辅助',
    arthas: '输出 / 控制', 'dark-aizen': '控制 / 输出', 'dark-grimmjow': '输出 / 机动',
    'dark-ulquiorra': '输出 / 治疗', guldan: '输出 / 辅助', kiljaedan: '输出 / 控制',
    reaper: '输出 / 机动', 'red-blackwidow': '输出 / 控制',
    'red-doomsday-fist': '输出 / 机动', 'red-hidan': '输出 / 辅助',
    'red-illidan': '输出 / 机动', 'red-itachi': '控制 / 输出',
    'red-obito': '控制 / 机动', 'red-rafaam': '控制 / 辅助',
    'red-sasuke': '输出 / 控制', 'red-shishio': '输出 / 辅助',
    'red-venom': '控制 / 机动', shadow: '输出 / 机动',
    shelly: '输出 / 控制', max: '输出 / 辅助',
    'el-primo': '输出 / 辅助', colt: '输出 / 控制',
    edgar: '输出 / 机动', mortis: '输出 / 机动',
    alfonso: '输出 / 控制'
  })
  const RECOMMENDED_PRESETS = Object.freeze([
    Object.freeze({
      id: 'recommended-good-steady', name: '光方 · 1.0.10 新手均衡', alignment: 'good',
      pieceIds: Object.freeze(['uther', 'anduin', 'blue-tirion-fordring', 'jaina', 'ana', 'shelly', 'el-primo', 'max']),
      style: '前排稳住，远程输出，机动收尾',
      opening: '先用乌瑟尔和艾尔·普里莫站住前线，安度因保持治疗距离；雪莉和吉安娜从侧后方制造压力。',
      pairing: '乌瑟尔和艾尔·普里莫负责前线；安度因和安娜负责治疗与辅助；雪莉、提里奥和吉安娜负责输出与控制；麦克斯负责机动支援。',
      replacement: '想提高机动收割，可用猎空替换提里奥；想提高远程压制，可用柯尔特替换提里奥。'
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
      pieceIds: Object.freeze(['arthas', 'reaper', 'red-blackwidow', 'red-doomsday-fist', 'red-illidan', 'red-venom', 'edgar', 'guldan']),
      style: '控制入口，输出追击，机动收割',
      opening: '阿尔萨斯和末日铁拳先控制入口，黑百合和古尔丹从后方输出；伊利丹、毒液和艾德加等待缺口再突进。',
      pairing: '阿尔萨斯与毒液提供控制，死神、伊利丹和艾德加负责机动输出，黑百合、古尔丹和末日铁拳补足持续火力。',
      replacement: '想增加持续作战，可用乌尔奇奥拉替换艾德加；想增加范围控制，可用拉法姆替换古尔丹。'
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
