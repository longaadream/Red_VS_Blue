import { parseAuthorExpression, AuthorExpressionError, type AuthorArgument, type AuthorExpression } from './author-expression'
import { getGameplayModule } from './module-registry'
import type { GameplayJsonValue, GameplayModuleSurface, GameplayRecordSchema, GameplayStatement, GameplayValue, GameplayValueType } from './module-types'

export type AuthorEntityDomain =
  | 'tile-effect'
  | 'tile-effects'
  | 'skill-instance'
  | 'skill-instances'
  | 'status-instance'
  | 'status-instances'
  | 'rule-instance'
  | 'rule-instances'
  | 'card-instance'
  | 'card-instances'
  | 'cluster-instance'
  | 'cluster-instances'
export type AuthorExtensionScope = 'piece' | 'player' | 'battle' | 'skill' | 'status' | 'rule' | 'card' | 'cluster' | 'tile-effect'
export type AuthorValue = { value: GameplayValue; type: GameplayValueType; domain?: AuthorEntityDomain; local?: boolean }
export type AuthorExpressionContext = {
  surface: GameplayModuleSurface
  bindings?: Readonly<Record<string, AuthorValue>>
  expectedType?: GameplayValueType
  prefix?: string
  schemas?: readonly GameplayRecordSchema[]
  extensions?: readonly { scope: AuthorExtensionScope; namespace: string; name: string; type: GameplayValueType }[]
  /** Editor-only observation of lexical types; never invoked by generated game code. */
  observeIdentifier?: (name: string, bindings: Readonly<Record<string, AuthorValue>>, schemas: readonly GameplayRecordSchema[], expected?: GameplayValueType) => void
}
export type LoweredAuthorExpression = AuthorValue & { statements: GameplayStatement[]; schemas: GameplayRecordSchema[] }
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const encodedType = (type: GameplayValueType) => typeof type === 'string' ? type : JSON.stringify(type)
const sameType = (a: GameplayValueType, b: GameplayValueType) => JSON.stringify(a) === JSON.stringify(b)
const own = <T>(object: Readonly<Record<string, T>>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined
const number: GameplayValueType = 'number'
export const authorFieldAliases: Readonly<Record<string, string>> = {
  名称: 'name', 阵营: 'faction', 所属玩家: 'ownerPlayerId', 生命值: 'currentHp', 当前生命: 'currentHp', 当前生命值: 'currentHp', 生命上限: 'maxHp', 最大生命: 'maxHp', 攻击力: 'attack', 防御力: 'defense', 移动速度: 'moveRange', 移动范围: 'moveRange',
  核心棋子: 'isCore', 实例标识: 'instanceId', 模板: 'templateId', 状态: 'statusTags', 状态列表: 'statusTags', 规则: 'rules', 技能: 'skills',
  冷却: 'currentCooldown', 剩余次数: 'usesRemaining', 等级: 'level', 所属棋子: 'owner', 技能标识: 'skillId', 能力组: 'abilityGroups',
  行动点: 'actionPoints', 行动点上限: 'maxActionPoints', 充能点: 'chargePoints', 回合数: 'turnNumber', 当前回合玩家: 'currentPlayerId',
  类型: 'type', 强度: 'intensity', 层数: 'stacks', 持续时间: 'currentDuration', 来源: 'sourcePiece', 承受者: 'targetPiece', 伤害量: 'damage', 实际伤害量: 'actualDamage', 成功: 'success', 造成击杀: 'isKilled', 已阻挡: 'blocked', 治疗量: 'heal',
  倍率: 'powerMultiplier', 行动点消耗: 'actionPointCost', 充能点消耗: 'chargeCost', 描述: 'description',
  卡牌标识: 'cardId', 绑定棋子: 'boundPieceInstanceId', 内容状态: 'contentState', 扩展: 'extension',
}
const operators: Readonly<Record<string, string>> = { '+': 'math.add', '-': 'math.subtract', '*': 'math.multiply', '/': 'math.divide', '%': 'math.modulo', '^': 'math.power', '<': 'compare.less-than', '<=': 'compare.less-or-equal', '>': 'compare.greater-than', '>=': 'compare.greater-or-equal', '&&': 'logic.and', '||': 'logic.or' }
export const authorFunctionSpecs: Readonly<Record<string, { module: string; port?: string; args: readonly string[]; labels?: readonly string[] }>> = {
  绝对值: { module: 'math.abs', args: ['value'] }, 最小值: { module: 'math.min', args: ['left', 'right'] }, 最大值: { module: 'math.max', args: ['left', 'right'] },
  集合: { module: 'set.create', args: ['items'], labels: ['元组'] }, 映射: { module: 'map.create', args: ['keys', 'values'], labels: ['键元组', '值元组'] },
  数量: { module: 'collection.length', args: ['items'], labels: ['容器'] }, 反转: { module: 'collection.reverse', args: ['items'], labels: ['容器'], port: 'items' },
  随机项目: { module: 'collection.random', args: ['items'], labels: ['容器'] }, 去重: { module: 'collection.distinct', args: ['items'], labels: ['容器'], port: 'value' },
  包含: { module: 'collection.contains', args: ['items', 'value'], labels: ['容器', '查找值'] }, 首项序号: { module: 'collection.index-of', args: ['items', 'value'], labels: ['容器', '查找值'] },
  截取: { module: 'collection.slice', args: ['items', 'start', 'count'], labels: ['容器', '起始序号', '数量'], port: 'items' }, 拼接: { module: 'collection.concat', args: ['left', 'right'], labels: ['前半部分', '后半部分'], port: 'items' },
  包含键: { module: 'map.has-key', args: ['map', 'key'], labels: ['映射', '键'] }, 键列表: { module: 'map.keys', args: ['map'], labels: ['映射'], port: 'items' }, 值列表: { module: 'map.values', args: ['map'], labels: ['映射'], port: 'items' },
  读取: { module: 'map.get', args: ['map', 'key'], labels: ['映射', '键'] }, 写入: { module: 'map.set', args: ['map', 'key', 'value'], labels: ['映射', '键', '值'] },
  移除: { module: 'map.delete', args: ['map', 'key'], labels: ['容器', '值'] }, 加入: { module: 'set.add', args: ['set', 'value'], labels: ['集合', '值'] },
  转元组: { module: 'set.items', args: ['set'], labels: ['集合'] },
  相对地格范围: { module: 'spatial.relative-cells', args: ['center', 'offsets'], labels: ['中心地格', '相对坐标'], port: 'cells' },
  查询棋子: { module: 'author.query.pieces', args: ['center', 'maximum', 'minimum'], labels: ['中心地格', '最大距离', '最小距离'], port: 'items' }, 查询地格: { module: 'author.query.cells', args: ['center', 'maximum', 'minimum'], labels: ['中心地格', '最大距离', '最小距离'], port: 'items' },
  状态强度: { module: 'status.strength', args: ['piece', 'statusType'], labels: ['棋子', '状态类型'] },
  坐标: { module: 'spatial.cell', args: ['x', 'y'], port: 'cell' }, 距离: { module: 'spatial.cell-distance', args: ['from', 'to'], labels: ['起点', '终点'], port: 'distance' },
}

/** Translate syntax into registered nodes; never execute author text or embed it as code. */
export function lowerAuthorExpression(source: string, options: AuthorExpressionContext): LoweredAuthorExpression {
  const tree = parseAuthorExpression(source)
  let counter = 0
  const schemas = [...(options.schemas ?? [])]
  const id = () => `${options.prefix ?? 'expression'}_${++counter}`
  const fail = (node: AuthorExpression, message: string): never => { throw new AuthorExpressionError(message, node.start) }
  const typeOfLiteral = (value: string | number | boolean | null): GameplayValueType => value === null ? 'null' : typeof value as 'string' | 'number' | 'boolean'
  function call(body: GameplayStatement[], module: string, inputs: Record<string, AuthorValue>, parameters: Record<string, GameplayJsonValue> = {}, port?: string, version?: string): AuthorValue {
    const descriptor = getGameplayModule(module, version)
    if (!descriptor) throw new Error(`未注册作者模块 ${module}`)
    if (!descriptor.allowedSurfaces.includes(options.surface)) throw new Error(`当前入口不支持 ${descriptor.label}`)
    if (descriptor.effects.pure !== true) throw new Error(`表达式不能执行有副作用的语句：${descriptor.label}`)
    const output = descriptor.outputs.find(output => output.name === (port ?? descriptor.outputs[0]?.name))
    if (!output) throw new Error(`模块 ${module} 没有返回值`)
    let type = output.type
    const fromParameter = descriptor.outputParameterTypeBindings?.[output.name]
    if (fromParameter) type = fromParameter.types[String(parameters[fromParameter.parameter])]
    const fromType = descriptor.outputValueTypeBindings?.[output.name]
    if (fromType) {
      const selected = parameters[fromType.parameter]
      type = typeof selected === 'string' && selected.startsWith('{') ? JSON.parse(selected) as GameplayValueType : selected as GameplayValueType
    }
    const binding = descriptor.outputTypeBindings?.[output.name]
    if (binding) {
      const inputType = inputs[binding.input]?.type
      if (!inputType) throw new Error(`缺少泛型输入 ${binding.input}`)
      type = binding.projection === 'same' ? inputType : binding.projection === 'singleton' ? { kind: 'list', element: inputType } : typeof inputType === 'object' && inputType.kind === 'list' ? inputType.element : 'unknown'
    }
    if (!type) throw new Error(`字段未注册：${String(parameters.field)}`)
    const nodeId = id()
    body.push({ kind: 'call', id: nodeId, module, version: descriptor.version, inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value.value])), parameters })
    const domainByModule: Record<string, AuthorEntityDomain> = {
      'ref.current-skill': 'skill-instance',
      'ref.current-card': 'card-instance',
      'ref.current-rule': 'rule-instance',
      'status.query-instances': 'status-instances',
      'status.instances': 'status-instances',
      'status.instances-by-id': 'status-instances',
      'status.find-instance': 'status-instance',
      'skill.instances': 'skill-instances',
      'author.cluster.list': 'cluster-instances',
    }
    const domain = output.name === 'value' || output.name === 'instance' || output.name === 'card' || output.name === 'status' || output.name === 'statuses' || output.name === 'instances' || output.name === 'groups'
      ? domainByModule[module]
      : undefined
    return { value: { kind: 'output', node: nodeId, port: output.name }, type: output.nullable ? { kind: 'nullable', value: type } : type, ...(domain ? { domain } : {}) }
  }
  const unwrapNullable = (type: GameplayValueType): GameplayValueType => typeof type === 'object' && type.kind === 'nullable' ? type.value : type
  const listType = (element: GameplayValueType): GameplayValueType => ({ kind: 'list', element })
  const mapType = (key: GameplayValueType, value: GameplayValueType): GameplayValueType => ({ kind: 'map', key, value })
  const setType = (element: GameplayValueType): GameplayValueType => ({ kind: 'set', element })
  const wildcardType = (type: GameplayValueType): boolean => type === 'any' || type === 'unknown'
  const matchesExpected = (actual: GameplayValueType, expected: GameplayValueType | undefined): boolean => expected === undefined || wildcardType(expected) || sameType(actual, expected)
  const containerModuleVersion = (module: string): string | undefined => getGameplayModule(module, '2') ? '2' : undefined
  const containerParameters = (type: GameplayValueType): Record<string, GameplayJsonValue> => {
    const selected = unwrapNullable(type)
    if (typeof selected === 'object' && selected.kind === 'map') {
      return {
        containerType: encodedType(selected), keyType: encodedType(selected.key), valueType: encodedType(selected.value),
        keysType: encodedType(listType(selected.key)), valuesType: encodedType(listType(selected.value)),
      }
    }
    if (typeof selected === 'object' && selected.kind === 'set') {
      return { containerType: encodedType(selected), valueType: encodedType(selected.element), itemsType: encodedType(listType(selected.element)) }
    }
    throw new Error('此值不是集合或映射')
  }
  const argumentExpressions = (args: readonly AuthorArgument[], member: boolean, names: readonly string[], aliases: readonly (readonly string[])[], node: AuthorExpression): AuthorExpression[] => {
    const supplied = member ? args.slice(1) : args
    if (supplied.length !== (member ? names.length - 1 : names.length)) return fail(node, `参数数量应为${names.length - (member ? 1 : 0)}`)
    const selected: Array<AuthorExpression | undefined> = Array.from({ length: names.length })
    if (member) selected[0] = args[0]?.value
    let next = member ? 1 : 0
    for (const argument of supplied) {
      let index = -1
      if (argument.name) {
        index = names.findIndex((name, position) => position >= (member ? 1 : 0) && (name === argument.name || aliases[position]?.includes(argument.name!)))
      } else {
        while (next < selected.length && selected[next] !== undefined) next += 1
        index = next
      }
      if (index < 0 || index >= selected.length || selected[index] !== undefined) return fail(node, '命名参数不匹配或重复')
      selected[index] = argument.value
    }
    if (selected.some(value => value === undefined)) return fail(node, '缺少参数')
    return selected as AuthorExpression[]
  }
  function containerOperation(name: string, args: readonly AuthorArgument[], member: boolean, body: GameplayStatement[], bindings: Readonly<Record<string, AuthorValue>>, expected: GameplayValueType | undefined, node: AuthorExpression): AuthorValue | undefined {
    if (name === '集合' || name === '映射') {
      if (member) return fail(node, `${name}只能作为函数调用`)
      if (name === '集合') {
        const [itemsExpression] = argumentExpressions(args, false, ['items'], [['元组', '集合', 'items']], node)
        const expectedContainer = unwrapNullable(expected ?? 'unknown')
        const expectedElement = typeof expectedContainer === 'object' && expectedContainer.kind === 'set' ? expectedContainer.element : undefined
        const items = compile(itemsExpression, body, bindings, expectedElement === undefined ? undefined : listType(expectedElement))
        const itemsType = unwrapNullable(items.type)
        if (typeof itemsType !== 'object' || itemsType.kind !== 'list') return fail(node, '集合需要元组作为参数')
        let element = itemsType.element
        if (element === 'never') {
          if (expectedElement === undefined) return fail(node, '集合的空元组需要集合类型上下文')
          element = expectedElement
        }
        if (!matchesExpected(element, expectedElement)) return fail(node, '集合元素类型与上下文不一致')
        const type = setType(element)
        return call(body, 'set.create', { items }, containerParameters(type), undefined, containerModuleVersion('set.create'))
      }
      const [keysExpression, valuesExpression] = argumentExpressions(args, false, ['keys', 'values'], [['键元组', '键', 'keys'], ['值元组', '值', 'values']], node)
      const expectedContainer = unwrapNullable(expected ?? 'unknown')
      const expectedKey = typeof expectedContainer === 'object' && expectedContainer.kind === 'map' ? expectedContainer.key : undefined
      const expectedValue = typeof expectedContainer === 'object' && expectedContainer.kind === 'map' ? expectedContainer.value : undefined
      const keys = compile(keysExpression, body, bindings, expectedKey === undefined ? undefined : listType(expectedKey))
      const values = compile(valuesExpression, body, bindings, expectedValue === undefined ? undefined : listType(expectedValue))
      const keysType = unwrapNullable(keys.type)
      const valuesType = unwrapNullable(values.type)
      if (typeof keysType !== 'object' || keysType.kind !== 'list' || typeof valuesType !== 'object' || valuesType.kind !== 'list') return fail(node, '映射需要两个元组作为参数')
      let key = keysType.element
      let value = valuesType.element
      if (key === 'never') {
        if (expectedKey === undefined) return fail(node, '映射的空键元组需要映射类型上下文')
        key = expectedKey
      }
      if (value === 'never') {
        if (expectedValue === undefined) return fail(node, '映射的空值元组需要映射类型上下文')
        value = expectedValue
      }
      if (!matchesExpected(key, expectedKey) || !matchesExpected(value, expectedValue)) return fail(node, '映射键或值类型与上下文不一致')
      const type = mapType(key, value)
      return call(body, 'map.create', { keys, values }, containerParameters(type), undefined, containerModuleVersion('map.create'))
    }
    const operationNames = new Set(['包含', '包含键', '键列表', '值列表', '数量', '读取', '写入', '移除', '加入', '转元组'])
    if (!operationNames.has(name)) return undefined
    const operationArguments = name === '写入' ? ['container', 'key', 'value'] : name === '数量' || name === '键列表' || name === '值列表' || name === '转元组' ? ['container'] : ['container', 'value']
    const aliases: readonly (readonly string[])[] = [
      ['容器', '集合', '映射', 'map', 'set', 'items'], ['值', '键', '查找值', 'value', 'key'], ['值', 'value'],
    ]
    const expressions = argumentExpressions(args, member, operationArguments, aliases, node)
    const receiver = compile(expressions[0], body, bindings)
    const receiverType = unwrapNullable(receiver.type)
    const isRecord = receiverType === 'record' || typeof receiverType === 'object' && receiverType.kind === 'record'
    const isMap = typeof receiverType === 'object' && receiverType.kind === 'map'
    const isSet = typeof receiverType === 'object' && receiverType.kind === 'set'
    const isList = typeof receiverType === 'object' && receiverType.kind === 'list'
    const legacyVersion = isRecord ? '1' : undefined
    if (name === '包含' && isList) {
      const value = compile(expressions[1], body, bindings, receiverType.element)
      if (!matchesExpected(unwrapNullable(value.type), receiverType.element)) return fail(node, '查找值必须与元组元素类型一致')
      return call(body, 'collection.contains', { items: receiver, value }, { valueType: encodedType(receiverType.element), itemsType: encodedType(receiverType) })
    }
    if (name === '包含' && isSet) {
      const value = compile(expressions[1], body, bindings, receiverType.element)
      if (!matchesExpected(unwrapNullable(value.type), receiverType.element)) return fail(node, '查找值必须与集合元素类型一致')
      return call(body, 'set.contains', { set: receiver, value }, containerParameters(receiverType), undefined, containerModuleVersion('set.contains'))
    }
    if (name === '包含键' && isRecord) {
      const key = compile(expressions[1], body, bindings, 'string')
      return call(body, 'map.has-key', { map: receiver, key }, {}, undefined, legacyVersion)
    }
    if (name === '包含键' && isMap) {
      const key = compile(expressions[1], body, bindings, receiverType.key)
      if (!matchesExpected(unwrapNullable(key.type), receiverType.key)) return fail(node, '映射键类型不一致')
      return call(body, 'map.has-key', { map: receiver, key }, containerParameters(receiverType), undefined, containerModuleVersion('map.has-key'))
    }
    if (name === '键列表' && isRecord) return call(body, 'map.keys', { map: receiver }, {}, 'items', legacyVersion)
    if (name === '键列表' && isMap) return call(body, 'map.keys', { map: receiver }, containerParameters(receiverType), undefined, containerModuleVersion('map.keys'))
    if (name === '值列表' && isRecord) {
      const schema = typeof receiverType === 'object' && receiverType.kind === 'record' ? schemas.find(item => item.id === receiverType.schema || `${item.id}@${item.version}` === receiverType.schema) : undefined
      const element = schema?.fields[0]?.type
      if (!element || schema?.fields.some(field => !sameType(field.type, element))) return fail(node, '映射的值须具有同一类型')
      return call(body, 'map.values', { map: receiver }, { valueType: encodedType(listType(element)) }, 'items', legacyVersion)
    }
    if (name === '值列表' && isMap) return call(body, 'map.values', { map: receiver }, containerParameters(receiverType), undefined, containerModuleVersion('map.values'))
    if (name === '数量' && isList) return call(body, 'collection.length', { items: receiver })
    if (name === '数量' && (isSet || isMap)) {
      const moduleName = isSet ? 'set.count' : 'map.count'
      return call(body, moduleName, isSet ? { set: receiver } : { map: receiver }, containerParameters(receiverType), undefined, containerModuleVersion(moduleName))
    }
    if (name === '读取' && isMap) {
      const key = compile(expressions[1], body, bindings, receiverType.key)
      if (!matchesExpected(unwrapNullable(key.type), receiverType.key)) return fail(node, '映射键类型不一致')
      return call(body, 'map.get', { map: receiver, key }, containerParameters(receiverType), undefined, containerModuleVersion('map.get'))
    }
    if (name === '写入' && isMap) {
      const key = compile(expressions[1], body, bindings, receiverType.key)
      const value = compile(expressions[2], body, bindings, receiverType.value)
      if (!matchesExpected(unwrapNullable(key.type), receiverType.key) || !matchesExpected(unwrapNullable(value.type), receiverType.value)) return fail(node, '映射键或值类型不一致')
      return call(body, 'map.set', { map: receiver, key, value }, containerParameters(receiverType), undefined, containerModuleVersion('map.set'))
    }
    if (name === '移除' && isMap) {
      const key = compile(expressions[1], body, bindings, receiverType.key)
      if (!matchesExpected(unwrapNullable(key.type), receiverType.key)) return fail(node, '映射键类型不一致')
      return call(body, 'map.delete', { map: receiver, key }, containerParameters(receiverType), undefined, containerModuleVersion('map.delete'))
    }
    if (name === '移除' && isSet) {
      const value = compile(expressions[1], body, bindings, receiverType.element)
      if (!matchesExpected(unwrapNullable(value.type), receiverType.element)) return fail(node, '集合元素类型不一致')
      return call(body, 'set.delete', { set: receiver, value }, containerParameters(receiverType), undefined, containerModuleVersion('set.delete'))
    }
    if (name === '加入' && isSet) {
      const value = compile(expressions[1], body, bindings, receiverType.element)
      if (!matchesExpected(unwrapNullable(value.type), receiverType.element)) return fail(node, '集合元素类型不一致')
      return call(body, 'set.add', { set: receiver, value }, containerParameters(receiverType), undefined, containerModuleVersion('set.add'))
    }
    if (name === '转元组' && isSet) return call(body, 'set.items', { set: receiver }, containerParameters(receiverType), undefined, containerModuleVersion('set.items'))
    return fail(node, `此类型不支持函数「${name}」`)
  }
  function compile(node: AuthorExpression, body: GameplayStatement[], bindings: Readonly<Record<string, AuthorValue>>, expected?: GameplayValueType): AuthorValue {
    if (node.kind === 'literal') return { value: literal(node.value), type: typeOfLiteral(node.value) }
    if (node.kind === 'identifier') {
      options.observeIdentifier?.(node.name, bindings, schemas, expected)
      const bound = own(bindings, node.name)
      if (bound) return bound.local
        ? call(body, 'local.read', { handle: { value: bound.value, type: 'record' } }, { valueType: encodedType(bound.type) }, 'value', '1')
        : bound
      const root = own({ 当前棋子: 'ref.holder', 当前玩家: 'ref.player', 当前手牌: 'ref.current-card', 当前技能: 'ref.current-skill', 当前规则: 'ref.current-rule', 目标: 'ref.target' }, node.name)
      if (root) {
        const result = call(body, root, {})
        if (root === 'ref.current-skill') return { ...result, domain: 'skill-instance' }
        if (root === 'ref.current-card') return { ...result, domain: 'card-instance' }
        if (root === 'ref.current-rule') return { ...result, domain: 'rule-instance' }
        return result
      }
      return fail(node, `变量「${node.name}」尚未声明`)
    }
    if (node.kind === 'member') {
      const path: string[] = []
      let receiver: AuthorExpression = node
      while (receiver.kind === 'member' && receiver.field !== 'extension' && receiver.field !== '扩展变量') { path.unshift(receiver.field); receiver = receiver.object }
      if (receiver.kind === 'member' && ['extension', '扩展变量'].includes(receiver.field) && path.length) {
        const global = receiver.object.kind === 'identifier' && ['全局', '当前对局'].includes(receiver.object.name)
        const owner = global ? undefined : compile(receiver.object, body, bindings)
        const ownerType = typeof owner?.type === 'object' && owner.type.kind === 'nullable' ? owner.type.value : owner?.type
        const domainScope: AuthorExtensionScope | undefined = owner?.domain === 'skill-instance' || owner?.domain === 'skill-instances' ? 'skill'
          : owner?.domain === 'status-instance' || owner?.domain === 'status-instances' ? 'status'
            : owner?.domain === 'rule-instance' || owner?.domain === 'rule-instances' ? 'rule'
              : owner?.domain === 'card-instance' || owner?.domain === 'card-instances' ? 'card'
                : owner?.domain === 'cluster-instance' || owner?.domain === 'cluster-instances' ? 'cluster'
                  : owner?.domain === 'tile-effect' || owner?.domain === 'tile-effects' ? 'tile-effect'
                    : undefined
        const scope: AuthorExtensionScope | undefined = global ? 'battle' : domainScope ?? (ownerType === 'piece' || ownerType === 'player' ? ownerType : undefined)
        if (!scope) return fail(node, '此扩展对象的运行引用尚未接通')
        const name = path.shift()!
        const declarations = (options.extensions ?? []).filter(item => item.scope === scope && item.name === name)
        if (declarations.some(item => !sameType(item.type, declarations[0].type) || item.namespace !== declarations[0].namespace)) return fail(node, '此扩展变量存在不同声明，请明确当前对象的类型')
        const declaration = declarations[0]
        let type: GameplayValueType | undefined = declaration?.type
        for (const field of path) {
          if (!type) break
          const ownerType: GameplayValueType = typeof type === 'object' && type.kind === 'nullable' ? type.value : type
          if (ownerType !== 'record' && !(typeof ownerType === 'object' && ownerType.kind === 'record')) return fail(node, '此扩展值没有字段 ' + field)
          const reference: string | undefined = typeof ownerType === 'object' && ownerType.kind === 'record' ? ownerType.schema : undefined
          const schema: GameplayRecordSchema | undefined = reference ? schemas.find(item => item.id === reference || `${item.id}@${item.version}` === reference) : undefined
          if (schema && !schema.fields.some(item => item.name === field)) return fail(node, '此扩展结构中没有字段 ' + field)
          type = schema?.fields.find(item => item.name === field)?.type
        }
        type ??= expected
        if (!type || type === 'unknown' || type === 'any') return fail(node, '请声明此扩展变量的类型，或在明确类型的参数中使用')
        if (scope === 'piece' || scope === 'player' || scope === 'battle') {
          return call(body, `extension.read-${scope}`, owner ? { owner } : {}, { namespace: declaration?.namespace ?? 'content', name, path: path.join('.'), valueType: encodedType(type) }, 'value', scope === 'battle' ? '2' : '1')
        }
        return call(body, 'extension.read-instance', { entity: owner! }, { entityKind: scope, namespace: declaration?.namespace ?? 'content', name, path: path.join('.'), valueType: encodedType(type) }, 'value')
      }
      const field = own(authorFieldAliases, node.field) ?? node.field
      if (node.object.kind === 'identifier' && ['全局', '当前对局'].includes(node.object.name)) {
        if (!['turnNumber', 'currentPlayerId'].includes(field)) return fail(node, '对局仅开放 turnNumber、currentPlayerId 和已声明扩展')
        return call(body, field === 'turnNumber' ? 'turn.number' : 'turn.current-player', {})
      }
      if (node.object.kind === 'identifier' && node.object.name === '当前事件') return call(body, 'event.field', {}, { field })
      const object = compile(node.object, body, bindings)
      const type = typeof object.type === 'object' && object.type.kind === 'nullable' ? object.type.value : object.type
      if (object.domain === 'tile-effect') return call(body, 'tile.effect-field', { effect: object }, { field: node.field === '类型' || node.field === 'type' ? 'tileType' : field })
      if (object.domain === 'skill-instance') return call(body, 'author.skill-instance.field', { instance: object }, { field })
      if (object.domain === 'card-instance') return call(body, 'card.instance-field', { card: object }, { field }, 'value')
      if (type === 'piece' && field === 'abilityGroups') return call(body, 'author.cluster.list', { piece: object }, {}, 'groups')
      if (type === 'piece' && node.field === '位置') return call(body, 'spatial.piece-position', { piece: object })
      if (type === 'piece' || type === 'player') return call(body, `${type}.field`, { [type]: object }, { field }, 'value', type === 'piece' ? '2' : '1')
      if (typeof type === 'object' && type.kind === 'record') {
        const schema = schemas.find(item => item.id === type.schema || `${item.id}@${item.version}` === type.schema)
        const selected = schema?.fields.find(item => item.name === node.field)
        if (!selected) return fail(node, `记录没有字段「${node.field}」`)
        const nodeId = id(); body.push({ kind: 'record.get', id: nodeId, record: object.value, field: node.field })
        return { value: { kind: 'output', node: nodeId, port: 'value' }, type: selected.type }
      }
      if (type === 'record') return call(body, 'data.field', { record: object }, { field }, 'value', '2')
      if (type === 'cell' && ['x', 'y'].includes(field)) return call(body, 'spatial.cell-coordinates', { cell: object }, {}, field)
      if (type === 'cell') {
        const cellField = own({ 可行走: 'walkable', 被占用: 'occupied', 地格效果: 'tileEffects' }, node.field) ?? node.field
        const result = call(body, 'cell.field', { cell: object }, { field: cellField })
        return cellField === 'tileEffects' ? { ...result, domain: 'tile-effects' } : result
      }
      return fail(node, `此类型不提供字段「${node.field}」`)
    }
    if (node.kind === 'index') {
      const items = compile(node.object, body, bindings)
      const itemsType = unwrapNullable(items.type)
      if (typeof itemsType === 'object' && itemsType.kind === 'map') {
        const key = compile(node.index, body, bindings, itemsType.key)
        if (!matchesExpected(unwrapNullable(key.type), itemsType.key)) return fail(node, '映射键类型不一致')
        return call(body, 'map.get', { map: items, key }, containerParameters(itemsType), undefined, containerModuleVersion('map.get'))
      }
      const result = call(body, 'collection.at', { items, position: compile(node.index, body, bindings) })
      const elementDomain: AuthorEntityDomain | undefined = items.domain === 'tile-effects' ? 'tile-effect'
        : items.domain === 'skill-instances' ? 'skill-instance'
          : items.domain === 'status-instances' ? 'status-instance'
            : items.domain === 'rule-instances' ? 'rule-instance'
              : items.domain === 'card-instances' ? 'card-instance'
                : items.domain === 'cluster-instances' ? 'cluster-instance'
                  : undefined
      return elementDomain ? { ...result, domain: elementDomain } : result
    }
    if (node.kind === 'unary') {
      const operand = compile(node.operand, body, bindings)
      if (node.operator === '!') return call(body, 'logic.not', { value: operand })
      if (node.operator === '+') { if (operand.type !== 'number') return fail(node, '正号只能用于数值'); return operand }
      return call(body, 'math.floor', { value: call(body, 'math.subtract', { left: { value: literal(0), type: number }, right: operand }) })
    }
    if (node.kind === 'binary') {
      const arithmetic = ['+', '-', '*', '/', '%', '^', '<', '<=', '>', '>='].includes(node.operator)
      const left = compile(node.left, body, bindings, arithmetic ? 'number' : node.operator === '&&' || node.operator === '||' ? 'boolean' : undefined)
      if (node.operator === '&&' || node.operator === '||') {
        if (left.type !== 'boolean') return fail(node, '逻辑运算需要布尔值')
        const captures: Record<string, GameplayValue> = { condition: left.value }
        const inner: Record<string, AuthorValue> = {}
        for (const [name, value] of Object.entries(bindings)) {
          const key = id(); captures[key] = value.value; inner[name] = { ...value, value: { kind: 'input', name: key } }
        }
        const rightBody: GameplayStatement[] = []
        const right = compile(node.right, rightBody, inner)
        if (right.type !== 'boolean') return fail(node, '逻辑运算需要布尔值')
        rightBody.push({ kind: 'return', id: id(), value: right.value })
        const constant: GameplayStatement[] = [{ kind: 'return', id: id(), value: literal(node.operator === '||') }]
        const collectionId = id()
        body.push({ kind: 'collection', id: collectionId, method: 'map', items: literal([0]), inputs: captures, body: [{ kind: 'if', id: id(), condition: { kind: 'input', name: 'condition' }, then: node.operator === '&&' ? rightBody : constant, else: node.operator === '&&' ? constant : rightBody }] })
        return call(body, 'collection.at', { items: { value: { kind: 'output', node: collectionId, port: 'value' }, type: { kind: 'list', element: 'boolean' } }, position: { value: literal(1), type: 'number' } })
      }
      const right = compile(node.right, body, bindings, left.type)
      if (['==', '!='].includes(node.operator)) {
        if (!sameType(left.type, right.type)) return fail(node, '比较值的类型必须一致')
        return call(body, 'compare.values', { left, right }, { operator: node.operator, valueType: encodedType(left.type) })
      }
      const result = call(body, operators[node.operator], { left, right })
      // Author arithmetic follows the agreed integer-result semantics. Keep
      // decimal literals available as coefficients; floor computed numbers.
      return result.type === 'number' ? call(body, 'math.floor', { value: result }) : result
    }
    if (node.kind === 'tuple') {
      if (!node.items.length) return { value: literal([]), type: expected && typeof expected === 'object' && expected.kind === 'list' ? expected : { kind: 'list', element: 'never' } }
      const items = node.items.map(item => compile(item, body, bindings))
      const first = items[0].type
      if (items.some(item => !sameType(item.type, first))) return fail(node, '元组各项类型必须一致')
      let result = call(body, 'collection.singleton', { value: items[0] }, { valueType: encodedType(first) }, 'items')
      for (const item of items.slice(1)) {
        const next = call(body, 'collection.singleton', { value: item }, { valueType: encodedType(first) }, 'items')
        result = call(body, 'collection.concat', { left: result, right: next }, { valueType: encodedType(result.type) }, 'items')
      }
      return result
    }
    if (node.kind === 'object') {
      const values = node.fields.map(field => ({ name: field.name, ...compile(field.value, body, bindings) }))
      const fields = values.map(field => ({ name: field.name, type: field.type }))
      // Object literals with the same shape are interchangeable values in a
      // tuple.  Reusing the first generated schema keeps a tuple such as
      // {{name: "result", type: "boolean"}, {name: "detail", type:
      // "boolean"}} homogeneous while retaining nominal schemas for objects
      // whose field types or order differ.
      const equivalent = schemas.find(schema => {
        if (schema.fields.length !== fields.length) return false
        return schema.fields.every((field, index) => {
          const other = fields[index]
          // A fresh object literal is a closed, required, non-nullable record.
          // Do not reuse a wider schema that permits omission or null even when
          // its visible field names and value types otherwise match.
          return field.optional !== true
            && field.nullable !== true
            && field.name === other.name
            && sameType(field.type, other.type)
        })
      })
      const schemaId = equivalent?.id ?? id()
      const schemaVersion = equivalent?.version ?? '1'
      if (!equivalent) schemas.push({ id: schemaId, version: schemaVersion, fields })
      const nodeId = id()
      const schemaReference = `${schemaId}@${schemaVersion}`
      body.push({ kind: 'record.create', id: nodeId, schema: schemaReference, fields: Object.fromEntries(values.map(field => [field.name, field.value])) })
      return { value: { kind: 'output', node: nodeId, port: 'value' }, type: { kind: 'record', schema: schemaReference } }
    }
    if (node.kind === 'call') {
      const member = node.callee.kind === 'member' ? node.callee : undefined
      const name = member?.field ?? (node.callee.kind === 'identifier' ? node.callee.name : '')
      const args = [...(member ? [{ value: member.object }] : []), ...node.arguments]
      const container = containerOperation(name, args, member !== undefined, body, bindings, expected, node)
      if (container) return container
      const methods: Record<string, 'map' | 'filter' | 'find'> = { 逐项变换: 'map', 筛选: 'filter', 查找首项: 'find' }
      if (own(methods, name) || name === '任意满足' || name === '全部满足') {
        if (args.length !== 2) return fail(node, `${name}需要容器和条件表达式`)
        const items = compile(args[0].value, body, bindings)
        if (typeof items.type !== 'object' || items.type.kind !== 'list') return fail(node, '此函数需要元组或集合')
        const childBindings: Record<string, AuthorValue> = {}; const captures: Record<string, GameplayValue> = {}
        for (const [key, value] of Object.entries(bindings)) {
          if (key === '每项') continue
          const capture = id(); captures[capture] = value.value; childBindings[key] = { ...value, value: { kind: 'input', name: capture } }
        }
        const childDomain: AuthorEntityDomain | undefined = items.domain === 'tile-effects' ? 'tile-effect'
          : items.domain === 'skill-instances' ? 'skill-instance'
            : items.domain === 'status-instances' ? 'status-instance'
              : items.domain === 'rule-instances' ? 'rule-instance'
                : items.domain === 'card-instances' ? 'card-instance'
                  : items.domain === 'cluster-instances' ? 'cluster-instance'
                    : undefined
        childBindings.每项 = { value: { kind: 'input', name: 'item' }, type: items.type.element, ...(childDomain ? { domain: childDomain } : {}) }
        const child: GameplayStatement[] = []
        const predicate = compile(args[1].value, child, childBindings, name === '逐项变换' ? undefined : 'boolean')
        child.push({ kind: 'return', id: id(), value: predicate.value })
        const nodeId = id(); const method = own(methods, name) ?? 'filter'
        body.push({ kind: 'collection', id: nodeId, method, items: items.value, inputs: captures, body: child })
        const result: AuthorValue = { value: { kind: 'output', node: nodeId, port: 'value' }, type: method === 'map' ? { kind: 'list', element: predicate.type } : method === 'find' ? { kind: 'nullable', value: items.type.element } : items.type }
        if (own(methods, name)) {
          if (method === 'map' && predicate.domain === 'tile-effect') result.domain = 'tile-effects'
          if (method !== 'map' && items.domain === 'tile-effects') result.domain = method === 'find' ? 'tile-effect' : 'tile-effects'
          if (method === 'map' && predicate.domain && predicate.domain.endsWith('-instance')) result.domain = `${predicate.domain}s` as AuthorEntityDomain
          if (method !== 'map' && items.domain && items.domain.endsWith('-instances')) result.domain = method === 'find' ? items.domain.replace(/-instances$/u, '-instance') as AuthorEntityDomain : items.domain
          return result
        }
        const count = call(body, 'collection.length', { items: result })
        if (name === '任意满足') return call(body, 'compare.greater-than', { left: count, right: { value: literal(0), type: number } })
        return call(body, 'compare.equal', { left: count, right: call(body, 'collection.length', { items }) })
      }
      const spec = own(authorFunctionSpecs, name)
      if (!spec) return fail(node, `函数「${name}」尚未注册`)
      const inputs: Record<string, AuthorValue> = {}
      for (const [index, arg] of args.entries()) {
        const key = arg.name ? spec.args.find((key, i) => key === arg.name || spec.labels?.[i] === arg.name) : spec.args[index]
        if (!key || inputs[key]) return fail(node, `函数「${name}」的参数不匹配`)
        const parameterType = getGameplayModule(spec.module)?.inputs.find(input => input.name === key)?.type
        inputs[key] = compile(arg.value, body, bindings, parameterType)
      }
      const parameters: Record<string, GameplayJsonValue> = {}
      if (name === '包含' || name === '首项序号') {
        const type = inputs.items?.type
        if (typeof type !== 'object' || type.kind !== 'list' || !sameType(type.element, inputs.value?.type)) return fail(node, '查找值必须与容器元素类型一致')
        parameters.valueType = encodedType(type.element)
        parameters.itemsType = encodedType(type)
      }
      if (name === '去重' || name === '拼接') parameters.valueType = encodedType(inputs.items?.type ?? inputs.left.type)
      if (name === '值列表') {
        const type = inputs.map?.type
        const schema = typeof type === 'object' && type.kind === 'record' ? schemas.find(schema => schema.id === type.schema || `${schema.id}@${schema.version}` === type.schema) : undefined
        const element = schema?.fields[0]?.type
        if (!element || schema?.fields.some(field => !sameType(field.type, element))) return fail(node, '映射的值须具有同一类型')
        parameters.valueType = encodedType({ kind: 'list', element })
      }
      const result = call(body, spec.module, inputs, parameters, spec.port)
      if (inputs.items?.domain === 'tile-effects' && ['反转', '截取', '去重'].includes(name)) result.domain = 'tile-effects'
      if (inputs.items?.domain === 'tile-effects' && name === '随机项目') result.domain = 'tile-effect'
      if (inputs.left?.domain === 'tile-effects' && inputs.right?.domain === 'tile-effects' && name === '拼接') result.domain = 'tile-effects'
      return result
    }
    return fail(node, '不支持的表达式')
  }
  const statements: GameplayStatement[] = []
  const value = compile(tree, statements, options.bindings ?? {}, options.expectedType)
  return { ...value, statements, schemas }
}
