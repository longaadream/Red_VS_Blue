import {
  bindStableRuntimeProfileV1,
  getProfileLeaseReportV1,
  getProfileRuntimeContextV1,
  getProfileServerReportV1,
  logProfileEventV1,
  reconcileRuntimePveAuthorityV1,
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
    if (!state.candidate) {
      if (state.activation !== null || state.stable.resolvedProfileHash !== body.targetProfileHash) {
        throw new Error('PROFILE_CANDIDATE_MISSING')
      }
      process.env.RVB_PROFILE_ADMISSION_PAUSED ||= `postcommit:${body.activationId}`
      const report = await getProfileServerReportV1()
      if (
        !report.healthy
        || report.activationId !== null
        || report.profile.resolvedProfileHash !== state.stable.resolvedProfileHash
        || report.profile.authorityContentHash !== state.stable.authorityContentHash
      ) throw new Error('COMMITTED_PROFILE_HEALTH_FAILED')
      await reconcileRuntimePveAuthorityV1(state.stable.authorityContentHash, 'activation-commit')
      const admissionPaused = body.keepAdmissionPaused === true
      bindStableRuntimeProfileV1({ admissionPaused: admissionPaused ? `postcommit:${body.activationId}` : undefined })
      return Response.json({ state, report, reloadMode: null, admissionPaused, alreadyCommitted: true })
    }
    const reloadMode = classifyProfileReloadV1(state.stable, state.candidate)
    if (reloadMode === 'authority-restart') {
      const lease = await getProfileLeaseReportV1()
      if (lease.active) {
        throw new Error(`PROFILE_IN_USE: ${[
          ...lease.roomIds,
          ...(lease.pveRunIds ?? []),
          ...(lease.pveBattleIds ?? []),
        ].join(',')}`)
      }
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
    await reconcileRuntimePveAuthorityV1(committed.stable.authorityContentHash, 'activation-commit')
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
      process.env.RVB_PROFILE_ADMISSION_PAUSED ||= 'postcommit:pve-cleanup-failed'
      try { bindStableRuntimeProfileV1({ admissionPaused: process.env.RVB_PROFILE_ADMISSION_PAUSED }) } catch { /* keep the existing fail-closed fence */ }
      return Response.json({
        error: 'PROFILE_COMMIT_RESPONSE_UNCERTAIN',
        message: error instanceof Error ? error.message : String(error),
      }, { status: 503 })
    }
    return profileApiError(error)
  }
}
