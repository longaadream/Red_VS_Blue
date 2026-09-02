import type { PackCapabilityV1 } from '../contracts'

export const CONTENT_OPERATION_SCHEMA_VERSION_V1 = 'rvb-content-operation/v1' as const
export const CONTENT_REPORT_SCHEMA_VERSION_V1 = 'rvb-content-report/v1' as const

export type ContentToolingChannelV1 = 'local-dev' | 'qa' | 'stable' | 'community'
export type ContentToolingCallerV1 = 'cli' | 'editor'

export interface ContentToolingCommandV1 {
  readonly name: string
  readonly args: readonly string[]
}

interface ContentOperationCommonV1 {
  readonly schemaVersion: typeof CONTENT_OPERATION_SCHEMA_VERSION_V1
  readonly caller: ContentToolingCallerV1
  readonly taskId: string
  readonly channel: ContentToolingChannelV1
  readonly appRoot: string
  readonly evidenceRoot: string
  readonly command: ContentToolingCommandV1
  readonly stableConfirmed?: boolean
  readonly trustedPublisherKeyIds?: readonly string[]
}

export interface BuildContentOperationV1 extends ContentOperationCommonV1 {
  readonly operation: 'build'
  readonly mode: 'snapshot' | 'patch'
  readonly sourceDir: string
  readonly outputArchive: string
  readonly compressionLevel?: number
  readonly packageId: string
  readonly version: string
  readonly displayName: string
  readonly description?: string
  readonly publisherId: string
  readonly parentProfileHash?: string
  readonly operations?: readonly unknown[]
  readonly capabilities?: readonly PackCapabilityV1[]
}

export interface SignContentOperationV1 extends ContentOperationCommonV1 {
  readonly operation: 'sign'
  readonly inputArchive: string
  readonly outputArchive: string
  readonly keyFile: string
}

export interface ValidateContentOperationV1 extends ContentOperationCommonV1 {
  readonly operation: 'validate'
  readonly archive: string
  readonly base?: ContentBaseReferenceV1
  readonly patches?: readonly string[]
}

export type ContentBaseReferenceV1 =
  | Readonly<{ kind: 'bundled' }>
  | Readonly<{ kind: 'archive'; archive: string }>

export interface ResolveContentOperationV1 extends ContentOperationCommonV1 {
  readonly operation: 'resolve'
  readonly base: ContentBaseReferenceV1
  readonly patches: readonly string[]
}

export interface SmokeContentOperationV1 extends ContentOperationCommonV1 {
  readonly operation: 'smoke'
  readonly base: ContentBaseReferenceV1
  readonly patches: readonly string[]
  readonly seed: number
}

export type ContentPipelineOperationV1 =
  | BuildContentOperationV1
  | SignContentOperationV1
  | ValidateContentOperationV1
  | ResolveContentOperationV1
  | SmokeContentOperationV1

export interface ContentToolingIdentityV1 {
  readonly packageHash: string | null
  readonly publisherKeyId: string | null
  readonly signature: 'signed' | 'unsigned-dev-only' | null
  readonly capabilities: readonly PackCapabilityV1[]
  readonly resolvedProfileHash: string | null
  readonly authorityContentHash: string | null
  readonly engineAbi: string | null
  readonly contentAbi: string | null
}

export interface ContentToolingRefusalV1 {
  readonly code: string
  readonly stage: string
  readonly message: string
  readonly packId?: string
  readonly path?: string
  readonly contentId?: string
}

export interface ContentToolingSmokeV1 {
  readonly resolvedProfileHash: string
  readonly authorityContentHash: string
  readonly battleStateHash: string
  readonly terminalOutcome: 'victory' | 'defeat' | 'draw'
  readonly terminalResult: unknown
  readonly terminalResultHash: string
  readonly endNodeId: string
  readonly endOutcome: string
  readonly rewardSubjectId: string
  readonly finalRunHash: string
}

export interface ContentToolingReportV1 {
  readonly schemaVersion: typeof CONTENT_REPORT_SCHEMA_VERSION_V1
  readonly taskId: string
  readonly operation: ContentPipelineOperationV1['operation'] | 'usage'
  readonly caller: ContentToolingCallerV1
  readonly channel: ContentToolingChannelV1
  readonly status: 'PASS' | 'REFUSED' | 'FAIL'
  readonly exitCode: number
  readonly startedAt: string
  readonly finishedAt: string
  readonly command: ContentToolingCommandV1
  readonly identity: ContentToolingIdentityV1
  readonly seed: number | null
  readonly smoke: ContentToolingSmokeV1 | null
  readonly refusal: ContentToolingRefusalV1 | null
}

export type ContentToolingResultV1 = Readonly<{
  ok: boolean
  exitCode: number
  report: ContentToolingReportV1
  reportPath: string
}>

export class ContentToolingRefusalErrorV1 extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    message: string,
    readonly exitCode = 3,
    readonly context: Readonly<{
      packId?: string
      path?: string
      contentId?: string
    }> = {},
  ) {
    super(message)
    this.name = 'ContentToolingRefusalErrorV1'
  }
}
