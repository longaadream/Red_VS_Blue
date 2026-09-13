import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { OfficialResourceUpdates, compareVersions, type ResourceIndex, type StableResource } from '../../electron-client/official-resource-updates'
import { ClientBinaryUpdates, type BinaryUpdater } from '../../electron-client/client-binary-updates'
import { UpdateAdmission } from '../../lib/server/colyseus/update-admission'
import { resolvedResourceVersion } from '../../electron-client/resource-update-identity'
import { assertOfficialUpdateIpcAllowed } from '../../electron-client/official-update-ipc'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const H = 'a'.repeat(64), P = 'b'.repeat(64), K = 'c'.repeat(64)
function fixture(options: { patch?: boolean; canApply?: boolean; version?: string } = {}) {
  const full = Buffer.from('signed full archive'), patch = Buffer.from('signed patch archive')
  const index: ResourceIndex = { schema: 'rvb-content-release/v1', channel: 'test', version: options.version || '0.0.123', contentHash: H, archive: 'content.rvbpack', archiveSha256: sha(full), identity: { publisherKeyId: K, engineAbi: 'engine/v1', contentAbi: 'content/v1' }, ...(options.patch ? { patch: { archive: 'content-patch.rvbpack', sha256: sha(patch), parentProfileHash: P, resolvedProfileHash: H } } : {}) }
  const state: StableResource = { kind: 'bundled-base', resolvedProfileHash: P, version: '0.1.0', compatibility: { engineAbi: 'engine/v1', contentAbi: 'content/v1' } }
  let allowed = options.canApply !== false
  let corrupt = ''
  let urlOverride = ''
  const reads: string[] = []
  const files = () => ({ 'content.rvbpack': full, 'content-patch.rvbpack': patch, 'content-update.json': Buffer.from(JSON.stringify(index)) })
  const release = () => ({ tag_name: 'content-test-' + H, draft: false, published_at: '2026-09-10', assets: Object.entries(files()).map(([name, data]) => ({ name, size: data.length, digest: 'sha256:' + sha(data), state: 'uploaded', browser_download_url: urlOverride || 'https://github.com/longaadream/Red_VS_Blue/releases/download/content-test-' + H + '/' + name })) })
  const fetcher = vi.fn(async (url: string) => {
    reads.push(url)
    if (url.includes('/releases?')) return new Response(JSON.stringify([{ tag_name: 'v99.0.0', draft: false, published_at: '2026-09-11', assets: [{ name: 'latest.yml' }] }, release()]))
    const name = url.split('/').pop()! as keyof ReturnType<typeof files>
    return new Response(corrupt === name ? Buffer.from('corrupt') : files()[name])
  })
  const apply = vi.fn(async (bytes: Buffer, value: ResourceIndex, parent: string) => {
    expect(parent).toBe(P)
    expect([full.toString(), patch.toString()]).toContain(bytes.toString())
    state.kind = 'installed'; state.resolvedProfileHash = H; state.version = value.version
    return H
  })
  const applied = vi.fn()
  const updater = new OfficialResourceUpdates(fetcher, '0.1.0', [K], { stable: async () => ({ ...state }), canApply: async () => allowed, apply, applied })
  return { updater, state, index, reads, fetcher, apply, applied, full, patch, allow: () => { allowed = true }, corrupt: (name: string) => { corrupt = name }, badUrl: (url: string) => { urlOverride = url } }
}

it('discovers resource updates independently of a newer client release and installs only once', async () => {
  const f = fixture()
  expect((await f.updater.check()).message).toBe('官方资源更新已应用')
  expect(f.apply).toHaveBeenCalledTimes(1)
  expect(f.applied).toHaveBeenCalledWith({ contentHash: H, profileHash: H, version: '0.0.123' })
  await f.updater.check()
  expect(f.apply).toHaveBeenCalledTimes(1)
})
it('uses a matching-parent patch, otherwise downloads the complete pack', async () => {
  const f = fixture({ patch: true }); await f.updater.check()
  expect(f.apply.mock.calls[0][0]).toEqual(f.patch)
  const g = fixture({ patch: true }); g.index.patch!.parentProfileHash = 'd'.repeat(64); await g.updater.check()
  expect(g.apply.mock.calls[0][0]).toEqual(g.full)
})
it('falls back to the signed complete archive if the patch download is corrupt', async () => {
  const f = fixture({ patch: true }); f.corrupt('content-patch.rvbpack'); await f.updater.check()
  expect(f.apply.mock.calls[0][0]).toEqual(f.full)
})
it('keeps downloaded bytes pending during a match and applies on return without another network request', async () => {
  const f = fixture({ canApply: false })
  expect((await f.updater.check()).phase).toBe('waiting')
  expect(f.apply).not.toHaveBeenCalled()
  const count = f.reads.length
  f.allow(); await f.updater.applyPending()
  expect(f.reads).toHaveLength(count)
  expect(f.apply).toHaveBeenCalledTimes(1)
})
it('does not overwrite a manually imported candidate', async () => {
  const f = fixture(); f.state.candidateHash = 'd'.repeat(64)
  expect((await f.updater.check()).message).toContain('手动导入')
  expect(f.apply).not.toHaveBeenCalled()
})
it.each(['abi', 'minimum', 'signature', 'hash', 'foreign-url'])('rejects incompatible or untrusted content: %s', async mode => {
  const f = fixture()
  if (mode === 'abi') f.index.identity.engineAbi = 'new/engine'
  if (mode === 'minimum') f.index.minimumClientVersion = '99.0.0'
  if (mode === 'signature') f.index.identity.publisherKeyId = 'e'.repeat(64)
  if (mode === 'hash') f.corrupt('content.rvbpack')
  if (mode === 'foreign-url') f.badUrl('https://evil.example/content.rvbpack')
  expect(['error', 'waiting']).toContain((await f.updater.check()).phase)
  expect(f.apply).not.toHaveBeenCalled()
  expect(f.state.resolvedProfileHash).toBe(P)
})
it('deduplicates simultaneous manual and scheduled checks', async () => {
  const f = fixture(); await Promise.all([f.updater.check(), f.updater.check(), f.updater.check()])
  expect(f.apply).toHaveBeenCalledTimes(1)
})
it('does not downgrade a locally newer installed pack', async () => {
  const f = fixture(); f.state.kind = 'installed'; f.state.version = '0.0.124'
  expect((await f.updater.check()).phase).toBe('current')
  expect(f.apply).not.toHaveBeenCalled()
})
it('ignores broken older release history instead of blocking the valid latest resource', async () => {
  const f = fixture()
  const releases = await (await f.fetcher('https://api.github.com/repos/longaadream/Red_VS_Blue/releases?per_page=100&page=1')).json()
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify([...releases, { tag_name: 'content-test-' + 'e'.repeat(64), draft: false, published_at: '2026-09-09', assets: [] }])))
  expect((await f.updater.check()).phase).toBe('current')
  expect(f.apply).toHaveBeenCalledTimes(1)
})
it('allows the renderer commit identity handshake while blocking mutations and new-room IPC', () => {
  expect(() => assertOfficialUpdateIpcAllowed('pack-list', true)).not.toThrow()
  expect(() => assertOfficialUpdateIpcAllowed('get-mode', true)).not.toThrow()
  for (const channel of ['pack-activate', 'pack-import-data', 'ensure-local-authority', 'relay-control']) expect(() => assertOfficialUpdateIpcAllowed(channel, true)).toThrow()
  expect(() => assertOfficialUpdateIpcAllowed('pack-activate', false)).not.toThrow()
})
it('does not report success when installation or activation fails', async () => {
  const f = fixture(); f.apply.mockRejectedValueOnce(new Error('SIGNATURE_INVALID'))
  expect((await f.updater.check()).phase).toBe('error')
  expect(f.applied).not.toHaveBeenCalled()
  expect(f.state.resolvedProfileHash).toBe(P)
})
it('compares numeric resource versions without lexicographic ordering or unsafe numbers', () => {
  expect(compareVersions('0.0.99', '0.0.100')).toBe(-1)
  expect(() => compareVersions('0.0.9007199254740992', '0.0.1')).toThrow()
  expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow()
})
it('reads the last applied patch version rather than the original base version', () => {
  expect(resolvedResourceVersion({ base: { version: '0.0.1' }, patches: [{ version: '0.0.2' }, { version: '0.0.3' }] })).toBe('0.0.3')
})
it('fences pending creation and all live rooms until disposal, and rejects new creation while updating', () => {
  const gate = new UpdateAdmission()
  const leave = gate.enterRoom() // Synchronous, before onCreate does asynchronous work.
  expect(gate.acquire('update')).toBe(false)
  leave()
  expect(gate.acquire('update')).toBe(true)
  expect(() => gate.enterRoom()).toThrow()
  gate.release('wrong-token')
  expect(() => gate.enterRoom()).toThrow()
  gate.release('update')
  expect(() => gate.enterRoom()).not.toThrow()
})
it('starts the replacement authority fenced until renderer commit releases it', () => {
  const gate = new UpdateAdmission('inherited')
  expect(() => gate.enterRoom()).toThrow()
  gate.release('inherited')
  expect(() => gate.enterRoom()).not.toThrow()
})
function binaryFixture() {
  const events = new EventEmitter()
  const updater = Object.assign(events, { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true, checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.0.0' } })), downloadUpdate: vi.fn(async () => { events.emit('update-downloaded', { version: '1.0.0' }) }), quitAndInstall: vi.fn() })
  return { updater, client: new ClientBinaryUpdates(updater as BinaryUpdater, vi.fn()) }
}
it('downloads a stable client update but never installs until explicitly requested', async () => {
  const { updater, client } = binaryFixture()
  expect(updater.allowPrerelease).toBe(false)
  expect(updater.autoInstallOnAppQuit).toBe(false)
  expect(updater.allowDowngrade).toBe(false)
  await Promise.all([client.check(), client.check()])
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  expect(client.isReady()).toBe(true)
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
  await client.check(); expect(client.isReady()).toBe(true)
  client.install(); expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
})
it('handles client download failure without an unhandled rejection or restart', async () => {
  const { updater, client } = binaryFixture()
  updater.downloadUpdate.mockRejectedValueOnce(new Error('offline'))
  await client.check()
  expect(client.status.phase).toBe('error')
  expect(() => client.install()).toThrow()
  expect(updater.quitAndInstall).not.toHaveBeenCalled()
})
it('prepares binary-update networking before discovery and allows retry after setup failure', async () => {
  const { updater } = binaryFixture()
  const prepare = vi.fn(async () => {}).mockRejectedValueOnce(new Error('network setup failed'))
  const client = new ClientBinaryUpdates(updater as BinaryUpdater, vi.fn(), prepare)
  await client.check()
  expect(client.status.phase).toBe('error')
  expect(updater.checkForUpdates).not.toHaveBeenCalled()
  await client.check()
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  expect(client.isReady()).toBe(true)
})
