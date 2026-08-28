import {
  bindStableRuntimeProfileV1,
  recordActivationFailureV1,
  recordProfileAuditEvidenceV1,
} from '@/lib/content-pipeline/runtime/profile-runtime'

import { profileApiError, readJsonObject, requireProfileAdmin } from '../../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const body = await readJsonObject(request)
    if (
      body.evidenceKind === 'postcommit-renderer-failure'
      || body.evidenceKind === 'postcommit-renderer-rollback'
    ) {
      if (
        typeof body.code !== 'string'
        || typeof body.stage !== 'string'
        || typeof body.message !== 'string'
        || typeof body.targetProfileHash !== 'string'
        || !/^[0-9a-f]{64}$/.test(body.targetProfileHash)
        || (body.rollbackTarget !== null && body.rollbackTarget !== 'previous-stable')
        || (
          body.rollbackSucceeded !== null
          && typeof body.rollbackSucceeded !== 'boolean'
        )
      ) throw new Error('invalid postcommit renderer evidence')
      const evidence = recordProfileAuditEvidenceV1({
        kind: body.evidenceKind,
        code: body.code,
        stage: body.stage,
        message: body.message,
        targetProfileHash: body.targetProfileHash,
        rollbackTarget: body.rollbackTarget,
        rollbackSucceeded: body.rollbackSucceeded,
      })
      return Response.json({ evidence })
    }
    if (
      typeof body.activationId !== 'string'
      || typeof body.code !== 'string'
      || typeof body.stage !== 'string'
      || typeof body.message !== 'string'
    ) throw new Error('activationId, code, stage and message are required')
    const state = recordActivationFailureV1(body.activationId, {
      code: body.code,
      stage: body.stage,
      message: body.message,
    })
    const admissionPaused = body.keepAdmissionPaused === true
    if (admissionPaused) {
      // A durable drain failure may have already closed the authority journal.
      // Keep this process fail-closed; only a fresh stable process may reopen it.
      process.env.RVB_PROFILE_ADMISSION_PAUSED = body.activationId
    } else {
      bindStableRuntimeProfileV1()
    }
    return Response.json({ state, admissionPaused })
  } catch (error) {
    return profileApiError(error)
  }
}
