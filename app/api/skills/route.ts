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
  effects?: Array<{
    type: string
    value: number
    target: string
    description: string
    duration?: number
  }>
  range: string
  areaSize?: number
  requiresTarget: boolean
  icon?: string
  previewCode?: string
}

export async function GET(request: NextRequest) {
  try {
    const skills: Record<string, SkillDefinition> = {}
    const dirPath = join(process.cwd(), 'data', 'skills')
    
    const files = readdirSync(dirPath, { withFileTypes: true })
    
    files.forEach((file) => {
      if (file.isFile() && file.name.endsWith('.json')) {
        const filePath = join(dirPath, file.name)
        try {
          const content = readFileSync(filePath, 'utf-8')
          try {
            const data = JSON.parse(content) as SkillDefinition
            if (data && typeof data === 'object' && 'id' in data) {
              skills[data.id] = data
            }
          } catch (parseError) {
            console.error(`Error parsing skill file ${file.name}:`, parseError)
            // 尝试使用简化版本，只提取必要字段
            try {
              // 提取id和name字段
              const idMatch = content.match(/"id":\s*"([^"]+)"/)
              const nameMatch = content.match(/"name":\s*"([^"]+)"/)
              if (idMatch && nameMatch) {
                const simpleSkill: SkillDefinition = {
                  id: idMatch[1],
                  name: nameMatch[1],
                  description: "技能描述",
                  kind: "active",
                  type: "normal",
                  cooldownTurns: 0,
                  maxCharges: 0,
                  powerMultiplier: 1.0,
                  code: "function executeSkill(context) { return { message: '技能执行', success: true }; }",
                  range: "single",
                  requiresTarget: false
                }
                skills[simpleSkill.id] = simpleSkill
              }
            } catch (e) {
              console.error(`Failed to extract basic skill info from ${file.name}:`, e)
            }
          }
        } catch (readError) {
          console.error(`Error reading skill file ${file.name}:`, readError)
        }
      }
    })
    
    return NextResponse.json({ skills })
  } catch (error) {
    console.error('Error loading skills:', error)
    return NextResponse.json({ error: 'Failed to load skills' }, { status: 500 })
  }
}
