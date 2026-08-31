import { pveApiErrorV1, readStrictJsonObjectV1 } from '@/lib/pve/api-errors'
import { getPveServiceV1, PveServiceErrorV1 } from '@/lib/pve/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readStrictJsonObjectV1(request)
    if (
      Object.keys(body).sort().join(',') !== 'campaignId'
      || typeof body.campaignId !== 'string'
    ) {
      throw new PveServiceErrorV1(
        'PVE_REQUEST_INVALID',
        'Create Run accepts exactly one campaignId',
        400,
      )
    }
    const result = getPveServiceV1().createRun(body.campaignId)
    return Response.json(result.view, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return pveApiErrorV1(error)
  }
}
