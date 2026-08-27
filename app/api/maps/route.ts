import { NextResponse } from 'next/server'
import { getSelectableMapCatalog } from '@/lib/game/map-selection'

export async function GET() {
  try {
    const maps = getSelectableMapCatalog()
    return NextResponse.json({ maps }, { status: 200 })
  } catch (error) {
    console.error('Error loading selectable maps:', error)
    return NextResponse.json({ error: 'Failed to load selectable maps' }, { status: 500 })
  }
}
