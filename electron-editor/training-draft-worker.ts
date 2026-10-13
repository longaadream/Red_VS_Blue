import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertContentGraphArtifact } from './content-graph-document'
import { assertSkillGraphArtifact } from './skill-graph'
import type { DraftTrainingMetadata, TrainingSnapshot } from './training-resources'

const collections = ['skills', 'rules', 'pieces', 'cards'] as const
const dataDirectories = [...collections, 'maps', 'tiles', 'status-effects']
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
type Document = Record<string, unknown>

export interface DraftTrainingRequest {
  skillId: string
  drafts: { collection: typeof collections[number]; document: Document }[]
}
export interface DraftTrainingSnapshot extends TrainingSnapshot {
  draft: DraftTrainingMetadata
}

function isPlainRecord(value: unknown): value is Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertJsonValue(value: unknown, location: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new Error(`试用草稿包含无效数字：${location}`)
  }
  if (typeof value !== 'object') throw new Error(`试用草稿包含不可序列化值：${location}`)
  if (seen.has(value)) throw new Error(`试用草稿包含循环引用：${location}`)
  seen.add(value)
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonValue(item, `${location}[${index}]`, seen))
  else if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error(`试用草稿包含保留字段：${location}.${key}`)
      assertJsonValue(item, `${location}.${key}`, seen)
    }
  } else throw new Error(`试用草稿包含非 JSON 对象：${location}`)
  seen.delete(value)
}

/** Validate and clone renderer input before it reaches filesystem-backed preparation. */
export function normalizeDraftTrainingRequest(raw: unknown): DraftTrainingRequest {
  if (!isPlainRecord(raw) || typeof raw.skillId !== 'string' || !identifier.test(raw.skillId)
    || !Array.isArray(raw.drafts) || raw.drafts.length > 1000) throw new Error('无效的技能试用请求')
  const skillId = raw.skillId
  const drafts = raw.drafts.map((entry, index) => {
    if (!isPlainRecord(entry) || !isPlainRecord(entry.document) || !collections.includes(entry.collection as typeof collections[number])) throw new Error(`无效的试用草稿：${index}`)
    const keys = Object.keys(entry)
    if (keys.some(key => key !== 'collection' && key !== 'document')) throw new Error(`试用草稿包含未知字段：${index}`)
    if (typeof entry.document.id !== 'string' || !identifier.test(entry.document.id)) throw new Error(`无效的试用草稿 ID：${index}`)
    assertJsonValue(entry.document, `drafts[${index}].document`)
    return { collection: entry.collection as typeof collections[number], document: JSON.parse(JSON.stringify(entry.document)) as Document }
  })
  return { skillId, drafts }
}

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/** Resolve only ordinary files below the authoring root; every existing ancestor is checked. */
function safeAuthoringPath(root: string, relative: string): string | undefined {
  let current = root
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('\\')) throw new Error('试用资源路径无效：' + relative)
    current = path.join(current, segment)
    if (!pathInside(root, current)) throw new Error('试用资源路径越界：' + relative)
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('试用资源不允许符号链接：' + relative)
    if (!pathInside(root, fs.realpathSync(current))) throw new Error('试用资源路径越界：' + relative)
  }
  return current
}

/** Capture authoring bytes only. Skill code is never executed in this process. */
export function prepareDraftTrainingPreview(workspace: string, rawRequest: unknown): DraftTrainingSnapshot {
  const request = normalizeDraftTrainingRequest(rawRequest)
  const workspaceStat = fs.lstatSync(workspace)
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) throw new Error('试用项目不允许符号链接')
  const root = fs.realpathSync(workspace)
  const files = new Map<string, Buffer>()
  let byteCount = 0
  const put = (relative: string, bytes: Buffer) => {
    if (bytes.length > MAX_FILE_BYTES) throw new Error('试用资源文件过大：' + relative)
    byteCount += bytes.length - (files.get(relative)?.length ?? 0)
    if (byteCount > MAX_TOTAL_BYTES) throw new Error('试用资源超过 128 MiB')
    files.set(relative, Buffer.from(bytes))
  }
  const visit = (relative: string, images = false) => {
    const absolute = safeAuthoringPath(root, relative)
    if (!absolute) return
    const stat = fs.lstatSync(absolute)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(relative + '/' + name, images)
    } else if (stat.isFile() && (images ? /\.(png|jpg|jpeg|webp|svg|gif)$/i : /\.json$/i).test(relative)) {
      put(relative, fs.readFileSync(absolute))
    }
  }
  // Pages, user records, archives and keys are not authoring content for a trial.
  for (const directory of dataDirectories) visit('data/' + directory)
  visit('data/skill-keywords.json')
  visit('images', true)
  const read = (relative: string): unknown => {
    const bytes = files.get(relative)
    if (!bytes) throw new Error('试用缺少项目资源：' + relative)
    return JSON.parse(bytes.toString('utf8'))
  }
  const write = (relative: string, value: unknown) => {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') throw new Error('试用资源不可序列化：' + relative)
    put(relative, Buffer.from(serialized))
  }
  const readManifest = (collection: string): string[] => {
    const relative = `data/${collection}/manifest.json`
    const manifest = read(relative)
    if (!Array.isArray(manifest) || manifest.some(item => typeof item !== 'string' || !identifier.test(item))) throw new Error('试用资源清单无效：' + relative)
    return manifest
  }
  const appendManifest = (collection: string, id: string) => {
    const manifest = readManifest(collection)
    if (!manifest.includes(id)) write(`data/${collection}/manifest.json`, [...manifest, id])
  }
  const mapIds = readManifest('maps')
  if (mapIds.length === 0) throw new Error('试用项目缺少地图资源')
  if (mapIds.some(id => !files.has(`data/maps/${id}.json`))) throw new Error('试用项目缺少地图文件')
  const seen = new Set<string>()
  for (const entry of request.drafts) {
    const relative = `data/${entry.collection}/${entry.document.id}.json`
    if (seen.has(relative)) throw new Error('试用草稿重复：' + relative)
    seen.add(relative)
    // These validators inspect artifacts; they do not evaluate authored code.
    assertSkillGraphArtifact(entry.document)
    assertContentGraphArtifact(entry.document)
    write(relative, entry.document)
    appendManifest(entry.collection, entry.document.id as string)
  }
  const rootSkillPath = `data/skills/${request.skillId}.json`
  if (!seen.has(rootSkillPath)) throw new Error('试用必须包含根技能草稿')
  const skill = read(rootSkillPath) as Document
  if (!skill || skill.id !== request.skillId) throw new Error('试用技能标识不匹配')
  assertSkillGraphArtifact(skill)
  assertContentGraphArtifact(skill)
  const pieceIds = readManifest('pieces')
  let holder: Document | undefined
  let holderId: string | undefined
  for (const id of pieceIds) {
    const piece = read(`data/pieces/${id}.json`) as Document
    if (Array.isArray(piece.skills) && piece.skills.some((entry: unknown) => entry === request.skillId || (entry && typeof entry === 'object' && (entry as Document).skillId === request.skillId))) { holder = piece; holderId = id; break }
  }
  const skillName = typeof skill.name === 'string' ? skill.name : request.skillId
  let pieceId: string
  let trialPiece: Document
  if (holder && holderId) {
    // Keep the source template id so rules bound with piece.by-template (for
    // example red-shishio's burn rules) still resolve during the trial.
    pieceId = holderId
    trialPiece = JSON.parse(JSON.stringify(holder)) as Document
  } else {
    pieceId = 'editor-trial-' + request.skillId
    while (files.has(`data/pieces/${pieceId}.json`)) pieceId += '-copy'
    trialPiece = {
      faction: 'evil', rarity: 'common', stats: { maxHp: 12, attack: 3, defense: 2, moveRange: 3 },
      skills: [{ skillId: request.skillId, level: 1 }],
    }
  }
  const pieceFaction = trialPiece.faction
  if (pieceFaction !== 'good' && pieceFaction !== 'evil') throw new Error('试用棋子阵营无效')
  trialPiece.id = pieceId
  trialPiece.name = '试用 · ' + skillName
  trialPiece.isDefault = false
  trialPiece.availability = { status: 'ready', modes: ['pvp'] }
  // Trial preparation never creates or persists a new Cluster definition.
  delete trialPiece.cluster
  write(`data/pieces/${pieceId}.json`, trialPiece)
  if (!holder) appendManifest('pieces', pieceId)
  const entries = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const hash = createHash('sha256')
  for (const [relative, bytes] of entries) hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  const contentHash = hash.digest('hex')
  const snapshotFiles = entries.map(([relative, bytes]) => ({ path: relative, bytes }))
  return {
    contentHash,
    files: snapshotFiles,
    draft: { skillId: request.skillId, pieceId, skillName, pieceFaction },
  }
}
