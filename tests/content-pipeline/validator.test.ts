import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  compareUnicodeCodePointsV1,
  type PackCapabilityV1,
  type PackCompatibilityV1,
  type PackFileDescriptorV1,
  type PackManifestV1,
  type PackPatchOperationV1,
} from '@/lib/content-pipeline/contracts'
import {
  CONTENT_PIPELINE_LIMITS_V1,
  ContentPipelineErrorV1,
} from '@/lib/content-pipeline/core/error-codes'
import { computePackageHashV1 } from '@/lib/content-pipeline/core/hash'
import {
  deriveEd25519PublicKeyV1,
  derivePublisherKeyIdV1,
  signPackageHashV1,
} from '@/lib/content-pipeline/core/signature'
import type {
  ContentPackSourceV1,
  ContentSourceEntryV1,
  ResolvedCandidateFileInputV1,
} from '@/lib/content-pipeline/core/source'
import {
  type ContentValidationPolicyV1,
  validatePackSourceV1,
  validateResolvedCandidateV1,
} from '@/lib/content-pipeline/core/validator'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const compatibility: PackCompatibilityV1 = {
  engineAbi: 'rvb-engine/v1',
  contentAbi: 'rvb-content/v1',
}
const localDevPolicy: ContentValidationPolicyV1 = {
  kind: 'local-dev',
  expectedCompatibility: compatibility,
  allowUnsigned: true,
}
const bundledPolicy: ContentValidationPolicyV1 = {
  kind: 'bundled-base',
  expectedCompatibility: compatibility,
}
const externalPolicy: ContentValidationPolicyV1 = {
  kind: 'external',
  expectedCompatibility: compatibility,
}
const signingSecret = Uint8Array.from(
  { length: 32 },
  (_value, index) => index + 1,
)
const signingKeyId = derivePublisherKeyIdV1(
  deriveEd25519PublicKeyV1(signingSecret),
)

function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function mediaType(path: string): PackFileDescriptorV1['mediaType'] {
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

function fileDescriptor(entry: ContentSourceEntryV1): PackFileDescriptorV1 {
  return {
    path: entry.path,
    mediaType: mediaType(entry.path),
    size: entry.bytes.byteLength,
    sha256: sha256(entry.bytes),
  }
}

function sortEntries(entries: readonly ContentSourceEntryV1[]): ContentSourceEntryV1[] {
  return [...entries].sort((left, right) => (
    compareUnicodeCodePointsV1(left.path, right.path)
  ))
}

function snapshotManifest(
  entries: readonly ContentSourceEntryV1[],
  capabilities: readonly PackCapabilityV1[],
  overrides: Partial<PackManifestV1> = {},
): PackManifestV1 {
  return {
    schemaVersion: 'rvb-pack/v1',
    packageId: 'tests.validator',
    version: '1.0.0',
    displayName: 'Validator fixture',
    publisher: { id: 'tests', keyId: null },
    compatibility,
    capabilities: [...capabilities],
    files: sortEntries(entries).map(fileDescriptor),
    kind: 'snapshot',
    ...overrides,
  } as PackManifestV1
}

function sourceFromManifest(
  manifest: PackManifestV1,
  entries: readonly ContentSourceEntryV1[],
  manifestBytes = utf8(JSON.stringify(manifest)),
): ContentPackSourceV1 {
  return { manifestBytes, entries }
}

function snapshotSource(
  entries: readonly ContentSourceEntryV1[],
  capabilities: readonly PackCapabilityV1[],
  overrides: Partial<PackManifestV1> = {},
): ContentPackSourceV1 {
  return sourceFromManifest(
    snapshotManifest(entries, capabilities, overrides),
    entries,
  )
}

function signedSnapshotSource(
  entries: readonly ContentSourceEntryV1[],
  capabilities: readonly PackCapabilityV1[],
  overrides: Partial<PackManifestV1> = {},
): ContentPackSourceV1 {
  const manifest = snapshotManifest(entries, capabilities, {
    ...overrides,
    publisher: { id: 'tests', keyId: signingKeyId },
  })
  const envelope = signPackageHashV1(
    computePackageHashV1(manifest),
    signingSecret,
  )
  return {
    ...sourceFromManifest(manifest, entries),
    signatureBytes: utf8(JSON.stringify(envelope)),
  }
}

function patchSource(
  entries: readonly ContentSourceEntryV1[],
  capabilities: readonly PackCapabilityV1[],
  operations: readonly PackPatchOperationV1[],
): ContentPackSourceV1 {
  const manifest: PackManifestV1 = {
    schemaVersion: 'rvb-pack/v1',
    packageId: 'tests.patch',
    version: '1.0.0',
    displayName: 'Patch fixture',
    publisher: { id: 'tests', keyId: null },
    compatibility,
    capabilities: [...capabilities],
    files: sortEntries(entries).map(fileDescriptor),
    kind: 'patch',
    parentProfileHash: 'a'.repeat(64),
    operations: [...operations],
  }
  return sourceFromManifest(manifest, entries)
}

function signedPatchSource(
  entries: readonly ContentSourceEntryV1[],
  capabilities: readonly PackCapabilityV1[],
  operations: readonly PackPatchOperationV1[],
): ContentPackSourceV1 {
  const unsigned = patchSource(entries, capabilities, operations)
  const rawManifest = JSON.parse(
    decoder.decode(unsigned.manifestBytes),
  ) as PackManifestV1
  const manifest = {
    ...rawManifest,
    publisher: { id: 'tests', keyId: signingKeyId },
  } as PackManifestV1
  const envelope = signPackageHashV1(
    computePackageHashV1(manifest),
    signingSecret,
  )
  return {
    ...sourceFromManifest(manifest, entries),
    signatureBytes: utf8(JSON.stringify(envelope)),
  }
}

function rawBudgetSource(
  entries: readonly ContentSourceEntryV1[],
): ContentPackSourceV1 {
  return { manifestBytes: utf8('{}'), entries }
}

function expectPipelineError(
  operation: () => unknown,
  code: ContentPipelineErrorV1['code'],
  stage: ContentPipelineErrorV1['stage'],
): ContentPipelineErrorV1 {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(ContentPipelineErrorV1)
    const pipelineError = error as ContentPipelineErrorV1
    expect(pipelineError).toMatchObject({ code, stage })
    return pipelineError
  }
  throw new Error(`Expected ${code}`)
}

function candidateFiles(
  entries: readonly ContentSourceEntryV1[],
): ResolvedCandidateFileInputV1[] {
  return sortEntries(entries).map(entry => ({
    descriptor: fileDescriptor(entry),
    bytes: entry.bytes,
  }))
}

function jsonArrayBytes(valueCount: number): Uint8Array {
  const values = valueCount === 0 ? '' : `${'0,'.repeat(valueCount - 1)}0`
  return utf8(`[${values}]`)
}

function validPveEntries(nextNodeId = 'finish'): ContentSourceEntryV1[] {
  const contentManifest = {
    schemaVersion: 'rvb-pve-content-manifest/v1',
    manifestId: 'validator-pve',
    documents: [{
      kind: 'campaign',
      contentId: 'validator-campaign',
      path: 'data/pve/campaign.json',
    }],
  }
  const campaign = {
    schemaVersion: 'rvb-pve-campaign/v1',
    campaignId: 'validator-campaign',
    version: '1.0.0',
    entryNodeId: 'intro',
    nodes: [
      { nodeId: 'finish', path: 'data/pve/nodes/finish.json' },
      { nodeId: 'intro', path: 'data/pve/nodes/intro.json' },
    ],
  }
  return [
    {
      path: 'data/pve/manifest.json',
      bytes: utf8(JSON.stringify(contentManifest)),
    },
    {
      path: 'data/pve/campaign.json',
      bytes: utf8(JSON.stringify(campaign)),
    },
    {
      path: 'data/pve/nodes/intro.json',
      bytes: utf8(JSON.stringify({
        schemaVersion: 'rvb-pve-node/v1',
        nodeId: 'intro',
        type: 'story',
        storyId: 'intro-story',
        nextNodeId,
      })),
    },
    {
      path: 'data/pve/nodes/finish.json',
      bytes: utf8(JSON.stringify({
        schemaVersion: 'rvb-pve-node/v1',
        nodeId: 'finish',
        type: 'end',
        endingId: 'finished',
        outcome: 'completed',
      })),
    },
  ]
}

function fullPveEntries(): ContentSourceEntryV1[] {
  const documents = [
    {
      kind: 'campaign',
      contentId: 'campaign-main',
      path: 'data/pve/campaign.json',
    },
    {
      kind: 'chapter',
      contentId: 'chapter-one',
      path: 'data/pve/chapter.json',
    },
    {
      kind: 'encounter',
      contentId: 'encounter-one',
      path: 'data/pve/encounter.json',
    },
    {
      kind: 'enemy',
      contentId: 'enemy-one',
      path: 'data/pve/enemy.json',
    },
    {
      kind: 'event',
      contentId: 'event-one',
      path: 'data/pve/event.json',
    },
    {
      kind: 'reward',
      contentId: 'reward-one',
      path: 'data/pve/reward.json',
    },
  ]
  const nodes = [
    { nodeId: 'battle', path: 'data/pve/nodes/battle.json' },
    { nodeId: 'event-node', path: 'data/pve/nodes/event.json' },
    { nodeId: 'failed', path: 'data/pve/nodes/failed.json' },
    { nodeId: 'finish', path: 'data/pve/nodes/finish.json' },
    { nodeId: 'intro', path: 'data/pve/nodes/intro.json' },
    { nodeId: 'reward-node', path: 'data/pve/nodes/reward.json' },
  ]
  const jsonEntries: Array<[string, Record<string, unknown>]> = [
    ['data/pve/manifest.json', {
      schemaVersion: 'rvb-pve-content-manifest/v1',
      manifestId: 'full-pve',
      documents,
    }],
    ['data/pve/campaign.json', {
      schemaVersion: 'rvb-pve-campaign/v1',
      campaignId: 'campaign-main',
      version: '1.0.0',
      entryNodeId: 'intro',
      nodes,
    }],
    ['data/pve/chapter.json', {
      schemaVersion: 'rvb-pve-chapter/v1',
      chapterId: 'chapter-one',
      titleTextId: 'chapter-title',
      descriptionTextId: 'chapter-description',
      campaignId: 'campaign-main',
    }],
    ['data/pve/encounter.json', {
      schemaVersion: 'rvb-pve-encounter/v1',
      encounterId: 'encounter-one',
      mapId: 'map-one',
      enemySetupId: 'enemy-one',
      objectiveId: 'objective-one',
    }],
    ['data/pve/enemy.json', {
      schemaVersion: 'rvb-pve-enemy-setup/v1',
      enemySetupId: 'enemy-one',
      rosterId: 'enemy-roster',
      aiProfileId: 'enemy-ai',
    }],
    ['data/pve/event.json', {
      schemaVersion: 'rvb-pve-event/v1',
      eventId: 'event-one',
      narrativeId: 'event-narrative',
      choices: [{
        choiceId: 'choice-one',
        labelTextId: 'choice-label',
        effectId: 'choice-effect',
        outcomeId: 'accepted',
      }],
    }],
    ['data/pve/reward.json', {
      schemaVersion: 'rvb-pve-reward/v1',
      rewardId: 'reward-one',
      rewardTableId: 'reward-table',
      grantEffectId: 'reward-effect',
    }],
    ['data/pve/nodes/intro.json', {
      schemaVersion: 'rvb-pve-node/v1',
      nodeId: 'intro',
      type: 'story',
      storyId: 'intro-story',
      nextNodeId: 'battle',
    }],
    ['data/pve/nodes/battle.json', {
      schemaVersion: 'rvb-pve-node/v1',
      nodeId: 'battle',
      type: 'battle',
      encounterId: 'encounter-one',
      victoryNodeId: 'event-node',
      defeatNodeId: 'failed',
      drawNodeId: 'failed',
    }],
    ['data/pve/nodes/event.json', {
      schemaVersion: 'rvb-pve-node/v1',
      nodeId: 'event-node',
      type: 'event',
      eventId: 'event-one',
      outcomes: [{ outcomeId: 'accepted', nextNodeId: 'reward-node' }],
    }],
    ['data/pve/nodes/reward.json', {
      schemaVersion: 'rvb-pve-node/v1',
      nodeId: 'reward-node',
      type: 'reward',
      rewardId: 'reward-one',
      nextNodeId: 'finish',
    }],
    ['data/pve/nodes/failed.json', {
      schemaVersion: 'rvb-pve-node/v1',
      nodeId: 'failed',
      type: 'end',
      endingId: 'failed-ending',
      outcome: 'failed',
    }],
    ['data/pve/nodes/finish.json', {
      schemaVersion: 'rvb-pve-node/v1',
      nodeId: 'finish',
      type: 'end',
      endingId: 'finished-ending',
      outcome: 'completed',
    }],
  ]
  return jsonEntries.map(([path, value]) => ({
    path,
    bytes: utf8(JSON.stringify(value)),
  }))
}

function mutateJsonEntry(
  entries: readonly ContentSourceEntryV1[],
  path: string,
  mutate: (value: Record<string, unknown>) => void,
): ContentSourceEntryV1[] {
  return entries.map(entry => {
    if (entry.path !== path) return entry
    const value = JSON.parse(decoder.decode(entry.bytes)) as Record<string, unknown>
    mutate(value)
    return { ...entry, bytes: utf8(JSON.stringify(value)) }
  })
}

function validateCandidate(entries: readonly ContentSourceEntryV1[]) {
  return validateResolvedCandidateV1({
    compatibility,
    files: candidateFiles(entries),
    trustedExecutablePaths: [],
  }, compatibility)
}

describe('Content Pipeline v1 source and JSON safety', () => {
  it('copies input and returns a fresh byte copy on every read', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{"id":"basic"}') }
    const source = snapshotSource([entry], ['game-data'])
    const validated = validatePackSourceV1(source, localDevPolicy)

    entry.bytes[0] = 0
    source.manifestBytes[0] = 0
    const firstRead = validated.readFile(entry.path)!
    expect(decoder.decode(firstRead)).toBe('{"id":"basic"}')
    firstRead[0] = 0
    expect(decoder.decode(validated.readFile(entry.path)!)).toBe('{"id":"basic"}')
    expect(validated.networkEligible).toBe(false)
  })

  it.each([
    ['../data/cards.json', 'PACK_PATH_INVALID'],
    ['/data/cards.json', 'PACK_PATH_INVALID'],
    ['C:/data/cards.json', 'PACK_PATH_INVALID'],
    ['data\\cards.json', 'PACK_PATH_INVALID'],
    ['data/index.html', 'PACK_FORBIDDEN_EXECUTABLE_CONTENT'],
    ['images/vector.svg', 'PACK_FORBIDDEN_EXECUTABLE_CONTENT'],
  ] as const)('rejects unsafe or active path %s', (path, expectedCode) => {
    const entry = { path, bytes: utf8('{}') }
    expectPipelineError(
      () => validatePackSourceV1(snapshotSource([entry], []), localDevPolicy),
      expectedCode,
      'source',
    )
  })

  it('sorts raw entries before reporting a deterministic first source error', () => {
    const first = { path: '../first.json', bytes: utf8('{}') }
    const second = { path: 'data\\second.json', bytes: utf8('{}') }
    const errors = [
      [first, second],
      [second, first],
    ].map(entries => expectPipelineError(
      () => validatePackSourceV1(snapshotSource(entries, []), localDevPolicy),
      'PACK_PATH_INVALID',
      'source',
    ))
    expect(errors.map(error => error.path)).toEqual([
      '../first.json',
      '../first.json',
    ])
  })

  it('rejects exact/case path collisions before manifest parsing', () => {
    const entries = [
      { path: 'data/cards/Test.json', bytes: utf8('{}') },
      { path: 'data/cards/test.json', bytes: utf8('{}') },
    ]
    expectPipelineError(
      () => validatePackSourceV1(snapshotSource(entries, ['game-data']), localDevPolicy),
      'PACK_PATH_COLLISION',
      'source',
    )
  })

  it('rejects BOM, malformed UTF-8, and decoded duplicate keys', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const manifest = snapshotManifest([entry], ['game-data'])
    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...utf8(JSON.stringify(manifest)),
    ])
    for (const manifestBytes of [bom, new Uint8Array([0xc0, 0xaf])]) {
      expectPipelineError(
        () => validatePackSourceV1(
          sourceFromManifest(manifest, [entry], manifestBytes),
          localDevPolicy,
        ),
        'PACK_SCHEMA_INVALID',
        'manifest',
      )
    }

    const duplicate = {
      path: 'data/cards/duplicate.json',
      bytes: utf8('{"a":1,"\\u0061":2}'),
    }
    expectPipelineError(
      () => validatePackSourceV1(
        snapshotSource([duplicate], ['game-data']),
        localDevPolicy,
      ),
      'PACK_SCHEMA_INVALID',
      'content',
    )
  })

  it('accepts the JSON depth boundary and rejects depth + 1 as a budget error', () => {
    const exactDepth = CONTENT_PIPELINE_LIMITS_V1.maxJsonDepth - 1
    const exact = {
      path: 'data/depth.json',
      bytes: utf8(`${'['.repeat(exactDepth)}0${']'.repeat(exactDepth)}`),
    }
    expect(validatePackSourceV1(
      snapshotSource([exact], ['game-data']),
      localDevPolicy,
    ).readFile(exact.path)).toBeDefined()

    const over = {
      ...exact,
      bytes: utf8(`${'['.repeat(exactDepth + 1)}0${']'.repeat(exactDepth + 1)}`),
    }
    expectPipelineError(
      () => validatePackSourceV1(snapshotSource([over], ['game-data']), localDevPolicy),
      'PACK_BUDGET_EXCEEDED',
      'content',
    )
  })

  it('accepts the JSON node boundary and rejects node count + 1', () => {
    const exactValues = CONTENT_PIPELINE_LIMITS_V1.maxJsonNodes - 1
    const exact = { path: 'data/nodes.json', bytes: jsonArrayBytes(exactValues) }
    expect(validatePackSourceV1(
      snapshotSource([exact], ['game-data']),
      localDevPolicy,
    ).readFile(exact.path)).toBeDefined()

    const over = { ...exact, bytes: jsonArrayBytes(exactValues + 1) }
    expectPipelineError(
      () => validatePackSourceV1(snapshotSource([over], ['game-data']), localDevPolicy),
      'PACK_BUDGET_EXCEEDED',
      'content',
    )
  })

  it('accepts the JSON string-byte boundary and rejects string bytes + 1', () => {
    const exactLength = CONTENT_PIPELINE_LIMITS_V1.maxJsonStringBytes
    const exact = {
      path: 'data/string.json',
      bytes: utf8(JSON.stringify('a'.repeat(exactLength))),
    }
    expect(validatePackSourceV1(
      snapshotSource([exact], ['game-data']),
      localDevPolicy,
    ).readFile(exact.path)).toBeDefined()

    const over = {
      ...exact,
      bytes: utf8(JSON.stringify('a'.repeat(exactLength + 1))),
    }
    expectPipelineError(
      () => validatePackSourceV1(snapshotSource([over], ['game-data']), localDevPolicy),
      'PACK_BUDGET_EXCEEDED',
      'content',
    )
  })

  it('enforces entry count at the exact boundary and + 1', () => {
    const empty = new Uint8Array()
    const entries = Array.from(
      { length: CONTENT_PIPELINE_LIMITS_V1.maxEntries },
      (_value, index) => ({
        path: `data/budget/${String(index).padStart(4, '0')}.json`,
        bytes: empty,
      }),
    )
    expectPipelineError(
      () => validatePackSourceV1(rawBudgetSource(entries), localDevPolicy),
      'PACK_SCHEMA_INVALID',
      'manifest',
    )
    expectPipelineError(
      () => validatePackSourceV1(rawBudgetSource([
        ...entries,
        { path: 'data/budget/over.json', bytes: empty },
      ]), localDevPolicy),
      'PACK_BUDGET_EXCEEDED',
      'source',
    )
  })

  it('enforces per-file bytes at the exact boundary and + 1', () => {
    const exact = {
      path: 'data/budget/file.json',
      bytes: new Uint8Array(CONTENT_PIPELINE_LIMITS_V1.maxFileBytes),
    }
    expectPipelineError(
      () => validatePackSourceV1(rawBudgetSource([exact]), localDevPolicy),
      'PACK_SCHEMA_INVALID',
      'manifest',
    )
    expectPipelineError(
      () => validatePackSourceV1(rawBudgetSource([{
        ...exact,
        bytes: new Uint8Array(CONTENT_PIPELINE_LIMITS_V1.maxFileBytes + 1),
      }]), localDevPolicy),
      'PACK_BUDGET_EXCEEDED',
      'source',
    )
  })

  it('enforces total bytes at the exact boundary and + 1', () => {
    const maximumFile = new Uint8Array(CONTENT_PIPELINE_LIMITS_V1.maxFileBytes)
    const filesAtLimit = CONTENT_PIPELINE_LIMITS_V1.maxTotalBytes
      / CONTENT_PIPELINE_LIMITS_V1.maxFileBytes
    const entries = Array.from({ length: filesAtLimit }, (_value, index) => ({
      path: `data/total/${index}.json`,
      bytes: maximumFile,
    }))
    expectPipelineError(
      () => validatePackSourceV1(rawBudgetSource(entries), localDevPolicy),
      'PACK_SCHEMA_INVALID',
      'manifest',
    )
    expectPipelineError(
      () => validatePackSourceV1(rawBudgetSource([
        ...entries,
        { path: 'data/total/over.json', bytes: Uint8Array.of(0) },
      ]), localDevPolicy),
      'PACK_BUDGET_EXCEEDED',
      'source',
    )
  })

  it('distinguishes inventory, hash, size, and magic failures', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const manifest = snapshotManifest([entry], ['game-data'])
    expectPipelineError(
      () => validatePackSourceV1(sourceFromManifest(manifest, []), localDevPolicy),
      'PACK_FILE_MISSING',
      'inventory',
    )

    const extra = { path: 'data/cards/extra.json', bytes: utf8('{}') }
    expectPipelineError(
      () => validatePackSourceV1(
        sourceFromManifest(manifest, [entry, extra]),
        localDevPolicy,
      ),
      'PACK_FILE_UNDECLARED',
      'inventory',
    )

    const wrongSize = structuredClone(manifest)
    wrongSize.files[0].size += 1
    expectPipelineError(
      () => validatePackSourceV1(sourceFromManifest(wrongSize, [entry]), localDevPolicy),
      'PACK_SIZE_MISMATCH',
      'inventory',
    )

    const wrongHash = structuredClone(manifest)
    wrongHash.files[0].sha256 = '0'.repeat(64)
    expectPipelineError(
      () => validatePackSourceV1(sourceFromManifest(wrongHash, [entry]), localDevPolicy),
      'PACK_HASH_MISMATCH',
      'inventory',
    )

    const invalidPng = { path: 'images/cards/basic.png', bytes: utf8('not png') }
    expectPipelineError(
      () => validatePackSourceV1(
        snapshotSource([invalidPng], ['raster-assets']),
        localDevPolicy,
      ),
      'PACK_MEDIA_TYPE_INVALID',
      'content',
    )
  })
})

describe('Content Pipeline v1 policy and capabilities', () => {
  it('requires signatures for unsigned external and bundled packs', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    for (const policy of [externalPolicy, bundledPolicy]) {
      expectPipelineError(
        () => validatePackSourceV1(snapshotSource([entry], ['game-data']), policy),
        'PACK_SIGNATURE_REQUIRED',
        'signature',
      )
    }
  })

  it('rejects a signed Patch under the bundled-base-only Snapshot policy', () => {
    const payload = { path: 'data/patch/new.json', bytes: utf8('{}') }
    const operation: PackPatchOperationV1 = {
      op: 'add',
      targetPath: 'data/cards/new.json',
      sourcePath: payload.path,
    }
    expectPipelineError(
      () => validatePackSourceV1(
        signedPatchSource([payload], ['game-data'], [operation]),
        bundledPolicy,
      ),
      'PACK_SCHEMA_INVALID',
      'manifest',
    )
  })

  it('rejects unsigned Local Dev when publisher keyId is non-null', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    expectPipelineError(
      () => validatePackSourceV1(snapshotSource([entry], ['game-data'], {
        publisher: { id: 'tests', keyId: signingKeyId },
      }), localDevPolicy),
      'PACK_PUBLISHER_KEY_MISMATCH',
      'signature',
    )
  })

  it('accepts valid signed external and bundled packs', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    for (const policy of [externalPolicy, bundledPolicy]) {
      const validated = validatePackSourceV1(
        signedSnapshotSource([entry], ['game-data']),
        policy,
      )
      expect(validated.signatureEnvelope?.keyId).toBe(signingKeyId)
      expect(validated.networkEligible).toBe(true)
    }
  })

  it('does not let a valid signature bypass executable, ABI, or capability checks', () => {
    const executable = {
      path: 'data/cards/executable.json',
      bytes: utf8('{"nested":{"code":"trusted"}}'),
    }
    expectPipelineError(
      () => validatePackSourceV1(signedSnapshotSource(
        [executable],
        ['game-data', 'trusted-executable-content'],
      ), externalPolicy),
      'PACK_FORBIDDEN_EXECUTABLE_CONTENT',
      'content',
    )

    const safe = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    expectPipelineError(
      () => validatePackSourceV1(signedSnapshotSource([safe], ['game-data'], {
        compatibility: { ...compatibility, contentAbi: 'rvb-content/v2' },
      }), bundledPolicy),
      'PACK_ABI_UNSUPPORTED',
      'compatibility',
    )
    expectPipelineError(
      () => validatePackSourceV1(
        signedSnapshotSource([safe], []),
        bundledPolicy,
      ),
      'PACK_CAPABILITY_MISMATCH',
      'capability',
    )
  })

  it('derives game, raster, PVE, and trusted executable capabilities', () => {
    const entries = [
      { path: 'data/cards/basic.json', bytes: utf8('{"nested":{"code":"trusted"}}') },
      {
        path: 'images/cards/basic.png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
      ...validPveEntries(),
    ]
    const capabilities: PackCapabilityV1[] = [
      'game-data',
      'pve-content',
      'raster-assets',
      'trusted-executable-content',
    ]
    const validated = validatePackSourceV1(
      signedSnapshotSource(entries, capabilities),
      bundledPolicy,
    )
    expect(validated.capabilities).toEqual(capabilities)
    expect(validated.hasExecutableContent('data/cards/basic.json')).toBe(true)
  })

  it.each(['code', 'skillCode', 'triggerSkill', 'previewCode', 'effectCode']) (
    'rejects recursive %s even in Local Dev',
    field => {
      const encodedField = field === 'code' ? '\\u0063ode' : field
      const entry = {
        path: 'data/cards/unsafe.json',
        bytes: utf8(`{"nested":[{"${encodedField}":null}]}`),
      }
      expectPipelineError(
        () => validatePackSourceV1(
          snapshotSource([entry], ['game-data', 'trusted-executable-content']),
          localDevPolicy,
        ),
        'PACK_FORBIDDEN_EXECUTABLE_CONTENT',
        'content',
      )
    },
  )

  it('rejects capability under-reporting and over-reporting', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    for (const capabilities of [[], ['game-data', 'raster-assets']] as PackCapabilityV1[][]) {
      expectPipelineError(
        () => validatePackSourceV1(snapshotSource([entry], capabilities), localDevPolicy),
        'PACK_CAPABILITY_MISMATCH',
        'capability',
      )
    }
  })

  it('requires Patch parent semantics and rejects unconsumed payload', () => {
    const payload = { path: 'data/patch/new.json', bytes: utf8('{}') }
    const operation: PackPatchOperationV1 = {
      op: 'add',
      targetPath: 'data/cards/new.json',
      sourcePath: payload.path,
    }
    const patch = patchSource([payload], ['game-data'], [operation])
    expectPipelineError(
      () => validatePackSourceV1(patch, localDevPolicy),
      'PACK_REFERENCE_INVALID',
      'patch',
    )

    const parentEntry = { path: 'data/cards/base.json', bytes: utf8('{}') }
    const parent = validatePackSourceV1(
      snapshotSource([parentEntry], ['game-data']),
      localDevPolicy,
    )
    const unused = { path: 'data/patch/unused.json', bytes: utf8('{}') }
    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([payload, unused], ['game-data'], [operation]),
        localDevPolicy,
        { parent },
      ),
      'PACK_FILE_UNDECLARED',
      'patch',
    )
  })

  it('rejects removal of bundled executable content outside bundled policy', () => {
    const executable = {
      path: 'data/cards/trusted.json',
      bytes: utf8('{"code":"trusted"}'),
    }
    const parent = validatePackSourceV1(signedSnapshotSource(
      [executable],
      ['game-data', 'trusted-executable-content'],
    ), bundledPolicy)
    const remove: PackPatchOperationV1 = {
      op: 'remove',
      targetPath: executable.path,
      expectedHash: fileDescriptor(executable).sha256,
    }
    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['game-data', 'trusted-executable-content'], [remove]),
        localDevPolicy,
        { parent },
      ),
      'PACK_FORBIDDEN_EXECUTABLE_CONTENT',
      'patch',
    )
  })
})

describe('Content Pipeline v1 resolved candidate and PVE closure', () => {
  it('derives final capabilities and accepts a closed reachable Campaign', () => {
    const validated = validateCandidate(validPveEntries())
    expect(validated.capabilities).toEqual(['pve-content'])
  })

  it('accepts the typed chapter, battle, encounter, enemy, event, and reward graph', () => {
    const validated = validateCandidate(fullPveEntries())
    expect(validated.capabilities).toEqual(['pve-content'])
  })

  it.each([
    ['chapter campaign', 'data/pve/chapter.json', (value: Record<string, unknown>) => {
      value.campaignId = 'missing-campaign'
    }],
    ['encounter enemy', 'data/pve/encounter.json', (value: Record<string, unknown>) => {
      value.enemySetupId = 'missing-enemy'
    }],
    ['battle encounter', 'data/pve/nodes/battle.json', (value: Record<string, unknown>) => {
      value.encounterId = 'missing-encounter'
    }],
    ['reward target', 'data/pve/nodes/reward.json', (value: Record<string, unknown>) => {
      value.rewardId = 'missing-reward'
    }],
    ['event exact outcomes', 'data/pve/event.json', (value: Record<string, unknown>) => {
      const choices = value.choices as Array<Record<string, unknown>>
      choices[0].outcomeId = 'different-outcome'
    }],
  ] as const)('rejects a dangling %s reference', (_label, path, mutate) => {
    expectPipelineError(
      () => validateCandidate(mutateJsonEntry(fullPveEntries(), path, mutate)),
      'PACK_REFERENCE_INVALID',
      'reference',
    )
  })

  it('rejects dangling transitions and descriptor ID mismatches', () => {
    expectPipelineError(
      () => validateCandidate(validPveEntries('missing')),
      'PACK_REFERENCE_INVALID',
      'reference',
    )

    const wrongId = validPveEntries()
    wrongId[2] = {
      ...wrongId[2],
      bytes: utf8(JSON.stringify({
        schemaVersion: 'rvb-pve-node/v1',
        nodeId: 'other',
        type: 'story',
        storyId: 'intro-story',
        nextNodeId: 'finish',
      })),
    }
    expectPipelineError(
      () => validateCandidate(wrongId),
      'PACK_REFERENCE_INVALID',
      'reference',
    )
  })

  it('rejects unreachable Campaign nodes', () => {
    const unreachable = validPveEntries()
    const campaign = JSON.parse(decoder.decode(unreachable[1].bytes)) as {
      nodes: Array<{ nodeId: string; path: string }>
    }
    campaign.nodes.push({ nodeId: 'unused', path: 'data/pve/nodes/unused.json' })
    campaign.nodes.sort((left, right) => compareUnicodeCodePointsV1(
      left.nodeId,
      right.nodeId,
    ))
    unreachable[1] = { ...unreachable[1], bytes: utf8(JSON.stringify(campaign)) }
    unreachable.push({
      path: 'data/pve/nodes/unused.json',
      bytes: utf8(JSON.stringify({
        schemaVersion: 'rvb-pve-node/v1',
        nodeId: 'unused',
        type: 'end',
        endingId: 'unused',
        outcome: 'failed',
      })),
    })
    expectPipelineError(
      () => validateCandidate(unreachable),
      'PACK_REFERENCE_INVALID',
      'reference',
    )
  })

  it('does not let trusted path metadata authorize new code or hide safe content', () => {
    const safe = { path: 'data/cards/safe.json', bytes: utf8('{}') }
    expectPipelineError(
      () => validateResolvedCandidateV1({
        compatibility,
        files: candidateFiles([safe]),
        trustedExecutablePaths: [safe.path],
      }, compatibility),
      'PACK_CAPABILITY_MISMATCH',
      'capability',
    )

    const executable = { path: safe.path, bytes: utf8('{"code":"x"}') }
    expectPipelineError(
      () => validateResolvedCandidateV1({
        compatibility,
        files: candidateFiles([executable]),
        trustedExecutablePaths: [],
      }, compatibility),
      'PACK_FORBIDDEN_EXECUTABLE_CONTENT',
      'content',
    )
  })
})
