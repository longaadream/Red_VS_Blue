import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/*
 * RED-252: real Electron regression for atomic sentence slots.
 *
 * This deliberately mounts the production sentence editor in a hidden
 * Electron renderer and drives its real DOM. The graph fixtures are small,
 * but every call descriptor comes from the renderer's ContentGraphCore
 * catalog. No component or descriptor mock is used here.
 */
const require = createRequire(import.meta.url)
const root = process.cwd()
const evidence = path.resolve(process.env.RVB_SENTENCE_SLOT_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-atomic-authoring/slot-verification'))
fs.mkdirSync(evidence, { recursive: true })

const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-sentence-slot-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'official', root)
const smokeId = 'sentence-slot-smoke'
const smokeFile = path.join(project, 'data', 'skills', `${smokeId}.json`)

// The selected official project is intentionally real even though the test
// mounts a small fixture directly. This keeps startup/content loading on the
// same Electron route as the editor's production UI.
fs.writeFileSync(path.join(project, 'data', 'skills', 'manifest.json'), JSON.stringify([smokeId]) + '\n')
fs.writeFileSync(smokeFile, JSON.stringify({
  id: smokeId,
  name: '句式单槽回归',
  description: 'RED-252 sentence slot regression fixture',
  kind: 'active',
  type: 'normal',
  code: 'function executeSkill(context){ return { success: true }; }',
}, null, 2) + '\n')
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const output = (node, port) => ({ kind: 'output', node, port })
const literal = value => ({ kind: 'literal', value })
const call = (id, module, inputs = {}, parameters = {}) => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const graph = (body, extra = {}) => ({
  version: 'rvb-gameplay-modules/v1',
  surface: 'skill',
  inputs: [],
  outputs: [],
  body,
  composites: [],
  schemas: [],
  continuations: [],
  ...extra,
})

const smokeDocument = (entryGraph, id = smokeId) => ({
  id,
  name: '句式单槽回归',
  description: '自然中文句式与单槽编辑验证',
  kind: 'active',
  type: 'normal',
  code: 'function executeSkill(context){ return { success: true }; }',
  gameplayModules: { version: 'rvb-gameplay-module-document/v1', entries: { code: { graph: entryGraph } } },
})

const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [...args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--editor-smoke-hidden'], { env, windowsHide: true, stdio: 'ignore' })
let startupError
child.on('error', error => { startupError = error })
let socket
let sequence = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function cdpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      socket?.removeEventListener('message', onMessage)
      reject(new Error(`CDP timeout: ${method}`))
    }, 30000)
    const onMessage = event => {
      const result = JSON.parse(event.data)
      if (result.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      if (result.error) reject(new Error(JSON.stringify(result.error)))
      else resolve(result.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await cdpCall('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

const browserQuery = selector => `document.querySelector(${JSON.stringify(selector)})`
const browserHas = selector => `Boolean(${browserQuery(selector)})`

async function until(expression, label = expression) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (startupError) throw startupError
    try { if (await evaluate(expression)) return } catch { /* renderer may still be loading */ }
    await delay(100)
  }
  throw new Error(`UI condition timed out: ${label}`)
}

async function click(selector) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing ${selector}');e.scrollIntoView({block:'center',inline:'nearest'});e.click()})()`)
  await delay(80)
}

async function clickSlot(name, kind) {
  const findSelector = `(()=>{const host=document.querySelector('#slot-verification-host');const node=[...host.querySelectorAll('[data-sentence-slot-editor]')].find(item=>item.dataset.sentenceSlotName===${JSON.stringify(name)} && (!${JSON.stringify(kind)} || item.dataset.sentenceSlotKind===${JSON.stringify(kind)}));return node?.getAttribute('data-sentence-slot-editor')||''})()`
  try {
    await until(`Boolean(${findSelector})`, `slot ${kind || 'any'}:${name}`)
  } catch (error) {
    const diagnostic = await evaluate(`(()=>{const host=document.querySelector('#slot-verification-host');return {requested:{name:${JSON.stringify(name)},kind:${JSON.stringify(kind || '')}},slots:[...host.querySelectorAll('[data-sentence-slot-editor]')].map(item=>({slot:item.getAttribute('data-sentence-slot-editor'),name:item.dataset.sentenceSlotName,kind:item.dataset.sentenceSlotKind,text:item.textContent})),editors:[...host.querySelectorAll('[data-sentence-inline-editor]')].map(item=>({inline:item.dataset.sentenceInlineEditor,className:item.className,text:item.textContent})),html:host.innerHTML.slice(0,16000)}})()`)
    fs.writeFileSync(path.join(evidence, `slot-missing-${String(name).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`), JSON.stringify(diagnostic, null, 2) + '\n')
    throw error
  }
  const selector = await evaluate(findSelector)
  await click(`#slot-verification-host [data-sentence-slot-editor=${JSON.stringify(selector)}]`)
  try {
    await until(browserHas('#slot-verification-host [data-sentence-inline-editor]'), `slot editor ${kind || 'any'}:${name}`)
  } catch (error) {
    const diagnostic = await evaluate(`(()=>{const host=document.querySelector('#slot-verification-host');return {slots:[...host.querySelectorAll('[data-sentence-slot-editor]')].map(item=>({slot:item.getAttribute('data-sentence-slot-editor'),name:item.dataset.sentenceSlotName,kind:item.dataset.sentenceSlotKind})),editors:[...host.querySelectorAll('[data-sentence-inline-editor]')].map(item=>({inline:item.dataset.sentenceInlineEditor,className:item.className,text:item.textContent})),html:host.innerHTML.slice(0,12000)}})()`)
    fs.writeFileSync(path.join(evidence, `slot-click-${String(name).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`), JSON.stringify(diagnostic, null, 2) + '\n')
    throw error
  }
}

async function mountDocument(documentValue) {
  await evaluate(`window.__sentenceSlotSmoke.mount(${JSON.stringify(documentValue)})`)
  await until("Boolean(document.querySelector('#slot-verification-host [data-sentence-editor]'))", 'sentence editor mount')
  await until("Boolean(document.querySelector('#slot-verification-host .sentence-row-expression'))", 'sentence projection')
  await delay(120)
}

async function currentDocument() {
  return evaluate('window.__sentenceSlotSmoke.state()')
}

async function focusedPanel() {
  return evaluate(`(()=>{const host=document.querySelector('#slot-verification-host');const panel=host.querySelector('[data-sentence-inline-editor]');return {className:panel?.className||'',text:panel?.textContent||'',moduleSelect:Boolean(panel?.querySelector('[data-sentence-module-select]')),inputs:[...panel?.querySelectorAll('[data-sentence-module-input]')||[]].map(item=>item.dataset.sentenceModuleInput),parameters:[...panel?.querySelectorAll('[data-sentence-module-parameter]')||[]].map(item=>item.dataset.sentenceModuleParameter),slotEditor:panel?.dataset.sentenceSlotEditor||'',chooser:Boolean(panel?.querySelector('[data-sentence-expression-chooser]'))}})()`)
}

async function applyAuthorExpression(name, source) {
  const editorSelector = `#slot-verification-host [data-sentence-author-expression=${JSON.stringify(name)}] .ei-editor`
  const statusSelector = `#slot-verification-host [data-sentence-author-expression=${JSON.stringify(name)}] .sentence-author-expression-type`
  const applySelector = `#slot-verification-host [data-sentence-apply-expression=${JSON.stringify(name)}]`
  await evaluate(`(()=>{const editor=document.querySelector(${JSON.stringify(editorSelector)});if(!editor)throw new Error('missing author expression editor: ${name}');editor.scrollIntoView({block:'center',inline:'nearest'});editor.focus();editor.textContent=${JSON.stringify(source)};editor.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until(`document.querySelector(${JSON.stringify(statusSelector)})?.dataset.valid === 'true'`, `${name} expression validation`)
  await click(applySelector)
  await delay(120)
}

async function chooseLiteralText(value) {
  const authorName = await evaluate(`document.querySelector('#slot-verification-host [data-sentence-author-expression]')?.dataset.sentenceAuthorExpression || ''`)
  if (authorName) {
    await applyAuthorExpression(authorName, JSON.stringify(value))
    return
  }
  await evaluate(`(()=>{const host=document.querySelector('#slot-verification-host');const source=host.querySelector('[data-sentence-value-source]');if(source&&source.value!=='literal'){source.value='literal';source.dispatchEvent(new Event('change',{bubbles:true}));}const input=host.querySelector('.sentence-literal-control input[type=text]');if(!input)throw new Error('missing text literal input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await delay(120)
}

async function capture(name) {
  const shot = await cdpCall('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(evidence, name)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return file
}

async function dispatchKey(key, code, windowsVirtualKeyCode) {
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  await delay(100)
}

const checks = []
async function check(name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, ok: true, detail })
    return detail
  } catch (error) {
    checks.push({ name, ok: false, error: error?.stack || String(error) })
    return null
  }
}

const report = {
  task: 'RED-252 atomic authoring sentence slots',
  role: 'independent real Electron verification',
  project,
  evidence,
  checks,
  screenshots: [],
}

try {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (startupError) throw startupError
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()
      const tab = tabs.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (tab) {
        socket = new WebSocket(tab.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
        break
      }
    } catch { /* bounded startup retry */ }
    if (attempt === 159) throw new Error('Editor startup timed out')
    await delay(250)
  }

  await cdpCall('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })
  await until('Boolean(window.SkillSentenceEditor && window.ContentGraphCore && window.SentenceTemplates)', 'production editor globals')

  const catalog = await evaluate(`(()=>{const values=window.ContentGraphCore.getGameplayModuleCatalog();return {count:values.length,ids:values.map(item=>item.id),descriptors:Object.fromEntries(values.filter(item=>['author.effect.damage','math.add','extension.read-player','extension.write-player'].includes(item.id)).map(item=>[item.id,item]))}})()`)
  report.catalog = { count: catalog.count, required: Object.keys(catalog.descriptors) }
  for (const id of ['author.effect.damage', 'math.add', 'extension.read-player', 'extension.write-player']) {
    if (!catalog.descriptors[id]) checks.push({ name: `catalog descriptor ${id}`, ok: false, error: `real ContentGraphCore descriptor missing: ${id}` })
  }

  await evaluate(`(()=>{
    const host=document.createElement('div');host.id='slot-verification-host';host.style.cssText='width:1200px;min-height:900px;margin:0;padding:20px;background:#fff;color:#111;overflow:auto;';document.body.replaceChildren(host);
    let value=null;let editor=null;
    window.__sentenceSlotSmoke={
      mount(seed){editor?.destroy?.();value=JSON.parse(JSON.stringify(seed));host.replaceChildren();editor=window.SkillSentenceEditor.mount(host,{core:window.ContentGraphCore,field:'code',root:{collection:'skills',id:value.id},getDraft:()=>value,onChange:next=>{value=next}});},
      state(){return JSON.parse(JSON.stringify(value));},
      host,
    };
  })()`)

  const damageGraph = graph([
    call('source-ref', 'ref.holder'),
    call('target-ref', 'ref.target'),
    call('damage', 'author.effect.damage', {
      source: output('source-ref', 'piece'),
      target: output('target-ref', 'piece'),
      amount: literal(5),
    }, { damageType: 'normal' }),
  ])
  const damageDocument = smokeDocument(damageGraph, `${smokeId}-damage`)

  await check('damage sentence uses natural Chinese and amount is atomic', async () => {
    await mountDocument(damageDocument)
    const projection = await evaluate(`document.querySelector('#slot-verification-host [data-sentence-node="damage"] .sentence-row-expression')?.textContent||''`)
    assert.match(projection, /造成/)
    assert.match(projection, /伤害/)
    await clickSlot('amount', 'input')
    const focused = await focusedPanel()
    fs.writeFileSync(path.join(evidence, 'natural-damage-amount-panel.json'), JSON.stringify({ projection, focused }, null, 2) + '\n')
    const screenshot = await capture('natural-damage-amount-slot.png')
    report.screenshots.push(screenshot)
    assert.equal(focused.moduleSelect, false)
    assert.deepEqual(focused.inputs, ['amount'])
    assert.deepEqual(focused.parameters, [])
    assert.match(focused.text, /伤害量|数量|amount|点/)
    assert.equal(focused.text.includes('target'), false)
    assert.equal(focused.text.includes('source'), false)
    assert.equal(focused.text.includes('Tab 补全'), true, 'expression editor keeps cursor completion guidance')
    assert.equal(await evaluate(browserHas('#slot-verification-host [data-sentence-author-expression="amount"] .ei-expand')), true, 'expression editor keeps its expand control')
    await applyAuthorExpression('amount', '5 + 2')
    const edited = await currentDocument()
    const damage = edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'damage')
    assert.equal(damage.inputs.amount.kind, 'output')
    assert.match(damage.inputs.amount.node, /^expr-/)
    assert.equal(edited.gameplayModules.entries.code.graph.body.find(item => item.id === damage.inputs.amount.node)?.module, 'math.floor')
    assert.equal(edited.gameplayModules.entries.code.graph.body.some(item => item.module === 'math.add'), true, 'the typed arithmetic expression lowers through math.add')
    return { projection, focused, composed: damage.inputs.amount }
  })

  const recordSchema = { id: 'smoke-record', version: '1', fields: [
    { name: 'hp', label: '生命', type: 'number' },
    { name: 'label', label: '名称', type: 'string' },
  ] }
  const recordGraph = graph([
    { kind: 'record.create', id: 'record-create', schema: 'smoke-record@1', fields: { hp: literal(3), label: literal('保留字段') } },
    { kind: 'record.get', id: 'record-get', record: output('record-create', 'value'), field: 'hp' },
    { kind: 'return', id: 'return-result', values: { result: literal(9) } },
  ], { outputs: [{ name: 'result', label: '结果', type: 'number' }], schemas: [recordSchema] })
  const recordDocument = smokeDocument(recordGraph, `${smokeId}-record`)

  await check('record field and named return slots write canonical AST keys', async () => {
    await mountDocument(recordDocument)
    fs.writeFileSync(path.join(evidence, 'record-slot-inventory.json'), JSON.stringify(await evaluate(`(()=>[...document.querySelectorAll('#slot-verification-host [data-sentence-slot-editor]')].map(item=>({slot:item.getAttribute('data-sentence-slot-editor'),name:item.dataset.sentenceSlotName,kind:item.dataset.sentenceSlotKind,text:item.textContent})) )()`), null, 2) + '\n')
    await click('#slot-verification-host [data-sentence-record-fields="record-create"]')
    await until(browserHas('#slot-verification-host [data-sentence-record-fields-editor="record-create"]'), 'record field editor')
    fs.writeFileSync(path.join(evidence, 'record-field-slot-inventory.json'), JSON.stringify(await evaluate(`(()=>[...document.querySelectorAll('#slot-verification-host [data-sentence-record-fields-editor="record-create"] [data-sentence-slot-editor]')].map(item=>({slot:item.getAttribute('data-sentence-slot-editor'),name:item.dataset.sentenceSlotName,kind:item.dataset.sentenceSlotKind,text:item.textContent})) )()`), null, 2) + '\n')
    await clickSlot('field:hp', 'property')
    const hpPanel = await focusedPanel()
    fs.writeFileSync(path.join(evidence, 'record-hp-panel.json'), JSON.stringify(hpPanel, null, 2) + '\n')
    assert.equal(hpPanel.moduleSelect, false)
    assert.equal(hpPanel.slotEditor, 'property:field:hp')
    assert.equal(await evaluate(browserHas('#slot-verification-host [data-sentence-author-expression="field:hp"]')), true, 'record field uses the shared sentence expression editor')
    assert.equal(await evaluate(browserHas('#slot-verification-host [data-sentence-value-source="field:hp"]')), false, 'record field does not switch to a separate source form')
    await applyAuthorExpression('field:hp', '3 + 4')
    let edited = await currentDocument()
    const created = edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'record-create')
    assert.equal(created.fields.hp.kind, 'output')
    assert.equal(edited.gameplayModules.entries.code.graph.body.find(item => item.id === created.fields.hp.node)?.module, 'math.floor')
    assert.equal(edited.gameplayModules.entries.code.graph.body.some(item => item.module === 'math.add'), true, 'record field arithmetic lowers through math.add')
    assert.equal(Object.hasOwn(created.fields, 'field:hp'), false)
    assert.deepEqual(created.fields.label, literal('保留字段'))

    await clickSlot('return:result', 'input')
    const returnPanel = await focusedPanel()
    assert.equal(returnPanel.slotEditor, 'input:return:result')
    await applyAuthorExpression('return:result', '9 + 1')
    edited = await currentDocument()
    const returned = edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'return-result')
    assert.equal(returned.values.result.kind, 'output')
    assert.match(returned.values.result.node, /^expr-/)
    assert.equal(edited.gameplayModules.entries.code.graph.body.find(item => item.id === returned.values.result.node)?.module, 'math.floor')
    assert.equal(edited.gameplayModules.entries.code.graph.body.some(item => item.module === 'math.add'), true, 'named return arithmetic lowers through math.add')
    assert.equal(Object.hasOwn(returned.values, 'return:result'), false)
    const get = edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'record-get')
    assert.equal(get.field, 'hp')
    await clickSlot('field')
    const fieldPanel = await focusedPanel()
    assert.ok(fieldPanel.text.includes('数值') || fieldPanel.text.includes('hp'), 'record field selector exposes hp numeric type')
    return { hp: created.fields.hp, retained: created.fields.label, values: returned.values, field: get.field }
  })

  const extensionGraph = graph([
    call('player-ref', 'ref.player'),
    call('ext-write', 'extension.write-player', { owner: output('player-ref', 'player'), value: literal(7) }, {
      namespace: 'content', name: '', path: 'stats.hp', valueType: 'number',
    }),
  ])
  const extensionDocument = smokeDocument(extensionGraph, `${smokeId}-extension`)

  await check('extension dependencies gate later controls and retain incompatible values', async () => {
    await mountDocument(extensionDocument)
    const initialExtensionSentence = await evaluate(`document.querySelector('#slot-verification-host [data-sentence-node="ext-write"] .sentence-row-expression')?.textContent||''`)
    assert.equal(initialExtensionSentence.includes('类型为'), false, 'value type is hidden until variable name is available')
    assert.equal(initialExtensionSentence.includes('将【7】'), false, 'value input is hidden until variable name is available')
    await click('#slot-verification-host [data-sentence-module-editor="ext-write"]')
    const extensionEditorSelector = '#slot-verification-host [data-sentence-inline-editor="ext-write"]'
    await until(browserHas(extensionEditorSelector), 'extension editor')
    assert.equal(await evaluate(browserHas(`${extensionEditorSelector} [data-sentence-module-parameter="valueType"]`)), false, 'value type waits for variable name')
    assert.equal(await evaluate(browserHas(`${extensionEditorSelector} [data-sentence-pending-parameter="ext-write:valueType"]`)), true, 'pending value type remains visible as a warning')
    await click('#slot-verification-host [data-sentence-inline-editor="ext-write"] .sentence-popover-close')
    await clickSlot('name', 'parameter')
    const nameInputSelector = `${extensionEditorSelector} [data-sentence-module-parameter="name"] input`
    assert.equal(await evaluate(browserHas(nameInputSelector)), true, 'name is the only focused parameter control')
    await evaluate(`(()=>{const input=${browserQuery(nameInputSelector)};input.value='flag';input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await delay(120)
    await click('#slot-verification-host [data-sentence-inline-editor="ext-write"] .sentence-popover-close')
    await click('#slot-verification-host [data-sentence-module-editor="ext-write"]')
    await until(browserHas(`${extensionEditorSelector} [data-sentence-module-parameter="valueType"]`), 'value type after name')
    await clickSlot('valueType', 'parameter')
    await evaluate(`(()=>{const select=${browserQuery(`${extensionEditorSelector} [data-sentence-type-kind]`)};if(!select)throw new Error('missing value type selector');select.focus();select.value='boolean';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await delay(120)
    const focusAfterType = await evaluate(`(()=>{const active=document.activeElement;return {tag:active?.tagName||'',slot:active?.getAttribute('data-sentence-slot-editor')||'',inside:Boolean(active?.closest('#slot-verification-host')),panel:Boolean(active?.closest('[data-sentence-inline-editor]'))}})()`)
    assert.equal(focusAfterType.inside, true, JSON.stringify(focusAfterType))
    assert.equal(focusAfterType.panel, true, JSON.stringify(focusAfterType))
    await dispatchKey('Tab', 'Tab', 9)
    const focusAfterTab = await evaluate(`(()=>{const active=document.activeElement;return {tag:active?.tagName||'',slot:active?.getAttribute('data-sentence-slot-editor')||'',inside:Boolean(active?.closest('#slot-verification-host')),panel:Boolean(active?.closest('[data-sentence-inline-editor]'))}})()`)
    assert.equal(focusAfterTab.inside, true, JSON.stringify(focusAfterTab))
    await dispatchKey('Escape', 'Escape', 27)
    const focusAfterEscape = await evaluate(`(()=>{const active=document.activeElement;return {popover:Boolean(document.querySelector('#slot-verification-host [data-sentence-inline-editor]')),slot:active?.getAttribute('data-sentence-slot-editor')||'',inside:Boolean(active?.closest('#slot-verification-host'))}})()`)
    assert.equal(focusAfterEscape.popover, false, JSON.stringify(focusAfterEscape))
    assert.equal(focusAfterEscape.slot, 'ext-write:parameter:valueType', JSON.stringify(focusAfterEscape))
    await click('#slot-verification-host [data-sentence-module-editor="ext-write"]')
    const state = await currentDocument()
    const write = state.gameplayModules.entries.code.graph.body.find(item => item.id === 'ext-write')
    assert.equal(write.parameters.name, 'flag')
    assert.equal(write.parameters.valueType, 'boolean')
    assert.deepEqual(write.inputs.value, literal(7))
    assert.equal(await evaluate(browserHas('#slot-verification-host [data-sentence-type-mismatch="ext-write:value"]')), true, 'number value remains with a boolean type warning')
    assert.equal(await evaluate(browserHas('#slot-verification-host [data-sentence-type-mismatch="ext-write:owner"]')), false, 'nullable player reference is accepted without a false warning')
    const panel = await focusedPanel()
    return { write: { parameters: write.parameters, value: write.inputs.value }, mismatch: panel.text.match(/待重填[^。]*/)?.[0] || '', focusAfterType, focusAfterTab, focusAfterEscape }
  })

  const structureGraph = graph([
    { kind: 'collection', id: 'collection-main', method: 'map', items: literal([1, 2]), item: 'item', index: 'index', inputs: { local: literal('before') }, body: [] },
    { kind: 'defer-choice', id: 'defer-main', graph: 'resume@1', payload: literal('before-payload'), title: literal('请选择'), targetType: 'piece' },
    { kind: 'return', id: 'return-value', value: literal('before-return') },
  ], {
    continuations: [
      { id: 'resume', version: '1', payloadType: 'string', graph: graph([], { surface: 'pending' }) },
      { id: 'alternate', version: '1', payloadType: 'string', graph: graph([], { surface: 'pending' }) },
    ],
  })
  const structureDocument = smokeDocument(structureGraph, `${smokeId}-structure`)

  await check('collection local input, defer graph/payload, return.value and more fields remain editable', async () => {
    await mountDocument(structureDocument)
    await clickSlot('local', 'input')
    await chooseLiteralText('updated-local')
    let edited = await currentDocument()
    assert.deepEqual(edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'collection-main').inputs.local, literal('updated-local'))

    await clickSlot('local', 'input')
    assert.equal(await evaluate(browserHas('#slot-verification-host [data-sentence-author-expression="local"]')), true, 'collection local uses the shared sentence expression editor')
    await applyAuthorExpression('local', '当前技能.skillId')
    edited = await currentDocument()
    const collectionAfterCompose = edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'collection-main')
    assert.equal(collectionAfterCompose.inputs.local.kind, 'output')
    assert.equal(edited.gameplayModules.entries.code.graph.body.find(item => item.id === collectionAfterCompose.inputs.local.node)?.module, 'author.skill-instance.field')

    await clickSlot('graph', 'parameter')
    await evaluate(`(()=>{const select=document.querySelector('#slot-verification-host [data-sentence-continuation-ref]');if(!select)throw new Error('missing defer graph selector');select.value='alternate@1';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await delay(120)
    edited = await currentDocument()
    assert.equal(edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'defer-main').graph, 'alternate@1')

    await clickSlot('payload', 'input')
    await chooseLiteralText('updated-payload')
    await clickSlot('value', 'input')
    await chooseLiteralText('updated-return')
    edited = await currentDocument()
    const defer = edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'defer-main')
    const returned = edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'return-value')
    assert.deepEqual(defer.payload, literal('updated-payload'))
    assert.deepEqual(returned.value, literal('updated-return'))

    await click('#slot-verification-host [data-sentence-configuration]')
    await until(browserHas('#slot-verification-host [data-sentence-graph-configuration][open]'), 'graph configuration inspector')
    const config = await evaluate(`(()=>{const details=document.querySelector('#slot-verification-host [data-sentence-graph-configuration]');return {present:Boolean(details),summary:details?.querySelector('summary')?.textContent||'',schemas:Boolean(details?.querySelector('[data-sentence-schemas]')),declarations:Boolean(details?.querySelector('[data-sentence-declarations]'))}})()`)
    assert.equal(config.present, true)
    assert.equal(config.schemas, true)
    assert.equal(config.declarations, true)
    return { collection: edited.gameplayModules.entries.code.graph.body.find(item => item.id === 'collection-main').inputs, defer: { graph: defer.graph, payload: defer.payload }, return: returned.value, config }
  })

  await check('changed graph survives file serialization and remount', async () => {
    const finalDocument = await currentDocument()
    fs.writeFileSync(smokeFile, JSON.stringify(finalDocument, null, 2) + '\n')
    const reopened = JSON.parse(fs.readFileSync(smokeFile, 'utf8'))
    await mountDocument(reopened)
    const roundTrip = await currentDocument()
    assert.deepEqual(roundTrip.gameplayModules.entries.code.graph, reopened.gameplayModules.entries.code.graph)
    return { body: roundTrip.gameplayModules.entries.code.graph.body.map(item => item.id), file: smokeFile }
  })

  report.ok = checks.every(item => item.ok)
  report.failureCount = checks.filter(item => !item.ok).length
  fs.writeFileSync(path.join(evidence, 'sentence-slot-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  if (!report.ok) {
    const failed = checks.filter(item => !item.ok).map(item => `${item.name}: ${item.error}`).join('\n')
    throw new Error(`sentence slot smoke failed (${report.failureCount})\n${failed}`)
  }
  console.log(JSON.stringify({ ok: true, evidence: report, project }))
} catch (error) {
  report.ok = false
  report.failureCount = Math.max(1, checks.filter(item => !item.ok).length)
  report.error = error?.stack || String(error)
  fs.writeFileSync(path.join(evidence, 'sentence-slot-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.error(error?.stack || error)
  process.exitCode = 1
} finally {
  try { socket?.close() } catch { /* ignore shutdown */ }
  child.kill()
}
