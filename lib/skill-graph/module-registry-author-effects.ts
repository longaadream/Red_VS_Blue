import type { GameplayModuleDescriptor, GameplayValueType } from './module-types'
const listPiece = { kind: 'list', element: 'piece' } as const
const listNumber = { kind: 'list', element: 'number' } as const
const decode = (value: unknown): GameplayValueType => typeof value === 'string' && value.trimStart().startsWith('{') ? JSON.parse(value) : value as GameplayValueType
const canonical = (value: unknown): string => value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : JSON.stringify(value)
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const UNIFIED_AUTHOR_EFFECT_V2_MODULES: readonly GameplayModuleDescriptor[] = (['damage', 'heal'] as const).map(kind => ({
  id: `author.effect.${kind}`, version: '2', label: kind === 'damage' ? '造成伤害' : '恢复生命',
  description: '一个目标或元组共用此语句；一个数值统一应用，数值元组按序对应；返回值保留失败项的序号。',
  inputs: [{ name: 'source', type: 'piece', label: '来源' }, { name: 'target', type: 'piece', label: '目标' }, { name: 'amount', type: 'number', label: kind === 'damage' ? '伤害量' : '恢复量' },
    ...(kind === 'damage' ? [{ name: 'killerPlayer', type: 'player' as const, label: '击杀归属', optional: true, nullable: true }] : [])],
  inputValueTypeBindings: { source: { parameter: 'sourceType' }, target: { parameter: 'targetType' }, amount: { parameter: 'amountType' } },
  outputs: [{ name: 'result', type: 'record', label: '结算结果' }], outputValueTypeBindings: { result: { parameter: 'resultType' } },
  parameters: [
    // A captured execution handle is represented by the closed `record` value
    // type.  The runtime still checks the WeakMap identity, so this is not a
    // record-shaped instance fallback; it is the only type accepted for the
    // source handle produced by source.capture/source.capture-list.
    { name: 'sourceType', type: 'string', label: '来源类型', default: 'piece', enum: ['piece', 'player', 'card', 'record'] },
    // `record` is the authenticated execution-local handle produced by a
    // capture module.  It is intentionally a separate target shape from the
    // existing piece/list forms: a record target is settled through the
    // processing queue and therefore keeps the captured identity after the
    // current event removes it.
    { name: 'targetType', type: 'string', label: '目标类型', default: 'piece', enum: ['piece', ...(kind === 'damage' ? ['record'] : []), JSON.stringify(listPiece)] },
    { name: 'amountType', type: 'string', label: '数值类型', default: 'number' },
    { name: 'resultType', type: 'string', label: '结果类型', default: 'record' },
    { name: 'damageType', type: 'string', label: '伤害类型', enum: ['normal', 'true'], default: 'normal' },
    ...(kind === 'damage' ? [{ name: 'legacyNormalSpelling', type: 'string' as const, label: '旧日志伤害名称', enum: ['physical', 'magical'] as const, default: 'physical' }] : []),
    ...(kind === 'damage' ? [{ name: 'attribution', type: 'string' as const, label: '归属方式', enum: ['current', 'unattributed'] as const, default: 'current' }] : []),
    { name: 'skillId', type: 'string', label: '技能标识', optional: true },
  ],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: false, previewSafe: false, writes: [kind, 'events'], events: kind === 'damage' ? ['beforeDamageDealt', 'afterDamageDealt'] : ['beforeHealDealt', 'afterHealDealt'] },
  ui: { category: 'effect', authoring: 'standard' },
  lower: ctx => {
    const sourceType = ctx.parameters.sourceType
    const captured = sourceType === 'record'
    const targets = decode(ctx.parameters.targetType), amount = decode(ctx.parameters.amountType), result = decode(ctx.parameters.resultType)
    if (captured) {
      if (ctx.inputs.killerPlayer !== undefined) throw new Error('已保留来源不支持覆盖击杀归属，请使用棋子、玩家或手牌来源')
      // Captured batches are intentionally kept as one host settlement.  The
      // captured source identity and target order must reach the authoritative
      // captured runtime intact; adapting it through effects.apply would look
      // up a live piece and lose the delayed-effect semantics.  A singular
      // record target is the queued processing form used by old captured
      // queue effects; healing has no equivalent queued record form.
      const capturedRecordTarget = same(targets, 'record')
      if (!same(targets, listPiece) && !(kind === 'damage' && capturedRecordTarget)) {
        throw new Error(kind === 'damage' ? '已保留来源只能使用棋子元组或保留目标记录' : '已保留来源只能使用棋子元组目标')
      }
      if (!same(amount, 'number')) throw new Error('已保留来源只能使用统一数值')
      if (!same(result, 'record')) throw new Error('已保留来源结果须为批量记录')
    } else {
      if (!same(targets, 'piece') && !same(targets, listPiece)) throw new Error('目标须为棋子或棋子元组')
      if (!same(amount, 'number') && !same(amount, listNumber)) throw new Error('数值须为数值或数值元组')
      if (!same(result, same(targets, 'piece') ? 'record' : { kind: 'list', element: 'record' })) throw new Error('结果形状须与目标形状一致')
    }
    const flow = ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
    const context = ctx.surface === 'pending' ? 'ctx' : 'context'
    const attribution = kind === 'damage' ? (ctx.parameters.attribution ?? 'current') : 'current'
    if (!['current', 'unattributed'].includes(String(attribution))) throw new Error('伤害归属方式不合法')
    // Keep an explicit empty skill id distinct from an omitted id.  The
    // unattributed policy deliberately passes the JavaScript undefined value
    // through to the authoritative host instead of allowing the runtime's
    // current-context fallback to fill it in.
    const skill = kind === 'damage' && attribution === 'unattributed'
      ? 'undefined'
      : Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId')
        ? ctx.emitLiteral(ctx.parameters.skillId)
        : `String(${context}.skill?.id||${context}.card?.id||${context}.ruleId||"flow")`
    if (captured) {
      if (kind === 'damage') {
        const damageType = ctx.parameters.damageType === 'true' ? 'true' : (ctx.parameters.legacyNormalSpelling ?? 'physical')
        const policy = attribution === 'unattributed' ? ',"unattributed"' : ''
        if (same(targets, 'record')) {
          return `({result:${flow}.effects.authorDamageCaptured(${ctx.inputs.source},${ctx.inputs.target},${ctx.inputs.amount},${ctx.emitLiteral(damageType)},${skill}${policy})})`
        }
        return `({result:${flow}.effects.damageManyCaptured(${ctx.inputs.source},${ctx.inputs.target},${ctx.inputs.amount},${ctx.emitLiteral(damageType)},${skill}${policy})})`
      }
      return `({result:${flow}.effects.healManyCaptured(${ctx.inputs.source},${ctx.inputs.target},${ctx.inputs.amount},${skill})})`
    }
    const killerAttribution = ctx.inputs.killerPlayer === undefined ? '' : `,${ctx.inputs.killerPlayer}`
    return `({result:${flow}.effects.apply(${JSON.stringify(kind)},${ctx.inputs.source},${ctx.emitLiteral(ctx.parameters.sourceType)},${ctx.inputs.target},${ctx.inputs.amount},${ctx.emitLiteral(ctx.parameters.damageType)},${skill}${killerAttribution})})`
  },
}))

/**
 * Typed damage attribution.  The v1/v2 descriptors above deliberately keep
 * their string skillId contracts for old graphs.  Version 3 accepts an
 * authenticated Cluster record instead and converts it at the flow boundary
 * to the legacy event/log identifier without changing settlement behavior.
 */
const TYPED_DAMAGE_MODULE: GameplayModuleDescriptor = {
  id: 'author.effect.damage',
  version: '3',
  label: '造成伤害（能力组归因）',
  description: '通过当前或指定能力组实例归因造成伤害；主动技能默认使用当前能力组，其他入口未填写能力组时不归因。支持单目标、目标元组与保留来源。',
  inputs: [
    { name: 'source', type: 'piece', label: '来源' },
    { name: 'target', type: 'piece', label: '目标' },
    { name: 'amount', type: 'number', label: '伤害量' },
    { name: 'abilityGroup', type: 'record', label: '能力组归因', optional: true },
    { name: 'killerPlayer', type: 'player', label: '击杀归属', optional: true, nullable: true },
  ],
  inputValueTypeBindings: { source: { parameter: 'sourceType' }, target: { parameter: 'targetType' }, amount: { parameter: 'amountType' } },
  outputs: [{ name: 'result', type: 'record', label: '结算结果' }],
  outputValueTypeBindings: { result: { parameter: 'resultType' } },
  parameters: [
    { name: 'sourceType', type: 'string', label: '来源类型', default: 'piece', enum: ['piece', 'player', 'card', 'record'] },
    { name: 'targetType', type: 'string', label: '目标类型', default: 'piece', enum: ['piece', 'record', JSON.stringify(listPiece)] },
    { name: 'amountType', type: 'string', label: '数值类型', default: 'number' },
    { name: 'resultType', type: 'string', label: '结果类型', default: 'record' },
    { name: 'damageType', type: 'string', label: '伤害类型', enum: ['normal', 'true'], default: 'normal' },
    { name: 'legacyNormalSpelling', type: 'string', label: '旧日志伤害名称', enum: ['physical', 'magical'], default: 'physical' },
    { name: 'attribution', type: 'string', label: '归属方式', enum: ['current', 'unattributed'], default: 'current' },
  ],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: false, previewSafe: false, writes: ['damage', 'events'], events: ['beforeDamageDealt', 'afterDamageDealt'] },
  ui: { category: 'effect', authoring: 'standard' },
  lower: ctx => {
    const source = ctx.inputs.source
    const target = ctx.inputs.target
    const amount = ctx.inputs.amount
    if (![source, target, amount].every(value => typeof value === 'string' && value.length > 0)) throw new Error(`module ${ctx.moduleId}: missing damage input`)
    const targets = decode(ctx.parameters.targetType)
    const amountType = decode(ctx.parameters.amountType)
    const result = decode(ctx.parameters.resultType)
    const sourceType = ctx.parameters.sourceType
    const captured = sourceType === 'record'
    const capturedRecordTarget = same(targets, 'record')
    if (captured) {
      if (ctx.inputs.killerPlayer !== undefined) throw new Error('已保留来源不支持覆盖击杀归属，请使用棋子、玩家或手牌来源')
      if (!same(targets, listPiece) && !capturedRecordTarget) throw new Error('已保留来源只能使用棋子元组或保留目标记录')
      if (!same(amountType, 'number')) throw new Error('已保留来源只能使用统一数值')
      if (!same(result, 'record')) throw new Error('已保留来源结果须为批量记录')
    } else {
      if (!same(targets, 'piece') && !same(targets, listPiece)) throw new Error('目标须为棋子或棋子元组')
      if (!same(amountType, 'number') && !same(amountType, listNumber)) throw new Error('数值须为数值或数值元组')
      if (!same(result, same(targets, 'piece') ? 'record' : { kind: 'list', element: 'record' })) throw new Error('结果形状须与目标形状一致')
    }
    const flow = ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
    const hasExplicitGroup = typeof ctx.inputs.abilityGroup === 'string' && ctx.inputs.abilityGroup.length > 0
    // A card or player-rule graph has no guaranteed current Skill/Rule group.
    // Keep its inserted/default damage sentence executable as unattributed;
    // an explicit group input still opts into authenticated attribution.
    const attribution = !hasExplicitGroup && ctx.surface !== 'skill'
      ? 'unattributed'
      : (ctx.parameters.attribution ?? 'current')
    if (!['current', 'unattributed'].includes(String(attribution))) throw new Error('伤害归属方式不合法')
    const group = attribution === 'unattributed'
      ? undefined
      : (typeof ctx.inputs.abilityGroup === 'string' && ctx.inputs.abilityGroup.length > 0
        ? ctx.inputs.abilityGroup
        : `${flow}.clusters.current().group`)
    const skill = attribution === 'unattributed' ? 'undefined' : `${flow}.clusters.attribution(${group})`
    if (captured) {
      const damageType = ctx.parameters.damageType === 'true' ? 'true' : (ctx.parameters.legacyNormalSpelling ?? 'physical')
      const policy = attribution === 'unattributed' ? ',"unattributed"' : ''
      if (capturedRecordTarget) return `({result:${flow}.effects.authorDamageCaptured(${source},${target},${amount},${ctx.emitLiteral(damageType)},${skill}${policy})})`
      return `({result:${flow}.effects.damageManyCaptured(${source},${target},${amount},${ctx.emitLiteral(damageType)},${skill}${policy})})`
    }
    const killerAttribution = ctx.inputs.killerPlayer === undefined ? '' : `,${ctx.inputs.killerPlayer}`
    return `({result:${flow}.effects.apply("damage",${source},${ctx.emitLiteral(ctx.parameters.sourceType)},${target},${amount},${ctx.emitLiteral(ctx.parameters.damageType)},${skill}${killerAttribution})})`
  },
}

export const UNIFIED_AUTHOR_EFFECT_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  ...UNIFIED_AUTHOR_EFFECT_V2_MODULES,
  TYPED_DAMAGE_MODULE,
])
