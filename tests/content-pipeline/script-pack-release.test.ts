import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createContentProject } from '../../electron-editor/content-project'
import { importResourceProject } from '../../electron-editor/content-import-worker'
import { prepareWorkspacePackageV1 } from '../../electron-editor/workspace'
import { CreativeWorkbench } from '../../electron-editor/workbench'
import { ResourceRelease } from '../../electron-editor/resource-release'
import { publicationKeyId } from '../../electron-editor/publication-identity'
import { runContentPipelineOperationV1 } from '../../lib/content-pipeline/tooling'
import { buildPackSourceV1, writeArchiveFileV1, contentPolicyForChannelV1 } from '../../lib/content-pipeline/tooling/archive'
import { resolveProfileV1 } from '../../lib/content-pipeline/core/resolver'
import { getBundledBaseProfileV1 } from '../../lib/content-pipeline/runtime/bundled-base'
import { installProfileArchiveV1, openInstalledProfileProvenanceV1, readProfileArchiveV1 } from '../../lib/content-pipeline/runtime/profile-archive'
import { ProfileStoreV1 } from '../../lib/content-pipeline/runtime/profile-store'
import { OfficialResourceUpdates } from '../../electron-client/official-resource-updates'
import { installedResourceVersion, resolvedResourceVersion } from '../../electron-client/resource-update-identity'
import type { BuildContentOperationV1, ContentPipelineOperationV1 } from '../../lib/content-pipeline/tooling/contracts'
import type { PieceInstance } from '../../lib/game/piece'
import type { BattleState } from '../../lib/game/turn'

const roots: string[] = []
const appRoot = process.cwd()
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function githubFixture() {
  const releases: { id: number; draft: boolean; html_url: string; assets: { name: string; size: number; digest: string; state: string; browser_download_url: string }[] }[] = []
  const uploaded = new Map<string, Uint8Array>()
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/releases?')) return response(releases)
    if (url.endsWith('/releases') && init.method === 'POST') {
      const release = { ...JSON.parse(String(init.body)), id: releases.length + 1, html_url: 'https://github.com/owner/game/releases/tag/test-' + releases.length, assets: [] }
      releases.push(release); return response(release, 201)
    }
    const id = Number(/\/releases\/(\d+)/.exec(url)?.[1]), release = releases.find(value => value.id === id)!
    if (url.includes('/assets?')) {
      const bytes = new Uint8Array(init.body as Uint8Array), name = new URL(url).searchParams.get('name')!
      const asset = { name, size: bytes.length, digest: 'sha256:' + digest(bytes), state: 'uploaded', browser_download_url: 'https://github.com/owner/game/releases/download/test/' + name }
      release.assets.push(asset); uploaded.set(`${id}/${name}`, bytes); return response(asset, 201)
    }
    if (init.method === 'PATCH') Object.assign(release, JSON.parse(String(init.body)))
    return response(release)
  })
  return { releases, uploaded, fetcher }
}

it('imports current JSON SkillCode, publishes accepted edits, installs and runs them, then patches and rolls back', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'rvb-script-release-')); roots.push(root)
  const projects = path.join(root, 'projects'); fs.mkdirSync(projects)
  const originalProject = createContentProject(projects, 'official', appRoot)
  const prepared = prepareWorkspacePackageV1(originalProject, appRoot)
  const original = path.join(root, 'original.rvbpack')
  const request: BuildContentOperationV1 = {
    schemaVersion: 'rvb-content-operation/v1', operation: 'build', caller: 'editor', taskId: 'RED-202', channel: 'authoring',
    mode: 'snapshot', sourceDir: path.join(originalProject, prepared.source), outputArchive: original, appRoot,
    evidenceRoot: path.join(root, 'reports'), command: { name: 'integration', args: [] },
    packageId: 'rvb.official-content', publisherId: 'rvb.official', displayName: 'Script package test', version: '0.1.0',
  }
  const source = buildPackSourceV1(request); writeArchiveFileV1(original, source)
  const unsigned = fs.readFileSync(original)
  const authored = resolveProfileV1({ base: { source, policy: contentPolicyForChannelV1('authoring') } })
  expect(authored.networkEligible).toBe(false)
  expect(authored.profile.capabilities).toContain('trusted-executable-content')
  expect(() => resolveProfileV1({ base: { source, policy: contentPolicyForChannelV1('local-dev') } })).toThrow('PACK_FORBIDDEN_EXECUTABLE_CONTENT')
  const smoke = await runContentPipelineOperationV1({ ...request, operation: 'smoke', base: { kind: 'archive', archive: original }, patches: [], seed: 1 })
  expect(smoke.ok).toBe(false)
  expect(smoke.report.refusal?.code).toBe('AUTHORING_PREVIEW_ONLY')

  const imported = importResourceProject({ archive: original, parent: projects })
  if (imported.needsBase) throw new Error('expected snapshot import')
  const importedRoot = imported.root
  console.info('script-pack: current original imported')
  const host = path.join(root, 'host'); fs.mkdirSync(path.join(host, 'config'), { recursive: true })
  fs.cpSync(path.join(appRoot, 'data'), path.join(host, 'data'), { recursive: true })
  const keyFile = path.join(root, 'publisher.key'); fs.writeFileSync(keyFile, '2'.repeat(64))
  const keyId = publicationKeyId(keyFile)
  const trust = (keys: string[]) => fs.writeFileSync(path.join(host, 'config/content-script-publishers.json'), JSON.stringify({ schema: 'rvb-script-publishers/v1', keyIds: keys }))
  trust([keyId])
  const workbench = new CreativeWorkbench(imported.root, host)
  expect(workbench.inspect(imported.taskId).changes).toEqual([])
  const paths = ['data/pieces/dark-aizen.json', 'data/skills/ulquiorra-high-speed-regeneration.json', 'data/rules/rule-ulquiorra-damage-dealt.json', 'data/rules/rule-ulquiorra-damage-taken.json']
  function edit(relative: string, change: (data: { stats: { attack: number }; description: string; skillCode: string }) => void) {
    const filename = path.join(importedRoot, relative), value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    change(value); fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n')
  }
  edit(paths[0], value => { expect(value.stats.attack).toBe(4); value.stats.attack = 5 })
  edit(paths[1], value => { value.description = '造成或受到伤害后，恢复1点生命。' })
  for (const relative of paths.slice(2)) edit(relative, value => { expect(value.skillCode).toMatch(/heal:\s*2/); value.skillCode = value.skillCode.replace(/heal:\s*2/g, 'heal: 1') })
  const changed = workbench.inspect(imported.taskId)
  expect(changed.changes.map(item => item.path).sort()).toEqual([...paths].sort())
  const accepted = workbench.accept(imported.taskId, { paths, expectedHash: changed.contentHash, expectedAcceptedHash: changed.acceptedHash })
  console.info('script-pack: four edits accepted')
  const service = new ResourceRelease(imported.root, host, path.join(root, 'private'), input => runContentPipelineOperationV1(input as ContentPipelineOperationV1))
  const exported = await service.export(imported.taskId, accepted.acceptedHash, '攻击 5，回血 1')
  expect(exported.published).toBe(false)
  const remote = githubFixture(), settings = { repository: 'owner/game', token: 'fixture-only', keyFile }
  trust([])
  await expect(service.publish(imported.taskId, accepted.acceptedHash, 'first', settings, remote.fetcher, () => {})).rejects.toThrow('尚未被当前客户端版本信任')
  expect(remote.fetcher).not.toHaveBeenCalled()
  trust([keyId])
  const first = await service.publish(imported.taskId, accepted.acceptedHash, 'first', settings, remote.fetcher, () => {})
  console.info('script-pack: first release verified and uploaded to mock')
  expect(first.hasPatch).toBe(false)
  const signed = remote.uploaded.get('1/content.rvbpack')!
  expect(JSON.parse(Buffer.from(readProfileArchiveV1(signed).manifestBytes).toString()).publisher.keyId).toBe(keyId)
  const storeRoot = path.join(root, 'installed'), bundledBase = getBundledBaseProfileV1(appRoot)
  const newStore = () => new ProfileStoreV1({ rootDir: storeRoot, bundledBase, openScriptProvenance: hash => openInstalledProfileProvenanceV1(storeRoot, host, hash) })
  const store = newStore()
  expect(() => installProfileArchiveV1({ store, appRoot: host, archive: unsigned })).toThrow('PACK_SIGNATURE_REQUIRED')
  expect(() => installProfileArchiveV1({ store, appRoot: host, archive: unsigned, allowLocalDevUnsigned: true })).toThrow('PACK_FORBIDDEN_EXECUTABLE_CONTENT')
  trust([])
  expect(() => installProfileArchiveV1({ store, appRoot: host, archive: signed })).toThrow('PACK_FORBIDDEN_EXECUTABLE_CONTENT')
  trust([keyId])
  const installed = installProfileArchiveV1({ store, appRoot: host, archive: signed, allowLocalDevUnsigned: true })
  const transaction = store.beginActivation(installed.reference.resolvedProfileHash)
  store.commitActivation(transaction.activationId, transaction.targetProfileHash)
  expect(newStore().readState().stable.resolvedProfileHash).toBe(installed.reference.resolvedProfileHash)
  const installedRoot = store.profileRoot(installed.reference)!
  vi.stubEnv('RVB_PROFILE_ROOT', installedRoot); vi.stubEnv('APP_ROOT_DIR', appRoot); vi.stubEnv('USER_DATA_DIR', path.join(root, 'userdata'))
  expect(JSON.parse(fs.readFileSync(path.join(installedRoot, paths[0]), 'utf8')).stats.attack).toBe(5)
  const { RuleRuntime, withRuleRuntime } = await import('../../lib/game/rule-runtime')
  const { dealDamage, loadRuleById } = await import('../../lib/game/skills')
  const { globalTriggerSystem } = await import('../../lib/game/triggers')
  const { makePiece, makeState } = await import('../helpers/minimal-state')
  globalTriggerSystem.clearRules()
  try {
    const piece = makePiece({ instanceId: 'ulquiorra', templateId: 'dark-ulquiorra', ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 6, maxHp: 12, attack: 4, moveRange: 3 }) as unknown as PieceInstance
    piece.name = '乌尔奇奥拉·西法'
    piece.rules = ['rule-ulquiorra-damage-dealt', 'rule-ulquiorra-damage-taken', 'rule-ulquiorra-resurreccion'].map(id => { const rule = loadRuleById(id, true, true); expect(rule).toBeTruthy(); return rule! })
    piece.skills = [{ skillId: 'ulquiorra-cero', currentCooldown: 0, usesRemaining: -1 }]
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, maxHp: 30 }) as unknown as PieceInstance
    const state = makeState({ pieces: [piece, enemy] }) as unknown as BattleState
    withRuleRuntime(new RuleRuntime({ rootSeed: 202, tick: 1 }), () => {
      dealDamage(piece, enemy, 1, 'true', state, 'outgoing'); expect(piece.currentHp).toBe(7)
      dealDamage(enemy, piece, 1, 'true', state, 'incoming'); expect(piece.currentHp).toBe(7)
      dealDamage(piece, enemy, 1, 'true', state, 'outgoing-2'); expect(piece.currentHp).toBe(8)
    })
    expect(piece.statusTags.find(tag => tag.type === 'ulquiorra-resurreccion-progress')?.intensity).toBe(3)
    globalTriggerSystem.checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' })
    expect([piece.attack, piece.moveRange, piece.currentHp]).toEqual([5, 4, 8])
  } finally { globalTriggerSystem.clearRules() }
  console.info('script-pack: installed gameplay verified')
  edit(paths[0], value => { value.stats.attack = 6 })
  const draft = workbench.inspect(imported.taskId), next = workbench.accept(imported.taskId, { paths: [paths[0]], expectedHash: draft.contentHash, expectedAcceptedHash: draft.acceptedHash })
  const second = await service.publish(imported.taskId, next.acceptedHash, 'second', settings, remote.fetcher, () => {})
  console.info('script-pack: automatic patch verified and uploaded to mock')
  expect(second.hasPatch).toBe(true)
  const patch = remote.uploaded.get('2/content-patch.rvbpack')!
  const releaseIndex = JSON.parse(Buffer.from(remote.uploaded.get('2/content-update.json')!).toString())
  const tag = `content-test-${releaseIndex.contentHash}`
  const download = async (url: string) => {
    const entries = ['content-update.json', 'content.rvbpack', 'content-patch.rvbpack'].map(name => {
      const bytes = remote.uploaded.get(`2/${name}`)!
      return { name, size: bytes.length, digest: 'sha256:' + digest(bytes), state: 'uploaded', browser_download_url: `https://github.com/longaadream/Red_VS_Blue/releases/download/${tag}/${name}` }
    })
    if (url.includes('/releases?')) return new Response(JSON.stringify([{ tag_name: tag, draft: false, published_at: '2026-09-10', assets: entries }]))
    return new Response(remote.uploaded.get(`2/${url.split('/').pop()}`)!)
  }
  let patched: ReturnType<typeof installProfileArchiveV1> | undefined
  let installations = 0
  const newUpdater = () => new OfficialResourceUpdates(download, '0.1.0', [releaseIndex.identity.publisherKeyId], {
    stable: async () => {
      const current = store.readState()
      return { ...current.stable, version: installedResourceVersion(store.rootDir, current.stable), candidateHash: current.candidate?.resolvedProfileHash }
    },
    canApply: async () => true,
    apply: async (bytes, index) => {
      expect(bytes).toEqual(Buffer.from(patch))
      patched = installProfileArchiveV1({ store, appRoot: host, archive: bytes })
      expect(resolvedResourceVersion(patched.profile)).toBe(index.version)
      expect(patched.reference.version).not.toBe(index.version) // Base version intentionally stays unchanged.
      const transaction = store.beginActivation(patched.reference.resolvedProfileHash)
      store.commitActivation(transaction.activationId, transaction.targetProfileHash)
      installations++
      return patched.reference.resolvedProfileHash
    },
    applied: () => {},
  })
  expect((await newUpdater().check()).phase).toBe('current')
  expect(installations).toBe(1)
  expect((await newUpdater().check()).phase).toBe('current') // Fresh process, no memory or receipt.
  expect(installations).toBe(1)
  expect(patched).toBeTruthy()
  expect(JSON.parse(Buffer.from(store.openVerifiedSnapshot(patched!.reference).readFile(paths[0])!).toString()).stats.attack).toBe(6)
  store.selectRollbackCandidate('previous-stable')
  const rollback = store.beginActivation(installed.reference.resolvedProfileHash); store.commitActivation(rollback.activationId, rollback.targetProfileHash)
  expect(JSON.parse(Buffer.from(store.openVerifiedSnapshot(store.readState().stable).readFile(paths[0])!).toString()).stats.attack).toBe(5)
  const tampered = readProfileArchiveV1(signed), badArchive = path.join(root, 'tampered.rvbpack')
  writeArchiveFileV1(badArchive, { ...tampered, entries: tampered.entries.map(entry => entry.path === paths[0] ? { ...entry, bytes: Buffer.from('{}') } : entry) })
  const before = store.readState()
  expect(() => installProfileArchiveV1({ store, appRoot: host, archive: fs.readFileSync(badArchive) })).toThrow()
  expect(store.readState()).toEqual(before)
  trust([])
  expect(() => store.verifyReference(installed.reference)).toThrow('PACK_FORBIDDEN_EXECUTABLE_CONTENT')
  expect(() => store.openVerifiedSnapshot(patched!.reference)).toThrow('PACK_FORBIDDEN_EXECUTABLE_CONTENT')
  expect(newStore().readState().stable.kind).toBe('bundled-base')
  expect(fs.readFileSync(original)).toEqual(unsigned)
}, 600000)
