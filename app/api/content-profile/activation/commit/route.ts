import {
  bindStableRuntimeProfileV1,
  getProfileLeaseReportV1,
  getProfileRuntimeContextV1,
  getProfileServerReportV1,
  logProfileEventV1,
} from '@/lib/content-pipeline/runtime/profile-runtime'
import { classifyProfileReloadV1 } from '@/lib/content-pipeline/runtime/profile-store'

import { profileApiError, readJsonObject, requireProfileAdmin } from '../../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  let commitCompleted = false
  try {
    const body = await readJsonObject(request)
    if (typeof body.activationId !== 'string' || typeof body.targetProfileHash !== 'string') {
      throw new Error('activationId and targetProfileHash are required')
    }
    const context = getProfileRuntimeContextV1()
    const state = context.store.readState()
    if (!state.candidate) throw new Error('PROFILE_CANDIDATE_MISSING')
    const reloadMode = classifyProfileReloadV1(state.stable, state.candidate)
    if (reloadMode === 'authority-restart' && (await getProfileLeaseReportV1()).active) {
      throw new Error('PROFILE_IN_USE')
    }
    const report = await getProfileServerReportV1()
    if (
      !report.healthy
      || report.activationId !== body.activationId
      || report.profile.resolvedProfileHash !== body.targetProfileHash
      || report.profile.authorityContentHash !== state.candidate.authorityContentHash
    ) throw new Error('CANDIDATE_HEALTH_FAILED')
    const committed = context.store.commitActivation(body.activationId, body.targetProfileHash)
    commitCompleted = true
    const admissionPaused = body.keepAdmissionPaused === true
    bindStableRuntimeProfileV1({
      admissionPaused: admissionPaused ? `postcommit:${body.activationId}` : undefined,
    })
    logProfileEventV1('activation-commit', {
      activationId: body.activationId,
      resolvedProfileHash: committed.stable.resolvedProfileHash,
      authorityContentHash: committed.stable.authorityContentHash,
      previousStableHash: committed.previousStable?.resolvedProfileHash ?? null,
      reloadMode,
      seed: report.fixedSeed.seed,
      stateHash: report.fixedSeed.stateHash,
    })
    return Response.json({ state: committed, report, reloadMode, admissionPaused })
  } catch (error) {
    if (commitCompleted) {
      return Response.json({
        error: 'PROFILE_COMMIT_RESPONSE_UNCERTAIN',
        message: error instanceof Error ? error.message : String(error),
      }, { status: 503 })
    }
    return profileApiError(error)
  }
}
