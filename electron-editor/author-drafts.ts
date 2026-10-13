import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const collections = new Set(['pieces', 'skills', 'cards', 'rules', 'tiles', 'maps', 'status-effects', 'clusters'])
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const maxBytes = 16 * 1024 * 1024
const schema = 'rvb-author-draft/v1'
type Document = Record<string, unknown>
export interface AuthorDraft {
  saved: Document
  draft: Document
  serialized: string
  baseRevision: string | null
  pendingCreate: boolean
  editorState?: Document
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const record = (value: unknown): value is Document => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function normalize(value: unknown): AuthorDraft {
  if (!record(value) || !record(value.saved) || !record(value.draft) || typeof value.serialized !== 'string'
    || typeof value.pendingCreate !== 'boolean' || (value.baseRevision !== null && typeof value.baseRevision !== 'string')
    || (value.editorState !== undefined && !record(value.editorState))) {
    throw new Error('草稿内容不完整，请保留当前输入并重试。')
  }
  return { saved: value.saved, draft: value.draft, serialized: value.serialized, baseRevision: value.baseRevision as string | null, pendingCreate: value.pendingCreate,
    ...(record(value.editorState) ? { editorState: value.editorState } : {}) }
}

function directory(workspace: string, collection: string, create: boolean): string {
  if (!collections.has(collection)) throw new Error('不支持保存该类内容的草稿。')
  if (fs.lstatSync(workspace).isSymbolicLink()) throw new Error('草稿项目路径不能使用符号链接。')
  let current = fs.realpathSync(workspace)
  // Deliberately outside data/images: incomplete drafts never enter a pack or runtime catalog.
  for (const part of ['.author-drafts', collection]) {
    current = path.join(current, part)
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('草稿保存位置无效。')
    } else if (create) fs.mkdirSync(current)
  }
  return current
}
function draftPath(workspace: string, collection: string, id: string, create: boolean): string {
  if (typeof id !== 'string' || !identifier.test(id)) throw new Error('草稿引用无效。')
  const file = path.join(directory(workspace, collection, create), id + '.json')
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) throw new Error('草稿文件无效。')
  return file
}
function readBytes(file: string): Buffer | null {
  if (!fs.existsSync(file)) return null
  if (fs.statSync(file).size > maxBytes) throw new Error('草稿过大，无法读取。')
  return fs.readFileSync(file)
}
function assertRevision(file: string, expected: string | null): void {
  const bytes = readBytes(file)
  if ((bytes ? digest(bytes) : null) !== expected) throw new Error('草稿已被其他窗口修改，请重新打开后再保存；已有草稿保持不变。')
}

export function listAuthorDrafts(workspace: string, collection: string) {
  const dir = directory(workspace, collection, false)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
    const id = name.slice(0, -5), file = draftPath(workspace, collection, id, false)
    const bytes = readBytes(file)!
    let envelope: unknown
    try { envelope = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('保存的草稿无法读取，请保留原文件以便恢复。') }
    if (!record(envelope) || envelope.schema !== schema) throw new Error('保存的草稿版本不受支持。')
    return { id, revision: digest(bytes), ...normalize(envelope.content) }
  })
}

export function saveAuthorDraft(workspace: string, collection: string, id: string, raw: unknown, expectedRevision: string | null) {
  const content = normalize(raw)
  let bytes: Buffer
  try { bytes = Buffer.from(JSON.stringify({ schema, content }, null, 2) + '\n') }
  catch { throw new Error('草稿包含无法保存的数据，请保留当前输入。') }
  if (bytes.length > maxBytes) throw new Error('草稿过大，请拆分内容后保存。')
  const file = draftPath(workspace, collection, id, true)
  assertRevision(file, expectedRevision)
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    assertRevision(file, expectedRevision)
    fs.renameSync(temporary, file)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return { revision: digest(bytes) }
}

export function removeAuthorDraft(workspace: string, collection: string, id: string, expectedRevision: string) {
  const file = draftPath(workspace, collection, id, false)
  assertRevision(file, expectedRevision)
  fs.unlinkSync(file)
}
