import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getAppRoot, getUserDataDir } from './app-paths'

const PACK_DATA_DIR = path.join(getUserDataDir(), 'resource-pack', 'data')

let loaded = false

function calcHash(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function getResourcePackDataDir(): string | null {
  if (!fs.existsSync(PACK_DATA_DIR)) {
    return null
  }
  return PACK_DATA_DIR
}

export function getResourcePackMeta(): { version: string; name: string; importedAt: string; md5: string } | null {
  const metaPath = path.join(path.dirname(PACK_DATA_DIR), 'pack.json')
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
  const destDir = path.dirname(PACK_DATA_DIR)
  const destPack = path.join(destDir, 'resource-pack.zip')

  if (!fs.existsSync(sourcePack)) {
    return { success: false, message: '资源包文件不存在，请先构建资源包 (npm run build:pack)' }
  }

  try {
    fs.mkdirSync(destDir, { recursive: true })

    const AdmZip = require('adm-zip')
    const zip = new AdmZip(sourcePack)

    if (fs.existsSync(PACK_DATA_DIR)) {
      fs.rmSync(PACK_DATA_DIR, { recursive: true, force: true })
    }

    zip.extractAllTo(destDir, true)

    const packMd5 = calcHash(sourcePack)

    const metaPath = path.join(destDir, 'pack.json')
    let meta = {}
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) } catch {}
    }
    meta = { ...meta, md5: packMd5, importedAt: new Date().toISOString() }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

    loaded = false

    return {
      success: true,
      message: '资源包同步成功',
      meta
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
