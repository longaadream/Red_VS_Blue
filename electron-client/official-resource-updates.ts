import { createHash } from 'node:crypto'
import { COS_UPDATE_ROOT, resourceMirrorUrl, type UpdateSource } from './update-source'

export const OFFICIAL_REPOSITORY = 'longaadream/Red_VS_Blue'
const HASH = /^[a-f0-9]{64}$/
const MAX_PACK = 32 * 1024 * 1024
type Asset = { name: string; size: number; digest: string; state: string; browser_download_url: string }
type Release = { tag_name: string; draft: boolean; assets: Asset[]; published_at: string; rvb_version?: string }
type Identity = { engineAbi: string; contentAbi: string; publisherKeyId: string }
export type ResourceIndex = { schema: string; channel: string; version: string; contentHash: string; archive: string; archiveSha256: string; identity: Identity; minimumClientVersion?: string; patch?: { archive: string; sha256: string; parentProfileHash: string; resolvedProfileHash: string } }
export type ResourceUpdateStatus = { phase: 'idle' | 'checking' | 'downloading' | 'waiting' | 'applying' | 'current' | 'error'; message: string; version?: string; checkedAt?: string }
export type StableResource = { resolvedProfileHash: string; version: string; kind: string; compatibility: { engineAbi: string; contentAbi: string }; candidateHash?: string | null }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>
export type ResourceUpdateHooks = {
  stable: () => Promise<StableResource>
  canApply: () => Promise<boolean>
  apply: (archive: Buffer, index: ResourceIndex, expectedStableHash: string) => Promise<string>
  applied: (receipt: { contentHash: string; profileHash: string; version: string }) => void
  changed?: (status: ResourceUpdateStatus) => void
}
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('更新版本格式无效')
    const parts = value.split('.').map(Number)
    if (parts.some(n => !Number.isSafeInteger(n))) throw new Error('更新版本超出范围')
    return parts
  }
  const a = parse(left), b = parse(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function isAssetUrl(raw: string, tag: string, name: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === `/${OFFICIAL_REPOSITORY}/releases/download/${tag}/${name}`
  } catch { return false }
}
export class OfficialResourceUpdates {
  status: ResourceUpdateStatus = { phase: 'idle', message: '启动后检查官方测试资源更新' }
  private running?: Promise<ResourceUpdateStatus>
  private pending?: { release: Release; index: ResourceIndex; bytes: Buffer; parent: string; patch: boolean }
  private generation = 0
  private activeReads = new Set<AbortController>()
  constructor(private fetcher: Fetcher, private clientVersion: string, private publishers: readonly string[], private hooks: ResourceUpdateHooks, private source: UpdateSource = 'github') {}
  isBusy() { return Boolean(this.running) || ['checking', 'downloading', 'applying'].includes(this.status.phase) }
  setSource(source: UpdateSource) {
    if (['downloading', 'applying'].includes(this.status.phase)) throw new Error('资源正在下载或应用，请稍后切换源')
    this.generation += 1
    this.activeReads.forEach(controller => controller.abort())
    this.activeReads.clear()
    this.running = undefined
    this.source = source
    this.pending = undefined
    this.set('idle', '更新源已切换，请检查更新')
  }
  private set(phase: ResourceUpdateStatus['phase'], message: string, version?: string) {
    this.status = { phase, message, checkedAt: new Date().toISOString(), ...(version ? { version } : {}) }
    this.hooks.changed?.(this.status)
  }
  private async read(url: string, max: number, asset = false): Promise<Buffer> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000)
    this.activeReads.add(controller)
    try {
      for (let redirects = 0; redirects < 4; redirects++) {
        const response = await this.fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache', 'X-GitHub-Api-Version': '2022-11-28' } })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = new URL(response.headers.get('location') || '', url)
          await response.body?.cancel()
          if (!asset || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) || next.protocol !== 'https:' || next.port || next.username || next.password) throw new Error('更新下载地址不属于官方分发站点')
          url = next.href; continue
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`官方更新请求失败（HTTP ${response.status}），当前版本继续可用`) }
        const declared = Number(response.headers.get('content-length') || 0)
        if (declared > max || !response.body) { await response.body?.cancel(); throw new Error('更新文件超出大小限制') }
        const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0
        try {
          while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) { await reader.cancel(); throw new Error('更新文件超出大小限制') }; chunks.push(Buffer.from(part.value)) }
        } finally { reader.releaseLock() }
        return Buffer.concat(chunks)
      }
      throw new Error('更新下载重定向过多')
    } finally { clearTimeout(timer); this.activeReads.delete(controller) }
  }
  private async asset(release: Release, name: string, hash: string | undefined, max: number) {
    const matching = release.assets.filter(a => a.name === name)
    const asset = matching[0]
    if (matching.length !== 1 || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > max || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !isAssetUrl(asset.browser_download_url, release.tag_name, name)) throw new Error('官方资源文件缺失或身份无效')
    if (hash && asset.digest !== `sha256:${hash}`) throw new Error('清单与官方文件摘要不一致')
    const url = this.source === 'cos' ? resourceMirrorUrl(release.rvb_version || '', name) : asset.browser_download_url
    const bytes = await this.read(url, max, this.source === 'github')
    if (bytes.length !== asset.size || `sha256:${sha(bytes)}` !== asset.digest) throw new Error('更新文件完整性校验失败，已保留旧版本')
    return bytes
  }
  async discover(): Promise<{ release: Release; index: ResourceIndex } | null> {
    const releases: Release[] = []
    for (let page = 1; page <= 3; page++) {
      const url = this.source === 'cos' ? `${COS_UPDATE_ROOT}/resource/latest.json` : `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases?per_page=100&page=${page}`
      const values = JSON.parse((await this.read(url, 2 * 1024 * 1024)).toString()) as Release[]
      if (!Array.isArray(values)) throw new Error('官方版本列表格式无效')
      releases.push(...values.filter(r => r.draft === false && /^content-test-[a-f0-9]{64}$/.test(r.tag_name) && Array.isArray(r.assets)))
      if (this.source === 'cos') {
        if (!releases.length || releases.length > 100) throw new Error('COS 资源版本清单为空或无效')
        break
      }
      if (values.length < 100) break
      if (page === 3) throw new Error('官方版本列表过长，未能确认最新资源')
    }
    // Resource versions are independent of client release ordering and /releases/latest.
    releases.sort((a, b) => b.published_at.localeCompare(a.published_at))
    let latest: { release: Release; index: ResourceIndex } | null = null
    let invalid: unknown = null
    for (const release of releases.slice(0, 10)) {
      try {
      const index = JSON.parse((await this.asset(release, 'content-update.json', undefined, 64 * 1024)).toString()) as ResourceIndex
      if (index.schema !== 'rvb-content-release/v1' || index.channel !== 'test' || !HASH.test(index.contentHash) || release.tag_name !== `content-test-${index.contentHash}` || index.archive !== 'content.rvbpack' || !HASH.test(index.archiveSha256) || !this.publishers.includes(index.identity?.publisherKeyId)) throw new Error('官方资源清单或签名发行者不受信任')
      compareVersions(index.version, index.version)
      if (this.source === 'cos' && index.version !== release.rvb_version) throw new Error('COS 资源目录与清单版本不一致')
      if (index.minimumClientVersion) compareVersions(index.minimumClientVersion, index.minimumClientVersion)
      if (index.patch && (index.patch.archive !== 'content-patch.rvbpack' || !HASH.test(index.patch.sha256) || !HASH.test(index.patch.parentProfileHash) || !HASH.test(index.patch.resolvedProfileHash))) throw new Error('资源补丁清单无效')
      if (!latest || compareVersions(index.version, latest.index.version) > 0) latest = { release, index }
      } catch (error) { invalid = error }
    }
    if (!latest && invalid) throw invalid
    return latest
  }
  check(): Promise<ResourceUpdateStatus> {
    if (this.running) return this.running
    const generation = this.generation
    const running = this.run(generation).catch(error => {
      if (generation === this.generation) this.set('error', error instanceof Error ? error.message : String(error))
      return this.status
    }).finally(() => {
      if (this.running === running) this.running = undefined
      if (generation === this.generation) this.hooks.changed?.(this.status)
    })
    this.running = running
    return running
  }
  applyPending(): Promise<ResourceUpdateStatus> {
    return this.pending ? this.check() : Promise.resolve(this.status)
  }
  private async run(generation = this.generation) {
    this.set('checking', '正在检查官方测试资源')
    const stable = await this.hooks.stable()
    if (generation !== this.generation) return this.status
    const discovered = this.pending ?? await this.discover()
    if (generation !== this.generation) return this.status
    if (!discovered) { this.set('current', '暂无官方测试资源更新'); return this.status }
    const { release, index } = discovered
    if (compareVersions(index.version, stable.version) <= 0) { this.pending = undefined; this.set('current', '资源已是当前版本', stable.version); return this.status }
    if (index.minimumClientVersion && compareVersions(this.clientVersion, index.minimumClientVersion) < 0 || index.identity.engineAbi !== stable.compatibility.engineAbi || index.identity.contentAbi !== stable.compatibility.contentAbi) { this.pending = undefined; this.set('waiting', '此资源需要先更新客户端'); return this.status }
    if (stable.candidateHash && stable.candidateHash !== stable.resolvedProfileHash) { this.set('waiting', '已有手动导入的候选资源，请先在资源管理中处理'); return this.status }
    const usePatch = Boolean(index.patch && index.patch.parentProfileHash === stable.resolvedProfileHash)
    if (!this.pending || this.pending.parent !== stable.resolvedProfileHash) {
      this.set('downloading', usePatch ? '正在下载资源补丁' : '正在下载完整资源包', index.version)
      let bytes: Buffer, patch = usePatch
      try { bytes = await this.asset(release, usePatch ? index.patch!.archive : index.archive, usePatch ? index.patch!.sha256 : index.archiveSha256, MAX_PACK) }
      catch (error) { if (!usePatch) throw error; patch = false; bytes = await this.asset(release, index.archive, index.archiveSha256, MAX_PACK) }
      if (generation !== this.generation) return this.status
      this.pending = { release, index, bytes, parent: stable.resolvedProfileHash, patch }
    }
    const pending = this.pending
    if (!pending) return this.status
    const canApply = await this.hooks.canApply()
    if (generation !== this.generation) return this.status
    if (!canApply) { this.set('waiting', '资源已下载，返回主菜单并退出房间后应用', index.version); return this.status }
    this.set('applying', '正在校验签名并应用资源更新', index.version)
    const profileHash = await this.hooks.apply(pending.bytes, index, pending.parent)
    if (generation !== this.generation) return this.status
    this.pending = undefined
    this.hooks.applied({ contentHash: index.contentHash, profileHash, version: index.version })
    this.set('current', '官方资源更新已应用', index.version)
    return this.status
  }
}
