import fs from 'node:fs'
import path from 'node:path'

import { installProfileArchiveV1 } from './content-pipeline/runtime/profile-archive'
import { getProfileRuntimeContextV1, logProfileEventV1 } from './content-pipeline/runtime/profile-runtime'
import { getAppRoot } from './app-paths'

export function getResourcePackDataDir(): string | null {
  const context = getProfileRuntimeContextV1()
  const stable = context.store.readState().stable
  const root = context.store.profileRoot(stable)
  return root ? path.join(root, 'data') : null
}

export function getResourcePackMeta() {
  return getProfileRuntimeContextV1().store.readState().stable
}

/**
 * Legacy build sync now performs v1 install only. It never activates the
 * candidate or mutates the stable pointer.
 */
export async function syncResourcePack(): Promise<{
  success: boolean
  message: string
  meta?: unknown
}> {
  const sourcePack = path.join(getAppRoot(), 'dist', 'resource-pack.zip')
  if (!fs.existsSync(sourcePack)) {
    return { success: false, message: '资源包文件不存在，请先构建 v1 Profile 包' }
  }
  try {
    const context = getProfileRuntimeContextV1()
    const installed = installProfileArchiveV1({
      store: context.store,
      appRoot: context.appRoot,
      archive: new Uint8Array(fs.readFileSync(sourcePack)),
      allowLocalDevUnsigned: process.env.NODE_ENV !== 'production',
    })
    logProfileEventV1('legacy-sync-installed-candidate', {
      resolvedProfileHash: installed.reference.resolvedProfileHash,
    })
    return {
      success: true,
      message: 'Profile 已安装为候选，尚未激活',
      meta: installed.reference,
    }
  } catch (error) {
    return {
      success: false,
      message: `Profile 安装失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function ensureResourcePackLoaded(): void {
  const stable = getProfileRuntimeContextV1().store.readState().stable
  logProfileEventV1('stable-selected', {
    resolvedProfileHash: stable.resolvedProfileHash,
    authorityContentHash: stable.authorityContentHash,
    kind: stable.kind,
  })
}
