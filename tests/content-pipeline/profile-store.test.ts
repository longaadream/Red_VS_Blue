import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PackCapabilityV1, PackFileMediaTypeV1 } from '@/lib/content-pipeline/contracts'
import { sha256HexV1 } from '@/lib/content-pipeline/core/hash'
import { resolveProfileV1, type ResolvedSnapshotViewV1 } from '@/lib/content-pipeline/core/resolver'
import type { ContentPackSourceV1 } from '@/lib/content-pipeline/core/source'
import {
  classifyProfileReloadV1,
  ProfileStoreErrorV1,
  ProfileStoreV1,
} from '@/lib/content-pipeline/runtime/profile-store'

const encoder = new TextEncoder()
const compatibility = { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' } as const
const temporaryRoots: string[] = []

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
  }
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-red-115-'))
  temporaryRoots.push(root)
  return root
}

function resolvedSnapshot(input: Readonly<{
  packageId: string
  marker: number
  jsonValue?: number
  capabilities?: readonly PackCapabilityV1[]
  compatibilityOverride?: { engineAbi: string; contentAbi: string }
}>): ResolvedSnapshotViewV1 {
  const activeCompatibility = input.compatibilityOverride ?? compatibility
  const files: Array<{
    path: string
    mediaType: PackFileMediaTypeV1
    bytes: Uint8Array
  }> = [{
    path: 'images/menu.png',
    mediaType: 'image/png',
    bytes: Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, input.marker,
    ]),
  }]
  if (input.jsonValue !== undefined) {
    files.push({
      path: 'data/rules/profile.json',
      mediaType: 'application/json',
      bytes: encoder.encode(JSON.stringify({ value: input.jsonValue })),
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const manifest = {
    schemaVersion: 'rvb-pack/v1',
    packageId: input.packageId,
    version: '1.0.0',
    displayName: input.packageId,
    publisher: { id: 'local.test', keyId: null },
    compatibility: activeCompatibility,
    capabilities: input.capabilities ?? (
      input.jsonValue === undefined ? ['raster-assets'] : ['game-data', 'raster-assets']
    ),
    files: files.map(file => ({
      path: file.path,
      mediaType: file.mediaType,
      size: file.bytes.byteLength,
      sha256: sha256HexV1(file.bytes),
    })),
    kind: 'snapshot',
  }
  const source: ContentPackSourceV1 = {
    manifestBytes: encoder.encode(JSON.stringify(manifest)),
    signatureBytes: null,
    entries: files.map(file => ({ path: file.path, bytes: file.bytes })),
  }
  return resolveProfileV1({
    base: {
      source,
      policy: {
        kind: 'local-dev',
        expectedCompatibility: activeCompatibility,
        allowUnsigned: true,
      },
    },
  })
}

function createStore(root: string, base: ResolvedSnapshotViewV1): ProfileStoreV1 {
  return new ProfileStoreV1({
    rootDir: root,
    bundledBase: base,
    now: () => '2026-08-28T00:00:00.000Z',
  })
}

describe('RED-115 Profile store and activation state', () => {
  it('opens an installed Profile only through the canonical verified immutable Snapshot seam', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 40, jsonValue: 40 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.snapshot-open', marker: 41, jsonValue: 41 })
    const store = createStore(root, base)
    const installed = store.installCandidate(candidate)

    const opened = store.openVerifiedSnapshot(installed)
    expect(opened.profile.resolvedProfileHash).toBe(installed.resolvedProfileHash)
    expect(opened.profile.authorityContentHash).toBe(installed.authorityContentHash)
    const first = opened.readFile('data/rules/profile.json')!
    first[0] = 0
    expect(new TextDecoder().decode(opened.readFile('data/rules/profile.json'))).toContain('"value":41')

    writeFileSync(path.join(root, 'profiles', installed.resolvedProfileHash, 'data/rules/profile.json'), '{}')
    expect(() => store.openVerifiedSnapshot(installed)).toThrow(/PROFILE_HASH_MISMATCH/)
  })

  it('installs an immutable candidate without changing stable, then commits atomically', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 1, jsonValue: 1 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.candidate', marker: 2, jsonValue: 2 })
    const store = createStore(root, base)

    const installed = store.installCandidate(candidate)
    const installedAgain = store.installCandidate(candidate)
    const staged = store.readState()

    expect(installedAgain).toEqual(installed)
    expect(staged.stable.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
    expect(staged.candidate?.resolvedProfileHash).toBe(candidate.profile.resolvedProfileHash)
    expect(staged.previousStable).toBeNull()
    expect(readFileSync(path.join(
      root,
      'profiles',
      candidate.profile.resolvedProfileHash,
      'data/rules/profile.json',
    ), 'utf8')).toContain('"value":2')

    const transaction = store.beginActivation(candidate.profile.resolvedProfileHash)
    const committed = store.commitActivation(
      transaction.activationId,
      candidate.profile.resolvedProfileHash,
    )
    expect(committed.stable.resolvedProfileHash).toBe(candidate.profile.resolvedProfileHash)
    expect(committed.previousStable?.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
    expect(committed.candidate).toBeNull()
    expect(committed.activation).toBeNull()
  })

  it('keeps stable on failure and recovers interrupted or legacy state to stable/Base', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 3, jsonValue: 3 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.bad', marker: 4, jsonValue: 4 })
    const store = createStore(root, base)
    store.installCandidate(candidate)
    const transaction = store.beginActivation(candidate.profile.resolvedProfileHash)
    const failed = store.failActivation(transaction.activationId, {
      code: 'CANDIDATE_HEALTH_FAILED',
      stage: 'fixed-seed-battle',
      message: 'candidate state hash mismatch',
    })

    expect(failed.stable.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
    expect(failed.lastFailure).toMatchObject({
      code: 'CANDIDATE_HEALTH_FAILED',
      targetProfileHash: candidate.profile.resolvedProfileHash,
      stableProfileHash: base.profile.resolvedProfileHash,
    })

    store.beginActivation(candidate.profile.resolvedProfileHash)
    const recovered = createStore(root, base).recoverInterruptedActivation()
    expect(recovered.stable.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
    expect(recovered.activation).toBeNull()
    expect(recovered.lastFailure?.code).toBe('ACTIVATION_INTERRUPTED')

    writeFileSync(path.join(root, 'active.json'), JSON.stringify({ activePackId: 'legacy' }))
    const legacyRecovered = createStore(root, base).readState()
    expect(legacyRecovered.stable.kind).toBe('bundled-base')
    expect(legacyRecovered.stable.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
  })

  it('supports previousStable and explicit Base rollback targets', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 5, jsonValue: 5 })
    const profileA = resolvedSnapshot({ packageId: 'rvb.a', marker: 6, jsonValue: 6 })
    const profileB = resolvedSnapshot({ packageId: 'rvb.b', marker: 7, jsonValue: 7 })
    const store = createStore(root, base)

    store.installCandidate(profileA)
    const activateA = store.beginActivation(profileA.profile.resolvedProfileHash)
    store.commitActivation(activateA.activationId, profileA.profile.resolvedProfileHash)
    store.installCandidate(profileB)
    const activateB = store.beginActivation(profileB.profile.resolvedProfileHash)
    store.commitActivation(activateB.activationId, profileB.profile.resolvedProfileHash)

    const previous = store.selectRollbackCandidate('previous-stable')
    expect(previous.candidate?.resolvedProfileHash).toBe(profileA.profile.resolvedProfileHash)
    expect(previous.stable.resolvedProfileHash).toBe(profileB.profile.resolvedProfileHash)

    const baseSelected = store.selectRollbackCandidate('bundled-base')
    expect(baseSelected.candidate?.kind).toBe('bundled-base')
    expect(baseSelected.candidate?.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
  })

  it('keeps a Base to Base rollback idempotent without leaving a candidate', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 30, jsonValue: 30 })
    const store = createStore(root, base)
    const before = store.readState()

    const selected = store.selectRollbackCandidate('bundled-base')

    expect(selected).toEqual(before)
    expect(selected.candidate).toBeNull()
    expect(selected.stable.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
  })

  it('persists the Windows A to failed-B to successful-B to A rollback lifecycle', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 21, jsonValue: 21 })
    const profileA = resolvedSnapshot({ packageId: 'rvb.windows-a', marker: 22, jsonValue: 22 })
    const profileB = resolvedSnapshot({ packageId: 'rvb.windows-b', marker: 23, jsonValue: 23 })

    let store = createStore(root, base)
    store.installCandidate(profileA)
    let transaction = store.beginActivation(profileA.profile.resolvedProfileHash)
    store.commitActivation(transaction.activationId, profileA.profile.resolvedProfileHash)

    store = createStore(root, base)
    store.installCandidate(profileB)
    transaction = store.beginActivation(profileB.profile.resolvedProfileHash)
    const failedB = store.failActivation(transaction.activationId, {
      code: 'CANDIDATE_ACTIVATION_FAILED',
      stage: 'fixed-seed-battle',
      message: 'forced Windows candidate failure',
    })
    expect(failedB.stable.resolvedProfileHash).toBe(profileA.profile.resolvedProfileHash)
    expect(failedB.candidate?.resolvedProfileHash).toBe(profileB.profile.resolvedProfileHash)

    store = createStore(root, base)
    transaction = store.beginActivation(profileB.profile.resolvedProfileHash)
    const committedB = store.commitActivation(transaction.activationId, profileB.profile.resolvedProfileHash)
    expect(committedB.stable.resolvedProfileHash).toBe(profileB.profile.resolvedProfileHash)
    expect(committedB.previousStable?.resolvedProfileHash).toBe(profileA.profile.resolvedProfileHash)

    store = createStore(root, base)
    const selectedA = store.selectRollbackCandidate('previous-stable')
    transaction = store.beginActivation(selectedA.candidate!.resolvedProfileHash)
    const rolledBackA = store.commitActivation(transaction.activationId, selectedA.candidate!.resolvedProfileHash)
    expect(rolledBackA.stable.resolvedProfileHash).toBe(profileA.profile.resolvedProfileHash)
    expect(rolledBackA.previousStable?.resolvedProfileHash).toBe(profileB.profile.resolvedProfileHash)
  })

  it('classifies refresh/restart/update requirements and detects unknown capability', () => {
    const rasterA = resolvedSnapshot({ packageId: 'rvb.raster-a', marker: 8 })
    const rasterB = resolvedSnapshot({ packageId: 'rvb.raster-b', marker: 9 })
    const authority = resolvedSnapshot({ packageId: 'rvb.authority', marker: 10, jsonValue: 10 })
    const unknownAbi = resolvedSnapshot({
      packageId: 'rvb.abi-v2',
      marker: 11,
      compatibilityOverride: { engineAbi: 'rvb-engine/v2', contentAbi: 'rvb-content/v2' },
    })
    const unknownCapability = {
      ...rasterB.profile,
      capabilities: [...rasterB.profile.capabilities, 'future-capability'],
    }

    expect(classifyProfileReloadV1(rasterA.profile, rasterB.profile)).toBe('presentation-refresh')
    expect(classifyProfileReloadV1(rasterA.profile, authority.profile)).toBe('authority-restart')
    expect(classifyProfileReloadV1(rasterA.profile, unknownAbi.profile)).toBe('app-update-required')
    expect(classifyProfileReloadV1(rasterA.profile, unknownCapability)).toBe('app-update-required')
  })

  it('fails a whole incomplete snapshot and rejects concurrent mutation', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 12, jsonValue: 12 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.candidate', marker: 13, jsonValue: 13 })
    const store = createStore(root, base)
    const installed = store.installCandidate(candidate)
    rmSync(path.join(root, 'profiles', installed.resolvedProfileHash, 'images/menu.png'))

    expect(() => store.verifyReference(installed)).toThrowError(ProfileStoreErrorV1)
    expect(() => store.verifyReference(installed)).toThrowError(/PROFILE_SNAPSHOT_INCOMPLETE/)

    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'activation.lock'), 'held')
    expect(() => store.selectRollbackCandidate('bundled-base')).toThrowError(/PROFILE_STORE_BUSY/)
    rmSync(path.join(root, 'activation.lock'))

    writeFileSync(path.join(root, 'activation.lock'), JSON.stringify({
      schemaVersion: 'rvb-profile-lock/v1',
      pid: 2_147_483_647,
      ownerToken: 'dead-owner',
      createdAt: '2026-08-27T00:00:00.000Z',
    }))
    const recoveredRollback = store.selectRollbackCandidate('bundled-base')
    expect(recoveredRollback.candidate).toBeNull()
    expect(recoveredRollback.stable.kind).toBe('bundled-base')
  })

  it('publishes only complete lock records and leaves no claim after an operation failure', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 31, jsonValue: 31 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.lock-publish', marker: 32, jsonValue: 32 })
    const store = createStore(root, base)
    store.installCandidate(candidate)
    const transaction = store.beginActivation(candidate.profile.resolvedProfileHash)

    expect(() => store.failActivation('wrong-owner', {
      code: 'EXPECTED_TEST_FAILURE',
      stage: 'lock-publish-test',
      message: 'force operation failure after lock publication',
    })).toThrow(/PROFILE_ACTIVATION_MISMATCH/)
    expect(existsSync(path.join(root, 'activation.lock'))).toBe(false)
    expect(readdirSync(root).filter(name => name.includes('activation.lock.claim-'))).toEqual([])

    expect(store.failActivation(transaction.activationId, {
      code: 'RECOVERED',
      stage: 'lock-publish-test',
      message: 'the next owner can acquire the canonical lock',
    }).activation).toBeNull()
  })

  it('recomputes Profile identities and binds pointer metadata to the immutable snapshot', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 27, jsonValue: 27 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.tamper', marker: 28, jsonValue: 28 })
    const store = createStore(root, base)
    const installed = store.installCandidate(candidate)
    const profileRoot = path.join(root, 'profiles', installed.resolvedProfileHash)
    const contentPath = path.join(profileRoot, 'data', 'rules', 'profile.json')
    const metadataPath = path.join(profileRoot, '.rvb', 'profile.json')
    const tamperedBytes = encoder.encode(JSON.stringify({ value: 999 }))
    writeFileSync(contentPath, tamperedBytes)
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      files: Array<{ descriptor: { path: string; size: number; sha256: string } }>
    }
    const descriptor = metadata.files.find(file => file.descriptor.path === 'data/rules/profile.json')!.descriptor
    descriptor.size = tamperedBytes.byteLength
    descriptor.sha256 = sha256HexV1(tamperedBytes)
    writeFileSync(metadataPath, JSON.stringify(metadata))

    expect(() => store.verifyReference(installed)).toThrow(/PROFILE_HASH_MISMATCH/)
    expect(() => store.verifyReference({ ...installed, capabilities: [] })).toThrow(/PROFILE_HASH_MISMATCH/)
  })

  it('recovers a corrupted installed stable pointer to Bundled Base before server startup', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 29, jsonValue: 29 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.corrupt-stable', marker: 30, jsonValue: 30 })
    const store = createStore(root, base)
    store.installCandidate(candidate)
    const transaction = store.beginActivation(candidate.profile.resolvedProfileHash)
    store.commitActivation(transaction.activationId, candidate.profile.resolvedProfileHash)
    rmSync(path.join(root, 'profiles', candidate.profile.resolvedProfileHash, '.rvb', 'profile.json'))

    const recovered = createStore(root, base).readState()
    expect(recovered.stable.kind).toBe('bundled-base')
    expect(recovered.stable.resolvedProfileHash).toBe(base.profile.resolvedProfileHash)
    expect(recovered.lastFailure?.stage).toBe('startup-recovery')
  })

  it('rejects undeclared installed files so authority loaders cannot bypass Profile identity', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 33, jsonValue: 33 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.closed-set', marker: 34, jsonValue: 34 })
    const store = createStore(root, base)
    const installed = store.installCandidate(candidate)
    const transaction = store.beginActivation(installed.resolvedProfileHash)
    store.commitActivation(transaction.activationId, installed.resolvedProfileHash)
    const injectedDirectory = path.join(root, 'profiles', installed.resolvedProfileHash, 'data', 'rules')
    mkdirSync(injectedDirectory, { recursive: true })
    writeFileSync(path.join(injectedDirectory, 'undeclared-rule.json'), JSON.stringify({
      id: 'undeclared-authority-rule',
    }))

    expect(() => store.verifyReference(installed)).toThrow(/PROFILE_HASH_MISMATCH.*undeclared file/)
    const recovered = createStore(root, base).readState()
    expect(recovered.stable.kind).toBe('bundled-base')
    expect(recovered.lastFailure).toMatchObject({
      code: 'PROFILE_HASH_MISMATCH',
      stage: 'startup-recovery',
      targetProfileHash: installed.resolvedProfileHash,
    })
  })

  it('keeps install and rollback mutually exclusive with an activation transaction', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 24, jsonValue: 24 })
    const candidate = resolvedSnapshot({ packageId: 'rvb.candidate', marker: 25, jsonValue: 25 })
    const replacement = resolvedSnapshot({ packageId: 'rvb.replacement', marker: 26, jsonValue: 26 })
    const store = createStore(root, base)
    store.installCandidate(candidate)
    const transaction = store.beginActivation(candidate.profile.resolvedProfileHash)

    expect(() => store.installCandidate(replacement)).toThrow(/PROFILE_STORE_BUSY/)
    expect(() => store.selectRollbackCandidate('bundled-base')).toThrow(/PROFILE_STORE_BUSY/)
    expect(store.beginActivation(candidate.profile.resolvedProfileHash)).toEqual(transaction)
  })

  it('persists structured postcommit renderer failure and rollback evidence atomically', () => {
    const root = temporaryRoot()
    const base = resolvedSnapshot({ packageId: 'rvb.base', marker: 35, jsonValue: 35 })
    const store = createStore(root, base)
    const failure = store.recordAuditEvidence({
      kind: 'postcommit-renderer-failure',
      code: 'PROFILE_RENDERER_RELOAD_FAILED',
      stage: 'renderer-commit-reload',
      message: 'renderer hash mismatch',
      targetProfileHash: 'a'.repeat(64),
      stableProfileHash: 'a'.repeat(64),
      rollbackTarget: 'previous-stable',
      rollbackSucceeded: null,
    })
    const rollback = store.recordAuditEvidence({
      kind: 'postcommit-renderer-rollback',
      code: 'PROFILE_RENDERER_ROLLBACK_RESULT',
      stage: 'renderer-commit-reload',
      message: 'rollback completed',
      targetProfileHash: 'a'.repeat(64),
      stableProfileHash: 'b'.repeat(64),
      rollbackTarget: 'previous-stable',
      rollbackSucceeded: true,
    })

    const files = readdirSync(path.join(root, 'audit')).sort()
    expect(files).toHaveLength(2)
    expect(files.every(name => name.endsWith('.json'))).toBe(true)
    expect(JSON.parse(readFileSync(path.join(root, 'audit', `${failure.eventId}.json`), 'utf8')))
      .toEqual(failure)
    expect(JSON.parse(readFileSync(path.join(root, 'audit', `${rollback.eventId}.json`), 'utf8')))
      .toEqual(rollback)
  })
})
