import { pveApiErrorV1, readStrictJsonObjectV1 } from '@/lib/pve/api-errors'
import { getPveServiceV1 } from '@/lib/pve/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const [{ runId }, body] = await Promise.all([
      context.params,
      readStrictJsonObjectV1(request),
    ])
    const result = await getPveServiceV1().execute(runId, body)
    return Response.json(result.view, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return pveApiErrorV1(error)
  }
}
