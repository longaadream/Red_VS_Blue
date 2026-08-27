import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AUTHORITY_CONTENT_IDENTITY_DOMAIN_V1,
  AUTHORITY_CONTENT_SCHEMA_VERSION_V1,
  AbiVersionV1Schema,
  AuthorityContentIdentityV1Schema,
  compareUnicodeCodePointsV1,
  ContentIdV1Schema,
  JsonValueV1Schema,
  PACK_IDENTITY_DOMAIN_V1,
  PACK_SIGNATURE_DOMAIN_V1,
  PROFILE_IDENTITY_DOMAIN_V1,
  PackManifestV1Schema,
  PackJsonPayloadPathV1Schema,
  PackPayloadPathV1Schema,
  PackSignatureEnvelopeV1Schema,
  PosixRelativePathV1Schema,
  ResolvedProfileIdentityV1Schema,
  ResolvedProfileV1Schema,
  SemVerV1Schema,
  Sha256HexV1Schema,
  UnicodeScalarStringV1Schema,
} from '@/lib/content-pipeline/contracts'

const fixtureRoot = resolve(process.cwd(), 'tests/content-pipeline/fixtures/contracts/v1')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as unknown
}

function issuePaths(result: ReturnType<typeof PackManifestV1Schema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))
}

describe('Content Pipeline v1 primitives', () => {
  it('accepts stable IDs, strict SemVer, lowercase SHA-256, and ABI names', () => {
    expect(ContentIdV1Schema.parse('community.example:campaign-one')).toBe('community.example:campaign-one')
    expect(ContentIdV1Schema.safeParse('Community/Example').success).toBe(false)

    expect(SemVerV1Schema.parse('1.2.3-alpha.1+build.9')).toBe('1.2.3-alpha.1+build.9')
    expect(SemVerV1Schema.safeParse('01.2.3').success).toBe(false)

    expect(Sha256HexV1Schema.safeParse('a'.repeat(64)).success).toBe(true)
    expect(Sha256HexV1Schema.safeParse('A'.repeat(64)).success).toBe(false)

    expect(AbiVersionV1Schema.parse('rvb-engine/v1')).toBe('rvb-engine/v1')
    expect(AbiVersionV1Schema.safeParse('rvb-engine/1').success).toBe(false)
  })

  it.each([
    '../data/cards.json',
    '/data/cards.json',
    'C:/data/cards.json',
    'data\\cards.json',
    'data//cards.json',
    'data/./cards.json',
    'data/cards.json/',
    `data/cafe\u0301.json`,
    'data/a:x.json',
    'data/card?.json',
    'data/CON.json',
    'data/COM¹.json',
    'data/com².payload',
    'images/LPT³.png',
    'data/trailing.',
    'data/trailing ',
    `data/${'a'.repeat(256)}.json`,
    'data/\ud800.json',
  ])('rejects non-canonical cross-platform POSIX path %j', path => {
    expect(PosixRelativePathV1Schema.safeParse(path).success).toBe(false)
  })

  it('accepts only recursively JSON-expressible Unicode scalar values backed by plain objects', () => {
    expect(JsonValueV1Schema.safeParse({ flags: ['won', true, 3, null] }).success).toBe(true)
    expect(UnicodeScalarStringV1Schema.safeParse('汉😀').success).toBe(true)
    expect(UnicodeScalarStringV1Schema.safeParse('\ud800').success).toBe(false)
    expect(JsonValueV1Schema.safeParse({ value: Number.POSITIVE_INFINITY }).success).toBe(false)
    expect(JsonValueV1Schema.safeParse({ value: undefined }).success).toBe(false)
    expect(JsonValueV1Schema.safeParse({ value: '\udfff' }).success).toBe(false)
    expect(JsonValueV1Schema.safeParse({ ['\ud800']: 'value' }).success).toBe(false)
    expect(JsonValueV1Schema.safeParse(new Date('2026-08-27T00:00:00.000Z')).success).toBe(false)
  })

  it('compares strings by Unicode code point without locale or UTF-16 ordering', () => {
    expect(compareUnicodeCodePointsV1('\uE000', '😀')).toBeLessThan(0)
    expect(compareUnicodeCodePointsV1('😀', '\uE000')).toBeGreaterThan(0)
    expect(compareUnicodeCodePointsV1('same', 'same')).toBe(0)
  })

  it('freezes exact UTF-8 domain separator strings without implementing hashing', () => {
    expect(AUTHORITY_CONTENT_SCHEMA_VERSION_V1).toBe('rvb-authority-content/v1')
    expect(AUTHORITY_CONTENT_IDENTITY_DOMAIN_V1)
      .toBe('RVB_AUTHORITY_CONTENT_IDENTITY_V1\0')
    expect(PACK_IDENTITY_DOMAIN_V1).toBe('RVB_PACK_IDENTITY_V1\0')
    expect(PROFILE_IDENTITY_DOMAIN_V1).toBe('RVB_PROFILE_IDENTITY_V1\0')
    expect(PACK_SIGNATURE_DOMAIN_V1).toBe('RVB_PACK_SIGNATURE_V1\0')
    expect([
      AUTHORITY_CONTENT_IDENTITY_DOMAIN_V1,
      PACK_IDENTITY_DOMAIN_V1,
      PROFILE_IDENTITY_DOMAIN_V1,
      PACK_SIGNATURE_DOMAIN_V1,
    ].every(domain => domain.charCodeAt(domain.length - 1) === 0)).toBe(true)
  })

  it('freezes normative canonical JSON text and byte vectors in both contract documents', () => {
    for (const file of [
      'docs/decisions/ADR-0018-content-pipeline-v1.md',
      'docs/technical/CONTENT_PIPELINE_V1_CONTRACT.md',
    ]) {
      const document = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(document).toContain('RVB Canonical JSON v1')
      expect(document).toContain('7b2261223a302c22ee8080223a312c22f09f9880223a327d')
      expect(document).toContain('333333333.3333333')
      expect(document).toContain('RFC 8785')
    }
  })
})

describe('rvb-pack/v1 manifest contract', () => {
  it.each([
    ['snapshot.valid.json', 'snapshot'],
    ['patch.valid.json', 'patch'],
  ])('accepts the valid %s fixture as a %s manifest', (name, kind) => {
    const result = PackManifestV1Schema.safeParse(loadFixture(name))

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.kind).toBe(kind)
  })

  it.each([
    'snapshot-unknown-field.invalid.json',
    'snapshot-patch-fields.invalid.json',
    'disallowed-file-type.invalid.json',
    'windows-path.invalid.json',
    'windows-superscript-device.invalid.json',
    'display-unpaired-surrogate.invalid.json',
  ])('fails closed for %s', name => {
    expect(PackManifestV1Schema.safeParse(loadFixture(name)).success).toBe(false)
  })

  it('rejects unpaired surrogates in displayName and description before identity projection', () => {
    const invalidDisplayName = PackManifestV1Schema.safeParse(
      loadFixture('display-unpaired-surrogate.invalid.json'),
    )
    const invalidDescription = loadFixture('snapshot.valid.json') as { description?: string }
    invalidDescription.description = '\udfff'

    expect(invalidDisplayName.success).toBe(false)
    expect(issuePaths(invalidDisplayName)).toContain('displayName')
    const descriptionResult = PackManifestV1Schema.safeParse(invalidDescription)
    expect(descriptionResult.success).toBe(false)
    expect(issuePaths(descriptionResult)).toContain('description')
  })
  it('keeps snapshot and patch fields mutually exclusive', () => {
    const result = PackManifestV1Schema.safeParse(loadFixture('snapshot-patch-fields.invalid.json'))

    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('')
  })

  it('requires replace/remove preconditions and one sorted operation per target', () => {
    const missingExpected = PackManifestV1Schema.safeParse(
      loadFixture('patch-missing-expected-hash.invalid.json'),
    )
    const duplicateTarget = PackManifestV1Schema.safeParse(
      loadFixture('patch-duplicate-target.invalid.json'),
    )

    expect(missingExpected.success).toBe(false)
    expect(issuePaths(missingExpected)).toContain('operations.0.expectedHash')
    expect(duplicateTarget.success).toBe(false)
    expect(issuePaths(duplicateTarget)).toContain('operations.1.targetPath')
  })

  it('requires canonical lexical order for set-like capabilities and file paths', () => {
    const fixture = loadFixture('snapshot.valid.json') as {
      capabilities: string[]
      files: Array<{ path: string }>
    }
    const unsortedCapabilities = structuredClone(fixture)
    const unsortedFiles = structuredClone(fixture)
    unsortedCapabilities.capabilities.reverse()
    unsortedFiles.files.reverse()

    const capabilityResult = PackManifestV1Schema.safeParse(unsortedCapabilities)
    const fileResult = PackManifestV1Schema.safeParse(unsortedFiles)

    expect(issuePaths(capabilityResult)).toContain('capabilities.1')
    expect(issuePaths(fileResult)).toContain('files.1.path')
  })

  it('uses Unicode code point order for manifest file descriptors', () => {
    const ordered = structuredClone(loadFixture('snapshot.valid.json')) as {
      files: Array<Record<string, unknown>>
    }
    const descriptor = ordered.files[0]
    ordered.files = [
      { ...descriptor, path: 'images/\uE000.png', mediaType: 'image/png' },
      { ...descriptor, path: 'images/😀.png', mediaType: 'image/png' },
    ]
    const reversed = structuredClone(ordered)
    reversed.files.reverse()

    expect(PackManifestV1Schema.safeParse(ordered).success).toBe(true)
    expect(issuePaths(PackManifestV1Schema.safeParse(reversed))).toContain('files.1.path')
  })

  it.each([
    ['data/cards/core.json', true],
    ['images/cards/core.jpg', true],
    ['images/cards/core.jpeg', true],
    ['images/cards/core.png', true],
    ['images/cards/core.webp', true],
    ['images/cards/.png', false],
    ['images/cards/.jpeg', false],
    ['images/cards/.webp', false],
    ['index.html', false],
    ['scripts/runtime.js', false],
    ['styles/runtime.css', false],
    ['images/vector.svg', false],
  ])('enforces the approved payload extension boundary for %s', (path, accepted) => {
    expect(PackPayloadPathV1Schema.safeParse(path).success).toBe(accepted)
  })

  it.each([
    ['data/cards/core.json', true],
    ['images/pve/node.json', false],
    ['campaign.json', false],
    ['data/.json', false],
    ['data/pve/.json', false],
  ])('enforces the shared Pack JSON payload path contract for %s', (path, accepted) => {
    expect(PackJsonPayloadPathV1Schema.safeParse(path).success).toBe(accepted)
  })
})

describe('detached Ed25519 envelope', () => {
  it('accepts the exact lowercase 32-byte key and 64-byte signature fixture', () => {
    expect(PackSignatureEnvelopeV1Schema.safeParse(loadFixture('signature.valid.json')).success).toBe(true)
  })

  it('rejects uppercase hex and unknown envelope fields', () => {
    const uppercase = PackSignatureEnvelopeV1Schema.safeParse(
      loadFixture('signature-uppercase.invalid.json'),
    )
    const withUnknownField = {
      ...(loadFixture('signature.valid.json') as Record<string, unknown>),
      trust: 'official',
    }

    expect(uppercase.success).toBe(false)
    expect(uppercase.success ? [] : uppercase.error.issues.map(issue => issue.path.join('.')))
      .toContain('keyId')
    expect(PackSignatureEnvelopeV1Schema.safeParse(withUnknownField).success).toBe(false)
  })
})

describe('rvb-authority-content/v1 identity projection', () => {
  it('accepts the strict compatibility, authority capability, and final JSON descriptor projection', () => {
    const result = AuthorityContentIdentityV1Schema.safeParse(
      loadFixture('authority-content.valid.json'),
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.schemaVersion).toBe(AUTHORITY_CONTENT_SCHEMA_VERSION_V1)
      expect(result.data.capabilities).toEqual([
        'game-data',
        'pve-content',
        'trusted-executable-content',
      ])
      expect(result.data.files.every(file => file.mediaType === 'application/json')).toBe(true)
    }
  })

  it.each([
    ['authority-content-unknown-field.invalid.json', ''],
    ['authority-content-raster-capability.invalid.json', 'capabilities.0'],
    ['authority-content-raster-file.invalid.json', 'files.0.mediaType'],
  ])('fails closed for %s at %s', (name, expectedPath) => {
    const result = AuthorityContentIdentityV1Schema.safeParse(loadFixture(name))

    expect(result.success).toBe(false)
    expect(result.success ? [] : result.error.issues.map(issue => issue.path.join('.')))
      .toContain(expectedPath)
  })

  it('requires authority capabilities to be unique and in Unicode code-point order', () => {
    const fixture = loadFixture('authority-content.valid.json') as {
      capabilities: string[]
    }
    const unsorted = structuredClone(fixture)
    const duplicate = structuredClone(fixture)
    unsorted.capabilities.reverse()
    duplicate.capabilities = ['game-data', 'game-data']

    const unsortedResult = AuthorityContentIdentityV1Schema.safeParse(unsorted)
    const duplicateResult = AuthorityContentIdentityV1Schema.safeParse(duplicate)

    expect(unsortedResult.success ? [] : unsortedResult.error.issues.map(issue => issue.path.join('.')))
      .toContain('capabilities.1')
    expect(duplicateResult.success ? [] : duplicateResult.error.issues.map(issue => issue.path.join('.')))
      .toContain('capabilities.1')
  })

  it('requires final JSON descriptors to be unique and in Unicode code-point path order', () => {
    const fixture = loadFixture('authority-content.valid.json') as {
      files: Array<Record<string, unknown>>
    }
    const unsorted = structuredClone(fixture)
    const duplicate = structuredClone(fixture)
    unsorted.files.reverse()
    duplicate.files = [structuredClone(duplicate.files[0]), structuredClone(duplicate.files[0])]

    const unsortedResult = AuthorityContentIdentityV1Schema.safeParse(unsorted)
    const duplicateResult = AuthorityContentIdentityV1Schema.safeParse(duplicate)

    expect(unsortedResult.success ? [] : unsortedResult.error.issues.map(issue => issue.path.join('.')))
      .toContain('files.1.path')
    expect(duplicateResult.success ? [] : duplicateResult.error.issues.map(issue => issue.path.join('.')))
      .toContain('files.1.path')
  })

  it('excludes package coordinates, provenance, and hash outputs from the strict projection', () => {
    const fixture = loadFixture('authority-content.valid.json') as Record<string, unknown>

    for (const [field, value] of [
      ['base', { packageId: 'rvb.core' }],
      ['patches', []],
      ['resolvedProfileHash', 'a'.repeat(64)],
      ['authorityContentHash', 'b'.repeat(64)],
    ] as const) {
      expect(AuthorityContentIdentityV1Schema.safeParse({ ...fixture, [field]: value }).success)
        .toBe(false)
    }

    const withProvenance = structuredClone(fixture) as {
      files: Array<Record<string, unknown>>
    }
    withProvenance.files[0].provenance = {
      packageHash: 'c'.repeat(64),
      operation: 'snapshot',
      sourcePath: 'data/cards/core.json',
    }
    expect(AuthorityContentIdentityV1Schema.safeParse(withProvenance).success).toBe(false)
  })
})

describe('rvb-profile/v1 resolved profile contract', () => {
  it('accepts a resolved profile with ordered patches, effective capabilities, and provenance', () => {
    const result = ResolvedProfileV1Schema.safeParse(loadFixture('profile.valid.json'))

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.patches.map(patch => patch.packageId)).toEqual(['community.balance-one'])
      expect(result.data.files[0].provenance.operation).toBe('replace')
      expect(result.data.authorityContentHash).toBe('9'.repeat(64))
    }
  })

  it('keeps both hash outputs outside the full resolved Profile identity projection', () => {
    const profile = ResolvedProfileV1Schema.parse(loadFixture('profile.valid.json'))
    const identity: Record<string, unknown> = { ...profile }
    delete identity.resolvedProfileHash
    delete identity.authorityContentHash

    expect(ResolvedProfileIdentityV1Schema.safeParse(identity).success).toBe(true)
    expect(ResolvedProfileIdentityV1Schema.safeParse(profile).success).toBe(false)
    expect(ResolvedProfileV1Schema.safeParse(identity).success).toBe(false)
  })

  it('rejects an old resolved Profile envelope that omits authorityContentHash', () => {
    const result = ResolvedProfileV1Schema.safeParse(
      loadFixture('profile-missing-authority-hash.invalid.json'),
    )

    expect(result.success).toBe(false)
    expect(result.success ? [] : result.error.issues.map(issue => issue.path.join('.')))
      .toContain('authorityContentHash')
  })

  it('fails closed on unknown fields and unsorted final file paths', () => {
    const unknownField = ResolvedProfileV1Schema.safeParse(
      loadFixture('profile-unknown-field.invalid.json'),
    )
    const unsorted = loadFixture('profile.valid.json') as {
      files: Array<{ descriptor: { path: string } }>
    }
    unsorted.files.reverse()
    const unsortedResult = ResolvedProfileV1Schema.safeParse(unsorted)

    expect(unknownField.success).toBe(false)
    expect(unsortedResult.success).toBe(false)
    expect(unsortedResult.success ? [] : unsortedResult.error.issues.map(issue => issue.path.join('.')))
      .toContain('files.1.descriptor.path')
  })

  it('keeps contract sources platform-neutral and disconnected from current pack runtimes', () => {
    for (const file of ['primitives-v1.ts', 'pack-v1.ts', 'profile-v1.ts']) {
      const source = readFileSync(resolve(process.cwd(), 'lib/content-pipeline/contracts', file), 'utf8')
      expect(source).not.toMatch(/node:(?:crypto|fs|path)/)
      expect(source).not.toContain('lib/resource-pack')
      expect(source).not.toContain('electron-client')
      expect(source).not.toContain('electron/resource-pack')
    }
  })
})
