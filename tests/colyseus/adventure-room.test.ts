import { createRelay } from '../../multiplayer-relay/relay.mjs'
import { openHostTunnel } from '@/lib/server/relay/host-tunnel'
import { getProfileLeaseReportV1 } from '@/lib/content-pipeline/runtime/profile-runtime'
import { createServer } from 'node:net'
import { Client } from '@colyseus/sdk'
import { describe,expect,it,vi } from 'vitest'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import type { AdventureRepository,AdventureReceipt,AdventureStoredRun } from '@/lib/server/colyseus/adventure-store'
import type { AdventureCheckpoint } from '@/lib/pve/roguelike/checkpoint'
import { FakeAuthorityRepository } from './fake-authority-repository'

const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
class TestAdventureStore implements AdventureRepository {
  runs=new Map<string,AdventureStoredRun>();receipts=new Map<string,AdventureReceipt>();fail=false
  async initialize(){}
  async deleteSave(id:string,host:string){const r=this.runs.get(id);if(!r||r.hostId!==host)throw new Error('denied');r.saved=null;r.savedAt=null}
  async create(runId:string,hostId:string,current:AdventureCheckpoint){this.runs.set(runId,{runId,hostId,current:clone(current),saved:null,savedAt:null})}
  async get(id:string){const r=this.runs.get(id);return r&&clone(r)}
  async list(host:string){return [...this.runs.values()].filter(r=>r.hostId===host&&r.saved).map(r=>({runId:r.runId,revision:r.saved!.revision,actNumber:r.saved!.aggregate.actIndex+1,savedAt:r.savedAt!}))}
  async commit(id:string,expected:number,current:AdventureCheckpoint,receipt:AdventureReceipt,save:boolean){
    if(this.fail)throw new Error('disk unavailable')
    const r=this.runs.get(id)!;if(r.current.revision!==expected)throw new Error('stale')
    r.current=clone(current);this.receipts.set(`${id}:${receipt.actor}:${receipt.actionId}`,clone(receipt))
    if(save){r.saved=clone(current);r.savedAt=new Date().toISOString()}
  }
  async receipt(id:string,actor:string,actionId:string){return this.receipts.get(`${id}:${actor}:${actionId}`)}
  async save(id:string,host:string,revision:number){const r=this.runs.get(id)!;if(r.hostId!==host||r.current.revision!==revision)throw new Error('denied');r.saved=clone(r.current);r.savedAt=new Date().toISOString()}
}
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p}
describe('real adventure SDK transport',()=>{
  it('blocks PVE creation during updates and holds the update fence until disposal',async()=>{
    const candidate=createColyseusBattleServer({repository:new FakeAuthorityRepository(),adventureRepository:new TestAdventureStore(),reconnectGraceMs:100})
    const p=await port();await candidate.server.listen(p,'127.0.0.1')
    const sdk=new Client(`ws://127.0.0.1:${p}`),profileIdentity={...getServerGameProfileIdentityV1()}
    try{
      expect(candidate.updateAdmission.acquire('update')).toBe(true)
      await expect(sdk.create('adventure',{playerId:'host',profileIdentity})).rejects.toThrow('更新资源')
      candidate.updateAdmission.release('update')
      const room=await sdk.create('adventure',{playerId:'host',profileIdentity})
      room.onMessage('adventure.state',()=>{})
      expect(candidate.updateAdmission.acquire('update')).toBe(false)
      await room.leave()
      await vi.waitFor(()=>expect(candidate.updateAdmission.status().idle).toBe(true),{timeout:3000})
      expect(candidate.updateAdmission.acquire('update')).toBe(true)
    }finally{await candidate.server.gracefullyShutdown(false)}
  },15000)
  it('relays PVE guests while the player host owns saves and restores checkpoints',async()=>{
    const store=new TestAdventureStore(),candidate=createColyseusBattleServer({repository:new FakeAuthorityRepository(),adventureRepository:store,reconnectGraceMs:300})
    const p=await port();await candidate.server.listen(p,'127.0.0.1')
    const sdk=new Client(`ws://127.0.0.1:${p}`),profileIdentity={...getServerGameProfileIdentityV1()}
    const host=await sdk.create('adventure',{playerId:'host',profileIdentity,seed:42})
    const relayPort=await port(), relayUrl=process.env.RVB_TEST_RELAY_URL || `http://127.0.0.1:${relayPort}`
    const relay=createRelay({publicOrigin:relayUrl})
    await new Promise<void>(resolve=>relay.server.listen(relayPort,'127.0.0.1',resolve))
    const tunnel=await openHostTunnel({relayUrl,localOrigin:`http://127.0.0.1:${p}`,name:'PVE host',visible:true})
    expect((await fetch(tunnel.published.url+'/matchmake/create/adventure',{method:'POST'})).status).toBe(403)
    const guest=await new Client(tunnel.published.url).joinById(host.roomId,{playerId:'guest',profileIdentity})
    type View={runId:string;snapshot?:{revision:number;world:{canSave:boolean};state:{turn:{currentPlayerId:string}}}}
    const bind=(room:typeof host)=>{
      const pending=new Map<string,{resolve:(v:View)=>void;reject:(e:Error)=>void}>()
      room.onMessage('adventure.state',()=>{});room.onMessage('adventure.error',()=>{})
      room.onMessage('adventure.reply',(reply)=>{const p=pending.get(reply.requestId);if(p){pending.delete(reply.requestId);if(reply.error)p.reject(new Error(reply.error.message));else p.resolve(reply.result)}})
      return (type:string,payload:Record<string,unknown>={})=>new Promise<View>((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});room.send('adventure.rpc',{requestId:id,actionId:id,type,payload,profileIdentity})})
    }
    const h=bind(host),g=bind(guest)
    try{
      expect((await getProfileLeaseReportV1()).roomIds).toContain(host.roomId)
      const listing=await fetch(tunnel.published.url+'/rooms?mode=pve').then(r=>r.json())
      expect(listing.rooms).toContainEqual(expect.objectContaining({id:host.roomId,players:2,status:'waiting'}))
      const pvpListing=await fetch(`http://127.0.0.1:${p}/rooms`).then(r=>r.json())
      expect(pvpListing.rooms.some((r:{id:string})=>r.id===host.roomId)).toBe(false)
      await expect(h('start')).rejects.toThrow('准备')
      await g('selectTeam',{familyId:'pressure'})
      await g('ready',{ready:true})
      await g('selectTeam',{familyId:'light'})
      await expect(h('start')).rejects.toThrow('准备')
      await g('ready',{ready:true})
      const correctHash=profileIdentity.authorityContentHash
      Object.assign(profileIdentity,{authorityContentHash:'0'.repeat(64)})
      await expect(h('snapshot')).rejects.toThrow()
      Object.assign(profileIdentity,{authorityContentHash:correctHash})
      const started=await h('start');expect(started.snapshot).toBeTruthy()
      expect(candidate.updateAdmission.acquire('active-adventure-update')).toBe(false)
      const activeListing=await fetch(`http://127.0.0.1:${p}/rooms?mode=pve`).then(r=>r.json())
      expect(activeListing.rooms).toContainEqual(expect.objectContaining({id:host.roomId,status:'playing'}))
      let view=await h('snapshot')
      for(let i=0;i<30&&!view.snapshot?.world.canSave;i++){await new Promise(r=>setTimeout(r,100));view=await h('snapshot')}
      expect(view.snapshot?.world.canSave).toBe(true)
      await expect(g('save')).rejects.toThrow('房主')
      await h('save');expect((await store.get(view.runId))?.saved).not.toBeNull()
      await h('save');expect((await store.get(view.runId))?.saved?.revision).toBe(view.snapshot?.revision)
      const reads=vi.spyOn(store,'get')
      await h('snapshot');await g('snapshot')
      expect(reads).not.toHaveBeenCalled()
      reads.mockRestore()
      expect((await g('snapshot')).snapshot?.revision).toBe(view.snapshot?.revision)
      const restoredRoom=await sdk.create('adventure',{playerId:'host',profileIdentity})
      const restore=bind(restoredRoom)
      try{const loaded=await restore('start',{saveId:view.runId});expect(loaded.snapshot?.revision).toBe(view.snapshot?.revision)}finally{await restoredRoom.leave()}
      await Promise.all([host.leave(),guest.leave()])
      expect(candidate.updateAdmission.acquire('leaving-adventure-update')).toBe(false)
      await new Promise(r=>setTimeout(r,900))
      expect((await getProfileLeaseReportV1()).roomIds).not.toContain(host.roomId)
    }finally{tunnel.close();await relay.close();await candidate.server.gracefullyShutdown(false)}
  },30000)
})

it('preserves a save and removes the room when its host dissolves the party',async()=>{
  const store=new TestAdventureStore(), candidate=createColyseusBattleServer({repository:new FakeAuthorityRepository(),adventureRepository:store})
  const p=await port();await candidate.server.listen(p,'127.0.0.1')
  const profileIdentity=getServerGameProfileIdentityV1(), sdk=new Client(`http://127.0.0.1:${p}`)
  const host=await sdk.create('adventure',{playerId:'host',profileIdentity,seed:42})
  host.onMessage('adventure.state',()=>{});host.onMessage('adventure.error',()=>{})
  const rpc=(type:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
    const id=crypto.randomUUID()
    host.onMessage('adventure.reply',message=>{if(message.requestId===id){if(message.error)reject(new Error(message.error.message));else resolve(message.result)}})
    host.send('adventure.rpc',{type,requestId:id,actionId:id,profileIdentity})
  })
  try {
    const started=await rpc('start')
    const saveAttempt=vi.spyOn(store,'save').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(rpc('dissolve')).rejects.toThrow('disk unavailable')
    expect(await rpc('snapshot')).toBeTruthy()
    saveAttempt.mockRestore()
    await rpc('dissolve')
    expect((await store.get(started.runId as string))?.saved).toBeTruthy()
    await vi.waitFor(async()=>{
      const result=await fetch(`http://127.0.0.1:${p}/rooms?mode=pve`).then(r=>r.json())
      expect(result.rooms.some((r:{id:string})=>r.id===host.roomId)).toBe(false)
    })
  } finally { if(host.connection.isOpen) await host.leave();await candidate.server.gracefullyShutdown(false) }
},20000)
