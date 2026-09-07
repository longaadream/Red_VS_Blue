/** Shared, deterministic authoring compiler. It never executes authored code. */
export const GRAPH_VERSION = 'rvb-skill-graph/v1'
export const COMPILER_VERSION = 'rvb-skill-graph-compiler/v1'
export type NodeKind = 'start' | 'select-piece' | 'select-cell' | 'damage' | 'heal' | 'status' | 'teleport' | 'condition' | 'end'
export interface GraphNode {
  id: string
  kind: NodeKind
  params: Record<string, unknown>
  next?: string
  yes?: string
  no?: string
  x?: number
  y?: number
}
export interface SkillGraph { version: typeof GRAPH_VERSION; entry: string; nodes: GraphNode[] }
type Field = { key: string; label: string; type: 'number' | 'piece' | 'cell' | 'damage' | 'select'; options?: string[]; default: string | number }
export const NODE_CATALOG: Record<NodeKind, { name: string; fields: Field[] }> = {
  start: { name: '主动使用', fields: [] },
  'select-piece': { name: '选择棋子', fields: [
    { key: 'relation', label: '目标关系', type: 'select', options: ['enemy', 'ally', 'all'], default: 'enemy' },
    { key: 'range', label: '距离本棋子不超过（格）', type: 'number', default: 5 },
    { key: 'includeSelf', label: '允许选择本棋子', type: 'select', options: ['no', 'yes'], default: 'no' },
  ] },
  'select-cell': { name: '选择地格', fields: [{ key: 'range', label: '距离本棋子不超过（格）', type: 'number', default: 7 }] },
  damage: { name: '造成伤害', fields: [
    { key: 'target', label: '承受伤害的棋子', type: 'piece', default: 'self' },
    { key: 'damageType', label: '伤害类型', type: 'select', options: ['physical', 'magical', 'true'], default: 'physical' },
    { key: 'basis', label: '计算依据', type: 'select', options: ['fixed', 'attack', 'actualDamage'], default: 'attack' },
    { key: 'value', label: '固定点数／百分比', type: 'number', default: 100 },
    { key: 'source', label: '实际伤害来自哪个伤害节点', type: 'damage', default: '' },
  ] },
  heal: { name: '恢复生命', fields: [
    { key: 'target', label: '恢复生命的棋子', type: 'piece', default: 'self' },
    { key: 'basis', label: '计算依据', type: 'select', options: ['fixed', 'attack', 'actualDamage'], default: 'fixed' },
    { key: 'value', label: '固定点数／百分比', type: 'number', default: 4 },
    { key: 'source', label: '实际伤害来自哪个伤害节点', type: 'damage', default: '' },
  ] },
  status: { name: '获得状态', fields: [
    { key: 'target', label: '状态持有者', type: 'piece', default: 'self' },
    { key: 'status', label: '状态', type: 'select', options: ['root', 'divine-shield'], default: 'root' },
    { key: 'turns', label: '持续回合（圣盾可填-1直到消耗）', type: 'number', default: 1 },
  ] },
  teleport: { name: '传送棋子', fields: [
    { key: 'target', label: '被传送的棋子', type: 'piece', default: 'self' },
    { key: 'cell', label: '落点来自哪个地格节点', type: 'cell', default: '' },
  ] },
  condition: { name: '条件分支', fields: [
    { key: 'target', label: '检查的棋子', type: 'piece', default: 'self' },
    { key: 'test', label: '条件', type: 'select', options: ['hp-below', 'is-self'], default: 'hp-below' },
    { key: 'value', label: '生命值低于最大生命值的百分比', type: 'number', default: 50 },
  ] },
  end: { name: '完成', fields: [] },
}
const names: Record<string, string> = { enemy: '敌方棋子', ally: '友方棋子', all: '棋子', physical: '物理伤害', magical: '法术伤害', true: '真实伤害', root: '定身', 'divine-shield': '圣盾' }
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
const literal = (value: unknown) => JSON.stringify(value)
const fail = (message: string): never => { throw new Error('技能流程图：' + message) }

export function newGraphNode(kind: NodeKind, id: string, x = 60, y = 60): GraphNode {
  return { id, kind, params: Object.fromEntries(NODE_CATALOG[kind].fields.map(field => [field.key, field.default])), x, y }
}
export function createSkillGraph(): SkillGraph {
  return { version: GRAPH_VERSION, entry: 'start', nodes: [
    { ...newGraphNode('start', 'start', 40, 70), next: 'end' }, newGraphNode('end', 'end', 330, 70),
  ] }
}
function validate(input: unknown) {
  if (!input || typeof input !== 'object') fail('缺少图定义')
  const graph = input as SkillGraph
  if (graph.version !== GRAPH_VERSION) fail('不支持的版本')
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 2 || graph.nodes.length > 64) fail('节点数量必须为2至64')
  const byId = new Map<string, GraphNode>()
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(node.id) || byId.has(node.id)) fail('节点ID无效或重复')
    if (!own(NODE_CATALOG, node.kind)) fail(node.id + '：未知节点类型')
    if (!node.params || typeof node.params !== 'object' || Array.isArray(node.params)) fail(node.id + '：参数必须为对象')
    for (const position of [node.x, node.y]) if (position !== undefined && (!Number.isFinite(position) || Math.abs(position) > 10000)) fail(node.id + '：坐标无效')
    for (const key of Object.keys(node.params)) if (!NODE_CATALOG[node.kind].fields.some(field => field.key === key)) fail(node.id + '：未知参数 ' + key)
    for (const field of NODE_CATALOG[node.kind].fields) {
      const value = node.params[field.key]
      if (field.type === 'number') {
        if (!Number.isSafeInteger(value) || Number(value) < (field.key === 'turns' ? -1 : 0) || Number(value) > 10000) fail(node.id + '：数值参数无效 ' + field.key)
      } else if (typeof value !== 'string' || (field.options && !field.options.includes(value))) fail(node.id + '：参数无效 ' + field.key)
    }
    if (node.kind === 'condition' && Number(node.params.value) > 100) fail(node.id + '：生命百分比必须不大于100')
    if (node.kind === 'status' && (node.params.turns === 0 || (node.params.turns === -1 && node.params.status !== 'divine-shield'))) fail(node.id + '：状态需要正整数时长，圣盾可持续到消耗')
    if ((node.kind === 'select-piece' || node.kind === 'select-cell') && Number(node.params.range) > 50) fail(node.id + '：射程不可超过50格')
    byId.set(node.id, node)
  }
  if (byId.get(graph.entry)?.kind !== 'start' || graph.nodes.filter(node => node.kind === 'start').length !== 1) fail('必须有唯一的主动使用入口')
  const edges = (node: GraphNode) => {
    if (node.kind === 'end') {
      if (node.next || node.yes || node.no) fail(node.id + '：完成节点不能有后继')
      return []
    }
    if (node.kind === 'condition') {
      if (node.next || !node.yes || !node.no) fail(node.id + '：请连接是、否两个出口')
      return [node.yes!, node.no!]
    }
    if (!node.next || node.yes || node.no) fail(node.id + '：请连接唯一的下一步')
    return [node.next!]
  }
  const incoming = new Map(graph.nodes.map(node => [node.id, [] as string[]]))
  for (const node of graph.nodes) for (const id of edges(node)) {
    if (!byId.has(id)) fail(node.id + '：连线指向不存在的节点')
    incoming.get(id)!.push(node.id)
  }
  const visited = new Set<string>(), active = new Set<string>(), reverse: GraphNode[] = []
  function visit(id: string) {
    if (active.has(id)) fail('存在循环连线')
    if (visited.has(id)) return
    active.add(id)
    for (const next of edges(byId.get(id)!)) visit(next)
    active.delete(id); visited.add(id); reverse.push(byId.get(id)!)
  }
  visit(graph.entry)
  if (visited.size !== graph.nodes.length) fail('存在未连接到入口的节点')
  const ordered = reverse.reverse(), dominators = new Map<string, Set<string>>()
  for (const node of ordered) {
    const parents = incoming.get(node.id)!
    const common = parents.length ? new Set(dominators.get(parents[0])) : new Set<string>()
    for (const parent of parents.slice(1)) for (const id of common) if (!dominators.get(parent)!.has(id)) common.delete(id)
    dominators.set(node.id, new Set([...common, node.id]))
    function ref(value: unknown, kind: NodeKind, selfAllowed = false) {
      if (selfAllowed && value === 'self') return
      if (typeof value !== 'string' || byId.get(value)?.kind !== kind) fail(node.id + '：数据端口类型不匹配')
      if (value === node.id || !common.has(value as string)) fail(node.id + '：引用的结果必须在所有前置路径中产生')
    }
    if (own(node.params, 'target')) ref(node.params.target, 'select-piece', true)
    if (node.kind === 'teleport') ref(node.params.cell, 'select-cell')
    if ((node.kind === 'damage' || node.kind === 'heal') && node.params.basis === 'actualDamage') ref(node.params.source, 'damage')
  }
  // All choices are an unconditional prefix, matching the current targeting ABI.
  const selections: GraphNode[] = []
  let cursor = byId.get(graph.entry)!.next
  while (cursor && ['select-piece', 'select-cell'].includes(byId.get(cursor)!.kind)) {
    const node = byId.get(cursor)!; selections.push(node); cursor = node.next
  }
  if (selections.length !== graph.nodes.filter(node => ['select-piece', 'select-cell'].includes(node.kind)).length) fail('目标选择必须连续放在所有效果和条件之前')
  return { graph, byId, ordered, selections }
}

export function compileSkillGraph(input: unknown) {
  const { graph, byId, ordered, selections } = validate(input)
  const variable = (id: unknown) => id === 'self' ? 'context.piece' : '_g' + ordered.findIndex(node => node.id === id)
  const label = (id: unknown): string => id === 'self' ? '本棋子' : '目标' + (selections.findIndex(node => node.id === id) + 1)
  const amount = (node: GraphNode) => node.params.basis === 'fixed' ? String(node.params.value)
    : `Math.floor(${node.params.basis === 'attack' ? 'context.piece.attack' : variable(node.params.source) + '.damage'} * ${node.params.value} / 100)`
  const amountText = (node: GraphNode) => node.params.basis === 'fixed' ? node.params.value + '点'
    : `等同于${node.params.basis === 'attack' ? '本棋子攻击力' : ordered.filter(n => n.kind === 'damage').length === 1 ? '本次实际伤害' : '第' + (ordered.filter(n => n.kind === 'damage').findIndex(n => n.id === node.params.source) + 1) + '次伤害的实际扣血量'}${node.params.value}%的`
  const mandatoryTeleports = new Map<string, boolean>()
  function alwaysTeleports(id: string, target: string): boolean {
    const key = id + ':' + target
    if (mandatoryTeleports.has(key)) return mandatoryTeleports.get(key)!
    const node = byId.get(id)!
    const result = node.kind === 'teleport' && node.params.target === target ? true : node.kind === 'end' ? false
      : node.kind === 'condition' ? alwaysTeleports(node.yes!, target) && alwaysTeleports(node.no!, target) : alwaysTeleports(node.next!, target)
    mandatoryTeleports.set(key, result)
    return result
  }
  const targetingSteps = selections.map(node => node.kind === 'select-piece' ? {
    kind: 'target', type: 'piece', range: node.params.range, distanceMetric: 'manhattan', filter: node.params.relation,
    excludeSourcePiece: node.params.includeSelf === 'no',
    ...(alwaysTeleports(node.next!, node.id) ? { forbiddenTargetStatuses: ['imprisoned', 'inoperable'] } : {}),
  } : { kind: 'target', type: 'grid', range: node.params.range, distanceMetric: 'manhattan', filter: 'all', requireWalkable: true, requireUnoccupied: true, forbiddenTileEffectTypes: ['tails-flight-reservation'] })
  const nodeDescriptions: Record<string, string> = {}
  const cases: string[] = []
  for (const node of ordered) {
    const p = node.params, v = variable(node.id), target = variable(p.target)
    let body = '', text = ''
    switch (node.kind) {
      case 'start': text = '主动使用'; break
      case 'select-piece':
      case 'select-cell': {
        const index = selections.indexOf(node), step = targetingSteps[index]
        body = `${v} = selectTarget(${literal({type: step.type, range: step.range, filter: step.filter})}); if (!${v} || ${v}.needsTargetSelection) return ${v};`
        text = node.kind === 'select-piece'
          ? `选择本棋子${p.range}格内1个${p.includeSelf === 'no' && p.relation !== 'enemy' ? '其他' : ''}${names[String(p.relation)]}（${label(node.id)}）`
          : `选择本棋子${p.range}格内1个空的可行走地格（${label(node.id)}）`
        break
      }
      case 'damage':
        body = `if (${target}.currentHp > 0) { ${v} = dealDamage(context.piece, ${target}, ${amount(node)}, ${literal(p.damageType)}, context.battle, context.skill.id); } else { ${v} = { damage: 0 }; }`
        text = `对${label(p.target)}造成${amountText(node)}${names[String(p.damageType)]}`; break
      case 'heal':
        body = `if (${target}.currentHp > 0) ${v} = healDamage(context.piece, ${target}, ${amount(node)}, context.battle, context.skill.id);`
        text = `使${label(p.target)}恢复${amountText(node)}生命`; break
      case 'status': {
        const rules = p.status === 'divine-shield' ? ['rule-divine-shield'] : []
        body = `if (${target}.currentHp > 0) { addStatusEffectById(${target}.instanceId, { id: context.skill.id + ${literal(':' + node.id + ':')} + context.piece.instanceId, sourceId: context.piece.instanceId, type: ${literal(p.status)}, name: ${literal(names[String(p.status)])}, currentDuration: ${p.turns}, currentUses: -1, intensity: 1, stacks: 1, relatedRules: ${literal(rules)} }); ${rules.map(rule => `addRuleById(${target}.instanceId, ${literal(rule)});`).join(' ')} }`
        text = `使${label(p.target)}获得${names[String(p.status)]}${p.turns === -1 ? '' : '，持续' + p.turns + '回合'}`; break
      }
      case 'teleport':
        body = `if (${target}.currentHp > 0) { ${v} = teleport(${variable(p.cell)}.x, ${variable(p.cell)}.y, ${target}.instanceId); if (!${v}.success) return { success: false, message: '传送落点或目标已失效' }; }`
        text = `将${label(p.target)}传送至${label(p.cell)}`; break
      case 'condition':
        body = `_pc = ${p.test === 'is-self' ? target + '.instanceId === context.piece.instanceId' : target + '.currentHp < ' + target + '.maxHp * ' + p.value + ' / 100'} ? ${literal(node.yes)} : ${literal(node.no)};`
        text = p.test === 'is-self' ? `${label(p.target)}是本棋子` : `${label(p.target)}的生命值低于其最大生命值${p.value}%`; break
      case 'end': body = `return { success: true, message: '技能流程结算完成', graphTrace: _trace };`; text = '完成'; break
    }
    nodeDescriptions[node.id] = text
    const trace = `_trace.push({ nodeId: ${literal(node.id)}, kind: ${literal(node.kind)}${node.kind === 'damage' ? ', actualDamage: ' + v + '.damage' : ''} });`
    cases.push(`case ${literal(node.id)}: ${body} ${node.kind === 'end' ? '' : trace} ${node.kind === 'condition' || node.kind === 'end' ? '' : '_pc = ' + literal(node.next) + ';'} break;`)
  }
  let descriptionBudget = 0
  function describe(id: string): string {
    if (++descriptionBudget > 256) fail('分支展开过多，请简化共享后继')
    const node = byId.get(id)!
    if (node.kind === 'end') return ''
    if (node.kind === 'start') return describe(node.next!)
    if (node.kind === 'condition') return `若${nodeDescriptions[id]}，则${describe(node.yes!) || '结束技能。'}否则，${describe(node.no!) || '结束技能。'}`
    return nodeDescriptions[id] + '。' + describe(node.next!)
  }
  const description = describe(graph.entry) || '使用后结束技能。'
  const declarations = ordered.map(node => variable(node.id)).join(', ')
  const code = `function executeSkill(context) { var ${declarations}; var _trace = []; var _pc = ${literal(graph.entry)}; for (var _step = 0; _step < 64; _step++) { switch (_pc) { ${cases.join(' ')} default: throw new Error('无效的技能图节点'); } } throw new Error('技能图超过执行预算'); }`
  const previewCode = `function calculatePreview() { return { description: ${literal(description)}, expectedValues: {} }; }`
  return { compilerVersion: COMPILER_VERSION, description, code, previewCode, targeting: { steps: targetingSteps }, requiresTarget: selections.length > 0, nodeDescriptions }
}

/** Explicit conversion owns generated fields; unrelated extension fields survive. */
export function applySkillGraph(document: Record<string, unknown>, graph: SkillGraph): Record<string, unknown> {
  const compiled = compileSkillGraph(graph)
  const next = { ...document }
  for (const key of ['form', 'targetType', 'filter', 'areaSize', 'targetText', 'statusTag', 'concealTargetInBattleLog', 'rollbackPendingTargetOnCancel', 'summonCapability']) delete next[key]
  return { ...next, skillGraph: graph, graphCompilerVersion: compiled.compilerVersion, kind: 'active', range: 'single',
    description: compiled.description, code: compiled.code, previewCode: compiled.previewCode, targeting: compiled.targeting, requiresTarget: compiled.requiresTarget }
}
export function assertSkillGraphArtifact(input: unknown): void {
  if (!input || typeof input !== 'object' || !own(input, 'skillGraph')) return
  const document = input as Record<string, unknown>
  const expected = applySkillGraph(document, document.skillGraph as SkillGraph)
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  if (canonical(document) !== canonical(expected)) fail('图与生成的描述、代码或目标配置不一致。请重新生成，或明确解除图关联后编辑代码。')
}
