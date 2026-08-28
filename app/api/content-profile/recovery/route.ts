import { logProfileEventV1, recoverRuntimeProfileOnStartupV1 } from '@/lib/content-pipeline/runtime/profile-runtime'

import { profileApiError, requireProfileAdmin } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const keepAdmissionPaused = new URL(request.url).searchParams.get('keepAdmissionPaused') === '1'
    const recovery = recoverRuntimeProfileOnStartupV1({ keepAdmissionPaused })
    logProfileEventV1('startup-recovery', {
      stableProfileHash: recovery.state.stable.resolvedProfileHash,
      lastFailure: recovery.state.lastFailure,
      requiresProcessRestart: recovery.requiresProcessRestart,
      previousRuntime: recovery.previousRuntime,
    })
    return Response.json(recovery)
  } catch (error) {
    return profileApiError(error)
  }
}
