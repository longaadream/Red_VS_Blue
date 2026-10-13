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
import { applyGameplayModuleGraph, assertGameplayModuleDocument } from '../../lib/skill-graph/module-document'
import type { GameplayModuleGraph, GameplayStatement } from '../../lib/skill-graph/module-types'

const roots: string[] = []
const appRoot = process.cwd()
const scriptReleaseRootPrefix = 'rvb-script-release-'
const cleanupConcurrency = 4
function ownedScriptReleaseRoot(root: string): string {
  const resolved = path.resolve(root)
  const tempRoot = path.resolve(tmpdir())
  if (path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase()
    || !path.basename(resolved).startsWith(scriptReleaseRootPrefix)) {
    throw new Error(`refusing to remove unexpected script-release temp root: ${resolved}`)
  }
  return resolved
}
async function removeScriptReleaseRoot(root: string): Promise<void> {
  const resolved = ownedScriptReleaseRoot(root)
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(resolved, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const children = entries.map(entry => path.join(resolved, entry.name))
  let next = 0
  const worker = async () => {
    while (next < children.length) {
      const child = children[next++]!
      await fs.promises.rm(child, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(cleanupConcurrency, children.length) }, worker))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'script-release temporary cleanup failed')
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(removeScriptReleaseRoot))
})
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
  // Patch verification rebuilds the bundled base from this isolated host.
  // Include its actual art as well as JSON, just like a packaged client.
  fs.mkdirSync(path.join(host, 'public'), { recursive: true })
  fs.cpSync(path.join(appRoot, 'public/images'), path.join(host, 'public/images'), { recursive: true })
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
  let editedAttack = 0
  edit(paths[0], value => { expect(Number.isFinite(value.stats.attack)).toBe(true); editedAttack = value.stats.attack + 1; value.stats.attack = editedAttack })
  edit(paths[1], value => { value.description = '造成或受到伤害后，恢复2点生命。' })
  for (const relative of paths.slice(2)) {
    const filename = path.join(importedRoot, relative), value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    assertGameplayModuleDocument(value)
    const graph: GameplayModuleGraph = value.gameplayModules.entries.skillCode.graph
    let changedAmounts = 0
    const changeHeal = (body: readonly GameplayStatement[]): GameplayStatement[] => body.map(node => {
      if (node.kind === 'call' && node.id === 'heal' && node.module === 'effect.queue-heal') {
        expect(node.inputs?.amount).toEqual({ kind: 'literal', value: 1 })
        changedAmounts++
        return { ...node, inputs: { ...node.inputs, amount: { kind: 'literal', value: 2 } } }
      }
      if (node.kind === 'if') return { ...node, then: changeHeal(node.then), ...(node.else ? { else: changeHeal(node.else) } : {}) }
      return node
    })
    const edited = applyGameplayModuleGraph(value, { ...graph, body: changeHeal(graph.body) }, 'skillCode')
    expect(changedAmounts).toBe(1)
    fs.writeFileSync(filename, JSON.stringify(edited, null, 2) + '\n')
  }
  // Carry an actual targeting edit through admission, archive and client
  // loading. Checking only the saved graph missed stale targeting metadata.
  const targetingPath = 'data/skills/naruto-shadow-clone.json'
  const targetingFile = path.join(importedRoot, targetingPath)
  const targetDefinition = JSON.parse(fs.readFileSync(targetingFile, 'utf8'))
  assertGameplayModuleDocument(targetDefinition)
  const targetGraph: GameplayModuleGraph = targetDefinition.gameplayModules.entries.code.graph
  let editedTargets = 0
  const targetBody = targetGraph.body.map(statement => {
    if (statement.kind !== 'call' || statement.id !== 'target' || statement.module !== 'author.choice.target-cell') return statement
    expect(statement.parameters?.range).toBe(5)
    editedTargets++
    return { ...statement, parameters: { ...statement.parameters, range: 6 } }
  })
  const updatedTargetDefinition = applyGameplayModuleGraph(targetDefinition, { ...targetGraph, body: targetBody }, 'code')
  expect(editedTargets).toBe(1)
  expect(updatedTargetDefinition.targetText).toBe('地格（6）')
  fs.writeFileSync(targetingFile, JSON.stringify(updatedTargetDefinition, null, 2) + '\n')
  paths.push(targetingPath)
  const changed = workbench.inspect(imported.taskId)
  expect(changed.changes.map(item => item.path).sort()).toEqual([...paths].sort())
  const accepted = workbench.accept(imported.taskId, { paths, expectedHash: changed.contentHash, expectedAcceptedHash: changed.acceptedHash })
  console.info('script-pack: five edits accepted, including targeting metadata')
  const service = new ResourceRelease(imported.root, host, path.join(root, 'private'), input => runContentPipelineOperationV1(input as ContentPipelineOperationV1))
  const exported = await service.export(imported.taskId, accepted.acceptedHash, `攻击 ${editedAttack}，回血 2`)
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
  expect(JSON.parse(fs.readFileSync(path.join(installedRoot, paths[0]), 'utf8')).stats.attack).toBe(editedAttack)
  const { RuleRuntime, withRuleRuntime } = await import('../../lib/game/rule-runtime')
  const { dealDamage, loadRuleById, loadSkillById } = await import('../../lib/game/skills')
  const { prepareAction } = await import('../../lib/game/targeting')
  const { globalTriggerSystem } = await import('../../lib/game/triggers')
  const { makePiece, makeState } = await import('../helpers/minimal-state')
  const installedTargetSkill = loadSkillById('naruto-shadow-clone', true)!
  expect(installedTargetSkill).toMatchObject({ targetText: '地格（6）' })
  expect(installedTargetSkill.description).toContain('地格（6）')
  assertGameplayModuleDocument(installedTargetSkill)
  const targetSource = makePiece({
    instanceId: 'installed-naruto', ownerPlayerId: 'player-red', x: 0, y: 0,
    skills: [{ skillId: 'naruto-shadow-clone', currentCooldown: 0, usesRemaining: -1 }],
  })
  const targetState = makeState({ pieces: [targetSource], width: 8, height: 2 })
  targetState.skillsById['naruto-shadow-clone'] = installedTargetSkill
  const targetAction = { type: 'useBasicSkill', playerId: 'player-red', pieceId: targetSource.instanceId, skillId: 'naruto-shadow-clone' }
  const optionPreparation = prepareAction(targetState, targetAction)
  expect(optionPreparation.kind).toBe('needOption')
  const installedTargetPreparation = prepareAction(targetState, {
    ...targetAction, selectedOption: 'summon',
    selectionId: optionPreparation.kind === 'needOption' ? optionPreparation.selectionId : undefined,
    stateRevision: optionPreparation.kind === 'needOption' ? optionPreparation.stateRevision : undefined,
  })
  expect(installedTargetPreparation).toMatchObject({ kind: 'needTarget', range: 6 })
  if (installedTargetPreparation.kind === 'needTarget') {
    expect(installedTargetPreparation.candidates).toContainEqual({ type: 'cell', x: 6, y: 0 })
  }
  globalTriggerSystem.clearRules()
  try {
    const piece = makePiece({ instanceId: 'ulquiorra', templateId: 'dark-ulquiorra', ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 6, maxHp: 12, attack: 4, moveRange: 3 }) as unknown as PieceInstance
    piece.name = '乌尔奇奥拉·西法'
    piece.rules = ['rule-ulquiorra-damage-dealt', 'rule-ulquiorra-damage-taken', 'rule-ulquiorra-resurreccion'].map(id => { const rule = loadRuleById(id, true, true); expect(rule).toBeTruthy(); return rule! })
    piece.skills = [{ skillId: 'ulquiorra-cero', currentCooldown: 0, usesRemaining: -1 }]
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, maxHp: 30 }) as unknown as PieceInstance
    const state = makeState({ pieces: [piece, enemy] }) as unknown as BattleState
    withRuleRuntime(new RuleRuntime({ rootSeed: 202, tick: 1 }), () => {
      dealDamage(piece, enemy, 1, 'true', state, 'outgoing'); expect(piece.currentHp).toBe(8)
      dealDamage(enemy, piece, 1, 'true', state, 'incoming'); expect(piece.currentHp).toBe(9)
      dealDamage(piece, enemy, 1, 'true', state, 'outgoing-2'); expect(piece.currentHp).toBe(11)
    })
    expect(piece.statusTags.find(tag => tag.type === 'ulquiorra-resurreccion-progress')?.intensity).toBe(3)
    globalTriggerSystem.checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' })
    expect([piece.attack, piece.moveRange, piece.currentHp]).toEqual([5, 4, 11])
  } finally { globalTriggerSystem.clearRules() }
  console.info('script-pack: installed gameplay verified')
  edit(paths[0], value => { value.stats.attack = editedAttack + 1 })
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
  const firstUpdate = await newUpdater().check()
  expect(firstUpdate.phase, JSON.stringify(firstUpdate)).toBe('current')
  expect(installations).toBe(1)
  expect((await newUpdater().check()).phase).toBe('current') // Fresh process, no memory or receipt.
  expect(installations).toBe(1)
  expect(patched).toBeTruthy()
  expect(JSON.parse(Buffer.from(store.openVerifiedSnapshot(patched!.reference).readFile(paths[0])!).toString()).stats.attack).toBe(editedAttack + 1)
  store.selectRollbackCandidate('previous-stable')
  const rollback = store.beginActivation(installed.reference.resolvedProfileHash); store.commitActivation(rollback.activationId, rollback.targetProfileHash)
  expect(JSON.parse(Buffer.from(store.openVerifiedSnapshot(store.readState().stable).readFile(paths[0])!).toString()).stats.attack).toBe(editedAttack)
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
