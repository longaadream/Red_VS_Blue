import { pveApiErrorV1 } from '@/lib/pve/api-errors'
import { getPveServiceV1 } from '@/lib/pve/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return Response.json(getPveServiceV1().catalog(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return pveApiErrorV1(error)
  }
}
