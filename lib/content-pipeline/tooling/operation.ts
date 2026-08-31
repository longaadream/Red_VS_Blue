import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  PackManifestV1Schema,
  PackSignatureEnvelopeV1Schema,
  type PackManifestV1,
} from '../contracts'
import { canonicalJsonBytesV1 } from '../core/canonical-json'
import { ContentPipelineErrorV1 } from '../core/error-codes'
import { computePackageHashV1, decodeLowerHexV1 } from '../core/hash'
import { resolveProfileV1, type ResolvePackInputV1, type ResolvedSnapshotViewV1 } from '../core/resolver'
import {
  deriveEd25519PublicKeyV1,
  derivePublisherKeyIdV1,
  signPackageHashV1,
} from '../core/signature'
import type { ContentPackSourceV1 } from '../core/source'
import {
  createBundledBasePackInputV1,
  createBundledBaseProfileV1,
} from '../runtime/bundled-base'
import { ProfileStoreV1 } from '../runtime/profile-store'
import { getGameProfileErrorPayloadV1 } from '../runtime/profile-game-identity'
import type { BattleState } from '@/lib/game/turn'
import type { PveServiceV1, PvePublicRunViewV1 } from '@/lib/pve/service'

import {
  buildPackSourceV1,
  contentPolicyForChannelV1,
  parseArchiveManifestV1,
  readArchiveFileV1,
  validateArchiveSourceV1,
  writeArchiveFileV1,
} from './archive'
import {
  CONTENT_REPORT_SCHEMA_VERSION_V1,
  ContentToolingRefusalErrorV1,
  type ContentPipelineOperationV1,
  type ContentToolingIdentityV1,
  type ContentToolingRefusalV1,
  type ContentToolingReportV1,
  type ContentToolingResultV1,
  type ContentToolingSmokeV1,
  type ResolveContentOperationV1,
  type SmokeContentOperationV1,
  type ValidateContentOperationV1,
} from './contracts'

const EMPTY_IDENTITY: ContentToolingIdentityV1 = Object.freeze({
  packageHash: null,
  publisherKeyId: null,
  signature: null,
  capabilities: Object.freeze([]),
  resolvedProfileHash: null,
  authorityContentHash: null,
  engineAbi: null,
  contentAbi: null,
})

function assertOperationPolicy(request: ContentPipelineOperationV1): void {
  if (request.channel === 'stable' && request.stableConfirmed !== true) {
    throw new ContentToolingRefusalErrorV1(
      'STABLE_CONFIRMATION_REQUIRED',
      'policy',
      'Stable operations require an explicit manual confirmation.',
    )
  }
  if (!/^RED-\d+$/.test(request.taskId)) {
    throw new ContentToolingRefusalErrorV1(
      'TOOLING_INVALID_ARGUMENT',
      'request',
      'Task ID must use RED-<number>.',
      2,
    )
  }
  const trusted = request.trustedPublisherKeyIds ?? []
  if (trusted.some(keyId => !/^[0-9a-f]{64}$/.test(keyId))) {
    throw new ContentToolingRefusalErrorV1(
      'TOOLING_INVALID_ARGUMENT',
      'request',
      'Trusted publisher key IDs must be lowercase SHA-256 values.',
      2,
    )
  }
  if (
    request.channel !== 'local-dev'
    && (request.operation === 'validate'
      || request.operation === 'resolve'
      || request.operation === 'smoke')
    && trusted.length === 0
  ) {
    throw new ContentToolingRefusalErrorV1(
      'TRUST_POLICY_REQUIRED',
      'policy',
      `${request.channel} validation requires at least one explicit trusted publisher key ID.`,
    )
  }
}

function identityFromPack(
  validated: ReturnType<typeof validateArchiveSourceV1>,
): ContentToolingIdentityV1 {
  return {
    packageHash: validated.packageHash,
    publisherKeyId: validated.signatureEnvelope?.keyId ?? null,
    signature: validated.signatureEnvelope ? 'signed' : 'unsigned-dev-only',
    capabilities: validated.capabilities,
    resolvedProfileHash: null,
    authorityContentHash: null,
    engineAbi: validated.manifest.compatibility.engineAbi,
    contentAbi: validated.manifest.compatibility.contentAbi,
  }
}

function identityFromUnsignedSource(source: ContentPackSourceV1): ContentToolingIdentityV1 {
  const manifest = parseArchiveManifestV1(source)
  return {
    packageHash: computePackageHashV1(manifest),
    publisherKeyId: null,
    signature: 'unsigned-dev-only',
    capabilities: manifest.capabilities,
    resolvedProfileHash: null,
    authorityContentHash: null,
    engineAbi: manifest.compatibility.engineAbi,
    contentAbi: manifest.compatibility.contentAbi,
  }
}

function identityFromProfile(
  snapshot: ResolvedSnapshotViewV1,
  publisherKeyId: string | null,
): ContentToolingIdentityV1 {
  return {
    packageHash: snapshot.profile.patches.at(-1)?.packageHash
      ?? snapshot.profile.base.packageHash,
    publisherKeyId,
    signature: snapshot.networkEligible ? 'signed' : 'unsigned-dev-only',
    capabilities: snapshot.profile.capabilities,
    resolvedProfileHash: snapshot.profile.resolvedProfileHash,
    authorityContentHash: snapshot.profile.authorityContentHash,
    engineAbi: snapshot.profile.compatibility.engineAbi,
    contentAbi: snapshot.profile.compatibility.contentAbi,
  }
}

function packInput(
  archive: string,
  channel: ContentPipelineOperationV1['channel'],
): ResolvePackInputV1 {
  return {
    source: readArchiveFileV1(archive),
    policy: contentPolicyForChannelV1(channel),
  }
}

function publisherKeyIdOfSource(source: ContentPackSourceV1): string | null {
  if (!source.signatureBytes) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(source.signatureBytes)
    return PackSignatureEnvelopeV1Schema.parse(JSON.parse(text)).keyId
  } catch {
    return null
  }
}

function assertTrustedSources(
  request: ContentPipelineOperationV1,
  sources: readonly ContentPackSourceV1[],
): void {
  if (request.channel === 'local-dev') return
  const trusted = new Set(request.trustedPublisherKeyIds ?? [])
  for (const source of sources) {
    const manifest = parseArchiveManifestV1(source)
    const keyId = publisherKeyIdOfSource(source)
    if (!keyId || !trusted.has(keyId)) {
      throw new ContentToolingRefusalErrorV1(
        'PUBLISHER_NOT_TRUSTED',
        'policy',
        'The package publisher is not trusted for the selected channel.',
        3,
        { packId: manifest.packageId },
      )
    }
  }
}

function resolveReferences(
  request: ContentPipelineOperationV1,
  baseReference: ResolveContentOperationV1['base'],
  patchArchives: readonly string[],
): Readonly<{ snapshot: ResolvedSnapshotViewV1; publisherKeyId: string | null }> {
  const base = baseReference.kind === 'bundled'
    ? createBundledBasePackInputV1(request.appRoot)
    : packInput(baseReference.archive, request.channel)
  const patches = patchArchives.map(archive => packInput(archive, request.channel))
  const snapshot = resolveProfileV1({
    base,
    patches,
  })
  const externalSources = [
    ...(baseReference.kind === 'archive' ? [base.source] : []),
    ...patches.map(patch => patch.source),
  ]
  assertTrustedSources(request, externalSources)
  return {
    snapshot,
    publisherKeyId: externalSources.length > 0
      ? publisherKeyIdOfSource(externalSources.at(-1)!)
      : null,
  }
}

function resolveSnapshot(request: ResolveContentOperationV1 | SmokeContentOperationV1) {
  return resolveReferences(request, request.base, request.patches)
}

function validateArchive(
  request: ValidateContentOperationV1,
): ReturnType<typeof validateArchiveSourceV1> {
  const source = readArchiveFileV1(request.archive)
  const manifest = parseArchiveManifestV1(source)
  if (manifest.kind === 'snapshot') {
    const validated = validateArchiveSourceV1(source, request.channel)
    assertTrustedSources(request, [source])
    return validated
  }
  if (!request.base) {
    throw new ContentToolingRefusalErrorV1(
      'PATCH_CONTEXT_REQUIRED',
      'request',
      'Patch validation requires --base and any preceding --patch entries.',
      2,
      { packId: manifest.packageId },
    )
  }
  const parent = resolveReferences(
    request,
    request.base,
    request.patches ?? [],
  ).snapshot
  const validated = validateArchiveSourceV1(source, request.channel, { parent })
  assertTrustedSources(request, [source])
  return validated
}

function rewriteForPublisher(
  source: ContentPackSourceV1,
  keyId: string,
): { manifest: PackManifestV1; source: ContentPackSourceV1 } {
  const original = parseArchiveManifestV1(source)
  const manifest = PackManifestV1Schema.parse({
    ...original,
    publisher: { ...original.publisher, keyId },
  })
  return {
    manifest,
    source: {
      manifestBytes: canonicalJsonBytesV1(manifest),
      signatureBytes: null,
      entries: source.entries,
    },
  }
}

type PveCommandInputV1 = Parameters<PveServiceV1['execute']>[1]

function pveCommand(
  view: PvePublicRunViewV1,
  commandId: string,
  type: string,
  parameters: Readonly<Record<string, unknown>> = {},
): PveCommandInputV1 {
  return {
    ...parameters,
    schemaVersion: 'rvb-pve-command/v1',
    runId: view.runId,
    commandId,
    expectedRevision: view.revision,
    type,
  } as PveCommandInputV1
}

async function runPveSmokeV1(
  snapshot: ResolvedSnapshotViewV1,
  seed: number,
  appRoot: string,
): Promise<ContentToolingSmokeV1> {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new ContentToolingRefusalErrorV1(
      'TOOLING_INVALID_ARGUMENT',
      'smoke',
      'Smoke seed must be an unsigned 32-bit integer.',
      2,
    )
  }
  const needsInstalledRuntime = snapshot.profile.base.packageId !== 'rvb.bundled-base'
    || snapshot.profile.patches.length > 0
  if (!needsInstalledRuntime) return executePveSmokeFlowV1(snapshot, seed)

  const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'rvb-content-smoke-runtime-'))
  const bundled = createBundledBaseProfileV1(appRoot)
  const runtimeStore = new ProfileStoreV1({
    rootDir: path.join(runtimeRoot, 'resource-pack'),
    bundledBase: bundled,
  })
  if (snapshot.profile.resolvedProfileHash !== bundled.profile.resolvedProfileHash) {
    const candidate = runtimeStore.installCandidate(snapshot)
    const activation = runtimeStore.beginActivation(candidate.resolvedProfileHash)
    runtimeStore.commitActivation(activation.activationId, candidate.resolvedProfileHash)
  }
  const activeReference = runtimeStore.readState().stable
  const previousContext = globalThis.__rvbProfileRuntimeContextV1
  const environmentNames = [
    'APP_ROOT_DIR',
    'USER_DATA_DIR',
    'RVB_PROFILE_ROOT',
    'RVB_RESOLVED_PROFILE_HASH',
    'RVB_AUTHORITY_CONTENT_HASH',
    'RVB_PROFILE_ENGINE_ABI',
    'RVB_PROFILE_CONTENT_ABI',
    'RVB_PROFILE_ACTIVATION_ID',
  ] as const
  const previousEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]))
  try {
    return await executePveSmokeFlowV1(snapshot, seed, () => {
      process.env.APP_ROOT_DIR = path.resolve(appRoot)
      process.env.USER_DATA_DIR = runtimeRoot
      for (const name of environmentNames.slice(2)) delete process.env[name]
      process.env.RVB_PROFILE_ROOT = runtimeStore.profileRoot(activeReference) ?? path.resolve(appRoot)
      process.env.RVB_RESOLVED_PROFILE_HASH = activeReference.resolvedProfileHash
      process.env.RVB_AUTHORITY_CONTENT_HASH = activeReference.authorityContentHash
      process.env.RVB_PROFILE_ENGINE_ABI = activeReference.compatibility.engineAbi
      process.env.RVB_PROFILE_CONTENT_ABI = activeReference.compatibility.contentAbi
      globalThis.__rvbProfileRuntimeContextV1 = {
        appRoot: path.resolve(appRoot),
        userDataDir: runtimeRoot,
        store: runtimeStore,
      }
    })
  } finally {
    globalThis.__rvbProfileRuntimeContextV1 = previousContext
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
}

async function executePveSmokeFlowV1(
  snapshot: ResolvedSnapshotViewV1,
  seed: number,
  beforeRuntimeLoad: () => void = () => undefined,
): Promise<ContentToolingSmokeV1> {
  beforeRuntimeLoad()
  const [flowRunner, prototypeRegistry, runStore, serviceModule] = await Promise.all([
    import('@/lib/pve/flow-runner'),
    import('@/lib/pve/prototype-registry'),
    import('@/lib/pve/run-store'),
    import('@/lib/pve/service'),
  ])
  const { hashPveRunV1 } = flowRunner
  const { createPrototypePveRegistryV1 } = prototypeRegistry
  const { MemoryPveRunStoreV1 } = runStore
  const { PveServiceV1 } = serviceModule
  if (process.env.RVB_RESOLVED_PROFILE_HASH) {
    const runtime = await import('../runtime/profile-runtime')
    const active = runtime.getRuntimeProfileReferenceV1()
    if (active.resolvedProfileHash !== process.env.RVB_RESOLVED_PROFILE_HASH) {
      throw new ContentToolingRefusalErrorV1(
        'PROFILE_RUNTIME_BIND_FAILED',
        'smoke',
        'The isolated smoke runtime did not bind the requested Profile.',
      )
    }
  }
  const store = new MemoryPveRunStoreV1()
  const service = new PveServiceV1({
    store,
    openVerifiedSnapshot: () => snapshot,
    createRegistry: createPrototypePveRegistryV1,
    createRunId: () => `content-smoke-${seed.toString(16)}`,
    createRootSeed: () => seed,
  })
  let current = service.createRun('prototype-campaign')
  current = await service.execute(current.view.runId, pveCommand(
    current.view, 'smoke-roster', 'roster-select',
  ))
  current = await service.execute(current.view.runId, pveCommand(
    current.view, 'smoke-story', 'story-continue',
  ))
  current = await service.execute(current.view.runId, pveCommand(
    current.view, 'smoke-event', 'event-choose', { choiceId: 'rest' },
  ))
  current = await service.execute(current.view.runId, pveCommand(
    current.view, 'smoke-start', 'battle-start',
  ))
  const settled = await service.execute(current.view.runId, pveCommand(
    current.view,
    'smoke-battle',
    'battle-action',
    { action: { type: 'surrender', playerId: 'player-blue', reason: 'voluntary' } },
  ))
  const finished = await service.execute(settled.view.runId, pveCommand(
    settled.view, 'smoke-reward', 'reward-claim', { subjectId: 'holy-heal' },
  ))
  const stored = store.get(finished.view.runId)
  const terminalResult = (stored?.battleState?.state as BattleState | undefined)?.terminalResult
  const terminalOutcome = settled.battleAudit?.terminalOutcome
  const terminalResultHash = settled.battleAudit?.terminalResultHash
  if (
    !stored
    || !settled.battleAudit
    || !terminalOutcome
    || !terminalResult
    || !terminalResultHash
    || finished.view.node.type !== 'end'
  ) {
    throw new ContentToolingRefusalErrorV1(
      'PVE_SMOKE_INCOMPLETE',
      'smoke',
      'The fixed-seed PVE run did not reach the formal terminal path.',
    )
  }
  return {
    resolvedProfileHash: snapshot.profile.resolvedProfileHash,
    authorityContentHash: stored.run.authorityContentHash,
    battleStateHash: settled.battleAudit.stateHash,
    terminalOutcome,
    terminalResult,
    terminalResultHash,
    endNodeId: finished.view.node.nodeId,
    endOutcome: finished.view.node.outcome,
    rewardSubjectId: 'holy-heal',
    finalRunHash: hashPveRunV1(stored.run),
  }
}

function redactMessage(message: string, request: ContentPipelineOperationV1): string {
  const sensitive = request.operation === 'sign' ? [request.keyFile] : []
  return sensitive.reduce(
    (result, value) => result.split(value).join('<redacted>'),
    message,
  )
}

function refusalFor(error: unknown, request: ContentPipelineOperationV1): {
  refusal: ContentToolingRefusalV1
  exitCode: number
  status: 'REFUSED' | 'FAIL'
} {
  if (error instanceof ContentToolingRefusalErrorV1) {
    return {
      refusal: {
        code: error.code,
        stage: error.stage,
        message: redactMessage(error.message, request),
        ...error.context,
      },
      exitCode: error.exitCode,
      status: 'REFUSED',
    }
  }
  if (error instanceof ContentPipelineErrorV1) {
    return {
      refusal: {
        code: error.code,
        stage: error.stage,
        message: error.message,
        ...(error.packId ? { packId: error.packId } : {}),
        ...(error.path ? { path: error.path } : {}),
        ...(error.contentId ? { contentId: error.contentId } : {}),
      },
      exitCode: 3,
      status: 'REFUSED',
    }
  }
  const profileFailure = getGameProfileErrorPayloadV1(error)
  if (profileFailure) {
    const context = profileFailure.context
    return {
      refusal: {
        code: profileFailure.code,
        stage: request.operation,
        message: profileFailure.message,
        ...(typeof context.packId === 'string' ? { packId: context.packId } : {}),
        ...(typeof context.path === 'string' ? { path: context.path } : {}),
        ...(typeof context.contentId === 'string' ? { contentId: context.contentId } : {}),
      },
      exitCode: 3,
      status: 'REFUSED',
    }
  }
  return {
    refusal: {
      code: 'TOOLING_OPERATION_FAILED',
      stage: request.operation,
      message: redactMessage(
        error instanceof Error ? error.message : 'Unknown tooling failure.',
        request,
      ),
    },
    exitCode: 1,
    status: 'FAIL',
  }
}

function reportDirectory(
  evidenceRoot: string,
  taskId: string,
  operation: ContentToolingReportV1['operation'],
  startedAt: Date,
): string {
  const timestamp = startedAt.toISOString().replace(/[-:.]/g, '')
  return path.join(
    path.resolve(evidenceRoot),
    taskId,
    `${timestamp}-${operation}-${process.pid}-${randomUUID()}`,
  )
}

function renderMarkdown(report: ContentToolingReportV1): string {
  const identity = report.identity
  return [
    '# RVB content pipeline report',
    '',
    `- Status: **${report.status}**`,
    `- Task / operation: ${report.taskId} / ${report.operation}`,
    `- Caller / channel: ${report.caller} / ${report.channel}`,
    `- Exit code: ${report.exitCode}`,
    `- Package hash: ${identity.packageHash ?? '-'}`,
    `- Publisher key ID: ${identity.publisherKeyId ?? '-'}`,
    `- Signature: ${identity.signature ?? '-'}`,
    `- Capabilities: ${identity.capabilities.join(', ') || '-'}`,
    `- Resolved Profile hash: ${identity.resolvedProfileHash ?? '-'}`,
    `- Authority content hash: ${identity.authorityContentHash ?? '-'}`,
    `- Engine ABI: ${identity.engineAbi ?? '-'}`,
    `- Content ABI: ${identity.contentAbi ?? '-'}`,
    `- Seed: ${report.seed ?? '-'}`,
    `- Refusal: ${report.refusal ? `${report.refusal.code} (${report.refusal.stage})` : '-'}`,
    `- Refusal pack: ${report.refusal?.packId ?? '-'}`,
    `- Refusal path: ${report.refusal?.path ?? '-'}`,
    `- Refusal content: ${report.refusal?.contentId ?? '-'}`,
    '',
  ].join('\n')
}

function writeReport(
  request: ContentPipelineOperationV1,
  startedAt: Date,
  report: ContentToolingReportV1,
): string {
  const directory = reportDirectory(
    request.evidenceRoot,
    request.taskId,
    request.operation,
    startedAt,
  )
  return writeReportFiles(directory, report)
}

function writeReportFiles(
  directory: string,
  report: ContentToolingReportV1,
): string {
  mkdirSync(directory, { recursive: true })
  const reportPath = path.join(directory, 'report.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(directory, 'report.md'), renderMarkdown(report), 'utf8')
  return reportPath
}

export function writeContentPipelineUsageFailureV1(input: Readonly<{
  argv: readonly string[]
  evidenceRoot: string
  message: string
}>): ContentToolingResultV1 {
  const startedAt = new Date()
  const taskIdCandidate = input.argv[1]?.toUpperCase()
  const taskId = taskIdCandidate && /^RED-\d+$/.test(taskIdCandidate)
    ? taskIdCandidate
    : 'RED-UNKNOWN'
  const operationCandidate = input.argv[0]
  const operation = (
    operationCandidate === 'build'
    || operationCandidate === 'sign'
    || operationCandidate === 'validate'
    || operationCandidate === 'resolve'
    || operationCandidate === 'smoke'
  ) ? operationCandidate : 'usage'
  const report: ContentToolingReportV1 = {
    schemaVersion: CONTENT_REPORT_SCHEMA_VERSION_V1,
    taskId,
    operation,
    caller: 'cli',
    channel: 'local-dev',
    status: 'REFUSED',
    exitCode: 2,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    command: { name: operationCandidate ?? 'content', args: ['<invalid-arguments>'] },
    identity: EMPTY_IDENTITY,
    seed: null,
    smoke: null,
    refusal: {
      code: 'TOOLING_INVALID_ARGUMENT',
      stage: 'request',
      message: input.message,
    },
  }
  const directory = reportDirectory(input.evidenceRoot, taskId, operation, startedAt)
  const reportPath = writeReportFiles(directory, report)
  return Object.freeze({ ok: false, exitCode: 2, report, reportPath })
}

export async function runContentPipelineOperationV1(
  request: ContentPipelineOperationV1,
): Promise<ContentToolingResultV1> {
  const startedAt = new Date()
  let identity = EMPTY_IDENTITY
  let smoke: ContentToolingSmokeV1 | null = null
  let refusal: ContentToolingRefusalV1 | null = null
  let exitCode = 0
  let status: ContentToolingReportV1['status'] = 'PASS'

  try {
    assertOperationPolicy(request)
    switch (request.operation) {
      case 'build': {
        const source = buildPackSourceV1(request)
        identity = request.mode === 'snapshot'
          ? identityFromPack(validateArchiveSourceV1(source, request.channel))
          : identityFromUnsignedSource(source)
        writeArchiveFileV1(request.outputArchive, source, request.compressionLevel)
        break
      }
      case 'sign': {
        if (request.channel === 'local-dev') {
          throw new ContentToolingRefusalErrorV1(
            'SIGNING_CHANNEL_INVALID',
            'policy',
            'Local Dev artifacts must remain unsigned and dev-only.',
          )
        }
        const keyText = readFileSync(request.keyFile, 'utf8').trim()
        const secretKey = decodeLowerHexV1(keyText, 32)
        try {
          const publicKey = deriveEd25519PublicKeyV1(secretKey)
          const keyId = derivePublisherKeyIdV1(publicKey)
          const rewritten = rewriteForPublisher(readArchiveFileV1(request.inputArchive), keyId)
          const packageHash = computePackageHashV1(rewritten.manifest)
          const envelope = signPackageHashV1(packageHash, secretKey)
          const signedSource = {
            ...rewritten.source,
            signatureBytes: canonicalJsonBytesV1(envelope),
          }
          writeArchiveFileV1(request.outputArchive, signedSource)
          identity = rewritten.manifest.kind === 'snapshot'
            ? identityFromPack(validateArchiveSourceV1(signedSource, request.channel))
            : {
              packageHash,
              publisherKeyId: envelope.keyId,
              signature: 'signed',
              capabilities: rewritten.manifest.capabilities,
              resolvedProfileHash: null,
              authorityContentHash: null,
              engineAbi: rewritten.manifest.compatibility.engineAbi,
              contentAbi: rewritten.manifest.compatibility.contentAbi,
            }
        } finally {
          secretKey.fill(0)
        }
        break
      }
      case 'validate': {
        identity = identityFromPack(validateArchive(request))
        break
      }
      case 'resolve': {
        const resolved = resolveSnapshot(request)
        identity = identityFromProfile(resolved.snapshot, resolved.publisherKeyId)
        break
      }
      case 'smoke': {
        const resolved = resolveSnapshot(request)
        identity = identityFromProfile(resolved.snapshot, resolved.publisherKeyId)
        smoke = await runPveSmokeV1(resolved.snapshot, request.seed, request.appRoot)
        break
      }
    }
  } catch (error) {
    const failure = refusalFor(error, request)
    refusal = failure.refusal
    exitCode = failure.exitCode
    status = failure.status
  }

  const report: ContentToolingReportV1 = {
    schemaVersion: CONTENT_REPORT_SCHEMA_VERSION_V1,
    taskId: request.taskId,
    operation: request.operation,
    caller: request.caller,
    channel: request.channel,
    status,
    exitCode,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    command: request.command,
    identity,
    seed: request.operation === 'smoke' ? request.seed : null,
    smoke,
    refusal,
  }
  const reportPath = writeReport(request, startedAt, report)
  return Object.freeze({ ok: exitCode === 0, exitCode, report, reportPath })
}
