import { adventureBoundary } from '../../game/adventure-boundary'
import type { BattleState } from '../../game/turn'
import type { RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'
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
export function strengthenEliteGuards(state:import('../../game/turn').BattleState,content:import('../contracts/roguelike-content-v1').RoguelikeAdventureV1){
  const eliteIds=new Set(content.enemyLineup.filter(e=>content.zones.some(z=>z.id===e.zone&&z.elite)).map(e=>e.id))
  for(const piece of state.pieces)if(eliteIds.has(piece.instanceId)){
    piece.maxHp=Math.ceil(piece.maxHp*1.5);piece.currentHp=piece.maxHp;piece.attack+=2
  }
}

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

export function completedAdventureRounds(state:BattleState):number {
  const world=adventureBoundary(state)!
  return (world.completedRoundOffset??0)+Math.max(0,(world.coop?.round??Math.ceil(state.turn.turnNumber/2))-1)
}
/** Idempotent world growth. Existing encounters keep the stats used by their public plans. */
export function upgradeWaitingEnemies(state:BattleState,content:RoguelikeAdventureV1):number {
  if(!content.enemyGrowth||state.terminalResult)return 0
  const world=adventureBoundary(state)!,config=content.enemyGrowth
  const level=Math.floor(completedAdventureRounds(state)/config.everyRounds)
  if(!level)return 0
  const fighting=new Set(world.coop?Object.values(world.coop.encounters).flatMap(z=>z.enemyIds):world.activeZone?world.activeEnemyIds:[])
  const levels=world.enemyLevels??(world.enemyLevels={})
  let count=0
  for(const piece of state.pieces){
    if(piece.ownerPlayerId!==content.party.enemyId||piece.currentHp<=0||piece.x===null||piece.y===null||fighting.has(piece.instanceId))continue
    const previous=levels[piece.instanceId]??{level:0,baseMaxHp:piece.maxHp}
    if(previous.level>=level)continue
    const extra=Math.ceil(previous.baseMaxHp*(1+config.healthPerLevel*level))-Math.ceil(previous.baseMaxHp*(1+config.healthPerLevel*previous.level))
    piece.maxHp+=extra;piece.currentHp+=extra;piece.attack+=config.attackPerLevel*(level-previous.level)
    levels[piece.instanceId]={...previous,level};count++
  }
  return count
}
