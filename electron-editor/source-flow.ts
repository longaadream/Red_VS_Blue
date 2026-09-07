import ts from 'typescript'
import { createHash } from 'node:crypto'

export type FlowCategory = 'skills' | 'rules'
export interface FlowNode {
  id: string; kind: string; label: string; source: string; start: number; end: number
  section?: string; calls: string[]; opaque?: boolean
}
export interface FlowSection { id: string; label: string; nodes: FlowNode[]; edges: Array<{ from: string; to: string; label: string }> }
export interface FlowField {
  key: string; source: string; hash: string; entry: string; sections: FlowSection[]
  diagnostics: string[]; readOnly?: boolean
}
export interface ContentFlow {
  version: 'rvb-source-flow/v1'; id: string; name: string; category: FlowCategory; context: string
  fields: FlowField[]; links: Array<{ category: FlowCategory; id: string; reason: string }>
  summary: { nodes: number; opaque: number; functions: number }; notes: string[]
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const captions: Record<string, string> = {
  dealDamage: '造成伤害', healDamage: '恢复生命', selectTarget: '选择目标', selectOption: '选择选项',
  addStatusEffectById: '棋子获得状态', removeStatusEffectById: '移除棋子状态', addPlayerStatusEffectById: '玩家获得状态',
  addRuleById: '安装棋子规则', addPlayerRuleById: '安装玩家规则', removeRuleById: '移除规则',
  addSkillById: '获得技能', removeSkillById: '移除技能', teleport: '传送', traceProjectile: '弹射物路径',
  fireEvent: '发送游戏事件', summonPiece: '召唤棋子', changePositions: '改变位置', createPiece: '创建棋子',
  floor: '向下取整', random: '随机数（由现役运行器处理）', find: '查找', filter: '筛选', map: '映射', forEach: '逐项处理',
}
const short = (value: string, max = 110) => value.replace(/\s+/g, ' ').trim().slice(0, max)
const isFunction = (node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
const callName = (node: ts.CallExpression) => ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText()
function parseField(key: string, source: string, nested = false): FlowField {
  if (source.length > 200_000) throw new Error('单个脚本超过200000字符分析预算')
  const prefix = /^\s*function\s*\(/.test(source) ? '(' : ''
  const tree = ts.createSourceFile('flow.js', prefix + source + (prefix ? ')' : ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
    .map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
  const result: FlowField = { key, source, hash: sha(source), entry: 'main', sections: [], diagnostics, readOnly: nested }
  if (diagnostics.length) return result
  const functions: Array<ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration> = []
  const collect = (node: ts.Node) => { if (isFunction(node) && node.body) functions.push(node); ts.forEachChild(node, collect) }
  collect(tree)
  if (functions.length > 300) throw new Error('函数数量超过分析预算')
  const sectionIds = new Map<ts.Node, string>(functions.map((node, i) => [node, 'function-' + i]))
  const named = new Map<string, string>()
  for (const fn of functions) if (fn.name) named.set(fn.name.getText(tree), sectionIds.get(fn)!)
  let totalNodes = 0
  function makeSection(id: string, label: string, statements: readonly ts.Statement[], expression?: ts.Expression) {
    const section: FlowSection = { id, label, nodes: [], edges: [] }
    result.sections.push(section)
    let serial = 0
    const slice = (n: ts.Node) => source.slice(Math.max(0, n.getStart(tree) - prefix.length), n.end - prefix.length)
    const add = (kind: string, label: string, n?: ts.Node, opaque = false): string => {
      if (++totalNodes > 4000) throw new Error('流程超过4000节点分析预算')
      const calls: string[] = []
      if (n) {
        const visit = (child: ts.Node) => {
          if (child !== n && isFunction(child)) return
          if (ts.isCallExpression(child)) calls.push(callName(child))
          ts.forEachChild(child, visit)
        }
        visit(n)
      }
      const nodeId = id + ':' + serial++
      section.nodes.push({ id: nodeId, kind, label, source: n ? slice(n) : '', start: n ? n.getStart(tree) - prefix.length : -1,
        end: n ? n.end - prefix.length : -1, calls: [...new Set(calls)], ...(opaque ? { opaque: true } : {}) })
      return nodeId
    }
    const edge = (from: string, to: string, label = '') => { section.edges.push({ from, to, label }) }
    const entry = add('entry', label), end = add('exit', '返回调用方'), thrown = add('throw-exit', '异常退出')
    type Targets = { break?: string; continue?: string }
    function sequence(items: readonly ts.Statement[], next: string, targets: Targets, depth: number): string {
      let first = next
      for (let index = items.length - 1; index >= 0; index--) first = statement(items[index], first, targets, depth + 1)
      return first
    }
    function statement(n: ts.Statement, next: string, targets: Targets, depth: number): string {
      if (depth > 100) throw new Error('语法嵌套超过分析预算')
      if (ts.isBlock(n)) return sequence(n.statements, next, targets, depth + 1)
      if (ts.isEmptyStatement(n)) return next
      if (ts.isIfStatement(n)) {
        const test = add('condition', '若 ' + short(slice(n.expression)), n.expression)
        edge(test, statement(n.thenStatement, next, targets, depth + 1), '是')
        edge(test, n.elseStatement ? statement(n.elseStatement, next, targets, depth + 1) : next, '否')
        return test
      }
      if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) {
        const condition = ts.isForStatement(n) ? n.condition : n.expression
        const head = add('loop', ts.isForOfStatement(n) || ts.isForInStatement(n) ? '遍历 ' + short(slice(n.expression)) :
          '循环条件 ' + short(condition ? slice(condition) : '始终成立'),
        ts.isForStatement(n) ? n.condition : n.expression)
        let resume = head
        if (ts.isForStatement(n) && n.incrementor) { resume = add('operation', '更新循环变量', n.incrementor); edge(resume, head, '重查条件') }
        if (ts.isForOfStatement(n) || ts.isForInStatement(n)) { resume = add('operation', '取下一项并绑定 ' + short(slice(n.initializer)), n.initializer); edge(head, resume, '有下一项') }
        const body = statement(n.statement, ts.isForOfStatement(n) || ts.isForInStatement(n) ? head : resume,
          { break: next, continue: ts.isForOfStatement(n) || ts.isForInStatement(n) ? head : resume }, depth + 1)
        if (ts.isForOfStatement(n) || ts.isForInStatement(n)) edge(resume, body)
        else edge(head, body, '是')
        if (!(ts.isForStatement(n) && !n.condition)) edge(head, next, '否 / 遍历结束')
        if (ts.isDoStatement(n)) return body
        if (ts.isForStatement(n) && n.initializer) { const init = add('operation', '初始化循环', n.initializer); edge(init, head); return init }
        return head
      }
      if (ts.isSwitchStatement(n)) {
        const choice = add('condition', '按值分支 ' + short(slice(n.expression)), n.expression)
        let fallthrough = next, hasDefault = false
        for (let i = n.caseBlock.clauses.length - 1; i >= 0; i--) {
          const clause = n.caseBlock.clauses[i]
          const first = sequence(clause.statements, fallthrough, { ...targets, break: next }, depth + 1)
          edge(choice, first, ts.isCaseClause(clause) ? short(slice(clause.expression)) : '默认')
          hasDefault ||= ts.isDefaultClause(clause); fallthrough = first
        }
        if (!hasDefault) edge(choice, next, '无匹配')
        return choice
      }
      if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
        const node = add(ts.isReturnStatement(n) ? 'return' : 'throw', (ts.isReturnStatement(n) ? '返回：' : '抛出：') + short(n.expression ? slice(n.expression) : ''), n)
        edge(node, ts.isReturnStatement(n) ? end : thrown); return node
      }
      if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
        const target = ts.isBreakStatement(n) ? targets.break : targets.continue
        const node = add('jump', ts.isBreakStatement(n) ? '退出当前循环/分支' : '进入下一次循环', n, Boolean(n.label || !target))
        if (!n.label && target) edge(node, target)
        return node
      }
      if (ts.isFunctionDeclaration(n)) {
        const node = add('definition', '定义函数 ' + (n.name?.text || '匿名函数'), n)
        section.nodes.find(item => item.id === node)!.section = sectionIds.get(n)
        edge(node, next); return node
      }
      const opaque = !(ts.isVariableStatement(n) || ts.isExpressionStatement(n))
      const node = add(opaque ? 'opaque' : 'operation', opaque ? '未展开语法：' + ts.SyntaxKind[n.kind] : '', n, opaque)
      const item = section.nodes.find(item => item.id === node)!
      item.label ||= item.calls.map(name => captions[name] || name).slice(0, 3).join(' → ') || (ts.isVariableStatement(n) ? '读取 / 计算' : '更新 / 执行')
      // Function bodies are separate sections, never inserted into the immediate execution chain.
      const callback = functions.find(fn => fn.getStart(tree) >= n.getStart(tree) && fn.end <= n.end)
      item.section = callback ? sectionIds.get(callback) : item.calls.map(name => named.get(name)).find(Boolean)
      edge(node, next, opaque ? '可能继续（内部控制流未展开）' : '')
      return node
    }
    if (expression) { const value = add('return', '返回表达式', expression); edge(entry, value); edge(value, end) }
    else edge(entry, sequence(statements, end, {}, 0))
    // Render only nodes reachable from the section entry; dead statements remain available in the source editor.
    const reachable = new Set<string>()
    const visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const e of section.edges) if (e.from === id) visit(e.to) }
    visit(entry)
    section.nodes = section.nodes.filter(n => reachable.has(n.id))
    section.edges = section.edges.filter(e => reachable.has(e.from) && reachable.has(e.to))
  }
  makeSection('main', '脚本顶层', tree.statements)
  for (const fn of functions) {
    const name = fn.name?.getText(tree) || (ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText(tree) : '回调 / 匿名函数')
    makeSection(sectionIds.get(fn)!, name, ts.isBlock(fn.body!) ? (fn.body as ts.Block).statements : [], ts.isBlock(fn.body!) ? undefined : fn.body as ts.Expression)
    if (name === 'executeSkill' || name === 'executeCard' || prefix && fn === functions[0]) result.entry = sectionIds.get(fn)!
  }
  return result
}
export function analyzeContentFlow(category: FlowCategory, document: Record<string, unknown>, pieceTemplates: Array<Record<string, unknown>> = []): ContentFlow {
  if (!['skills', 'rules'].includes(category) || !document || typeof document !== 'object' || Array.isArray(document)) throw new Error('只支持技能或规则对象')
  const result: ContentFlow = { version: 'rvb-source-flow/v1', category, id: String(document.id || ''), name: String(document.name || ''),
    context: category === 'rules' ? '规则入口：持有者=context.rulePiece；事件来源=context.sourcePiece；context.piece不保证是持有者。' :
      '技能主动入口：本棋子=context.piece。若被规则triggerSkill调用，实际接口和对象绑定不同，需按规则入口核查。',
    fields: [], links: [], summary: { nodes: 0, opaque: 0, functions: 0 },
    notes: ['源码流程是静态投影，不执行代码，也不代表所有逻辑已转换为纯参数节点。表达式内部短路/三元判断保留在节点源码中；函数和回调在独立子流程中展示。'] }
  const link = (category: FlowCategory, id: unknown, reason: string) => {
    if (typeof id === 'string' && /^[a-zA-Z0-9_.-]+$/.test(id) && !result.links.some(item => item.category === category && item.id === id)) result.links.push({ category, id, reason })
  }
  for (const id of Array.isArray(document.relatedRules) ? document.relatedRules : []) link('rules', id, '关联规则')
  for (const id of Array.isArray(document.relatedSkills) ? document.relatedSkills : []) link('skills', id, '关联技能')
  if (category === 'skills') for (const piece of pieceTemplates) {
    const skills = Array.isArray(piece.skills) ? piece.skills : []
    if (!skills.some(skill => typeof skill === 'string' ? skill === document.id : skill && skill.skillId === document.id)) continue
    for (const rule of Array.isArray(piece.rules) ? piece.rules : []) link('rules', typeof rule === 'string' ? rule : rule?.id,
      '同棋子装配规则（' + String(piece.name || piece.id) + '，不等同于技能调用）')
  }
  const effect = document.effect as { type?: string; params?: { skillId?: string }; skillId?: string } | undefined
  if (effect?.type === 'triggerSkill') link('skills', effect.params?.skillId || effect.skillId, '触发技能（受限规则调用环境）')
  if (category === 'rules') result.notes.unshift('触发配置：' + JSON.stringify(document.trigger || {}) + '；优先级：' + String(document.priority ?? '运行时默认'))
  if (Array.isArray(document.passiveTraits)) result.notes.unshift('开局公共被动：' + document.passiveTraits.join('、'))
  for (const key of ['code', 'skillCode', 'effectCode', 'previewCode']) {
    const source = document[key]
    if (typeof source !== 'string' || !source.trim()) continue
    const field = parseField(key, source); result.fields.push(field)
    const tree = ts.createSourceFile(key + '.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = callName(node)
        const group = /(?:add|remove|load)(?:Player)?RuleById/.test(name) ? 'rules' : /(?:add|remove|load)SkillById/.test(name) ? 'skills' : null
        const arg = node.arguments[name.startsWith('load') ? 0 : 1]
        if (group && arg && ts.isStringLiteralLike(arg)) link(group, arg.text, '脚本：' + name)
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/['"]/g, '') === 'effectCode' && ts.isStringLiteralLike(node.initializer)) {
        result.fields.push(parseField(key + '.pending@' + node.pos, node.initializer.text, true))
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  if (!result.fields.length) {
    const section: FlowSection = { id: 'main', label: category === 'rules' ? '事件路由' : '被动装配', nodes: [], edges: [] }
    const node = (id: string, label: string, source = ''): FlowNode => ({ id, kind: id === 'entry' ? 'entry' : 'operation', label, source, start: -1, end: -1, calls: [] })
    section.nodes.push(node('entry', category === 'rules' ? '规则触发：' + JSON.stringify(document.trigger || {}) : '加载棋子技能'))
    if (document.targetValidation) {
      section.nodes.push(node('validation', '公共目标校验', JSON.stringify(document.targetValidation, null, 2)))
      section.edges.push({ from: 'entry', to: 'validation', label: '校验目标时' })
    } else if (effect) {
      section.nodes.push(node('effect', effect.type === 'triggerSkill' ? '调用关联技能的 SkillCode' : '执行声明效果', JSON.stringify(effect, null, 2)))
      section.edges.push({ from: 'entry', to: 'effect', label: '检查条件与规则限用后' })
    } else {
      const labels = [...result.links.map(l => l.reason + '：' + l.id), ...(Array.isArray(document.passiveTraits) ? document.passiveTraits.map(String) : [])]
      labels.forEach((label, i) => { section.nodes.push(node('binding-' + i, label)); section.edges.push({ from: 'entry', to: 'binding-' + i, label: '装配关联能力（非执行顺序）' }) })
    }
    result.fields.push({ key: '声明入口', source: '', hash: sha(JSON.stringify(document)), entry: 'main', sections: [section], diagnostics: [], readOnly: true })
    result.notes.push('声明入口只展示路由；关联技能/规则可从上方打开，触发条件、优先级与限用仍由规则系统结算。')
  }
  for (const field of result.fields) for (const section of field.sections) {
    result.summary.nodes += section.nodes.length; result.summary.opaque += section.nodes.filter(n => n.opaque).length
    if (section.id !== 'main') result.summary.functions++
  }
  if (!result.fields.length) result.notes.push('本定义没有内联脚本，行为来自关联规则、触发技能或公共开局接口；请沿关联入口查看。')
  return result
}
export function editFlowNode(category: FlowCategory, document: Record<string, unknown>, request: { field: string; hash: string; section: string; node: string; replacement: string }): Record<string, unknown> {
  if (!request || typeof request.replacement !== 'string' || request.replacement.length > 200_000) throw new Error('节点修改参数无效')
  if (document.skillGraph) throw new Error('此内容由类型化技能图生成，请在原图中修改或先显式解除关联')
  const flow = analyzeContentFlow(category, document), field = flow.fields.find(f => f.key === request.field)
  if (!field || field.readOnly || field.hash !== request.hash) throw new Error('源码已改变或为内嵌只读回调，请重新读取流程')
  const node = field.sections.find(s => s.id === request.section)?.nodes.find(n => n.id === request.node)
  if (!node || node.start < 0) throw new Error('此节点没有可替换的源码范围')
  const source = field.source.slice(0, node.start) + request.replacement + field.source.slice(node.end)
  const checked = parseField(field.key, source)
  if (checked.diagnostics.length) throw new Error('修改后语法无效：' + checked.diagnostics.join('；'))
  return { ...document, [field.key]: source }
}
