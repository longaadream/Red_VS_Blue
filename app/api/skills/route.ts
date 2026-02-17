import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { NextRequest, NextResponse } from 'next/server'

interface SkillDefinition {
  id: string
  name: string
  description: string
  kind: string
  type: string
  cooldownTurns: number
  maxCharges: number
  chargeCost?: number
  powerMultiplier: number
  code: string
  effects: Array<{
    type: string
    value: number
    target: string
    description: string
    duration?: number
  }>
  range: string
  areaSize?: number
  requiresTarget: boolean
}

export async function GET(request: NextRequest) {
  try {
    const skills: Record<string, SkillDefinition> = {}
    const dirPath = join(process.cwd(), 'data', 'skills')
    
    const files = readdirSync(dirPath, { withFileTypes: true })
    
    files.forEach((file) => {
      if (file.isFile() && file.name.endsWith('.json')) {
        const filePath = join(dirPath, file.name)
        const content = readFileSync(filePath, 'utf-8')
        try {
          const data = JSON.parse(content) as SkillDefinition
          if (data && typeof data === 'object' && 'id' in data) {
            skills[data.id] = data
          }
        } catch (parseError) {
          console.error(`Error parsing skill file ${file.name}:`, parseError)
        }
      }
    })
    
    return NextResponse.json(skills)
  } catch (error) {
    console.error('Error loading skills:', error)
    return NextResponse.json({ error: 'Failed to load skills' }, { status: 500 })
  }
}
