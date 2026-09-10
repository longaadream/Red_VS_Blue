import fs from 'node:fs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
const targets=await(await fetch('http://127.0.0.1:19243/json/list')).json()
const target=targets.find(p=>p.url.startsWith('https://localhost'))
assert(target,'Forward the actual acceptance WebView to 19243')
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let seq=0
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
ws.addEventListener('message',e=>{const data=JSON.parse(e.data);if(data.id){pending.get(data.id)?.(data);pending.delete(data.id)}})
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},90000);pending.set(id,d=>{clearTimeout(timer);if(d.error)reject(Error(d.error.message));else resolve(d.result)});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function until(expression){const end=Date.now()+45000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,150))}throw Error('Timed out: '+expression)}
async function touch(selector){const r=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,h:r.height,hit:e.contains(document.elementFromPoint(x,y))}})()`);assert(r.h>=44&&r.hit,'Control clipped '+selector);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x,y:r.y}]});await new Promise(r=>setTimeout(r,80));await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}
const native=(method,args={})=>evaluate(`Capacitor.nativePromise('AndroidMaintenance',${JSON.stringify(method)},${JSON.stringify(args)})`)
try{
 await call('Page.navigate',{url:'https://localhost/android-maintenance.html'})
 await until('document.getElementById("version")?.textContent.length>0')
 const info=await native('info');console.log(JSON.stringify({version:info.version,versionCode:info.versionCode,state:info.state,config:info.config}))
 await touch('#check')
 await until('document.getElementById("message").textContent!=="准备就绪" && !document.getElementById("check").disabled')
 console.log('Check: '+await evaluate('document.getElementById("message").textContent'))
 const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('dist/multiplayer-qa/android-maintenance.png',Buffer.from(screenshot.data,'base64'))
 if(process.argv.includes('--packs')){
   const expected=JSON.parse(fs.readFileSync('dist/android-update-qa/expected.json','utf8'))
   await native('activate',{target:'base'})
   for(const [name,hash] of [['raster',expected.raster.resolvedProfileHash],['game',expected.game.resolvedProfileHash]]){
     await call('Page.reload');await until('document.getElementById("version")?.textContent.length>0')
     await evaluate(`document.getElementById('packUrl').value='https://10.0.2.2:19443/${name}.zip'`)
     await touch('#fetchPack');await until('document.getElementById("message").textContent!=="准备就绪" && !document.getElementById("fetchPack").disabled')
     const status=await evaluate('document.getElementById("message").textContent');console.log(name+': '+status)
     assert.equal((await native('info')).state.candidate,hash,status)
     await native('activate',{target:'candidate'})
     const identity=await evaluate("fetch('__tutorial-profile.json',{cache:'no-store'}).then(r=>r.json())")
     assert.equal(identity.resolvedProfileHash,hash);assert.equal(identity.authorityContentHash,expected[name].authorityContentHash)
   }
   await call('Page.reload');await until('document.getElementById("version")?.textContent.length>0')
   assert.equal((await native('info')).state.stable,expected.game.resolvedProfileHash)
   await native('activate',{target:'previous'})
   assert.equal((await native('info')).state.stable,expected.raster.resolvedProfileHash)
   const before=(await native('info')).state.stable
   await assert.rejects(()=>native('downloadPack',{url:'https://10.0.2.2:19443/broken.zip'}))
   assert.equal((await native('info')).state.stable,before)
   await native('activate',{target:'base'})
   assert.equal((await native('info')).state.stable,'base')
   await native('cleanUnused')
   console.log('PASS: native HTTPS resource import, shared signature/resolver, raster/game identity, reload, rollback, broken ZIP, Base recovery')
 }
 if(process.argv.includes('--download')){
   const result=await native('checkUpdate');assert(result.available)
   await native('downloadUpdate');console.log('PASS: downloaded and verified newer same-signer APK')
   await evaluate("localStorage.setItem('android_update_preserved','verified-before-upgrade')")
   await native('installUpdate');console.log('System installer requested; complete its UI confirmation separately')
 }
 if(process.argv.includes('--negative-updates')){
   const manifestPath='dist/android-update-qa/android-latest.json',original=fs.readFileSync(manifestPath),manifest=JSON.parse(original)
   const write=value=>fs.writeFileSync(manifestPath,JSON.stringify(value))
   try{
     write({...manifest,versionCode:info.versionCode});assert.equal((await native('checkUpdate')).available,false)
     for(const change of [{packageName:'wrong.package'},{minSdk:999},{url:'http://10.0.2.2:19443/version7.apk'}]){
       write({...manifest,...change});await assert.rejects(()=>native('checkUpdate'))
     }
     write({...manifest,sha256:'0'.repeat(64)});await native('checkUpdate');await assert.rejects(()=>native('downloadUpdate'))
     write({...manifest,versionCode:99});await native('checkUpdate');await assert.rejects(()=>native('downloadUpdate'))
     const wrong=fs.readFileSync('dist/android-update-qa/version7-wrong-signer.apk')
     write({...manifest,url:'https://10.0.2.2:19443/version7-wrong-signer.apk',size:wrong.length,sha256:crypto.createHash('sha256').update(wrong).digest('hex')})
     await native('checkUpdate');await assert.rejects(()=>native('downloadUpdate'))
     await assert.rejects(()=>native('downloadPack',{url:'https://10.0.2.2:19443/redirect.zip'}))
     write({...manifest,url:'https://10.0.2.2:19443/slow.apk'});await native('checkUpdate')
     const download=native('downloadUpdate');const result=assert.rejects(()=>download)
     await new Promise(r=>setTimeout(r,350));await native('cancel');await result
     write({...manifest,url:'https://10.0.2.2:19444/offline.apk'});await native('checkUpdate');await assert.rejects(()=>native('downloadUpdate'))
     console.log('PASS: current version, wrong package, incompatible SDK, HTTP URL/redirect, hash, version, signer, cancellation and unavailable server rejected')
   }finally{fs.writeFileSync(manifestPath,original)}
 }
 if(process.argv.includes('--upgraded')){
   assert.equal(await evaluate("localStorage.getItem('android_update_preserved')"),'verified-before-upgrade')
   assert.equal(info.versionCode,Number(process.env.RVB_EXPECTED_VERSION||6));console.log('PASS: upgrade version and settings preserved')
 }
 if(process.argv.includes('--install')){await native('installUpdate');console.log('System installer requested')}
 if(process.argv.includes('--local-input')){await touch('#choose');console.log('Native document picker requested')}
 if(process.argv.includes('--recovery')){
   await call('Page.enable')
   let confirmations=0
   ws.addEventListener('message',event=>{const d=JSON.parse(event.data);if(d.method==='Page.javascriptDialogOpening'){confirmations++;void call('Page.handleJavaScriptDialog',{accept:true})}})
   await evaluate("sessionStorage.setItem('rvb_colyseus_reconnect:https://expired.example:old:player','expired-token')")
   await touch('#base')
   await until("document.getElementById('message').textContent.includes('资源已切换')")
   assert(confirmations>=2);assert.equal(await evaluate("sessionStorage.getItem('rvb_colyseus_reconnect:https://expired.example:old:player')"),null)
   assert.equal((await native('info')).state.stable,'base')
   console.log('PASS: explicit stale reservation confirmation and Base recovery')
 }
}finally{ws.close()}
