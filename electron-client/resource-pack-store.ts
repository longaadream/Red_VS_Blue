import fs from 'node:fs'
import path from 'node:path'

export interface DesktopProfileReference {
  readonly schemaVersion: 'rvb-profile-reference/v1'
  readonly kind: 'bundled-base' | 'installed'
  readonly resolvedProfileHash: string
  readonly authorityContentHash: string
  readonly compatibility: Readonly<{ engineAbi: string; contentAbi: string }>
  readonly capabilities: readonly string[]
  readonly packageId: string
  readonly version: string
  readonly installedAt: string
}

export interface DesktopProfileState {
  readonly schemaVersion: 'rvb-profile-state/v1'
  readonly stable: DesktopProfileReference
  readonly candidate: DesktopProfileReference | null
  readonly previousStable: DesktopProfileReference | null
  readonly lastFailure: unknown
}

export function isActivatableResourcePackPath(relativePath: string): boolean {
  return /^data\/.+\.json$/i.test(relativePath)
    || /^images\/.+\.(?:jpe?g|png|svg|webp)$/i.test(relativePath)
}

function isReference(value: unknown): value is DesktopProfileReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reference = value as Partial<DesktopProfileReference>
  return reference.schemaVersion === 'rvb-profile-reference/v1'
    && (reference.kind === 'bundled-base' || reference.kind === 'installed')
    && typeof reference.resolvedProfileHash === 'string'
    && /^[0-9a-f]{64}$/.test(reference.resolvedProfileHash)
    && typeof reference.authorityContentHash === 'string'
    && /^[0-9a-f]{64}$/.test(reference.authorityContentHash)
    && typeof reference.compatibility?.engineAbi === 'string'
    && typeof reference.compatibility?.contentAbi === 'string'
    && Array.isArray(reference.capabilities)
}

export function readDesktopProfileState(packRoot: string): DesktopProfileState | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(packRoot, 'active.json'), 'utf8')) as Partial<DesktopProfileState>
    if (value.schemaVersion !== 'rvb-profile-state/v1' || !isReference(value.stable)) return null
    if (value.candidate !== null && !isReference(value.candidate)) return null
    if (value.previousStable !== null && !isReference(value.previousStable)) return null
    return value as DesktopProfileState
  } catch {
    return null
  }
}

export function resolveActiveResourcePackRoot(packRoot: string): string | null {
  const stable = readDesktopProfileState(packRoot)?.stable
  if (!stable || stable.kind === 'bundled-base') return null
  const profileRoot = path.join(packRoot, 'profiles', stable.resolvedProfileHash)
  const metadata = path.join(profileRoot, '.rvb', 'profile.json')
  const data = path.join(profileRoot, 'data')
  if (!fs.existsSync(metadata) || !fs.existsSync(data)) {
    throw new Error(`PROFILE_SNAPSHOT_INCOMPLETE: ${stable.resolvedProfileHash}`)
  }
  return profileRoot
}

export function getActiveResourcePackMeta(packRoot: string): DesktopProfileReference | null {
  return readDesktopProfileState(packRoot)?.stable ?? null
}

export function listActiveResourcePackFiles(packRoot: string): string[] {
  const root = resolveActiveResourcePackRoot(packRoot)
  if (!root) return []
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.rvb') continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join('/')
        if (isActivatableResourcePackPath(relative)) files.push(`/${relative}`)
      }
    }
  }
  walk(root)
  return files.sort((left, right) => left.localeCompare(right, 'en-US'))
}

type JsonRecord = Record<string, unknown>

export function isHealthyCommittedProfileObservation(
  observed: JsonRecord | null,
  targetProfileHash: string,
): boolean {
  return observed?.state != null
    && (observed.state as JsonRecord).stable != null
    && ((observed.state as JsonRecord).stable as JsonRecord).resolvedProfileHash === targetProfileHash
    && observed.server != null
    && (observed.server as JsonRecord).healthy === true
    && (observed.server as JsonRecord).activationId === null
    && (observed.server as JsonRecord).profile != null
    && ((observed.server as JsonRecord).profile as JsonRecord).resolvedProfileHash === targetProfileHash
}

export async function recoverUncertainProfileCommit(
  targetProfileHash: string,
  observe: () => Promise<JsonRecord | null>,
  restartStable: () => Promise<void>,
): Promise<JsonRecord | null> {
  const first = await observe()
  if (isHealthyCommittedProfileObservation(first, targetProfileHash)) return first
  await restartStable()
  const afterRestart = await observe()
  return isHealthyCommittedProfileObservation(afterRestart, targetProfileHash)
    ? afterRestart
    : null
}

type ReconcileProfileRendererCommitOptions = {
  expectedProfileHash: string
  stage: string
  success: JsonRecord
  allowRollback: boolean
  reloadAndVerify: (expectedProfileHash: string) => Promise<void>
  releaseAdmission: (expectedProfileHash: string) => Promise<void>
  rollbackPreviousStable: () => Promise<JsonRecord>
  recordFailureEvidence: (evidence: Readonly<{
    code: string
    stage: string
    message: string
    targetProfileHash: string
    rollbackTarget: 'previous-stable' | null
  }>) => Promise<void>
  recordRollbackEvidence: (evidence: Readonly<{
    code: string
    stage: string
    message: string
    targetProfileHash: string
    rollbackTarget: 'previous-stable'
    rollbackSucceeded: boolean
  }>) => Promise<void>
  enterFailClosed: () => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function enterProfileFailClosed(
  enterFailClosed: () => Promise<void>,
): Promise<string | null> {
  try {
    await enterFailClosed()
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

export async function reconcileProfileRendererCommit({
  expectedProfileHash,
  stage,
  success,
  allowRollback,
  reloadAndVerify,
  releaseAdmission,
  rollbackPreviousStable,
  recordFailureEvidence,
  recordRollbackEvidence,
  enterFailClosed,
}: ReconcileProfileRendererCommitOptions): Promise<JsonRecord> {
  try {
    await reloadAndVerify(expectedProfileHash)
    await releaseAdmission(expectedProfileHash)
    return { ok: true, ...success }
  } catch (rendererError) {
    const message = errorMessage(rendererError)
    const failure = {
      ok: false,
      error: message,
      code: 'PROFILE_RENDERER_RELOAD_FAILED',
      stage,
    }
    let failureEvidenceError: string | null = null
    try {
      await recordFailureEvidence({
        code: failure.code,
        stage,
        message,
        targetProfileHash: expectedProfileHash,
        rollbackTarget: allowRollback ? 'previous-stable' : null,
      })
    } catch (evidenceError) {
      failureEvidenceError = errorMessage(evidenceError)
    }
    if (!allowRollback) {
      const failClosedError = await enterProfileFailClosed(enterFailClosed)
      return {
        ...failure,
        failureEvidenceError,
        failClosedError,
        requiresApplicationRestart: true,
        admissionPaused: true,
        state: success.state,
      }
    }
    try {
      const rollback = await rollbackPreviousStable()
      const rollbackSucceeded = rollback.ok === true
      let rollbackEvidenceError: string | null = null
      try {
        await recordRollbackEvidence({
          code: 'PROFILE_RENDERER_ROLLBACK_RESULT',
          stage,
          message: rollbackSucceeded ? 'rollback completed' : 'rollback returned failure',
          targetProfileHash: expectedProfileHash,
          rollbackTarget: 'previous-stable',
          rollbackSucceeded,
        })
      } catch (evidenceError) {
        rollbackEvidenceError = errorMessage(evidenceError)
      }
      const failClosedError = rollbackSucceeded
        ? null
        : await enterProfileFailClosed(enterFailClosed)
      return {
        ...failure,
        failureEvidenceError,
        rollbackEvidenceError,
        rolledBack: rollbackSucceeded,
        rollback,
        ...(rollbackSucceeded ? {} : {
          failClosedError,
          requiresApplicationRestart: true,
          admissionPaused: true,
        }),
      }
    } catch (rollbackError) {
      const rollbackMessage = errorMessage(rollbackError)
      let rollbackEvidenceError: string | null = null
      try {
        await recordRollbackEvidence({
          code: 'PROFILE_RENDERER_ROLLBACK_RESULT',
          stage,
          message: rollbackMessage,
          targetProfileHash: expectedProfileHash,
          rollbackTarget: 'previous-stable',
          rollbackSucceeded: false,
        })
      } catch (evidenceError) {
        rollbackEvidenceError = errorMessage(evidenceError)
      }
      const failClosedError = await enterProfileFailClosed(enterFailClosed)
      return {
        ...failure,
        failureEvidenceError,
        rollbackEvidenceError,
        rolledBack: false,
        rollback: {
          ok: false,
          error: rollbackMessage,
        },
        failClosedError,
        requiresApplicationRestart: true,
        admissionPaused: true,
      }
    }
  }
}
