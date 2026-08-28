import fs from 'node:fs'
import path from 'node:path'

/** Root of the immutable application bundle. */
export function getAppRoot(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.APP_ROOT_DIR ?? process.cwd())
}

/** Writable runtime state root supplied by Electron or the host. */
export function getUserDataDir(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.USER_DATA_DIR ?? process.cwd())
}

function installedStableRoot(): string | null {
  const profileStoreRoot = path.join(getUserDataDir(), 'resource-pack')
  const pointerPath = path.join(profileStoreRoot, 'active.json')
  if (!fs.existsSync(pointerPath)) return null
  let state: unknown
  try {
    state = JSON.parse(fs.readFileSync(pointerPath, 'utf8'))
  } catch {
    return null
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  const candidate = state as {
    schemaVersion?: unknown
    stable?: { kind?: unknown; resolvedProfileHash?: unknown }
  }
  // Legacy/invalid pointers are never interpreted as active v1 content.
  if (candidate.schemaVersion !== 'rvb-profile-state/v1') return null
  if (candidate.stable?.kind === 'bundled-base') return null
  if (
    candidate.stable?.kind !== 'installed'
    || typeof candidate.stable.resolvedProfileHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate.stable.resolvedProfileHash)
  ) throw new Error('PROFILE_STATE_INVALID: invalid installed stable pointer')
  const root = path.join(
    profileStoreRoot,
    'profiles',
    candidate.stable.resolvedProfileHash,
  )
  const metadataPath = path.join(root, '.rvb', 'profile.json')
  const dataPath = path.join(root, 'data')
  if (!fs.existsSync(metadataPath) || !fs.existsSync(dataPath)) {
    throw new Error(
      `PROFILE_SNAPSHOT_INCOMPLETE: ${candidate.stable.resolvedProfileHash}`,
    )
  }
  return root
}

/**
 * Data root is selected once per process from an explicit candidate/stable
 * Profile. Installed Profile failures never fall through to bundled files.
 */
export function getDataRoot(): string {
  if (process.env.RVB_PROFILE_ROOT) {
    const root = path.resolve(process.env.RVB_PROFILE_ROOT)
    const data = path.join(root, 'data')
    if (!fs.existsSync(data)) {
      throw new Error(`PROFILE_SNAPSHOT_INCOMPLETE: ${data}`)
    }
    return data
  }
  const installed = installedStableRoot()
  return installed ? path.join(installed, 'data') : path.join(getAppRoot(), 'data')
}
