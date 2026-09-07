import * as fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { resolveEditorWorkspacePathV1 } from './content-pipeline-ipc'

type Manifest = Record<string, string>
type Task = { schema: 'rvb-creative-task/v1'; id: string; title: string; brief: string; criteria: string; createdAt: string; baseline: Manifest; baselineHash: string }
type Issue = { severity: 'error' | 'warning'; path: string; message: string }
type Check = { contentHash: string; checkedAt: string; issues: Issue[]; runtimeVerified: false }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const manifestHash = (value: Manifest) => digest(JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
const now = () => new Date().toISOString()
function text(value: unknown, name: string, max = 12000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不能为空，且不能超过 ${max} 字符`)
  return value.trim()
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

export class CreativeWorkbench {
  constructor(private root: string, private bundledRoot: string, private launcher: string[] = []) {
    if (!path.isAbsolute(root) || fs.lstatSync(root).isSymbolicLink()) throw new Error('无效的工作区路径')
    this.root = fs.realpathSync(root)
    this.directory('.workbench/tasks')
    this.directory('.workbench/objects')
  }

  private file(relative: string, intent: 'read' | 'write' = 'read') {
    if (fs.realpathSync(this.root) !== this.root || fs.lstatSync(this.root).isSymbolicLink()) throw new Error('工作区路径发生变化')
    return resolveEditorWorkspacePathV1(this.root, relative, 'workbench', intent)
  }
  private directory(relative: string) { fs.mkdirSync(this.file(relative, 'write'), { recursive: true }) }
  private read(relative: string): unknown {
    const file = this.file(relative)
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('任务记录超出大小限制')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  private writeNew(relative: string, value: unknown) {
    const file = this.file(relative, 'write')
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  }
  private replace(relative: string, value: unknown) {
    const temporary = `${relative}.${randomUUID()}.tmp`
    this.writeNew(temporary, value)
    try { fs.renameSync(this.file(temporary), this.file(relative, 'write')) }
    finally { const file = this.file(temporary, 'write'); if (fs.existsSync(file)) fs.unlinkSync(file) }
  }
  private checkRecord(relative: string, hash: string): Check | null {
    if (!fs.existsSync(this.file(relative, 'write'))) return null
    const value = this.read(relative)
    if (!record(value) || value.contentHash !== hash || value.runtimeVerified !== false || typeof value.checkedAt !== 'string' || !Array.isArray(value.issues)
      || !value.issues.every(issue => record(issue) && ['error', 'warning'].includes(String(issue.severity)) && typeof issue.path === 'string' && typeof issue.message === 'string')) return null
    return value as Check
  }
  private id(id: string) { if (!UUID.test(id)) throw new Error('无效的任务编号'); return `.workbench/tasks/${id}` }
  private task(id: string): Task {
    const value = this.read(this.id(id) + '/task.json')
    if (!record(value) || value.schema !== 'rvb-creative-task/v1' || value.id !== id || !record(value.baseline)) throw new Error('任务记录格式错误')
    for (const [relative, hash] of Object.entries(value.baseline)) {
      if (!/^(data|images)\//.test(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || typeof hash !== 'string' || !HASH.test(hash)) throw new Error('任务快照记录错误')
    }
    if (manifestHash(value.baseline as Manifest) !== value.baselineHash) throw new Error('任务基准校验失败')
    text(value.title, '任务名称', 120); text(value.brief, '需求'); text(value.criteria, '验收条件')
    return value as Task
  }
  private scan(storeObjects = false): Manifest {
    const entries: [string, string][] = []
    let total = 0
    const walk = (relative: string) => {
      const absolute = this.file(relative)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error('内容中不允许符号链接：' + relative)
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(absolute).sort()) walk(`${relative}/${name}`)
      } else if (stat.isFile() && (relative.startsWith('data/') ? relative.endsWith('.json') : /\.(png|jpe?g|webp|svg)$/i.test(relative))) {
        total += stat.size
        if (stat.size > 16 * 1024 * 1024 || total > 128 * 1024 * 1024 || entries.length >= 4000) throw new Error('内容超过快照预算（单文件 16 MiB、总计 128 MiB、4000 个文件）')
        const bytes = fs.readFileSync(absolute)
        const hash = digest(bytes)
        if (storeObjects) {
          const object = this.file(`.workbench/objects/${hash}`, 'write')
          if (!fs.existsSync(object)) fs.writeFileSync(object, bytes, { flag: 'wx' })
          else if (digest(fs.readFileSync(object)) !== hash) throw new Error('历史快照损坏：' + hash)
        }
        entries.push([relative, hash])
      }
    }
    for (const name of ['data', 'images']) if (fs.existsSync(this.file(name, 'write'))) walk(name)
    return Object.fromEntries(entries)
  }
  private capture(): Manifest {
    const first = this.scan(true)
    if (manifestHash(first) !== manifestHash(this.scan())) throw new Error('内容正在被修改，请等 AI 完成后重试')
    return first
  }
  private object(hash: string): Buffer {
    if (!HASH.test(hash)) throw new Error('快照编号无效')
    const bytes = fs.readFileSync(this.file(`.workbench/objects/${hash}`))
    if (digest(bytes) !== hash) throw new Error('快照校验失败')
    return bytes
  }
  private records(id: string, kind: string): Record<string, unknown>[] {
    return fs.readdirSync(this.file(`${this.id(id)}/${kind}`)).filter(name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).map(name => {
      const value = this.read(`${this.id(id)}/${kind}/${name}`)
      if (!record(value)) throw new Error('任务记录损坏')
      return value
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }
  list() {
    return fs.readdirSync(this.file('.workbench/tasks')).filter(id => UUID.test(id)).map(id => {
      const { title, brief, createdAt } = this.task(id)
      return { id, title, brief, createdAt }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  create(input: { title: string; brief: string; criteria: string }) {
    const title = text(input?.title, '任务名称', 120)
    const brief = text(input?.brief, '需求')
    const criteria = text(input?.criteria, '验收条件')
    const baseline = this.capture()
    const id = randomUUID()
    const task: Task = { schema: 'rvb-creative-task/v1', id, title, brief, criteria, createdAt: now(), baseline, baselineHash: manifestHash(baseline) }
    for (const directory of ['', '/checks', '/feedback', '/versions', '/scenarios']) this.directory(this.id(id) + directory)
    this.writeNew(this.id(id) + '/task.json', task)
    this.handoff(id)
    return this.inspect(id)
  }
  inspect(id: string) {
    const task = this.task(id)
    const current = this.capture()
    const contentHash = manifestHash(current)
    const contents = new Map<string, string>()
    const readObject = (hash: string) => {
      if (!contents.has(hash)) contents.set(hash, this.object(hash).toString('utf8'))
      return contents.get(hash)!
    }
    const parsed = (hash?: string) => { if (!hash) return null; const value = readObject(hash); try { return JSON.parse(value) } catch { return null } }
    const changes = [...new Set([...Object.keys(task.baseline), ...Object.keys(current)])].sort().filter(file => task.baseline[file] !== current[file]).map(file => {
      const before = file.endsWith('.json') ? parsed(task.baseline[file]) : null
      const after = file.endsWith('.json') ? parsed(current[file]) : null
      const fields: { field: string; before: unknown; after: unknown }[] = []
      const compare = (left: unknown, right: unknown, prefix = '') => {
        if (fields.length >= 200 || JSON.stringify(left) === JSON.stringify(right)) return
        if (record(left) && record(right)) {
          for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) compare(left[key], right[key], prefix ? `${prefix}.${key}` : key)
        } else fields.push({ field: prefix || '内容', before: left ?? null, after: right ?? null })
      }
      compare(before, after)
      const idValue = record(after) ? after.id : record(before) ? before.id : undefined
      const affected = typeof idValue === 'string' ? Object.keys(current).filter(other => other !== file && other.endsWith('.json') && readObject(current[other]).includes(JSON.stringify(idValue))) : []
      return { path: file, kind: !task.baseline[file] ? 'added' : !current[file] ? 'deleted' : 'modified', name: (record(after) && after.name) || (record(before) && before.name) || path.basename(file), fields, fieldsTruncated: fields.length >= 200, affected }
    })
    const checkPath = `${this.id(id)}/checks/${contentHash}.json`
    const check = this.checkRecord(checkPath, contentHash)
    return { task, contentHash, changes, check, hasOlderChecks: fs.readdirSync(this.file(`${this.id(id)}/checks`)).length > 0, feedback: this.records(id, 'feedback'), scenarios: this.records(id, 'scenarios'), versions: this.records(id, 'versions'), handoffPath: this.file(`${this.id(id)}/AI_TASK.md`, 'write') }
  }
  check(id: string) {
    this.task(id)
    const manifest = this.capture()
    const issues: Issue[] = []
    const documents = new Map<string, unknown>()
    const add = (relative: string, message: string, severity: 'error' | 'warning' = 'error') => issues.push({ severity, path: relative, message })
    for (const [relative, hash] of Object.entries(manifest)) if (relative.endsWith('.json')) {
      try { documents.set(relative, JSON.parse(this.object(hash).toString('utf8'))) }
      catch (error) { add(relative, 'JSON 解析失败：' + (error as Error).message) }
    }
    for (const collection of ['pieces', 'skills', 'cards', 'rules']) {
      const manifestPath = `data/${collection}/manifest.json`
      const ids = documents.get(manifestPath)
      if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) { add(manifestPath, 'manifest 必须是 ID 字符串数组'); continue }
      if (new Set(ids).size !== ids.length) add(manifestPath, 'manifest 中有重复 ID')
      for (const id of ids) if (!documents.has(`data/${collection}/${id}.json`)) add(manifestPath, `引用的内容不存在或无法解析：${id}`)
      for (const [relative, value] of documents) {
        if (!relative.startsWith(`data/${collection}/`) || relative === manifestPath) continue
        const id = path.posix.basename(relative, '.json')
        if (!record(value) || value.id !== id) { add(relative, '内容 ID 必须与文件名一致'); continue }
        if (!ids.includes(id)) add(relative, '内容未登记到 manifest，游戏可能无法发现它')
        for (const field of ['skills', 'rules', 'playerRules', 'relatedCards']) {
          if (value[field] === undefined) continue
          if (!Array.isArray(value[field])) { add(relative, `${field} 必须是引用数组`); continue }
          const target = field === 'relatedCards' ? 'cards' : field === 'playerRules' ? 'rules' : field
          for (const ref of value[field]) {
            const refId = typeof ref === 'string' ? ref : record(ref) && field !== 'playerRules' ? ref[field === 'skills' ? 'skillId' : field === 'rules' ? 'ruleId' : 'cardId'] : null
            if (typeof refId !== 'string' || !refId.trim()) add(relative, `${field} 包含无效引用条目`)
            else if (!documents.has(`data/${target}/${refId}.json`)) add(relative, `${field} 引用不存在：${refId}`)
          }
        }
        if (typeof value.image === 'string' && value.image) {
          const image = value.image.replace(/^\/?images\//, '')
          const safe = !path.isAbsolute(image) && !image.includes('\\') && !image.split('/').includes('..')
          const legacy = safe && fs.existsSync(path.join(this.bundledRoot, 'public', image))
          if (!safe || (!manifest[`images/${image}`] && !legacy)) add(relative, `图片不在项目中：${value.image}`, 'warning')
        }
      }
    }
    const contentHash = manifestHash(manifest)
    const report: Check = { contentHash, checkedAt: now(), issues, runtimeVerified: false }
    const file = `${this.id(id)}/checks/${contentHash}.json`
    this.replace(file, report)
    this.handoff(id)
    return this.inspect(id)
  }
  feedback(id: string, input: { message: string; expectedHash: string }) {
    const state = this.inspect(id)
    if (state.contentHash !== input.expectedHash) throw new Error('内容已改变，请刷新后为当前版本提交反馈')
    this.writeNew(`${this.id(id)}/feedback/${randomUUID()}.json`, { createdAt: now(), message: text(input.message, '反馈'), contentHash: state.contentHash, origin: 'human', check: state.check, scenarios: state.scenarios })
    this.handoff(id)
    return this.inspect(id)
  }
  scenario(id: string, input: { setup: string; action: string; expected: string; expectedHash: string }) {
    const state = this.inspect(id)
    if (state.contentHash !== input.expectedHash) throw new Error('内容已改变，请刷新后记录场景')
    this.writeNew(`${this.id(id)}/scenarios/${randomUUID()}.json`, { createdAt: now(), setup: text(input.setup, '场景条件'), action: text(input.action, '操作'), expected: text(input.expected, '预期'), contentHash: state.contentHash, executed: false })
    this.handoff(id)
    return this.inspect(id)
  }
  keep(id: string, expectedHash: string) {
    const state = this.inspect(id)
    if (state.contentHash !== expectedHash) throw new Error('内容已改变，请刷新并重新检查')
    if (!state.check || state.check.issues.some(issue => issue.severity === 'error')) throw new Error('请先通过当前版本的结构与引用检查')
    const snapshot = this.capture()
    if (manifestHash(snapshot) !== expectedHash) throw new Error('内容已改变，未保存候选')
    this.writeNew(`${this.id(id)}/versions/${randomUUID()}.json`, { createdAt: now(), contentHash: expectedHash, snapshot, check: state.check, status: 'candidate-unverified', published: false })
    return this.inspect(id)
  }
  handoff(id: string) {
    const state = this.inspect(id)
    const checkCommand = this.launcher.length ? [...this.launcher, '--check-content-task', this.root, id] : null
    const report = { schema: 'rvb-ai-handoff/v1', ...state, task: { ...state.task, baseline: undefined }, checkCommand }
    const body = `# ${state.task.title}\n\n工作内容目录：${this.root}\n任务编号：${id}\n\n## 人的需求\n${state.task.brief}\n\n## 验收条件\n${state.task.criteria}\n\n## 协作规则\n修改 data/ 与 images/ 中的内容，保留未知字段和 manifest 引用一致性。不要修改 .workbench 内的历史、报告、快照或发布记录。需要新增引擎接口时先报告能力缺口。不要使用 eval 或可信开关绕过技能限制。\n\n在编辑器点击“检查内容”生成最新结构/引用报告，点击“接收 AI 改动”更新差异。AI_CONTEXT.json 包含实际变化、校验和人的反馈。结构检查不代表技能执行通过；当前实战试验入口尚未接通。不要声称没有运行过的测试通过。\n\n当前内容版本：${state.contentHash}\n修改文件数：${state.changes.length}\n`
    const instructions = body + (checkCommand ? `\n## AI 自检入口\n使用以下参数数组启动子进程（不要拼接或 eval shell 字符串），退出码 0 表示结构/引用检查无错误，1 表示检查失败。命令会更新本任务 AI_CONTEXT.json。\n\n\`\`\`json\n${JSON.stringify(checkCommand, null, 2)}\n\`\`\`\n` : '')
    for (const [name, value] of [['AI_TASK.md', instructions], ['AI_CONTEXT.json', JSON.stringify(report, null, 2) + '\n']]) {
      const relative = `${this.id(id)}/${name}`
      const temporary = `${relative}.${randomUUID()}.tmp`
      fs.writeFileSync(this.file(temporary, 'write'), value, { flag: 'wx' })
      try { fs.renameSync(this.file(temporary), this.file(relative, 'write')) }
      finally { const file = this.file(temporary, 'write'); if (fs.existsSync(file)) fs.unlinkSync(file) }
    }
    return { path: state.handoffPath, text: `请读取并执行这个创作任务：\n${state.handoffPath}\n\n工作内容在 ${this.root}。请同时阅读同目录 AI_CONTEXT.json，参考实际差异和反馈。` }
  }
}
