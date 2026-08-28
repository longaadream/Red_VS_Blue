import {
  compareUnicodeCodePointsV1,
  RESOLVED_PROFILE_SCHEMA_VERSION_V1,
  ResolvedProfileIdentityV1Schema,
  ResolvedProfileV1Schema,
  type AuthorityContentIdentityV1,
  type PackCompatibilityV1,
  type PackFileDescriptorV1,
  type ResolvedFileProvenanceV1,
  type ResolvedFileV1,
  type ResolvedPackageCoordinateV1,
  type ResolvedPatchCoordinateV1,
  type ResolvedProfileV1,
} from '../contracts'

import { ContentPipelineErrorV1 } from './error-codes'
import { computeResolvedProfileIdentitiesV1 } from './hash'
import type { ContentPackSourceV1, ReadonlyContentTreeV1 } from './source'
import {
  validatePackSourceV1,
  validateResolvedCandidateV1,
  type ContentValidationPolicyV1,
} from './validator'

export interface ResolvePackInputV1 {
  readonly source: ContentPackSourceV1
  readonly policy: ContentValidationPolicyV1
}

export type CandidateCheckResultV1 =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason?: string }>

export type CandidateCheckV1 = (
  candidate: ResolvedSnapshotViewV1,
) => CandidateCheckResultV1

export interface ResolveProfileInputV1 {
  readonly base: ResolvePackInputV1
  readonly patches?: readonly ResolvePackInputV1[]
  readonly candidateCheck?: CandidateCheckV1
}

/**
 * A resolved resource tree whose byte backing is never exposed. `readFile()`
 * returns a new copy on every call; profile and descriptor metadata are deeply
 * frozen before this view crosses the resolver boundary.
 */
export interface ResolvedSnapshotViewV1 extends ReadonlyContentTreeV1 {
  readonly profile: ResolvedProfileV1
  readonly authorityContentIdentity: AuthorityContentIdentityV1
  readonly networkEligible: boolean
}

interface InternalResolvedFileV1 {
  readonly descriptor: PackFileDescriptorV1
  readonly provenance: ResolvedFileProvenanceV1
  readonly bytes: Uint8Array
  readonly trustedExecutable: boolean
}

interface ResolutionStateV1 {
  readonly compatibility: PackCompatibilityV1
  readonly base: ResolvedPackageCoordinateV1
  readonly patches: readonly ResolvedPatchCoordinateV1[]
  readonly filesByPath: ReadonlyMap<string, InternalResolvedFileV1>
  readonly networkEligible: boolean
  readonly view: ResolvedSnapshotViewV1
}

// This runtime preflight must stay aligned with the frozen
// ResolvedPatchChainV1Schema.max(256) contract. It is intentionally not a
// caller-adjustable option.
const MAX_PATCH_CHAIN_LENGTH_V1 = 256

function patchInputSchemaError(): ContentPipelineErrorV1 {
  return new ContentPipelineErrorV1(
    'PACK_SCHEMA_INVALID',
    'patch',
  )
}

function packInputSchemaError(): ContentPipelineErrorV1 {
  return new ContentPipelineErrorV1(
    'PACK_SCHEMA_INVALID',
    'source',
  )
}

function candidateCheckError(): ContentPipelineErrorV1 {
  return new ContentPipelineErrorV1(
    'CANDIDATE_CHECK_FAILED',
    'candidate-check',
  )
}

function isNonArrayObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object') return false
  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * Capture the declared array by bounded numeric indices. Array iterators are
 * mutable JavaScript surface, so spread/for-of/Array.from would let a Proxy or
 * Array subclass yield more items than the length that passed the budget gate.
 */
function snapshotPatchInputsV1(
  input: ResolveProfileInputV1,
): readonly unknown[] {
  let declaredPatches: unknown
  try {
    declaredPatches = input.patches
  } catch {
    throw patchInputSchemaError()
  }

  if (declaredPatches === undefined) {
    return Object.freeze([] as unknown[])
  }

  let isArray: boolean
  try {
    isArray = Array.isArray(declaredPatches)
  } catch {
    throw patchInputSchemaError()
  }
  if (!isArray) throw patchInputSchemaError()

  let declaredLength: unknown
  try {
    declaredLength = (declaredPatches as unknown[]).length
  } catch {
    throw patchInputSchemaError()
  }
  if (
    typeof declaredLength !== 'number'
    || !Number.isSafeInteger(declaredLength)
    || declaredLength < 0
  ) {
    throw patchInputSchemaError()
  }
  if (declaredLength > MAX_PATCH_CHAIN_LENGTH_V1) {
    throw new ContentPipelineErrorV1(
      'PACK_BUDGET_EXCEEDED',
      'patch',
    )
  }

  const snapshot: unknown[] = []
  for (let index = 0; index < declaredLength; index += 1) {
    let hasIndex: boolean
    try {
      hasIndex = Object.prototype.hasOwnProperty.call(declaredPatches, index)
    } catch {
      throw patchInputSchemaError()
    }
    if (!hasIndex) throw patchInputSchemaError()

    let patchInput: unknown
    try {
      patchInput = (declaredPatches as unknown[])[index]
    } catch {
      throw patchInputSchemaError()
    }
    snapshot.push(patchInput)
  }
  return Object.freeze(snapshot)
}

function snapshotPackInputV1(input: unknown): ResolvePackInputV1 {
  if (!isNonArrayObject(input)) throw packInputSchemaError()

  let source: unknown
  try {
    source = input.source
  } catch {
    throw packInputSchemaError()
  }
  if (!isNonArrayObject(source)) throw packInputSchemaError()

  let policy: unknown
  try {
    policy = input.policy
  } catch {
    throw packInputSchemaError()
  }
  if (!isNonArrayObject(policy)) throw packInputSchemaError()

  return Object.freeze({
    source: source as unknown as ContentPackSourceV1,
    policy: policy as unknown as ContentValidationPolicyV1,
  })
}

function snapshotBaseInputV1(input: ResolveProfileInputV1): ResolvePackInputV1 {
  let base: unknown
  try {
    base = input.base
  } catch {
    throw packInputSchemaError()
  }
  return snapshotPackInputV1(base)
}

function runCandidateCheckV1(
  input: ResolveProfileInputV1,
  candidate: ResolvedSnapshotViewV1,
): void {
  let candidateCheck: unknown
  try {
    candidateCheck = input.candidateCheck
  } catch {
    throw candidateCheckError()
  }

  if (candidateCheck === undefined) return
  if (typeof candidateCheck !== 'function') throw candidateCheckError()

  let result: unknown
  try {
    result = candidateCheck(candidate)
  } catch {
    throw candidateCheckError()
  }
  if (!isNonArrayObject(result)) throw candidateCheckError()

  let accepted: unknown
  try {
    accepted = result.ok
  } catch {
    throw candidateCheckError()
  }
  if (accepted !== true) throw candidateCheckError()
}

function cloneCompatibility(
  compatibility: PackCompatibilityV1,
): PackCompatibilityV1 {
  return {
    engineAbi: compatibility.engineAbi,
    contentAbi: compatibility.contentAbi,
  }
}

function cloneDescriptor(
  descriptor: PackFileDescriptorV1,
): PackFileDescriptorV1 {
  return {
    path: descriptor.path,
    mediaType: descriptor.mediaType,
    size: descriptor.size,
    sha256: descriptor.sha256,
  }
}

function cloneProvenance(
  provenance: ResolvedFileProvenanceV1,
): ResolvedFileProvenanceV1 {
  return {
    packageHash: provenance.packageHash,
    operation: provenance.operation,
    sourcePath: provenance.sourcePath,
  }
}

function clonePackageCoordinate(
  coordinate: ResolvedPackageCoordinateV1,
): ResolvedPackageCoordinateV1 {
  return {
    packageId: coordinate.packageId,
    version: coordinate.version,
    packageHash: coordinate.packageHash,
  }
}

function clonePatchCoordinate(
  coordinate: ResolvedPatchCoordinateV1,
): ResolvedPatchCoordinateV1 {
  return {
    ...clonePackageCoordinate(coordinate),
    parentProfileHash: coordinate.parentProfileHash,
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }

  // Non-empty typed arrays cannot be frozen. No byte array is ever passed to
  // this helper; byte immutability is enforced by the copy-returning reader.
  if (ArrayBuffer.isView(value)) return value

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}

function sortedInternalFiles(
  filesByPath: ReadonlyMap<string, InternalResolvedFileV1>,
): InternalResolvedFileV1[] {
  return [...filesByPath.values()].sort((left, right) =>
    compareUnicodeCodePointsV1(left.descriptor.path, right.descriptor.path))
}

function createContentTreeView(
  filesByPath: ReadonlyMap<string, InternalResolvedFileV1>,
): ReadonlyContentTreeV1 {
  const files = deepFreeze(
    sortedInternalFiles(filesByPath).map(file => cloneDescriptor(file.descriptor)),
  )

  return Object.freeze({
    files,
    readFile(path: string): Uint8Array | undefined {
      return filesByPath.get(path)?.bytes.slice()
    },
    hasExecutableContent(path: string): boolean {
      return filesByPath.get(path)?.trustedExecutable ?? false
    },
  })
}

function sameCompatibility(
  left: PackCompatibilityV1,
  right: PackCompatibilityV1,
): boolean {
  return left.engineAbi === right.engineAbi
    && left.contentAbi === right.contentAbi
}

function materializeState(
  input: Readonly<{
    compatibility: PackCompatibilityV1
    base: ResolvedPackageCoordinateV1
    patches: readonly ResolvedPatchCoordinateV1[]
    filesByPath: ReadonlyMap<string, InternalResolvedFileV1>
    networkEligible: boolean
  }>,
): ResolutionStateV1 {
  const sorted = sortedInternalFiles(input.filesByPath)
  const validatedTree = validateResolvedCandidateV1(
    {
      compatibility: cloneCompatibility(input.compatibility),
      files: sorted.map(file => ({
        descriptor: cloneDescriptor(file.descriptor),
        bytes: file.bytes.slice(),
      })),
      trustedExecutablePaths: sorted
        .filter(file => file.trustedExecutable)
        .map(file => file.descriptor.path),
    },
    input.compatibility,
  )

  const resolvedFiles: ResolvedFileV1[] = validatedTree.files.map(descriptor => {
    const internal = input.filesByPath.get(descriptor.path)
    if (!internal) {
      throw new ContentPipelineErrorV1(
        'PACK_FILE_MISSING',
        'profile',
        { path: descriptor.path },
      )
    }
    return {
      descriptor: cloneDescriptor(descriptor),
      provenance: cloneProvenance(internal.provenance),
    }
  })

  const identity = ResolvedProfileIdentityV1Schema.parse({
    schemaVersion: RESOLVED_PROFILE_SCHEMA_VERSION_V1,
    compatibility: cloneCompatibility(validatedTree.compatibility),
    capabilities: [...validatedTree.capabilities],
    base: clonePackageCoordinate(input.base),
    patches: input.patches.map(clonePatchCoordinate),
    files: resolvedFiles,
  })
  const identities = computeResolvedProfileIdentitiesV1(identity)
  const profile = deepFreeze(ResolvedProfileV1Schema.parse({
    ...identity,
    resolvedProfileHash: identities.resolvedProfileHash,
    authorityContentHash: identities.authorityContentHash,
  }))
  const authorityContentIdentity = deepFreeze(
    identities.authorityContentIdentity,
  )
  const contentTree = createContentTreeView(input.filesByPath)
  const view: ResolvedSnapshotViewV1 = Object.freeze({
    ...contentTree,
    profile,
    authorityContentIdentity,
    networkEligible: input.networkEligible,
  })

  return {
    compatibility: cloneCompatibility(validatedTree.compatibility),
    base: clonePackageCoordinate(input.base),
    patches: input.patches.map(clonePatchCoordinate),
    filesByPath: input.filesByPath,
    networkEligible: input.networkEligible,
    view,
  }
}

function resolveBase(input: ResolvePackInputV1): ResolutionStateV1 {
  const validated = validatePackSourceV1(input.source, input.policy)
  if (validated.manifest.kind !== 'snapshot') {
    throw new ContentPipelineErrorV1(
      'PACK_SCHEMA_INVALID',
      'manifest',
      { packId: validated.manifest.packageId },
    )
  }

  const filesByPath = new Map<string, InternalResolvedFileV1>()
  for (const descriptor of validated.files) {
    const bytes = validated.readFile(descriptor.path)
    if (!bytes) {
      throw new ContentPipelineErrorV1(
        'PACK_FILE_MISSING',
        'profile',
        { packId: validated.manifest.packageId, path: descriptor.path },
      )
    }
    filesByPath.set(descriptor.path, {
      descriptor: cloneDescriptor(descriptor),
      provenance: {
        packageHash: validated.packageHash,
        operation: 'snapshot',
        sourcePath: descriptor.path,
      },
      bytes: bytes.slice(),
      trustedExecutable: validated.hasExecutableContent(descriptor.path),
    })
  }

  return materializeState({
    compatibility: validated.manifest.compatibility,
    base: {
      packageId: validated.manifest.packageId,
      version: validated.manifest.version,
      packageHash: validated.packageHash,
    },
    patches: [],
    filesByPath,
    networkEligible: validated.networkEligible,
  })
}

function cloneWorkingTree(
  filesByPath: ReadonlyMap<string, InternalResolvedFileV1>,
): Map<string, InternalResolvedFileV1> {
  return new Map([...filesByPath].map(([path, file]) => [path, {
    descriptor: cloneDescriptor(file.descriptor),
    provenance: cloneProvenance(file.provenance),
    bytes: file.bytes.slice(),
    trustedExecutable: file.trustedExecutable,
  }]))
}

function applyPatch(
  parent: ResolutionStateV1,
  input: ResolvePackInputV1,
): ResolutionStateV1 {
  const validated = validatePackSourceV1(input.source, input.policy, {
    parent: parent.view,
  })
  if (validated.manifest.kind !== 'patch') {
    throw new ContentPipelineErrorV1(
      'PACK_SCHEMA_INVALID',
      'manifest',
      { packId: validated.manifest.packageId },
    )
  }
  const manifest = validated.manifest

  if (manifest.parentProfileHash !== parent.view.profile.resolvedProfileHash) {
    throw new ContentPipelineErrorV1(
      'PATCH_PARENT_MISMATCH',
      'patch',
      { packId: manifest.packageId },
    )
  }
  if (!sameCompatibility(manifest.compatibility, parent.compatibility)) {
    throw new ContentPipelineErrorV1(
      'PACK_ABI_UNSUPPORTED',
      'compatibility',
      { packId: manifest.packageId },
    )
  }
  if (parent.patches.some(patch => patch.packageHash === validated.packageHash)) {
    throw new ContentPipelineErrorV1(
      'PATCH_OPERATION_CONFLICT',
      'patch',
      { packId: manifest.packageId },
    )
  }

  const sources = new Map(validated.files.map(file => [file.path, file]))

  // All operations are checked against the same parent before any staging
  // mutation, even though the v1 schema already requires unique targets.
  for (const operation of manifest.operations) {
    const current = parent.filesByPath.get(operation.targetPath)
    if (operation.op === 'add') {
      if (current) {
        throw new ContentPipelineErrorV1(
          'PATCH_PRECONDITION_FAILED',
          'patch',
          { packId: manifest.packageId, path: operation.targetPath },
        )
      }
    } else if (!current || current.descriptor.sha256 !== operation.expectedHash) {
      throw new ContentPipelineErrorV1(
        'PATCH_PRECONDITION_FAILED',
        'patch',
        { packId: manifest.packageId, path: operation.targetPath },
      )
    }

    if (
      operation.op !== 'remove'
      && !sources.has(operation.sourcePath)
    ) {
      throw new ContentPipelineErrorV1(
        'PACK_REFERENCE_INVALID',
        'patch',
        { packId: manifest.packageId, path: operation.sourcePath },
      )
    }
  }

  const nextFiles = cloneWorkingTree(parent.filesByPath)
  for (const operation of manifest.operations) {
    if (operation.op === 'remove') {
      nextFiles.delete(operation.targetPath)
      continue
    }

    const source = sources.get(operation.sourcePath)!
    const bytes = validated.readFile(operation.sourcePath)
    if (!bytes) {
      throw new ContentPipelineErrorV1(
        'PACK_FILE_MISSING',
        'patch',
        { packId: manifest.packageId, path: operation.sourcePath },
      )
    }
    nextFiles.set(operation.targetPath, {
      descriptor: {
        ...cloneDescriptor(source),
        path: operation.targetPath,
      },
      provenance: {
        packageHash: validated.packageHash,
        operation: operation.op,
        sourcePath: operation.sourcePath,
      },
      bytes: bytes.slice(),
      trustedExecutable: validated.hasExecutableContent(operation.sourcePath),
    })
  }

  return materializeState({
    compatibility: parent.compatibility,
    base: parent.base,
    patches: [
      ...parent.patches,
      {
        packageId: manifest.packageId,
        version: manifest.version,
        packageHash: validated.packageHash,
        parentProfileHash: manifest.parentProfileHash,
      },
    ],
    filesByPath: nextFiles,
    networkEligible: parent.networkEligible && validated.networkEligible,
  })
}

export function resolveProfileV1(
  input: ResolveProfileInputV1,
): ResolvedSnapshotViewV1 {
  const patches = snapshotPatchInputsV1(input)
  const base = snapshotBaseInputV1(input)

  let state = resolveBase(base)
  for (let index = 0; index < patches.length; index += 1) {
    state = applyPatch(state, snapshotPackInputV1(patches[index]))
  }

  runCandidateCheckV1(input, state.view)
  return state.view
}
