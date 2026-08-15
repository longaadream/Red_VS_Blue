import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { NextRequest, NextResponse } from 'next/server'

import { isRed43LocalDevelopmentHostname } from '@/app/qa/same-alignment/access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE_ROOT = path.resolve(process.cwd(), 'data/pages')
const DATA_ROOT = path.resolve(process.cwd(), 'data')
const PUBLIC_ROOT = path.resolve(process.cwd(), 'public')

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function isLoopbackDevelopmentRequest(request: NextRequest): boolean {
  return isRed43LocalDevelopmentHostname(request.nextUrl.hostname)
}

function resolveQaResource(segments: string[]): string | undefined {
  if (!segments.length || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0'),
  )) return undefined

  const servesData = segments[0] === 'data'
  const servesPublicAsset = segments[0] === 'images'
  const root = servesData ? DATA_ROOT : servesPublicAsset ? PUBLIC_ROOT : PAGE_ROOT
  const relativeSegments = servesData || servesPublicAsset ? segments.slice(1) : segments
  if (!relativeSegments.length) return undefined

  const target = path.resolve(root, ...relativeSegments)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return undefined
  return target
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isLoopbackDevelopmentRequest(request)) {
    return NextResponse.json({ error: 'RED-43 QA resources are available only from local development.' }, { status: 404 })
  }

  const target = resolveQaResource((await params).path)
  const contentType = target ? CONTENT_TYPES[path.extname(target).toLowerCase()] : undefined
  if (!target || !contentType) return NextResponse.json({ error: 'QA resource not found.' }, { status: 404 })

  try {
    const body = await readFile(target)
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return NextResponse.json({ error: 'QA resource not found.' }, { status: 404 })
  }
}
