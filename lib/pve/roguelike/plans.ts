import type { BattleState } from '../../game/turn'
import { adventureBoundary, insideZone, type AdventureEnemyPlan } from '../../game/adventure-boundary'
import { getLegalNormalMoveTargets, traceProjectile } from '../../game/spatial'
import { ENEMY, HUMAN } from './content'

/** Fixed public plans. Player movement never retargets the attack after publication. */
export function planAdventureEnemies(state: BattleState): AdventureEnemyPlan[] {
  const world = adventureBoundary(state)!, zone = world.activeZone
  if (!zone) return []
  const round = world.party?.battleRound ?? 1
  const targets = state.pieces.filter(p => p.ownerPlayerId === HUMAN && p.currentHp > 0 && insideZone(zone,p.x,p.y))
  if (!targets.length) return []
  const distance = (x:number,y:number) => Math.min(...targets.map(p => Math.abs(x-p.x!)+Math.abs(y-p.y!)))
  const sources = state.pieces.filter(p => p.ownerPlayerId === ENEMY && p.currentHp > 0 && world.activeEnemyIds.includes(p.instanceId) && insideZone(zone,p.x,p.y))
    .sort((a,b) => distance(a.x!,a.y!)-distance(b.x!,b.y!) || a.instanceId.localeCompare(b.instanceId))
  const plans: AdventureEnemyPlan[] = []
  for (const p of sources) {
    const origin={x:p.x!,y:p.y!}
    const base = {id:`${zone.id}:${round}:${p.instanceId}`,sourceId:p.instanceId,round,origin}
    const summonReady = p.skills.some(s => s.skillId === 'pve-raise-dead' && (s.currentCooldown ?? 0) <= 1)
    if (summonReady && round >= 2 && !state.pieces.some(p => p.templateId === 'pve-ghoul' && p.currentHp > 0)) {
      const cell = state.map.tiles.find(t=>t.props.walkable && insideZone(zone,t.x,t.y) && Math.abs(t.x-p.x!)+Math.abs(t.y-p.y!)<=2
        && !state.pieces.some(piece=>piece.currentHp>0&&piece.x===t.x&&piece.y===t.y))
      if (cell) { plans.unshift({...base,kind:'summon',cells:[{x:cell.x,y:cell.y}],action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:'pve-raise-dead'}}); continue }
    }
    const ranged = p.templateId === 'pve-reaper' || p.templateId === 'pve-skeleton'
    const range = p.templateId === 'pve-reaper' ? 5 : 4
    if (ranged) {
      const rays = [[0,-1],[1,0],[0,1],[-1,0]].map(([x,y]) => {
        const events = traceProjectile(state,origin,{x,y},{maxDistance:range,excludePieceId:p.instanceId})
        const first = events.find(e=>e.type==='piece'||e.type==='terrain'&&e.blocksProjectile||e.type==='boundary')
        return {events,first}
      })
      const ray = rays.find(r=>r.first?.type==='piece' && r.first.piece.ownerPlayerId===HUMAN)
      if (ray) {
        const cells: {x:number;y:number}[]=[]
        for(const e of ray.events) {
          if(e.type==='boundary'||e.type==='terrain'&&e.blocksProjectile) break
          if(insideZone(zone,e.x,e.y) && !cells.some(c=>c.x===e.x&&c.y===e.y)) cells.push({x:e.x,y:e.y})
        }
        plans.push({...base,kind:'attack',cells,action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:p.templateId==='pve-skeleton'?'pve-arrow':'pve-shot'}});continue
      }
    } else {
      const target=targets.find(t=>Math.abs(t.x!-p.x!)+Math.abs(t.y!-p.y!)===1)
      if(target){plans.push({...base,kind:'attack',cells:[{x:target.x!,y:target.y!}],action:{type:'useBasicSkill',playerId:ENEMY,pieceId:p.instanceId,skillId:'pve-claw'}});continue}
    }
    const moves=getLegalNormalMoveTargets(state,p).filter(c=>insideZone(zone,c.x,c.y))
    const value=(x:number,y:number)=>{
      const aligned = ranged && targets.some(t=>(t.x===x||t.y===y) && Math.abs(x-t.x!)+Math.abs(y-t.y!)<=range)
      return distance(x,y)-(aligned?6:0)
    }
    moves.sort((a,b)=>value(a.x,a.y)-value(b.x,b.y)||a.y-b.y||a.x-b.x)
    const to=moves.find(c=>value(c.x,c.y)<value(p.x!,p.y!))
    if(to){
      const dx=Math.sign(to.x-p.x!),dy=Math.sign(to.y-p.y!),cells=[]
      for(let n=1;n<=Math.abs(to.x-p.x!)+Math.abs(to.y-p.y!);n++)cells.push({x:p.x!+dx*n,y:p.y!+dy*n})
      plans.push({...base,kind:'move',cells,action:{type:'move',playerId:ENEMY,pieceId:p.instanceId,toX:to.x,toY:to.y}})
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
  if(!world.activeZone||plan.cells.some(c=>!insideZone(world.activeZone!,c.x,c.y)))return '战区已改变'
  if(plan.kind==='move'||plan.kind==='summon')for(const cell of plan.cells){
    if(!state.map.tiles.some(t=>t.x===cell.x&&t.y===cell.y&&t.props.walkable)||state.pieces.some(p=>p.currentHp>0&&p.x===cell.x&&p.y===cell.y))return '预告路径或落点被占据'
  }
  return undefined
}
