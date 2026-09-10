import {describe,it,expect} from 'vitest'
import {AdventureSession,createAdventureState} from '@/lib/pve/roguelike/session'
import {planAdventureEnemies} from '@/lib/pve/roguelike/plans'
import {HUMAN,ENEMY,zones} from '@/lib/pve/roguelike/content'
import {enemySkills} from '@/lib/pve/roguelike/enemies'
import {adventureBoundary} from '@/lib/game/adventure-boundary'
import {runBattleActionIsolated} from '@/lib/game/battle-runner'
import {getServerGameProfileIdentityV1} from '@/lib/content-pipeline/runtime/profile-game-identity'

async function fixture(zoneIndex=0,round=3) {
  const initial=await createAdventureState(getServerGameProfileIdentityV1())
  const state=runBattleActionIsolated(initial,{type:'beginPhase'}).state
  const w=adventureBoundary(state)!;w.activeZone=zones[zoneIndex];w.activeEnemyIds=[`${ENEMY}-${zoneIndex+1}`];w.party!.battleRound=round;w.plansTurn=state.turn.turnNumber
  const captain=state.pieces.find(p=>p.instanceId===`${HUMAN}-1`)!
  captain.x=zoneIndex?24:14;captain.y=zoneIndex?10:23;captain.skills=[]
  state.players[0].actionPoints=3
  return state
}
function enemyPhase(session:AdventureSession) {
  session.human({type:'endTurn',playerId:HUMAN},session.snapshot().revision)
  for(let n=0;n<6;n++){
    const v=session.snapshot()
    if(v.inputOwner===ENEMY && v.state.turn.phase==='action')return
    if(v.inputOwner===ENEMY)session.step(v.revision)
    else session.human({type:'beginPhase'},v.revision)
  }
  throw Error('Enemy phase not reached')
}
describe('public PVE enemy plans',()=>{
  it('starts with cross-IP minions and dedicated PVE cores already on the map',async()=>{
    const state=await createAdventureState(getServerGameProfileIdentityV1())
    const foes=state.pieces.filter(p=>p.ownerPlayerId===ENEMY)
    expect(foes).toHaveLength(6)
    expect(foes.every(p=>p.x!==null&&p.y!==null)).toBe(true)
    expect(foes.filter(p=>p.isCore).map(p=>p.templateId)).toEqual(['pve-reaper','pve-arthas'])
    expect(foes.every(p=>p.skills.every(s=>s.skillId in enemySkills))).toBe(true)
  })
  it.each([[14,23],[18,23],[16,21],[16,25]])('announces and actually fires toward (%i,%i)',async(x,y)=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    cap.x=x;cap.y=y
    state.pieces=state.pieces.filter(p=>p.isCore)
    w.plans=planAdventureEnemies(state)
    expect(w.plans[0]).toMatchObject({kind:'attack',sourceId:`${ENEMY}-1`})
    expect(w.plans[0].cells).toContainEqual({x,y})
    const session=new AdventureSession(state);enemyPhase(session)
    const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===cap.instanceId)!.currentHp).toBeLessThan(cap.currentHp)
    expect(result.world.plans).toEqual([])
  })
  it('does not retarget when the player dodges the announced line',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!
    w.plans=planAdventureEnemies(state)
    const original=JSON.parse(JSON.stringify(w.plans))
    const session=new AdventureSession(state)
    session.human({type:'move',playerId:HUMAN,pieceId:`${HUMAN}-1`,toX:14,toY:24},session.snapshot().revision)
    expect(session.snapshot().world.plans).toEqual(original)
    session.human({type:'beginPhase'},session.snapshot().revision)
    expect(session.snapshot().world.plans).toEqual(original)
    enemyPhase(session);const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===`${HUMAN}-1`)!.currentHp).toBe(7)
  })
  it('cancels an occupied move without repathing or replacing the plan',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    cap.x=10;cap.y=25;w.activeEnemyIds=[`${ENEMY}-3`];w.plans=planAdventureEnemies(state)
    const plan=w.plans[0];expect(plan.kind).toBe('move')
    const target=plan.cells.at(-1)!,session=new AdventureSession(state)
    session.human({type:'move',playerId:HUMAN,pieceId:cap.instanceId,toX:target.x,toY:target.y},session.snapshot().revision)
    enemyPhase(session);const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===plan.sourceId)).toMatchObject(plan.origin)
    expect(result.world.plans).toHaveLength(0);expect(result.world.log[0]).toContain('作废')
  })
  it('executes a published movement at zero AP, but rejects an unannounced move',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    cap.x=10;cap.y=25;w.activeEnemyIds=[`${ENEMY}-3`];w.plans=planAdventureEnemies(state)
    const plan=w.plans[0],session=new AdventureSession(state);enemyPhase(session)
    expect(session.snapshot().state.players[1].actionPoints).toBe(0)
    const view=session.snapshot().state
    expect(()=>runBattleActionIsolated(view,{type:'move',playerId:ENEMY,pieceId:plan.sourceId,toX:14,toY:24})).toThrow()
    const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===plan.sourceId)).toMatchObject(plan.cells.at(-1)!)
    expect(result.state.players[1].actionPoints).toBe(0)
  })
  it('summons a ghoul through the formal skill, registers it, and uses no enemy AP',async()=>{
    const state=await fixture(1,2),w=adventureBoundary(state)!
    w.plans=planAdventureEnemies(state);expect(w.plans[0].kind).toBe('summon')
    const mark=w.plans[0].cells[0],session=new AdventureSession(state);enemyPhase(session)
    const before=session.snapshot().state.players[1].actionPoints,result=session.step(session.snapshot().revision)
    const ghoul=result.state.pieces.find(p=>p.templateId==='pve-ghoul')!
    expect(ghoul).toMatchObject({...mark,isCore:false,ownerPlayerId:ENEMY,currentHp:4})
    expect(adventureBoundary(result.state)!.activeEnemyIds).toContain(ghoul.instanceId)
    expect(result.state.players[1].actionPoints).toBe(0);expect(before).toBe(0)
    expect(result.world.plans).toEqual([])
  })
  it('does not change a gate plan when inactive keep units change',async()=>{
    const state=await fixture(),before=planAdventureEnemies(state)
    const keep=state.pieces.find(p=>p.instanceId===`${ENEMY}-2`)!
    keep.currentHp=1;keep.x=28;keep.y=6
    expect(planAdventureEnemies(state)).toEqual(before)
  })
  it('plans each enemy independently of action points',async()=>{
    const state=await fixture(0,1),w=adventureBoundary(state)!
    w.activeEnemyIds=[...zones[0].enemyIds]
    state.players[1].actionPoints=10
    const before=planAdventureEnemies(state);expect(before.length).toBeGreaterThan(1)
    state.players[1].actionPoints=0;expect(planAdventureEnemies(state)).toEqual(before)
    w.party!.battleRound=3
    expect(planAdventureEnemies(state).length).toBeLessThanOrEqual(3)
  })
})
