import { NextResponse } from "next/server"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Required for browsers to allow fetching from private network IPs
  'Access-Control-Allow-Private-Network': 'true',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET() {
  return NextResponse.json(
    { name: "RED vs BLUE Server", version: "1.0", ts: Date.now() },
    { headers: CORS_HEADERS }
  )
}
