import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

// Focused real-Electron coverage for the explicit result binding control. DOM
// composition events are deterministic here; this does not drive the native
// Windows IME candidate window.
const require = createRequire(import.meta.url)
const root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const gameplayCore = require(path.join(root, 'electron-editor/dist/gameplay-module-core.cjs'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-result-binding-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const skillId = 'result-binding-regression'
const cardId = 'result-binding-card-regression'
const producer = {
  kind: 'call',
  id: 'compare-result',
  module: 'compare.equal-string',
  version: '1',
  inputs: { left: { kind: 'literal', value: '甲' }, right: { kind: 'literal', value: '甲' } },
  parameters: {},
}
const legacyProducer = {
  kind: 'call',
  id: 'legacy-result',
  module: 'compare.equal-string',
  version: '1',
  inputs: { left: { kind: 'literal', value: '旧' }, right: { kind: 'literal', value: '旧' } },
  parameters: {},
  layout: { resultNames: { value: '原别名' } },
}
const staleBindingProducer = {
  kind: 'call',
  id: 'stale-binding-result',
  module: 'compare.equal-string',
  version: '1',
  inputs: { left: { kind: 'literal', value: '陈' }, right: { kind: 'literal', value: '陈' } },
  parameters: {},
  // This link names a removed declaration. It must not reserve the name for
  // a new binding elsewhere in the graph.
  layout: { resultVariables: { value: { name: '空缺', declarationId: 'removed-result-declaration', valueType: 'boolean' } } },
}
const declarationId = 'compare-result_value_result-1'
const multiOutputProducer = {
  kind: 'call', id: 'multiple-result', module: 'author.card.gain', version: '1',
  inputs: { player: { kind: 'output', node: 'fixture-player', port: 'player' }, card: { kind: 'output', node: 'fixture-card', port: 'card' } }, parameters: { extensionType: 'record' },
  layout: { resultVariables: { success: { name: '复用', declarationId: 'removed-output-variable', valueType: 'boolean' } } },
}
const writer = {
  kind: 'call',
  id: 'write-target',
  module: 'local.write',
  version: '1',
  inputs: {
    handle: { kind: 'output', node: declarationId, port: 'handle' },
    value: { kind: 'literal', value: false },
  },
  parameters: { valueType: 'boolean' },
}
const reader = {
  kind: 'call',
  id: 'read-target',
  module: 'local.read',
  version: '1',
  inputs: { handle: { kind: 'output', node: declarationId, port: 'handle' } },
  parameters: { valueType: 'boolean' },
}
const terminal = {
  kind: 'return',
  id: 'return-result',
  values: { value: { kind: 'output', node: 'read-target', port: 'value' } },
}
const graph = {
  version: 'rvb-gameplay-modules/v1',
  surface: 'skill',
  body: [producer, writer, reader, legacyProducer, staleBindingProducer,
    { kind: 'call', id: 'fixture-player', module: 'ref.player', version: '1', inputs: {}, parameters: {} },
    { kind: 'call', id: 'fixture-card', module: 'ref.card-definition', version: '1', inputs: {}, parameters: { cardId } },
    multiOutputProducer, terminal],
  inputs: [],
  outputs: [{ name: 'value', type: 'boolean' }],
  composites: [],
  continuations: [],
}
const cardGraph = {
  version: 'rvb-gameplay-modules/v1',
  surface: 'card',
  body: [
    {
      kind: 'call',
      id: 'current-hand',
      module: 'ref.current-card',
      version: '1',
      inputs: {},
      parameters: {},
    },
    {
      kind: 'return',
      id: 'card-return',
      values: { value: { kind: 'literal', value: true } },
    },
  ],
  inputs: [],
  outputs: [{ name: 'value', type: 'boolean' }],
  composites: [],
  continuations: [],
}
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([skillId]) + '\n')
fs.writeFileSync(path.join(project, 'data/cards/manifest.json'), JSON.stringify([cardId]) + '\n')
fs.writeFileSync(path.join(project, 'data/skills', skillId + '.json'), JSON.stringify({
  id: skillId,
  name: '返回值绑定回归',
  description: '测试显式保存返回值',
  kind: 'active',
  type: 'normal',
  code: '',
  gameplayModules: {
    version: 'rvb-gameplay-module-document/v1',
    entries: { code: { graph, compilerVersion: 'rvb-gameplay-module-compiler/v3' } },
  },
}, null, 2) + '\n')
fs.writeFileSync(path.join(project, 'data/cards', cardId + '.json'), JSON.stringify({
  id: cardId,
  name: '当前手牌返回值绑定回归',
  description: '验证当前手牌输出可以保存为局部变量并供统一扩展语句使用。',
  type: 'active',
  code: '',
  gameplayModules: {
    version: 'rvb-gameplay-module-document/v1',
    entries: { code: { graph: cardGraph, compilerVersion: 'rvb-gameplay-module-compiler/v3' } },
  },
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
]), { env, windowsHide: true, stdio: 'ignore' })

let socket
let sequence = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
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
    } catch { /* renderer is still mounting */ }
    await delay(100)
  }
  throw new Error('UI condition timed out: ' + expression)
}
async function click(selector) {
  await evaluate('(()=>{const element=document.querySelector(' + JSON.stringify(selector) + ');if(!element)throw new Error(' + JSON.stringify('missing ' + selector) + ');element.click()})()')
  await delay(80)
}
async function setAuthorEditor(rootSelector, field, value) {
  const editorSelector = `${rootSelector} [data-sentence-author-field="${field}"] .ei-editor`
  await evaluate(`(()=>{
    const editor=document.querySelector(${JSON.stringify(editorSelector)})
    if(!editor)throw new Error('missing author expression editor: '+${JSON.stringify(field)})
    editor.focus()
    editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    editor.textContent=${JSON.stringify(value)}
    editor.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:${JSON.stringify(value)}}))
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(value)},inputType:'insertCompositionText',isComposing:true}))
    editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:${JSON.stringify(value)}}))
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,data:${JSON.stringify(value)},inputType:'insertText',isComposing:false}))
  })()`)
  await delay(80)
}

try {
  let target
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) })).json()
      target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch { /* Electron is still starting */ }
    await delay(100)
  }
  if (!target) throw new Error('Editor startup timed out')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await until("document.body.classList.contains('studio-surface') && Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate('(()=>{document.querySelector(\'[data-tab=skills]\').click();const item=[...document.querySelectorAll("#skills-list .entity-item")].find(node=>node.dataset.entityId===' + JSON.stringify(skillId) + ');if(!item)throw new Error(\'missing result binding skill\');item.click()})()')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\"compare-result\"]'))")

  const buttonState = await evaluate(`(()=>{
    const row=document.querySelector('#skills-detail [data-sentence-node="compare-result"]')
    const button=row?.querySelector('[data-sentence-save-result="compare-result:value"]')
    return {visible:Boolean(button),disabled:Boolean(button?.disabled),text:button?.textContent||'',legacy:Boolean(row?.querySelector('.sentence-result-legacy'))}
  })()`)
  assert.deepEqual(buttonState, { visible: true, disabled: false, text: '保存返回值', legacy: false })
  await click('#skills-detail [data-sentence-save-result="compare-result:value"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-editor=\"compare-result:value\"] input[data-sentence-result-variable-name]'))")

  const composition = await evaluate(`(async()=>{
    const input=document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')
    input.focus()
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    input.value='目标'
    input.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'目标'}))
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertCompositionText',isComposing:true}))
    const during={connected:input.isConnected,same:document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')===input,value:input.value,focused:document.activeElement===input}
    const enter=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:229,isComposing:true})
    input.dispatchEvent(enter)
    const composingEnter={prevented:enter.defaultPrevented,editorStillOpen:!document.querySelector('[data-sentence-result-variable-editor="compare-result:value"]').hidden}
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'目标'}))
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,30))
    const settled=document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')
    const secondInput=settled
    secondInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))
    secondInput.value='目标'
    secondInput.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'目标'}))
    secondInput.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertCompositionText',isComposing:true}))
    secondInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'目标'}))
    secondInput.dispatchEvent(new InputEvent('input',{bubbles:true,data:'目标',inputType:'insertText',isComposing:false}))
    await new Promise(resolve=>setTimeout(resolve,30))
    const secondSettled=document.querySelector('#skills-detail [data-sentence-result-variable-name="compare-result:value"]')
    return {during,composingEnter,settled:{connected:settled?.isConnected===true,value:settled?.value||'',focused:document.activeElement===settled},second:{same:secondSettled===secondInput,value:secondSettled?.value||'',focused:document.activeElement===secondSettled}}
  })()`)
  assert.deepEqual(composition.during, { connected: true, same: true, value: '目标', focused: true })
  assert.deepEqual(composition.composingEnter, { prevented: false, editorStillOpen: true })
  assert.deepEqual(composition.settled, { connected: true, value: '目标', focused: true })
  assert.deepEqual(composition.second, { same: true, value: '目标', focused: true })

  await click('#skills-detail [data-sentence-result-variable-apply="compare-result:value"]')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body[1]?.module==='local.declare'")
  const persisted = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules?.entries?.code?.graph?.body||[]
    const index=body.findIndex(item=>item?.id==='compare-result')
    const declaration=body[index+1]
    return {index,declaration,link:body[index]?.layout?.resultVariables?.value,visible:document.querySelector('#skills-detail')?.innerText?.includes('变量目标')===true}
  })()`)
  assert.equal(persisted.index, 0)
  assert.equal(persisted.declaration?.module, 'local.declare')
  assert.equal(String(persisted.declaration?.version), '2')
  assert.equal(persisted.declaration?.parameters?.name, '目标')
  assert.equal(persisted.declaration?.parameters?.valueType, 'boolean')
  assert.deepEqual(persisted.declaration?.inputs?.initial, { kind: 'output', node: 'compare-result', port: 'value' })
  const persistedWriter = persisted.declaration && (await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.write'))()`))
  const persistedReader = persisted.declaration && (await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.read'))()`))
  assert.deepEqual(persistedWriter?.inputs?.handle, { kind: 'output', node: persisted.declaration.id, port: 'handle' })
  assert.deepEqual(persistedReader?.inputs?.handle, { kind: 'output', node: persisted.declaration.id, port: 'handle' })
  assert.deepEqual(persistedWriter?.inputs?.value, { kind: 'literal', value: false })
  const persistedReturn = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.kind==='return'))()`)
  assert.deepEqual(persistedReturn?.values?.value, { kind: 'output', node: 'read-target', port: 'value' })
  assert.equal(persisted.link?.name, '目标')
  assert.equal(persisted.link?.declarationId, persisted.declaration?.id)
  assert.equal(persisted.visible, true)

  // A missing declaration behind an old resultVariables link must not reserve
  // the name. Once a real declaration exists, a second producer is rejected;
  // prototype names remain rejected by the local binding validator.
  await click('#skills-detail [data-sentence-save-result="legacy-result:value"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-editor=\"legacy-result:value\"] input[data-sentence-result-variable-name]'))")
  await evaluate(`(()=>{
    const editor=document.querySelector('[data-sentence-result-variable-editor="legacy-result:value"]')
    const input=editor?.querySelector('[data-sentence-result-variable-name]')
    const apply=editor?.querySelector('[data-sentence-result-variable-apply]')
    if(!input||!apply) throw new Error('missing legacy result binding controls')
    input.value='空缺'; input.dispatchEvent(new Event('input',{bubbles:true})); apply.click()
  })()`)
  await delay(80)
  const legacyBindingCheck = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const legacy=body.find(item=>item?.id==='legacy-result')
    const declaration=body.find(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='legacy-result')
    return {ok:true,legacyLink:legacy?.layout?.resultVariables,declaration}
  })()`)
  assert.equal(legacyBindingCheck.ok, true)
  assert.equal(legacyBindingCheck.legacyLink?.value?.name, '空缺')
  assert.equal(legacyBindingCheck.declaration?.parameters?.name, '空缺')

  await click('#skills-detail [data-sentence-save-result="stale-binding-result:value"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-editor=\"stale-binding-result:value\"] input[data-sentence-result-variable-name]'))")
  await evaluate(`(()=>{
    const editor=document.querySelector('[data-sentence-result-variable-editor="stale-binding-result:value"]')
    const input=editor?.querySelector('[data-sentence-result-variable-name]')
    const apply=editor?.querySelector('[data-sentence-result-variable-apply]')
    if(!input||!apply) throw new Error('missing stale result binding controls')
    input.value='空缺'; input.dispatchEvent(new Event('input',{bubbles:true})); apply.click()
  })()`)
  await delay(80)
  const staleBindingCheck = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    return {
      staleLink:body.find(item=>item?.id==='stale-binding-result')?.layout?.resultVariables?.value,
      declaration:body.find(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='stale-binding-result'),
    }
  })()`)
  assert.equal(staleBindingCheck.staleLink?.declarationId, 'removed-result-declaration')
  assert.equal(staleBindingCheck.declaration, undefined)
  await click('#skills-detail [data-sentence-result-variable-editor="stale-binding-result:value"] .sentence-result-cancel')
  await click('#skills-detail [data-sentence-result-variable-editor="legacy-result:value"] .sentence-result-cancel')

  // A stale link on another port of the same producer also releases its name.
  await click('#skills-detail [data-sentence-save-result="multiple-result:placement"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-result-variable-name=\"multiple-result:placement\"]'))")
  await evaluate(`(()=>{
    const input=document.querySelector('#skills-detail [data-sentence-result-variable-name="multiple-result:placement"]');
    input.value='复用';input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await click('#skills-detail [data-sentence-result-variable-apply="multiple-result:placement"]')
  const reusedPort = await evaluate(`(()=>{
    const graph=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph;
    return graph.body.find(item=>item?.module==='local.declare'&&item?.parameters?.name==='复用');
  })()`)
  assert.equal(reusedPort?.inputs?.initial?.node, 'multiple-result')
  assert.equal(reusedPort?.inputs?.initial?.port, 'placement')

  // A legacy resultNames edit remains available and still writes its metadata.
  const legacy = await evaluate(`(()=>{
    const input=document.querySelector('#skills-detail [data-sentence-node="legacy-result"] .sentence-result-legacy input')
    if(!input) return false
    input.value='旧别名'; input.dispatchEvent(new Event('change',{bubbles:true})); return true
  })()`)
  assert.equal(legacy, true)
  await delay(80)
  const legacyValue = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.id==='legacy-result').layout.resultNames.value)()`)
  assert.equal(legacyValue, '旧别名')
  await until("Boolean(document.querySelector('#skills-detail [data-save-json]'))")
  await until("document.querySelector('#studio-save')?.disabled===false")
  await click('#studio-save')
  let saved = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const documentValue = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', skillId + '.json'), 'utf8'))
      const body = documentValue.gameplayModules?.entries?.code?.graph?.body || []
      const fresh = body.find(item => item?.id === 'compare-result')
      const legacy = body.find(item => item?.id === 'legacy-result')
      saved = { declaration: body[body.findIndex(item => item?.id === 'compare-result') + 1], resultVariables: fresh?.layout?.resultVariables, resultNames: legacy?.layout?.resultNames, ids: body.map(item => `${item?.id}:${item?.module || item?.kind}`) }
    } catch { /* save is still in flight */ }
    if (saved?.declaration?.parameters?.name === '目标' && saved.resultNames?.value === '旧别名') break
    await delay(100)
  }
  if (saved?.declaration?.module !== 'local.declare') {
    const diagnostics = await evaluate(`(()=>({
      toast:[...document.querySelectorAll('.toast')].map(item=>item.textContent),
      issues:[...document.querySelectorAll('#skills-detail .error,#skills-detail .validation-error,#skills-detail .diagnostic')].map(item=>item.textContent),
      saveDisabled:document.querySelector('#studio-save')?.disabled,
      body:JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules?.entries?.code?.graph?.body?.map(item=>({id:item.id,module:item.module})),
    }))()`)
    throw new Error('result binding persistence failed: '+JSON.stringify(diagnostics))
  }
  assert.equal(saved?.declaration?.module, 'local.declare')
  assert.equal(saved?.declaration?.parameters?.name, '目标')
  assert.equal(saved?.resultVariables?.value?.name, '目标')
  assert.equal(saved?.resultNames?.value, '旧别名')

  // Execute the persisted graph with the same local handle protocol used by
  // the runtime. The producer starts true, the explicit local.write changes
  // it to false, and the return reads that changed value through local.read.
  const savedGraph = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', skillId + '.json'), 'utf8')).gameplayModules.entries.code.graph
  const compiled = gameplayCore.compileGameplayModuleGraph(savedGraph, gameplayCore.GAMEPLAY_MODULE_REGISTRY)
  const values = new Map()
  const events = []
  let handleId = 0
  const flow = { refs: { player: () => 'player-red' }, cards: { gain: () => ({ instance: null, success: true, placement: 'hand' }) }, execution: {
    declare(_type, _schemas, initial) {
      const handle = { id: ++handleId }
      values.set(handle, initial)
      events.push(['declare', initial])
      return { handle, success: true }
    },
    write(handle, _type, _schemas, value) {
      values.set(handle, value)
      events.push(['write', value])
      return true
    },
    read(handle) {
      const value = values.get(handle)
      events.push(['read', value])
      return { value, success: true }
    },
  } }
  const execute = new Function('flow', `return (${compiled.code})`)(flow)
  assert.deepEqual(execute({}), { value: false })
  assert.deepEqual(events.slice(0, 3), [['declare', true], ['write', false], ['read', false]])

  // Reopen the same document after persistence; the explicit declaration and
  // both binding representations must remain available to the editor.
  await evaluate(`document.querySelector('#skills-list .entity-item[data-entity-id="${skillId}"]')?.click()`)
  await delay(120)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\"compare-result\"]'))")
  const reopened = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const fresh=body.find(item=>item?.id==='compare-result')
    const legacy=body.find(item=>item?.id==='legacy-result')
    return {declaration:body[body.findIndex(item=>item?.id==='compare-result')+1],resultVariables:fresh?.layout?.resultVariables,resultNames:legacy?.layout?.resultNames}
  })()`)
  assert.equal(reopened.declaration?.module, 'local.declare')
  assert.equal(reopened.declaration?.parameters?.name, '目标')
  assert.equal(reopened.resultVariables?.value?.name, '目标')
  assert.equal(reopened.resultNames?.value, '旧别名')
  const reopenedWriter = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.write'))()`)
  const reopenedReader = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.module==='local.read'))()`)
  assert.deepEqual(reopenedWriter?.inputs?.handle, { kind: 'output', node: reopened.declaration.id, port: 'handle' })
  assert.deepEqual(reopenedReader?.inputs?.handle, { kind: 'output', node: reopened.declaration.id, port: 'handle' })
  assert.deepEqual(reopenedWriter?.inputs?.value, { kind: 'literal', value: false })
  const reopenedReturn = await evaluate(`(()=>JSON.parse(document.querySelector('#skills-detail [data-json-source]').value||'{}').gameplayModules.entries.code.graph.body.find(item=>item?.kind==='return'))()`)
  assert.deepEqual(reopenedReturn?.values?.value, { kind: 'output', node: 'read-target', port: 'value' })
  const boundUi = await evaluate(`(()=>{
    const row=document.querySelector('#skills-detail [data-sentence-node="compare-result"]')
    const button=row?.querySelector('[data-sentence-save-result="compare-result:value"]')
    button?.click()
    const input=row?.querySelector('[data-sentence-result-variable-name="compare-result:value"]')
    const apply=row?.querySelector('[data-sentence-result-variable-apply="compare-result:value"]')
    return {button:button?.textContent||'',readonly:input?.readOnly===true,applyDisabled:apply?.disabled===true,focused:document.activeElement===input}
  })()`)
  assert.deepEqual(boundUi, { button: '查看变量（目标）', readonly: true, applyDisabled: true, focused: true })
  await delay(80)
  assert.equal(await evaluate("document.querySelector('#studio-save')?.disabled"), true, 'read-only result viewer does not mark the document dirty')
  await click('#skills-detail [data-sentence-result-variable-editor="compare-result:value"] .sentence-result-cancel')
  await delay(50)
  assert.equal(await evaluate("document.querySelector('#studio-save')?.disabled"), true, 'closing read-only result viewer keeps the document clean')

  // A card's current-hand reference is a real record result. Save that result
  // as a local handle, then use the same unified extension declaration and
  // assignment inspectors against the local value. This guards the domain
  // propagation path (card-instance -> card extension) in addition to the
  // skill boolean result path above.
  await evaluate("document.querySelector('[data-tab=cards]').click()")
  await until(`Boolean(document.querySelector('#cards-list [data-entity-id=${JSON.stringify(cardId)}]'))`)
  await click(`#cards-list [data-entity-id="${cardId}"]`)
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-node=\"current-hand\"]'))")
  const cardResultButton = await evaluate(`(()=>{
    const row=document.querySelector('#cards-detail [data-sentence-node="current-hand"]')
    const button=row?.querySelector('[data-sentence-save-result="current-hand:card"]')
    return {visible:Boolean(button),disabled:Boolean(button?.disabled),text:button?.textContent||'',legacy:Boolean(row?.querySelector('.sentence-result-legacy'))}
  })()`)
  assert.deepEqual(cardResultButton, { visible: true, disabled: false, text: '保存返回值', legacy: false })
  await click('#cards-detail [data-sentence-save-result="current-hand:card"]')
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-result-variable-editor=\"current-hand:card\"] input[data-sentence-result-variable-name]'))")
  await evaluate(`(()=>{
    const input=document.querySelector('#cards-detail [data-sentence-result-variable-name="current-hand:card"]')
    input.value='手牌变量'
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'手牌变量',inputType:'insertText',isComposing:false}))
  })()`)
  await click('#cards-detail [data-sentence-result-variable-apply="current-hand:card"]')
  await until(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    return Boolean(source.gameplayModules?.entries?.code?.graph?.body?.some(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='current-hand'))
  })()`)
  const cardBinding = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const producer=body.find(item=>item?.id==='current-hand')
    const declaration=body.find(item=>item?.module==='local.declare'&&item?.inputs?.initial?.node==='current-hand')
    return {producer,declaration,link:producer?.layout?.resultVariables?.card}
  })()`)
  assert.equal(cardBinding.declaration?.parameters?.name, '手牌变量')
  assert.equal(cardBinding.declaration?.parameters?.valueType, 'record')
  assert.deepEqual(cardBinding.declaration?.inputs?.initial, { kind: 'output', node: 'current-hand', port: 'card' })
  assert.equal(cardBinding.link?.name, '手牌变量')
  assert.equal(cardBinding.link?.declarationId, cardBinding.declaration?.id)

  await click('#cards-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-module=\"author.extension.declare\"]'))")
  await click('#cards-detail [data-sentence-module="author.extension.declare"]')
  await until("Boolean(document.querySelector('#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'))")
  const cardDeclarationPanel = '#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'
  await setAuthorEditor(cardDeclarationPanel, 'ownerSource', '手牌变量')
  await setAuthorEditor(cardDeclarationPanel, 'name', '护甲')
  await setAuthorEditor(cardDeclarationPanel, 'initialSource', '1')
  await click('#cards-detail [data-sentence-author-apply]')
  await until(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    return Boolean(source.gameplayModules?.entries?.code?.graph?.body?.some(item=>item?.layout?.authorStatement?.kind==='extension-declaration'&&item.layout.authorStatement.name==='护甲'))
  })()`)
  const cardExtension = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const declaration=body.find(item=>item?.module==='local.declare'&&item?.parameters?.name==='手牌变量')
    const statement=body.find(item=>item?.layout?.authorStatement?.kind==='extension-declaration')
    const ownerRead=statement?.inputs?.entity?.kind==='output' ? body.find(item=>item?.id===statement.inputs.entity.node) : null
    return {statement,ownerRead,declaration}
  })()`)
  assert.equal(cardExtension.statement?.module, 'extension.declare-instance')
  assert.equal(cardExtension.statement?.parameters?.entityKind, 'card')
  assert.equal(cardExtension.statement?.parameters?.name, '护甲')
  assert.equal(cardExtension.statement?.parameters?.valueType, 'number')
  assert.equal(cardExtension.statement?.layout?.authorStatement?.ownerSource, '手牌变量')
  assert.deepEqual(cardExtension.ownerRead?.inputs?.handle, { kind: 'output', node: cardExtension.declaration?.id, port: 'handle' })

  await click('#cards-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-module=\"author.assignment\"]'))")
  await click('#cards-detail [data-sentence-module="author.assignment"]')
  await until("Boolean(document.querySelector('#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'))")
  const cardAssignmentPanel = '#cards-detail .sentence-author-statement-editor[data-sentence-author-statement]'
  await setAuthorEditor(cardAssignmentPanel, 'targetSource', '手牌变量.extension.护甲')
  await setAuthorEditor(cardAssignmentPanel, 'valueSource', '2')
  await click('#cards-detail [data-sentence-author-apply]')
  await until(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    return Boolean(source.gameplayModules?.entries?.code?.graph?.body?.some(item=>item?.layout?.authorStatement?.kind==='assignment'&&item.layout.authorStatement.targetSource==='手牌变量.extension.护甲'))
  })()`)
  const cardAssignment = await evaluate(`(()=>{
    const source=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value||'{}')
    const body=source.gameplayModules.entries.code.graph.body||[]
    const statement=body.find(item=>item?.layout?.authorStatement?.kind==='assignment')
    const entityRead=statement?.inputs?.entity?.kind==='output' ? body.find(item=>item?.id===statement.inputs.entity.node) : null
    return {statement,entityRead,body}
  })()`)
  assert.equal(cardAssignment.statement?.module, 'extension.write-instance')
  assert.equal(cardAssignment.statement?.parameters?.entityKind, 'card')
  assert.equal(cardAssignment.statement?.parameters?.name, '护甲')
  assert.equal(cardAssignment.statement?.parameters?.valueType, 'number')
  assert.deepEqual(cardAssignment.statement?.inputs?.value, { kind: 'literal', value: 2 })
  assert.deepEqual(cardAssignment.entityRead?.inputs?.handle, { kind: 'output', node: cardBinding.declaration.id, port: 'handle' })
  assert.equal(cardAssignment.statement?.layout?.authorStatement?.targetSource, '手牌变量.extension.护甲')
  const compiledCard = gameplayCore.compileGameplayModuleGraph(
    { ...cardGraph, body: cardAssignment.body }, gameplayCore.GAMEPLAY_MODULE_REGISTRY,
  )
  assert.match(compiledCard.code, /function executeCard\(/)

  await until("document.querySelector('#studio-save')?.disabled===false")
  await click('#studio-save')
  let savedCard = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { savedCard = JSON.parse(fs.readFileSync(path.join(project, 'data/cards', cardId + '.json'), 'utf8')) } catch { /* save is still in flight */ }
    const savedBody = savedCard?.gameplayModules?.entries?.code?.graph?.body || []
    if (savedBody.some(item => item?.module === 'extension.write-instance' && item?.parameters?.name === '护甲')) break
    await delay(100)
  }
  const savedCardBody = savedCard?.gameplayModules?.entries?.code?.graph?.body || []
  assert.ok(savedCardBody.some(item => item?.module === 'local.declare' && item?.parameters?.name === '手牌变量'))
  assert.ok(savedCardBody.some(item => item?.module === 'extension.declare-instance' && item?.parameters?.name === '护甲'))
  assert.ok(savedCardBody.some(item => item?.module === 'extension.write-instance' && item?.parameters?.name === '护甲'))
} finally {
  socket?.close()
  if (child.exitCode === null) child.kill()
}

console.log('sentence-result-binding: passed')
