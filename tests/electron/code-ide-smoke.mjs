import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-ide-smoke-'))
const userData = path.join(temporary, 'user'); fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const original = { id: 'graph-demo', name: '代码 IDE 验收技能', description: '旧描述', kind:'active', type:'normal', code:'function executeSkill(){return {success:true};}', cooldownTurns:1, actionPointCost:1, maxCharges:0, powerMultiplier:1, extension:{preserved:true} }
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([original.id]))
const skillFile = path.join(project, 'data/skills/graph-demo.json')
fs.writeFileSync(skillFile, JSON.stringify(original))
const existingSkill = JSON.parse(fs.readFileSync(path.join(root, 'data/skills/naruto-sage-mode.json'), 'utf8'))
const existingRule = JSON.parse(fs.readFileSync(path.join(root, 'data/rules/rule-naruto-sage-tick.json'), 'utf8'))
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([original.id, existingSkill.id]))
fs.writeFileSync(path.join(project, 'data/rules/manifest.json'), JSON.stringify([existingRule.id]))
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
const evidence = path.join(root, 'docs/qa/RED-202-IDE')
fs.mkdirSync(evidence, { recursive: true })
async function openCode(collection, id) {
  await evaluate(`document.querySelector('[data-tab=${collection}]').click(); [...document.querySelectorAll('#${collection}-list .entity-item')].find(e=>e.querySelector('.id').textContent===${JSON.stringify(id)}).click(); document.querySelector('#${collection}-detail [data-editor-mode=code]').click()`)
  await until(`Boolean(document.querySelector('#${collection}-detail .cm-content'))`)
}
async function pasteCode(selector, source) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  await call('Input.dispatchKeyEvent', { type:'keyDown', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:2 })
  await call('Input.dispatchKeyEvent', { type:'keyUp', key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:2 })
  await call('Input.insertText', { text: source })
}
const clickButton = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)}+' button')].find(e=>e.textContent===${JSON.stringify(text)}).click()`)
const draftCode = (collection, field) => evaluate(`JSON.parse(document.querySelector('#${collection}-detail [data-json-source]').value)[${JSON.stringify(field)}]`)
try {
  await connect(); await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  const packSmokeTask = await evaluate("editorAPI.workbenchCreate({title:'IDE 打包验收',brief:'粘贴并保存 JSON 代码后导出原包',criteria:'原包保留接受后的代码'})")
  await openCode('skills', 'graph-demo')
  const pasted = 'function executeSkill(context){/* AI 粘贴 */ const text="引号\\\" 与换行\\n";return {success:true,text,value:context.value};}'
  await pasteCode('#skills-detail .cm-content', pasted)
  await until(`JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).code===${JSON.stringify(pasted)}`)
  await clickButton('#skills-detail .ide-toolbar', '格式化')
  await until("document.querySelector('#skills-detail .ide-message').textContent.includes('已按')")
  const formatted = await draftCode('skills', 'code')
  assert.ok(formatted.includes('\n')); assert.ok(formatted.includes('/* AI 粘贴 */'))
  await clickButton('#skills-detail .ide-toolbar', '撤销')
  assert.equal(await draftCode('skills', 'code'), pasted)
  await clickButton('#skills-detail .ide-toolbar', '重做')
  assert.equal(await draftCode('skills', 'code'), formatted)
  await evaluate("document.querySelector('#skills-detail .cm-content').focus()")
  await call('Input.dispatchKeyEvent', { type:'keyDown', key:'s', code:'KeyS', windowsVirtualKeyCode:83, modifiers:2 })
  await call('Input.dispatchKeyEvent', { type:'keyUp', key:'s', code:'KeyS', windowsVirtualKeyCode:83, modifiers:2 })
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  assert.equal(JSON.parse(fs.readFileSync(skillFile,'utf8')).code, formatted)
  assert.deepEqual(JSON.parse(fs.readFileSync(skillFile,'utf8')).extension, {preserved:true})
  await call('Page.reload'); await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await openCode('skills','graph-demo')
  assert.equal(await draftCode('skills','code'), formatted)
  await until("document.querySelector('#skills-detail .ide-status').textContent.includes('语法检查通过')")
  const screenshot = await call('Page.captureScreenshot', {format:'png',captureBeyondViewport:false})
  fs.writeFileSync(path.join(evidence,'builtin-code-ide.png'),Buffer.from(screenshot.data,'base64'))
  await pasteCode('#skills-detail .cm-content', 'function executeSkill() {\nconst broken = ;\n}')
  await clickButton('#skills-detail .ide-toolbar', '格式化')
  await until("document.querySelector('#skills-detail .ide-message').textContent.includes('第 2 行')")
  await evaluate("document.querySelector('#skills-detail [data-save-json]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='保存失败'")
  assert.equal(JSON.parse(fs.readFileSync(skillFile,'utf8')).code, formatted)
  assert.ok((await draftCode('skills','code')).includes('broken'))
  await evaluate("document.querySelector('#skills-detail [data-reset-document]').click()")
  await openCode('rules', existingRule.id)
  assert.ok((await evaluate("document.querySelector('#rules-detail .ide-entry').textContent")).includes('直接写语句'))
  const ruleBody = 'const amount=1; // 恢复数值\nreturn {success:true,amount};'
  await pasteCode('#rules-detail .cm-content', ruleBody)
  await clickButton('#rules-detail .ide-toolbar', '格式化')
  await until("document.querySelector('#rules-detail .ide-message').textContent.includes('已按')")
  const formattedRule = await draftCode('rules','skillCode')
  assert.ok(!formattedRule.includes('function execute'))
  await evaluate("document.querySelector('#rules-detail [data-editor-mode=json]').click()")
  assert.equal(await draftCode('rules','skillCode'), formattedRule)
  await evaluate("document.querySelector('#rules-detail [data-editor-mode=code]').click(); document.querySelector('#rules-detail [data-save-json]').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]').textContent==='已保存'")
  assert.equal(JSON.parse(fs.readFileSync(ruleFile,'utf8')).skillCode, formattedRule)
  assert.deepEqual(JSON.parse(fs.readFileSync(ruleFile,'utf8')).trigger, existingRule.trigger)
  // Filesystem reader is tested separately; here use a deterministic native-picker result.
  await evaluate(`window.ideFixture={code:'function executeSkill(){return 1;}'};window.ideImportHost=document.createElement('div');ideImportHost.id='ide-fixture';document.querySelector('#rules-detail').prepend(ideImportHost);window.ideFixtureController=ContentCodeIDE.mount(ideImportHost,{category:'skills',primaryField:'code',filename:'fixture.json',getDraft:()=>ideFixture,onChange:value=>{ideFixture=value},save:()=>{},importCode:async()=>[{name:'AI-output.js',source:'function executeSkill(){return 2;}'},{name:'rule.txt',source:'return {success:true};'}]})`)
  await clickButton('#ide-fixture .ide-toolbar', '导入文件夹')
  await until("!document.querySelector('#ide-fixture .ide-imports').hidden")
  assert.equal(await evaluate('ideFixture.code'),'function executeSkill(){return 1;}')
  assert.ok((await evaluate("document.querySelector('#ide-fixture .ide-import-target').textContent")).includes('fixture.json → code'))
  await clickButton('#ide-fixture .ide-imports', '替换当前入口的草稿')
  assert.equal(await evaluate('ideFixture.code'),'function executeSkill(){return 2;}')
  await clickButton('#ide-fixture .ide-toolbar', '撤销')
  assert.equal(await evaluate('ideFixture.code'),'function executeSkill(){return 1;}')
  await evaluate('ideFixtureController.setLocked(true)')
  assert.equal(await evaluate("document.querySelector('#ide-fixture .cm-content').getAttribute('contenteditable')"),'false')
  await evaluate('ideFixtureController.destroy();ideImportHost.remove()')
  fs.writeFileSync(ruleFile,JSON.stringify({...JSON.parse(fs.readFileSync(ruleFile,'utf8')),name:'外部更新'}))
  await pasteCode('#rules-detail .cm-content',ruleBody+'\n// new draft')
  await evaluate("document.querySelector('#rules-detail [data-save-json]').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]').textContent==='保存失败'")
  assert.equal(JSON.parse(fs.readFileSync(ruleFile,'utf8')).name,'外部更新')
  const packaged = await evaluate(`(async()=>{const id=${JSON.stringify(packSmokeTask.task.id)};const draft=await editorAPI.workbenchInspect(id);const accepted=await editorAPI.workbenchAccept(id,{paths:draft.changes.map(c=>c.path),expectedHash:draft.contentHash,expectedAcceptedHash:draft.acceptedHash});return editorAPI.workbenchExport(id,accepted.acceptedHash,'IDE 打包实测')})()`)
  assert.equal(packaged.published, false)
  const AdmZip = require('adm-zip'), archive = new AdmZip(packaged.path)
  assert.equal(JSON.parse(archive.readAsText('data/skills/graph-demo.json')).code, JSON.parse(fs.readFileSync(skillFile,'utf8')).code)
  assert.equal(JSON.parse(archive.readAsText('data/rules/rule-naruto-sage-tick.json')).skillCode, formattedRule)
  const report={ok:true,checks:['real Electron paste/format/undo/redo','Ctrl+S saves embedded JSON; reload preserves escapes/comments and unknown fields','syntax error preserves file and draft','rule body uses skillCode and synchronizes JSON/code modes','import preview and explicit target; undo import (deterministic picker fixture)','save lock makes code read-only','external revision conflict preserved','accepted JSON skill/rule code exported through real editor IPC and utility worker'],archiveBytes:fs.statSync(packaged.path).size,screenshot:'builtin-code-ide.png'}
  fs.writeFileSync(path.join(evidence,'smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
} finally {socket?.close();child.kill()}
