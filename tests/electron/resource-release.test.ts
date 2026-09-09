import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { CreativeWorkbench } from '../../electron-editor/workbench'
import { ResourceRelease } from '../../electron-editor/resource-release'
import { runContentPipelineOperationV1 } from '../../lib/content-pipeline/tooling'
import { readProfileArchiveV1 } from '../../lib/content-pipeline/runtime/profile-archive'
import { resolveProfileV1 } from '../../lib/content-pipeline/core/resolver'
import { contentPolicyForChannelV1 } from '../../lib/content-pipeline/tooling/archive'
import type { ContentPipelineOperationV1 } from '../../lib/content-pipeline/tooling/contracts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-release-coordinator-')); roots.push(root)
  const workspace = path.join(root, 'content'), privateRoot = path.join(root, 'private')
  for (const collection of ['pieces', 'skills', 'cards', 'rules']) { mkdirSync(path.join(workspace, 'data', collection), { recursive: true }); writeFileSync(path.join(workspace, 'data', collection, 'manifest.json'), '[]') }
  mkdirSync(path.join(workspace, 'data/maps'))
  const data = path.join(workspace, 'data/maps/fixture.json')
  writeFileSync(data, '{"name":"fixture","value":1}')
  const workbench = new CreativeWorkbench(workspace, root)
  const task = workbench.create({ title: '修改地图', brief: '数值修改', criteria: '固定接受版本' })
  writeFileSync(data, '{"name":"fixture","value":2}')
  const state = workbench.inspect(task.task.id)
  const accepted = workbench.accept(task.task.id, { paths: ['data/maps/fixture.json'], expectedHash: state.contentHash, expectedAcceptedHash: state.acceptedHash })
  return { root, workspace, privateRoot, data, accepted, task: task.task.id, service: new ResourceRelease(workspace, root, privateRoot, request => runContentPipelineOperationV1(request as ContentPipelineOperationV1)) }
}

it('builds and validates a real rvbpack from accepted bytes, leaving later drafts out', async () => {
  const { service, task, accepted, data, workspace } = fixture()
  writeFileSync(data, '{"name":"fixture","value":99}')
  const output = await service.export(task, accepted.acceptedHash, '详'.repeat(999) + '😀' + '细'.repeat(1999))
  expect(output.published).toBe(false)
  expect(output.signed).toBe(false)
  expect(output.path.startsWith(workspace)).toBe(false)
  const archive = readProfileArchiveV1(readFileSync(output.path))
  expect(JSON.parse(Buffer.from(archive.manifestBytes).toString('utf8')).description).toBe('详'.repeat(999))
  const changed = archive.entries.find(entry => entry.path === 'data/maps/fixture.json')
  expect(JSON.parse(Buffer.from(changed!.bytes).toString('utf8')).value).toBe(2)
  expect(JSON.parse(readFileSync(data, 'utf8')).value).toBe(99)
})

it('fails closed for unsupported executable content and does not make a Github request', async () => {
  const { workspace, root, data } = fixture()
  const store = new CreativeWorkbench(workspace, root)
  const task = store.list()[0].id
  writeFileSync(data, '{"name":"fixture","code":"return 1"}')
  const current = store.inspect(task)
  const accepted = store.accept(task, { paths: ['data/maps/fixture.json'], expectedHash: current.contentHash, expectedAcceptedHash: current.acceptedHash })
  const service = new ResourceRelease(workspace, root, path.join(root, 'private'), request => runContentPipelineOperationV1(request as ContentPipelineOperationV1))
  await expect(service.export(task, accepted.acceptedHash, '')).rejects.toThrow('PACK_FORBIDDEN_EXECUTABLE_CONTENT')
})

it('signs real snapshots and generates an automatically resolved patch on the next publication', async () => {
  const { service, task, accepted, root, workspace, privateRoot, data } = fixture()
  const keyFile = path.join(root, 'publisher.key')
  writeFileSync(keyFile, '1'.repeat(64))
  const releases: { id: number; tag_name: string; body: string; draft: boolean; html_url: string; assets: { name: string; size: number; digest: string; state: string; browser_download_url: string }[] }[] = []
  const uploaded = new Map<string, Uint8Array>()
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
  let checkedConcurrentPublisher = false
  const fetcher = async (url: string, init: RequestInit) => {
    if (!checkedConcurrentPublisher) {
      checkedConcurrentPublisher = true
      const another = new ResourceRelease(workspace, root, privateRoot, () => { throw new Error('second publisher must not run worker') })
      await expect(another.publish(task, accepted.acceptedHash, '并发发布', { repository: 'OWNER/GAME', token: 'fixture-only', keyFile }, () => { throw new Error('second publisher must not upload') }, () => {})).rejects.toThrow('另一个编辑器正在发布')
    }
    if (url.includes('/releases?')) return response(releases)
    if (url.endsWith('/releases') && init.method === 'POST') {
      const release = { ...JSON.parse(String(init.body)), id: releases.length + 1, html_url: 'https://github.com/owner/game/releases/tag/test-' + releases.length, assets: [] }
      releases.push(release); return response(release, 201)
    }
    const id = Number(/\/releases\/(\d+)/.exec(url)?.[1]), release = releases.find(value => value.id === id)!
    if (url.includes('/assets?')) {
      const bytes = new Uint8Array(init.body as Uint8Array), name = new URL(url).searchParams.get('name')!
      const asset = { name, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), state: 'uploaded', browser_download_url: 'https://github.com/owner/game/releases/download/test/' + name }
      release.assets.push(asset); uploaded.set(`${id}/${name}`, bytes); return response(asset, 201)
    }
    if (init.method === 'PATCH') Object.assign(release, JSON.parse(String(init.body)))
    return response(release)
  }
  const settings = { repository: 'owner/game', token: 'fixture-only', keyFile }
  const first = await service.publish(task, accepted.acceptedHash, '第一版', settings, fetcher, () => {})
  expect(first.hasPatch).toBe(false)
  writeFileSync(data, '{"name":"fixture","value":3}')
  const store = new CreativeWorkbench(workspace, root), current = store.inspect(task)
  const next = store.accept(task, { paths: ['data/maps/fixture.json'], expectedHash: current.contentHash, expectedAcceptedHash: current.acceptedHash })
  const second = await service.publish(task, next.acceptedHash, '第二版', settings, fetcher, () => {})
  expect(second.hasPatch).toBe(true)
  const patch = readProfileArchiveV1(uploaded.get('2/content-patch.rvbpack')!)
  const manifest = JSON.parse(Buffer.from(patch.manifestBytes).toString('utf8'))
  expect(manifest.kind).toBe('patch')
  expect(manifest.operations).toEqual([expect.objectContaining({ op: 'replace', targetPath: 'data/maps/fixture.json' })])
  expect(patch.signatureBytes).toBeTruthy()
  const index = JSON.parse(Buffer.from(uploaded.get('2/content-update.json')!).toString('utf8'))
  expect(index.patch.parentProfileHash).toMatch(/^[a-f0-9]{64}$/)
  expect(index.patch.resolvedProfileHash).toMatch(/^[a-f0-9]{64}$/)
  await service.publish(task, next.acceptedHash, '重复点击', settings, fetcher, () => {})
  await service.publish(task, next.acceptedHash, '仓库大小写变化重试', { ...settings, repository: 'OWNER/GAME' }, fetcher, () => {})
  expect(releases).toHaveLength(2)
  writeFileSync(data, '{"name":"fixture","value":4}')
  const changed = store.inspect(task)
  const thirdVersion = store.accept(task, { paths: ['data/maps/fixture.json'], expectedHash: changed.contentHash, expectedAcceptedHash: changed.acceptedHash })
  await service.publish(task, thirdVersion.acceptedHash, '第三版', settings, fetcher, () => {})
  const thirdIndex = JSON.parse(Buffer.from(uploaded.get('3/content-update.json')!).toString('utf8'))
  expect(thirdIndex.patch.parentProfileHash).toBe(index.patch.resolvedProfileHash)
  const policy = contentPolicyForChannelV1('qa')
  const resolved = resolveProfileV1({ base: { source: readProfileArchiveV1(uploaded.get('1/content.rvbpack')!), policy }, patches: [2, 3].map(id => ({ source: readProfileArchiveV1(uploaded.get(`${id}/content-patch.rvbpack`)!), policy })) })
  expect(resolved.profile.resolvedProfileHash).toBe(thirdIndex.patch.resolvedProfileHash)
  expect(JSON.parse(Buffer.from(resolved.readFile('data/maps/fixture.json')!).toString('utf8')).value).toBe(4)
})
