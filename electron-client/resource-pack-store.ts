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

interface ResourcePackEntryLike {
  entryName: string
  isDirectory: boolean
  attr?: number
  header: {
    size: number
    encrypted?: boolean
  }
  getData?: () => Buffer
}

interface ValidatedResourcePackEntry {
  entry: ResourcePackEntryLike
  relativePath: string
}

export interface ResourcePackMeta {
  name: string
  version: string
  description?: string
  builtAt?: string
  fileCount: number
  importedAt: string
  sha256: string
}

interface ActiveResourcePackPointer {
  version: string | null
  previousVersion: string | null
  activatedAt: string
}

export interface ResourcePackImportResult {
  version: string
  count: number
  meta: ResourcePackMeta
}

function normaliseEntryName(rawName: string): string {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')) {
    throw new Error(`Invalid resource-pack entry path: ${JSON.stringify(rawName)}`)
  }
  if (rawName.startsWith('/') || /^[a-zA-Z]:\//.test(rawName)) {
    throw new Error(`Absolute resource-pack entry path is not allowed: ${rawName}`)
  }

  const withoutTrailingSlash = rawName.replace(/\/+$/, '')
  const segments = withoutTrailingSlash.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe resource-pack entry path: ${rawName}`)
  }
  if (segments[0] === 'resource-pack') segments.shift()
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe resource-pack entry path: ${rawName}`)
  }
  return segments.join('/')
}

function isSymbolicLink(entry: ResourcePackEntryLike): boolean {
  const unixMode = ((entry.attr ?? 0) >>> 16) & 0xffff
  return (unixMode & 0xf000) === 0xa000
}

function isUnsupportedUnixEntryType(entry: ResourcePackEntryLike): boolean {
  const unixMode = ((entry.attr ?? 0) >>> 16) & 0xffff
  const fileType = unixMode & 0xf000
  return fileType !== 0 && fileType !== 0x4000 && fileType !== 0x8000
}

export function preflightResourcePackEntries(
  entries: readonly ResourcePackEntryLike[],
): ValidatedResourcePackEntry[] {
  if (entries.length > RESOURCE_PACK_LIMITS.maxEntries) {
    throw new Error(`Resource-pack entry count exceeds ${RESOURCE_PACK_LIMITS.maxEntries}`)
  }

  const seen = new Set<string>()
  const validated: ValidatedResourcePackEntry[] = []
  let totalSize = 0

  for (const entry of entries) {
    const relativePath = normaliseEntryName(entry.entryName)
    if (!relativePath) continue
    const collisionKey = relativePath.toLocaleLowerCase('en-US')
    if (seen.has(collisionKey)) {
      throw new Error(`Duplicate or case-colliding resource-pack entry: ${entry.entryName}`)
    }
    seen.add(collisionKey)

    if (entry.header.encrypted) {
      throw new Error(`Encrypted resource-pack entry is not supported: ${entry.entryName}`)
    }
    if (isSymbolicLink(entry)) {
      throw new Error(`Symbolic link resource-pack entry is not allowed: ${entry.entryName}`)
    }
    if (isUnsupportedUnixEntryType(entry)) {
      throw new Error(`Unsupported resource-pack entry type: ${entry.entryName}`)
    }

    const declaredSize = entry.header.size
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new Error(`Invalid declared size for resource-pack entry: ${entry.entryName}`)
    }
    if (!entry.isDirectory && declaredSize > RESOURCE_PACK_LIMITS.maxFileBytes) {
      throw new Error(`Resource-pack single file size exceeds ${RESOURCE_PACK_LIMITS.maxFileBytes}: ${entry.entryName}`)
    }
    totalSize += declaredSize
    if (totalSize > RESOURCE_PACK_LIMITS.maxTotalBytes) {
      throw new Error(`Resource-pack declared total size exceeds ${RESOURCE_PACK_LIMITS.maxTotalBytes}`)
    }

    validated.push({ entry, relativePath })
  }
  return validated
}

export function isActivatableResourcePackPath(relativePath: string): boolean {
  return /^data\/.+\.json$/i.test(relativePath)
    || /^images\/.+\.(?:jpe?g|png|webp)$/i.test(relativePath)
}

function validateManifest(value: unknown, archiveFileCount: number): Omit<ResourcePackMeta, 'importedAt' | 'sha256'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Resource-pack pack.json must contain a JSON object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0 || candidate.name.length > 100) {
    throw new Error('Resource-pack pack.json name must be a non-empty string of at most 100 characters')
  }
  if (typeof candidate.version !== 'string' || candidate.version.trim().length === 0 || candidate.version.length > 100) {
    throw new Error('Resource-pack pack.json version must be a non-empty string of at most 100 characters')
  }
  if (candidate.description !== undefined && (typeof candidate.description !== 'string' || candidate.description.length > 1000)) {
    throw new Error('Resource-pack pack.json description must be a string of at most 1000 characters')
  }
  if (candidate.builtAt !== undefined && (typeof candidate.builtAt !== 'string' || candidate.builtAt.length > 100)) {
    throw new Error('Resource-pack pack.json builtAt must be a string of at most 100 characters')
  }
  if (!Number.isSafeInteger(candidate.fileCount) || candidate.fileCount !== archiveFileCount) {
    throw new Error(`Resource-pack pack.json fileCount must equal archive file count (${archiveFileCount})`)
  }
  return {
    name: candidate.name,
    version: candidate.version,
    ...(candidate.description === undefined ? {} : { description: candidate.description as string }),
    ...(candidate.builtAt === undefined ? {} : { builtAt: candidate.builtAt as string }),
    fileCount: candidate.fileCount as number,
  }
}

function readActivePointer(packRoot: string): ActiveResourcePackPointer | null {
  const pointerPath = path.join(packRoot, 'active.json')
  if (!fs.existsSync(pointerPath)) return null
  try {
    const value = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Partial<ActiveResourcePackPointer>
    if (value.version !== null && (typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version))) return null
    if (value.previousVersion !== null && value.previousVersion !== undefined
      && (typeof value.previousVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousVersion))) return null
    return {
      version: value.version,
      previousVersion: value.previousVersion ?? null,
      activatedAt: typeof value.activatedAt === 'string' ? value.activatedAt : '',
    }
  } catch {
    return null
  }
}

function writeActivePointer(packRoot: string, pointer: ActiveResourcePackPointer): void {
  fs.mkdirSync(packRoot, { recursive: true })
  const pointerPath = path.join(packRoot, 'active.json')
  const temporaryPath = path.join(packRoot, `.active-${crypto.randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(temporaryPath, pointerPath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

function previousVersionForActivation(
  current: ActiveResourcePackPointer | null,
  nextVersion: string,
): string | null {
  if (!current) return null
  if (current.version === nextVersion) return current.previousVersion
  const candidate = current.version ?? current.previousVersion
  return candidate === nextVersion ? null : candidate
}

function safeDestination(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split('/'))
  const relative = path.relative(path.resolve(root), target)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Resource-pack destination escapes staging root: ${relativePath}`)
  }
  return target
}

export function importResourcePackArchive(packRoot: string, archive: Buffer): ResourcePackImportResult {
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > RESOURCE_PACK_LIMITS.maxArchiveBytes) {
    throw new Error(`Resource-pack compressed archive exceeds ${RESOURCE_PACK_LIMITS.maxArchiveBytes} bytes or is empty`)
  }
  if (archive[0] !== 0x50 || archive[1] !== 0x4b) {
    throw new Error('Resource-pack archive is not a ZIP file')
  }

  const zip = new AdmZip(archive)
  const validated = preflightResourcePackEntries(zip.getEntries() as ResourcePackEntryLike[])
  const manifestEntries = validated.filter(({ entry, relativePath }) => !entry.isDirectory && relativePath === 'pack.json')
  if (manifestEntries.length !== 1 || !manifestEntries[0].entry.getData) {
    throw new Error('Resource-pack archive must contain exactly one pack.json')
  }
  const archiveFileCount = validated.filter(({ entry, relativePath }) => !entry.isDirectory && relativePath !== 'pack.json').length

  let manifestValue: unknown
  try {
    manifestValue = JSON.parse(manifestEntries[0].entry.getData().toString('utf8'))
  } catch (error) {
    throw new Error(`Resource-pack pack.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = validateManifest(manifestValue, archiveFileCount)
  const version = crypto.createHash('sha256').update(archive).digest('hex')
  const importedAt = new Date().toISOString()
  const meta: ResourcePackMeta = { ...manifest, importedAt, sha256: version }
  const stagingRoot = path.join(packRoot, `.staging-${crypto.randomUUID()}`)
  const versionRoot = path.join(packRoot, 'versions', version)
  let activatedCount = 0

  try {
    fs.mkdirSync(stagingRoot, { recursive: true })
    for (const { entry, relativePath } of validated) {
      if (entry.isDirectory || !isActivatableResourcePackPath(relativePath)) continue
      if (!entry.getData) throw new Error(`Resource-pack entry cannot be read: ${relativePath}`)
      const content = entry.getData()
      if (content.length !== entry.header.size || content.length > RESOURCE_PACK_LIMITS.maxFileBytes) {
        throw new Error(`Resource-pack extracted size does not match the declared size: ${relativePath}`)
      }
      if (relativePath.toLowerCase().endsWith('.json')) {
        try {
          JSON.parse(content.toString('utf8'))
        } catch (error) {
          throw new Error(`Resource-pack entry contains invalid JSON (${relativePath}): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const destination = safeDestination(stagingRoot, relativePath)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, content, { flag: 'wx' })
      activatedCount += 1
    }
    fs.writeFileSync(path.join(stagingRoot, 'pack.json'), `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })

    fs.mkdirSync(path.dirname(versionRoot), { recursive: true })
    if (fs.existsSync(versionRoot)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true })
    } else {
      fs.renameSync(stagingRoot, versionRoot)
    }
    const current = readActivePointer(packRoot)
    writeActivePointer(packRoot, {
      version,
      previousVersion: previousVersionForActivation(current, version),
      activatedAt: importedAt,
    })
    return { version, count: activatedCount, meta }
  } catch (error) {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

export function importResourcePackFromPath(packRoot: string, archivePath: string): ResourcePackImportResult {
  const stat = fs.statSync(archivePath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > RESOURCE_PACK_LIMITS.maxArchiveBytes) {
    throw new Error(`Resource-pack compressed archive exceeds ${RESOURCE_PACK_LIMITS.maxArchiveBytes} bytes or is not a file`)
  }
  return importResourcePackArchive(packRoot, fs.readFileSync(archivePath))
}

export function resolveActiveResourcePackRoot(packRoot: string): string | null {
  const pointer = readActivePointer(packRoot)
  if (!pointer?.version) return null
  const versionRoot = path.join(packRoot, 'versions', pointer.version)
  return fs.existsSync(versionRoot) && fs.statSync(versionRoot).isDirectory() ? versionRoot : null
}

export function getActiveResourcePackMeta(packRoot: string): ResourcePackMeta | null {
  const activeRoot = resolveActiveResourcePackRoot(packRoot)
  if (!activeRoot) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(activeRoot, 'pack.json'), 'utf8')) as ResourcePackMeta
  } catch {
    return null
  }
}

export function listActiveResourcePackFiles(packRoot: string): string[] {
  const activeRoot = resolveActiveResourcePackRoot(packRoot)
  if (!activeRoot) return []
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else {
        const relativePath = path.relative(activeRoot, fullPath).split(path.sep).join('/')
        if (isActivatableResourcePackPath(relativePath)) files.push(`/${relativePath}`)
      }
    }
  }
  walk(activeRoot)
  return files.sort((left, right) => left.localeCompare(right, 'en-US'))
}

export function clearActiveResourcePack(packRoot: string): void {
  const current = readActivePointer(packRoot)
  writeActivePointer(packRoot, {
    version: null,
    previousVersion: current?.version ?? current?.previousVersion ?? null,
    activatedAt: new Date().toISOString(),
  })
}
