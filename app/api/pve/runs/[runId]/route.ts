import { pveApiErrorV1 } from '@/lib/pve/api-errors'
import { getPveServiceV1 } from '@/lib/pve/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await context.params
    const result = getPveServiceV1().getRun(runId)
    return Response.json(result.view, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return pveApiErrorV1(error)
  }
}
