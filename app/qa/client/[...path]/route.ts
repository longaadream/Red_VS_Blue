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

function resolveQaResources(segments: string[]): string[] {
  if (!segments.length || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0'),
  )) return []

  const servesData = segments[0] === 'data'
  const servesPublicAsset = segments[0] === 'images'
  const relativeSegments = servesData || servesPublicAsset ? segments.slice(1) : segments
  if (!relativeSegments.length) return []

  const roots = servesData
    ? [DATA_ROOT]
    : servesPublicAsset
      ? [path.resolve(PAGE_ROOT, 'images'), PUBLIC_ROOT]
      : [PAGE_ROOT]

  return roots.flatMap(root => {
    const target = path.resolve(root, ...relativeSegments)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return []
    return [target]
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isLoopbackDevelopmentRequest(request)) {
    return NextResponse.json({ error: 'RED-43 QA resources are available only from local development.' }, { status: 404 })
  }

  const targets = resolveQaResources((await params).path)
  const contentType = targets[0] ? CONTENT_TYPES[path.extname(targets[0]).toLowerCase()] : undefined
  if (!targets.length || !contentType) return NextResponse.json({ error: 'QA resource not found.' }, { status: 404 })

  for (const target of targets) {
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
      // Local QA serves battle-page images first, then legacy public images.
    }
  }
  return NextResponse.json({ error: 'QA resource not found.' }, { status: 404 })
}
