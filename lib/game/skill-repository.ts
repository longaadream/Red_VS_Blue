import { clearSkillDefinitionCache, type SkillDefinition } from "./skills"
import { loadJsonFilesServer } from './file-loader'

function battleDebugLog(...args: unknown[]): void {
  if (typeof process === 'undefined' || process.env?.RVB_BATTLE_DEBUG_LOGS !== '1') return
  console.log(...args)
}

// 技能必须来自资源数据；核心层不提供任何内容技能兜底。
export let DEFAULT_SKILLS: Record<string, SkillDefinition> = {}

// 从API加载技能数据
export async function loadSkills(): Promise<void> {
  try {
    const response = await fetch('/api/skills')
    if (response.ok) {
      const data = await response.json()
      // 检查API返回的数据格式
      if (data && data.skills) {
        let skillsObject: Record<string, SkillDefinition> = {}
        
        // 处理对象格式的技能数据
        if (typeof data.skills === 'object' && !Array.isArray(data.skills)) {
          skillsObject = data.skills as Record<string, SkillDefinition>
        }
        // 处理数组格式的技能数据
        else if (Array.isArray(data.skills)) {
          data.skills.forEach((skill: SkillDefinition) => {
            skillsObject[skill.id] = skill
          })
        }

        DEFAULT_SKILLS = skillsObject
        battleDebugLog('Loaded skills from API:', Object.keys(DEFAULT_SKILLS))
      }
    }
  } catch (error) {
    console.error('Error loading skills:', error)
  }
}

// 服务器端版本：使用文件系统加载数据
if (typeof window === 'undefined') {
  // 只在服务器端执行
  try {
    const loadedSkills = loadJsonFilesServer<SkillDefinition>('data/skills')
    DEFAULT_SKILLS = loadedSkills

    battleDebugLog('Loaded skills:', Object.keys(DEFAULT_SKILLS))
  } catch (error) {
    console.error('Error loading skills from files:', error)
    DEFAULT_SKILLS = {}
  }
}

export function getSkillById(id: string): SkillDefinition | undefined {
  return DEFAULT_SKILLS[id]
}

export function getAllSkills(): SkillDefinition[] {
  return Object.values(DEFAULT_SKILLS)
}

export function getSkillsByIds(ids: string[]): SkillDefinition[] {
  return ids.map(id => DEFAULT_SKILLS[id]).filter((skill): skill is SkillDefinition => skill !== undefined)
}

// 强制重新加载技能文件（用于开发模式热重载）
export function reloadSkills(): void {
  if (typeof window === 'undefined') {
    try {
      const loadedSkills = loadJsonFilesServer<SkillDefinition>('data/skills')
      DEFAULT_SKILLS = loadedSkills
      clearSkillDefinitionCache()
      battleDebugLog('[reloadSkills] Reloaded skills:', Object.keys(DEFAULT_SKILLS))
    } catch (error) {
      console.error('[reloadSkills] Error reloading skills:', error)
    }
  }
}
