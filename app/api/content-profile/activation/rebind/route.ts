import { bindRuntimeProfileV1 } from '@/lib/content-pipeline/runtime/profile-runtime'

import { profileApiError, readJsonObject, requireProfileAdmin } from '../../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const body = await readJsonObject(request)
    if (typeof body.activationId !== 'string' || typeof body.targetProfileHash !== 'string') {
      throw new Error('activationId and targetProfileHash are required')
    }
    bindRuntimeProfileV1(body.activationId, body.targetProfileHash)
    return Response.json({ ok: true })
  } catch (error) {
    return profileApiError(error)
  }
}
