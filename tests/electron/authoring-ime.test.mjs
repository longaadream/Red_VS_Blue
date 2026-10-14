import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/*
 * CompositionEvent/InputEvent coverage for the production authoring widgets.
 * Chromium can deliver these DOM events deterministically, but this does not
 * emulate the Windows IME candidate engine or its native keyboard driver.
 */
const require = createRequire(import.meta.url)
const root = process.cwd()
const evidence = path.resolve(process.env.RVB_UNIFIED_STATEMENTS_EVIDENCE_DIR || path.join(root, 'docs/qa/completion-unified-statements-smoke'))
fs.mkdirSync(evidence, { recursive: true })
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-authoring-ime-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const skillId = 'authoring-ime-regression'
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([skillId]) + '\n')
fs.writeFileSync(path.join(project, 'data/skills', skillId + '.json'), JSON.stringify({
  id: skillId,
  name: '输入法回归',
  description: '测试编辑器组合输入',
  kind: 'active',
  type: 'normal',
  code: 'function executeSkill(context){ return { success: true }; }',
}, null, 2) + '\n')
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, args.concat([
  '--user-data-dir=' + userData,
  '--remote-debugging-port=' + port,
  '--editor-smoke-hidden',
]), {
  env,
  windowsHide: true,
  stdio: 'ignore',
})

let socket
let sequence = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function findAuthorStatement(value) {
  if (!value || typeof value !== 'object') return null
  if (value.layout?.authorStatement?.kind === 'extension-declaration') return value.layout.authorStatement
  for (const child of Object.values(value)) {
    const found = findAuthorStatement(child)
    if (found) return found
  }
  return null
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++sequence
    const timer = setTimeout(() => {
      socket?.removeEventListener('message', onMessage)
      reject(new Error('CDP timeout: ' + method))
    }, 30000)
    const onMessage = event => {
      const result = JSON.parse(event.data)
      if (result.id !== requestId) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      if (result.error) reject(new Error(JSON.stringify(result.error)))
      else resolve(result.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if (await evaluate(expression)) return
    } catch {
      // The renderer can be between route and editor mounts.
    }
    await delay(100)
  }
  throw new Error('UI condition timed out: ' + expression)
}

async function click(selector) {
  await evaluate('(()=>{const element=document.querySelector(' + JSON.stringify(selector) + ');if(!element)throw new Error(' + JSON.stringify('missing ' + selector) + ');element.click()})()')
  await delay(80)
}

try {
  let target
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) })).json()
      target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch {
      // Electron is still starting.
    }
    await delay(100)
  }
  if (!target) throw new Error('Editor startup timed out')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  await until("document.body.classList.contains('studio-surface') && Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate('(()=>{\n' +
    "document.querySelector('[data-tab=skills]').click()\n" +
    'const item=[...document.querySelectorAll("#skills-list .entity-item")].find(node=>node.dataset.entityId===' + JSON.stringify(skillId) + ' || node.querySelector(".id")?.textContent===' + JSON.stringify(skillId) + ')\n' +
    "if(!item)throw new Error('missing regression skill')\n" +
    'item.click()\n' +
  '})()')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))")

  // The module catalogue search used to replace its focused input for every
  // composition input, making Chinese entry appear frozen after one syllable.
  await click('#skills-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-module-search]'))")
  const moduleComposition = await evaluate(`(async()=>{
    const selector='[data-sentence-module-search]'
    const input=document.querySelector(selector)
    const fireInput=data=>input.dispatchEvent(new InputEvent('input',{bubbles:true,data,inputType:'insertCompositionText',isComposing:true}))
    input.focus()
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    input.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'中'}))
    input.value='中'; fireInput('中')
    const first={same:document.querySelector(selector)===input,connected:input.isConnected,value:input.value}
    input.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'中文'}))
    input.value='中文'; fireInput('文')
    const second={same:document.querySelector(selector)===input,connected:input.isConnected,value:input.value}
    input.setSelectionRange(2,2)
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}))
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,30))
    const settled=document.querySelector(selector)
    return {first,second,settledConnected:settled?.isConnected===true,settledValue:settled?.value||'',settledReplaced:settled!==input,settledFocused:document.activeElement===settled,selection:[settled?.selectionStart,settled?.selectionEnd]}
  })()`)
  assert.deepEqual(moduleComposition.first, { same: true, connected: true, value: '中' })
  assert.deepEqual(moduleComposition.second, { same: true, connected: true, value: '中文' })
  assert.equal(moduleComposition.settledConnected, true)
  assert.equal(moduleComposition.settledValue, '中文')
  assert.equal(moduleComposition.settledReplaced, true, 'compositionend flushes the queued picker render')
  assert.equal(moduleComposition.settledFocused, true, 'module search keeps focus after compositionend')
  assert.deepEqual(moduleComposition.selection, [2, 2], 'module search keeps the IME caret after compositionend')

  // Mount the same production expression widget in the live Electron page so
  // Enter/Tab, suggestion requests, punctuation folding, and the expanded
  // editor all share one composition lifecycle.
  const expressionComposition = await evaluate(`(async()=>{
    const host=document.createElement('div')
    host.dataset.imeRegressionHost=''
    document.body.append(host)
    const stats={changes:[],suggestions:0,expanded:false}
    const widget=window.ExpressionInput.mount(host,{
      value:'',
      getSuggestions:()=>{stats.suggestions+=1;return [{value:'候选',label:'候选'}]},
      onChange:value=>stats.changes.push(value),
      onExpand:()=>{stats.expanded=true;host.classList.add('sentence-author-expression-expanded')},
    })
    const editor=host.querySelector('.ei-editor')
    editor.focus()
    stats.changes.length=0; stats.suggestions=0
    editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    for(const [value,data] of [['拼','拼'],['拼音','音']]){
      editor.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:value}))
      editor.textContent=value
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,data,inputType:'insertCompositionText',isComposing:true}))
    }
    const enter=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:229,isComposing:true})
    const tab=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Tab',code:'Tab',keyCode:9,isComposing:true})
    const escape=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',keyCode:229,isComposing:true})
    editor.dispatchEvent(enter); editor.dispatchEvent(tab); editor.dispatchEvent(escape)
    const during={same:host.querySelector('.ei-editor')===editor,connected:editor.isConnected,changes:stats.changes.length,suggestions:stats.suggestions,enterPrevented:enter.defaultPrevented,tabPrevented:tab.defaultPrevented,escapePrevented:escape.defaultPrevented}
    editor.textContent='当前玩家。'
    editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'当前玩家。'}))
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:'当前玩家。',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,30))
    const afterComposition={same:host.querySelector('.ei-editor')===editor,connected:editor.isConnected,text:widget.getText(),changes:stats.changes.length,suggestions:stats.suggestions}
    host.querySelector('.ei-expand').click()
    const expandedEditor=host.querySelector('.ei-editor')
    expandedEditor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    expandedEditor.textContent='当前玩家。动量'
    expandedEditor.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'当前玩家。动量'}))
    expandedEditor.dispatchEvent(new InputEvent('input',{bubbles:true,data:'动量',inputType:'insertCompositionText',isComposing:true}))
    const expandedDuring={same:host.querySelector('.ei-editor')===expandedEditor,connected:expandedEditor.isConnected,expanded:stats.expanded,changes:stats.changes.length}
    expandedEditor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'当前玩家。动量'}))
    await new Promise(resolve=>setTimeout(resolve,30))
    expandedEditor.focus()
    expandedEditor.textContent='候'
    expandedEditor.dispatchEvent(new InputEvent('input',{bubbles:true,data:'候',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,10))
    const normalTab=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Tab',code:'Tab',keyCode:9,isComposing:false})
    expandedEditor.dispatchEvent(normalTab)
    const afterExpanded={same:host.querySelector('.ei-editor')===expandedEditor,connected:expandedEditor.isConnected,text:widget.getText(),normalTabPrevented:normalTab.defaultPrevented,changes:stats.changes.length}
    widget.destroy(); host.remove()
    return {during,afterComposition,expandedDuring,afterExpanded}
  })()`)
  assert.deepEqual(expressionComposition.during, {
    same: true,
    connected: true,
    changes: 0,
    suggestions: 0,
    enterPrevented: false,
    tabPrevented: false,
    escapePrevented: false,
  })
  assert.equal(expressionComposition.afterComposition.connected, true)
  assert.equal(expressionComposition.afterComposition.text, '当前玩家.')
  assert.equal(expressionComposition.afterComposition.changes, 1)
  assert.ok(expressionComposition.afterComposition.suggestions > 0, 'suggestions resume after compositionend')
  assert.deepEqual(expressionComposition.expandedDuring, {
    same: true,
    connected: true,
    expanded: true,
    changes: 1,
  })
  assert.equal(expressionComposition.afterExpanded.connected, true)
  assert.equal(expressionComposition.afterExpanded.normalTabPrevented, true, 'non-IME Tab completion remains active')
  assert.ok(expressionComposition.afterExpanded.changes >= 2)

  // Exercise the unified declaration entry in the real sentence editor. The
  // Chinese name and initial expression must survive a parent refresh while
  // composing, then survive lowering, save, and a fresh inspector mount.
  await evaluate(`(()=>{
    const search=document.querySelector('#skills-detail [data-sentence-module-search]')
    if(!search)throw new Error('missing unified statement picker')
    search.value=''
    search.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-module=\\\"author.extension.declare\\\"]'))")
  const paletteScreenshot = await call('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(evidence, 'unified-statement-palette.png'), Buffer.from(paletteScreenshot.data, 'base64'))
  await click('#skills-detail [data-sentence-module="author.extension.declare"]')
  await until("Boolean(document.querySelector('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement]'))")
  const declarationIme = await evaluate(`(async()=>{
    const panel=document.querySelector('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement]')
    const type=panel?.querySelector('[data-sentence-author-value-type] [data-sentence-type-kind]')
    if(!panel||!type)throw new Error('missing unified declaration controls')
    type.value='string'; type.dispatchEvent(new Event('change',{bubbles:true}))
    const compose=(editor,value,data)=>{
      editor.focus()
      editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
      editor.textContent=value
      editor.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:value}))
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:data||value,inputType:'insertCompositionText',isComposing:true}))
    }
    const refreshParents=()=>{
      const detail=document.querySelector('#skills-detail')
      let count=0
      for(const owner of detail?.skillClusterEditors||[]) if(typeof owner.refresh==='function'){ count+=1; owner.refresh() }
      return count
    }
    const nameHost=panel.querySelector('[data-sentence-author-field="name"]')
    const nameEditor=nameHost?.querySelector('.ei-editor')
    if(!nameEditor)throw new Error('missing unified declaration name input')
    compose(nameEditor,'中文变量','变量')
    const compositionEscape=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',keyCode:229,isComposing:true})
    nameEditor.dispatchEvent(compositionEscape)
    const nameDuring={connected:nameEditor.isConnected,same:nameHost.querySelector('.ei-editor')===nameEditor,escapePrevented:compositionEscape.defaultPrevented}
    const parentRefreshes=refreshParents()
    const nameQueued={connected:nameEditor.isConnected,same:nameHost.querySelector('.ei-editor')===nameEditor,pendingRefreshes:parentRefreshes}
    nameEditor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文变量'}))
    nameEditor.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文变量',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,50))
    const namePanel=document.querySelector('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement]')
    const settledNameEditor=namePanel?.querySelector('[data-sentence-author-field="name"] .ei-editor')
    const nameSettled={connected:Boolean(settledNameEditor?.isConnected),text:settledNameEditor?.textContent||'',applyDisabled:namePanel?.querySelector('[data-sentence-author-apply]')?.disabled??null}

    const initialHost=namePanel?.querySelector('[data-sentence-author-field="initialSource"]')
    const initialEditor=initialHost?.querySelector('.ei-editor')
    if(!initialEditor)throw new Error('missing unified declaration initial input')
    compose(initialEditor,'"中文初始值"','中文初始值')
    const initialEscape=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',keyCode:229,isComposing:true})
    initialEditor.dispatchEvent(initialEscape)
    const initialDuring={connected:initialEditor.isConnected,same:initialHost.querySelector('.ei-editor')===initialEditor,escapePrevented:initialEscape.defaultPrevented}
    initialEditor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'"中文初始值"'}))
    initialEditor.dispatchEvent(new InputEvent('input',{bubbles:true,data:'"中文初始值"',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,50))
    const settledPanel=document.querySelector('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement]')
    const settledName=settledPanel?.querySelector('[data-sentence-author-field="name"] .ei-editor')
    const settledInitial=settledPanel?.querySelector('[data-sentence-author-field="initialSource"] .ei-editor')
    const settled={name:settledName?.textContent||'',initial:settledInitial?.textContent||'',type:settledPanel?.querySelector('[data-sentence-author-value-type] [data-sentence-type-kind]')?.value||'',applyDisabled:settledPanel?.querySelector('[data-sentence-author-apply]')?.disabled??null}
    return {nameDuring,nameQueued,nameSettled,initialDuring,settled}
  })()`)
  assert.deepEqual(declarationIme.nameDuring, { connected: true, same: true, escapePrevented: false })
  assert.equal(declarationIme.nameQueued.connected, true, 'parent refresh stays queued during name composition')
  assert.equal(declarationIme.nameQueued.same, true, 'parent refresh does not replace the composing name input')
  assert.ok(declarationIme.nameQueued.pendingRefreshes > 0, 'test exercised the mounted parent refresh path')
  assert.deepEqual(declarationIme.nameSettled, { connected: true, text: '中文变量', applyDisabled: false })
  assert.deepEqual(declarationIme.initialDuring, { connected: true, same: true, escapePrevented: false })
  assert.deepEqual(declarationIme.settled, { name: '中文变量', initial: '"中文初始值"', type: 'string', applyDisabled: false })

  await click('#skills-detail [data-sentence-author-apply]')
  await delay(80)
  const appliedDeclaration = await evaluate(`(()=>{
    const find=value=>{
      if(!value||typeof value!=='object')return null
      if(value.layout?.authorStatement?.kind==='extension-declaration')return value.layout.authorStatement
      for(const child of Object.values(value)){const found=find(child);if(found)return found}
      return null
    }
    return find(JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}'))
  })()`)
  assert.equal(appliedDeclaration?.name, '中文变量')
  assert.equal(appliedDeclaration?.valueType, 'string')
  assert.equal(appliedDeclaration?.initialSource, '"中文初始值"')

  await until("document.querySelector('#skills-detail [data-save-json]').disabled===false")
  await click('#skills-detail [data-save-json]')
  let persistedDeclaration = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { persistedDeclaration = findAuthorStatement(JSON.parse(fs.readFileSync(path.join(project, 'data/skills', skillId + '.json'), 'utf8'))) } catch { /* save is still in flight */ }
    if (persistedDeclaration?.name === '中文变量' && persistedDeclaration?.initialSource === '"中文初始值"') break
    await delay(100)
  }
  assert.equal(persistedDeclaration?.name, '中文变量')
  assert.equal(persistedDeclaration?.valueType, 'string')
  assert.equal(persistedDeclaration?.initialSource, '"中文初始值"')

  await click('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement] .sentence-popover-close')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node][data-sentence-author-statement]'))")
  const reopenedDeclaration = await evaluate(`(async()=>{
    const row=document.querySelector('#skills-detail [data-sentence-node][data-sentence-author-statement]')
    row?.querySelector('[data-sentence-module-editor]')?.click()
    await new Promise(resolve=>setTimeout(resolve,40))
    const panel=document.querySelector('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement]')
    const name=panel?.querySelector('[data-sentence-author-field="name"] .ei-editor')
    const initial=panel?.querySelector('[data-sentence-author-field="initialSource"] .ei-editor')
    const type=panel?.querySelector('[data-sentence-author-value-type] [data-sentence-type-kind]')
    return {name:name?.textContent||'',initial:initial?.textContent||'',type:type?.value||'',applyDisabled:panel?.querySelector('[data-sentence-author-apply]')?.disabled??null}
  })()`)
  assert.deepEqual(reopenedDeclaration, { name: '中文变量', initial: '"中文初始值"', type: 'string', applyDisabled: true })
  const normalEscape = await evaluate(`(()=>{
    const panel=document.querySelector('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement]')
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',keyCode:27,isComposing:false})
    panel?.dispatchEvent(event)
    return {prevented:event.defaultPrevented,closed:!document.querySelector('#skills-detail .sentence-author-statement-editor[data-sentence-author-statement]')}
  })()`)
  assert.deepEqual(normalEscape, { prevented: true, closed: true }, 'normal Escape still closes the statement inspector')
  const statementScreenshot = await call('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(evidence, 'unified-extension-statement.png'), Buffer.from(statementScreenshot.data, 'base64'))
} finally {
  socket?.close()
  if (child.exitCode === null) child.kill()
}

console.log('authoring-ime: passed')
