(function (root) {
  'use strict'

  const MISSING = {}
  const RESERVED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
  const PATH_SEGMENT = /^[\p{L}\p{N}_$-]+$/u
  const MAX_EVALUATION_STEPS = 256
  const MAX_EVALUATION_DEPTH = 32
  const MAX_RESULT_TEXT_LENGTH = 4096
  // A description can contain many independent placeholders.  Keep the
  // aggregate work bounded as well as each expression so malformed content
  // cannot monopolise a render callback.
  const MAX_TEMPLATE_COUNT = 256
  const MAX_TOTAL_EVALUATION_STEPS = 4096
  const NO_PARSER = {}

  // These names mirror the registered pure gameplay modules.  The renderer
  // never invokes a module or a value supplied by content; it only maps this
  // allowlist to the corresponding total, side-effect-free operation.
  const PURE_FUNCTIONS = Object.freeze({
    'math.add': { names: ['left', 'right'], arity: 2 },
    'math.subtract': { names: ['left', 'right'], arity: 2 },
    'math.multiply': { names: ['left', 'right'], arity: 2 },
    'math.divide': { names: ['left', 'right'], arity: 2 },
    'math.modulo': { names: ['left', 'right'], arity: 2 },
    'math.power': { names: ['left', 'right'], arity: 2 },
    'math.floor': { names: ['value'], arity: 1 },
    'math.abs': { names: ['value'], arity: 1 },
    'math.min': { names: ['left', 'right'], arity: 2 },
    'math.max': { names: ['left', 'right'], arity: 2 },
  })
  const PURE_FUNCTION_ALIASES = Object.freeze({
    floor: 'math.floor',
    向下取整: 'math.floor',
    绝对值: 'math.abs',
    最小值: 'math.min',
    最大值: 'math.max',
  })

  // Descriptions can be rendered with a read-only snapshot context.  These
  // aliases keep the author-facing Chinese field names separate from the
  // runtime JSON names without evaluating arbitrary JavaScript.
  const ROOT_ALIASES = Object.freeze({
    '当前棋子': ['piece', 'currentPiece'],
    '本棋子': ['piece', 'currentPiece'],
    '棋子': ['piece', 'currentPiece'],
    '当前手牌': ['card', 'handCard', 'currentCard'],
    '手牌': ['card', 'handCard', 'currentCard'],
    '当前技能': ['skillInstance', 'currentSkill', 'skill'],
    '技能': ['skill', 'skillInstance', 'currentSkill'],
    '当前规则': ['ruleInstance', 'currentRule', 'rule'],
    '规则': ['rule', 'ruleInstance', 'currentRule'],
    '当前状态': ['statusInstance', 'currentStatus', 'status'],
    '状态': ['status', 'statusInstance', 'currentStatus'],
    '当前玩家': ['player', 'currentPlayer'],
    '玩家': ['player', 'currentPlayer'],
    '当前对局': ['snapshot', 'state', 'battle'],
    '对局': ['snapshot', 'state', 'battle'],
    '当前事件': ['event'],
    '全局': ['global', 'snapshot', 'state'],
    '每项': ['item'],
    piece: ['piece', 'currentPiece'],
    currentPiece: ['currentPiece', 'piece'],
    card: ['card', 'handCard', 'currentCard'],
    handCard: ['handCard', 'card', 'currentCard'],
    currentCard: ['currentCard', 'card', 'handCard'],
    skill: ['skill', 'skillInstance', 'currentSkill'],
    skillInstance: ['skillInstance', 'currentSkill', 'skill'],
    currentSkill: ['currentSkill', 'skillInstance', 'skill'],
    player: ['player', 'currentPlayer'],
    currentPlayer: ['currentPlayer', 'player'],
    snapshot: ['snapshot', 'state', 'battle'],
    state: ['state', 'snapshot', 'battle'],
    battle: ['battle', 'snapshot', 'state'],
    rule: ['rule', 'ruleInstance', 'currentRule'],
    ruleInstance: ['ruleInstance', 'currentRule', 'rule'],
    status: ['status', 'statusInstance', 'currentStatus'],
    statusInstance: ['statusInstance', 'currentStatus', 'status'],
    event: ['event'],
    global: ['global', 'snapshot', 'state'],
    item: ['item'],
  })

  const FIELD_ALIASES = Object.freeze({
    '扩展变量': ['extension'],
    '扩展字段': ['extension'],
    '扩展数据': ['extension'],
    扩展: ['extension'],
    '攻击力': ['attack', 'displayAttack'],
    '防御力': ['defense', 'displayDefense'],
    '移动范围': ['moveRange', 'displayMoveRange'],
    '生命值': ['currentHp', 'displayCurrentHp'],
    '当前生命': ['currentHp', 'displayCurrentHp'],
    '当前生命值': ['currentHp', 'displayCurrentHp'],
    '生命上限': ['maxHp', 'displayMaxHp'],
    '最大生命值': ['maxHp', 'displayMaxHp'],
    '当前冷却': ['currentCooldown'],
    冷却: ['currentCooldown', 'cooldownTurns'],
    '基础冷却': ['cooldownTurns'],
    '行动点消耗': ['actionPointCost'],
    '充能点消耗': ['chargeCost'],
    '剩余次数': ['usesRemaining'],
    '技能编号': ['skillId', 'id', 'definitionId'],
    编号: ['turnNumber', 'number', 'id'],
    回合: ['turn', 'turnNumber'],
    '所属玩家': ['ownerPlayerId'],
    名称: ['name'],
    描述: ['description'],
  })

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    })
  }

  function hasOwn(value, key) {
    return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
  }

  function readOwn(value, key) {
    if (!hasOwn(value, key) || RESERVED_PATH_SEGMENTS.has(key)) return MISSING
    try {
      // Descriptor reads keep a malicious or malformed snapshot getter from
      // executing during a description render.
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return MISSING
      const result = descriptor.value
      return result === undefined ? MISSING : result
    } catch {
      return MISSING
    }
  }

  function primitive(value) {
    return typeof value === 'string'
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
  }

  function fieldCandidates(segment) {
    const aliases = hasOwn(FIELD_ALIASES, segment) ? FIELD_ALIASES[segment] : []
    return [segment].concat(aliases.filter(function (name) { return name !== segment }))
  }

  function readSegment(value, segment) {
    if (value === null || typeof value !== 'object') return MISSING
    const candidates = fieldCandidates(segment)
    for (const candidate of candidates) {
      const direct = readOwn(value, candidate)
      if (direct !== MISSING) return direct
    }
    // Piece attributes are stored under stats in authoritative snapshots but
    // are also flattened on a few display records.  This fallback only reads
    // the supplied record; it never derives a value by running a rule.
    const stats = readOwn(value, 'stats')
    if (stats !== MISSING && stats !== null && typeof stats === 'object') {
      for (const candidate of candidates) {
        const nested = readOwn(stats, candidate)
        if (nested !== MISSING) return nested
      }
    }
    return MISSING
  }

  function pathSegments(expression) {
    const segments = String(expression || '').trim().split('.').map(function (segment) { return segment.trim() })
    if (!segments.length || segments.some(function (segment) { return !segment || !PATH_SEGMENT.test(segment) })) return null
    return segments
  }

  function readPath(value, segments) {
    let current = value
    for (const segment of segments) {
      current = readSegment(current, segment)
      if (current === MISSING) return MISSING
    }
    return current
  }

  function contextMaps(context) {
    if (!context || typeof context !== 'object') return []
    const maps = [context]
    for (const key of ['values', 'variables', 'expressionValues', 'bindings', 'locals']) {
      const value = readOwn(context, key)
      if (value !== MISSING && value !== null && typeof value === 'object' && !maps.includes(value)) maps.push(value)
    }
    return maps
  }

  function copyDataRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const copy = {}
    for (const key of Object.keys(value)) {
      const item = readOwn(value, key)
      if (item !== MISSING) copy[key] = item
    }
    return copy
  }

  function unwrapFlowStateValue(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const format = readOwn(value, 'format')
    if (format !== 'author-extension-value/v1') return value
    const wrapped = readOwn(value, 'value')
    return wrapped === MISSING ? MISSING : wrapped
  }

  function flowStateRecords(snapshot) {
    const extensions = readOwn(snapshot, 'extensions')
    if (extensions === MISSING || extensions === null || typeof extensions !== 'object') return []
    const records = readOwn(extensions, 'flowState')
    return Array.isArray(records) ? records : []
  }

  function projectionEntityKey(scope, entityIdValue) {
    return String(scope) + '\u0000' + String(entityIdValue)
  }

  function consumeProjectionBudget(state) {
    if (!state || !Number.isFinite(state.totalLimit)) return true
    if (state.total >= state.totalLimit) {
      state.budgetExceeded = true
      state.projectionBudgetExceeded = true
      return false
    }
    state.total += 1
    return true
  }

  function activePieceIds(snapshot, state) {
    const active = new Set()
    const pieces = readOwn(snapshot, 'pieces')
    if (!Array.isArray(pieces)) return active
    for (let index = 0; index < pieces.length; index += 1) {
      if (!consumeProjectionBudget(state)) break
      const piece = readOwn(pieces, String(index))
      if (piece === MISSING || piece === null || typeof piece !== 'object') continue
      const id = entityId(piece, ['instanceId'])
      const currentHp = readSegment(piece, 'currentHp')
      if (id !== MISSING && typeof currentHp === 'number' && currentHp > 0) active.add(id)
    }
    return active
  }

  // Build the flow-state lookup once per rendered description.  The old path
  // scanned every record for every placeholder and then scanned all pieces
  // again for each while-alive record, which made a repeated template freeze
  // on a large snapshot.  Values remain read-only; this is only an index.
  function createProjectionIndex(snapshot, state) {
    const records = flowStateRecords(snapshot)
    const byEntity = new Map()
    let active = null
    for (let index = 0; index < records.length; index += 1) {
      if (!consumeProjectionBudget(state)) break
      const record = readOwn(records, String(index))
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue
      const lifetime = readOwn(record, 'lifetime')
      const scope = readOwn(record, 'scope')
      const recordEntityId = readOwn(record, 'entityId')
      // The runtime only permits while-alive records for live pieces.  A
      // malformed or stale record is projected as absent.
      // Delay the piece scan until the first while-alive record.  This keeps
      // snapshots containing only battle/player values cheap and ensures the
      // scan itself consumes the same projection budget as every other read.
      if (lifetime === 'while-alive') {
        if (!active) active = activePieceIds(snapshot, state)
        if (scope !== 'piece' || !active.has(recordEntityId)) continue
      }
      if (readOwn(record, 'schemaVersion') !== 1
        || (typeof scope !== 'string')
        || (typeof recordEntityId !== 'string')
        || !recordEntityId
        || readOwn(record, 'namespace') !== 'content') continue
      const name = readOwn(record, 'name')
      if (typeof name !== 'string' || !name || RESERVED_PATH_SEGMENTS.has(name)) continue
      const key = projectionEntityKey(scope, recordEntityId)
      const entry = byEntity.get(key) || { values: {}, seen: new Set(), duplicate: false }
      if (entry.seen.has(name)) {
        entry.duplicate = true
      } else {
        entry.seen.add(name)
        const value = unwrapFlowStateValue(readOwn(record, 'value'))
        if (value !== MISSING) entry.values[name] = value
      }
      byEntity.set(key, entry)
    }
    return { snapshot: snapshot, byEntity: byEntity, entityCache: new Map() }
  }

  function flowExtensions(snapshot, scope, entityIdValue, projection) {
    if (!snapshot || typeof snapshot !== 'object' || typeof entityIdValue !== 'string' || !entityIdValue) return MISSING
    const index = projection && projection.snapshot === snapshot ? projection : createProjectionIndex(snapshot, null)
    const entry = index.byEntity.get(projectionEntityKey(scope, entityIdValue))
    if (!entry || entry.duplicate || !Object.keys(entry.values).length) return MISSING
    return entry.values
  }

  function mergeProjectedExtension(entity, projected) {
    if (projected === MISSING) return readOwn(entity, 'extension')
    const existing = readOwn(entity, 'extension')
    const merged = existing !== MISSING && existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? copyDataRecord(existing)
      : {}
    for (const [key, value] of Object.entries(projected)) merged[key] = value
    return merged
  }

  function projectEntity(entity, snapshot, scope, entityIdValue, projection, state) {
    if (entity === MISSING || entity === null || typeof entity !== 'object' || Array.isArray(entity)) return entity
    const cacheKey = projection ? projectionEntityKey(scope, entityIdValue) : null
    if (projection && projection.entityCache.has(cacheKey)) return projection.entityCache.get(cacheKey)
    if (!consumeProjectionBudget(state)) return MISSING
    const projected = flowExtensions(snapshot, scope, entityIdValue, projection)
    const copy = copyDataRecord(entity)
    if (scope === 'piece' || scope === 'player') {
      // These hosts use the versioned flowState table.  A raw extension field
      // on a snapshot is not a second source of private author state.
      delete copy.extension
      if (projected !== MISSING) copy.extension = projected
    } else if (projected !== MISSING) copy.extension = mergeProjectedExtension(entity, projected)
    if (projection) projection.entityCache.set(cacheKey, copy)
    return copy
  }

  function entityId(value, fields) {
    if (!value || typeof value !== 'object') return MISSING
    for (const field of fields) {
      const result = readOwn(value, field)
      if (typeof result === 'string' && result) return result
    }
    return MISSING
  }

  function projectEntityArray(values, snapshot, scope, projection, state) {
    if (!Array.isArray(values)) return values
    const copy = []
    for (let index = 0; index < values.length; index += 1) {
      if (!consumeProjectionBudget(state)) return MISSING
      const value = readOwn(values, String(index))
      if (value === MISSING) return MISSING
      const id = scope === 'piece'
        ? entityId(value, ['instanceId'])
        : entityId(value, ['playerId', 'id'])
      copy.push(id === MISSING ? value : projectEntity(value, snapshot, scope, id, projection, state))
    }
    return copy
  }

  function projectSnapshot(snapshot, projection, state) {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot
    const copy = copyDataRecord(snapshot)
    const rawExtensions = readOwn(snapshot, 'extensions')
    if (rawExtensions !== MISSING && rawExtensions !== null && typeof rawExtensions === 'object' && !Array.isArray(rawExtensions)) {
      const safeExtensions = copyDataRecord(rawExtensions)
      // flowState is an internal table.  Descriptions can only see the exact
      // owner/name projection below, never the private source records.
      delete safeExtensions.flowState
      copy.extensions = safeExtensions
    }
    const battleProjection = flowExtensions(snapshot, 'battle', 'battle', projection)
    delete copy.extension
    if (battleProjection !== MISSING) copy.extension = battleProjection
    const pieces = projectEntityArray(readOwn(snapshot, 'pieces'), snapshot, 'piece', projection, state)
    const players = projectEntityArray(readOwn(snapshot, 'players'), snapshot, 'player', projection, state)
    if (pieces !== MISSING) copy.pieces = pieces
    if (players !== MISSING) copy.players = players
    return copy
  }

  function findEntity(values, fields, wanted) {
    if (!Array.isArray(values) || typeof wanted !== 'string') return MISSING
    for (let index = 0; index < values.length; index += 1) {
      const value = readOwn(values, String(index))
      if (value === MISSING || value === null || typeof value !== 'object') continue
      if (entityId(value, fields) === wanted) return value
    }
    return MISSING
  }

  // Build a read-only view over the serialized snapshot.  This is the only
  // place where piece/player/battle flowState records enter descriptions.
  function projectContext(context, state) {
    if (!context || typeof context !== 'object') return context
    const sourceSnapshot = readOwn(context, 'snapshot')
    const stateSnapshot = readOwn(context, 'state')
    const battleSnapshot = readOwn(context, 'battle')
    const snapshot = sourceSnapshot !== MISSING ? sourceSnapshot
      : stateSnapshot !== MISSING ? stateSnapshot
        : battleSnapshot !== MISSING ? battleSnapshot : MISSING
    if (snapshot === MISSING || snapshot === null || typeof snapshot !== 'object') return context

    const projection = createProjectionIndex(snapshot, state)
    const projectedSnapshot = projectSnapshot(snapshot, projection, state)
    const copy = copyDataRecord(context)
    copy.snapshot = projectedSnapshot
    if (stateSnapshot !== MISSING) copy.state = projectedSnapshot
    if (battleSnapshot !== MISSING) copy.battle = projectedSnapshot

    let piece = readOwn(context, 'piece')
    if (piece === MISSING) piece = readOwn(context, 'currentPiece')
    let card = readOwn(context, 'card')
    if (card === MISSING) card = readOwn(context, 'handCard')
    if (card === MISSING) card = readOwn(context, 'currentCard')
    let player = readOwn(context, 'player')
    if (player === MISSING) player = readOwn(context, 'currentPlayer')
    if (piece === MISSING) {
      const pieceId = entityId(readOwn(context, 'pieceReference'), ['instanceId', 'pieceInstanceId'])
      if (pieceId !== MISSING) piece = findEntity(readOwn(snapshot, 'pieces'), ['instanceId'], pieceId)
    }
    if (piece !== MISSING) {
      const pieceId = entityId(piece, ['instanceId'])
      if (pieceId !== MISSING) {
        copy.piece = projectEntity(piece, snapshot, 'piece', pieceId, projection, state)
        if (readOwn(context, 'currentPiece') !== MISSING) copy.currentPiece = copy.piece
      }
    }

    let currentPlayer = player
    if (currentPlayer === MISSING && card !== MISSING) {
      const ownerId = entityId(card, ['ownerPlayerId', 'playerId'])
      if (ownerId !== MISSING) currentPlayer = findEntity(readOwn(snapshot, 'players'), ['playerId', 'id'], ownerId)
    }
    if (currentPlayer === MISSING && piece !== MISSING) {
      const ownerId = entityId(piece, ['ownerPlayerId', 'playerId'])
      if (ownerId !== MISSING) currentPlayer = findEntity(readOwn(snapshot, 'players'), ['playerId', 'id'], ownerId)
    }
    if (currentPlayer !== MISSING) {
      const playerId = entityId(currentPlayer, ['playerId', 'id'])
      if (playerId !== MISSING) {
        copy.player = projectEntity(currentPlayer, snapshot, 'player', playerId, projection, state)
        if (readOwn(context, 'currentPlayer') !== MISSING) copy.currentPlayer = copy.player
      }
    }
    return copy
  }

  function authorExpressionParser() {
    const bundled = root.RvBAuthorExpression && root.RvBAuthorExpression.parseAuthorExpression
    if (typeof bundled === 'function') return bundled
    const core = root.ContentGraphCore && root.ContentGraphCore.parseAuthorExpression
    return typeof core === 'function' ? core : null
  }

  function parseAuthorExpression(source) {
    const parser = authorExpressionParser()
    if (!parser) return NO_PARSER
    try { return parser(source) } catch { return MISSING }
  }

  function safeValue(value) {
    return value === null || primitive(value) || Array.isArray(value) || (value && typeof value === 'object')
  }

  function readIndex(value, index) {
    if (value === null || typeof value !== 'object' || !safeValue(index)) return MISSING
    if (typeof index === 'number') {
      if (!Number.isSafeInteger(index) || index < 1) return MISSING
      // Author tuples and arrays are one-based.  Plain records/maps retain
      // their numeric property key exactly, so `{1: value}[1]` remains a
      // lookup of the property named "1" rather than an array offset.
      return readOwn(value, String(Array.isArray(value) ? index - 1 : index))
    }
    if (typeof index !== 'string' || RESERVED_PATH_SEGMENTS.has(index)) return MISSING
    return readOwn(value, index)
  }

  function resolveIdentifier(name, context) {
    const maps = contextMaps(context)
    for (const map of maps) {
      const direct = readOwn(map, name)
      if (direct !== MISSING) return direct
    }
    for (const candidate of rootNames(name)) {
      for (const map of maps) {
        const direct = readOwn(map, candidate)
        if (direct !== MISSING) return direct
      }
    }
    for (const map of maps) {
      const result = readSegment(map, name)
      if (result !== MISSING) return result
    }
    return MISSING
  }

  function memberPath(node) {
    if (!node || typeof node !== 'object') return null
    if (node.kind === 'identifier') return [node.name]
    if (node.kind !== 'member') return null
    const parent = memberPath(node.object)
    return parent ? parent.concat(node.field) : null
  }

  function resolveMemberPath(path, context) {
    if (!Array.isArray(path) || path.length < 2) return MISSING
    const maps = contextMaps(context)
    for (const rootName of rootNames(path[0])) {
      for (const map of maps) {
        const rootValue = readOwn(map, rootName)
        if (rootValue === MISSING) continue
        const result = readPath(rootValue, path.slice(1))
        if (result !== MISSING) return result
      }
    }
    return MISSING
  }

  function calleeName(node) {
    if (!node || typeof node !== 'object') return null
    if (node.kind === 'identifier') return node.name
    if (node.kind !== 'member') return null
    const parent = calleeName(node.object)
    return parent ? `${parent}.${node.field}` : null
  }

  function registeredPure(moduleId) {
    const descriptor = PURE_FUNCTIONS[moduleId]
    if (!descriptor) return false
    const core = root.ContentGraphCore
    if (core && typeof core.getGameplayModule === 'function') {
      try {
        const gameplayModule = core.getGameplayModule(moduleId)
        return gameplayModule?.effects?.pure === true && gameplayModule?.effects?.previewSafe === true
      } catch { return false }
    }
    return true
  }

  function selectedArguments(node, descriptor) {
    const args = Array.isArray(node.arguments) ? node.arguments : []
    if (args.length !== descriptor.arity) return null
    const selected = new Array(descriptor.arity)
    let positional = 0
    for (const argument of args) {
      let index = -1
      if (typeof argument?.name === 'string') index = descriptor.names.indexOf(argument.name)
      else {
        while (positional < selected.length && selected[positional] !== undefined) positional += 1
        index = positional
        positional += 1
      }
      if (index < 0 || index >= selected.length || selected[index] !== undefined || !argument?.value) return null
      selected[index] = argument.value
    }
    return selected
  }

  function numberArguments(values) {
    return values.every(value => typeof value === 'number' && Number.isFinite(value))
  }

  function callPure(moduleId, values) {
    if (!registeredPure(moduleId) || !numberArguments(values)) return MISSING
    let result
    switch (moduleId) {
      case 'math.add': result = values[0] + values[1]; break
      case 'math.subtract': result = values[0] - values[1]; break
      case 'math.multiply': result = values[0] * values[1]; break
      case 'math.divide': if (values[1] === 0) return MISSING; result = values[0] / values[1]; break
      case 'math.modulo': if (values[1] === 0) return MISSING; result = values[0] % values[1]; break
      case 'math.power': result = values[0] ** values[1]; break
      case 'math.floor': result = Math.floor(values[0]); break
      case 'math.abs': result = Math.abs(values[0]); break
      case 'math.min': result = Math.min(values[0], values[1]); break
      case 'math.max': result = Math.max(values[0], values[1]); break
      default: return MISSING
    }
    return Number.isFinite(result) ? result : MISSING
  }

  function evaluateAuthorExpression(node, context, state, depth = 0) {
    if (!node || typeof node !== 'object' || depth > MAX_EVALUATION_DEPTH) return MISSING
    if (state.steps >= MAX_EVALUATION_STEPS || state.total >= state.totalLimit) {
      // Report both the per-expression and whole-description limits through
      // the same diagnostic channel.  A deeply nested expression should not
      // silently look like an ordinary missing value.
      state.budgetExceeded = true
      return MISSING
    }
    state.steps += 1
    state.total += 1
    switch (node.kind) {
      case 'literal': return safeValue(node.value) ? node.value : MISSING
      case 'identifier': return resolveIdentifier(node.name, context)
      case 'member': {
        const pathValue = resolveMemberPath(memberPath(node), context)
        if (pathValue !== MISSING) return pathValue
        const object = evaluateAuthorExpression(node.object, context, state, depth + 1)
        return object === MISSING ? MISSING : readSegment(object, node.field)
      }
      case 'index': {
        const object = evaluateAuthorExpression(node.object, context, state, depth + 1)
        const index = evaluateAuthorExpression(node.index, context, state, depth + 1)
        return object === MISSING || index === MISSING ? MISSING : readIndex(object, index)
      }
      case 'tuple': {
        if (!Array.isArray(node.items)) return MISSING
        const values = []
        for (const item of node.items) {
          const value = evaluateAuthorExpression(item, context, state, depth + 1)
          if (value === MISSING) return MISSING
          values.push(value)
        }
        return values
      }
      case 'object': {
        if (!Array.isArray(node.fields)) return MISSING
        const value = {}
        for (const field of node.fields) {
          if (!field || typeof field.name !== 'string' || RESERVED_PATH_SEGMENTS.has(field.name)) return MISSING
          const item = evaluateAuthorExpression(field.value, context, state, depth + 1)
          if (item === MISSING) return MISSING
          value[field.name] = item
        }
        return value
      }
      case 'unary': {
        const operand = evaluateAuthorExpression(node.operand, context, state, depth + 1)
        if (operand === MISSING) return MISSING
        if (node.operator === '!') return !Boolean(operand)
        if (typeof operand !== 'number' || !Number.isFinite(operand)) return MISSING
        if (node.operator === '+') return operand
        if (node.operator === '-') return -operand
        return MISSING
      }
      case 'binary': {
        const left = evaluateAuthorExpression(node.left, context, state, depth + 1)
        if (left === MISSING) return MISSING
        if (node.operator === '&&') {
          if (!Boolean(left)) return false
          const right = evaluateAuthorExpression(node.right, context, state, depth + 1)
          return right === MISSING ? MISSING : Boolean(right)
        }
        if (node.operator === '||') {
          if (Boolean(left)) return true
          const right = evaluateAuthorExpression(node.right, context, state, depth + 1)
          return right === MISSING ? MISSING : Boolean(right)
        }
        const right = evaluateAuthorExpression(node.right, context, state, depth + 1)
        if (right === MISSING) return MISSING
        if (['==', '!='].includes(node.operator)) return node.operator === '==' ? Object.is(left, right) : !Object.is(left, right)
        if (['<', '<=', '>', '>='].includes(node.operator)) {
          if (typeof left !== typeof right || !['number', 'string'].includes(typeof left)) return MISSING
          if (node.operator === '<') return left < right
          if (node.operator === '<=') return left <= right
          if (node.operator === '>') return left > right
          return left >= right
        }
        if (typeof left !== 'number' || typeof right !== 'number' || !Number.isFinite(left) || !Number.isFinite(right)) return MISSING
        return callPure({ '+': 'math.add', '-': 'math.subtract', '*': 'math.multiply', '/': 'math.divide', '%': 'math.modulo', '^': 'math.power' }[node.operator] || '', [left, right])
      }
      case 'call': {
        const name = calleeName(node.callee)
        const moduleId = PURE_FUNCTION_ALIASES[name] || name
        const descriptor = PURE_FUNCTIONS[moduleId]
        const selected = descriptor && selectedArguments(node, descriptor)
        if (!selected) return MISSING
        const values = selected.map(argument => evaluateAuthorExpression(argument, context, state, depth + 1))
        if (values.some(value => value === MISSING)) return MISSING
        return callPure(moduleId, values)
      }
      default: return MISSING
    }
  }

  function rootNames(name) {
    const aliases = hasOwn(ROOT_ALIASES, name) ? ROOT_ALIASES[name] : null
    return aliases ? [name].concat(aliases.filter(function (candidate) { return candidate !== name })) : [name]
  }

  function normalizeResolved(value) {
    return primitive(value) ? value : MISSING
  }

  function resolveInternal(expression, context, evaluationState, projectedContext) {
    const source = String(expression || '').trim()
    const state = evaluationState || {
      steps: 0,
      total: 0,
      totalLimit: MAX_TOTAL_EVALUATION_STEPS,
      budgetExceeded: false,
      projectionBudgetExceeded: false,
    }
    const safeContext = projectedContext === undefined
      ? projectContext(context, state)
      : projectedContext
    const parsed = parseAuthorExpression(source)
    if (parsed !== NO_PARSER) {
      if (parsed === MISSING) return MISSING
      const evaluated = evaluateAuthorExpression(parsed, safeContext, state)
      return normalizeResolved(evaluated)
    }

    // Keep the legacy path reader as a compatibility fallback for an older
    // page that forgot to load the small parser bundle.  Normal pages load
    // the bundle above, so authored expressions always take the AST path.
    const segments = pathSegments(source)
    if (!segments) return MISSING
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source)) return Number(source)
    if (source === 'true') return true
    if (source === 'false') return false

    const maps = contextMaps(safeContext)
    // A named binding may itself contain dots.  Check it before traversing a
    // path so the editor can supply an explicitly named value without adding
    // a second expression grammar.
    for (const map of maps) {
      const direct = normalizeResolved(readOwn(map, source))
      if (direct !== MISSING) return direct
    }

    const rawRoot = safeContext && typeof safeContext === 'object' ? readOwn(safeContext, segments[0]) : MISSING
    const roots = [rawRoot].concat(rootNames(segments[0]).map(function (name) {
      for (const map of maps) {
        const value = readOwn(map, name)
        if (value !== MISSING) return value
      }
      return MISSING
    }))
    for (const rootValue of roots) {
      if (rootValue === MISSING) continue
      const result = normalizeResolved(readPath(rootValue, segments.slice(1)))
      if (result !== MISSING) return result
    }

    // An unqualified field is allowed for local values or a plain context
    // object.  It still goes through the same safe field reader.
    for (const map of maps) {
      const result = normalizeResolved(readPath(map, segments))
      if (result !== MISSING) return result
    }
    return MISSING
  }

  // Scan placeholders without rewriting their contents.  In particular,
  // braces inside a quoted author string stay text, while both ASCII and
  // full-width outer braces are accepted.  Nested object/tuple literals are
  // balanced before the closing placeholder brace is selected.
  function replaceExpressions(source, visitor) {
    const input = String(source || '')
    const output = []
    const quotes = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』', '＂': '＂', '＇': '＇' }
    let cursor = 0
    while (cursor < input.length) {
      const opener = input[cursor]
      if (opener !== '{' && opener !== '｛') {
        output.push(opener)
        cursor += 1
        continue
      }
      const closer = opener === '｛' ? '｝' : '}'
      const doubled = input[cursor + 1] === opener
      const expressionStart = cursor + (doubled ? 2 : 1)
      let index = expressionStart
      let nested = 0
      let quote = ''
      let escaped = false
      let end = -1
      for (; index < input.length; index += 1) {
        const character = input[index]
        if (quote) {
          if (escaped) { escaped = false; continue }
          if ((quote === '"' || quote === "'") && character === '\\') { escaped = true; continue }
          if (character === quote) quote = ''
          continue
        }
        if (quotes[character]) { quote = quotes[character]; continue }
        if (character === '{' || character === '｛') { nested += 1; continue }
        if (character === '}' || character === '｝') {
          if (nested > 0) { nested -= 1; continue }
          if (character !== closer || doubled && input[index + 1] !== closer) continue
          end = index
          break
        }
      }
      if (end < 0) {
        // The remainder is plain text once no matching closer exists.  Keep
        // it byte-for-byte and finish in one pass instead of rescanning the
        // same tail for every character.
        output.push(input.slice(cursor))
        break
      }
      const raw = input.slice(expressionStart, end)
      output.push(visitor(raw))
      cursor = end + (doubled ? 2 : 1)
    }
    return output.join('')
  }

  function interpolateDetails(description, context, options) {
    const text = description === null || description === undefined ? '' : String(description)
    // Existing static descriptions must remain byte-for-byte compatible when
    // no instance context is available.  Editors can pass {} explicitly to
    // render unresolved slots as “未赋值”.
    if (context === undefined) return { text: text, missing: [] }
    const input = options && typeof options.missingText === 'string' ? options.missingText : '未赋值'
    const missing = []
    const seen = new Set()
    const diagnostics = []
    const evaluationState = {
      steps: 0,
      total: 0,
      totalLimit: MAX_TOTAL_EVALUATION_STEPS,
      budgetExceeded: false,
      projectionBudgetExceeded: false,
    }
    const addBudgetDiagnostic = function () {
      if (!diagnostics.includes('description-template-budget')) diagnostics.push('description-template-budget')
    }
    let templateCount = 0
    let projectedContext
    let projectionReady = false
    const getProjectedContext = function () {
      if (!projectionReady) {
        projectedContext = projectContext(context, evaluationState)
        projectionReady = true
      }
      return projectedContext
    }
    const rendered = replaceExpressions(text, function (expression) {
      templateCount += 1
      if (templateCount > MAX_TEMPLATE_COUNT || evaluationState.total >= MAX_TOTAL_EVALUATION_STEPS) {
        addBudgetDiagnostic()
        return input
      }
      // Keep the per-expression limit while sharing one aggregate budget for
      // the whole description.
      evaluationState.steps = 0
      evaluationState.budgetExceeded = false
      const value = resolveInternal(expression, context, evaluationState, getProjectedContext())
      if (evaluationState.budgetExceeded || evaluationState.projectionBudgetExceeded) addBudgetDiagnostic()
      if (value === MISSING) {
        if (!seen.has(expression)) { seen.add(expression); missing.push(expression) }
        return input
      }
      const renderedValue = typeof value === 'boolean' ? (value ? '是' : '否') : String(value)
      if (renderedValue.length > MAX_RESULT_TEXT_LENGTH) {
        if (!seen.has(expression)) { seen.add(expression); missing.push(expression) }
        return input
      }
      return renderedValue
    })
    return { text: rendered, missing: missing, diagnostics: diagnostics }
  }

  function interpolate(description, context, options) {
    return interpolateDetails(description, context, options).text
  }

  function expressions(description) {
    const result = []
    const seen = new Set()
    replaceExpressions(String(description === null || description === undefined ? '' : description), function (rawExpression) {
      const expression = String(rawExpression).trim()
      if (expression && !seen.has(expression)) { seen.add(expression); result.push(expression) }
      return ''
    })
    return result
  }

  function resolve(expression, context) {
    const value = resolveInternal(expression, context)
    return value === MISSING ? undefined : value
  }

  function render(description, keywords, context, options) {
    // A context-only second argument is useful to callers that do not need
    // keyword highlighting, while preserving the historical (text, keywords)
    // signature.
    if (!Array.isArray(keywords) && keywords && context === undefined) {
      context = keywords
      keywords = []
    }
    const text = interpolateDetails(description, context, options).text
    const names = Array.from(new Set((Array.isArray(keywords) ? keywords : [])
      .filter(function (name) { return typeof name === 'string' && name.length > 0 })))
      .sort(function (a, b) { return b.length - a.length || a.localeCompare(b) })
    let result = ''
    let plainStart = 0
    for (let cursor = 0; cursor < text.length;) {
      const keyword = names.find(function (name) { return text.startsWith(name, cursor) })
      if (!keyword) { cursor++; continue }
      result += escapeHtml(text.slice(plainStart, cursor))
      result += '<strong class="skill-description-keyword">' + escapeHtml(keyword) + '</strong>'
      cursor += keyword.length
      plainStart = cursor
    }
    return result + escapeHtml(text.slice(plainStart))
  }

  const guideKey = 'rvb_skill_reading_guide_v1'
  let acknowledged = false
  let guide = null

  function showGuide(manual) {
    if (guide || (!manual && acknowledged)) return
    try { if (!manual && root.localStorage.getItem(guideKey) === '1') return } catch { /* 本页仍可记住确认。 */ }
    const previousFocus = document.activeElement
    guide = document.createElement('dialog')
    guide.className = 'skill-reading-guide'
    guide.setAttribute('aria-labelledby', 'skill-reading-guide-title')
    guide.innerHTML = '<h2 id="skill-reading-guide-title">技能描述怎么看</h2>' +
      '<dl><dt>地格（5）</dt><dd>选择5格内的地格；（>6）表示6格外。</dd>' +
      '<dt>沉默[3]</dt><dd>沉默持续3回合。</dd>' +
      '<dt>中毒 x 2</dt><dd>强度或层数为2，具体效果看关键词说明。</dd>' +
      '<dt>2倍伤害</dt><dd>数值等于攻击力的2倍。</dd>' +
      '<dt><strong>粗体关键词</strong></dt><dd>状态或机制，可在关键词说明中查看含义。</dd></dl>' +
      '<p>句号分开的效果依次独立执行；逗号或“并”连接的后续效果，需要前项成功。</p>' +
      '<button type="button" autofocus>知道了</button>'
    guide.addEventListener('cancel', function (event) { event.preventDefault() })
    guide.addEventListener('keydown', function (event) { event.stopPropagation() })
    guide.querySelector('button').addEventListener('click', function () {
      acknowledged = true
      try { root.localStorage.setItem(guideKey, '1') } catch { /* 存储不可用时仅本页免打扰。 */ }
      guide.close()
      guide.remove()
      guide = null
      if (previousFocus && previousFocus.isConnected) previousFocus.focus()
    })
    document.body.appendChild(guide)
    guide.showModal()
  }

  root.RvBSkillDescription = Object.freeze({
    render: render,
    interpolate: interpolate,
    interpolateDetails: interpolateDetails,
    resolve: resolve,
    expressions: expressions,
    showGuide: showGuide,
  })
})(globalThis)

