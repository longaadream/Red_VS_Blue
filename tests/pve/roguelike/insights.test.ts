import {createCooperativeAdventure,CooperativeAdventureSession} from '@/lib/pve/roguelike/cooperative-session'
import {adventureContent} from '@/lib/pve/roguelike/content'
import {selectAdventureActor} from '@/lib/game/adventure-boundary'
import {describe,it,expect} from 'vitest'
import {createAdventureState,HUMAN,ENEMY,zones} from './fixtures/legacy-adventure'
import {getServerGameProfileIdentityV1} from '@/lib/content-pipeline/runtime/profile-game-identity'
import {runBattleActionIsolated,hashBattleState} from '@/lib/game/battle-runner'
import {adventureBoundary} from '@/lib/game/adventure-boundary'
import {adventureCards} from '@/lib/game/adventure-card-state'
import {adventureCardCounters,forecastAdventureThreats} from '@/lib/pve/roguelike/insights'
import {planAdventureEnemies} from '@/lib/pve/roguelike/plans'
async function fixture(){
 const state=runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1()),{type:'beginPhase'}).state
 const w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.instanceId===HUMAN+'-1')!,foe=state.pieces.find(p=>p.instanceId===ENEMY+'-1')!
 w.activeZone=zones[0];w.activeEnemyIds=[foe.instanceId];w.party!.battleRound=1
 cap.x=14;cap.y=23;cap.rules=[];cap.skills=[];cap.defense=0;cap.currentHp=cap.maxHp=5
 foe.x=16;foe.y=23;foe.attack=6
 w.plans=planAdventureEnemies(state)
 return {state,w,cap,foe}
}
describe('adventure read-only insights',()=>{
 it('projects published lethal damage without changing live HP, plans or random state',async()=>{
  const {state,cap}=await fixture(),before=hashBattleState(state)
  const result=forecastAdventureThreats(state)
  expect(result.complete,result.note).toBe(true)
  expect(result.pieces[cap.instanceId]).toEqual({hp:5,remainingHp:0,dies:true})
  expect(hashBattleState(state)).toBe(before)
 })
 it('recomputes after dodging and respects defense instead of summing attack numbers',async()=>{
  const {state,cap}=await fixture();cap.defense=4
  const defended=forecastAdventureThreats(state)
  expect(defended.pieces[cap.instanceId]?.dies).not.toBe(true)
  cap.x=14;cap.y=24
  expect(forecastAdventureThreats(state).pieces[cap.instanceId]).toBeUndefined()
 })
 it('shows current card power from the same data used by card execution',async()=>{
  const {state,cap}=await fixture(),ledger=adventureCards(state)!.players[HUMAN]
  ledger.growth['pve-skirmish-calibrate']=6;ledger.passiveHits[cap.instanceId]=3
  const result=adventureCardCounters(state,HUMAN)
  expect(result.cards['pve-skirmish-calibrate']).toEqual({baseDamage:2,growth:6,damage:8})
  expect(result.passiveHits[cap.instanceId]).toBe(3)
 })
})


it('predicts two cooperative zones once and isolates each viewer and returned cache objects',async()=>{
 const profile=getServerGameProfileIdentityV1(),state=await createCooperativeAdventure(profile,adventureContent,[{playerId:'a',name:'a',pieceIds:['tracer','ana']},{playerId:'b',name:'b',pieceIds:['tracer','ana']}])
 const w=adventureBoundary(state)!,keep=new Set<string>()
 for(const [i,id] of ['a','b'].entries()){
  const zone={...adventureContent.zones[i],participants:[id],round:1,scaledPlayers:1,plans:[] as ReturnType<typeof planAdventureEnemies>}
  w.coop!.encounters[zone.id]=zone;w.coop!.playerZones[id]=zone.id
  const cap=state.pieces.find(p=>p.ownerPlayerId===id)!,foe=state.pieces.find(p=>zone.coreIds.includes(p.instanceId))!
  cap.x=zone.x+2;cap.y=zone.y+2;cap.currentHp=cap.maxHp=10;cap.rules=[];cap.skills=[];cap.defense=0
  foe.x=zone.x+3;foe.y=zone.y+2;foe.attack=3+i;foe.skills=[{skillId:'pve-claw',level:1,currentCooldown:0}]
  keep.add(cap.instanceId);keep.add(foe.instanceId)
  zone.plans=[{id:'intent-'+id,sourceId:foe.instanceId,round:1,kind:'attack',origin:{x:foe.x,y:foe.y},cells:[{x:cap.x,y:cap.y}],action:{type:'useBasicSkill',playerId:ENEMY,pieceId:foe.instanceId,skillId:'pve-claw'}}]
  adventureCards(state)!.players[id].growth['pve-skirmish-calibrate']=i?9:6
 }
 state.pieces=state.pieces.filter(p=>keep.has(p.instanceId))
 selectAdventureActor(state,'a')
 const session=new CooperativeAdventureSession(state,adventureContent,profile)
 const a=session.snapshot('a'),b=session.snapshot('b')
 expect(a.world.forecast.complete,a.world.forecast.note).toBe(true)
 expect(a.world.forecast.pieces['a-1']?.remainingHp).toBe(7)
 expect(a.world.forecast.pieces['b-1']?.remainingHp).toBe(6)
 expect(a.world.counters.cards['pve-skirmish-calibrate'].damage).toBe(8)
 expect(b.world.counters.cards['pve-skirmish-calibrate'].damage).toBe(11)
 a.world.counters.cards['pve-skirmish-calibrate'].damage=999
 a.world.forecast.pieces['a-1'].remainingHp=999
 expect(session.snapshot('a').world.counters.cards['pve-skirmish-calibrate'].damage).toBe(8)
 expect(session.snapshot('a').world.forecast.pieces['a-1'].remainingHp).toBe(7)
})
