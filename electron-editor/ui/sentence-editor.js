/*
 * Author-facing sentence projection for structured gameplay module graphs.
 *
 * This is deliberately a projection, rather than a second rules engine.  The
 * A small set of common damage graphs gets inline controls below.  Every
 * other graph still receives a readable projection of its registered
 * statements, including branches, loops, records, collections, composites,
 * and pending continuations.  The projection never executes or rewrites the
 * graph. All normal authoring, including typed fields and nested expressions,
 * stays in the sentence editor and its parameter inspector.
 */
(() => {
  'use strict'

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
  const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  const clone = value => {
    try { return JSON.parse(JSON.stringify(value)) } catch { return value }
  }
  const node = (tag, text, className) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined && text !== null) element.textContent = String(text)
    return element
  }
  const action = (text, handler, className = 'sentence-button') => {
    const button = node('button', text, className)
    button.type = 'button'
    button.onclick = handler
    return button
  }

  const filterLabels = { enemy: '一名敌人', ally: '一名友军', all: '任意棋子' }
  const filterShortLabels = { enemy: '敌人', ally: '友军', all: '任意棋子' }
  const attributeLabels = {
    attack: '自身攻击力', defense: '自身防御力', moveRange: '自身移动范围',
    currentHp: '自身当前生命', maxHp: '自身最大生命', x: '自身横坐标', y: '自身纵坐标',
  }
  // Attribute calls are ordinary typed field reads.  Keep the field vocabulary
  // in one place so numeric, piece-text, and player-text projections use the
  // same Chinese names without adding a skill-specific relation shortcut.
  const fieldLabels = Object.freeze({
    attack: '攻击力', defense: '防御力', moveRange: '移动范围',
    currentHp: '当前生命', maxHp: '最大生命', x: '横坐标', y: '纵坐标',
    name: '名称', faction: '阵营', momentum: '动量', stats: '基础属性',
    sourcePiece: '来源棋子记录', targetPiece: '目标棋子记录', piece: '棋子', rulePiece: '规则持有者记录',
    distance: '距离', blocksProjectile: '阻挡弹道', powerMultiplier: '倍率', actionPointCost: '行动点消耗', chargeCost: '充能点消耗', cooldown: '冷却', description: '描述',
    ownerPlayerId: '所属玩家', instanceId: '实例标识', templateId: '模板', isCore: '核心棋子',
    statusTags: '状态列表', rules: '规则列表', type: '类型', id: '标识', sourceId: '来源标识',
    skillId: '技能标识', actionPoints: '行动点', chargePoints: '充能点', maxActionPoints: '行动点上限',
    stacks: '层数', intensity: '强度', currentDuration: '持续时间', remainingDuration: '剩余持续时间',
    currentUses: '可用次数', remainingUses: '剩余次数', success: '成功', queued: '已加入效果队列', queueCount: '已加入召唤队列数量', blocked: '已阻挡',
    isKilled: '造成击杀', damage: '伤害量', heal: '治疗量', results: '逐项结果',
    tileEffects: '地格附着列表', turnNumber: '回合编号', currentPlayerId: '当前回合玩家',
    actions: '动作记录', extensions: '扩展数据', customCards: '动态卡牌定义',
    currentCooldown: '当前冷却', usesRemaining: '剩余次数', level: '等级', owner: '所属棋子', abilityGroups: '能力组', kind: '发动方式', definitionExists: '已有定义', momentumGainOnUse: '使用时积累动量',
    spentPassives: '已消耗的被动能力', relatedRules: '相关规则', stacking: '叠加方式', visible: '可见', expiresAfterTurn: '到期回合', showFreezeEffect: '冻结表现标记',
    lastDamageTurn: '上次受伤回合', hitCount: '命中次数', readyCharges: '可用资格', remainingTurns: '剩余回合', grantedTurnNumber: '获得回合', createdTurnNumber: '创建回合', value: '数值',
    actualDamage: '实际伤害', amount: '数量', boundPieceInstanceId: '绑定棋子实例', cancelled: '已取消', cardId: '卡牌标识',
    centerX: '中心横坐标', centerY: '中心纵坐标', contactCells: '接触地格', contentState: '内容状态',
    currentCardId: '当前卡牌标识', currentCardType: '当前卡牌类型', dx: '横向位移', dy: '纵向位移',
    effectModifiers: '效果修正', extension: '扩展字段', extraValue: '额外数值', flightId: '飞行标识',
    fromX: '起点横坐标', fromY: '起点纵坐标', isSinglePieceTargetAction: '是否单棋子目标行动', left: '左值',
    legacyText: '旧文本', modifiedDamage: '修正伤害', modifiedHeal: '修正治疗', movementKind: '移动方式',
    noKillCharge: '不积累击杀充能', occupied: '是否占用', pathCells: '路径地格', playerId: '玩家标识',
    presentation: '表现批次', rawDamage: '原始伤害', rawHeal: '原始治疗', reservedCells: '保留地格',
    resolvedDamage: '结算伤害', right: '右值', ruleOwnerPlayerId: '规则所属玩家',
    ruleRewrittenPrimaryTargetPieceId: '规则改写的主要目标棋子', selectedOption: '已选选项', selectedTargets: '已选目标',
    skillIds: '技能标识列表', skills: '技能列表', sourcePieceId: '来源棋子标识', statusId: '状态标识', statusType: '状态类型',
    targetHp: '目标生命', targetId: '目标标识', targetX: '目标横坐标', targetY: '目标纵坐标', terrainType: '地形类型',
    tileType: '地格类型', totalDamage: '总伤害', totalHeal: '总治疗', turns: '回合数',
    velenHolyProphecy: '圣预言', velenHolyProphecyEnhanced: '强化圣预言', walkable: '可通行',
  })

  // Descriptors usually carry a domain label, but older catalog entries and
  // structural slots only expose their machine name.  Keep the projection
  // readable in that case without changing the descriptor or graph.
  const semanticSlotLabels = Object.freeze({
    target: '目标', source: '来源', amount: '数量', damage: '实际伤害', heal: '实际治疗', damageType: '伤害类型',
    instance: '实例', instances: '实例列表', statuses: '状态列表', defined: '字段已定义', present: '实例可用', cells: '地格列表',
    player: '玩家', piece: '棋子', owner: '归属对象', items: '集合', item: '项目', index: '索引',
    condition: '条件', record: '记录', field: '字段', name: '变量名称', namespace: '分组', path: '字段路径',
    valueType: '值类型', value: '值', schema: '记录结构', keyField: '键字段', initial: '初始值',
    accumulator: '累计变量', handle: '变量', result: '结果', success: '是否成功', message: '提示文字', title: '提示',
    range: '范围', filter: '筛选条件', targetType: '目标类型', canCancel: '允许中止本次效果',
    resumeOnCancel: '中止后继续流程', candidates: '候选项', selectionMode: '选择模式',
    min: '最少选择', max: '最多选择', minSelections: '最少选择', maxSelections: '最多选择',
    budget: '循环上限', graph: '续接流程', payload: '载荷', resource: '资源', attribute: '属性',
    skillId: '技能', left: '左值', right: '右值', whenTrue: '满足时的值', whenFalse: '不满足时的值',
    currentDuration: '持续时间', duration: '持续时间', stacks: '层数', currentUses: '可用次数',
    maxUses: '最大使用次数', statusType: '状态类型', inputPolicy: '输入策略',
    variant: '变体', quantity: '数量', amountType: '数量类型', fields: '字段集合', fieldType: '字段类型',
    templateType: '模板类型', displayType: '显示类型', destinationType: '目标地格类型', extensionType: '扩展字段类型',
    definitionType: '定义类型', blockType: '代码块类型', argsType: '参数类型', optionsType: '选项类型',
    sourceType: '来源类型', mode: '模式', scope: '作用范围', storageKey: '存储键', key: '键',
    order: '顺序', comparison: '比较方式', attribution: '归属方式', flowStatePolicy: '流程状态策略',
    lifetime: '生命周期', stacking: '叠加方式', relation: '关联方式', collection: '内容集合',
    card: '卡牌', rule: '规则', status: '状态', block: '代码块', args: '参数', extension: '扩展字段',
    definition: '定义', iconPath: '图标路径', duration: '持续时间', area: '范围', radius: '半径',
    attackBonus: '攻击加成', cancelValue: '中止返回值', cardId: '卡牌标识', cell: '地格',
    center: '中心地格', choice: '选择项', count: '数量', defaultValue: '默认值', description: '说明',
    destination: '目的地', destinations: '目的地列表', direction: '方向', display: '显示设置', effect: '效果',
    effects: '效果列表', end: '结束位置', entity: '实体', event: '事件', events: '事件列表', excludePiece: '排除棋子', blocked: '是否阻挡',
    first: '首项', from: '起点', group: '能力组', id: '标识', ignoreA: '忽略左侧目标', ignoreB: '忽略右侧目标',
    keys: '键列表', killerPlayer: '击杀玩家', map: '映射', maxDistance: '最大距离', maximum: '最大值', minimum: '最小值',
    movement: '移动方式', offsets: '偏移列表', omitFields: '省略字段', options: '选项列表', origin: '起点地格',
    originId: '起点标识', ownerId: '所有者标识', pieces: '棋子列表', playerId: '玩家标识', position: '位置',
    records: '记录列表', root: '根节点', second: '第二项', selfDamage: '是否自伤', set: '集合', skill: '技能',
    snapshot: '快照', sourceId: '来源标识', start: '起始位置', template: '模板', text: '文本', tiles: '地格列表',
    to: '终点', turn: '回合', type: '类型', values: '值列表', x: '横坐标', y: '纵坐标',
    audience: '显示对象', blockedTerrainTypes: '阻挡地形', containerType: '容器类型', currentHp: '当前生命',
    entityKind: '实体类型', fieldsType: '字段类型', idPrefix: '标识前缀', includeCover: '包含掩体',
    includeDead: '包含已失效对象', itemsType: '项目类型', keyType: '键类型', keysType: '键列表类型', kind: '方式',
    legacyNormalSpelling: '旧伤害名称', metric: '距离度量', missing: '缺失值', operator: '运算符', ownerType: '所有者类型',
    passAllies: '允许通过友方', passEnemies: '允许通过敌方', payloadSchema: '载荷结构', prefix: '前缀',
    presentationBatch: '表现批次', preserveMissing: '保留缺失项', requireUnoccupied: '要求未占用',
    requireWalkable: '要求可通行', resultType: '结果类型', ruleId: '规则标识', separator: '分隔符',
    snapshotType: '快照类型', statusId: '状态标识', subfield: '子字段', templateId: '模板标识', terrain: '地形',
    terrainPolicy: '地形策略', tileType: '地格类型', valuesType: '值列表类型',
    accepted: '已接受', ally: '友军', beforeFirstEnemy: '首个敌人之前', cards: '卡牌列表', distance: '距离',
    changed: '已变化', copied: '已复制', dx: '横向位移', dy: '纵向位移', encounters: '遭遇列表', enemy: '敌人',
    enemyPieces: '敌方棋子列表', exists: '是否存在', faction: '阵营', firstEnemy: '首个敌人', firstEnemyDistance: '首个敌人距离',
    groups: '能力组列表', hasHand: '是否有手牌', hasNewLandable: '是否有新可落点', lastLandable: '最后可落点', legal: '是否合法',
    ownerPlayerId: '所属玩家', placement: '落点结果', players: '玩家列表', reachedTarget: '已到达目标', reference: '引用',
    removed: '已移除', sameCell: '是否同格', steps: '步数', terrainBlocked: '地形受阻', valid: '是否有效',
  })

  const semanticModuleLabels = Object.freeze({
    'author.effect.summon': '召唤棋子', 'author.piece.display': '设置棋子显示',
    'author.effect.damage': '造成伤害', 'author.effect.heal': '进行治疗',
    'record.create': '创建记录', 'record.get': '读取记录字段', 'record.with': '更新记录',
    'record.empty': '创建空记录', 'collection.map': '映射集合', 'collection.filter': '筛选集合',
    'collection.reduce': '汇总集合', 'collection.find': '查找集合', 'code-block.invoke': '执行代码块',
  })

  const expressionInfixOperators = Object.freeze({
    'math.add': '＋',
    'math.subtract': '−',
    'math.multiply': '×',
    'math.divide': '÷',
    'math.modulo': '%',
    'math.power': '^',
    'compare.equal': '==',
    'compare.not-equal': '!=',
    'compare.equal-string': '==',
    'compare.not-equal-string': '!=',
    'compare.equal-string-nullable': '==',
    'compare.equal-boolean': '==',
    'compare.not-equal-boolean': '!=',
    'compare.equal-piece': '==',
    'compare.not-equal-piece': '!=',
    'compare.equal-piece-nullable': '==',
    'compare.equal-player': '==',
    'compare.not-equal-player': '!=',
    'compare.player-reference': '==',
    'compare.text': '==',
    'compare.less-than': '<',
    'compare.less-or-equal': '<=',
    'compare.greater-than': '>',
    'compare.greater-or-equal': '>=',
    'logic.and': '且',
    'logic.or': '或',
  })

  function semanticSlotLabel(definition, name) {
    if (name === 'canCancel') return '允许中止本次效果'
    if (name === 'resumeOnCancel') return '中止后继续流程'
    const provided = String(definition?.label || '').trim()
    if (provided && provided !== name && /[\u3400-\u9fff]/u.test(provided)) return provided
    return semanticSlotLabels[name] || provided || name || '字段'
  }

  function fieldDisplayLabel(definition) {
    const name = String(definition?.name || '').trim()
    const provided = String(definition?.label || '').trim()
    if (provided && /[\u3400-\u9fff]/u.test(provided)) return provided
    return fieldLabels[name] || provided || name || '字段'
  }

  const diagnosticFieldLabels = Object.freeze({
    summonCapability: '召唤能力声明', amount: '数量', source: '来源', target: '目标',
    template: '棋子模板', display: '显示选项', destination: '落点', message: '提示文字',
    skillId: '技能', damageType: '伤害类型', resultType: '结果类型', sourceType: '来源类型',
    targetType: '目标类型', amountType: '数量类型',
  })

  function authorDiagnostic(text) {
    let value = String(text ?? '')
    if (!value) return value
    const diagnostics = typeof window !== 'undefined' ? window.AuthorDiagnostics : globalThis.AuthorDiagnostics
    if (typeof diagnostics?.format === 'function') {
      try {
        const catalogCore = typeof window !== 'undefined' ? (window.ContentGraphCore || window.GameplayModuleCore) : null
        const formatted = diagnostics.format(value, catalogCore ? descriptorSource(catalogCore) : undefined)
        if (typeof formatted === 'string' && formatted.trim()) return formatted
      } catch { /* retain the local fallback if the optional adapter is unavailable */ }
    }
    value = value.replace(/^Gameplay module document:\s*/iu, '内容流程文档：')
    value = value.replace(/invalid summonCapability:\s*summonCapability must be a plain object/iu,
      '召唤能力声明无效：该字段必须填写对象结构，或移除空值。')
    value = value.replace(/missing input port\s+"([^"]+)"/giu, (_match, name) => `缺少输入“${diagnosticFieldLabels[name] || semanticSlotLabels[name] || name}”`)
    value = value.replace(/\binput port\b/giu, '输入')
    value = value.replace(/\bgraph\.body\[(\d+)\]\.inputs\b/giu, (_match, index) => `第${Number(index) + 1}条语句的输入`)
    value = value.replace(/\b(?:summonCapability|displayType|templateType|destinationType|sourceType|targetType|amountType|resultType)\b/giu,
      name => diagnosticFieldLabels[name] || name)
    return value
  }

  function semanticModuleLabel(id, label) {
    const value = String(label || '').trim()
    // Registered descriptors normally provide a Chinese label.  A machine
    // identifier is only a compatibility hint and must not become the
    // author-facing sentence text when a known built-in has a semantic name.
    if (semanticModuleLabels[id]) return semanticModuleLabels[id]
    if (value && value !== id && !/^[a-z][a-z0-9]*(?:[.-][a-z0-9_-]+)+$/i.test(value)) return value
    return '未注册模块'
  }

  function coreFor(options) {
    return options.core || window.ContentGraphCore || window.GameplayModuleCore || null
  }

  function targetBindingWarnings(core, draft) {
    const key = core?.GAMEPLAY_TARGET_BINDING_WARNINGS || '__gameplayTargetBindingWarnings'
    const warnings = draft?.[key]
    return Array.isArray(warnings) ? warnings.filter(item => typeof item === 'string' && item.length > 0) : []
  }

  function notifyTargetBindingWarnings(options, core, draft) {
    const warnings = targetBindingWarnings(core, draft)
    if (warnings.length) options.onDraftWarning?.(warnings.join('；'))
  }

  function graphFor(core, draft, field) {
    try {
      if (typeof core?.getGameplayModuleGraph === 'function') {
        const graph = core.getGameplayModuleGraph(draft, field)
        if (record(graph)) return graph
      }
    } catch { /* malformed drafts still get an explicit advanced-editor message */ }
    const entry = draft?.gameplayModules?.entries?.[field]
    return record(entry?.graph) ? entry.graph : null
  }

  function nestedStatements(body, result = []) {
    for (const statement of Array.isArray(body) ? body : []) {
      if (!record(statement)) continue
      result.push(statement)
      for (const branch of ['then', 'else', 'body']) nestedStatements(statement[branch], result)
      nestedStatements(statement.condition?.body, result)
    }
    return result
  }

  // A sentence editor can be mounted inside a Cluster member while the graph
  // itself contains composites, continuations, and nested branches.  IDs are
  // only unique inside a graph scope in the authoring contract, so every
  // editing operation carries a small path instead of treating the whole
  // document as one flat namespace.
  function scopeDefinition(graph, scopePath = [], createMissing = false) {
    let scope = graph
    let body = Array.isArray(graph?.body) ? graph.body : null
    let parent = null
    let parentFrame = null
    for (const frame of Array.isArray(scopePath) ? scopePath : []) {
      if (!record(scope)) return { graph: null, body: null, parent, parentFrame }
      if (frame.kind === 'composite') {
        const list = Array.isArray(scope.composites) ? scope.composites : []
        const definition = list.find(item => item?.id === frame.id && (!frame.version || item.version === frame.version))
        if (!definition) return { graph: null, body: null, parent, parentFrame }
        if (!Array.isArray(definition.body) && createMissing) definition.body = []
        parent = scope
        parentFrame = frame
        scope = definition
        body = Array.isArray(definition.body) ? definition.body : null
        continue
      }
      if (frame.kind === 'continuation') {
        const list = Array.isArray(scope.continuations) ? scope.continuations : []
        const definition = list.find(item => item?.id === frame.id && (!frame.version || item.version === frame.version))
        if (!definition) return { graph: null, body: null, parent, parentFrame }
        if (!record(definition.graph) && createMissing) definition.graph = {
          version: scope.version || 'rvb-gameplay-modules/v1',
          surface: 'pending', body: [], inputs: [], outputs: [], composites: [], schemas: [], continuations: [],
        }
        parent = scope
        parentFrame = frame
        scope = definition.graph
        body = Array.isArray(scope.body) ? scope.body : null
        continue
      }
      if (frame.kind === 'branch') {
        const owner = (Array.isArray(body) ? body : []).find(item => item?.id === frame.parentId)
        if (!owner) return { graph: null, body: null, parent, parentFrame }
        if (frame.branch === 'condition.body') {
          if (!record(owner.condition) && createMissing) owner.condition = { inputs: {}, body: [] }
          if (record(owner.condition) && !Array.isArray(owner.condition.body) && createMissing) owner.condition.body = []
          body = record(owner.condition) && Array.isArray(owner.condition.body) ? owner.condition.body : null
        } else {
          if (!Array.isArray(owner[frame.branch]) && createMissing) owner[frame.branch] = []
          body = Array.isArray(owner[frame.branch]) ? owner[frame.branch] : null
        }
        parent = owner
        parentFrame = frame
      }
    }
    return { graph: scope, body, parent, parentFrame }
  }

  function scopePathKey(scopePath) {
    return (Array.isArray(scopePath) ? scopePath : []).map(frame => `${frame.kind}:${frame.id || frame.parentId || ''}:${frame.branch || ''}`).join('/')
  }

  // Composite bodies inherit the parent graph's schema table, while a
  // continuation may add local schemas of its own.  Give controls a merged
  // view of the declarations visible at the active scope without changing the
  // graph that is eventually handed back to the compiler.
  function schemaGraphForScope(graph, scopePath = []) {
    if (!record(graph)) return graph
    let current = graph
    const sources = [graph]
    for (const frame of Array.isArray(scopePath) ? scopePath : []) {
      if (!record(current)) break
      if (frame.kind === 'composite') {
        current = (Array.isArray(current.composites) ? current.composites : []).find(item => item?.id === frame.id && (!frame.version || item.version === frame.version)) || null
      } else if (frame.kind === 'continuation') {
        const definition = (Array.isArray(current.continuations) ? current.continuations : []).find(item => item?.id === frame.id && (!frame.version || item.version === frame.version))
        current = definition?.graph || null
      }
      if (record(current)) sources.push(current)
    }
    if (current === graph) return graph
    const merged = new Map()
    for (const source of sources) for (const schema of Array.isArray(source?.schemas) ? source.schemas : []) {
      if (!record(schema)) continue
      merged.set(`${schema.id || ''}@${schema.version || ''}`, schema)
    }
    // Preserve the root graph shape so scopeDefinition can still walk the
    // original composite/continuation path while schema lookups see the
    // inherited declarations.
    return { ...graph, schemas: [...merged.values()] }
  }

  function findCall(graph, module, preferredId) {
    const calls = nestedStatements(graph?.body).filter(statement => statement.kind === 'call' && statement.module === module)
    return calls.find(statement => statement.id === preferredId) || calls[0] || null
  }

  function findCallById(graph, id) {
    return nestedStatements(graph?.body).find(statement => statement.kind === 'call' && statement.id === id) || null
  }

  function isOutput(value, nodeId, port) {
    return record(value) && value.kind === 'output'
      && (!nodeId || value.node === nodeId)
      && (!port || value.port === port)
  }

  function isLiteral(value, expected) {
    return record(value) && value.kind === 'literal'
      && (expected === undefined || value.value === expected)
  }

  function isCall(statement, id, module) {
    return record(statement) && statement.kind === 'call'
      && statement.id === id && statement.module === module
  }

  // The sentence controls are intentionally limited to complete, known graph
  // shapes. Looking only for a damage node and a multiplier made graphs such
  // as Frostbolt appear editable even though they also contain freeze status
  // and rule branches. Requiring the whole dataflow keeps authored complex
  // descriptions intact and routes those graphs to the advanced editor.
  function supportedAtomicDamageGraph(graph) {
    if (!record(graph) || graph.surface !== 'skill' || !Array.isArray(graph.body) || graph.body.length !== 6) return null
    const [source, choice, attack, multiplier, scaled, damage] = graph.body
    const calls = [source, choice, attack, multiplier, scaled, damage]
    if (!calls.every(statement => record(statement) && statement.kind === 'call' && statement.id)) return null
    if (source.module !== 'ref.holder' || choice.module !== 'author.choice.target-piece'
      || attack.module !== 'attribute.read' || multiplier.module !== 'skill.power-multiplier'
      || scaled.module !== 'math.multiply' || damage.module !== 'author.effect.damage') return null
    if (Object.keys(source.inputs || {}).length || Object.keys(choice.inputs || {}).length
      || Object.keys(multiplier.inputs || {}).length) return null
    if (!isOutput(attack.inputs?.piece, source.id, 'piece') || !attack.parameters?.attribute) return null
    if (!isOutput(scaled.inputs?.left, attack.id, 'value') || !isOutput(scaled.inputs?.right, multiplier.id, 'value')) return null
    if (!isOutput(damage.inputs?.source, source.id, 'piece')
      || !isOutput(damage.inputs?.target, choice.id, 'piece')
      || !isOutput(damage.inputs?.amount, scaled.id, 'value')) return null
    return { choice, damage, multiplier, scaled, attack, source }
  }

  function supportedDamageGraph(graph) {
    const atomic = supportedAtomicDamageGraph(graph)
    if (atomic) return atomic
    if (!record(graph) || graph.surface !== 'skill' || !Array.isArray(graph.body)) return null
    const expected = [
      ['source-ref', 'ref.holder'], ['source', 'query.piece'],
      ['choice', 'choice.target-piece'], ['unresolved', 'choice.is-unresolved'],
      ['wait-or-cancel', 'if'], ['target', 'choice.piece'],
      ['source-name', 'attribute.text'], ['target-name', 'attribute.text'],
      ['attack', 'attribute.read'], ['multiplier', 'skill.power-multiplier'],
      ['scaled', 'math.multiply'], ['damage', 'effect.damage'],
      ['damage-text', 'text.from-number'], ['message-0', 'text.concat'],
      ['message-1', 'text.concat'], ['message-2', 'text.concat'],
      ['message-3', 'text.concat'], ['message-4', 'text.concat'],
      ['message-5', 'text.concat'], ['result', 'result.action'],
      ['return-result', 'return'],
    ]
    if (graph.body.length !== expected.length) return null
    for (let index = 0; index < expected.length; index += 1) {
      const statement = graph.body[index]
      const [id, module] = expected[index]
      if (module === 'if') {
        if (!record(statement) || statement.kind !== 'if' || statement.id !== id) return null
      } else if (module === 'return') {
        if (!record(statement) || statement.kind !== 'return' || statement.id !== id) return null
      } else if (!isCall(statement, id, module)) return null
    }
    const [sourceRef, source, choice, unresolved, wait, target, sourceName, targetName,
      attack, multiplier, scaled, damage, damageText, message0, message1, message2,
      message3, message4, message5, result, returnResult] = graph.body
    if (Object.keys(wait).some(key => !['kind', 'id', 'condition', 'then'].includes(key))) return null
    if (!isOutput(source.inputs?.pieceId, sourceRef.id, 'piece')) return null
    if (Object.keys(choice.inputs || {}).length !== 0) return null
    if (!isOutput(unresolved.inputs?.choice, choice.id, 'choice')) return null
    if (!isOutput(wait.condition, unresolved.id, 'value') || !Array.isArray(wait.then) || wait.then.length !== 2 || (Array.isArray(wait.else) && wait.else.length)) return null
    if (!isCall(wait.then[0], 'selection-result', 'choice.as-result') || !record(wait.then[0].inputs) || !isOutput(wait.then[0].inputs.choice, choice.id, 'choice')) return null
    if (!record(wait.then[1]) || wait.then[1].kind !== 'return' || wait.then[1].id !== 'return-selection' || !isOutput(wait.then[1].value, 'selection-result', 'result')) return null
    if (!isOutput(target.inputs?.choice, choice.id, 'choice')) return null
    if (!isOutput(sourceName.inputs?.piece, source.id, 'piece') || sourceName.parameters?.attribute !== 'name') return null
    if (!isOutput(targetName.inputs?.piece, target.id, 'piece') || targetName.parameters?.attribute !== 'name') return null
    if (!isOutput(attack.inputs?.piece, source.id, 'piece') || !Object.hasOwn(attributeLabels, attack.parameters?.attribute)) return null
    if (Object.keys(multiplier.inputs || {}).length !== 0) return null
    if (!isOutput(scaled.inputs?.left, attack.id, 'value') || !isOutput(scaled.inputs?.right, multiplier.id, 'value')) return null
    if (!isOutput(damage.inputs?.source, source.id, 'piece') || !isOutput(damage.inputs?.target, target.id, 'piece') || !isOutput(damage.inputs?.amount, scaled.id, 'value')) return null
    if (!isOutput(damageText.inputs?.value, damage.id, 'damage')) return null
    const messageLinks = [
      [message0, 'left', null, 'right', sourceName.id, 'text'],
      [message1, 'left', message0.id, 'right', null, null],
      [message2, 'left', message1.id, 'right', targetName.id, 'text'],
      [message3, 'left', message2.id, 'right', null, null],
      [message4, 'left', message3.id, 'right', damageText.id, 'text'],
      [message5, 'left', message4.id, 'right', null, null],
    ]
    for (const [statement, leftKey, leftId, rightKey, rightId, rightPort] of messageLinks) {
      if (leftId === null ? !isLiteral(statement.inputs?.[leftKey], '') : !isOutput(statement.inputs?.[leftKey], leftId, 'text')) return null
      if (rightId === null ? !isLiteral(statement.inputs?.[rightKey]) : !isOutput(statement.inputs?.[rightKey], rightId, rightPort)) return null
    }
    if (!isLiteral(result.inputs?.success, true) || !isOutput(result.inputs?.message, message5.id, 'text')) return null
    if (!isOutput(returnResult.value, result.id, 'result')) return null
    return { choice, damage, multiplier, scaled, attack }
  }

  function graphPattern(graph) {
    return supportedDamageGraph(graph)
  }

  const statementKindLabels = {
    'record.create': '创建结构化记录',
    'record.get': '读取记录字段',
    'record.with': '更新结构化记录',
    'defer-choice': '等待选择',
    'return': '返回结果',
    'if': '条件分支',
    'foreach': '逐项执行',
    'while': '受限循环',
    'collection': '处理集合',
    'collection.map': '映射集合',
    'collection.filter': '筛选集合',
    'collection.reduce': '汇总集合',
    'collection.find': '查找第一项',
  }
  const branchLabels = { then: '满足条件时', else: '否则' }

  function descriptorForStatement(core, statement) {
    if (!record(statement) || statement.kind !== 'call') return null
    return descriptorFor(core, statement.module, statement.version)
  }

  function descriptorForGraphStatement(core, graph, statement, scopePath = []) {
    if (!record(statement) || statement.kind !== 'call') return null
    return descriptorForStatement(core, statement)
      || (Array.isArray((scopeDefinition(graph, scopePath).graph || graph)?.composites)
        ? (scopeDefinition(graph, scopePath).graph || graph).composites.find(item => item?.id === statement.module && item?.version === statement.version) || null
        : null)
  }

  function descriptorSource(core) {
    try {
      if (typeof core?.getGameplayModuleCatalog === 'function') return core.getGameplayModuleCatalog()
    } catch { /* fallback to exported registry below */ }
    return core?.GAMEPLAY_MODULE_CATALOG || core?.GAMEPLAY_MODULES || core?.GAMEPLAY_MODULE_REGISTRY || []
  }

  // Keep the registry's category navigation for side-effect modules. Pure
  // reads and calculations are filtered from the author palette below, while
  // their historical categories remain available to the full graph editor.
  const authoringCategoryOrder = [
    'data', 'calculation', 'selection', 'control', 'combat', 'board', 'status-rule', 'card-ability',
  ]
  const authoringCategoryLabels = {
    data: '变量与数据',
    calculation: '计算与容器',
    selection: '查询与选择',
    control: '流程控制',
    combat: '战斗效果',
    board: '棋盘与召唤',
    'status-rule': '状态与规则',
    'card-ability': '卡牌与能力',
  }
  const authoringCategoryFallbacks = {
    context: 'data', state: 'data', record: 'data', attribute: 'data', preview: 'data',
    math: 'calculation', value: 'calculation', logic: 'calculation', condition: 'calculation',
    text: 'calculation', collection: 'calculation',
    query: 'selection', choice: 'selection',
    flow: 'control', result: 'control', log: 'control',
    effect: 'combat',
    position: 'board', projectile: 'board', lifecycle: 'board', presentation: 'board',
    event: 'status-rule', status: 'status-rule', rule: 'status-rule',
    skill: 'card-ability', card: 'card-ability', content: 'card-ability',
  }

  function authoringCategoryFor(descriptor) {
    const category = descriptor?.ui?.category
    if (category && Object.prototype.hasOwnProperty.call(authoringCategoryLabels, category)) return category
    return authoringCategoryFallbacks[category || '']
      || authoringCategoryFallbacks[String(descriptor?.id || '').split('.')[0]]
      || 'data'
  }

  function isCompatibilityDescriptor(descriptor) {
    // Catalogs from older editor bundles do not have `ui.authoring`; treat
    // them as standard so legacy projects remain addable while the new bundle
    // can explicitly hide compatibility adapters from the basic palette.
    return descriptor?.ui?.authoring === 'compatibility'
  }

  function authoringCategoryLabel(category) {
    return authoringCategoryLabels[category] || authoringCategoryLabels.data
  }

  function isUnifiedWriteDescriptor(descriptor) {
    const id = String(descriptor?.id || '')
    return id === 'local.read' || id === 'local.write'
      || id.startsWith('extension.declare-') || id.startsWith('extension.read-') || id.startsWith('extension.write-')
      || id.startsWith('extension.map-')
      || ['piece.write-field', 'player.write-field', 'author.skill-instance.write', 'event.write-number'].includes(id)
  }

  function descriptorsFrom(source) {
    if (source instanceof Map) return [...source.values()].flatMap(value => Array.isArray(value) ? value : [value]).filter(record)
    if (Array.isArray(source)) return source.filter(record)
    if (record(source) && Array.isArray(source.descriptors)) return source.descriptors.filter(record)
    if (record(source) && typeof source.values === 'function') {
      try { return [...source.values()].flatMap(value => Array.isArray(value) ? value : [value]).filter(record) } catch { /* use object values below */ }
    }
    if (record(source)) return Object.values(source).flatMap(value => Array.isArray(value) ? value : [value]).filter(record)
    return []
  }

  function descriptorFor(core, id, version) {
    return descriptorsFrom(descriptorSource(core)).find(item => item.id === id && (!version || item.version === version)) || null
  }

  function formatNumber(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return '—'
    if (Number.isInteger(number)) return String(number)
    return String(Number(number.toFixed(4)))
  }

  function reference(nodeId, port) { return { kind: 'output', node: nodeId, port } }
  function literal(value) { return { kind: 'literal', value } }

  function directTarget(pattern, graph) {
    const targetRef = pattern?.damage?.inputs?.target
    if (record(targetRef) && targetRef.kind === 'output') {
      const target = findCallById(graph, targetRef.node)
      if (target?.module === 'choice.piece') return targetRef
    }
    return targetRef || null
  }

  function updatePreviewDescription(next, description, core, options) {
    const previewGraph = graphFor(core, next, 'previewCode')
    if (!record(previewGraph)) return next
    const preview = findCall(previewGraph, 'preview.result', 'preview')
    if (!preview) return next
    const current = preview.inputs?.description
    if (!record(current) || current.kind !== 'literal' || typeof current.value !== 'string') return next
    const updated = clone(previewGraph)
    const previewNode = findCallById(updated, preview.id)
    if (!previewNode) return next
    previewNode.inputs = { ...(previewNode.inputs || {}), description: literal(description) }
    if (!core?.applyGameplayModuleGraph) return next
    try {
      return core.applyGameplayModuleGraph(next, updated, 'previewCode')
    } catch (error) {
      // A code graph can be repaired while its optional preview graph is still
      // incomplete. Keep that preview draft attached to the document so the
      // author can fix it in the same editor; do not let the description sync
      // turn a successful code edit into a lost change.
      if (options) {
        let diagnostic = error?.message || String(error)
        try {
          const compiled = partiallyApplyCompiledGraph({ ...options, field: 'previewCode' }, next, updated, 'previewCode')
          if (compiled) return compiled
        } catch (compileError) {
          diagnostic = compileError?.message || String(compileError)
        }
        options.__sentenceLastDiagnostic = options.__sentenceLastDiagnostic || diagnostic
        options.onDraftDiagnostic?.(diagnostic)
        return rawGraphDraft({ ...options, field: 'previewCode' }, next, updated, 'previewCode')
      }
      throw error
    }
  }

  function previewPieceNumber(graph) {
    const calls = nestedStatements(graph?.body).filter(statement => statement.kind === 'call')
    return calls.find(statement => statement.id === 'attack' && ['preview.piece-number', 'preview.piece-number-nan'].includes(statement.module))
      || calls.find(statement => ['preview.piece-number', 'preview.piece-number-nan'].includes(statement.module))
      || null
  }

  function rawGraphDraft(options, draft, graph, field) {
    const next = clone(draft || {})
    const priorModules = record(next.gameplayModules) ? clone(next.gameplayModules) : {
      version: coreFor(options)?.GAMEPLAY_MODULE_DOCUMENT_VERSION || 'rvb-gameplay-module-document/v1',
      entries: {},
    }
    priorModules.version = priorModules.version || coreFor(options)?.GAMEPLAY_MODULE_DOCUMENT_VERSION || 'rvb-gameplay-module-document/v1'
    priorModules.entries = record(priorModules.entries) ? priorModules.entries : {}
    const prior = record(priorModules.entries[field]) ? priorModules.entries[field] : {}
    priorModules.entries[field] = { ...prior, graph: clone(graph) }
    // The compiler version must be removed while a graph is incomplete.  The
    // document validator then blocks Save, but the author can continue fixing
    // the same in-memory graph and the next successful edit recompiles it.
    delete priorModules.entries[field].compilerVersion
    next.gameplayModules = priorModules
    return next
  }

  // New authoring documents may still carry the legacy content-field default
  // `summonCapability: null`.  The document validator treats an explicitly
  // present null as an invalid capability; an omitted optional capability is
  // the supported representation.  Keep this normalization at the authoring
  // boundary so the runnable graph and the user-facing draft stay identical.
  function normalizeAuthorDraft(next) {
    if (!record(next) || next.summonCapability !== null) return next
    const normalized = clone(next)
    delete normalized.summonCapability
    return normalized
  }

  function graphWithDescriptorSchemas(graph, descriptor) {
    const schemas = Array.isArray(descriptor?.recordSchemas) ? descriptor.recordSchemas : []
    if (!record(graph) || !schemas.length) return graph
    const merged = new Map()
    for (const schema of Array.isArray(graph.schemas) ? graph.schemas : []) {
      if (!record(schema)) continue
      merged.set(`${schema.id || schema.name || ''}@${schema.version || ''}`, schema)
    }
    for (const schema of schemas) {
      if (!record(schema)) continue
      merged.set(`${schema.id || schema.name || ''}@${schema.version || ''}`, schema)
    }
    return { ...graph, schemas: [...merged.values()] }
  }

  // Author record modules carry the shared piece/template/display schemas on
  // their descriptors.  A blank graph has no local schema declarations yet,
  // so structural record editors must still see those declarations while an
  // author is composing the graph.  Keep this as an editor-only projection:
  // schemas become part of the executable graph only when a graph statement
  // explicitly selects one (and the compiler receives its descriptor schema
  // table in the normal way).
  function graphWithAuthorSchemas(core, graph) {
    const schemas = descriptorsFrom(descriptorSource(core)).flatMap(item => Array.isArray(item?.recordSchemas) ? item.recordSchemas : [])
    return graphWithDescriptorSchemas(graph, { recordSchemas: schemas })
  }

  function authorSchemaForReference(core, reference) {
    if (!reference) return null
    const projected = graphWithAuthorSchemas(core, { schemas: [] })
    return schemaForGraph(projected, reference)
  }

  // Selecting a shared structure is an explicit authoring action. Persist the
  // selected declaration on the graph so record.create/get/with compile after
  // the draft is saved; controls still obtain the metadata from the registry
  // while the selection is being edited.
  function ensureAuthorSchema(graph, core, reference) {
    const schema = authorSchemaForReference(core, reference)
    if (!schema || !record(graph)) return
    if (!Array.isArray(graph.schemas)) graph.schemas = []
    const key = `${schema.id || ''}@${schema.version || ''}`
    const existing = graph.schemas.findIndex(item => `${item?.id || ''}@${item?.version || ''}` === key)
    if (existing >= 0) graph.schemas[existing] = clone(schema)
    else graph.schemas.push(clone(schema))
  }

  function surfaceForField(options, field) {
    if (field === 'previewCode') return 'preview'
    if (field === 'effectCode') return 'pending'
    if (field === 'triggerSkill') return 'triggerSkill'
    if (options?.root?.collection === 'cards') return 'card'
    if (field === 'skillCode') return options?.root?.collection === 'rules' ? 'rule' : 'skill'
    if (options?.root?.collection === 'rules') return 'rule'
    return 'skill'
  }

  function createInitialGraph(options, field) {
    const core = coreFor(options)
    if (typeof core?.createGameplayModuleGraph === 'function') return core.createGameplayModuleGraph(surfaceForField(options, field))
    return {
      version: core?.GAMEPLAY_MODULE_GRAPH_VERSION || 'rvb-gameplay-modules/v1',
      surface: surfaceForField(options, field), inputs: [], inputBindings: {}, outputs: [], body: [],
      composites: [], schemas: [], continuations: [],
    }
  }

  function graphWithInitialDraft(options, draft, field) {
    const core = coreFor(options)
    const current = graphFor(core, draft, field)
    if (record(current)) return { draft, graph: current }
    return { draft, graph: createInitialGraph(options, field), created: true }
  }

  // `applyGameplayModuleGraph` validates the entire document. That is the
  // correct save gate, but it also means an invalid sibling entry (for
  // example code while repairing previewCode) would deadlock this editor: a
  // repaired graph could never regain its compilerVersion. Compile the entry
  // in isolation after the whole-document helper rejects it, while leaving
  // every other raw entry untouched so the document validator still blocks
  // Save until all entries are valid.
  function partiallyApplyCompiledGraph(options, draft, graph, field) {
    const core = coreFor(options)
    if (typeof core?.compileGameplayModuleGraph !== 'function') return null
    const compiled = core.compileGameplayModuleGraph(graph, core.GAMEPLAY_MODULE_REGISTRY)
    const fields = {
      skill: ['code', 'skillCode'],
      card: ['code'],
      rule: ['code', 'skillCode'],
      triggerSkill: ['code', 'skillCode', 'triggerSkill'],
      pending: ['code', 'effectCode'],
      preview: ['code', 'previewCode'],
    }
    if (!fields[compiled.surface]?.includes(field)) throw new Error(`字段 ${field} 与 ${compiled.surface} 流程图不兼容。`)
    const next = clone(draft || {})
    // Keep legacy compatibility artifacts in the same state transition as
    // applyGameplayModuleGraph. A partially compiled entry is still allowed
    // to coexist with an invalid sibling, but it must not leave the replaced
    // field duplicated in contentGraph/contentGraphEntries.
    const legacyDefaults = { skill: 'code', card: 'code', rule: 'skillCode', triggerSkill: 'code', pending: 'effectCode', preview: 'previewCode' }
    const legacyEntries = record(next.contentGraphEntries) ? { ...next.contentGraphEntries } : {}
    const legacyPrimary = record(next.contentGraph)
      ? (typeof next.contentGraphField === 'string' ? next.contentGraphField : legacyDefaults[next.contentGraph.surface] || '')
      : ''
    if (legacyPrimary === field) {
      delete next.contentGraph
      delete next.contentGraphField
      delete next.contentGraphCompilerVersion
      const first = Object.keys(legacyEntries).sort()[0]
      if (first) {
        const entry = legacyEntries[first]
        if (record(entry)) {
          next.contentGraph = clone(entry.graph)
          next.contentGraphField = first
          next.contentGraphCompilerVersion = entry.compilerVersion
        }
        delete legacyEntries[first]
      }
    } else {
      delete legacyEntries[field]
    }
    if (Object.keys(legacyEntries).length) next.contentGraphEntries = legacyEntries
    else delete next.contentGraphEntries
    const modules = record(next.gameplayModules) ? next.gameplayModules : {
      version: core.GAMEPLAY_MODULE_DOCUMENT_VERSION || 'rvb-gameplay-module-document/v1', entries: {},
    }
    modules.version = core.GAMEPLAY_MODULE_DOCUMENT_VERSION || modules.version || 'rvb-gameplay-module-document/v1'
    modules.entries = record(modules.entries) ? modules.entries : {}
    const prior = record(modules.entries[field]) ? modules.entries[field] : {}
    modules.entries[field] = { ...prior, graph: clone(graph), compilerVersion: compiled.compilerVersion }
    next.gameplayModules = modules
    next[field] = compiled.code
    if (modules.textBindings !== undefined && typeof core.renderGameplayModuleText === 'function') {
      try { Object.assign(next, core.renderGameplayModuleText(modules.entries, modules.textBindings)) } catch { /* text binding repair remains a separate save-blocking diagnostic */ }
    }
    return next
  }

  function commitGraphDraft(options, draft, graph, field) {
    const core = coreFor(options)
    let next = draft
    let diagnostic = ''
    try {
      next = typeof core?.applyGameplayModuleGraph === 'function'
        ? core.applyGameplayModuleGraph(draft, graph, field)
        : rawGraphDraft(options, draft, graph, field)
    } catch (error) {
      if (error?.name === 'GameplayTargetBindingError') diagnostic = error.message || String(error)
      try {
        next = partiallyApplyCompiledGraph(options, draft, graph, field) || rawGraphDraft(options, draft, graph, field)
      } catch (compileError) {
        diagnostic = compileError?.message || String(compileError)
        next = rawGraphDraft(options, draft, graph, field)
      }
    }
    notifyTargetBindingWarnings(options, core, next)
    next = normalizeAuthorDraft(next)
    options.__sentenceLastDiagnostic = diagnostic
    options.onChange?.(next)
    if (diagnostic) options.onDraftDiagnostic?.(diagnostic)
    return { next, diagnostic }
  }

  function applyGraphChange(options, mutate, textState) {
    const core = coreFor(options)
    const field = options.field || 'code'
    // A successful repair must clear the prior save-blocking diagnostic. The
    // optional preview graph may set a fresh diagnostic below.
    options.__sentenceLastDiagnostic = ''
    const currentDraft = clone(options.getDraft?.() || {})
    const currentGraph = graphFor(core, currentDraft, field) || createInitialGraph(options, field)
    const nextGraph = clone(currentGraph)
    mutate(nextGraph, currentDraft)
    let next = currentDraft
    let diagnostic = ''
    try {
      if (typeof core?.applyGameplayModuleGraph === 'function') {
        next = core.applyGameplayModuleGraph(next, nextGraph, field)
      } else next = rawGraphDraft(options, next, nextGraph, field)
    } catch (error) {
      if (error?.name === 'GameplayTargetBindingError') diagnostic = error.message || String(error)
      // Keep invalid references/ports/modules visible in the same editor.  A
      // malformed graph is intentionally stored as a raw draft without a
      // compilerVersion; the host document validator remains the save gate.
      try {
        next = partiallyApplyCompiledGraph(options, next, nextGraph, field) || rawGraphDraft(options, next, nextGraph, field)
      } catch (compileError) {
        diagnostic = compileError?.message || String(compileError)
        next = rawGraphDraft(options, next, nextGraph, field)
      }
    }
    notifyTargetBindingWarnings(options, core, next)
    if (typeof textState?.mutatePreview === 'function' && typeof core?.applyGameplayModuleGraph === 'function') {
      const previewGraph = graphFor(core, next, 'previewCode')
      if (record(previewGraph)) {
        const updatedPreview = clone(previewGraph)
        textState.mutatePreview(updatedPreview)
        try { next = core.applyGameplayModuleGraph(next, updatedPreview, 'previewCode') } catch {
          try {
            next = partiallyApplyCompiledGraph({ ...options, field: 'previewCode' }, next, updatedPreview, 'previewCode') || rawGraphDraft({ ...options, field: 'previewCode' }, next, updatedPreview, 'previewCode')
          } catch (compileError) {
            diagnostic = diagnostic || compileError?.message || String(compileError)
            next = rawGraphDraft({ ...options, field: 'previewCode' }, next, updatedPreview, 'previewCode')
          }
        }
      }
    }
    const derivedDescription = textState?.description || (graphPattern(nextGraph) && typeof next.description === 'string' ? next.description : '')
    if (derivedDescription) next = updatePreviewDescription(next, derivedDescription, core, options)
    next = normalizeAuthorDraft(next)
    diagnostic = diagnostic || options.__sentenceLastDiagnostic || ''
    options.__sentenceLastDiagnostic = diagnostic
    options.onChange?.(next)
    if (diagnostic) options.onDraftDiagnostic?.(diagnostic)
    return next
  }

  function canonicalText(pattern, draft, core = null, graph = null, scopePath = []) {
    const range = Number(pattern.choice.parameters?.range)
    const filter = typeof pattern.choice.parameters?.filter === 'string' ? pattern.choice.parameters.filter : 'enemy'
    const multiplier = Number(draft.powerMultiplier)
    const attribute = pattern.attack?.parameters?.attribute || 'attack'
    const targetShort = filterShortLabels[filter] || filter
    const defaultMultiplier = pattern.scaled?.inputs?.right?.kind === 'output'
      && pattern.multiplier?.id
      && pattern.scaled.inputs.right.node === pattern.multiplier.id
      && pattern.scaled.inputs.right.port === 'value'
    const multiplierLabel = !defaultMultiplier && core && graph && pattern.scaled?.inputs?.right
      ? expressionValueLabel(core, graph, pattern.scaled.inputs.right, new Set(), scopePath)
      : formatNumber(multiplier)
    const description = `选择${targetShort}（${formatNumber(range)}），造成${multiplierLabel}倍伤害。`
    return {
      range,
      filter,
      multiplier,
      multiplierLabel,
      attribute,
      description,
      targetText: `${targetShort}（${formatNumber(range)}）`,
    }
  }

  function updateCanonicalFields(next, pattern, core = null, graph = null, scopePath = []) {
    if (!pattern) return null
    const text = canonicalText(pattern, next, core, graph, scopePath)
    next.targetText = text.targetText
    next.description = text.description
    return text
  }

  function createModuleInputs(core, graph, descriptor, pattern) {
    const inputs = {}
    for (const port of Array.isArray(descriptor?.inputs) ? descriptor.inputs : []) {
      if (port.optional) continue
      // A newly inserted call must not silently point at an arbitrary prior
      // output.  Keep only references whose meaning is unambiguous in the
      // active sentence (the supported damage projection has a real target or
      // source); every other required slot remains visibly unset for the
      // author to choose.  Nullable ports are the one safe literal default.
      let value
      if (port.name === 'target') value = directTarget(pattern, graph) || undefined
      else if (port.name === 'source' || port.name === 'piece') value = pattern?.damage?.inputs?.source
      if (value !== undefined) inputs[port.name] = clone(value)
      else if (port.nullable) inputs[port.name] = literal(null)
    }
    return inputs
  }

  function nextStatementId(graph, prefix) {
    const ids = new Set()
    const visitGraph = current => {
      if (!record(current)) return
      for (const statement of nestedStatements(current.body)) if (statement?.id) ids.add(statement.id)
      for (const composite of Array.isArray(current.composites) ? current.composites : []) {
        for (const statement of nestedStatements(composite?.body)) if (statement?.id) ids.add(statement.id)
        // A continuation may declare its own composites. Walk those nested
        // declarations as well so a scope-local insertion cannot collide with
        // an ID that is already used deeper in the document.
        for (const nestedComposite of Array.isArray(composite?.composites) ? composite.composites : []) {
          for (const statement of nestedStatements(nestedComposite?.body)) if (statement?.id) ids.add(statement.id)
        }
      }
      for (const continuation of Array.isArray(current.continuations) ? current.continuations : []) {
        visitGraph(continuation?.graph)
      }
    }
    visitGraph(graph)
    let index = 1
    let id = `${prefix}-${index}`
    while (ids.has(id) || [...ids].some(existing => existing.startsWith(`${id}_`))) id = `${prefix}-${++index}`
    return id
  }

  function addModule(options, moduleId, moduleVersion, target = { kind: 'root' }, scopePath = options.__sentenceScopePath || []) {
    // Keep the pre-versioned internal call shape working while making picker
    // insertion explicit about the selected descriptor version.
    if (record(moduleVersion)) {
      scopePath = Array.isArray(target) ? target : scopePath
      target = moduleVersion
      moduleVersion = undefined
    }
    const core = coreFor(options)
    const field = options.field || 'code'
    const currentDraft = clone(options.getDraft?.() || {})
    const ensured = graphWithInitialDraft(options, currentDraft, field)
    const graph = ensured.graph
    const activeGraph = scopeDefinition(graph, scopePath).graph || graph
    const pattern = graphPattern(activeGraph)
    const descriptor = moduleDescriptorsFor(core, activeGraph).find(item => item.id === moduleId && (!moduleVersion || item.version === moduleVersion))
      || descriptorFor(core, moduleId, moduleVersion)
    if (!record(graph) || !descriptor) throw new Error('找不到可用的注册模块。')
    const insertionParent = target?.parentId ? statementForId(graph, target.parentId, scopePath) : null
    const dataOnly = target?.branch === 'condition.body' || insertionParent?.kind === 'collection' || insertionParent?.kind?.startsWith?.('collection.')
    if (dataOnly && !pureDescriptor(descriptor)) throw new Error('循环条件和集合子流程只能加入无副作用模块。')
    const nextGraph = clone(graph)
    const statement = {
      kind: 'call', id: nextStatementId(nextGraph, 'sentence-module'), module: descriptor.id,
      version: descriptor.version, inputs: createModuleInputs(core, scopeDefinition(nextGraph, scopePath).graph || nextGraph, descriptor, pattern), parameters: {},
    }
    for (const parameter of Array.isArray(descriptor.parameters) ? descriptor.parameters : []) {
      if (own(parameter, 'default')) statement.parameters[parameter.name] = clone(parameter.default)
    }
    const targetStatements = target?.kind === 'root' ? scopeDefinition(nextGraph, scopePath, true).body : statementArrayFor(nextGraph, target, scopePath)
    if (!Array.isArray(targetStatements)) throw new Error('找不到要插入的分支。')
    const terminal = targetStatements.findIndex(item => item?.kind === 'return')
    targetStatements.splice(terminal < 0 ? targetStatements.length : terminal, 0, statement)
    commitGraphDraft(options, currentDraft, nextGraph, field)
    return statement.id
  }

  function addCondition(options, target = { kind: 'root' }, scopePath = options.__sentenceScopePath || []) {
    const field = options.field || 'code'
    const currentDraft = clone(options.getDraft?.() || {})
    const graph = graphWithInitialDraft(options, currentDraft, field).graph
    const nextGraph = clone(graph)
    const targetStatements = target?.kind === 'root' ? scopeDefinition(nextGraph, scopePath, true).body : statementArrayFor(nextGraph, target, scopePath)
    if (!Array.isArray(targetStatements)) throw new Error('找不到要插入的分支。')
    const terminal = targetStatements.findIndex(item => item?.kind === 'return')
    const statement = { kind: 'if', id: nextStatementId(nextGraph, 'sentence-condition'), condition: literal(true), then: [], else: [] }
    targetStatements.splice(terminal < 0 ? targetStatements.length : terminal, 0, statement)
    commitGraphDraft(options, currentDraft, nextGraph, field)
  }

  function addStructuredStatement(options, kind, target = { kind: 'root' }, scopePath = options.__sentenceScopePath || []) {
    const field = options.field || 'code'
    const currentDraft = clone(options.getDraft?.() || {})
    const graph = graphWithInitialDraft(options, currentDraft, field).graph
    const nextGraph = clone(graph)
    const active = scopeDefinition(nextGraph, scopePath, true)
    const scopeGraph = active.graph || nextGraph
    const statements = target?.kind === 'root' ? scopeDefinition(nextGraph, scopePath, true).body : statementArrayFor(nextGraph, target, scopePath)
    if (!Array.isArray(statements)) throw new Error('找不到要插入的分支。')
    const id = nextStatementId(nextGraph, `sentence-${kind}`)
    let statement
    if (kind === 'foreach') statement = { kind, id, items: literal([]), item: 'item', index: 'index', body: [] }
    else if (kind === 'while') statement = { kind, id, budget: 1, condition: { inputs: {}, body: [{ kind: 'return', id: nextStatementId(nextGraph, `${id}-condition-return`), value: literal(false) }] }, body: [] }
    else if (kind === 'record.create') {
      const schema = (Array.isArray(scopeGraph.schemas) ? scopeGraph.schemas : []).find(Boolean)
        || (Array.isArray(nextGraph.schemas) ? nextGraph.schemas : []).find(Boolean)
      statement = { kind, id, schema: schema ? `${schema.id}@${schema.version}` : '', fields: {} }
      for (const field of Array.isArray(schema?.fields) ? schema.fields : []) {
        if (own(field, 'default')) statement.fields[field.name] = literal(clone(field.default))
      }
    } else if (kind === 'record.get') statement = { kind, id, record: literal(null), field: '' }
    else if (kind === 'record.with') statement = { kind, id, record: literal(null), fields: {} }
    else if (kind === 'collection' || kind === 'collection.map' || kind === 'collection.filter' || kind === 'collection.reduce' || kind === 'collection.find') {
      const method = kind.startsWith('collection.') ? kind.slice('collection.'.length) : 'map'
      // The canonical compiler form is `kind: collection` plus a method.
      statement = { kind: 'collection', id, method, items: literal([]), item: 'item', index: 'index', body: [] }
      if (method === 'reduce') { statement.accumulator = 'accumulator'; statement.initial = literal(null) }
    } else if (kind === 'defer-choice') {
      const continuation = Array.isArray(scopeGraph.continuations) ? scopeGraph.continuations[0] : null
      statement = { kind, id, graph: continuation?.id || '', payload: literal(null), title: literal('等待选择'), canCancel: literal(true), resumeOnCancel: literal(true) }
    }
    else if (kind === 'return') {
      const outputs = Array.isArray(scopeGraph.outputs) ? scopeGraph.outputs : []
      if (outputs.length) statement = { kind, id, values: Object.fromEntries(outputs.map(output => [output.name, literal(defaultForType(output))])) }
      else statement = { kind, id, value: literal(true) }
    } else throw new Error(`不支持的结构语句：${kind}`)
    const terminal = statements.findIndex(item => item?.kind === 'return')
    statements.splice(terminal < 0 ? statements.length : terminal, 0, statement)
    commitGraphDraft(options, currentDraft, nextGraph, field)
    return id
  }

  function statementIds(statement, ids = new Set()) {
    if (!record(statement)) return ids
    if (statement.id) ids.add(statement.id)
    for (const branch of ['then', 'else', 'body']) for (const child of Array.isArray(statement[branch]) ? statement[branch] : []) statementIds(child, ids)
    for (const child of Array.isArray(statement.condition?.body) ? statement.condition.body : []) statementIds(child, ids)
    return ids
  }

  function authorStatementGroupIdsForRow(statement) {
    const metadata = record(statement?.layout?.authorStatement) ? statement.layout.authorStatement : null
    const ids = new Set(Array.isArray(metadata?.generatedIds) ? metadata.generatedIds.filter(Boolean) : [])
    if (statement?.id) ids.add(statement.id)
    return ids
  }

  function graphUsesAnyOutput(graph, ids, scopePath = []) {
    const visit = statements => {
      for (const statement of Array.isArray(statements) ? statements : []) {
        if (!record(statement)) continue
        if (ids.has(statement.id)) continue
        const values = []
        const scan = value => { if (record(value) && value.kind === 'output' && ids.has(value.node)) values.push(value) }
        if (statement.kind === 'call') Object.values(statement.inputs || {}).forEach(scan)
        else if (statement.kind === 'if') scan(statement.condition)
        else if (statement.kind === 'foreach') scan(statement.items)
        else if (statement.kind === 'while') Object.values(statement.condition?.inputs || {}).forEach(scan)
        else if (statement.kind === 'return') { scan(statement.value); Object.values(statement.values || {}).forEach(scan) }
        else if (statement.kind === 'record.create') Object.values(statement.fields || {}).forEach(scan)
        else if (statement.kind === 'record.get' || statement.kind === 'record.with') { scan(statement.record); Object.values(statement.fields || {}).forEach(scan) }
        else if (statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) { scan(statement.items); Object.values(statement.inputs || {}).forEach(scan); scan(statement.initial) }
        else if (statement.kind === 'defer-choice') for (const key of ['payload', 'player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message']) scan(statement[key])
        if (values.length) return true
        if (visit(statement.then) || visit(statement.else) || visit(statement.body) || visit(statement.condition?.body)) return true
      }
      return false
    }
    const scoped = scopeDefinition(graph, scopePath)
    if (Array.isArray(scopePath) && scopePath.length) return visit(scoped.body)
    return visit(graph?.body)
  }

  function changeStatementRow(options, statementId, operation, scopePath = options.__sentenceScopePath || []) {
    return applyGraphChange(options, graph => {
      const location = statementLocation(graph, statementId, scopePath)
      if (!location?.statements || location.index < 0) throw new Error('找不到这条语句。')
      const statement = location.statement
      if (operation === 'delete') {
        if (statement.kind === 'return') throw new Error('返回语句是流程终点，不能直接删除。')
        const ids = statementIds(statement)
        const authorIds = authorStatementGroupIdsForRow(statement)
        const resultBindingIds = resultBindingGroupIds(coreFor(options), graph, statement, scopePath)
        for (const id of authorIds) ids.add(id)
        for (const id of resultBindingIds) ids.add(id)
        const ownedIds = new Set([...authorIds, ...resultBindingIds])
        const owned = []
        for (const item of location.statements) if (item !== statement && ownedIds.has(item?.id)) owned.push(item)
        let expanded = true
        while (expanded) {
          expanded = false
          for (const item of location.statements) if (!owned.includes(item) && ids.has(item.layout?.authorExpression?.owner ?? item.layout?.sentenceExpression?.owner)) {
            owned.push(item); statementIds(item, ids); expanded = true
          }
        }
        if (graphUsesAnyOutput(graph, ids, scopePath)) throw new Error('这条语句仍被后续引用；请先改掉引用，再删除。')
        location.statements.splice(location.index, 1)
        for (let index = location.statements.length - 1; index >= 0; index--) if (owned.includes(location.statements[index])) location.statements.splice(index, 1)
        return
      }
      if (operation === 'duplicate') {
        if (statement.kind === 'return') throw new Error('返回语句不能复制为同一流程中的第二个终点。')
        const ids = statementIds(statement)
        const authorIds = authorStatementGroupIdsForRow(statement)
        for (const id of authorIds) ids.add(id)
        const expressions = new Set()
        for (const candidate of location.statements.slice(0, location.index)) if (authorIds.has(candidate?.id)) expressions.add(candidate)
        // Inline expressions live before their consumer in the same block.
        // Copy that owned dependency tree too, while retaining ordinary
        // references to values produced by unrelated earlier statements.
        let changed = true
        while (changed) {
          changed = false
          for (const candidate of location.statements.slice(0, location.index)) {
            const expressionOwner = candidate.layout?.authorExpression?.owner ?? candidate.layout?.sentenceExpression?.owner
            if (expressions.has(candidate) || !ids.has(expressionOwner)) continue
            if (!candidate.layout?.authorExpression && (candidate.kind !== 'call' || !pureDescriptor(descriptorForGraphStatement(coreFor(options), graph, candidate, scopePath)))) continue
            expressions.add(candidate)
            statementIds(candidate, ids)
            changed = true
          }
        }
        const idMap = new Map([...ids].map(id => [id, nextStatementId(graph, `copy-${id}`)]))
        const originals = [...location.statements.filter(candidate => expressions.has(candidate)), statement]
        const copies = originals.map(original => remapStatementIds(original, idMap, graph))
        location.statements.splice(location.index + 1, 0, ...copies)
        return
      }
      if (operation === 'up' || operation === 'down') {
        if (statement?.kind === 'return') throw new Error('返回语句必须保持在分支末尾。')
        const authorIds = authorStatementGroupIdsForRow(statement)
        const authorFacade = record(statement?.layout?.authorStatement)
        {
          const core = coreFor(options)
          const resultBindingIds = resultBindingGroupIds(core, graph, statement, scopePath)
          const movingIds = authorFacade
            ? new Set([...authorIds, ...resultBindingIds])
            : resultBindingIds
          const groupFor = new Map()
          for (const item of location.statements) {
            const metadata = record(item?.layout?.authorStatement) ? item.layout.authorStatement : null
            if (!metadata) continue
            const ids = new Set(Array.isArray(metadata.generatedIds) ? metadata.generatedIds.filter(Boolean) : [])
            if (item.id) ids.add(item.id)
            for (const id of ids) groupFor.set(id, ids)
          }
          const isProjectionHidden = item => {
            if (!record(item)) return true
            if (resultBindingDeclaration(core, graph, item, scopePath)) return true
            if (item.layout?.authorExpression && statementForLexicalId(graph, item.layout.authorExpression.owner, scopePath)) return true
            if (isProjectedPureCall(core, graph, item, scopePath)) return true
            const consumedContext = item.kind === 'call'
              && ['ref.holder', 'ref.source', 'ref.target'].includes(item.module)
              && graphUsesAnyOutput(graph, new Set([item.id]), scopePath)
            if (consumedContext) return true
            const expressionMeta = item.layout?.sentenceExpression
            if (item.kind === 'call' && record(expressionMeta) && expressionMeta.owner && expressionMeta.input) {
              const owner = statementForLexicalId(graph, expressionMeta.owner, scopePath)
              const ownerValue = owner?.kind === 'call' ? owner.inputs?.[expressionMeta.input] : undefined
              const descriptor = descriptorForGraphStatement(core, graph, item, scopePath)
              if (ownerValue?.kind === 'output' && ownerValue.node === item.id && pureDescriptor(descriptor)) return true
            }
            return false
          }
          const movingItems = location.statements.filter(item => movingIds.has(item?.id))
          const movingSet = new Set(movingItems)
          const visibleIndex = direction => {
            const start = direction < 0
              ? Math.min(...location.statements.map((item, index) => movingIds.has(item?.id) ? index : Infinity)) - 1
              : Math.max(...location.statements.map((item, index) => movingIds.has(item?.id) ? index : -1)) + 1
            for (let index = start; index >= 0 && index < location.statements.length; index += direction) {
              const item = location.statements[index]
              if (movingIds.has(item?.id) || isProjectionHidden(item)) continue
              return index
            }
            return -1
          }
          const neighborIndex = visibleIndex(operation === 'up' ? -1 : 1)
          if (neighborIndex < 0 && resultBindingIds.size > 1) return
          if (neighborIndex < 0) return
          if (neighborIndex >= 0) {
            const neighbor = location.statements[neighborIndex]
            if (neighbor?.kind === 'return') throw new Error('返回语句必须保持在分支末尾。')
            const neighborIds = new Set(groupFor.get(neighbor?.id) || [neighbor?.id])
            for (const id of resultBindingGroupIds(core, graph, neighbor, scopePath)) neighborIds.add(id)
            const neighborItems = location.statements.filter(item => neighborIds.has(item?.id))
            const movingReferencesNeighbor = movingItems.some(item => [...neighborIds].some(id => statementReferences(item, id)))
            const neighborReferencesMoving = neighborItems.some(item => [...movingIds].some(id => statementReferences(item, id)))
            if ((operation === 'up' && movingReferencesNeighbor) || (operation === 'down' && neighborReferencesMoving)) {
              throw new Error(operation === 'up' ? '这条语句依赖上一行的输出，不能上移。' : '下一行使用了这条语句的输出，不能下移。')
            }
            if (operation === 'up') {
              const first = Math.min(...location.statements.map((item, index) => movingIds.has(item?.id) ? index : Infinity))
              const crossed = location.statements.slice(neighborIndex + 1, first).filter(item => !movingIds.has(item?.id) && !neighborIds.has(item?.id))
              if (movingItems.some(item => crossed.some(candidate => statementReferences(item, candidate?.id)))) throw new Error('这条语句依赖被隐藏的中间结果，不能上移。')
            }
            const moved = movingItems.slice()
            for (let index = location.statements.length - 1; index >= 0; index -= 1) if (movingSet.has(location.statements[index])) location.statements.splice(index, 1)
            const remainingNeighborIndexes = location.statements.map((item, index) => neighborIds.has(item?.id) ? index : -1).filter(index => index >= 0)
            const insertion = operation === 'up'
              ? Math.min(...remainingNeighborIndexes)
              : Math.max(...remainingNeighborIndexes) + 1
            location.statements.splice(insertion, 0, ...moved)
            return
          }
        }
        const direction = operation === 'up' ? -1 : 1
        const otherIndex = location.index + direction
        if (otherIndex < 0 || otherIndex >= location.statements.length) return
        const other = location.statements[otherIndex]
        if (other?.kind === 'return' || statement.kind === 'return') throw new Error('返回语句必须保持在分支末尾。')
        if (operation === 'up' && statementReferences(statement, other?.id)) throw new Error('这条语句依赖上一行的输出，不能上移。')
        if (operation === 'down' && statementReferences(other, statement.id)) throw new Error('下一行使用了这条语句的输出，不能下移。')
        location.statements[location.index] = other
        location.statements[otherIndex] = statement
        return
      }
      throw new Error('不支持的语句操作。')
    })
  }

  /*
   * The sentence surface uses the same descriptor contract as the full
   * gameplay-module editor.  These small DOM helpers intentionally operate on
   * the descriptor's declared inputs and parameters; they do not interpret or
   * execute a graph and they leave unrecognised fields untouched.
   */
  const builtinSchemaLabels = Object.freeze({
    'author.piece-skill@1': '技能实例', 'author.piece-status@1': '状态实例',
    'author.piece-rule@1': '规则实例', 'author.piece-buff@1': '增益', 'author.piece-debuff@1': '减益',
    'author.piece-identity@1': '棋子身份', 'author.piece-snapshot-fields@1': '棋子字段副本',
    'author.piece-flow-state@1': '已存扩展变量', 'author.piece-instance@1': '棋子实例副本',
    'author.piece-display@1': '棋子显示选项', 'author.piece-display-audiences@1': '各方显示选项',
    'author.piece-display-plan@1': '棋子显示方案', 'author.piece-template@1': '棋子模板',
  })
  const typeLabel = type => {
    const labels = {
      number: '数值', boolean: '布尔值', string: '文本', piece: '棋子', player: '玩家',
      cell: '地格', path: '路径', card: '卡牌', content: '内容', status: '状态',
      event: '事件', choice: '选择', record: '记录', object: '对象', list: '元组', set: '集合',
      map: '映射', nullable: '可空值', enum: '选项', json: '任意数据', null: '空值', never: '空', unknown: '未知', any: '任意值', 'cluster-instance': '能力组实例', 'cluster-instances': '能力组实例列表',
    }
    if (record(type)) {
      if (type.kind === 'list') return `元组<${typeLabel(type.element)}>`
      if (type.kind === 'set') return `集合<${typeLabel(type.element)}>`
      if (type.kind === 'map') return `映射<${typeLabel(type.key)}, ${typeLabel(type.value)}>`
      if (type.kind === 'nullable') return `可空${typeLabel(type.value)}`
      if (type.kind === 'record') return builtinSchemaLabels[type.schema] || (type.schema ? '结构化记录' : '记录')
      return labels[type.kind] || '未知类型'
    }
    return labels[type] || '未知类型'
  }
  // A local declaration must carry a concrete value type. Keep this check
  // recursive so unresolved nested types cannot be serialized as a misleading
  // declaration and fail later in the compiler.
  const knownResultType = type => {
    if (!type || type === 'unknown' || type === 'any') return false
    if (!record(type)) return true
    if (type.kind === 'nullable') return knownResultType(type.value)
    if (type.kind === 'list' || type.kind === 'set') return knownResultType(type.element)
    if (type.kind === 'map') return knownResultType(type.key) && knownResultType(type.value)
    return type.kind !== 'unknown' && type.kind !== 'any'
  }
  const authorDomainLabel = domain => ({
    'card-instance': '手牌实例',
    'skill-instance': '技能实例',
    'rule-instance': '规则实例',
    'status-instance': '状态实例',
    'cluster-instance': '能力组实例',
    'tile-effect': '地格效果',
  })[domain] || ''
  function contextualTypeLabel(type, definition = null, descriptor = null, name = '') {
    const explicitDomain = definition?.domain || descriptor?.outputDomains?.[name]
    const domain = explicitDomain || (descriptor?.id === 'ref.current-cluster' && name === 'group' ? 'cluster-instance' : null)
      || (definition?.name === 'abilityGroup' ? 'cluster-instance' : null)
    return domain ? (authorDomainLabel(domain) || typeLabel(type)) : typeLabel(type)
  }
  const authoredValueLabel = value => authorDomainLabel(value?.domain) || (value ? typeLabel(value.type) : '未知')
  function portValueType(port) {
    const type = port?.type ?? port?.valueType ?? 'unknown'
    if (port?.nullable && !(record(type) && type.kind === 'nullable')) return { kind: 'nullable', value: type }
    return type
  }
  // Literal controls are recursive.  Named records resolve their fields from
  // the active graph; a generic record opens the shared object editor so an
  // author can choose a declared structure before entering fields.  Lists and
  // nullable values may contain any recursively editable literal type.
  const literalType = type => type === 'null' || ['number', 'boolean', 'string', 'json', 'any', 'unknown', 'record', 'object'].includes(type)
    || (record(type) && type.kind === 'record' && Boolean(type.schema))
    || (record(type) && type.kind === 'nullable' && literalType(type.value))
    || (record(type) && type.kind === 'list' && literalType(type.element))
    || (record(type) && type.kind === 'set' && literalType(type.element))
    || (record(type) && type.kind === 'map' && literalType(type.key) && literalType(type.value))
  const structuredLiteralType = type => type === 'record' || type === 'object' || type === 'json'
    || (record(type) && ['record', 'object', 'nullable', 'list', 'array', 'set', 'map'].includes(type.kind))
  const defaultForType = definition => {
    if (own(definition, 'default')) return clone(definition.default)
    if (Array.isArray(definition?.enum) && definition.enum.length) return clone(definition.enum[0])
    const type = portValueType(definition)
    if (record(type) && type.kind === 'nullable') return null
    if (type === 'boolean') return false
    if (type === 'number') return 0
    if (type === 'string') return ''
    if (type === 'json') return {}
    if (record(type) && type.kind === 'list') return []
    if (record(type) && type.kind === 'set') return { format: 'author-set/v1', items: [] }
    if (record(type) && type.kind === 'map') return { format: 'author-map/v1', entries: [] }
    return null
  }
  function defaultLiteralFor(definition, graph, depth = 0) {
    if (depth > 8) return null
    const type = portValueType(definition)
    if (record(type) && type.kind === 'nullable') return null
    if (record(type) && type.kind === 'record') {
      const schema = schemaForGraph(graph, type.schema)
      if (!schema) return null
      const value = {}
      // Start a newly selected record empty.  The shared object editor owns
      // field presence, so optional fields remain omitted until the author
      // explicitly chooses a value (including an explicit empty value).
      for (const field of Array.isArray(schema.fields) ? schema.fields : []) {
        if (own(field, 'default')) value[field.name] = clone(field.default)
      }
      return value
    }
    return defaultForType(definition)
  }
  const jsonValue = value => {
    try { return JSON.stringify(value) } catch { return '' }
  }
  const parseJsonValue = value => {
    try { return JSON.parse(value) } catch { return null }
  }
  const compatibleType = (source, target) => {
    if (!target || target === 'any' || target === 'unknown') return true
    if (!source || source === 'any' || source === 'unknown') return true
    if (source === target) return true
    // Native ports accept a nullable source; the compiler emits the same
    // null guard and skips the dependent call when it is absent.  Keep the
    // authoring picker aligned with that runtime contract.
    if (record(source) && source.kind === 'nullable') return compatibleType(source.value, target)
    if (target === 'null') return source === 'null'
    if (typeof target === 'string') {
      if (typeof source === 'string') return source === target
      if (source === 'never') return true
      return target === 'record' && record(source) && source.kind === 'record'
    }
    if (!record(target)) return false
    if (target.kind === 'nullable') {
      if (source === 'null') return true
      if (record(source) && source.kind === 'nullable') return compatibleType(source.value, target.value)
      return compatibleType(source, target.value)
    }
    if (target.kind === 'record') {
      if (source === 'record') return true
      if (!record(source) || source.kind !== 'record') return false
      const sourceSchema = String(source.schema || '')
      const targetSchema = String(target.schema || '')
      return sourceSchema === targetSchema
        || !targetSchema
        || !sourceSchema
        || (!sourceSchema.includes('@') && targetSchema.startsWith(sourceSchema + '@'))
        || (!targetSchema.includes('@') && sourceSchema.startsWith(targetSchema + '@'))
    }
    if (target.kind === 'list') {
      if (!record(source) || source.kind !== 'list') return false
      return source.element === 'never' || compatibleType(source.element, target.element)
    }
    if (target.kind === 'set') return record(source) && source.kind === 'set' && (source.element === 'never' || compatibleType(source.element, target.element))
    if (target.kind === 'map') return record(source) && source.kind === 'map' && compatibleType(source.key, target.key) && compatibleType(source.value, target.value)
    return false
  }
  const literalDisplay = value => {
    if (value === null || value === undefined) return '空值'
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (Array.isArray(value)) return value.map(literalDisplay).join('、') || '空列表'
    if (typeof value === 'object') {
      const count = Object.keys(value).length
      return count ? `结构化记录（${count} 个字段）` : '空记录'
    }
    const labels = {
      ...fieldLabels,
      enemy: '敌方', ally: '友方', all: '全部', normal: '普通', true: '真实', toxin: '毒素',
      attack: '攻击力', defense: '防御力', moveRange: '移动范围', currentHp: '当前生命', maxHp: '最大生命',
      name: '名称', faction: '阵营',
      physical: '物理', magical: '魔法', floor: '向下取整', flow: '流程输入', host: '宿主输入',
      public: '公开', owner: '所属玩家', allies: '友方', spectators: '观战者',
      piece: '棋子', player: '玩家', cell: '地格', card: '卡牌', record: '记录',
      'new-instance': '新建棋子', 'return-instance': '原实例回场', declaration: '使用当前内容声明',
      add: '增加', atLeast: '至少达到', teleport: '传送', summon: '召唤', dash: '冲刺', walk: '步行',
      push: '推动', pull: '拉拽', swap: '交换', current: '沿用当前归属', unattributed: '无技能归属',
      cleanup: '清理状态', preserve: '保留状态', numeric: '按数值', text: '按文本', locale: '按本地化文本',
      manhattan: '曼哈顿距离', chebyshev: '切比雪夫距离', undefined: '未定义',
      '==': '等于', '!=': '不等于', ascending: '升序', descending: '降序',
      enemies: '敌方', direct: '立即表现', queue: '统一表现队列', tileEffectAdded: '地格效果添加', tileEffectRemoved: '地格效果移除',
      live: '实时值', stored: '已保存值', single: '单选', multi: '多选',
      string: '文本', target: '目标', source: '来源',
      'floor-or-cover': '地面或掩体', walkable: '可通行', projectile: '弹道', any: '任意', 'lethal-toxin': '致命毒素',
    }
    return labels[value] || String(value)
  }

  // Enum values are serialized machine identifiers.  Keep those identifiers
  // in the graph while translating their author-facing meaning at the point
  // where the parameter gives the value its context.  Unknown values are
  // intentionally left alone so user-defined names remain recoverable.
  const enumValueLabels = Object.freeze({
    attribute: Object.freeze({ attack: '攻击力', defense: '防御力', moveRange: '移动范围' }),
    attribution: Object.freeze({ current: '沿用当前归属', unattributed: '无技能归属' }),
    audience: Object.freeze({ public: '公开', owner: '所属玩家', allies: '友方', enemies: '敌方', spectators: '观战者' }),
    comparison: Object.freeze({ numeric: '按数值', text: '按文本', locale: '按本地化文本' }),
    damageType: Object.freeze({ normal: '普通伤害', true: '真实伤害', toxin: '毒素伤害' }),
    entityKind: Object.freeze({ card: '卡牌实例', cluster: '能力组实例', rule: '规则实例', skill: '技能实例', status: '状态实例', 'tile-effect': '地格效果' }),
    filter: filterLabels,
    flowStatePolicy: Object.freeze({ cleanup: '清理状态', preserve: '保留状态' }),
    inputPolicy: Object.freeze({ floor: '向下取整', flow: '流程输入', host: '宿主输入' }),
    kind: Object.freeze({ teleport: '传送', summon: '召唤', dash: '冲刺', walk: '步行', push: '推动', pull: '拉拽', swap: '交换' }),
    legacyNormalSpelling: Object.freeze({ physical: '物理伤害', magical: '魔法伤害' }),
    metric: Object.freeze({ manhattan: '曼哈顿距离', chebyshev: '切比雪夫距离' }),
    missing: Object.freeze({ undefined: '未定义', null: '空值' }),
    mode: Object.freeze({ add: '增加', atLeast: '至少达到', 'new-instance': '新建棋子', 'return-instance': '原实例回场', declaration: '使用当前内容声明' }),
    operator: Object.freeze({ '==': '等于', '!=': '不等于' }),
    order: Object.freeze({ ascending: '升序', descending: '降序' }),
    ownerType: Object.freeze({ piece: '棋子', player: '玩家' }),
    presentationBatch: Object.freeze({ direct: '立即表现', queue: '统一表现队列', tileEffectAdded: '地格效果添加', tileEffectRemoved: '地格效果移除' }),
    relation: Object.freeze({ all: '全体', ally: '友方', enemy: '敌方' }),
    resource: Object.freeze({ actionPoints: '行动点', chargePoints: '充能点' }),
    scope: Object.freeze({ live: '实时值', stored: '已保存值' }),
    selectionMode: Object.freeze({ single: '单选', multi: '多选' }),
    sourceType: Object.freeze({ piece: '棋子来源', player: '玩家来源', card: '卡牌来源', record: '本次执行来源' }),
    targetType: Object.freeze({ piece: '棋子目标', record: '本次执行目标', string: '文本目标' }),
    terrain: Object.freeze({ walkable: '可通行', projectile: '弹道', any: '任意' }),
    terrainPolicy: Object.freeze({ 'floor-or-cover': '地面或掩体', walkable: '可通行地形' }),
    tileType: Object.freeze({ 'lethal-toxin': '致命毒素' }),
  })

  const typeParameterNames = new Set([
    'valueType', 'amountType', 'argsType', 'blockType', 'containerType', 'definitionType', 'destinationType',
    'displayType', 'extensionType', 'fieldsType', 'itemsType', 'keyType', 'keysType', 'optionsType',
    'payloadSchema', 'resultType', 'snapshotType', 'targetType', 'templateType', 'valuesType',
  ])

  function enumTypeDisplay(value, name) {
    if (!typeParameterNames.has(name)) return undefined
    const parsed = serializedValueType(value, undefined)
    if (parsed === undefined) return undefined
    if (name === 'targetType' && record(parsed) && parsed.kind === 'list' && parsed.element === 'piece') return '棋子目标列表'
    return typeLabel(parsed)
  }

  function enumValueDisplay(value, definition = {}) {
    const name = definition?.name
    const declared = !Array.isArray(definition?.enum) || definition.enum.some(item => item === value
      || (record(item) && record(value) && jsonValue(item) === jsonValue(value))
      || (typeof item === 'string' && record(value) && item === jsonValue(value)))
    if (!declared) return undefined
    if (name === 'field' || name === 'attribute') return fieldLabels[value]
    const labels = enumValueLabels[name]
    if (labels && Object.prototype.hasOwnProperty.call(labels, value)) return labels[value]
    if (name === 'targetType') {
      const parsed = serializedValueType(value, undefined)
      if (record(parsed) && parsed.kind === 'list' && parsed.element === 'piece') return '棋子目标列表'
    }
    const typed = enumTypeDisplay(value, name)
    if (typed) return typed
    return undefined
  }

  const movementKindLabels = Object.freeze({
    teleport: '传送',
    dash: '冲刺',
    walk: '步行',
    push: '推动',
    pull: '拉拽',
    swap: '交换',
  })
  const movementTerrainLabels = Object.freeze({
    walkable: '可通行',
    projectile: '弹道',
    any: '任意',
  })
  const enumContains = (definition, value) => Array.isArray(definition?.enum) && definition.enum.includes(value)
  const movementEnumDisplay = (value, definition) => {
    if (definition?.name === 'kind' && enumContains(definition, value)) return movementKindLabels[value]
    if (definition?.name === 'terrain' && enumContains(definition, value)) return movementTerrainLabels[value]
    return undefined
  }
  const enumLiteralDisplay = (value, definition) => {
    const declared = !Array.isArray(definition?.enum) || definition.enum.some(item => item === value
      || (record(item) && record(value) && jsonValue(item) === jsonValue(value))
      || (typeof item === 'string' && record(value) && item === jsonValue(value)))
    if (!declared) return String(value)
    const mapped = enumValueDisplay(value, definition)
    if (mapped) return mapped
    const movement = movementEnumDisplay(value, definition)
    if (movement) return movement
    if (definition?.name === 'kind' && (value === 'teleport' || value === 'summon')) return value === 'teleport' ? '传送' : '召唤'
    return literalDisplay(value)
  }

  function statementForId(graph, id, scopePath = []) {
    const search = statements => {
      for (const statement of Array.isArray(statements) ? statements : []) {
        if (statement?.id === id) return statement
        const nested = search(statement?.then) || search(statement?.else) || search(statement?.body)
        if (nested) return nested
        const condition = search(statement?.condition?.body)
        if (condition) return condition
      }
      return null
    }
    const scoped = scopeDefinition(graph, scopePath)
    const ownStatement = search(scoped.body)
    if (ownStatement) return ownStatement
    return null
  }

  // A reference made inside a branch may legally consume a declaration from
  // the branch's lexical parent.  Composite and continuation frames are
  // separate graph scopes, however, so walking past either frame would make
  // an unrelated declaration look visible.  Keep the fallback deliberately
  // narrow: only peel consecutive branch frames from the active path.
  function statementLocationForLexicalId(graph, id, scopePath = []) {
    const frames = Array.isArray(scopePath) ? scopePath : []
    for (let depth = frames.length; depth >= 0; depth -= 1) {
      if (depth < frames.length && frames[depth]?.kind !== 'branch') break
      const candidatePath = frames.slice(0, depth)
      const statement = statementForId(graph, id, candidatePath)
      if (statement) return { statement, scopePath: candidatePath }
    }
    return null
  }

  function statementForLexicalId(graph, id, scopePath = []) {
    return statementLocationForLexicalId(graph, id, scopePath)?.statement || null
  }

  function infixOperatorForValue(graph, value, scopePath = []) {
    if (!record(value) || value.kind !== 'output') return null
    const source = statementLocationForLexicalId(graph, value.node, scopePath)?.statement
    return source?.kind === 'call' ? (source.module === 'compare.values' ? source.parameters?.operator || '==' : expressionInfixOperators[source.module] || null) : null
  }

  function expressionOperandNeedsParentheses(graph, value, scopePath = []) {
    if (record(value) && value.kind === 'literal' && typeof value.value === 'number' && value.value < 0) return true
    return Boolean(infixOperatorForValue(graph, value, scopePath))
  }

  function updateStatementById(graph, id, mutate, scopePath = []) {
    const location = statementLocationForLexicalId(graph, id, scopePath)
    if (!location?.statement) return false
    // The second argument is the owning graph root. Existing mutators only
    // use the statement; structural record editors use the root to persist a
    // shared schema declaration when one is selected.
    mutate(location.statement, graph)
    return true
  }

  // The authoring surface works with the same flat-call IR as the compiler.
  // A nested expression is therefore represented by a pure call inserted in
  // the lexical statement list immediately before the consumer.  These
  // helpers keep that insertion scoped to the owning branch instead of
  // flattening every output in the graph (which would make invalid cycles and
  // cross-branch references look editable).
  function statementLocation(graph, id, scopePath = []) {
    const visit = (statements, owner, branch, rootKind = 'body') => {
      if (!Array.isArray(statements)) return null
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index]
        if (!record(statement)) continue
        if (statement.id === id) return { statements, index, statement, owner, branch, rootKind }
        for (const nested of [
          ['then', statement.then], ['else', statement.else], ['body', statement.body],
          ['condition.body', statement.condition?.body],
        ]) {
          const found = visit(nested[1], statement, nested[0], nested[0] === 'condition.body' ? 'condition' : 'body')
          if (found) return found
        }
      }
      return null
    }
    const scoped = scopeDefinition(graph, scopePath)
    const found = visit(scoped.body, null, scopePath.length ? 'scoped' : 'root')
    if (found) return found
    return null
  }

  function statementArrayFor(graph, target, scopePath = []) {
    if (!target || target.kind === 'root' || target.branch === 'root') return scopeDefinition(graph, scopePath, true).body || null
    const parent = statementForId(graph, target.parentId || target.ownerId, scopePath)
    if (!parent) return null
    if (target.branch === 'condition.body') {
      if (Array.isArray(parent.condition?.body)) return parent.condition.body
      if (parent.kind === 'while') { parent.condition = { ...(parent.condition || {}), body: [] }; return parent.condition.body }
      return null
    }
    if (target.branch && Array.isArray(parent[target.branch])) return parent[target.branch]
    if (target.branch === 'else' && parent.kind === 'if') { parent.else = []; return parent.else }
    if (target.branch === 'body' && ['foreach', 'while', 'collection'].includes(parent.kind)) { parent.body = []; return parent.body }
    return null
  }

  function extensionMapDeclaration(statement) {
    if (!record(statement) || statement.kind !== 'call' || statement.module !== 'extension.map-declare') return null
    const parameters = statement.parameters || {}
    const namespace = typeof parameters.namespace === 'string' && parameters.namespace.trim() ? parameters.namespace.trim() : 'content'
    const name = typeof parameters.name === 'string' ? parameters.name.trim() : ''
    const schema = typeof parameters.schema === 'string' ? parameters.schema.trim() : ''
    const keyField = typeof parameters.keyField === 'string' ? parameters.keyField.trim() : ''
    if (!namespace || !name || !schema || !keyField) return null
    return { kind: 'map', namespace, name, schema, keyField, statementId: statement.id || '' }
  }

  function extensionValueDeclaration(statement) {
    if (!record(statement) || statement.kind !== 'call') return null
    const match = /^extension\.declare-(player|piece|battle|instance)$/.exec(statement.module || '')
    if (!match) return null
    const parameters = statement.parameters || {}
    const namespace = typeof parameters.namespace === 'string' && parameters.namespace.trim() ? parameters.namespace.trim() : 'content'
    const name = typeof parameters.name === 'string' ? parameters.name.trim() : ''
    const valueType = typeof parameters.valueType === 'string' ? parameters.valueType.trim() : ''
    if (!namespace || !name) return null
    const scope = match[1] === 'instance' && typeof parameters.entityKind === 'string' ? parameters.entityKind.trim() : match[1]
    if (!scope) return null
    return { kind: 'value', scope, namespace, name, valueType, statementId: statement.id || '' }
  }

  // Instance extension descriptors deliberately use one entity input rather
  // than one descriptor per host domain.  Keep the domain inference local to
  // the sentence projection so the graph/compiler still receives the explicit
  // entityKind parameter it requires, while authors never have to select a
  // duplicate kind field by hand.
  function entityKindForValue(graph, value, scopePath = [], trail = new Set()) {
    if (!record(value) || value.kind !== 'output' || !value.node || trail.has(value.node)) return null
    const location = statementLocationForLexicalId(graph, value.node, scopePath)
    const source = location?.statement
    if (!source) return null
    const nextTrail = new Set(trail); nextTrail.add(value.node)
    if (source.kind === 'call') {
      const direct = {
        'ref.current-skill': 'skill',
        'ref.current-card': 'card',
        'ref.current-rule': 'rule',
        'ref.current-cluster': 'cluster',
        'card.instance-reference': 'card',
        'status.find-instance': 'status',
      }[source.module]
      if (direct) return direct
      if (source.module === 'local.declare') return entityKindForValue(graph, source.inputs?.initial, location.scopePath || scopePath, nextTrail)
      if (source.module === 'local.read') return entityKindForValue(graph, source.inputs?.handle, location.scopePath || scopePath, nextTrail)
      if (source.module === 'author.cluster.acquire' && value.port === 'group') return 'cluster'
      if (source.module === 'author.cluster.list' && value.port === 'groups') return 'cluster'
      if (['status.query-instances', 'status.instances', 'status.instances-by-id'].includes(source.module) && value.port === 'statuses') return 'status'
      if (['skill.instances', 'skill.list-instances'].includes(source.module) && ['instances', 'skills'].includes(value.port)) return 'skill'
      if (['card.hand-instances', 'query.hand-card-instances'].includes(source.module) && ['instances', 'cards'].includes(value.port)) return 'card'
      if (source.module === 'cell.field' && source.parameters?.field === 'tileEffects' && value.port === 'value') return 'tile-effect'
      if (['collection.find', 'collection.filter', 'collection.at', 'collection.random', 'collection.reverse', 'collection.sort', 'collection.slice'].includes(source.module)) {
        return entityKindForValue(graph, source.inputs?.items, location.scopePath || scopePath, nextTrail)
      }
    }
    if (source.kind === 'foreach') return entityKindForValue(graph, source.items, location.scopePath || scopePath, nextTrail)
    if (source.kind === 'collection' || source.kind?.startsWith?.('collection.')) {
      if (source.method === 'map' || source.kind === 'collection.map') return null
      return entityKindForValue(graph, source.items, location.scopePath || scopePath, nextTrail)
    }
    return null
  }

  function collectExtensionMapDeclarations(statements, result) {
    for (const statement of Array.isArray(statements) ? statements : []) {
      const declaration = extensionMapDeclaration(statement) || extensionValueDeclaration(statement)
      if (declaration) result.push(declaration)
    }
    return result
  }

  // Extension variables are lexical authoring data. A declaration in a
  // sibling branch must not make a map operation appear in this branch, while
  // declarations in an enclosing scope remain visible to its descendants.
  function extensionMapDeclarations(graph, scopePath = [], beforeStatementId = null) {
    const result = []
    let current = graph
    let body = Array.isArray(graph?.body) ? graph.body : []
    for (const frame of Array.isArray(scopePath) ? scopePath : []) {
      if (!record(current)) break
      if (frame.kind === 'composite') {
        current = (Array.isArray(current.composites) ? current.composites : []).find(item => item?.id === frame.id && (!frame.version || item.version === frame.version)) || null
        body = Array.isArray(current?.body) ? current.body : []
        continue
      }
      if (frame.kind === 'continuation') {
        const definition = (Array.isArray(current.continuations) ? current.continuations : []).find(item => item?.id === frame.id && (!frame.version || item.version === frame.version))
        current = definition?.graph || null
        body = Array.isArray(current?.body) ? current.body : []
        continue
      }
      if (frame.kind !== 'branch') continue
      const ownerIndex = body.findIndex(statement => statement?.id === frame.parentId)
      if (ownerIndex < 0) return result
      collectExtensionMapDeclarations(body.slice(0, ownerIndex), result)
      const owner = body[ownerIndex]
      if (frame.branch === 'condition.body') body = Array.isArray(owner?.condition?.body) ? owner.condition.body : []
      else body = Array.isArray(owner?.[frame.branch]) ? owner[frame.branch] : []
    }
    const beforeIndex = beforeStatementId ? body.findIndex(statement => statement?.id === beforeStatementId) : -1
    collectExtensionMapDeclarations(beforeIndex >= 0 ? body.slice(0, beforeIndex) : body, result)
    const seen = new Set()
    return result.filter(item => {
      const key = `${item.kind}\u0000${item.scope || ''}\u0000${item.namespace}\u0000${item.name}\u0000${item.schema || ''}\u0000${item.keyField || ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  function directValueReferences(value, nodeId, result = []) {
    if (!record(value)) return result
    if (value.kind === 'output' && value.node === nodeId) result.push(value)
    return result
  }

  function statementReferences(statement, nodeId) {
    if (!record(statement)) return false
    const values = []
    const collect = value => directValueReferences(value, nodeId, values)
    if (statement.kind === 'call') Object.values(statement.inputs || {}).forEach(collect)
    else if (statement.kind === 'if') collect(statement.condition)
    else if (statement.kind === 'foreach') collect(statement.items)
    else if (statement.kind === 'while') {
      Object.values(statement.condition?.inputs || {}).forEach(collect)
    } else if (statement.kind === 'return') {
      collect(statement.value); Object.values(statement.values || {}).forEach(collect)
    } else if (statement.kind === 'record.create') Object.values(statement.fields || {}).forEach(collect)
    else if (statement.kind === 'record.get' || statement.kind === 'record.with') {
      collect(statement.record); Object.values(statement.fields || {}).forEach(collect)
    } else if (statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) {
      collect(statement.items); Object.values(statement.inputs || {}).forEach(collect); collect(statement.initial)
    } else if (statement.kind === 'defer-choice') {
      for (const key of ['payload', 'player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message']) collect(statement[key])
    }
    return values.length > 0
  }

  function remapValue(value, idMap) {
    if (!record(value) || value.kind !== 'output' || !idMap.has(value.node)) return value
    return { ...value, node: idMap.get(value.node) }
  }

  function remapStatementIds(statement, idMap, graph) {
    if (!record(statement)) return statement
    const next = clone(statement)
    const originalId = next.id
    if (originalId) {
      const newId = idMap.get(originalId) || nextStatementId(graph, `copy-${originalId}`)
      idMap.set(originalId, newId)
      next.id = newId
    }
    if (record(next.layout?.sentenceExpression)) {
      const owner = next.layout.sentenceExpression.owner
      if (idMap.has(owner)) next.layout.sentenceExpression.owner = idMap.get(owner)
      else delete next.layout.sentenceExpression
    }
    if (record(next.layout?.authorExpression)) {
      const owner = next.layout.authorExpression.owner
      if (idMap.has(owner)) next.layout.authorExpression.owner = idMap.get(owner)
      else delete next.layout.authorExpression
    }
    if (record(next.layout?.authorExpressions)) for (const expression of Object.values(next.layout.authorExpressions)) {
      expression.value = remapValue(expression.value, idMap)
      expression.nodes = (expression.nodes || []).map(id => idMap.get(id) || id)
    }
    if (record(next.layout?.authorStatement)) {
      next.layout.authorStatement = {
        ...next.layout.authorStatement,
        generatedIds: Array.isArray(next.layout.authorStatement.generatedIds)
          ? next.layout.authorStatement.generatedIds.map(id => idMap.get(id) || id)
          : next.layout.authorStatement.generatedIds,
      }
    }
    const remapBody = body => Array.isArray(body) ? body.map(item => remapStatementIds(item, idMap, graph)) : body
    if (next.kind === 'call') next.inputs = Object.fromEntries(Object.entries(next.inputs || {}).map(([key, value]) => [key, remapValue(value, idMap)]))
    if (next.kind === 'if') { next.condition = remapValue(next.condition, idMap); next.then = remapBody(next.then); if (next.else) next.else = remapBody(next.else) }
    if (next.kind === 'foreach') { next.items = remapValue(next.items, idMap); next.body = remapBody(next.body) }
    if (next.kind === 'while') {
      next.condition = { ...(next.condition || {}), inputs: Object.fromEntries(Object.entries(next.condition?.inputs || {}).map(([key, value]) => [key, remapValue(value, idMap)])), body: remapBody(next.condition?.body) }
      next.body = remapBody(next.body)
    }
    if (next.kind === 'return') { if (next.value) next.value = remapValue(next.value, idMap); if (next.values) next.values = Object.fromEntries(Object.entries(next.values).map(([key, value]) => [key, remapValue(value, idMap)])) }
    if (next.kind === 'record.create') next.fields = Object.fromEntries(Object.entries(next.fields || {}).map(([key, value]) => [key, remapValue(value, idMap)]))
    if (next.kind === 'record.get' || next.kind === 'record.with') { next.record = remapValue(next.record, idMap); if (next.fields) next.fields = Object.fromEntries(Object.entries(next.fields).map(([key, value]) => [key, remapValue(value, idMap)])) }
    if (next.kind === 'collection' || next.kind?.startsWith?.('collection.')) {
      next.items = remapValue(next.items, idMap); if (next.inputs) next.inputs = Object.fromEntries(Object.entries(next.inputs).map(([key, value]) => [key, remapValue(value, idMap)])); if (next.initial) next.initial = remapValue(next.initial, idMap); next.body = remapBody(next.body)
    }
    if (next.kind === 'defer-choice') for (const key of ['payload', 'player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message']) if (next[key]) next[key] = remapValue(next[key], idMap)
    return next
  }

  function pureDescriptor(descriptor) {
    const effects = descriptor?.effects || {}
    return Boolean(descriptor) && effects.pure === true && effects.random !== true && effects.pending !== true
      && !((effects.writes || []).length) && !((effects.events || []).length)
  }

  // Legacy production graphs predate sentence-expression ownership metadata.
  // Their pure reads and calculations are still ordinary executable calls, so
  // project a consumed call into the value slot that uses it.  A named output
  // or an explicit declaration is an authoring choice and remains a visible
  // step; the projection only removes implementation-only intermediates.
  function isProjectedPureCall(core, graph, statement, scopePath = []) {
    if (!record(statement) || statement.kind !== 'call') return false
    if (statement.module === 'local.declare' || statement.module === 'local.read') return false
    if (Object.values(statement.layout?.resultNames || {}).some(value => typeof value === 'string' && value.trim())) return false
    if (Object.values(statement.layout?.resultVariables || {}).some(value => (typeof value === 'string' ? value : value?.name)?.trim())) return false
    const descriptor = descriptorForGraphStatement(core, graph, statement, scopePath)
    return pureDescriptor(descriptor) && graphUsesAnyOutput(graph, new Set([statement.id]), scopePath)
  }

  // Saving a result creates an executable local handle immediately after the
  // producer. The handle is part of the graph's runtime IR, while the
  // producer row owns the author-facing result. Keep the relationship
  // explicit so a hand-authored local.declare remains visible. A link only
  // counts as generated when the producer still exposes the saved port and
  // its current type still accepts the declaration's value type. This keeps
  // old/stale declarations visible instead of hiding a broken association.
  function resultBindingValidation(core, graph, producer, port, binding, scopePath = []) {
    if (!record(binding) || typeof binding.declarationId !== 'string') {
      return { valid: false, reason: '缺少关联的局部变量声明' }
    }
    const declaration = statementLocationForLexicalId(graph, binding.declarationId, scopePath)?.statement
    if (declaration?.kind !== 'call' || declaration.module !== 'local.declare') {
      return { valid: false, reason: '关联的局部变量声明不存在' }
    }
    const initial = declaration.inputs?.initial
    if (initial?.kind !== 'output' || initial.node !== producer?.id || initial.port !== port) {
      return { valid: false, reason: '关联的初始返回值已变化' }
    }
    if (binding.name && binding.name !== declaration.parameters?.name) {
      return { valid: false, reason: '关联的变量名已变化' }
    }

    let output = null
    let outputType = null
    if (producer?.kind === 'call') {
      const descriptor = descriptorForGraphStatement(core, graph, producer, scopePath)
      output = (Array.isArray(descriptor?.outputs) ? descriptor.outputs : []).find(item => item?.name === port) || null
      if (!output) return { valid: false, reason: '返回端口已不存在', declaration }
      outputType = outputValueType(core, graph, { kind: 'output', node: producer.id, port }, scopePath)
        || descriptorOutputType(descriptor, port, producer, input => outputValueType(core, graph, input, scopePath))
    } else if (['record.create', 'record.get', 'record.with'].includes(producer?.kind) && port === 'value') {
      output = { name: 'value' }
      outputType = producer.kind === 'record.create'
        ? { kind: 'record', schema: producer.schema }
        : producer.kind === 'record.get'
          ? (recordFieldType(core, graph, producer.record, producer.field, scopePath) || 'unknown')
          : (recordSchemaType(core, graph, producer.record, new Set(), scopePath) || 'unknown')
    } else {
      return { valid: false, reason: '结果来源已不再提供该返回端口', declaration }
    }

    const declaredType = serializedValueType(declaration.parameters?.valueType ?? binding.valueType, null)
    if (knownResultType(outputType) && knownResultType(declaredType) && !compatibleType(outputType, declaredType)) {
      return { valid: false, reason: '返回类型已变化', declaration, output, outputType, declaredType }
    }
    return { valid: true, declaration, output, outputType, declaredType }
  }

  function resultBindingDeclaration(core, graph, statement, scopePath = []) {
    if (statement?.kind !== 'call' || statement.module !== 'local.declare') return null
    const initial = statement.inputs?.initial
    if (initial?.kind !== 'output' || !initial.node || !initial.port) return null
    const producerLocation = statementLocationForLexicalId(graph, initial.node, scopePath)
    const producer = producerLocation?.statement
    if (!producer) return null
    const binding = producer.layout?.resultVariables?.[initial.port]
    if (!record(binding) || binding.declarationId !== statement.id) return null
    const validation = resultBindingValidation(core, graph, producer, initial.port, binding, producerLocation?.scopePath || scopePath)
    if (!validation.valid) return null
    return { producer, binding, output: validation.output, outputType: validation.outputType }
  }

  function invalidResultBindingEntries(core, graph, statement, scopePath = []) {
    const resultVariables = statement?.layout?.resultVariables
    if (!record(resultVariables)) return []
    return Object.entries(resultVariables)
      .filter(([, binding]) => record(binding) && typeof binding.declarationId === 'string')
      .map(([port, binding]) => ({ port, binding, validation: resultBindingValidation(core, graph, statement, port, binding, scopePath) }))
      .filter(item => !item.validation.valid)
  }

  function resultBindingGroupIds(core, graph, statement, scopePath = []) {
    const ids = new Set(statement?.id ? [statement.id] : [])
    const linkedDeclaration = resultBindingDeclaration(core, graph, statement, scopePath)
    if (linkedDeclaration?.producer?.id) ids.add(linkedDeclaration.producer.id)
    const resultVariables = statement?.layout?.resultVariables
    if (!record(resultVariables)) return ids
    for (const binding of Object.values(resultVariables)) {
      if (!record(binding) || typeof binding.declarationId !== 'string') continue
      const declaration = statementLocationForLexicalId(graph, binding.declarationId, scopePath)?.statement
      const linked = resultBindingDeclaration(core, graph, declaration, scopePath)
      if (linked?.producer?.id === statement.id) ids.add(declaration.id)
    }
    return ids
  }

  function schemaBoundType(baseType, binding, statement) {
    const reference = binding?.parameter ? statement?.parameters?.[binding.parameter] : null
    if (typeof reference !== 'string' || !reference.trim()) return baseType
    const recordType = { kind: 'record', schema: reference }
    const boundType = binding.list ? { kind: 'list', element: recordType } : recordType
    if (record(baseType) && baseType.kind === 'nullable') return { kind: 'nullable', value: boundType }
    return boundType
  }

  function serializedValueType(value, fallback) {
    if (record(value)) return value
    if (typeof value !== 'string') return fallback
    const text = value.trim()
    if (!text) return fallback
    if (text[0] === '{' || text[0] === '[') {
      try {
        const parsed = JSON.parse(text)
        return parsed || fallback
      } catch { return fallback }
    }
    return ['number', 'boolean', 'string', 'piece', 'player', 'cell', 'path', 'card', 'content', 'status', 'event', 'choice', 'record', 'null', 'any', 'unknown'].includes(text)
      ? text
      : fallback
  }

  function valueTypeBoundType(baseType, binding, statement, parameter) {
    const value = binding?.parameter
      ? (own(statement?.parameters || {}, binding.parameter) ? statement.parameters[binding.parameter] : parameter?.default)
      : undefined
    return value === undefined ? baseType : serializedValueType(value, baseType)
  }

  function descriptorOutputType(descriptor, outputName, statement, resolveInputType = null) {
    const output = descriptor?.outputs?.find(item => item.name === outputName)
      || descriptor?.outputs?.find(item => !item.optional)
      || descriptor?.outputs?.[0]
    let type = portValueType(output)
    const typeBinding = descriptor?.outputTypeBindings?.[output?.name || outputName]
    if (typeBinding) {
      const source = descriptor?.inputs?.find(item => item.name === typeBinding.input)
      const supplied = resolveInputType && own(statement?.inputs || {}, typeBinding.input)
        ? resolveInputType(statement.inputs[typeBinding.input])
        : null
      const sourceType = supplied || portValueType(source)
      const listType = record(sourceType) && sourceType.kind === 'nullable' ? sourceType.value : sourceType
      type = typeBinding.projection === 'element' ? (record(listType) && listType.kind === 'list' ? listType.element : 'unknown') : typeBinding.projection === 'singleton' ? { kind: 'list', element: descriptorInputType(descriptor, typeBinding.input, statement) } : sourceType
      if (output?.nullable && type?.kind !== 'nullable') type = { kind: 'nullable', value: type }
    }
    type = schemaBoundType(type, descriptor?.outputSchemaBindings?.[output?.name || outputName], statement)
    const parameterBinding = descriptor?.outputParameterTypeBindings?.[output?.name || outputName]
    if (parameterBinding) {
      const key = statement?.parameters?.[parameterBinding.parameter]
        ?? descriptor?.parameters?.find(item => item.name === parameterBinding.parameter)?.default
      type = parameterBinding.types?.[key] || 'unknown'
    }
    const valueBinding = descriptor?.outputValueTypeBindings?.[output?.name || outputName]
    return valueTypeBoundType(type, valueBinding, statement, descriptor?.parameters?.find(item => item.name === valueBinding?.parameter))
  }

  function descriptorInputType(descriptor, inputName, statement) {
    const input = descriptor?.inputs?.find(item => item.name === inputName)
    const type = schemaBoundType(portValueType(input), descriptor?.inputSchemaBindings?.[input?.name || inputName], statement)
    const valueBinding = descriptor?.inputValueTypeBindings?.[input?.name || inputName]
    const bound = valueTypeBoundType(type, valueBinding, statement, descriptor?.parameters?.find(item => item.name === valueBinding?.parameter))
    return valueBinding?.nullable && bound?.kind !== 'nullable' ? { kind: 'nullable', value: bound } : bound
  }

  function descriptorInputDefinition(descriptor, input, statement) {
    if (!input) return input
    const type = descriptorInputType(descriptor, input.name, statement)
    return type === portValueType(input) ? input : { ...input, type, nullable: false }
  }

  function outputLabel(descriptor, port) {
    const output = descriptor?.outputs?.find(item => item.name === port)
    return semanticSlotLabel(output, port) || '结果'
  }

  function outputValueType(core, graph, value, scopePath = [], trail = new Set()) {
    if (!record(value)) return null
    if (value.kind === 'literal') return literalTypeOfValue(value.value)
    if (value.kind === 'input') {
      const scopedGraph = scopeDefinition(graph, scopePath).graph || graph
      return portValueType(scopedGraph?.inputs?.find(item => item.name === value.name)) || null
    }
    if (value.kind === 'output') {
      if (!value.node || trail.has(value.node)) return null
      const sourceLocation = statementLocationForLexicalId(graph, value.node, scopePath)
      const source = sourceLocation?.statement
      const sourceScopePath = sourceLocation?.scopePath || scopePath
      const nextTrail = new Set(trail); nextTrail.add(value.node)
      if (source?.kind === 'call') return descriptorOutputType(descriptorForGraphStatement(core, graph, source, sourceScopePath), value.port, source, input => outputValueType(core, graph, input, sourceScopePath, nextTrail))
      if (source?.kind === 'foreach' && value.port === 'item') return listElementType(outputValueType(core, graph, source.items, sourceScopePath, nextTrail))
      if ((source?.kind === 'foreach' || source?.kind === 'while') && value.port === 'index') return 'number'
      if (source?.kind === 'record.create') return { kind: 'record', schema: source.schema }
      if (source?.kind === 'record.with') return recordSchemaType(core, graph, source.record, nextTrail, sourceScopePath)
      if (source?.kind === 'record.get') return recordFieldType(core, graph, source.record, source.field, sourceScopePath) || 'unknown'
      if (source?.kind === 'collection' || source?.kind?.startsWith?.('collection.')) return collectionOutputType(core, graph, source, sourceScopePath, nextTrail)
    }
    return null
  }

  function literalTypeOfValue(value) {
    if (typeof value === 'number') return 'number'
    if (typeof value === 'boolean') return 'boolean'
    if (typeof value === 'string') return 'string'
    if (Array.isArray(value)) return { kind: 'list', element: value.length ? literalTypeOfValue(value[0]) : 'unknown' }
    if (value === null || value === undefined) return 'null'
    return 'record'
  }

  function listElementType(type) { return record(type) && type.kind === 'list' ? type.element : null }

  function schemaForGraph(graph, reference) {
    if (!reference) return null
    return (Array.isArray(graph?.schemas) ? graph.schemas : []).find(schema => schema?.id === reference || `${schema?.id}@${schema?.version}` === reference) || null
  }

  // These are the shared author schemas whose string fields are content
  // references.  The mapping is deliberately schema-scoped so an ordinary
  // author string named `id`, `rules`, or `templateId` remains a normal text
  // value in a custom record.
  const authorReferenceFields = Object.freeze({
    'author.piece-template@1': Object.freeze({ templateId: 'pieces', rules: 'rules' }),
    'author.piece-skill@1': Object.freeze({ skillId: 'skills', abilityGroupIds: 'clusters' }),
    'author.piece-status@1': Object.freeze({ id: 'statusTags', relatedRules: 'rules' }),
    'author.piece-rule@1': Object.freeze({ id: 'rules' }),
    'author.piece-identity@1': Object.freeze({ templateId: 'pieces' }),
    'author.piece-snapshot-fields@1': Object.freeze({ templateId: 'pieces' }),
    'author.piece-display@1': Object.freeze({ templateId: 'pieces' }),
  })

  function authorContentReference(field, path, context = {}) {
    void path
    const schema = String(context.schema || '')
    const candidates = [schema, schema && !schema.includes('@') ? `${schema}@1` : '']
    const declared = field?.referenceCollection || field?.contentCollection
    const collection = (typeof declared === 'string' && declared.trim())
      ? declared.trim()
      : candidates.map(reference => authorReferenceFields[reference]?.[field?.name]).find(Boolean)
    return collection ? { collection } : null
  }

  function authorReferenceSourceHasData(source) {
    if (source instanceof Map) return source.size > 0
    if (Array.isArray(source)) return source.length > 0
    if (!record(source)) return false
    if (['id', 'ruleId', 'skillId', 'statusId', 'templateId', 'clusterId', 'cardId', 'contentId']
      .some(key => typeof source[key] === 'string' && source[key].trim())) return true
    for (const key of ['items', 'rawItems', 'documents', 'dataMap', 'entries']) {
      if (source[key] !== undefined && authorReferenceSourceHasData(source[key])) return true
    }
    return Object.keys(source).length > 0
  }

  function authorReferenceCatalog(catalog) {
    if (!record(catalog)) return catalog
    const aliases = ['statusTags', 'statuses', 'status-effects']
    const existingAliases = aliases.filter(key => Object.prototype.hasOwnProperty.call(catalog, key))
    if (existingAliases.length) {
      // Prefer an explicitly supplied canonical collection, but do not let an
      // empty placeholder hide a populated legacy alias from an older shell.
      const preferred = existingAliases.find(key => authorReferenceSourceHasData(catalog[key])) || existingAliases[0]
      return preferred === 'statusTags' ? catalog : { ...catalog, statusTags: catalog[preferred] }
    }
    const statusTags = []
    const seen = new Set()
    for (const collection of ['skills', 'pieces']) {
      const source = catalog[collection]
      const documents = Array.isArray(source) ? source : record(source) ? Object.values(source) : []
      for (const document of documents) {
        if (!record(document)) continue
        const values = [document.statusTag, document.initialStatusTags, document.statusTags]
        for (const value of values) {
          const items = Array.isArray(value) ? value : record(value) ? [value] : []
          for (const item of items) {
            if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) continue
            seen.add(item.id); statusTags.push(item)
          }
        }
      }
    }
    return { ...catalog, statusTags }
  }

  function authorReferenceCollectionSource(catalog, collection) {
    if (!record(catalog)) return undefined
    const requested = String(collection || '').trim()
    const aliases = requested === 'statusTags' ? ['statusTags', 'statuses', 'status-effects']
      : requested === 'clusters' || requested === 'cluster' ? ['clusters', 'cluster']
        : [requested]
    const values = aliases.map(key => catalog[key]).filter(value => value !== undefined)
    return values.find(authorReferenceSourceHasData) || values[0]
  }

  // The editor shell normally supplies an ID map, while tests, embedded
  // panels, and older shells may expose arrays or {items/dataMap/entries}.
  // Resolve all of those shapes here without changing the serialized value.
  function authorReferenceEntries(catalog, collection) {
    const source = authorReferenceCollectionSource(catalog, collection)
    if (source === undefined) return []
    const entries = []
    const seen = new Set()
    const add = (candidate, fallbackId = '') => {
      if (typeof candidate === 'string' && candidate.trim()) candidate = { id: candidate.trim() }
      if (!record(candidate)) return
      const id = [candidate.id, candidate.ruleId, candidate.skillId, candidate.statusId,
        candidate.templateId, candidate.clusterId, candidate.cardId, candidate.contentId]
        .find(item => typeof item === 'string' && item.trim()) || fallbackId
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) return
      seen.add(id)
      const label = [candidate.name, candidate.title, candidate.label, candidate.displayName]
        .find(item => typeof item === 'string' && item.trim()) || ''
      entries.push({ id, label: String(label).trim() })
    }
    const visit = (value, fallbackId = '') => {
      if (value instanceof Map) { value.forEach((item, id) => visit(item, String(id))); return }
      if (Array.isArray(value)) { value.forEach(item => visit(item)); return }
      if (!record(value)) return
      let expanded = false
      for (const key of ['items', 'rawItems', 'documents']) {
        if (value[key] !== undefined) { visit(value[key]); expanded = true }
      }
      for (const key of ['dataMap', 'entries']) {
        if (value[key] !== undefined) { visit(value[key]); expanded = true }
      }
      if (typeof value.id === 'string' || typeof value.ruleId === 'string' || typeof value.skillId === 'string'
        || typeof value.templateId === 'string' || typeof value.clusterId === 'string' || typeof value.cardId === 'string') {
        add(value, fallbackId); expanded = true
      }
      if (!expanded) Object.entries(value).forEach(([id, item]) => add(item, id))
    }
    visit(source)
    return entries
  }

  function authorReferenceValueInfo(value, collection, catalog) {
    if (Array.isArray(value)) {
      if (!value.length) return { text: '空列表', missing: false, raw: value }
      const parts = value.map(item => authorReferenceValueInfo(item, collection, catalog))
      if (parts.some(item => !item)) return null
      return {
        text: parts.map(item => item.text).join('、'),
        missing: parts.some(item => item.missing),
        raw: value,
      }
    }
    const raw = record(value)
      ? [value.id, value.ruleId, value.skillId, value.statusId, value.templateId, value.clusterId, value.cardId, value.contentId].find(item => typeof item === 'string' && item.trim())
      : value
    if (typeof raw !== 'string' || !raw.trim()) return null
    const entry = authorReferenceEntries(catalog, collection).find(item => item.id === raw)
    if (!entry) return { text: '未找到引用', missing: true, raw }
    const collectionLabels = { pieces: '棋子模板', skills: '技能', rules: '规则', statusTags: '状态', clusters: '能力组', cards: '卡牌' }
    return { text: entry.label || `未命名${collectionLabels[collection] || '内容'}`, missing: false, raw }
  }

  function recordSchemaType(core, graph, value, trail = new Set(), scopePath = []) {
    if (!record(value)) return null
    if (value.kind === 'input') {
      const scopedGraph = scopeDefinition(graph, scopePath).graph || graph
      const input = (Array.isArray(scopedGraph?.inputs) ? scopedGraph.inputs : []).find(item => item?.name === value.name)
      const type = portValueType(input)
      return record(type) && type.kind === 'record' ? type : null
    }
    if (value.kind !== 'output' || !value.node || trail.has(value.node)) return null
    const sourceLocation = statementLocationForLexicalId(graph, value.node, scopePath)
    const source = sourceLocation?.statement
    const sourceScopePath = sourceLocation?.scopePath || scopePath
    if (!source) return null
    const nextTrail = new Set(trail); nextTrail.add(value.node)
    if (source.kind === 'record.create') return { kind: 'record', schema: source.schema }
    if (source.kind === 'record.with') return recordSchemaType(core, graph, source.record, nextTrail, sourceScopePath)
    // A record.get can itself return a structured record (for example the
    // snapshot fields inside a copied piece). Preserve that schema while
    // walking a chain of field reads so the next record.get exposes the
    // shared field definitions in the author editor.
    if (source.kind === 'record.get') {
      const fieldType = recordFieldType(core, graph, source.record, source.field, sourceScopePath)
      return record(fieldType) && fieldType.kind === 'record' ? fieldType : null
    }
    if (source.kind === 'call') {
      const type = descriptorOutputType(descriptorForGraphStatement(core, graph, source, sourceScopePath), value.port, source, input => outputValueType(core, graph, input, sourceScopePath, new Set(nextTrail)))
      return record(type) && type.kind === 'record' ? type : null
    }
    return null
  }

  function recordFieldType(core, graph, value, fieldName, scopePath = []) {
    const type = recordSchemaType(core, graph, value, new Set(), scopePath)
    const schema = schemaForGraph(graphWithAuthorSchemas(core, schemaGraphForScope(graph, scopePath)), type?.schema)
    const field = schema?.fields?.find(item => item?.name === fieldName)
    if (!field) return null
    return field.nullable ? { kind: 'nullable', value: field.type || 'unknown' } : (field.type || 'unknown')
  }

  function collectionReturnTypes(core, graph, statements, trail = new Set(), scopePath = []) {
    const types = []
    for (const statement of Array.isArray(statements) ? statements : []) {
      if (!record(statement)) continue
      if (statement.kind === 'return') {
        const value = statement.value || statement.values?.value
        if (value) types.push(outputValueType(core, graph, value, scopePath, trail) || 'unknown')
      } else if (statement.kind === 'if') {
        types.push(...collectionReturnTypes(core, graph, statement.then, trail, scopePath), ...collectionReturnTypes(core, graph, statement.else, trail, scopePath))
      } else if (statement.kind === 'foreach' || statement.kind === 'while' || statement.kind === 'collection') {
        if (!trail.has(statement.id)) {
          const nextTrail = new Set(trail); nextTrail.add(statement.id)
          types.push(...collectionReturnTypes(core, graph, statement.body, nextTrail, scopePath))
        }
      }
    }
    return types
  }

  function collectionOutputType(core, graph, statement, scopePath = [], trail = new Set()) {
    const itemType = listElementType(outputValueType(core, graph, statement?.items, scopePath, trail)) || 'unknown'
    const returned = collectionReturnTypes(core, graph, statement?.body, trail, scopePath)
    const bodyType = returned.find(type => type && type !== 'unknown') || returned[0] || 'unknown'
    if (statement?.method === 'reduce') return bodyType
    if (statement?.method === 'find') return { kind: 'nullable', value: itemType }
    if (statement?.method === 'filter') return { kind: 'list', element: itemType }
    return { kind: 'list', element: bodyType }
  }

  function scopeReferences(core, graph, targetId, scopePath = []) {
    const active = scopeDefinition(graph, scopePath)
    const scopeGraph = active.graph || graph
    let rootRefs = (Array.isArray(scopeGraph?.inputs) ? scopeGraph.inputs : []).map(input => ({
      value: { kind: 'input', name: input.name }, type: portValueType(input), label: `输入 · ${semanticSlotLabel(input, input.name)}`,
    }))
    const lastFrame = Array.isArray(scopePath) && scopePath.length ? scopePath[scopePath.length - 1] : null
    if (lastFrame?.kind === 'branch' && active.parent) {
      const outer = scopeReferences(core, graph, active.parent.id, scopePath.slice(0, -1))
      rootRefs = [...(outer?.refs || rootRefs)]
      const owner = active.parent
      if (lastFrame.branch === 'condition.body') {
        for (const [name, value] of Object.entries(owner.condition?.inputs || {})) rootRefs.push({ value: { kind: 'input', name }, type: outputValueType(core, graph, value, scopePath.slice(0, -1)) || 'unknown', label: `循环条件 · ${name}` })
      } else {
        const itemType = listElementType(outputValueType(core, graph, owner.items, scopePath.slice(0, -1))) || 'unknown'
        if ((owner.kind === 'foreach' || owner.kind === 'collection') && owner.item) rootRefs.push({ value: { kind: 'input', name: owner.item }, type: itemType, label: `当前项 · ${owner.item}` })
        if ((owner.kind === 'foreach' || owner.kind === 'collection') && owner.index) rootRefs.push({ value: { kind: 'input', name: owner.index }, type: 'number', label: `索引 · ${owner.index}` })
        if (owner.kind === 'while' && owner.index) rootRefs.push({ value: { kind: 'input', name: owner.index }, type: 'number', label: `循环索引 · ${owner.index}` })
        if (owner.kind === 'collection' && owner.method === 'reduce' && owner.accumulator) rootRefs.push({ value: { kind: 'input', name: owner.accumulator }, type: outputValueType(core, graph, owner.initial, scopePath.slice(0, -1)) || itemType, label: `累计值 · ${owner.accumulator}` })
      }
    }
    const visit = (statements, refs, owner, branch) => {
      if (!Array.isArray(statements)) return null
      const local = [...refs]
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index]
        if (!record(statement)) continue
        if (statement.id === targetId) return { refs: local, statements, index, statement, owner, branch }
        const descend = (children, childBranch, childRefs = local) => visit(children, childRefs, statement, childBranch)
        if (statement.kind === 'if') {
          const found = descend(statement.then, 'then') || descend(statement.else, 'else')
          if (found) return found
        } else if (statement.kind === 'foreach') {
          const bodyRefs = [...local]
          const itemType = listElementType(outputValueType(core, graph, statement.items, scopePath)) || 'unknown'
          if (statement.item) bodyRefs.push({ value: { kind: 'input', name: statement.item }, type: itemType, label: `当前项 · ${statement.item}` })
          if (statement.index) bodyRefs.push({ value: { kind: 'input', name: statement.index }, type: 'number', label: `索引 · ${statement.index}` })
          const found = descend(statement.body, 'body', bodyRefs)
          if (found) return found
        } else if (statement.kind === 'while') {
          const conditionInputs = Object.entries(statement.condition?.inputs || {}).map(([name, value]) => ({ value: { kind: 'input', name }, type: outputValueType(core, graph, value, scopePath) || 'unknown', label: `循环条件 · ${name}` }))
          const found = descend(statement.condition?.body, 'condition.body', conditionInputs) || descend(statement.body, 'body', [...local, ...(statement.index ? [{ value: { kind: 'input', name: statement.index }, type: 'number', label: `循环索引 · ${statement.index}` }] : [])])
          if (found) return found
        } else if (statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) {
          const bodyRefs = [...local]
          const itemType = listElementType(outputValueType(core, graph, statement.items, scopePath)) || 'unknown'
          if (statement.item || statement.method !== 'reduce') bodyRefs.push({ value: { kind: 'input', name: statement.item || 'item' }, type: itemType, label: `当前项 · ${statement.item || 'item'}` })
          if (statement.index || statement.method !== 'reduce') bodyRefs.push({ value: { kind: 'input', name: statement.index || 'index' }, type: 'number', label: `索引 · ${statement.index || 'index'}` })
          if (statement.accumulator || statement.method === 'reduce') bodyRefs.push({ value: { kind: 'input', name: statement.accumulator || 'accumulator' }, type: outputValueType(core, graph, statement.initial, scopePath) || itemType, label: `累计值 · ${statement.accumulator || 'accumulator'}` })
          const found = descend(statement.body, 'body', bodyRefs)
          if (found) return found
          // A collection's body is a nested lexical scope, while its typed
          // result is available to statements that follow the collection in
          // the surrounding branch.  Add it only after visiting the body so
          // an expression inside the collection cannot capture its own result.
          local.push({ value: reference(statement.id, 'value'), type: collectionOutputType(core, graph, statement, scopePath), label: '集合结果' })
        } else if (statement.kind === 'call') {
          const descriptor = descriptorForGraphStatement(core, graph, statement, scopePath)
          for (const output of Array.isArray(descriptor?.outputs) ? descriptor.outputs : []) local.push({ value: reference(statement.id, output.name), type: descriptorOutputType(descriptor, output.name, statement, input => outputValueType(core, graph, input, scopePath)), label: `${semanticModuleLabel(statement.module, descriptor?.label)} · ${outputLabel(descriptor, output.name)}` })
        } else if (statement.kind === 'record.create') local.push({ value: reference(statement.id, 'value'), type: { kind: 'record', schema: statement.schema }, label: '记录结果' })
        else if (statement.kind === 'record.with') local.push({ value: reference(statement.id, 'value'), type: recordSchemaType(core, graph, statement.record, new Set(), scopePath) || 'unknown', label: '更新后的记录' })
        else if (statement.kind === 'record.get') local.push({ value: reference(statement.id, 'value'), type: recordFieldType(core, graph, statement.record, statement.field, scopePath) || 'unknown', label: `记录字段 · ${fieldLabels[statement.field] || statement.field || '字段'}` })
      }
      return null
    }
    return visit(active.body, rootRefs, null, scopePath.length ? 'scoped' : 'root') || { refs: rootRefs, statements: active.body || [], index: -1, statement: null, owner: null, branch: scopePath.length ? 'scoped' : 'root' }
  }

  function pureDescriptors(core, graph, expectedType) {
    if (expectedType === 'any' || expectedType === 'unknown' || !expectedType) return []
    return moduleDescriptorsFor(core, graph).filter(descriptor => pureDescriptor(descriptor)
      && !isCompatibilityDescriptor(descriptor)
      && Boolean(expressionOutput(descriptor, expectedType)))
  }

  function seedablePureDescriptors(core, graph, expectedType, targetId, scopePath = []) {
    const refs = scopeReferences(core, graph, targetId, scopePath)?.refs || []
    return pureDescriptors(core, graph, expectedType).filter(descriptor => (Array.isArray(descriptor.inputs) ? descriptor.inputs : []).every(port => {
      const type = descriptorInputType(descriptor, port.name, { parameters: expressionParameters(descriptor, expectedType) })
      return refs.some(ref => compatibleType(ref.type, type)) || literalType(type) || port.nullable || port.optional
    }))
  }

  // Kept outside mount so the helper can share descriptor handling with the
  // non-specialized graph projection and remains independent of DOM state.
  function moduleDescriptorsFor(core, graph) {
    const surface = graph?.surface
    const byKey = new Map()
    for (const descriptor of descriptorsFrom(descriptorSource(core))) {
      if (typeof descriptor.id !== 'string' || typeof descriptor.version !== 'string') continue
      if (Array.isArray(descriptor.allowedSurfaces) && surface && !descriptor.allowedSurfaces.includes(surface)) continue
      byKey.set(`${descriptor.id}@${descriptor.version}`, descriptor)
    }
    for (const composite of Array.isArray(graph?.composites) ? graph.composites : []) {
      if (!record(composite) || typeof composite.id !== 'string' || typeof composite.version !== 'string') continue
      if (Array.isArray(composite.allowedSurfaces) && surface && !composite.allowedSurfaces.includes(surface)) continue
      const key = `${composite.id}@${composite.version}`
      if (byKey.has(key)) continue
      byKey.set(key, { ...composite, label: composite.label || composite.id, description: composite.description || '当前模块图中的组合模块', inputs: Array.isArray(composite.inputs) ? composite.inputs : [], outputs: Array.isArray(composite.outputs) ? composite.outputs : [], parameters: Array.isArray(composite.parameters) ? composite.parameters : [], allowedSurfaces: Array.isArray(composite.allowedSurfaces) ? composite.allowedSurfaces : (surface ? [surface] : []), __composite: true })
    }
    return [...byKey.values()]
  }

  function compareDescriptorVersions(left, right) {
    const a = String(left ?? '').split(/[^0-9]+/u).filter(Boolean).map(Number)
    const b = String(right ?? '').split(/[^0-9]+/u).filter(Boolean).map(Number)
    const length = Math.max(a.length, b.length)
    for (let index = 0; index < length; index += 1) {
      const difference = (a[index] || 0) - (b[index] || 0)
      if (difference) return difference
    }
    return String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true, sensitivity: 'base' })
  }

  // The authoring catalogue exposes one current authoring shape per module.
  // Older versions remain resolvable for existing graphs, but showing every
  // version under the same data-sentence-module selector makes a blank
  // insertion pick an arbitrary legacy shape.  Prefer the highest registered
  // version while retaining the catalogue's first-seen order.
  function authoringPickerDescriptors(descriptors) {
    const byId = new Map()
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      const previous = byId.get(descriptor?.id)
      if (!previous || compareDescriptorVersions(descriptor.version, previous.version) > 0) byId.set(descriptor.id, descriptor)
    }
    return [...byId.values()]
  }

  function graphRefs(core, graph, statementId, scopePath = []) {
    return scopeReferences(core, graph, statementId, scopePath)?.refs || []
  }

  function expressionOutput(descriptor, expectedType) {
    const statement = { parameters: expressionParameters(descriptor, expectedType) }
    return (Array.isArray(descriptor?.outputs) ? descriptor.outputs : []).find(output => compatibleType(descriptorOutputType(descriptor, output.name, statement), expectedType)) || null
  }

  function expressionParameters(descriptor, expectedType) {
    const parameters = {}
    for (const parameter of descriptor?.parameters || []) {
      if (own(parameter, 'default')) parameters[parameter.name] = clone(parameter.default)
      else if (Array.isArray(parameter.enum) && parameter.enum.length) parameters[parameter.name] = clone(parameter.enum[0])
    }
    for (const binding of Object.values(descriptor?.outputParameterTypeBindings || {})) {
      const matching = Object.entries(binding.types || {}).find(([, type]) => compatibleType(type, expectedType))
      if (matching) parameters[binding.parameter] = matching[0]
    }
    for (const binding of Object.values(descriptor?.outputValueTypeBindings || {})) {
      if (expectedType && expectedType !== 'unknown' && expectedType !== 'any') parameters[binding.parameter] = typeof expectedType === 'string' ? expectedType : JSON.stringify(expectedType)
    }
    return parameters
  }

  function setStatementValue(statement, inputName, value) {
    if (!record(statement)) return false
    if (statement.kind === 'call') { statement.inputs = { ...(statement.inputs || {}), [inputName]: value }; return true }
    if (statement.kind === 'if' && inputName === 'condition') { statement.condition = value; return true }
    if (statement.kind === 'foreach' && inputName === 'items') { statement.items = value; return true }
    if (statement.kind === 'return') {
      if (inputName === 'value') statement.value = value
      else statement.values = { ...(statement.values || {}), [inputName.startsWith('return:') ? inputName.slice('return:'.length) : inputName]: value }
      return true
    }
    if (statement.kind === 'record.create') {
      const fieldName = inputName.startsWith('field:') ? inputName.slice('field:'.length) : inputName
      statement.fields = { ...(statement.fields || {}), [fieldName]: value }; return true
    }
    if (statement.kind === 'record.get' && inputName === 'record') { statement.record = value; return true }
    if (statement.kind === 'record.with') {
      // Keep the explicit field namespace ahead of the source-record name.
      // A valid schema may contain a field literally named "record".
      if (inputName.startsWith('field:')) {
        const fieldName = inputName.slice('field:'.length)
        statement.fields = { ...(statement.fields || {}), [fieldName]: value }
      } else if (inputName === 'record') statement.record = value
      else statement.fields = { ...(statement.fields || {}), [inputName]: value }
      return true
    }
    if (statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) {
      if (inputName === 'items') statement.items = value
      else if (inputName === 'initial') statement.initial = value
      else statement.inputs = { ...(statement.inputs || {}), [inputName]: value }
      return true
    }
    if (statement.kind === 'defer-choice') { statement[inputName] = value; return true }
    return false
  }

  // Most record fields historically used their bare field name as the
  // author-expression metadata key. Keep that format for compatibility, but
  // reserve the explicit key for record.with's field named `record`, where a
  // bare `record` key would collide with the wrapped source value.
  function authorExpressionMetadataName(statement, inputName) {
    if (statement?.kind === 'record.with' && inputName === 'field:record') return inputName
    return inputName?.startsWith?.('field:') ? inputName.slice('field:'.length) : inputName
  }

  function legacyAuthorExpressionMetadataMatches(statement, legacy, current) {
    if (!legacy || jsonValue(legacy.value) !== jsonValue(current)) return false
    // A legacy bare `record` entry is ambiguous. If it points at the same
    // output as record.with's source, it is the source metadata, not a field
    // entry eligible for migration or cleanup.
    return jsonValue(legacy.value) !== jsonValue(statement?.record)
  }

  function authorExpressionMetadataEntry(statement, metadataName, current) {
    const direct = statement?.layout?.authorExpressions?.[metadataName]
    if (direct) return { entry: direct, legacy: false, name: metadataName }
    const legacyName = metadataName?.startsWith?.('field:') ? metadataName.slice('field:'.length) : ''
    const legacy = legacyName ? statement?.layout?.authorExpressions?.[legacyName] : null
    if (legacyAuthorExpressionMetadataMatches(statement, legacy, current)) return { entry: legacy, legacy: true, name: legacyName }
    return { entry: null, legacy: false, name: metadataName }
  }

  function createPureExpression(options, consumerId, inputName, expectedType, moduleId, moduleVersion, scopePath = options.__sentenceScopePath || []) {
    const core = coreFor(options)
    const field = options.field || 'code'
    const currentDraft = clone(options.getDraft?.() || {})
    const graph = graphFor(core, currentDraft, field)
    const consumerLocation = statementLocationForLexicalId(graph, consumerId, scopePath)
    const consumerScopePath = consumerLocation?.scopePath || scopePath
    const activeGraph = scopeDefinition(graph, consumerScopePath).graph || graph
    const location = consumerLocation && statementLocation(graph, consumerId, consumerScopePath)
    if (!record(graph) || !location?.statement || !Array.isArray(location.statements)) throw new Error('找不到表达式输入所在的语句。')
    const descriptor = descriptorFor(core, moduleId, moduleVersion)
      || (Array.isArray(activeGraph.composites) ? activeGraph.composites.find(item => item.id === moduleId && (!moduleVersion || item.version === moduleVersion)) : null)
    if (!pureDescriptor(descriptor)) throw new Error('表达式只能使用无副作用的注册模块。')
    const output = expressionOutput(descriptor, expectedType)
    if (!output) throw new Error(`模块“${descriptor?.label || moduleId}”没有兼容的${typeLabel(expectedType)}输出。`)
    const refs = scopeReferences(core, graph, consumerId, consumerScopePath)?.refs || []
    const inputs = {}
    const parameters = expressionParameters(descriptor, expectedType)
    for (const port of Array.isArray(descriptor.inputs) ? descriptor.inputs : []) {
      const type = descriptorInputType(descriptor, port.name, { parameters })
      const compatible = refs.find(ref => compatibleType(ref.type, type))
      if (compatible) inputs[port.name] = clone(compatible.value)
      else if (literalType(type) || port.nullable || type.kind === 'nullable') inputs[port.name] = literal(defaultLiteralFor({ ...port, type }, schemaGraphForScope(graph, consumerScopePath)))
      else if (!port.optional) throw new Error(`“${semanticModuleLabel(moduleId, descriptor.label)}”的${semanticSlotLabel(port, port.name)}还没有可用的同类型引用。`)
    }
    const statement = {
      kind: 'call', id: nextStatementId(graph, 'sentence-expression'), module: descriptor.id,
      version: descriptor.version, inputs, parameters,
      layout: { sentenceExpression: { owner: consumerId, input: inputName } },
    }
    const nextGraph = clone(graph)
    const nextLocation = statementLocation(nextGraph, consumerId, consumerScopePath)
    if (!nextLocation?.statements) throw new Error('表达式输入位置在编辑过程中失效。')
    nextLocation.statements.splice(nextLocation.index, 0, statement)
    // The consumer is looked up after insertion so a future core normalizer
    // cannot accidentally mutate the caller's draft object.
    const consumer = statementForId(nextGraph, consumerId, consumerScopePath)
    if (!consumer) throw new Error('表达式输入消费者已丢失。')
    if (!setStatementValue(consumer, inputName, reference(statement.id, output.name))) throw new Error('此结构语句的输入槽不支持表达式引用。')
    const applied = commitGraphDraft(options, currentDraft, nextGraph, field)
    return { statement, output: reference(statement.id, output.name), scopePath: consumerScopePath, draft: applied.next, diagnostic: applied.diagnostic }
  }

  function explicitResultBindingName(core, graph, source, value, scopePath = []) {
    const binding = source?.layout?.resultVariables?.[value?.port]
    if (!record(binding) || typeof binding.declarationId !== 'string') return ''
    const declaration = statementLocationForLexicalId(graph, binding.declarationId, scopePath)?.statement
    const linked = resultBindingDeclaration(core, graph, declaration, scopePath)
    if (linked?.producer?.id !== source?.id || linked.binding !== binding) return ''
    const name = declaration.parameters?.name
    return typeof name === 'string' && name.trim() && (!binding.name || binding.name === name)
      ? name.trim()
      : ''
  }

  function expressionValueLabel(core, graph, value, trail = new Set(), scopePath = []) {
    if (!record(value)) return '未设置'
    if (value.kind === 'literal') return literalDisplay(value.value)
    if (value.kind === 'input') return `输入 · ${semanticSlotLabel(null, value.name)}`
    if (value.kind === 'output') {
      const sourceLocation = statementLocationForLexicalId(graph, value.node, scopePath)
      const source = sourceLocation?.statement
      const sourceScopePath = sourceLocation?.scopePath || scopePath
      const author = source?.layout?.authorExpression
      const owner = author && statementForLexicalId(graph, author.owner, sourceScopePath)
      const authored = owner?.layout?.authorExpressions?.[author?.input]
      if (authored && jsonValue(authored.value) === jsonValue(value)) return authored.source
      const savedBindingName = explicitResultBindingName(core, graph, source, value, sourceScopePath)
      if (savedBindingName) return savedBindingName
      if (source?.layout?.resultNames?.[value.port]) return source.layout.resultNames[value.port]
      if (source?.kind === 'record.get' && !trail.has(value.node)) {
        const nextTrail = new Set(trail); nextTrail.add(value.node)
        const parent = expressionValueLabel(core, graph, source.record, nextTrail, sourceScopePath)
        const type = recordSchemaType(core, graph, source.record, new Set(), sourceScopePath)
        const schema = schemaForGraph(graphWithAuthorSchemas(core, graph), type?.schema)
        const field = schema?.fields?.find(item => item.name === source.field)
        return `${parent}.${field?.label || semanticSlotLabel(field, source.field)}`
      }
      if (source?.kind === 'record.create') return typeLabel({ kind: 'record', schema: source.schema })
      const descriptor = descriptorForGraphStatement(core, graph, source, sourceScopePath)
      const output = descriptor?.outputs?.find(item => item.name === value.port)
      if (source?.kind === 'call') {
        const contextLabels = {
          'ref.holder': '当前棋子',
          'ref.source': '来源棋子',
          'ref.target': '当前目标',
          'author.choice.target-piece': '当前目标',
          'author.choice.target-cell': '当前目标',
          'ref.player': '所属玩家',
          'ref.current-card': '当前手牌',
          'ref.current-skill': '当前技能',
          'ref.current-rule': '当前规则',
          'ref.current-cluster': '当前能力组',
          'ref.event-player': '事件玩家',
          'ref.event-piece': '当前事件棋子',
          'ref.rule-piece': '当前规则持有棋子',
        }
        if (contextLabels[source.module]) return contextLabels[source.module]
        if (source.module === 'local.declare' && source.parameters?.name) return source.parameters.name
        if (source.layout?.resultNames?.[value.port]) return source.layout.resultNames[value.port]
        if (source.module === 'spatial.piece-position') {
          const sourceTrail = new Set(trail)
          sourceTrail.add(value.node)
          if (own(source.inputs || {}, 'piece') && !trail.has(value.node)) {
            const piece = expressionValueLabel(core, graph, source.inputs.piece, sourceTrail, sourceScopePath)
            if (piece && piece !== '未设置') return `${piece}的位置`
          }
          return '当前棋子的位置'
        }
        const sourceTrail = new Set(trail)
        sourceTrail.add(value.node)
        if (['piece.field', 'player.field', 'event.field', 'context.field', 'skill.field', 'observation.field', 'battle.field', 'data.field', 'data.optional-field', 'result.field', 'card.instance-field', 'card.definition-field', 'card.content-field', 'author.skill-instance.field', 'status.instance-field', 'rule.instance-field'].includes(source.module) && !trail.has(value.node)) {
          const inputName = { 'piece.field': 'piece', 'player.field': 'player', 'data.field': 'record', 'data.optional-field': 'record', 'result.field': 'record', 'observation.field': 'record', 'card.instance-field': 'card', 'card.definition-field': 'card', 'card.content-field': 'record', 'author.skill-instance.field': 'instance', 'status.instance-field': 'status', 'rule.instance-field': 'rule' }[source.module]
          const owner = inputName ? expressionValueLabel(core, graph, source.inputs?.[inputName], sourceTrail, sourceScopePath) : source.module === 'battle.field' ? '当前对局' : source.module === 'skill.field' ? '当前技能' : '当前事件'
          const field = source.parameters?.field
          return `${owner}.${fieldLabels[field] || field || '字段'}${['exists', 'defined'].includes(value.port) ? '已定义' : ''}`
        }
        const fieldInput = source.module === 'attribute.player-text' ? 'player' : source.module === 'attribute.read' || source.module === 'attribute.text' ? 'piece' : ''
        if (fieldInput && own(source.inputs, fieldInput) && !trail.has(value.node)) {
          const owner = expressionValueLabel(core, graph, source.inputs[fieldInput], sourceTrail, sourceScopePath)
          const attribute = fieldLabels[source.parameters?.attribute]
            || attributeLabels[source.parameters?.attribute]
            || semanticSlotLabels[source.parameters?.attribute]
            || source.parameters?.attribute
            || '属性'
          return `${owner}.${String(attribute).replace(/^(自身|当前棋子)/, '')}`
        }
        const operator = source.module === 'compare.values' ? source.parameters?.operator || '==' : expressionInfixOperators[source.module]
        if (operator && own(source.inputs, 'left') && own(source.inputs, 'right') && !trail.has(value.node)) {
          const left = expressionValueLabel(core, graph, source.inputs.left, sourceTrail, sourceScopePath)
          const right = expressionValueLabel(core, graph, source.inputs.right, sourceTrail, sourceScopePath)
          const parenthesize = (operand, rawValue) => expressionOperandNeedsParentheses(graph, rawValue, sourceScopePath)
            ? `（${operand}）`
            : operand
          return `${parenthesize(left, source.inputs.left)} ${operator} ${parenthesize(right, source.inputs.right)}`
        }
        if (source.module === 'logic.not' && own(source.inputs, 'value') && !trail.has(value.node)) {
          const operand = expressionValueLabel(core, graph, source.inputs.value, sourceTrail, sourceScopePath)
          return `非（${operand}）`
        }
        // Extension reads are data-only values too.  Keep their storage
        // identity in the value chip while projecting the read itself out of
        // the step list; write/declare descriptors never enter this branch
        // because pureDescriptor rejects their writes.
        if (String(source.module || '').startsWith('extension.') && pureDescriptor(descriptor) && !trail.has(value.node)) {
          const inputLabels = Object.keys(source.inputs || {}).map(input => expressionValueLabel(core, graph, source.inputs[input], sourceTrail, sourceScopePath))
          const parameterLabels = ['namespace', 'name', 'path', 'key', 'storageKey', 'field']
            .filter(name => own(source.parameters || {}, name) && source.parameters[name] !== '' && !(name === 'namespace' && source.parameters[name] === 'content'))
            .map(name => `${name === 'name' ? '变量' : name === 'path' ? '字段' : name === 'key' ? '键' : name === 'storageKey' ? '存储' : name === 'field' ? '字段' : '分组'}：${literalDisplay(source.parameters[name])}`)
          const args = [...inputLabels, ...parameterLabels]
          const label = descriptor?.label || '读取扩展值'
          return args.length ? `${label}（${args.join('，')}）` : label
        }
        const functionLabels = {
          'collection.length': ['数量', ['items']],
          'collection.contains': ['包含', ['items', 'value']],
          'collection.index-of': ['首项序号', ['items', 'value']],
          'collection.concat': ['拼接', ['left', 'right']],
          'collection.reverse': ['反转', ['items']],
          'collection.slice': ['截取', ['items', 'start', 'count']],
          'collection.random': ['随机项目', ['items']],
          'collection.distinct': ['去重', ['items']],
          'map.has-key': ['包含键', ['map', 'key']],
          'map.keys': ['键列表', ['map']],
          'map.values': ['值列表', ['map']],
          'map.get': ['读取', ['map', 'key']],
          'set.contains': ['包含', ['set', 'value']],
          'set.items': ['转元组', ['set']],
        }[source.module]
        if (functionLabels && !trail.has(value.node)) {
          const [label, inputs] = functionLabels
          const args = inputs.map(input => expressionValueLabel(core, graph, source.inputs?.[input], sourceTrail, sourceScopePath))
          return `${label}（${args.join('，')}）`
        }
        if (source.module === 'record.create' && typeof source.schema === 'string') return '记录内容'
      }
      const expressionMeta = source?.layout?.sentenceExpression
      // Newly composed expressions are still ordinary IR calls, but their
      // authoring metadata lets the sentence projection read the whole value
      // as one formula.  Keep a cycle guard because malformed/legacy graphs
      // must remain renderable even when they contain self references.
      if (source?.kind === 'call' && expressionMeta && !trail.has(source.id)) {
        const nextTrail = new Set(trail)
        nextTrail.add(source.id)
        const args = []
        for (const input of Array.isArray(descriptor?.inputs) ? descriptor.inputs : []) {
          if (!own(source.inputs, input.name) && input.optional) continue
          const current = own(source.inputs, input.name) ? source.inputs[input.name] : undefined
          args.push(`${semanticSlotLabel(input, input.name)}：${expressionValueLabel(core, graph, current, nextTrail, sourceScopePath)}`)
        }
        const parameters = []
        for (const parameter of Array.isArray(descriptor?.parameters) ? descriptor.parameters : []) {
          if (!own(source.parameters, parameter.name)) continue
          parameters.push(`${semanticSlotLabel(parameter, parameter.name)}：${literalDisplay(source.parameters[parameter.name])}`)
        }
        const label = semanticModuleLabel(source.module, descriptor?.label)
        const suffix = parameters.length ? ` · ${parameters.join('，')}` : ''
        return `${label}${suffix}${args.length ? `（${args.join('，')}）` : ''}`
      }
      return `${semanticModuleLabel(source?.module, descriptor?.label)} · ${semanticSlotLabel(output, output?.name || value.port || 'result')}`
    }
    return '未设置'
  }

  function valueLabel(core, graph, value, scopePath = []) {
    return expressionValueLabel(core, graph, value, new Set(), scopePath)
  }

  // The sentence projection intentionally consumes templates as data.  The
  // catalog is loaded by the editor shell, so older shells can still render a
  // useful generic sentence when the optional catalog is absent.  Keeping the
  // lookup here also lets the catalog evolve without duplicating authoring
  // rules in this view.
  function sentenceTemplate(descriptor, statement, context = {}) {
    const roots = [
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplateCatalog : null,
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.SkillSentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.GameplaySentenceTemplates : null,
    ]
    for (const root of roots) {
      const describe = root?.describeCall || root?.describe || root?.templateFor
      if (typeof describe !== 'function') continue
      try {
        const result = describe(descriptor, statement, context)
        const fragments = Array.isArray(result) ? result : result?.fragments
        if (Array.isArray(fragments) && fragments.length) return fragments
      } catch { /* malformed optional templates must not hide the graph */ }
    }
    return null
  }

  function authorStatementCatalog() {
    const roots = [
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplateCatalog : null,
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.SkillSentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.GameplaySentenceTemplates : null,
    ]
    for (const root of roots) {
      const catalog = root?.authorStatementCatalog || root?.authorStatements
      if (Array.isArray(catalog) && catalog.length) return catalog
    }
    return [
      { id: 'local.declare', kind: 'local-declaration', label: '新建变量', description: '在本次执行中新建一个局部变量。', registered: true },
      { id: 'author.extension.declare', kind: 'extension-declaration', label: '声明扩展变量', description: '在对象的扩展中新建一个带类型的变量。', registered: false },
      { id: 'author.assignment', kind: 'assignment', label: '赋值', description: '把表达式结果写入局部变量、可写字段或扩展变量。', registered: false },
    ]
  }

  // The sentence catalogue owns dependency metadata for standard modules.
  // Keep this lookup optional so a legacy shell or an older catalogue still
  // renders and edits its existing graph through the local fallback rules.
  function sentenceSlotAvailable(descriptor, statement, kind, name, options = {}) {
    const roots = [
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplateCatalog : null,
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.SkillSentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.GameplaySentenceTemplates : null,
    ]
    for (const root of roots) {
      if (typeof root?.isSlotAvailable !== 'function') continue
      try { return Boolean(root.isSlotAvailable(descriptor, statement, kind, name, options)) } catch { /* use local fallback */ }
    }
    return null
  }

  function sentenceResultMessageIsHidden(descriptor, statement, kind, name) {
    const roots = [
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplateCatalog : null,
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.SkillSentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.GameplaySentenceTemplates : null,
    ]
    for (const root of roots) {
      if (typeof root?.isRedundantResultMessage !== 'function') continue
      try { return Boolean(root.isRedundantResultMessage(descriptor, statement, kind, name)) } catch { /* use the next alias */ }
    }
    return false
  }

  function sentenceParameterIsDerived(descriptor, statement, name) {
    const roots = [
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplateCatalog : null,
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.SkillSentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.GameplaySentenceTemplates : null,
    ]
    for (const root of roots) {
      if (typeof root?.isDerivedParameter === 'function') {
        try { if (root.isDerivedParameter(descriptor, statement, name)) return true } catch { /* use the next alias */ }
      }
      if (typeof root?.getTemplate === 'function') {
        try {
          const derived = root.getTemplate(descriptor?.id || statement?.module, descriptor?.version || statement?.version)?.derivedParameters
          if (Array.isArray(derived) && derived.includes(name)) return true
        } catch { /* use the next alias */ }
      }
    }
    return false
  }

  function sentenceStatementTemplate(statement, context = {}) {
    const roots = [
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplateCatalog : null,
      typeof globalThis !== 'undefined' ? globalThis.SentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.SkillSentenceTemplates : null,
      typeof globalThis !== 'undefined' ? globalThis.GameplaySentenceTemplates : null,
    ]
    for (const root of roots) {
      if (typeof root?.describeStatement !== 'function') continue
      try {
        const result = root.describeStatement(statement, context)
        if (Array.isArray(result) && result.length) return result
      } catch { /* keep the generic structural projection available */ }
    }
    return null
  }

  function literalControl(current, definition, onChange, disabled = false, context = {}, depth = 0) {
    const type = portValueType(definition)
    const wrapper = node('div', undefined, 'sentence-literal-control sentence-literal-editor')
    wrapper.dataset.sentenceLiteralType = typeLabel(type)
    const controls = []
    const register = control => { if (control) controls.push(control); return control }
    const applyDisabled = value => {
      wrapper.dataset.sentenceLiteralDisabled = String(Boolean(value))
      for (const control of controls) control.disabled = Boolean(value)
      for (const child of wrapper.querySelectorAll('input,select,button,textarea')) child.disabled = Boolean(value)
    }
    wrapper.setDisabled = applyDisabled
    const emit = (value, metadata) => { if (!Boolean(disabled)) onChange(value, metadata) }
    const maxDepth = Number.isFinite(context.maxLiteralDepth) ? context.maxLiteralDepth : 8
    if (depth > maxDepth) {
      wrapper.append(node('span', '结构化常量层级过深。', 'sentence-literal-unavailable'))
    } else if ((type === 'record' || type === 'object' || type === 'json' || (record(type) && ['record', 'object', 'map', 'set'].includes(type.kind))) && window.AuthorObjectEditor?.mount) {
      const host = node('div', undefined, 'sentence-literal-object-editor')
      const objectEditor = window.AuthorObjectEditor.mount(host, {
        value: current,
        type,
        definition,
        schemas: context.graph?.schemas || [],
        schemaRegistry: context.schemaRegistry,
        catalog: authorReferenceCatalog(context.catalog),
        getCatalog: typeof context.getCatalog === 'function' ? () => authorReferenceCatalog(context.getCatalog()) : undefined,
        referenceResolver: context.referenceResolver || authorContentReference,
        allowSchemaSelect: type === 'record' || type === 'object',
        label: definition?.label || '记录值',
        description: definition?.description,
        readonly: Boolean(disabled),
        maxDepth: maxDepth - depth,
        onChange: (value, metadata) => emit(value, metadata),
      })
      wrapper.setDisabled = value => {
        wrapper.dataset.sentenceLiteralDisabled = String(Boolean(value))
        objectEditor?.setReadonly?.(Boolean(value))
      }
      wrapper.append(host)
    } else if (Array.isArray(definition?.enum)) {
      const select = register(document.createElement('select'))
      select.dataset.sentenceLiteralEnum = definition.name || ''
      for (const value of definition.enum) { const option = node('option', enumLiteralDisplay(value, definition)); option.value = jsonValue(value); select.append(option) }
      select.value = jsonValue(current)
      select.onchange = () => emit(parseJsonValue(select.value))
      wrapper.append(select)
    } else if (record(type) && type.kind === 'nullable') {
      const present = register(document.createElement('select'))
      present.dataset.sentenceLiteralNullable = definition.name || ''
      const nullOption = node('option', '空值'); nullOption.value = 'null'; present.append(nullOption)
      const valueOption = node('option', '有值'); valueOption.value = 'value'; present.append(valueOption)
      const inner = node('div', undefined, 'sentence-literal-nested')
      let currentValue = current
      const renderInner = value => {
        inner.replaceChildren()
        if (value) {
          const childDefinition = { ...definition, type: type.value, nullable: false }
          inner.append(literalControl(currentValue ?? defaultLiteralFor(childDefinition, context.graph), childDefinition, value => {
            currentValue = value
            emit(value)
          }, disabled, context, depth + 1))
        }
      }
      const hasValue = currentValue !== null && currentValue !== undefined
      present.value = hasValue ? 'value' : 'null'
      present.onchange = () => {
          currentValue = present.value === 'value' ? defaultLiteralFor({ ...definition, type: type.value, nullable: false }, context.graph) : null
        emit(currentValue)
        renderInner(present.value === 'value')
      }
      renderInner(hasValue)
      wrapper.append(present, inner)
    } else if (record(type) && type.kind === 'list') {
      const list = Array.isArray(current) ? current : []
      const rows = node('div', undefined, 'sentence-literal-list')
      const renderRows = () => {
        rows.replaceChildren()
        list.forEach((item, index) => {
          const row = node('div', undefined, 'sentence-literal-list-row')
          row.dataset.sentenceLiteralIndex = String(index)
          const childDefinition = { name: `${definition?.name || 'item'}[${index}]`, type: type.element }
          row.append(literalControl(item, childDefinition, value => { list[index] = value; emit([...list]) }, disabled, context, depth + 1))
          const remove = action('删除', () => { list.splice(index, 1); emit([...list]); renderRows() }, 'sentence-literal-list-remove')
          remove.dataset.sentenceLiteralRemove = String(index); row.append(remove); rows.append(row)
        })
      }
      const add = action('＋ 添加一项', () => { list.push(defaultLiteralFor({ type: type.element }, context.graph)); emit([...list]); renderRows() }, 'sentence-literal-list-add')
      add.dataset.sentenceLiteralAdd = definition?.name || ''
      wrapper.append(rows, add); renderRows()
    } else if (record(type) && type.kind === 'record') {
      const schema = schemaForGraph(context.graph, type.schema)
      const object = record(current) && !Array.isArray(current) ? current : {}
      if (schema && Array.isArray(schema.fields)) {
        const fields = node('div', undefined, 'sentence-literal-record')
        for (const field of schema.fields) {
          const fieldDefinition = { ...field, name: field.name, type: field.type || 'unknown', nullable: field.nullable }
          const fieldRow = node('label', undefined, 'sentence-editor-field sentence-literal-record-field')
          fieldRow.append(node('span', `${semanticSlotLabel(field, field.name)} · ${typeLabel(portValueType(fieldDefinition))}`, 'sentence-field-label'))
          const fieldValue = own(object, field.name) ? object[field.name] : defaultLiteralFor(fieldDefinition, context.graph)
          fieldRow.append(literalControl(fieldValue, fieldDefinition, value => { object[field.name] = value; emit({ ...object }) }, disabled, context, depth + 1))
          fields.append(fieldRow)
        }
        for (const key of Object.keys(object).filter(key => !schema.fields.some(field => field.name === key))) {
          fields.append(node('span', `未登记字段：${key}（已保留）`, 'sentence-invalid-field'))
        }
        wrapper.append(fields)
      } else wrapper.append(node('span', '记录结构暂不可用；请先声明结构定义。', 'sentence-literal-unavailable'))
    } else if (type === 'boolean') {
      const input = register(document.createElement('input')); input.type = 'checkbox'; input.checked = current === true
      input.onchange = () => emit(input.checked); wrapper.append(input)
    } else if (type === 'number') {
      const input = register(document.createElement('input')); input.type = 'number'; input.step = 'any'; input.value = Number.isFinite(current) ? String(current) : ''
      if (Number.isFinite(definition?.minimum)) input.min = String(definition.minimum)
      if (Number.isFinite(definition?.maximum)) input.max = String(definition.maximum)
      input.onchange = () => emit(input.value === '' ? null : Number(input.value)); wrapper.append(input)
    } else if (type === 'string') {
      const input = register(document.createElement('input')); input.type = 'text'; input.value = current == null ? '' : String(current); input.maxLength = 2000
      input.onchange = () => emit(input.value); wrapper.append(input)
    } else if (type === 'null' || !literalType(type)) {
      wrapper.append(node('span', type === 'null' ? '空值' : '该类型只能引用已有输出。', 'sentence-literal-unavailable'))
    } else {
      const input = register(document.createElement('input')); input.type = 'text'; input.value = current == null ? '' : String(current); input.maxLength = 2000
      input.onchange = () => emit(input.value); wrapper.append(input)
    }
    applyDisabled(disabled)
    return wrapper
  }

  function valueEditor(core, graph, statement, definition, current, onChange, disabled = false, controls = {}) {
    const expectedType = portValueType(definition)
    // Structured values keep their recursive literal editor, but authors may
    // also provide a typed expression for the whole value (for example a
    // snapshot's 技能 or 状态 field).  The explicit force flag is set only
    // after the author chooses the expression action, so ordinary nested
    // object/list editing remains available.
    if (!disabled && (controls.forceExpression || !structuredLiteralType(expectedType)) && typeof controls.renderExpression === 'function' && typeof core?.lowerAuthorExpression === 'function' && window.ExpressionInput?.mount) return controls.renderExpression(graph, statement, definition, current)
    const wrapper = node('div', undefined, 'sentence-value-editor')
    const literalGraph = scopeDefinition(graph, controls.scopePath || []).graph || graph
    const title = node('span', `${semanticSlotLabel(definition, definition?.name)} · ${contextualTypeLabel(expectedType, definition)}`, 'sentence-field-label')
    const source = document.createElement('select')
    source.setAttribute('aria-label', title.textContent)
    source.dataset.sentenceValueSource = definition?.name || ''
    const refs = graphRefs(core, graph, statement?.id, controls.scopePath || [])
    const choices = [['', '请选择数据来源']]
    if (literalType(expectedType)) choices.push(['literal', '常量'])
    for (const ref of refs) if (compatibleType(ref.type, expectedType)) choices.push([jsonValue(ref.value), ref.label])
    const currentKind = current?.kind
    if (currentKind === 'input' || currentKind === 'output') {
      const encoded = jsonValue(current)
      if (!choices.some(choice => choice[0] === encoded)) choices.push([encoded, `当前引用 · ${valueLabel(core, graph, current, controls.scopePath || [])}`])
      source.value = encoded
    } else if (currentKind === 'literal') source.value = 'literal'
    for (const [value, label] of choices) { const option = node('option', label); option.value = value; source.append(option) }
    source.value = currentKind === 'literal' ? 'literal' : currentKind
      ? jsonValue(current)
      : structuredLiteralType(expectedType) ? 'literal' : ''
    const literal = literalControl(currentKind === 'literal' ? current.value : defaultLiteralFor(definition, literalGraph), definition, (value, metadata) => {
      onChange({ kind: 'literal', value })
      controls.onLiteralTypeChange?.(metadata?.type)
    }, disabled || source.value !== 'literal', {
      graph: literalGraph,
      maxLiteralDepth: 8,
      schemaRegistry: controls.schemaRegistry,
      catalog: controls.catalog,
      getCatalog: controls.getCatalog,
      referenceResolver: controls.referenceResolver || authorContentReference,
      onLiteralTypeChange: controls.onLiteralTypeChange,
    })
    source.disabled = Boolean(disabled)
    source.onchange = () => {
      if (source.value === 'literal') { literal.setDisabled?.(Boolean(disabled)); onChange({ kind: 'literal', value: defaultLiteralFor(definition, literalGraph) }) }
      else { literal.setDisabled?.(true); onChange(parseJsonValue(source.value)) }
    }
    const actionRow = node('span', undefined, 'sentence-value-actions')
    if (!disabled && typeof controls.onAuthorExpression === 'function') {
      const expression = action('输入表达式', controls.onAuthorExpression, 'sentence-value-action')
      expression.dataset.sentenceDirectExpression = definition?.name || ''
      expression.dataset.sentenceExpressionType = String(expectedType || 'unknown')
      expression.title = '使用中文变量或字段表达式填写此值'
      actionRow.append(expression)
    }
    const canCompose = !disabled && controls.allowExpression !== false && seedablePureDescriptors(core, graph, expectedType, statement?.id, controls.scopePath || []).length > 0
    if (canCompose && typeof controls.onCompose === 'function') {
      const compose = action('＋ 组合表达式', controls.onCompose, 'sentence-value-action')
      compose.dataset.sentenceCreateExpression = definition?.name || ''
      compose.dataset.sentenceExpressionType = String(expectedType || 'unknown')
      compose.title = '选择一个无副作用模块，把它的输出作为此输入'
      actionRow.append(compose)
    }
    if (currentKind === 'output' && current.node && typeof controls.onOpenSource === 'function') {
      const sourceLocation = statementLocationForLexicalId(graph, current.node, controls.scopePath || [])
      const sourceStatement = sourceLocation?.statement
      const sourceDescriptor = sourceStatement?.kind === 'call' ? descriptorForGraphStatement(core, graph, sourceStatement, sourceLocation?.scopePath || controls.scopePath || []) : null
      const edit = action(`编辑：${outputLabel(sourceDescriptor, current.port)}`, controls.onOpenSource, 'sentence-value-action sentence-value-edit-expression')
      edit.dataset.sentenceEditExpression = current.node
      edit.title = '递归编辑此表达式的输入'
      actionRow.append(edit)
    }
    wrapper.append(title, source, literal)
    if (actionRow.childElementCount) wrapper.append(actionRow)
    return wrapper
  }

  function mount(container, options = {}) {
    if (!container) return {
      refresh() {},
      getEditorState() { return { version: 1, expressions: [], expressionDrafts: [], collapsedBlocks: [], openPopover: null, scopePath: [] } },
      restoreEditorState() { return false },
      hasUnappliedEdits() { return false },
      getTrialRequest() { return { ok: false, request: null, error: '语句编辑器尚未挂载。' } },
      startTrial() { return Promise.resolve() },
      destroy() {},
    }
    const core = coreFor(options)
    let destroyed = false
    let openPopover = null
    let scopePath = []
    let message = null
    let messageKind = 'info'
    let resultVariableMessageKey = null
    let trialPending = false
    let activeDraft = null
    let pendingCollapseFocusKey = null
    let pendingFocusTarget = null
    let renderGeneration = 0
    const expressionEditors = new Set()
    const expressionDrafts = new Map()
    const resultVariableDrafts = new Map()
    const resultVariableDraftErrors = new Map()
    // Author facade fields are editor drafts until the whole declaration or
    // assignment is applied. Keep them outside the graph so an IME-triggered
    // render (or closing and reopening the inspector) cannot discard text.
    const authorStatementDrafts = new Map()
    const composingControls = new Set()
    let pendingRender = false
    const collapsedBlocks = new Map()
    let collapsePanelSequence = 0
    const collection = options.root?.collection || 'skills'
    const primaryField = options.field || (collection === 'rules' ? 'skillCode' : 'code')
    const externalDraftDiagnostic = options.onDraftDiagnostic
    options.onDraftDiagnostic = text => {
      const localized = authorDiagnostic(text)
      message = `草稿尚不可保存：${localized}`
      messageKind = 'error'
      externalDraftDiagnostic?.(localized)
    }
    const externalDraftWarning = options.onDraftWarning
    options.onDraftWarning = text => {
      message = `提示：${text}`
      messageKind = 'warning'
      externalDraftWarning?.(text)
      render()
    }
    // Core helpers are shared by controls created during this mount. Keep the
    // active path on the options object so a legacy callback can still invoke
    // applyGraphChange without receiving a new public API argument.
    options.__sentenceScopePath = scopePath

    function hasActiveComposition() {
      if (composingControls.size) return true
      return [...expressionEditors].some(editor => editor?.isComposing?.())
    }

    function flushPendingRender() {
      if (destroyed || !pendingRender || hasActiveComposition()) return
      pendingRender = false
      render()
    }

    // Editor-only state is intentionally kept outside the executable graph.
    // Draft expressions can be temporarily invalid while an author is typing;
    // serialise those strings separately so a session restore does not either
    // lose the text or write it into a runnable graph.
    function getEditorState() {
      const expressions = [...expressionDrafts.entries()]
        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
        .map(([key, value]) => [key, value])
      const authorStatements = [...authorStatementDrafts.entries()]
        .filter(([key, value]) => typeof key === 'string' && record(value))
        .map(([key, value]) => [key, clone(value)])
      const resultVariables = [...resultVariableDrafts.entries()]
        .filter(([key, value]) => typeof key === 'string' && record(value))
        .map(([key, value]) => [key, clone(value)])
      return {
        version: 1,
        // `expressions` is the stable public name. Keep the older alias in
        // the snapshot for callers that adopted the first editor-state draft.
        expressions,
        expressionDrafts: expressions.map(item => [...item]),
        authorStatementDrafts: authorStatements,
        resultVariableDrafts: resultVariables,
        collapsedBlocks: [...collapsedBlocks.entries()]
          .filter(([key]) => typeof key === 'string')
          .map(([key, value]) => [key, Boolean(value)]),
        openPopover: clone(openPopover),
        scopePath: Array.isArray(scopePath) ? clone(scopePath) : [],
        pendingCollapseFocusKey: typeof pendingCollapseFocusKey === 'string' ? pendingCollapseFocusKey : null,
        pendingFocusTarget: clone(pendingFocusTarget),
      }
    }

    function restoreEditorState(state, renderAfter = true) {
      if (!record(state)) return false
      expressionDrafts.clear()
      authorStatementDrafts.clear()
      resultVariableDrafts.clear()
      resultVariableDraftErrors.clear()
      resultVariableMessageKey = null
      const rawDrafts = state.expressions ?? state.expressionDrafts
      const drafts = Array.isArray(rawDrafts)
        ? rawDrafts
        : record(rawDrafts) ? Object.entries(rawDrafts) : []
      for (const item of drafts) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'string') continue
        expressionDrafts.set(item[0], item[1])
      }
      const rawAuthorDrafts = state.authorStatementDrafts
      const authorDrafts = Array.isArray(rawAuthorDrafts)
        ? rawAuthorDrafts
        : record(rawAuthorDrafts) ? Object.entries(rawAuthorDrafts) : []
      for (const item of authorDrafts) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || !record(item[1])) continue
        authorStatementDrafts.set(item[0], clone(item[1]))
      }
      const rawResultVariableDrafts = state.resultVariableDrafts
      const resultVariableDraftEntries = Array.isArray(rawResultVariableDrafts)
        ? rawResultVariableDrafts
        : record(rawResultVariableDrafts) ? Object.entries(rawResultVariableDrafts) : []
      for (const item of resultVariableDraftEntries) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || !record(item[1])) continue
        resultVariableDrafts.set(item[0], clone(item[1]))
      }
      collapsedBlocks.clear()
      const collapsed = Array.isArray(state.collapsedBlocks)
        ? state.collapsedBlocks
        : record(state.collapsedBlocks) ? Object.entries(state.collapsedBlocks) : []
      for (const item of collapsed) {
        if (!Array.isArray(item) || typeof item[0] !== 'string') continue
        collapsedBlocks.set(item[0], Boolean(item[1]))
      }
      openPopover = record(state.openPopover) ? clone(state.openPopover) : null
      scopePath.splice(0, scopePath.length, ...(Array.isArray(state.scopePath)
        ? state.scopePath.filter(item => typeof item === 'string' || record(item)).map(item => clone(item))
        : []))
      pendingCollapseFocusKey = typeof state.pendingCollapseFocusKey === 'string' ? state.pendingCollapseFocusKey : null
      pendingFocusTarget = record(state.pendingFocusTarget) ? clone(state.pendingFocusTarget) : null
      if (renderAfter) notifyEditorStateChange()
      if (renderAfter) render()
      return true
    }

    function notifyEditorStateChange() {
      try { options.onEditorStateChange?.(getEditorState()) } catch { /* state persistence must not interrupt editing */ }
    }

    function authorStatementDraftKey(statementId, path = scopePath) {
      return `${documentScopeKey(options.getDraft?.() || {}, options.field || primaryField)}:${scopePathKey(path)}:${statementId || ''}`
    }

    function resultVariableDraftKey(statementId, outputName, path = scopePath) {
      return `${documentScopeKey(options.getDraft?.() || {}, options.field || primaryField)}:${scopePathKey(path)}:${statementId || ''}:${outputName || ''}`
    }

    function expressionBindings(graph, statement, path) {
      const bindings = {}
      const generatedAuthorIds = new Set()
      for (const item of nestedStatements(scopeDefinition(graph, path).body || [])) {
        const metadata = authorStatementMetadata(item)
        for (const id of Array.isArray(metadata?.generatedIds) ? metadata.generatedIds : []) generatedAuthorIds.add(id)
      }
      for (const ref of graphRefs(core, graph, statement.id, path)) {
        if (ref.value?.kind === 'output' && generatedAuthorIds.has(ref.value.node)) continue
        const source = ref.value.kind === 'output' ? statementForLexicalId(graph, ref.value.node, path) : null
        if (source?.layout?.authorExpression) continue
        if (source?.module === 'local.declare' && ref.value.port === 'handle' && source.parameters?.name) {
          const selected = source.parameters.valueType || 'number'
          const selectedType = typeof selected === 'string' && selected.startsWith('{') ? JSON.parse(selected) : selected
          const entityKind = entityKindForValue(graph, ref.value, path)
          const unwrappedType = selectedType?.kind === 'nullable' ? selectedType.value : selectedType
          const multiple = ['list', 'set'].includes(unwrappedType?.kind)
          const domain = entityKind === 'tile-effect' ? (multiple ? 'tile-effects' : 'tile-effect') : entityKind ? `${entityKind}-instance${multiple ? 's' : ''}` : null
          bindings[source.parameters.name] = { value: clone(ref.value), type: selectedType, local: true, ...(domain ? { domain } : {}) }
          continue
        }
        const rawName = ref.value.kind === 'input' ? ref.value.name : source?.layout?.resultNames?.[ref.value.port] || `${ref.value.node}_${ref.value.port}`
        const name = String(rawName).replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^(?=\d)/u, '_')
        if (!name) continue
        const domainByModule = {
          'ref.current-card': 'card-instance',
          'ref.current-skill': 'skill-instance',
          'ref.current-rule': 'rule-instance',
          'ref.current-cluster': 'cluster-instance',
        }
        const domain = domainByModule[source?.module]
        bindings[name] = { value: clone(ref.value), type: ref.type, ...(domain ? { domain } : {}),
          generatedName: ref.value.kind === 'output' && !source?.layout?.resultNames?.[ref.value.port] }
        if (ref.label.startsWith('当前项')) bindings.每项 = { value: clone(ref.value), type: ref.type }
      }
      return bindings
    }

    function authorStatementMetadata(statement) {
      return record(statement?.layout?.authorStatement) ? statement.layout.authorStatement : null
    }

    function authorStatementGroupIds(statement) {
      const metadata = authorStatementMetadata(statement)
      const ids = new Set(Array.isArray(metadata?.generatedIds) ? metadata.generatedIds.filter(Boolean) : [])
      if (statement?.id) ids.add(statement.id)
      return ids
    }

    function authorStatementContext(graph, statements, path, prefix) {
      const targetStatements = Array.isArray(statements) ? statements : scopeDefinition(graph, path, true).body || []
      let targetId = targetStatements.find(item => item?.kind === 'return')?.id || null
      // `scopeReferences` stops immediately before targetId. A temporary
      // return lets a newly inserted statement see every preceding result in
      // a branch that has no explicit terminal return yet.
      let sentinel = '__sentence-author-context__'
      while (targetStatements.some(item => item?.id === sentinel)) sentinel += '_'
      if (!targetId) {
        targetStatements.push({ kind: 'return', id: sentinel, values: {} })
        targetId = sentinel
      }
      let bindings
      try { bindings = expressionBindings(graph, { id: targetId }, path) } finally {
        if (targetId === sentinel) targetStatements.pop()
      }
      const scoped = scopeDefinition(graph, path).graph || graph
      const schemas = graphWithAuthorSchemas(core, schemaGraphForScope(graph, path)).schemas || []
      const extensions = extensionMapDeclarations(graph, path, targetId)
        .filter(item => item.kind === 'value' && item.name)
        .map(item => ({
          scope: item.scope,
          namespace: item.namespace || 'content',
          name: item.name,
          type: serializedValueType(item.valueType, 'record'),
        }))
      return {
        surface: scoped.surface || graph.surface || surfaceForField(options, options.field || primaryField),
        bindings,
        schemas,
        extensions,
        prefix,
      }
    }

    function mergeAuthorSchemas(graph, schemas) {
      if (!Array.isArray(schemas) || !schemas.length) return
      const merged = new Map()
      for (const schema of Array.isArray(graph.schemas) ? graph.schemas : []) {
        if (record(schema)) merged.set(`${schema.id || ''}@${schema.version || ''}`, schema)
      }
      for (const schema of schemas) {
        if (record(schema)) merged.set(`${schema.id || ''}@${schema.version || ''}`, clone(schema))
      }
      graph.schemas = [...merged.values()]
    }

    function remapAuthorOutput(value, from, to) {
      if (Array.isArray(value)) return value.map(item => remapAuthorOutput(item, from, to))
      if (!record(value)) return value
      if (value.kind === 'output' && value.node === from) return { ...value, node: to }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapAuthorOutput(item, from, to)]))
    }

    function stableAuthorStatements(lowered, finalId, metadata) {
      const statements = Array.isArray(lowered?.statements) ? lowered.statements.map(item => clone(item)) : []
      const initialFinal = statements.at(-1)
      if (!initialFinal) throw new Error('作者语句没有生成可写入的实现。')
      const generatedId = initialFinal.id
      if (generatedId && generatedId !== finalId) {
        for (let index = 0; index < statements.length; index += 1) statements[index] = remapAuthorOutput(statements[index], generatedId, finalId)
      }
      const final = statements.at(-1)
      final.id = finalId
      const generatedIds = statements.map(item => item?.id).filter(Boolean)
      final.layout = {
        ...(final.layout || {}),
        authorStatement: {
          ...metadata,
          generatedIds,
          prefix: metadata.prefix || finalId,
          version: 1,
        },
      }
      return statements
    }

    function authorTargetStatements(graph, target, path) {
      return target?.kind === 'root' ? scopeDefinition(graph, path, true).body : statementArrayFor(graph, target, path)
    }

    function authorDefaultExtensionName(graph, path) {
      const used = new Set(extensionMapDeclarations(graph, path).filter(item => item.kind === 'value').map(item => item.name))
      let name = '变量'
      let index = 2
      while (used.has(name)) name = `变量${index++}`
      return name
    }

    function lowerAuthorFacade(nextGraph, targetStatements, path, kind, values, finalId) {
      if (typeof core?.lowerAuthorExtensionDeclaration !== 'function' || typeof core?.lowerAuthorAssignment !== 'function') {
        throw new Error('当前编辑器核心尚未提供统一作者语句接口，请先更新编辑器核心。')
      }
      const prefix = `${finalId}_author`
      const context = authorStatementContext(nextGraph, targetStatements, path, prefix)
      let lowered
      if (kind === 'extension-declaration') {
        lowered = core.lowerAuthorExtensionDeclaration(
          values.ownerSource, values.name, values.valueType, values.initialSource, context,
        )
      } else if (kind === 'assignment') {
        lowered = core.lowerAuthorAssignment(values.targetSource, values.valueSource, context)
      } else throw new Error('不支持的作者语句类型。')
      const metadata = kind === 'extension-declaration'
        ? {
            kind,
            ownerSource: values.ownerSource,
            name: values.name,
            valueType: clone(values.valueType),
            initialSource: values.initialSource,
            scope: lowered.scope,
          }
        : {
            kind,
            targetSource: values.targetSource,
            valueSource: values.valueSource,
            valueType: clone(lowered.valueType),
          }
      const statements = stableAuthorStatements(lowered, finalId, { ...metadata, prefix: finalId })
      mergeAuthorSchemas(scopeDefinition(nextGraph, path).graph || nextGraph, lowered.schemas)
      return { statements, metadata: statements.at(-1)?.layout?.authorStatement || metadata }
    }

    function addAuthorStatement(options, kind, target = { kind: 'root' }, path = options.__sentenceScopePath || []) {
      const field = options.field || primaryField
      const currentDraft = clone(options.getDraft?.() || {})
      const graph = graphWithInitialDraft(options, currentDraft, field).graph
      const nextGraph = clone(graph)
      const targetStatements = authorTargetStatements(nextGraph, target, path)
      if (!Array.isArray(targetStatements)) throw new Error('找不到要插入的分支。')
      const insertionParent = target?.parentId ? statementForId(nextGraph, target.parentId, path) : null
      const dataOnly = target?.branch === 'condition.body' || insertionParent?.kind === 'collection' || insertionParent?.kind?.startsWith?.('collection.')
      if (dataOnly) throw new Error('循环条件和集合子流程只能加入表达式；赋值或声明应放在执行步骤中。')
      const finalId = nextStatementId(nextGraph, `sentence-author-${kind}`)
      const values = kind === 'extension-declaration'
        ? { ownerSource: '当前玩家', name: authorDefaultExtensionName(nextGraph, path), valueType: 'number', initialSource: '0' }
        : (() => {
            const context = authorStatementContext(nextGraph, targetStatements, path, `${finalId}_probe`)
            const local = Object.entries(context.bindings || {}).find(([, item]) => item?.local)
            if (local) return { targetSource: local[0], valueSource: local[0] }
            const candidates = [['当前棋子.动量', '0'], ['当前技能.冷却', '0']]
            for (const [targetSource, valueSource] of candidates) {
              try { core.lowerAuthorAssignment(targetSource, valueSource, context); return { targetSource, valueSource } } catch { /* try the next bounded writer */ }
            }
            return { targetSource: '当前棋子.动量', valueSource: '0' }
          })()
      const terminal = targetStatements.findIndex(item => item?.kind === 'return')
      const insertionIndex = terminal < 0 ? targetStatements.length : terminal
      const lowered = lowerAuthorFacade(nextGraph, targetStatements, path, kind, values, finalId)
      targetStatements.splice(insertionIndex, 0, ...lowered.statements)
      commitGraphDraft(options, currentDraft, nextGraph, field)
      return finalId
    }

    function replaceAuthorStatement(options, statementId, changes, path = options.__sentenceScopePath || []) {
      const field = options.field || primaryField
      const draft = clone(options.getDraft?.() || {})
      const graph = graphFor(core, draft, field)
      const location = statementLocation(graph, statementId, path)
      const metadata = authorStatementMetadata(location?.statement)
      if (!location?.statement || !metadata) throw new Error('找不到统一作者语句。')
      const nextGraph = clone(graph)
      const nextLocation = statementLocation(nextGraph, statementId, path)
      const ids = authorStatementGroupIds(nextLocation.statement)
      const indexes = nextLocation.statements.map((item, index) => ids.has(item?.id) ? index : -1).filter(index => index >= 0)
      const insertionIndex = indexes.length ? Math.min(...indexes) : nextLocation.index
      for (let index = nextLocation.statements.length - 1; index >= 0; index -= 1) if (ids.has(nextLocation.statements[index]?.id)) nextLocation.statements.splice(index, 1)
      const nextMetadata = { ...metadata, ...changes }
      const values = nextMetadata.kind === 'extension-declaration'
        ? { ownerSource: nextMetadata.ownerSource, name: nextMetadata.name, valueType: nextMetadata.valueType, initialSource: nextMetadata.initialSource }
        : { targetSource: nextMetadata.targetSource, valueSource: nextMetadata.valueSource }
      const lowered = lowerAuthorFacade(nextGraph, nextLocation.statements, path, nextMetadata.kind, values, statementId)
      nextLocation.statements.splice(insertionIndex, 0, ...lowered.statements)
      // Remove the editor-only draft before the graph callback can trigger a
      // host render. If lowering failed, the draft is still present and the
      // caller keeps the inspector open for correction.
      authorStatementDrafts.delete(authorStatementDraftKey(statementId, path))
      commitGraphDraft(options, draft, nextGraph, field)
      notifyEditorStateChange()
      openPopover = { control: 'statement', statementId, scopePath: path }
      return statementId
    }

    // Expression ownership is editing metadata, including expressions used
    // inside a typed object. Keep it with both the field and generated reads
    // so editing a single field replaces its previous expression cleanly.
    const authorExpressionLayoutKinds = new Set(['call', 'if', 'foreach', 'while', 'return', 'record.create', 'record.get', 'record.with'])
    const supportsAuthorExpressionLayout = statement => authorExpressionLayoutKinds.has(statement?.kind)

    function expressionLiteral(value) {
      if (Array.isArray(value)) return `{${value.map(expressionLiteral).join(', ')}}`
      if (record(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${expressionLiteral(item)}`).join(', ')}}`
      return JSON.stringify(value)
    }

    // Code-block definitions are authored as a data expression so the normal
    // expression editor can type-check and lower them without accepting code.
    // Keep the nested body editor on the same boundary: it only accepts the
    // literal/object/tuple AST produced by parseAuthorExpression, and writes
    // the result back through the existing block expression apply action.
    function authorExpressionData(ast) {
      if (!record(ast)) throw new Error('代码块定义只能由数据记录组成。')
      if (ast.kind === 'literal') return clone(ast.value)
      if (ast.kind === 'tuple') return ast.items.map(authorExpressionData)
      if (ast.kind === 'object') return Object.fromEntries(ast.fields.map(field => [field.name, authorExpressionData(field.value)]))
      throw new Error('代码块定义不能包含变量、函数或运算表达式。')
    }

    function authorExpressionDataSource(value) {
      if (Array.isArray(value)) return `{${value.map(authorExpressionDataSource).join(', ')}}`
      if (record(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${authorExpressionDataSource(item)}`).join(', ')}}`
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
      throw new Error('代码块定义包含不可序列化的数据。')
    }

    function codeBlockSourceData(statement) {
      const authoredData = statement?.layout?.authorExpressions?.block?.data
      if (record(authoredData) && record(authoredData.graph) && Array.isArray(authoredData.graph.body)) return clone(authoredData)
      const source = statement?.layout?.authorExpressions?.block?.source
      if (typeof source !== 'string' || !source.trim() || typeof core?.parseAuthorExpression !== 'function') return null
      try {
        const value = authorExpressionData(core.parseAuthorExpression(source))
        if (!record(value) || !record(value.graph) || !Array.isArray(value.graph.body)) return null
        return value
      } catch (error) {
        return { __error: error?.message || String(error) }
      }
    }

    // A block body is a closed graph statement union (calls and returns),
    // while the author-expression tuple compiler intentionally requires every
    // tuple item to have one exact record schema.  Keep the block's top-level
    // expression editor on that existing path and rebuild only the nested
    // body as a typed list<record> in the outer graph.  The block compiler
    // revalidates the resulting data at invocation, so this does not add an
    // interpreter or a second execution format.
    function applyCodeBlockBodyGraphChange(outerGraph, statementId, bodyData, path) {
      const location = statementLocation(outerGraph, statementId, path)
      const statement = location?.statement
      const blockReference = statement?.inputs?.block
      if (!location || !record(blockReference) || blockReference.kind !== 'output') throw new Error('代码块定义尚未生成可编辑的记录。')
      const blockNode = statementForId(outerGraph, blockReference.node, path)
      const graphReference = blockNode?.kind === 'record.create' ? blockNode.fields?.graph : null
      if (!record(graphReference) || graphReference.kind !== 'output') throw new Error('无法定位代码块内部流程图。')
      const graphNode = statementForId(outerGraph, graphReference.node, path)
      if (graphNode?.kind !== 'record.create') throw new Error('代码块内部流程图不是可编辑记录。')
      const graphSchema = (Array.isArray(outerGraph.schemas) ? outerGraph.schemas : []).find(schema => `${schema?.id}@${schema?.version}` === graphNode.schema)
      const bodyField = graphSchema?.fields?.find(field => field?.name === 'body')
      if (!bodyField) throw new Error('代码块流程图缺少 body 字段。')
      const body = Array.isArray(bodyData?.graph?.body) ? bodyData.graph.body : []

      // The nested body is serialized into a collection of record statements
      // in the owning graph.  A body edit replaces that collection; keeping
      // the previous collection in the outer statement list leaves it
      // unreachable but still compiled, so each edit grows the saved graph.
      // Use the code-block statement id as an ownership prefix for new
      // generated nodes, and also remove the currently referenced legacy
      // chain so older documents are repaired on their first edit.
      const ownerKey = String(statement.id || statementId || 'code-block').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'code-block'
      const generatedStatementPrefix = `code-block-body-${ownerKey}`
      const generatedSchemaPrefix = `code-block-body-schema-${ownerKey}`
      const generatedModules = new Set(['collection.singleton', 'collection.concat', 'record.create'])
      const generatedStatementIds = new Set()
      const generatedSchemaIds = new Set()
      const isGeneratedStatement = item => record(item)
        && (generatedModules.has(item.module) || item.kind === 'record.create')
      const isGeneratedStatementId = id => typeof id === 'string'
        && (id.startsWith(`${generatedStatementPrefix}-`) || id.startsWith('code-block-body-'))
      const rememberGenerated = item => {
        if (!isGeneratedStatement(item) || !isGeneratedStatementId(item.id)) return false
        generatedStatementIds.add(item.id)
        if (item.module === 'record.create' && typeof item.schema === 'string') generatedSchemaIds.add(item.schema.split('@')[0])
        if (item.kind === 'record.create' && typeof item.schema === 'string') generatedSchemaIds.add(item.schema.split('@')[0])
        return true
      }
      const rememberOwnedGenerated = item => {
        if (!isGeneratedStatement(item) || typeof item.id !== 'string' || !item.id.startsWith(`${generatedStatementPrefix}-`)) return false
        generatedStatementIds.add(item.id)
        if (item.kind === 'record.create' && typeof item.schema === 'string') generatedSchemaIds.add(item.schema.split('@')[0])
        return true
      }
      const statementById = id => location.statements.find(item => item?.id === id)
      const collectGeneratedReferences = (value, seen = new Set()) => {
        if (!record(value) || seen.has(value)) return
        seen.add(value)
        if (value.kind === 'output' && typeof value.node === 'string') {
          const source = statementById(value.node)
          if (rememberGenerated(source) && !generatedStatementIds.has(`${source.id}:visited`)) {
            const visitedKey = `${source.id}:visited`
            generatedStatementIds.add(visitedKey)
            collectGeneratedReferences(source.inputs, seen)
            collectGeneratedReferences(source.fields, seen)
          }
          return
        }
        for (const [key, child] of Object.entries(value)) if (key !== 'layout') collectGeneratedReferences(child, seen)
      }
      collectGeneratedReferences(graphNode.fields?.body)
      for (const item of location.statements) rememberOwnedGenerated(item)
      // The temporary :visited markers above only prevent recursive walks;
      // keep the actual statement ids as the removal set.
      for (const id of [...generatedStatementIds]) if (id.endsWith(':visited')) generatedStatementIds.delete(id)
      for (let index = location.statements.length - 1; index >= 0; index -= 1) {
        if (generatedStatementIds.has(location.statements[index]?.id)) location.statements.splice(index, 1)
      }
      if (generatedSchemaIds.size || generatedSchemaPrefix) {
        outerGraph.schemas = (Array.isArray(outerGraph.schemas) ? outerGraph.schemas : []).filter(schema => {
          const schemaId = schema?.id
          return !(generatedSchemaIds.has(schemaId) || (typeof schemaId === 'string' && schemaId.startsWith(`${generatedSchemaPrefix}-`)))
        })
      }

      const usedStatementIds = new Set(nestedStatements(outerGraph.body).map(item => item?.id).filter(Boolean))
      const usedSchemaIds = new Set((Array.isArray(outerGraph.schemas) ? outerGraph.schemas : []).map(schema => schema?.id).filter(Boolean))
      let statementSerial = 1
      let schemaSerial = 1
      const freshStatementId = prefix => {
        let id = `${prefix}-${statementSerial++}`
        while (usedStatementIds.has(id)) id = `${prefix}-${statementSerial++}`
        usedStatementIds.add(id)
        return id
      }
      const freshSchemaId = prefix => {
        let id = `${prefix}-${schemaSerial++}`
        while (usedSchemaIds.has(id)) id = `${prefix}-${schemaSerial++}`
        usedSchemaIds.add(id)
        return id
      }
      const generated = []
      const generatedSchemas = []
      const encodeType = type => typeof type === 'string' ? type : JSON.stringify(type)
      const primitiveType = value => value === null ? 'null' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string'
      const sameEncodedType = (left, right) => JSON.stringify(left) === JSON.stringify(right)

      const emitValue = value => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('代码块 body 只能包含有限数值。')
          return { value: literal(value), type: primitiveType(value) }
        }
        if (Array.isArray(value)) return emitList(value)
        if (record(value)) return emitRecord(value)
        throw new Error('代码块 body 包含不可序列化字段。')
      }
      const emitList = values => {
        // Empty serialized collections have no runtime element to infer.  A
        // gameplay graph schema cannot use the compiler's universal `any`
        // type, so use the ordinary data record boundary for an empty list.
        // The list is still a literal value and later non-empty edits rebuild
        // its precise element type.
        if (!values.length) return { value: literal([]), type: { kind: 'list', element: 'record' } }
        const entries = values.map(emitValue)
        let elementType = entries[0].type
        if (entries.some(entry => !sameEncodedType(entry.type, elementType))) {
          elementType = entries.every(entry => typeof entry.type === 'object' && entry.type.kind === 'record') ? 'record' : 'any'
        }
        const singletonRefs = entries.map(entry => {
          const id = freshStatementId(`${generatedStatementPrefix}-item`)
          generated.push({ kind: 'call', id, module: 'collection.singleton', version: '1', inputs: { value: entry.value }, parameters: { valueType: encodeType(elementType) } })
          return reference(id, 'items')
        })
        let listReference = singletonRefs[0]
        for (let index = 1; index < singletonRefs.length; index += 1) {
          const id = freshStatementId(`${generatedStatementPrefix}-list`)
          generated.push({
            kind: 'call', id, module: 'collection.concat', version: '1',
            inputs: { left: listReference, right: singletonRefs[index] },
            parameters: { valueType: JSON.stringify({ kind: 'list', element: elementType }) },
          })
          listReference = reference(id, 'items')
        }
        return { value: listReference, type: { kind: 'list', element: elementType } }
      }
      const emitRecord = value => {
        const fields = {}
        const schemaFields = []
        for (const [name, item] of Object.entries(value)) {
          const emitted = emitValue(item)
          fields[name] = emitted.value
          schemaFields.push({ name, type: emitted.type })
        }
        const schemaId = freshSchemaId(generatedSchemaPrefix)
        generatedSchemas.push({ id: schemaId, version: '1', fields: schemaFields })
        const id = freshStatementId(`${generatedStatementPrefix}-record`)
        generated.push({ kind: 'record.create', id, schema: `${schemaId}@1`, fields })
        return { value: reference(id, 'value'), type: { kind: 'record', schema: `${schemaId}@1` } }
      }

      // `emitValue` closes over both helpers; function declarations are not
      // used here so initialize the list/record references before the first
      // body entry is emitted.
      const listValue = emitList(body)
      bodyField.type = listValue.type
      graphNode.fields.body = listValue.value
      outerGraph.schemas = [...(Array.isArray(outerGraph.schemas) ? outerGraph.schemas : []), ...generatedSchemas]
      // The graph record consumes `body`, so its generated collection must
      // dominate the graph record itself.  Inserting only before the outer
      // invoke leaves the reference out of scope at compile time.
      const graphLocation = statementLocation(outerGraph, graphNode.id, path)
      location.statements.splice(graphLocation?.index ?? location.index, 0, ...generated)
      statement.layout = {
        ...(statement.layout || {}),
        authorExpressions: {
          ...(statement.layout?.authorExpressions || {}),
          block: {
            ...(statement.layout?.authorExpressions?.block || {}),
            data: clone(bodyData),
          },
        },
      }
    }

    function renderCodeBlockBodyEditor(statement, graph, path) {
      const data = codeBlockSourceData(statement)
      const panel = node('section', undefined, 'sentence-code-block-body-editor')
      panel.dataset.codeBlockBodyEditor = statement.id || ''
      panel.append(node('h4', '代码块执行内容', 'sentence-inline-editor-section'))
      if (!data) {
        panel.append(node('p', '先填写代码块定义后，才能编辑其中的执行内容。', 'sentence-inline-editor-copy'))
        return panel
      }
      if (data.__error) {
        panel.append(node('p', `当前代码块定义无法展开：${data.__error}`, 'sentence-invalid-field'))
        return panel
      }
      const blockGraph = clone(data.graph)
      const nestedHost = node('div', undefined, 'sentence-code-block-body-normal-editor')
      nestedHost.dataset.codeBlockBodyNormalEditor = statement.id || ''
      panel.append(node('p', '代码块使用与外层流程相同的模块、条件、循环、记录和返回编辑器。', 'sentence-inline-editor-copy'), nestedHost)
      let nestedDraft = {
        gameplayModules: {
          version: core?.GAMEPLAY_MODULE_DOCUMENT_VERSION || 'rvb-gameplay-module-document/v1',
          entries: { code: { graph: blockGraph } },
        },
      }
      const commit = nextGraph => {
        try {
          const next = clone(data)
          next.graph = clone(nextGraph)
          applyGraphChange(options, outerGraph => {
            applyCodeBlockBodyGraphChange(outerGraph, statement.id, next, path)
          }, undefined, path)
        } catch (error) { report(error.message || String(error), 'error') }
      }
      const nestedEditor = mount(nestedHost, {
        core,
        root: { collection: 'skills', id: `${statement.id || 'code-block'}-body`, name: '代码块执行内容' },
        field: 'code',
        getDraft: () => nestedDraft,
        onChange: next => {
          nestedDraft = next
          const nextGraph = graphFor(core, next, 'code')
          if (record(nextGraph)) {
            // The nested mount is an ordinary editor, so its document wrapper
            // may carry the host editor's compiler metadata.  A code block
            // stores only the pending graph data in its definition; keeping
            // that wrapper metadata makes the outer content validator treat
            // it as a gameplay-module entry and reject the save.  Strip this
            // editor-only field before handing the graph back to the block
            // data boundary.  The outer graph is compiled again by
            // applyGraphChange, so no generated code is persisted here.
            const blockGraph = clone(nextGraph)
            delete blockGraph.compilerVersion
            commit(blockGraph)
          }
        },
      })
      // The parent render owns this nested mount and destroys it before the
      // next render, just like a normal expression editor.
      expressionEditors.add(nestedEditor)
      return panel
    }

    // Older graph documents can contain a lowered static tuple without the
    // author-expression metadata that newer edits attach.  Reconstruct only
    // the closed, literal coordinate subset here.  Any variable, input, or
    // non-whitelisted operation returns null and keeps the existing binding
    // label, so a dynamic range is never overwritten by the range picker.
    function staticNumberFromGraph(graph, value, path, trail = new Set()) {
      if (value?.kind === 'literal') return typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : null
      if (value?.kind !== 'output' || trail.has(value.node)) return null
      const location = statementLocationForLexicalId(graph, value.node, path)
      const source = location?.statement
      if (!source || source.kind !== 'call' || value.port !== 'value') return null
      const nextTrail = new Set(trail); nextTrail.add(value.node)
      const number = inputName => staticNumberFromGraph(graph, source.inputs?.[inputName], location.scopePath || path, nextTrail)
      if (source.module === 'math.floor') {
        const operand = number('value')
        return operand === null ? null : Math.floor(operand)
      }
      if (source.module === 'math.abs') {
        const operand = number('value')
        return operand === null ? null : Math.abs(operand)
      }
      const left = number('left'), right = number('right')
      if (left === null || right === null) return null
      if (source.module === 'math.add') return left + right
      if (source.module === 'math.subtract') return left - right
      if (source.module === 'math.multiply') return left * right
      if (source.module === 'math.divide') return right === 0 ? null : left / right
      if (source.module === 'math.modulo') return right === 0 ? null : left % right
      if (source.module === 'math.power') return left ** right
      return null
    }

    function staticCellFromGraph(graph, value, path, trail = new Set()) {
      if (value?.kind !== 'output' || value.port !== 'cell' || trail.has(value.node)) return null
      const location = statementLocationForLexicalId(graph, value.node, path)
      const source = location?.statement
      if (!source || source.kind !== 'call' || source.module !== 'spatial.cell') return null
      const nextTrail = new Set(trail); nextTrail.add(value.node)
      const x = staticNumberFromGraph(graph, source.inputs?.x, location.scopePath || path, nextTrail)
      const y = staticNumberFromGraph(graph, source.inputs?.y, location.scopePath || path, nextTrail)
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null
      return { x, y }
    }

    function staticCellListFromGraph(graph, value, path, trail = new Set()) {
      if (value?.kind !== 'output' || trail.has(value.node)) return null
      const location = statementLocationForLexicalId(graph, value.node, path)
      const source = location?.statement
      if (!source || source.kind !== 'call' || value.port !== 'items') return null
      const nextTrail = new Set(trail); nextTrail.add(value.node)
      const sourcePath = location.scopePath || path
      if (source.module === 'collection.singleton' && source.parameters?.valueType === 'cell') {
        const cell = staticCellFromGraph(graph, source.inputs?.value, sourcePath, nextTrail)
        return cell ? [cell] : null
      }
      if (source.module === 'collection.concat') {
        const left = staticCellListFromGraph(graph, source.inputs?.left, sourcePath, nextTrail)
        const right = staticCellListFromGraph(graph, source.inputs?.right, sourcePath, nextTrail)
        if (!left || !right || left.length + right.length > 10000) return null
        return [...left, ...right]
      }
      return null
    }

    function staticCellListSource(graph, value, path) {
      const cells = staticCellListFromGraph(graph, value, path)
      return cells ? `{${cells.map(cell => `坐标(${cell.x}, ${cell.y})`).join(', ')}}` : null
    }

    function expressionText(graph, statement, definition, current, path, bindings, metadataName = definition.name) {
      const metadata = authorExpressionMetadataEntry(statement, metadataName, current)
      const legacyName = metadata.legacy ? metadata.name : ''
      const legacyMatches = metadata.legacy
      const savedExpression = metadata.entry
      if (savedExpression && jsonValue(savedExpression.value) === jsonValue(current)) return savedExpression.source
      if (current?.kind === 'literal') return expressionLiteral(current.value)
      if (current?.kind === 'output') {
        const source = statementForLexicalId(graph, current.node, path)
        const authored = source?.layout?.authorExpression
        if (authored?.owner === statement.id && (authored.input === metadataName || legacyMatches && authored.input === legacyName) && typeof authored.source === 'string') return authored.source
      }
      const expectedType = portValueType(definition)
      if (expectedType?.kind === 'list' && expectedType.element === 'cell') {
        const restored = staticCellListSource(graph, current, path)
        if (restored) return restored
      }
      // Production graphs written before author-expression metadata still have
      // enough typed IR to recover a readable value expression.  Only use it
      // as editable text when the author parser accepts the projection; an
      // unsupported legacy host read falls through to its lexical binding so
      // opening the slot never invents executable syntax.
      // Extension reads use the same readable projection as other pure calls,
      // but their storage label is presentation text rather than an
      // author-expression function.  Keep the actual lexical output binding
      // in the editor so applying the unchanged value remains type checked.
      const sourceModule = current?.kind === 'output'
        ? statementForLexicalId(graph, current.node, path)?.module
        : ''
      if (!String(sourceModule || '').startsWith('extension.') && typeof core?.parseAuthorExpression === 'function') {
        const projected = expressionValueLabel(core, graph, current, new Set(), path)
        if (projected && projected !== '未设置') {
          try { core.parseAuthorExpression(projected); return projected } catch { /* use the stable binding below */ }
        }
      }
      const bound = Object.entries(bindings).find(([, binding]) => jsonValue(binding.value) === jsonValue(current))
      return bound?.[0] || ''
    }

    function renderAuthorCodeBlockDefinitionEditor(graph, statement, definition, current, path = scopePath) {
      const panel = node('section', undefined, 'sentence-code-block-definition-editor')
      panel.dataset.sentenceCodeBlockDefinition = statement.id || ''
      panel.append(node('h4', '新建代码块', 'sentence-inline-editor-section'))
      panel.append(node('p', '用表单声明代码块标识、显式参数和返回类型；执行内容随后使用同一套流程编辑器编写。', 'sentence-inline-editor-copy'))

      const existing = codeBlockSourceData(statement)
      const existingGraph = existing && !existing.__error && record(existing.graph) ? existing.graph : null
      const payloadReference = existingGraph?.hostBindings?.payload?.schema
      const payloadSchema = Array.isArray(existingGraph?.schemas)
        ? existingGraph.schemas.find(schema => schema?.id === payloadReference || `${schema?.id}@${schema?.version}` === payloadReference)
        : null
      const state = {
        id: typeof existing?.id === 'string' && existing.id.trim() ? existing.id : `${statement.id || 'code-block'}-definition`,
        arguments: Array.isArray(payloadSchema?.fields) && payloadSchema.fields.length
          ? clone(payloadSchema.fields)
          : [{ name: 'target', type: 'piece' }],
        outputs: Array.isArray(existingGraph?.outputs) && existingGraph.outputs.length
          ? clone(existingGraph.outputs)
          : [{ name: 'result', type: 'boolean' }],
      }

      const field = (label, value, dataset, change) => {
        const wrapper = node('label', undefined, 'sentence-editor-field')
        const input = document.createElement('input')
        input.type = 'text'; input.value = value || ''; input.dataset[dataset] = ''
        input.onchange = () => change(input.value)
        wrapper.append(node('span', label, 'sentence-field-label'), input)
        return wrapper
      }

      const idField = field('代码块标识', state.id, 'sentenceCodeBlockId', value => { state.id = value.trim() || state.id })
      panel.append(idField)

      const argumentsSection = node('section', undefined, 'sentence-code-block-signature-section')
      argumentsSection.dataset.sentenceCodeBlockArguments = ''
      const argumentsHeading = node('div', undefined, 'sentence-config-heading')
      argumentsHeading.append(node('h4', '显式参数', 'sentence-inline-editor-section'))
      const addArgument = action('＋ 添加参数', () => {
        let index = state.arguments.length + 1
        const used = new Set(state.arguments.map(item => item?.name))
        while (used.has(`argument${index}`)) index += 1
        state.arguments.push({ name: `argument${index}`, type: 'string' })
        renderArguments()
      }, 'sentence-config-add')
      addArgument.dataset.sentenceCodeBlockAddArgument = ''
      argumentsHeading.append(addArgument); argumentsSection.append(argumentsHeading)
      const argumentRows = node('div', undefined, 'sentence-code-block-signature-rows')
      argumentsSection.append(argumentRows)

      const outputsSection = node('section', undefined, 'sentence-code-block-signature-section')
      outputsSection.dataset.sentenceCodeBlockOutputs = ''
      const outputsHeading = node('div', undefined, 'sentence-config-heading')
      outputsHeading.append(node('h4', '返回值', 'sentence-inline-editor-section'))
      const addOutput = action('＋ 添加返回值', () => {
        let index = state.outputs.length + 1
        const used = new Set(state.outputs.map(item => item?.name))
        while (used.has(`output${index}`)) index += 1
        state.outputs.push({ name: `output${index}`, type: 'boolean' })
        renderOutputs()
      }, 'sentence-config-add')
      addOutput.dataset.sentenceCodeBlockAddOutput = ''
      outputsHeading.append(addOutput); outputsSection.append(outputsHeading)
      const outputRows = node('div', undefined, 'sentence-code-block-signature-rows')
      outputsSection.append(outputRows)

      const status = node('p', '', 'sentence-code-block-definition-status')
      status.dataset.sentenceCodeBlockDefinitionStatus = ''
      const applyDefinition = action('创建代码块', () => {
        try {
          const id = state.id.trim()
          if (!id) throw new Error('代码块标识不能为空。')
          if (['__proto__', 'prototype', 'constructor'].includes(id)) throw new Error('代码块标识不可使用保留名称。')
          const normalizePorts = (ports, label) => {
            const seen = new Set()
            return ports.map((port, index) => {
              const name = String(port?.name || '').trim()
              if (!name) throw new Error(`${label}${index + 1}的名称不能为空。`)
              if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) throw new Error(`${label}${index + 1}的名称格式不正确。`)
              if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error(`${label}${index + 1}使用了保留名称。`)
              if (seen.has(name)) throw new Error(`${label}名称不能重复：${name}。`)
              seen.add(name)
              return { name, type: clone(port.type || 'string'), ...(port.label ? { label: port.label } : {}) }
            })
          }
          const inputs = normalizePorts(state.arguments, '参数')
          const outputs = normalizePorts(state.outputs, '返回值')
          if (!inputs.length) throw new Error('至少声明一个显式参数。')
          if (!outputs.length) throw new Error('至少声明一个返回值。')
          const schemaId = `${id}.arguments`
          const schemaReference = `${schemaId}@1`
          const graphVersion = core?.GAMEPLAY_MODULE_GRAPH_VERSION || 'rvb-gameplay-modules/v1'
          const schemas = [{ id: schemaId, version: '1', fields: inputs }]
          const knownSchemas = new Set([schemaReference])
          const collectTypeSchemas = type => {
            if (!record(type)) return
            if (type.kind === 'record' && type.schema) {
              const schema = schemaForGraph(schemaGraphForScope(graph, path), type.schema)
              if (!schema) throw new Error(`找不到记录结构：${type.schema}`)
              const reference = `${schema.id}@${schema.version}`
              if (!knownSchemas.has(reference)) { knownSchemas.add(reference); schemas.push(clone(schema)) }
              return
            }
            if (['list', 'set', 'nullable'].includes(type.kind)) collectTypeSchemas(type.element || type.value)
            if (type.kind === 'map') { collectTypeSchemas(type.key); collectTypeSchemas(type.value) }
          }
          inputs.forEach(port => collectTypeSchemas(port.type))
          outputs.forEach(port => collectTypeSchemas(port.type))
          const blockGraph = {
            version: graphVersion,
            surface: 'pending',
            inputs: [{ name: 'payload', type: { kind: 'record', schema: schemaReference }, label: '执行载荷' }],
            schemas,
            hostBindings: { payload: { kind: 'record', schema: schemaReference } },
            outputs,
            body: [],
          }
          blockGraph.body = [{
            kind: 'return',
            id: 'return-result',
            values: Object.fromEntries(outputs.map(port => [port.name, { kind: 'literal', value: defaultLiteralFor(port, blockGraph) }])),
          }]
          const source = authorExpressionDataSource({
            version: 'rvb-author-code-block/v1',
            id,
            graph: blockGraph,
          })
          const editor = hiddenGeneric.querySelector('.ei-editor')
          const apply = hiddenGeneric.querySelector('[data-sentence-apply-expression="block"]')
          if (!editor || !apply) throw new Error('代码块定义编辑器尚未就绪。')
          editor.textContent = source
          editor.dispatchEvent(new Event('input', { bubbles: true }))
          if (apply.disabled) throw new Error('代码块定义未通过类型校验。')
          apply.click()
        } catch (error) {
          status.textContent = error?.message || String(error)
          status.classList.add('sentence-invalid-field')
        }
      }, 'sentence-code-block-create')
      applyDefinition.dataset.sentenceCodeBlockCreate = ''

      function renderArguments() {
        argumentRows.replaceChildren()
        state.arguments.forEach((item, index) => {
          const row = node('div', undefined, 'sentence-code-block-signature-row')
          row.dataset.sentenceCodeBlockArgument = String(index)
          const name = document.createElement('input')
          name.type = 'text'; name.value = item.name || ''; name.placeholder = '参数名'; name.dataset.sentenceCodeBlockArgumentName = ''
          name.onchange = () => { item.name = name.value.trim() }
          const type = typeControl(item.type || 'string', value => { item.type = clone(value) }, graph, 'sentenceCodeBlockArgumentType')
          const remove = action('删除', () => {
            if (state.arguments.length <= 1) { status.textContent = '至少保留一个显式参数。'; return }
            state.arguments.splice(index, 1); renderArguments()
          }, 'sentence-config-remove')
          row.append(node('span', `参数 ${index + 1}`, 'sentence-field-label'), name, type, remove)
          argumentRows.append(row)
        })
      }

      function renderOutputs() {
        outputRows.replaceChildren()
        state.outputs.forEach((item, index) => {
          const row = node('div', undefined, 'sentence-code-block-signature-row')
          row.dataset.sentenceCodeBlockOutput = String(index)
          const name = document.createElement('input')
          name.type = 'text'; name.value = item.name || ''; name.placeholder = '返回值名'; name.dataset.sentenceCodeBlockOutputName = ''
          name.onchange = () => { item.name = name.value.trim() }
          const type = typeControl(item.type || 'boolean', value => { item.type = clone(value) }, graph, 'sentenceCodeBlockOutputType')
          const remove = action('删除', () => {
            if (state.outputs.length <= 1) { status.textContent = '至少保留一个返回值。'; return }
            state.outputs.splice(index, 1); renderOutputs()
          }, 'sentence-config-remove')
          row.append(node('span', `返回值 ${index + 1}`, 'sentence-field-label'), name, type, remove)
          outputRows.append(row)
        })
      }

      const hiddenGeneric = renderAuthorExpression(graph, statement, definition, current, path, { forceGeneric: true, hidden: true })
      hiddenGeneric.hidden = true
      panel.append(argumentsSection, outputsSection, status, applyDefinition, hiddenGeneric)
      renderArguments(); renderOutputs()
      return panel
    }

    function renderAuthorExpression(graph, statement, definition, current, path = scopePath, renderOptions = {}) {
      const originalDefinitionName = definition.name
      const authorExpressionName = authorExpressionMetadataName(statement, originalDefinitionName)
      if (['record.create', 'record.with'].includes(statement.kind) && definition.name.startsWith('field:')) {
        definition = { ...definition, name: definition.name.slice('field:'.length) }
      }
      if (!renderOptions.forceGeneric && statement.module === 'code-block.invoke' && definition.name === 'block') {
        return renderAuthorCodeBlockDefinitionEditor(graph, statement, definition, current, path)
      }
      const key = `${documentScopeKey(options.getDraft?.())}:${scopePathKey(path)}:${statement.id}:${authorExpressionName}`
      const bindings = expressionBindings(graph, statement, path)
      if (statement.module === 'local.write' && definition.name === 'handle') for (const [name, value] of Object.entries(bindings)) {
        if (value.local) bindings[name] = { ...value, type: 'record', local: false }
        else delete bindings[name]
      }
      // Choice v3 derives the public input type from the map expression.  Its
      // descriptor default is intentionally a string-valued map, but using
      // that default as the editor's expected type would reject a perfectly
      // valid numeric (or otherwise typed) map before inference can update
      // optionsType/valueType. Keep the broad record boundary here and make
      // the validation below require a real text-keyed map.
      const derivesChoiceMapType = statement.module === 'author.choice.option'
        && String(statement.version) === '3' && definition.name === 'options'
      const expected = derivesChoiceMapType ? 'record' : portValueType(definition)
      const inferredParameters = type => {
        const encode = value => typeof value === 'string' ? value : JSON.stringify(value)
        if (['skill.add', 'skill.remove'].includes(statement.module) && String(statement.version) === '2'
          && definition.name === 'owner' && ['piece', 'player'].includes(type)) return { ownerType: type }
        if (statement.module === 'content.materialize-template' && String(statement.version) === '2'
          && ['fields', 'extension'].includes(definition.name) && (type === 'record' || type?.kind === 'record')) return { [`${definition.name}Type`]: encode(type) }
        if (/^author\.effect\.(damage|heal)$/.test(statement.module) && statement.version === '2') {
          if (definition.name === 'source' && ['piece', 'player', 'card', 'record'].includes(type)) return { sourceType: type }
          if (definition.name === 'target' && (type === 'piece' || statement.module === 'author.effect.damage' && type === 'record' || type?.kind === 'list' && type.element === 'piece')) {
            return { targetType: encode(type), resultType: encode(type === 'piece' || type === 'record' ? 'record' : { kind: 'list', element: 'record' }) }
          }
          if (definition.name === 'amount' && (type === 'number' || type?.kind === 'list' && type.element === 'number')) return { amountType: encode(type) }
        }
        if (statement.module === 'rule.remove-id-raw' && String(statement.version) === '2'
          && definition.name === 'target' && (type === 'string' || type === 'record')) return { targetType: type }
        if (statement.module === 'author.card.gain' && definition.name === 'extension' && (type === 'record' || type?.kind === 'record')) return { extensionType: encode(type) }
        if (statement.module === 'author.effect.summon') {
          if (definition.name === 'source' && ['piece', 'record'].includes(type)) return { sourceType: type }
          if (definition.name === 'template') return { templateType: encode(type) }
          if (definition.name === 'destination' && (type === 'cell' || type?.kind === 'list' && type.element === 'cell')) return { destinationType: encode(type) }
          if (definition.name === 'display' && (type === 'record' || type?.kind === 'record')) return { displayType: encode(type) }
        }
        if (statement.module === 'author.piece.display' && definition.name === 'display' && (type === 'record' || type?.kind === 'record')) return { displayType: encode(type) }
        if (statement.module === 'author.cluster.acquire' && definition.name === 'definition' && (type === 'record' || type?.kind === 'record')) return { definitionType: encode(type) }
        if (statement.module === 'code-block.invoke' && ['block', 'args'].includes(definition.name) && (type === 'record' || type?.kind === 'record')) return { [`${definition.name}Type`]: encode(type) }
        if (derivesChoiceMapType && type?.kind === 'map' && type.key === 'string') {
          const valueType = statement.parameters?.selectionMode === 'multi' ? { kind: 'list', element: type.value } : type.value
          return { optionsType: encode(type), valueType: encode(valueType) }
        }
        const mapModule = /^map\.(create|get|set|delete|count)$/.test(statement.module) || /^map\.(has-key|keys|values)$/.test(statement.module) && String(statement.version) === '2'
        const setModule = /^set\.(create|contains|add|delete|items|count)$/.test(statement.module)
        if (mapModule || setModule) {
          const container = serializedValueType(statement.parameters?.containerType, mapModule ? { kind: 'map', key: 'string', value: 'number' } : { kind: 'set', element: 'number' })
          let next = null
          if (mapModule) {
            if (definition.name === 'map' && type?.kind === 'map') next = type
            if (statement.module === 'map.create' && type?.kind === 'list' && container?.kind === 'map') {
              if (definition.name === 'keys') next = { ...container, key: type.element }
              if (definition.name === 'values') next = { ...container, value: type.element }
            }
            if (next) return { containerType: encode(next), keyType: encode(next.key), valueType: encode(next.value), keysType: encode({ kind: 'list', element: next.key }), valuesType: encode({ kind: 'list', element: next.value }) }
          } else {
            if (definition.name === 'set' && type?.kind === 'set') next = type
            if (statement.module === 'set.create' && definition.name === 'items' && type?.kind === 'list') next = { kind: 'set', element: type.element }
            if (next) return { containerType: encode(next), valueType: encode(next.element), itemsType: encode({ kind: 'list', element: next.element }) }
          }
        }
        return null
      }
      const wrapper = node('div', undefined, 'sentence-author-expression')
      // Keep the explicit field: prefix on DOM hooks so focused record-field
      // editors remain addressable beside the bare metadata key used by old
      // saved graphs. The latter continues to be used internally below.
      wrapper.dataset.sentenceAuthorExpression = originalDefinitionName
      if (renderOptions.hidden) wrapper.hidden = true
      const header = node('div', undefined, 'sentence-author-expression-header')
      const label = node('span', semanticSlotLabel(definition, definition.name), 'sentence-field-label')
      const status = node('span', `需要${contextualTypeLabel(expected, definition)}`, 'sentence-author-expression-type')
      const editorHost = node('div')
      const footer = node('div', undefined, 'sentence-author-expression-footer')
      header.append(label, status); wrapper.append(header, editorHost, footer)
      const schemas = graphWithAuthorSchemas(core, schemaGraphForScope(graph, path)).schemas || []
      const extensions = extensionMapDeclarations(graph, path, statement.id).filter(item => item.kind === 'value').map(item => ({ ...item, type: serializedValueType(item.valueType, 'record') }))
      const context = { surface: graph.surface, bindings, schemas, extensions, expectedType: expected }
      let value = expressionDrafts.get(key) ?? expressionText(graph, statement, definition, current, path, bindings, authorExpressionName)
      // A missing typed tuple is an empty author expression, not an omitted
      // editor. Keep this as an editor draft only; the graph remains sparse
      // until the author presses 应用.
      if (!String(value || '').trim() && current == null && originalDefinitionName.startsWith('field:') && expected?.kind === 'list') value = '{}'
      let valid = false
      const validate = () => {
        try {
          const lowered = core.lowerAuthorExpression(value, context)
          const inferred = inferredParameters(lowered.type)
          valid = derivesChoiceMapType ? Boolean(inferred) : Boolean(inferred) || compatibleType(lowered.type, expected)
          const actualLabel = authoredValueLabel(lowered)
          status.textContent = valid ? actualLabel : `需要${contextualTypeLabel(expected, definition)}，当前为${actualLabel}`
        } catch (error) { valid = false; status.textContent = value.trim() ? error.message : `需要${contextualTypeLabel(expected, definition)}` }
        status.dataset.valid = String(valid)
        apply.disabled = !valid
      }
      const apply = action('应用', () => {
        try {
          const draft = clone(options.getDraft?.() || {})
          const field = options.field || primaryField
          const nextGraph = graphFor(core, draft, field)
          const location = statementLocation(nextGraph, statement.id, path)
          if (!location?.statement) throw new Error('此语句已经移除')
          const owner = scopeDefinition(nextGraph, path).graph || nextGraph
          const nextBindings = expressionBindings(nextGraph, location.statement, path)
          if (statement.module === 'local.write' && definition.name === 'handle') for (const [name, item] of Object.entries(nextBindings)) {
            if (item.local) nextBindings[name] = { ...item, type: 'record', local: false }
            else delete nextBindings[name]
          }
          const prefix = nextStatementId(nextGraph, 'expr')
          const lowered = core.lowerAuthorExpression(value, { ...context, bindings: nextBindings, schemas: graphWithAuthorSchemas(core, schemaGraphForScope(nextGraph, path)).schemas || [], prefix })
          const inferred = inferredParameters(lowered.type)
          if (!inferred && (derivesChoiceMapType || !compatibleType(lowered.type, expected))) throw new Error(`此处需要${derivesChoiceMapType ? '文本键映射' : typeLabel(expected)}`)
          if (statement.module === 'local.write' && definition.name === 'handle') {
            const variable = statementForLexicalId(graph, lowered.value.node, path)
            if (variable?.module !== 'local.declare') throw new Error('赋值目标须为已声明的变量')
          }
          if (inferred) location.statement.parameters = { ...(location.statement.parameters || {}), ...inferred }
          // Replace only nodes owned by this parameter. Intermediate outputs
          // are not offered as variables, so external author rows cannot bind them.
          const prior = location.statement.layout?.authorExpressions?.[authorExpressionName]
          const legacyExpressionName = authorExpressionName?.startsWith?.('field:') ? authorExpressionName.slice('field:'.length) : ''
          const legacyPrior = !prior && legacyExpressionName
            ? location.statement.layout?.authorExpressions?.[legacyExpressionName]
            : null
          const legacyMatches = legacyAuthorExpressionMetadataMatches(location.statement, legacyPrior, current)
          const priorNames = new Set([authorExpressionName, ...(legacyMatches ? [legacyExpressionName] : [])])
          const oldIds = new Set([
            ...(Array.isArray(prior?.nodes) ? prior.nodes : []),
            ...(legacyMatches && Array.isArray(legacyPrior?.nodes) ? legacyPrior.nodes : []),
          ])
          for (const item of location.statements) {
            const authored = item?.layout?.authorExpression
            if (authored?.owner === statement.id && priorNames.has(authored.input)) oldIds.add(item.id)
          }
          for (let index = location.statements.length - 1; index >= 0; index -= 1) if (oldIds.has(location.statements[index].id)) location.statements.splice(index, 1)
          const consumerIndex = location.statements.findIndex(item => item.id === statement.id)
          for (const item of lowered.statements) if (supportsAuthorExpressionLayout(item)) {
            item.layout = { ...(item.layout || {}), authorExpression: { owner: statement.id, input: authorExpressionName, source: value } }
          }
          location.statements.splice(consumerIndex, 0, ...lowered.statements)
          owner.schemas = lowered.schemas
          if (!setStatementValue(location.statement, authorExpressionName, lowered.value)) throw new Error('此参数不支持表达式')
           if (/^extension\.(declare|read|write)-instance$/.test(statement.module || '') && definition.name === 'entity') {
             const entityKind = entityKindForValue(nextGraph, lowered.value, path)
             if (entityKind) location.statement.parameters = { ...(location.statement.parameters || {}), entityKind }
           }
          // The block body has a closed statement union whose members cannot
          // share one author-expression tuple schema.  The body editor keeps
          // its data-only form in the authoring metadata and lowers it into
          // the outer graph separately.  Rebuild that lowering when the
          // surrounding block expression is edited so a source edit cannot
          // silently discard body statements.
          const priorBlockData = statement.module === 'code-block.invoke' && definition.name === 'block'
            && record(prior?.data) && record(prior.data.graph) && Array.isArray(prior.data.graph.body)
            ? clone(prior.data)
            : null
          if (priorBlockData) applyCodeBlockBodyGraphChange(nextGraph, location.statement.id, priorBlockData, path)
          const hasOldReference = item => {
            if (!item || typeof item !== 'object') return false
            if (item.kind === 'output' && oldIds.has(item.node)) return true
            return Object.entries(item).some(([key, value]) => key !== 'layout' && hasOldReference(value))
          }
          if (hasOldReference(nextGraph)) throw new Error('其他语句正在引用此表达式的内部结果，请先修改该引用')
          if (supportsAuthorExpressionLayout(location.statement)) {
            const priorLayout = location.statement.layout?.authorExpressions?.[authorExpressionName]
              || (legacyMatches ? legacyPrior : null)
            const authorExpressions = {
              ...(location.statement.layout?.authorExpressions || {}),
            }
            if (legacyMatches && legacyExpressionName !== authorExpressionName) delete authorExpressions[legacyExpressionName]
            location.statement.layout = {
              ...(location.statement.layout || {}),
              authorExpressions: {
                ...authorExpressions,
                [authorExpressionName]: {
                  ...(record(priorLayout) ? priorLayout : {}),
                  source: value,
                  value: lowered.value,
                  nodes: lowered.statements.map(item => item.id),
                },
              },
            }
          } else if (location.statement.layout?.authorExpressions) {
            const remaining = { ...(location.statement.layout.authorExpressions || {}) }
            delete remaining[authorExpressionName]
            if (Object.keys(remaining).length) location.statement.layout = { ...location.statement.layout, authorExpressions: remaining }
            else {
              const nextLayout = { ...location.statement.layout }
              delete nextLayout.authorExpressions
              if (Object.keys(nextLayout).length) location.statement.layout = nextLayout
              else delete location.statement.layout
            }
          }
          if (statement.module === 'local.write' && definition.name === 'handle') {
            location.statement.parameters = { ...(location.statement.parameters || {}), valueType: statementForLexicalId(graph, lowered.value.node, path).parameters.valueType }
          }
          const result = commitGraphDraft(options, draft, nextGraph, field)
          // This parameter was parsed, type-checked, lowered, and written to
          // the graph. A separate incomplete sibling can still leave a graph
          // diagnostic, but retaining this applied text in editorState would
          // make Save/Trial report a false unapplied edit forever. Keep that
          // sibling diagnostic while clearing this parameter's local draft.
          expressionDrafts.delete(key)
          notifyEditorStateChange()
          if (!result.diagnostic) closePopover()
          else render()
        } catch (error) { status.textContent = error.message || String(error); status.dataset.valid = 'false' }
      }, 'sentence-author-expression-apply')
          apply.dataset.sentenceApplyExpression = originalDefinitionName
      footer.append(node('small', 'Tab 补全 · Ctrl / ⌘ + Enter 应用'), apply)
      const widget = window.ExpressionInput.mount(editorHost, {
        value, label: semanticSlotLabel(definition, definition.name), placeholder: `输入${contextualTypeLabel(expected, definition)}表达式`,
        getSuggestions: (_query, details) => core.completeAuthorExpression(details.prefix, context)
          .filter(item => !bindings[item.value]?.generatedName),
        getParameterHint: details => core.authorExpressionParameterHint?.(details.prefix, context),
        onCompositionEnd: flushPendingRender,
        onInspect: (reference, details) => {
          wrapper.querySelector('.sentence-expression-inspector')?.remove()
          const inspector = node('div', undefined, 'sentence-expression-inspector')
          inspector.setAttribute('role', 'dialog'); inspector.setAttribute('aria-label', '变量详情')
          inspector.append(action('关闭详情', () => inspector.remove(), 'sentence-link-action'))
          try {
            const info = core.describeAuthorReference(reference, details.prefix, context)
            inspector.append(node('strong', info.name), node('p', `类型：${info.type}`))
            if (own(info, 'value')) inspector.append(node('p', `当前字面值：${JSON.stringify(info.value)}`))
            for (const field of info.fields) inspector.append(node('p', `${field.name} · ${field.type}`))
            if (!info.fields.length) inspector.append(node('small', '此值没有可继续展开的已声明字段。'))
          } catch (error) { inspector.append(node('p', error.message || String(error))) }
          wrapper.append(inspector)
        },
        onChange: text => { value = text; expressionDrafts.set(key, text); notifyEditorStateChange(); validate() },
        onExpand: () => { wrapper.classList.toggle('sentence-author-expression-expanded'); widget.focus() },
      })
      editorHost.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229 || widget.isComposing?.()) return
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          if (valid) apply.click()
        }
      })
      expressionEditors.add(widget)
      const rangeButton = action('绘制相对范围', () => {
        wrapper.classList.add('sentence-author-expression-expanded')
        wrapper.querySelector('.sentence-range-picker')?.remove()
        const panel = node('section', undefined, 'sentence-range-picker')
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '绘制相对范围')
        const controls = node('div', undefined, 'sentence-range-controls')
        const grid = node('div', undefined, 'sentence-range-grid')
        grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', '相对坐标格')
        const note = node('small')
        let origin = { x: 0, y: 0 }, pickingOrigin = false, radius = 3, dynamicRange = false
        const selected = new Map()
        let replaceSpan = expected?.kind === 'list' && expected.element === 'cell' ? [0, value.length] : null
        try {
          const tree = core.parseAuthorExpression(value)
          const ranges = []
          const visit = item => {
            if (!item || typeof item !== 'object') return
            if (item.kind === 'call' && item.callee.kind === 'identifier' && item.callee.name === '相对地格范围') {
              const argument = item.arguments.find(arg => ['相对坐标', 'offsets'].includes(arg.name)) || item.arguments[1]
              if (argument) ranges.push(argument.value)
            }
            for (const part of Object.values(item)) if (Array.isArray(part)) part.forEach(visit); else if (part && typeof part === 'object') visit(part)
          }
          visit(tree)
          const target = replaceSpan ? tree : ranges.length === 1 ? ranges[0] : null
          if (target) replaceSpan = [target.start, target.end]
          if (target && target.kind !== 'tuple') dynamicRange = true
          const number = item => item?.kind === 'literal' && typeof item.value === 'number' ? item.value : item?.kind === 'unary' && item.operator === '-' && item.operand?.kind === 'literal' ? -item.operand.value : NaN
          for (const item of target?.kind === 'tuple' ? target.items : []) {
            if (item.kind !== 'call' || item.callee.kind !== 'identifier' || item.callee.name !== '坐标') { dynamicRange = true; continue }
            const x = number(item.arguments.find(arg => arg.name === 'x')?.value || item.arguments[0]?.value)
            const y = number(item.arguments.find(arg => arg.name === 'y')?.value || item.arguments[1]?.value)
            if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) { selected.set(`${x},${y}`, { x, y }); radius = Math.min(15, Math.max(radius, Math.abs(x), Math.abs(y))) }
            else dynamicRange = true
          }
        } catch { /* An unfinished expression stays editable; drawing inserts a new tuple at its caret. */ }
        const originButton = action('设置原点', () => { pickingOrigin = !pickingOrigin; draw() }, 'sentence-link-action')
        const size = node('select'); size.setAttribute('aria-label', '坐标画布大小')
        for (const amount of [3, 5, 7, 10, 15]) { const option = node('option', `${amount * 2 + 1} × ${amount * 2 + 1}`); option.value = String(amount); size.append(option) }
        radius = [3, 5, 7, 10, 15].find(amount => amount >= radius)
        size.value = String(radius); size.onchange = () => { radius = Number(size.value); draw() }
        const draw = () => {
          grid.replaceChildren(); grid.style.setProperty('--range-columns', String(radius * 2 + 1))
          originButton.setAttribute('aria-pressed', String(pickingOrigin))
          originButton.textContent = pickingOrigin ? '点击一个格子作为原点' : '设置原点'
          for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
            const key = `${x},${y}`, relative = { x: x - origin.x, y: y - origin.y }
            const cell = action(x === origin.x && y === origin.y ? '＋' : '', () => {
              if (pickingOrigin) { origin = { x, y }; pickingOrigin = false }
              else if (selected.has(key)) selected.delete(key)
              else selected.set(key, { x, y })
              draw()
            }, 'sentence-range-cell')
            cell.setAttribute('aria-label', `坐标(${relative.x},${relative.y})`)
            cell.setAttribute('aria-pressed', String(selected.has(key)))
            cell.title = `坐标(${relative.x},${relative.y})`
            cell.dataset.origin = String(x === origin.x && y === origin.y)
            grid.append(cell)
          }
          note.textContent = dynamicRange ? '此范围含变量或计算，请在表达式中修改；绘图不会覆盖动态坐标。' : `已选 ${selected.size} 格 · ＋ 为原点 · 按选择顺序保存；原点不会自动加入范围。`
        }
        controls.append(originButton, size, action('清空', () => { selected.clear(); draw() }, 'sentence-link-action'), action('关闭范围绘制', () => { panel.remove(); widget.focus() }, 'sentence-link-action'))
        const save = action('填入坐标元组', () => {
          const tuple = '{' + [...selected.values()].map(cell => `坐标(${cell.x - origin.x}, ${cell.y - origin.y})`).join(', ') + '}'
          if (replaceSpan) widget.setValue(value.slice(0, replaceSpan[0]) + tuple + value.slice(replaceSpan[1]))
          else widget.insertText(tuple)
          value = widget.getText(); expressionDrafts.set(key, value); notifyEditorStateChange(); validate()
          panel.remove(); widget.focus()
        }, 'sentence-author-expression-apply')
        save.disabled = dynamicRange
        panel.append(controls, grid, note, save); wrapper.append(panel); draw(); originButton.focus()
      }, 'sentence-link-action')
      footer.prepend(rangeButton)
      validate()
      return wrapper
    }

    function documentScopeKey(draft, field = options.field || primaryField) {
      return `${collection}:${draft?.id || options.root?.id || ''}:${field}`
    }

    function collapseKey(draft, field, path, statementId) {
      return `${documentScopeKey(draft, field)}:${scopePathKey(path)}:${statementId || ''}`
    }

    function captureScrollOffsets() {
      return [...container.querySelectorAll('[data-sentence-scroll]')].map(element => ({
        key: element.dataset.sentenceScrollKey || element.dataset.sentenceScroll || '',
        left: element.scrollLeft,
        top: element.scrollTop,
      }))
    }

    function restoreScrollOffsets(snapshot) {
      if (!Array.isArray(snapshot) || !snapshot.length) return
      const targets = [...container.querySelectorAll('[data-sentence-scroll]')]
      for (const item of snapshot) {
        const target = targets.find(element => (element.dataset.sentenceScrollKey || element.dataset.sentenceScroll || '') === item.key)
        if (!target) continue
        target.scrollLeft = item.left
        target.scrollTop = item.top
      }
    }

    function trialDrafts(draft) {
      const root = options.root || { collection: 'skills', id: draft?.id || '' }
      const catalog = typeof options.getCatalog === 'function' ? options.getCatalog() : null
      const drafts = []
      const seen = new Set()
      const add = (sourceCollection, id, document) => {
        if (!sourceCollection || !id || !record(document)) return
        const key = `${sourceCollection}:${id}`
        if (seen.has(key)) return
        seen.add(key)
        drafts.push({ collection: sourceCollection, document: clone(document) })
      }
      add(root.collection, root.id || draft?.id, draft)
      if (typeof core?.buildSkillCluster !== 'function') throw new Error('当前编辑器未加载能力组。')
      let cluster
      try {
        cluster = core.buildSkillCluster(catalog || { skills: {}, rules: {}, pieces: {}, cards: {} }, root)
      } catch (error) {
        throw new Error(`读取能力关联失败：${error?.message || error}`)
      }
      for (const member of Array.isArray(cluster?.members?.all) ? cluster.members.all : []) {
        const source = member?.source
        const sourceCollection = source?.collection
        const id = source?.id
        if (!catalog?.[sourceCollection]?.[id]) continue
        add(sourceCollection, id, catalog[sourceCollection][id])
      }
      return { skillId: root.id || draft?.id, drafts }
    }

    async function startTrial() {
      if (trialPending || collection !== 'skills') return
      trialPending = true
      render()
      try {
        const trialRequest = getTrialRequest()
        if (!trialRequest.ok) throw new Error(trialRequest.error)
        const draft = clone(options.getDraft?.() || {})
        const request = trialRequest.request
        if (!request.skillId) throw new Error('当前技能没有可用的 ID。')
        const invoke = options.skillTrial || window.editorAPI?.skillTrial
        if (typeof invoke !== 'function') throw new Error('当前编辑器未连接训练营试用。')
        const result = await invoke(request)
        const trial = record(result?.draft) ? result.draft : {}
        const skillName = trial.skillName || trial.skill || draft.name || request.skillId
        const pieceName = trial.pieceName || trial.name || `试用 · ${skillName}`
        const details = `「${pieceName}」`
        report(`训练营已打开：${skillName}。请在训练营选择${details}。`, 'success')
        options.notify?.(`训练营已打开：${skillName}；请选择${details}。`, 'success')
      } catch (error) {
        const text = error?.message || String(error)
        report(`试用失败：${text}`, 'error')
        options.notify?.(`试用失败：${text}`, 'error')
      } finally {
        trialPending = false
        render()
      }
    }

    function getTrialRequest() {
      if (expressionDrafts.size > 0 || authorStatementDrafts.size > 0) return { ok: false, request: null, error: '请先应用当前正在编辑的表达式或作者语句，再开始训练营试用。' }
      if (options.__sentenceLastDiagnostic) return { ok: false, request: null, error: authorDiagnostic(options.__sentenceLastDiagnostic) }
      try {
        const draft = clone(options.getDraft?.() || {})
        return { ok: true, request: trialDrafts(draft), error: null }
      } catch (error) {
        return { ok: false, request: null, error: authorDiagnostic(error?.message || String(error)) }
      }
    }

    const report = (text, kind = 'info') => {
      text = authorDiagnostic(text)
      if (kind === 'success' && options.__sentenceLastDiagnostic) {
        text = `草稿尚不可保存：${authorDiagnostic(options.__sentenceLastDiagnostic)}`
        kind = 'error'
      }
      message = text
      messageKind = kind
      render()
    }

    function reportResultVariableError(draftKey, text) {
      const localized = authorDiagnostic(text)
      resultVariableDraftErrors.set(draftKey, localized)
      resultVariableMessageKey = draftKey
      message = localized
      messageKind = 'error'
      render()
    }

    function clearResultVariableError(draftKey) {
      const previous = resultVariableDraftErrors.get(draftKey)
      if (!previous) return false
      resultVariableDraftErrors.delete(draftKey)
      if (resultVariableMessageKey === draftKey) {
        resultVariableMessageKey = null
        if (messageKind === 'error' && message === previous) {
          message = null
          messageKind = 'info'
        }
      }
      return true
    }

    function clearResultVariableMessage() {
      if (resultVariableMessageKey === null) return false
      const activeError = resultVariableDraftErrors.get(resultVariableMessageKey)
      resultVariableMessageKey = null
      if (messageKind === 'error' && activeError && message === activeError) {
        // The corresponding draft keeps its inline diagnostic. Clearing the
        // transient banner lets another bound viewer open without erasing
        // that draft or masking an unrelated editor error.
        message = null
        messageKind = 'info'
        // A read-only result viewer toggles its panel in place and therefore
        // does not render the whole editor. Remove the already-rendered
        // banner here as well so an old draft error cannot leak across rows.
        for (const banner of container.querySelectorAll('.sentence-message.error')) {
          if (banner.textContent === activeError) banner.remove()
        }
      }
      return true
    }

    function focusTargetForPopover(popover) {
      if (!popover) return null
      if (popover.returnPopover && popover.returnPopover !== popover) {
        const returned = focusTargetForPopover(popover.returnPopover)
        if (returned) return returned
      }
      if (['range', 'target', 'multiplier'].includes(popover.control)) return { kind: 'control', value: popover.control }
      if (!popover.statementId) return null
      if (popover.control === 'record-fields') return { kind: 'record-fields', value: popover.statementId }
      if ((popover.control === 'slot' || popover.control === 'expression') && popover.slotName) {
        return { kind: 'slot', value: `${popover.statementId}:${popover.slotKind || 'input'}:${popover.slotName}` }
      }
      return { kind: 'module', value: popover.statementId }
    }

    function focusTargetForElement(element) {
      if (!element || !container.contains(element)) return null
      if (element.matches?.('[data-sentence-module-search]')) {
        return {
          kind: 'module-search',
          start: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
          end: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
          direction: element.selectionDirection || 'none',
        }
      }
      if (element.matches?.('[data-sentence-result-variable-name]')) {
        return {
          kind: 'result-variable-name',
          value: element.getAttribute('data-sentence-result-variable-name') || '',
          start: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
          end: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
          direction: element.selectionDirection || 'none',
        }
      }
      const directSlot = element.matches?.('[data-sentence-slot-editor]') ? element : null
      if (directSlot) return { kind: 'slot', value: directSlot.getAttribute('data-sentence-slot-editor') }
      const inlineEditor = element.closest?.('[data-sentence-inline-editor]')
      const focusable = element.matches?.('input, select, textarea, button, [contenteditable="true"], [tabindex]:not([tabindex="-1"])') ? element : null
      if (inlineEditor && focusable) {
        const fields = [...inlineEditor.querySelectorAll('input, select, textarea, button, [contenteditable="true"], [tabindex]:not([tabindex="-1"])')]
        const index = fields.indexOf(focusable)
        if (index >= 0) return { kind: 'field', value: `${inlineEditor.dataset.sentenceInlineEditor || ''}:${index}` }
      }
      const slot = element.closest?.('[data-sentence-slot-editor]')
      if (slot) return { kind: 'slot', value: slot.getAttribute('data-sentence-slot-editor') }
      const recordFields = element.closest?.('[data-sentence-record-fields]')
      if (recordFields) return { kind: 'record-fields', value: recordFields.getAttribute('data-sentence-record-fields') }
      const control = element.closest?.('[data-sentence-control]')
      if (control) return { kind: 'control', value: control.getAttribute('data-sentence-control') }
      const moduleElement = element.closest?.('[data-sentence-module-editor]')
      if (moduleElement) return { kind: 'module', value: moduleElement.getAttribute('data-sentence-module-editor') }
      const panel = element.closest?.('[data-sentence-inline-editor]')
      if (panel?.dataset.sentenceInlineEditor) return { kind: 'panel', value: panel.dataset.sentenceInlineEditor }
      const structure = element.closest?.('[data-sentence-structure-settings], [data-sentence-structured-editor]')
      if (structure) return { kind: 'structure', value: structure.getAttribute('data-sentence-structure-settings') || structure.getAttribute('data-sentence-structured-editor') }
      return null
    }

    function findFocusTarget(target) {
      if (!target) return null
      if (target.kind === 'module-search') return container.querySelector('[data-sentence-module-search]') || null
      if (target.kind === 'result-variable-name') {
        return [...container.querySelectorAll('[data-sentence-result-variable-name]')]
          .find(element => element.getAttribute('data-sentence-result-variable-name') === target.value) || null
      }
      if (target.kind === 'record-fields') {
        return [...container.querySelectorAll('[data-sentence-record-fields]')]
          .find(element => element.getAttribute('data-sentence-record-fields') === target.value) || null
      }
      if (target.kind === 'field') {
        const separator = target.value.lastIndexOf(':')
        const editorId = separator >= 0 ? target.value.slice(0, separator) : target.value
        const index = separator >= 0 ? Number(target.value.slice(separator + 1)) : -1
        const editor = [...container.querySelectorAll('[data-sentence-inline-editor]')].find(element => element.dataset.sentenceInlineEditor === editorId)
        const fields = editor ? [...editor.querySelectorAll('input, select, textarea, button, [contenteditable="true"], [tabindex]:not([tabindex="-1"])')] : []
        return Number.isInteger(index) && index >= 0 ? fields[index] || null : null
      }
      const elements = {
        slot: [...container.querySelectorAll('[data-sentence-slot-editor]')],
        control: [...container.querySelectorAll('[data-sentence-control]')],
        module: [...container.querySelectorAll('[data-sentence-module-editor]')],
        structure: [...container.querySelectorAll('[data-sentence-structure-settings], [data-sentence-structured-editor]')],
      }[target.kind] || []
      const direct = elements.find(element => {
        const value = target.kind === 'slot'
          ? element.getAttribute('data-sentence-slot-editor')
          : target.kind === 'control'
            ? element.getAttribute('data-sentence-control')
            : element.getAttribute(target.kind === 'structure' ? 'data-sentence-structure-settings' : 'data-sentence-module-editor')
        return value === target.value
      })
      if (direct) {
        if (target.kind !== 'structure') return direct
        return direct.querySelector?.('button, input, select, textarea, [tabindex]') || direct
      }
      if (target.kind === 'module') {
        const menu = [...container.querySelectorAll('[data-sentence-row-menu]')].find(element => element.dataset.sentenceRowMenu === target.value)
        if (menu) {
          if (!menu.open) return menu.querySelector('summary') || null
          return menu.querySelector('[data-sentence-structured-editor], [data-sentence-module-editor], summary') || null
        }
        const structured = [...container.querySelectorAll('[data-sentence-structure-settings], [data-sentence-structured-editor]')]
          .find(element => element.getAttribute('data-sentence-structure-settings') === target.value || element.getAttribute('data-sentence-structured-editor') === target.value)
        if (structured) return structured.querySelector?.('button, input, select, textarea, [tabindex]') || structured
      }
      if (target.kind === 'panel') {
        const panel = [...container.querySelectorAll('[data-sentence-inline-editor]')].find(element => element.dataset.sentenceInlineEditor === target.value)
        return panel?.querySelector('input, select, textarea, button') || panel
      }
      return null
    }

    function restorePendingFocus() {
      const target = pendingFocusTarget
      pendingFocusTarget = null
      const element = findFocusTarget(target)
      if (!element || typeof element.focus !== 'function') return
      try { element.focus({ preventScroll: true }) } catch { element.focus() }
      if (target?.kind === 'module-search' && typeof element.setSelectionRange === 'function') {
        const length = String(element.value || '').length
        const start = Math.max(0, Math.min(length, Number.isInteger(target.start) ? target.start : length))
        const end = Math.max(start, Math.min(length, Number.isInteger(target.end) ? target.end : start))
        try { element.setSelectionRange(start, end, target.direction || 'none') } catch { /* unsupported input selection */ }
      }
      if (target?.kind === 'result-variable-name' && typeof element.setSelectionRange === 'function') {
        const length = String(element.value || '').length
        const start = Math.max(0, Math.min(length, Number.isInteger(target.start) ? target.start : length))
        const end = Math.max(start, Math.min(length, Number.isInteger(target.end) ? target.end : start))
        try { element.setSelectionRange(start, end, target.direction || 'none') } catch { /* unsupported input selection */ }
      }
    }

    function closePopover() {
      pendingFocusTarget = focusTargetForPopover(openPopover) || pendingFocusTarget
      openPopover = null
      render()
    }

    function controlButton(text, control, title) {
      const button = action(text, () => { openPopover = { control }; render() }, 'sentence-token')
      const selected = openPopover?.control === control
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-expanded', selected ? 'true' : 'false')
      button.setAttribute('aria-pressed', selected ? 'true' : 'false')
      const chevron = node('span', '', 'sentence-token-chevron')
      chevron.setAttribute('aria-hidden', 'true')
      button.append(chevron)
      button.dataset.sentenceControl = control
      button.title = title || '编辑此参数'
      return button
    }

    function popoverFor(control, pattern, text, graph = null, path = scopePath) {
      const panel = node('div', undefined, 'sentence-inline-editor sentence-popover')
      panel.dataset.sentencePopover = control
      panel.dataset.sentenceInlineEditor = control
      const close = action('关闭编辑', closePopover, 'sentence-popover-close')
      if (control === 'range') {
        const field = node('label', undefined, 'sentence-editor-field')
        field.append(node('span', '范围（格）', 'sentence-field-label'))
        const input = document.createElement('input')
        input.type = 'number'; input.min = '0'; input.step = '1'; input.value = String(Number.isFinite(text.range) ? text.range : 0)
        input.dataset.sentenceRange = ''
        input.onchange = () => {
          const value = Number(input.value)
          if (!Number.isFinite(value) || value < 0) return report('范围必须是非负数字。', 'error')
          try {
            applyGraphChange(options, (graph, nextDraft) => {
              const choice = findCallById(graph, pattern?.choice?.id) || findCall(graph, 'choice.target-piece', 'choice')
              if (choice) choice.parameters = { ...(choice.parameters || {}), range: value }
              updateCanonicalFields(nextDraft, graphPattern(graph), core, graph, path)
            })
            closePopover()
          } catch (error) { report(error.message || String(error), 'error') }
        }
        field.append(input); panel.append(field)
      } else if (control === 'target') {
        const field = node('label', undefined, 'sentence-editor-field')
        field.append(node('span', '目标类型', 'sentence-field-label'))
        const select = document.createElement('select')
        select.dataset.sentenceTarget = ''
        for (const [value, label] of Object.entries(filterLabels)) {
          const option = node('option', label); option.value = value; option.selected = value === text.filter; select.append(option)
        }
        select.onchange = () => {
          try {
            applyGraphChange(options, (graph, nextDraft) => {
              const choice = findCallById(graph, pattern?.choice?.id) || findCall(graph, 'choice.target-piece', 'choice')
              if (choice) choice.parameters = { ...(choice.parameters || {}), filter: select.value }
              updateCanonicalFields(nextDraft, graphPattern(graph), core, graph, path)
            })
            closePopover()
          } catch (error) { report(error.message || String(error), 'error') }
        }
        field.append(select); panel.append(field)
      } else if (control === 'multiplier') {
        panel.classList.add('sentence-expression-editor')
        const stat = document.createElement('select')
        stat.dataset.sentenceBaseStat = ''
        for (const [value, label] of Object.entries(attributeLabels)) { const option = node('option', label); option.value = value; option.selected = value === text.attribute; stat.append(option) }
        const amount = document.createElement('input')
        amount.type = 'number'; amount.step = '0.1'; amount.min = '0'; amount.value = String(Number.isFinite(text.multiplier) ? text.multiplier : 1); amount.dataset.sentenceMultiplier = ''
        const left = node('label', undefined, 'sentence-editor-field'); left.append(node('span', '左侧数值', 'sentence-field-label'), stat)
        const right = node('label', undefined, 'sentence-editor-field'); right.append(node('span', '倍率', 'sentence-field-label'), amount)
        const result = node('span', `结果：${attributeLabels[text.attribute] || text.attribute} × ${text.multiplierLabel || formatNumber(text.multiplier)}`, 'sentence-popover-result')
        const updateResult = () => { result.textContent = `结果：${attributeLabels[stat.value] || stat.value} × ${formatNumber(amount.value)}` }
        const apply = () => {
          const value = Number(amount.value)
          if (!Number.isFinite(value) || value < 0) return report('伤害倍率必须是非负数字。', 'error')
          try {
            applyGraphChange(options, (graph, nextDraft) => {
              const attack = findCallById(graph, pattern?.attack?.id) || findCall(graph, 'attribute.read', 'attack')
              if (attack) attack.parameters = { ...(attack.parameters || {}), attribute: stat.value }
              const scaled = findCallById(graph, pattern?.scaled?.id) || findCall(graph, 'math.multiply', 'amount')
              if (scaled && pattern?.multiplier?.id) scaled.inputs = { ...(scaled.inputs || {}), right: reference(pattern.multiplier.id, 'value') }
              nextDraft.powerMultiplier = value
              updateCanonicalFields(nextDraft, graphPattern(graph), core, graph, path)
            }, {
              mutatePreview: preview => {
                const pieceNumber = previewPieceNumber(preview)
                if (pieceNumber) pieceNumber.parameters = { ...(pieceNumber.parameters || {}), attribute: stat.value }
              },
            })
            closePopover()
          } catch (error) { report(error.message || String(error), 'error') }
        }
        stat.onchange = apply; amount.onchange = apply; stat.oninput = updateResult; amount.oninput = updateResult
        panel.append(left, node('span', '×', 'sentence-expression-operator'), right, result)
        const currentGraph = graph || graphFor(core, options.getDraft?.() || {}, options.field || primaryField)
        const scaled = pattern?.scaled?.id ? statementForId(currentGraph, pattern.scaled.id, path) : null
        if (scaled) {
          panel.append(node('h4', '伤害表达式', 'sentence-inline-editor-section'))
          const expressionEditor = renderStatementEditor(scaled, currentGraph, path, { activatePopover: true })
          expressionEditor.dataset.sentenceCanonicalExpression = scaled.id
          expressionEditor.querySelector('.sentence-popover-close')?.remove()
          panel.append(expressionEditor)
        }
      }
      panel.append(close)
      return panel
    }

    function descriptorForCurrent(graph, statement, path = scopePath) {
      return descriptorForStatement(core, statement)
        || descriptorFor(core, statement?.module, statement?.version)
        || moduleDescriptors(graphOwner(graph, path)).find(item => item.id === statement?.module && item.version === statement?.version)
    }

    function openSourceExpression(value, path = scopePath, returnPopover = null) {
      if (!record(value) || value.kind !== 'output' || !value.node) return
      const draft = clone(options.getDraft?.() || {})
      const graph = graphFor(core, draft, options.field || primaryField)
      const sourceLocation = statementLocationForLexicalId(graph, value.node, path)
      openPopover = { control: 'statement', statementId: value.node, scopePath: sourceLocation?.scopePath || path, ...(returnPopover ? { returnPopover } : {}) }
      render()
    }

    function renderExpressionChooser(statement, graph, definition, path = scopePath) {
      const panel = node('div', undefined, 'sentence-expression-chooser')
      panel.dataset.sentenceExpressionChooser = definition?.name || ''
      panel.append(node('strong', `为“${semanticSlotLabel(definition, definition?.name)}”组合表达式`, 'sentence-inline-editor-title'))
      panel.append(node('p', '只显示纯模块；选择后会在当前语句之前生成一个有类型的输出引用。', 'sentence-inline-editor-copy'))
      const expectedType = portValueType(definition)
      const list = node('div', undefined, 'sentence-expression-options')
      const consumerScopePath = statementLocationForLexicalId(graph, statement.id, path)?.scopePath || path
      const descriptors = seedablePureDescriptors(core, graph, expectedType, statement.id, consumerScopePath)
      for (const descriptor of descriptors) {
        const output = expressionOutput(descriptor, expectedType)
        const outputText = output ? `（返回${outputLabel(descriptor, output.name)}）` : ''
        const descriptorLabel = semanticModuleLabel(descriptor.id, descriptor.label)
        const item = action(`${descriptorLabel}${outputText}`, () => {
          try {
            const result = createPureExpression(options, statement.id, definition.name, expectedType, descriptor.id, descriptor.version, consumerScopePath)
            const returnPopover = openPopover?.returnPopover || openPopover
            openPopover = { control: 'statement', statementId: result.statement.id, scopePath: result.scopePath || consumerScopePath, ...(returnPopover ? { returnPopover } : {}) }
            report(`已将“${descriptorLabel}”作为嵌套表达式。`, 'success')
          } catch (error) { report(error.message || String(error), 'error') }
        }, 'sentence-expression-option')
        item.dataset.sentenceExpressionModule = descriptor.id
        item.dataset.sentenceExpressionOutput = output?.name || ''
        item.title = descriptor.description || descriptorLabel
        list.append(item)
      }
      if (!descriptors.length) list.append(node('p', '没有可用的纯模块。', 'sentence-module-empty'))
      panel.append(list, action('返回', closePopover, 'sentence-popover-close'))
      return panel
    }

    function updateStructural(statementId, mutate, path = scopePath) {
      try {
        applyGraphChange(options, graph => {
          if (!updateStatementById(graph, statementId, mutate, path)) throw new Error('找不到要编辑的结构语句。')
          const updated = statementForLexicalId(graph, statementId, path)
          if (updated?.kind === 'record.create') ensureAuthorSchema(graph, core, updated.schema)
          if (updated?.kind === 'record.get' || updated?.kind === 'record.with') {
            ensureAuthorSchema(graph, core, recordSchemaType(core, graph, updated.record, new Set(), path)?.schema)
          }
        }, undefined, path)
        render()
      } catch (error) { report(error.message || String(error), 'error') }
    }

    function structuralValue(graph, statement, definition, current, assign, path = scopePath, editorOptions = {}) {
      // Legacy graphs sometimes omit a type on a structured slot. If its
      // current value is a literal, infer only that slot's editor type; the
      // original unknown fields remain untouched in the graph.
      const effective = definition?.type === 'any' && current?.kind === 'literal'
        ? { ...definition, type: literalTypeOfValue(current.value) }
        : definition
      const editorGraph = graphWithAuthorSchemas(core, schemaGraphForScope(graph, path))
      const editor = valueEditor(core, editorGraph, statement, effective, current, assign, false, {
        renderExpression: (g, s, d, v) => renderAuthorExpression(editorGraph, s, d, v, path),
        scopePath: path,
        schemaRegistry: options.schemaRegistry || options.objectSchemaRegistry,
        catalog: authorReferenceCatalog(options.catalog),
        getCatalog: typeof options.getCatalog === 'function' ? () => authorReferenceCatalog(options.getCatalog()) : undefined,
        referenceResolver: authorContentReference,
        // A focused record-field token uses the same author-expression editor
        // even for structured field types (such as tuples). The full
        // structured editor still owns literal/object controls; this focused
        // row editor keeps one consistent expression path for an empty field.
        forceExpression: Boolean(editorOptions.forceExpression)
          || (openPopover?.control === 'expression'
            && openPopover.statementId === statement.id
            && openPopover.inputName === definition.name),
        onAuthorExpression: () => {
          const returnPopover = openPopover?.returnPopover || openPopover
          openPopover = { control: 'expression', statementId: statement.id, inputName: definition.name, slotKind: 'input', slotName: definition.name, scopePath: path, ...(returnPopover ? { returnPopover } : {}) }
          render()
        },
        onCompose: () => {
          const returnPopover = openPopover?.returnPopover || openPopover
          openPopover = { control: 'expression', statementId: statement.id, inputName: definition.name, slotKind: 'input', slotName: definition.name, scopePath: path, ...(returnPopover ? { returnPopover } : {}) }
          render()
        },
        onOpenSource: () => openSourceExpression(current, path, openPopover?.returnPopover || openPopover),
      })
      if (!current) return editor
      const actual = current.kind === 'literal' ? literalTypeOfValue(current.value) : outputValueType(core, editorGraph, current, path)
      const expected = portValueType(effective)
      if (!actual || compatibleType(actual, expected)) return editor
      const wrapper = node('div', undefined, 'sentence-structural-value-field')
      const warning = node('small', `待重填：当前是${typeLabel(actual)}，此处需要${typeLabel(expected)}。原值已保留。`, 'sentence-invalid-field sentence-type-mismatch')
      warning.dataset.sentenceTypeMismatch = `${statement.id}:${definition?.name || ''}`
      warning.setAttribute('role', 'alert')
      wrapper.append(editor, warning)
      return wrapper
    }

    function selectField(parent, label, value, values, change, datasetName, currentLabel = '') {
      const field = node('label', undefined, 'sentence-editor-field')
      const select = document.createElement('select')
      if (datasetName) select.dataset[datasetName] = ''
      for (const item of values) {
        const option = node('option', item.label || item.value)
        option.value = item.value
        option.selected = item.value === value
        select.append(option)
      }
      if (value && !values.some(item => item.value === value)) {
        const option = node('option', currentLabel || '当前值（已保存）'); option.value = value; select.append(option)
      }
      select.value = value || ''
      select.onchange = () => change(select.value)
      field.append(node('span', label, 'sentence-field-label'), select)
      parent.append(field)
      return select
    }

    function graphSchemas(graph) {
      const local = Array.isArray(graph?.schemas) ? graph.schemas : []
      return local
    }

    function schemaDisplayLabel(schema) {
      const builtin = builtinSchemaLabels[`${schema?.id}@${schema?.version}`]
      if (builtin) return builtin
      const value = String(schema?.label || schema?.title || schema?.name || '').trim()
      if (value && !/^[a-z][a-z0-9]*(?:[.-][a-z0-9_-]+)+$/i.test(value)) return value
      return '未命名记录结构'
    }

    function continuationDefinition(graph, referenceValue) {
      return (Array.isArray(graph?.continuations) ? graph.continuations : []).find(item => item?.id === referenceValue || `${item?.id}@${item?.version}` === referenceValue) || null
    }

    function recordFieldDefinitions(graph, schemaRef) {
      const schema = schemaForGraph(graph, schemaRef)
      return { schema, fields: Array.isArray(schema?.fields) ? schema.fields : [] }
    }

    // A schema field is an editable target as soon as the schema is selected,
    // even when the author has not supplied a value yet.  Keep the graph
    // sparse until the shared slot editor writes a value, but make the field
    // discoverable in the row and in the field popover.
    function recordFieldProjection(statement, graph, path = scopePath) {
      const editorGraph = graphWithAuthorSchemas(core, schemaGraphForScope(graph, path))
      const schemaRef = statement?.kind === 'record.create'
        ? statement.schema
        : recordSchemaType(core, graph, statement?.record, new Set(), path)?.schema
      const definitions = recordFieldDefinitions(editorGraph, schemaRef).fields
      const fieldNames = []
      for (const field of definitions) {
        if (field?.name && !fieldNames.includes(field.name)) fieldNames.push(field.name)
      }
      for (const fieldName of Object.keys(statement?.fields || {})) {
        if (!fieldNames.includes(fieldName)) fieldNames.push(fieldName)
      }
      return { editorGraph, schemaRef, definitions, fieldNames }
    }

    function renderStructuredSlotEditor(statement, graph, path = scopePath) {
      const focus = (openPopover?.control === 'slot' || openPopover?.control === 'expression') && openPopover.statementId === statement.id ? openPopover : null
      const panel = node('div', undefined, 'sentence-inline-editor sentence-structured-editor sentence-slot-only-editor')
      panel.dataset.sentenceInlineEditor = statement.id || ''
      panel.dataset.sentenceStructuredEditor = statement.id || ''
      panel.dataset.sentenceSlotEditor = `${focus?.slotKind || 'input'}:${focus?.slotName || ''}`
      const top = node('div', undefined, 'sentence-inline-editor-top')
      const slotHeading = node('strong', `编辑${semanticSlotLabel(null, focus?.slotName)}`, 'sentence-inline-editor-title')
      top.append(slotHeading, action('关闭编辑', closePopover, 'sentence-popover-close'))
      panel.append(top)
      const editorGraph = graphWithAuthorSchemas(core, schemaGraphForScope(graph, path))
      const name = focus?.slotName || ''
      const isRecordStatement = statement.kind === 'record.create' || statement.kind === 'record.with'
      const recordFieldName = name.startsWith('field:') ? name.slice('field:'.length) : name
      const recordSchemaRef = isRecordStatement
        ? statement.kind === 'record.create'
          ? statement.schema
          : recordSchemaType(core, graph, statement.record, new Set(), path)?.schema
        : ''
      const recordFieldDefinition = isRecordStatement && recordFieldName
        ? recordFieldDefinitions(editorGraph, recordSchemaRef).fields.find(field => field.name === recordFieldName)
        : null
      let expressionDefinition = null
      const input = (label, type, value, assign, editorOptions = {}) => {
        expressionDefinition = { name, label, type: type === 'any' && value?.kind === 'literal' ? literalTypeOfValue(value.value) : type }
        slotHeading.textContent = `编辑${label}`
        panel.append(structuralValue(graph, statement, expressionDefinition, value, assign, path, editorOptions))
      }
      const textField = (label, value, onChange, dataName) => {
        const field = node('label', undefined, 'sentence-editor-field')
        const control = document.createElement('input')
        control.type = 'text'; control.value = value == null ? '' : String(value)
        if (dataName) control.dataset[dataName] = `${statement.id}:${name}`
        control.onchange = () => onChange(control.value)
        field.append(node('span', label, 'sentence-field-label'), control); panel.append(field)
      }
      if (statement.kind === 'if' && name === 'condition') input('条件', 'boolean', statement.condition, value => updateStructural(statement.id, item => { item.condition = value }, path))
      else if (statement.kind === 'foreach' && name === 'items') input('集合', { kind: 'list', element: 'any' }, statement.items, value => updateStructural(statement.id, item => { item.items = value }, path))
      else if ((statement.kind === 'foreach' || statement.kind === 'collection') && (name === 'item' || name === 'index' || name === 'accumulator')) {
        textField(name === 'item' ? '项目变量' : name === 'index' ? '索引变量' : '累计变量', statement[name], value => updateStructural(statement.id, item => { if (value.trim()) item[name] = value.trim(); else delete item[name] }, path), 'sentenceFocusedVariable')
      } else if (statement.kind === 'while' && name === 'budget') {
        const field = node('label', undefined, 'sentence-editor-field')
        const control = document.createElement('input'); control.type = 'number'; control.min = '1'; control.step = '1'; control.value = Number.isFinite(Number(statement.budget)) ? String(statement.budget) : '1'; control.dataset.sentenceWhileBudget = statement.id
        control.onchange = () => { const value = Math.floor(Number(control.value)); if (!Number.isSafeInteger(value) || value < 1) return report('循环上限必须是正整数。', 'error'); updateStructural(statement.id, item => { item.budget = value }, path) }
        field.append(node('span', '循环上限', 'sentence-field-label'), control); panel.append(field)
      } else if (statement.kind === 'while' && name === 'index') textField('循环索引', statement.index, value => updateStructural(statement.id, item => { if (value.trim()) item.index = value.trim(); else delete item.index }, path), 'sentenceWhileIndex')
      else if ((statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) && name === 'items') input('集合', { kind: 'list', element: 'any' }, statement.items, value => updateStructural(statement.id, item => { item.items = value }, path))
      else if ((statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) && name === 'initial') input('初始累计值', 'any', statement.initial, value => updateStructural(statement.id, item => { item.initial = value }, path))
      else if ((statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) && own(statement.inputs, name)) {
        const current = statement.inputs[name]
        const type = current?.kind === 'literal' ? literalTypeOfValue(current.value) : outputValueType(core, graph, current, path) || 'any'
        input(`局部输入 · ${name}`, type, current, value => updateStructural(statement.id, item => { item.inputs = { ...(item.inputs || {}), [name]: value } }, path))
      }
      else if (statement.kind === 'record.get' && name === 'record') {
        const type = recordSchemaType(core, graph, statement.record, new Set(), path) || { kind: 'record', schema: '' }
        input('记录值', type, statement.record, value => updateStructural(statement.id, item => { item.record = value }, path))
      } else if (statement.kind === 'record.get' && name === 'field') {
        const type = recordSchemaType(core, graph, statement.record, new Set(), path)
        const definitions = recordFieldDefinitions(editorGraph, type?.schema).fields
        if (definitions.length) selectField(panel, '字段名', statement.field || '', definitions.map(field => ({ value: field.name, label: `${fieldDisplayLabel(field)} · ${typeLabel(portValueType(field))}` })), value => updateStructural(statement.id, item => { item.field = value }, path), 'sentenceRecordField')
        else panel.append(node('p', `请先选择可解析的记录；字段“${statement.field || '未设置'}”会继续保留。`, 'sentence-invalid-field sentence-pending-field'))
      } else if (statement.kind === 'record.create' && name === 'schema') {
        const values = graphSchemas(editorGraph).map(item => ({ value: `${item.id}@${item.version}`, label: schemaDisplayLabel(item) }))
        selectField(panel, '结构定义', statement.schema || '', values, value => updateStructural(statement.id, (item, ownerGraph) => {
          item.schema = value
          ensureAuthorSchema(ownerGraph, core, value)
          const selected = schemaForGraph(editorGraph, value)
          const fields = { ...(item.fields || {}) }
          for (const field of Array.isArray(selected?.fields) ? selected.fields : []) {
            if (!own(fields, field.name) && own(field, 'default')) fields[field.name] = literal(clone(field.default))
          }
          item.fields = fields
        }, path), 'sentenceRecordSchema', '当前记录结构（已保存）')
      } else if (statement.kind === 'record.with' && name === 'record') {
        const type = recordSchemaType(core, graph, statement.record, new Set(), path) || { kind: 'record', schema: '' }
        input('记录值', type, statement.record, value => updateStructural(statement.id, item => {
          item.record = value
          // A record.with slot can change the schema of the record it wraps.
          // Add defaults for newly available fields, while retaining every
          // existing field so a schema change never silently erases authoring.
          const selected = recordSchemaType(core, graph, value, new Set(), path)
          if (selected?.schema) {
            item.fields = { ...(item.fields || {}) }
            const schema = schemaForGraph(editorGraph, selected.schema)
            for (const field of Array.isArray(schema?.fields) ? schema.fields : []) {
              if (!own(item.fields, field.name) && own(field, 'default')) item.fields[field.name] = literal(clone(field.default))
            }
          }
        }, path))
      } else if (isRecordStatement && (name.startsWith('field:') || recordFieldDefinition)) {
        const fieldName = recordFieldName
        const definition = recordFieldDefinition || { name: fieldName, label: fieldName, type: 'any' }
        input(semanticSlotLabel(definition, fieldName), portValueType(definition), statement.fields?.[fieldName], value => updateStructural(statement.id, item => { item.fields = { ...(item.fields || {}), [fieldName]: value } }, path), { forceExpression: Boolean(recordFieldDefinition) })
      } else if (statement.kind === 'return' && name.startsWith('return:')) {
        const outputName = name.slice('return:'.length)
        const output = (scopeDefinition(graph, path).graph?.outputs || []).find(item => item.name === outputName)
        input(semanticSlotLabel(output, outputName), output?.type || 'any', statement.values?.[outputName], value => updateStructural(statement.id, item => { item.values = { ...(item.values || {}), [outputName]: value } }, path))
      } else if (statement.kind === 'defer-choice' && name === 'title') input('提示', 'string', statement.title, value => updateStructural(statement.id, item => { item.title = value }, path))
      else if (statement.kind === 'return' && name === 'value') input('返回值', 'any', statement.value, value => updateStructural(statement.id, item => { item.value = value }, path))
      else if (statement.kind === 'defer-choice' && name === 'graph') {
        const ownerGraph = scopeDefinition(graph, path).graph || graph
        const values = (Array.isArray(ownerGraph?.continuations) ? ownerGraph.continuations : []).map(item => ({ value: `${item.id}@${item.version}`, label: item.label || item.name || '未命名续接流程' }))
        selectField(panel, '续接流程', statement.graph || '', values, value => updateStructural(statement.id, item => { item.graph = value }, path), 'sentenceContinuationRef')
      } else if (statement.kind === 'defer-choice' && name === 'payload') {
        const continuation = continuationDefinition(scopeDefinition(graph, path).graph || graph, statement.graph)
        input('载荷', continuation?.payloadType || continuation?.payload || 'any', statement.payload, value => updateStructural(statement.id, item => { item.payload = value }, path))
      } else if (statement.kind === 'defer-choice' && ['player', 'candidates'].includes(name)) {
        input(name === 'player' ? '玩家' : '候选项', name === 'candidates' ? { kind: 'list', element: 'any' } : 'player', statement[name], value => updateStructural(statement.id, item => { item[name] = value }, path))
      } else if (statement.kind === 'defer-choice' && ['targetType', 'range', 'filter', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'].includes(name)) {
        const type = ['range', 'min', 'max', 'minSelections', 'maxSelections'].includes(name) ? 'number' : ['canCancel', 'resumeOnCancel'].includes(name) ? 'boolean' : 'string'
        input(name, type, statement[name], value => updateStructural(statement.id, item => { item[name] = value }, path))
      }
      else panel.append(node('p', '当前结构语句的这个槽位暂不可用；原始字段仍会保留。', 'sentence-invalid-field'))
      if (openPopover?.control === 'expression' && openPopover.statementId === statement.id && expressionDefinition) {
        panel.append(renderExpressionChooser(statement, editorGraph, expressionDefinition, path))
      }
      const slots = (sentenceStatementTemplate(statement, { graph, path }) || []).filter(part => record(part) && part.name)
      const currentIndex = slots.findIndex(slot => slot.name === name)
      const next = slots[currentIndex + 1]
      if (currentIndex >= 0 && next) {
        const advance = action(`下一项：${semanticSlotLabel(null, next.name.replace(/^(field|return):/, ''))}`, () => {
          const returnPopover = openPopover?.returnPopover || openPopover
          openPopover = { control: 'slot', statementId: statement.id, slotKind: next.kind, slotName: next.name, scopePath: path, ...(returnPopover ? { returnPopover } : {}) }
          render()
        }, 'sentence-next-slot')
        advance.dataset.sentenceNextSlot = `${statement.id}:${next.kind}:${next.name}`
        panel.append(advance)
      }
      return panel
    }

    function renderRecordFieldsEditor(statement, graph, path = scopePath) {
      const panel = node('div', undefined, 'sentence-inline-editor sentence-record-fields-editor')
      panel.dataset.sentenceInlineEditor = statement.id || ''
      panel.dataset.sentenceRecordFieldsEditor = statement.id || ''
      const top = node('div', undefined, 'sentence-inline-editor-top')
      top.append(node('strong', '编辑记录字段', 'sentence-inline-editor-title'), action('关闭编辑', closePopover, 'sentence-popover-close'))
      panel.append(top)
      const { definitions, fieldNames } = recordFieldProjection(statement, graph, path)
      if (!fieldNames.length) {
        panel.append(node('p', '这条记录还没有字段。', 'sentence-inline-editor-copy'))
        return panel
      }
      const definitionByName = new Map(definitions.map(field => [field.name, field]))
      const list = node('div', undefined, 'sentence-record-fields-list')
      for (const fieldName of fieldNames) {
        const field = node('div', undefined, 'sentence-record-field sentence-record-field-editor')
        const definition = definitionByName.get(fieldName)
        const label = definition?.label || fieldName
        field.append(node('span', `${label}：`, 'sentence-field-label'))
        const hasValue = own(statement.fields || {}, fieldName)
        const value = hasValue ? statement.fields[fieldName] : undefined
        const referenceInfo = hasValue ? recordFieldReferenceInfo(statement, fieldName, value, graph, path) : null
        const display = hasValue
          ? (referenceInfo?.text || recordFieldValueLabel(statement, value, graph, path, fieldName))
          : definition
            ? `未填写（${typeLabel(portValueType(definition))}）`
            : '未填写'
        field.append(slotToken(display, statement.id, 'property', `field:${fieldName}`, path, label, {
          returnPopover: { control: 'record-fields', statementId: statement.id, scopePath: path },
          ...(referenceInfo?.missing ? { referenceMissing: true, referenceId: Array.isArray(referenceInfo.raw) ? referenceInfo.raw.join('、') : referenceInfo.raw } : {}),
        }))
        list.append(field)
      }
      panel.append(list)
      return panel
    }

    function renderStructuredStatementEditor(statement, graph, path = scopePath) {
      if ((openPopover?.control === 'slot' || openPopover?.control === 'expression') && openPopover.statementId === statement.id && openPopover.slotName) return renderStructuredSlotEditor(statement, graph, path)
      const panel = node('div', undefined, 'sentence-inline-editor sentence-structured-editor')
      panel.dataset.sentenceInlineEditor = statement.id || ''
      panel.dataset.sentenceStructuredEditor = statement.id || ''
      panel.dataset.sentenceScope = scopePathKey(path)
      const top = node('div', undefined, 'sentence-inline-editor-top')
      top.append(node('strong', statementKindLabels[statement.kind] || '编辑结构语句', 'sentence-inline-editor-title'), action('关闭编辑', closePopover, 'sentence-popover-close'))
      panel.append(top)
      const active = scopeDefinition(graph, path)
      const ownerGraph = active.graph || graph
      const editorGraph = graphWithAuthorSchemas(core, schemaGraphForScope(graph, path))
      if (statement.kind === 'if') {
        panel.append(node('h4', '条件表达式', 'sentence-inline-editor-section'))
        panel.append(structuralValue(graph, statement, { name: 'condition', label: '条件', type: 'boolean' }, statement.condition, value => updateStructural(statement.id, item => { item.condition = value }, path), path))
      } else if (statement.kind === 'foreach') {
        panel.append(node('h4', '遍历集合', 'sentence-inline-editor-section'))
        panel.append(structuralValue(graph, statement, { name: 'items', label: '集合', type: { kind: 'list', element: 'any' } }, statement.items, value => updateStructural(statement.id, item => { item.items = value }, path), path))
        for (const [name, label] of [['item', '项目变量'], ['index', '索引变量']]) {
          const field = node('label', undefined, 'sentence-editor-field')
          const input = document.createElement('input'); input.type = 'text'; input.value = statement[name] || ''; input.placeholder = name
          input.dataset.sentenceLoopVariable = `${statement.id}:${name}`
          input.onchange = () => updateStructural(statement.id, item => { if (input.value.trim()) item[name] = input.value.trim(); else delete item[name] }, path)
          field.append(node('span', label, 'sentence-field-label'), input); panel.append(field)
        }
        const presentation = document.createElement('select'); presentation.dataset.sentencePresentation = statement.id
        const noPresentation = node('option', '普通逐项执行'); noPresentation.value = ''; presentation.append(noPresentation)
        for (const value of ['statusAdded', 'statusRemoved', 'tileEffectAdded', 'tileEffectRemoved']) { const option = node('option', value); option.value = value; presentation.append(option) }
        presentation.value = statement.presentation || ''
        presentation.onchange = () => updateStructural(statement.id, item => { if (presentation.value) item.presentation = presentation.value; else delete item.presentation }, path)
        const presentationField = node('label', undefined, 'sentence-editor-field'); presentationField.append(node('span', '表现批次（可选）', 'sentence-field-label'), presentation); panel.append(presentationField)
      } else if (statement.kind === 'while') {
        const budgetField = node('label', undefined, 'sentence-editor-field')
        const budget = document.createElement('input'); budget.type = 'number'; budget.min = '1'; budget.step = '1'; budget.value = Number.isFinite(Number(statement.budget)) ? String(statement.budget) : '1'; budget.dataset.sentenceWhileBudget = statement.id
        budget.onchange = () => { const value = Math.floor(Number(budget.value)); if (!Number.isSafeInteger(value) || value < 1) return report('循环上限必须是正整数。', 'error'); updateStructural(statement.id, item => { item.budget = value }, path) }
        budgetField.append(node('span', '最多迭代次数', 'sentence-field-label'), budget); panel.append(budgetField)
        const indexField = node('label', undefined, 'sentence-editor-field'); const index = document.createElement('input'); index.type = 'text'; index.value = statement.index || ''; index.placeholder = '可选索引变量'; index.dataset.sentenceWhileIndex = statement.id
        index.onchange = () => updateStructural(statement.id, item => { if (index.value.trim()) item.index = index.value.trim(); else delete item.index }, path); indexField.append(node('span', '循环索引', 'sentence-field-label'), index); panel.append(indexField)
        panel.append(node('p', '循环条件位于“循环条件”分支中，只能调用纯/查询模块。', 'sentence-inline-editor-copy'))
      } else if (statement.kind === 'return') {
        panel.append(node('h4', '返回值', 'sentence-inline-editor-section'))
        const outputs = Array.isArray(ownerGraph?.outputs) ? ownerGraph.outputs : []
        if (outputs.length) for (const output of outputs) {
          panel.append(structuralValue(graph, statement, { ...output, name: output.name, label: semanticSlotLabel(output, output.name), type: portValueType(output) }, statement.values?.[output.name], value => updateStructural(statement.id, item => { item.values = { ...(item.values || {}), [output.name]: value } }, path), path))
        } else if (statement.value) {
          const type = outputValueType(core, graph, statement.value, path) || 'any'
          panel.append(structuralValue(graph, statement, { name: 'value', label: '返回', type }, statement.value, value => updateStructural(statement.id, item => { item.value = value }, path), path))
        } else panel.append(node('p', '当前流程没有声明可编辑的返回端口。', 'sentence-inline-editor-copy'))
      } else if (statement.kind === 'record.create' || statement.kind === 'record.with') {
        let schemaRef = statement.schema || ''
        if (statement.kind === 'record.with') schemaRef = recordSchemaType(core, graph, statement.record, new Set(), path)?.schema || schemaRef
        const schemaValues = graphSchemas(editorGraph).map(item => ({ value: `${item.id}@${item.version}`, label: schemaDisplayLabel(item) }))
        if (statement.kind === 'record.with') {
          const recordType = recordSchemaType(core, graph, statement.record, new Set(), path) || { kind: 'record', schema: schemaRef }
          panel.append(structuralValue(graph, statement, { name: 'record', label: '记录值', type: recordType }, statement.record, value => updateStructural(statement.id, item => {
            item.record = value
            const selected = recordSchemaType(core, graph, value, new Set(), path)
            if (selected?.schema) {
              item.fields = { ...(item.fields || {}) }
              const schema = schemaForGraph(editorGraph, selected.schema)
              for (const field of Array.isArray(schema?.fields) ? schema.fields : []) {
                if (!own(item.fields, field.name) && own(field, 'default')) item.fields[field.name] = literal(clone(field.default))
              }
            }
          }, path), path, { forceExpression: true }))
        }
        if (statement.kind === 'record.create') {
          selectField(panel, '结构定义', schemaRef, schemaValues, value => updateStructural(statement.id, (item, ownerGraph) => {
            item.schema = value
            ensureAuthorSchema(ownerGraph, core, value)
            const selected = schemaForGraph(editorGraph, value)
            const fields = { ...(item.fields || {}) }
            for (const field of Array.isArray(selected?.fields) ? selected.fields : []) {
              if (!own(fields, field.name) && own(field, 'default')) fields[field.name] = literal(clone(field.default))
            }
            item.fields = fields
          }, path), 'sentenceRecordSchema')
        }
        const definitions = recordFieldDefinitions(editorGraph, schemaRef).fields
        for (const field of definitions) panel.append(structuralValue(graph, statement, field, statement.fields?.[field.name], value => updateStructural(statement.id, item => { item.fields = { ...(item.fields || {}), [field.name]: value } }, path), path))
        for (const key of Object.keys(statement.fields || {}).filter(key => !definitions.some(field => field.name === key))) panel.append(node('p', `未登记字段：${key}（已保留）`, 'sentence-invalid-field'))
        if (!definitions.length) panel.append(node('p', '记录字段定义不可用；未知字段已原样保留。', 'sentence-invalid-field'))
      } else if (statement.kind === 'record.get') {
        const recordType = recordSchemaType(core, graph, statement.record, new Set(), path)
        const definitions = recordFieldDefinitions(editorGraph, recordType?.schema).fields
        if (definitions.length) selectField(panel, '字段名', statement.field || '', definitions.map(field => ({ value: field.name, label: `${fieldDisplayLabel(field)} · ${typeLabel(portValueType(field))}` })), value => updateStructural(statement.id, item => { item.field = value }, path), 'sentenceRecordField')
        else panel.append(node('p', `请先选择可解析的记录；字段“${statement.field || '未设置'}”会继续保留并参与诊断。`, 'sentence-invalid-field sentence-pending-field'))
        const recordDefinition = recordType || { kind: 'record', schema: '' }
        panel.append(structuralValue(graph, statement, { name: 'record', label: '记录值', type: recordDefinition }, statement.record, value => updateStructural(statement.id, item => { item.record = value }, path), path, { forceExpression: true }))
      } else if (statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) {
        const methodValues = ['map', 'filter', 'reduce'].map(value => ({ value, label: value === 'map' ? '映射' : value === 'filter' ? '筛选' : '汇总' }))
        selectField(panel, '处理方式', statement.method || 'map', methodValues, value => updateStructural(statement.id, item => { item.kind = 'collection'; item.method = value }, path), 'sentenceCollectionMethod')
        if (statement.method !== 'reduce' && (own(statement, 'accumulator') || own(statement, 'initial'))) {
          panel.append(node('p', '当前处理方式不会使用累计变量和初始值；原字段已保留，切回“汇总”后仍可继续编辑。', 'sentence-pending-field'))
        }
        panel.append(structuralValue(graph, statement, { name: 'items', label: '集合', type: { kind: 'list', element: 'any' } }, statement.items, value => updateStructural(statement.id, item => { item.items = value }, path), path))
        for (const [name, label] of [['item', '项目变量'], ['index', '索引变量']]) {
          const field = node('label', undefined, 'sentence-editor-field'); const input = document.createElement('input'); input.type = 'text'; input.value = statement[name] || ''; input.dataset.sentenceCollectionVariable = `${statement.id}:${name}`
          input.onchange = () => updateStructural(statement.id, item => { if (input.value.trim()) item[name] = input.value.trim(); else delete item[name] }, path); field.append(node('span', label, 'sentence-field-label'), input); panel.append(field)
        }
        if ((statement.method || '') === 'reduce') {
          const accumulator = node('label', undefined, 'sentence-editor-field'); const input = document.createElement('input'); input.type = 'text'; input.value = statement.accumulator || ''; input.dataset.sentenceCollectionAccumulator = statement.id
          input.onchange = () => updateStructural(statement.id, item => { if (input.value.trim()) item.accumulator = input.value.trim(); else delete item.accumulator }, path); accumulator.append(node('span', '累计变量', 'sentence-field-label'), input); panel.append(accumulator)
          panel.append(structuralValue(graph, statement, { name: 'initial', label: '初始累计值', type: 'any' }, statement.initial, value => updateStructural(statement.id, item => { item.initial = value }, path), path))
        }
        for (const [name, value] of Object.entries(statement.inputs || {})) panel.append(structuralValue(graph, statement, { name, label: `局部输入 · ${name}`, type: value?.kind === 'literal' ? literalTypeOfValue(value.value) : 'any' }, value, next => updateStructural(statement.id, item => { item.inputs = { ...(item.inputs || {}), [name]: next } }, path), path))
        panel.append(node('p', '集合体内语句会在“执行内容”分支中编辑；编译器负责校验 data-only 限制。', 'sentence-inline-editor-copy'))
      } else if (statement.kind === 'defer-choice') {
        const continuations = Array.isArray(ownerGraph?.continuations) ? ownerGraph.continuations : []
        selectField(panel, '续接流程', statement.graph || '', continuations.map(item => ({ value: `${item.id}@${item.version}`, label: item.label || item.name || '未命名续接流程' })), value => updateStructural(statement.id, item => { item.graph = value }, path), 'sentenceContinuationRef')
        const continuation = continuationDefinition(ownerGraph, statement.graph)
        const payloadType = continuation?.payloadType || continuation?.payload || continuation?.graph?.hostBindings?.payload || 'any'
        const fields = [
          ['payload', '载荷', payloadType], ['player', '玩家', 'player'], ['title', '标题', 'string'], ['targetType', '目标类型', 'string'],
          ['range', '范围', 'number'], ['filter', '筛选器', 'string'], ['candidates', '候选项', { kind: 'list', element: 'any' }], ['selectionMode', '选择模式', 'string'],
          ['min', '最少选择', 'number'], ['max', '最多选择', 'number'], ['minSelections', '最少选择（兼容）', 'number'], ['maxSelections', '最多选择（兼容）', 'number'],
          ['canCancel', '允许中止本次效果', 'boolean'], ['resumeOnCancel', '中止后继续流程', 'boolean'], ['message', '提示文字', 'string'],
        ]
        for (const [key, label, type] of fields) if (own(statement, key)) panel.append(structuralValue(graph, statement, { name: key, label, type }, statement[key], value => updateStructural(statement.id, item => { item[key] = value }, path), path, { forceExpression: key === 'payload' }))
        if (statement.min !== undefined && statement.minSelections !== undefined) panel.append(node('p', 'min 与 minSelections 不能同时使用；请保留一个字段。', 'sentence-invalid-field'))
        if (statement.max !== undefined && statement.maxSelections !== undefined) panel.append(node('p', 'max 与 maxSelections 不能同时使用；请保留一个字段。', 'sentence-invalid-field'))
      } else {
        panel.append(node('p', `当前语句类型“${statement.kind || '未知'}”保留在图中，但没有可用的字段描述。`, 'sentence-invalid-field'))
      }
      if (openPopover?.control === 'expression' && openPopover.statementId === statement.id) {
        let definition = null
        if (statement.kind === 'if' && openPopover.inputName === 'condition') definition = { name: 'condition', label: '条件', type: 'boolean' }
        if ((statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind?.startsWith?.('collection.')) && openPopover.inputName === 'items') definition = { name: 'items', label: '集合', type: { kind: 'list', element: 'any' } }
        if (statement.kind === 'return') definition = (ownerGraph.outputs || []).find(item => item.name === openPopover.inputName) || null
        if (statement.kind === 'call') {
          const currentDescriptor = descriptorForCurrent(graph, statement, path)
          const input = currentDescriptor?.inputs?.find(item => item.name === openPopover.inputName)
          definition = descriptorInputDefinition(currentDescriptor, input, statement)
        }
        if (definition) panel.append(renderExpressionChooser(statement, editorGraph, definition, path))
      }
      return panel
    }

    function updateCall(statementId, mutate, path = scopePath) {
      try {
        applyGraphChange(options, graph => {
          if (!updateStatementById(graph, statementId, mutate, path)) throw new Error('找不到要编辑的模块。')
        }, undefined, path)
        render()
      } catch (error) { report(error.message || String(error), 'error') }
    }

    function moduleDescriptors(graph) {
      const surface = graph?.surface
      const byKey = new Map()
      for (const descriptor of descriptorsFrom(descriptorSource(core))) {
        if (typeof descriptor.id !== 'string' || typeof descriptor.version !== 'string') continue
        if (Array.isArray(descriptor.allowedSurfaces) && surface && !descriptor.allowedSurfaces.includes(surface)) continue
        byKey.set(`${descriptor.id}@${descriptor.version}`, descriptor)
      }
      for (const composite of Array.isArray(graph?.composites) ? graph.composites : []) {
        if (!record(composite) || typeof composite.id !== 'string' || typeof composite.version !== 'string') continue
        if (Array.isArray(composite.allowedSurfaces) && surface && !composite.allowedSurfaces.includes(surface)) continue
        const key = `${composite.id}@${composite.version}`
        if (byKey.has(key)) continue
        byKey.set(key, {
          ...composite,
          label: composite.label || composite.id,
          description: composite.description || '当前模块图中的组合模块',
          inputs: Array.isArray(composite.inputs) ? composite.inputs : [],
          outputs: Array.isArray(composite.outputs) ? composite.outputs : [],
          parameters: Array.isArray(composite.parameters) ? composite.parameters : [],
          allowedSurfaces: Array.isArray(composite.allowedSurfaces) ? composite.allowedSurfaces : (surface ? [surface] : []),
          __composite: true,
        })
      }
      return [...byKey.values()]
    }

    function renderAuthorStatementEditor(statement, graph, path) {
      const metadata = authorStatementMetadata(statement)
      const draftKey = authorStatementDraftKey(statement.id, path)
      const storedDraft = authorStatementDrafts.get(draftKey)
      const draftValues = { ...metadata, ...(record(storedDraft) ? clone(storedDraft) : {}) }
      let applyButton = null
      const panel = node('div', undefined, 'sentence-inline-editor sentence-statement-editor sentence-author-statement-editor')
      panel.dataset.sentencePopover = `statement:${statement.id}`
      panel.dataset.sentenceInlineEditor = statement.id || ''
      panel.dataset.sentenceAuthorStatement = statement.id || ''
      const top = node('div', undefined, 'sentence-inline-editor-top')
      top.append(node('strong', metadata?.kind === 'extension-declaration' ? '编辑扩展变量声明' : '编辑赋值', 'sentence-inline-editor-title'))
      top.append(action('关闭编辑', closePopover, 'sentence-popover-close'))
      panel.append(top)
      const help = metadata?.kind === 'extension-declaration'
        ? '在对象的扩展中新建变量；对象类型由表达式自动推导。'
        : '目标必须是已声明局部变量、可写字段或已声明扩展变量。'
      panel.append(node('p', help, 'sentence-inline-editor-copy'))
      const updateDraft = changes => {
        Object.assign(draftValues, changes)
        authorStatementDrafts.set(draftKey, clone(draftValues))
        notifyEditorStateChange()
        if (applyButton) applyButton.disabled = false
      }
      const sourceField = (label, key, value, placeholder) => {
        const field = node('label', undefined, 'sentence-editor-field sentence-author-source-field')
        field.append(node('span', label, 'sentence-field-label'))
        const host = node('div', undefined, 'sentence-author-source-editor')
        host.dataset.sentenceAuthorField = key
        host.dataset.sentenceAuthorSource = key
        host.setAttribute('aria-label', label)
        const expectedType = key === 'initialSource' && metadata.kind === 'extension-declaration'
          ? serializedValueType(draftValues.valueType, 'unknown')
          : key === 'valueSource' && metadata.kind === 'assignment' ? draftValues.valueType || 'unknown' : undefined
        const context = authorStatementContext(graph, scopeDefinition(graph, path).body || [], path, `${statement.id}_edit`)
        if (typeof window.ExpressionInput?.mount === 'function') {
          const widget = window.ExpressionInput.mount(host, {
            value: value == null ? '' : String(value),
            label,
            placeholder: placeholder || '',
            getSuggestions: (_query, details) => typeof core?.completeAuthorExpression === 'function'
              ? core.completeAuthorExpression(details.prefix, { ...context, expectedType }).filter(item => !item.generatedName)
              : [],
            getParameterHint: details => core?.authorExpressionParameterHint?.(details.prefix, { ...context, expectedType }),
            onChange: text => updateDraft({ [key]: text }),
            onCompositionEnd: flushPendingRender,
          })
          expressionEditors.add(widget)
        } else {
          const input = document.createElement('input')
          input.type = 'text'; input.value = value == null ? '' : String(value); input.placeholder = placeholder || ''
          input.dataset.sentenceAuthorInput = key
          input.addEventListener('compositionstart', () => composingControls.add(input))
          input.addEventListener('compositionupdate', () => composingControls.add(input))
          input.addEventListener('compositionend', () => {
            composingControls.add(input)
            setTimeout(() => { composingControls.delete(input); flushPendingRender() }, 0)
          })
          input.addEventListener('input', event => {
            if (event.isComposing) {
              composingControls.add(input)
              return
            }
            // The final input can follow compositionend in the same task.
            // Keep the render queued, but retain that committed value.
            updateDraft({ [key]: input.value })
          })
          host.append(input)
        }
        field.append(host)
        return field
      }
      if (metadata?.kind === 'extension-declaration') {
        const owner = sourceField('对象', 'ownerSource', draftValues.ownerSource, '当前玩家、当前棋子或全局')
        owner.dataset.sentenceAuthorOwner = ''
        panel.append(owner)
        panel.append(sourceField('变量名称', 'name', draftValues.name, '例如：计数'))
        const typeField = node('label', undefined, 'sentence-editor-field sentence-author-type-field')
        typeField.append(node('span', '变量类型', 'sentence-field-label'))
        const defaultSourceForType = value => {
          const selected = record(value) && value.kind === 'nullable' ? value.value : value
          if (selected === 'boolean') return 'false'
          if (selected === 'string') return '""'
          if (selected === 'piece') return '当前棋子'
          if (selected === 'player') return '当前玩家'
          if (record(selected) && selected.kind === 'list') return `{${defaultSourceForType(selected.element)}}`
          if (record(selected) && selected.kind === 'set') return `集合({${defaultSourceForType(selected.element)}})`
          if (record(selected) && selected.kind === 'map') return `映射({"键"}, {${defaultSourceForType(selected.value)}})`
          return '0'
        }
        const typeEditor = typeControl(serializedValueType(draftValues.valueType, 'number'), value => updateDraft({
          valueType: value,
          ...(new Set(['0', 'false', '""', '{}']).has(String(draftValues.initialSource || '').trim()) ? { initialSource: defaultSourceForType(value) } : {}),
        }), graph, 'sentenceAuthorValueType')
        typeEditor.dataset.sentenceAuthorValueType = ''
        typeField.append(typeEditor)
        panel.append(typeField)
        panel.append(sourceField('初始表达式', 'initialSource', draftValues.initialSource, '例如：0 或 当前棋子.攻击力'))
        panel.append(node('small', `对象类型：${({ piece: '棋子', player: '玩家', battle: '全局', skill: '技能实例', status: '状态实例', rule: '规则实例', card: '卡牌实例', cluster: '能力组实例', 'tile-effect': '地格效果' })[metadata.scope] || '待推导'}`, 'sentence-field-help'))
      } else {
        panel.append(sourceField('目标字段/变量', 'targetSource', draftValues.targetSource, '例如：次数 或 当前棋子.动量'))
        panel.append(sourceField('值表达式', 'valueSource', draftValues.valueSource, '例如：次数 + 1'))
        panel.append(node('small', `结果类型：${typeLabel(draftValues.valueType || 'unknown')}`, 'sentence-field-help'))
      }
      applyButton = action('应用', () => {
        try {
          replaceAuthorStatement(options, statement.id, draftValues, path)
          report('作者语句已更新。', 'success')
        }
        catch (error) { report(error?.message || String(error), 'error') }
      }, 'sentence-author-statement-apply')
      applyButton.dataset.sentenceAuthorApply = statement.id || ''
      applyButton.disabled = !storedDraft
      panel.append(node('div', undefined, 'sentence-author-statement-footer'))
      panel.lastChild.append(node('small', '可先修改多个字段，再一次应用；输入法组合期间不会刷新编辑器。', 'sentence-field-help'), applyButton)
      return panel
    }

    function renderStatementEditor(statement, graph, path = scopePath, editorOptions = {}) {
      if (authorStatementMetadata(statement)) return renderAuthorStatementEditor(statement, graph, path)
      if (statement?.kind !== 'call') return renderStructuredStatementEditor(statement, graph, path)
      const panel = node('div', undefined, 'sentence-inline-editor sentence-statement-editor')
      panel.dataset.sentencePopover = `statement:${statement.id}`
      panel.dataset.sentenceInlineEditor = statement.id || ''
      const focusedSlot = (openPopover?.control === 'slot' || openPopover?.control === 'expression')
        && openPopover.statementId === statement.id && openPopover.slotName
        ? openPopover
        : null
      if (focusedSlot) panel.classList.add('sentence-slot-only-editor')
      if (focusedSlot) {
        panel.dataset.sentenceSlotEditor = `${focusedSlot.slotKind || 'input'}:${focusedSlot.slotName || ''}`
      }
      const descriptor = descriptorForCurrent(graph, statement, path)
      const editorGraph = graphWithDescriptorSchemas(schemaGraphForScope(graph, path), descriptor)
      const stableEditorTarget = editorOptions.activatePopover
        ? { control: 'statement', statementId: statement.id, scopePath: path }
        : null
      const activateEditorPopover = () => {
        if (stableEditorTarget) openPopover = stableEditorTarget
      }
      const top = node('div', undefined, 'sentence-inline-editor-top')
      const focusedDefinition = focusedSlot
        ? (focusedSlot.slotKind === 'parameter'
          ? (Array.isArray(descriptor?.parameters) ? descriptor.parameters : []).find(item => item.name === focusedSlot.slotName)
          : descriptorInputDefinition(descriptor, (Array.isArray(descriptor?.inputs) ? descriptor.inputs : []).find(item => item.name === focusedSlot.slotName), statement))
        : null
      const focusedLabel = semanticSlotLabel(focusedDefinition, focusedSlot?.slotName)
      top.append(node('strong', focusedSlot ? `编辑${focusedSlot.slotKind === 'parameter' ? '参数' : '输入'}：${focusedLabel}` : '编辑模块', 'sentence-inline-editor-title'))
      const close = action('关闭编辑', closePopover, 'sentence-popover-close')
      top.append(close); panel.append(top)
      const allDescriptors = moduleDescriptors(graphOwner(graph, path))
      const authorDescriptors = authoringPickerDescriptors(allDescriptors.filter(item => !isCompatibilityDescriptor(item)))
      const currentDescriptor = allDescriptors.find(item => item.id === statement.module && item.version === statement.version)
      const descriptors = [...authorDescriptors, ...(currentDescriptor && !authorDescriptors.some(item => item.id === currentDescriptor.id && item.version === currentDescriptor.version) ? [currentDescriptor] : [])]
      if (!focusedSlot) {
        const select = document.createElement('select')
        select.dataset.gameplayModuleModule = 'true'
        select.dataset.sentenceModuleSelect = statement.id || ''
        for (const item of descriptors) {
          const option = node('option', semanticModuleLabel(item.id, item.label))
          option.value = `${item.id}\0${item.version}`; select.append(option)
        }
        if (statement.module && !descriptors.some(item => item.id === statement.module && item.version === statement.version)) {
          const option = node('option', '当前模块引用（已保存）')
          option.value = `${statement.module}\0${statement.version}`; select.append(option)
        }
        select.value = `${statement.module || ''}\0${statement.version || ''}`
        select.onchange = () => {
          const [id, version] = select.value.split('\0')
          const nextDescriptor = descriptors.find(item => item.id === id && item.version === version)
          activateEditorPopover()
          updateCall(statement.id, item => {
            // Module replacement must not silently throw away authored ports.
            // The descriptor/default pass fills only missing values; retained
            // values are rendered as pending/invalid when the new type cannot
            // accept them, so authors can repair them explicitly.
            const priorInputs = { ...(item.inputs || {}) }
            const priorParameters = { ...(item.parameters || {}) }
            item.module = id; item.version = version
            item.inputs = priorInputs; item.parameters = priorParameters
            for (const parameter of Array.isArray(nextDescriptor?.parameters) ? nextDescriptor.parameters : []) {
              if (!own(item.parameters, parameter.name) && own(parameter, 'default')) item.parameters[parameter.name] = clone(parameter.default)
            }
          }, path)
        }
        const moduleField = node('label', undefined, 'sentence-editor-field sentence-module-select-field')
        moduleField.append(node('span', '模块选择', 'sentence-field-label'), select)
        panel.append(moduleField)
      }
      if (!descriptor) {
        panel.append(node('p', '当前模块未注册；可从上方菜单选择可用模块。', 'sentence-message error'))
        return panel
      }
      if (!focusedSlot && (descriptor.description || descriptor.uiDescription)) panel.append(node('p', descriptor.uiDescription || descriptor.description, 'sentence-inline-editor-copy'))
      const inputs = Array.isArray(descriptor.inputs) ? descriptor.inputs : []
      const parameters = Array.isArray(descriptor.parameters) ? descriptor.parameters : []
      const hasParameterValue = name => {
        const value = statement.parameters?.[name]
        if (value !== undefined && value !== null && value !== '') return true
        const definition = parameters.find(parameter => parameter.name === name)
        const fallback = definition?.default
        return fallback !== undefined && fallback !== null && fallback !== ''
      }
      const dependencySatisfied = definition => {
        const dependency = definition?.dependsOn || definition?.ui?.dependsOn || definition?.ui?.when
        if (!dependency) return true
        const list = Array.isArray(dependency) ? dependency : [dependency]
        return list.every(item => {
          if (typeof item === 'string') return hasParameterValue(item)
          if (!record(item)) return true
          const name = item.parameter || item.name || item.field
          const value = name ? statement.parameters?.[name] : undefined
          if (item.exists === true || item.required === true) return value !== undefined && value !== null && value !== ''
          if (item.equals !== undefined) return value === item.equals
          if (Array.isArray(item.oneOf)) return item.oneOf.includes(value)
          return value !== undefined && value !== null && value !== ''
        })
      }
      const extensionDescriptor = /^extension\.(declare|read|write)-(player|piece|battle|instance)$/.exec(descriptor.id || '')
      const extensionInstanceDescriptor = /^extension\.(declare|read|write)-instance$/.test(descriptor.id || '')
      const inferredEntityKind = extensionInstanceDescriptor
        ? entityKindForValue(graph, statement.inputs?.entity, path)
        : null
      if (inferredEntityKind && statement.parameters?.entityKind !== inferredEntityKind) {
        // This is a deterministic normalization of the hidden authoring
        // parameter.  The graph compiler still validates the value; the UI
        // simply avoids making the author repeat a domain already carried by
        // the typed entity reference.
        statement.parameters = { ...(statement.parameters || {}), entityKind: inferredEntityKind }
      }
      const mapDescriptor = /^extension\.map-(declare|items|put|remove)$/.exec(descriptor.id || '')
      const isAuthorableInput = input => {
        if (!input) return false
        const templateAvailability = sentenceSlotAvailable(descriptor, statement, 'input', input.name, { allowUnsetOptional: Boolean(input.optional) })
        if (templateAvailability !== null) return templateAvailability
        if (!dependencySatisfied(input)) return false
        // Values of a custom extension become meaningful after its target has
        // a name and type.  Keep an authored value in the graph and surface it
        // as pending below rather than deleting it.
        if (extensionDescriptor && input.name === 'value' && extensionDescriptor[1] !== 'read') {
          return hasParameterValue('name') && hasParameterValue('valueType')
        }
        return true
      }
      const isVisibleInput = input => Boolean(isAuthorableInput(input)) && (!focusedSlot || (focusedSlot.slotKind === 'input' && focusedSlot.slotName === input.name))
      const isInternalAuthorParameter = parameter => descriptor.id === 'author.choice.option' && String(statement.version) === '3' && parameter?.name === 'optionsType'
        || sentenceParameterIsDerived(descriptor, statement, parameter?.name)
        // These values are compiler bindings or compatibility spellings. They
        // remain in the graph for deterministic lowering, while authors edit
        // the typed inputs and Chinese semantic choices instead.
        || ['sourceType', 'targetType', 'amountType', 'resultType', 'templateType', 'destinationType', 'displayType', 'extensionType', 'definitionType', 'blockType', 'argsType', 'legacyNormalSpelling', 'entityKind'].includes(parameter?.name)
        || ['author.effect.damage', 'author.effect.heal'].includes(descriptor.id)
          && ['2', '3'].includes(String(statement.version || descriptor.version))
          && parameter?.name === 'skillId'
        // Older editor bundles had no sentence metadata API. Keep this narrow
        // fallback so a legacy catalog still hides the instance discriminator.
        || extensionInstanceDescriptor && parameter?.name === 'entityKind'
      const isAuthorableParameter = parameter => {
        if (!parameter) return false
        if (isInternalAuthorParameter(parameter)) return false
        // The typed damage sentence exposes an attribution toggle even when
        // the template has folded the default into prose. A focused toggle
        // must open the real enum editor instead of the generic prerequisite
        // warning used for dependent parameters.
        if (descriptor.id === 'author.effect.damage' && String(statement.version || descriptor.version) === '3'
          && parameter.name === 'attribution'
          && focusedSlot?.slotKind === 'parameter' && focusedSlot.slotName === 'attribution') return true
        if (/^author\.effect\.(damage|heal)$/.test(descriptor.id) && statement.version === '2' && (['sourceType', 'targetType', 'amountType', 'resultType'].includes(parameter.name) || descriptor.id === 'author.effect.heal' && parameter.name === 'damageType')) return false
        if (descriptor.id === 'rule.remove-id-raw' && String(descriptor.version) === '2' && parameter.name === 'targetType') return false
        if (['author.effect.summon', 'author.piece.display'].includes(descriptor.id) && ['sourceType', 'templateType', 'destinationType', 'displayType'].includes(parameter.name)) return false
        if (descriptor.id === 'author.card.gain' && parameter.name === 'extensionType') return false
        if (descriptor.id === 'local.write' && parameter.name === 'valueType') return false
        const templateAvailability = sentenceSlotAvailable(descriptor, statement, 'parameter', parameter.name, { allowUnsetOptional: Boolean(parameter.optional) })
        if (templateAvailability !== null) return templateAvailability
        if (!dependencySatisfied(parameter)) return false
        if (extensionDescriptor) {
          if (parameter.name === 'valueType') return hasParameterValue('name')
          if (parameter.name === 'path') return hasParameterValue('name')
        }
        if (mapDescriptor) {
          if (parameter.name === 'schema') return hasParameterValue('name')
          if (parameter.name === 'keyField') return hasParameterValue('schema')
        }
        return true
      }
      const isVisibleParameter = parameter => Boolean(isAuthorableParameter(parameter)) && (!focusedSlot || (focusedSlot.slotKind === 'parameter' && focusedSlot.slotName === parameter.name))
      const pendingValue = (kind, name) => kind === 'input' ? own(statement.inputs || {}, name) : own(statement.parameters || {}, name)
      const renderInput = input => {
        const definition = descriptorInputDefinition(descriptor, input, statement)
        const displayDefinition = definition?.label ? definition : { ...definition, label: semanticSlotLabel(definition, input.name) }
        const current = statement.inputs?.[input.name]
        const field = node('div', undefined, 'sentence-module-input-field')
        field.dataset.sentenceModuleInput = input.name
        field.append(valueEditor(core, editorGraph, statement, displayDefinition, current, value => {
          activateEditorPopover()
          updateCall(statement.id, item => {
            item.inputs = { ...(item.inputs || {}) }
            if (value !== undefined) item.inputs[input.name] = value
            else delete item.inputs[input.name]
            if (extensionInstanceDescriptor && input.name === 'entity') {
              const entityKind = entityKindForValue(graph, value, path)
              if (entityKind) item.parameters = { ...(item.parameters || {}), entityKind }
            }
          }, path)
        }, false, {
          renderExpression: (g, s, d, v) => renderAuthorExpression(graph, s, d, v, path),
          forceExpression: openPopover?.control === 'expression' && openPopover.directExpression === true
            && openPopover.statementId === statement.id && openPopover.inputName === input.name,
          onAuthorExpression: () => {
            const returnPopover = stableEditorTarget || openPopover?.returnPopover || openPopover
            openPopover = { control: 'expression', directExpression: true, statementId: statement.id, inputName: input.name, slotKind: 'input', slotName: input.name, scopePath: path, ...(returnPopover ? { returnPopover } : {}) }
            render()
          },
          scopePath: path,
          schemaRegistry: options.schemaRegistry || options.objectSchemaRegistry,
          catalog: authorReferenceCatalog(options.catalog),
          getCatalog: typeof options.getCatalog === 'function' ? () => authorReferenceCatalog(options.getCatalog()) : undefined,
          referenceResolver: authorContentReference,
          onCompose: () => {
            const returnPopover = stableEditorTarget || openPopover?.returnPopover || openPopover
            openPopover = { control: 'expression', statementId: statement.id, inputName: input.name, slotKind: 'input', slotName: input.name, scopePath: path, ...(returnPopover ? { returnPopover } : {}) }
            render()
          },
          onLiteralTypeChange: nextType => {
            if (!nextType || nextType === 'record' || nextType === 'object') return
            const typeParameter = {
              'author.effect.summon': { source: 'sourceType', template: 'templateType', destination: 'destinationType', display: 'displayType' },
              'author.piece.display': { display: 'displayType' },
              'content.materialize-template': { fields: 'fieldsType', extension: 'extensionType' },
              'author.card.gain': { extension: 'extensionType' },
              'author.cluster.acquire': { definition: 'definitionType' },
              'code-block.invoke': { block: 'blockType', args: 'argsType' },
            }[descriptor.id]?.[input.name]
            if (!typeParameter) return
            const encoded = typeof nextType === 'string' ? nextType : JSON.stringify(nextType)
            updateCall(statement.id, item => { item.parameters = { ...(item.parameters || {}), [typeParameter]: encoded } }, path)
          },
          onOpenSource: () => openSourceExpression(current, path, stableEditorTarget || openPopover?.returnPopover || openPopover),
        }))
        if (input.description) field.append(node('small', input.description, 'sentence-field-help'))
        if (current) {
          const actual = current.kind === 'literal'
            ? literalTypeOfValue(current.value)
            : outputValueType(core, graph, current, path)
          const expected = portValueType(displayDefinition)
          if (actual && !compatibleType(actual, expected)) {
            const warning = node('small', `待重填：当前是${typeLabel(actual)}，此处需要${typeLabel(expected)}。原值已保留，请重新选择或组合表达式。`, 'sentence-invalid-field sentence-type-mismatch')
            warning.dataset.sentenceTypeMismatch = `${statement.id}:${input.name}`
            warning.setAttribute('role', 'alert')
            field.append(warning)
          }
        }
        return field
      }
      const requiredInputs = inputs.filter(input => !input.optional && isVisibleInput(input))
      const optionalInputs = inputs.filter(input => input.optional && isVisibleInput(input))
      const hiddenInputs = focusedSlot ? [] : inputs.filter(input => !isVisibleInput(input) && pendingValue('input', input.name) && !sentenceResultMessageIsHidden(descriptor, statement, 'input', input.name))
      if (requiredInputs.length && !focusedSlot) panel.append(node('h4', '必填数据引用', 'sentence-inline-editor-section'))
      for (const input of requiredInputs) panel.append(renderInput(input))
      if (optionalInputs.length && !focusedSlot) {
        const advancedInputs = node('details', undefined, 'sentence-advanced-fields')
        advancedInputs.open = optionalInputs.some(input => own(statement.inputs || {}, input.name))
        const summary = node('summary', `其他数据引用（可选，${optionalInputs.length} 项）`, 'sentence-advanced-fields-title')
        advancedInputs.append(summary)
        for (const input of optionalInputs) advancedInputs.append(renderInput(input))
        panel.append(advancedInputs)
      } else for (const input of optionalInputs) panel.append(renderInput(input))
      if (focusedSlot && focusedSlot.slotKind === 'input' && !isVisibleInput(inputs.find(input => input.name === focusedSlot.slotName))) {
        const warning = node('p', '请先完成前置选择后再编辑此输入；已有值会继续保留。', 'sentence-invalid-field sentence-pending-field')
        warning.dataset.sentencePendingInput = `${statement.id}:${focusedSlot.slotName}`
        warning.setAttribute('role', 'alert')
        panel.append(warning)
      }
      for (const input of hiddenInputs) {
        const warning = node('p', `待重填：${semanticSlotLabel(input, input.name)} 需要先完成前置选择；当前值已保留。`, 'sentence-invalid-field sentence-pending-field')
        warning.dataset.sentencePendingInput = `${statement.id}:${input.name}`
        warning.setAttribute('role', 'alert')
        panel.append(warning)
      }
      const missingInputs = requiredInputs.filter(input => !own(statement.inputs || {}, input.name))
      if (missingInputs.length) {
        const warning = node('p', `请先填写必填输入：${missingInputs.map(input => semanticSlotLabel(input, input.name)).join('、')}。`, 'sentence-message error')
        warning.dataset.sentenceMissingInput = statement.id || ''
        warning.setAttribute('role', 'alert')
        panel.append(warning)
      }
      for (const name of Object.keys(statement.inputs || {}).filter(name => !inputs.some(input => input.name === name))) {
        panel.append(node('p', `未登记输入：${name}（已保留）`, 'sentence-invalid-field'))
      }
      const extensionOperation = /^extension\.map-(declare|items|put|remove)$/.exec(descriptor.id || '')?.[1] || ''
      const extensionValueOperation = /^extension\.(declare|read|write)-(player|piece|battle|instance)$/.exec(descriptor.id || '')
      const extensionDeclarations = (extensionOperation || extensionValueOperation) ? extensionMapDeclarations(graph, path, statement.id) : []
      const mapDeclarations = extensionDeclarations.filter(item => item.kind === 'map')
      const currentExtensionDeclaration = () => mapDeclarations.find(item => item.namespace === statement.parameters?.namespace && item.name === statement.parameters?.name)
      const schemaValues = graphSchemas(editorGraph).map(schema => ({
        value: `${schema.id}@${schema.version}`,
        label: schemaDisplayLabel(schema),
      }))
      const selectParameter = (parameter, values, current, onChange, disabled = false) => {
        const select = document.createElement('select')
        select.dataset.sentenceParameterPicker = parameter.name
        select.dataset.sentenceModuleParameterPicker = parameter.name
        const parameterLabel = semanticSlotLabel(parameter, parameter.name)
        select.setAttribute('aria-label', parameterLabel)
        const options = [['', `请选择${parameterLabel}`], ...values.map(item => [item.value, item.label])]
        if (current !== undefined && current !== null && current !== '' && !options.some(item => item[0] === current)) options.push([String(current), '当前值（已保存）'])
        for (const [value, label] of options) { const option = node('option', label); option.value = value; select.append(option) }
        select.value = current == null ? '' : String(current)
        select.disabled = disabled
        select.onchange = () => onChange(select.value)
        return select
      }
      const schemaParameterValues = () => {
        if (!extensionOperation || extensionOperation === 'declare') return schemaValues
        const declaration = currentExtensionDeclaration()
        if (declaration?.schema) return schemaValues.filter(item => item.value === declaration.schema || item.value.startsWith(`${declaration.schema}@`))
        return schemaValues
      }
      const keyFieldValues = () => {
        const selectedSchema = schemaForGraph(editorGraph, statement.parameters?.schema)
        return (Array.isArray(selectedSchema?.fields) ? selectedSchema.fields : []).map(field => ({
          value: field.name,
          label: fieldDisplayLabel(field),
        }))
      }
      const appendExtensionSuggestions = (control, parameter) => {
        const operation = extensionValueOperation || mapDescriptor
        if (!operation || operation[1] === 'declare' || !extensionDeclarations.length) return
        const input = control.querySelector?.('input')
        if (!input) return
        const extensionScope = operation[2] === 'instance' ? inferredEntityKind : operation[2]
        const values = [...new Set(extensionDeclarations
          .filter(item => item.kind === (mapDescriptor ? 'map' : 'value') && (!extensionScope || item.scope === extensionScope))
          .map(item => parameter.name === 'namespace' ? item.namespace : item.name))]
        if (!values.length) return
        const list = document.createElement('datalist')
        list.id = `sentence-extension-${statement.id}-${parameter.name}`.replace(/[^a-zA-Z0-9_-]/g, '-')
        for (const value of values) list.append(node('option', value))
        input.setAttribute('list', list.id)
        control.append(list)
      }
      const scopedWriterParameter = (parameter) => {
        if (descriptor?.id !== 'piece.write-field' || String(statement.version || descriptor?.version) !== '2' || parameter?.name !== 'field') return parameter
        const scope = statement.parameters?.scope ?? descriptor.parameters?.find(item => item.name === 'scope')?.default
        const enumValues = scope === 'stored'
          ? ['attack', 'defense', 'moveRange', 'showFreezeEffect']
          : ['spentPassives', 'momentum', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange']
        return { ...parameter, enum: enumValues }
      }
      const renderParameter = parameter => {
        const effectiveParameter = scopedWriterParameter(parameter)
        const field = node('label', undefined, 'sentence-editor-field sentence-module-parameter-field')
        field.dataset.sentenceModuleParameter = parameter.name
        const parameterLabel = semanticSlotLabel(effectiveParameter, parameter.name)
        const isSchemaParameter = parameter.name === 'schema' && Boolean(descriptor?.outputSchemaBindings || descriptor?.inputSchemaBindings)
        const isKeyFieldParameter = parameter.name === 'keyField' && Boolean(descriptor?.outputSchemaBindings || descriptor?.inputSchemaBindings)
        const isValueTypeParameter = parameter.name === 'valueType' && Boolean(descriptor?.outputValueTypeBindings || descriptor?.inputValueTypeBindings)
        let control
        const syncChoiceOptionTypes = item => {
          if (descriptor?.id !== 'author.choice.option' || String(item?.version || statement.version) !== '3') return
          const optionsType = outputValueType(core, editorGraph, item?.inputs?.options, path)
          if (!optionsType || typeof optionsType !== 'object' || optionsType.kind !== 'map') return
          const valueType = item.parameters?.selectionMode === 'multi'
            ? { kind: 'list', element: optionsType.value }
            : optionsType.value
          item.parameters = {
            ...(item.parameters || {}),
            optionsType: JSON.stringify(optionsType),
            valueType: typeof valueType === 'string' ? valueType : JSON.stringify(valueType),
          }
        }
        const updateParameter = mutate => {
          activateEditorPopover()
          updateCall(statement.id, item => {
            mutate(item)
            // Before an options map exists, the author-facing return type can
            // establish the map value type. Keep this compiler binding
            // synchronized without exposing it as a separate control.
            if (descriptor?.id === 'author.choice.option' && String(item?.version || statement.version) === '3'
              && parameter.name === 'valueType' && !own(item.inputs || {}, 'options')) {
              try {
                const raw = item.parameters?.optionsType
                const parsed = typeof raw === 'string' && raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw
                const selectedRaw = item.parameters?.valueType
                const selected = typeof selectedRaw === 'string' && selectedRaw.trimStart().startsWith('{') ? JSON.parse(selectedRaw) : selectedRaw
                if (parsed?.kind === 'map' && parsed.key === 'string' && parsed.value === 'string') item.parameters.optionsType = JSON.stringify({ ...parsed, value: selected })
              } catch { /* retain the registered default until map editing */ }
            }
            // Choice v3 derives its public result shape from the typed map
            // input. Keep that shape synchronized when an author changes the
            // single/multi return form after the options expression exists.
            syncChoiceOptionTypes(item)
            const derived = globalThis.SentenceTemplateCatalog?.derivedParameterValues?.(descriptor, item)
            if (derived) item.parameters = { ...(item.parameters || {}), ...derived }
          }, path)
        }
        const updateDamageAttribution = value => {
          updateParameter(item => { item.parameters = { ...(item.parameters || {}), [parameter.name]: value } })
          if (descriptor.id === 'author.effect.damage' && String(statement.version || descriptor.version) === '3'
            && parameter.name === 'attribution' && value === 'current') {
            try { ensureTypedDamageCurrentCluster(statement, descriptor, graph, path) }
            catch (error) { report(error?.message || String(error), 'error') }
          }
        }
        if (isValueTypeParameter) {
          const current = serializedValueType(statement.parameters?.[parameter.name], 'number')
          control = typeControl(current, value => updateParameter(item => {
            item.parameters = { ...(item.parameters || {}), [parameter.name]: typeof value === 'string' ? value : JSON.stringify(value) }
          }), editorGraph, 'sentenceValueTypeParameter')
          control.dataset.sentenceValueTypeParameter = parameter.name
        } else if (isSchemaParameter) {
          const values = schemaParameterValues(parameter)
          control = selectParameter(parameter, values, statement.parameters?.[parameter.name], value => updateParameter(item => {
            item.parameters = { ...(item.parameters || {}), [parameter.name]: value }
          }), values.length === 0)
          control.dataset.sentenceSchemaParameter = parameter.name
        } else if (isKeyFieldParameter) {
          const values = keyFieldValues()
          control = selectParameter(parameter, values, statement.parameters?.[parameter.name], value => updateParameter(item => { item.parameters = { ...(item.parameters || {}), [parameter.name]: value } }), values.length === 0)
          control.dataset.sentenceKeyFieldParameter = parameter.name
          if (!values.length) control.title = '请先选择已声明的记录类型。'
        } else {
          control = literalControl(statement.parameters?.[parameter.name] ?? defaultForType(effectiveParameter), effectiveParameter, value => updateDamageAttribution(value), false, {
            graph: editorGraph,
            schemaRegistry: options.schemaRegistry || options.objectSchemaRegistry,
            catalog: authorReferenceCatalog(options.catalog),
            getCatalog: typeof options.getCatalog === 'function' ? () => authorReferenceCatalog(options.getCatalog()) : undefined,
            referenceResolver: authorContentReference,
          })
          if ((extensionValueOperation || extensionOperation) && (parameter.name === 'namespace' || parameter.name === 'name')) appendExtensionSuggestions(control, parameter)
        }
        // Schema/type selectors expose the domain value directly below. Their
        // registry storage type is an internal string and should not be
        // presented as a second, misleading author-facing type label.
        const hideStorageType = isValueTypeParameter || isSchemaParameter || isKeyFieldParameter
        field.append(node('span', hideStorageType ? parameterLabel : `${parameterLabel} · ${typeLabel(portValueType(effectiveParameter))}`, 'sentence-field-label'))
        field.append(control)
        if (parameter.description) field.append(node('small', parameter.description, 'sentence-field-help'))
        if (parameter.name === 'field' && Array.isArray(effectiveParameter.enum)
          && own(statement.parameters || {}, 'field') && !effectiveParameter.enum.includes(statement.parameters.field)) {
          const scope = statement.parameters?.scope ?? descriptor.parameters?.find(item => item.name === 'scope')?.default
          field.append(node('small', `当前目标范围“${scope === 'stored' ? '已保存记录' : '当前棋子'}”不支持字段“${statement.parameters.field}”；原值已保留，请重新选择。`, 'sentence-invalid-field sentence-type-mismatch'))
        }
        if (isKeyFieldParameter) {
          const values = keyFieldValues()
          const current = statement.parameters?.[parameter.name]
          if (current && (!values.length || !values.some(item => item.value === current))) {
            const warning = node('small', `待重填：字段“${current}”不属于当前 schema，原值已保留。`, 'sentence-invalid-field sentence-type-mismatch')
            warning.dataset.sentencePendingParameter = `${statement.id}:${parameter.name}`
            warning.setAttribute('role', 'alert')
            field.append(warning)
          }
        }
        return field
      }
      const requiredParameters = parameters.filter(parameter => !parameter.optional && isVisibleParameter(parameter))
      const optionalParameters = parameters.filter(parameter => parameter.optional && isVisibleParameter(parameter))
      const hiddenParameters = focusedSlot ? [] : parameters.filter(parameter => !isInternalAuthorParameter(parameter) && !isVisibleParameter(parameter) && pendingValue('parameter', parameter.name))
      if (requiredParameters.length && !focusedSlot) panel.append(node('h4', '必填参数', 'sentence-inline-editor-section'))
      for (const parameter of requiredParameters) panel.append(renderParameter(parameter))
      if (optionalParameters.length && !focusedSlot) {
        const advancedParameters = node('details', undefined, 'sentence-advanced-fields')
        advancedParameters.open = optionalParameters.some(parameter => own(statement.parameters || {}, parameter.name))
        const summary = node('summary', `其他参数（可选，${optionalParameters.length} 项）`, 'sentence-advanced-fields-title')
        advancedParameters.append(summary)
        for (const parameter of optionalParameters) advancedParameters.append(renderParameter(parameter))
        panel.append(advancedParameters)
      } else for (const parameter of optionalParameters) panel.append(renderParameter(parameter))
      if (focusedSlot && focusedSlot.slotKind === 'parameter' && !isVisibleParameter(parameters.find(parameter => parameter.name === focusedSlot.slotName))) {
        const warning = node('p', '请先完成前置选择后再编辑此参数；已有值会继续保留。', 'sentence-invalid-field sentence-pending-field')
        warning.dataset.sentencePendingParameter = `${statement.id}:${focusedSlot.slotName}`
        warning.setAttribute('role', 'alert')
        panel.append(warning)
      }
      for (const parameter of hiddenParameters) {
        const warning = node('p', `待重填：${semanticSlotLabel(parameter, parameter.name)} 需要先完成前置选择；当前值已保留。`, 'sentence-invalid-field sentence-pending-field')
        warning.dataset.sentencePendingParameter = `${statement.id}:${parameter.name}`
        warning.setAttribute('role', 'alert')
        panel.append(warning)
      }
      const missingParameters = requiredParameters.filter(parameter => !own(statement.parameters || {}, parameter.name) && !own(parameter, 'default'))
      if (missingParameters.length) {
        const warning = node('p', `请先填写必填参数：${missingParameters.map(parameter => semanticSlotLabel(parameter, parameter.name)).join('、')}。`, 'sentence-message error')
        warning.dataset.sentenceMissingParameter = statement.id || ''
        warning.setAttribute('role', 'alert')
        panel.append(warning)
      }
      for (const name of Object.keys(statement.parameters || {}).filter(name => !parameters.some(parameter => parameter.name === name))) {
        panel.append(node('p', `未登记参数：${name}（已保留）`, 'sentence-invalid-field'))
      }
      // A code block is still authored through the typed data expression above,
      // but its executable body needs an author-facing module picker. Keep this
      // panel in the ordinary statement inspector so selecting a block module
      // exposes the same registry and typed controls used by the outer graph.
      if (!focusedSlot && descriptor.id === 'code-block.invoke') {
        panel.append(renderCodeBlockBodyEditor(statement, graph, path))
      }
      if (!focusedSlot && Array.isArray(descriptor.outputs) && descriptor.outputs.length) {
        panel.append(node('h4', '输出', 'sentence-inline-editor-section'))
        panel.append(node('p', descriptor.outputs.map(output => `${semanticSlotLabel(output, output.name)} · ${contextualTypeLabel(descriptorOutputType(descriptor, output.name, statement, input => outputValueType(core, editorGraph, input, path)), output, descriptor, output.name)}`).join('、'), 'sentence-inline-editor-output'))
      }
      if (focusedSlot) {
        const slots = [
          ...inputs.filter(isAuthorableInput).map(input => ({ kind: 'input', name: input.name, label: semanticSlotLabel(input, input.name) })),
          ...parameters.filter(isAuthorableParameter).map(parameter => ({ kind: 'parameter', name: parameter.name, label: semanticSlotLabel(parameter, parameter.name) })),
        ]
        const order = sentenceTemplate(descriptor, statement)?.meta?.slotOrder || []
        slots.sort((a, b) => {
          const aIndex = order.indexOf(a.name), bIndex = order.indexOf(b.name)
          return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex)
        })
        const currentIndex = slots.findIndex(slot => slot.kind === focusedSlot.slotKind && slot.name === focusedSlot.slotName)
        const next = slots[(currentIndex + 1) % Math.max(slots.length, 1)]
        if (next && slots.length > 1) {
          const advance = action(`下一项：${next.label}`, () => {
            const returnPopover = openPopover?.returnPopover || openPopover
            openPopover = { control: 'slot', statementId: statement.id, slotKind: next.kind, slotName: next.name, scopePath: path, ...(returnPopover ? { returnPopover } : {}) }
            render()
          }, 'sentence-next-slot')
          advance.dataset.sentenceNextSlot = `${statement.id}:${next.kind}:${next.name}`
          panel.append(advance)
        }
      }
      if (openPopover?.control === 'expression' && !openPopover.directExpression && openPopover.statementId === statement.id) {
        const definition = descriptorInputDefinition(descriptor, inputs.find(input => input.name === openPopover.inputName), statement)
        if (definition) panel.append(renderExpressionChooser(statement, editorGraph, definition, path))
      }
      return panel
    }

    function slotToken(text, statementId, slotKind, slotName, path = scopePath, label = '', tokenOptions = {}) {
      const button = action(text, () => {
        // Some typed templates intentionally fold a default reference into
        // prose.  The first click must materialize that reference before the
        // focused editor is opened, otherwise the author sees a label that
        // cannot be edited and the graph keeps relying on an implicit
        // compiler fallback.
        if (typeof tokenOptions.beforeOpen === 'function') {
          try { tokenOptions.beforeOpen() }
          catch (error) {
            report(error?.message || String(error), 'error')
            return
          }
        }
        openPopover = {
          control: 'slot', statementId, slotKind, slotName, scopePath: path,
          ...(tokenOptions.returnPopover ? { returnPopover: tokenOptions.returnPopover } : {}),
        }
        render()
      }, 'sentence-inline-token sentence-slot-token')
      button.dataset.sentenceSlotEditor = `${statementId || ''}:${slotKind}:${slotName || ''}`
      button.dataset.sentenceSlotKind = slotKind
      button.dataset.sentenceSlotName = slotName || ''
      if (tokenOptions.autoCurrentCluster) button.dataset.sentenceAutoCurrentCluster = 'true'
      if (tokenOptions.autoUnattributed) button.dataset.sentenceAutoUnattributed = 'true'
      if (tokenOptions.referenceMissing) {
        button.dataset.sentenceReferenceMissing = 'true'
        if (tokenOptions.referenceId) button.dataset.sentenceReferenceId = String(tokenOptions.referenceId)
      }
      const selected = ['slot', 'expression'].includes(openPopover?.control)
        && openPopover?.statementId === statementId
        && openPopover?.slotKind === slotKind
        && openPopover?.slotName === slotName
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-pressed', selected ? 'true' : 'false')
      const displayLabel = label || semanticSlotLabel(null, slotName)
      button.title = tokenOptions.referenceMissing
        ? `未找到引用${tokenOptions.referenceId ? `（已保存标识：${tokenOptions.referenceId}）` : ''}；编辑${displayLabel}`
        : tokenOptions.pending
          ? `前置选择未完成，原值已保留；编辑${displayLabel}`
          : `编辑${displayLabel || (slotKind === 'parameter' ? '参数' : '输入')}`
      if (tokenOptions.pending) {
        button.classList.add('sentence-pending-slot', 'sentence-invalid-token')
        button.setAttribute('aria-invalid', 'true')
      }
      return button
    }

    function genericTemplate(descriptor, statement) {
      const fragments = [{ text: `执行“${semanticModuleLabel(statement.module, descriptor?.label)}”` }]
      for (const parameter of Array.isArray(descriptor?.parameters) ? descriptor.parameters : []) {
        if (!own(statement.parameters || {}, parameter.name) && parameter.optional) continue
        fragments.push({ text: `，${semanticSlotLabel(parameter, parameter.name)}为` }, { kind: 'parameter', name: parameter.name })
      }
      for (const input of Array.isArray(descriptor?.inputs) ? descriptor.inputs : []) {
        if (!own(statement.inputs || {}, input.name) && input.optional) continue
        fragments.push({ text: `，${semanticSlotLabel(input, input.name)}为` }, { kind: 'input', name: input.name })
      }
      return fragments
    }

    function parameterReferenceInfo(statement, name, value) {
      if (name !== 'skillId' || !['author.effect.damage', 'author.effect.heal'].includes(statement?.module)) return null
      let catalog = authorReferenceCatalog(options.catalog)
      if (typeof options.getCatalog === 'function') {
        try { catalog = authorReferenceCatalog(options.getCatalog() || catalog) } catch { /* retain the last catalog snapshot */ }
      }
      const info = authorReferenceValueInfo(value, 'skills', catalog)
      return info ? { ...info, collection: 'skills' } : null
    }

    function semanticParameterDisplay(name, value, definition, statement) {
      const reference = parameterReferenceInfo(statement, name, value)
      if (reference) return reference.missing ? '缺失的技能引用' : reference.text
      if (name === 'valueType') return typeLabel(serializedValueType(value, portValueType(definition)))
      if (name === 'sourceType' && ['piece', 'record'].includes(value)) return value === 'piece' ? '棋子来源' : '本次执行来源'
      if (name === 'mode' && ['new-instance', 'return-instance', 'declaration'].includes(value)) {
        return { 'new-instance': '新建棋子', 'return-instance': '原实例回场', declaration: '使用当前内容声明' }[value]
      }
      if (name === 'targetType') {
        if (value === 'piece') return '棋子目标'
        if (value === 'record') return '本次执行目标'
        try {
          const parsed = typeof value === 'string' && value.trimStart().startsWith('{') ? JSON.parse(value) : value
          if (parsed?.kind === 'list' && parsed.element === 'piece') return '棋子目标列表'
        } catch { /* keep the serialized type visible below */ }
      }
      if (name === 'flowStatePolicy' && ['cleanup', 'preserve'].includes(value)) return value === 'cleanup' ? '清理状态' : '保留状态'
      const movement = movementEnumDisplay(value, definition)
      if (movement) return movement
      if (name === 'kind' && (value === 'teleport' || value === 'summon')) return value === 'teleport' ? '传送' : '召唤'
      if (name === 'attribute' || name === 'field') return fieldLabels[value] || literalDisplay(value)
      const enumText = enumValueDisplay(value, { ...(definition || {}), name })
      if (enumText !== undefined) return enumText
      const labels = {
        currentDuration: '持续时间', duration: '持续时间', stacks: '层数', currentUses: '可用次数',
        maxUses: '最大使用次数', field: '字段', statusType: '状态类型', inputPolicy: '输入策略',
        resource: '资源', attribute: '属性', filter: '筛选条件', targetType: '目标类型',
        sourceType: '来源类型', templateType: '模板类型', displayType: '显示类型',
        destinationType: '目标地格类型', extensionType: '扩展字段类型', definitionType: '定义类型',
        blockType: '代码块类型', argsType: '参数类型', optionsType: '选项类型',
      }
      const label = labels[value]
      return label || literalDisplay(value)
    }

    function fragmentText(descriptor, statement, fragment, graph, path) {
      if (fragment?.text !== undefined) return String(fragment.text)
      const kind = fragment?.kind
      const name = fragment?.name
      const definition = kind === 'parameter'
        ? (Array.isArray(descriptor?.parameters) ? descriptor.parameters : []).find(item => item.name === name)
        : descriptorInputDefinition(descriptor, (Array.isArray(descriptor?.inputs) ? descriptor.inputs : []).find(item => item.name === name), statement)
      if (fragment?.unattributedFallback) return { text: '不归因于能力组', kind, name, label: semanticSlotLabel(definition, name) }
      let value = kind === 'parameter' ? statement.parameters?.[name] : statement.inputs?.[name]
      if (value === undefined && !descriptor) {
        if (name?.startsWith?.('field:')) value = statement.fields?.[name.slice('field:'.length)]
        else if (name?.startsWith?.('return:')) value = statement.values?.[name.slice('return:'.length)]
        else if (own(statement, name)) value = statement[name]
      }
      if ((value === undefined || value === null || value === '') && own(definition, 'default')) value = definition.default
      const semanticLabel = semanticSlotLabel(definition, name)
      const empty = fragment?.empty || semanticLabel || '待填写'
      if (value === undefined || value === null || value === '') return { text: empty, kind, name, label: semanticLabel }
      const reference = kind === 'parameter' ? parameterReferenceInfo(statement, name, value) : null
      const display = kind === 'parameter'
        ? (statement?.kind === 'record.create' && name === 'schema' ? recordCreateDisplayLabel(statement, graph, path) : semanticParameterDisplay(name, value, definition, statement))
        : record(value) ? projectionValueLabel(statement, fragment, value, graph, path) : contextualLiteralDisplay(statement, value, graph, path)
      return {
        text: display || empty,
        kind,
        name,
        label: semanticLabel,
        ...(reference?.missing ? { referenceMissing: true, referenceId: reference.raw } : {}),
      }
    }

    function sentenceFragmentAvailability(descriptor, statement, fragment) {
      if (!descriptor || !fragment || (fragment.kind !== 'input' && fragment.kind !== 'parameter') || !fragment.name) return null
      if (fragment.autoCurrentCluster || fragment.unattributedFallback) return true
      const definition = fragment.kind === 'input'
        ? (Array.isArray(descriptor.inputs) ? descriptor.inputs : []).find(item => item.name === fragment.name)
        : (Array.isArray(descriptor.parameters) ? descriptor.parameters : []).find(item => item.name === fragment.name)
      return sentenceSlotAvailable(descriptor, statement, fragment.kind, fragment.name, { allowUnsetOptional: Boolean(definition?.optional) })
    }

    function authoredFragmentValue(statement, fragment) {
      if (!fragment?.name) return false
      if (fragment.kind === 'input') return own(statement?.inputs, fragment.name)
      if (fragment.kind === 'parameter') return own(statement?.parameters, fragment.name)
      return false
    }

    function recordCreateDisplayLabel(statement, graph, path = scopePath) {
      const reference = String(statement?.schema || '')
      const schema = schemaForGraph(schemaGraphForScope(graph, path), reference)
      const usedByChoice = choiceRecordValueInfo(graph, path).recordIds.has(statement?.id)
      if (usedByChoice) return '选项内容'
      return schema ? schemaDisplayLabel(schema) : '记录内容'
    }

    function choiceRecordValueInfo(graph, path = scopePath) {
      const labels = new Map()
      const recordIds = new Set()
      const frames = Array.isArray(path) ? path : []
      const statements = []
      const seen = new Set()
      for (let depth = frames.length; depth >= 0; depth -= 1) {
        const scoped = scopeDefinition(graph, frames.slice(0, depth))
        for (const statement of nestedStatements(scoped.body)) {
          if (seen.has(statement)) continue
          seen.add(statement)
          statements.push(statement)
        }
      }
      const choices = statements.filter(candidate => candidate?.kind === 'call'
        && candidate.module === 'author.choice.option'
        && candidate.inputs?.options?.kind === 'output')
      for (const candidate of statements) {
        if (candidate?.kind !== 'record.create' || !choices.some(choice => choice.inputs.options.node === candidate.id)) continue
        recordIds.add(candidate.id)
        const schema = schemaForGraph(schemaGraphForScope(graph, path), candidate.schema)
        for (const field of Array.isArray(schema?.fields) ? schema.fields : []) {
          const value = candidate.fields?.[field.name]
          if (value?.kind !== 'literal' || typeof value.value !== 'string') continue
          labels.set(value.value, fieldDisplayLabel(field))
        }
      }
      return { labels, recordIds }
    }

    function contextualLiteralDisplay(statement, value, graph, path = scopePath) {
      if (!record(value) || value.kind !== 'literal') return literalDisplay(value)
      const raw = literalDisplay(value.value)
      if (typeof value.value !== 'string') return raw
      const isChoiceConsumer = Object.values(statement?.inputs || {}).some(input => input?.kind === 'output'
        && statementForLexicalId(graph, input.node, path)?.module === 'author.choice.option')
      if (!isChoiceConsumer) return raw
      return choiceRecordValueInfo(graph, path).labels.get(value.value) || raw
    }

    function recordFieldReferenceInfo(statement, fieldName, value, graph, path = scopePath) {
      if (!record(value) || value.kind !== 'literal') return null
      const schemaRef = statement?.kind === 'record.create'
        ? statement.schema
        : recordSchemaType(core, graph, statement?.record, new Set(), path)?.schema
      const schema = schemaForGraph(graphWithAuthorSchemas(core, schemaGraphForScope(graph, path)), schemaRef)
      const definition = (Array.isArray(schema?.fields) ? schema.fields : []).find(field => field?.name === fieldName)
      const reference = authorContentReference(definition, fieldName, { schema: schemaRef, type: definition?.type })
      if (!reference?.collection) return null
      let catalog = options.catalog
      if (typeof options.getCatalog === 'function') {
        try { catalog = options.getCatalog() || catalog } catch { /* retain the last catalog snapshot */ }
      }
      const info = authorReferenceValueInfo(value.value, reference.collection, authorReferenceCatalog(catalog))
      return info ? { ...info, collection: reference.collection } : null
    }

    function recordFieldValueLabel(statement, value, graph, path = scopePath, fieldName = '') {
      const raw = valueLabel(core, graph, value, path)
      if (!record(value) || value.kind !== 'literal') return raw
      const reference = recordFieldReferenceInfo(statement, fieldName, value, graph, path)
      if (reference) return reference.text
      if (typeof value.value !== 'string') return raw
      const info = choiceRecordValueInfo(graph, path)
      return info.recordIds.has(statement?.id) ? (info.labels.get(value.value) || raw) : raw
    }

    function sentenceTextProjection(descriptor, text) {
      const value = String(text || '')
      if (descriptor?.id === 'ref.holder' && value === '引用当前持有者') return '当前棋子'
      return value
        .replaceAll('请在高级视图中检查', '请打开这一行的更多操作查看保留字段')
        .replaceAll('允许取消', '允许中止本次效果')
        .replaceAll('取消后继续', '中止后继续流程')
    }

    function projectionValueLabel(statement, fragment, value, graph, path = scopePath) {
      if (statement?.module === 'author.choice.option' && fragment?.kind === 'input' && fragment.name === 'options') return '选项内容'
      if (statement?.kind === 'record.create' && fragment?.kind === 'parameter' && fragment.name === 'schema') return recordCreateDisplayLabel(statement, graph, path)
      return valueLabel(core, graph, value, path)
    }

    function typedDamageClusterFallback(descriptor, statement, graph, fragment) {
      if (descriptor?.id !== 'author.effect.damage' || String(statement?.version || descriptor?.version) !== '3') return null
      if (own(statement?.inputs, 'abilityGroup')) return null
      const text = typeof fragment === 'string' ? fragment : fragment?.text
      if (fragment?.kind === 'input' && fragment.name === 'abilityGroup') {
        const inputFragment = { ...fragment }
        delete inputFragment.text
        if (graph?.surface === 'skill') return { ...inputFragment, empty: '当前能力组', autoCurrentCluster: true }
        if (['rule', 'triggerSkill', 'pending'].includes(String(graph?.surface))) {
          return { kind: 'parameter', name: 'attribution', empty: '不归因于能力组', unattributedFallback: true }
        }
        return '不归因于能力组'
      }
      if (fragment?.kind === 'parameter' && fragment.name === 'attribution') {
        const parameterFragment = { ...fragment }
        delete parameterFragment.text
        return { ...parameterFragment, empty: '不归因于能力组', unattributedFallback: true }
      }
      if (text === '不归因于能力组') {
        // Rule/trigger flows can opt back into the current cluster. Cards do
        // not have a current-cluster execution context, so keep their honest
        // default as prose until the author provides a supported input.
        if (['rule', 'triggerSkill', 'pending'].includes(String(graph?.surface))) {
          return { kind: 'parameter', name: 'attribution', empty: '不归因于能力组', unattributedFallback: true }
        }
        return '不归因于能力组'
      }
      if (text !== '当前能力组') return null
      // The skill surface has a meaningful current cluster at runtime. Keep
      // that default authorable by projecting it as a synthetic slot until
      // the first click creates the explicit ref.current-cluster call.
      if (graph?.surface === 'skill') return { kind: 'input', name: 'abilityGroup', empty: '当前能力组', autoCurrentCluster: true }
      // Core lowering treats a missing group on cards/rules as unattributed,
      // even if an old graph retained the serialized `current` policy. Do not
      // present the stale policy as a fake current-cluster reference.
      if (['rule', 'triggerSkill', 'pending'].includes(String(graph?.surface))) {
        return { kind: 'parameter', name: 'attribution', empty: '不归因于能力组', unattributedFallback: true }
      }
      return '不归因于能力组'
    }

    function ensureTypedDamageCurrentCluster(statement, descriptor, graph, path) {
      if (descriptor?.id !== 'author.effect.damage' || String(statement?.version || descriptor?.version) !== '3') return
      if (!['skill', 'rule', 'triggerSkill', 'pending'].includes(String(graph?.surface)) || own(statement?.inputs, 'abilityGroup')) return
      const expectedType = descriptorInputType(descriptor, 'abilityGroup', statement)
      if (!expectedType) throw new Error('当前能力组输入类型未注册，无法创建默认引用。')
      // A newly inserted damage row can still be incomplete. The graph
      // compiler may return a save diagnostic for that partial state while
      // preserving the editor draft; keep the real reference and let the
      // focused input editor repair the remaining required values.
      createPureExpression(options, statement.id, 'abilityGroup', expectedType, 'ref.current-cluster', '1', path)
    }

    function appendSentenceTemplate(expression, descriptor, statement, graph, path, suppliedFragments = null) {
      const supplied = suppliedFragments || sentenceTemplate(descriptor, statement, {
        graph,
        path,
        valueLabel: value => valueLabel(core, graph, value, path),
        literalDisplay,
      })
      const rawFragments = supplied || genericTemplate(descriptor, statement)
      const fragments = []
      for (const fragment of rawFragments) {
        const fallback = typedDamageClusterFallback(descriptor, statement, graph, fragment)
        if (fallback !== null) fragments.push(fallback)
        else fragments.push(fragment)
      }
      expression.dataset.sentenceTemplate = statement.module || ''
      for (const fragment of fragments) {
        if (typeof fragment === 'string' || fragment?.text !== undefined) {
          expression.append(node('span', sentenceTextProjection(descriptor, typeof fragment === 'string' ? fragment : fragment.text), 'sentence-template-text'))
          continue
        }
        const availability = sentenceFragmentAvailability(descriptor, statement, fragment)
        // A later slot must not appear before its prerequisite.  If an old
        // graph already authored that slot, keep it in the sentence and mark
        // it for repair so changing a prerequisite never discards data.
        if (availability === false && !authoredFragmentValue(statement, fragment)) continue
        const resolved = fragmentText(descriptor, statement, fragment, graph, path)
        if (resolved.kind && resolved.name) {
          expression.append(slotToken(resolved.text, statement.id, resolved.kind, resolved.name, path, semanticSlotLabel(resolved, resolved.name), {
            pending: availability === false,
            referenceMissing: resolved.referenceMissing,
            referenceId: resolved.referenceId,
            ...(fragment.autoCurrentCluster ? {
              autoCurrentCluster: true,
              beforeOpen: () => ensureTypedDamageCurrentCluster(statement, descriptor, graph, path),
            } : {}),
            ...(fragment.unattributedFallback ? { autoUnattributed: true } : {}),
          }))
        } else expression.append(node('span', resolved.text || '待填写', 'sentence-template-text'))
      }
    }

    function rowActions(statement, path = scopePath) {
      const menu = node('details', undefined, 'sentence-row-menu')
      menu.dataset.sentenceRowMenu = statement?.id || ''
      const summary = node('summary', '更多操作')
      summary.setAttribute('aria-label', '更多操作')
      menu.append(summary)
      const actions = node('span', undefined, 'sentence-row-actions')
      actions.dataset.sentenceRowActions = statement?.id || ''
      if (statement?.kind && statement.kind !== 'call') {
        const edit = action('编辑结构', () => { openPopover = { control: 'statement', statementId: statement.id, scopePath: path }; render() }, 'sentence-row-action sentence-row-action-edit')
        edit.dataset.sentenceStructuredEditor = statement.id || ''
        edit.dataset.sentenceRowAction = 'edit'
        edit.title = '编辑此结构语句的全部字段'
        actions.append(edit)
      } else if (statement?.kind === 'call') {
        const edit = action('编辑模块', () => { openPopover = { control: 'statement', statementId: statement.id, scopePath: path }; render() }, 'sentence-row-action sentence-row-action-edit')
        edit.dataset.sentenceModuleEditor = statement.id || ''
        edit.dataset.sentenceRowAction = 'edit'
        edit.title = '编辑此模块和参数'
        actions.append(edit)
      }
      for (const [operation, label, title] of [['up', '↑', '上移'], ['down', '↓', '下移'], ['duplicate', '复制', '复制此行'], ['delete', '删除', '删除此行']]) {
        const button = action(label, () => {
          try { changeStatementRow(options, statement.id, operation, path); report(`${title}完成。`, 'success') }
          catch (error) { report(error.message || String(error), 'error') }
        }, `sentence-row-action sentence-row-action-${operation}`)
        button.dataset.sentenceRowAction = operation
        button.title = title
        actions.append(button)
      }
      actions.hidden = true
      const syncMenuActions = () => { actions.hidden = !menu.open }
      menu.addEventListener('toggle', syncMenuActions)
      summary.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.code !== 'Space') return
        event.preventDefault()
        menu.open = !menu.open
        syncMenuActions()
      })
      menu.append(actions)
      const graph = graphFor(core, options.getDraft?.() || {}, options.field || primaryField)
      const descriptor = statement?.kind === 'call' ? descriptorForCurrent(graph, statement, path) : null
      const technical = node('details', undefined, 'sentence-row-details')
      const technicalSummary = node('summary', '查看技术信息')
      technicalSummary.setAttribute('aria-label', '查看技术信息')
      technical.append(technicalSummary)
      const technicalBody = node('div', undefined, 'sentence-technical-details')
      if (statement?.kind === 'call' && own(statement.inputs || {}, 'amount')) {
        const amountText = node('p', undefined, 'sentence-inline-editor-output')
        amountText.append(node('span', '伤害量：', 'sentence-field-label'))
        amountText.append(slotToken(valueLabel(core, graph, statement.inputs.amount, path), statement.id, 'input', 'amount', path, '伤害量'))
        technicalBody.append(amountText)
      }
      if (descriptor?.description || descriptor?.uiDescription) technicalBody.append(node('p', descriptor.uiDescription || descriptor.description, 'sentence-row-description'))
      if (Array.isArray(descriptor?.outputs) && descriptor.outputs.length) {
        const outputText = node('p', undefined, 'sentence-inline-editor-output')
        outputText.append(node('span', '可用结果：', 'sentence-field-label'))
        descriptor.outputs.forEach((output, index) => {
          if (index) outputText.append(node('span', '、'))
          const outputLabelText = semanticSlotLabel(output, output.name)
          const outputChip = node('span', outputLabelText, 'sentence-output-label')
          outputChip.dataset.sentenceOutputName = `${statement.id}:${output.name}`
          outputText.append(outputChip)
        })
        technicalBody.append(outputText)
      }
      if (statement?.kind === 'record.create' && statement.schema) {
        const visibleSchema = schemaForGraph(graphWithAuthorSchemas(core, schemaGraphForScope(graph, path)), statement.schema)
        technicalBody.append(node('p', `结构定义：${schemaDisplayLabel(visibleSchema)}`, 'sentence-inline-editor-output'))
      }
      if (technicalBody.childElementCount) {
        technicalBody.hidden = true
        technical.addEventListener('toggle', () => { technicalBody.hidden = !technical.open })
        technical.append(technicalBody)
        menu.append(technical)
      }
      return menu
    }

    function branchActions(statement, branch, label, path = scopePath) {
      const block = node('div', undefined, 'sentence-branch-actions')
      block.dataset.sentenceBranch = `${statement.id}:${branch}`
      block.append(node('span', label, 'sentence-branch-title'))
      const target = { parentId: statement.id, branch }
      const menu = node('details', undefined, 'sentence-branch-menu')
      const summary = node('summary', '添加步骤')
      summary.setAttribute('aria-label', `${label}：添加步骤`)
      menu.append(summary)
      const menuActions = node('div', undefined, 'sentence-branch-menu-actions')
      const add = action('＋ 添加语句', () => { openPopover = { control: 'module', category: 'all', query: '', insertInto: target }; render() }, 'sentence-branch-add')
      add.dataset.sentenceAddBranch = `${statement.id}:${branch}`
      menuActions.append(add)
      const condition = action('＋ 条件', () => {
        try { addCondition(options, target, path); report(`${label}已加入条件分支。`, 'success') }
        catch (error) { report(error.message || String(error), 'error') }
      }, 'sentence-branch-add sentence-branch-condition')
      condition.dataset.sentenceAddBranchCondition = `${statement.id}:${branch}`
      menuActions.append(condition)
      for (const kind of ['foreach', 'while', 'record.create', 'record.get', 'record.with', 'collection.map', 'collection.filter', 'collection.reduce', 'collection.find', 'defer-choice', 'return']) {
        const kindLabel = statementKindLabels[kind] || kind
        const structural = action(`＋ ${kindLabel}`, () => {
          try { const id = addStructuredStatement(options, kind, target, path); openPopover = { control: 'statement', statementId: id, scopePath: path }; report(`${label}已加入${kindLabel}。`, 'success') }
          catch (error) { report(error.message || String(error), 'error') }
        }, 'sentence-branch-add sentence-branch-structure')
        structural.dataset.sentenceAddStructured = `${statement.id}:${branch}:${kind}`
        menuActions.append(structural)
      }
      menu.append(menuActions)
      block.append(menu)
      return block
    }

    function appendStatementExpression(parent, statement, graph, editable = true, path = scopePath) {
      const row = node('li', undefined, 'sentence-generic-step sentence-generic-semantic-step sentence-expression-row')
      if (statement?.id) row.dataset.sentenceNode = statement.id
      if (statement?.kind) row.dataset.sentenceNodeKind = statement.kind
      const expressionMeta = statement?.layout?.sentenceExpression
      if (record(expressionMeta) && expressionMeta.owner && expressionMeta.input) {
        row.classList.add('sentence-expression-owned')
        row.dataset.sentenceExpressionOwner = String(expressionMeta.owner)
        row.dataset.sentenceExpressionInput = String(expressionMeta.input)
      }
      const expression = node('div', undefined, 'sentence-row-expression')
      const appendRecordFields = (fieldNames, suffix = '。') => {
        if (!fieldNames.length) return false
        expression.append(node('span', '，填写', 'sentence-template-text'))
        const fieldTrigger = action(`${fieldNames.length}个字段`, () => {
          openPopover = { control: 'record-fields', statementId: statement.id, scopePath: path }
          render()
        }, 'sentence-inline-token sentence-record-fields-token')
        fieldTrigger.dataset.sentenceRecordFields = statement.id || ''
        fieldTrigger.setAttribute('aria-pressed', openPopover?.control === 'record-fields' && openPopover.statementId === statement.id ? 'true' : 'false')
        fieldTrigger.classList.toggle('is-selected', openPopover?.control === 'record-fields' && openPopover.statementId === statement.id)
        fieldTrigger.title = '在右侧编辑记录字段'
        expression.append(fieldTrigger, node('span', suffix, 'sentence-template-text'))
        return true
      }
      const authorStatement = authorStatementMetadata(statement)
      const authorDraft = authorStatement
        ? authorStatementDrafts.get(authorStatementDraftKey(statement.id, path))
        : null
      const authorDisplay = authorStatement
        ? { ...authorStatement, ...(record(authorDraft) ? clone(authorDraft) : {}) }
        : null
      if (authorStatement) {
        row.dataset.sentenceAuthorStatement = statement.id || ''
        expression.dataset.sentenceModuleEditor = statement.id || ''
        expression.classList.toggle('is-selected', ['statement', 'slot', 'expression'].includes(openPopover?.control) && openPopover?.statementId === statement.id)
        expression.setAttribute('aria-pressed', String(expression.classList.contains('is-selected')))
        expression.setAttribute('role', 'button')
        expression.tabIndex = 0
        expression.title = authorDisplay.kind === 'extension-declaration' ? '编辑扩展变量声明' : '编辑赋值'
        expression.onclick = event => {
          if (event.target !== expression) return
          openPopover = { control: 'statement', statementId: statement.id, scopePath: path }
          render()
        }
        expression.onkeydown = event => {
          if ((event.key === 'Enter' || event.key === ' ') && event.target === expression) {
            event.preventDefault()
            openPopover = { control: 'statement', statementId: statement.id, scopePath: path }
            render()
          }
        }
        const authorToken = (text, field, label = text) => {
          const token = action(text || '未填写', () => {
            openPopover = { control: 'statement', statementId: statement.id, scopePath: path, authorField: field }
            render()
          }, 'sentence-inline-token sentence-author-token')
          token.dataset.sentenceAuthorField = field
          token.dataset.sentenceAuthorToken = `${statement.id}:${field}`
          token.title = `编辑${label}`
          return token
        }
        if (authorDisplay.kind === 'extension-declaration') {
          expression.append(
            node('span', '在', 'sentence-template-text'),
            authorToken(authorDisplay.ownerSource, 'ownerSource', '对象'),
            node('span', '的扩展中新建', 'sentence-template-text'),
            authorToken(typeLabel(authorDisplay.valueType || 'unknown'), 'valueType', '变量类型'),
            node('span', '变量', 'sentence-template-text'),
            authorToken(authorDisplay.name, 'name', '变量名称'),
            node('span', '＝', 'sentence-template-text'),
            authorToken(authorDisplay.initialSource, 'initialSource', '初始表达式'),
          )
        } else {
          expression.append(
            authorToken(authorDisplay.targetSource, 'targetSource', '目标字段/变量'),
            node('span', '＝', 'sentence-template-text'),
            authorToken(authorDisplay.valueSource, 'valueSource', '值表达式'),
          )
        }
      } else {
      const structuralTemplate = statement?.kind !== 'call' && !['record.create', 'record.with'].includes(statement?.kind) ? sentenceStatementTemplate(statement, { graph, path }) : null
      if (structuralTemplate) {
        appendSentenceTemplate(expression, null, statement, graph, path, structuralTemplate)
      } else if (statement?.kind === 'call') {
        const descriptor = descriptorForCurrent(graph, statement, path)
        // Keep the row itself as the stable module editing target so existing
        // integrations can still open a statement with its data attribute.
        // The visible sentence stays focused on authored language; module
        // actions and output metadata live in the row's technical menu.
        expression.dataset.sentenceModuleEditor = statement.id || ''
        const selected = ['statement', 'slot', 'expression'].includes(openPopover?.control) && openPopover?.statementId === statement.id
        expression.classList.toggle('is-selected', selected)
        expression.setAttribute('aria-pressed', selected ? 'true' : 'false')
        expression.setAttribute('role', 'button')
        expression.tabIndex = 0
        expression.title = descriptor
          ? `编辑${semanticModuleLabel(statement.module, descriptor.label)}`
          : '当前模块未注册；打开菜单修复此语句。'
        expression.onclick = event => {
          if (event.target !== expression) return
          openPopover = { control: 'statement', statementId: statement.id, scopePath: path }
          render()
        }
        expression.onkeydown = event => {
          if ((event.key === 'Enter' || event.key === ' ') && event.target === expression) {
            event.preventDefault()
            openPopover = { control: 'statement', statementId: statement.id, scopePath: path }
            render()
          }
        }
        if (expressionMeta) {
          expression.append(node('span', '表达式', 'sentence-expression-owned-label'))
          expression.append(node('span', `由${semanticModuleLabel(statement.module, descriptor?.label)}生成`, 'sentence-template-text'))
        } else appendSentenceTemplate(expression, descriptor, statement, graph, path)
      } else if (statement?.kind === 'if') {
        expression.append(node('span', '如果', 'sentence-template-text'), slotToken(valueLabel(core, graph, statement.condition, path), statement.id, 'input', 'condition', path, '条件'), node('span', '成立，则执行以下步骤。', 'sentence-template-text'))
      } else if (statement?.kind === 'foreach') {
        expression.append(node('span', '对', 'sentence-template-text'), slotToken(valueLabel(core, graph, statement.items, path), statement.id, 'input', 'items', path, '集合'), node('span', '中的每一项执行以下步骤。', 'sentence-template-text'))
      } else if (statement?.kind === 'collection' || statement?.kind?.startsWith?.('collection.')) {
        const method = statement.method === 'filter' ? '筛选' : statement.method === 'reduce' ? '汇总' : statement.method === 'find' ? '查找第一项' : '映射'
        expression.append(node('span', '对', 'sentence-template-text'), slotToken(valueLabel(core, graph, statement.items, path), statement.id, 'input', 'items', path, '集合'), node('span', `执行${method}，再继续后续步骤。`, 'sentence-template-text'))
      } else if (statement?.kind === 'record.create') {
        expression.append(node('span', '创建一条', 'sentence-template-text'), slotToken(recordCreateDisplayLabel(statement, graph, path), statement.id, 'property', 'schema', path, '结构定义'), node('span', '记录', 'sentence-template-text'))
        appendRecordFields(recordFieldProjection(statement, graph, path).fieldNames)
      } else if (statement?.kind === 'record.with') {
        expression.append(node('span', '更新', 'sentence-template-text'), slotToken(valueLabel(core, graph, statement.record, path), statement.id, 'input', 'record', path, '记录'))
        if (!appendRecordFields(recordFieldProjection(statement, graph, path).fieldNames, '后继续。')) {
          expression.append(node('span', '中的字段后继续。', 'sentence-template-text'))
        }
      } else if (statement?.kind === 'record.get') {
        expression.append(node('span', '读取', 'sentence-template-text'), slotToken(valueLabel(core, graph, statement.record, path), statement.id, 'input', 'record', path, '记录'), node('span', '的字段', 'sentence-template-text'), slotToken(statement.field || '字段名', statement.id, 'property', 'field', path, '字段名'), node('span', '。', 'sentence-template-text'))
      } else if (statement?.kind === 'while') {
        expression.append(node('span', '在最多', 'sentence-template-text'), slotToken(formatNumber(statement.budget), statement.id, 'property', 'budget', path, '循环上限'), node('span', '次内重复执行以下步骤。', 'sentence-template-text'))
      } else if (statement?.kind === 'defer-choice') {
        expression.append(node('span', '等待玩家选择，提示为', 'sentence-template-text'), slotToken(valueLabel(core, graph, statement.title, path), statement.id, 'input', 'title', path, '提示'), node('span', '。', 'sentence-template-text'))
      } else if (statement?.kind === 'return') {
        expression.append(node('span', '返回结果', 'sentence-template-text'))
        const outputs = Object.keys(statement.values || {})
        for (const name of outputs) {
          expression.append(node('span', `，${semanticSlotLabel(null, name)}为`, 'sentence-template-text'), slotToken(valueLabel(core, graph, statement.values[name], path), statement.id, 'input', `return:${name}`, path, semanticSlotLabel(null, name)))
        }
      } else {
        expression.append(node('strong', statementKindLabels[statement?.kind] || '结构化步骤', 'sentence-row-label'))
      }
      }
      row.append(expression)
      if (editable && !authorStatement && ['call', 'record.create', 'record.get', 'record.with'].includes(statement.kind) && statement.module !== 'local.declare') {
        const descriptor = statement.kind === 'call' ? descriptorForCurrent(graph, statement, path)
          : { outputs: [{ name: 'value', label: statement.kind === 'record.get' ? '字段值' : '记录' }] }
        const outputs = (descriptor?.outputs || []).filter(output => output.name !== 'success' || descriptor.outputs.length === 1)
        const invalidBindings = invalidResultBindingEntries(core, graph, statement, path)
        if (outputs.length || invalidBindings.length) {
          const results = node('div', undefined, 'sentence-result-names')
          results.append(node('span', '返回值绑定', 'sentence-result-heading'))
          for (const output of outputs) {
            const outputReference = { kind: 'output', node: statement.id, port: output.name }
            const graphOutputType = outputValueType(core, graph, outputReference, path)
            const outputType = statement.kind === 'record.create'
              ? { kind: 'record', schema: statement.schema }
              : statement.kind === 'record.get'
                ? (recordFieldType(core, graph, statement.record, statement.field, path) || 'unknown')
                : statement.kind === 'record.with'
                  ? (recordSchemaType(core, graph, statement.record, new Set(), path) || 'unknown')
                  : graphOutputType || descriptorOutputType(descriptor, output.name, statement, input => outputValueType(core, graph, input, path))
            const encodedType = typeof outputType === 'string' ? outputType : JSON.stringify(outputType)
            const typeKnown = knownResultType(outputType)
            const storedBinding = statement.layout?.resultVariables?.[output.name]
            const binding = typeof storedBinding === 'string'
              ? { name: storedBinding }
              : record(storedBinding) ? storedBinding : null
            const producerLocation = statementLocation(graph, statement.id, path)
            const linkedDeclaration = binding?.declarationId
              ? statementLocation(graph, binding.declarationId, path)?.statement
              : null
            const adjacentDeclaration = producerLocation?.statements?.[producerLocation.index + 1]
            const declarationCandidate = [linkedDeclaration, adjacentDeclaration]
              .filter(item => item?.module === 'local.declare')
              .find(item => item.inputs?.initial?.kind === 'output'
                && item.inputs.initial.node === statement.id
                && item.inputs.initial.port === output.name)
            const declarationForBinding = declarationCandidate
              && resultBindingDeclaration(core, graph, declarationCandidate, path)?.producer?.id === statement.id
              ? declarationCandidate
              : null
            const bindingName = declarationForBinding?.parameters?.name
              || (binding && !binding.declarationId ? binding.name : '')
            const draftKey = resultVariableDraftKey(statement.id, output.name, path)
            // A bound result is a read-only view here. Any stale editor draft
            // must not make opening that view count as an unapplied edit.
            const existingDraft = declarationForBinding ? null : resultVariableDrafts.get(draftKey)
            const draftName = typeof existingDraft?.name === 'string' ? existingDraft.name : bindingName
            const card = node('div', undefined, 'sentence-result-binding')
            const header = node('div', undefined, 'sentence-result-binding-header')
            const outputText = node('span', `${outputLabel(descriptor, output.name)} · ${contextualTypeLabel(outputType, output, descriptor, output.name)}`, 'sentence-result-binding-label')
            if (bindingName) header.append(node('span', `将${outputLabel(descriptor, output.name)}存入${bindingName}`, 'sentence-result-binding-summary'))
            const openButton = action(declarationForBinding ? `查看变量（${bindingName}）` : bindingName ? `保存返回值（${bindingName}）` : '保存返回值', null, 'sentence-result-save')
            openButton.dataset.sentenceSaveResult = `${statement.id}:${output.name}`
            openButton.title = typeKnown ? '把这个返回值保存为同一流程中的局部变量' : '返回值类型暂不可推导，暂不能创建局部变量'
            header.append(outputText, openButton)
            const editor = node('div', undefined, 'sentence-result-editor')
            editor.dataset.sentenceResultVariableEditor = `${statement.id}:${output.name}`
            const editorOpen = existingDraft?.open === true
            editor.hidden = !editorOpen
            const typeText = node('span', `推导类型：${contextualTypeLabel(outputType, output, descriptor, output.name)}`, 'sentence-result-binding-type')
            const nameLabel = node('label', undefined, 'sentence-result-binding-field')
            nameLabel.append(node('span', '变量名', 'sentence-result-binding-field-label'))
            const input = node('input')
            input.type = 'text'
            input.placeholder = '例如：目标'
            input.value = draftName
            input.autocomplete = 'off'
            input.setAttribute('aria-label', `${outputLabel(descriptor, output.name)}局部变量名`)
            input.dataset.sentenceResultVariableName = `${statement.id}:${output.name}`
            input.disabled = !typeKnown
            input.readOnly = Boolean(declarationForBinding)
            if (declarationForBinding) input.title = '此返回值已绑定局部变量；请在局部变量行中编辑名称。'
            nameLabel.append(input)
            const editorActions = node('div', undefined, 'sentence-result-editor-actions')
            const applyButton = action(declarationForBinding ? '已绑定变量' : '新建变量并保存', null, 'sentence-result-apply')
            applyButton.dataset.sentenceResultVariableApply = `${statement.id}:${output.name}`
            applyButton.disabled = !typeKnown || Boolean(declarationForBinding)
            const cancelButton = action('取消', () => {
              clearResultVariableError(draftKey)
              if (resultVariableDrafts.delete(draftKey)) notifyEditorStateChange()
              editor.hidden = true
            }, 'sentence-result-cancel')
            editorActions.append(applyButton, cancelButton)
            editor.append(typeText, nameLabel)
            const draftError = resultVariableDraftErrors.get(draftKey)
            if (draftError) {
              const warning = node('small', draftError, 'sentence-result-binding-diagnostic sentence-result-variable-error')
              warning.dataset.sentenceResultVariableError = draftKey
              warning.setAttribute('role', 'alert')
              editor.append(warning)
            }
            if (!typeKnown) editor.append(node('small', '返回值类型暂不可推导，完善输入后再保存。', 'sentence-result-binding-diagnostic'))
            editor.append(editorActions)
            const rememberDraft = () => {
              resultVariableDrafts.set(draftKey, {
                name: input.value,
                valueType: encodedType,
                open: true,
              })
              notifyEditorStateChange()
            }
            input.addEventListener('compositionstart', () => composingControls.add(input))
            input.addEventListener('compositionupdate', () => composingControls.add(input))
            input.addEventListener('compositionend', () => {
              composingControls.add(input)
              setTimeout(() => {
                composingControls.delete(input)
                flushPendingRender()
              }, 0)
            })
            input.addEventListener('input', event => {
              clearResultVariableError(draftKey)
              rememberDraft()
              if (event.isComposing || event.inputType === 'insertCompositionText') composingControls.add(input)
            })
            input.addEventListener('keydown', event => {
              if (event.isComposing || event.keyCode === 229 || composingControls.has(input)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                applyButton.click()
              }
            })
            openButton.disabled = !typeKnown
            openButton.onclick = () => {
              if (!typeKnown) return
              if (declarationForBinding) {
                // Viewing an existing declaration never creates a draft. This
                // keeps save/training guards clear while the read-only panel
                // is open, including after a stale restored draft.
                const removedDraft = resultVariableDrafts.delete(draftKey)
                const removedError = clearResultVariableError(draftKey)
                const clearedResultMessage = clearResultVariableMessage()
                if (removedDraft || removedError || clearedResultMessage) notifyEditorStateChange()
                editor.hidden = !editor.hidden
                if (!editor.hidden) {
                  input.focus()
                  try { input.setSelectionRange(input.value.length, input.value.length) } catch { /* unsupported input selection */ }
                }
                return
              }
              const opening = editor.hidden
              if (opening) {
                const current = resultVariableDrafts.get(draftKey) || { name: input.value, valueType: encodedType }
                resultVariableDrafts.set(draftKey, { ...current, name: input.value, valueType: encodedType, open: true })
                notifyEditorStateChange()
                editor.hidden = false
                input.focus()
                try { input.setSelectionRange(input.value.length, input.value.length) } catch { /* unsupported input selection */ }
              } else {
                const current = resultVariableDrafts.get(draftKey)
                if (current) resultVariableDrafts.set(draftKey, { ...current, name: input.value, open: false })
                notifyEditorStateChange()
                editor.hidden = true
              }
            }
            applyButton.onclick = () => {
              const name = input.value.trim()
              if (!typeKnown) { reportResultVariableError(draftKey, '返回值类型暂不可推导，暂不能创建局部变量。'); return }
              if (!name) { reportResultVariableError(draftKey, '请填写变量名。'); return }
              if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) { reportResultVariableError(draftKey, '变量名须以文字或下划线开头。'); return }
              if (['当前棋子', '当前玩家', '当前手牌', '当前技能', '当前规则', '当前事件', '全局', '当前对局', '每项', 'true', 'false', 'null', '__proto__', 'prototype', 'constructor'].includes(name)) { reportResultVariableError(draftKey, '此名称已用于当前上下文，请换一个变量名。'); return }
              let committed = false
              const draftBeforeCommit = resultVariableDrafts.get(draftKey)
              resultVariableDrafts.delete(draftKey)
              const applied = mutateGraph(next => {
                const location = statementLocation(next, statement.id, path)
                if (!location?.statement || !Array.isArray(location.statements)) throw new Error('返回值所在语句在编辑过程中失效。')
                const activeBody = scopeDefinition(next, path).body || []
                const currentLink = location.statement.layout?.resultVariables?.[output.name]
                const linkedDeclaration = currentLink?.declarationId
                  ? statementLocation(next, currentLink.declarationId, path)
                  : null
                const adjacentCandidate = location.statements[location.index + 1]
                const adjacentDeclaration = adjacentCandidate?.module === 'local.declare'
                  && adjacentCandidate.inputs?.initial?.kind === 'output'
                  && adjacentCandidate.inputs.initial.node === statement.id
                  && adjacentCandidate.inputs.initial.port === output.name
                  ? { statement: adjacentCandidate }
                  : null
                const existingDeclaration = [linkedDeclaration, adjacentDeclaration].find(candidate => candidate?.statement?.module === 'local.declare'
                  && candidate.statement.inputs?.initial?.kind === 'output'
                  && candidate.statement.inputs.initial.node === statement.id
                  && candidate.statement.inputs.initial.port === output.name) || null
                const declarationId = existingDeclaration?.statement?.module === 'local.declare'
                  ? existingDeclaration.statement.id
                  : nextStatementId(next, `${statement.id}_${output.name}_result`)
                for (const item of nestedStatements(activeBody)) {
                  if (item.id === declarationId) continue
                  if (item.module === 'local.declare' && item.parameters?.name === name) throw new Error('此变量名已经使用')
                  if (Object.entries(item.layout?.resultNames || {}).some(([port, alias]) => alias === name && (item.id !== statement.id || port !== output.name))) throw new Error('此变量名已经使用')
                  const hasValidResultBinding = Object.entries(item.layout?.resultVariables || {}).some(([port, value]) => {
                    if (!record(value) || typeof value.declarationId !== 'string') return false
                    const declaration = statementLocation(next, value.declarationId, path)?.statement
                    return declaration?.module === 'local.declare'
                      && declaration.inputs?.initial?.kind === 'output'
                      && declaration.inputs.initial.node === item.id
                      && declaration.inputs.initial.port === port
                      && declaration.parameters?.name === name
                  })
                  if (hasValidResultBinding) throw new Error('此变量名已经使用')
                }
                const reference = { kind: 'output', node: statement.id, port: output.name }
                if (existingDeclaration?.statement?.module === 'local.declare') {
                  existingDeclaration.statement.parameters = { ...(existingDeclaration.statement.parameters || {}), name, valueType: encodedType }
                  existingDeclaration.statement.inputs = { ...(existingDeclaration.statement.inputs || {}), initial: clone(reference) }
                } else {
                  location.statements.splice(location.index + 1, 0, {
                    kind: 'call',
                    id: declarationId,
                    module: 'local.declare',
                    version: '2',
                    parameters: { name, valueType: encodedType },
                    inputs: { initial: clone(reference) },
                  })
                }
                location.statement.layout = {
                  ...(location.statement.layout || {}),
                  resultVariables: {
                    ...(location.statement.layout?.resultVariables || {}),
                    [output.name]: { name, declarationId, valueType: encodedType },
                  },
                }
                committed = true
              }, path, error => reportResultVariableError(draftKey, error))
              committed = committed && applied
              if (committed) {
                clearResultVariableError(draftKey)
                notifyEditorStateChange()
              }
              if (!committed && draftBeforeCommit) {
                resultVariableDrafts.set(draftKey, draftBeforeCommit)
                render()
              }
            }
            const legacyName = statement.layout?.resultNames?.[output.name]
            if (typeof legacyName === 'string' && legacyName.trim()) {
              const legacy = node('details', undefined, 'sentence-result-legacy')
              legacy.append(node('summary', '已保存结果'))
              const label = node('label', `${outputLabel(descriptor, output.name)} → `)
              const defaultName = `${statement.id}_${output.name}`.replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^(?=\d)/u, '_')
              const legacyInput = node('input'); legacyInput.type = 'text'; legacyInput.placeholder = '为此结果命名'
              legacyInput.value = legacyName
              legacyInput.setAttribute('aria-label', `${outputLabel(descriptor, output.name)}变量名`)
              legacyInput.addEventListener('change', () => {
                const nextLegacyName = legacyInput.value.trim(), previous = statement.layout?.resultNames?.[output.name] || defaultName
                if (!nextLegacyName) { report('请填写变量名。', 'error'); return }
                if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(nextLegacyName)) { report('变量名须以文字或下划线开头。', 'error'); return }
                if (['当前棋子', '当前玩家', '当前手牌', '当前技能', '当前规则', '当前事件', '全局', '当前对局', '每项', 'true', 'false', 'null', '__proto__', 'prototype', 'constructor'].includes(nextLegacyName)) { report('此名称已用于当前上下文，请换一个变量名。', 'error'); return }
                mutateGraph(next => {
                  for (const item of nestedStatements(next.body)) if (item.id !== statement.id && (Object.values(item.layout?.resultNames || {}).includes(nextLegacyName) || item.module === 'local.declare' && item.parameters?.name === nextLegacyName)) throw new Error('此变量名已经使用')
                  const location = statementLocation(next, statement.id, path)
                  location.statement.layout = { ...(location.statement.layout || {}), resultNames: { ...(location.statement.layout?.resultNames || {}), [output.name]: nextLegacyName } }
                  for (const item of nestedStatements(next.body)) for (const saved of Object.values(item.layout?.authorExpressions || {})) {
                    if (typeof saved.source !== 'string' || !core.parseAuthorExpression) continue
                    const replacements = []
                    const visit = ast => { if (!ast || typeof ast !== 'object') return; if (ast.kind === 'identifier' && ast.name === previous) replacements.push([ast.start, ast.end]); for (const value of Object.values(ast)) if (typeof value === 'object') { if (Array.isArray(value)) value.forEach(visit); else visit(value) } }
                    visit(core.parseAuthorExpression(saved.source))
                    for (const [start, end] of replacements.sort((a, b) => b[0] - a[0])) saved.source = saved.source.slice(0, start) + nextLegacyName + saved.source.slice(end)
                  }
                })
              })
              label.append(legacyInput); legacy.append(label)
              card.append(header, legacy, editor)
            } else card.append(header, editor)
            results.append(card)
          }
          for (const invalid of invalidBindings) {
            const diagnostic = node('small', `返回值绑定已失效（${invalid.port}）：${invalid.validation.reason}。请重新保存返回值。`, 'sentence-result-binding-diagnostic')
            diagnostic.dataset.sentenceResultBindingInvalid = `${statement.id}:${invalid.port}`
            results.append(diagnostic)
          }
          row.append(results)
        }
      }
      if (editable) {
        const actions = rowActions(statement, path)
        if (statement?.kind !== 'call') {
          const editStructure = actions.querySelector?.('[data-sentence-structured-editor]')
          if (editStructure) editStructure.dataset.sentenceStructureSettings = statement.id
        }
        row.append(actions)
      }
      return row
    }

    function collapsePanelId(statement, path) {
      const readable = `${scopePathKey(path)}-${statement?.id || 'nested'}`.replace(/[^a-zA-Z0-9_-]+/g, '-')
      collapsePanelSequence += 1
      return `sentence-nested-panel-${readable || collapsePanelSequence}-${collapsePanelSequence}`
    }

    function appendCollapseToggle(row, statement, path, panelId) {
      const key = collapseKey(activeDraft, options.field || primaryField, path, statement?.id)
      const collapsed = collapsedBlocks.get(key) === true
      const toggle = action(collapsed ? '展开步骤' : '收起步骤', () => {
        collapsedBlocks.set(key, !collapsed)
        pendingCollapseFocusKey = key
        render()
      }, 'sentence-collapse-toggle')
      toggle.dataset.sentenceCollapse = statement?.id || ''
      toggle.dataset.sentenceCollapseKey = key
      toggle.setAttribute('aria-expanded', String(!collapsed))
      toggle.setAttribute('aria-controls', panelId)
      toggle.setAttribute('aria-label', `${collapsed ? '展开' : '收起'} ${statementKindLabels[statement?.kind] || '嵌套步骤'}`)
      const expression = row.querySelector('.sentence-row-expression')
      expression?.append(toggle)
      return collapsed
    }

    function appendProjectedStatements(parent, statements, graph, depth = 0, path = scopePath) {
      const list = node('ol', undefined, 'sentence-generic-list sentence-generic-semantic-list sentence-expression-list')
      list.dataset.sentenceDepth = String(depth)
      const activeBody = scopeDefinition(graph, path).body || statements
      const authorGeneratedIds = new Set()
      for (const item of nestedStatements(activeBody)) {
        const metadata = authorStatementMetadata(item)
        for (const id of Array.isArray(metadata?.generatedIds) ? metadata.generatedIds : []) authorGeneratedIds.add(id)
      }
      for (const statement of Array.isArray(statements) ? statements : []) {
        if (authorGeneratedIds.has(statement?.id) && !authorStatementMetadata(statement)) continue
        if (resultBindingDeclaration(core, graph, statement, path)) continue
        if (statement?.layout?.authorExpression && statementForLexicalId(graph, statement.layout.authorExpression.owner, path)) continue
        // Legacy graphs carry no sentence-expression ownership metadata.  A
        // consumed pure call is still a value-producing implementation detail;
        // project it into its consumer's slot so the author sees one readable
        // expression.  Named outputs and explicit locals remain visible.
        if (isProjectedPureCall(core, graph, statement, path)) continue
        const isConsumedContextReference = statement?.kind === 'call'
          && ['ref.holder', 'ref.source', 'ref.target'].includes(statement.module)
          && graphUsesAnyOutput(graph, new Set([statement.id]), path)
        const expressionMeta = statement?.layout?.sentenceExpression
        if (statement?.kind === 'call' && record(expressionMeta) && expressionMeta.owner && expressionMeta.input) {
          const owner = statementForLexicalId(graph, expressionMeta.owner, path)
          const ownerValue = owner?.kind === 'call' ? owner.inputs?.[expressionMeta.input] : undefined
          const descriptor = descriptorForCurrent(graph, statement, path)
          const isLinkedPureExpression = ownerValue?.kind === 'output'
            && ownerValue.node === statement.id
            && pureDescriptor(descriptor)
          // Pure expressions created from a slot are shown inside that slot's
          // value editor. Keep the source statement reachable there while
          // avoiding a duplicate execution-looking row in the main sentence.
          if (isLinkedPureExpression) continue
        }
        // Context references are useful authoring values, but showing every
        // consumed holder/source/target as an execution-looking row makes a
        // sentence read like an implementation trace. Keep the row when it is
        // authored as a standalone step; project it into its consumer when it
        // has a real output reference. The graph and generic editor remain the
        // source of truth for either case.
        if (isConsumedContextReference) continue
        const structural = ['if', 'foreach', 'while', 'collection'].includes(statement?.kind) || statement?.kind?.startsWith?.('collection.')
        // Keep registered calls in the authoring list when they are authored
        // execution steps. Context and owned pure values are projected into
        // their consumer slots without changing the underlying graph.
        const visible = statement?.kind === 'call' || statement?.kind === 'defer-choice' || structural || Boolean(statement?.kind)
        if (!visible) continue
        const row = appendStatementExpression(list, statement, graph, true, path)
        if (structural) {
          const panelId = collapsePanelId(statement, path)
          const collapsed = appendCollapseToggle(row, statement, path, panelId)
          const nested = node('div', undefined, 'sentence-nested-block')
          nested.id = panelId
          nested.dataset.sentenceNestedBlock = statement.id || ''
          nested.hidden = collapsed
          for (const branch of ['then', 'else', 'body']) {
            if (!Array.isArray(statement?.[branch]) && !(branch === 'else' && statement?.kind === 'if')) continue
            const branchBlock = node('div', undefined, 'sentence-generic-branch')
            branchBlock.append(node('span', branch === 'body' ? '执行内容' : branchLabels[branch], 'sentence-generic-branch-label'))
            const childPath = [...path, { kind: 'branch', parentId: statement.id, branch }]
            branchBlock.append(appendProjectedStatements(branchBlock, statement[branch] || [], graph, depth + 1, childPath), branchActions(statement, branch, branch === 'body' ? '执行内容' : branchLabels[branch], path))
            nested.append(branchBlock)
          }
          if (statement?.kind === 'while' && Array.isArray(statement.condition?.body)) {
            const condition = node('div', undefined, 'sentence-generic-branch')
            condition.append(node('span', '循环条件', 'sentence-generic-branch-label'))
            const childPath = [...path, { kind: 'branch', parentId: statement.id, branch: 'condition.body' }]
            condition.append(appendProjectedStatements(condition, statement.condition.body, graph, depth + 1, childPath), branchActions(statement, 'condition.body', '循环条件', path))
            nested.append(condition)
          }
          if (statement?.kind === 'while' && !Array.isArray(statement.condition?.body)) {
            const condition = node('div', undefined, 'sentence-generic-branch')
            condition.append(node('span', '循环条件', 'sentence-generic-branch-label'), branchActions(statement, 'condition.body', '循环条件', path))
            nested.append(condition)
          }
          row.append(nested)
        }
        list.append(row)
      }
      return list
    }

    function mutateGraph(mutator, path = scopePath, onError = null) {
      try {
        const scrollSnapshot = captureScrollOffsets()
        const generation = renderGeneration
        applyGraphChange(options, mutator, undefined, path)
        // Some hosts synchronously refresh every mounted sentence editor from
        // onChange. Avoid rebuilding this editor a second time in the same
        // event; the duplicate pass can capture a freshly replaced inspector
        // before its layout has settled and reset its scroll position.
        if (renderGeneration === generation) render()
        // The synchronous host refresh can reparent this editor after render;
        // restore the user's position after that refresh has returned.
        restoreScrollOffsets(scrollSnapshot)
        return true
      }
      catch (error) {
        const text = error.message || String(error)
        if (typeof onError === 'function') onError(text)
        else report(text, 'error')
        return false
      }
    }

    function typeControl(current, onChange, graph, datasetName = 'sentenceType') {
      const wrapper = node('div', undefined, 'sentence-type-editor')
      if (datasetName) wrapper.dataset[datasetName] = ''
      const mode = document.createElement('select')
      mode.dataset.sentenceTypeKind = ''
      const modes = [
        ['number', '数值'], ['boolean', '布尔值'], ['string', '文本'], ['piece', '棋子'], ['player', '玩家'], ['cell', '地格'],
        ['path', '路径'], ['card', '卡牌'], ['content', '内容'], ['status', '状态'], ['event', '事件'], ['choice', '选择'], ['null', '空值'],
        ['list', '元组'], ['set', '集合'], ['map', '映射'], ['nullable', '可空'], ['record', '记录（通用）'], ['record-schema', '记录（结构定义）'],
      ]
      for (const [value, label] of modes) { const option = node('option', label); option.value = value; mode.append(option) }
      const currentMode = record(current) && current.kind === 'record'
        ? 'record-schema'
        : (record(current) ? current.kind : (typeof current === 'string' ? current : 'string'))
      mode.value = modes.some(item => item[0] === currentMode) ? currentMode : 'string'
      const nested = node('div', undefined, 'sentence-type-nested')
      const schemaValues = graphSchemas(graph).map(item => ({ value: `${item.id}@${item.version}`, label: schemaDisplayLabel(item) }))
      const renderNested = value => {
        nested.replaceChildren()
        if (value === 'list' || value === 'set' || value === 'nullable') {
          const child = record(current) ? (value === 'nullable' ? current.value : current.element) : 'string'
          nested.append(typeControl(child, next => onChange(value === 'nullable' ? { kind: 'nullable', value: next } : { kind: value, element: next }), graph, 'sentenceNestedType'))
        } else if (value === 'map') {
          const keyType = current?.kind === 'map' ? current.key : 'string'
          const valueType = current?.kind === 'map' ? current.value : 'number'
          nested.append(node('span', '键'), typeControl(keyType, next => onChange({ kind: 'map', key: next, value: valueType }), graph, 'sentenceMapKeyType'), node('span', '值'), typeControl(valueType, next => onChange({ kind: 'map', key: keyType, value: next }), graph, 'sentenceMapValueType'))
        } else if (value === 'record-schema') {
          const select = document.createElement('select'); select.dataset.sentenceRecordType = ''
          for (const item of schemaValues) { const option = node('option', item.label); option.value = item.value; select.append(option) }
          const selected = record(current) && current.kind === 'record' ? current.schema : ''
          if (selected && !schemaValues.some(item => item.value === selected)) { const option = node('option', '当前记录结构（已保存）'); option.value = selected; select.append(option) }
          select.value = selected || schemaValues[0]?.value || ''
          select.onchange = () => onChange({ kind: 'record', schema: select.value })
          nested.append(select)
        }
      }
      mode.onchange = () => {
        const value = mode.value
        if (value === 'list' || value === 'set') onChange({ kind: value, element: 'string' })
        else if (value === 'map') onChange({ kind: 'map', key: 'string', value: 'number' })
        else if (value === 'nullable') onChange({ kind: 'nullable', value: 'string' })
        else if (value === 'record-schema') onChange({ kind: 'record', schema: schemaValues[0]?.value || '' })
        else onChange(value)
        renderNested(value)
      }
      renderNested(mode.value)
      wrapper.append(mode, nested)
      return wrapper
    }

    function graphOwner(graph, path = scopePath) {
      return scopeDefinition(graph, path).graph || graph
    }

    function updateDeclarationId(graph, kind, oldId, oldVersion, nextId, nextVersion, path = scopePath) {
      const visit = statements => {
        for (const statement of Array.isArray(statements) ? statements : []) {
          if (kind === 'composite' && statement.kind === 'call' && statement.module === oldId && (!oldVersion || statement.version === oldVersion)) {
            statement.module = nextId; statement.version = nextVersion
          }
          if (kind === 'continuation' && statement.kind === 'defer-choice') {
            const oldReference = oldVersion ? `${oldId}@${oldVersion}` : oldId
            if (statement.graph === oldId || statement.graph === oldReference) statement.graph = statement.graph === oldReference ? `${nextId}@${nextVersion}` : nextId
          }
          visit(statement.then); visit(statement.else); visit(statement.body); visit(statement.condition?.body)
        }
      }
      // Declarations belong to the nearest graph scope. Branch frames do not
      // introduce a declaration namespace, so trim them before finding the
      // owner. This prevents a rename in one continuation from changing a
      // same-ID reference in a sibling graph.
      const frames = Array.isArray(path) ? path : []
      let declarationEnd = 0
      frames.forEach((frame, frameIndex) => { if (frame.kind === 'composite' || frame.kind === 'continuation') declarationEnd = frameIndex + 1 })
      const declarationPath = frames.slice(0, declarationEnd)
      const owner = scopeDefinition(graph, declarationPath).graph || graph
      visit(owner.body)
      // Composite bodies resolve declarations from their owning graph. When a
      // graph-level composite is renamed, update only that graph's composite
      // bodies as well; continuation graphs have independent declarations.
      if (kind === 'composite') for (const composite of Array.isArray(owner.composites) ? owner.composites : []) visit(composite.body)
    }

    function renderPortSection(parent, owner, graph, path, key, title) {
      const ports = Array.isArray(owner?.[key]) ? owner[key] : []
      const ownerFrame = [...(Array.isArray(path) ? path : [])].reverse().find(frame => frame.kind === 'composite' || frame.kind === 'continuation')
      const ownerIsGraph = !ownerFrame || ownerFrame.kind === 'continuation'
      const section = node('section', undefined, 'sentence-config-section sentence-port-section')
      section.dataset.sentencePorts = key
      const heading = node('div', undefined, 'sentence-config-heading')
      heading.append(node('h4', title, 'sentence-inline-editor-section'))
      const add = action(`＋ 添加${key === 'inputs' ? '输入项' : '返回值'}`, () => mutateGraph(graphValue => {
        const target = graphOwner(graphValue, path)
        if (!Array.isArray(target[key])) target[key] = []
        const used = new Set(target[key].map(item => item?.name))
        let index = 1; let name = `${key === 'inputs' ? 'input' : 'output'}${index}`
        while (used.has(name)) name = `${key === 'inputs' ? 'input' : 'output'}${++index}`
        target[key].push({ name, type: 'string', label: `${key === 'inputs' ? '输入' : '输出'} ${index}` })
        if (key === 'inputs' && ownerIsGraph) target.inputBindings = { ...(target.inputBindings || {}), [name]: '' }
      }, path), 'sentence-config-add')
      add.dataset.sentenceAddPort = key
      heading.append(add); section.append(heading)
      for (const [index, port] of ports.entries()) {
        const row = node('div', undefined, 'sentence-config-row sentence-port-row')
        row.dataset.sentencePort = `${key}:${port?.name || index}`
        const name = document.createElement('input'); name.type = 'text'; name.value = port?.name || ''; name.placeholder = 'name'; name.dataset.sentencePortName = ''
        name.onchange = () => mutateGraph(graphValue => {
          const target = graphOwner(graphValue, path); const next = target[key]?.[index]; if (!next) return
          const old = next.name; next.name = name.value.trim() || old
          if (key === 'inputs' && ownerIsGraph && old !== next.name) { const bindings = { ...(target.inputBindings || {}) }; if (own(bindings, old)) { bindings[next.name] = bindings[old]; delete bindings[old] } target.inputBindings = bindings }
        }, path)
        const type = typeControl(port?.type || 'string', value => mutateGraph(graphValue => { const next = graphOwner(graphValue, path)[key]?.[index]; if (next) next.type = value }, path), schemaGraphForScope(graph, path), 'sentencePortType')
        const optional = document.createElement('input'); optional.type = 'checkbox'; optional.checked = Boolean(port?.optional); optional.dataset.sentencePortOptional = ''
        optional.onchange = () => mutateGraph(graphValue => { const next = graphOwner(graphValue, path)[key]?.[index]; if (next) { if (optional.checked) next.optional = true; else delete next.optional } }, path)
        const nullable = document.createElement('input'); nullable.type = 'checkbox'; nullable.checked = Boolean(port?.nullable); nullable.dataset.sentencePortNullable = ''
        nullable.onchange = () => mutateGraph(graphValue => { const next = graphOwner(graphValue, path)[key]?.[index]; if (next) { if (nullable.checked) next.nullable = true; else delete next.nullable } }, path)
        const remove = action('删除', () => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); target[key] = (target[key] || []).filter((_item, itemIndex) => itemIndex !== index); if (key === 'inputs' && ownerIsGraph) { const bindings = { ...(target.inputBindings || {}) }; delete bindings[port.name]; target.inputBindings = bindings } }, path), 'sentence-config-remove')
        row.append(name, type, node('label', '可选', 'sentence-config-check'), optional, node('label', '可空', 'sentence-config-check'), nullable, remove)
        section.append(row)
        if (key === 'inputs' && ownerIsGraph) {
          const binding = node('label', undefined, 'sentence-config-binding')
          binding.append(node('span', `静态绑定 · ${port.name}`, 'sentence-field-label'))
          binding.append(literalControl(owner.inputBindings?.[port.name] ?? defaultForType(port), port, value => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); target.inputBindings = { ...(target.inputBindings || {}), [port.name]: value } }, path), false, {
            graph: schemaGraphForScope(graph, path),
            catalog: authorReferenceCatalog(options.catalog),
            getCatalog: typeof options.getCatalog === 'function' ? () => authorReferenceCatalog(options.getCatalog()) : undefined,
            referenceResolver: authorContentReference,
          }))
          section.append(binding)
        }
      }
      if (!ports.length) section.append(node('p', '尚未声明端口。', 'sentence-inline-editor-copy'))
      if (parent) parent.append(section)
      return section
    }

    function renderSchemaSection(parent, target, path, rootGraph = target) {
      const editable = path.length === 0 || path[path.length - 1]?.kind === 'continuation'
      const visible = schemaGraphForScope(rootGraph, path)
      const schemas = editable
        ? (Array.isArray(target?.schemas) ? target.schemas : [])
        : (Array.isArray(visible?.schemas) ? visible.schemas : [])
      const section = node('section', undefined, 'sentence-config-section sentence-schema-section')
      section.dataset.sentenceSchemas = ''
      const heading = node('div', undefined, 'sentence-config-heading')
      heading.append(node('h4', '结构定义', 'sentence-inline-editor-section'))
      if (editable) {
        const add = action('＋ 添加结构定义', () => mutateGraph(graphValue => {
          const target = graphOwner(graphValue, path); if (!Array.isArray(target.schemas)) target.schemas = []
          const used = new Set(target.schemas.map(item => item?.id)); let index = 1; while (used.has(`schema-${index}`)) index++
          target.schemas.unshift({ id: `schema-${index}`, version: 'v1', fields: [] })
        }, path), 'sentence-config-add'); add.dataset.sentenceAddSchema = ''; heading.append(add)
      } else heading.append(node('span', '组合模块沿用主流程的结构定义，请返回主流程编辑。', 'sentence-inline-editor-copy'))
      section.append(heading)
      for (const [index, schema] of schemas.entries()) {
        const builtin = authorSchemaForReference(core, `${schema.id}@${schema.version}`)
        if (builtin) {
          const card = node('details', undefined, 'sentence-schema-card')
          card.dataset.sentenceSchema = `${schema.id}@${schema.version}`
          card.append(node('summary', schemaDisplayLabel(schema), 'sentence-schema-summary'))
          card.append(node('p', '这是内置结构。创建对象时可逐项填写；这里用于查看字段含义。', 'sentence-inline-editor-copy'))
          for (const field of schema.fields || []) {
            const row = node('div', undefined, 'sentence-config-row sentence-schema-field')
            row.append(node('span', semanticSlotLabel(field, field.name)), node('span', typeLabel(field.type)), node('span', field.optional ? '可省略' : '必填'))
            card.append(row)
          }
          section.append(card)
          continue
        }
        const card = node('details', undefined, 'sentence-schema-card'); card.open = true; card.dataset.sentenceSchema = `${schema.id || index}@${schema.version || ''}`
        const summary = node('summary', `${schema.id || '未命名'}@${schema.version || ''}`, 'sentence-schema-summary'); card.append(summary)
        const identity = node('div', undefined, 'sentence-config-row')
        const id = document.createElement('input'); id.type = 'text'; id.value = schema.id || ''; id.dataset.sentenceSchemaId = ''; id.disabled = !editable
        const version = document.createElement('input'); version.type = 'text'; version.value = schema.version || ''; version.dataset.sentenceSchemaVersion = ''; version.disabled = !editable
        const rename = () => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); const next = target.schemas?.[index]; if (next) { next.id = id.value.trim() || next.id; next.version = version.value.trim() || next.version } }, path)
        id.onchange = rename; version.onchange = rename
        identity.append(node('span', '结构名称', 'sentence-field-label'), id, node('span', '版本', 'sentence-field-label'), version)
        if (editable) {
          const remove = action('删除结构定义', () => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); target.schemas = (target.schemas || []).filter((_item, itemIndex) => itemIndex !== index) }, path), 'sentence-config-remove'); identity.append(remove)
        }
        card.append(identity)
        const fields = Array.isArray(schema.fields) ? schema.fields : []
        for (const [fieldIndex, field] of fields.entries()) {
          const row = node('div', undefined, 'sentence-config-row sentence-schema-field')
          row.dataset.sentenceSchemaField = `${schema.id}:${field.name || fieldIndex}`
          const name = document.createElement('input'); name.type = 'text'; name.value = field.name || ''; name.placeholder = '字段名'; name.disabled = !editable
          name.onchange = () => mutateGraph(graphValue => { const next = graphOwner(graphValue, path).schemas?.[index]?.fields?.[fieldIndex]; if (next) next.name = name.value.trim() || next.name }, path)
          const type = typeControl(field.type || 'string', value => mutateGraph(graphValue => { const next = graphOwner(graphValue, path).schemas?.[index]?.fields?.[fieldIndex]; if (next) next.type = value }, path), schemaGraphForScope(rootGraph, path), 'sentenceSchemaFieldType')
          const nullable = document.createElement('input'); nullable.type = 'checkbox'; nullable.checked = Boolean(field.nullable); nullable.disabled = !editable; nullable.onchange = () => mutateGraph(graphValue => { const next = graphOwner(graphValue, path).schemas?.[index]?.fields?.[fieldIndex]; if (next) { if (nullable.checked) next.nullable = true; else delete next.nullable } }, path)
          if (!editable) type.querySelectorAll('input,select,button').forEach(control => { control.disabled = true })
          const removeField = editable ? action('删除字段', () => mutateGraph(graphValue => { const next = graphOwner(graphValue, path).schemas?.[index]; if (next) next.fields = (next.fields || []).filter((_item, itemIndex) => itemIndex !== fieldIndex) }, path), 'sentence-config-remove') : null
          row.append(name, type, node('label', '可空', 'sentence-config-check'), nullable); if (removeField) row.append(removeField); card.append(row)
        }
        if (editable) {
          const addField = action('＋ 添加字段', () => mutateGraph(graphValue => { const next = graphOwner(graphValue, path).schemas?.[index]; if (!next) return; if (!Array.isArray(next.fields)) next.fields = []; const used = new Set(next.fields.map(item => item?.name)); let fieldIndex = 1; while (used.has(`field${fieldIndex}`)) fieldIndex++; next.fields.push({ name: `field${fieldIndex}`, type: 'string' }) }, path), 'sentence-config-add'); addField.dataset.sentenceAddSchemaField = schema.id || ''; card.append(addField)
        }
        section.append(card)
      }
      if (!schemas.length) section.append(node('p', '尚未声明结构定义；记录编辑器会保留未知字段并显示诊断。', 'sentence-inline-editor-copy'))
      parent.append(section)
    }

    function renderDeclarations(parent, graph, path) {
      const owner = graphOwner(graph, path)
      const composites = Array.isArray(owner?.composites) ? owner.composites : []
      const continuations = Array.isArray(owner?.continuations) ? owner.continuations : []
      const section = node('section', undefined, 'sentence-config-section sentence-declaration-section')
      section.dataset.sentenceDeclarations = ''
      const heading = node('div', undefined, 'sentence-config-heading'); heading.append(node('h4', '组合与续接声明', 'sentence-inline-editor-section'))
      const addComposite = action('＋ 添加组合模块', () => mutateGraph(graphValue => {
        const target = graphOwner(graphValue, path); if (!Array.isArray(target.composites)) target.composites = []
        const used = new Set(target.composites.map(item => item?.id)); let index = 1; while (used.has(`composite-${index}`)) index++
        target.composites.push({ id: `composite-${index}`, version: 'v1', label: `组合模块 ${index}`, inputs: [], outputs: [], body: [], allowedSurfaces: [target.surface || graphValue.surface || 'skill'] })
      }, path), 'sentence-config-add'); addComposite.dataset.sentenceAddComposite = ''
      const addContinuation = action('＋ 添加续接流程', () => mutateGraph(graphValue => {
        const target = graphOwner(graphValue, path); if (!Array.isArray(target.continuations)) target.continuations = []
        const used = new Set(target.continuations.map(item => item?.id)); let index = 1; while (used.has(`continuation-${index}`)) index++
        const version = core?.GAMEPLAY_MODULE_GRAPH_VERSION || 'rvb-gameplay-modules/v1'
        target.continuations.push({ id: `continuation-${index}`, version: 'v1', graph: { version, surface: 'pending', inputs: [], inputBindings: {}, outputs: [], body: [], composites: [], schemas: [], hostBindings: {}, continuations: [] } })
      }, path), 'sentence-config-add'); addContinuation.dataset.sentenceAddContinuation = ''
      heading.append(addComposite, addContinuation); section.append(heading)
      for (const [index, composite] of composites.entries()) {
        const card = node('article', undefined, 'sentence-declaration-card'); card.dataset.sentenceComposite = `${composite.id || index}@${composite.version || ''}`
        const identity = node('div', undefined, 'sentence-config-row')
        const id = document.createElement('input'); id.type = 'text'; id.value = composite.id || ''; id.dataset.sentenceCompositeId = ''
        const version = document.createElement('input'); version.type = 'text'; version.value = composite.version || ''; version.dataset.sentenceCompositeVersion = ''
        const label = document.createElement('input'); label.type = 'text'; label.value = composite.label || ''; label.dataset.sentenceCompositeLabel = ''
        const saveIdentity = () => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); const next = target.composites?.[index]; if (!next) return; const oldId = next.id; const oldVersion = next.version; next.id = id.value.trim() || next.id; next.version = version.value.trim() || next.version; next.label = label.value.trim() || next.id; if (oldId !== next.id || oldVersion !== next.version) updateDeclarationId(graphValue, 'composite', oldId, oldVersion, next.id, next.version, path) }, path)
        id.onchange = saveIdentity; version.onchange = saveIdentity; label.onchange = saveIdentity
        identity.append(node('span', 'ID', 'sentence-field-label'), id, node('span', '版本', 'sentence-field-label'), version, node('span', '名称', 'sentence-field-label'), label)
        const enter = action('进入编辑', () => { scopePath = [...path, { kind: 'composite', id: composite.id, version: composite.version }]; options.__sentenceScopePath = scopePath; openPopover = null; render() }, 'sentence-config-enter'); enter.dataset.sentenceEnterScope = `composite:${composite.id}@${composite.version}`
        const remove = action('删除', () => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); target.composites = (target.composites || []).filter((_item, itemIndex) => itemIndex !== index) }, path), 'sentence-config-remove'); identity.append(enter, remove); card.append(identity)
        renderPortSection(card, composite, graph, [...path, { kind: 'composite', id: composite.id, version: composite.version }], 'inputs', '组合输入项')
        renderPortSection(card, composite, graph, [...path, { kind: 'composite', id: composite.id, version: composite.version }], 'outputs', '组合返回值')
        section.append(card)
      }
      for (const [index, continuation] of continuations.entries()) {
        const card = node('article', undefined, 'sentence-declaration-card'); card.dataset.sentenceContinuation = `${continuation.id || index}@${continuation.version || ''}`
        const identity = node('div', undefined, 'sentence-config-row')
        const id = document.createElement('input'); id.type = 'text'; id.value = continuation.id || ''; id.dataset.sentenceContinuationId = ''
        const version = document.createElement('input'); version.type = 'text'; version.value = continuation.version || ''; version.dataset.sentenceContinuationVersion = ''
        const visibleSchemas = graphSchemas(schemaGraphForScope(graph, path))
        const payloadType = continuation.payloadType || continuation.payload || { kind: 'record', schema: visibleSchemas[0] ? `${visibleSchemas[0].id}@${visibleSchemas[0].version}` : '' }
        const saveIdentity = () => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); const next = target.continuations?.[index]; if (!next) return; const oldId = next.id; const oldVersion = next.version; next.id = id.value.trim() || next.id; next.version = version.value.trim() || next.version; if (oldId !== next.id || oldVersion !== next.version) updateDeclarationId(graphValue, 'continuation', oldId, oldVersion, next.id, next.version, path) }, path)
        id.onchange = saveIdentity; version.onchange = saveIdentity
        identity.append(node('span', 'ID', 'sentence-field-label'), id, node('span', '版本', 'sentence-field-label'), version)
        const enter = action('进入编辑', () => { scopePath = [...path, { kind: 'continuation', id: continuation.id, version: continuation.version }]; options.__sentenceScopePath = scopePath; openPopover = null; render() }, 'sentence-config-enter'); enter.dataset.sentenceEnterScope = `continuation:${continuation.id}@${continuation.version}`
        const remove = action('删除', () => mutateGraph(graphValue => { const target = graphOwner(graphValue, path); target.continuations = (target.continuations || []).filter((_item, itemIndex) => itemIndex !== index) }, path), 'sentence-config-remove'); identity.append(enter, remove); card.append(identity)
        const continuationPath = [...path, { kind: 'continuation', id: continuation.id, version: continuation.version }]
        const continuationGraph = continuation.graph || {}
        renderPortSection(card, continuationGraph, graph, continuationPath, 'inputs', '续接输入项')
        renderPortSection(card, continuationGraph, graph, continuationPath, 'outputs', '续接返回值')
        { const field = node('label', undefined, 'sentence-config-row'); field.append(node('span', '载荷类型', 'sentence-field-label'), typeControl(payloadType, value => mutateGraph(graphValue => { const next = graphOwner(graphValue, path).continuations?.[index]; if (next) { next.payloadType = value; delete next.payload } }, path), schemaGraphForScope(graph, path), 'sentenceContinuationPayloadType')); card.append(field) }
        section.append(card)
      }
      if (!composites.length && !continuations.length) section.append(node('p', '尚未声明组合模块或续接流程。', 'sentence-inline-editor-copy'))
      parent.append(section)
    }

    function renderSummonCapabilitySection(parent, path) {
      // summonCapability belongs to the content document, not to a nested
      // composite/continuation graph.  Keep the editor visible only at the
      // root so a nested sentence cannot accidentally create a second source
      // of summon authority.
      if (path.length) return
      const draft = options.getDraft?.() || {}
      const capability = record(draft.summonCapability) ? draft.summonCapability : null
      const section = node('details', undefined, 'sentence-config-section sentence-summon-capability-section')
      section.dataset.sentenceSummonCapability = ''
      section.open = Boolean(capability)
      const summary = node('summary', '内容召唤声明', 'sentence-generic-extra-title')
      section.append(summary)
      const copy = node('p', '召唤句只负责来源与落点；这里声明当前内容可使用的储存/模板能力。原有 source-mirror 声明会保留并继续按旧协议读取。', 'sentence-inline-editor-copy')
      section.append(copy)

      const changeCapability = change => mutateGraph((_graph, nextDraft) => {
        const before = clone(nextDraft.summonCapability)
        const next = record(nextDraft.summonCapability) ? clone(nextDraft.summonCapability) : null
        change(nextDraft, next)
        // Most controls edit the cloned capability, while add/remove and the
        // recipe selector intentionally replace the draft field directly.
        // Preserve either form, otherwise edits would only appear until the
        // next render and never reach the saved document.
        if (JSON.stringify(nextDraft.summonCapability) === JSON.stringify(before)) {
          if (next) nextDraft.summonCapability = next
          else delete nextDraft.summonCapability
        }
      }, path)
      const textField = (row, label, value, dataset, change, options = {}) => {
        const input = document.createElement('input')
        input.type = options.type || 'text'
        input.value = value === undefined || value === null ? '' : String(value)
        if (options.min !== undefined) input.min = String(options.min)
        if (options.max !== undefined) input.max = String(options.max)
        if (options.step !== undefined) input.step = String(options.step)
        input.dataset[dataset] = ''
        input.onchange = () => change(input.value)
        row.append(node('span', label, 'sentence-field-label'), input)
        return input
      }
      const selectField = (row, label, value, dataset, values, change) => {
        const select = document.createElement('select')
        select.dataset[dataset] = ''
        values.forEach(([id, text]) => { const option = node('option', text); option.value = id; select.append(option) })
        select.value = value || values[0]?.[0] || ''
        select.onchange = () => change(select.value)
        row.append(node('span', label, 'sentence-field-label'), select)
        return select
      }
      const replaceWith = (recipe, nextDraft) => {
        nextDraft.summonCapability = recipe === 'stored-or-declared-piece'
          ? {
              version: 1,
              recipe,
              maxSummons: 1,
              storageExtensionKey: 'storedSummon',
              ownerScopedStorageExtensionKey: 'storedSummonByPlayer',
              uniqueTemplateId: 'declared-summon',
              fallback: {
                instanceIdPrefix: 'declared-summon-',
                templateId: 'declared-summon',
                name: '待配置棋子',
                faction: 'red',
                maxHp: 1,
                attack: 0,
                defense: 0,
                moveRange: 0,
                skills: [{ skillId: '待填写技能', level: 1, currentCooldown: 0 }],
              },
            }
          : { version: 1, recipe: 'authored-piece', maxSummons: 1, modes: ['new-instance'] }
      }

      if (!capability) {
        const add = action('＋ 添加召唤声明', () => changeCapability(nextDraft => replaceWith('authored-piece', nextDraft)), 'sentence-config-add')
        add.dataset.sentenceAddSummonCapability = ''
        section.append(add)
        parent.append(section)
        return
      }

      if (capability.recipe === 'source-mirror') {
        section.append(node('p', '当前内容使用历史 source-mirror 声明；本面板只读并保留原有字段和权限，不会自动覆盖这份旧声明。普通作者声明请在迁移完成或新建内容时使用公开的模板/原实例声明。', 'sentence-inline-editor-copy'))
        parent.append(section)
        return
      }

      const identity = node('div', undefined, 'sentence-config-row')
      selectField(identity, '声明类型', capability.recipe, 'sentenceSummonRecipe', [
        ['authored-piece', '模板/原实例声明'],
        ['stored-or-declared-piece', '储存或默认棋子声明'],
      ], value => changeCapability(nextDraft => replaceWith(value, nextDraft)))
      identity.append(action('移除声明', () => changeCapability(nextDraft => { delete nextDraft.summonCapability }), 'sentence-config-remove'))
      section.append(identity)
      if (capability.recipe === 'authored-piece') {
        const row = node('div', undefined, 'sentence-config-row')
        textField(row, '最多召唤数量', capability.maxSummons, 'sentenceSummonMaxSummons', value => changeCapability((_draft, next) => { if (next) next.maxSummons = Number(value) }), { type: 'number', min: 1, max: 64, step: 1 })
        section.append(row)
        const modes = node('div', undefined, 'sentence-config-row sentence-summon-mode-list')
        modes.append(node('span', '允许方式', 'sentence-field-label'))
        for (const [id, label] of [['new-instance', '新建棋子'], ['return-instance', '原实例回场']]) {
          const wrapper = node('label', undefined, 'sentence-config-check')
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Array.isArray(capability.modes) && capability.modes.includes(id); checkbox.dataset.sentenceSummonMode = id
          checkbox.onchange = () => changeCapability((_draft, next) => { if (next) next.modes = Array.from(modes.querySelectorAll('input:checked')).map(input => input.dataset.sentenceSummonMode) })
          wrapper.append(checkbox, node('span', label)); modes.append(wrapper)
        }
        section.append(modes, node('p', '模板字段仍在“召唤”句中按记录填写；原实例回场要求来源记录保持本次执行认证。', 'sentence-inline-editor-copy'))
      } else if (capability.recipe === 'stored-or-declared-piece') {
        const fields = node('div', undefined, 'sentence-summon-capability-fields')
        const simple = [
          ['storageExtensionKey', '全局储存键', 'sentenceSummonStorageKey'],
          ['ownerScopedStorageExtensionKey', '按玩家储存键', 'sentenceSummonOwnerStorageKey'],
          ['uniqueTemplateId', '唯一模板标识', 'sentenceSummonUniqueTemplate'],
        ]
        for (const [key, label, dataset] of simple) {
          const row = node('div', undefined, 'sentence-config-row')
          const value = key === 'ownerScopedStorageExtensionKey' ? capability[key] || '' : capability[key]
          textField(row, label, value, dataset, nextValue => {
            const normalized = nextValue.trim()
            changeCapability((_draft, next) => {
              if (!next) return
              if (key === 'uniqueTemplateId') {
                next.uniqueTemplateId = normalized
                if (next.fallback) next.fallback.templateId = normalized
              } else if (key === 'ownerScopedStorageExtensionKey' && !normalized) delete next[key]
              else next[key] = normalized
            })
            if (key === 'uniqueTemplateId' && !normalized) report('唯一模板标识不能为空；请填写后再保存召唤声明。', 'error')
          }, { })
          fields.append(row)
        }
        const fallback = capability.fallback || {}
        const fallbackTitle = node('h5', '默认棋子（没有储存原实例时使用）', 'sentence-inline-editor-section'); fields.append(fallbackTitle)
        const fallbackFields = [
          ['instanceIdPrefix', '实例标识前缀', 'sentenceSummonFallbackPrefix'],
          ['templateId', '模板标识', 'sentenceSummonFallbackTemplate'],
          ['name', '显示名称', 'sentenceSummonFallbackName'],
        ]
        for (const [key, label, dataset] of fallbackFields) {
          const row = node('div', undefined, 'sentence-config-row')
          textField(row, label, fallback[key], dataset, value => {
            const normalized = value.trim()
            changeCapability((_draft, next) => {
              if (!next?.fallback) return
              next.fallback[key] = normalized
              if (key === 'templateId') next.uniqueTemplateId = normalized
            })
            if (!normalized) report(`${label}不能为空；请填写后再保存召唤声明。`, 'error')
          }, {})
          fields.append(row)
        }
        const numericFields = [['maxHp', '最大生命', 'sentenceSummonFallbackMaxHp'], ['attack', '攻击力', 'sentenceSummonFallbackAttack'], ['defense', '防御力', 'sentenceSummonFallbackDefense'], ['moveRange', '移动范围', 'sentenceSummonFallbackMoveRange']]
        for (const [key, label, dataset] of numericFields) {
          const row = node('div', undefined, 'sentence-config-row')
          textField(row, label, fallback[key], dataset, value => changeCapability((_draft, next) => { if (next?.fallback) next.fallback[key] = Number(value) }), { type: 'number', min: key === 'maxHp' ? 1 : 0, step: 1 })
          fields.append(row)
        }
        const factionRow = node('div', undefined, 'sentence-config-row')
        selectField(factionRow, '阵营', fallback.faction, 'sentenceSummonFallbackFaction', [['red', '红方'], ['blue', '蓝方']], value => changeCapability((_draft, next) => { if (next?.fallback) next.fallback.faction = value }))
        fields.append(factionRow)
        const skills = Array.isArray(fallback.skills) ? fallback.skills : []
        const skillTitle = node('h5', '默认技能', 'sentence-inline-editor-section'); fields.append(skillTitle)
        skills.forEach((skill, index) => {
          const row = node('div', undefined, 'sentence-config-row sentence-summon-skill-row'); row.dataset.sentenceSummonSkill = String(index)
          textField(row, '技能标识', skill?.skillId, 'sentenceSummonSkillId', value => changeCapability((_draft, next) => { const item = next?.fallback?.skills?.[index]; if (item) item.skillId = value.trim() }), {})
          textField(row, '等级', skill?.level, 'sentenceSummonSkillLevel', value => changeCapability((_draft, next) => { const item = next?.fallback?.skills?.[index]; if (item) item.level = Number(value) }), { type: 'number', min: 1, step: 1 })
          textField(row, '当前冷却', skill?.currentCooldown, 'sentenceSummonSkillCooldown', value => changeCapability((_draft, next) => { const item = next?.fallback?.skills?.[index]; if (item) item.currentCooldown = Number(value) }), { type: 'number', min: 0, step: 1 })
          row.append(action('删除技能', () => changeCapability((_draft, next) => { if (next?.fallback?.skills) next.fallback.skills.splice(index, 1) }), 'sentence-config-remove'))
          fields.append(row)
        })
        const addSkill = action('＋ 添加技能', () => changeCapability((_draft, next) => { if (next?.fallback) (next.fallback.skills || (next.fallback.skills = [])).push({ skillId: '待填写技能', level: 1, currentCooldown: 0 }) }), 'sentence-config-add')
        addSkill.dataset.sentenceSummonAddSkill = ''
        fields.append(addSkill, node('p', '储存的原实例会保留其规则、状态与扩展；默认棋子声明只接受技能条目，规则不会被此表单伪造。', 'sentence-inline-editor-copy'))
        section.append(fields)
      }
      parent.append(section)
    }

    function graphDiagnostic(graph) {
      if (options.__sentenceLastDiagnostic) return authorDiagnostic(options.__sentenceLastDiagnostic)
      if (!record(graph) || !core) return ''
      try {
        if (typeof core.compileGameplayModuleGraph === 'function') core.compileGameplayModuleGraph(graph, core.GAMEPLAY_MODULE_REGISTRY)
        else if (typeof core.assertGameplayModuleGraph === 'function') core.assertGameplayModuleGraph(graph)
        return ''
      } catch (error) { return authorDiagnostic(error?.message || String(error)) }
    }

    function renderGraphConfiguration(parent, graph, path = scopePath) {
      const section = node('details', undefined, 'sentence-graph-configuration')
      section.open = Boolean(graphDiagnostic(graph)); section.dataset.sentenceGraphConfiguration = ''
      const summary = node('summary', undefined, 'sentence-generic-extra-title')
      summary.append(node('span', path.length ? '当前流程变量与返回值' : '变量、返回值与结构定义'))
      section.append(summary)
      const diagnostic = graphDiagnostic(graph)
      if (diagnostic) { const warning = node('p', `当前图需要修复后才能保存：${diagnostic}`, 'sentence-message error'); warning.dataset.sentenceDiagnostic = ''; warning.setAttribute('role', 'alert'); section.append(warning) }
      const owner = graphOwner(graph, path)
      renderPortSection(section, owner, graph, path, 'inputs', '输入项')
      renderPortSection(section, owner, graph, path, 'outputs', '返回值')
      renderSchemaSection(section, owner, path, graph)
      renderSummonCapabilitySection(section, path)
      renderDeclarations(section, graph, path)
      if (parent) parent.append(section)
      return section
    }

    function renderScopeNavigation(parent, graph, path = scopePath) {
      const nav = node('nav', undefined, 'sentence-scope-navigation')
      nav.dataset.sentenceScopeNavigation = ''
      nav.setAttribute('aria-label', '效果编辑范围')
      const root = action('主流程', () => { scopePath = []; options.__sentenceScopePath = scopePath; openPopover = null; render() }, 'sentence-scope-crumb')
      root.dataset.sentenceScope = 'root'; nav.append(root)
      for (let index = 0; index < path.length; index += 1) {
        const frame = path[index]
        nav.append(node('span', ' / ', 'sentence-scope-separator'))
        const label = frame.kind === 'composite' ? `组合 · ${frame.id}` : frame.kind === 'continuation' ? `续接 · ${frame.id}` : frame.branch === 'then' ? '满足条件时' : frame.branch === 'else' ? '否则' : frame.branch === 'condition.body' ? '循环条件' : '执行内容'
        const crumb = action(label, () => { scopePath = path.slice(0, index + 1); options.__sentenceScopePath = scopePath; openPopover = null; render() }, 'sentence-scope-crumb')
        crumb.dataset.sentenceScope = scopePathKey(path.slice(0, index + 1)); nav.append(crumb)
      }
      parent.append(nav)
      const owner = graphOwner(graph, path)
      const links = node('div', undefined, 'sentence-scope-links')
      const composites = Array.isArray(owner?.composites) ? owner.composites : []
      const continuations = Array.isArray(owner?.continuations) ? owner.continuations : []
      for (const composite of composites) {
        const button = action(`进入组合：${composite.label || composite.id}@${composite.version}`, () => { scopePath = [...path, { kind: 'composite', id: composite.id, version: composite.version }]; options.__sentenceScopePath = scopePath; openPopover = null; render() }, 'sentence-scope-link')
        button.dataset.sentenceScopePicker = `composite:${composite.id}@${composite.version}`; links.append(button)
      }
      for (const continuation of continuations) {
        const button = action(`进入续接：${continuation.id}@${continuation.version}`, () => { scopePath = [...path, { kind: 'continuation', id: continuation.id, version: continuation.version }]; options.__sentenceScopePath = scopePath; openPopover = null; render() }, 'sentence-scope-link')
        button.dataset.sentenceScopePicker = `continuation:${continuation.id}@${continuation.version}`; links.append(button)
      }
      if (links.childElementCount) parent.append(links)
    }

    function graphProjection(graph) {
      const section = node('section', undefined, 'sentence-generic-flow')
      section.dataset.sentenceGraphSummary = ''
      section.append(node('p', '点击蓝色参数即可修改；可以逐项填写，也能随时返回。', 'sentence-generic-intro'))
      const scroll = node('div', undefined, 'sentence-flow-viewport')
      scroll.dataset.sentenceScroll = 'flow'
      scroll.dataset.sentenceHorizontalScroll = ''
      scroll.dataset.sentenceScrollKey = `${options.field || primaryField}:${scopePathKey(scopePath)}`
      const content = node('div', undefined, 'sentence-flow-content')
      renderScopeNavigation(content, graph, scopePath)
      const active = scopeDefinition(graph, scopePath)
      const body = active.body || []
      const list = appendProjectedStatements(content, body, graph, 0, scopePath)
      if (list.children.length) content.append(list)
      else content.append(node('p', '当前流程还没有语句；可以从下方添加结构语句或注册模块。', 'sentence-generic-empty'))
      scroll.append(content)
      section.append(scroll)
      return section
    }

    function renderModulePicker(graph) {
      const catalogGraph = graphOwner(graph, scopePath)
      const picker = node('div', undefined, 'sentence-module-picker sentence-module-popover')
      picker.dataset.sentencePopover = 'module'
      picker.setAttribute('aria-label', '添加语句模块目录')
      picker.append(node('strong', '添加语句', 'sentence-module-picker-title'))
      const search = document.createElement('input')
      search.type = 'search'; search.placeholder = '搜索模块…'; search.value = openPopover?.query || ''; search.dataset.sentenceModuleSearch = ''
      search.setAttribute('aria-label', '搜索模块')
      const beginSearchComposition = () => composingControls.add(search)
      const finishSearchComposition = () => {
        composingControls.add(search)
        setTimeout(() => {
          composingControls.delete(search)
          flushPendingRender()
        }, 0)
      }
      search.addEventListener('compositionstart', beginSearchComposition)
      search.addEventListener('compositionupdate', beginSearchComposition)
      search.addEventListener('compositionend', finishSearchComposition)
      search.oninput = event => {
        if (openPopover) openPopover.query = search.value
        if (event.isComposing) composingControls.add(search)
        // render() records a pending refresh while this input is composing;
        // the compositionend task flushes it after the final input settles.
        render()
      }
      picker.append(search)
      picker.append(node('p', '新增步骤使用声明、赋值和点号表达式；读取、四则、比较和逻辑运算请在表达式字段中填写。', 'sentence-module-help'))
      const query = String(openPopover?.query || '').trim().toLowerCase()
      const insertionTarget = openPopover?.insertInto
      const insertionParent = insertionTarget?.parentId ? statementForId(graph, insertionTarget.parentId, scopePath) : null
      const dataOnly = insertionTarget?.branch === 'condition.body' || insertionParent?.kind === 'collection' || insertionParent?.kind?.startsWith?.('collection.')
      const category = authoringCategoryOrder.includes(openPopover?.category) ? openPopover.category : 'all'
      const allDescriptors = authoringPickerDescriptors(moduleDescriptorsFor(core, catalogGraph)
        .filter(descriptor => descriptor.id !== 'local.declare' && !isCompatibilityDescriptor(descriptor)
          && !isUnifiedWriteDescriptor(descriptor) && !pureDescriptor(descriptor)))
      const categoryDescriptors = allDescriptors.filter(descriptor => category === 'all' || authoringCategoryFor(descriptor) === category)
      const allAuthorStatements = authorStatementCatalog()
      const categoryAuthorStatements = allAuthorStatements.filter(item => category === 'all' || authoringCategoryFor({ id: item.id, ui: { category: 'data' } }) === category)
      const catalog = categoryAuthorStatements.filter(item => {
        const label = `${item.label || ''} ${item.id || ''} ${item.description || ''} ${authoringCategoryLabel(authoringCategoryFor({ id: item.id, ui: { category: 'data' } }))}`.toLowerCase()
        return !query || label.includes(query)
      })
      const moduleDescriptors = categoryDescriptors
        .filter(descriptor => {
          const label = `${descriptor.label || ''} ${descriptor.id || ''} ${descriptor.description || ''} ${descriptor.uiDescription || ''} ${authoringCategoryLabel(authoringCategoryFor(descriptor))}`.toLowerCase()
          return !query || label.includes(query)
        })
      const categoryCounts = new Map(authoringCategoryOrder.map(value => [value, 0]))
      categoryCounts.set('data', (categoryCounts.get('data') || 0) + allAuthorStatements.length)
      for (const descriptor of allDescriptors) {
        const key = authoringCategoryFor(descriptor)
        categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1)
      }
      const categories = [['all', '全部'], ...authoringCategoryOrder.map(value => [value, authoringCategoryLabel(value)])]
      const categoryBar = node('div', undefined, 'sentence-module-categories')
      for (const [value, label] of categories) {
        const count = value === 'all' ? allAuthorStatements.length + allDescriptors.length : (categoryCounts.get(value) || 0)
        const button = action(`${label}（${count}）`, () => {
          openPopover = { ...(openPopover || {}), control: 'module', category: value }
          render()
        }, `sentence-module-category${category === value ? ' active' : ''}`)
        button.dataset.sentenceModuleCategory = value
        button.setAttribute('aria-pressed', String(category === value))
        button.disabled = value !== 'all' && count === 0
        categoryBar.append(button)
      }
      picker.append(categoryBar)
      const list = node('div', undefined, 'sentence-module-options')
      for (const itemDefinition of catalog) {
        const label = itemDefinition.label || itemDefinition.id
        const blocked = dataOnly
        const item = action('', () => {
          if (blocked) return
          try {
            let statementId
            if (itemDefinition.kind === 'local-declaration') {
              const localDescriptor = authoringPickerDescriptors(moduleDescriptorsFor(core, catalogGraph).filter(descriptor => descriptor.id === 'local.declare'))[0]
              if (!localDescriptor) throw new Error('找不到局部变量声明模块。')
              statementId = addModule(options, localDescriptor.id, localDescriptor.version, openPopover?.insertInto || { kind: 'root' }, scopePath)
            } else statementId = addAuthorStatement(options, itemDefinition.kind, openPopover?.insertInto || { kind: 'root' }, scopePath)
            openPopover = { control: 'statement', statementId, scopePath }
            report(`已加入${label}。`, 'success')
          } catch (error) { report(error.message || String(error), 'error') }
        }, 'sentence-module-option')
        item.append(node('span', label, 'sentence-module-option-label'))
        item.append(node('small', blocked ? '此位置只允许无副作用表达式。' : itemDefinition.description || '按句式填写后即可继续编辑。', 'sentence-module-option-help'))
        item.dataset.sentenceModule = itemDefinition.id
        item.dataset.sentenceAuthorStatement = itemDefinition.kind || ''
        item.title = itemDefinition.description || label
        item.setAttribute('aria-label', `${label}：${itemDefinition.description || '按句式填写后即可继续编辑。'}`)
        item.disabled = blocked
        list.append(item)
      }
      for (const descriptor of moduleDescriptors) {
        const label = semanticModuleLabel(descriptor.id, descriptor.label)
        const item = action('', () => {
          if (dataOnly) return
          try {
            const statementId = addModule(options, descriptor.id, descriptor.version, insertionTarget || { kind: 'root' }, scopePath)
            openPopover = { control: 'statement', statementId, scopePath }
            report(`已加入${label}。`, 'success')
          } catch (error) { report(error.message || String(error), 'error') }
        }, 'sentence-module-option')
        item.append(node('span', label, 'sentence-module-option-label'))
        item.append(node('small', dataOnly ? '此位置只允许无副作用表达式。' : descriptor.uiDescription || descriptor.description || '按声明输入后即可继续编辑。', 'sentence-module-option-help'))
        item.dataset.sentenceModule = descriptor.id
        item.dataset.sentenceModuleCategory = authoringCategoryFor(descriptor)
        item.title = descriptor.description || label
        item.setAttribute('aria-label', `${label}：${descriptor.uiDescription || descriptor.description || '按声明输入后即可继续编辑。'}`)
        item.disabled = dataOnly
        list.append(item)
      }
      if (!catalog.length && !moduleDescriptors.length) list.append(node('p', '没有匹配的作者语句。', 'sentence-module-empty'))
      picker.append(list, action('返回', closePopover, 'sentence-popover-close'))
      return picker
    }

    function render() {
      if (destroyed) return
      if (hasActiveComposition()) {
        pendingRender = true
        return
      }
      pendingRender = false
      for (const editor of expressionEditors) editor.destroy()
      expressionEditors.clear()
      renderGeneration += 1
      if (!pendingFocusTarget) pendingFocusTarget = focusTargetForElement(document.activeElement)
      const viewport = container.closest('.detail-col')
      const previousScroll = viewport?.scrollTop
      const scrollSnapshot = captureScrollOffsets()
      const draft = options.getDraft?.() || {}
      const field = options.field || 'code'
      activeDraft = draft
      collapsePanelSequence = 0
      const graph = graphFor(core, draft, field)
      options.__sentenceScopePath = scopePath
      if (record(graph) && scopePath.length && !scopeDefinition(graph, scopePath).graph) {
        scopePath = []
        options.__sentenceScopePath = scopePath
      }
      const pattern = graphPattern(graph)
      const text = pattern ? canonicalText(pattern, draft, core, graph, scopePath) : null
      container.dataset.sentenceKind = draft.kind || ''
      container.dataset.sentenceCollection = collection
      container.replaceChildren()
      const shell = node('section', undefined, 'sentence-editor')
      shell.dataset.sentenceEditor = ''
      shell.dataset.sentenceKind = draft.kind || ''
      shell.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !openPopover) return
        if (event.isComposing || event.keyCode === 229 || hasActiveComposition()) return
        event.preventDefault()
        closePopover()
      })

      const header = node('header', undefined, 'sentence-header')
      const titleBlock = node('div', undefined, 'sentence-title-block')
      const surfaceTitle = collection === 'cards' ? '卡牌 / 内容说明' : collection === 'rules' ? '规则 / 内容说明' : '技能 / 能力说明'
      titleBlock.append(node('span', surfaceTitle, 'sentence-eyebrow'))
      titleBlock.append(node('h2', draft.name || draft.id || '未命名内容', 'sentence-title-heading'))
      titleBlock.append(node('p', draft.description || '尚未填写内容描述。', 'sentence-lede'))
      const headerActions = node('div', undefined, 'sentence-header-actions')
      const kind = draft.kind === 'passive' ? '被动能力' : draft.kind === 'active' ? '主动能力' : collection === 'rules' ? '规则' : collection === 'cards' ? '卡牌' : '能力类型未设置'
      headerActions.append(node('span', kind, `sentence-kind ${draft.kind || 'unset'}`))
      if (typeof options.save === 'function') {
        const saveAction = action('保存', options.save, 'sentence-save')
        saveAction.dataset.sentenceSave = ''
        headerActions.append(saveAction)
      }
      if (typeof options.openAdvanced === 'function') {
        const detailsAction = action('兼容诊断', options.openAdvanced, 'sentence-advanced')
        detailsAction.dataset.sentenceAdvanced = ''
        headerActions.append(detailsAction)
      }
      header.append(titleBlock, headerActions); shell.append(header)

      const body = node('div', undefined, 'sentence-layout')
      const main = node('main', undefined, 'sentence-main')
      const effects = node('section', undefined, 'sentence-card sentence-effects')
      const effectHeader = node('div', undefined, 'sentence-card-header')
      effectHeader.append(node('h3', '效果步骤'))
      effectHeader.append(node('span', graph || pattern ? '按顺序执行' : '添加第一条效果', 'sentence-card-hint'))
      effects.append(effectHeader)

      const entryNavigation = node('label', undefined, 'sentence-entry-navigation')
      entryNavigation.append(node('span', '编辑内容', 'sentence-field-label'))
      const entrySelect = document.createElement('select')
      entrySelect.dataset.sentenceEntry = ''
      entrySelect.setAttribute('aria-label', '效果入口')
      const entryLabels = { code: '执行效果', skillCode: '规则效果', previewCode: '范围与效果预览', effectCode: '选择后的效果', triggerSkill: '触发效果' }
      const entryFields = [primaryField, ...['code', 'skillCode', 'previewCode', 'effectCode', 'triggerSkill'].filter(key => own(draft, key) || own(draft.gameplayModules?.entries || {}, key))]
      if (collection === 'skills' || collection === 'cards') entryFields.push('previewCode')
      for (const entryField of new Set(entryFields)) {
        const option = node('option', entryLabels[entryField] || entryField)
        option.value = entryField
        entrySelect.append(option)
      }
      entrySelect.value = field
      entrySelect.onchange = () => {
        options.field = entrySelect.value
        scopePath = []
        options.__sentenceScopePath = scopePath
        openPopover = null
        message = null
        render()
      }
      entryNavigation.append(entrySelect)
      effects.append(entryNavigation)

      if (pattern && text) {
        const steps = node('ol', undefined, 'sentence-steps')
        const step1 = node('li', undefined, 'sentence-step'); step1.dataset.sentenceStep = '1'
        const copy1 = node('p'); copy1.append(node('span', '使用时', 'sentence-step-label'), node('span', '执行此能力。', 'sentence-step-copy')); step1.append(copy1); steps.append(step1)
        const step2 = node('li', undefined, 'sentence-step'); step2.dataset.sentenceStep = '2'
        const copy2 = node('p'); copy2.append(node('span', '选择', 'sentence-step-label'), node('span', ' '))
        const range = controlButton(`${formatNumber(text.range)} 格内`, 'range', '编辑选择范围'); copy2.append(range, node('span', '的'))
        copy2.append(controlButton(filterLabels[text.filter] || text.filter, 'target', '编辑目标类型'), node('span', '目标并记作'), controlButton('目标', 'target', '编辑目标类型'), node('span', '。'))
        step2.append(copy2, rowActions(pattern.choice, scopePath))
        steps.append(step2)
        const step3 = node('li', undefined, 'sentence-step'); step3.dataset.sentenceStep = '3'; step3.dataset.sentenceNode = pattern.damage?.id || 'damage'
        const copy3 = node('p'); copy3.append(node('span', '对', 'sentence-step-label'), node('span', ' '), controlButton('目标', 'target', '编辑目标类型'), node('span', '造成'))
        copy3.append(controlButton(`${attributeLabels[text.attribute] || text.attribute} × ${formatNumber(text.multiplier)}`, 'multiplier', '编辑伤害计算'), node('span', '的伤害。'))
        step3.append(copy3, rowActions(pattern.damage, scopePath))
        steps.append(step3)
        effects.append(steps)
        // Keep the concise damage prose while exposing the same declarations
        // and scope editor used by every other graph.
      } else if (record(graph)) {
        effects.append(graphProjection(graph))
      } else {
        const empty = node('div', undefined, 'sentence-empty-graph')
        empty.dataset.sentenceEmptyGraph = ''
        empty.append(node('strong', '尚未建立结构化效果图。'))
        empty.append(node('p', '可以直接从下方添加语句或注册模块；保存前会检查完整流程图。现有字段和代码会继续保留。'))
        effects.append(empty)
      }

      const actionRow = node('div', undefined, 'sentence-action-row')
      const addMenu = node('details', undefined, 'sentence-add-menu')
      const addSummary = node('summary', '添加步骤')
      addSummary.setAttribute('aria-label', '添加步骤')
      addMenu.append(addSummary)
      const addActions = node('div', undefined, 'sentence-add-menu-actions')
      const addEffectAction = action('＋ 添加语句', () => { openPopover = { control: 'module', category: 'all', query: '', insertInto: { kind: 'root' }, scopePath }; render() }, 'sentence-primary sentence-add-statement')
      addEffectAction.dataset.sentenceAddEffect = ''
      addActions.append(addEffectAction)
      const addConditionAction = action('＋ 添加条件', () => {
        try { addCondition(options, { kind: 'root' }, scopePath); report('条件分支已加入流程图。', 'success') } catch (error) { report(error.message || String(error), 'error') }
      }, 'sentence-secondary')
      addConditionAction.dataset.sentenceAddCondition = ''
      addActions.append(addConditionAction)
      for (const kind of ['foreach', 'while', 'record.create', 'record.get', 'record.with', 'collection.map', 'collection.filter', 'collection.reduce', 'collection.find', 'defer-choice', 'return']) {
        const label = kind === 'foreach' ? '＋ 添加遍历' : kind === 'while' ? '＋ 添加循环' : kind === 'record.create' ? '＋ 创建记录' : kind === 'record.get' ? '＋ 读取字段' : kind === 'record.with' ? '＋ 更新记录' : kind === 'collection.map' ? '＋ 映射集合' : kind === 'collection.filter' ? '＋ 筛选集合' : kind === 'collection.reduce' ? '＋ 汇总集合' : kind === 'collection.find' ? '＋ 查找第一项' : kind === 'defer-choice' ? '＋ 等待选择' : '＋ 添加返回'
        const structural = action(label, () => {
          try { const id = addStructuredStatement(options, kind, { kind: 'root' }, scopePath); openPopover = { control: 'statement', statementId: id, scopePath }; report(`${label.slice(2)}已加入流程图。`, 'success') }
          catch (error) { report(error.message || String(error), 'error') }
        }, 'sentence-secondary')
        structural.dataset.sentenceAddStructured = `root:${kind}`
        addActions.append(structural)
      }
      addMenu.append(addActions)
      actionRow.append(addMenu)
      if (record(graph)) {
        const configurationAction = action('变量与类型', () => { openPopover = { control: 'configuration', scopePath }; render() }, 'sentence-secondary sentence-configuration-toggle')
        configurationAction.dataset.sentenceConfiguration = ''
        configurationAction.setAttribute('aria-label', '编辑变量、返回值与结构定义')
        actionRow.append(configurationAction)
      }
      effects.append(actionRow)
      if (openPopover?.control === 'module') effects.append(renderModulePicker(graph))
      if (message) effects.append(node('p', message, `sentence-message ${messageKind}`))
      main.append(effects)

      const inspector = node('aside', undefined, 'sentence-inspector')
      inspector.dataset.sentenceInspector = ''
      inspector.dataset.sentenceScroll = 'inspector'
      inspector.dataset.sentenceScrollKey = `${documentScopeKey(draft, field)}:inspector`
      let selectedStatement = null
      let selectedPath = openPopover?.scopePath || scopePath
      if (openPopover?.statementId) {
        const selectedLocation = statementLocationForLexicalId(graph, openPopover.statementId, selectedPath)
        selectedStatement = selectedLocation?.statement || null
        selectedPath = selectedLocation?.scopePath || selectedPath
      }
      let inspectorHeadingText = '选择一项进行编辑'
      if (openPopover?.control === 'range') inspectorHeadingText = '编辑选择范围'
      else if (openPopover?.control === 'target') inspectorHeadingText = '编辑目标类型'
      else if (openPopover?.control === 'multiplier') inspectorHeadingText = '编辑伤害计算'
      else if (openPopover?.control === 'configuration') inspectorHeadingText = '变量、返回值与结构定义'
      else if (openPopover?.control === 'record-fields') inspectorHeadingText = '编辑记录字段'
      else if (selectedStatement) {
        const selectedDescriptor = descriptorForCurrent(graph, selectedStatement, selectedPath)
        if ((openPopover?.control === 'slot' || openPopover?.control === 'expression') && openPopover.slotName) {
          const slotName = String(openPopover.slotName).replace(/^(field|return):/, '')
          const slotDefinition = openPopover.slotKind === 'parameter'
            ? (Array.isArray(selectedDescriptor?.parameters) ? selectedDescriptor.parameters : []).find(item => item.name === openPopover.slotName)
            : descriptorInputDefinition(selectedDescriptor, (Array.isArray(selectedDescriptor?.inputs) ? selectedDescriptor.inputs : []).find(item => item.name === openPopover.slotName), selectedStatement)
          inspectorHeadingText = `编辑${semanticSlotLabel(slotDefinition, slotName)}`
        } else inspectorHeadingText = selectedDescriptor?.label || statementKindLabels[selectedStatement.kind] || '编辑当前步骤'
      }
      const inspectorHeading = node('h3', inspectorHeadingText, 'sentence-inspector-heading')
      inspectorHeading.dataset.sentenceInspectorHeading = ''
      const inspectorCopy = node('p', selectedStatement || ['range', 'target', 'multiplier'].includes(openPopover?.control)
        ? '当前选项的配置固定在这里，修改后会保留在原有流程位置。'
        : '点击句中的蓝色参数，或打开一行的更多操作，在这里配置当前选择。', 'sentence-inspector-copy')
      inspectorCopy.dataset.sentenceInspectorCopy = ''
      inspector.append(inspectorHeading, inspectorCopy)
      if (record(graph)) {
        const configuration = renderGraphConfiguration(null, graph, selectedPath)
        configuration.open = openPopover?.control === 'configuration' || configuration.open
        inspector.append(configuration)
      }
      if (['range', 'target', 'multiplier'].includes(openPopover?.control) && pattern && text) {
        inspector.append(popoverFor(openPopover.control, pattern, text, graph, selectedPath))
      } else if (selectedStatement && openPopover?.control === 'record-fields') {
        inspector.append(renderRecordFieldsEditor(selectedStatement, graph, selectedPath))
      } else if (selectedStatement && ['statement', 'slot', 'expression'].includes(openPopover?.control)) {
        inspector.append(renderStatementEditor(selectedStatement, graph, selectedPath))
      } else if (openPopover?.control && !['module', 'configuration'].includes(openPopover.control) && !selectedStatement) {
        inspector.append(node('p', '当前选择已失效；原有内容仍保留，请重新选择一行。', 'sentence-invalid-field'))
      }

      const preview = node('aside', undefined, 'sentence-preview sentence-card')
      preview.hidden = Boolean(openPopover?.statementId || ['range', 'target', 'multiplier', 'configuration', 'record-fields'].includes(openPopover?.control))
      preview.dataset.sentencePreview = ''
      const previewHeader = node('div', undefined, 'sentence-card-header')
      const previewTitle = collection === 'cards' ? '卡牌预览' : collection === 'rules' ? '规则预览' : '技能预览'
      previewHeader.append(node('h3', previewTitle))
      previewHeader.append(node('span', kind, 'sentence-card-hint')); preview.append(previewHeader)
      const previewCard = node('div', undefined, 'sentence-preview-card')
      previewCard.append(node('h4', draft.name || draft.id || '未命名内容'))
      const previewDescriptionText = text?.description || draft.description || '暂无效果描述。'
      const previewDescription = node('p', previewDescriptionText, 'sentence-preview-description')
      previewDescription.dataset.sentencePreviewDescription = ''
      previewCard.append(previewDescription); preview.append(previewCard)
      const costs = [['行动点', draft.actionPointCost], ['充能点', draft.chargeCost], ['冷却回合', draft.cooldownTurns], ['每局使用次数', draft.maxCharges]]
        .filter(([, value]) => value !== null && value !== undefined && Number.isFinite(Number(value)))
      if (costs.length) {
        const costGrid = node('div', undefined, 'sentence-cost-grid')
        for (const [label, value] of costs) {
          const item = node('div', undefined, 'sentence-cost')
          item.dataset.sentenceCost = label
          const displayValue = label === '每局使用次数' && Number(value) === 0 ? '无限制' : formatNumber(Number(value))
          item.append(node('span', label, 'sentence-cost-label'), node('strong', displayValue, 'sentence-cost-value'))
          costGrid.append(item)
        }
        preview.append(costGrid)
      }
      if (collection === 'skills' && (typeof options.skillTrial === 'function' || typeof window.editorAPI?.skillTrial === 'function')) {
        const trialButton = action(trialPending ? '正在打开训练营…' : '试用技能', startTrial, 'sentence-preview-action sentence-trial-action')
        trialButton.dataset.sentenceTrial = ''; trialButton.disabled = trialPending; trialButton.setAttribute('aria-busy', trialPending ? 'true' : 'false')
        trialButton.title = '打开隔离训练营；请在那里选择对应阵营的试用棋子。'; preview.append(trialButton)
        preview.append(node('span', '在训练营中体验当前技能草稿', 'sentence-trial-help'))
      } else if (typeof options.previewAction === 'function') {
        preview.append(action('预览内容', options.previewAction, 'sentence-preview-action'))
      }
      inspector.append(preview)
      body.append(main, inspector); shell.append(body); container.append(shell)
      if (viewport && previousScroll !== undefined) viewport.scrollTop = previousScroll
      restoreScrollOffsets(scrollSnapshot)
      if (pendingCollapseFocusKey) {
        const focusKey = pendingCollapseFocusKey
        pendingCollapseFocusKey = null
        const toggle = [...container.querySelectorAll('[data-sentence-collapse-key]')].find(item => item.dataset.sentenceCollapseKey === focusKey)
        if (toggle) {
          try { toggle.focus({ preventScroll: true }) } catch { toggle.focus() }
          restoreScrollOffsets(scrollSnapshot)
        }
      }
      restorePendingFocus()

      const collectionList = options.root?.collection ? document.getElementById(`${options.root.collection}-list`) : null
      const selectedItem = collectionList?.querySelector('.entity-item.selected')
      if (collectionList && selectedItem) {
        const listBounds = collectionList.getBoundingClientRect(); const itemBounds = selectedItem.getBoundingClientRect()
        if (itemBounds.top < listBounds.top) collectionList.scrollTop -= listBounds.top - itemBounds.top
        else if (itemBounds.bottom > listBounds.bottom) collectionList.scrollTop += itemBounds.bottom - listBounds.bottom
      }
    }

    if (options.initialEditorState) restoreEditorState(options.initialEditorState, false)
    render()
    return {
      refresh: render,
      getEditorState,
      restoreEditorState,
      hasUnappliedEdits() { return expressionDrafts.size > 0 || authorStatementDrafts.size > 0 || resultVariableDrafts.size > 0 },
      getTrialRequest,
      startTrial,
      destroy() {
        destroyed = true
        pendingRender = false
        composingControls.clear()
        openPopover = null
        for (const editor of expressionEditors) editor.destroy()
        expressionEditors.clear()
        expressionDrafts.clear()
        authorStatementDrafts.clear()
        resultVariableDrafts.clear()
        container.replaceChildren()
      },
    }
  }

  window.SkillSentenceEditor = { mount }
  window.SkillSentenceEditor.localizeDiagnostic = authorDiagnostic
})()
