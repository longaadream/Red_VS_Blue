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
import { Client } from '@colyseus/sdk'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
const origin = 'http://127.0.0.1:19267' // ADB forward to APK's own Node host, not a Windows server.
const guests = []
function rpc(room, profileIdentity) {
  const pending = new Map()
  room.onMessage('adventure.state', () => {}); room.onMessage('adventure.error', () => {})
  room.onMessage('adventure.reply', reply => { const p = pending.get(reply.requestId); if (!p) return; pending.delete(reply.requestId); clearTimeout(p.timer); if (reply.error) p.reject(Error(reply.error.message)); else p.resolve(reply.result) })
  return (type, payload = {}) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout: ' + type)) }, 15000)
    pending.set(id, { resolve, reject, timer }); room.send('adventure.rpc', { requestId: id, actionId: id, type, payload, profileIdentity })
  })
}
try {
  await call('Page.navigate', { url: 'https://localhost/adventure.html' })
  await until('document.querySelectorAll("#families button").length>0')
  await touch('#create'); await until('typeof adventureLobby!=="undefined" && !!adventureLobby && !lobbyBusy')
  const roomId = await evaluate('adventureLobby.roomId')
  const profileIdentity = await evaluate('fetch("./__tutorial-profile.json").then(r=>r.json())')
  const health = await (await fetch(origin + '/healthz')).json()
  assert.equal(health.runtime, 'colyseus-android'); assert.equal(health.database, 'sqlite')
  for (let i = 0; i < 3; i++) {
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
    const playerId = createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 8)
    const { nonce } = await (await fetch(origin + '/admission/challenge')).json()
    const payload = { type: 'rvb-colyseus-admission-v1', nonce, playerId, roomId }
    const room = await new Client(origin).joinById(roomId, { playerId, name: '桌面 SDK ' + (i + 1), familyId: ['light','shield','pressure'][i], profileIdentity, auth: { payload, publicKey, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('hex') } })
    const request = rpc(room, profileIdentity); guests.push({ room, request }); await request('ready', { ready: true })
  }
  const listing = await (await fetch(origin + '/rooms?mode=pve')).json()
  assert(listing.rooms.some(r => r.id === roomId && r.players === 4))
  await touch('#start')
  await until('location.pathname.endsWith("battle.html") && typeof adventureSnapshot!=="undefined" && !!adventureSnapshot && !adventureBusy && adventureSnapshot.world.canSave')
  const revision = await evaluate('adventureSnapshot.revision')
  for (const guest of guests) {
    assert.equal((await guest.request('snapshot')).snapshot.revision, revision)
    await assert.rejects(guest.request('save'), /房主/)
  }
  const adb = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe')
  execFileSync(adb, ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_HOME'], { windowsHide: true })
  await new Promise(resolve => setTimeout(resolve, 15000))
  assert.equal((await guests[0].request('snapshot')).snapshot.revision, revision)
  execFileSync(adb, ['-s', 'emulator-5554', 'shell', 'am', 'start', '-W', '-n', 'com.redvsblue.client.uiqa/com.redvsblue.client.UiAcceptanceActivity'], { windowsHide: true })
  await evaluate('adventureClient.network.request("save")')
  await evaluate('adventureClient.network.request("save")')
  const saved = await evaluate('adventureClient.network.request("saves")')
  const chosen = saved.find(s => s.revision === revision)
  assert(chosen)
  // Stop the native service, not just its socket, then resume through the same UI used by players.
  await Promise.all(guests.map(g => g.room.leave())); guests.length = 0
  await call('Page.navigate', { url: 'https://localhost/adventure.html' })
  await until('!!window.RvBHost')
  assert((await evaluate('RvBHost.stopLocalAuthority()')).ok)
  await until('(async()=>!(await RvBHost.getHostInfo()).running)()')
  await touch('#resume')
  await until('document.querySelectorAll("#saves button").length>=2')
  const restoredList = await evaluate('adventureLobby.request("saves")')
  const index = restoredList.findIndex(s => s.runId === chosen.runId)
  assert(index >= 0, 'Save lost across native service restart')
  await touch(`#saves button:nth-child(${index + 1})`)
  await until('location.pathname.endsWith("battle.html") && typeof adventureSnapshot!=="undefined" && !!adventureSnapshot && !adventureBusy')
  assert.equal(await evaluate('adventureSnapshot.revision'), revision)
  await screenshot('android-host-restored')
  console.log(JSON.stringify({ androidNativeHost: true, desktopSdkGuests: 3, fourSeats: true, guestSaveRejected: true, nativeServiceRestart: true, oldSaveRestored: chosen.runId, revision }))
} finally { await Promise.allSettled(guests.map(g => g.room.leave())); ws.close() }
