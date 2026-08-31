import path from 'node:path'
import {
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs'

type PlainRecord = Record<string, unknown>
type EditorChannelV1 = 'local-dev' | 'qa' | 'stable' | 'community'
type EditorCapabilityV1 =
  | 'game-data'
  | 'pve-content'
  | 'raster-assets'
  | 'trusted-executable-content'

interface NormalizedCommonV1 {
  readonly schemaVersion: 'rvb-content-operation/v1'
  readonly caller: 'editor'
  readonly taskId: string
  readonly channel: EditorChannelV1
  readonly appRoot: string
  readonly evidenceRoot: string
  readonly stableConfirmed: boolean
  readonly trustedPublisherKeyIds: readonly string[]
  readonly command: { readonly name: string; readonly args: readonly string[] }
}

export type NormalizedEditorContentOperationV1 = NormalizedCommonV1 & (
  | Readonly<{
    operation: 'build'
    mode: 'snapshot' | 'patch'
    sourceDir: string
    outputArchive: string
    compressionLevel: number
    packageId: string
    version: string
    displayName: string
    description?: string
    publisherId: string
    parentProfileHash?: string
    operations?: readonly unknown[]
    capabilities?: readonly EditorCapabilityV1[]
  }>
  | Readonly<{
    operation: 'sign'
    inputArchive: string
    outputArchive: string
    keyFile: string
  }>
  | Readonly<{
    operation: 'validate'
    archive: string
    base?: { kind: 'bundled' } | { kind: 'archive'; archive: string }
    patches: readonly string[]
  }>
  | Readonly<{
    operation: 'resolve'
    base: { kind: 'bundled' } | { kind: 'archive'; archive: string }
    patches: readonly string[]
  }>
  | Readonly<{
    operation: 'smoke'
    base: { kind: 'bundled' } | { kind: 'archive'; archive: string }
    patches: readonly string[]
    seed: number
  }>
)

const CHANNELS = new Set(['local-dev', 'qa', 'stable', 'community'])
const COMMON_KEYS = new Set([
  'operation',
  'taskId',
  'channel',
  'stableConfirmed',
  'trustedKeyIds',
])
const OPERATION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  build: new Set([
    'mode', 'source', 'output', 'compressionLevel', 'packageId', 'version',
    'displayName', 'description', 'publisherId', 'parentProfileHash',
    'operations', 'capabilities',
  ]),
  sign: new Set(['input', 'output', 'keyFile']),
  validate: new Set(['archive', 'base', 'patches']),
  resolve: new Set(['base', 'patches']),
  smoke: new Set(['base', 'patches', 'seed']),
})

function invalid(message: string): never {
  throw new Error(`EDITOR_REQUEST_INVALID: ${message}`)
}

function record(value: unknown): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('request must be a plain object')
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return invalid('request must use the standard object prototype')
  }
  return value as PlainRecord
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) return invalid(`${field} is required`)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return text(value, field)
}

type EditorWorkspacePathIntentV1 = 'read' | 'write'

export function resolveEditorWorkspacePathV1(
  workspaceRoot: string,
  value: unknown,
  field: string,
  intent: EditorWorkspacePathIntentV1 = 'read',
): string {
  const relative = text(value, field)
  if (path.isAbsolute(relative)) throw new Error(`EDITOR_PATH_INVALID: ${field}`)
  const root = path.resolve(workspaceRoot)
  const candidate = path.resolve(root, relative)
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`EDITOR_PATH_INVALID: ${field}`)
  }
  if (!existsSync(root)) throw new Error(`EDITOR_PATH_INVALID: ${field}`)
  const realRoot = realpathSync.native(root)
  let cursor = root
  const relativeParts = path.relative(root, candidate).split(path.sep).filter(Boolean)
  for (const part of relativeParts) {
    cursor = path.join(cursor, part)
    if (!existsSync(cursor)) break
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`EDITOR_PATH_INVALID: ${field}`)
    }
  }
  if (intent === 'read' && !existsSync(candidate)) {
    throw new Error(`EDITOR_PATH_INVALID: ${field}`)
  }
  let existing = candidate
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) throw new Error(`EDITOR_PATH_INVALID: ${field}`)
    existing = parent
  }
  const projected = path.resolve(
    realpathSync.native(existing),
    path.relative(existing, candidate),
  )
  if (projected !== realRoot && !projected.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`EDITOR_PATH_INVALID: ${field}`)
  }
  return candidate
}

const SAFE_DATA_FILENAME = /^[a-zA-Z0-9_\-]+\.json$/
const SAFE_DATA_SUBDIR = /^[a-zA-Z0-9_\-/]+$/

export function resolveEditorDataDirectoryV1(dataRoot: string, subdir: string): string {
  if (!SAFE_DATA_SUBDIR.test(subdir)) throw new Error('EDITOR_PATH_INVALID: subdir')
  return resolveEditorWorkspacePathV1(dataRoot, subdir, 'subdir')
}

export function resolveEditorDataFilePathV1(
  dataRoot: string,
  subdir: string,
  filename: string,
  intent: EditorWorkspacePathIntentV1 = 'read',
): string {
  if (!SAFE_DATA_FILENAME.test(filename)) throw new Error('EDITOR_PATH_INVALID: filename')
  if (!SAFE_DATA_SUBDIR.test(subdir)) throw new Error('EDITOR_PATH_INVALID: subdir')
  return resolveEditorWorkspacePathV1(
    dataRoot,
    path.join(subdir, filename),
    'dataFile',
    intent,
  )
}

function patches(workspaceRoot: string, value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return invalid('patches must be an array')
  return value.map((entry, index) => resolveEditorWorkspacePathV1(
    workspaceRoot, entry, `patches[${index}]`,
  ))
}

function base(workspaceRoot: string, value: unknown) {
  if (value === 'bundled') return { kind: 'bundled' as const }
  return {
    kind: 'archive' as const,
    archive: resolveEditorWorkspacePathV1(workspaceRoot, value, 'base'),
  }
}

function trustedKeyIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return invalid('trustedKeyIds must be an array')
  return value.map((entry, index) => {
    const keyId = text(entry, `trustedKeyIds[${index}]`)
    if (!/^[0-9a-f]{64}$/.test(keyId)) {
      return invalid(`trustedKeyIds[${index}] must be a lowercase SHA-256 value`)
    }
    return keyId
  })
}

export function normalizeEditorContentOperationRequestV1(
  workspaceRoot: string,
  appRoot: string,
  rawRequest: unknown,
): NormalizedEditorContentOperationV1 {
  const raw = record(rawRequest)
  const operation = text(raw.operation, 'operation')
  const allowed = OPERATION_KEYS[operation]
  if (!allowed) return invalid(`unsupported operation ${operation}`)
  for (const key of Object.keys(raw)) {
    if (!COMMON_KEYS.has(key) && !allowed.has(key)) return invalid(`unexpected field ${key}`)
  }
  const taskId = text(raw.taskId, 'taskId').toUpperCase()
  if (!/^RED-\d+$/.test(taskId)) return invalid('taskId must use RED-<number>')
  const channel = text(raw.channel, 'channel')
  if (!CHANNELS.has(channel)) return invalid('unsupported channel')
  const common = {
    schemaVersion: 'rvb-content-operation/v1' as const,
    caller: 'editor' as const,
    taskId,
    channel: channel as EditorChannelV1,
    appRoot: path.resolve(appRoot),
    evidenceRoot: resolveEditorWorkspacePathV1(workspaceRoot, 'reports', 'reports', 'write'),
    stableConfirmed: raw.stableConfirmed === true,
    trustedPublisherKeyIds: trustedKeyIds(raw.trustedKeyIds),
  }

  switch (operation) {
    case 'build': {
      const mode = raw.mode === 'patch' ? 'patch' : raw.mode === 'snapshot'
        ? 'snapshot'
        : invalid('mode must be snapshot or patch')
      const sourceDir = resolveEditorWorkspacePathV1(workspaceRoot, raw.source, 'source')
      const outputArchive = resolveEditorWorkspacePathV1(workspaceRoot, raw.output, 'output', 'write')
      return {
        ...common,
        operation,
        command: { name: 'build', args: [mode, '<workspace-source>', '<workspace-output>'] },
        mode,
        sourceDir,
        outputArchive,
        compressionLevel: raw.compressionLevel === undefined
          ? 6
          : Number(raw.compressionLevel),
        packageId: text(raw.packageId, 'packageId'),
        version: text(raw.version, 'version'),
        displayName: text(raw.displayName, 'displayName'),
        description: optionalText(raw.description, 'description'),
        publisherId: text(raw.publisherId, 'publisherId'),
        parentProfileHash: optionalText(raw.parentProfileHash, 'parentProfileHash'),
        operations: raw.operations as readonly unknown[] | undefined,
        capabilities: raw.capabilities as readonly EditorCapabilityV1[] | undefined,
      } as NormalizedEditorContentOperationV1
    }
    case 'sign':
      return {
        ...common,
        operation,
        command: { name: 'sign', args: ['<workspace-input>', '--key-file', '<redacted>', '<workspace-output>'] },
        inputArchive: resolveEditorWorkspacePathV1(workspaceRoot, raw.input, 'input'),
        outputArchive: resolveEditorWorkspacePathV1(workspaceRoot, raw.output, 'output', 'write'),
        keyFile: resolveEditorWorkspacePathV1(workspaceRoot, raw.keyFile, 'keyFile'),
      }
    case 'validate':
      return {
        ...common,
        operation,
        command: { name: 'validate', args: ['<workspace-archive>'] },
        archive: resolveEditorWorkspacePathV1(workspaceRoot, raw.archive, 'archive'),
        base: raw.base === undefined ? undefined : base(workspaceRoot, raw.base),
        patches: patches(workspaceRoot, raw.patches),
      }
    case 'resolve':
      return {
        ...common,
        operation,
        command: { name: 'resolve', args: ['<workspace-profile>'] },
        base: base(workspaceRoot, raw.base),
        patches: patches(workspaceRoot, raw.patches),
      }
    case 'smoke': {
      const seed = Number(raw.seed)
      if (!Number.isSafeInteger(seed)) return invalid('seed must be an integer')
      return {
        ...common,
        operation,
        command: { name: 'smoke', args: ['<workspace-profile>', '--seed', String(seed)] },
        base: base(workspaceRoot, raw.base),
        patches: patches(workspaceRoot, raw.patches),
        seed,
      }
    }
    default:
      return invalid(`unsupported operation ${operation}`)
  }
}

export class EditorContentOperationQueueV1 {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  constructor(private readonly maximumPending = 16) {}

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maximumPending) {
      return Promise.reject(new Error('EDITOR_CONTENT_QUEUE_FULL'))
    }
    this.pending += 1
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result.finally(() => {
      this.pending -= 1
    })
  }
}
