import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const AdmZip = require('adm-zip')

export const RESOURCE_PACK_LIMITS = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxEntries: 2048,
})

interface ResourcePackEntry {
  entryName: string
  isDirectory: boolean
  attr?: number
  header: { size: number; encrypted?: boolean }
  getData?: () => Buffer
}

interface CheckedEntry {
  entry: ResourcePackEntry
  relativePath: string
}

interface ActivePointer {
  version: string | null
  previousVersion: string | null
  activatedAt: string
}

export interface ImportedResourcePack {
  version: string
  count: number
  meta: Record<string, unknown>
}

function normaliseEntryName(rawName: string): string {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')
    || rawName.startsWith('/') || /^[a-zA-Z]:\//.test(rawName)) {
    throw new Error(`Invalid resource-pack entry path: ${JSON.stringify(rawName)}`)
  }
  const segments = rawName.replace(/\/+$/, '').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe resource-pack entry path: ${rawName}`)
  }
  if (segments[0] === 'resource-pack') segments.shift()
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe resource-pack entry path: ${rawName}`)
  }
  return segments.join('/')
}

function isSymbolicLink(entry: ResourcePackEntry): boolean {
  return ((((entry.attr ?? 0) >>> 16) & 0xffff) & 0xf000) === 0xa000
}

function isUnsupportedUnixEntryType(entry: ResourcePackEntry): boolean {
  const fileType = (((entry.attr ?? 0) >>> 16) & 0xffff) & 0xf000
  return fileType !== 0 && fileType !== 0x4000 && fileType !== 0x8000
}

function preflight(entries: readonly ResourcePackEntry[]): CheckedEntry[] {
  if (entries.length > RESOURCE_PACK_LIMITS.maxEntries) {
    throw new Error(`Resource-pack entry count exceeds ${RESOURCE_PACK_LIMITS.maxEntries}`)
  }
  const seen = new Set<string>()
  const checked: CheckedEntry[] = []
  let totalSize = 0
  for (const entry of entries) {
    const relativePath = normaliseEntryName(entry.entryName)
    if (!relativePath) continue
    const collisionKey = relativePath.toLocaleLowerCase('en-US')
    if (seen.has(collisionKey)) throw new Error(`Duplicate or case-colliding resource-pack entry: ${entry.entryName}`)
    seen.add(collisionKey)
    if (entry.header.encrypted) throw new Error(`Encrypted resource-pack entry is not supported: ${entry.entryName}`)
    if (isSymbolicLink(entry)) throw new Error(`Symbolic link resource-pack entry is not allowed: ${entry.entryName}`)
    if (isUnsupportedUnixEntryType(entry)) throw new Error(`Unsupported resource-pack entry type: ${entry.entryName}`)
    const size = entry.header.size
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid declared entry size: ${entry.entryName}`)
    if (!entry.isDirectory && size > RESOURCE_PACK_LIMITS.maxFileBytes) {
      throw new Error(`Resource-pack single file size exceeds ${RESOURCE_PACK_LIMITS.maxFileBytes}: ${entry.entryName}`)
    }
    totalSize += size
    if (totalSize > RESOURCE_PACK_LIMITS.maxTotalBytes) {
      throw new Error(`Resource-pack declared total size exceeds ${RESOURCE_PACK_LIMITS.maxTotalBytes}`)
    }
    checked.push({ entry, relativePath })
  }
  return checked
}

function isActivatable(relativePath: string): boolean {
  return /^data\/.+\.json$/i.test(relativePath)
    || /^images\/.+\.(?:jpe?g|png|webp)$/i.test(relativePath)
}

function validateManifest(value: unknown, archiveFileCount: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resource-pack pack.json must be a JSON object')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 100) {
    throw new Error('Resource-pack pack.json has an invalid name')
  }
  if (typeof candidate.version !== 'string' || !candidate.version.trim() || candidate.version.length > 100) {
    throw new Error('Resource-pack pack.json has an invalid version')
  }
  if (candidate.description !== undefined && (typeof candidate.description !== 'string' || candidate.description.length > 1000)) {
    throw new Error('Resource-pack pack.json has an invalid description')
  }
  if (candidate.builtAt !== undefined && (typeof candidate.builtAt !== 'string' || candidate.builtAt.length > 100)) {
    throw new Error('Resource-pack pack.json has an invalid builtAt')
  }
  if (!Number.isSafeInteger(candidate.fileCount) || candidate.fileCount !== archiveFileCount) {
    throw new Error(`Resource-pack pack.json fileCount must equal archive file count (${archiveFileCount})`)
  }
  return candidate
}

function readPointer(packRoot: string): ActivePointer | null {
  const pointerPath = path.join(packRoot, 'active.json')
  if (!fs.existsSync(pointerPath)) return null
  try {
    const value = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Partial<ActivePointer>
    if (value.version !== null && (typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version))) return null
    return {
      version: value.version,
      previousVersion: typeof value.previousVersion === 'string' ? value.previousVersion : null,
      activatedAt: typeof value.activatedAt === 'string' ? value.activatedAt : '',
    }
  } catch {
    return null
  }
}

function writePointer(packRoot: string, pointer: ActivePointer): void {
  fs.mkdirSync(packRoot, { recursive: true })
  const temporaryPath = path.join(packRoot, `.active-${crypto.randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(temporaryPath, path.join(packRoot, 'active.json'))
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

function previousVersionForActivation(current: ActivePointer | null, nextVersion: string): string | null {
  if (!current) return null
  if (current.version === nextVersion) return current.previousVersion
  const candidate = current.version ?? current.previousVersion
  return candidate === nextVersion ? null : candidate
}

function destinationWithin(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split('/'))
  const relative = path.relative(path.resolve(root), target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Resource-pack destination escapes staging root: ${relativePath}`)
  }
  return target
}

export function importResourcePackArchive(packRoot: string, archive: Buffer): ImportedResourcePack {
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > RESOURCE_PACK_LIMITS.maxArchiveBytes) {
    throw new Error('Resource-pack compressed archive is empty or exceeds 32 MiB')
  }
  if (archive[0] !== 0x50 || archive[1] !== 0x4b) throw new Error('Resource-pack archive is not a ZIP file')

  const zip = new AdmZip(archive)
  const entries = preflight(zip.getEntries() as ResourcePackEntry[])
  const manifestEntries = entries.filter(({ entry, relativePath }) => !entry.isDirectory && relativePath === 'pack.json')
  if (manifestEntries.length !== 1 || !manifestEntries[0].entry.getData) {
    throw new Error('Resource-pack archive must contain exactly one pack.json')
  }
  const archiveFileCount = entries.filter(({ entry, relativePath }) => !entry.isDirectory && relativePath !== 'pack.json').length
  let manifest: Record<string, unknown>
  try {
    manifest = validateManifest(JSON.parse(manifestEntries[0].entry.getData().toString('utf8')), archiveFileCount)
  } catch (error) {
    throw new Error(`Resource-pack pack.json is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }

  const version = crypto.createHash('sha256').update(archive).digest('hex')
  const importedAt = new Date().toISOString()
  const meta = { ...manifest, importedAt, sha256: version }
  const stagingRoot = path.join(packRoot, `.staging-${crypto.randomUUID()}`)
  const versionRoot = path.join(packRoot, 'versions', version)
  let count = 0
  try {
    fs.mkdirSync(stagingRoot, { recursive: true })
    for (const { entry, relativePath } of entries) {
      if (entry.isDirectory || !isActivatable(relativePath)) continue
      if (!entry.getData) throw new Error(`Resource-pack entry cannot be read: ${relativePath}`)
      const content = entry.getData()
      if (content.length !== entry.header.size || content.length > RESOURCE_PACK_LIMITS.maxFileBytes) {
        throw new Error(`Resource-pack extracted size does not match declared size: ${relativePath}`)
      }
      if (relativePath.toLowerCase().endsWith('.json')) {
        try { JSON.parse(content.toString('utf8')) } catch { throw new Error(`Resource-pack entry contains invalid JSON: ${relativePath}`) }
      }
      const destination = destinationWithin(stagingRoot, relativePath)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, content, { flag: 'wx' })
      count += 1
    }
    fs.writeFileSync(path.join(stagingRoot, 'pack.json'), `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fs.mkdirSync(path.dirname(versionRoot), { recursive: true })
    if (fs.existsSync(versionRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true })
    else fs.renameSync(stagingRoot, versionRoot)
    const current = readPointer(packRoot)
    writePointer(packRoot, {
      version,
      previousVersion: previousVersionForActivation(current, version),
      activatedAt: importedAt,
    })
    return { version, count, meta }
  } catch (error) {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
}
