import { NextRequest, NextResponse } from 'next/server'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Content-Type',
    'Authorization',
    'x-admin-key',
    'x-player-id',
    'x-rvb-profile-admin-key',
    'x-rvb-local-dev-profile',
  ].join(', '),
  'Access-Control-Allow-Private-Network': 'true',
}

function isProfileAdmissionPaused(): boolean {
  return Boolean(
    process.env.RVB_PROFILE_ACTIVATION_ID
    || process.env.RVB_PROFILE_ADMISSION_PAUSED,
  )
}

function isProfileControlPath(pathname: string): boolean {
  return pathname === '/api/ping'
    || pathname === '/api/content-profile'
    || pathname.startsWith('/api/content-profile/')
}

export function proxy(request: NextRequest) {
  if (
    isProfileAdmissionPaused()
    && !isProfileControlPath(request.nextUrl.pathname)
  ) {
    return NextResponse.json(
      {
        error: 'PROFILE_ACTIVATION_IN_PROGRESS',
        message: 'New API sessions are paused while the content Profile is activating.',
      },
      {
        status: 503,
        headers: {
          ...corsHeaders,
          'Retry-After': '1',
        },
      },
    )
  }

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 200,
      headers: corsHeaders,
    })
  }

  const response = NextResponse.next()
  for (const [name, value] of Object.entries(corsHeaders)) {
    response.headers.set(name, value)
  }
  return response
}

export const config = {
  matcher: '/api/:path*',
}
