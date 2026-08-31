import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { sha256HexV1 } from '../core/hash'
import { createBundledBasePackInputV1 } from '../runtime/bundled-base'
import { readArchiveFileV1, writeArchiveFileV1 } from './archive'
import type {
  ContentToolingReportV1,
  ContentToolingResultV1,
} from './contracts'
import { runContentPipelineCliV1 } from './cli'

const PIXEL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f0001040100b51c0c020000000049454e44ae426082',
  'hex',
)
const PVE_NODE_PATH = 'data/pve/campaigns/prototype/nodes/victory-ending.json'
const FIXED_SEED = 0x1170cafe

function readCliResult(
  evidenceRoot: string,
  exitCode: number,
  expectedOperation: string | undefined,
): ContentToolingResultV1 {
  const taskRoot = path.join(evidenceRoot, 'RED-118')
  const runDirectories = readdirSync(taskRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
  if (runDirectories.length !== 1) {
    throw new Error(`CLI operation wrote ${runDirectories.length} report directories`)
  }
  const reportPath = path.join(taskRoot, runDirectories[0]!.name, 'report.json')
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ContentToolingReportV1
  if (
    report.schemaVersion !== 'rvb-content-report/v1'
    || report.taskId !== 'RED-118'
    || report.caller !== 'cli'
    || report.operation !== expectedOperation
    || report.exitCode !== exitCode
    || (report.status === 'PASS') !== (exitCode === 0)
  ) {
    throw new Error(`CLI operation produced an invalid report: ${reportPath}`)
  }
  return Object.freeze({ ok: exitCode === 0, exitCode, report, reportPath })
}

function renderCandidateMarkdown(summary: Record<string, unknown>): string {
  return [
    '# RED-118 Windows content candidate',
    '',
    `- Status: **${summary.status}**`,
    `- Bundled Base: ${summary.baseProfileHash}`,
    `- Image patch Profile: ${summary.imageProfileHash}`,
    `- Final Profile: ${summary.finalProfileHash}`,
    `- Authority content: ${summary.authorityContentHash}`,
    `- QA key: ${summary.qaKeyId}`,
    `- Rotated/community key: ${summary.rotatedKeyId}`,
    `- Tamper refusal: ${summary.tamperRefusal}`,
    `- Stable refusal: ${summary.stableRefusal}`,
    `- Fixed seed: ${summary.seed}`,
    `- Terminal outcome: ${summary.terminalOutcome}`,
    `- Final Run hash: ${summary.finalRunHash}`,
    '',
    'Temporary private keys were created outside the evidence tree and removed.',
    '',
  ].join('\n')
}

export async function runContentCandidateV1(
  appRootInput: string,
  evidenceRootInput: string,
): Promise<number> {
  const appRoot = path.resolve(appRootInput)
  const evidenceRoot = path.resolve(evidenceRootInput)
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '')
  const runRoot = path.join(evidenceRoot, 'RED-118', `${timestamp}-content-candidate`)
  const fixtureRoot = path.join(runRoot, 'fixtures')
  const artifactRoot = path.join(runRoot, 'artifacts')
  const secretRoot = mkdtempSync(path.join(tmpdir(), 'rvb-red118-keys-'))
  const cliReportPaths: string[] = []
  let cliOperationIndex = 0
  mkdirSync(fixtureRoot, { recursive: true })
  mkdirSync(artifactRoot, { recursive: true })

  const runCli = async (
    label: string,
    argv: readonly string[],
  ): Promise<ContentToolingResultV1> => {
    cliOperationIndex += 1
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    const cliEvidenceRoot = path.join(
      runRoot,
      'cli-reports',
      `${String(cliOperationIndex).padStart(2, '0')}-${slug}`,
    )
    const exitCode = await runContentPipelineCliV1(argv, { appRoot, evidenceRoot: cliEvidenceRoot })
    const result = readCliResult(cliEvidenceRoot, exitCode, argv[0])
    cliReportPaths.push(result.reportPath)
    return result
  }

  const requirePass = async (
    label: string,
    argv: readonly string[],
  ): Promise<ContentToolingResultV1> => {
    const result = await runCli(label, argv)
    if (!result.ok) {
      throw new Error(`${label} failed: ${result.report.refusal?.code ?? result.exitCode}`)
    }
    return result
  }

  try {
    const qaKeyFile = path.join(secretRoot, 'qa.key')
    const communityKeyFile = path.join(secretRoot, 'community.key')
    writeFileSync(qaKeyFile, `${'31'.repeat(32)}\n`, 'utf8')
    writeFileSync(communityKeyFile, `${'72'.repeat(32)}\n`, 'utf8')

    const bundledInput = createBundledBasePackInputV1(appRoot)
    const baseResolve = await requirePass('bundled Base resolve', [
      'resolve', 'RED-118',
      '--base', 'bundled',
      '--channel', 'local-dev',
    ])
    const baseProfileHash = baseResolve.report.identity.resolvedProfileHash
    if (!baseProfileHash) throw new Error('Bundled Base CLI resolve did not return a Profile hash')
    const imageSource = path.join(fixtureRoot, 'image-patch')
    const imagePayload = path.join(imageSource, 'images', 'red-118', 'pixel.png')
    mkdirSync(path.dirname(imagePayload), { recursive: true })
    writeFileSync(imagePayload, PIXEL_PNG)
    const imageUnsigned = path.join(artifactRoot, 'image-patch-unsigned.rvbpack')
    const imageSigned = path.join(artifactRoot, 'image-patch-qa.rvbpack')
    const imageOperations = [{
      op: 'add',
      targetPath: 'images/red-118/pixel.png',
      sourcePath: 'images/red-118/pixel.png',
    }]
    const imageOperationsFile = path.join(fixtureRoot, 'image-patch-operations.json')
    writeFileSync(imageOperationsFile, `${JSON.stringify(imageOperations, null, 2)}\n`, 'utf8')
    const imageBuildContract = {
      mode: 'patch' as const,
      packageId: 'red-118-image-patch',
      version: '1.0.0',
      displayName: 'RED-118 image patch',
      description: 'Windows candidate raster patch',
      publisherId: 'red-118-candidate',
      parentProfileHash: baseProfileHash,
      operations: imageOperations,
      capabilities: ['raster-assets'],
    }
    const imageBuild = await requirePass('image patch build', [
      'build', 'RED-118', 'patch',
      '--source', imageSource,
      '--output', imageUnsigned,
      '--package-id', imageBuildContract.packageId,
      '--version', imageBuildContract.version,
      '--display-name', imageBuildContract.displayName,
      '--description', imageBuildContract.description,
      '--publisher-id', imageBuildContract.publisherId,
      '--parent-profile-hash', imageBuildContract.parentProfileHash,
      '--operations-file', imageOperationsFile,
      '--capabilities', imageBuildContract.capabilities.join(','),
    ])
    const imageSign = await requirePass('image patch QA sign', [
      'sign', 'RED-118',
      '--input', imageUnsigned,
      '--output', imageSigned,
      '--key-file', qaKeyFile,
      '--channel', 'qa',
    ])
    const qaKeyId = imageSign.report.identity.publisherKeyId
    if (!qaKeyId) throw new Error('QA signing did not return a publisher key ID')
    await requirePass('image patch QA validate', [
      'validate', 'RED-118',
      '--archive', imageSigned,
      '--base', 'bundled',
      '--channel', 'qa',
      '--trusted-key-id', qaKeyId,
    ])
    const imageResolve = await requirePass('image patch resolve', [
      'resolve', 'RED-118',
      '--base', 'bundled',
      '--patch', imageSigned,
      '--channel', 'qa',
      '--trusted-key-id', qaKeyId,
    ])
    const imageProfileHash = imageResolve.report.identity.resolvedProfileHash
    if (!imageProfileHash) throw new Error('Image Patch CLI resolve did not return a Profile hash')
    const pveEntry = bundledInput.source.entries.find(entry => entry.path === PVE_NODE_PATH)
    if (!pveEntry) throw new Error('Bundled Prototype PVE node is missing')
    const pveBytes = pveEntry.bytes
    const pveExpectedHash = sha256HexV1(pveBytes)
    const pveSource = path.join(fixtureRoot, 'pve-node-patch')
    const pvePayload = path.join(pveSource, ...PVE_NODE_PATH.split('/'))
    mkdirSync(path.dirname(pvePayload), { recursive: true })
    writeFileSync(pvePayload, Buffer.concat([Buffer.from(pveBytes), Buffer.from('\n')]))
    const pveUnsigned = path.join(artifactRoot, 'pve-node-patch-unsigned.rvbpack')
    const pveSigned = path.join(artifactRoot, 'pve-node-patch-qa.rvbpack')
    const pveOperations = [{
      op: 'replace',
      targetPath: PVE_NODE_PATH,
      sourcePath: PVE_NODE_PATH,
      expectedHash: pveExpectedHash,
    }]
    const pveOperationsFile = path.join(fixtureRoot, 'pve-node-patch-operations.json')
    writeFileSync(pveOperationsFile, `${JSON.stringify(pveOperations, null, 2)}\n`, 'utf8')
    const pveBuildContract = {
      mode: 'patch' as const,
      packageId: 'red-118-pve-node-patch',
      version: '1.0.0',
      displayName: 'RED-118 PVE node patch',
      description: 'Windows candidate Prototype node byte replacement',
      publisherId: 'red-118-candidate',
      parentProfileHash: imageProfileHash,
      operations: pveOperations,
      capabilities: ['pve-content'],
    }
    const pveBuild = await requirePass('PVE node patch build', [
      'build', 'RED-118', 'patch',
      '--source', pveSource,
      '--output', pveUnsigned,
      '--package-id', pveBuildContract.packageId,
      '--version', pveBuildContract.version,
      '--display-name', pveBuildContract.displayName,
      '--description', pveBuildContract.description,
      '--publisher-id', pveBuildContract.publisherId,
      '--parent-profile-hash', pveBuildContract.parentProfileHash,
      '--operations-file', pveOperationsFile,
      '--capabilities', pveBuildContract.capabilities.join(','),
    ])
    const pveSign = await requirePass('PVE node patch QA sign', [
      'sign', 'RED-118',
      '--input', pveUnsigned,
      '--output', pveSigned,
      '--key-file', qaKeyFile,
      '--channel', 'qa',
    ])
    await requirePass('PVE node patch QA validate', [
      'validate', 'RED-118',
      '--archive', pveSigned,
      '--base', 'bundled',
      '--patch', imageSigned,
      '--channel', 'qa',
      '--trusted-key-id', qaKeyId,
    ])
    const finalResolve = await requirePass('final QA resolve', [
      'resolve', 'RED-118',
      '--base', 'bundled',
      '--patch', imageSigned,
      '--patch', pveSigned,
      '--channel', 'qa',
      '--trusted-key-id', qaKeyId,
    ])
    const smoke = await requirePass('fixed-seed patched Profile PVE smoke', [
      'smoke', 'RED-118',
      '--base', 'bundled',
      '--patch', imageSigned,
      '--patch', pveSigned,
      '--seed', String(FIXED_SEED),
      '--channel', 'qa',
      '--trusted-key-id', qaKeyId,
    ])
    if (smoke.report.identity.resolvedProfileHash !== finalResolve.report.identity.resolvedProfileHash) {
      throw new Error('PVE smoke did not execute the final resolved Profile')
    }

    const tampered = path.join(artifactRoot, 'pve-node-patch-tampered.rvbpack')
    const tamperedSource = readArchiveFileV1(pveSigned)
    writeArchiveFileV1(tampered, {
      ...tamperedSource,
      entries: tamperedSource.entries.map(entry => entry.path === PVE_NODE_PATH
        ? { ...entry, bytes: Uint8Array.from(entry.bytes, (value, index) => index === 0 ? value ^ 1 : value) }
        : entry),
    })
    const tamperResult = await runCli('tampered patch refusal', [
      'resolve', 'RED-118',
      '--base', 'bundled',
      '--patch', imageSigned,
      '--patch', tampered,
      '--channel', 'qa',
      '--trusted-key-id', qaKeyId,
    ])
    if (tamperResult.ok) throw new Error('Tampered candidate was accepted')

    const rotated = path.join(artifactRoot, 'pve-node-patch-community.rvbpack')
    const rotationSign = await requirePass('community key rotation sign', [
      'sign', 'RED-118',
      '--input', pveUnsigned,
      '--output', rotated,
      '--key-file', communityKeyFile,
      '--channel', 'community',
    ])
    const communityKeyId = rotationSign.report.identity.publisherKeyId
    if (!communityKeyId) throw new Error('Community signing did not return a publisher key ID')
    await requirePass('community key rotation resolve', [
      'resolve', 'RED-118',
      '--base', 'bundled',
      '--patch', imageSigned,
      '--patch', rotated,
      '--channel', 'community',
      '--trusted-key-id', qaKeyId,
      '--trusted-key-id', communityKeyId,
    ])
    if (rotationSign.report.identity.publisherKeyId === pveSign.report.identity.publisherKeyId) {
      throw new Error('Key rotation did not change publisherKeyId')
    }

    const stableRefusal = await runCli('stable confirmation refusal', [
      'resolve', 'RED-118',
      '--base', 'bundled',
      '--patch', imageSigned,
      '--patch', pveSigned,
      '--channel', 'stable',
    ])
    if (stableRefusal.ok || stableRefusal.report.refusal?.code !== 'STABLE_CONFIRMATION_REQUIRED') {
      throw new Error('Stable channel did not require manual confirmation')
    }

    const summary = {
      schemaVersion: 'rvb-red-118-candidate/v1',
      status: 'PASS',
      baseProfileHash,
      imageProfileHash: imageResolve.report.identity.resolvedProfileHash,
      finalProfileHash: finalResolve.report.identity.resolvedProfileHash,
      authorityContentHash: finalResolve.report.identity.authorityContentHash,
      engineAbi: finalResolve.report.identity.engineAbi,
      contentAbi: finalResolve.report.identity.contentAbi,
      smokeProfileHash: smoke.report.identity.resolvedProfileHash,
      imagePackageHash: imageSign.report.identity.packageHash,
      imageUnsignedPackageHash: imageBuild.report.identity.packageHash,
      pvePackageHash: pveSign.report.identity.packageHash,
      pveUnsignedPackageHash: pveBuild.report.identity.packageHash,
      qaKeyId,
      rotatedKeyId: communityKeyId,
      tamperRefusal: tamperResult.report.refusal?.code,
      stableRefusal: stableRefusal.report.refusal?.code,
      seed: FIXED_SEED,
      terminalOutcome: smoke.report.smoke?.terminalOutcome,
      terminalResult: smoke.report.smoke?.terminalResult,
      finalRunHash: smoke.report.smoke?.finalRunHash,
      cliReportPaths,
      fixtureHashes: {
        image: sha256HexV1(PIXEL_PNG),
        pveNode: sha256HexV1(new Uint8Array(readFileSync(pvePayload))),
      },
      fixture: {
        image: {
          sourceDir: imageSource,
          unsignedArchive: imageUnsigned,
          signedArchive: imageSigned,
          build: imageBuildContract,
        },
        pve: {
          sourceDir: pveSource,
          unsignedArchive: pveUnsigned,
          signedArchive: pveSigned,
          build: pveBuildContract,
        },
      },
      secretMaterialPersisted: false,
    }
    writeFileSync(path.join(runRoot, 'candidate.json'), `${JSON.stringify(summary, null, 2)}\n`)
    writeFileSync(path.join(runRoot, 'candidate.md'), renderCandidateMarkdown(summary))
    writeFileSync(
      path.join(evidenceRoot, 'RED-118', 'content-candidate-latest.json'),
      `${JSON.stringify({
        ...summary,
        schemaVersion: 'rvb-red-118-candidate-pointer/v1',
        candidateReport: path.join(runRoot, 'candidate.json'),
      }, null, 2)}\n`,
      'utf8',
    )
    console.log(`[RVB content] candidate PASS report=${path.join(runRoot, 'candidate.md')}`)
    return 0
  } finally {
    rmSync(secretRoot, { recursive: true, force: true })
  }
}
