import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { readProfileArchiveV1 } from '@/lib/content-pipeline/runtime/profile-archive'
import { createBundledBasePackInputV1 } from '@/lib/content-pipeline/runtime/bundled-base'
import { resolveProfileV1 } from '@/lib/content-pipeline/core/resolver'
import { runContentPipelineOperationV1 } from '@/lib/content-pipeline/tooling'
import { runContentPipelineCliV1 } from '@/lib/content-pipeline/tooling/cli'
import {
  EditorContentOperationQueueV1,
  normalizeEditorContentOperationRequestV1,
  resolveEditorDataDirectoryV1,
  resolveEditorDataFilePathV1,
} from '@/electron-editor/content-pipeline-ipc'

const root = path.resolve(__dirname, '..', '..')

function fixtureRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeSnapshotSource(rootDir: string): void {
  const dataDir = path.join(rootDir, 'data', 'maps')
  const imageDir = path.join(rootDir, 'images', 'fixture')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(imageDir, { recursive: true })
  writeFileSync(path.join(dataDir, 'fixture.json'), '{"name":"fixture","value":1}\n')
  writeFileSync(path.join(imageDir, 'pixel.png'), Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f0001040100b51c0c020000000049454e44ae426082',
    'hex',
  ))
}

function buildRequest(temp: string, sourceDir: string, outputArchive: string, compressionLevel: number) {
  return {
    schemaVersion: 'rvb-content-operation/v1' as const,
    operation: 'build' as const,
    caller: 'cli' as const,
    taskId: 'RED-118',
    channel: 'local-dev' as const,
    appRoot: root,
    evidenceRoot: path.join(temp, 'evidence'),
    command: { name: 'build', args: ['snapshot', '<source>', '<output>'] },
    mode: 'snapshot' as const,
    sourceDir,
    outputArchive,
    compressionLevel,
    packageId: 'red-118-fixture',
    version: '1.0.0',
    displayName: 'RED-118 Fixture',
    description: 'deterministic fixture',
    publisherId: 'red-118-author',
  }
}

describe('RED-118 content pipeline tooling', () => {
  it('drives candidate operations and identity through persisted CLI reports', () => {
    const candidateSource = readFileSync(
      path.join(root, 'lib', 'content-pipeline', 'tooling', 'candidate.ts'),
      'utf8',
    )

    expect(candidateSource).toContain('runContentPipelineCliV1')
    expect(candidateSource).toContain("path.join(taskRoot, runDirectories[0]!.name, 'report.json')")
    expect(candidateSource).toContain('cliReportPaths')
    expect(candidateSource).not.toContain('runContentPipelineOperationV1')
    expect(candidateSource).not.toContain('resolveProfileV1')
  })

  it('builds deterministic canonical manifests across absolute roots and ZIP settings', async () => {
    const temp = fixtureRoot('rvb-red118-build-')
    try {
      const sourceA = path.join(temp, 'absolute-a', 'source')
      const sourceB = path.join(temp, 'different', 'absolute-b', 'source')
      writeSnapshotSource(sourceA)
      writeSnapshotSource(sourceB)
      const archiveA = path.join(temp, 'a.rvbpack')
      const archiveB = path.join(temp, 'b.rvbpack')

      const first = await runContentPipelineOperationV1(buildRequest(temp, sourceA, archiveA, 0))
      const second = await runContentPipelineOperationV1(buildRequest(temp, sourceB, archiveB, 9))

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(first.report.identity.packageHash).toBe(second.report.identity.packageHash)
      expect(Buffer.from(readProfileArchiveV1(readFileSync(archiveA)).manifestBytes))
        .toEqual(Buffer.from(readProfileArchiveV1(readFileSync(archiveB)).manifestBytes))
      expect(first.report.identity.capabilities).toEqual(['game-data', 'raster-assets'])
      expect(first.report.identity.signature).toBe('unsigned-dev-only')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('uses the same operation core for Editor requests and rejects arbitrary execution fields', async () => {
    const temp = fixtureRoot('rvb-red118-editor-')
    try {
      const workspace = path.join(temp, 'workspace')
      const source = path.join(workspace, 'sources', 'fixture')
      writeSnapshotSource(source)
      const raw = {
        operation: 'build',
        taskId: 'RED-118',
        channel: 'local-dev',
        mode: 'snapshot',
        source: 'sources/fixture',
        output: 'archives/editor.rvbpack',
        packageId: 'red-118-fixture',
        version: '1.0.0',
        displayName: 'RED-118 Fixture',
        description: 'deterministic fixture',
        publisherId: 'red-118-author',
        compressionLevel: 6,
      }
      const normalized = normalizeEditorContentOperationRequestV1(workspace, root, raw)
      const result = await runContentPipelineOperationV1(normalized)

      expect(result.ok).toBe(true)
      expect(result.report.caller).toBe('editor')
      expect(result.report.identity.packageHash).toMatch(/^[0-9a-f]{64}$/)
      expect(() => normalizeEditorContentOperationRequestV1(workspace, root, {
        ...raw,
        executable: 'powershell.exe',
        script: 'evil.ps1',
        argv: ['-Command', 'whoami'],
      })).toThrowError(/EDITOR_REQUEST_INVALID/)
      expect(() => normalizeEditorContentOperationRequestV1(workspace, root, {
        ...raw,
        source: '../outside',
      })).toThrowError(/EDITOR_PATH_INVALID/)

      const outside = path.join(temp, 'outside')
      writeSnapshotSource(outside)
      const junction = path.join(workspace, 'sources', 'junction-outside')
      symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => normalizeEditorContentOperationRequestV1(workspace, root, {
        ...raw,
        source: 'sources/junction-outside',
      })).toThrowError(/EDITOR_PATH_INVALID/)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('serializes Editor operations and rejects an unbounded pending queue', async () => {
    const queue = new EditorContentOperationQueueV1(2)
    const order: string[] = []
    let releaseFirst!: () => void
    const first = queue.enqueue(async () => {
      order.push('first-start')
      await new Promise<void>(resolve => { releaseFirst = resolve })
      order.push('first-end')
      return 1
    })
    const second = queue.enqueue(async () => {
      order.push('second')
      return 2
    })
    await expect(queue.enqueue(async () => 3)).rejects.toThrow('EDITOR_CONTENT_QUEUE_FULL')
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('rejects junction escapes from legacy Editor data IPC paths', () => {
    const temp = fixtureRoot('rvb-red118-data-ipc-')
    try {
      const dataRoot = path.join(temp, 'workspace', 'data')
      const outside = path.join(temp, 'outside')
      mkdirSync(dataRoot, { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}\n')
      const junction = path.join(dataRoot, 'pieces')
      symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')

      expect(() => resolveEditorDataDirectoryV1(dataRoot, 'pieces'))
        .toThrowError(/EDITOR_PATH_INVALID/)
      expect(() => resolveEditorDataFilePathV1(dataRoot, 'pieces', 'secret.json'))
        .toThrowError(/EDITOR_PATH_INVALID/)
      expect(() => resolveEditorDataFilePathV1(dataRoot, 'pieces', 'secret.json', 'write'))
        .toThrowError(/EDITOR_PATH_INVALID/)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('writes a standard secret-free report for CLI usage failures', async () => {
    const temp = fixtureRoot('rvb-red118-usage-')
    try {
      const exitCode = await runContentPipelineCliV1(
        ['build', 'RED-118', 'snapshot', '--key-file', 'C:\\secret\\stable.key'],
        { appRoot: root, evidenceRoot: path.join(temp, 'evidence') },
      )
      expect(exitCode).toBe(2)
      const taskRoot = path.join(temp, 'evidence', 'RED-118')
      const runDirectories = readdirSync(taskRoot)
      expect(runDirectories).toHaveLength(1)
      const report = JSON.parse(readFileSync(
        path.join(taskRoot, runDirectories[0], 'report.json'),
        'utf8',
      ))
      expect(report).toMatchObject({
        status: 'REFUSED',
        exitCode: 2,
        refusal: { code: 'TOOLING_INVALID_ARGUMENT', stage: 'request' },
        command: { args: ['<invalid-arguments>'] },
      })
      expect(JSON.stringify(report)).not.toContain('stable.key')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('signs through an explicit key file, validates external policy, and keeps reports secret-free', async () => {
    const temp = fixtureRoot('rvb-red118-sign-')
    try {
      const source = path.join(temp, 'source')
      writeSnapshotSource(source)
      const unsignedArchive = path.join(temp, 'unsigned.rvbpack')
      const signedArchive = path.join(temp, 'signed.rvbpack')
      const keyFile = path.join(temp, 'qa-private.key')
      const secretHex = '11'.repeat(32)
      writeFileSync(keyFile, `${secretHex}\n`, 'utf8')

      const built = await runContentPipelineOperationV1(buildRequest(temp, source, unsignedArchive, 6))
      expect(built.ok).toBe(true)

      const signed = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'sign',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'qa',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'sign', args: ['<archive>', '--key-file', '<redacted>', '<output>'] },
        inputArchive: unsignedArchive,
        outputArchive: signedArchive,
        keyFile,
      })
      expect(signed.ok).toBe(true)
      expect(signed.report.identity.signature).toBe('signed')
      expect(signed.report.identity.publisherKeyId).toMatch(/^[0-9a-f]{64}$/)
      const qaKeyId = signed.report.identity.publisherKeyId!

      const validated = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'validate',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'qa',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'validate', args: ['<archive>'] },
        archive: signedArchive,
        trustedPublisherKeyIds: [qaKeyId],
      })
      expect(validated.ok).toBe(true)

      const reportText = readFileSync(signed.reportPath, 'utf8')
      expect(reportText).not.toContain(secretHex)
      expect(reportText).not.toContain(keyFile)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('runs the fixed-seed Prototype through formal terminalResult, reward, and end', async () => {
    const temp = fixtureRoot('rvb-red118-smoke-')
    try {
      const result = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'smoke',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'local-dev',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'smoke', args: ['--base', 'bundled', '--seed', '292604670'] },
        base: { kind: 'bundled' },
        patches: [],
        seed: 0x1170cafe,
      })

      expect(result.ok, JSON.stringify(result.report.refusal)).toBe(true)
      expect(result.report.smoke).toMatchObject({
        terminalOutcome: 'victory',
        terminalResult: {
          status: 'finished',
          winnerPlayerId: 'player-red',
        },
        endNodeId: 'victory-ending',
        endOutcome: 'completed',
      })
      expect(result.report.smoke?.finalRunHash).toMatch(/^[0-9a-f]{64}$/)
      expect(result.report.seed).toBe(0x1170cafe)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the installed patched Profile active until fixed-seed PVE reaches end', async () => {
    const temp = fixtureRoot('rvb-red118-patched-smoke-')
    try {
      const bundled = resolveProfileV1({ base: createBundledBasePackInputV1(root) })
      const targetPath = 'data/pve/campaigns/prototype/nodes/victory-ending.json'
      const descriptor = bundled.files.find(file => file.path === targetPath)
      const original = bundled.readFile(targetPath)
      expect(descriptor).toBeDefined()
      expect(original).toBeDefined()

      const sourceDir = path.join(temp, 'source')
      const sourceFile = path.join(sourceDir, ...targetPath.split('/'))
      mkdirSync(path.dirname(sourceFile), { recursive: true })
      writeFileSync(sourceFile, Buffer.concat([Buffer.from(original!), Buffer.from('\n')]))
      const unsignedArchive = path.join(temp, 'patch-unsigned.rvbpack')
      const signedArchive = path.join(temp, 'patch-qa.rvbpack')
      const keyFile = path.join(temp, 'qa.key')
      writeFileSync(keyFile, `${'19'.repeat(32)}\n`, 'utf8')

      const built = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'build',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'local-dev',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'build', args: ['patch', '<source>', '<output>'] },
        mode: 'patch',
        sourceDir,
        outputArchive: unsignedArchive,
        packageId: 'red-118-pve-smoke-patch',
        version: '1.0.0',
        displayName: 'RED-118 patched PVE smoke',
        publisherId: 'red-118-author',
        parentProfileHash: bundled.profile.resolvedProfileHash,
        capabilities: ['pve-content'],
        operations: [{
          op: 'replace',
          targetPath,
          sourcePath: targetPath,
          expectedHash: descriptor!.sha256,
        }],
      })
      expect(built.ok, JSON.stringify(built.report.refusal)).toBe(true)

      const signed = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'sign',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'qa',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'sign', args: ['<input>', '<redacted>', '<output>'] },
        inputArchive: unsignedArchive,
        outputArchive: signedArchive,
        keyFile,
      })
      expect(signed.ok, JSON.stringify(signed.report.refusal)).toBe(true)
      const qaKeyId = signed.report.identity.publisherKeyId!

      const missingContext = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'validate',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'qa',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'validate', args: ['<patch>'] },
        archive: signedArchive,
        trustedPublisherKeyIds: [qaKeyId],
      })
      expect(missingContext.ok).toBe(false)
      expect(missingContext.report.refusal).toMatchObject({
        code: 'PATCH_CONTEXT_REQUIRED',
        packId: 'red-118-pve-smoke-patch',
      })

      const validated = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'validate',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'qa',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'validate', args: ['<patch>', '--base', 'bundled'] },
        archive: signedArchive,
        base: { kind: 'bundled' },
        patches: [],
        trustedPublisherKeyIds: [qaKeyId],
      })
      expect(validated.ok, JSON.stringify(validated.report.refusal)).toBe(true)
      expect(validated.report.identity).toMatchObject({
        publisherKeyId: qaKeyId,
        engineAbi: 'rvb-engine/v1',
        contentAbi: 'rvb-content/v1',
      })

      const untrustedPublisher = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'validate',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'qa',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'validate', args: ['<patch>', '--base', 'bundled'] },
        archive: signedArchive,
        base: { kind: 'bundled' },
        patches: [],
        trustedPublisherKeyIds: ['0'.repeat(64)],
      })
      expect(untrustedPublisher.ok).toBe(false)
      expect(untrustedPublisher.report.refusal).toMatchObject({
        code: 'PUBLISHER_NOT_TRUSTED',
        packId: 'red-118-pve-smoke-patch',
      })

      const stableWithoutTrust = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'validate',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'stable',
        stableConfirmed: true,
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'validate', args: ['<patch>', '--base', 'bundled'] },
        archive: signedArchive,
        base: { kind: 'bundled' },
        patches: [],
      })
      expect(stableWithoutTrust.ok).toBe(false)
      expect(stableWithoutTrust.report.refusal?.code).toBe('TRUST_POLICY_REQUIRED')

      const smoked = await runContentPipelineOperationV1({
        schemaVersion: 'rvb-content-operation/v1',
        operation: 'smoke',
        caller: 'cli',
        taskId: 'RED-118',
        channel: 'qa',
        appRoot: root,
        evidenceRoot: path.join(temp, 'evidence'),
        command: { name: 'smoke', args: ['<patched-profile>', '--seed', '292604670'] },
        base: { kind: 'bundled' },
        patches: [signedArchive],
        trustedPublisherKeyIds: [qaKeyId],
        seed: 0x1170cafe,
      })

      expect(smoked.ok, JSON.stringify(smoked.report.refusal)).toBe(true)
      expect(smoked.report.smoke?.resolvedProfileHash)
        .toBe(smoked.report.identity.resolvedProfileHash)
      expect(smoked.report.smoke).toMatchObject({
        terminalOutcome: 'victory',
        endNodeId: 'victory-ending',
        endOutcome: 'completed',
        rewardSubjectId: 'holy-heal',
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the legacy builder as a deprecated thin wrapper over canonical CLI output', () => {
    const temp = fixtureRoot('rvb-red118-legacy-')
    try {
      const source = path.join(temp, 'source')
      writeSnapshotSource(source)
      const canonicalArchive = path.join(temp, 'canonical.rvbpack')
      const legacyArchive = path.join(temp, 'legacy.rvbpack')
      const shared = [
        '--source', source,
        '--package-id', 'red-118-legacy-fixture',
        '--version', '1.0.0',
        '--publisher-id', 'red-118-author',
      ]
      const canonical = spawnSync(process.execPath, [
        path.join(root, 'scripts', 'rvb.mjs'),
        'build', 'RED-118', 'snapshot',
        ...shared,
        '--display-name', 'Legacy Fixture',
        '--output', canonicalArchive,
      ], { cwd: root, encoding: 'utf8' })
      const legacy = spawnSync(process.execPath, [
        path.join(root, 'scripts', 'build-resource-pack.js'),
        '--task', 'RED-118',
        ...shared,
        '--name', 'Legacy Fixture',
        '--output', legacyArchive,
      ], { cwd: root, encoding: 'utf8' })

      expect(canonical.status, canonical.stderr).toBe(0)
      expect(legacy.status, legacy.stderr).toBe(0)
      expect(legacy.stderr).toContain('deprecated')
      expect(Buffer.from(readProfileArchiveV1(readFileSync(canonicalArchive)).manifestBytes))
        .toEqual(Buffer.from(readProfileArchiveV1(readFileSync(legacyArchive)).manifestBytes))
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 30_000)
})
