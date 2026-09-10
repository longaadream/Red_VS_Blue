import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import dgram from 'node:dgram'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url), root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const { CreativeWorkbench } = require(path.join(root, 'electron-editor/dist/workbench.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-training-smoke-'))
const userData = path.join(temporary, 'user'); fs.mkdirSync(userData)
const project = createContentProject(temporary, 'official', root)
const wb = new CreativeWorkbench(project, root)
const task = wb.create({ title:'训练营验收', brief:'蓝染攻击 5、小乌恢复 1', criteria:'实际训练营使用已接受数值' })
function edit(relative, transform) { const file = path.join(project,relative), data = JSON.parse(fs.readFileSync(file,'utf8')); transform(data); fs.writeFileSync(file,JSON.stringify(data,null,2)) }
edit('data/pieces/dark-aizen.json', data => { data.stats.attack = 5 })
for (const name of ['dealt','taken']) edit(`data/rules/rule-ulquiorra-damage-${name}.json`, data => { data.skillCode = data.skillCode.replace(/heal:\s*2/g,'heal: 1') })
let state = wb.inspect(task.task.id)
state = wb.accept(task.task.id,{paths:state.changes.map(c=>c.path),expectedHash:state.contentHash,expectedAcceptedHash:state.acceptedHash})
edit('data/pieces/dark-aizen.json', data => { data.stats.attack = 99 })
fs.writeFileSync(path.join(userData,'content-project-selection.json'),JSON.stringify({root:project}))
const listener = net.createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r))
const port = listener.address().port; await new Promise(r=>listener.close(r))
const udp = dgram.createSocket('udp4'); let packets = 0
udp.on('message',()=>packets++); await new Promise(r=>udp.bind(0,'127.0.0.1',r))
const tcp = net.createServer(socket=>{ packets++; socket.destroy() }); await new Promise(r=>tcp.listen(0,'127.0.0.1',r))
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(process.env.RVB_GRAPH_ELECTRON_BINARY,[path.join(root,'electron-editor/dist/main.js'),`--user-data-dir=${userData}`,`--remote-debugging-port=${port}`,'--editor-smoke-hidden'],{env,windowsHide:true,stdio:'ignore'})
const delay = ms=>new Promise(r=>setTimeout(r,ms)), sockets=[]
async function connect(match) {
  for(let i=0;i<300;i++) {
    try { const tabs=await(await fetch(`http://127.0.0.1:${port}/json`)).json(), tab=tabs.find(t=>t.type==='page'&&match(t.url))
      if(tab) { const socket=new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r=>socket.addEventListener('open',r,{once:true})); sockets.push(socket); let seq=0
        const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error('CDP timeout '+method)),120000);const onMessage=event=>{const v=JSON.parse(event.data);if(v.id!==id)return;clearTimeout(timer);socket.removeEventListener('message',onMessage);if(v.error){reject(new Error(JSON.stringify(v.error)))}else{resolve(v.result)}};socket.addEventListener('message',onMessage);socket.send(JSON.stringify({id,method,params}))})
        const evaluate=async(expression)=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value}
        return {call,evaluate}
      }
    } catch {}
    await delay(200)
  } throw new Error('Window startup timed out')
}
async function until(client,expression) { for(let i=0;i<300;i++){if(await client.evaluate(expression))return;await delay(100)}throw new Error('Condition timed out: '+expression) }
const evidence=path.join(root,'docs/qa/RED-202-IDE')
try {
  const editor=await connect(url=>url.includes('index.html'))
  await until(editor,"Boolean(document.querySelector('[data-section=tests]'))")
  await editor.evaluate("document.querySelector('[data-tab=workbench]').click();document.querySelector('[data-section=tests]').click()")
  assert.equal(await editor.evaluate("document.querySelector('[data-wb=training]').disabled"),false)
  await editor.evaluate("document.querySelector('[data-wb=training]').click()")
  const training=await connect(url=>url.startsWith('rvb-editor-training:'))
  await until(training,"Boolean(document.querySelector('#trainingFirstPieces input'))")
  const marker=await training.evaluate("fetch('./__editor-preview.json').then(r=>r.json())")
  assert.equal(marker.contentHash,state.acceptedHash)
  assert.equal(await training.evaluate("fetch('./data/pieces/dark-aizen.json').then(r=>r.json()).then(p=>p.stats.attack)"),5)
  assert.equal(await training.evaluate("typeof editorAPI + ':' + typeof electronAPI"),'undefined:undefined')
  assert.equal(await training.evaluate("fetch('http://127.0.0.1:"+tcp.address().port+"/').then(()=>false,()=>true)"),true)
  await training.evaluate(`(async()=>{window.probeRTC=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'},{urls:'turn:127.0.0.1:${tcp.address().port}?transport=tcp',username:'probe',credential:'probe'}]});probeRTC.createDataChannel('probe');await probeRTC.setLocalDescription(await probeRTC.createOffer());})()`)
  await delay(2500); assert.equal(packets,0); await training.evaluate('probeRTC.close()')
  const screenshot=await training.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,'training-setup.png'),Buffer.from(screenshot.data,'base64'))
  await training.evaluate("document.querySelector('#trainingFirstFaction').value='red';document.querySelector('#trainingSecondFaction').value='red';refreshTrainingSetupPieces();document.querySelectorAll('#trainingFirstPieces input').forEach(e=>e.checked=e.value==='dark-ulquiorra');document.querySelectorAll('#trainingSecondPieces input').forEach(e=>e.checked=e.value==='dark-aizen');startTrainingFromSetup()")
  await until(training,"typeof G !== 'undefined' && G && G.pieces && G.pieces.some(p=>p.templateId==='dark-aizen')")
  const pieces=await training.evaluate('G.pieces')
  assert.equal(pieces.find(p=>p.templateId==='dark-aizen').attack,5)
  assert.ok((await training.evaluate("fetch('./data/rules/rule-ulquiorra-damage-dealt.json').then(r=>r.json()).then(r=>r.skillCode)")).includes('heal: 1'))
  const combat = await training.evaluate(`(async()=>{const caster=G.pieces.find(p=>p.templateId==='dark-ulquiorra'),target=G.pieces.find(p=>p.templateId==='dark-aizen');caster.currentHp=6;caster.x=3;caster.y=3;target.x=4;target.y=3;const before=target.currentHp;G=await trainingApiFetch('PUT',{battleState:G,action:await prepareTutorialTargetAction({type:'useBasicSkill',playerId:caster.ownerPlayerId,pieceId:caster.instanceId,skillId:'ulquiorra-cero',clientActionId:'training-smoke-cero'},{targetPieceId:target.instanceId})});renderBoard();return {healedHp:G.pieces.find(p=>p.instanceId===caster.instanceId).currentHp,targetHp:G.pieces.find(p=>p.instanceId===target.instanceId).currentHp,before};})()`)
  console.log('combat',JSON.stringify(combat)); assert.equal(combat.healedHp,7); assert.ok(combat.targetHp<combat.before)
  const battle=await training.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(evidence,'training-battle.png'),Buffer.from(battle.data,'base64'))
  assert.deepEqual(fs.readdirSync(path.join(userData,'training-previews')),[])
  edit('data/pieces/dark-aizen.json', data=>{data.stats.attack=6})
  const nextDraft=wb.inspect(task.task.id), next=wb.accept(task.task.id,{paths:['data/pieces/dark-aizen.json'],expectedHash:nextDraft.contentHash,expectedAcceptedHash:nextDraft.acceptedHash})
  await editor.evaluate(`editorAPI.workbenchTraining(${JSON.stringify(task.task.id)},${JSON.stringify(next.acceptedHash)})`)
  const oldOrigin=await training.evaluate('location.host')
  const reopened=await connect(url=>url.startsWith('rvb-editor-training:')&&!url.includes(oldOrigin))
  assert.equal(await reopened.evaluate("fetch('./data/pieces/dark-aizen.json').then(r=>r.json()).then(p=>p.stats.attack)"),6)
  assert.equal(await training.evaluate("fetch('./data/pieces/dark-aizen.json').then(r=>r.json()).then(p=>p.stats.attack)"),5)
  const report={ok:true,acceptedHash:state.acceptedHash,combat,checks:['enabled UI opens actual training','accepted attack 5, unaccepted attack 99 excluded','real battle creates Aizen with attack 5','Cero actually damages opponent and heals Ulquiorra from 6 to 7','reopen new accepted attack 6; previous window stays 5','no native bridge','HTTP and WebRTC loopback probes blocked','temporary preparation files removed']}
  fs.writeFileSync(path.join(evidence,'training-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
} finally { for(const socket of sockets)socket.close();child.kill();udp.close();tcp.close() }
