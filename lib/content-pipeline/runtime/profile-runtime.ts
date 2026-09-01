import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { getAppRoot, getUserDataDir } from '@/lib/app-paths'

import { getBundledBaseProfileV1 } from './bundled-base'
import type { ResolvedSnapshotViewV1 } from '../core/resolver'
import {
  classifyProfileReloadV1,
  ProfileStoreErrorV1,
  ProfileStoreV1,
  type ProfileActivationFailureV1,
  type ProfileAuditEvidenceV1,
  type ProfileReferenceV1,
  type ProfileReloadModeV1,
  type ProfileStateV1,
} from './profile-store'

export const PROFILE_HEALTH_SEED_V1 = 0x01152026

export interface ProfileRuntimeContextV1 {
  readonly appRoot: string
  readonly userDataDir: string
  readonly store: ProfileStoreV1
}

export interface ProfileLeaseReportV1 {
  readonly active: boolean
  readonly roomIds: readonly string[]
  readonly pveRunIds?: readonly string[]
  readonly pveBattleIds?: readonly string[]
}

export interface ProfileServerReportV1 {
  readonly schemaVersion: 'rvb-profile-server-report/v1'
  readonly profile: ProfileReferenceV1
  readonly profileRoot: string
  readonly activationId: string | null
  readonly processId: number
  readonly health: Readonly<{
    profileIntegrity: boolean
    contentParse: boolean
    fixedSeedBattle: boolean
    http: boolean
    menuResources: boolean
  }>
  readonly fixedSeed: Readonly<{ seed: number; stateHash: string | null }>
  readonly lease: ProfileLeaseReportV1
  readonly healthy: boolean
}

export interface ProfileStartupRecoveryV1 {
  readonly state: ReturnType<ProfileStoreV1['recoverInterruptedActivation']>
  readonly requiresProcessRestart: boolean
  readonly previousRuntime: Readonly<{
    resolvedProfileHash: string | null
    profileRoot: string | null
  }>
}

declare global {
  var __rvbProfileRuntimeContextV1: ProfileRuntimeContextV1 | undefined
  var __rvbProfileHttpIngressV1: {
    activeCount: () => number
    waitForDrain: (timeoutMs?: number) => Promise<boolean>
  } | undefined
}

export function getProfileRuntimeContextV1(): ProfileRuntimeContextV1 {
  const root = getAppRoot()
  const writable = getUserDataDir()
  const cached = globalThis.__rvbProfileRuntimeContextV1
  if (cached && cached.appRoot === root && cached.userDataDir === writable) return cached
  const context: ProfileRuntimeContextV1 = {
    appRoot: root,
    userDataDir: writable,
    store: new ProfileStoreV1({
      rootDir: path.join(writable, 'resource-pack'),
      bundledBase: getBundledBaseProfileV1(root),
    }),
  }
  globalThis.__rvbProfileRuntimeContextV1 = context
  return context
}

export function logProfileEventV1(
  stage: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  console.info(JSON.stringify({
    event: 'content-profile',
    stage,
    at: new Date().toISOString(),
    ...fields,
  }))
}

export function selectRuntimeProfileReferenceV1(
  state: ProfileStateV1,
  requestedHash: string | undefined,
  activationId: string | undefined,
): ProfileReferenceV1 {
  if (!requestedHash || requestedHash === state.stable.resolvedProfileHash) return state.stable
  if (
    !state.activation
    || !activationId
    || activationId !== state.activation.activationId
    || state.activation.targetProfileHash !== requestedHash
    || state.candidate?.resolvedProfileHash !== requestedHash
  ) {
    throw new ProfileStoreErrorV1('PROFILE_ACTIVATION_MISMATCH', requestedHash)
  }
  return state.candidate
}

function referenceForRuntime(context: ProfileRuntimeContextV1): ProfileReferenceV1 {
  const state = context.store.readState()
  const requestedHash = process.env.RVB_RESOLVED_PROFILE_HASH
  if (
    requestedHash
    && requestedHash !== state.stable.resolvedProfileHash
    && ![state.candidate, state.previousStable].some(
      reference => reference?.resolvedProfileHash === requestedHash,
    )
  ) {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `runtime hash ${requestedHash}`)
  }
  return selectRuntimeProfileReferenceV1(
    state,
    requestedHash,
    process.env.RVB_PROFILE_ACTIVATION_ID,
  )
}

export function getRuntimeProfileReferenceV1(): ProfileReferenceV1 {
  const context = getProfileRuntimeContextV1()
  const reference = referenceForRuntime(context)
  const root = getRuntimeProfileRootV1(context, reference)
  assertRuntimeEnvironment(context, reference, root)
  return reference
}

export function openRuntimeVerifiedSnapshotV1(): ResolvedSnapshotViewV1 {
  const context = getProfileRuntimeContextV1()
  const reference = referenceForRuntime(context)
  const root = getRuntimeProfileRootV1(context, reference)
  assertRuntimeEnvironment(context, reference, root)
  return context.store.openVerifiedSnapshot(reference)
}

export function getRuntimeProfileRootV1(
  context: ProfileRuntimeContextV1,
  reference: ProfileReferenceV1,
): string {
  return context.store.profileRoot(reference) ?? context.appRoot
}

function assertRuntimeEnvironment(
  context: ProfileRuntimeContextV1,
  reference: ProfileReferenceV1,
  root: string,
): void {
  const declaredRoot = process.env.RVB_PROFILE_ROOT
  if (declaredRoot && path.resolve(declaredRoot) !== path.resolve(root)) {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', 'runtime root mismatch')
  }
  const checks = [
    ['RVB_AUTHORITY_CONTENT_HASH', reference.authorityContentHash],
    ['RVB_PROFILE_ENGINE_ABI', reference.compatibility.engineAbi],
    ['RVB_PROFILE_CONTENT_ABI', reference.compatibility.contentAbi],
  ] as const
  for (const [name, expected] of checks) {
    const actual = process.env[name]
    if (actual && actual !== expected) {
      throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `${name} mismatch`)
    }
  }
  context.store.verifyReference(reference)
}

function absoluteProfileFile(
  context: ProfileRuntimeContextV1,
  reference: ProfileReferenceV1,
  relativePath: string,
): string {
  if (reference.kind === 'bundled-base') {
    if (relativePath.startsWith('data/')) {
      return path.join(context.appRoot, ...relativePath.split('/'))
    }
    if (relativePath.startsWith('images/')) {
      return path.join(context.appRoot, 'public', ...relativePath.split('/'))
    }
  }
  return path.join(getRuntimeProfileRootV1(context, reference), ...relativePath.split('/'))
}

function profileFromReference(
  context: ProfileRuntimeContextV1,
  reference: ProfileReferenceV1,
) {
  if (reference.kind === 'bundled-base') {
    return getBundledBaseProfileV1(context.appRoot).profile
  }
  return JSON.parse(readFileSync(path.join(
    getRuntimeProfileRootV1(context, reference),
    '.rvb',
    'profile.json',
  ), 'utf8')) as { files: Array<{ descriptor: { path: string } }> }
}

function parseAllJson(
  context: ProfileRuntimeContextV1,
  reference: ProfileReferenceV1,
): void {
  const profile = profileFromReference(context, reference)
  for (const file of profile.files) {
    if (!file.descriptor.path.startsWith('data/')) continue
    JSON.parse(readFileSync(
      absoluteProfileFile(context, reference, file.descriptor.path),
      'utf8',
    ))
  }
}

function hasMenuResources(
  context: ProfileRuntimeContextV1,
  reference: ProfileReferenceV1,
): boolean {
  const required = [
    'data/pieces/manifest.json',
    'data/skills/manifest.json',
    'data/cards/manifest.json',
    'data/cards/lucky-coin.json',
  ]
  return required.every(relative =>
    existsSync(absoluteProfileFile(context, reference, relative)))
}

export async function getProfileLeaseReportV1(): Promise<ProfileLeaseReportV1> {
  const { getPveActiveBattleLeaseReportV1 } = await import('@/lib/pve/profile-lifecycle')
  const pve = getPveActiveBattleLeaseReportV1()
  const roomIds: string[] = []
  return {
    active: roomIds.length > 0 || pve.active,
    roomIds,
    ...(pve.runIds.length > 0 ? { pveRunIds: pve.runIds } : {}),
    ...(pve.battleIds.length > 0 ? { pveBattleIds: pve.battleIds } : {}),
  }
}

export async function reconcileRuntimePveAuthorityV1(
  authorityContentHash: string,
  reason: 'activation-commit' | 'admission-release' | 'startup-recovery',
) {
  const { reconcilePveAuthorityV1 } = await import('@/lib/pve/profile-lifecycle')
  return reconcilePveAuthorityV1(authorityContentHash, reason)
}

export async function getProfileServerReportV1(): Promise<ProfileServerReportV1> {
  const context = getProfileRuntimeContextV1()
  const reference = referenceForRuntime(context)
  const root = getRuntimeProfileRootV1(context, reference)
  let profileIntegrity = false
  let contentParse = false
  let fixedSeedBattle = false
  let stateHash: string | null = null
  let menuResources = false
  try {
    assertRuntimeEnvironment(context, reference, root)
    profileIntegrity = true
    parseAllJson(context, reference)
    contentParse = true
    menuResources = hasMenuResources(context, reference)
    if (menuResources) {
      const { createDebugDuel } = await import('@/lib/game/debug-battle')
      const duel = await createDebugDuel({ seed: PROFILE_HEALTH_SEED_V1 })
      stateHash = duel.stateHash
      fixedSeedBattle = true
    }
  } catch (error) {
    logProfileEventV1('health-failure', {
      resolvedProfileHash: reference.resolvedProfileHash,
      authorityContentHash: reference.authorityContentHash,
      seed: PROFILE_HEALTH_SEED_V1,
      failure: error instanceof Error ? error.message : String(error),
    })
  }
  const lease = await getProfileLeaseReportV1()
  const health = {
    profileIntegrity,
    contentParse,
    fixedSeedBattle,
    http: true,
    menuResources,
  }
  const report: ProfileServerReportV1 = {
    schemaVersion: 'rvb-profile-server-report/v1',
    profile: reference,
    profileRoot: root,
    activationId: process.env.RVB_PROFILE_ACTIVATION_ID ?? null,
    processId: process.pid,
    health,
    fixedSeed: { seed: PROFILE_HEALTH_SEED_V1, stateHash },
    lease,
    healthy: Object.values(health).every(Boolean),
  }
  logProfileEventV1('server-report', {
    resolvedProfileHash: reference.resolvedProfileHash,
    authorityContentHash: reference.authorityContentHash,
    engineAbi: reference.compatibility.engineAbi,
    contentAbi: reference.compatibility.contentAbi,
    activationId: report.activationId,
    health,
    seed: PROFILE_HEALTH_SEED_V1,
    stateHash,
    activeRoomIds: lease.roomIds,
    activePveRunIds: lease.pveRunIds ?? [],
    activePveBattleIds: lease.pveBattleIds ?? [],
  })
  return report
}

export async function beginProfileActivationV1(targetProfileHash: string): Promise<{
  activationId: string
  reloadMode: ProfileReloadModeV1
  target: ProfileReferenceV1
  stable: ProfileReferenceV1
  profileRoot: string
}> {
  const context = getProfileRuntimeContextV1()
  const state = context.store.readState()
  if (!state.candidate || state.candidate.resolvedProfileHash !== targetProfileHash) {
    throw new ProfileStoreErrorV1('PROFILE_CANDIDATE_MISSING', targetProfileHash)
  }
  const reloadMode = classifyProfileReloadV1(state.stable, state.candidate)
  if (reloadMode === 'app-update-required') {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', reloadMode)
  }
  if (state.activation) {
    if (
      state.activation.targetProfileHash !== targetProfileHash
      || state.candidate.resolvedProfileHash !== targetProfileHash
    ) {
      throw new ProfileStoreErrorV1('PROFILE_STORE_BUSY', state.activation.activationId)
    }
    process.env.RVB_PROFILE_ADMISSION_PAUSED = state.activation.activationId
    const profileRoot = getRuntimeProfileRootV1(context, state.candidate)
    logProfileEventV1('activation-plan-retry', {
      activationId: state.activation.activationId,
      stableProfileHash: state.stable.resolvedProfileHash,
      targetProfileHash,
      authorityContentHash: state.candidate.authorityContentHash,
      reloadMode,
      profileRoot,
    })
    return {
      activationId: state.activation.activationId,
      reloadMode,
      target: state.candidate,
      stable: state.stable,
      profileRoot,
    }
  }
  let planningFence: string | null = null
  if (reloadMode === 'authority-restart') {
    planningFence = `activation-plan-${randomUUID()}`
    process.env.RVB_PROFILE_ADMISSION_PAUSED = planningFence
    try {
      const httpDrained = await (globalThis.__rvbProfileHttpIngressV1?.waitForDrain() ?? true)
      if (!httpDrained) throw new Error('PROFILE_HTTP_DRAIN_FAILED')
      const lease = await getProfileLeaseReportV1()
      if (process.env.RVB_PROFILE_ADMISSION_PAUSED !== planningFence) {
        throw new ProfileStoreErrorV1('PROFILE_STORE_BUSY', 'activation planning fence lost')
      }
      if (lease.active) {
        throw new Error(`PROFILE_IN_USE: ${[
          ...lease.roomIds,
          ...(lease.pveRunIds ?? []),
        ].join(',')}`)
      }
    } catch (error) {
      if (process.env.RVB_PROFILE_ADMISSION_PAUSED === planningFence) {
        delete process.env.RVB_PROFILE_ADMISSION_PAUSED
      }
      throw error
    }
  }
  let transaction
  try {
    transaction = context.store.beginActivation(targetProfileHash)
  } catch (error) {
    if (planningFence && process.env.RVB_PROFILE_ADMISSION_PAUSED === planningFence) {
      delete process.env.RVB_PROFILE_ADMISSION_PAUSED
    }
    throw error
  }
  process.env.RVB_PROFILE_ADMISSION_PAUSED = transaction.activationId
  const profileRoot = getRuntimeProfileRootV1(context, state.candidate)
  logProfileEventV1('activation-begin', {
    activationId: transaction.activationId,
    stableProfileHash: state.stable.resolvedProfileHash,
    targetProfileHash,
    authorityContentHash: state.candidate.authorityContentHash,
    reloadMode,
    profileRoot,
  })
  return {
    activationId: transaction.activationId,
    reloadMode,
    target: state.candidate,
    stable: state.stable,
    profileRoot,
  }
}

export function bindRuntimeProfileV1(activationId: string, targetProfileHash: string): void {
  const context = getProfileRuntimeContextV1()
  const state = context.store.readState()
  if (
    state.activation?.activationId !== activationId
    || state.candidate?.resolvedProfileHash !== targetProfileHash
  ) throw new ProfileStoreErrorV1('PROFILE_ACTIVATION_MISMATCH', targetProfileHash)
  const target = state.candidate
  process.env.RVB_PROFILE_ROOT = getRuntimeProfileRootV1(context, target)
  process.env.RVB_RESOLVED_PROFILE_HASH = target.resolvedProfileHash
  process.env.RVB_AUTHORITY_CONTENT_HASH = target.authorityContentHash
  process.env.RVB_PROFILE_ENGINE_ABI = target.compatibility.engineAbi
  process.env.RVB_PROFILE_CONTENT_ABI = target.compatibility.contentAbi
  process.env.RVB_PROFILE_ACTIVATION_ID = activationId
  process.env.RVB_PROFILE_ADMISSION_PAUSED = activationId
}

export function bindStableRuntimeProfileV1(
  options: Readonly<{ admissionPaused?: string }> = {},
): void {
  const context = getProfileRuntimeContextV1()
  const stable = context.store.readState().stable
  process.env.RVB_PROFILE_ROOT = getRuntimeProfileRootV1(context, stable)
  process.env.RVB_RESOLVED_PROFILE_HASH = stable.resolvedProfileHash
  process.env.RVB_AUTHORITY_CONTENT_HASH = stable.authorityContentHash
  process.env.RVB_PROFILE_ENGINE_ABI = stable.compatibility.engineAbi
  process.env.RVB_PROFILE_CONTENT_ABI = stable.compatibility.contentAbi
  delete process.env.RVB_PROFILE_ACTIVATION_ID
  if (options.admissionPaused) {
    process.env.RVB_PROFILE_ADMISSION_PAUSED = options.admissionPaused
  } else {
    delete process.env.RVB_PROFILE_ADMISSION_PAUSED
  }
}

export function recoverRuntimeProfileOnStartupV1(
  options: Readonly<{ keepAdmissionPaused?: boolean }> = {},
): ProfileStartupRecoveryV1 {
  const context = getProfileRuntimeContextV1()
  const previousRuntime = {
    resolvedProfileHash: process.env.RVB_RESOLVED_PROFILE_HASH ?? null,
    profileRoot: process.env.RVB_PROFILE_ROOT ?? null,
  }
  const startupAdmission = process.env.RVB_PROFILE_ADMISSION_PAUSED ?? 'startup-recovery'
  const state = context.store.recoverInterruptedActivation()
  const stableRoot = getRuntimeProfileRootV1(context, state.stable)
  const requiresProcessRestart = (
    previousRuntime.resolvedProfileHash !== null
    && previousRuntime.resolvedProfileHash !== state.stable.resolvedProfileHash
  ) || (
    previousRuntime.profileRoot !== null
    && path.resolve(/* turbopackIgnore: true */ previousRuntime.profileRoot)
      !== path.resolve(stableRoot)
  )

  // The old identity may already exist in process-scoped module caches.
  // Keep gameplay admission closed until Electron replaces this process.
  bindStableRuntimeProfileV1({
    admissionPaused: requiresProcessRestart || options.keepAdmissionPaused
      ? startupAdmission
      : undefined,
  })
  return { state, requiresProcessRestart, previousRuntime }
}

export function recordActivationFailureV1(
  activationId: string,
  failure: Pick<ProfileActivationFailureV1, 'code' | 'stage' | 'message'>,
) {
  const context = getProfileRuntimeContextV1()
  const state = context.store.failActivation(activationId, failure)
  logProfileEventV1('activation-failure', {
    activationId,
    ...state.lastFailure,
  })
  return state
}

export function recordProfileAuditEvidenceV1(
  evidence: Readonly<Omit<
    ProfileAuditEvidenceV1,
    'schemaVersion' | 'eventId' | 'occurredAt' | 'stableProfileHash'
  >>,
): ProfileAuditEvidenceV1 {
  const context = getProfileRuntimeContextV1()
  const stable = context.store.readState().stable
  const record = context.store.recordAuditEvidence({
    ...evidence,
    stableProfileHash: stable.resolvedProfileHash,
  })
  logProfileEventV1(record.kind, { ...record })
  return record
}
