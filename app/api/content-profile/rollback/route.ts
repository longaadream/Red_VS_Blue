import { getProfileRuntimeContextV1, logProfileEventV1 } from '@/lib/content-pipeline/runtime/profile-runtime'

import { profileApiError, readJsonObject, requireProfileAdmin } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const body = await readJsonObject(request)
    if (body.target !== 'previous-stable' && body.target !== 'bundled-base') {
      throw new Error('target must be previous-stable or bundled-base')
    }
    const state = getProfileRuntimeContextV1().store.selectRollbackCandidate(body.target)
    const targetProfileHash = state.candidate?.resolvedProfileHash
      ?? state.stable.resolvedProfileHash
    logProfileEventV1('rollback-candidate', {
      rollbackTarget: body.target,
      stableProfileHash: state.stable.resolvedProfileHash,
      targetProfileHash,
    })
    return Response.json({
      state,
      targetProfileHash,
      alreadyStable: state.candidate === null
        && targetProfileHash === state.stable.resolvedProfileHash,
    })
  } catch (error) {
    return profileApiError(error)
  }
}
