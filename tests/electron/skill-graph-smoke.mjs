import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const root = process.cwd()
const presentationMode = process.env.RVB_PRESENTATION_SMOKE === '1'
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const { assertSkillGraphArtifact } = require(path.join(root, 'electron-editor/dist/skill-graph.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-graph-smoke-'))
const userData = path.join(temporary, 'user'); fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const original = { id: 'graph-demo', name: '流程图测试技能', description: '旧描述', kind:'active', type:'normal', code:'function executeSkill(){return {success:true};}', cooldownTurns:1, actionPointCost:1, maxCharges:0, powerMultiplier:1, extension:{preserved:true} }
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([original.id]))
const skillFile = path.join(project, 'data/skills/graph-demo.json')
fs.writeFileSync(skillFile, JSON.stringify(original))
const existingSkill = JSON.parse(fs.readFileSync(path.join(root, 'data/skills/naruto-sage-mode.json'), 'utf8'))
const existingRule = JSON.parse(fs.readFileSync(path.join(root, 'data/rules/rule-naruto-sage-tick.json'), 'utf8'))
fs.writeFileSync(path.join(project, 'data/skills/naruto-sage-mode.json'), JSON.stringify(existingSkill))
const ruleFile = path.join(project, 'data/rules/rule-naruto-sage-tick.json')
fs.writeFileSync(ruleFile, JSON.stringify({ ...existingRule, extension: { preserved: true } }))
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root:project }))
const listener = net.createServer(); await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve))
const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root,'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root,'electron-editor/dist/main.js')]
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable,[...args,`--user-data-dir=${userData}`,`--remote-debugging-port=${port}`,'--editor-smoke-hidden'],{env,windowsHide:true,stdio:'ignore'})
let startupError
child.on('error', error => { startupError = error })
let socket, sequence = 0
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
async function connect() {
  for (let attempt=0;attempt<120;attempt++) {
    if (startupError) throw startupError
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(1500)})).json()
      const tab = tabs.find(tab => tab.type==='page' && tab.url.includes('index.html'))
      if (tab) { socket = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((resolve,reject) => {socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})}); return }
    } catch { /* bounded app startup */ }
    await delay(250)
  }
  throw new Error('Editor startup timed out')
}
function call(method,params={}) {
  return new Promise((resolve,reject) => {
    const id=++sequence
    const timer=setTimeout(()=>{socket.removeEventListener('message',onMessage);reject(new Error('CDP timeout: '+method))},20000)
    const onMessage=event=>{const result=JSON.parse(event.data);if(result.id!==id)return;clearTimeout(timer);socket.removeEventListener('message',onMessage);if(result.error){reject(new Error(JSON.stringify(result.error)))}else{resolve(result.result)}}
    socket.addEventListener('message',onMessage);socket.send(JSON.stringify({id,method,params}))
  })
}
async function evaluate(expression) {
  const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100)}throw new Error('UI condition timed out: '+expression)}
const evidence=process.env.RVB_GRAPH_EVIDENCE_DIR || path.join(root,presentationMode?'docs/qa/RED-202':'docs/qa/RED-192-graph');fs.mkdirSync(evidence,{recursive:true})
try {
  await connect();await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate("document.querySelector('[data-tab=skills]').click();[...document.querySelectorAll('#skills-list .entity-item')].find(e=>e.textContent.includes('仙人模式')).click();document.querySelector('#skills-detail [data-editor-mode=graph]').click()")
  await until("document.querySelectorAll('#skills-detail [data-source-flow-node]').length>3")
  const skillScreenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
  fs.writeFileSync(path.join(evidence,'existing-skill-flow.png'),Buffer.from(skillScreenshot.data,'base64'))
  await evaluate("[...document.querySelectorAll('#skills-detail .flow-links button')].find(b=>b.textContent.includes('rule-naruto-sage-tick')).click()")
  await until("document.querySelectorAll('#rules-detail [data-source-flow-node]').length>3")
  const ruleScreenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
  fs.writeFileSync(path.join(evidence,'existing-rule-flow.png'),Buffer.from(ruleScreenshot.data,'base64'))
  await evaluate("[...document.querySelectorAll('#rules-detail [data-source-flow-node]')].find(n=>n.querySelector('code').textContent.length>0).click()")
  await evaluate("document.querySelector('#rules-detail [data-flow-node-source]').value+=' /* source-flow-smoke */';[...document.querySelectorAll('#rules-detail .flow-inspector button')].find(b=>b.textContent==='应用节点修改').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]').textContent!=='已保存'")
  await evaluate("document.querySelector('#rules-detail [data-save-json]').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]').textContent==='已保存'")
  const editedRule=JSON.parse(fs.readFileSync(ruleFile,'utf8'))
  assert.ok(editedRule.skillCode.includes('source-flow-smoke'));assert.deepEqual(editedRule.extension,{preserved:true});assert.deepEqual(editedRule.trigger,existingRule.trigger)
  await call('Page.reload');await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate("document.querySelector('[data-tab=skills]').click();document.querySelector('#skills-list .entity-item').click();document.querySelector('#skills-detail [data-editor-mode=graph]').click()")
  await evaluate("document.querySelector('#skills-detail [data-typed-graph]').open=true")
  await evaluate("[...document.querySelectorAll('#skills-detail button')].find(b=>b.textContent==='建立空白技能图').click()")
  for (const kind of presentationMode ? ['select-piece','select-cell','select-options','condition-option','display-bind','display-indicator','display-marker','display-cue','display-remove'] : ['select-piece','damage','heal']) {
    await evaluate(`document.querySelector('.graph-toolbar select').value=${JSON.stringify(kind)};[...document.querySelectorAll('.graph-toolbar button')].find(b=>b.textContent==='新增节点').click()`)
  }
  const configure = async (id,params,ports) => {
    await evaluate(`document.querySelector('[data-graph-node="${id}"]').click()`)
    for(const [key,value] of Object.entries(params))await evaluate(`(()=>{const e=document.querySelector('[data-graph-param="${key}"]');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    for(const [port,target] of Object.entries(ports))await evaluate(`(()=>{const e=document.querySelector('[data-graph-port="${port}"]');e.value=${JSON.stringify(target)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  }
  if (presentationMode) {
    await configure('start',{}, {next:'node-1'})
    await configure('node-1',{}, {next:'node-2'})
    await configure('node-2',{}, {next:'node-3'})
    await configure('node-3',{options:'显示镜像|保持原样',min:1,max:2}, {next:'node-4'})
    await configure('node-4',{choice:'node-3',value:1}, {yes:'node-5',no:'node-9'})
    await configure('node-5',{target:'node-1',sourcePiece:'self',fields:'health'}, {next:'node-6'})
    await configure('node-6',{target:'node-1',label:'查克拉进度',value:3,max:6,audience:'owner'}, {next:'node-7'})
    await configure('node-7',{cell:'node-2',label:'分身位置',icon:'✦'}, {next:'node-8'})
    await configure('node-8',{target:'node-1',label:'分身出现',kind:'sound',sound:'success'}, {next:'end'})
    await configure('node-9',{slot:'binding'}, {next:'end'})
    await until("!document.querySelector('#skills-detail [data-save-json]').disabled")
    await evaluate("[...document.querySelectorAll('.graph-toolbar button')].find(b=>b.textContent==='自动排列').click();document.querySelector('#skills-detail [data-save-json]').click()")
    await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
    const saved=JSON.parse(fs.readFileSync(skillFile,'utf8'));assertSkillGraphArtifact(saved);assert.equal(saved.skillGraph.nodes.length,11)
    assert.ok(saved.code.includes('flow.presentation.bind'));assert.ok(saved.code.includes('flow.presentation.emit'));assert.equal(saved.targeting.steps[2].maxSelections,2)
    await call('Page.reload');await until("Boolean(document.querySelector('#skills-list .entity-item'))")
    await evaluate("document.querySelector('[data-tab=skills]').click();document.querySelector('#skills-list .entity-item').click();document.querySelector('#skills-detail [data-editor-mode=graph]').click();document.querySelector('#skills-detail [data-typed-graph]').open=true")
    assert.equal(await evaluate("document.querySelectorAll('[data-graph-node]').length"),11)
    await configure('node-6',{}, {})
    assert.equal(await evaluate("document.querySelector('[data-graph-param=label]').value"),'查克拉进度')
    assert.equal(await evaluate("document.querySelector('[data-graph-param=audience]').value"),'owner')
    await evaluate("document.querySelector('.graph-inspector').scrollIntoView({block:'center'})")
    const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
    fs.writeFileSync(path.join(evidence,'skill-presentation-editor.png'),Buffer.from(screenshot.data,'base64'))
    fs.writeFileSync(path.join(evidence,'candidate-skill.json'),JSON.stringify(saved,null,2)+'\n')
    const report={ok:true,nodeCount:11,checks:['real editor node creation and wiring','option branch and multi-choice contract','display binding/indicator/marker/cue/remove nodes','Chinese audience settings','atomic save and reopen','compiled artifact validation'],screenshot:'skill-presentation-editor.png'}
    fs.writeFileSync(path.join(evidence,'smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
  } else {
  await configure('start',{}, {next:'node-1'})
  await configure('node-1',{}, {next:'node-2'})
  await configure('node-2',{target:'node-1',basis:'fixed',value:10,damageType:'true'}, {next:'node-3'})
  await configure('node-3',{target:'self',basis:'actualDamage',source:'node-2',value:50}, {next:'end'})
  await until("!document.querySelector('#skills-detail [data-save-json]').disabled")
  await evaluate("[...document.querySelectorAll('.graph-toolbar button')].find(b=>b.textContent==='自动排列').click()")
  // A cycle remains editable but cannot be saved; reconnecting fixes it.
  await configure('node-3',{}, {next:'node-2'})
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-save-json]').disabled"),true)
  await configure('node-3',{}, {next:'end'})
  await evaluate("document.querySelector('#skills-detail [data-editor-mode=code]').click()")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).code.includes('healDamage')"),true)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-ide-field=code] .cm-content').getAttribute('contenteditable')"),'false')
  await evaluate("document.querySelector('#skills-detail [data-editor-mode=json]').click()")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).extension.preserved"),true)
  await evaluate("document.querySelector('#skills-detail [data-save-json]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const saved=JSON.parse(fs.readFileSync(skillFile,'utf8'));assertSkillGraphArtifact(saved);assert.equal(saved.skillGraph.nodes.length,5)
  await call('Page.reload');await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate("document.querySelector('[data-tab=skills]').click();document.querySelector('#skills-list .entity-item').click();document.querySelector('#skills-detail [data-editor-mode=graph]').click()")
  assert.equal(await evaluate("document.querySelectorAll('[data-graph-node]').length"),5)
  const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
  fs.writeFileSync(path.join(evidence,'skill-graph-editor.png'),Buffer.from(screenshot.data,'base64'))
  // External modification remains protected by the existing optimistic revision check.
  fs.writeFileSync(skillFile,JSON.stringify({...saved,name:'外部修改'}))
  await configure('node-2',{value:12},{})
  await evaluate("document.querySelector('#skills-detail [data-save-json]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='保存失败'")
  assert.equal(JSON.parse(fs.readFileSync(skillFile,'utf8')).name,'外部修改')
  const report={ok:true,checks:['existing Naruto skill flow automatically populated','follow skill link into real rule flow','edit rule source node and save preserving other fields','real canvas node creation/parameters/connections','cycle blocks save','code/JSON synchronization','unknown fields preserved','atomic save and reload','external revision conflict protected'],screenshot:'skill-graph-editor.png'}
  fs.writeFileSync(path.join(evidence,'smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
  }
} finally {socket?.close();child.kill()}
