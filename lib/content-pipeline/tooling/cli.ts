import { readFileSync } from 'node:fs'
import path from 'node:path'

import type {
  BuildContentOperationV1,
  ContentBaseReferenceV1,
  ContentPipelineOperationV1,
  ContentToolingChannelV1,
} from './contracts'
import {
  runContentPipelineOperationV1,
  writeContentPipelineUsageFailureV1,
} from './operation'

export interface ContentCliEnvironmentV1 {
  readonly appRoot: string
  readonly evidenceRoot: string
}

class ContentCliUsageErrorV1 extends Error {}

interface ParsedOptionsV1 {
  readonly values: Map<string, string[]>
  readonly flags: Set<string>
}

const CHANNELS = new Set<ContentToolingChannelV1>([
  'local-dev', 'qa', 'stable', 'community',
])

function parseOptions(
  args: readonly string[],
  booleanFlags: ReadonlySet<string> = new Set(),
): ParsedOptionsV1 {
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (!option.startsWith('--')) throw new ContentCliUsageErrorV1(`Unexpected argument: ${option}`)
    if (booleanFlags.has(option)) {
      if (flags.has(option)) throw new ContentCliUsageErrorV1(`Duplicate flag: ${option}`)
      flags.add(option)
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new ContentCliUsageErrorV1(`${option} requires a value.`)
    }
    const current = values.get(option) ?? []
    current.push(value)
    values.set(option, current)
    index += 1
  }
  return { values, flags }
}

function one(
  parsed: ParsedOptionsV1,
  option: string,
  required = false,
): string | undefined {
  const values = parsed.values.get(option) ?? []
  if (values.length > 1) throw new ContentCliUsageErrorV1(`${option} may be provided only once.`)
  if (required && values.length === 0) throw new ContentCliUsageErrorV1(`${option} is required.`)
  return values[0]
}

function ensureKnown(parsed: ParsedOptionsV1, allowed: ReadonlySet<string>): void {
  for (const option of parsed.values.keys()) {
    if (!allowed.has(option)) throw new ContentCliUsageErrorV1(`Unknown option: ${option}`)
  }
  for (const option of parsed.flags) {
    if (!allowed.has(option)) throw new ContentCliUsageErrorV1(`Unknown option: ${option}`)
  }
}

function channel(parsed: ParsedOptionsV1, fallback: ContentToolingChannelV1) {
  const selected = (one(parsed, '--channel') ?? fallback) as ContentToolingChannelV1
  if (!CHANNELS.has(selected)) throw new ContentCliUsageErrorV1(`Unsupported channel: ${selected}`)
  return selected
}

function absolute(root: string, value: string): string {
  return path.resolve(root, value)
}

function common<TOperation extends ContentPipelineOperationV1['operation']>(
  operation: TOperation,
  taskId: string,
  parsed: ParsedOptionsV1,
  environment: ContentCliEnvironmentV1,
  fallbackChannel: ContentToolingChannelV1,
) {
  const normalizedTask = taskId.toUpperCase()
  if (!/^RED-\d+$/.test(normalizedTask)) {
    throw new ContentCliUsageErrorV1('Task ID must use RED-<number>.')
  }
  return {
    schemaVersion: 'rvb-content-operation/v1' as const,
    operation,
    caller: 'cli' as const,
    taskId: normalizedTask,
    channel: channel(parsed, fallbackChannel),
    appRoot: path.resolve(environment.appRoot),
    evidenceRoot: one(parsed, '--evidence-root')
      ? absolute(environment.appRoot, one(parsed, '--evidence-root')!)
      : path.resolve(environment.evidenceRoot),
    stableConfirmed: parsed.flags.has('--confirm-stable'),
    trustedPublisherKeyIds: parsed.values.get('--trusted-key-id') ?? [],
  }
}

function baseReference(root: string, value: string | undefined): ContentBaseReferenceV1 {
  if (!value || value === 'bundled') return { kind: 'bundled' }
  return { kind: 'archive', archive: absolute(root, value) }
}

function parseRequest(
  argv: readonly string[],
  environment: ContentCliEnvironmentV1,
): ContentPipelineOperationV1 {
  const [operation, taskId, modeOrOption, ...tail] = argv
  if (!operation || !taskId) throw new ContentCliUsageErrorV1('Operation and task ID are required.')
  const commonFlags = new Set(['--confirm-stable'])

  if (operation === 'build') {
    const mode = modeOrOption
    if (mode !== 'snapshot' && mode !== 'patch') {
      throw new ContentCliUsageErrorV1('Build mode must be snapshot or patch.')
    }
    const parsed = parseOptions(tail, commonFlags)
    ensureKnown(parsed, new Set([
      '--source', '--output', '--package-id', '--version', '--display-name',
      '--description', '--publisher-id', '--compression-level', '--channel',
      '--evidence-root', '--confirm-stable', '--parent-profile-hash',
      '--operations-file', '--capabilities',
      '--trusted-key-id',
    ]))
    const source = one(parsed, '--source', true)!
    const output = one(parsed, '--output', true)!
    const operationsFile = one(parsed, '--operations-file')
    const capabilities = one(parsed, '--capabilities')
    return {
      ...common(operation, taskId, parsed, environment, 'local-dev'),
      command: {
        name: 'build',
        args: [mode, '--source', '<source>', '--output', '<output>'],
      },
      mode,
      sourceDir: absolute(environment.appRoot, source),
      outputArchive: absolute(environment.appRoot, output),
      compressionLevel: Number(one(parsed, '--compression-level') ?? 6),
      packageId: one(parsed, '--package-id', true)!,
      version: one(parsed, '--version', true)!,
      displayName: one(parsed, '--display-name', true)!,
      description: one(parsed, '--description'),
      publisherId: one(parsed, '--publisher-id', true)!,
      parentProfileHash: one(parsed, '--parent-profile-hash'),
      operations: operationsFile
        ? JSON.parse(readFileSync(absolute(environment.appRoot, operationsFile), 'utf8'))
        : undefined,
      capabilities: capabilities
        ? capabilities.split(',').filter(Boolean) as BuildContentOperationV1['capabilities']
        : undefined,
    } as ContentPipelineOperationV1
  }

  const rest = modeOrOption === undefined ? [] : [modeOrOption, ...tail]
  const parsed = parseOptions(rest, commonFlags)
  if (operation === 'sign') {
    ensureKnown(parsed, new Set([
      '--input', '--output', '--key-file', '--channel', '--evidence-root', '--confirm-stable',
      '--trusted-key-id',
    ]))
    return {
      ...common(operation, taskId, parsed, environment, 'qa'),
      command: {
        name: 'sign',
        args: ['<input>', '--key-file', '<redacted>', '--output', '<output>'],
      },
      inputArchive: absolute(environment.appRoot, one(parsed, '--input', true)!),
      outputArchive: absolute(environment.appRoot, one(parsed, '--output', true)!),
      keyFile: absolute(environment.appRoot, one(parsed, '--key-file', true)!),
    }
  }
  if (operation === 'validate') {
    ensureKnown(parsed, new Set([
      '--archive', '--base', '--patch', '--channel', '--evidence-root',
      '--confirm-stable', '--trusted-key-id',
    ]))
    const baseValue = one(parsed, '--base')
    return {
      ...common(operation, taskId, parsed, environment, 'local-dev'),
      command: { name: 'validate', args: ['<archive>'] },
      archive: absolute(environment.appRoot, one(parsed, '--archive', true)!),
      base: baseValue ? baseReference(environment.appRoot, baseValue) : undefined,
      patches: (parsed.values.get('--patch') ?? [])
        .map(value => absolute(environment.appRoot, value)),
    }
  }
  if (operation === 'resolve' || operation === 'smoke') {
    ensureKnown(parsed, new Set([
      '--base', '--patch', '--seed', '--channel', '--evidence-root', '--confirm-stable',
      '--trusted-key-id',
    ]))
    const shared = {
      base: baseReference(environment.appRoot, one(parsed, '--base')),
      patches: (parsed.values.get('--patch') ?? []).map(value => absolute(environment.appRoot, value)),
    }
    if (operation === 'resolve') {
      return {
        ...common('resolve', taskId, parsed, environment, 'local-dev'),
        ...shared,
        command: { name: 'resolve', args: ['<base>', '<patch-chain>'] },
      }
    }
    return {
      ...common('smoke', taskId, parsed, environment, 'local-dev'),
      ...shared,
      command: { name: 'smoke', args: ['<base>', '<patch-chain>', '--seed', '<seed>'] },
      seed: Number(one(parsed, '--seed') ?? 0x1170cafe),
    }
  }
  throw new ContentCliUsageErrorV1(`Unknown content operation: ${operation}`)
}

export async function runContentPipelineCliV1(
  argv: readonly string[],
  environment: ContentCliEnvironmentV1,
): Promise<number> {
  let request: ContentPipelineOperationV1
  try {
    request = parseRequest(argv, environment)
  } catch (error) {
    const message = error instanceof ContentCliUsageErrorV1
      ? error.message
      : 'Could not parse content CLI arguments or option files.'
    const failure = writeContentPipelineUsageFailureV1({
      argv,
      evidenceRoot: environment.evidenceRoot,
      message,
    })
    console.error(`[RVB content] ${message}`)
    console.error(`[RVB content] report=${failure.reportPath}`)
    return failure.exitCode
  }
  const result = await runContentPipelineOperationV1(request)
  const identity = result.report.identity
  const output = result.ok ? console.log : console.error
  output(`[RVB content] ${result.report.status} ${request.operation}`)
  if (identity.packageHash) output(`[RVB content] packageHash=${identity.packageHash}`)
  if (identity.resolvedProfileHash) {
    output(`[RVB content] resolvedProfileHash=${identity.resolvedProfileHash}`)
    output(`[RVB content] authorityContentHash=${identity.authorityContentHash}`)
  }
  if (result.report.refusal) {
    output(`[RVB content] ${result.report.refusal.code}: ${result.report.refusal.message}`)
  }
  output(`[RVB content] report=${result.reportPath}`)
  return result.exitCode
}
