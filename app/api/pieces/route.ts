import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { NextRequest, NextResponse } from 'next/server'

interface PieceTemplate {
  id: string
  name: string
  faction: string
  description?: string
  rarity: string
  image?: string
  stats: {
    maxHp: number
    attack: number
    defense: number
    moveRange: number
  }
  skills: Array<{ skillId: string; level: number }>
  isDefault?: boolean
}

export async function GET(request: NextRequest) {
  try {
    const pieces: Record<string, PieceTemplate> = {}
    const dirPath = join(process.cwd(), 'data', 'pieces')
    
    const files = readdirSync(dirPath, { withFileTypes: true })
    
    files.forEach((file) => {
      if (file.isFile() && file.name.endsWith('.json')) {
        const filePath = join(dirPath, file.name)
        const content = readFileSync(filePath, 'utf-8')
        try {
          const data = JSON.parse(content) as PieceTemplate
          if (data && typeof data === 'object' && 'id' in data) {
            pieces[data.id] = data
          }
        } catch (parseError) {
          console.error(`Error parsing piece file ${file.name}:`, parseError)
        }
      }
    })
    
    return NextResponse.json(pieces)
  } catch (error) {
    console.error('Error loading pieces:', error)
    return NextResponse.json({ error: 'Failed to load pieces' }, { status: 500 })
  }
}
