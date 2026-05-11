/**
 * Centralized app path resolution.
 *
 * Dev mode  : falls back to process.cwd() (existing behaviour, no change).
 * Electron  : Electron main process injects APP_ROOT_DIR and USER_DATA_DIR
 *             via the child-process env before starting the Next.js server.
 * Railway   : APP_ROOT_DIR = /app (auto), USER_DATA_DIR not needed.
 */
import { getResourcePackDataDir, ensureResourcePackLoaded } from './resource-pack'

/**
 * Root of the application bundle (where data/, public/, .next/ live).
 * Replace all `process.cwd()` calls for reading game assets with this.
 */
export function getAppRoot(): string {
  return process.env.APP_ROOT_DIR ?? process.cwd()
}

/**
 * Writable user-data directory (logs, SQLite file, etc.).
 * Replace all `process.cwd()` calls for writing runtime files with this.
 */
export function getUserDataDir(): string {
  return process.env.USER_DATA_DIR ?? process.cwd()
}

/**
 * Root of the game data directory (pieces/, skills/, rules/, maps/, cards/).
 *
 * Priority:
 * 1. RESOURCE_PACK_DATA_DIR env (Electron with imported pack)
 * 2. Synced resource pack in user-data (server with imported pack)
 * 3. APP_ROOT_DIR/data (bundled data)
 * 4. cwd/data (dev mode fallback)
 */
export function getDataRoot(): string {
  if (process.env.RESOURCE_PACK_DATA_DIR) {
    return process.env.RESOURCE_PACK_DATA_DIR
  }

  ensureResourcePackLoaded()
  const packDataDir = getResourcePackDataDir()
  if (packDataDir) {
    return packDataDir
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path') as typeof import('path')
  return join(getAppRoot(), 'data')
}
