import { createHash } from 'node:crypto'

export type ReleaseAsset = { name: string; bytes: Uint8Array }
type AssetRecord = { name: string; size: number; digest?: string; state: string; browser_download_url: string }
type ReleaseRecord = { id: number; tag_name: string; draft: boolean; body: string; html_url: string; assets: AssetRecord[] }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>
const digest = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

/** Only Github's fixed API/upload origins receive credentials. No remote redirect is followed. */
export class GithubContentRelease {
  constructor(private fetcher: Fetcher, private repository: string, private token: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) throw new Error('请填写 GitHub 仓库：所有者/仓库名')
    if (!token || /[\r\n]/.test(token)) throw new Error('请先配置 GitHub 上传凭据')
  }
  private async request(path: string, method = 'GET', body?: unknown, upload?: Uint8Array): Promise<Response> {
    const origin = upload ? 'https://uploads.github.com' : 'https://api.github.com'
    let response: Response
    try {
      response = await this.fetcher(origin + `/repos/${this.repository}` + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': upload ? 'application/octet-stream' : 'application/json' },
        body: upload ? new Uint8Array(upload) : body === undefined ? undefined : JSON.stringify(body),
      })
    } catch { throw new Error('GitHub 网络请求未确认完成。保留本地版本，再次发布时会先核对远端草稿；不会覆盖已有文件。') }
    if (!response.ok && response.status !== 404) throw new Error(`GitHub 返回 ${response.status}；请检查仓库权限、连接或配额。已上传的草稿和本地内容保留。`)
    return response
  }
  private async existing(tag: string): Promise<ReleaseRecord | null> {
    // Drafts must be found through the authenticated list, not only /tags (which may omit them).
    for (let page = 1; page <= 10; page++) {
      const response = await this.request(`/releases?per_page=100&page=${page}`)
      if (!response.ok) throw new Error('仓库不存在或当前凭据没有访问权限')
      const values = await response.json() as ReleaseRecord[]
      if (!Array.isArray(values)) throw new Error('GitHub 返回了无效的发布列表')
      const found = values.find(value => value.tag_name === tag)
      if (found) return found
      if (values.length < 100) return null
    }
    throw new Error('发布记录较多，自动检索已停止；请核对仓库中的对应版本，避免重复创建')
  }
  async publish(input: { contentHash: string; notes: string; assets: ReleaseAsset[] }, progress: (stage: string) => void = () => {}) {
    if (!/^[a-f0-9]{64}$/.test(input.contentHash) || typeof input.notes !== 'string' || input.notes.length > 4000) throw new Error('发布内容身份或说明无效')
    if (!input.assets.length || new Set(input.assets.map(asset => asset.name)).size !== input.assets.length) throw new Error('发布文件不能为空或重名')
    const assets = input.assets.map(asset => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(asset.name) || !asset.bytes.length || asset.bytes.length > 32 * 1024 * 1024) throw new Error('发布文件名称或大小不符合资源包限制')
      return { name: asset.name, bytes: new Uint8Array(asset.bytes) }
    })
    const tag = `content-test-${input.contentHash}`
    const marker = `<!-- rvb-content:${input.contentHash} -->`
    progress('核对远端发布记录')
    let release = await this.existing(tag)
    if (!release) {
      const created = await this.request('/releases', 'POST', { tag_name: tag, name: '资源测试更新', body: `${input.notes}\n\n${marker}`, draft: true, prerelease: true, make_latest: 'false' })
      if (!created.ok) throw new Error('未能创建发布草稿')
      release = await created.json() as ReleaseRecord
    }
    if (!Number.isSafeInteger(release.id) || release.tag_name !== tag || !release.body?.includes(marker)) throw new Error('远端版本身份不符，已停止；不会修改这个 Release')
    for (const asset of assets) {
      const found = release.assets.find(value => value.name === asset.name)
      if (found) {
        if (found.size !== asset.bytes.length || found.digest !== digest(asset.bytes) || found.state !== 'uploaded') throw new Error(`远端文件 ${asset.name} 与本地内容不一致或未完成；不会覆盖，请检查草稿`)
      } else {
        if (!release.draft) throw new Error('已发布版本缺少所需文件，拒绝向已发布版本补写内容')
        progress('上传 ' + asset.name)
        const response = await this.request(`/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, 'POST', undefined, asset.bytes)
        if (!response.ok) throw new Error('上传失败：' + asset.name)
        const uploaded = await response.json() as AssetRecord
        if (uploaded.name !== asset.name || uploaded.size !== asset.bytes.length || uploaded.digest !== digest(asset.bytes) || uploaded.state !== 'uploaded') throw new Error('上传校验未通过：' + asset.name)
      }
    }
    const verifiedResponse = await this.request(`/releases/${release.id}`)
    if (!verifiedResponse.ok) throw new Error('无法核对远端草稿')
    const verified = await verifiedResponse.json() as ReleaseRecord
    if (verified.assets.length !== assets.length || assets.some(asset => !verified.assets.some(found => found.name === asset.name && found.size === asset.bytes.length && found.digest === digest(asset.bytes) && found.state === 'uploaded'))) throw new Error('远端文件集合不符合本次快照，发布已停止')
    if (verified.draft) {
      progress('发布测试更新')
      const response = await this.request(`/releases/${release.id}`, 'PATCH', { draft: false, prerelease: true, make_latest: 'false' })
      if (!response.ok) throw new Error('发布结果未知，请重试以核对远端状态')
    }
    const finalResponse = await this.request(`/releases/${release.id}`)
    if (!finalResponse.ok) throw new Error('无法确认发布结果，请重试以核对')
    const final = await finalResponse.json() as ReleaseRecord
    if (final.draft || final.tag_name !== tag || !final.html_url?.startsWith(`https://github.com/${this.repository}/releases/`)) throw new Error('发布结果尚未确认')
    return { url: final.html_url, tag, contentHash: input.contentHash, assets: final.assets.map(asset => ({ name: asset.name, url: asset.browser_download_url })) }
  }
}
