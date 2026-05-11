import { NextResponse } from 'next/server'
import { getWsPort } from '@/lib/ws-server'

export async function GET() {
  return NextResponse.json({ wsPort: getWsPort() })
}
