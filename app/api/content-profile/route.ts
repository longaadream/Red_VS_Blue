import {
  getProfileRuntimeContextV1,
  getProfileServerReportV1,
} from '@/lib/content-pipeline/runtime/profile-runtime'

import { requireProfileAdmin } from './_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const context = getProfileRuntimeContextV1()
    const state = context.store.readState()
    const server = await getProfileServerReportV1()
    return Response.json({
      schemaVersion: 'rvb-content-profile-api/v1',
      state,
      server,
    })
  } catch (error) {
    return Response.json({
      error: 'PROFILE_REPORT_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 503 })
  }
}
