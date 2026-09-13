export type UpdateSource = 'github' | 'cos'
export const COS_UPDATE_ROOT = 'https://rvb-updates-hk-1321590994.cos.ap-hongkong.myqcloud.com'

export function parseUpdateSource(value: unknown): UpdateSource {
  if (value !== 'github' && value !== 'cos') throw new Error('更新源无效')
  return value
}

export function readUpdateSettings(value: unknown): { automatic: boolean; source: UpdateSource } {
  const settings = value as { automatic?: unknown; source?: unknown } | null
  return { automatic: settings?.automatic !== false, source: settings?.source === 'cos' ? 'cos' : 'github' }
}

export function binaryFeed(source: UpdateSource) {
  return source === 'cos'
    ? { provider: 'generic' as const, url: COS_UPDATE_ROOT + '/', useMultipleRangeRequest: false }
    : { provider: 'github' as const, owner: 'longaadream', repo: 'Red_VS_Blue', private: false }
}

export function resourceMirrorUrl(version: string, name: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['content-update.json', 'content.rvbpack', 'content-patch.rvbpack'].includes(name)) throw new Error('资源镜像路径无效')
  return `${COS_UPDATE_ROOT}/resource/${version}/${name}`
}
