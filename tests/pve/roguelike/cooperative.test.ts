import { describe, expect, it } from 'vitest'
import { CooperativeAdventureSession, createCooperativeAdventure, adventureTurnOrder } from '@/lib/pve/roguelike/cooperative-session'
import {campaignAct} from '@/lib/pve/roguelike/campaign'
import { adventureContent, ENEMY } from '@/lib/pve/roguelike/content'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {planAdventureEnemies} from '@/lib/pve/roguelike/plans'
import { adventureBoundary, selectAdventureActor } from '@/lib/game/adventure-boundary'
import { areMatchAllies } from '@/lib/game/match-teams'

async function setup(count=4,act=0){
  const profile=getServerGameProfileIdentityV1(), content=structuredClone(act?campaignAct(adventureContent,act,42):adventureContent)
  const seats=Array.from({length:count},(_,i)=>({playerId:`coop-${i}`,name:`队伍${i}`,pieceIds:['tracer','uther']}))
  const state=await createCooperativeAdventure(profile,content,seats)
  return {state,session:new CooperativeAdventureSession(state,content,profile),seats,content}
}
describe('cooperative adventure authority',()=>{
  it('creates four independent parties and one hostile faction',async()=>{
    const {state,session,seats}=await setup()
    expect(state.players).toHaveLength(5)
    expect(areMatchAllies(state,seats[0].playerId,seats[1].playerId)).toBe(true)
    expect(areMatchAllies(state,seats[0].playerId,ENEMY)).toBe(false)
    for(const seat of seats){
      const snapshot=session.snapshot(seat.playerId)
      expect(snapshot.deployment.pieces).toHaveLength(1)
      expect(snapshot.deployment.pieces[0].ownerPlayerId).toBe(seat.playerId)
      expect(snapshot.world.coins).toBe(0)
      expect(state.players.find(p=>p.playerId===seat.playerId)?.actionPoints).toBe(3)
    }
    expect(Object.keys(adventureBoundary(state)!.coop!.parties)).toHaveLength(4)
  })
  it('runs each human before one enemy phase, then uses the next seeded order',async()=>{
    const {session}=await setup(2)
    const first=session.snapshot(),order=first.world.order
    for(const id of order){
      let snap=session.snapshot(id)
      expect(snap.state.turn.currentPlayerId).toBe(id)
      if(snap.state.turn.phase==='start')snap=session.human({type:'beginPhase'},snap.revision,id)
      snap=session.human({type:'endTurn',playerId:id},snap.revision,id)
      session.human({type:'beginPhase'},snap.revision,id)
    }
    expect(session.snapshot().state.turn.currentPlayerId).toBe(ENEMY)
    for(let i=0;i<4&&session.snapshot().state.turn.currentPlayerId===ENEMY;i++)session.step(session.snapshot().revision)
    const next=session.snapshot()
    expect(next.world.worldRound).toBe(2)
    expect(next.world.order).toEqual(adventureTurnOrder(order,adventureContent.party.seed,2))
  })
  it('rejects other players’ commands and preserves revision on rejection',async()=>{
    const {session,seats}=await setup(2),snap=session.snapshot(),owner=snap.state.turn.currentPlayerId
    const other=seats.find(s=>s.playerId!==owner)!.playerId
    expect(()=>session.human({type:'endTurn',playerId:owner},snap.revision,other)).toThrow()
    expect(session.snapshot(owner).revision).toBe(snap.revision)
  })
  it.each([1,2])('cooperative enemy stops before blocker %i and continues the attack',async(offset)=>{
    const {state,content,seats}=await setup(2),w=adventureBoundary(state)!,definition=content.zones[0],id=seats[0].playerId
    const zone={...structuredClone(definition),participants:[id],scaledPlayers:1,round:1,plans:[] as ReturnType<typeof planAdventureEnemies>,plannedRound:1}
    w.coop!.encounters[zone.id]=zone;w.coop!.playerZones[id]=zone.id
    const source=state.pieces.find(p=>zone.coreIds.includes(p.instanceId))!,cap=state.pieces.find(p=>p.ownerPlayerId===id)!
    const x=zone.x+2,y=zone.y+2
    for(const tile of state.map.tiles.filter(t=>t.y===y&&t.x>=x&&t.x<=x+3))tile.props={...tile.props,walkable:true,bulletPassable:true}
    source.x=x;source.y=y;source.moveRange=2;source.attack=5;source.skills=[{skillId:'pve-claw',level:1,currentCooldown:0}]
    cap.x=x+3;cap.y=y;cap.currentHp=cap.maxHp=30;cap.defense=0;cap.rules=[];cap.skills=[]
    selectAdventureActor(state,id,zone.id);w.activeEnemyIds=[source.instanceId]
    zone.plans=planAdventureEnemies(state)
    expect(zone.plans.map(p=>p.kind)).toEqual(['move','attack'])
    cap.x=x+offset
    state.turn.currentPlayerId=ENEMY;state.turn.phase='action'
    const session=new CooperativeAdventureSession(state,content,getServerGameProfileIdentityV1())
    let result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===source.instanceId)?.x).toBe(x+offset-1)
    result=session.step(result.revision)
    expect(result.state.pieces.find(p=>p.instanceId===cap.instanceId)?.currentHp).toBe(25)
  })
  it.each([0,1,2])('scales act %i elite baseline health for each joining team without compounding',async(act)=>{
    const {state,session,content,seats}=await setup(4,act)
    const zone={...structuredClone(content.zones.find(z=>z.elite)!),participants:[seats[0].playerId],scaledPlayers:1,round:1,plans:[]}
    const boss=state.pieces.find(p=>zone.coreIds.includes(p.instanceId))!,base=boss.maxHp
    const scale=session as unknown as {scaleEncounter:(s:typeof state,z:typeof zone)=>void}
    for(let count=2;count<=4;count++){
      zone.participants=seats.slice(0,count).map(s=>s.playerId)
      scale.scaleEncounter(state,zone)
      expect(boss.maxHp).toBe(Math.ceil(base*(1+.25*(count-1))))
      const hp=boss.maxHp;scale.scaleEncounter(state,zone);expect(boss.maxHp).toBe(hp)
    }
  })
  it('opens independent encounters and scales only when a second team participates',async()=>{
    const {state,content}=await setup(2),ids=adventureBoundary(state)!.coop!.order
    const [a,b]=content.zones
    for(const [index,id] of ids.entries()){
      const zone=index?b:a,p=state.pieces.find(p=>p.ownerPlayerId===id)!
      p.x=zone.x;p.y=zone.y-1
    }
    const session=new CooperativeAdventureSession(state,content,getServerGameProfileIdentityV1())
    for(const [index,id] of ids.entries()){
      const zone=index?b:a
      let snap=session.snapshot(id)
      snap=session.human({type:'beginPhase'},snap.revision,id)
      const p=snap.state.pieces.find(p=>p.ownerPlayerId===id)!
      snap=session.human({type:'move',playerId:id,pieceId:p.instanceId,toX:zone.x,toY:zone.y},snap.revision,id)
      expect(snap.world.encounters.find(e=>e.id===zone.id)?.scaledPlayers).toBe(1)
      expect(snap.state.players.find(p=>p.playerId===id)?.actionPoints).toBe(1)
      if(!index){snap=session.human({type:'endTurn',playerId:id},snap.revision,id);session.human({type:'beginPhase'},snap.revision,id)}
    }
    expect(session.snapshot().world.encounters).toHaveLength(2)
    expect(session.canSave()).toBe(false)
  }, 15000)
})
