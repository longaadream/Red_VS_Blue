import { adventureContent as liveContent } from '@/lib/pve/roguelike/content'
import { AdventureSession, createAdventureState, HUMAN, ENEMY, zones } from './fixtures/legacy-adventure'
import {describe,it,expect} from 'vitest'
import {adventurePlanInvalidReason,shortenBlockedAdventureMove,planAdventureEnemies} from '@/lib/pve/roguelike/plans'
import {enemySkills, enemyTemplates} from '@/lib/pve/roguelike/enemies'
import {loadRuleById} from '@/lib/game/skills'
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
  it('stops on the last free announced square when the destination is occupied',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    cap.x=10;cap.y=25;w.activeEnemyIds=[`${ENEMY}-3`];w.plans=planAdventureEnemies(state)
    const plan=w.plans[0];expect(plan.kind).toBe('move')
    const target=plan.cells.at(-1)!,session=new AdventureSession(state)
    session.human({type:'move',playerId:HUMAN,pieceId:cap.instanceId,toX:target.x,toY:target.y},session.snapshot().revision)
    enemyPhase(session);const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===plan.sourceId)).toMatchObject(plan.cells.at(-2)??plan.origin)
    expect(result.world.plans).toHaveLength(0);expect(result.world.log[0]).toContain('阻挡')
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
    // Real encounters activate every member; native Tracer passives may hit a nearby minion.
    w.activeEnemyIds = [...zones[1].enemyIds]
    w.plans=planAdventureEnemies(state);expect(w.plans[0].kind).toBe('summon')
    const mark=w.plans[0].cells[0],remaining=w.plans.slice(1),session=new AdventureSession(state);enemyPhase(session)
    const before=session.snapshot().state.players[1].actionPoints,result=session.step(session.snapshot().revision)
    const ghoul=result.state.pieces.find(p=>p.templateId==='pve-ghoul')!
    expect(ghoul, JSON.stringify({ log: result.world.log, plans: result.world.plans })).toMatchObject({...mark,isCore:false,ownerPlayerId:ENEMY,currentHp:enemyTemplates.find(p=>p.id==='pve-ghoul')!.stats.maxHp})
    expect(adventureBoundary(result.state)!.activeEnemyIds).toContain(ghoul.instanceId)
    expect(result.state.players[1].actionPoints).toBe(0);expect(before).toBe(0)
    expect(result.world.plans).toEqual(remaining)
  })
  it('summons in a live campaign without replacing or being blocked by other regions’ ghouls', async () => {
    const state = runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1(),liveContent),{type:'beginPhase'}).state
    const source = state.pieces.find(p=>p.templateId==='pve-arthas')!
    const zone = liveContent.zones.find(z=>z.enemyIds.includes(source.instanceId))!
    const world = adventureBoundary(state)!
    world.activeZone=zone;world.activeEnemyIds=[...zone.enemyIds];world.party!.battleRound=2;world.plansTurn=state.turn.turnNumber
    // Simulate this encounter's initial ghouls already defeated; others remain on the same map.
    state.pieces=state.pieces.filter(p=>p.templateId!=='pve-ghoul'||!zone.enemyIds.includes(p.instanceId))
    const outside=state.pieces.filter(p=>p.templateId==='pve-ghoul')
    expect(outside.length).toBeGreaterThan(0)
    const captain=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    captain.x=zone.x;captain.y=zone.y;captain.rules=[]
    world.plans=planAdventureEnemies(state)
    const summon=world.plans.find(p=>p.sourceId===source.instanceId&&p.kind==='summon')!
    expect(summon).toBeDefined()
    world.plans=[summon]
    const session=new AdventureSession(state,liveContent);enemyPhase(session)
    const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.filter(p=>p.templateId==='pve-ghoul'),JSON.stringify(result.world.log)).toHaveLength(outside.length+1)
    for(const piece of outside)expect(result.state.pieces.find(p=>p.instanceId===piece.instanceId)).toMatchObject({templateId:piece.templateId,currentHp:piece.currentHp,x:piece.x,y:piece.y})
  })
  it('does not change a gate plan when inactive keep units change',async()=>{
    const state=await fixture(),before=planAdventureEnemies(state)
    const keep=state.pieces.find(p=>p.instanceId===`${ENEMY}-2`)!
    keep.currentHp=1;keep.x=28;keep.y=6
    expect(planAdventureEnemies(state)).toEqual(before)
  })
  it.each([13,14])('attacks from the actual stopping square when blocked at x=%i',async(blockX)=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!,foe=state.pieces.find(p=>p.templateId==='pve-zombie')!
    cap.x=15;cap.y=23;cap.currentHp=cap.maxHp=30;cap.defense=0;cap.rules=[]
    foe.x=12;foe.y=23;w.activeEnemyIds=[foe.instanceId];w.plans=planAdventureEnemies(state)
    expect(w.plans.map(p=>p.kind)).toEqual(['move','attack'])
    const session=new AdventureSession(state)
    session.human({type:'move',playerId:HUMAN,pieceId:cap.instanceId,toX:blockX,toY:23},session.snapshot().revision)
    enemyPhase(session)
    let result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===foe.instanceId)?.x).toBe(blockX-1)
    result=session.step(result.revision)
    expect(result.state.pieces.find(p=>p.instanceId===cap.instanceId)?.currentHp).toBe(30-foe.attack)
  })
  it('hooks a distant target into an adjacent free square',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!,foe=state.pieces.find(p=>p.instanceId===w.activeEnemyIds[0])!
    cap.x=12;cap.y=23;cap.currentHp=cap.maxHp=30;cap.defense=0;cap.rules=[]
    foe.x=16;foe.y=23;foe.attack=5;foe.skills=[{skillId:'pve-hook',level:1,currentCooldown:0},{skillId:'pve-sweep',level:1,currentCooldown:0}]
    state.pieces=[cap,foe];w.plans=planAdventureEnemies(state)
    expect(w.plans[0].action).toMatchObject({skillId:'pve-hook'})
    const session=new AdventureSession(state);enemyPhase(session)
    const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===cap.instanceId)).toMatchObject({x:15,y:23,currentHp:25})
  })
  it('tracking slash follows its locked target after movement instead of hitting the old square',async()=>{
    const state=await fixture(0,2),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!,foe=state.pieces.find(p=>p.instanceId===w.activeEnemyIds[0])!
    cap.x=14;cap.y=23;cap.currentHp=cap.maxHp=30;cap.defense=0;cap.rules=[]
    foe.x=16;foe.y=23;foe.attack=5;foe.skills=[{skillId:'pve-tracking-slash',level:1,currentCooldown:0}]
    state.pieces=[cap,foe];w.plans=planAdventureEnemies(state)
    expect(w.plans[0].trackingTargetId).toBe(cap.instanceId)
    const session=new AdventureSession(state)
    session.human({type:'move',playerId:HUMAN,pieceId:cap.instanceId,toX:14,toY:24},session.snapshot().revision)
    enemyPhase(session)
    const result=session.step(session.snapshot().revision)
    expect(result.state.pieces.find(p=>p.instanceId===cap.instanceId)).toMatchObject({x:14,y:24,currentHp:25})
  })
  it('overwatch fires after human movement at most once each player turn',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!,foe=state.pieces.find(p=>p.instanceId===w.activeEnemyIds[0])!
    cap.x=14;cap.y=24;cap.currentHp=cap.maxHp=30;cap.defense=0;cap.rules=[]
    foe.x=16;foe.y=23;foe.attack=4;foe.skills=[{skillId:'pve-overwatch',level:1,currentCooldown:0}];foe.rules=[JSON.parse(JSON.stringify(loadRuleById('rule-pve-overwatch')))]
    state.pieces=[cap,foe]
    const first=runBattleActionIsolated(state,{type:'move',playerId:HUMAN,pieceId:cap.instanceId,toX:14,toY:23}).state
    expect(first.pieces.find(p=>p.instanceId===cap.instanceId)?.currentHp).toBe(26)
    const second=runBattleActionIsolated(first,{type:'move',playerId:HUMAN,pieceId:cap.instanceId,toX:15,toY:23}).state
    expect(second.pieces.find(p=>p.instanceId===cap.instanceId)?.currentHp).toBe(26)
  })
  it('executes the abomination sweep against both announced adjacent targets',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    const foe=state.pieces.find(p=>p.instanceId===w.activeEnemyIds[0])!
    foe.templateId='pve-abomination';foe.skills=[{skillId:'pve-sweep',level:1,currentCooldown:0}];foe.attack=5;foe.x=14;foe.y=23
    cap.x=13;cap.y=23;cap.maxHp=cap.currentHp=30;cap.defense=0;cap.rules=[]
    const ally={...structuredClone(cap),instanceId:'sweep-target',x:14,y:24,isCore:false}
    state.pieces=[cap,foe,ally];w.plans=planAdventureEnemies(state)
    expect(w.plans[0].cells).toHaveLength(4)
    const session=new AdventureSession(state);enemyPhase(session)
    const result=session.step(session.snapshot().revision)
    for(const id of [cap.instanceId,ally.instanceId])expect(result.state.pieces.find(p=>p.instanceId===id)?.currentHp).toBe(25)
  })
  it('stops before occupation and preserves the following attack direction',async()=>{
    const state=await fixture(),w=adventureBoundary(state)!,cap=state.pieces.find(p=>p.ownerPlayerId===HUMAN)!
    const foe=state.pieces.find(p=>p.instanceId===zones[0].enemyIds.find(id=>state.pieces.find(p=>p.instanceId===id)?.templateId==='pve-zombie'))!
    state.pieces=[cap,foe];foe.x=12;foe.y=23;cap.x=15;cap.y=23
    w.activeEnemyIds=[foe.instanceId]
    const plans=planAdventureEnemies(state)
    expect(plans.map(p=>p.kind)).toEqual(['move','attack'])
    expect(plans[1].origin).toEqual(plans[0].cells.at(-1))
    cap.x=plans[0].cells.at(-1)!.x;cap.y=plans[0].cells.at(-1)!.y
    expect(adventurePlanInvalidReason(state,plans[0])).toContain('被占据')
    w.plans=plans
    expect(shortenBlockedAdventureMove(state)).toBe(true)
    const attack=w.plans.find(p=>p.kind==='attack')!
    const move=w.plans.find(p=>p.kind==='move')
    const stop=move?.cells.at(-1)??{x:foe.x,y:foe.y}
    expect(attack.origin).toEqual(stop)
    expect(attack.cells).toContainEqual({x:cap.x,y:cap.y})
  })
  it('plans each enemy independently of action points',async()=>{
    const state=await fixture(0,1),w=adventureBoundary(state)!
    w.activeEnemyIds=[...zones[0].enemyIds]
    state.players[1].actionPoints=10
    const before=planAdventureEnemies(state);expect(before.length).toBeGreaterThan(1)
    state.players[1].actionPoints=0;expect(planAdventureEnemies(state)).toEqual(before)
    w.party!.battleRound=3
    const plans=planAdventureEnemies(state)
    for(const id of w.activeEnemyIds){
      const sequence=plans.filter(p=>p.sourceId===id)
      expect(sequence.length).toBeLessThanOrEqual(2)
      if(sequence.length===2)expect(sequence.map(p=>p.kind)).toEqual(['move','attack'])
    }
  })
})
