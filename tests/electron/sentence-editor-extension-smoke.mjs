import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/* Real Electron regression for custom extension authoring in the sentence editor. */
const require = createRequire(import.meta.url)
const root = process.cwd()
const evidence = process.env.RVB_SENTENCE_EDITOR_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-atomic-authoring')
fs.mkdirSync(evidence, { recursive: true })
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-extension-editor-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'official', root)
const frostbolt = JSON.parse(fs.readFileSync(path.join(root, 'data/skills/frostbolt.json'), 'utf8'))
const extensionSmoke = JSON.parse(JSON.stringify(frostbolt))
extensionSmoke.id = 'extension-authoring-smoke'
extensionSmoke.name = '扩展变量编辑验证'
extensionSmoke.description = '验证扩展变量的自定义访问、作用域建议与类型编辑。'
extensionSmoke.cluster = { ...(extensionSmoke.cluster || {}), id: 'skills:extension-authoring-smoke' }
const extensionGraph = extensionSmoke.gameplayModules.entries.code.graph
extensionGraph.schemas = [
  ...(Array.isArray(extensionGraph.schemas) ? extensionGraph.schemas : []),
  { id: 'smoke-record', version: '1', fields: [{ name: 'hp', type: 'number' }, { name: 'label', type: 'string' }] },
]
const output = (node, port) => ({ kind: 'output', node, port })
const literal = value => ({ kind: 'literal', value })
const extensionCall = (id, module, inputs = {}, parameters = {}) => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const extensionStatements = [
  extensionCall('smoke-player', 'ref.player'),
  extensionCall('smoke-piece', 'ref.holder'),
  extensionCall('smoke-skill-instance', 'ref.current-skill'),
  extensionCall('ext-declare-instance', 'extension.declare-instance', { entity: output('smoke-skill-instance', 'instance'), value: literal(1) }, { namespace: 'content', name: 'skillState', valueType: 'number', entityKind: 'skill' }),
  extensionCall('ext-read-instance', 'extension.read-instance', { entity: output('smoke-skill-instance', 'instance') }, { namespace: 'content', name: 'skillState', path: '', valueType: 'number', entityKind: 'skill' }),
  extensionCall('ext-declare-player', 'extension.declare-player', { owner: output('smoke-player', 'player'), value: literal(1) }, { name: 'priorPlayer', valueType: 'number' }),
  extensionCall('ext-read-player', 'extension.read-player', { owner: output('smoke-player', 'player') }, { namespace: 'content', name: 'savedPlayerState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('ext-write-player', 'extension.write-player', { owner: output('smoke-player', 'player'), value: output('ext-read-player', 'value') }, { namespace: 'content', name: 'savedPlayerState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('ext-read-missing', 'extension.read-player', { owner: output('smoke-player', 'player') }, { namespace: 'content', name: 'missingState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('ext-declare-player-later', 'extension.declare-player', { owner: output('smoke-player', 'player'), value: literal(2) }, { namespace: 'content', name: 'laterPlayer', valueType: 'number' }),
  extensionCall('ext-declare-piece-root', 'extension.declare-piece', { owner: output('smoke-piece', 'piece'), value: literal(2) }, { name: 'rootPiece', valueType: 'number' }),
  extensionCall('ext-declare-piece-shared', 'extension.declare-piece', { owner: output('smoke-piece', 'piece'), value: literal(3) }, { name: 'priorPlayer', valueType: 'number' }),
  extensionCall('ext-declare-battle', 'extension.declare-battle', { value: literal(3) }, { namespace: 'content', name: 'battleState', valueType: 'number' }),
  extensionCall('ext-read-battle', 'extension.read-battle', {}, { namespace: 'content', name: 'battleState', path: '', valueType: 'number' }),
  extensionCall('ext-write-battle', 'extension.write-battle', { value: output('ext-read-battle', 'value') }, { namespace: 'content', name: 'battleState', path: '', valueType: 'number' }),
  {
    kind: 'if', id: 'ext-scope', condition: literal(true),
    then: [
      extensionCall('ext-declare-piece-branch', 'extension.declare-piece', { owner: output('smoke-piece', 'piece'), value: literal(4) }, { namespace: 'content', name: 'branchPiece', valueType: 'number' }),
      extensionCall('ext-read-piece-then', 'extension.read-piece', { owner: output('smoke-piece', 'piece') }, { namespace: 'content', name: 'branchPiece', path: 'stats.hp', valueType: 'number' }),
      extensionCall('ext-write-piece', 'extension.write-piece', { owner: output('smoke-piece', 'piece'), value: output('ext-read-piece-then', 'value') }, { namespace: 'content', name: 'branchPiece', path: 'stats.hp', valueType: 'number' }),
    ],
    else: [extensionCall('ext-read-piece-else', 'extension.read-piece', { owner: output('smoke-piece', 'piece') }, { namespace: 'content', name: 'branchPiece', path: 'stats.hp', valueType: 'number' })],
  },
]
const extensionReturnIndex = extensionGraph.body.findIndex(statement => statement?.kind === 'return')
extensionGraph.body.splice(extensionReturnIndex >= 0 ? extensionReturnIndex : extensionGraph.body.length, 0, ...extensionStatements)
fs.writeFileSync(path.join(project, 'data', 'skills', 'extension-authoring-smoke.json'), JSON.stringify(extensionSmoke, null, 2) + '\n')
fs.writeFileSync(path.join(project, 'data', 'skills', 'manifest.json'), JSON.stringify(['extension-authoring-smoke']) + '\n')
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

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
async function connect() {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (startupError) throw startupError
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()
      const tab = tabs.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (tab) {
        socket = new WebSocket(tab.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
        return
      }
    } catch { /* bounded startup retry */ }
    await delay(250)
  }
  throw new Error('Editor startup timed out')
}
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
    const onMessage = event => {
      const result = JSON.parse(event.data)
      if (result.id !== id) return
      clearTimeout(timer); socket.removeEventListener('message', onMessage)
      if (result.error) reject(new Error(JSON.stringify(result.error))); else resolve(result.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt++) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error(`UI condition timed out: ${expression}`)
}
async function openSkill() {
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate("(()=>{document.querySelector('[data-tab=skills]').click();const e=[...document.querySelectorAll('#skills-list .entity-item')].find(x=>x.querySelector('.id').textContent==='extension-authoring-smoke');if(!e)throw new Error('missing extension-authoring-smoke');e.click()})()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))")
}
function draftExpression() { return "(()=>{const text=document.querySelector('#skills-detail [data-json-source]')?.value||'';return JSON.parse(text)})()" }
async function openStatementEditor(statementId) {
  await evaluate(`(()=>{const button=document.querySelector('#skills-detail [data-sentence-module-editor="${statementId}"]');if(!button)throw new Error('missing sentence module '+${JSON.stringify(statementId)});button.click()})()`)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"]'))`)
}
async function focusSentenceSlot(statementId, kind, name) {
  const selector = `#skills-detail [data-sentence-slot-editor="${statementId}:${kind}:${name}"]`
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw new Error('missing sentence slot '+${JSON.stringify(`${kind}:${name}`)});button.click()})()`)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"].sentence-slot-only-editor'))`)
}
async function setModuleParameter(statementId, parameter, value) {
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-module-parameter="${parameter}"] input'))`)
  await evaluate(`(()=>{const field=document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-module-parameter="${parameter}"]');const details=field?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click();const input=field?.querySelector('input');if(!input)throw new Error('missing module parameter');input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}
async function setModuleValueType(statementId, mode) {
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]'))`)
  await evaluate(`(()=>{const select=document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]');select.value=${JSON.stringify(mode)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}
async function setModuleRecordSchema(statementId, schema) {
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-record-type]'))`)
  await evaluate(`(()=>{const select=document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-record-type]');select.value=${JSON.stringify(schema)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}
async function extensionSuggestions(statementId) {
  return evaluate(`(()=>{const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"]');const input=panel?.querySelector('[data-sentence-module-parameter="name"] input');const list=input&&document.getElementById(input.getAttribute('list'));return [...(list?.options||[])].map(option=>option.value)})()`)
}

try {
  await connect()
  await openSkill()
  const initial = await evaluate(draftExpression())
  const initialIds = new Set(initial.gameplayModules.entries.code.graph.body.map(statement => statement?.id).filter(Boolean))
  await evaluate("document.querySelector('#skills-detail [data-sentence-add-effect]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))")
  for (const moduleId of ['extension.map-items', 'extension.map-put', 'extension.map-remove']) {
    assert.equal(await evaluate(`Boolean(document.querySelector('#skills-detail [data-sentence-module="${moduleId}"]'))`), true, `${moduleId} remains authorable when a schema exists without a map declaration`)
  }
  await evaluate("document.querySelector('#skills-detail [data-sentence-popover=module] .sentence-popover-close').click()")
  await evaluate("document.querySelector('#skills-detail [data-sentence-add-effect]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))")
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-module=\"extension.read-battle\"]'))"), true)
  await evaluate("document.querySelector('#skills-detail [data-sentence-module=\"extension.read-battle\"]').click()")
  let draft = await evaluate(draftExpression())
  const inserted = draft.gameplayModules.entries.code.graph.body.find(statement => statement?.module === 'extension.read-battle' && !initialIds.has(statement.id))
  assert.ok(inserted?.id, 'custom access can be created without a declaration')
  const insertedId = inserted.id
  await openStatementEditor(insertedId)
  await setModuleParameter(insertedId, 'namespace', 'author-test')
  await setModuleParameter(insertedId, 'name', 'customRecord')
  await setModuleParameter(insertedId, 'path', 'state.hp')
  await setModuleValueType(insertedId, 'record')
  draft = await evaluate(draftExpression())
  assert.equal(draft.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId).parameters.valueType, 'record')
  await setModuleValueType(insertedId, 'record-schema')
  await setModuleRecordSchema(insertedId, 'smoke-record@1')
  draft = await evaluate(draftExpression())
  const edited = draft.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId)
  assert.deepEqual(edited.parameters, { namespace: 'author-test', name: 'customRecord', path: 'state.hp', valueType: '{"kind":"record","schema":"smoke-record@1"}' })
  await evaluate("document.querySelector('#skills-detail [data-sentence-save]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存'")
  const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'extension-authoring-smoke.json'), 'utf8'))
  assert.deepEqual(persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId).parameters, edited.parameters)

  await openSkill()
  draft = await evaluate(draftExpression())
  assert.deepEqual(draft.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId).parameters, edited.parameters)
  await openStatementEditor(insertedId)
  assert.equal(await evaluate(`document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"] [data-sentence-module-parameter="name"] input')?.value`), 'customRecord')
  assert.equal(await evaluate(`document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]')?.value`), 'record-schema')
  assert.equal(await evaluate(`document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"] [data-sentence-record-type]')?.value`), 'smoke-record@1')

  // The sentence projection opens one editable slot at a time. A focused
  // custom name edit must not reopen the module selector or expose unrelated
  // type/path/value controls.
  await focusSentenceSlot(insertedId, 'parameter', 'name')
  const focusedCustom = await evaluate(`(()=>{const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"]');return {slotOnly:panel?.classList.contains('sentence-slot-only-editor'),moduleSelect:Boolean(panel?.querySelector('[data-sentence-module-select]')),parameters:[...panel?.querySelectorAll('[data-sentence-module-parameter]')||[]].map(node=>node.dataset.sentenceModuleParameter),inputs:[...panel?.querySelectorAll('[data-sentence-module-input]')||[]].map(node=>node.dataset.sentenceModuleInput)}})()`)
  assert.equal(focusedCustom.slotOnly, true)
  assert.equal(focusedCustom.moduleSelect, false)
  assert.deepEqual(focusedCustom.parameters, ['name'])
  assert.deepEqual(focusedCustom.inputs, [])
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const screenshotPath = path.join(evidence, 'sentence-editor-extension-custom.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  await evaluate(`document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"] .sentence-popover-close')?.click()`)

  await openStatementEditor('ext-read-player')
  const rootSuggestions = await extensionSuggestions('ext-read-player')
  assert.ok(rootSuggestions.includes('priorPlayer'), JSON.stringify(rootSuggestions))
  assert.equal(rootSuggestions.includes('laterPlayer'), false, JSON.stringify(rootSuggestions))
  assert.equal(rootSuggestions.includes('foreignSkill'), false, JSON.stringify(rootSuggestions))
  await openStatementEditor('ext-read-piece-then')
  const thenSuggestions = await extensionSuggestions('ext-read-piece-then')
  assert.ok(thenSuggestions.includes('rootPiece'), JSON.stringify(thenSuggestions))
  assert.ok(thenSuggestions.includes('branchPiece'), JSON.stringify(thenSuggestions))
  assert.ok(thenSuggestions.includes('priorPlayer'), JSON.stringify(thenSuggestions))
  await openStatementEditor('ext-read-piece-else')
  const elseSuggestions = await extensionSuggestions('ext-read-piece-else')
  assert.ok(elseSuggestions.includes('rootPiece'), JSON.stringify(elseSuggestions))
  assert.ok(elseSuggestions.includes('priorPlayer'), JSON.stringify(elseSuggestions))
  assert.equal(elseSuggestions.includes('branchPiece'), false, JSON.stringify(elseSuggestions))
  await openStatementEditor('ext-read-missing')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-inline-editor=\"ext-read-missing\"] [data-sentence-module-parameter=\"name\"] input')?.value"), 'missingState')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=\"ext-read-missing\"] [data-sentence-module-parameter=\"fallback\"]'))"), false)
  await openStatementEditor('ext-read-instance')
  const instanceEditor = await evaluate("(()=>{const panel=document.querySelector('#skills-detail [data-sentence-inline-editor=\"ext-read-instance\"]');return {entityKind:Boolean(panel?.querySelector('[data-sentence-module-parameter=\"entityKind\"]')),entity:Boolean(panel?.querySelector('[data-sentence-module-input=\"entity\"]')),text:panel?.closest('#skills-detail')?.querySelector('[data-sentence-node=\"ext-read-instance\"]')?.textContent||''}})()")
  assert.equal(instanceEditor.entityKind, false, JSON.stringify(instanceEditor))
  assert.equal(instanceEditor.entity, true, JSON.stringify(instanceEditor))
  const reportPath = path.join(evidence, 'sentence-editor-extension-smoke.json')
  fs.writeFileSync(reportPath, JSON.stringify({
    ok: true,
    statementId: insertedId,
    parameters: edited.parameters,
    rootSuggestions,
    thenSuggestions,
    elseSuggestions,
    focusedCustom,
    mapPickerWithSchema: ['extension.map-items', 'extension.map-put', 'extension.map-remove'],
    missingExtension: { name: 'missingState', fallback: false },
    instanceEditor,
    screenshot: screenshotPath,
  }, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, evidence: screenshotPath, report: reportPath, project }))
} finally {
  try { socket?.close() } catch { /* ignore shutdown */ }
  child.kill()
}
