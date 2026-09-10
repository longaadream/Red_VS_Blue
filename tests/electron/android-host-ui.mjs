import { Client } from '@colyseus/sdk'
import identityHelper from '../helpers/guest-identity.ts'
import protocol from '../../lib/game/battle-public-patch.ts'
const { guestIdentity } = identityHelper
const { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } = protocol
import fs from 'node:fs'
import assert from 'node:assert/strict'
const targets=await(await fetch('http://127.0.0.1:19243/json/list')).json()
const target=targets.find(p=>p.url.startsWith('https://localhost'))
assert(target,'Forward the actual acceptance WebView to 19243')
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let seq=0
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
ws.addEventListener('message',e=>{const data=JSON.parse(e.data);if(data.id){pending.get(data.id)?.(data);pending.delete(data.id)}})
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},90000);pending.set(id,d=>{clearTimeout(timer);if(d.error)reject(Error(d.error.message));else resolve(d.result)});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function until(expression){const end=Date.now()+45000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,150))}throw Error('Timed out: '+expression)}
async function touch(selector){
 await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',behavior:'instant'})`)
 await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return r.height>=43.5&&r.top>=-1&&r.bottom<=innerHeight+1&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`)
 const r=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
 await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x,y:r.y}]})
 await new Promise(r=>setTimeout(r,80))
 await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
}

const origin='http://127.0.0.1:19267';let guest;
const json=async url=>(await fetch(origin+url)).json();
const next=(room,type)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Missing '+type)),15000);const off=room.onMessage(type,data=>{off();clearTimeout(t);resolve(data)})});
try {
 await call('Page.navigate',{url:'https://localhost/index.html'});await until('!!window.RvBHost');
 // This script targets the isolated QA package and owns its test rooms.
 await evaluate('RvBHost.stopLocalAuthority()');
 await touch('[onclick="showHostSheet()"]');await until('document.getElementById("hostEnterBtn").style.display==="block"');
 await touch('#hostEnterBtn');await until('location.pathname.endsWith("lobby.html") && document.querySelector("#openCreateRoom")');
 await touch('#openCreateRoom');await until('!document.getElementById("createRoomBtn").disabled');
 await touch('#createRoomBtn');await until('document.querySelector("#factionBtnBlue")?.getBoundingClientRect().height>0');
 await touch('#factionBtnBlue');await until('location.pathname.endsWith("room.html") && !!document.getElementById("readyBtn")');
 const roomId=await evaluate('new URLSearchParams(location.search).get("roomId")'),who=guestIdentity();
 const {nonce}=await json('/admission/challenge'),{profileIdentity}=await json('/catalog/identity');
 guest=await new Client(origin).joinById(roomId,{product:true,playerId:who.playerId,playerName:'Desktop QA',profileIdentity,auth:who.proof(nonce,roomId)});
 for(const type of ['roomUpdate','battleSnapshot','battleTransition','battleDurable','subscribed'])guest.onMessage(type,()=>{});
 const rpc=data=>guest.request('roomRpc',{method:'rooms.action',data:{...data,playerId:who.playerId,profileIdentity}},{timeout:15000});
 await rpc({action:'claim-faction',alignment:'dark'});await rpc({action:'toggle-ready'});
 await until('!document.getElementById("readyBtn").disabled');await touch('#readyBtn');
 await until('location.pathname.endsWith("piece-selection.html") && document.querySelectorAll("#pieceGrid .piece-card").length>=8');
 const {pieces}=await json('/catalog/pieces');await rpc({action:'select-pieces',alignment:'dark',pieces:pieces.filter(p=>p.faction==='evil').slice(0,8).map(p=>({templateId:p.id}))});
 for(let i=0;i<8;i++){await touch('#pieceGrid .piece-card:nth-child('+(i+1)+')');await until('selectedIds.size==='+(i+1));}
 await touch('#confirmBtn');
 await until('location.pathname.endsWith("battle.html") && !!window.BattleRenderer3D && typeof G!=="undefined" && !!G && document.getElementById("loadingOverlay").style.display==="none"');
 await until('BattleRenderer3D.getPerformanceDiagnostics().lastDrawCalls>0');
 const rendering=await evaluate('({renderer:!!document.querySelector("#boardStage3d canvas"),diagnostics:BattleRenderer3D.getPerformanceDiagnostics(),players:G.players.length})');
 assert(rendering.renderer&&rendering.diagnostics.lastDrawCalls>0);assert.equal(rendering.players,2);
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 fs.writeFileSync('dist/multiplayer-qa/android-host-live-3d.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 const view=next(guest,'battleSnapshot');guest.send('battleResync',{});const snapshot=await view;
 const receipt=next(guest,'battleReceipt'),action='android-ui-'+Date.now();guest.send('battleCommand',{protocolVersion:BATTLE_AUTHORITY_PROTOCOL_VERSION,authorityBuildId:BATTLE_AUTHORITY_BUILD_ID,roomId,playerId:who.playerId,expectedAuthorityVersion:snapshot.authorityVersion,clientActionId:action,command:{type:'surrender',playerId:who.playerId,clientActionId:action}});
 assert.equal((await receipt).kind,'applied');await until('!!G.terminalResult');
 console.log(JSON.stringify({phoneHostUI:true,roomId,threeD:rendering,terminal:await evaluate('G.terminalResult')}));
}finally{if(guest)await guest.leave();ws.close()}
