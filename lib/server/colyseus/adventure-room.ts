import { acquireAdventureLease, releaseAdventureLease } from '../../content-pipeline/runtime/adventure-leases'
import { Room, type Client } from 'colyseus'
import { createHash, randomUUID } from 'node:crypto'
import { CooperativeAdventureSession, createCooperativeAdventure, type AdventureSeat } from '../../pve/roguelike/cooperative-session'
import { createAdventureCheckpoint, restoreAdventureCheckpoint } from '../../pve/roguelike/checkpoint'
import { adventureContent, adventureBuilds, ENEMY } from '../../pve/roguelike/content'
import { generateAdventureContent } from '../../pve/roguelike/generation'
import { createRootSeed } from '../../game/rule-runtime'
import { hasAdventureCardChoice } from '../../game/adventure-card-state'
import { assertGameProfileCompatibleV1, getServerGameProfileIdentityV1 } from '../../content-pipeline/runtime/profile-game-identity'
import type { AdventureRepository, AdventureReceipt } from './adventure-store'

interface Join {playerId:string;name?:string;profileIdentity:unknown;auth?:unknown;seed?:number;saveId?:string;familyId?:string}
interface Request {profileIdentity:unknown;requestId:string;actionId:string;type:string;payload?:Record<string,unknown>}
export function createAdventureRoomClass(dependencies:{store?:AdventureRepository;authenticate?:(playerId:string,roomId:string,proof:unknown)=>string;reconnectGraceMs?:number}) {
  return class AdventureRoom extends Room {
    maxClients=8
    autoDispose=false
    private seats=new Map<string,AdventureSeat>()
    private ready=new Set<string>()
    private waiting=new Map<string,AdventureSeat>()
    private identities=new Map<string,string>()
    private playerByClient=new Map<string,string>()
    private offline=new Map<string,number>()
    private hostId=''
    private runId=''
    private options!:Join
    private creatorKey?:string
    private session?:CooperativeAdventureSession
    private queue:Promise<unknown>=Promise.resolve()
    private disposed=false
    private failures=new Map<string,AdventureReceipt>()
    private emptySince=Date.now()
    onCreate(options:Join){
      if(!dependencies.store)throw new Error('此服务器尚未配置冒险存档服务')
      this.options=options
      this.creatorKey=dependencies.authenticate?.(options.playerId,'create',options.auth)
      acquireAdventureLease(this.roomId)
      this.onMessage('adventure.rpc',(client,message:Request)=>{
        void this.enqueue(async()=>{
          try{client.send('adventure.reply',{requestId:message.requestId,result:await this.request(client,message)})}
          catch(error){
            const detail=error as Error&Record<string,unknown>
            client.send('adventure.reply',{requestId:message.requestId,error:{message:detail.message??String(error),code:detail.code,
              needsTargetSelection:detail.needsTargetSelection,needsOptionSelection:detail.needsOptionSelection,
              preparation:detail.preparation,targetType:detail.targetType,range:detail.range,filter:detail.filter,options:detail.options,title:detail.title}})
          }
        })
      })
      this.clock.setInterval(()=>{void this.enqueue(()=>this.tick()).catch(error=>{
        this.broadcast('adventure.error',{message:error instanceof Error?error.message:String(error)})
      })},250)
    }
    private enqueue<T>(operation:()=>Promise<T>):Promise<T>{
      const result=this.queue.then(operation);this.queue=result.catch(()=>undefined);return result
    }
    async onJoin(client:Client,options:Join){
      await this.enqueue(async()=>{
        if(!/^[a-z0-9-]{1,64}$/.test(options.playerId))throw new Error('玩家身份无效')
        const identity=!this.hostId&&options.playerId===this.options.playerId&&this.creatorKey
          ? this.creatorKey : dependencies.authenticate?.(options.playerId,this.roomId,options.auth)??options.playerId
        assertGameProfileCompatibleV1(options.profileIdentity)
        if([...this.playerByClient.values()].includes(options.playerId))throw new Error('该玩家已经连接')
        if(this.identities.has(options.playerId)&&this.identities.get(options.playerId)!==identity)throw new Error('席位身份不匹配')
        if(this.session&&this.seats.has(options.playerId)&&!this.seatFor(options.playerId))throw new Error('原席位已由其他玩家接管')
        if(!this.session&&!this.seats.has(options.playerId)&&this.seats.size>=4)throw new Error('冒险席位已满')
        this.identities.set(options.playerId,identity)
        this.playerByClient.set(client.sessionId,options.playerId);this.offline.delete(options.playerId)
        this.hostId ||= options.playerId
        const family=adventureBuilds.families.find(f=>f.id===(options.familyId??'skirmish'))
        if(!family)throw new Error('初始队伍不存在')
        const seat={playerId:options.playerId,name:String(options.name??'冒险者').slice(0,32),pieceIds:family.team.map(p=>p.pieceId),familyId:family.id}
        if(this.session&&!this.seatFor(options.playerId))this.waiting.set(options.playerId,seat)
        else if(!this.session)this.seats.set(options.playerId,seat)
        await this.publish()
      })
    }
    async onDrop(client:Client){
      const id=this.playerByClient.get(client.sessionId)
      if(id)this.offline.set(id,Date.now())
      await this.enqueue(()=>this.publish())
      try{await this.allowReconnection(client,(dependencies.reconnectGraceMs??30000)/1000)}catch{/* onLeave retains the seat for host-authorized recovery. */}
    }
    async onReconnect(client:Client){
      const id=this.playerByClient.get(client.sessionId)
      if(!id||this.session&&!this.seatFor(id)&&!this.waiting.has(id))throw new Error('重连席位已失效')
      this.offline.delete(id);await this.enqueue(()=>this.publish())
    }
    onLeave(client:Client){
      const id=this.playerByClient.get(client.sessionId)
      this.playerByClient.delete(client.sessionId)
      if(id)this.offline.set(id,Date.now())
      if(id&&!this.session){
        this.seats.delete(id);this.ready.delete(id);this.offline.delete(id)
        if(id===this.hostId)this.hostId=this.seats.keys().next().value??''
      }
      void this.enqueue(()=>this.publish())
    }
    onDispose(){this.disposed=true;releaseAdventureLease(this.roomId)}
    private seatFor(identity:string){
      if(!this.session)return this.seats.has(identity)?identity:undefined
      const coop=this.aggregate().state.extensions!.adventureWorld.coop
      return coop.humanIds.find((id:string)=>(coop.controllers?.[id]??id)===identity) as string|undefined
    }
    private view(id:string){
      const seat=this.seatFor(id)
      const controllers=(this.session?this.aggregate():undefined)?.state.extensions!.adventureWorld.coop.controllers??{}
      return {roomId:this.roomId,runId:this.runId,hostId:this.hostId,playerId:id,
        seats:[...this.seats.values()].map(s=>({...s,ready:this.ready.has(s.playerId),connected:!this.offline.has(controllers[s.playerId]??s.playerId)})),waiting:[...this.waiting.values()],
        snapshot:seat&&this.session?this.snapshotFor(seat):undefined}
    }
    private cacheSession?: CooperativeAdventureSession
    private cacheRevision=-1
    private cachedAggregate?: ReturnType<CooperativeAdventureSession['exportAggregate']>
    private views=new Map<string,ReturnType<CooperativeAdventureSession['snapshot']>>()
    private savedMetadataRun=''
    private savedMetadata:{savedAt:string|null;savedRevision?:number}={savedAt:null}
    private aggregate(){
      if(this.cacheSession!==this.session||this.cacheRevision!==this.session!.currentRevision){
        this.cacheSession=this.session;this.cacheRevision=this.session!.currentRevision
        this.cachedAggregate=this.session!.exportAggregate();this.views.clear()
      }
      return this.cachedAggregate!
    }
    private snapshotFor(id?:string){
      const aggregate=this.aggregate(),viewer=id??aggregate.playerId
      if(!this.views.has(viewer))this.views.set(viewer,this.session!.snapshot(viewer))
      return this.views.get(viewer)!
    }
    private async publish(){
      if(this.disposed)return
      const coop=(this.session?this.aggregate():undefined)?.state.extensions!.adventureWorld.coop
      const connected=(id:string)=>!this.offline.has(id)&&[...this.playerByClient.values()].includes(id)
      const online=[...this.seats.keys()].filter(id=>connected(coop?.controllers?.[id]??id)).length
      const hostOnline=connected(this.hostId)
      await this.setMetadata({ product:true, mode:'pve', room:{
        id:this.roomId, name:(this.seats.get(this.hostId)?.name??'冒险者')+'的冒险',
        players:this.seats.size, online, maxPlayers:4, status:this.session?'playing':'waiting',
        joinable:hostOnline&&this.clients.length<this.maxClients&&(this.seats.size<4||Boolean(coop?.absent.length)),
        takeoverAvailable:Boolean(coop?.absent.length),
        teams:[...this.seats.values()].map(s=>({name:s.name,familyId:s.familyId,ready:this.ready.has(s.playerId)})),
      } })
      if(this.runId&&this.savedMetadataRun!==this.runId){
        const saved=await dependencies.store!.get(this.runId)
        this.savedMetadata={savedAt:saved?.savedAt??null,savedRevision:saved?.saved?.revision};this.savedMetadataRun=this.runId
      }
      for(const client of this.clients){const id=this.playerByClient.get(client.sessionId);if(id)client.send('adventure.state',{...this.view(id),...this.savedMetadata})}
    }
    private async request(client:Client,message:Request){
      assertGameProfileCompatibleV1(message?.profileIdentity)
      const actor=this.playerByClient.get(client.sessionId)
      if(!actor||this.offline.has(actor))throw new Error('当前连接没有可操作席位')
      if(!message||typeof message.type!=='string'||typeof message.actionId!=='string'||message.actionId.length>128)throw new Error('指令格式无效')
      const payload=message.payload??{}
      if(message.type==='snapshot')return this.view(actor)
      if(message.type==='saves')return dependencies.store!.list(actor)
      if(message.type==='selectTeam'||message.type==='ready'){
        if(this.session)throw new Error('冒险开始后不能更换初始队伍')
        if(message.type==='selectTeam'){
          const family=adventureBuilds.families.find(f=>f.id===payload.familyId)
          if(!family)throw new Error('初始队伍不存在')
          Object.assign(this.seats.get(actor)!,{pieceIds:family.team.map(p=>p.pieceId),familyId:family.id})
          this.ready.delete(actor)
        }else if(payload.ready===true)this.ready.add(actor)
        else this.ready.delete(actor)
        await this.publish();return this.view(actor)
      }
      if(message.type==='start'){
        if(actor!==this.hostId)throw new Error('仅房主可以开始冒险')
        if(this.session)return this.view(actor)
        const profile=getServerGameProfileIdentityV1()
        let candidate:CooperativeAdventureSession
        const saveId=typeof payload.saveId==='string'?payload.saveId:this.options.saveId
        if(saveId){
          const saved=await dependencies.store!.get(saveId)
          if(saved?.hostId!==actor||!saved.saved)throw new Error('存档不存在或不属于你')
          candidate=restoreAdventureCheckpoint(saved.saved,profile)
          const ids=candidate.exportAggregate().state.players.filter(p=>p.playerId!==ENEMY).map(p=>p.playerId)
          const controllers=candidate.exportAggregate().state.extensions!.adventureWorld.coop.controllers??{}
          if([...this.seats.keys()].some(id=>!ids.some(seat=>(controllers[seat]??seat)===id)))throw new Error('请使用原存档席位进入')
          this.seats.clear()
          for(const id of ids){
            this.seats.set(id,{playerId:id,name:candidate.snapshot(id).state.players.find(p=>p.playerId===id)!.name??id,pieceIds:[]})
            const controller=controllers[id]??id
            if(![...this.playerByClient.values()].includes(controller))this.offline.set(controller,Date.now())
          }
        }else{
          if([...this.seats.keys()].some(id=>this.offline.has(id)||id!==actor&&!this.ready.has(id)))throw new Error('请等待同行者连接并准备')
          const content=generateAdventureContent(adventureContent,this.options.seed??createRootSeed())
          candidate=new CooperativeAdventureSession(await createCooperativeAdventure(profile,content,[...this.seats.values()]),content,profile)
        }
        const runId=randomUUID()
        await dependencies.store!.create(runId,actor,createAdventureCheckpoint(candidate,false))
        this.runId=runId;this.session=candidate;await this.publish();return this.view(actor)
      }
      if(!this.session)throw new Error('冒险尚未开始')
      const seat=this.seatFor(actor)
      if(message.type==='save'){
        if(actor!==this.hostId)throw new Error('仅房主可以保存')
        createAdventureCheckpoint(this.session)
        await dependencies.store!.save(this.runId,actor,this.snapshotFor(seat!).revision)
        this.savedMetadata={savedAt:new Date().toISOString(),savedRevision:this.session.currentRevision}
        await this.publish();return this.view(actor)
      }
      if(message.type==='receipt')return await dependencies.store!.receipt(this.runId,actor,String(payload.actionId))??this.failures.get(`${actor}:${payload.actionId}`)??{status:'unknown'}
      const fingerprint=createHash('sha256').update(JSON.stringify({type:message.type,payload})).digest('hex')
      const previous=await dependencies.store!.receipt(this.runId,actor,message.actionId)??this.failures.get(`${actor}:${message.actionId}`)
      if(previous){if(previous.fingerprint!==fingerprint)throw new Error('重复动作 ID 的内容不一致');return {receipt:previous,...this.view(actor)}}
      const candidate=restoreAdventureCheckpoint(createAdventureCheckpoint(this.session,false),getServerGameProfileIdentityV1(),false)
      try{
        if(message.type==='admit'||message.type==='takeover'){
          if(actor!==this.hostId)throw new Error('仅房主可以接纳或移交席位')
          const incoming=this.waiting.get(String(payload.playerId))
          if(!incoming||this.offline.has(incoming.playerId))throw new Error('该玩家不在等待名单')
          if(message.type==='admit')await candidate.addPlayer(incoming)
          else candidate.takeover(String(payload.seatId),incoming.playerId)
        }else{
          if(!seat)throw new Error('等待房主接纳')
          await candidate.command(seat,message.type,payload)
        }
        await this.accept(candidate,{actor,actionId:message.actionId,fingerprint,revision:candidate.snapshot().revision,status:'applied'})
        if(message.type==='admit'){const s=this.waiting.get(String(payload.playerId))!;this.seats.set(s.playerId,s);this.waiting.delete(s.playerId);await this.publish()}
        if(message.type==='takeover'){this.waiting.delete(String(payload.playerId));await this.publish()}
        return this.view(actor)
      }catch(error){
        const receipt:AdventureReceipt={actor,actionId:message.actionId,fingerprint,revision:this.snapshotFor().revision,status:'rejected',error:error instanceof Error?error.message:String(error)}
        if(this.failures.size>256)this.failures.delete(this.failures.keys().next().value!)
        this.failures.set(`${actor}:${message.actionId}`,receipt);throw error
      }
    }
    private async accept(candidate:CooperativeAdventureSession,receipt:AdventureReceipt){
      const before=this.snapshotFor().revision
      const save=candidate.canSave()&&candidate.exportAggregate().checkpointPending
      if(save)candidate.markCheckpointSaved()
      const checkpoint=createAdventureCheckpoint(candidate,false)
      await dependencies.store!.commit(this.runId,before,checkpoint,receipt,save)
      this.session=candidate
      if(save)this.savedMetadata={savedAt:new Date().toISOString(),savedRevision:checkpoint.revision}
      await this.publish()
    }
    private async tick(){
      if(this.disposed)return
      const online=[...this.playerByClient.values()].some(id=>!this.offline.has(id))
      if(online)this.emptySince=Date.now()
      else if(Date.now()-this.emptySince>(dependencies.reconnectGraceMs??30000)) {
        // Existing node checkpoints remain in the repository after the room closes.
        releaseAdventureLease(this.roomId)
        this.disposed=true
        void this.disconnect()
        return
      }
      if(!this.session)return
      if(![...this.playerByClient.values()].some(id=>!this.offline.has(id)&&this.seatFor(id)))return
      const snapshot=this.snapshotFor(),state=snapshot.state
      if(state.terminalResult)return
      const owner=snapshot.inputOwner
      const coop=this.aggregate().state.extensions!.adventureWorld.coop
      const offline=(id:string)=>{const controller=coop.controllers?.[id]??id;return this.offline.has(controller)&&Date.now()-this.offline.get(controller)!>30000}
      const waiting=(coop.humanIds as string[]).find(id=>offline(id)&&hasAdventureCardChoice(this.aggregate().state,id))
      if(waiting&&!state.pendingOptionSelection&&!state.pendingTargetSelection){
        const candidate=restoreAdventureCheckpoint(createAdventureCheckpoint(this.session,false),getServerGameProfileIdentityV1(),false)
        candidate.skipDisconnected(waiting)
        await this.accept(candidate,{actor:'system',actionId:`skip-${snapshot.revision}`,fingerprint:`skip-${snapshot.revision}`,revision:candidate.snapshot().revision,status:'applied'});return
      }
      if(this.session.canSave()){
        const id=(coop.humanIds as string[]).find(id=>offline(id)!==coop.absent.includes(id))
        if(id){
          const candidate=restoreAdventureCheckpoint(createAdventureCheckpoint(this.session,false),getServerGameProfileIdentityV1(),false)
          candidate.setPresence(id,!offline(id))
          await this.accept(candidate,{actor:'system',actionId:`presence-${snapshot.revision}`,fingerprint:`presence-${snapshot.revision}`,revision:candidate.snapshot().revision,status:'applied'});return
        }
      }
      if((state.pendingOptionSelection||state.pendingTargetSelection)&&!offline(owner))return
      const human=owner!==ENEMY
      const phase=state.turn.phase==='start'||state.turn.phase==='end'
      if(human&&!phase&&!offline(owner))return
      const candidate=restoreAdventureCheckpoint(createAdventureCheckpoint(this.session,false),getServerGameProfileIdentityV1(),false)
      try{
        if(human&&offline(owner))candidate.skipDisconnected(owner)
        else if(human)candidate.human({type:phase?'beginPhase':'endTurn',playerId:owner},snapshot.revision,owner)
        else candidate.step(snapshot.revision)
      }catch(error){
        if(error instanceof Error&&/奖励|补给|等待玩家/.test(error.message))return
        throw error
      }
      await this.accept(candidate,{actor:'system',actionId:`step-${snapshot.revision}`,fingerprint:`step-${snapshot.revision}`,revision:candidate.snapshot().revision,status:'applied'})
    }
  }
}
