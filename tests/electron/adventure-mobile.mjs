// Installed APK WebView: use RVB_ADVENTURE_QA_LOCAL=1 for its native Android host.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const output='output/pve-roguelike/android-ui'
fs.mkdirSync(output,{recursive:true})
const targets=await(await fetch('http://127.0.0.1:19243/json/list')).json()
const target=targets.find(p=>p.url.startsWith('https://localhost'))
assert(target,'Forward the installed acceptance APK WebView to 19243')
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let sequence=0
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
ws.addEventListener('message',e=>{const data=JSON.parse(e.data);if(data.id)pending.get(data.id)?.(data)})
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},60000);pending.set(id,data=>{clearTimeout(timer);pending.delete(id);if(data.error)reject(Error(data.error.message));else resolve(data.result)});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value}
async function until(expression){const end=Date.now()+60000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,150))}throw Error('Timed out: '+expression)}
async function touch(selector){const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,height:r.height,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})()`);assert(point.height>=44&&point.hit,'Touch target clipped: '+selector+' '+JSON.stringify(point));await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await new Promise(r=>setTimeout(r,80));await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await new Promise(r=>setTimeout(r,500))}
async function screenshot(name){const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${output}/${name}.png`,Buffer.from(shot.data,'base64'))}
try{
  await call('Page.navigate',{url:'https://localhost/adventure.html'})
  await until('document.querySelectorAll("#families button").length>0')
  for(const [width,height] of [[393,851],[640,360],[800,360]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true})
    assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Lobby horizontal overflow')
    await touch('#families button:last-child')
    await screenshot(`lobby-${width}`)
  }
  const server=process.env.RVB_ADVENTURE_QA_SERVER
  await call('Emulation.clearDeviceMetricsOverride')
  assert(server || process.env.RVB_ADVENTURE_QA_LOCAL==='1','Select the disposable remote or Android local host')
  await evaluate(`document.getElementById('server').value=${JSON.stringify(server || '')}`)
  await touch('#solo')
  await until('location.pathname.endsWith("battle.html") && typeof adventureSnapshot!=="undefined" && !!adventureSnapshot && !adventureBusy')
  const tactical=await evaluate(`(()=>{const p=G.pieces.find(p=>p.instanceId===adventureSnapshot.world.captainId),a=BattleRenderer3D.projectCell(p.x,p.y),b=BattleRenderer3D.projectCell(p.x+1,p.y),c=BattleRenderer3D.projectCell(p.x,p.y-1);return {id:p.instanceId,x:a.clientX,y:a.clientY,spacing:Math.min(Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY),Math.hypot(c.clientX-a.clientX,c.clientY-a.clientY))}})()`)
  assert(tactical.spacing>=40,'Captain cells too small to play: '+tactical.spacing)
  async function boardTouch(point){await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await new Promise(r=>setTimeout(r,100));await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await new Promise(r=>setTimeout(r,500))}
  await boardTouch(tactical)
  await until(`selectedPieceId===${JSON.stringify(tactical.id)}`)
  const destination=await evaluate(`(()=>{for(const key of adventureSnapshot.legalMoves[adventureSnapshot.world.captainId]||[]){const [x,y]=key.split(',').map(Number),p=BattleRenderer3D.projectCell(x,y);if(p.clientX>100&&p.clientX<innerWidth-100&&p.clientY>100&&p.clientY<innerHeight-110)return {x:p.clientX,y:p.clientY,cellX:x,cellY:y}}return null})()`)
  assert(destination,'No reachable nearby move visible')
  await boardTouch(destination)
  await until(`G.pieces.some(p=>p.instanceId===${JSON.stringify(tactical.id)}&&p.x===${destination.cellX}&&p.y===${destination.cellY})&&!adventureBusy`)
  const adb=process.env.RVB_ADB_BIN||path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe')
  execFileSync(adb,['-s','emulator-5554','shell','screencap','-p','/sdcard/rvb-pve-tactical.png'],{windowsHide:true})
  execFileSync(adb,['-s','emulator-5554','pull','/sdcard/rvb-pve-tactical.png',`${output}/tactical-native.png`],{windowsHide:true})
  const actualSize=await evaluate('[innerWidth,innerHeight]')
  for(const [width] of [actualSize]){
    await until('getComputedStyle(document.getElementById("adventurePartyDock")).display==="none"')
    await touch('#adventurePartyToggle')
    await until('document.body.classList.contains("adventure-party-open")')
    assert(await evaluate(`(()=>{const r=document.getElementById('adventurePartyDock').getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight-90})()`),'Party overlaps hand rail')
    await screenshot(`party-${width}`)
    const crowded=await evaluate(`(()=>{const original=adventureSnapshot.deployment.pieces;try{adventureSnapshot.deployment.pieces=Array.from({length:14},()=>original[0]);renderAdventureWorld();const dock=document.getElementById('adventurePartyDock'),row=dock.querySelector('.adventure-party'),r=dock.getBoundingClientRect();return row.scrollWidth>row.clientWidth&&r.right<=innerWidth&&r.bottom<=innerHeight-90}finally{adventureSnapshot.deployment.pieces=original;renderAdventureWorld()}})()`)
    assert(crowded,'Large reserve roster must scroll without covering hand rail')
    await touch('.adventure-reserve-details')
    await until('getComputedStyle(document.getElementById("pieceInfoModal")).display!=="none"')
    await screenshot(`details-${width}`)
    await touch('#pieceInfoModal .pi-close')
    await until('getComputedStyle(document.getElementById("pieceInfoModal")).display==="none"')
    await touch('#adventurePartyToggle')
    await until('!document.body.classList.contains("adventure-party-open")')
  }
  await touch('#adventureMenuToggle');await touch('#adventureRoomButton')
  await until('document.getElementById("adventureDialog").open')
  const saveSelector=await evaluate(`(()=>{const b=[...document.querySelectorAll('#adventureDialogContent button')].find(b=>b.textContent==='保存冒险');b.id='qa-save-adventure';return '#'+b.id})()`)
  await touch(saveSelector);await until('!document.querySelector("#qa-save-adventure").disabled')
  await touch(saveSelector);await until('!document.querySelector("#qa-save-adventure").disabled')
  const saves=await evaluate('adventureClient.network.request("saves")')
  assert(saves.filter(s=>s.kind==='manual').length>=2,'Manual history missing')
  await screenshot('saved')
  await touch('#adventureDialog header button')
  console.log(JSON.stringify({apkWebView:true,lobbyViewports:[[393,851],[640,360],[800,360]],battleTouchViewport:actualSize,cellPixels:tactical.spacing,touchMove:true,touchDetails:true,manualSaves:saves.length}))
}finally{ws.close()}
