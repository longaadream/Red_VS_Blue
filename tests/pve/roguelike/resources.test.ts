import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createBundledBasePackInputV1 } from '@/lib/content-pipeline/runtime/bundled-base'
import { resolveProfileV1, type ResolvePackInputV1 } from '@/lib/content-pipeline/core/resolver'
import { sha256HexV1 } from '@/lib/content-pipeline/core/hash'
import { deriveFileCapabilitiesV1 } from '@/lib/content-pipeline/core/capabilities'
import { writeArchiveFileV1, readArchiveFileV1 } from '@/lib/content-pipeline/tooling/archive'
import { validateRoguelikeReferences } from '@/lib/pve/roguelike/content-references'
import { RoguelikeAdventureV1Schema, RoguelikeBuildsV1Schema } from '@/lib/pve/contracts/roguelike-content-v1'
import { loadAdventureContent, createAdventureMap, adventureContent, HUMAN, zones } from '@/lib/pve/roguelike/content'
import { bindAdventureSummonTemplate } from '@/lib/pve/roguelike/enemies'
import { createAdventureState, AdventureSession } from '@/lib/pve/roguelike/session'
import { DEFAULT_PIECES, getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { getSkillById } from '@/lib/game/skill-repository'
import { isContentAvailable, isValidContentAvailability } from '@/lib/game/content-availability'
import { practiceCatalog, choosePracticeRoster } from '@/lib/practice/setup'
import { validateDemoRosterSelection } from '@/lib/game/roster-contract'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { loadCardForBattle, executeCardFunction, type CardDefinition } from '@/lib/game/skills'
import type { BattleState } from '@/lib/game/turn'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { readClientProtocolBattleData, resolveClientProtocolFile } from '../../../electron-client/client-protocol-resource'

const read=(relative:string)=>JSON.parse(readFileSync(path.resolve(relative),'utf8'))
const base=createBundledBasePackInputV1(process.cwd())
const profile=resolveProfileV1({base})
const worldPath='data/pve/roguelike/adventure.json'
const files=base.source.entries.map(file=>({path:file.path,jsonValue:file.path.endsWith('.json')?JSON.parse(new TextDecoder().decode(file.bytes)):undefined}))
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value))

function patch(targetPath:string,value?:unknown):ResolvePackInputV1 {
  const bytes=new TextEncoder().encode(JSON.stringify(value??null))
  const sourcePath=targetPath
  const expectedHash=sha256HexV1(profile.readFile(targetPath)!)
  const removing=value===undefined
  const capabilities=removing?['game-data','pve-content']:deriveFileCapabilitiesV1({path:sourcePath,mediaType:'application/json',jsonValue:value as never,hasExecutableContent:false})
  const manifest={schemaVersion:'rvb-pack/v1',packageId:'test.exploration-patch',version:'1.0.0',displayName:'Exploration patch',publisher:{id:'local.test',keyId:null},
    compatibility:profile.profile.compatibility,capabilities,kind:'patch',parentProfileHash:profile.profile.resolvedProfileHash,
    files:removing?[]:[{path:sourcePath,mediaType:'application/json',size:bytes.length,sha256:sha256HexV1(bytes)}],
    operations:[removing?{op:'remove',targetPath,expectedHash}:{op:'replace',targetPath,sourcePath,expectedHash}]}
  return {source:{manifestBytes:new TextEncoder().encode(JSON.stringify(manifest)),signatureBytes:null,entries:removing?[]:[{path:sourcePath,bytes}]},
    policy:{kind:'local-dev',expectedCompatibility:profile.profile.compatibility,allowUnsigned:true}}
}

describe('shared PVE resources and mode boundaries',()=>{
  it('preserves unmarked content and fails closed on malformed availability',()=>{
    expect(isContentAvailable({},'pvp')).toBe(true)
    expect(isContentAvailable({},'pve')).toBe(true)
    for(const availability of [null,{modes:[],status:'ready'},{modes:['pve','pve'],status:'ready'},{modes:['pvp'],status:'unknown'},{modes:['pvp'],status:'ready',extra:true}]) {
      expect(isValidContentAvailability(availability)).toBe(false)
      expect(isContentAvailable({availability},'pvp')).toBe(false)
    }
  })
  it('shares the eight enemies and sixty designed cards, activating only the four supply-slice cards',()=>{
    expect(read('data/pieces/manifest.json').filter((id:string)=>id.startsWith('pve-'))).toHaveLength(8)
    const cards=read('data/cards/manifest.json').filter((id:string)=>id.startsWith('pve-'))
    expect(cards).toHaveLength(60)
    const ready = ['pve-blood-curse','pve-light-spark','pve-skirmish-calibrate','pve-skirmish-cover']
    for(const id of cards){const card=read('data/cards/'+id+'.json');expect(card.availability).toEqual({modes:['pve'],status:ready.includes(id)?'ready':'draft'});if(ready.includes(id))expect(card.code).toContain('function executeCard');else expect(card.code).toBeUndefined();expect(card.description).not.toMatch(/物理伤害|魔法伤害/)}
  })
  it('hides PVE enemies from manual, saved and random PVP rosters',()=>{
    expect(practiceCatalog().pieces.some(piece=>piece.id.startsWith('pve-'))).toBe(false)
    expect(getDemoPieceIds().some(id=>id.startsWith('pve-'))).toBe(false)
    for(let seed=0;seed<10;seed++)expect(choosePracticeRoster('evil',seed).pieceIds.some(id=>id.startsWith('pve-'))).toBe(false)
    const pieces=getDemoPieceIds().filter(id=>getPieceById(id)?.faction==='evil').slice(0,7).concat('pve-zombie').map(templateId=>({templateId}))
    expect(()=>validateDemoRosterSelection({alignment:'dark',pieces})).toThrow('not admitted')
  })
  it('rejects an injected PVE piece even if the caller removes its flag',async()=>{
    const template={...DEFAULT_PIECES['pve-zombie'],availability:undefined}
    await expect(createInitialBattleForPlayers(['a','b'],[template])).rejects.toThrow('未开放给 PVP')
  })
  it('blocks PVE cards during execution and never activates draft cards',()=>{
    const pvp={extensions:{},customCards:{}} as BattleState
    const card:CardDefinition={id:'test-pve-card',name:'test',description:'test',type:'active',code:'function executeCard(){return {success:true}}',availability:{modes:['pve'],status:'ready'}}
    expect(executeCardFunction(card,'a',pvp).success).toBe(false)
    expect(()=>loadCardForBattle(pvp,'pve-blood-flame')).toThrow('专用内容或草案')
    expect(()=>loadCardForBattle({extensions:{contentMode:'pve'}} as unknown as BattleState,'pve-blood-flame')).toThrow('草案')
  })
  it('validates both catalogs strictly and rejects dangling references',()=>{
    expect(()=>RoguelikeAdventureV1Schema.parse({...read(worldPath),legacyNodes:[]})).toThrow()
    expect(()=>RoguelikeBuildsV1Schema.parse({...read('data/pve/roguelike/builds.json'),extra:true})).toThrow()
    expect(()=>validateRoguelikeReferences(files)).not.toThrow()
    expect(()=>validateRoguelikeReferences(files.filter(file=>file.path!=='data/maps/adventure-act-1-v1.json'))).toThrow('maps/adventure-act-1-v1')
    const invalidMap=clone(files)
    const altered=invalidMap.find(file=>file.path==='data/maps/adventure-act-1-v1.json')!.jsonValue
    altered.legend.find((entry:{char:string})=>entry.char==='#').walkable=true
    expect(()=>validateRoguelikeReferences(invalidMap)).toThrow('terrain semantics')
    expect(()=>validateRoguelikeReferences(files.filter(file=>file.path!=='data/cards/pve-blood-flame.json'))).toThrow('pve-blood-flame')
    expect(()=>validateRoguelikeReferences(files.filter(file=>file.path!=='images/adventure/zombie.svg'))).toThrow('zombie.svg')
  })
  it('includes new catalogs in the browser VFS payload',()=>{
    const payload=readClientProtocolBattleData({appRoot:process.cwd(),htmlRoot:path.resolve('data/pages'),activePackRoot:null,isPackaged:false})
    expect(payload[worldPath]).toEqual(read(worldPath))
    expect(payload['data/pve/roguelike/supplies.json']).toEqual(read('data/pve/roguelike/supplies.json'))
    expect(payload['data/cards/pve-blood-flame.json']).toBeDefined()
    expect(resolveClientProtocolFile({appRoot:process.cwd(),htmlRoot:path.resolve('data/pages'),activePackRoot:null,isPackaged:false,relativePath:'images/adventure/reaper.jpg'})).toBe(path.resolve('public/images/adventure/reaper.jpg'))
  })
  it('primes the page-side engine with exploration JSON and rejects unregistered nested paths',()=>{
    const window:{RvBGameEngine?:{primeJsonFiles:(files:Record<string,unknown>)=>number}}={}
    vm.runInNewContext(readFileSync('data/pages/js/game-engine-runtime.js','utf8'),{window,console})
    expect(window.RvBGameEngine!.primeJsonFiles({[worldPath]:read(worldPath),'data/pve/roguelike/builds.json':read('data/pve/roguelike/builds.json'), 'data/pve/roguelike/supplies.json':read('data/pve/roguelike/supplies.json')})).toBe(3)
    expect(()=>window.RvBGameEngine!.primeJsonFiles({'data/pve/roguelike/../../unknown.json':{}})).toThrow('资源路径无效')
  })
  it('round-trips the combined Base archive with new JSON and images',()=>{
    const archive=path.resolve('output/pve-roguelike/resources/base-with-exploration.rvbpack')
    writeArchiveFileV1(archive,base.source)
    const restored=resolveProfileV1({base:{source:readArchiveFileV1(archive),policy:base.policy}})
    expect(restored.profile.resolvedProfileHash).toBe(profile.profile.resolvedProfileHash)
    expect(restored.readFile('images/adventure/zombie.svg')).toBeDefined()
    expect(restored.readFile(worldPath)).toEqual(profile.readFile(worldPath))
    expect(restored.readFile('data/pve/roguelike/supplies.json')).toEqual(profile.readFile('data/pve/roguelike/supplies.json'))
  })
  it('rejects renamed runtime paths and non-executable supply cards before activating a pack', () => {
    for (const field of ['suppliesPath', 'buildsPath']) {
      const world = read(worldPath); world.resources[field] = 'data/pve/roguelike/renamed.json'
      expect(() => RoguelikeAdventureV1Schema.parse(world)).toThrow()
    }
    for (const update of [{code:''}, {type:'unknown'}, {availability:{modes:['pve'],status:'draft'}}]) {
      const cardPath = 'data/cards/pve-light-spark.json', card = {...read(cardPath), ...update}
      expect(() => resolveProfileV1({base,patches:[patch(cardPath,card)]})).toThrow()
    }
  })
  it('a data-only map Patch changes the resolved identity and actual map initialization',()=>{
    const mapPath=`data/maps/${read(worldPath).map.id}.json`, map=read(mapPath)
    map.layout[2]='#C'+map.layout[2].slice(2)
    const updated=resolveProfileV1({base,patches:[patch(mapPath,map)]})
    const content=loadAdventureContent(relative=>JSON.parse(new TextDecoder().decode(updated.readFile('data/'+relative)!)))
    expect(updated.profile.authorityContentHash).not.toBe(profile.profile.authorityContentHash)
    expect(createAdventureMap(content).tiles.find(tile=>tile.x===1&&tile.y===2)?.props.type).toBe('cover')
    expect(createAdventureMap().tiles.find(tile=>tile.x===1&&tile.y===2)?.props.type).toBe('floor')
  })
  it('rejects a referenced-card removal without changing the parent Profile',()=>{
    const before=profile.profile.resolvedProfileHash
    expect(()=>resolveProfileV1({base,patches:[patch('data/cards/pve-blood-flame.json')]})).toThrow('PACK_REFERENCE_INVALID')
    expect(profile.profile.resolvedProfileHash).toBe(before)
    expect(profile.readFile('data/cards/pve-blood-flame.json')).toBeDefined()
  })
  it('rejects malformed availability through the actual pack validator',()=>{
    const card=read('data/cards/pve-blood-flame.json');card.availability={modes:['pve','pve'],status:'draft'}
    expect(()=>resolveProfileV1({base,patches:[patch('data/cards/pve-blood-flame.json',card)]})).toThrow('PACK_SCHEMA_INVALID')
  })
  it('requires a declared summon template even when removed from the direct enemy list',()=>{
    const altered=clone(files).filter(file=>file.path!=='data/pieces/pve-ghoul.json')
    const world=altered.find(file=>file.path===worldPath)!.jsonValue
    world.resources.pieceIds=world.resources.pieceIds.filter((id:string)=>id!=='pve-ghoul')
    const manifest=altered.find(file=>file.path==='data/pieces/manifest.json')!
    manifest.jsonValue=manifest.jsonValue.filter((id:string)=>id!=='pve-ghoul')
    expect(()=>validateRoguelikeReferences(altered)).toThrow('pve-ghoul')
  })
  it('keeps all configured party members as cores and accepts a single-zone snapshot',async()=>{
    const before=clone(adventureContent)
    try {
      adventureContent.party.pieceIds.push('ana')
      adventureContent.startingPositions[`${HUMAN}-3`]={x:6,y:25}
      const state=await createAdventureState(getServerGameProfileIdentityV1())
      expect(state.extensions?.adventureWorld.party.reserves.map((piece:{isCore:boolean})=>piece.isCore)).toEqual([true,true])
      zones.splice(1)
      expect(()=>new AdventureSession(state).snapshot()).not.toThrow()
    } finally {
      adventureContent.party.pieceIds.splice(0,Infinity,...before.party.pieceIds)
      delete adventureContent.startingPositions[`${HUMAN}-3`]
      zones.splice(0,Infinity,...before.zones)
    }
  })
  it('binds summoned ghoul stats from the shared template',()=>{
    const ghoul=DEFAULT_PIECES['pve-ghoul'],hp=ghoul.stats.maxHp
    try{ghoul.stats.maxHp=9;expect(bindAdventureSummonTemplate(getSkillById('pve-raise-dead')!).summonCapability).toMatchObject({fallback:{maxHp:9}})}finally{ghoul.stats.maxHp=hp}
  })
  it.each(['data/pieces/ana.json','data/skills/blood-echo-trigger.json','data/cards/holy-charge.json'])(
    'rejects missing recruitment dependency %s', path => {
      expect(()=>validateRoguelikeReferences(files.filter(file=>file.path!==path))).toThrow(path.split('/').pop()!.replace('.json',''))
    })
})

 it('rejects malformed PVE power before resource-pack activation', () => {
   for (const adventurePower of [null, {baseDamage:-1,usesGrowth:true}, {baseDamage:2,usesGrowth:'yes'}]) {
     const card = {...read('data/cards/pve-skirmish-calibrate.json'), adventurePower}
     expect(() => resolveProfileV1({base, patches:[patch('data/cards/pve-skirmish-calibrate.json',card)]})).toThrow()
   }
 })
