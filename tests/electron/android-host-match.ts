import assert from 'node:assert/strict'
import { Client, type Room } from '@colyseus/sdk'
import { guestIdentity } from '../helpers/guest-identity'
import { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } from '../../lib/game/battle-public-patch'

const origin=process.env.RVB_ANDROID_HOST_URL||'http://127.0.0.1:19267'
const createOrigin=process.env.RVB_ANDROID_CREATE_URL||origin
const json=(url:string)=>fetch(origin+url).then(async r=>{assert(r.ok,`${url}: ${r.status}`);return r.json()})
type Snapshot = { authorityVersion: number; durableAuthorityVersion: number; state: { turn: { currentPlayerId: string }; terminalResult?: unknown; deployment: { offerPieceIds?: string[]; offerPieces?: { instanceId: string }[]; legalPositions?: { x: number; y: number }[]; revision: number } } }
type Receipt = { kind: string; receipt?: { clientActionId: string } }
function next<T>(room:Room,type:string,predicate:(data:T)=>boolean=()=>true):Promise<T>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{off();reject(Error('Missing '+type))},15000)
  const off=room.onMessage(type,data=>{if(predicate(data)){clearTimeout(timer);off();resolve(data)}})
})}
async function snapshot(room:Room){const result=next<Snapshot>(room,'battleSnapshot');room.send('battleResync',{});return result}
async function run(count:number){
  const {profileIdentity}=await json('/catalog/identity'),{pieces}=await json('/catalog/pieces')
  assert.deepEqual(await json('/healthz'),{ok:true,protocol:'rvb-colyseus',runtime:'colyseus-android',database:'sqlite'})
  const identities=Array.from({length:count},guestIdentity),rooms:Room[]=[]
  const rpc=(room:Room,data:Record<string,unknown>)=>room.request('roomRpc',{method:'rooms.action',data:{...data,playerId:identities[rooms.indexOf(room)].playerId}},{timeout:15000})
  async function options(index:number,roomId:string){const{nonce}=await json('/admission/challenge');return{product:true,mode:count===4?'2v2':'1v1',playerId:identities[index].playerId,playerName:'Android QA '+index,profileIdentity,auth:identities[index].proof(nonce,roomId)}}
  try{
    rooms.push(await new Client(createOrigin).create('battle',{...await options(0,'create'),name:'Android native '+count,mapId:count===4?'twin-fronts':'open-expanse',visibility:'public'}))
    const id=rooms[0].roomId
    for(let i=1;i<count;i++)rooms.push(await new Client(origin).joinById(id,await options(i,id)))
    for(const room of rooms){room.onMessage('roomUpdate',()=>{});room.onMessage('battleDurable',()=>{});room.onMessage('battleSnapshot',()=>{});room.onMessage('battleReceipt',()=>{})}
    for(let i=0;i<count;i++)await rpc(rooms[i],{action:'claim-faction',alignment:i%2?'dark':'light',profileIdentity})
    for(const room of rooms)await rpc(room,{action:'toggle-ready',profileIdentity})
    for(let i=0;i<count;i++)await rpc(rooms[i],{action:'select-pieces',alignment:i%2?'dark':'light',pieces:pieces.filter((p:{faction:string})=>p.faction===(i%2?'evil':'good')).slice(0,8).map((p:{id:string})=>({templateId:p.id})),profileIdentity})
    let view=await snapshot(rooms[0]);assert.equal(view.authorityVersion,0)
    const active=identities.findIndex(p=>p.playerId===view.state.turn.currentPlayerId), actor=rooms[active]
    view=await snapshot(actor)
    const deployment=view.state.deployment, pieceId=deployment.offerPieceIds?.[0]||deployment.offerPieces?.[0]?.instanceId,position=deployment.legalPositions?.[0]
    async function command(index:number,command:Record<string,unknown>){const current=await snapshot(rooms[index]),clientActionId='android-'+crypto.randomUUID(),playerId=identities[index].playerId,result=next<Receipt>(rooms[index],'battleReceipt',m=>m.receipt?.clientActionId===clientActionId);rooms[index].send('battleCommand',{protocolVersion:BATTLE_AUTHORITY_PROTOCOL_VERSION,authorityBuildId:BATTLE_AUTHORITY_BUILD_ID,roomId:id,playerId,expectedAuthorityVersion:current.authorityVersion,clientActionId,command:{...command,playerId,clientActionId}});const receipt=await result;assert.equal(receipt.kind,'applied',JSON.stringify(receipt));return receipt}
    assert(pieceId)
    await command(active,{type:'deployReservePiece',expectedDeploymentRevision:deployment.revision,pieceId,...(position?{toX:position.x,toY:position.y}:{})})
    if(count===2)await command(active,{type:'surrender'})
    else {await command(0,{type:'surrender'});await command(3,{type:'surrender'})}
    const terminal=await snapshot(rooms[0]);assert(terminal.state.terminalResult);assert.equal(terminal.authorityVersion,terminal.durableAuthorityVersion)
    assert(!(await json('/rooms')).rooms.some((r:{id:string})=>r.id===id))
    console.log(JSON.stringify({androidHost:true,players:count,roomId:id,authorityVersion:terminal.authorityVersion,durable:terminal.durableAuthorityVersion,terminal:terminal.state.terminalResult}))
  }finally{for(const room of rooms)await room.leave()}
}
run(process.argv.includes('--2v2')?4:2).catch(error=>{console.error(error);process.exitCode=1})
