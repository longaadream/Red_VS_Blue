import * as fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { importResourceProject } from '../../electron-editor/content-import-worker'
import { CreativeWorkbench } from '../../electron-editor/workbench'
import { buildPackSourceV1, contentPolicyForChannelV1, writeArchiveFileV1 } from '../../lib/content-pipeline/tooling/archive'
import { resolveProfileV1 } from '../../lib/content-pipeline/core/resolver'
import type { BuildContentOperationV1 } from '../../lib/content-pipeline/tooling/contracts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'rvb-import-test-')); roots.push(root)
  const sourceDir = path.join(root, 'source'), parent = path.join(root, 'projects'), archive = path.join(root, 'original.rvbpack')
  fs.mkdirSync(path.join(sourceDir, 'data/maps'), { recursive: true }); fs.mkdirSync(parent)
  fs.writeFileSync(path.join(sourceDir, 'data/maps/map.json'), '{"value":1}')
  const request: BuildContentOperationV1 = { schemaVersion: 'rvb-content-operation/v1', operation: 'build', caller: 'editor', taskId: 'RED-200', channel: 'local-dev', mode: 'snapshot', sourceDir, outputArchive: archive, appRoot: root, evidenceRoot: path.join(root, 'reports'), command: { name: 'test', args: [] }, packageId: 'rvb.test-content', publisherId: 'rvb.test', displayName: '导入测试', version: '0.0.1' }
  const source = buildPackSourceV1(request); writeArchiveFileV1(archive, source)
  return { root, parent, archive, request, source }
}

it('imports original bytes to an independent project and establishes a baseline before any edits', () => {
  const input = fixture(), original = fs.readFileSync(input.archive)
  const result = importResourceProject(input)
  if (result.needsBase) throw new Error('expected full import')
  const store = new CreativeWorkbench(result.root, input.root)
  expect(store.inspect(result.taskId).changes).toEqual([])
  expect(fs.readFileSync(input.archive)).toEqual(original)
  const file = path.join(result.root, 'data/maps/map.json')
  fs.writeFileSync(file, '{"value":2}')
  const changed = store.inspect(result.taskId)
  expect(changed.changes.map(item => item.path)).toEqual(['data/maps/map.json'])
  store.revert(result.taskId, { paths: ['data/maps/map.json'], expectedHash: changed.contentHash, expectedAcceptedHash: changed.acceptedHash })
  expect(fs.readFileSync(file, 'utf8')).toBe('{"value":1}')
  const again = importResourceProject(input)
  expect(again.root).not.toBe(result.root)
  expect(fs.readFileSync(file, 'utf8')).toBe('{"value":1}')
})

it('initializes missing empty collections so a maps-only original can be edited and accepted', () => {
  const input = fixture(), result = importResourceProject(input)
  if (result.needsBase) throw new Error('expected full import')
  fs.writeFileSync(path.join(result.root, 'data/maps/map.json'), '{"value":2}')
  const store = new CreativeWorkbench(result.root, input.root), state = store.inspect(result.taskId)
  const accepted = store.accept(result.taskId, { paths: ['data/maps/map.json'], expectedHash: state.contentHash, expectedAcceptedHash: state.acceptedHash })
  expect(accepted.acceptedVersionId).toBeTruthy()
  const marker = JSON.parse(fs.readFileSync(path.join(result.root, 'rvb-content-project.json'), 'utf8'))
  expect(marker.initializedFiles).toHaveLength(4)
  expect(fs.readdirSync(path.join(result.root, 'archives'))).toHaveLength(1)
})

it.each(['bytes', 'signature', 'archive'])('rejects invalid %s before creating any destination', kind => {
  const input = fixture()
  if (kind === 'bytes') writeArchiveFileV1(input.archive, { ...input.source, entries: input.source.entries.map(entry => ({ ...entry, bytes: Buffer.from('{"value":999}') })) })
  if (kind === 'signature') writeArchiveFileV1(input.archive, { ...input.source, signatureBytes: Buffer.from('{}') })
  if (kind === 'archive') fs.writeFileSync(input.archive, 'not a zip')
  expect(() => importResourceProject(input)).toThrow()
  expect(fs.readdirSync(input.parent)).toEqual([])
})

it('requires a matching complete base for a patch, then imports the resolved content', () => {
  const input = fixture()
  const base = resolveProfileV1({ base: { source: input.source, policy: contentPolicyForChannelV1('local-dev') } })
  fs.writeFileSync(path.join(input.request.sourceDir, 'data/maps/map.json'), '{"value":2}')
  const patch = path.join(input.root, 'patch.rvbpack')
  const patchSource = buildPackSourceV1({ ...input.request, mode: 'patch', version: '0.0.2', parentProfileHash: base.profile.resolvedProfileHash, operations: [{ op: 'replace', targetPath: 'data/maps/map.json', sourcePath: 'data/maps/map.json', expectedHash: createHash('sha256').update('{"value":1}').digest('hex') }] })
  writeArchiveFileV1(patch, patchSource)
  expect(importResourceProject({ ...input, archive: patch })).toEqual({ needsBase: true })
  expect(fs.readdirSync(input.parent)).toEqual([])
  const wrongBase = path.join(input.root, 'wrong.rvbpack')
  writeArchiveFileV1(wrongBase, buildPackSourceV1(input.request))
  expect(() => importResourceProject({ ...input, archive: patch, baseArchive: wrongBase })).toThrow()
  expect(fs.readdirSync(input.parent)).toEqual([])
  const result = importResourceProject({ ...input, archive: patch, baseArchive: input.archive })
  if (result.needsBase) throw new Error('expected resolved import')
  expect(JSON.parse(fs.readFileSync(path.join(result.root, 'data/maps/map.json'), 'utf8')).value).toBe(2)
  expect(new CreativeWorkbench(result.root, input.root).inspect(result.taskId).changes).toEqual([])
})
