import fs from 'fs'
import path from 'path'
import { getAppRoot, getUserDataDir } from './app-paths'
import { RESOURCE_PACK_LIMITS, importResourcePackArchive } from '../electron/resource-pack-store'

const PACK_ROOT = path.join(getUserDataDir(), 'resource-pack')
const LEGACY_PACK_DATA_DIR = path.join(PACK_ROOT, 'data')

let loaded = false
let warnedInvalidPack = false

function getMissingRequiredFiles(dataDir: string): string[] {
  const required = [
    path.join('pieces', 'manifest.json'),
    path.join('skills', 'manifest.json'),
    path.join('cards', 'manifest.json'),
    path.join('effects', 'effect-lucky-coin.json'),
    path.join('cards', 'lucky-coin.json'),
    path.join('skills', 'basic-attack.json'),
  ]
  return required.filter(rel => !fs.existsSync(path.join(dataDir, rel)))
}

function getActiveVersionRoot(): string | null {
  const pointerPath = path.join(PACK_ROOT, 'active.json')
  if (!fs.existsSync(pointerPath)) {
    return fs.existsSync(LEGACY_PACK_DATA_DIR) ? PACK_ROOT : null
  }
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as { version?: unknown }
    if (pointer.version === null) return null
    if (typeof pointer.version !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.version)) return null
    const versionRoot = path.join(PACK_ROOT, 'versions', pointer.version)
    return fs.existsSync(versionRoot) && fs.statSync(versionRoot).isDirectory() ? versionRoot : null
  } catch {
    return null
  }
}

export function getResourcePackDataDir(): string | null {
  const versionRoot = getActiveVersionRoot()
  if (!versionRoot) return null
  const dataDir = path.join(versionRoot, 'data')
  if (!fs.existsSync(dataDir)) return null
  const missing = getMissingRequiredFiles(dataDir)
  if (missing.length > 0) {
    if (!warnedInvalidPack) {
      warnedInvalidPack = true
      console.warn('[resource-pack] Ignoring incomplete resource pack:', dataDir, 'missing:', missing.join(', '))
    }
    return null
  }
  return dataDir
}

export function getResourcePackMeta(): { version: string; name: string; importedAt: string; sha256?: string; md5?: string } | null {
  const versionRoot = getActiveVersionRoot()
  if (!versionRoot) return null
  const metaPath = path.join(versionRoot, 'pack.json')
  if (!fs.existsSync(metaPath)) {
    return null
  }
  try {
    const content = fs.readFileSync(metaPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

export async function syncResourcePack(): Promise<{ success: boolean; message: string; meta?: any }> {
  const sourcePack = path.join(getAppRoot(), 'dist', 'resource-pack.zip')

  if (!fs.existsSync(sourcePack)) {
    return { success: false, message: '资源包文件不存在，请先构建资源包 (npm run build:pack)' }
  }

  try {
    const stat = fs.statSync(sourcePack)
    if (!stat.isFile() || stat.size <= 0 || stat.size > RESOURCE_PACK_LIMITS.maxArchiveBytes) {
      throw new Error('资源包压缩文件为空或超过 32 MiB 限制')
    }
    const result = importResourcePackArchive(PACK_ROOT, fs.readFileSync(sourcePack))

    loaded = false
    warnedInvalidPack = false

    return {
      success: true,
      message: '资源包同步成功',
      meta: result.meta,
    }
  } catch (error) {
    console.error('[resource-pack] Sync error:', error)
    return { success: false, message: `同步失败: ${error}` }
  }
}

export function ensureResourcePackLoaded() {
  if (loaded) return
  loaded = true

  const packDataDir = getResourcePackDataDir()
  if (packDataDir) {
    console.log('[resource-pack] Using packed data from:', packDataDir)
  }
}
