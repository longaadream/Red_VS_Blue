import type { BattleState } from '../../game/turn'
import { adventureBoundary, insideZone, isAdventureHuman, type AdventureEnemyPlan } from '../../game/adventure-boundary'
import { getLegalNormalMoveTargets, traceProjectile } from '../../game/spatial'
import { ENEMY } from './content'

/** Public plans preserve their direction; explicit tracking attacks preserve target identity. */
export function planAdventureEnemies(state: BattleState, followUp = true): AdventureEnemyPlan[] {
  const world = adventureBoundary(state)!, zone = world.activeZone
  if (!zone) return []
  const round = world.party?.battleRound ?? 1
  const targets = state.pieces.filter(p => isAdventureHuman(state, p.ownerPlayerId) && p.currentHp > 0 && insideZone(zone,p.x,p.y))
  if (!targets.length) return []
  const distance = (x:number,y:number) => Math.min(...targets.map(p => Math.abs(x-p.x!)+Math.abs(y-p.y!)))
  const floor = new Set(state.map.tiles.filter(t => t.props.walkable && insideZone(zone, t.x, t.y)).map(t => `${t.x},${t.y}`))
  const pathDistance = new Map(targets.map(t => [`${t.x},${t.y}`, 0])), queue = targets.map(t => ({ x: t.x!, y: t.y! }))
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const cell = { x: queue[i].x + dx, y: queue[i].y + dy }, key = `${cell.x},${cell.y}`
    if (floor.has(key) && !pathDistance.has(key)) { pathDistance.set(key, pathDistance.get(`${queue[i].x},${queue[i].y}`)! + 1); queue.push(cell) }
  }
  const sources = state.pieces.filter(p => p.ownerPlayerId === ENEMY && p.currentHp > 0 && world.activeEnemyIds.includes(p.instanceId) && insideZone(zone,p.x,p.y))
    .sort((a,b) => distance(a.x!,a.y!)-distance(b.x!,b.y!) || a.instanceId.localeCompare(b.instanceId))
  const plans: AdventureEnemyPlan[] = []
  for (const p of sources) {
    const origin={x:p.x!,y:p.y!}
    const base = {id:`${zone.id}:${round}:${p.instanceId}`,sourceId:p.instanceId,round,origin}
    const summonReady = p.skills.some(s => s.skillId === 'pve-raise-dead' && (s.currentCooldown ?? 0) <= 1)
    if (summonReady && round >= 2 && !state.pieces.some(p => p.templateId === 'pve-ghoul' && p.currentHp > 0 && world.activeEnemyIds.includes(p.instanceId))) {
      const cell = state.map.tiles.find(t=>t.props.walkable && insideZone(zone,t.x,t.y) && Math.abs(t.x-p.x!)+Math.abs(t.y-p.y!)<=2
        && !state.pieces.some(piece=>piece.currentHp>0&&piece.x===t.x&&piece.y===t.y))
      if (cell) { plans.unshift({...base,kind:'summon',cells:[{x:cell.x,y:cell.y}],action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:'pve-raise-dead'}}); continue }
    }
    if(p.skills.some(s=>s.skillId==='pve-tracking-slash')&&round%2===0){
      const target=[...targets].sort((a,b)=>Math.abs(a.x!-p.x!)+Math.abs(a.y!-p.y!)-Math.abs(b.x!-p.x!)-Math.abs(b.y!-p.y!)||a.instanceId.localeCompare(b.instanceId)).find(t=>Math.abs(t.x!-p.x!)+Math.abs(t.y!-p.y!)<=4)
      if(target){plans.push({...base,kind:'attack',trackingTargetId:target.instanceId,cells:[{x:target.x!,y:target.y!}],action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:'pve-tracking-slash'}});continue}
    }
    if(p.skills.some(s=>s.skillId==='pve-hook')&&round%2===1&&!targets.some(t=>Math.abs(t.x!-p.x!)+Math.abs(t.y!-p.y!)===1)){
      let hooked=false
      for(const [x,y] of [[0,-1],[1,0],[0,1],[-1,0]]){
        const events=traceProjectile(state,origin,{x,y},{maxDistance:4,excludePieceId:p.instanceId})
        const first=events.find(e=>e.type==='piece'||e.type==='terrain'&&e.blocksProjectile||e.type==='boundary')
        if(first?.type!=='piece'||!isAdventureHuman(state,first.piece.ownerPlayerId))continue
        const cells:{x:number;y:number}[]=[]
        for(const e of events){if(e.type==='boundary'||e.type==='terrain'&&e.blocksProjectile)break;if(insideZone(zone,e.x,e.y)&&!cells.some(c=>c.x===e.x&&c.y===e.y))cells.push({x:e.x,y:e.y})}
        plans.push({...base,kind:'attack',cells,action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:'pve-hook'}});hooked=true;break
      }
      if(hooked)continue
    }
    const shotSkill=p.skills.find(s=>s.skillId==='pve-shot'||s.skillId==='pve-blaster')?.skillId,shot=!!shotSkill,ranged = shot || p.skills.some(s=>s.skillId==='pve-arrow')
    const range = shot ? 5 : 4
    if (ranged) {
      const rays = [[0,-1],[1,0],[0,1],[-1,0]].map(([x,y]) => {
        const events = traceProjectile(state,origin,{x,y},{maxDistance:range,excludePieceId:p.instanceId})
        const first = events.find(e=>e.type==='piece'||e.type==='terrain'&&e.blocksProjectile||e.type==='boundary')
        return {events,first}
      })
      const ray = rays.find(r=>r.first?.type==='piece' && isAdventureHuman(state,r.first.piece.ownerPlayerId))
      if (ray) {
        const cells: {x:number;y:number}[]=[]
        for(const e of ray.events) {
          if(e.type==='boundary'||e.type==='terrain'&&e.blocksProjectile) break
          if(insideZone(zone,e.x,e.y) && !cells.some(c=>c.x===e.x&&c.y===e.y)) cells.push({x:e.x,y:e.y})
        }
        plans.push({...base,kind:'attack',cells,action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:shotSkill??'pve-arrow'}});continue
      }
    } else {
      const target=targets.find(t=>Math.abs(t.x!-p.x!)+Math.abs(t.y!-p.y!)===1)
      if(target){
        const sweep=p.skills.some(s=>s.skillId==='pve-sweep')
        const cells=sweep?[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:p.x!+dx,y:p.y!+dy})).filter(c=>insideZone(zone,c.x,c.y)):[{x:target.x!,y:target.y!}]
        plans.push({...base,kind:'attack',cells,action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:sweep?'pve-sweep':'pve-claw'}});continue
      }
    }
    const moves=getLegalNormalMoveTargets(state,p).filter(c=>insideZone(zone,c.x,c.y))
    const value=(x:number,y:number)=>{
      const aligned = ranged && targets.some(t => {
        if ((t.x !== x && t.y !== y) || Math.abs(x-t.x!)+Math.abs(y-t.y!) > range) return false
        const events = traceProjectile(state, { x, y }, { x: Math.sign(t.x! - x), y: Math.sign(t.y! - y) }, { maxDistance: range, excludePieceId: p.instanceId })
        const first = events.find(e => e.type === 'piece' || e.type === 'terrain' && e.blocksProjectile || e.type === 'boundary')
        return first?.type === 'piece' && isAdventureHuman(state, first.piece.ownerPlayerId)
      })
      return (pathDistance.get(`${x},${y}`) ?? Infinity)-(aligned?6:0)
    }
    moves.sort((a,b)=>value(a.x,a.y)-value(b.x,b.y)||a.y-b.y||a.x-b.x)
    const to=moves.find(c=>value(c.x,c.y)<value(p.x!,p.y!))
    if(to){
      const dx=Math.sign(to.x-p.x!),dy=Math.sign(to.y-p.y!),cells=[]
      for(let n=1;n<=Math.max(Math.abs(to.x-p.x!),Math.abs(to.y-p.y!));n++)cells.push({x:p.x!+dx*n,y:p.y!+dy*n})
      plans.push({...base,kind:'move',cells,action:{type:'move',playerId:ENEMY,pieceId:p.instanceId,toX:to.x,toY:to.y}})
      if(followUp){
        const projected={...state,pieces:state.pieces.map(piece=>piece.instanceId===p.instanceId?{...piece,x:to.x,y:to.y}:piece)}
        const attack=planAdventureEnemies(projected,false).find(plan=>plan.sourceId===p.instanceId&&plan.kind==='attack')
        if(attack)plans.push({...attack,id:base.id+':follow-up'})
      }
    }
  }
  return plans
}

export function adventurePlanInvalidReason(state: BattleState, plan: AdventureEnemyPlan): string | undefined {
  const world=adventureBoundary(state)!,p=state.pieces.find(p=>p.instanceId===plan.sourceId&&p.currentHp>0)
  if(!p) return '施术者已被击败'
  if(p.ownerPlayerId!==ENEMY || !world.activeEnemyIds.includes(p.instanceId))return '施术者已不属于敌方战区'
  if(p.x!==plan.origin.x||p.y!==plan.origin.y) return '起点已改变'
  if(plan.round!==(world.party?.battleRound??1)) return '计划已过期'
  if(world.activeZone ? plan.cells.some(c=>!insideZone(world.activeZone!,c.x,c.y))
    : plan.kind !== 'move' || !world.roamingEnemyIds?.includes(plan.sourceId))return '战区已改变'
  if(plan.kind==='move'||plan.kind==='summon')for(const cell of plan.cells){
    if(!state.map.tiles.some(t=>t.x===cell.x&&t.y===cell.y&&t.props.walkable)||state.pieces.some(p=>p.currentHp>0&&p.x===cell.x&&p.y===cell.y))return '预告路径或落点被占据'
  }
  return undefined
}

/** Preserve the announced direction, stopping on the last free square before an obstruction. */
export function shortenBlockedAdventureMove(state:BattleState):boolean {
  const world=adventureBoundary(state)!,plan=world.plans?.[0]
  if(!plan||plan.kind!=='move'||plan.action.type!=='move'||adventurePlanInvalidReason(state,plan)!=='预告路径或落点被占据')return false
  const source=state.pieces.find(p=>p.instanceId===plan.sourceId&&p.currentHp>0)
  if(!source||source.x!==plan.origin.x||source.y!==plan.origin.y)return false
  const blocked=plan.cells.findIndex(c=>!state.map.tiles.some(t=>t.x===c.x&&t.y===c.y&&t.props.walkable)||state.pieces.some(p=>p.currentHp>0&&p.x===c.x&&p.y===c.y))
  if(blocked<0)return false
  const cells=plan.cells.slice(0,blocked),stop=cells.at(-1)??plan.origin
  const plannedEnd={x:plan.action.toX,y:plan.action.toY}
  const following=world.plans!.find(p=>p.id===plan.id+':follow-up')
  if(following){
    const dx=stop.x-plannedEnd.x,dy=stop.y-plannedEnd.y
    following.origin={...stop}
    if(!following.trackingTargetId)following.cells=following.cells.map(c=>({x:c.x+dx,y:c.y+dy})).filter(c=>!world.activeZone||insideZone(world.activeZone,c.x,c.y))
  }
  plan.cells=cells;plan.action={...plan.action,toX:stop.x,toY:stop.y}
  if(!cells.length)world.plans!.shift()
  if(world.coop&&world.activeZone){const zone=world.coop.encounters[world.activeZone.id];if(zone)zone.plans=world.plans!}
  return true
}
