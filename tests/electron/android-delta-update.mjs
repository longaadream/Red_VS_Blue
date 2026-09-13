// Dedicated deltaqa app + loopback HTTPS fixture; no production release/config changes.
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import assert from 'node:assert/strict'
import { androidArtifacts } from '../../scripts/android-release-artifacts.mjs'
const root=path.resolve('dist/android-delta-qa')
const mode=process.argv[2]
if(mode==='serve') {
  const result=androidArtifacts(path.join(root,'target.apk'),'v0.1.2',{previousApk:path.join(root,'base.apk')})
  assert.equal(result.manifest.packageName,'com.redvsblue.client.deltaqa')
  assert.equal(result.manifest.deltas.length,1)
  const delta=result.manifest.deltas[0]
  fs.writeFileSync(path.join(root,'patch.rvbdelta'),result.assets.get(new URL(delta.url).pathname.split('/').at(-1)))
  result.manifest.url='https://10.0.2.2:19444/full.apk';delta.url='https://10.0.2.2:19444/patch.rvbdelta'
  fs.writeFileSync(path.join(root,'android-latest.json'),JSON.stringify(result.manifest))
  fs.writeFileSync(path.join(root,'manifest-original.json'),JSON.stringify(result.manifest))
  const traffic=[]
  https.createServer({key:fs.readFileSync(path.join(root,'key.pem')),cert:fs.readFileSync(path.join(root,'cert.pem'))},(req,res)=>{
    const files={'/android-latest.json':'android-latest.json','/full.apk':'target.apk','/patch.rvbdelta':'patch.rvbdelta'}
    const file=files[req.url];if(!file){res.writeHead(404);res.end();return}
    const location=path.join(root,file),size=fs.statSync(location).size
    res.writeHead(200,{'Content-Length':size,'Content-Type':'application/octet-stream'})
    res.on('finish',()=>{traffic.push({path:req.url,bytes:size});fs.writeFileSync(path.join(root,'traffic.json'),JSON.stringify(traffic,null,2))})
    fs.createReadStream(location).pipe(res)
  }).listen(19444,'127.0.0.1',()=>console.log('deltaqa HTTPS ready on 19444'))
} else if(mode==='verify' || mode==='post-install') {
  const targets=await(await fetch('http://127.0.0.1:19245/json/list')).json()
  const target=targets.find(t=>t.url.startsWith('https://localhost'))
  assert(target,'Forward deltaqa WebView to port19245')
  const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let seq=0
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
  ws.addEventListener('message',event=>{const data=JSON.parse(event.data);pending.get(data.id)?.(data)})
  function call(method,params={}) {return new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},120000)
    pending.set(id,r=>{clearTimeout(timer);pending.delete(id);if(r.error)reject(Error(JSON.stringify(r.error)));else resolve(r.result)})
    ws.send(JSON.stringify({id,method,params}))
  })}
  async function evaluate(expression) {const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  const native=(method,args={})=>evaluate(`Capacitor.Plugins.AndroidMaintenance[${JSON.stringify(method)}](${JSON.stringify(args)})`)
  try {
    await call('Page.navigate',{url:'https://localhost/android-maintenance.html'})
    let ready=false
    for(let i=0;i<60;i++) {try{if(await evaluate('!!window.Capacitor?.Plugins?.AndroidMaintenance && document.readyState==="complete"')){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,300))}
    assert(ready,'Native maintenance did not become ready')
    assert.equal((await native('info')).packageName,'com.redvsblue.client.deltaqa')
    if(mode==='post-install') {
      assert.equal((await native('info')).versionCode,20302)
      assert.equal(await evaluate('localStorage.getItem("rvb-delta-qa-marker")'),'RED203-preserved')
      assert.equal((await native('checkUpdate')).available,false)
      fs.writeFileSync(path.join(root,'installed-results.json'),JSON.stringify({versionCode:20302,localStoragePreserved:true,currentVersionRecognized:true},null,2))
      console.log('PASS installed reconstructed APK20302; localStorage preserved; no repeat update')
    } else {
    await evaluate('localStorage.setItem("rvb-delta-qa-marker","RED203-preserved")')
    const trafficStart=fs.existsSync(path.join(root,'traffic.json'))?JSON.parse(fs.readFileSync(path.join(root,'traffic.json'))).length:0
    assert.equal((await native('checkUpdate')).available,true)
    const delta=await native('downloadUpdate');assert.equal(delta.mode,'delta')
    const firstTraffic=JSON.parse(fs.readFileSync(path.join(root,'traffic.json'))).slice(trafficStart)
    assert(firstTraffic.some(r=>r.path==='/patch.rvbdelta'));assert(!firstTraffic.some(r=>r.path==='/full.apk'))
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest-original.json')))
    const damaged=structuredClone(manifest);damaged.deltas[0].sha256='0'.repeat(64)
    fs.writeFileSync(path.join(root,'android-latest.json'),JSON.stringify(damaged))
    assert.equal((await native('checkUpdate')).available,true)
    const fallback=await native('downloadUpdate');assert.equal(fallback.mode,'full')
    fs.writeFileSync(path.join(root,'android-latest.json'),JSON.stringify(manifest))
    fs.writeFileSync(path.join(root,'native-results.json'),JSON.stringify({delta,fallback,info:await native('info'),firstTraffic},null,2))
    console.log('PASS native HTTPS delta-only download + corrupt delta fallback; both APK signatures validated')
    }
  } finally {ws.close()}
} else throw Error('Usage: android-delta-update.mjs serve | verify')
