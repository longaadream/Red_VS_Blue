import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { assertSkillGraphArtifact } from './skill-graph'

const MARKER = 'rvb-content-project.json'
const COLLECTIONS = ['pieces', 'skills', 'cards', 'rules']

function rejectLinks(root: string): void {
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink()) throw new Error('内容项目不允许符号链接：' + root)
  if (stat.isDirectory()) for (const name of fs.readdirSync(root)) rejectLinks(path.join(root, name))
}

export function openContentProject(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('请选择完整的内容项目路径')
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('内容项目不允许符号链接：' + root)
  const canonical = fs.realpathSync(root)
  if (fs.lstatSync(path.join(canonical, MARKER)).isSymbolicLink()) throw new Error('项目描述文件不允许符号链接')
  const marker = JSON.parse(fs.readFileSync(path.join(canonical, MARKER), 'utf8'))
  if (marker.schema !== 'rvb-content-project/v1') throw new Error('不支持的内容项目版本')
  rejectLinks(path.join(canonical, 'data'))
  if (fs.existsSync(path.join(canonical, 'images'))) rejectLinks(path.join(canonical, 'images'))
  for (const collection of COLLECTIONS) {
    if (!fs.statSync(path.join(canonical, 'data', collection)).isDirectory()) throw new Error('缺少内容目录：' + collection)
  }
  return canonical
}

export function assertContentProjectRoot(root: string): void {
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('项目路径发生变化，请重新打开项目')
  for (const name of ['data', 'images']) {
    const directory = path.join(root, name)
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('内容目录不允许符号链接：' + name)
  }
}

export function createContentProject(parent: string, mode: 'official' | 'blank', bundledRoot: string): string {
  if (mode !== 'official' && mode !== 'blank') throw new Error('无效的内容项目模板')
  const canonicalParent = fs.realpathSync(parent)
  const root = path.join(canonicalParent, 'rvb-content-' + randomUUID().slice(0, 8))
  fs.mkdirSync(root)
  if (mode === 'official') {
    for (const [source, destination] of [['data', 'data'], ['public/images', 'images']]) {
      const input = path.join(bundledRoot, source)
      if (fs.existsSync(input)) {
        rejectLinks(input)
        fs.cpSync(input, path.join(root, destination), { recursive: true, force: false, errorOnExist: true })
      }
    }
  }
  for (const collection of COLLECTIONS) {
    const directory = path.join(root, 'data', collection)
    fs.mkdirSync(directory, { recursive: true })
    const manifest = path.join(directory, 'manifest.json')
    if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, '[]\n', { flag: 'wx' })
  }
  for (const directory of ['data/pve', 'images', 'archives', 'keys', 'reports', 'sources']) fs.mkdirSync(path.join(root, directory), { recursive: true })
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify({ schema: 'rvb-content-project/v1', template: mode }, null, 2) + '\n', { flag: 'wx' })
  return openContentProject(root)
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export function readDocumentSnapshot(file: string) {
  const bytes = fs.readFileSync(file)
  try { return { value: JSON.parse(bytes.toString('utf8')), revision: digest(bytes) } }
  catch (error) { throw new Error(`${path.basename(file)}：${(error as Error).message}`) }
}

/** Detect stale editors; arbitrary external writers do not participate in a filesystem lock. */
export function writeDocumentSnapshot(file: string, value: unknown, expectedRevision: string) {
  assertSkillGraphArtifact(value)
  if (typeof expectedRevision !== 'string' || digest(fs.readFileSync(file)) !== expectedRevision) {
    throw new Error('文件已被 AI 或其他程序修改，请刷新后重新编辑；磁盘文件未被覆盖。')
  }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    if (digest(fs.readFileSync(file)) !== expectedRevision) throw new Error('保存期间文件发生变化，请刷新后重试。')
    fs.renameSync(temporary, file)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return { ok: true, revision: digest(bytes) }
}
