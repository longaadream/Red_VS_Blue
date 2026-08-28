import { timingSafeEqual } from 'node:crypto'

import { ProfileStoreErrorV1 } from '@/lib/content-pipeline/runtime/profile-store'

export function requireProfileAdmin(request: Request): Response | null {
  const expected = process.env.RVB_PROFILE_ADMIN_KEY
  const actual = request.headers.get('x-rvb-profile-admin-key')
  if (!expected) {
    return Response.json({ error: 'PROFILE_ADMIN_DISABLED' }, { status: 503 })
  }
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual ?? '')
  if (
    expectedBytes.byteLength !== actualBytes.byteLength
    || !timingSafeEqual(expectedBytes, actualBytes)
  ) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  return null
}

export function profileApiError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof ProfileStoreErrorV1
    ? error.code
    : message.startsWith('PROFILE_IN_USE')
      ? 'PROFILE_IN_USE'
      : 'PROFILE_OPERATION_FAILED'
  const status = code === 'PROFILE_IN_USE'
    ? 409
    : code === 'PROFILE_CANDIDATE_MISSING'
      ? 404
      : code === 'PROFILE_STORE_BUSY'
        ? 423
        : 400
  return Response.json({ error: code, message }, { status })
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}
