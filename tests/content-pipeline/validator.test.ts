import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'

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

function proxiedBytesWithPoisonIterator(
  bytes: Uint8Array,
  onIterator: () => void,
): Uint8Array {
  return new Proxy(bytes, {
    get(target, property) {
      if (property === Symbol.iterator) {
        onIterator()
        throw new Error('Uint8Array iterator must not be read')
      }
      return Reflect.get(target, property, target) as unknown
    },
  })
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
    ['manifestBytes', CONTENT_PIPELINE_LIMITS_V1.maxManifestBytes],
    ['signatureBytes', CONTENT_PIPELINE_LIMITS_V1.maxSignatureBytes],
  ] as const)(
    'budgets the first %s snapshot and reads the source field once',
    (field, maximumBytes) => {
      const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
      const base = signedSnapshotSource([entry], ['game-data'])
      const oversized = new Uint8Array(maximumBytes + 1)
      let reads = 0
      const source: ContentPackSourceV1 = field === 'manifestBytes'
        ? {
            get manifestBytes(): Uint8Array {
              reads += 1
              return reads === 1 ? oversized : base.manifestBytes
            },
            signatureBytes: base.signatureBytes,
            entries: base.entries,
          }
        : {
            manifestBytes: base.manifestBytes,
            get signatureBytes(): Uint8Array {
              reads += 1
              return reads === 1 ? oversized : base.signatureBytes!
            },
            entries: base.entries,
          }

      expectPipelineError(
        () => validatePackSourceV1(source, externalPolicy),
        'PACK_BUDGET_EXCEEDED',
        'source',
      )
      expect(reads).toBe(1)
    },
  )

  it('reads valid manifest and signature byte fields only once', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const base = signedSnapshotSource([entry], ['game-data'])
    let manifestReads = 0
    let signatureReads = 0
    const source: ContentPackSourceV1 = {
      get manifestBytes(): Uint8Array {
        manifestReads += 1
        if (manifestReads > 1) throw new Error('manifestBytes read twice')
        return base.manifestBytes
      },
      get signatureBytes(): Uint8Array {
        signatureReads += 1
        if (signatureReads > 1) throw new Error('signatureBytes read twice')
        return base.signatureBytes!
      },
      entries: base.entries,
    }

    expect(validatePackSourceV1(source, externalPolicy).capabilities).toEqual([
      'game-data',
    ])
    expect({ manifestReads, signatureReads }).toEqual({
      manifestReads: 1,
      signatureReads: 1,
    })
  })

  it.each(['manifestBytes', 'signatureBytes'] as const)(
    'maps a throwing %s getter to a stable source error',
    field => {
      const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
      const base = snapshotSource([entry], ['game-data'])
      const source: ContentPackSourceV1 = field === 'manifestBytes'
        ? {
            get manifestBytes(): Uint8Array {
              throw new Error('poison manifest getter')
            },
            entries: base.entries,
          }
        : {
            manifestBytes: base.manifestBytes,
            get signatureBytes(): Uint8Array {
              throw new Error('poison signature getter')
            },
            entries: base.entries,
          }
      expectPipelineError(
        () => validatePackSourceV1(source, localDevPolicy),
        'PACK_SCHEMA_INVALID',
        'source',
      )
    },
  )

  it('checks and reads own source entry indices exactly once without iterators', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const base = snapshotSource([entry], ['game-data'])
    let iteratorReads = 0
    let indexDescriptorReads = 0
    let indexValueReads = 0
    const entries = new Proxy([entry], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads += 1
          throw new Error('entries iterator must not be read')
        }
        if (property === '0') {
          indexValueReads += 1
          return Reflect.get(target, property, receiver) as unknown
        }
        return Reflect.get(target, property, receiver) as unknown
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') indexDescriptorReads += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(validatePackSourceV1({
      ...base,
      entries,
    }, localDevPolicy).capabilities).toEqual(['game-data'])
    expect(indexDescriptorReads).toBe(1)
    expect(indexValueReads).toBe(1)
    expect(iteratorReads).toBe(0)
  })

  it('rejects unsafe entries lengths and throwing index getters', () => {
    const base = snapshotSource([], [])
    for (const invalidLength of [-1, 1.5, Number.NaN]) {
      const entries = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') return invalidLength
          return Reflect.get(target, property, receiver) as unknown
        },
      })
      expectPipelineError(
        () => validatePackSourceV1({ ...base, entries }, localDevPolicy),
        'PACK_SCHEMA_INVALID',
        'source',
      )
    }

    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const oneEntryBase = snapshotSource([entry], ['game-data'])
    const throwingEntries = new Proxy([entry], {
      get(target, property, receiver) {
        if (property === '0') throw new Error('poison entry index')
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    expectPipelineError(
      () => validatePackSourceV1({
        ...oneEntryBase,
        entries: throwingEntries,
      }, localDevPolicy),
      'PACK_SCHEMA_INVALID',
      'source',
    )
  })

  it.each([
    ['inherited', (
      entry: ContentSourceEntryV1,
    ) => {
      const entries = new Array<ContentSourceEntryV1>(1)
      const prototype = Object.create(Array.prototype) as Record<
        PropertyKey,
        unknown
      >
      prototype[0] = entry
      Object.setPrototypeOf(entries, prototype)
      return entries
    }],
    ['hole', (
      _entry: ContentSourceEntryV1,
    ) => {
      void _entry
      return new Array<ContentSourceEntryV1>(1)
    }],
  ] as const)(
    'rejects a missing own %s source entry index',
    (_label, makeEntries) => {
      const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
      const entries = makeEntries(entry)
      const base = snapshotSource([entry], ['game-data'])
      expectPipelineError(
        () => validatePackSourceV1({ ...base, entries }, localDevPolicy),
        'PACK_SCHEMA_INVALID',
        'source',
      )
    },
  )

  it.each([
    ['accessor', (
      entry: ContentSourceEntryV1,
      onAccessor: () => void,
    ) => {
      const entries: ContentSourceEntryV1[] = []
      Object.defineProperty(entries, 0, {
        configurable: true,
        enumerable: true,
        get() {
          onAccessor()
          return entry
        },
      })
      return entries
    }, 1],
    ['non-enumerable', (
      entry: ContentSourceEntryV1,
      onAccessor: () => void,
    ) => {
      void onAccessor
      const entries: ContentSourceEntryV1[] = []
      Object.defineProperty(entries, 0, {
        configurable: true,
        enumerable: false,
        value: entry,
        writable: true,
      })
      return entries
    }, 0],
  ] as const)(
    'accepts an own %s source entry index',
    (_label, makeEntries, expectedAccessorReads) => {
      const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
      let accessorReads = 0
      const entries = makeEntries(entry, () => { accessorReads += 1 })
      const base = snapshotSource([entry], ['game-data'])
      expect(validatePackSourceV1({
        ...base,
        entries,
      }, localDevPolicy).capabilities).toEqual(['game-data'])
      expect(accessorReads).toBe(expectedAccessorReads)
    },
  )

  it('ignores non-index string and symbol properties on source arrays', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const entries = [entry]
    Object.defineProperty(entries, 'metadata', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('extra string property must not be read') },
    })
    Object.defineProperty(entries, Symbol('metadata'), {
      configurable: true,
      enumerable: true,
      get() { throw new Error('extra symbol property must not be read') },
    })
    const base = snapshotSource([entry], ['game-data'])
    expect(validatePackSourceV1({
      ...base,
      entries,
    }, localDevPolicy).capabilities).toEqual(['game-data'])
  })

  it('rejects proxied source byte views without invoking their iterator', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const local = snapshotSource([entry], ['game-data'])
    const signed = signedSnapshotSource([entry], ['game-data'])
    const factories = [
      () => {
        let iteratorReads = 0
        return {
          source: {
            ...local,
            manifestBytes: proxiedBytesWithPoisonIterator(
              local.manifestBytes,
              () => { iteratorReads += 1 },
            ),
          },
          iteratorReads: () => iteratorReads,
          policy: localDevPolicy,
        }
      },
      () => {
        let iteratorReads = 0
        return {
          source: {
            ...signed,
            signatureBytes: proxiedBytesWithPoisonIterator(
              signed.signatureBytes!,
              () => { iteratorReads += 1 },
            ),
          },
          iteratorReads: () => iteratorReads,
          policy: externalPolicy,
        }
      },
      () => {
        let iteratorReads = 0
        return {
          source: {
            ...local,
            entries: [{
              ...entry,
              bytes: proxiedBytesWithPoisonIterator(
                entry.bytes,
                () => { iteratorReads += 1 },
              ),
            }],
          },
          iteratorReads: () => iteratorReads,
          policy: localDevPolicy,
        }
      },
    ]

    for (const createCase of factories) {
      const testCase = createCase()
      expectPipelineError(
        () => validatePackSourceV1(testCase.source, testCase.policy),
        'PACK_SCHEMA_INVALID',
        'source',
      )
      expect(testCase.iteratorReads()).toBe(0)
    }
  })

  it('accepts cross-realm ordinary Uint8Array bytes at both boundaries', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const crossRealmBytes = runInNewContext(
      `Uint8Array.from(${JSON.stringify([...entry.bytes])})`,
    ) as Uint8Array
    const source = snapshotSource([entry], ['game-data'])
    expect(validatePackSourceV1({
      ...source,
      entries: [{ ...entry, bytes: crossRealmBytes }],
    }, localDevPolicy).capabilities).toEqual(['game-data'])

    const candidate = candidateFiles([entry])[0]
    expect(validateResolvedCandidateV1({
      compatibility,
      files: [{ ...candidate, bytes: crossRealmBytes }],
      trustedExecutablePaths: [],
    }, compatibility).capabilities).toEqual(['game-data'])
  })

  it('rejects SharedArrayBuffer-backed bytes at the source boundary', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const sharedBytes = new Uint8Array(new SharedArrayBuffer(entry.bytes.byteLength))
    sharedBytes.set(entry.bytes)
    const source = snapshotSource([entry], ['game-data'])
    expectPipelineError(
      () => validatePackSourceV1({
        ...source,
        entries: [{ ...entry, bytes: sharedBytes }],
      }, localDevPolicy),
      'PACK_SCHEMA_INVALID',
      'source',
    )
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

  it('rejects the Greek sigma Windows case collision in pack source paths', () => {
    const entries = [
      { path: 'data/cards/Σ.json', bytes: utf8('{}') },
      { path: 'data/cards/ς.json', bytes: utf8('{}') },
    ]
    expectPipelineError(
      () => validatePackSourceV1(
        snapshotSource(entries, ['game-data']),
        localDevPolicy,
      ),
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

  it('rejects an over-limit entry array before reading or iterating an entry', () => {
    const backing = new Array<ContentSourceEntryV1>(
      CONTENT_PIPELINE_LIMITS_V1.maxEntries + 1,
    )
    const entries = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'length') return Reflect.get(target, property, receiver)
        throw new Error(`Poison entry access: ${String(property)}`)
      },
    })

    expectPipelineError(
      () => validatePackSourceV1(rawBudgetSource(entries), localDevPolicy),
      'PACK_BUDGET_EXCEEDED',
      'source',
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

  it.each([
    ['missing', {
      kind: 'local-dev',
      expectedCompatibility: compatibility,
    }],
    ['false', {
      kind: 'local-dev',
      expectedCompatibility: compatibility,
      allowUnsigned: false,
    }],
  ] as const)(
    'rejects unsigned Local Dev when allowUnsigned is %s',
    (_label, runtimePolicy) => {
      const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
      expectPipelineError(
        () => validatePackSourceV1(
          snapshotSource([entry], ['game-data']),
          runtimePolicy as unknown as ContentValidationPolicyV1,
        ),
        'PACK_SIGNATURE_REQUIRED',
        'signature',
      )
    },
  )

  it.each([
    ['missing', {
      kind: 'local-dev',
      allowUnsigned: true,
    }],
    ['null', {
      kind: 'local-dev',
      allowUnsigned: true,
      expectedCompatibility: null,
    }],
    ['missing field', {
      kind: 'local-dev',
      allowUnsigned: true,
      expectedCompatibility: { engineAbi: compatibility.engineAbi },
    }],
    ['unknown field', {
      kind: 'local-dev',
      allowUnsigned: true,
      expectedCompatibility: { ...compatibility, extraAbi: 'rvb-extra/v1' },
    }],
    ['invalid ABI', {
      kind: 'local-dev',
      allowUnsigned: true,
      expectedCompatibility: {
        ...compatibility,
        engineAbi: 'RVB-ENGINE/v1',
      },
    }],
  ] as const)(
    'rejects runtime expectedCompatibility when it is %s',
    (_label, runtimePolicy) => {
      const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
      expectPipelineError(
        () => validatePackSourceV1(
          snapshotSource([entry], ['game-data']),
          runtimePolicy as unknown as ContentValidationPolicyV1,
        ),
        'PACK_SCHEMA_INVALID',
        'source',
      )
    },
  )

  it('rejects malformed runtime compatibility before reading manifest bytes', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const validSource = snapshotSource([entry], ['game-data'])
    const poisonSource: ContentPackSourceV1 = {
      get manifestBytes(): Uint8Array {
        throw new Error('Manifest bytes must not be read')
      },
      signatureBytes: validSource.signatureBytes,
      entries: validSource.entries,
    }
    const runtimePolicy = {
      kind: 'local-dev',
      allowUnsigned: true,
      expectedCompatibility: { ...compatibility, unexpected: true },
    } as unknown as ContentValidationPolicyV1
    expectPipelineError(
      () => validatePackSourceV1(poisonSource, runtimePolicy),
      'PACK_SCHEMA_INVALID',
      'source',
    )
  })

  it('keeps a schema-valid ABI mismatch in the compatibility stage', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    expectPipelineError(
      () => validatePackSourceV1(
        snapshotSource([entry], ['game-data']),
        {
          kind: 'local-dev',
          allowUnsigned: true,
          expectedCompatibility: {
            ...compatibility,
            engineAbi: 'rvb-engine/v2',
          },
        },
      ),
      'PACK_ABI_UNSUPPORTED',
      'compatibility',
    )
  })

  it('uses one parsed compatibility copy despite accessor mutation', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const base = snapshotSource([entry], ['game-data'])
    const mutableCompatibility = { ...compatibility }
    let compatibilityReads = 0
    const runtimePolicy = {
      kind: 'local-dev',
      allowUnsigned: true,
      get expectedCompatibility(): PackCompatibilityV1 {
        compatibilityReads += 1
        if (compatibilityReads > 1) {
          throw new Error('expectedCompatibility read twice')
        }
        return mutableCompatibility
      },
    } as ContentValidationPolicyV1
    const source: ContentPackSourceV1 = {
      get manifestBytes(): Uint8Array {
        mutableCompatibility.engineAbi = 'rvb-engine/v2'
        return base.manifestBytes
      },
      entries: base.entries,
    }

    expect(validatePackSourceV1(source, runtimePolicy).capabilities).toEqual([
      'game-data',
    ])
    expect(compatibilityReads).toBe(1)
  })

  it('rejects an unknown runtime policy even for a correctly signed pack', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const runtimePolicy = {
      kind: 'future-policy',
      expectedCompatibility: compatibility,
    } as unknown as ContentValidationPolicyV1
    expectPipelineError(
      () => validatePackSourceV1(
        signedSnapshotSource([entry], ['game-data']),
        runtimePolicy,
      ),
      'PACK_SCHEMA_INVALID',
      'source',
    )
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

  it('rejects schema-valid manifest bytes changed after signing', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const signed = signedSnapshotSource([entry], ['game-data'])
    const manifest = JSON.parse(
      decoder.decode(signed.manifestBytes),
    ) as PackManifestV1

    const error = expectPipelineError(
      () => validatePackSourceV1({
        ...signed,
        manifestBytes: utf8(JSON.stringify({
          ...manifest,
          displayName: 'Tampered validator fixture',
        })),
      }, externalPolicy),
      'PACK_SIGNATURE_INVALID',
      'signature',
    )
    expect(error).toMatchObject({ packId: 'tests.validator' })
  })

  it('rejects same-length entry bytes changed after signing', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const signed = signedSnapshotSource([entry], ['game-data'])

    const error = expectPipelineError(
      () => validatePackSourceV1({
        ...signed,
        entries: [{
          ...entry,
          bytes: utf8('[]'),
        }],
      }, externalPolicy),
      'PACK_HASH_MISMATCH',
      'inventory',
    )
    expect(error).toMatchObject({
      packId: 'tests.validator',
      path: 'data/cards/basic.json',
    })
  })

  it('does not let a self-consistent signed pack bypass PVE references', () => {
    const entries = validPveEntries('missing-node')

    const error = expectPipelineError(
      () => validatePackSourceV1(
        signedSnapshotSource(entries, ['pve-content']),
        externalPolicy,
      ),
      'PACK_REFERENCE_INVALID',
      'reference',
    )
    expect(error).toMatchObject({
      packId: 'tests.validator',
      contentId: 'missing-node',
    })
  })

  it('lets signature JSON depth 64 reach envelope validation and budgets depth 65', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const signed = signedSnapshotSource([entry], ['game-data'])
    const signatureText = decoder.decode(signed.signatureBytes!)
    const withPaddingDepth = (arrayDepth: number): Uint8Array => utf8(
      `${signatureText.slice(0, -1)},"padding":`
      + `${'['.repeat(arrayDepth)}null${']'.repeat(arrayDepth)}}`,
    )

    expectPipelineError(
      () => validatePackSourceV1({
        ...signed,
        signatureBytes: withPaddingDepth(
          CONTENT_PIPELINE_LIMITS_V1.maxJsonDepth - 2,
        ),
      }, externalPolicy),
      'PACK_SIGNATURE_INVALID',
      'signature',
    )
    expectPipelineError(
      () => validatePackSourceV1({
        ...signed,
        signatureBytes: withPaddingDepth(
          CONTENT_PIPELINE_LIMITS_V1.maxJsonDepth - 1,
        ),
      }, externalPolicy),
      'PACK_BUDGET_EXCEEDED',
      'signature',
    )
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

  function removeOperation(
    descriptor: PackFileDescriptorV1,
  ): PackPatchOperationV1 {
    return {
      op: 'remove',
      targetPath: descriptor.path,
      expectedHash: descriptor.sha256,
    }
  }

  function rawParentTree(
    descriptors: readonly PackFileDescriptorV1[],
    readFile: (path: string) => Uint8Array | undefined,
  ) {
    return {
      files: descriptors,
      readFile,
      hasExecutableContent: () => false,
    }
  }

  it('does not observe context.parent for Snapshot manifests', () => {
    const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
    let parentReads = 0
    const context = Object.defineProperty({}, 'parent', {
      get() {
        parentReads += 1
        throw new Error('Snapshot must not observe parent')
      },
    })

    expect(validatePackSourceV1(
      snapshotSource([entry], ['game-data']),
      localDevPolicy,
      context as never,
    ).capabilities).toEqual(['game-data'])
    expect(parentReads).toBe(0)
  })

  it('snapshots Patch parent accessors and indexed files exactly once', () => {
    const entries = sortEntries([
      { path: 'data/cards/a.json', bytes: utf8('{}') },
      { path: 'data/cards/b.json', bytes: utf8('[]') },
    ])
    const descriptors = entries.map(fileDescriptor)
    const bytesByPath = new Map(entries.map(entry => [entry.path, entry.bytes]))
    const indexDescriptorReads = [0, 0]
    const indexValueReads = [0, 0]
    let lengthReads = 0
    let iteratorReads = 0
    const files = new Proxy([...descriptors], {
      get(target, property) {
        if (property === Symbol.iterator) {
          iteratorReads += 1
          throw new Error('parent files iterator must not be read')
        }
        if (property === 'length') lengthReads += 1
        if (property === '0' || property === '1') {
          indexValueReads[Number(property)] += 1
          return Reflect.get(target, property, target) as unknown
        }
        return Reflect.get(target, property, target) as unknown
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === '0' || property === '1') {
          indexDescriptorReads[Number(property)] += 1
        }
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })

    let parentReads = 0
    let filesReads = 0
    let readFileReads = 0
    let executableMarkerReads = 0
    const calls = new Map<string, number>()
    const parent = Object.defineProperties({}, {
      files: {
        get() {
          filesReads += 1
          if (filesReads > 1) throw new Error('parent files read twice')
          return files
        },
      },
      readFile: {
        get() {
          readFileReads += 1
          if (readFileReads > 1) throw new Error('parent readFile read twice')
          return (path: string) => {
            calls.set(path, (calls.get(path) ?? 0) + 1)
            return bytesByPath.get(path)
          }
        },
      },
      hasExecutableContent: {
        get() {
          executableMarkerReads += 1
          throw new Error('external executable marker must not be read')
        },
      },
    })
    const context = {
      get parent() {
        parentReads += 1
        if (parentReads > 1) throw new Error('context parent read twice')
        return parent
      },
    }

    expect(validatePackSourceV1(
      patchSource([], ['game-data'], descriptors.map(removeOperation)),
      localDevPolicy,
      context as never,
    ).capabilities).toEqual(['game-data'])
    expect(parentReads).toBe(1)
    expect(filesReads).toBe(1)
    expect(lengthReads).toBe(1)
    expect(indexDescriptorReads).toEqual([1, 1])
    expect(indexValueReads).toEqual([1, 1])
    expect(iteratorReads).toBe(0)
    expect(readFileReads).toBe(1)
    expect(calls).toEqual(new Map(entries.map(entry => [entry.path, 1])))
    expect(executableMarkerReads).toBe(0)
  })

  it.each([
    ['null context', null],
    ['throwing parent getter', Object.defineProperty({}, 'parent', {
      get() { throw new Error('poison parent getter') },
    })],
    ['null parent', { parent: null }],
    ['throwing files getter', {
      parent: Object.defineProperty({}, 'files', {
        get() { throw new Error('poison files getter') },
      }),
    }],
    ['non-array files', {
      parent: {
        files: {},
        readFile: () => utf8('{}'),
        hasExecutableContent: (): boolean => false,
      },
    }],
    ['throwing readFile getter', {
      parent: Object.defineProperties({}, {
        files: { value: [fileDescriptor({
          path: 'data/cards/base.json',
          bytes: utf8('{}'),
        })] },
        readFile: {
          get() { throw new Error('poison readFile getter') },
        },
      }),
    }],
    ['non-function readFile', {
      parent: {
        files: [fileDescriptor({
          path: 'data/cards/base.json',
          bytes: utf8('{}'),
        })],
        readFile: 42,
        hasExecutableContent: () => false,
      },
    }],
    ['throwing readFile call', {
      parent: {
        files: [fileDescriptor({
          path: 'data/cards/base.json',
          bytes: utf8('{}'),
        })],
        readFile() { throw new Error('poison readFile call') },
        hasExecutableContent: (): boolean => false,
      },
    }],
  ] as const)(
    'maps malformed Patch parent boundary: %s',
    (_label, context) => {
      const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
      const descriptor = fileDescriptor(entry)
      expectPipelineError(
        () => validatePackSourceV1(
          patchSource([], ['game-data'], [removeOperation(descriptor)]),
          localDevPolicy,
          context as never,
        ),
        'PACK_SCHEMA_INVALID',
        'patch',
      )
    },
  )

  it('bounds parent files before indexes and never reads their iterator', () => {
    let indexReads = 0
    let iteratorReads = 0
    const files = new Proxy([], {
      get(target, property) {
        if (property === 'length') {
          return CONTENT_PIPELINE_LIMITS_V1.maxEntries + 1
        }
        if (property === Symbol.iterator) {
          iteratorReads += 1
          throw new Error('parent files iterator must not be read')
        }
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          indexReads += 1
          throw new Error('parent file index must not be read')
        }
        return Reflect.get(target, property, target) as unknown
      },
    })
    const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['game-data'], [removeOperation(fileDescriptor(entry))]),
        localDevPolicy,
        {
          parent: {
            files,
            readFile: () => entry.bytes,
            hasExecutableContent: () => false,
          },
        },
      ),
      'PACK_BUDGET_EXCEEDED',
      'source',
    )
    expect(indexReads).toBe(0)
    expect(iteratorReads).toBe(0)
  })

  it('rejects inherited Patch parent file descriptors', () => {
    const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
    const descriptor = fileDescriptor(entry)
    const files = new Array<PackFileDescriptorV1>(1)
    const prototype = Object.create(Array.prototype) as Record<
      PropertyKey,
      unknown
    >
    prototype[0] = descriptor
    Object.setPrototypeOf(files, prototype)

    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['game-data'], [removeOperation(descriptor)]),
        localDevPolicy,
        { parent: rawParentTree(files, () => entry.bytes) },
      ),
      'PACK_SCHEMA_INVALID',
      'patch',
    )
  })

  it.each([Number.NaN, -1, 1.5])(
    'rejects an invalid parent files length: %s',
    length => {
      const files = new Proxy([], {
        get(target, property) {
          if (property === 'length') return length
          return Reflect.get(target, property, target) as unknown
        },
      })
      const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
      expectPipelineError(
        () => validatePackSourceV1(
          patchSource(
            [],
            ['game-data'],
            [removeOperation(fileDescriptor(entry))],
          ),
          localDevPolicy,
          {
            parent: {
              files,
              readFile: () => entry.bytes,
              hasExecutableContent: () => false,
            },
          },
        ),
        'PACK_SCHEMA_INVALID',
        'patch',
      )
    },
  )

  it.each([
    ['unknown descriptor field', (
      first: PackFileDescriptorV1,
      second: PackFileDescriptorV1,
    ) => {
      void second
      return [{ ...first, unexpected: true }]
    }],
    ['unsorted descriptors', (
      first: PackFileDescriptorV1,
      second: PackFileDescriptorV1,
    ) => [second, first]],
    ['duplicate descriptor', (
      first: PackFileDescriptorV1,
      second: PackFileDescriptorV1,
    ) => {
      void second
      return [first, first]
    }],
  ] as const)(
    'strictly validates parent inventory: %s',
    (_label, makeDescriptors) => {
      const entries = sortEntries([
        { path: 'data/cards/a.json', bytes: utf8('{}') },
        { path: 'data/cards/b.json', bytes: utf8('[]') },
      ])
      const first = fileDescriptor(entries[0])
      const second = fileDescriptor(entries[1])
      const descriptors = makeDescriptors(first, second)
      const bytesByPath = new Map(entries.map(entry => [entry.path, entry.bytes]))
      expectPipelineError(
        () => validatePackSourceV1(
          patchSource([], ['game-data'], [removeOperation(first)]),
          localDevPolicy,
          {
            parent: rawParentTree(
              descriptors as readonly PackFileDescriptorV1[],
              path => bytesByPath.get(path),
            ),
          },
        ),
        'PACK_SCHEMA_INVALID',
        'patch',
      )
    },
  )

  it('rejects Windows-style parent descriptor path collisions', () => {
    const entries = [
      { path: 'data/cards/Σ.json', bytes: utf8('{}') },
      { path: 'data/cards/ς.json', bytes: utf8('[]') },
    ]
    const descriptors = entries.map(fileDescriptor)
    const bytesByPath = new Map(entries.map(entry => [entry.path, entry.bytes]))
    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['game-data'], [removeOperation(descriptors[0])]),
        localDevPolicy,
        { parent: rawParentTree(descriptors, path => bytesByPath.get(path)) },
      ),
      'PACK_PATH_COLLISION',
      'patch',
    )
  })

  it.each([
    ['Proxy', (bytes: Uint8Array) => proxiedBytesWithPoisonIterator(
      bytes,
      () => { throw new Error('parent byte iterator must not be read') },
    )],
    ['SharedArrayBuffer', (bytes: Uint8Array) => {
      const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength))
      shared.set(bytes)
      return shared
    }],
    ['detached ArrayBuffer', (bytes: Uint8Array) => {
      const detached = new Uint8Array(bytes)
      structuredClone(detached.buffer, { transfer: [detached.buffer] })
      return detached
    }],
  ] as const)(
    'rejects %s bytes returned by parent.readFile',
    (_label, makeBytes) => {
      const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
      const descriptor = fileDescriptor(entry)
      expectPipelineError(
        () => validatePackSourceV1(
          patchSource([], ['game-data'], [removeOperation(descriptor)]),
          localDevPolicy,
          {
            parent: rawParentTree(
              [descriptor],
              () => makeBytes(entry.bytes),
            ),
          },
        ),
        'PACK_SCHEMA_INVALID',
        'patch',
      )
    },
  )

  it('maps a missing parent file body to a stable Patch error', () => {
    const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
    const descriptor = fileDescriptor(entry)
    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['game-data'], [removeOperation(descriptor)]),
        localDevPolicy,
        { parent: rawParentTree([descriptor], () => undefined) },
      ),
      'PACK_FILE_MISSING',
      'patch',
    )
  })

  it('accepts cross-realm ordinary bytes returned by parent.readFile', () => {
    const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
    const descriptor = fileDescriptor(entry)
    const crossRealmBytes = runInNewContext(
      `Uint8Array.from(${JSON.stringify([...entry.bytes])})`,
    ) as Uint8Array
    expect(validatePackSourceV1(
      patchSource([], ['game-data'], [removeOperation(descriptor)]),
      localDevPolicy,
      { parent: rawParentTree([descriptor], () => crossRealmBytes) },
    ).capabilities).toEqual(['game-data'])
  })

  it.each([
    [
      'size',
      utf8('{"changed":true}'),
      'PACK_SIZE_MISMATCH',
    ],
    [
      'hash',
      utf8('[]'),
      'PACK_HASH_MISMATCH',
    ],
  ] as const)(
    'rechecks parent descriptor %s against returned bytes',
    (_label, returnedBytes, code) => {
      const entry = { path: 'data/cards/base.json', bytes: utf8('{}') }
      const descriptor = fileDescriptor(entry)
      expectPipelineError(
        () => validatePackSourceV1(
          patchSource([], ['game-data'], [removeOperation(descriptor)]),
          localDevPolicy,
          { parent: rawParentTree([descriptor], () => returnedBytes) },
        ),
        code,
        'inventory',
      )
    },
  )

  it('checks the parent per-file byte budget before copying', () => {
    const bytes = new Uint8Array(
      CONTENT_PIPELINE_LIMITS_V1.maxFileBytes + 1,
    )
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const entry = { path: 'images/parent/over.png', bytes }
    const descriptor = fileDescriptor(entry)
    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['raster-assets'], [removeOperation(descriptor)]),
        localDevPolicy,
        { parent: rawParentTree([descriptor], () => bytes) },
      ),
      'PACK_BUDGET_EXCEEDED',
      'source',
    )
  })

  it('checks the complete parent byte budget, including untouched files', () => {
    const maximum = new Uint8Array(CONTENT_PIPELINE_LIMITS_V1.maxFileBytes)
    maximum.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const tiny = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
    const maximumHash = sha256(maximum)
    const descriptors = Array.from({ length: 8 }, (_value, index) => ({
      path: `images/parent/${String(index).padStart(2, '0')}.png`,
      mediaType: 'image/png' as const,
      size: maximum.byteLength,
      sha256: maximumHash,
    }))
    descriptors.push({
      path: 'images/parent/08.png',
      mediaType: 'image/png',
      size: tiny.byteLength,
      sha256: sha256(tiny),
    })

    expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['raster-assets'], [removeOperation(descriptors[0])]),
        localDevPolicy,
        {
          parent: rawParentTree(
            descriptors,
            path => path.endsWith('/08.png') ? tiny : maximum,
          ),
        },
      ),
      'PACK_BUDGET_EXCEEDED',
      'source',
    )
  })

  it('derives executable semantics from parent bytes, not external markers', () => {
    const entry = {
      path: 'data/cards/trusted.json',
      bytes: utf8('{"code":"trusted"}'),
    }
    const descriptor = fileDescriptor(entry)
    expectPipelineError(
      () => validatePackSourceV1(
        patchSource(
          [],
          ['game-data', 'trusted-executable-content'],
          [removeOperation(descriptor)],
        ),
        localDevPolicy,
        {
          parent: {
            files: [descriptor],
            readFile: () => entry.bytes,
            hasExecutableContent: () => false,
          },
        },
      ),
      'PACK_FORBIDDEN_EXECUTABLE_CONTENT',
      'patch',
    )
  })

  it('rejects a self-consistent Patch parent with a dangling PVE graph', () => {
    const entries = sortEntries(validPveEntries('missing-node'))
    const descriptors = entries.map(fileDescriptor)
    const bytesByPath = new Map(entries.map(entry => [entry.path, entry.bytes]))
    const removed = descriptors.find(
      descriptor => descriptor.path === 'data/pve/nodes/finish.json',
    )!

    const error = expectPipelineError(
      () => validatePackSourceV1(
        patchSource([], ['pve-content'], [removeOperation(removed)]),
        localDevPolicy,
        {
          parent: rawParentTree(
            descriptors,
            path => bytesByPath.get(path),
          ),
        },
      ),
      'PACK_REFERENCE_INVALID',
      'reference',
    )
    expect(error).toMatchObject({
      packId: 'tests.patch',
      path: undefined,
      contentId: 'missing-node',
    })
  })
})

describe('Content Pipeline v1 resolved candidate and PVE closure', () => {
  it.each([
    ['null actual', null, compatibility],
    ['empty actual and expected', {}, {}],
    ['unknown actual field', { ...compatibility, extraAbi: true }, compatibility],
    ['null expected', compatibility, null],
  ] as const)(
    'rejects malformed candidate compatibility: %s',
    (_label, actualCompatibility, expectedCompatibility) => {
      expectPipelineError(
        () => validateResolvedCandidateV1({
          compatibility: actualCompatibility as PackCompatibilityV1,
          files: [],
          trustedExecutablePaths: [],
        }, expectedCompatibility as PackCompatibilityV1),
        'PACK_SCHEMA_INVALID',
        'profile',
      )
    },
  )

  it('snapshots candidate compatibility once before reading other input fields', () => {
    const mutableCompatibility = { ...compatibility }
    let compatibilityReads = 0
    const input = {
      get compatibility(): PackCompatibilityV1 {
        compatibilityReads += 1
        if (compatibilityReads > 1) {
          throw new Error('candidate compatibility read twice')
        }
        return mutableCompatibility
      },
      get files(): ResolvedCandidateFileInputV1[] {
        mutableCompatibility.engineAbi = 'rvb-engine/v2'
        return []
      },
      trustedExecutablePaths: [],
    }

    const validated = validateResolvedCandidateV1(input, compatibility)
    expect(validated.compatibility).toEqual(compatibility)
    expect(compatibilityReads).toBe(1)
  })

  it('keeps a schema-valid candidate ABI mismatch in compatibility stage', () => {
    expectPipelineError(
      () => validateResolvedCandidateV1({
        compatibility,
        files: [],
        trustedExecutablePaths: [],
      }, {
        ...compatibility,
        contentAbi: 'rvb-content/v2',
      }),
      'PACK_ABI_UNSUPPORTED',
      'compatibility',
    )
  })

  it('uses a bounded candidate file snapshot and reads each index once', () => {
    const bytes = utf8('{}')
    const descriptor = fileDescriptor({ path: 'data/cards/0000.json', bytes })
    let lengthReads = 0
    const changingLengthFiles = new Proxy(
      [] as ResolvedCandidateFileInputV1[],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            lengthReads += 1
            return lengthReads === 1 ? 0 : CONTENT_PIPELINE_LIMITS_V1.maxEntries + 1
          }
          if (typeof property === 'string' && /^\\d+$/.test(property)) {
            const path = `data/cards/${property.padStart(4, '0')}.json`
            return {
              descriptor: { ...descriptor, path },
              bytes,
            }
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      },
    )
    const empty = validateResolvedCandidateV1({
      compatibility,
      files: changingLengthFiles,
      trustedExecutablePaths: [],
    }, compatibility)
    expect(empty.files).toEqual([])
    expect(lengthReads).toBe(1)

    const entries = [
      { path: 'data/cards/a.json', bytes },
      { path: 'data/cards/b.json', bytes },
    ]
    const inputs = candidateFiles(entries)
    const indexDescriptorReads = [0, 0]
    const indexValueReads = [0, 0]
    const indexedFiles = new Proxy(inputs, {
      get(target, property, receiver) {
        if (property === '0' || property === '1') {
          indexValueReads[Number(property)] += 1
          return Reflect.get(target, property, receiver) as unknown
        }
        return Reflect.get(target, property, receiver) as unknown
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === '0' || property === '1') {
          indexDescriptorReads[Number(property)] += 1
        }
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(validateResolvedCandidateV1({
      compatibility,
      files: indexedFiles,
      trustedExecutablePaths: [],
    }, compatibility).files).toHaveLength(2)
    expect(indexDescriptorReads).toEqual([1, 1])
    expect(indexValueReads).toEqual([1, 1])
  })

  it('rejects inherited candidate file indices', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const input = candidateFiles([entry])[0]
    const files = new Array<ResolvedCandidateFileInputV1>(1)
    const prototype = Object.create(Array.prototype) as Record<
      PropertyKey,
      unknown
    >
    prototype[0] = input
    Object.setPrototypeOf(files, prototype)

    expectPipelineError(
      () => validateResolvedCandidateV1({
        compatibility,
        files,
        trustedExecutablePaths: [],
      }, compatibility),
      'PACK_SCHEMA_INVALID',
      'profile',
    )
  })

  it('rejects inherited trusted executable path indices', () => {
    const trustedExecutablePaths = new Array<string>(1)
    const prototype = Object.create(Array.prototype) as Record<
      PropertyKey,
      unknown
    >
    prototype[0] = 'data/cards/missing.json'
    Object.setPrototypeOf(trustedExecutablePaths, prototype)

    expectPipelineError(
      () => validateResolvedCandidateV1({
        compatibility,
        files: [],
        trustedExecutablePaths,
      }, compatibility),
      'PACK_SCHEMA_INVALID',
      'profile',
    )
  })

  it('bounds trusted executable paths without invoking their iterator', () => {
    let iteratorReads = 0
    const trustedPaths = new Proxy([] as string[], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads += 1
          throw new Error('trusted path iterator must not be read')
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    expect(validateResolvedCandidateV1({
      compatibility,
      files: [],
      trustedExecutablePaths: trustedPaths,
    }, compatibility).files).toEqual([])
    expect(iteratorReads).toBe(0)

    const executable = {
      path: 'data/cards/trusted.json',
      bytes: utf8('{"code":"trusted"}'),
    }
    let indexDescriptorReads = 0
    let indexValueReads = 0
    const indexedTrustedPaths = new Proxy([executable.path], {
      get(target, property, receiver) {
        if (property === '0') {
          indexValueReads += 1
          return Reflect.get(target, property, receiver) as unknown
        }
        if (property === Symbol.iterator) {
          iteratorReads += 1
          throw new Error('trusted path iterator must not be read')
        }
        return Reflect.get(target, property, receiver) as unknown
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') indexDescriptorReads += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(validateResolvedCandidateV1({
      compatibility,
      files: candidateFiles([executable]),
      trustedExecutablePaths: indexedTrustedPaths,
    }, compatibility).files).toHaveLength(1)
    expect(indexDescriptorReads).toBe(1)
    expect(indexValueReads).toBe(1)
    expect(iteratorReads).toBe(0)

    expectPipelineError(
      () => validateResolvedCandidateV1({
        compatibility,
        files: [],
        trustedExecutablePaths: new Array<string>(
          CONTENT_PIPELINE_LIMITS_V1.maxEntries + 1,
        ).fill('data/cards/x.json'),
      }, compatibility),
      'PACK_BUDGET_EXCEEDED',
      'source',
    )
  })

  it('rejects proxied candidate bytes without invoking their iterator', () => {
    const entry = { path: 'data/cards/basic.json', bytes: utf8('{}') }
    const input = candidateFiles([entry])[0]
    let iteratorReads = 0
    expectPipelineError(
      () => validateResolvedCandidateV1({
        compatibility,
        files: [{
          ...input,
          bytes: proxiedBytesWithPoisonIterator(
            input.bytes,
            () => { iteratorReads += 1 },
          ),
        }],
        trustedExecutablePaths: [],
      }, compatibility),
      'PACK_SCHEMA_INVALID',
      'profile',
    )
    expect(iteratorReads).toBe(0)
  })

  it('rejects the Greek sigma Windows case collision in resolved paths', () => {
    const entries = [
      { path: 'data/cards/Σ.json', bytes: utf8('{}') },
      { path: 'data/cards/ς.json', bytes: utf8('{}') },
    ]
    expectPipelineError(
      () => validateCandidate(entries),
      'PACK_PATH_COLLISION',
      'profile',
    )
  })

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
