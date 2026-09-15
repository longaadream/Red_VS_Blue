import {safeCloneBattleState,type BattleState} from '../../game/turn'
import {adventureBoundary,selectAdventureActor,isAdventureHuman} from '../../game/adventure-boundary'
import {runBattleActionIsolated} from '../../game/battle-runner'
import {adventureCards} from '../../game/adventure-card-state'
import {loadCardForBattle} from '../../game/skills'
import {shortenBlockedAdventureMove,adventurePlanInvalidReason} from './plans'

export function adventureCardCounters(state:BattleState,playerId:string){
  const ledger=adventureCards(state)?.players[playerId]
  const ids=new Set([...(state.players.find(p=>p.playerId===playerId)?.hand??[]).map(c=>c.cardId),...Object.keys(ledger?.growth??{})])
  const cards:Record<string,{baseDamage:number;growth:number;damage:number}>={}
  for(const id of ids){
    const def=loadCardForBattle(state,id),power=def?.adventurePower
    if(!power)continue
    const growth=power.usesGrowth?(ledger?.growth[id]??0):0
    cards[id]={baseDamage:power.baseDamage,growth,damage:power.baseDamage+growth}
  }
  return {cards,passiveHits:{...ledger?.passiveHits}}
}
export interface AdventureThreatForecast {
  complete:boolean
  note:string
  pieces:Record<string,{hp:number;remainingHp:number;dies:boolean}>
}
/** A read-only projection of published actions, not a simulation of future player choices or end-turn effects. */
export function forecastAdventureThreats(source:BattleState):AdventureThreatForecast {
  const result:AdventureThreatForecast={complete:true,note:'按当前站位及已公布行动；不计后续操作、回合结束效果和未触发的条件攻击。',pieces:{}}
  const original=adventureBoundary(source)
  if(!original)return result
  const groups=original.coop?Object.values(original.coop.encounters).map(z=>({id:z.id,plans:z.plans})):original.activeZone?[{id:original.activeZone.id,plans:original.plans??[]}]:[]
  if(!groups.some(g=>g.plans.length))return result
  let state=safeCloneBattleState(source),budget=0
  delete state.pendingTargetSelection;delete state.pendingOptionSelection
  const enemy=original.coop?.enemyId??state.players.find(p=>!isAdventureHuman(source,p.playerId))?.playerId
  if(!enemy)return result
  state.turn.currentPlayerId=enemy;state.turn.phase='action'
  for(const group of groups){
    let world=adventureBoundary(state)!
    if(world.coop)selectAdventureActor(state,enemy,group.id)
    world=adventureBoundary(state)!
    world.plans=JSON.parse(JSON.stringify(group.plans))
    if(world.coop)world.coop.encounters[group.id].plans=world.plans!
    while(world.plans?.length&&!state.terminalResult){
      if(++budget>64)return {complete:false,note:'预告过多，暂无法完整预测。',pieces:{}}
      const first=world.plans[0]
      shortenBlockedAdventureMove(state)
      if(world.plans[0]?.id!==first.id)continue
      const plan=world.plans[0]
      if(adventurePlanInvalidReason(state,plan)){world.plans.shift();continue}
      try{state=runBattleActionIsolated(state,plan.action).state}
      catch(error){
        if(error instanceof Error&&error.name==='BattleRuleError'){world.plans.shift();continue}
        return {complete:false,note:'预告预测暂不可用：'+(error instanceof Error?error.message:String(error)),pieces:{}}
      }
      world=adventureBoundary(state)!
      world.plans?.shift()
      if(state.pendingOptionSelection||state.pendingTargetSelection)return {complete:false,note:'预告包含待选择效果，暂不能确定结果。',pieces:{}}
    }
  }
  const survivors=[...state.pieces,...state.graveyard,...(state.extensions?.removedPieces??[])]
  for(const piece of source.pieces.filter(p=>isAdventureHuman(source,p.ownerPlayerId)&&p.currentHp>0&&p.x!==null)){
    const after=survivors.find(p=>p.instanceId===piece.instanceId),remainingHp=Math.max(0,after?.currentHp??0)
    if(remainingHp<piece.currentHp)result.pieces[piece.instanceId]={hp:piece.currentHp,remainingHp,dies:remainingHp===0}
  }
  return result
}
