import type { SkillDefinition } from "./skills"

// 默认技能数据（作为后备）
const defaultSkillsData: Record<string, SkillDefinition> = {
  "basic-attack": {
    id: "basic-attack",
    name: "基础攻击",
    description: "对目标造成基础伤害",
    kind: "active",
    type: "normal",
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    code: "function executeSkill(context) { const targetEnemy = context.targetPiece; if (!targetEnemy) { return { message: sourcePiece.templateId + '需要选择一个目标', success: false }; } const damageValue = sourcePiece.attack * context.skill.powerMultiplier; const damageResult = dealDamage(sourcePiece, targetEnemy, damageValue, 'physical', context.battle, context.skill.id); return { message: sourcePiece.templateId + '对' + targetEnemy.templateId + '造成' + damageResult.damage + '点伤害', success: true }; }",
    range: "single",
    actionPointCost: 1
  }
}

// 客户端版本：初始为默认技能数据，通过API获取数据
export let DEFAULT_SKILLS: Record<string, SkillDefinition> = { ...defaultSkillsData }

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
        
        // 合并API返回的数据和默认数据，确保默认数据总是可用
        DEFAULT_SKILLS = { ...defaultSkillsData, ...skillsObject }
        console.log('Loaded skills from API:', Object.keys(DEFAULT_SKILLS))
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
    const { loadJsonFilesServer } = require('./file-loader')
    const loadedSkills = loadJsonFilesServer<SkillDefinition>('data/skills')
    // 合并加载的数据和默认数据，确保默认数据总是可用
    DEFAULT_SKILLS = { ...defaultSkillsData, ...loadedSkills }
    
    console.log('Loaded skills:', Object.keys(DEFAULT_SKILLS))
  } catch (error) {
    console.error('Error loading skills from files:', error)
    // 加载失败，使用默认数据
    DEFAULT_SKILLS = { ...defaultSkillsData }
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
