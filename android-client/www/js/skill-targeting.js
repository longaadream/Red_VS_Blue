;(function () {
  'use strict'

  // ── 桩函数（Stubs）────────────────────────────────────────────────────────────
  // 所有有副作用的环境函数都换成无操作桩，让技能代码安全地空跑
  const NOOP    = () => {}
  const DMG_OK  = () => ({ damage: 0, heal: 0, success: true })
  const STUBS = [
    // 按 new Function 参数顺序排列（见 buildWrapper 下方）
    DMG_OK,   // dealDamage
    DMG_OK,   // healDamage
    NOOP,     // applyEffect
    NOOP,     // addStatusEffectById
    NOOP,     // addPlayerStatusEffectById
    NOOP,     // addPlayerRuleById
    NOOP,     // addPlayerSkillById
    NOOP,     // addSkillById
    NOOP,     // removeSkillById
    NOOP,     // addCardToHand
    NOOP,     // discardCard
    () => [], // getHand
    () => ({ needsOptionSelection: true }), // selectOption
    () => null, // loadRuleById
  ]

  // ── 技能包装器（按技能缓存，避免重复 new Function）──────────────────────────
  const wrapperCache = new Map()

  function buildWrapper(skill) {
    if (wrapperCache.has(skill.id)) return wrapperCache.get(skill.id)
    try {
      const fn = new Function(
        // 环境变量名（与 STUBS 顺序对应）
        'sourcePiece', 'battle', 'context', 'selectTarget',
        'dealDamage', 'healDamage', 'applyEffect',
        'addStatusEffectById', 'addPlayerStatusEffectById',
        'addPlayerRuleById', 'addPlayerSkillById',
        'addSkillById', 'removeSkillById',
        'addCardToHand', 'discardCard', 'getHand', 'selectOption', 'loadRuleById',
        skill.code + '\nreturn executeSkill(context);'
      )
      wrapperCache.set(skill.id, fn)
      return fn
    } catch {
      return null
    }
  }

  // ── 单次 Dry-run ──────────────────────────────────────────────────────────────
  // candidate: { x, y, instanceId?, ownerPlayerId? }
  // 返回 true = 技能接受这个目标；false = 技能拒绝
  function tryCandidate(wrapper, battleState, sourcePiece, skill, candidate) {
    // 浅克隆施法者和所有棋子，防止技能代码直接写属性（如 caster.x = pos.x）
    const mockPiece = { ...sourcePiece }
    const mockBattle = {
      ...battleState,
      pieces: battleState.pieces.map(p =>
        p.instanceId === sourcePiece.instanceId ? mockPiece : { ...p }
      ),
      // 给 tileEffects 等提供可写的空容器，防止 push 报错
      extensions: Object.assign({}, battleState.extensions, { tileEffects: [] }),
    }

    // mock selectTarget：
    //   - piece 类型：检查 range（曼哈顿）和阵营 filter，候选格上有棋子才返回
    //   - grid 类型：直接返回坐标，让技能代码自己做额外检查（如 Chebyshev、空地等）
    function mockSelectTarget(opts) {
      const o = Object.assign({ type: 'piece', range: 99, filter: 'all' }, opts)

      if (o.type === 'grid') {
        return { x: candidate.x, y: candidate.y }
      }

      if (o.type === 'piece') {
        const tp = mockBattle.pieces.find(p =>
          p.x === candidate.x && p.y === candidate.y &&
          p.currentHp > 0 && p.instanceId !== mockPiece.instanceId
        )
        if (!tp) return { needsTargetSelection: true }

        const isAlly = tp.ownerPlayerId === mockPiece.ownerPlayerId
        if (o.filter === 'enemy' &&  isAlly) return { needsTargetSelection: true }
        if (o.filter === 'ally'  && !isAlly) return { needsTargetSelection: true }

        // 只有 range < 99 才做范围裁剪（99 表示全场）
        if (o.range < 99) {
          const d = Math.abs(mockPiece.x - tp.x) + Math.abs(mockPiece.y - tp.y)
          if (d > o.range) return { needsTargetSelection: true }
        }
        return tp
      }

      return { needsTargetSelection: true }
    }

    try {
      const context = {
        piece: mockPiece,
        battle: mockBattle,
        skill,
        _selectTargetCallCount: 0,
        target: candidate.instanceId ? candidate : null,
        targetPosition: candidate,
        targets: [{ info: candidate.instanceId ? candidate : null, pos: candidate }],
      }

      const result = wrapper(
        mockPiece, mockBattle, context, mockSelectTarget,
        ...STUBS
      )

      if (!result) return false
      if (result.needsTargetSelection) return false
      if (result.success === false) return false
      return true
    } catch {
      return false
    }
  }

  // ── 获取技能合法目标格 ────────────────────────────────────────────────────────
  // 返回 [{x, y, kind: 'piece'|'grid', isAlly?}]
  function getValidSkillTargets(battleState, piece, skill) {
    if (!skill || !skill.code || !skill.code.includes('selectTarget')) return []

    const wrapper = buildWrapper(skill)
    if (!wrapper) return []

    const results = []
    const seen = new Set()

    // 先遍历所有存活棋子（作为 piece 候选）
    for (const p of battleState.pieces) {
      if (p.currentHp <= 0 || p.instanceId === piece.instanceId) continue
      const key = p.x + ',' + p.y
      const candidate = { x: p.x, y: p.y, instanceId: p.instanceId, ownerPlayerId: p.ownerPlayerId }
      if (tryCandidate(wrapper, battleState, piece, skill, candidate)) {
        results.push({ x: p.x, y: p.y, kind: 'piece', isAlly: p.ownerPlayerId === piece.ownerPlayerId })
        seen.add(key)
      }
    }

    // 再遍历所有地块（作为 grid 候选），跳过已被棋子覆盖的格子
    for (const tile of battleState.map.tiles) {
      const key = tile.x + ',' + tile.y
      if (seen.has(key)) continue
      const candidate = { x: tile.x, y: tile.y }
      if (tryCandidate(wrapper, battleState, piece, skill, candidate)) {
        results.push({ x: tile.x, y: tile.y, kind: 'grid' })
        seen.add(key)
      }
    }

    return results
  }

  // ── 移动可到达格（BFS）──────────────────────────────────────────────────────
  function getReachableCells(battleState, piece) {
    const moveRange = piece.moveRange != null ? piece.moveRange : 3

    const blocked = new Set(
      battleState.pieces
        .filter(p => p.instanceId !== piece.instanceId && p.currentHp > 0)
        .map(p => p.x + ',' + p.y)
    )

    const tileMap = {}
    for (const t of battleState.map.tiles) tileMap[t.x + ',' + t.y] = t

    const visited = new Set([piece.x + ',' + piece.y])
    const queue   = [{ x: piece.x, y: piece.y, steps: 0 }]
    const results = []

    while (queue.length) {
      const { x, y, steps } = queue.shift()
      if (steps > 0) results.push({ x, y })
      if (steps >= moveRange) continue

      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy
        const key = nx + ',' + ny
        if (visited.has(key)) continue
        visited.add(key)
        const tile = tileMap[key]
        if (!tile || !tile.props?.walkable) continue
        if (blocked.has(key)) continue
        queue.push({ x: nx, y: ny, steps: steps + 1 })
      }
    }

    return results
  }

  // ── 导出 ──────────────────────────────────────────────────────────────────────
  window.RvBTargeting = { getValidSkillTargets, getReachableCells }
})()
