import {
  bindStableRuntimeProfileV1,
  getProfileRuntimeContextV1,
  getProfileServerReportV1,
  logProfileEventV1,
  reconcileRuntimePveAuthorityV1,
} from '@/lib/content-pipeline/runtime/profile-runtime'

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
    const report = await getProfileServerReportV1()
    // Re-read the atomic pointer after the asynchronous health probe. From
    // this check through bindStableRuntimeProfileV1 there is no await, so a
    // concurrent activation request cannot interleave and lose its gate.
    const state = getProfileRuntimeContextV1().store.readState()
    if (
      state.activation !== null
      || state.stable.resolvedProfileHash !== body.targetProfileHash
      || !report.healthy
      || report.activationId !== null
      || report.profile.resolvedProfileHash !== body.targetProfileHash
      || report.profile.authorityContentHash !== state.stable.authorityContentHash
    ) throw new Error('PROFILE_ADMISSION_RELEASE_MISMATCH')

    const wasPaused = Boolean(process.env.RVB_PROFILE_ADMISSION_PAUSED)
    process.env.RVB_PROFILE_ADMISSION_PAUSED ||= 'admission-release'
    await reconcileRuntimePveAuthorityV1(state.stable.authorityContentHash, 'admission-release')
    bindStableRuntimeProfileV1()
    logProfileEventV1('activation-admission-release', {
      resolvedProfileHash: state.stable.resolvedProfileHash,
      authorityContentHash: state.stable.authorityContentHash,
      wasPaused,
    })
    return Response.json({ state, report, admissionPaused: false, wasPaused })
  } catch (error) {
    process.env.RVB_PROFILE_ADMISSION_PAUSED ||= 'pve-cleanup-failed'
    return profileApiError(error)
  }
}
