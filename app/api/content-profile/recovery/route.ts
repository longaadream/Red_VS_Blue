import { bindStableRuntimeProfileV1, logProfileEventV1, reconcileRuntimePveAuthorityV1, recoverRuntimeProfileOnStartupV1 } from '@/lib/content-pipeline/runtime/profile-runtime'

import { profileApiError, requireProfileAdmin } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const keepAdmissionPaused = new URL(request.url).searchParams.get('keepAdmissionPaused') === '1'
    process.env.RVB_PROFILE_ADMISSION_PAUSED ||= 'startup-recovery'
    const recovery = recoverRuntimeProfileOnStartupV1({ keepAdmissionPaused: true })
    await reconcileRuntimePveAuthorityV1(recovery.state.stable.authorityContentHash, 'startup-recovery')
    if (!keepAdmissionPaused && !recovery.requiresProcessRestart) bindStableRuntimeProfileV1()
    logProfileEventV1('startup-recovery', {
      stableProfileHash: recovery.state.stable.resolvedProfileHash,
      lastFailure: recovery.state.lastFailure,
      requiresProcessRestart: recovery.requiresProcessRestart,
      previousRuntime: recovery.previousRuntime,
    })
    return Response.json(recovery)
  } catch (error) {
    process.env.RVB_PROFILE_ADMISSION_PAUSED ||= 'startup-recovery-failed'
    return profileApiError(error)
  }
}
