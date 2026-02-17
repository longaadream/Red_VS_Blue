import { NextRequest, NextResponse } from 'next/server'
import { loadJsonFilesServer } from '@/lib/game/file-loader'

// 加载地图数据
async function loadMaps() {
  return loadJsonFilesServer('data/maps')
}

export async function GET(request: NextRequest) {
  try {
    const maps = await loadMaps()
    return NextResponse.json(maps, { status: 200 })
  } catch (error) {
    console.error('Error loading maps:', error)
    return NextResponse.json({ error: 'Failed to load maps' }, { status: 500 })
  }
}