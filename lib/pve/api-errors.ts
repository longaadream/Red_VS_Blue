import { parseStrictJsonBytesV1 } from '@/lib/content-pipeline/core/json-safety'
import { ProfileStoreErrorV1 } from '@/lib/content-pipeline/runtime/profile-store'

import { PveBattleAdapterErrorV1 } from './battle-adapter'
import { PveContentSnapshotErrorV1 } from './content-snapshot'
import { PveFlowRunnerErrorV1 } from './flow-runner'
import { PveRunStoreErrorV1 } from './run-store'
import { PveRuntimeRegistryErrorV1 } from './runtime-registry'
import { PveServiceErrorV1 } from './service'

export function pveApiErrorV1(error: unknown): Response {
  if (error instanceof ProfileStoreErrorV1) {
    return errorResponse(
      'PVE_SNAPSHOT_UNAVAILABLE',
      'Active verified Snapshot is unavailable',
      503,
      { profileErrorCode: error.code },
    )
  }
  if (error instanceof PveServiceErrorV1) {
    return errorResponse(error.code, error.message, error.status, error.context)
  }
  if (error instanceof PveBattleAdapterErrorV1) {
    return errorResponse(error.code, error.message, error.status)
  }
  if (error instanceof PveFlowRunnerErrorV1) {
    const status = error.code === 'PVE_COMMAND_INVALID'
      || error.code === 'PVE_COMMAND_RUN_MISMATCH'
      ? 400
      : 409
    return errorResponse(error.code, error.message, status, error.context)
  }
  if (error instanceof PveRunStoreErrorV1) {
    const status = error.code === 'PVE_RUN_NOT_FOUND'
      ? 404
      : error.code === 'PVE_RUN_ID_INVALID'
        ? 400
      : error.code.includes('CONFLICT') || error.code === 'PVE_RUN_ALREADY_EXISTS'
        ? 409
        : 500
    return errorResponse(error.code, error.message, status)
  }
  if (
    error instanceof PveContentSnapshotErrorV1
    || error instanceof PveRuntimeRegistryErrorV1
  ) {
    return errorResponse(error.code, error.message, 503, error.context)
  }
  const message = error instanceof Error ? error.message : String(error)
  return errorResponse('PVE_INTERNAL_ERROR', message, 500)
}

export async function readStrictJsonObjectV1(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = parseStrictJsonBytesV1(
      new Uint8Array(await request.arrayBuffer()),
    )
  } catch {
    throw new PveServiceErrorV1(
      'PVE_REQUEST_INVALID',
      'Request body must be strict UTF-8 JSON without duplicate keys',
      400,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PveServiceErrorV1(
      'PVE_REQUEST_INVALID',
      'Request body must be a JSON object',
      400,
    )
  }
  return value as Record<string, unknown>
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  context: Readonly<Record<string, unknown>> = {},
): Response {
  return Response.json(
    { error: code, code, message, ...(Object.keys(context).length ? { context } : {}) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}
