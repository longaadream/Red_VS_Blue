// Replaces lib/game/file-loader.ts in the mobile server bundle.
// All data comes from the fs-shim (backed by __GAME_DATA__ injected at build time).

import { readdirSync, readFileSync, existsSync } from './fs-shim'
import { join } from './path-shim'
import { getDataRoot } from './app-paths-shim'

export function loadJsonFilesServer<T>(directory: string): Record<string, T> {
  const result: Record<string, T> = {}
  const subDir = directory.replace(/^data[\\/]/, '').replace(/\\/g, '/')
  const dirPath = join(getDataRoot(), subDir)
  if (!existsSync(dirPath)) return result

  const files = readdirSync(dirPath) as string[]
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const content = readFileSync(join(dirPath, file), 'utf-8')
      const data = JSON.parse(content) as T
      if (data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
        result[(data as { id: string }).id] = data
      }
    } catch {}
  }
  return result
}

export async function loadJsonFiles<T>(endpoint: string): Promise<Record<string, T>> {
  return loadJsonFilesServer<T>('data/' + endpoint)
}
