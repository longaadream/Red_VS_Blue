import {
  PackCompatibilityV1Schema,
  PackFileDescriptorV1Schema,
  PackFileInventoryV1Schema,
  PackManifestV1Schema,
  PackPayloadPathV1Schema,
  PackSignatureEnvelopeV1Schema,
  PosixRelativePathV1Schema,
  compareUnicodeCodePointsV1,
} from '../contracts'
import type {
  JsonValueV1,
  PackCapabilityV1,
  PackCompatibilityV1,
  PackFileDescriptorV1,
  PackManifestV1,
  PackSignatureEnvelopeV1,
  Sha256HexV1,
} from '../contracts'
import {
  PveCampaignV1Schema,
  PveChapterV1Schema,
  PveContentManifestV1Schema,
  PveEncounterV1Schema,
  PveEnemySetupV1Schema,
  PveEventV1Schema,
  PveFlowNodeV1Schema,
  PveRelicV1Schema,
  PveRewardV1Schema,
} from '@/lib/pve/contracts'
import type {
  PveCampaignV1,
  PveChapterV1,
  PveContentKindV1,
  PveContentManifestV1,
  PveEncounterV1,
  PveEnemySetupV1,
  PveEventV1,
  PveFlowNodeV1,
  PveRelicV1,
  PveRewardV1,
} from '@/lib/pve/contracts'

import {
  deriveFileCapabilitiesV1,
  sameCapabilitiesV1,
  sortCapabilitiesV1,
} from './capabilities'
import {
  CONTENT_PIPELINE_LIMITS_V1,
  ContentPipelineErrorV1,
} from './error-codes'
import type {
  ContentPipelineErrorCodeV1,
  ContentPipelineStageV1,
} from './error-codes'
import { computePackageHashV1, sha256HexV1 } from './hash'
import {
  JsonSafetyErrorV1,
  hasExecutableContentV1,
  parseStrictJsonBytesV1,
} from './json-safety'
import {
  createReadonlyContentTreeV1,
  snapshotOrdinaryUint8ArrayV1,
} from './source'
import type {
  ContentPackSourceV1,
  ContentSourceEntryV1,
  ContentTreeFileInputV1,
  ReadonlyContentTreeV1,
  ResolvedCandidateFileInputV1,
} from './source'
import { verifyPackageSignatureV1 } from './signature'

export type ContentValidationPolicyV1 =
  | {
    readonly kind: 'bundled-base' | 'external'
    readonly expectedCompatibility: PackCompatibilityV1
  }
  | {
    readonly kind: 'local-dev'
    readonly expectedCompatibility: PackCompatibilityV1
    readonly allowUnsigned: true
  }

export interface PackValidationContextV1 {
  readonly parent?: ReadonlyContentTreeV1
}

export interface ValidatedPackV1 extends ReadonlyContentTreeV1 {
  readonly manifest: PackManifestV1
  readonly packageHash: Sha256HexV1
  readonly signatureEnvelope: PackSignatureEnvelopeV1 | null
  readonly networkEligible: boolean
  readonly capabilities: readonly PackCapabilityV1[]
}

export interface ResolvedCandidateInputV1 {
  readonly compatibility: PackCompatibilityV1
  readonly files: readonly ResolvedCandidateFileInputV1[]
  readonly trustedExecutablePaths: readonly string[]
}

export interface ValidatedContentTreeV1 extends ReadonlyContentTreeV1 {
  readonly compatibility: PackCompatibilityV1
  readonly capabilities: readonly PackCapabilityV1[]
}

type ParsedPveDocumentV1 =
  | { readonly kind: 'content-manifest'; readonly value: PveContentManifestV1 }
  | { readonly kind: 'campaign'; readonly value: PveCampaignV1 }
  | { readonly kind: 'chapter'; readonly value: PveChapterV1 }
  | { readonly kind: 'encounter'; readonly value: PveEncounterV1 }
  | { readonly kind: 'event'; readonly value: PveEventV1 }
  | { readonly kind: 'reward'; readonly value: PveRewardV1 }
  | { readonly kind: 'relic'; readonly value: PveRelicV1 }
  | { readonly kind: 'enemy'; readonly value: PveEnemySetupV1 }
  | { readonly kind: 'node'; readonly value: PveFlowNodeV1 }

interface ValidatedFileFactV1 extends ContentTreeFileInputV1 {
  readonly jsonValue?: JsonValueV1
  readonly pveDocument?: ParsedPveDocumentV1
}

interface PreflightedSourceV1 {
  readonly manifestBytes: Uint8Array
  readonly signatureBytes: Uint8Array | null
  readonly entries: readonly ContentSourceEntryV1[]
}

const forbiddenActiveExtensionPattern = /\.(?:html?|js|mjs|cjs|css|svg|wasm|node|dll|exe)$/i
const jsonBudgetReasons = new Set([
  'depth',
  'nodes',
  'string-bytes',
])

function reject(
  code: ContentPipelineErrorCodeV1,
  stage: ContentPipelineStageV1,
  context: { packId?: string; path?: string; contentId?: string } = {},
): never {
  throw new ContentPipelineErrorV1(code, stage, context)
}

function rejectJsonFailure(
  error: unknown,
  stage: ContentPipelineStageV1,
  context: { packId?: string; path?: string } = {},
): never {
  if (error instanceof JsonSafetyErrorV1 && jsonBudgetReasons.has(error.reason)) {
    reject('PACK_BUDGET_EXCEEDED', stage, context)
  }
  reject('PACK_SCHEMA_INVALID', stage, context)
}

function readPropertyV1(
  value: object,
  key: PropertyKey,
  stage: ContentPipelineStageV1,
  context: { packId?: string; path?: string; contentId?: string } = {},
): unknown {
  try {
    return (value as Record<PropertyKey, unknown>)[key]
  } catch {
    return reject('PACK_SCHEMA_INVALID', stage, context)
  }
}

function hasOwnPropertyV1(
  value: object,
  key: PropertyKey,
  stage: ContentPipelineStageV1,
  context: { packId?: string; path?: string; contentId?: string } = {},
): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key)
  } catch {
    return reject('PACK_SCHEMA_INVALID', stage, context)
  }
}

function parseCompatibilitySnapshotV1(
  value: unknown,
  stage: ContentPipelineStageV1,
): PackCompatibilityV1 {
  let parsed: PackCompatibilityV1 | undefined
  try {
    const result = PackCompatibilityV1Schema.safeParse(value)
    if (result.success) parsed = result.data
  } catch {
    // Accessors and Proxies are untrusted at this boundary.
  }
  if (parsed === undefined) reject('PACK_SCHEMA_INVALID', stage)
  return Object.freeze({ ...parsed })
}

function snapshotBoundedArrayV1(
  value: unknown,
  stage: ContentPipelineStageV1,
): readonly unknown[] {
  let isArray = false
  try {
    isArray = Array.isArray(value)
  } catch {
    reject('PACK_SCHEMA_INVALID', stage)
  }
  if (!isArray) reject('PACK_SCHEMA_INVALID', stage)

  const length = readPropertyV1(value as object, 'length', stage)
  if (
    typeof length !== 'number'
    || !Number.isSafeInteger(length)
    || length < 0
  ) {
    reject('PACK_SCHEMA_INVALID', stage)
  }
  if (length > CONTENT_PIPELINE_LIMITS_V1.maxEntries) {
    reject('PACK_BUDGET_EXCEEDED', 'source')
  }

  const snapshot: unknown[] = new Array(length)
  for (let index = 0; index < length; index += 1) {
    if (!hasOwnPropertyV1(value as object, index, stage)) {
      reject('PACK_SCHEMA_INVALID', stage)
    }
    snapshot[index] = readPropertyV1(value as object, index, stage)
  }
  return Object.freeze(snapshot)
}

function cloneBytes(
  value: unknown,
  stage: ContentPipelineStageV1,
  maxBytes: number,
  context: { packId?: string; path?: string; contentId?: string } = {},
): Uint8Array {
  const snapshot = snapshotOrdinaryUint8ArrayV1(value, maxBytes)
  if (!snapshot.ok) {
    if (snapshot.reason === 'budget') {
      reject('PACK_BUDGET_EXCEEDED', 'source', context)
    }
    reject('PACK_SCHEMA_INVALID', stage, context)
  }
  return snapshot.bytes
}

function assertPayloadPath(
  path: unknown,
  stage: ContentPipelineStageV1,
  packId?: string,
): asserts path is string {
  if (typeof path !== 'string' || !PosixRelativePathV1Schema.safeParse(path).success) {
    reject('PACK_PATH_INVALID', stage, {
      packId,
      path: typeof path === 'string' ? path : undefined,
    })
  }
  if (!PackPayloadPathV1Schema.safeParse(path).success) {
    reject('PACK_FORBIDDEN_EXECUTABLE_CONTENT', stage, { packId, path })
  }
}

function collisionKey(path: string): string {
  // Unicode default uppercase is locale-free and conservatively coalesces case
  // variants. Full mappings such as ß -> SS can reject more than Windows does.
  return path.toUpperCase()
}

function rawEntryPath(entry: unknown): string {
  if (entry === null || typeof entry !== 'object') return ''
  const path = readPropertyV1(entry, 'path', 'source')
  return typeof path === 'string' ? path : ''
}

function assertRuntimePolicyV1(
  policy: unknown,
): ContentValidationPolicyV1 {
  if (policy === null || typeof policy !== 'object') {
    reject('PACK_SCHEMA_INVALID', 'source')
  }
  const kind = readPropertyV1(policy, 'kind', 'source')
  if (
    kind !== 'bundled-base'
    && kind !== 'external'
    && kind !== 'local-dev'
  ) {
    reject('PACK_SCHEMA_INVALID', 'source')
  }
  if (kind === 'local-dev') {
    const allowUnsigned = readPropertyV1(
      policy,
      'allowUnsigned',
      'signature',
    )
    if (allowUnsigned !== true) {
      reject('PACK_SIGNATURE_REQUIRED', 'signature')
    }
  }
  const expectedCompatibility = parseCompatibilitySnapshotV1(
    readPropertyV1(policy, 'expectedCompatibility', 'source'),
    'source',
  )
  if (kind === 'local-dev') {
    return Object.freeze({
      kind,
      allowUnsigned: true,
      expectedCompatibility,
    })
  }
  return Object.freeze({ kind, expectedCompatibility })
}

function preflightSource(source: ContentPackSourceV1): PreflightedSourceV1 {
  if (source === null || typeof source !== 'object') {
    reject('PACK_SCHEMA_INVALID', 'source')
  }

  const rawEntries = readPropertyV1(source, 'entries', 'source')
  const entries = snapshotBoundedArrayV1(rawEntries, 'source')

  const manifestBytes = cloneBytes(
    readPropertyV1(source, 'manifestBytes', 'source'),
    'source',
    CONTENT_PIPELINE_LIMITS_V1.maxManifestBytes,
  )
  if (manifestBytes.byteLength === 0) {
    reject('PACK_BUDGET_EXCEEDED', 'source')
  }

  const orderedEntries: Array<{ entry: unknown; path: string }> = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    orderedEntries.push({ entry, path: rawEntryPath(entry) })
  }
  orderedEntries.sort((left, right) => (
    compareUnicodeCodePointsV1(left.path, right.path)
  ))

  const seenPaths = new Set<string>()
  const copiedEntries: ContentSourceEntryV1[] = []
  let totalBytes = 0
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const ordered = orderedEntries[index]
    const entry = ordered.entry
    if (entry === null || typeof entry !== 'object') {
      reject('PACK_SCHEMA_INVALID', 'source')
    }
    const path = ordered.path
    assertPayloadPath(path, 'source')
    const key = collisionKey(path)
    if (seenPaths.has(key)) {
      reject('PACK_PATH_COLLISION', 'source', { path })
    }
    seenPaths.add(key)
    const bytes = cloneBytes(
      readPropertyV1(entry, 'bytes', 'source', { path }),
      'source',
      CONTENT_PIPELINE_LIMITS_V1.maxFileBytes,
      { path },
    )
    totalBytes += bytes.byteLength
    if (totalBytes > CONTENT_PIPELINE_LIMITS_V1.maxTotalBytes) {
      reject('PACK_BUDGET_EXCEEDED', 'source', { path })
    }
    copiedEntries.push({ path, bytes })
  }

  const rawSignatureBytes = readPropertyV1(
    source,
    'signatureBytes',
    'source',
  )
  let signatureBytes: Uint8Array | null = null
  if (rawSignatureBytes !== undefined && rawSignatureBytes !== null) {
    signatureBytes = cloneBytes(
      rawSignatureBytes,
      'source',
      CONTENT_PIPELINE_LIMITS_V1.maxSignatureBytes,
    )
    if (signatureBytes.byteLength === 0) {
      reject('PACK_BUDGET_EXCEEDED', 'source')
    }
  }

  return {
    manifestBytes,
    signatureBytes,
    entries: copiedEntries,
  }
}

function nestedValueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

function parseManifest(manifestBytes: Uint8Array): PackManifestV1 {
  let raw: JsonValueV1
  try {
    raw = parseStrictJsonBytesV1(manifestBytes)
  } catch (error) {
    return rejectJsonFailure(error, 'manifest')
  }
  const result = PackManifestV1Schema.safeParse(raw)
  if (result.success) return result.data

  for (const issue of result.error.issues) {
    if (issue.message.includes('Duplicate patch target')) {
      reject('PATCH_OPERATION_CONFLICT', 'patch')
    }
    if (issue.message.includes('Duplicate file path')) {
      reject('PACK_PATH_COLLISION', 'manifest')
    }
    if (issue.path.includes('capabilities')) {
      reject('PACK_CAPABILITY_MISMATCH', 'capability')
    }
    if (issue.path.includes('compatibility')) {
      reject('PACK_ABI_UNSUPPORTED', 'compatibility')
    }
    if (issue.path.includes('mediaType')) {
      reject('PACK_MEDIA_TYPE_INVALID', 'manifest')
    }
    const field = issue.path.at(-1)
    if (field === 'path' || field === 'sourcePath' || field === 'targetPath') {
      const path = nestedValueAtPath(raw, issue.path)
      if (typeof path === 'string' && forbiddenActiveExtensionPattern.test(path)) {
        reject('PACK_FORBIDDEN_EXECUTABLE_CONTENT', 'manifest', { path })
      }
      reject('PACK_PATH_INVALID', 'manifest', {
        path: typeof path === 'string' ? path : undefined,
      })
    }
  }
  return reject('PACK_SCHEMA_INVALID', 'manifest')
}

function assertCompatibility(
  actual: PackCompatibilityV1,
  expected: PackCompatibilityV1,
  packId?: string,
): void {
  if (
    actual.engineAbi !== expected.engineAbi
    || actual.contentAbi !== expected.contentAbi
  ) {
    reject('PACK_ABI_UNSUPPORTED', 'compatibility', { packId })
  }
}

function validateSignature(
  signatureBytes: Uint8Array | null,
  manifest: PackManifestV1,
  packageHash: Sha256HexV1,
  policy: ContentValidationPolicyV1,
): PackSignatureEnvelopeV1 | null {
  if (signatureBytes === null) {
    if (policy.kind !== 'local-dev') {
      reject('PACK_SIGNATURE_REQUIRED', 'signature', { packId: manifest.packageId })
    }
    if (manifest.publisher.keyId !== null) {
      reject('PACK_PUBLISHER_KEY_MISMATCH', 'signature', {
        packId: manifest.packageId,
      })
    }
    return null
  }

  let rawEnvelope: JsonValueV1
  try {
    rawEnvelope = parseStrictJsonBytesV1(signatureBytes)
  } catch (error) {
    if (
      error instanceof JsonSafetyErrorV1
      && jsonBudgetReasons.has(error.reason)
    ) {
      return reject('PACK_BUDGET_EXCEEDED', 'signature', {
        packId: manifest.packageId,
      })
    }
    return reject('PACK_SIGNATURE_INVALID', 'signature', {
      packId: manifest.packageId,
    })
  }
  const verification = verifyPackageSignatureV1({
    envelope: rawEnvelope,
    expectedPackageHash: packageHash,
    expectedPublisherKeyId: manifest.publisher.keyId,
  })
  if (!verification.ok) {
    if (
      verification.reason === 'key-id-mismatch'
      || verification.reason === 'publisher-key-id-mismatch'
    ) {
      reject('PACK_PUBLISHER_KEY_MISMATCH', 'signature', {
        packId: manifest.packageId,
      })
    }
    reject('PACK_SIGNATURE_INVALID', 'signature', { packId: manifest.packageId })
  }
  return PackSignatureEnvelopeV1Schema.parse(rawEnvelope)
}

function assertDescriptorPathCollisions(
  files: readonly PackFileDescriptorV1[],
  stage: ContentPipelineStageV1,
  packId?: string,
): void {
  const seen = new Set<string>()
  for (const file of files) {
    const key = collisionKey(file.path)
    if (seen.has(key)) reject('PACK_PATH_COLLISION', stage, { packId, path: file.path })
    seen.add(key)
  }
}

function hasBytesPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}

function validateRasterMagic(
  descriptor: PackFileDescriptorV1,
  bytes: Uint8Array,
  packId?: string,
): void {
  let valid = false
  if (descriptor.mediaType === 'image/png') {
    valid = bytes.byteLength >= 8 && hasBytesPrefix(bytes, [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
  } else if (descriptor.mediaType === 'image/jpeg') {
    valid = bytes.byteLength >= 3 && hasBytesPrefix(bytes, [0xff, 0xd8, 0xff])
  } else if (descriptor.mediaType === 'image/webp') {
    if (
      bytes.byteLength >= 12
      && hasBytesPrefix(bytes, [0x52, 0x49, 0x46, 0x46])
      && bytes[8] === 0x57
      && bytes[9] === 0x45
      && bytes[10] === 0x42
      && bytes[11] === 0x50
    ) {
      const declaredLength = (
        bytes[4]
        | (bytes[5] << 8)
        | (bytes[6] << 16)
        | (bytes[7] << 24)
      ) >>> 0
      valid = declaredLength + 8 === bytes.byteLength
    }
  }
  if (!valid) {
    reject('PACK_MEDIA_TYPE_INVALID', 'content', {
      packId,
      path: descriptor.path,
    })
  }
}

function parsePveDocument(
  path: string,
  value: JsonValueV1,
  packId?: string,
): ParsedPveDocumentV1 | undefined {
  const schemaVersion = (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.schemaVersion === 'string'
  ) ? value.schemaVersion : undefined

  const parse = <T>(kind: ParsedPveDocumentV1['kind'], schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false }
  }): ParsedPveDocumentV1 => {
    const result = schema.safeParse(value)
    if (!result.success) reject('PACK_SCHEMA_INVALID', 'content', { packId, path })
    return { kind, value: result.data } as ParsedPveDocumentV1
  }

  switch (schemaVersion) {
    case 'rvb-pve-content-manifest/v1':
      return parse('content-manifest', PveContentManifestV1Schema)
    case 'rvb-pve-campaign/v1': return parse('campaign', PveCampaignV1Schema)
    case 'rvb-pve-chapter/v1': return parse('chapter', PveChapterV1Schema)
    case 'rvb-pve-encounter/v1': return parse('encounter', PveEncounterV1Schema)
    case 'rvb-pve-event/v1': return parse('event', PveEventV1Schema)
    case 'rvb-pve-reward/v1': return parse('reward', PveRewardV1Schema)
    case 'rvb-pve-relic/v1': return parse('relic', PveRelicV1Schema)
    case 'rvb-pve-enemy-setup/v1': return parse('enemy', PveEnemySetupV1Schema)
    case 'rvb-pve-node/v1': return parse('node', PveFlowNodeV1Schema)
    default:
      if (path.startsWith('data/pve/')) {
        reject('PACK_SCHEMA_INVALID', 'content', { packId, path })
      }
      return undefined
  }
}

function validateFileContent(
  descriptor: PackFileDescriptorV1,
  bytes: Uint8Array,
  allowExecutableContent: boolean,
  packId?: string,
): ValidatedFileFactV1 {
  if (descriptor.mediaType !== 'application/json') {
    validateRasterMagic(descriptor, bytes, packId)
    return { descriptor, bytes, hasExecutableContent: false }
  }

  let jsonValue: JsonValueV1
  try {
    jsonValue = parseStrictJsonBytesV1(bytes)
  } catch (error) {
    return rejectJsonFailure(error, 'content', { packId, path: descriptor.path })
  }
  const hasExecutableContent = hasExecutableContentV1(jsonValue)
  if (hasExecutableContent && !allowExecutableContent) {
    reject('PACK_FORBIDDEN_EXECUTABLE_CONTENT', 'content', {
      packId,
      path: descriptor.path,
    })
  }
  return {
    descriptor,
    bytes,
    jsonValue,
    pveDocument: parsePveDocument(descriptor.path, jsonValue, packId),
    hasExecutableContent,
  }
}

function validateInventory(
  manifest: PackManifestV1,
  entries: readonly ContentSourceEntryV1[],
  allowExecutableContent: boolean,
): ValidatedFileFactV1[] {
  assertDescriptorPathCollisions(manifest.files, 'manifest', manifest.packageId)
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]))
  const descriptorsByPath = new Map(manifest.files.map(file => [file.path, file]))

  for (const descriptor of manifest.files) {
    if (!entriesByPath.has(descriptor.path)) {
      reject('PACK_FILE_MISSING', 'inventory', {
        packId: manifest.packageId,
        path: descriptor.path,
      })
    }
  }
  for (const entry of entries) {
    if (!descriptorsByPath.has(entry.path)) {
      reject('PACK_FILE_UNDECLARED', 'inventory', {
        packId: manifest.packageId,
        path: entry.path,
      })
    }
  }

  const facts: ValidatedFileFactV1[] = []
  for (const descriptor of manifest.files) {
    const storedBytes = new Uint8Array(entriesByPath.get(descriptor.path)!.bytes)
    if (descriptor.size !== storedBytes.byteLength) {
      reject('PACK_SIZE_MISMATCH', 'inventory', {
        packId: manifest.packageId,
        path: descriptor.path,
      })
    }
    if (descriptor.sha256 !== sha256HexV1(storedBytes)) {
      reject('PACK_HASH_MISMATCH', 'inventory', {
        packId: manifest.packageId,
        path: descriptor.path,
      })
    }
    facts.push(validateFileContent(
      descriptor,
      storedBytes,
      allowExecutableContent,
      manifest.packageId,
    ))
  }
  return facts
}

function addFactCapabilities(
  result: Set<PackCapabilityV1>,
  fact: ValidatedFileFactV1,
  targetPath = fact.descriptor.path,
): void {
  for (const capability of deriveFileCapabilitiesV1({
    path: targetPath,
    mediaType: fact.descriptor.mediaType,
    jsonValue: fact.jsonValue,
    hasExecutableContent: fact.hasExecutableContent,
  })) {
    result.add(capability)
  }
}

function snapshotPatchParentFactsV1(
  context: unknown,
  packId: string,
): readonly ValidatedFileFactV1[] {
  let contextIsArray = false
  try {
    contextIsArray = Array.isArray(context)
  } catch {
    reject('PACK_SCHEMA_INVALID', 'patch', { packId })
  }
  if (
    context === null
    || typeof context !== 'object'
    || contextIsArray
  ) {
    reject('PACK_SCHEMA_INVALID', 'patch', { packId })
  }

  const parent = readPropertyV1(context, 'parent', 'patch', { packId })
  if (parent === undefined) {
    reject('PACK_REFERENCE_INVALID', 'patch', { packId })
  }
  let parentIsArray = false
  try {
    parentIsArray = Array.isArray(parent)
  } catch {
    reject('PACK_SCHEMA_INVALID', 'patch', { packId })
  }
  if (
    parent === null
    || typeof parent !== 'object'
    || parentIsArray
  ) {
    reject('PACK_SCHEMA_INVALID', 'patch', { packId })
  }

  const rawFiles = snapshotBoundedArrayV1(
    readPropertyV1(parent, 'files', 'patch', { packId }),
    'patch',
  )
  let descriptors: readonly PackFileDescriptorV1[] | undefined
  try {
    const result = PackFileInventoryV1Schema.safeParse(rawFiles)
    if (result.success) descriptors = result.data
  } catch {
    // Descriptor accessors and Proxies are untrusted at this boundary.
  }
  if (descriptors === undefined) {
    reject('PACK_SCHEMA_INVALID', 'patch', { packId })
  }
  assertDescriptorPathCollisions(descriptors, 'patch', packId)

  const readFile = readPropertyV1(parent, 'readFile', 'patch', { packId })
  if (typeof readFile !== 'function') {
    reject('PACK_SCHEMA_INVALID', 'patch', { packId })
  }

  const facts: ValidatedFileFactV1[] = []
  let totalBytes = 0
  for (const descriptor of descriptors) {
    let rawBytes: unknown
    try {
      rawBytes = Reflect.apply(readFile, parent, [descriptor.path])
    } catch {
      reject('PACK_SCHEMA_INVALID', 'patch', {
        packId,
        path: descriptor.path,
      })
    }
    if (rawBytes === undefined) {
      reject('PACK_FILE_MISSING', 'patch', {
        packId,
        path: descriptor.path,
      })
    }

    const snapshot = snapshotOrdinaryUint8ArrayV1(
      rawBytes,
      CONTENT_PIPELINE_LIMITS_V1.maxFileBytes,
    )
    if (!snapshot.ok) {
      if (snapshot.reason === 'budget') {
        reject('PACK_BUDGET_EXCEEDED', 'source', {
          packId,
          path: descriptor.path,
        })
      }
      reject('PACK_SCHEMA_INVALID', 'patch', {
        packId,
        path: descriptor.path,
      })
    }
    const bytes = snapshot.bytes
    totalBytes += bytes.byteLength
    if (totalBytes > CONTENT_PIPELINE_LIMITS_V1.maxTotalBytes) {
      reject('PACK_BUDGET_EXCEEDED', 'source', {
        packId,
        path: descriptor.path,
      })
    }
    if (descriptor.size !== bytes.byteLength) {
      reject('PACK_SIZE_MISMATCH', 'inventory', {
        packId,
        path: descriptor.path,
      })
    }
    if (descriptor.sha256 !== sha256HexV1(bytes)) {
      reject('PACK_HASH_MISMATCH', 'inventory', {
        packId,
        path: descriptor.path,
      })
    }
    facts.push(validateFileContent(descriptor, bytes, true, packId))
  }
  validatePveClosure(facts, packId)
  return Object.freeze(facts)
}

function assertTargetMediaMatches(
  fact: ValidatedFileFactV1,
  targetPath: string,
  packId: string,
): void {
  const result = PackFileDescriptorV1Schema.safeParse({
    ...fact.descriptor,
    path: targetPath,
  })
  if (!result.success) {
    reject('PACK_MEDIA_TYPE_INVALID', 'patch', { packId, path: targetPath })
  }
}

function derivePatchCapabilities(
  manifest: Extract<PackManifestV1, { kind: 'patch' }>,
  facts: readonly ValidatedFileFactV1[],
  parentFacts: readonly ValidatedFileFactV1[],
  policy: ContentValidationPolicyV1,
): readonly PackCapabilityV1[] {
  const factsByPath = new Map(facts.map(fact => [fact.descriptor.path, fact]))
  const parentByPath = new Map(
    parentFacts.map(fact => [fact.descriptor.path, fact]),
  )
  const parentByCollision = new Map(
    parentFacts.map(fact => [collisionKey(fact.descriptor.path), fact]),
  )
  const consumedPayload = new Set<string>()
  const seenTargets = new Set<string>()
  const capabilities = new Set<PackCapabilityV1>()

  for (const operation of manifest.operations) {
    const targetKey = collisionKey(operation.targetPath)
    if (seenTargets.has(targetKey)) {
      reject('PATCH_OPERATION_CONFLICT', 'patch', {
        packId: manifest.packageId,
        path: operation.targetPath,
      })
    }
    seenTargets.add(targetKey)
    const exactParent = parentByPath.get(operation.targetPath)
    const collidingParent = parentByCollision.get(targetKey)
    if (operation.op === 'add') {
      if (collidingParent !== undefined) {
        reject('PATCH_PRECONDITION_FAILED', 'patch', {
          packId: manifest.packageId,
          path: operation.targetPath,
        })
      }
    } else {
      if (
        exactParent === undefined
        || exactParent.descriptor.sha256 !== operation.expectedHash
      ) {
        reject('PATCH_PRECONDITION_FAILED', 'patch', {
          packId: manifest.packageId,
          path: operation.targetPath,
        })
      }
      if (
        policy.kind !== 'bundled-base'
        && exactParent.hasExecutableContent
      ) {
        reject('PACK_FORBIDDEN_EXECUTABLE_CONTENT', 'patch', {
          packId: manifest.packageId,
          path: operation.targetPath,
        })
      }
      addFactCapabilities(capabilities, exactParent)
    }

    if (operation.op !== 'remove') {
      const sourceFact = factsByPath.get(operation.sourcePath)
      if (sourceFact === undefined) {
        reject('PACK_FILE_MISSING', 'patch', {
          packId: manifest.packageId,
          path: operation.sourcePath,
        })
      }
      consumedPayload.add(operation.sourcePath)
      assertTargetMediaMatches(sourceFact, operation.targetPath, manifest.packageId)
      addFactCapabilities(capabilities, sourceFact, operation.targetPath)
    }
  }

  for (const fact of facts) {
    if (!consumedPayload.has(fact.descriptor.path)) {
      reject('PACK_FILE_UNDECLARED', 'patch', {
        packId: manifest.packageId,
        path: fact.descriptor.path,
      })
    }
  }
  return sortCapabilitiesV1(capabilities)
}

function nextNodeIds(node: PveFlowNodeV1): readonly string[] {
  switch (node.type) {
    case 'story':
    case 'roster':
    case 'reward':
    case 'checkpoint': return [node.nextNodeId]
    case 'battle': return [node.victoryNodeId, node.defeatNodeId, node.drawNodeId]
    case 'event': return node.outcomes.map(route => route.nextNodeId)
    case 'branch':
      return [...node.routes.map(route => route.nextNodeId), node.fallbackNodeId]
    case 'end': return []
  }
}

function contentDocumentId(document: ParsedPveDocumentV1): string | undefined {
  switch (document.kind) {
    case 'campaign': return document.value.campaignId
    case 'chapter': return document.value.chapterId
    case 'encounter': return document.value.encounterId
    case 'event': return document.value.eventId
    case 'reward': return document.value.rewardId
    case 'relic': return document.value.relicId
    case 'enemy': return document.value.enemySetupId
    default: return undefined
  }
}

function contentKey(kind: PveContentKindV1, contentId: string): string {
  return `${kind}\0${contentId}`
}

function validatePveClosure(
  facts: readonly ValidatedFileFactV1[],
  packId?: string,
): void {
  const factsByPath = new Map(facts.map(fact => [fact.descriptor.path, fact]))
  const registrationsByKey = new Map<string, {
    kind: PveContentKindV1
    contentId: string
    path: string
  }>()
  const registrationPaths = new Set<string>()
  const registeredManifestIds = new Set<string>()
  const campaigns = new Map<string, PveCampaignV1>()
  const chapters: PveChapterV1[] = []
  const encounters = new Map<string, PveEncounterV1>()
  const events = new Map<string, PveEventV1>()
  const rewards = new Map<string, PveRewardV1>()
  const enemies = new Map<string, PveEnemySetupV1>()
  const referencedNodePaths = new Set<string>()

  const invalidReference = (path?: string, contentId?: string): never => reject(
    'PACK_REFERENCE_INVALID',
    'reference',
    { packId, path, contentId },
  )

  for (const fact of facts) {
    const document = fact.pveDocument
    if (document === undefined) continue
    switch (document.kind) {
      case 'content-manifest': {
        if (registeredManifestIds.has(document.value.manifestId)) {
          invalidReference(fact.descriptor.path, document.value.manifestId)
        }
        registeredManifestIds.add(document.value.manifestId)
        for (const descriptor of document.value.documents) {
          const key = contentKey(descriptor.kind, descriptor.contentId)
          if (registrationsByKey.has(key) || registrationPaths.has(descriptor.path)) {
            invalidReference(descriptor.path, descriptor.contentId)
          }
          registrationsByKey.set(key, descriptor)
          registrationPaths.add(descriptor.path)
        }
        break
      }
      case 'campaign': campaigns.set(document.value.campaignId, document.value); break
      case 'chapter': chapters.push(document.value); break
      case 'encounter': encounters.set(document.value.encounterId, document.value); break
      case 'event': events.set(document.value.eventId, document.value); break
      case 'reward': rewards.set(document.value.rewardId, document.value); break
      case 'enemy': enemies.set(document.value.enemySetupId, document.value); break
      default: break
    }
  }

  for (const registration of registrationsByKey.values()) {
    const target = factsByPath.get(registration.path)
    if (target?.pveDocument === undefined) {
      invalidReference(registration.path, registration.contentId)
      continue
    }
    if (
      target.pveDocument.kind !== registration.kind
      || contentDocumentId(target.pveDocument) !== registration.contentId
    ) {
      invalidReference(registration.path, registration.contentId)
    }
  }

  for (const fact of facts) {
    const document = fact.pveDocument
    if (
      document === undefined
      || document.kind === 'content-manifest'
      || document.kind === 'node'
    ) {
      continue
    }
    const contentId = contentDocumentId(document)
    if (contentId === undefined) continue
    const registration = registrationsByKey.get(contentKey(document.kind, contentId))
    if (registration?.path !== fact.descriptor.path) {
      invalidReference(fact.descriptor.path, contentId)
    }
  }

  for (const chapter of chapters) {
    if (!campaigns.has(chapter.campaignId)) invalidReference(undefined, chapter.campaignId)
  }
  for (const encounter of encounters.values()) {
    if (!enemies.has(encounter.enemySetupId)) {
      invalidReference(undefined, encounter.enemySetupId)
    }
  }

  for (const campaign of campaigns.values()) {
    const nodes = new Map<string, PveFlowNodeV1>()
    for (const descriptor of campaign.nodes) {
      const fact = factsByPath.get(descriptor.path)
      if (fact?.pveDocument?.kind !== 'node') {
        invalidReference(descriptor.path, descriptor.nodeId)
        continue
      }
      if (fact.pveDocument.value.nodeId !== descriptor.nodeId) {
        invalidReference(descriptor.path, descriptor.nodeId)
      }
      nodes.set(descriptor.nodeId, fact.pveDocument.value)
      referencedNodePaths.add(descriptor.path)
    }

    for (const node of nodes.values()) {
      for (const nextNodeId of nextNodeIds(node)) {
        if (!nodes.has(nextNodeId)) invalidReference(undefined, nextNodeId)
      }
      if (node.type === 'battle' && !encounters.has(node.encounterId)) {
        invalidReference(undefined, node.encounterId)
      }
      if (node.type === 'reward' && !rewards.has(node.rewardId)) {
        invalidReference(undefined, node.rewardId)
      }
      if (node.type === 'event') {
        const event = events.get(node.eventId)
        if (event === undefined) {
          invalidReference(undefined, node.eventId)
          continue
        }
        const declared = [...new Set(event.choices.map(choice => choice.outcomeId))]
          .sort(compareUnicodeCodePointsV1)
        const routed = node.outcomes.map(route => route.outcomeId)
        if (
          declared.length !== routed.length
          || declared.some((outcomeId, index) => outcomeId !== routed[index])
        ) {
          invalidReference(undefined, node.eventId)
        }
      }
    }

    const reachable = new Set<string>()
    const pending = [campaign.entryNodeId]
    while (pending.length > 0) {
      const nodeId = pending.pop()!
      if (reachable.has(nodeId)) continue
      const node = nodes.get(nodeId)
      if (node === undefined) {
        invalidReference(undefined, nodeId)
        continue
      }
      reachable.add(nodeId)
      pending.push(...nextNodeIds(node))
    }
    if (reachable.size !== nodes.size) invalidReference(undefined, campaign.campaignId)
  }

  for (const fact of facts) {
    if (
      fact.pveDocument?.kind === 'node'
      && !referencedNodePaths.has(fact.descriptor.path)
    ) {
      invalidReference(fact.descriptor.path, fact.pveDocument.value.nodeId)
    }
  }
}

function freezePlainObject<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezePlainObject(nested)
  }
  return Object.freeze(value)
}

export function validatePackSourceV1(
  source: ContentPackSourceV1,
  policy: ContentValidationPolicyV1,
  context: PackValidationContextV1 = {},
): ValidatedPackV1 {
  const validatedPolicy = assertRuntimePolicyV1(policy)
  const preflighted = preflightSource(source)
  const manifest = parseManifest(preflighted.manifestBytes)
  assertCompatibility(
    manifest.compatibility,
    validatedPolicy.expectedCompatibility,
    manifest.packageId,
  )
  if (
    validatedPolicy.kind === 'bundled-base'
    && manifest.kind !== 'snapshot'
  ) {
    reject('PACK_SCHEMA_INVALID', 'manifest', { packId: manifest.packageId })
  }
  const packageHash = computePackageHashV1(manifest)
  const signatureEnvelope = validateSignature(
    preflighted.signatureBytes,
    manifest,
    packageHash,
    validatedPolicy,
  )
  const facts = validateInventory(
    manifest,
    preflighted.entries,
    validatedPolicy.kind === 'bundled-base',
  )

  let capabilities: readonly PackCapabilityV1[]
  if (manifest.kind === 'patch') {
    const parentFacts = snapshotPatchParentFactsV1(
      context,
      manifest.packageId,
    )
    capabilities = derivePatchCapabilities(
      manifest,
      facts,
      parentFacts,
      validatedPolicy,
    )
  } else {
    const derived = new Set<PackCapabilityV1>()
    for (const fact of facts) addFactCapabilities(derived, fact)
    capabilities = sortCapabilitiesV1(derived)
    validatePveClosure(facts, manifest.packageId)
  }
  if (!sameCapabilitiesV1(capabilities, manifest.capabilities)) {
    reject('PACK_CAPABILITY_MISMATCH', 'capability', { packId: manifest.packageId })
  }

  const tree = createReadonlyContentTreeV1(facts)
  return Object.freeze({
    ...tree,
    manifest: freezePlainObject(manifest),
    packageHash,
    signatureEnvelope: signatureEnvelope === null
      ? null
      : freezePlainObject(signatureEnvelope),
    networkEligible: validatedPolicy.kind !== 'local-dev',
    capabilities,
  })
}

function validateCandidateFiles(
  files: readonly unknown[],
  trustedExecutablePaths: readonly unknown[],
): ValidatedFileFactV1[] {
  const trusted = new Set<string>()
  for (let index = 0; index < trustedExecutablePaths.length; index += 1) {
    const path = trustedExecutablePaths[index]
    if (typeof path !== 'string') {
      reject('PACK_SCHEMA_INVALID', 'profile')
    }
    if (trusted.has(path)) {
      reject('PACK_CAPABILITY_MISMATCH', 'capability', { path })
    }
    trusted.add(path)
  }

  const seen = new Set<string>()
  const facts: ValidatedFileFactV1[] = []
  let totalBytes = 0
  let previousPath: string | undefined

  for (let index = 0; index < files.length; index += 1) {
    const input = files[index]
    if (input === null || typeof input !== 'object') {
      reject('PACK_SCHEMA_INVALID', 'profile')
    }
    const rawDescriptor = readPropertyV1(input, 'descriptor', 'profile')
    let descriptor: PackFileDescriptorV1 | undefined
    try {
      const parsedDescriptor = PackFileDescriptorV1Schema.safeParse(rawDescriptor)
      if (parsedDescriptor.success) descriptor = parsedDescriptor.data
    } catch {
      // Descriptor accessors are untrusted.
    }
    if (descriptor === undefined) reject('PACK_SCHEMA_INVALID', 'profile')

    if (
      previousPath !== undefined
      && compareUnicodeCodePointsV1(previousPath, descriptor.path) > 0
    ) {
      reject('PACK_SCHEMA_INVALID', 'profile', { path: descriptor.path })
    }
    previousPath = descriptor.path

    const key = collisionKey(descriptor.path)
    if (seen.has(key)) {
      reject('PACK_PATH_COLLISION', 'profile', { path: descriptor.path })
    }
    seen.add(key)

    const bytes = cloneBytes(
      readPropertyV1(input, 'bytes', 'profile', { path: descriptor.path }),
      'profile',
      CONTENT_PIPELINE_LIMITS_V1.maxFileBytes,
      { path: descriptor.path },
    )
    totalBytes += bytes.byteLength
    if (totalBytes > CONTENT_PIPELINE_LIMITS_V1.maxTotalBytes) {
      reject('PACK_BUDGET_EXCEEDED', 'source', { path: descriptor.path })
    }
    if (descriptor.size !== bytes.byteLength) {
      reject('PACK_SIZE_MISMATCH', 'inventory', { path: descriptor.path })
    }
    if (descriptor.sha256 !== sha256HexV1(bytes)) {
      reject('PACK_HASH_MISMATCH', 'inventory', { path: descriptor.path })
    }
    facts.push(validateFileContent(
      descriptor,
      bytes,
      trusted.has(descriptor.path),
    ))
  }

  for (const path of trusted) {
    const fact = facts.find(candidate => candidate.descriptor.path === path)
    if (fact === undefined || !fact.hasExecutableContent) {
      reject('PACK_CAPABILITY_MISMATCH', 'capability', { path })
    }
  }
  return facts
}

export function validateResolvedCandidateV1(
  input: ResolvedCandidateInputV1,
  expectedCompatibility: PackCompatibilityV1,
): ValidatedContentTreeV1 {
  if (input === null || typeof input !== 'object') {
    reject('PACK_SCHEMA_INVALID', 'profile')
  }

  const compatibility = parseCompatibilitySnapshotV1(
    readPropertyV1(input, 'compatibility', 'profile'),
    'profile',
  )
  const expected = parseCompatibilitySnapshotV1(
    expectedCompatibility,
    'profile',
  )
  assertCompatibility(compatibility, expected)

  const files = snapshotBoundedArrayV1(
    readPropertyV1(input, 'files', 'profile'),
    'profile',
  )
  const trustedExecutablePaths = snapshotBoundedArrayV1(
    readPropertyV1(input, 'trustedExecutablePaths', 'profile'),
    'profile',
  )
  const facts = validateCandidateFiles(files, trustedExecutablePaths)
  validatePveClosure(facts)
  const derived = new Set<PackCapabilityV1>()
  for (const fact of facts) addFactCapabilities(derived, fact)
  const capabilities = sortCapabilitiesV1(derived)
  const tree = createReadonlyContentTreeV1(facts)
  return Object.freeze({
    ...tree,
    compatibility,
    capabilities,
  })
}
