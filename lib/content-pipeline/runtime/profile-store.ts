import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  PackCapabilityV1Schema,
  ResolvedProfileV1Schema,
  type ResolvedProfileV1,
} from '../contracts'
import { computeResolvedProfileIdentitiesV1, sha256HexV1 } from '../core/hash'
import type { ResolvedSnapshotViewV1 } from '../core/resolver'

export const PROFILE_STATE_SCHEMA_VERSION_V1 = 'rvb-profile-state/v1' as const
export const PROFILE_REFERENCE_SCHEMA_VERSION_V1 = 'rvb-profile-reference/v1' as const
export const PROFILE_METADATA_DIRECTORY_V1 = '.rvb' as const
export const PROFILE_METADATA_FILE_V1 = '.rvb/profile.json' as const
export const PROFILE_RESOLUTION_FILE_V1 = '.rvb/resolution.json' as const
export const SUPPORTED_ENGINE_ABI_V1 = 'rvb-engine/v1' as const
export const SUPPORTED_CONTENT_ABI_V1 = 'rvb-content/v1' as const

export type ProfileReloadModeV1 =
  | 'presentation-refresh'
  | 'authority-restart'
  | 'app-update-required'

export type ProfileStoreErrorCodeV1 =
  | 'PROFILE_STORE_BUSY'
  | 'PROFILE_STATE_INVALID'
  | 'PROFILE_CANDIDATE_MISSING'
  | 'PROFILE_ACTIVATION_MISMATCH'
  | 'PROFILE_SNAPSHOT_INCOMPLETE'
  | 'PROFILE_HASH_MISMATCH'
  | 'PROFILE_ROLLBACK_UNAVAILABLE'

export class ProfileStoreErrorV1 extends Error {
  readonly code: ProfileStoreErrorCodeV1

  constructor(code: ProfileStoreErrorCodeV1, detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'ProfileStoreErrorV1'
    this.code = code
  }
}

export interface ProfileReferenceV1 {
  readonly schemaVersion: typeof PROFILE_REFERENCE_SCHEMA_VERSION_V1
  readonly kind: 'bundled-base' | 'installed'
  readonly resolvedProfileHash: string
  readonly authorityContentHash: string
  readonly compatibility: Readonly<{ engineAbi: string; contentAbi: string }>
  readonly capabilities: readonly string[]
  readonly packageId: string
  readonly version: string
  readonly installedAt: string
}

export interface ProfileActivationTransactionV1 {
  readonly activationId: string
  readonly targetProfileHash: string
  readonly stableProfileHash: string
  readonly requestedAt: string
}

export interface ProfileActivationFailureV1 {
  readonly code: string
  readonly stage: string
  readonly message: string
  readonly targetProfileHash: string
  readonly stableProfileHash: string
  readonly occurredAt: string
}

export interface ProfileStateV1 {
  readonly schemaVersion: typeof PROFILE_STATE_SCHEMA_VERSION_V1
  readonly revision: number
  readonly stable: ProfileReferenceV1
  readonly candidate: ProfileReferenceV1 | null
  readonly previousStable: ProfileReferenceV1 | null
  readonly activation: ProfileActivationTransactionV1 | null
  readonly lastFailure: ProfileActivationFailureV1 | null
}

export interface ProfileAuditEvidenceV1 {
  readonly schemaVersion: 'rvb-profile-audit/v1'
  readonly eventId: string
  readonly kind: 'postcommit-renderer-failure' | 'postcommit-renderer-rollback'
  readonly code: string
  readonly stage: string
  readonly message: string
  readonly targetProfileHash: string
  readonly stableProfileHash: string
  readonly rollbackTarget: 'previous-stable' | null
  readonly rollbackSucceeded: boolean | null
  readonly occurredAt: string
}

interface ProfileLikeV1 {
  readonly resolvedProfileHash: string
  readonly authorityContentHash: string
  readonly compatibility: Readonly<{ engineAbi: string; contentAbi: string }>
  readonly capabilities: readonly string[]
}

export interface ProfileStoreOptionsV1 {
  readonly rootDir: string
  readonly bundledBase: ResolvedSnapshotViewV1
  readonly now?: () => string
  readonly createActivationId?: () => string
}

export interface ProfileResolutionPackageV1 {
  readonly packageHash: string
  readonly policy: 'bundled-base' | 'external' | 'local-dev'
}

export interface ProfileResolutionRecordV1 {
  readonly schemaVersion: 'rvb-profile-resolution/v1'
  readonly base: ProfileResolutionPackageV1
  readonly patches: readonly ProfileResolutionPackageV1[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneReference(reference: ProfileReferenceV1): ProfileReferenceV1 {
  return {
    ...reference,
    compatibility: { ...reference.compatibility },
    capabilities: [...reference.capabilities],
  }
}

function referenceMatchesProfile(
  reference: ProfileReferenceV1,
  profile: ResolvedProfileV1,
): boolean {
  return reference.resolvedProfileHash === profile.resolvedProfileHash
    && reference.authorityContentHash === profile.authorityContentHash
    && reference.packageId === profile.base.packageId
    && reference.version === profile.base.version
    && reference.compatibility.engineAbi === profile.compatibility.engineAbi
    && reference.compatibility.contentAbi === profile.compatibility.contentAbi
    && reference.capabilities.length === profile.capabilities.length
    && reference.capabilities.every((capability, index) => capability === profile.capabilities[index])
}

function referenceFromView(
  view: ResolvedSnapshotViewV1,
  kind: ProfileReferenceV1['kind'],
  installedAt: string,
): ProfileReferenceV1 {
  return {
    schemaVersion: PROFILE_REFERENCE_SCHEMA_VERSION_V1,
    kind,
    resolvedProfileHash: view.profile.resolvedProfileHash,
    authorityContentHash: view.profile.authorityContentHash,
    compatibility: { ...view.profile.compatibility },
    capabilities: [...view.profile.capabilities],
    packageId: view.profile.base.packageId,
    version: view.profile.base.version,
    installedAt,
  }
}

function parseReference(value: unknown): ProfileReferenceV1 | null {
  if (!isObject(value)) return null
  if (
    value.schemaVersion !== PROFILE_REFERENCE_SCHEMA_VERSION_V1
    || (value.kind !== 'bundled-base' && value.kind !== 'installed')
    || typeof value.resolvedProfileHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.resolvedProfileHash)
    || typeof value.authorityContentHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.authorityContentHash)
    || !isObject(value.compatibility)
    || typeof value.compatibility.engineAbi !== 'string'
    || typeof value.compatibility.contentAbi !== 'string'
    || !Array.isArray(value.capabilities)
    || !value.capabilities.every(capability => typeof capability === 'string')
    || typeof value.packageId !== 'string'
    || typeof value.version !== 'string'
    || typeof value.installedAt !== 'string'
  ) return null
  return {
    schemaVersion: PROFILE_REFERENCE_SCHEMA_VERSION_V1,
    kind: value.kind,
    resolvedProfileHash: value.resolvedProfileHash,
    authorityContentHash: value.authorityContentHash,
    compatibility: {
      engineAbi: value.compatibility.engineAbi,
      contentAbi: value.compatibility.contentAbi,
    },
    capabilities: [...value.capabilities],
    packageId: value.packageId,
    version: value.version,
    installedAt: value.installedAt,
  }
}

function parseState(value: unknown): ProfileStateV1 | null {
  if (!isObject(value) || value.schemaVersion !== PROFILE_STATE_SCHEMA_VERSION_V1) {
    return null
  }
  const stable = parseReference(value.stable)
  const candidate = value.candidate === null ? null : parseReference(value.candidate)
  const previous = value.previousStable === null
    ? null
    : parseReference(value.previousStable)
  if (
    !stable
    || candidate === null && value.candidate !== null
    || previous === null && value.previousStable !== null
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || (value.activation !== null && !isObject(value.activation))
    || (value.lastFailure !== null && !isObject(value.lastFailure))
  ) return null

  const activation = value.activation === null ? null : value.activation
  const failure = value.lastFailure === null ? null : value.lastFailure
  if (activation && (
    typeof activation.activationId !== 'string'
    || typeof activation.targetProfileHash !== 'string'
    || typeof activation.stableProfileHash !== 'string'
    || typeof activation.requestedAt !== 'string'
  )) return null
  if (failure && (
    typeof failure.code !== 'string'
    || typeof failure.stage !== 'string'
    || typeof failure.message !== 'string'
    || typeof failure.targetProfileHash !== 'string'
    || typeof failure.stableProfileHash !== 'string'
    || typeof failure.occurredAt !== 'string'
  )) return null

  return {
    schemaVersion: PROFILE_STATE_SCHEMA_VERSION_V1,
    revision: value.revision,
    stable,
    candidate,
    previousStable: previous,
    activation: activation as unknown as ProfileActivationTransactionV1 | null,
    lastFailure: failure as unknown as ProfileActivationFailureV1 | null,
  }
}

export function classifyProfileReloadV1(
  current: ProfileLikeV1,
  target: ProfileLikeV1,
): ProfileReloadModeV1 {
  const compatible = target.compatibility.engineAbi === SUPPORTED_ENGINE_ABI_V1
    && target.compatibility.contentAbi === SUPPORTED_CONTENT_ABI_V1
  const knownCapabilities = target.capabilities.every(capability =>
    PackCapabilityV1Schema.safeParse(capability).success)
  if (!compatible || !knownCapabilities) return 'app-update-required'
  return target.authorityContentHash === current.authorityContentHash
    ? 'presentation-refresh'
    : 'authority-restart'
}

export class ProfileStoreV1 {
  readonly rootDir: string
  readonly profilesDir: string
  readonly statePath: string
  readonly lockPath: string
  readonly auditDir: string
  private readonly bundledBase: ResolvedSnapshotViewV1
  private readonly now: () => string
  private readonly createActivationId: () => string

  constructor(options: ProfileStoreOptionsV1) {
    this.rootDir = path.resolve(options.rootDir)
    this.profilesDir = path.join(this.rootDir, 'profiles')
    this.statePath = path.join(this.rootDir, 'active.json')
    this.lockPath = path.join(this.rootDir, 'activation.lock')
    this.auditDir = path.join(this.rootDir, 'audit')
    this.bundledBase = options.bundledBase
    this.now = options.now ?? (() => new Date().toISOString())
    this.createActivationId = options.createActivationId ?? randomUUID
  }

  private bundledReference(): ProfileReferenceV1 {
    return referenceFromView(this.bundledBase, 'bundled-base', this.now())
  }

  private defaultState(): ProfileStateV1 {
    return {
      schemaVersion: PROFILE_STATE_SCHEMA_VERSION_V1,
      revision: 0,
      stable: this.bundledReference(),
      candidate: null,
      previousStable: null,
      activation: null,
      lastFailure: null,
    }
  }

  private ensureRoot(): void {
    mkdirSync(this.profilesDir, { recursive: true })
  }

  private atomicWriteState(state: ProfileStateV1): void {
    this.ensureRoot()
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      renameSync(temporary, this.statePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private withLock<T>(operation: () => T): T {
    this.ensureRoot()
    const ownerToken = randomUUID()
    const ownerRecord = JSON.stringify({
      schemaVersion: 'rvb-profile-lock/v1',
      pid: process.pid,
      ownerToken,
      createdAt: this.now(),
    })
    const publishOwnerLock = (): void => {
      const claimPath = `${this.lockPath}.claim-${process.pid}-${ownerToken}`
      try {
        // Publish only a fully-written owner record. linkSync is atomic and
        // fails when activation.lock already exists, so a crash can leave an
        // orphan claim or a complete canonical lock, never a partial lock.
        writeFileSync(claimPath, ownerRecord, { encoding: 'utf8', flag: 'wx' })
        linkSync(claimPath, this.lockPath)
      } finally {
        try {
          // An orphan claim is non-authoritative and can be cleaned later; a
          // cleanup failure must not turn a published canonical lock into a
          // false acquisition failure owned by this same live process.
          rmSync(claimPath, { force: true })
        } catch {}
      }
    }
    try {
      publishOwnerLock()
    } catch {
      if (!this.removeDeadOwnerLock()) {
        throw new ProfileStoreErrorV1('PROFILE_STORE_BUSY')
      }
      try {
        publishOwnerLock()
      } catch {
        throw new ProfileStoreErrorV1('PROFILE_STORE_BUSY')
      }
    }
    try {
      return operation()
    } finally {
      try {
        const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { ownerToken?: unknown }
        if (owner.ownerToken === ownerToken) rmSync(this.lockPath)
      } catch {
        // Never remove a lock that cannot be proven to belong to this owner.
      }
    }
  }

  private removeDeadOwnerLock(): boolean {
    let observedRaw: string
    let owner: unknown
    try {
      observedRaw = readFileSync(this.lockPath, 'utf8')
      owner = JSON.parse(observedRaw)
    } catch {
      return false
    }
    if (
      !isObject(owner)
      || owner.schemaVersion !== 'rvb-profile-lock/v1'
      || typeof owner.pid !== 'number'
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
    ) return false
    try {
      process.kill(owner.pid, 0)
      return false
    } catch (error) {
      const code = isObject(error) && typeof error.code === 'string' ? error.code : ''
      if (code !== 'ESRCH') return false
    }
    const claimedPath = `${this.lockPath}.stale-${randomUUID()}`
    try {
      // Rename is the stale-lock claim. Competing recoverers cannot both claim
      // the same directory entry, and nobody deletes activation.lock by path.
      renameSync(this.lockPath, claimedPath)
    } catch {
      return false
    }
    try {
      if (readFileSync(claimedPath, 'utf8') !== observedRaw) {
        if (!existsSync(this.lockPath)) renameSync(claimedPath, this.lockPath)
        return false
      }
      rmSync(claimedPath)
      return true
    } catch {
      try {
        if (existsSync(claimedPath) && !existsSync(this.lockPath)) {
          renameSync(claimedPath, this.lockPath)
        }
      } catch {}
      return false
    }
  }

  readState(): ProfileStateV1 {
    this.ensureRoot()
    let parsed: ProfileStateV1 | null = null
    if (existsSync(this.statePath)) {
      try {
        parsed = parseState(JSON.parse(readFileSync(this.statePath, 'utf8')))
      } catch {
        parsed = null
      }
    }
    if (!parsed) {
      const base = this.defaultState()
      this.atomicWriteState(base)
      return base
    }
    if (parsed.stable.kind === 'bundled-base') {
      if (!referenceMatchesProfile(parsed.stable, this.bundledBase.profile)) {
        const base = this.defaultState()
        this.atomicWriteState(base)
        return base
      }
      return parsed
    }
    try {
      this.verifyReference(parsed.stable)
      return parsed
    } catch (error) {
      const base = this.defaultState()
      const recovered: ProfileStateV1 = {
        ...base,
        revision: parsed.revision + 1,
        lastFailure: {
          code: error instanceof ProfileStoreErrorV1
            ? error.code
            : 'PROFILE_STATE_INVALID',
          stage: 'startup-recovery',
          message: error instanceof Error ? error.message : String(error),
          targetProfileHash: parsed.stable.resolvedProfileHash,
          stableProfileHash: base.stable.resolvedProfileHash,
          occurredAt: this.now(),
        },
      }
      this.atomicWriteState(recovered)
      return recovered
    }
  }

  profileRoot(reference: ProfileReferenceV1): string | null {
    return reference.kind === 'bundled-base'
      ? null
      : path.join(this.profilesDir, reference.resolvedProfileHash)
  }

  verifyReference(reference: ProfileReferenceV1): void {
    if (reference.kind === 'bundled-base') {
      if (!referenceMatchesProfile(reference, this.bundledBase.profile)) {
        throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', reference.resolvedProfileHash)
      }
      return
    }
    const root = this.profileRoot(reference)!
    let profile: ResolvedProfileV1
    try {
      profile = ResolvedProfileV1Schema.parse(JSON.parse(
        readFileSync(path.join(root, PROFILE_METADATA_FILE_V1), 'utf8'),
      ))
    } catch {
      throw new ProfileStoreErrorV1('PROFILE_SNAPSHOT_INCOMPLETE', 'profile metadata')
    }
    const profileIdentity = {
      schemaVersion: profile.schemaVersion,
      compatibility: profile.compatibility,
      capabilities: profile.capabilities,
      base: profile.base,
      patches: profile.patches,
      files: profile.files,
    }
    const derived = computeResolvedProfileIdentitiesV1(profileIdentity)
    if (
      !referenceMatchesProfile(reference, profile)
      || derived.resolvedProfileHash !== profile.resolvedProfileHash
      || derived.authorityContentHash !== profile.authorityContentHash
    ) {
      throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', reference.resolvedProfileHash)
    }
    const allowedFiles = new Set([
      PROFILE_METADATA_FILE_V1,
      ...profile.files.map(file => file.descriptor.path),
    ])
    if (existsSync(path.join(root, PROFILE_RESOLUTION_FILE_V1))) {
      allowedFiles.add(PROFILE_RESOLUTION_FILE_V1)
    }
    const allowedDirectories = new Set<string>()
    for (const relativePath of allowedFiles) {
      let directory = path.posix.dirname(relativePath)
      while (directory !== '.') {
        allowedDirectories.add(directory)
        directory = path.posix.dirname(directory)
      }
    }
    const observedCaseInsensitive = new Set<string>()
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        const relative = path.relative(root, absolute).split(path.sep).join('/')
        const folded = relative.toLocaleLowerCase('en-US')
        if (observedCaseInsensitive.has(folded)) {
          throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `case collision: ${relative}`)
        }
        observedCaseInsensitive.add(folded)
        if (entry.isSymbolicLink()) {
          throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `symbolic link: ${relative}`)
        }
        if (entry.isDirectory()) {
          if (!allowedDirectories.has(relative)) {
            throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `undeclared directory: ${relative}`)
          }
          walk(absolute)
        } else if (entry.isFile()) {
          if (!allowedFiles.has(relative)) {
            throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `undeclared file: ${relative}`)
          }
        } else {
          throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `unsupported entry: ${relative}`)
        }
      }
    }
    walk(root)
    for (const file of profile.files) {
      const absolute = path.resolve(root, ...file.descriptor.path.split('/'))
      if (!absolute.startsWith(`${root}${path.sep}`) || !existsSync(absolute)) {
        throw new ProfileStoreErrorV1('PROFILE_SNAPSHOT_INCOMPLETE', file.descriptor.path)
      }
      const bytes = new Uint8Array(readFileSync(absolute))
      if (
        bytes.byteLength !== file.descriptor.size
        || sha256HexV1(bytes) !== file.descriptor.sha256
      ) {
        throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', file.descriptor.path)
      }
    }
  }

  recordAuditEvidence(
    evidence: Readonly<Omit<
      ProfileAuditEvidenceV1,
      'schemaVersion' | 'eventId' | 'occurredAt'
    >>,
  ): ProfileAuditEvidenceV1 {
    this.ensureRoot()
    mkdirSync(this.auditDir, { recursive: true })
    const record: ProfileAuditEvidenceV1 = {
      schemaVersion: 'rvb-profile-audit/v1',
      eventId: randomUUID(),
      ...evidence,
      occurredAt: this.now(),
    }
    const destination = path.join(this.auditDir, `${record.eventId}.json`)
    const temporary = `${destination}.tmp-${process.pid}`
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      renameSync(temporary, destination)
    } finally {
      rmSync(temporary, { force: true })
    }
    return record
  }

  installCandidate(
    view: ResolvedSnapshotViewV1,
    resolution?: ProfileResolutionRecordV1,
  ): ProfileReferenceV1 {
    return this.withLock(() => {
      const current = this.readState()
      if (current.activation) {
        throw new ProfileStoreErrorV1('PROFILE_STORE_BUSY', current.activation.activationId)
      }
      const installedAt = this.now()
      const reference = referenceFromView(view, 'installed', installedAt)
      const destination = path.join(this.profilesDir, view.profile.resolvedProfileHash)
      if (existsSync(destination)) {
        this.verifyReference(reference)
        if (resolution) {
          let stored: unknown
          try {
            stored = JSON.parse(readFileSync(
              path.join(destination, PROFILE_RESOLUTION_FILE_V1),
              'utf8',
            ))
          } catch {
            throw new ProfileStoreErrorV1(
              'PROFILE_SNAPSHOT_INCOMPLETE',
              PROFILE_RESOLUTION_FILE_V1,
            )
          }
          if (JSON.stringify(stored) !== JSON.stringify(resolution)) {
            throw new ProfileStoreErrorV1(
              'PROFILE_HASH_MISMATCH',
              PROFILE_RESOLUTION_FILE_V1,
            )
          }
        }
      } else {
        const temporary = path.join(
          this.profilesDir,
          `.${view.profile.resolvedProfileHash}.tmp-${randomUUID()}`,
        )
        try {
          mkdirSync(path.join(temporary, PROFILE_METADATA_DIRECTORY_V1), { recursive: true })
          for (const file of view.profile.files) {
            const bytes = view.readFile(file.descriptor.path)
            if (!bytes) {
              throw new ProfileStoreErrorV1(
                'PROFILE_SNAPSHOT_INCOMPLETE',
                file.descriptor.path,
              )
            }
            const absolute = path.resolve(temporary, ...file.descriptor.path.split('/'))
            if (!absolute.startsWith(`${temporary}${path.sep}`)) {
              throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', file.descriptor.path)
            }
            mkdirSync(path.dirname(absolute), { recursive: true })
            writeFileSync(absolute, bytes, { flag: 'wx' })
          }
          writeFileSync(
            path.join(temporary, PROFILE_METADATA_FILE_V1),
            `${JSON.stringify(view.profile, null, 2)}\n`,
            { encoding: 'utf8', flag: 'wx' },
          )
          if (resolution) {
            writeFileSync(
              path.join(temporary, PROFILE_RESOLUTION_FILE_V1),
              `${JSON.stringify(resolution, null, 2)}\n`,
              { encoding: 'utf8', flag: 'wx' },
            )
          }
          renameSync(temporary, destination)
        } finally {
          rmSync(temporary, { recursive: true, force: true })
        }
      }

      const next: ProfileStateV1 = {
        ...current,
        revision: current.revision + 1,
        candidate: reference,
        activation: null,
        lastFailure: null,
      }
      this.atomicWriteState(next)
      return cloneReference(reference)
    })
  }

  beginActivation(targetProfileHash: string): ProfileActivationTransactionV1 {
    return this.withLock(() => {
      const current = this.readState()
      if (!current.candidate || current.candidate.resolvedProfileHash !== targetProfileHash) {
        throw new ProfileStoreErrorV1('PROFILE_CANDIDATE_MISSING', targetProfileHash)
      }
      if (current.activation?.targetProfileHash === targetProfileHash) {
        return { ...current.activation }
      }
      this.verifyReference(current.candidate)
      const activation: ProfileActivationTransactionV1 = {
        activationId: this.createActivationId(),
        targetProfileHash,
        stableProfileHash: current.stable.resolvedProfileHash,
        requestedAt: this.now(),
      }
      this.atomicWriteState({
        ...current,
        revision: current.revision + 1,
        activation,
        lastFailure: null,
      })
      return { ...activation }
    })
  }

  commitActivation(activationId: string, targetProfileHash: string): ProfileStateV1 {
    return this.withLock(() => {
      const current = this.readState()
      if (
        !current.activation
        || current.activation.activationId !== activationId
        || current.activation.targetProfileHash !== targetProfileHash
        || !current.candidate
        || current.candidate.resolvedProfileHash !== targetProfileHash
      ) {
        throw new ProfileStoreErrorV1('PROFILE_ACTIVATION_MISMATCH', targetProfileHash)
      }
      this.verifyReference(current.candidate)
      const next: ProfileStateV1 = {
        ...current,
        revision: current.revision + 1,
        stable: cloneReference(current.candidate),
        previousStable: current.stable.resolvedProfileHash === targetProfileHash
          ? current.previousStable
          : cloneReference(current.stable),
        candidate: null,
        activation: null,
        lastFailure: null,
      }
      this.atomicWriteState(next)
      return next
    })
  }

  failActivation(
    activationId: string,
    failure: Readonly<{ code: string; stage: string; message: string }>,
  ): ProfileStateV1 {
    return this.withLock(() => {
      const current = this.readState()
      if (!current.activation || current.activation.activationId !== activationId) {
        throw new ProfileStoreErrorV1('PROFILE_ACTIVATION_MISMATCH', activationId)
      }
      const next: ProfileStateV1 = {
        ...current,
        revision: current.revision + 1,
        activation: null,
        lastFailure: {
          ...failure,
          targetProfileHash: current.activation.targetProfileHash,
          stableProfileHash: current.stable.resolvedProfileHash,
          occurredAt: this.now(),
        },
      }
      this.atomicWriteState(next)
      return next
    })
  }

  recoverInterruptedActivation(): ProfileStateV1 {
    return this.withLock(() => {
      const current = this.readState()
      if (!current.activation) return current
      const next: ProfileStateV1 = {
        ...current,
        revision: current.revision + 1,
        activation: null,
        lastFailure: {
          code: 'ACTIVATION_INTERRUPTED',
          stage: 'startup-recovery',
          message: 'Candidate activation did not commit; stable Profile was preserved.',
          targetProfileHash: current.activation.targetProfileHash,
          stableProfileHash: current.stable.resolvedProfileHash,
          occurredAt: this.now(),
        },
      }
      this.atomicWriteState(next)
      return next
    })
  }

  selectRollbackCandidate(target: 'previous-stable' | 'bundled-base'): ProfileStateV1 {
    return this.withLock(() => {
      const current = this.readState()
      if (current.activation) {
        throw new ProfileStoreErrorV1('PROFILE_STORE_BUSY', current.activation.activationId)
      }
      const candidate = target === 'bundled-base'
        ? this.bundledReference()
        : current.previousStable
      if (!candidate) {
        throw new ProfileStoreErrorV1('PROFILE_ROLLBACK_UNAVAILABLE', target)
      }
      this.verifyReference(candidate)
      if (candidate.resolvedProfileHash === current.stable.resolvedProfileHash) {
        if (current.candidate === null && current.lastFailure === null) return current
        const normalized: ProfileStateV1 = {
          ...current,
          revision: current.revision + 1,
          candidate: null,
          activation: null,
          lastFailure: null,
        }
        this.atomicWriteState(normalized)
        return normalized
      }
      const next: ProfileStateV1 = {
        ...current,
        revision: current.revision + 1,
        candidate: cloneReference(candidate),
        activation: null,
        lastFailure: null,
      }
      this.atomicWriteState(next)
      return next
    })
  }
}
