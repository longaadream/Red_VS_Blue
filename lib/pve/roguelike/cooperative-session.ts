import { AdventureSession, type WorldProgress } from './session'
import { adventureContent, adventureSupplies, ENEMY, createAdventureMap } from './content'
import { enemyTemplates, enemySkills, strengthenEliteGuards, completedAdventureRounds, upgradeWaitingEnemies } from './enemies'
import { createInitialBattleForPlayers } from '../../game/battle-setup'
import { getPieceById } from '../../game/piece-repository'
import { safeCloneBattleState, type BattleState, type BattleAction } from '../../game/turn'
import { adventureBoundary, selectAdventureActor, insideZone, type AdventureBoundary, type AdventureEnemyPlan } from '../../game/adventure-boundary'
import { initializeAdventureCards, adventureCards, hasAdventureCardChoice } from '../../game/adventure-card-state'
import { cleanupAdventureCards, supplyEncounter, withAdventureSupplyRuntime } from './supplies'
import { deriveStreamSeed, mulberry32 } from '../../game/rule-runtime'
import { getCurrentInputOwnerPlayerId } from '../../game/turn-timer'
import { planAdventureEnemies, adventurePlanInvalidReason, shortenBlockedAdventureMove } from './plans'
import { initializeRoaming, planRoamingEnemies, tryStartRoamingEncounter } from './roaming'
import { campaignAct } from './campaign'
import { recruitmentOffers } from './recruitment'
import type { GameProfileIdentityV1 } from '../../content-pipeline/runtime/profile-game-identity'
import type { RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
type Encounter = NonNullable<AdventureBoundary['coop']>['encounters'][string]
export interface AdventureSeat { playerId: string; name: string; pieceIds: string[]; familyId?:string }
const emptyProgress = (): WorldProgress => ({ coins: 0, cleared: [], claimed: [], log: [], campVisits: 0, recruited: [], dismissals: 0, upgrades: {} })
export function adventureTurnOrder(ids: string[], seed: number, round: number): string[] {
  const order = [...ids], random = mulberry32(deriveStreamSeed(seed, `adventure-order:${round}`))
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i],order[j]] = [order[j],order[i]] }
  return order
}
export async function createCooperativeAdventure(profile: GameProfileIdentityV1, content = adventureContent, seats: AdventureSeat[]) {
  if (!seats.length || seats.length > 4 || new Set(seats.map(s => s.playerId)).size !== seats.length
    || seats.some(s => !/^[a-z0-9-]{1,64}$/.test(s.playerId) || s.playerId === ENEMY || !s.pieceIds.length || s.pieceIds.length > 10)) throw new Error('冒险需要 1–4 个不同的玩家席位')
  const ids = adventureTurnOrder(seats.map(s => s.playerId), content.party.seed, 1)
  const map = createAdventureMap(content), positions = copy(content.startingPositions)
  const occupied = new Set(content.enemyLineup.map(e => `${positions[e.id].x},${positions[e.id].y}`))
  const origin = content.startingPositions[`${content.party.humanId}-1`]
  const available = map.tiles.filter(t => t.props.walkable && !content.zones.some(z => insideZone(z,t.x,t.y)))
    .sort((a,b) => Math.abs(a.x-origin.x)+Math.abs(a.y-origin.y)-Math.abs(b.x-origin.x)-Math.abs(b.y-origin.y) || a.y-b.y || a.x-b.x)
  for (const seat of seats) for (let i = 0; i < seat.pieceIds.length; i++) {
    const cell = available.find(t => !occupied.has(`${t.x},${t.y}`))
    if (!cell) throw new Error('起点没有足够的部署位置')
    positions[`${seat.playerId}-${i+1}`] = { x:cell.x,y:cell.y }; occupied.add(`${cell.x},${cell.y}`)
  }
  const template = (id: string) => { const p = enemyTemplates.find(p=>p.id===id) ?? getPieceById(id); if (!p) throw new Error(`缺少角色 ${id}`); return p }
  const state = await createInitialBattleForPlayers([...ids,ENEMY], [], [
    ...seats.map(s=>({playerId:s.playerId,faction:'red' as const,pieces:s.pieceIds.map(template)})),
    {playerId:ENEMY,faction:'blue',pieces:content.enemyLineup.map(e=>template(e.templateId))},
  ], undefined, { rootSeed:content.party.seed, firstPlayerId:ids[0], profileIdentity:profile,
    adventureWorld:{ map, humanId:ids[0], humanIds:ids, positions, skills:enemySkills,
      coreIds:[...seats.flatMap(s=>s.pieceIds.map((_,i)=>`${s.playerId}-${i+1}`)),...content.enemyLineup.filter(e=>e.core&&!content.zones.find(z=>z.id===e.zone)?.optional).map(e=>e.id)] } })
  if (!state) throw new Error('无法创建合作冒险')
  strengthenEliteGuards(state,content)
  for (const seat of seats) {
    state.players.find(p=>p.playerId===seat.playerId)!.name = seat.name
    if (adventureSupplies) {
      const relic=adventureSupplies.relics.find(r=>r.familyId===seat.familyId)
      initializeAdventureCards(state,seat.playerId,relic?[relic.id]:adventureSupplies.initialRelicIds)
    }
  }
  if (adventureCards(state)) adventureCards(state)!.rewards = {}
  initializeRoaming(state,content)
  return state
}

/** One authoritative aggregate; no client owns a second simulation. */
export class CooperativeAdventureSession extends AdventureSession {
  protected personal: Record<string,WorldProgress> = {}
  protected cleared: string[] = []
  protected patrolPlans: AdventureEnemyPlan[] = []
  protected checkpointPending = false
  constructor(state: BattleState, content: RoguelikeAdventureV1, profile: GameProfileIdentityV1) {
    super(state,content,profile)
    const coop = adventureBoundary(this.state)?.coop
    if (!coop) throw new Error('缺少合作冒险状态')
    for (const id of coop.humanIds) this.personal[id] = emptyProgress()
    this.select(coop.humanIds[0])
  }
  protected select(id: string) {
    if (!this.personal[id]) throw new Error('玩家不属于本次冒险')
    selectAdventureActor(this.state,id)
    this.playerId = id; this.progress = copy(this.personal[id]); this.progress.cleared = [...this.cleared]
  }
  override snapshot(viewerId = this.playerId) {
    const state = this.state, progress = this.progress, playerId = this.playerId
    this.state = safeCloneBattleState(state); this.select(viewerId)
    try {
      const result = super.snapshot(), world = adventureBoundary(this.state)!, coop = world.coop!
      if (result.world.cardProgress) {
        result.world.cardProgress.players = { [viewerId]: result.world.cardProgress.players[viewerId] }
        result.world.cardProgress.reward = result.world.cardProgress.rewards?.[viewerId]
        delete result.world.cardProgress.rewards
      }
      const publicWorld = adventureBoundary(result.state)!
      if (publicWorld.coop) for (const id of coop.humanIds) if (id !== viewerId) publicWorld.coop.parties[id].reserves = []
      const publicCards=adventureCards(result.state)
      if(publicCards){publicCards.players={[viewerId]:publicCards.players[viewerId]};publicCards.rewards=publicCards.rewards?.[viewerId]?{[viewerId]:publicCards.rewards[viewerId]}:{}}
      return { ...result, world: { ...result.world, worldRound:completedAdventureRounds(this.state)+1,
        plans:Object.values(coop.encounters).flatMap(e=>e.plans).concat(this.patrolPlans),
        stage:`第 ${this.actIndex+1} 幕 · 合作冒险`,
        encounters:copy(Object.values(coop.encounters)), order:[...coop.order],
        teammates:coop.humanIds.map(id=>({playerId:id,name:this.state.players.find(p=>p.playerId===id)!.name,
          captainId:coop.parties[id].captainId,absent:coop.absent.includes(id),zone:coop.playerZones[id]})),
        canSave:this.canSave(), checkpointPending:this.checkpointPending } }
    } finally { this.state=state;this.progress=progress;this.playerId=playerId }
  }
  canSave(): boolean {
    const world=adventureBoundary(this.state)!,coop=world.coop!
    return !Object.keys(coop.encounters).length && !this.state.pendingOptionSelection && !this.state.pendingTargetSelection
      && !coop.humanIds.some(id=>hasAdventureCardChoice(this.state,id))
      && this.state.turn.phase==='action' && coop.humanIds.includes(this.state.turn.currentPlayerId)
  }
  markCheckpointSaved(){this.checkpointPending=false}
  exportAggregate() {
    const state=safeCloneBattleState(this.state)
    const initial=safeCloneBattleState(this.initial)
    state.skillsById={};initial.skillsById={}
    selectAdventureActor(state,this.playerId)
    return copy({revision:this.revision,state,initial,content:this.content,campaign:this.campaign,
      actIndex:this.actIndex,personal:this.personal,cleared:this.cleared,offers:this.offers,patrolPlans:this.patrolPlans,
      playerId:this.playerId,profile:this.profile!,checkpointPending:this.checkpointPending})
  }
  static restoreAggregate(value: ReturnType<CooperativeAdventureSession['exportAggregate']>) {
    const data=copy(value)
    for(const state of [data.state,data.initial]) {
      state.skillsById={}
      adventureBoundary(state)!.skillDefinitions=copy(enemySkills)
    }
    const session=new CooperativeAdventureSession(data.state,data.content,data.profile)
    session.initial=data.initial;session.campaign=data.campaign;session.actIndex=data.actIndex
    session.personal=data.personal;session.cleared=data.cleared;session.offers=data.offers;session.revision=data.revision
    session.patrolPlans=data.patrolPlans;session.checkpointPending=data.checkpointPending
    session.select(data.playerId)
    return session
  }
  override human(action: BattleAction, revision: number, actor = this.playerId) {
    this.select(actor)
    if (adventureBoundary(this.state)!.coop!.absent.includes(actor)) throw new Error('该席位暂时缺席')
    if (action.type==='surrender') throw new Error('请通过房间菜单离开冒险')
    const result=super.human(action,revision)
    return {...result,...this.snapshot(actor)}
  }
  command(actor: string, type: string, payload: Record<string,unknown>) {
    this.select(actor)
    const revision=Number(payload.revision)
    if(type==='human') return this.human(payload.action as BattleAction,revision,actor)
    if(type==='interact') return payload.operation==='advance'
      ? this.advanceAct(String(payload.siteId),String(payload.pieceId),revision)
      : this.interact(String(payload.siteId),String(payload.operation),String(payload.pieceId),revision,String(payload.targetPieceId ?? payload.pieceId))
    if(type==='supply') return this.supply(String(payload.operation),String(payload.choice),revision)
    throw new Error('无效冒险指令')
  }
  setPresence(id:string,present:boolean) {
    if(!this.canSave())throw new Error('请等待全局节点结算')
    this.select(id)
    const stage=safeCloneBattleState(this.state),coop=adventureBoundary(stage)!.coop!,party=coop.parties[id]
    const captain=stage.pieces.find(p=>p.instanceId===party.captainId)
    if(present){
      coop.absent=coop.absent.filter(p=>p!==id)
      if(captain){
        const cell=stage.map.tiles.filter(t=>t.props.walkable&&!this.content.zones.some(z=>insideZone(z,t.x,t.y))&&!stage.pieces.some(p=>p.currentHp>0&&p.x===t.x&&p.y===t.y))
          .sort((a,b)=>Math.abs(a.x-party.anchor.x)+Math.abs(a.y-party.anchor.y)-Math.abs(b.x-party.anchor.x)-Math.abs(b.y-party.anchor.y)||a.y-b.y||a.x-b.x)[0]
        if(!cell)throw new Error('没有安全回归位置')
        captain.x=cell.x;captain.y=cell.y
      }
    }else{
      if(!coop.absent.includes(id))coop.absent.push(id)
      if(captain){captain.x=null;captain.y=null}
    }
    return this.commit(stage,copy(this.progress),{type:'presence',id,present})
  }
  async addPlayer(seat:AdventureSeat) {
    this.check(this.revision)
    if(!this.canSave())throw new Error('请等待全局节点结算')
    const revision=this.revision,current=adventureBoundary(this.state)!.coop!
    if(current.humanIds.length>=4||current.humanIds.includes(seat.playerId))throw new Error('没有空闲席位')
    const sample=await createCooperativeAdventure(this.profile!,this.content,[seat]);this.check(revision)
    const stage=safeCloneBattleState(this.state),coop=adventureBoundary(stage)!.coop!
    const party=copy(adventureBoundary(sample)!.coop!.parties[seat.playerId]),captain=copy(sample.pieces.find(p=>p.ownerPlayerId===seat.playerId)!)
    const cell=stage.map.tiles.filter(t=>t.props.walkable&&!this.content.zones.some(z=>insideZone(z,t.x,t.y))&&!stage.pieces.some(p=>p.currentHp>0&&p.x===t.x&&p.y===t.y))
      .sort((a,b)=>Math.abs(a.x-party.anchor.x)+Math.abs(a.y-party.anchor.y)-Math.abs(b.x-party.anchor.x)-Math.abs(b.y-party.anchor.y)||a.y-b.y||a.x-b.x)[0]
    if(!cell)throw new Error('没有新队伍抵达的位置')
    captain.x=cell.x;captain.y=cell.y;party.anchor={x:cell.x,y:cell.y}
    stage.pieces.push(captain);stage.players.splice(stage.players.length-1,0,copy(sample.players.find(p=>p.playerId===seat.playerId)!))
    coop.humanIds.push(seat.playerId);coop.order.push(seat.playerId);coop.parties[seat.playerId]=party
    if(adventureSupplies)initializeAdventureCards(stage,seat.playerId,adventureSupplies.initialRelicIds)
    this.personal[seat.playerId]=emptyProgress()
    this.personal[seat.playerId].coins=Math.min(this.content.cooperation?.lateJoinCoinCap??20,this.content.zones.filter(z=>this.cleared.includes(z.id)).reduce((sum,z)=>sum+z.reward,0))
    this.initial.pieces.push(copy(captain));this.initial.players.push(copy(sample.players.find(p=>p.playerId===seat.playerId)!))
    const baseline=adventureBoundary(this.initial)!.coop!;baseline.humanIds.push(seat.playerId);baseline.parties[seat.playerId]=copy(party)
    return this.commit(stage,copy(this.progress),{type:'join',playerId:seat.playerId})
  }
  takeover(seat:string,controller:string) {
    if(!this.canSave())throw new Error('请等待全局节点结算')
    const coop=adventureBoundary(this.state)!.coop!
    if(!coop.absent.includes(seat))throw new Error('只能接管缺席队伍')
    const stage=safeCloneBattleState(this.state),next=adventureBoundary(stage)!.coop!
    next.controllers??=Object.fromEntries(next.humanIds.map(id=>[id,id]))
    if(Object.values(next.controllers).includes(controller))throw new Error('该玩家已有队伍')
    next.controllers[seat]=controller
    this.state=stage
    return this.setPresence(seat,true)
  }
  skipDisconnected(id:string) {
    this.select(id)
    const cards=adventureCards(this.state),ledger=cards?.players[id],reward=cards?.rewards?.[id]
    if(ledger?.overflow.length)return super.supply('discard',ledger.overflow[0].instanceId,this.revision)
    if(reward)return super.supply(reward.relicIds.length?'skip-relic':'skip-cards','',this.revision)
    const pending=this.state.pendingOptionSelection??this.state.pendingTargetSelection
    if(pending)return super.human({type:'cancelPendingSelection',playerId:id,selectionId:pending.selectionId,stateRevision:pending.stateRevision} as BattleAction,this.revision)
    return super.human({type:this.state.turn.phase==='action'?'endTurn':'beginPhase',playerId:id},this.revision)
  }
  protected enter(state: BattleState, zone: Encounter, id: string) {
    const world=adventureBoundary(state)!,coop=world.coop!
    if (coop.playerZones[id]===zone.id) return
    if (coop.playerZones[id]) throw new Error('已经加入其他战区')
    const reinforcement=zone.participants.length>0
    zone.participants.push(id);coop.playerZones[id]=zone.id
    if(reinforcement) coop.protectedUntil[id]=coop.round
    coop.parties[id].battleRound=zone.round
    const player=state.players.find(p=>p.playerId===id)!
    player.maxActionPoints=Math.min(10,zone.round);player.actionPoints=player.maxActionPoints
    this.scaleEncounter(state,zone)
  }
  protected scaleEncounter(state: BattleState, zone: Encounter) {
    // Each additional participating team adds melee pressure and a ranged threat.
    const count=zone.participants.length
    if(count<=zone.scaledPlayers)return
    const bases=this.initial.pieces.filter(p=>p.ownerPlayerId===ENEMY&&!p.isCore)
    const reinforcements=this.content.cooperation?.reinforcementPieceIds??['pve-zombie','pve-skeleton']
    for(let n=Math.max(1,zone.scaledPlayers);n<count;n++) for(let k=0;k<reinforcements.length;k++) {
      const base=bases.find(p=>p.templateId===reinforcements[k])
      if(!base)throw new Error('缺少多人增援模板')
      const center=state.pieces.find(p=>zone.coreIds.includes(p.instanceId))??base
      const cell=state.map.tiles.filter(t=>t.props.walkable&&insideZone(zone,t.x,t.y)&&!state.pieces.some(p=>p.currentHp>0&&p.x===t.x&&p.y===t.y))
        .sort((a,b)=>Math.abs(a.x-center.x!)+Math.abs(a.y-center.y!)-Math.abs(b.x-center.x!)-Math.abs(b.y-center.y!)||a.y-b.y||a.x-b.x)[0]
      if(!cell)throw new Error('多人战区缺少敌方增援位置')
      const p={...copy(base),instanceId:`coop-${this.actIndex}-${zone.id}-${n}-${k}`,x:cell.x,y:cell.y,isCore:false}
      state.pieces.push(p);zone.enemyIds.push(p.instanceId)
    }
    for(const boss of state.pieces.filter(p=>zone.coreIds.includes(p.instanceId)&&p.currentHp>0)){
      const raw=enemyTemplates.find(t=>t.id===boss.templateId)!.stats.maxHp
      const definition=this.content.enemyLineup.find(p=>p.id===boss.instanceId)
      const base=this.content.zones.some(z=>z.id===definition?.zone&&z.elite)?Math.ceil(raw*1.5):raw
      const growth=adventureBoundary(state)!.enemyLevels?.[boss.instanceId]
      const grownBase=growth?Math.ceil(growth.baseMaxHp*(1+(this.content.enemyGrowth?.healthPerLevel??0)*growth.level)):base
      const maximum=Math.ceil(grownBase*(1+(this.content.cooperation?.bossHealthPerExtraPlayer??.25)*(count-1)))
      if(maximum>boss.maxHp){boss.currentHp+=maximum-boss.maxHp;boss.maxHp=maximum}
    }
    zone.scaledPlayers=count
  }
  protected override commit(state: BattleState, progress: WorldProgress, command: unknown, action?: BattleAction, events: unknown[] = []) {
    const upgraded=upgradeWaitingEnemies(state,this.content)
    const personal=copy(this.personal), cleared=[...this.cleared]
    personal[this.playerId]=progress
    if(upgraded)for(const item of Object.values(personal))item.log.unshift(`世界回合推进，${upgraded} 个未交战敌人升级。`)
    let world=adventureBoundary(state)!,coop=world.coop!
    if(world.party)coop.parties[world.humanId]=world.party
    if(action && state.turn.currentPlayerId===ENEMY && 'pieceId' in action) {
      for(const encounter of Object.values(coop.encounters))if(encounter.plans[0]?.sourceId===action.pieceId)encounter.plans.shift()
    }
    if(!world.activeZone && state.turn.currentPlayerId===this.playerId && state.turn.phase==='action' && !hasAdventureCardChoice(state,this.playerId)) {
      tryStartRoamingEncounter(state,{...this.content,zones:[...this.content.zones,...Object.values(coop.encounters)]})
    }
    const proposed=world.activeZone
    if(proposed&&!coop.encounters[proposed.id]&&!cleared.includes(proposed.id)) {
      const definition=this.content.zones.find(z=>z.id===proposed.id)??world.roamingEncounter
      if(!definition)throw new Error('遭遇定义不存在')
      const zone: Encounter={...copy(definition),participants:[],round:1,plans:[],scaledPlayers:1}
      coop.encounters[zone.id]=zone
      for(const id of coop.humanIds) if(!coop.absent.includes(id)&&state.pieces.some(p=>p.ownerPlayerId===id&&p.currentHp>0&&insideZone(zone,p.x,p.y)))this.enter(state,zone,id)
    }
    for(const zone of Object.values(coop.encounters)) {
      for(const id of coop.humanIds) if(!coop.absent.includes(id)&&!coop.playerZones[id]&&state.pieces.some(p=>p.ownerPlayerId===id&&p.currentHp>0&&insideZone(zone,p.x,p.y)))this.enter(state,zone,id)
      for(const p of state.pieces) if(p.ownerPlayerId===ENEMY&&insideZone(zone,p.x,p.y)&&!zone.enemyIds.includes(p.instanceId))zone.enemyIds.push(p.instanceId)
    }
    if(adventureSupplies && Object.values(coop.encounters).some(zone=>zone.participants.some(id=>!adventureCards(state)!.suppliedEncounters.includes(`${this.actIndex}:${zone.id}:${id}`)))) {
      const grants=Object.values(coop.encounters).flatMap(zone=>zone.participants.map(id=>({id,encounter:`${this.actIndex}:${zone.id}:${id}`})))
      withAdventureSupplyRuntime(state,()=>{for(const grant of grants)supplyEncounter(state,grant.id,grant.encounter,adventureSupplies!)})
    }
    world=adventureBoundary(state)!;coop=world.coop!
    for(const zone of Object.values(coop.encounters)) {
      if(state.pendingOptionSelection||state.pendingTargetSelection||zone.coreIds.some(id=>state.pieces.some(p=>p.instanceId===id&&p.currentHp>0)))continue
      if(state.terminalResult&&state.terminalResult.winnerTeamId!=='red')continue
      for(const id of zone.participants) {
        selectAdventureActor(state,id,zone.id)
        const old=this.playerId;this.playerId=id
        personal[id].cleared=personal[id].cleared.filter(z=>z!==zone.id)
        try{super.settle(state,personal[id])}finally{this.playerId=old}
        const w=adventureBoundary(state)!;if(w.party)w.coop!.parties[id]=w.party
      }
      cleared.push(zone.id)
      for(const id of zone.participants)delete coop.playerZones[id]
      delete coop.encounters[zone.id];this.checkpointPending=true
    }
    // Patrol kill currency is once per run/act and per participating player.
    if(this.content.roaming)for(const enemyId of this.content.roaming.enemyIds) {
      const remains=[...state.pieces,...state.graveyard,...(state.extensions?.removedPieces??[])]
      if(!remains.some(p=>p.instanceId===enemyId&&p.currentHp<=0))continue
      for(const id of coop.humanIds)if(!coop.absent.includes(id)&&!personal[id].claimed.includes(`kill:${enemyId}`)) {
        personal[id].claimed.push(`kill:${enemyId}`);personal[id].coins+=this.content.roaming.reward
        personal[id].lastReward={id:`kill:${enemyId}`,name:'巡游怪物',coins:this.content.roaming.reward,kind:'roaming'}
      }
    }
    for(const zone of Object.values(coop.encounters)) if(zone.plannedRound!==zone.round && this.state.turn.currentPlayerId!==ENEMY) {
      selectAdventureActor(state,zone.participants[0],zone.id);zone.plans=planAdventureEnemies(state);zone.plannedRound=zone.round
    }
    if(action && state.turn.currentPlayerId===ENEMY && 'pieceId' in action)this.patrolPlans=this.patrolPlans.filter(p=>p.sourceId!==action.pieceId)
    this.state=state;this.personal=personal;this.cleared=[...new Set(cleared)];this.revision++
    this.select(this.playerId)
    return {...this.snapshot(),action,events}
  }
  override step(revision: number) {
    this.check(revision)
    const owner=getCurrentInputOwnerPlayerId(this.state),world=adventureBoundary(this.state)!,coop=world.coop!
    if(owner!==ENEMY)throw new Error('等待玩家行动')
    if(coop.humanIds.some(id=>hasAdventureCardChoice(this.state,id)))throw new Error('等待玩家处理奖励')
    if(this.state.turn.phase!=='action') {
      const stage=safeCloneBattleState(this.state),next=adventureBoundary(stage)!.coop!
      if(stage.turn.phase==='end') {
        next.round++;next.order=adventureTurnOrder(next.humanIds,this.content.party.seed,next.round)
        stage.players.sort((a,b)=>[...next.order,ENEMY].indexOf(a.playerId)-[...next.order,ENEMY].indexOf(b.playerId))
        for(const zone of Object.values(next.encounters)){zone.round++;selectAdventureActor(stage,zone.participants[0],zone.id);zone.plans=planAdventureEnemies(stage);zone.plannedRound=zone.round}
        const patrols=new Map<string,AdventureEnemyPlan>()
        for(const id of next.order)if(!next.playerZones[id]&&!next.absent.includes(id)){
          selectAdventureActor(stage,id)
          for(const plan of planRoamingEnemies(stage,this.content))if(!Object.values(next.encounters).some(e=>e.enemyIds.includes(plan.sourceId))&&!patrols.has(plan.sourceId))patrols.set(plan.sourceId,plan)
        }
        this.patrolPlans=[...patrols.values()]
      }
      return this.apply({type:'beginPhase'},stage)
    }
    const zone=Object.values(coop.encounters).find(e=>e.plans.length)
    if(!zone){
      const patrol=this.patrolPlans[0]
      if(!patrol)return this.apply({type:'endTurn',playerId:ENEMY})
      const id=coop.humanIds.find(id=>!coop.playerZones[id])
      if(!id){this.patrolPlans=[];return this.apply({type:'endTurn',playerId:ENEMY})}
      const stage=safeCloneBattleState(this.state);selectAdventureActor(stage,id)
      adventureBoundary(stage)!.plans=[patrol]
      const reason=adventurePlanInvalidReason(stage,patrol)
      if(reason){this.patrolPlans.shift();return this.commit(stage,copy(this.progress),{type:'cancelPlan',reason})}
      return this.apply(patrol.action,stage)
    }
    selectAdventureActor(this.state,zone.participants[0],zone.id)
    const original=zone.plans[0],stage=safeCloneBattleState(this.state)
    selectAdventureActor(stage,zone.participants[0],zone.id)
    if(shortenBlockedAdventureMove(stage)&&adventureBoundary(stage)!.plans?.[0]?.id!==original.id)return this.commit(stage,copy(this.progress),{type:'blockedMove',planId:original.id})
    const plan=adventureBoundary(stage)!.plans![0],reason=adventurePlanInvalidReason(stage,plan)
    if(reason){adventureBoundary(stage)!.coop!.encounters[zone.id].plans.shift();return this.commit(stage,copy(this.progress),{type:'cancelPlan',reason})}
    try{return this.apply(plan.action,stage)}catch(error){
      if(!(error instanceof Error)||error.name!=='BattleRuleError')throw error
      const cancelled=safeCloneBattleState(this.state)
      adventureBoundary(cancelled)!.coop!.encounters[zone.id].plans.shift()
      return this.commit(cancelled,copy(this.progress),{type:'cancelPlan',reason:error.message})
    }
  }
  override async advanceAct(siteId:string,pieceId:string,revision:number) {
    this.check(revision)
    if(getCurrentInputOwnerPlayerId(this.state)!==this.playerId)throw new Error('尚未轮到你行动')
    if(!this.canSave())throw new Error('请等待所有战区及奖励结算完成')
    const site=this.content.sites.find(s=>s.id===siteId&&s.kind==='exit'),piece=this.state.pieces.find(p=>p.instanceId===pieceId&&p.ownerPlayerId===this.playerId)
    if(!site||piece?.x==null||piece.y==null||Math.abs(piece.x-site.x)+Math.abs(piece.y-site.y)>1)throw new Error('请移动到幕间入口')
    if(!this.content.zones.filter(z=>!z.optional).every(z=>this.cleared.includes(z.id)))throw new Error('请先击败本幕首领')
    const nextContent=campaignAct(this.campaign,this.actIndex+1,this.campaign.party.seed)
    const old=adventureBoundary(this.state)!.coop!
    const seats=old.humanIds.map(id=>({playerId:id,name:this.state.players.find(p=>p.playerId===id)!.name??id,pieceIds:[this.state.pieces.find(p=>p.instanceId===old.parties[id].captainId)!.templateId]}))
    const next=await createCooperativeAdventure(this.profile!,nextContent,seats);this.check(revision)
    adventureBoundary(next)!.completedRoundOffset=completedAdventureRounds(this.state)
    const coop=adventureBoundary(next)!.coop!
    coop.controllers=copy(old.controllers??{});coop.absent=[...old.absent]
    for(const id of old.humanIds){
      const prior=this.state.pieces.find(p=>p.instanceId===old.parties[id].captainId)!,arrival=next.pieces.find(p=>p.ownerPlayerId===id)!
      Object.assign(arrival,copy(prior),{x:arrival.x,y:arrival.y})
      coop.parties[id]={...copy(old.parties[id]),anchor:{x:arrival.x!,y:arrival.y!},battleRound:0,deploymentRevision:old.parties[id].deploymentRevision+1}
      delete coop.parties[id].deployedTurn
      if(coop.absent.includes(id)){arrival.x=null;arrival.y=null}
      next.players.find(p=>p.playerId===id)!.hand=copy(this.state.players.find(p=>p.playerId===id)!.hand)
      this.personal[id].cleared=[];this.personal[id].claimed=[];delete this.personal[id].lastReward
    }
    next.graveyard=copy(this.state.graveyard.filter(p=>old.humanIds.includes(p.ownerPlayerId)))
    if(adventureCards(this.state)){next.extensions!.adventureCards=copy(adventureCards(this.state));adventureCards(next)!.suppliedEncounters=[];cleanupAdventureCards(next)}
    adventureBoundary(next)!.campaignHasNext=this.actIndex+1<(this.campaign.nextActs?.length??0)
    this.actIndex++;this.content=nextContent;this.cleared=[];this.offers=recruitmentOffers(nextContent);this.checkpointPending=true
    selectAdventureActor(next,this.playerId)
    return this.commit(next,copy(this.personal[this.playerId]),{type:'advanceAct'})
  }
}
