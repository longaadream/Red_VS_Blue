export const CONTENT_PIPELINE_ERROR_CODES_V1 = [
  'PACK_SCHEMA_INVALID',
  'PACK_PATH_INVALID',
  'PACK_PATH_COLLISION',
  'PACK_BUDGET_EXCEEDED',
  'PACK_FILE_MISSING',
  'PACK_FILE_UNDECLARED',
  'PACK_SIZE_MISMATCH',
  'PACK_HASH_MISMATCH',
  'PACK_MEDIA_TYPE_INVALID',
  'PACK_ABI_UNSUPPORTED',
  'PACK_SIGNATURE_REQUIRED',
  'PACK_SIGNATURE_INVALID',
  'PACK_PUBLISHER_KEY_MISMATCH',
  'PACK_CAPABILITY_MISMATCH',
  'PACK_FORBIDDEN_EXECUTABLE_CONTENT',
  'PACK_REFERENCE_INVALID',
  'PATCH_PARENT_MISMATCH',
  'PATCH_PRECONDITION_FAILED',
  'PATCH_OPERATION_CONFLICT',
  'PROFILE_HASH_MISMATCH',
  'AUTHORITY_CONTENT_HASH_MISMATCH',
  'CANDIDATE_CHECK_FAILED',
] as const

export type ContentPipelineErrorCodeV1 =
  (typeof CONTENT_PIPELINE_ERROR_CODES_V1)[number]

export const CONTENT_PIPELINE_STAGES_V1 = [
  'source',
  'manifest',
  'compatibility',
  'signature',
  'inventory',
  'content',
  'capability',
  'reference',
  'patch',
  'profile',
  'candidate-check',
] as const

export type ContentPipelineStageV1 =
  (typeof CONTENT_PIPELINE_STAGES_V1)[number]

export interface ContentPipelineErrorContextV1 {
  readonly packId?: string
  readonly path?: string
  readonly contentId?: string
}

function displayContextValue(value: string): string {
  return JSON.stringify(value)
}

export class ContentPipelineErrorV1 extends Error {
  readonly code: ContentPipelineErrorCodeV1
  readonly stage: ContentPipelineStageV1
  readonly packId?: string
  readonly path?: string
  readonly contentId?: string

  constructor(
    code: ContentPipelineErrorCodeV1,
    stage: ContentPipelineStageV1,
    context: ContentPipelineErrorContextV1 = {},
  ) {
    const details = [
      context.packId === undefined
        ? null
        : `pack=${displayContextValue(context.packId)}`,
      context.path === undefined
        ? null
        : `path=${displayContextValue(context.path)}`,
      context.contentId === undefined
        ? null
        : `content=${displayContextValue(context.contentId)}`,
    ].filter((value): value is string => value !== null)
    super(`[content-pipeline:${stage}] ${code}${details.length > 0 ? ` ${details.join(' ')}` : ''}`)
    this.name = 'ContentPipelineErrorV1'
    this.code = code
    this.stage = stage
    this.packId = context.packId
    this.path = context.path
    this.contentId = context.contentId
  }
}

export const CONTENT_PIPELINE_LIMITS_V1 = Object.freeze({
  maxEntries: 2_048,
  maxFileBytes: 16 * 1_024 * 1_024,
  maxTotalBytes: 128 * 1_024 * 1_024,
  maxManifestBytes: 16 * 1_024 * 1_024,
  maxSignatureBytes: 16 * 1_024,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000,
  maxJsonStringBytes: 1 * 1_024 * 1_024,
})
