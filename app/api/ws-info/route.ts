import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    transport: 'same-origin',
    path: '/ws/rooms/{roomId}',
  })
}
