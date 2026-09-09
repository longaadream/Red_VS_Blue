import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { GithubContentRelease } from '../../electron-editor/github-content-release'

const contentHash = 'a'.repeat(64)
const asset = { name: 'content.rvbpack', bytes: new Uint8Array([1, 2, 3]) }
function fixture() {
  const calls: { url: string; method: string }[] = []
  let release: Record<string, unknown> | null = null
  let assets: Record<string, unknown>[] = []
  let failAfterUpload = false
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method || 'GET' })
    expect(init.redirect).toBe('error')
    expect(new URL(url).hostname).toMatch(/^(api|uploads)\.github\.com$/)
    if (url.includes('/releases?')) return respond(release ? [{ ...release, assets }] : [])
    if (url.endsWith('/releases') && init.method === 'POST') {
      release = { ...JSON.parse(String(init.body)), id: 11, html_url: 'https://github.com/owner/game/releases/tag/test' }
      return respond({ ...release, assets }, 201)
    }
    if (url.includes('/assets?')) {
      const bytes = init.body as Uint8Array
      const record = { name: new URL(url).searchParams.get('name'), size: bytes.byteLength, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), state: 'uploaded', browser_download_url: 'https://github.com/owner/game/releases/download/test/content.rvbpack' }
      assets.push(record)
      if (failAfterUpload) { failAfterUpload = false; throw new Error('response lost') }
      return respond(record, 201)
    }
    if (init.method === 'PATCH') release = { ...release, ...JSON.parse(String(init.body)) }
    return respond({ ...release, assets })
  }
  return { calls, client: new GithubContentRelease(fetcher, 'owner/game', 'test-secret'), loseUploadResponse: () => { failAfterUpload = true }, alterAsset: () => { assets = assets.map(value => ({ ...value, digest: 'sha256:' + '0'.repeat(64) })) } }
}

it('uploads to a draft, verifies bytes, and only then publishes; repeating does not upload or publish again', async () => {
  const { client, calls } = fixture()
  const input = { contentHash, notes: '测试改动', assets: [asset] }
  const result = await client.publish(input)
  expect(result.url).toContain('https://github.com/owner/game/releases/')
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(2)
  const publication = calls.findIndex(call => call.method === 'PATCH')
  expect(calls[publication - 1].method).toBe('GET')
  await client.publish(input)
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(2)
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1)
})

it('recovers after an uploaded response was lost without creating duplicate drafts or assets', async () => {
  const { client, calls, loseUploadResponse } = fixture()
  const input = { contentHash, notes: '测试改动', assets: [asset] }
  loseUploadResponse()
  await expect(client.publish(input)).rejects.toThrow('未确认完成')
  expect(calls.some(call => call.method === 'PATCH')).toBe(false)
  await client.publish(input)
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(2)
})

it('refuses changed remote bytes instead of replacing or deleting the published asset', async () => {
  const { client, calls, alterAsset } = fixture()
  const input = { contentHash, notes: '', assets: [asset] }
  await client.publish(input)
  alterAsset()
  await expect(client.publish(input)).rejects.toThrow('不会覆盖')
  expect(calls.some(call => call.method === 'DELETE')).toBe(false)
})

it.each(['https://evil.example/owner/game', '../evil', 'owner/game/extra', 'owner/..'])('rejects a non-repository target %s', repository => {
  expect(() => new GithubContentRelease(async () => new Response(), repository, 'secret')).toThrow()
})

it('rejects unsafe asset names before making any request', async () => {
  const { client, calls } = fixture()
  await expect(client.publish({ contentHash, notes: '', assets: [{ ...asset, name: '../secret' }] })).rejects.toThrow('名称')
  expect(calls).toHaveLength(0)
})
