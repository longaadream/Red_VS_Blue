import { getPieceById } from '../../game/piece-repository'
import { getSkillById } from '../../game/skill-repository'
import { assertContentAvailable } from '../../game/content-availability'
import { adventureContent } from './content'

export const enemyTemplates = adventureContent.resources.pieceIds.map(id => {
  const piece = getPieceById(id)
  if (!piece) throw new Error('缺少冒险角色 ' + id)
  assertContentAvailable(piece, 'pve')
  return piece
})
export const enemySkills = Object.fromEntries(adventureContent.resources.skillIds.map(id => {
  const skill = getSkillById(id)
  if (!skill) throw new Error('缺少冒险技能 ' + id)
  assertContentAvailable(skill, 'pve')
  return [id, bindAdventureSummonTemplate(skill)]
}))
export const enemyLineup = adventureContent.enemyLineup

/** Materialize the existing sealed declaration from the shared piece definition. */
export function bindAdventureSummonTemplate(skill: import('../../game/skills').SkillDefinition) {
  const capability = skill.summonCapability
  if (capability?.recipe !== 'stored-or-declared-piece') return skill
  const template = getPieceById(capability.uniqueTemplateId)
  if (!template) throw new Error('缺少召唤模板 ' + capability.uniqueTemplateId)
  assertContentAvailable(template, 'pve')
  return { ...skill, summonCapability: { ...capability, fallback: {
    ...capability.fallback, name: template.name, maxHp:template.stats.maxHp,
    attack:template.stats.attack, defense:template.stats.defense, moveRange:template.stats.moveRange,
    skills: template.skills.map(item => ({skillId:item.skillId,level:item.level??1,currentCooldown:0})),
  } } }
}
