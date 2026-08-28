import { installProfileArchiveV1 } from '@/lib/content-pipeline/runtime/profile-archive'
import { getProfileRuntimeContextV1, logProfileEventV1 } from '@/lib/content-pipeline/runtime/profile-runtime'

import { profileApiError, requireProfileAdmin } from '../_shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = requireProfileAdmin(request)
  if (denied) return denied
  try {
    const context = getProfileRuntimeContextV1()
    const allowLocalDevUnsigned = process.env.RVB_ALLOW_LOCAL_DEV_PROFILES === '1'
      && request.headers.get('x-rvb-local-dev-profile') === '1'
    const result = installProfileArchiveV1({
      store: context.store,
      appRoot: context.appRoot,
      archive: new Uint8Array(await request.arrayBuffer()),
      allowLocalDevUnsigned,
    })
    logProfileEventV1('install-candidate', {
      resolvedProfileHash: result.reference.resolvedProfileHash,
      authorityContentHash: result.reference.authorityContentHash,
      reloadMode: result.reloadMode,
      packageId: result.reference.packageId,
      localDevUnsigned: allowLocalDevUnsigned,
    })
    return Response.json(result, { status: 201 })
  } catch (error) {
    return profileApiError(error)
  }
}
