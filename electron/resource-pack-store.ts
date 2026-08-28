import fs from 'node:fs'
import path from 'node:path'

export interface ServerProfileReference {
  readonly kind: 'bundled-base' | 'installed'
  readonly resolvedProfileHash: string
  readonly authorityContentHash: string
  readonly compatibility: Readonly<{ engineAbi: string; contentAbi: string }>
  readonly capabilities: readonly string[]
}

export interface ServerProfileState {
  readonly schemaVersion: 'rvb-profile-state/v1'
  readonly stable: ServerProfileReference
  readonly candidate: ServerProfileReference | null
  readonly previousStable: ServerProfileReference | null
  readonly lastFailure: unknown
}

type JsonRecord = Record<string, unknown>

export function isHealthyCommittedServerObservation(
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

export async function recoverUncertainServerCommit(
  targetProfileHash: string,
  observe: () => Promise<JsonRecord | null>,
  restartStable: () => Promise<void>,
): Promise<JsonRecord | null> {
  const first = await observe()
  if (isHealthyCommittedServerObservation(first, targetProfileHash)) return first
  await restartStable()
  const afterRestart = await observe()
  return isHealthyCommittedServerObservation(afterRestart, targetProfileHash)
    ? afterRestart
    : null
}

export function readServerProfileState(packRoot: string): ServerProfileState | null {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(packRoot, 'active.json'), 'utf8')) as ServerProfileState
    if (
      state.schemaVersion !== 'rvb-profile-state/v1'
      || !state.stable
      || !/^[0-9a-f]{64}$/.test(state.stable.resolvedProfileHash)
      || !/^[0-9a-f]{64}$/.test(state.stable.authorityContentHash)
    ) return null
    return state
  } catch {
    return null
  }
}

export function resolveServerProfileRoot(
  packRoot: string,
  reference: ServerProfileReference,
): string | null {
  if (reference.kind === 'bundled-base') return null
  const root = path.join(packRoot, 'profiles', reference.resolvedProfileHash)
  if (
    !fs.existsSync(path.join(root, '.rvb', 'profile.json'))
    || !fs.existsSync(path.join(root, 'data'))
  ) {
    throw new Error(`PROFILE_SNAPSHOT_INCOMPLETE: ${reference.resolvedProfileHash}`)
  }
  return root
}
