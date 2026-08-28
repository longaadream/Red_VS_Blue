import { beginProfileActivationV1 } from '@/lib/content-pipeline/runtime/profile-runtime'

import { profileApiError, readJsonObject, requireProfileAdmin } from '../../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const body = await readJsonObject(request)
    if (typeof body.targetProfileHash !== 'string') {
      throw new Error('targetProfileHash is required')
    }
    return Response.json(await beginProfileActivationV1(body.targetProfileHash))
  } catch (error) {
    return profileApiError(error)
  }
}
