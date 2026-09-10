import fs from 'node:fs'
import path from 'node:path'
import type { DesktopProfileReference } from './resource-pack-store'
import { compareVersions } from './official-resource-updates'

export function resolvedResourceVersion(profile: { base: { version: string }; patches: { version: string }[] }): string {
  const version = profile.patches.length ? profile.patches[profile.patches.length - 1].version : profile.base.version
  compareVersions(version, version)
  return version
}
export function installedResourceVersion(root: string, reference: DesktopProfileReference): string {
  if (reference.kind !== 'installed') return reference.version
  if (!/^[a-f0-9]{64}$/.test(reference.resolvedProfileHash)) throw new Error('资源身份无效')
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'profiles', reference.resolvedProfileHash, '.rvb/profile.json'), 'utf8'))
  if (profile.resolvedProfileHash !== reference.resolvedProfileHash) throw new Error('资源版本记录不匹配')
  return resolvedResourceVersion(profile)
}
