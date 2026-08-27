import { describe, expect, it } from 'vitest'

import type {
  PackCapabilityV1,
  PackCompatibilityV1,
  PackFileMediaTypeV1,
} from '@/lib/content-pipeline/contracts'
import { ContentPipelineErrorV1 } from '@/lib/content-pipeline/core/error-codes'
import { sha256HexV1 } from '@/lib/content-pipeline/core/hash'
import {
  resolveProfileV1,
  type ResolvePackInputV1,
} from '@/lib/content-pipeline/core/resolver'
import type { ContentPackSourceV1 } from '@/lib/content-pipeline/core/source'
import type { ContentValidationPolicyV1 } from '@/lib/content-pipeline/core/validator'

const encoder = new TextEncoder()
const compatibility = {
  engineAbi: 'rvb-engine/v1',
  contentAbi: 'rvb-content/v1',
} as const
const localDevPolicy = {
  kind: 'local-dev',
  expectedCompatibility: compatibility,
  allowUnsigned: true,
} as const satisfies ContentValidationPolicyV1

interface FixtureFile {
  readonly path: string
  readonly mediaType: PackFileMediaTypeV1
  readonly bytes: Uint8Array
}

type FixtureOperation =
  | Readonly<{ op: 'add'; targetPath: string; sourcePath: string }>
  | Readonly<{
    op: 'replace'
    targetPath: string
    sourcePath: string
    expectedHash: string
  }>
  | Readonly<{ op: 'remove'; targetPath: string; expectedHash: string }>

function png(marker: number): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    marker & 0xff,
  ])
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

function descriptor(file: FixtureFile) {
  return {
    path: file.path,
    mediaType: file.mediaType,
    size: file.bytes.byteLength,
    sha256: sha256HexV1(file.bytes),
  }
}

function createSource(
  manifest: Record<string, unknown>,
  files: readonly FixtureFile[],
  entryOrder: readonly number[] = files.map((_, index) => index),
): ContentPackSourceV1 {
  return {
    manifestBytes: encoder.encode(JSON.stringify(manifest)),
    signatureBytes: null,
    entries: entryOrder.map(index => ({
      path: files[index].path,
      bytes: files[index].bytes,
    })),
  }
}

function snapshotSource(input: Readonly<{
  files: readonly FixtureFile[]
  capabilities: readonly PackCapabilityV1[]
  packageId?: string
  version?: string
  entryOrder?: readonly number[]
}>): ContentPackSourceV1 {
  const files = [...input.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return createSource({
    schemaVersion: 'rvb-pack/v1',
    packageId: input.packageId ?? 'local.base',
    version: input.version ?? '1.0.0',
    displayName: 'Resolver base fixture',
    publisher: { id: 'local.fixture', keyId: null },
    compatibility,
    capabilities: input.capabilities,
    files: files.map(descriptor),
    kind: 'snapshot',
  }, files, input.entryOrder)
}

function patchSource(input: Readonly<{
  parentProfileHash: string
  files: readonly FixtureFile[]
  capabilities: readonly PackCapabilityV1[]
  operations: readonly FixtureOperation[]
  packageId: string
  version?: string
  packCompatibility?: PackCompatibilityV1
}>): ContentPackSourceV1 {
  const files = [...input.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return createSource({
    schemaVersion: 'rvb-pack/v1',
    packageId: input.packageId,
    version: input.version ?? '1.0.0',
    displayName: `Resolver patch ${input.packageId}`,
    publisher: { id: 'local.fixture', keyId: null },
    compatibility: input.packCompatibility ?? compatibility,
    capabilities: input.capabilities,
    files: files.map(descriptor),
    kind: 'patch',
    parentProfileHash: input.parentProfileHash,
    operations: input.operations,
  }, files)
}

function pack(
  source: ContentPackSourceV1,
  policy: ContentValidationPolicyV1 = localDevPolicy,
): ResolvePackInputV1 {
  return { source, policy }
}

function expectPipelineError(
  operation: () => unknown,
  code: ContentPipelineErrorV1['code'],
): ContentPipelineErrorV1 {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(ContentPipelineErrorV1)
    expect((error as ContentPipelineErrorV1).code).toBe(code)
    return error as ContentPipelineErrorV1
  }
  throw new Error(`Expected ContentPipelineErrorV1(${code})`)
}

describe('Content Pipeline v1 resolver', () => {
  it('is deterministic across input entry order and exposes only copy-backed bytes', () => {
    const firstBytes = png(1)
    const secondBytes = png(2)
    const files = [
      { path: 'images/a.png', mediaType: 'image/png', bytes: firstBytes },
      { path: 'images/b.png', mediaType: 'image/png', bytes: secondBytes },
    ] as const
    const forward = snapshotSource({
      files,
      capabilities: ['raster-assets'],
      entryOrder: [0, 1],
    })
    const reverse = snapshotSource({
      files,
      capabilities: ['raster-assets'],
      entryOrder: [1, 0],
    })

    const first = resolveProfileV1({ base: pack(forward) })
    const second = resolveProfileV1({ base: pack(reverse) })
    const originalFirstByte = first.readFile('images/a.png')![0]

    expect(second.profile).toEqual(first.profile)
    expect(second.authorityContentIdentity).toEqual(first.authorityContentIdentity)
    expect(first.profile.resolvedProfileHash).toBe(second.profile.resolvedProfileHash)
    expect(first.profile.authorityContentHash).toBe(second.profile.authorityContentHash)
    expect(first.networkEligible).toBe(false)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.profile)).toBe(true)
    expect(Object.isFrozen(first.profile.files)).toBe(true)

    firstBytes[0] = 0
    const returned = first.readFile('images/a.png')!
    returned[0] = 0
    expect(first.readFile('images/a.png')![0]).toBe(originalFirstByte)
  })

  it('applies an explicit add/replace/remove chain with final target provenance', () => {
    const oldA = png(10)
    const addedB = png(20)
    const newA = png(30)
    const base = snapshotSource({
      files: [{ path: 'images/a.png', mediaType: 'image/png', bytes: oldA }],
      capabilities: ['raster-assets'],
    })
    const baseView = resolveProfileV1({ base: pack(base) })
    const add = patchSource({
      parentProfileHash: baseView.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/b.png', mediaType: 'image/png', bytes: addedB }],
      capabilities: ['raster-assets'],
      operations: [{
        op: 'add',
        targetPath: 'images/b.png',
        sourcePath: 'images/patch/b.png',
      }],
      packageId: 'local.patch-add',
    })
    const afterAdd = resolveProfileV1({ base: pack(base), patches: [pack(add)] })
    const replaceAndRemove = patchSource({
      parentProfileHash: afterAdd.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/a.png', mediaType: 'image/png', bytes: newA }],
      capabilities: ['raster-assets'],
      operations: [
        {
          op: 'replace',
          targetPath: 'images/a.png',
          sourcePath: 'images/patch/a.png',
          expectedHash: sha256HexV1(oldA),
        },
        {
          op: 'remove',
          targetPath: 'images/b.png',
          expectedHash: sha256HexV1(addedB),
        },
      ],
      packageId: 'local.patch-replace-remove',
    })

    const input = {
      base: pack(base),
      patches: [pack(add), pack(replaceAndRemove)],
    }
    const result = resolveProfileV1(input)
    const repeated = resolveProfileV1(input)

    expect(result.files.map(file => file.path)).toEqual(['images/a.png'])
    expect(result.readFile('images/a.png')).toEqual(newA)
    expect(result.readFile('images/b.png')).toBeUndefined()
    expect(result.profile.patches).toHaveLength(2)
    expect(result.profile.patches[1].parentProfileHash)
      .toBe(afterAdd.profile.resolvedProfileHash)
    expect(result.profile.files[0].provenance).toMatchObject({
      operation: 'replace',
      sourcePath: 'images/patch/a.png',
    })
    expect(repeated.profile).toEqual(result.profile)
    expect(repeated.readFile('images/a.png')).toEqual(result.readFile('images/a.png'))
  })

  it('keeps authority identity stable for raster-only changes and changes it for JSON', () => {
    const oldRaster = png(40)
    const newRaster = png(41)
    const oldRules = json({ value: 1 })
    const newRules = json({ value: 2 })
    const base = snapshotSource({
      files: [
        { path: 'data/cards/base.json', mediaType: 'application/json', bytes: oldRules },
        { path: 'images/a.png', mediaType: 'image/png', bytes: oldRaster },
      ],
      capabilities: ['game-data', 'raster-assets'],
    })
    const baseView = resolveProfileV1({ base: pack(base) })
    const rasterPatch = patchSource({
      parentProfileHash: baseView.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/a.png', mediaType: 'image/png', bytes: newRaster }],
      capabilities: ['raster-assets'],
      operations: [{
        op: 'replace',
        targetPath: 'images/a.png',
        sourcePath: 'images/patch/a.png',
        expectedHash: sha256HexV1(oldRaster),
      }],
      packageId: 'local.raster-change',
    })
    const rasterView = resolveProfileV1({
      base: pack(base),
      patches: [pack(rasterPatch)],
    })
    const jsonPatch = patchSource({
      parentProfileHash: baseView.profile.resolvedProfileHash,
      files: [{ path: 'data/patch/rules.json', mediaType: 'application/json', bytes: newRules }],
      capabilities: ['game-data'],
      operations: [{
        op: 'replace',
        targetPath: 'data/cards/base.json',
        sourcePath: 'data/patch/rules.json',
        expectedHash: sha256HexV1(oldRules),
      }],
      packageId: 'local.rules-change',
    })
    const jsonView = resolveProfileV1({
      base: pack(base),
      patches: [pack(jsonPatch)],
    })

    expect(rasterView.profile.resolvedProfileHash)
      .not.toBe(baseView.profile.resolvedProfileHash)
    expect(rasterView.profile.authorityContentHash)
      .toBe(baseView.profile.authorityContentHash)
    expect(jsonView.profile.resolvedProfileHash)
      .not.toBe(baseView.profile.resolvedProfileHash)
    expect(jsonView.profile.authorityContentHash)
      .not.toBe(baseView.profile.authorityContentHash)
    expect(rasterView.authorityContentIdentity.files)
      .toEqual(baseView.authorityContentIdentity.files)
  })

  it('changes only full identity when a JSON replacement keeps identical target bytes', () => {
    const rules = json({ value: 1 })
    const base = snapshotSource({
      files: [{ path: 'data/cards/base.json', mediaType: 'application/json', bytes: rules }],
      capabilities: ['game-data'],
    })
    const parent = resolveProfileV1({ base: pack(base) })
    const sameBytesPatch = patchSource({
      parentProfileHash: parent.profile.resolvedProfileHash,
      files: [{ path: 'data/patch/same.json', mediaType: 'application/json', bytes: rules }],
      capabilities: ['game-data'],
      operations: [{
        op: 'replace',
        targetPath: 'data/cards/base.json',
        sourcePath: 'data/patch/same.json',
        expectedHash: sha256HexV1(rules),
      }],
      packageId: 'local.same-bytes-new-provenance',
    })

    const result = resolveProfileV1({
      base: pack(base),
      patches: [pack(sameBytesPatch)],
    })

    expect(result.profile.resolvedProfileHash)
      .not.toBe(parent.profile.resolvedProfileHash)
    expect(result.profile.authorityContentHash)
      .toBe(parent.profile.authorityContentHash)
    expect(result.authorityContentIdentity).toEqual(parent.authorityContentIdentity)
    expect(result.profile.files[0].provenance.operation).toBe('replace')
  })

  it('derives effective capabilities from targets when a remove-only patch empties a domain', () => {
    const rules = json({})
    const base = snapshotSource({
      files: [{ path: 'data/cards/base.json', mediaType: 'application/json', bytes: rules }],
      capabilities: ['game-data'],
    })
    const baseView = resolveProfileV1({ base: pack(base) })
    const remove = patchSource({
      parentProfileHash: baseView.profile.resolvedProfileHash,
      files: [],
      capabilities: ['game-data'],
      operations: [{
        op: 'remove',
        targetPath: 'data/cards/base.json',
        expectedHash: sha256HexV1(rules),
      }],
      packageId: 'local.remove-rules',
    })

    const result = resolveProfileV1({ base: pack(base), patches: [pack(remove)] })

    expect(result.profile.files).toEqual([])
    expect(result.profile.capabilities).toEqual([])
    expect(result.authorityContentIdentity.capabilities).toEqual([])
    expect(result.authorityContentIdentity.files).toEqual([])
    expect(result.profile.authorityContentHash)
      .not.toBe(baseView.profile.authorityContentHash)
  })

  it('rejects parent and operation precondition mismatches without polluting the parent', () => {
    const oldBytes = png(50)
    const newBytes = png(51)
    const base = snapshotSource({
      files: [{ path: 'images/a.png', mediaType: 'image/png', bytes: oldBytes }],
      capabilities: ['raster-assets'],
    })
    const parent = resolveProfileV1({ base: pack(base) })
    const parentProfile = structuredClone(parent.profile)
    const parentBytes = parent.readFile('images/a.png')!
    const wrongParent = patchSource({
      parentProfileHash: '0'.repeat(64),
      files: [{ path: 'images/patch/a.png', mediaType: 'image/png', bytes: newBytes }],
      capabilities: ['raster-assets'],
      operations: [{
        op: 'replace',
        targetPath: 'images/a.png',
        sourcePath: 'images/patch/a.png',
        expectedHash: sha256HexV1(oldBytes),
      }],
      packageId: 'local.wrong-parent',
    })
    const wrongExpected = patchSource({
      parentProfileHash: parent.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/a.png', mediaType: 'image/png', bytes: newBytes }],
      capabilities: ['raster-assets'],
      operations: [{
        op: 'replace',
        targetPath: 'images/a.png',
        sourcePath: 'images/patch/a.png',
        expectedHash: 'f'.repeat(64),
      }],
      packageId: 'local.wrong-expected',
    })

    expectPipelineError(
      () => resolveProfileV1({ base: pack(base), patches: [pack(wrongParent)] }),
      'PATCH_PARENT_MISMATCH',
    )
    expectPipelineError(
      () => resolveProfileV1({ base: pack(base), patches: [pack(wrongExpected)] }),
      'PATCH_PRECONDITION_FAILED',
    )
    expect(parent.profile).toEqual(parentProfile)
    expect(parent.readFile('images/a.png')).toEqual(parentBytes)
  })

  it('rejects a Patch whose ABI differs from its exact parent Profile', () => {
    const oldBytes = png(52)
    const newBytes = png(53)
    const base = snapshotSource({
      files: [{ path: 'images/a.png', mediaType: 'image/png', bytes: oldBytes }],
      capabilities: ['raster-assets'],
    })
    const parent = resolveProfileV1({ base: pack(base) })
    const incompatible = {
      engineAbi: 'rvb-engine/v2',
      contentAbi: 'rvb-content/v1',
    } as const
    const incompatiblePolicy = {
      kind: 'local-dev',
      expectedCompatibility: incompatible,
      allowUnsigned: true,
    } as const satisfies ContentValidationPolicyV1
    const patch = patchSource({
      parentProfileHash: parent.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/a.png', mediaType: 'image/png', bytes: newBytes }],
      capabilities: ['raster-assets'],
      operations: [{
        op: 'replace',
        targetPath: 'images/a.png',
        sourcePath: 'images/patch/a.png',
        expectedHash: sha256HexV1(oldBytes),
      }],
      packageId: 'local.incompatible',
      packCompatibility: incompatible,
    })

    expectPipelineError(() => resolveProfileV1({
      base: pack(base),
      patches: [pack(patch, incompatiblePolicy)],
    }), 'PACK_ABI_UNSUPPORTED')
  })

  it('rejects unused Patch payload and duplicate targets with stable codes', () => {
    const oldBytes = png(54)
    const payload = png(55)
    const base = snapshotSource({
      files: [{ path: 'images/a.png', mediaType: 'image/png', bytes: oldBytes }],
      capabilities: ['raster-assets'],
    })
    const parent = resolveProfileV1({ base: pack(base) })
    const unused = patchSource({
      parentProfileHash: parent.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/unused.png', mediaType: 'image/png', bytes: payload }],
      capabilities: ['raster-assets'],
      operations: [{
        op: 'remove',
        targetPath: 'images/a.png',
        expectedHash: sha256HexV1(oldBytes),
      }],
      packageId: 'local.unused-payload',
    })
    const duplicateTarget = patchSource({
      parentProfileHash: parent.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/add.png', mediaType: 'image/png', bytes: payload }],
      capabilities: ['raster-assets'],
      operations: [
        { op: 'add', targetPath: 'images/b.png', sourcePath: 'images/patch/add.png' },
        { op: 'add', targetPath: 'images/b.png', sourcePath: 'images/patch/add.png' },
      ],
      packageId: 'local.duplicate-target',
    })

    expectPipelineError(() => resolveProfileV1({
      base: pack(base),
      patches: [pack(unused)],
    }), 'PACK_FILE_UNDECLARED')
    expectPipelineError(() => resolveProfileV1({
      base: pack(base),
      patches: [pack(duplicateTarget)],
    }), 'PATCH_OPERATION_CONFLICT')
  })

  it('enforces the 256-Patch chain boundary before resolving inputs', () => {
    const base = snapshotSource({
      files: [{ path: 'images/a.png', mediaType: 'image/png', bytes: png(56) }],
      capabilities: ['raster-assets'],
    })
    const notActuallyAPatch = pack(base)

    expectPipelineError(() => resolveProfileV1({
      base: pack(base),
      patches: Array.from({ length: 256 }, () => notActuallyAPatch),
    }), 'PACK_SCHEMA_INVALID')
    const error = expectPipelineError(() => resolveProfileV1({
      base: pack(base),
      patches: Array.from({ length: 257 }, () => notActuallyAPatch),
    }), 'PACK_BUDGET_EXCEEDED')
    expect(error.stage).toBe('patch')
  })

  it('runs the candidate hook once after the complete chain and isolates its view', () => {
    const original = png(60)
    const added = png(61)
    const base = snapshotSource({
      files: [{ path: 'images/a.png', mediaType: 'image/png', bytes: original }],
      capabilities: ['raster-assets'],
    })
    const baseView = resolveProfileV1({ base: pack(base) })
    const add = patchSource({
      parentProfileHash: baseView.profile.resolvedProfileHash,
      files: [{ path: 'images/patch/b.png', mediaType: 'image/png', bytes: added }],
      capabilities: ['raster-assets'],
      operations: [{
        op: 'add',
        targetPath: 'images/b.png',
        sourcePath: 'images/patch/b.png',
      }],
      packageId: 'local.hook-add',
    })
    let calls = 0

    const result = resolveProfileV1({
      base: pack(base),
      patches: [pack(add)],
      candidateCheck(candidate) {
        calls += 1
        expect(Object.isFrozen(candidate)).toBe(true)
        expect(Object.isFrozen(candidate.profile)).toBe(true)
        expect(Object.isFrozen(candidate.profile.files[0].provenance)).toBe(true)
        expect(Object.isFrozen(candidate.authorityContentIdentity)).toBe(true)
        const copy = candidate.readFile('images/b.png')!
        copy[0] = 0
        return { ok: true }
      },
    })

    expect(calls).toBe(1)
    expect(result.readFile('images/b.png')).toEqual(added)
  })

  it('maps a false or throwing candidate hook to one stable error without changing inputs', () => {
    const original = png(70)
    const base = snapshotSource({
      files: [{ path: 'images/a.png', mediaType: 'image/png', bytes: original }],
      capabilities: ['raster-assets'],
    })
    const before = original.slice()
    let falseCalls = 0
    let throwCalls = 0

    const falseError = expectPipelineError(() => resolveProfileV1({
      base: pack(base),
      candidateCheck() {
        falseCalls += 1
        return { ok: false, reason: 'fixture failure' }
      },
    }), 'CANDIDATE_CHECK_FAILED')
    const throwError = expectPipelineError(() => resolveProfileV1({
      base: pack(base),
      candidateCheck() {
        throwCalls += 1
        throw new Error('fixture failure with sensitive details')
      },
    }), 'CANDIDATE_CHECK_FAILED')

    expect(falseCalls).toBe(1)
    expect(throwCalls).toBe(1)
    expect(falseError.stage).toBe('candidate-check')
    expect(throwError.stage).toBe('candidate-check')
    expect(throwError.message).not.toContain('sensitive details')
    expect(original).toEqual(before)
  })
})
