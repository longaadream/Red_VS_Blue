import { NextResponse } from 'next/server'
import { getDataRoot } from '@/lib/app-paths'

type PveManifest = Record<string, string[]>

function readJson<T>(...parts: string[]): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path') as typeof import('path')
  return JSON.parse(readFileSync(join(getDataRoot(), 'pve', ...parts), 'utf8')) as T
}

function readMany(type: string, ids: string[]) {
  return ids.map(id => readJson(`${type}/${id}.json`))
}

export async function GET() {
  try {
    const manifest = readJson<PveManifest>('manifest.json')
    return NextResponse.json({
      manifest,
      chapters: readMany('chapters', manifest.chapters || []),
      encounters: readMany('encounters', manifest.encounters || []),
      events: readMany('events', manifest.events || []),
      rewards: readMany('rewards', manifest.rewards || []),
      relics: readMany('relics', manifest.relics || []),
      enemies: readMany('enemies', manifest.enemies || []),
    })
  } catch (error) {
    console.error('[GET /api/pve] Failed to load PVE data:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
