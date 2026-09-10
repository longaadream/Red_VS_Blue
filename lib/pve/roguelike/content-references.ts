import { parseRoguelikeDocumentV1 } from '../contracts/roguelike-content-v1'
import { isContentAvailable, type ContentAvailability } from '../../game/content-availability'

interface ReferencedContent {
  id: string
  availability?: ContentAvailability
  image?: string
  skills?: { skillId: string }[]
  rules?: string[]
  playerRules?: string[]
  progressiveDeployment?: unknown
  relatedCards?: string[]
  effect?: { type?: string; skillId?: string }
  summonCapability?: { recipe?: string; uniqueTemplateId?: string }
  design?: { familyId?: string }
  type?: string
  code?: string
}

/** Called on complete resolved trees, never on an isolated Patch payload. */
export function validateRoguelikeReferences(files: readonly {path:string;jsonValue?:unknown}[]): void {
  const entries = new Map(files.map(file=>[file.path,file.jsonValue]))
  const fail=(path:string):never=>{throw new Error(`PVE resource reference is invalid: ${path}`)}
  const resource=(kind:string,id:string):ReferencedContent=>{
    const path=`data/${kind}/${id}.json`,value=entries.get(path) as ReferencedContent|undefined
    const manifest=entries.get(`data/${kind}/manifest.json`)
    if(!value||value.id!==id||!Array.isArray(manifest)||!manifest.includes(id))return fail(path)
    return value
  }
  const image=(path:string)=>{if(!path.startsWith('images/')||!entries.has(path))fail(path)}
  const visited = new Set<string>()
  const rule=(id:string)=>{
    const value=resource('rules',id)
    if(visited.has('rules/'+id))return
    visited.add('rules/'+id)
    if(value.effect?.type==='triggerSkill') {
      if(typeof value.effect.skillId!=='string')return fail(`rules/${id}: missing trigger skill`)
      skill(value.effect.skillId)
    }
  }
  const skill=(id:string)=>{
    const value=resource('skills',id)
    if(!isContentAvailable(value,'pve'))fail(`skills/${id}: unavailable`)
    if(visited.has('skills/'+id))return
    visited.add('skills/'+id)
    if(value.summonCapability?.recipe==='stored-or-declared-piece') {
      const templateId=value.summonCapability.uniqueTemplateId
      if(typeof templateId!=='string')return fail(`skills/${id}: missing summon template`)
      piece(templateId)
    }
  }
  const piece=(id:string)=>{
    const value=resource('pieces',id)
    if(!isContentAvailable(value,'pve'))fail(`pieces/${id}: unavailable`)
    if(visited.has('pieces/'+id))return
    visited.add('pieces/'+id)
    if(value.image && value.availability?.modes?.length === 1 && value.availability.modes[0] === 'pve')image('images/'+value.image)
    for(const item of value.skills??[])skill(item.skillId)
    for(const ruleId of [...(value.rules??[]),...(value.playerRules??[])])rule(ruleId)
  }
  const documents=new Set<string>()
  for(const file of files) {
    const document=parseRoguelikeDocumentV1(file.jsonValue)
    if(!document)continue
    const key=document.schemaVersion+':'+document.id
    if(documents.has(key))fail(file.path+': duplicate document id')
    documents.add(key)
    if(document.schemaVersion==='rvb-pve-roguelike-adventure/v1') {
      const builds=parseRoguelikeDocumentV1(entries.get(document.resources.buildsPath))
      if(builds?.schemaVersion!=='rvb-pve-roguelike-builds/v1')fail(document.resources.buildsPath)
      if(document.resources.suppliesPath && parseRoguelikeDocumentV1(entries.get(document.resources.suppliesPath))?.schemaVersion !== 'rvb-pve-roguelike-supplies/v1') fail(document.resources.suppliesPath)
      for(const id of [...document.party.pieceIds,...document.resources.pieceIds])piece(id)
      for (const id of document.recruitment?.pieceIds ?? []) {
        piece(id)
        const template = resource('pieces', id)
        if (template.playerRules?.length || template.progressiveDeployment) fail(`pieces/${id}: unsupported recruitment setup`)
        for (const cardId of template.relatedCards ?? []) {
          const card = resource('cards', cardId)
          if (!isContentAvailable(card, 'pve') || !['active','reactive'].includes(card.type ?? '') || !card.code?.trim()) fail(`cards/${cardId}: invalid recruit card`)
        }
      }
      for(const id of document.resources.skillIds) skill(id)
      for(const path of document.resources.images)image(path)
    }else if(document.schemaVersion==='rvb-pve-roguelike-supplies/v1'){
      for (const id of [...document.rewardCardIds, ...document.relics.flatMap(relic => relic.grants.map(grant => grant.cardId))]) {
        const card = resource('cards', id)
        if (!isContentAvailable(card, 'pve')) fail(`cards/${id}: supply requires ready card`)
        if (!['active', 'reactive'].includes(card.type ?? '') || typeof card.code !== 'string' || !card.code.trim()) fail(`cards/${id}: supply requires executable card`)
      }
      for (const relic of document.relics) {
        const familyExists = files.some(file => {
          const builds = parseRoguelikeDocumentV1(file.jsonValue)
          return builds?.schemaVersion === 'rvb-pve-roguelike-builds/v1' && builds.families.some(family => family.id === relic.familyId)
        })
        if (!familyExists) fail(`relics/${relic.id}: missing family`)
      }
    }else{
      for(const family of document.families) {
        for(const member of family.team){piece(member.pieceId);image('images/'+member.image)}
        for(const id of family.cardIds) {
          const card=resource('cards',id)
          if(card.design?.familyId!==family.id)fail(`cards/${id}: family mismatch`)
          if(!card.availability?.modes?.includes('pve'))fail(`cards/${id}: missing PVE availability`)
        }
      }
    }
  }
}
