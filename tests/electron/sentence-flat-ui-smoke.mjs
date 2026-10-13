import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/*
 * RED-252 flat Chinese sentence UI acceptance coverage.
 *
 * This is intentionally a real Electron/CDP test.  It starts the editor with
 * a temporary copy of the official project and drives the production DOM and
 * IPC save route.  The user's current project is never selected or written.
 */
const require = createRequire(import.meta.url)
const root = process.cwd()
const evidence = path.resolve(process.env.RVB_FLAT_SENTENCE_UI_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-flat-sentence'))
fs.mkdirSync(evidence, { recursive: true })

const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-flat-sentence-ui-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'official', root)

const readSkill = id => JSON.parse(fs.readFileSync(path.join(root, 'data', 'skills', `${id}.json`), 'utf8'))
const writeSkill = (id, document) => fs.writeFileSync(path.join(project, 'data', 'skills', `${id}.json`), JSON.stringify(document, null, 2) + '\n')
const output = (node, port) => ({ kind: 'output', node, port })
const literal = value => ({ kind: 'literal', value })
const extensionCall = (id, module, inputs = {}, parameters = {}) => ({ kind: 'call', id, module, version: '1', inputs, parameters })
function findGraphStatement(value, id, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null
  seen.add(value)
  if (!Array.isArray(value) && value.id === id && typeof value.kind === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGraphStatement(item, id, seen)
      if (found) return found
    }
    return null
  }
  for (const child of Object.values(value)) {
    const found = findGraphStatement(child, id, seen)
    if (found) return found
  }
  return null
}

// Keep the production Fireball and Shadow Clone definitions in the isolated
// official project.  The marker is an unknown field used to prove save/reload
// preservation; it is never written to the user's source project.
const fireball = readSkill('fireball')
fireball.editorFlatSentenceUnknown = { preserved: true, source: 'official-fireball' }
const shadowClone = readSkill('naruto-shadow-clone')
shadowClone.editorFlatSentenceUnknown = { preserved: true, source: 'official-shadow-clone' }
const minatoFlyingRaijin = readSkill('minato-flying-raijin-passive')
const recall = readSkill('recall')
const recallMoveTrigger = readSkill('recall-move-trigger')
const frostbolt = readSkill('frostbolt')
const extensionSmoke = JSON.parse(JSON.stringify(frostbolt))
extensionSmoke.id = 'flat-sentence-extension-smoke'
extensionSmoke.name = '扩展访问真实流程验证'
extensionSmoke.description = 'RED-252 flat sentence extension authoring smoke.'
extensionSmoke.editorFlatSentenceUnknown = { preserved: true, source: 'extension-copy' }
extensionSmoke.cluster = { ...(extensionSmoke.cluster || {}), id: 'skills:flat-sentence-extension-smoke' }
const moduleVersionSmoke = readSkill('fireball')
moduleVersionSmoke.id = 'flat-sentence-module-version-smoke'
moduleVersionSmoke.name = '模块版本选择回归'
moduleVersionSmoke.description = 'RED-252 generic field picker and comparison regression.'
moduleVersionSmoke.statusTag = { id: 'flat-ui-status', type: 'flat-ui-status', name: '护甲状态', duration: 2, amount: 1 }
moduleVersionSmoke.editorFlatSentenceUnknown = { preserved: true, source: 'module-version-picker' }
moduleVersionSmoke.cluster = { ...(moduleVersionSmoke.cluster || {}), id: `skills:${moduleVersionSmoke.id}` }
const moduleVersionGraph = moduleVersionSmoke.gameplayModules.entries.code.graph
const moduleVersionAttackIndex = moduleVersionGraph.body.findIndex(statement => statement?.id === 'attack')
moduleVersionGraph.body.splice(moduleVersionAttackIndex >= 0 ? moduleVersionAttackIndex : moduleVersionGraph.body.length, 0,
  {
    kind: 'call',
    id: 'source-faction',
    module: 'piece.field',
    version: '2',
    inputs: { piece: output('source', 'piece') },
    parameters: { field: 'faction' },
    layout: { sentenceExpression: { owner: 'same-faction', input: 'left' } },
  },
  {
    kind: 'call',
    id: 'target-faction',
    module: 'piece.field',
    version: '2',
    inputs: { piece: output('target', 'piece') },
    parameters: { field: 'faction' },
    layout: { sentenceExpression: { owner: 'same-faction', input: 'right' } },
  },
  {
    kind: 'call',
    id: 'same-faction',
    module: 'compare.values',
    version: '1',
    inputs: {
      left: output('source-faction', 'value'),
      right: output('target-faction', 'value'),
    },
    parameters: { valueType: 'string', operator: '==' },
  },
)
moduleVersionGraph.composites = [
  ...(Array.isArray(moduleVersionGraph.composites) ? moduleVersionGraph.composites : []),
  {
    id: 'legacy-field-fixture',
    version: '1',
    label: '兼容文本字段夹具',
    inputs: [{ name: 'piece', label: '棋子', type: 'piece' }],
    outputs: [{ name: 'text', label: '文本', type: 'string' }],
    body: [
      {
        kind: 'call',
        id: 'legacy-text',
        module: 'attribute.text',
        version: '1',
        inputs: { piece: { kind: 'input', name: 'piece' } },
        parameters: { attribute: 'name' },
      },
      {
        kind: 'return',
        id: 'legacy-text-return',
        value: { kind: 'output', node: 'legacy-text', port: 'text' },
      },
    ],
    allowedSurfaces: ['skill'],
  },
]
const extensionGraph = extensionSmoke.gameplayModules.entries.code.graph
extensionGraph.schemas = [
  ...(Array.isArray(extensionGraph.schemas) ? extensionGraph.schemas : []),
  { id: 'flat-record', version: '1', fields: [{ name: 'hp', label: '生命', type: 'number' }, { name: 'label', label: '名称', type: 'string' }] },
]
const extensionStatements = [
  extensionCall('flat-player', 'ref.player'),
  extensionCall('flat-piece', 'ref.holder'),
  extensionCall('flat-declare-player', 'extension.declare-player', {
    owner: output('flat-player', 'player'), value: literal(1),
  }, { name: 'priorPlayer', valueType: 'number' }),
  extensionCall('flat-read-player', 'extension.read-player', {
    owner: output('flat-player', 'player'),
  }, { namespace: 'content', name: 'savedPlayerState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('flat-write-player', 'extension.write-player', {
    owner: output('flat-player', 'player'), value: output('flat-read-player', 'value'),
  }, { namespace: 'content', name: 'savedPlayerState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('flat-read-missing', 'extension.read-player', {
    owner: output('flat-player', 'player'),
  }, { namespace: 'content', name: 'missingState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('flat-declare-piece', 'extension.declare-piece', {
    owner: output('flat-piece', 'piece'), value: literal(2),
  }, { name: 'rootPiece', valueType: 'number' }),
  {
    kind: 'if', id: 'flat-scope', condition: literal(true),
    then: [extensionCall('flat-declare-branch-piece', 'extension.declare-piece', {
      owner: output('flat-piece', 'piece'), value: literal(3),
    }, { namespace: 'content', name: 'branchPiece', valueType: 'number' })],
    else: [extensionCall('flat-read-else-piece', 'extension.read-piece', {
      owner: output('flat-piece', 'piece'),
    }, { namespace: 'content', name: 'branchPiece', path: 'stats.hp', valueType: 'number' })],
  },
]
const extensionReturnIndex = extensionGraph.body.findIndex(statement => statement?.kind === 'return')
extensionGraph.body.splice(extensionReturnIndex >= 0 ? extensionReturnIndex : extensionGraph.body.length, 0, ...extensionStatements)

writeSkill('fireball', fireball)
writeSkill('naruto-shadow-clone', shadowClone)
writeSkill('minato-flying-raijin-passive', minatoFlyingRaijin)
writeSkill('recall', recall)
writeSkill('recall-move-trigger', recallMoveTrigger)
writeSkill('flat-sentence-extension-smoke', extensionSmoke)
writeSkill('flat-sentence-module-version-smoke', moduleVersionSmoke)
fs.writeFileSync(path.join(project, 'data', 'skills', 'manifest.json'), JSON.stringify(['fireball', 'naruto-shadow-clone', 'minato-flying-raijin-passive', 'recall', 'recall-move-trigger', 'flat-sentence-extension-smoke', 'flat-sentence-module-version-smoke']) + '\n')
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [...args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--editor-smoke-hidden'], {
  env, windowsHide: true, stdio: 'ignore',
})
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

async function until(expression, label = expression) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (startupError) throw startupError
    try { if (await evaluate(expression)) return } catch { /* bounded renderer startup */ }
    await delay(100)
  }
  throw new Error(`UI condition timed out: ${label}`)
}

async function connect() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (startupError) throw startupError
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()
      const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) {
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
        return
      }
    } catch { /* bounded startup retry */ }
    await delay(250)
  }
  throw new Error('Editor startup timed out')
}

function selector(value) { return JSON.stringify(value) }

async function click(css) {
  await evaluate(`(()=>{const e=document.querySelector(${selector(css)});if(!e)throw new Error('missing ${css}');e.scrollIntoView({block:'center',inline:'nearest'});e.click()})()`)
  await delay(100)
}

async function openSkill(id, { reuseCurrent = false } = {}) {
  if (reuseCurrent) {
    const alreadyOpen = await evaluate(`(()=>{const source=document.querySelector('#skills-detail [data-json-source]')?.value||'';try{return JSON.parse(source)?.id===${selector(id)}}catch{return false}})()`)
    if (alreadyOpen) {
      await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))", `${id} sentence editor`)
      await until("Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]')||document.querySelector('#skills-detail [data-sentence-step]'))", `${id} sentence projection`)
      await delay(120)
      return
    }
  }
  await until("Boolean(document.querySelector('#skills-list .entity-item'))", 'skills list')
  await evaluate("document.querySelector('[data-tab=skills]').click()")
  await evaluate(`(()=>{const item=[...document.querySelectorAll('#skills-list .entity-item')].find(node=>node.querySelector('.id')?.textContent===${selector(id)});if(!item)throw new Error('missing skill '+${selector(id)});item.click()})()`)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))", `${id} sentence editor`)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]')||document.querySelector('#skills-detail [data-sentence-step]'))", `${id} sentence projection`)
  await delay(120)
}

async function openCard(id) {
  await until("Boolean(document.querySelector('#cards-list .entity-item'))", 'cards list')
  await evaluate("document.querySelector('[data-tab=cards]').click()")
  await evaluate(`(()=>{const item=[...document.querySelectorAll('#cards-list .entity-item')].find(node=>node.querySelector('.id')?.textContent===${selector(id)});if(!item)throw new Error('missing card '+${selector(id)});item.click()})()`)
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-editor]'))", `${id} card sentence editor`)
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-graph-summary]')||document.querySelector('#cards-detail [data-sentence-step]'))", `${id} card sentence projection`)
  await delay(120)
}

async function readDraft(root = '#skills-detail') {
  return evaluate(`(()=>{const text=document.querySelector(${selector(`${root} [data-json-source]`)})?.value||'';if(!text)throw new Error('missing live draft JSON source');return JSON.parse(text)})()`)
}

async function saveCurrent() {
  await evaluate("(()=>{const button=document.querySelector('#skills-detail [data-sentence-save]')||document.querySelector('#skills-detail [data-save-json]');if(!button)throw new Error('missing save action');button.click()})()")
  try {
    await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存' || document.querySelector('#skills-detail .dirty-state')?.textContent==='已保存'", 'save completion')
  } catch (error) {
    const diagnostic = await evaluate("document.querySelector('#skills-detail [data-json-error]')?.textContent || document.querySelector('#skills-detail .dirty-state.invalid')?.textContent || ''")
    const entryState = await evaluate("(()=>{const text=document.querySelector('#skills-detail [data-json-source]')?.value||'';try{const value=JSON.parse(text);const entry=value.gameplayModules?.entries?.code;let compile='';try{window.ContentGraphCore.compileGameplayModuleGraph(entry?.graph,window.ContentGraphCore.GAMEPLAY_MODULE_REGISTRY)}catch(error){compile=error?.message||String(error)}return JSON.stringify({entries:Object.fromEntries(Object.entries(value.gameplayModules?.entries||{}).map(([key,item])=>[key,{compilerVersion:item?.compilerVersion,graphSurface:item?.graph?.surface,graphVersion:item?.graph?.version,bodyLength:item?.graph?.body?.length}])),compile,schema10:entry?.graph?.schemas?.[10]||null})}catch{return ''}})()")
    throw new Error(`${error.message}; graph diagnostic: ${diagnostic}; entries: ${entryState}`)
  }
  await delay(100)
}

async function saveEditor(root) {
  await evaluate(`(()=>{const button=document.querySelector(${selector(`${root} [data-sentence-save]`)})||document.querySelector(${selector(`${root} [data-save-json]`)});if(!button)throw new Error('missing save action in '+${selector(root)});button.click()})()`)
  try {
    await until(`document.querySelector(${selector(`${root} [data-footer-state]`)})?.textContent==='已保存' || document.querySelector(${selector(`${root} .dirty-state`)})?.textContent==='已保存'`, `${root} save completion`)
  } catch (error) {
    const diagnostic = await evaluate(`(()=>{const root=document.querySelector(${selector(root)});const message=root?.querySelector('[data-sentence-diagnostic],[data-json-error],.dirty-state.invalid')?.textContent||'';const source=root?.querySelector('[data-json-source]')?.value||'';try{const value=JSON.parse(source);const graph=value.gameplayModules?.entries?.code?.graph;let compile='';try{window.ContentGraphCore.compileGameplayModuleGraph(graph,window.ContentGraphCore.GAMEPLAY_MODULE_REGISTRY)}catch(error){compile=error?.message||String(error)}return {message,compile}}catch(parseError){return {message,compile:'json:'+parseError?.message}}})()`)
    throw new Error(`${error.message}; save diagnostic: ${JSON.stringify(diagnostic)}`)
  }
  await delay(100)
}

async function screenshot(name) {
  const shot = await cdpCall('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(evidence, name)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return file
}

async function dispatchKey(key, code, windowsVirtualKeyCode) {
  await evaluate(`(()=>{const active=document.activeElement;return {tag:active?.tagName||'',text:active?.textContent||'',dataset:{...(active?.dataset||{})}}})()`)
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
  await cdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  await delay(100)
}

async function setLiteralNumber(fieldSelector, value) {
  await evaluate(`(()=>{const field=document.querySelector(${selector(fieldSelector)});if(!field)throw new Error('missing literal field '+${selector(fieldSelector)});const source=field.querySelector('[data-sentence-value-source]');if(source){source.value='literal';source.dispatchEvent(new Event('change',{bubbles:true}))}})()`)
  await delay(120)
  await evaluate(`(()=>{const field=document.querySelector(${selector(fieldSelector)});const input=field?.querySelector('.sentence-literal-control input[type=number], .sentence-literal-control input[type=text], input[type=number]');if(!input)throw new Error('missing literal number input in '+${selector(fieldSelector)});input.value=${selector(String(value))};input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await delay(120)
}

async function setParameter(statementId, name, value) {
  const panel = `#skills-detail [data-sentence-inspector] [data-sentence-inline-editor=${selector(statementId)}]`
  await until(`Boolean(document.querySelector(${selector(panel)}))`, `selected editor ${statementId}`)
  await evaluate(`(()=>{const field=document.querySelector(${selector(`${panel} [data-sentence-module-parameter=${JSON.stringify(name)}]`)});if(!field)throw new Error('missing parameter '+${name});const details=field.closest('details');if(details&&!details.open)details.querySelector('summary')?.click();const input=field.querySelector('input');if(!input)throw new Error('missing parameter input '+${name});input.value=${selector(String(value))};input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await delay(120)
}

async function setEnumParameter(statementId, name, value) {
  const panel = `#skills-detail [data-sentence-inspector] [data-sentence-inline-editor=${selector(statementId)}]`
  await until(`Boolean(document.querySelector(${selector(panel)}))`, `selected editor ${statementId}`)
  await evaluate(`(()=>{const field=document.querySelector(${selector(`${panel} [data-sentence-module-parameter=${JSON.stringify(name)}]`)});if(!field)throw new Error('missing parameter '+${name});const select=field.querySelector('[data-sentence-literal-enum]');if(!select)throw new Error('missing enum parameter '+${name});const value=${selector(JSON.stringify(value))};select.value=value;if(select.value!==value)throw new Error('enum option is unavailable '+value);select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await delay(120)
}

async function applyAuthorExpression(name, source, root = '#skills-detail') {
  const editorSelector = `${root} [data-sentence-author-expression=${selector(name)}] .ei-editor`
  const applySelector = `${root} [data-sentence-apply-expression=${selector(name)}]`
  await evaluate(`(()=>{const editor=document.querySelector(${selector(editorSelector)});if(!editor)throw new Error('missing author expression editor: ${name}');editor.scrollIntoView({block:'center',inline:'nearest'});editor.focus();editor.textContent=${selector(source)};editor.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until(`Boolean(document.querySelector(${selector(applySelector)})) && document.querySelector(${selector(applySelector)})?.disabled===false`, `valid author expression ${name}`)
  await click(applySelector)
  await delay(120)
}

async function addModule(root, moduleId, version) {
  await click(`${root} [data-sentence-add-effect]`)
  await until(`Boolean(document.querySelector(${selector(`${root} [data-sentence-popover=module]`)}))`, `${moduleId} module picker`)
  await evaluate(`(()=>{
    const items=[...document.querySelectorAll(${selector(`${root} [data-sentence-popover=module] [data-sentence-module=${JSON.stringify(moduleId)}]`)})]
    const item=items.at(-1)
    if(!item)throw new Error('missing module '+${selector(moduleId)})
    item.click()
  })()`)
  await delay(160)
  let draft = await readDraft(root)
  let graph = draft.gameplayModules.entries.code.graph
  let statement = [...(graph.body || [])].reverse().find(item => item?.module === moduleId)
  assert.ok(statement, `module ${moduleId} must be inserted from the picker`)
  if (version && String(statement.version) !== String(version)) {
    await click(`${root} [data-sentence-module-editor=${selector(statement.id)}]`)
    await until(`Boolean(document.querySelector(${selector(`${root} [data-sentence-inline-editor=${statement.id}]`)}))`, `${moduleId} inspector`)
    await evaluate(`(()=>{
      const panel=document.querySelector(${selector(`${root} [data-sentence-inline-editor=${statement.id}]`)})
      const select=panel?.querySelector('[data-sentence-module-select]')
      if(!select)throw new Error('missing module version selector for '+${selector(moduleId)})
      const expected=${selector(`${moduleId}\0${version}`)}
      if(select.value!==expected){select.value=expected;select.dispatchEvent(new Event('change',{bubbles:true}))}
    })()`)
    await delay(160)
    draft = await readDraft(root)
    graph = draft.gameplayModules.entries.code.graph
    statement = graph.body.find(item => item?.id === statement.id)
  }
  assert.equal(String(statement.version), String(version || statement.version), `${moduleId} version`)
  return statement.id
}

async function applySlotExpression(root, statementId, name, source) {
  const slot = `${statementId}:input:${name}`
  await click(`${root} [data-sentence-slot-editor=${selector(slot)}]`)
  await until(`Boolean(document.querySelector(${selector(`${root} [data-sentence-author-expression=${JSON.stringify(name)}] .ei-editor`)}))`, `${name} expression editor`)
  await applyAuthorExpression(name, source, root)
}

function decodeTypeParameter(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(trimmed) : value
}

const checks = []
const screenshots = []
async function check(name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, ok: true, detail })
    return detail
  } catch (error) {
    const diagnostic = { name, ok: false, error: error?.stack || String(error) }
    try {
      diagnostic.dom = await evaluate("JSON.stringify({skills:document.querySelector('#skills-detail')?.innerHTML?.slice(0, 12000)||'',cards:document.querySelector('#cards-detail')?.innerHTML?.slice(0, 30000)||''})")
    } catch {}
    checks.push(diagnostic)
    // Preserve the first failing assertion. Continuing to another document
    // with a dirty fixture would block on an unrelated native discard dialog.
    throw error
  }
}

const report = {
  task: 'RED-252 flat Chinese sentence UI',
  role: 'real Electron regression verification',
  project,
  sourceProject: root,
  viewport: { width: 1487, height: 1058 },
  checks,
  screenshots,
}

try {
  await connect()
  await cdpCall('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })
  await until("Boolean(window.SkillSentenceEditor && window.ContentGraphCore && window.SentenceTemplates)", 'production sentence editor globals')

  await check('Fireball wide default uses one modern inspector and hides technical row chrome', async () => {
    await openSkill('fireball')
    const state = await evaluate(`(()=>{
      const root=document.querySelector('#skills-detail [data-sentence-editor]')
      const visible=e=>{if(!e)return false;const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length>0}
      const borderNodes=[...document.querySelectorAll('#skills-detail .sentence-generic-step,#skills-detail .sentence-generic-branch,#skills-detail .sentence-row-expression')]
      const visibleSteps=[...document.querySelectorAll('#skills-detail [data-sentence-node]')].filter(visible).map(node=>node.dataset.sentenceNode)
      const damageRow=document.querySelector('#skills-detail [data-sentence-node="damage"]')
      return {
        editor:Boolean(root),
        inspectorCount:document.querySelectorAll('#skills-detail [data-sentence-inspector]').length,
        visibleInspectors:[...document.querySelectorAll('#skills-detail [data-sentence-inspector]')].filter(visible).length,
        inspectorScroll:[...document.querySelectorAll('#skills-detail [data-sentence-inspector]')].filter(node=>node.hasAttribute('data-sentence-scroll')).length,
        previewsOutsideInspector:[...document.querySelectorAll('#skills-detail .sentence-preview')].filter(node=>!node.closest('[data-sentence-inspector]')).length,
        visibleDescriptions:[...document.querySelectorAll('#skills-detail .sentence-row-description')].filter(visible).length,
        visibleOutputs:[...document.querySelectorAll('#skills-detail .sentence-output-label')].filter(visible).length,
        visibleRowToolbars:[...document.querySelectorAll('#skills-detail .sentence-row-actions')].filter(visible).length,
        rowMenus:document.querySelectorAll('#skills-detail [data-sentence-row-menu]').length,
        menuSummaries:document.querySelectorAll('#skills-detail [data-sentence-row-menu] > summary').length,
        visibleSteps,
        damageText:damageRow?.textContent||'',
        nestedBorders:borderNodes.map(node=>({className:node.className,border:getComputedStyle(node).border,top:getComputedStyle(node).borderTopWidth,right:getComputedStyle(node).borderRightWidth,bottom:getComputedStyle(node).borderBottomWidth,left:getComputedStyle(node).borderLeftWidth})),
        sentenceText:document.querySelector('#skills-detail [data-sentence-graph-summary]')?.textContent||document.querySelector('#skills-detail .sentence-effects')?.textContent||'',
      }
    })()`)
    fs.writeFileSync(path.join(evidence, 'fireball-wide-state.json'), JSON.stringify(state, null, 2) + '\n')
    assert.equal(state.editor, true)
    assert.equal(state.inspectorCount, 1)
    assert.equal(state.visibleInspectors, 1)
    assert.equal(state.inspectorScroll, 1, 'the inspector must participate in scroll-offset restoration')
    assert.equal(state.previewsOutsideInspector, 0)
    assert.equal(state.visibleDescriptions, 0)
    assert.equal(state.visibleOutputs, 0)
    assert.equal(state.visibleRowToolbars, 0)
    assert.ok(state.rowMenus > 0, 'row operations must have a keyboard reachable more menu')
    assert.equal(state.menuSummaries, state.rowMenus)
    assert.equal(state.visibleSteps.includes('attack'), false, JSON.stringify(state.visibleSteps))
    assert.equal(state.visibleSteps.includes('power'), false, JSON.stringify(state.visibleSteps))
    assert.equal(state.visibleSteps.includes('amount'), false, JSON.stringify(state.visibleSteps))
    assert.match(state.damageText, /当前棋子\.攻击力.*当前技能\.倍率/)
    for (const item of state.nestedBorders) {
      assert.equal(item.top, '0px', JSON.stringify(item))
      assert.equal(item.right, '0px', JSON.stringify(item))
      assert.equal(item.bottom, '0px', JSON.stringify(item))
      assert.equal(item.left, '0px', JSON.stringify(item))
    }
    assert.match(state.sentenceText, /造成|伤害/)
    screenshots.push(await screenshot('fireball-wide-default.png'))
    return { inspectorCount: state.inspectorCount, rowMenus: state.rowMenus, sentenceText: state.sentenceText.slice(0, 240) }
  })

  await check('Fireball damage amount edits only that input in the right inspector through the shared expression editor', async () => {
    const slot = await evaluate(`(()=>{const row=document.querySelector('#skills-detail [data-sentence-node="damage"]');const amount=row?.querySelector('[data-sentence-slot-editor][data-sentence-slot-name="amount"]');return {selector:amount?.getAttribute('data-sentence-slot-editor')||'',text:amount?.textContent||'',row:Boolean(row)}})()`)
    assert.ok(slot.row, 'real Fireball damage row must be present')
    assert.ok(slot.selector, `real Fireball damage amount slot missing: ${JSON.stringify(slot)}`)
    await click(`#skills-detail [data-sentence-slot-editor=${JSON.stringify(slot.selector)}]`)
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor]'))", 'amount inspector editor')
    const panel = await evaluate(`(()=>{const inspector=document.querySelector('#skills-detail [data-sentence-inspector]');const editor=inspector?.querySelector('[data-sentence-inline-editor]');return {editor:editor?.dataset.sentenceInlineEditor||'',slot:editor?.dataset.sentenceSlotEditor||'',moduleSelect:Boolean(editor?.querySelector('[data-sentence-module-select]')),inputs:[...editor?.querySelectorAll('[data-sentence-module-input]')||[]].map(node=>node.dataset.sentenceModuleInput),parameters:[...editor?.querySelectorAll('[data-sentence-module-parameter]')||[]].map(node=>node.dataset.sentenceModuleParameter),editorOutside:document.querySelectorAll('#skills-detail [data-sentence-inline-editor]').length-(inspector?inspector.querySelectorAll('[data-sentence-inline-editor]').length:0)}})()`)
    fs.writeFileSync(path.join(evidence, 'fireball-amount-inspector.json'), JSON.stringify(panel, null, 2) + '\n')
    assert.equal(panel.editor, 'damage')
    assert.equal(panel.moduleSelect, false)
    assert.equal(panel.editorOutside, 0)
    assert.ok(panel.slot.includes('amount') || panel.inputs.includes('amount'), JSON.stringify(panel))

    const before = await readDraft()
    const beforeDamage = before.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'damage')
    const beforeStable = JSON.stringify({ source: beforeDamage.inputs?.source, target: beforeDamage.inputs?.target, parameters: beforeDamage.parameters })
    // Structural slots now use the same typed expression input as every
    // other author field. Enter a nested expression directly, then edit that
    // expression in place; no legacy module chooser is involved.
    await applyAuthorExpression('amount', 'amount_value * (attack_value + 2)')
    let edited = await readDraft()
    let damage = edited.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'damage')
    assert.equal(JSON.stringify({ source: damage.inputs?.source, target: damage.inputs?.target, parameters: damage.parameters }), beforeStable)
    assert.equal(damage.inputs?.amount?.kind, 'output')
    const firstAuthoredIds = damage.layout?.authorExpressions?.amount?.nodes || []
    assert.ok(firstAuthoredIds.length >= 2, 'nested expression must lower to owned graph nodes')
    const firstAuthored = firstAuthoredIds.map(id => edited.gameplayModules.entries.code.graph.body.find(statement => statement.id === id)).filter(Boolean)
    assert.ok(firstAuthored.some(statement => statement.module === 'math.multiply'))
    assert.ok(firstAuthored.some(statement => statement.module === 'math.add'))

    await click(`#skills-detail [data-sentence-slot-editor=${JSON.stringify(slot.selector)}]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-author-expression="amount"]'))`, 'reopened amount expression editor')
    await applyAuthorExpression('amount', 'amount_value * (attack_value + 12)')
    edited = await readDraft()
    damage = edited.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'damage')
    assert.equal(damage.layout?.authorExpressions?.amount?.source, 'amount_value * (attack_value + 12)')
    const editedAuthoredIds = damage.layout?.authorExpressions?.amount?.nodes || []
    assert.ok(editedAuthoredIds.length >= 2, 'edited expression must retain owned graph nodes')
    const editedAuthored = editedAuthoredIds.map(id => edited.gameplayModules.entries.code.graph.body.find(statement => statement.id === id)).filter(Boolean)
    assert.ok(editedAuthored.some(statement => statement.module === 'math.multiply'))
    assert.ok(editedAuthored.some(statement => statement.module === 'math.add'))
    assert.equal(JSON.stringify({ source: damage.inputs?.source, target: damage.inputs?.target, parameters: damage.parameters }), beforeStable)
    screenshots.push(await screenshot('fireball-amount-inspector.png'))

    await saveCurrent()
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'fireball.json'), 'utf8'))
    const persistedDamage = persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'damage')
    assert.equal(persistedDamage.layout?.authorExpressions?.amount?.source, 'amount_value * (attack_value + 12)')
    const persistedAuthored = (persistedDamage.layout?.authorExpressions?.amount?.nodes || [])
      .map(id => persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === id)).filter(Boolean)
    assert.ok(persistedAuthored.some(statement => statement.module === 'math.multiply'))
    assert.ok(persistedAuthored.some(statement => statement.module === 'math.add'))
    assert.deepEqual(persisted.editorFlatSentenceUnknown, fireball.editorFlatSentenceUnknown)
    await openSkill('fireball')
    const reopened = await readDraft()
    const reopenedDamage = reopened.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'damage')
    assert.equal(reopenedDamage.layout?.authorExpressions?.amount?.source, 'amount_value * (attack_value + 12)')
    const reopenedAuthored = (reopenedDamage.layout?.authorExpressions?.amount?.nodes || [])
      .map(id => reopened.gameplayModules.entries.code.graph.body.find(statement => statement.id === id)).filter(Boolean)
    assert.ok(reopenedAuthored.some(statement => statement.module === 'math.multiply'))
    assert.ok(reopenedAuthored.some(statement => statement.module === 'math.add'))
    assert.deepEqual(reopened.editorFlatSentenceUnknown, fireball.editorFlatSentenceUnknown)
    return { slot, panel, authoredIds: reopenedDamage.layout?.authorExpressions?.amount?.nodes || [], amount: reopenedDamage.inputs.amount, preservedUnknown: reopened.editorFlatSentenceUnknown }
  })

  await check('Choice v3 infers typed map values and synchronizes the single/multi return shape', async () => {
    await openSkill('fireball')
    await click('#skills-detail [data-sentence-add-effect]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))", 'choice v3 module picker')
    await evaluate(`(()=>{const items=[...document.querySelectorAll('#skills-detail [data-sentence-module="author.choice.option"]')];const item=items.at(-1);if(!item)throw new Error('missing author.choice.option module');item.click()})()`)
    await delay(160)
    let draft = await readDraft()
    let graph = draft.gameplayModules.entries.code.graph
    const choice = graph.body.find(statement => statement.module === 'author.choice.option')
    assert.ok(choice, 'choice statement must be created from the module picker')
    const choiceId = choice.id
    if (String(choice.version) !== '3') {
      await click(`#skills-detail [data-sentence-module-editor=${JSON.stringify(choiceId)}]`)
      await evaluate(`(()=>{const select=document.querySelector('#skills-detail [data-sentence-inline-editor=${JSON.stringify(choiceId)}] [data-sentence-module-select]');if(!select)throw new Error('missing choice module version selector');const expected=${JSON.stringify(`author.choice.option\0${'3'}`)};if(select.value!==expected){select.value=expected;select.dispatchEvent(new Event('change',{bubbles:true}))}})()`)
      await delay(160)
    }
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    assert.equal(graph.body.find(statement => statement.id === choiceId)?.version, '3', 'the real picker must expose choice v3')

    await click(`#skills-detail [data-sentence-slot-editor=${JSON.stringify(`${choiceId}:input:options`)}]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-author-expression="options"] .ei-editor'))`, 'choice v3 options expression editor')
    await applyAuthorExpression('options', '映射({"红", "蓝"}, {1, 2})')
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    let selected = graph.body.find(statement => statement.id === choiceId)
    assert.equal(selected.version, '3')
    assert.deepEqual(JSON.parse(selected.parameters.optionsType), { kind: 'map', key: 'string', value: 'number' })
    assert.equal(decodeTypeParameter(selected.parameters.valueType), 'number')

    await click(`#skills-detail [data-sentence-module-editor=${JSON.stringify(choiceId)}]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=${JSON.stringify(choiceId)}]'))`, 'choice v3 inspector')
    assert.equal(await evaluate(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=${JSON.stringify(choiceId)}] [data-sentence-module-parameter="optionsType"]'))`), false, 'optionsType stays an internal derived parameter')
    await setEnumParameter(choiceId, 'selectionMode', 'multi')
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    selected = graph.body.find(statement => statement.id === choiceId)
    assert.deepEqual(decodeTypeParameter(selected.parameters.valueType), { kind: 'list', element: 'number' }, 'multi choice returns a typed tuple')

    await click(`#skills-detail [data-sentence-module-editor=${JSON.stringify(choiceId)}]`)
    await setEnumParameter(choiceId, 'selectionMode', 'single')
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    selected = graph.body.find(statement => statement.id === choiceId)
    assert.equal(decodeTypeParameter(selected.parameters.valueType), 'number', 'switching back restores the scalar return type')

    await saveCurrent()
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'fireball.json'), 'utf8'))
    const persistedChoice = persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === choiceId)
    assert.equal(persistedChoice.version, '3')
    assert.equal(decodeTypeParameter(persistedChoice.parameters.valueType), 'number')
    await openSkill('fireball')
    const reopened = await readDraft()
    const reopenedChoice = reopened.gameplayModules.entries.code.graph.body.find(statement => statement.id === choiceId)
    assert.equal(reopenedChoice.version, '3')
    assert.equal(JSON.parse(reopenedChoice.parameters.optionsType).value, 'number')
    assert.equal(decodeTypeParameter(reopenedChoice.parameters.valueType), 'number')
    return { choiceId, optionsType: decodeTypeParameter(reopenedChoice.parameters.optionsType), valueType: decodeTypeParameter(reopenedChoice.parameters.valueType) }
  })

  await check('Authors a typed code block through the Cluster sentence editor and reopens the saved definition', async () => {
    await openSkill('fireball')
    assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-skill-cluster-editor]'))"), true, 'code block authoring must run inside the Cluster editor')
    await click('#skills-detail [data-sentence-add-effect]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))", 'code block module picker')
    await evaluate(`(()=>{const item=document.querySelector('#skills-detail [data-sentence-popover=module] [data-sentence-module="code-block.invoke"]');if(!item)throw new Error('missing code-block.invoke module');item.click()})()`)
    await delay(160)
    let draft = await readDraft()
    let graph = draft.gameplayModules.entries.code.graph
    const codeBlock = graph.body.find(statement => statement.module === 'code-block.invoke')
    assert.ok(codeBlock, 'code-block.invoke must be inserted from the author module picker')
    const codeBlockId = codeBlock.id

    await click(`#skills-detail [data-sentence-slot-editor=${JSON.stringify(`${codeBlockId}:input:block`)}]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}]'))`, 'code block definition form')
    assert.equal(await evaluate(`Boolean(document.querySelector('#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}] [data-sentence-code-block-id]'))`), true, 'code block form must expose a typed identifier field')
    assert.equal(await evaluate(`Boolean(document.querySelector('#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}] [data-sentence-code-block-argument-type]'))`), true, 'code block form must expose argument type controls')
    assert.equal(await evaluate(`Boolean(document.querySelector('#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}] [data-sentence-code-block-output-type]'))`), true, 'code block form must expose return type controls')
    await evaluate(`(()=>{const root=document.querySelector('#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}]');const id=root?.querySelector('[data-sentence-code-block-id]');if(!id)throw new Error('missing code block id field');id.value='ui-block';id.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click(`#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}] [data-sentence-code-block-create]`)
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    let selected = graph.body.find(statement => statement.id === codeBlockId)
    assert.equal(selected.module, 'code-block.invoke')
    assert.equal(selected.inputs.block.kind, 'output')
    assert.match(selected.layout?.authorExpressions?.block?.source || '', /ui-block/)
    assert.equal(decodeTypeParameter(selected.parameters.blockType).kind, 'record')

    await click(`#skills-detail [data-sentence-slot-editor=${JSON.stringify(`${codeBlockId}:input:args`)}]`)
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression=\"args\"] .ei-editor'))", 'code block arguments expression editor')
    await applyAuthorExpression('args', '{"target": "piece-1"}')
    await click(`#skills-detail [data-sentence-module-editor=${JSON.stringify(codeBlockId)}]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=${JSON.stringify(codeBlockId)}]'))`, 'code block inspector')
    assert.equal(await evaluate(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=${JSON.stringify(codeBlockId)}] [data-sentence-module-parameter="blockType"]'))`), false, 'blockType remains an internal inferred parameter')
    assert.equal(await evaluate(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=${JSON.stringify(codeBlockId)}] [data-sentence-module-parameter="argsType"]'))`), false, 'argsType remains an internal inferred parameter')

    // The block body mounts the same normal sentence editor used by the outer
    // flow.  Authors can compose calls, conditions, loops and returns through
    // the ordinary module/structure controls instead of pasting another AST.
    await until(`Boolean(document.querySelector('#skills-detail [data-code-block-body-editor=${JSON.stringify(codeBlockId)}]'))`, 'code block typed body editor')
    const bodyRoot = `#skills-detail [data-code-block-body-normal-editor=${JSON.stringify(codeBlockId)}]`
    await click(`${bodyRoot} [data-sentence-add-effect]`)
    await until(`Boolean(document.querySelector(${JSON.stringify(`${bodyRoot} [data-sentence-popover=module]`)}))`, 'code block body module picker')
    await until(`Boolean(document.querySelector(${JSON.stringify(`${bodyRoot} [data-sentence-module="math.add"]`)}))`, 'code block body math module')
    await click(`${bodyRoot} [data-sentence-module="math.add"]`)
    await delay(160)
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    selected = graph.body.find(statement => statement.id === codeBlockId)
    const bodyAfterModule = selected.layout?.authorExpressions?.block?.data?.graph?.body || []
    const mathAddAfterPicker = bodyAfterModule.find(statement => statement.module === 'math.add')
    assert.ok(mathAddAfterPicker, 'normal body editor must write a registered typed module into the block definition metadata')
    assert.ok(bodyAfterModule.some(statement => statement.kind === 'return'), 'normal body editor keeps the typed return statement')

    // The structural controls are the ordinary editor controls too.  Add an
    // if and a foreach so the smoke catches a regression where code blocks
    // only allow the first few call modules.
    await click(`${bodyRoot} [data-sentence-add-condition]`)
    await delay(160)
    await click(`${bodyRoot} [data-sentence-add-structured="root:foreach"]`)
    await delay(160)
    draft = await readDraft()
    selected = draft.gameplayModules.entries.code.graph.body.find(statement => statement.id === codeBlockId)
    const bodyAfterStructures = selected.layout?.authorExpressions?.block?.data?.graph?.body || []
    assert.ok(bodyAfterStructures.some(statement => statement.kind === 'if'), 'normal body editor must support if statements')
    assert.ok(bodyAfterStructures.some(statement => statement.kind === 'foreach'), 'normal body editor must support foreach statements')

    // Reopen the nested statement inspector and edit its typed number input.
    const mathAddId = bodyAfterStructures.find(statement => statement.module === 'math.add')?.id
    assert.ok(mathAddId, 'math.add body statement has an id')
    await click(`${bodyRoot} [data-sentence-module-editor=${JSON.stringify(mathAddId)}]`)
    await until(`Boolean(document.querySelector(${JSON.stringify(`${bodyRoot} [data-sentence-inline-editor=${mathAddId}] [data-sentence-author-expression="left"] .ei-editor`)}))`, 'code block nested number expression')
    await applyAuthorExpression('left', '3', bodyRoot)
    await delay(160)
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    selected = graph.body.find(statement => statement.id === codeBlockId)
    const bodyAfterInput = selected.layout?.authorExpressions?.block?.data?.graph?.body || []
    const mathAddAfterInput = bodyAfterInput.find(statement => statement.id === mathAddId)
    assert.equal(mathAddAfterInput?.inputs?.left?.value, 3, 'nested typed literal should be persisted')

    await click(`#skills-detail [data-sentence-slot-editor=${JSON.stringify(`${codeBlockId}:input:block`)}]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}]'))`, 'code block edit definition form')
    const sourceBeforeRename = selected.layout?.authorExpressions?.block?.source || ''
    const editedSource = sourceBeforeRename.replace('ui-block', 'ui-block-edited')
    await evaluate(`(()=>{const root=document.querySelector('#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}]');const id=root?.querySelector('[data-sentence-code-block-id]');if(!id)throw new Error('missing code block id field');id.value='ui-block-edited';id.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click(`#skills-detail [data-sentence-code-block-definition=${JSON.stringify(codeBlockId)}] [data-sentence-code-block-create]`)
    draft = await readDraft()
    graph = draft.gameplayModules.entries.code.graph
    selected = graph.body.find(statement => statement.id === codeBlockId)
    assert.match(selected.layout?.authorExpressions?.block?.source || '', /ui-block-edited/)
    assert.equal(decodeTypeParameter(selected.parameters.argsType).kind, 'record')

    await saveCurrent()
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'fireball.json'), 'utf8'))
    const persistedCodeBlock = persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === codeBlockId)
    assert.match(persistedCodeBlock.layout?.authorExpressions?.block?.source || '', /ui-block-edited/)
    assert.ok(persistedCodeBlock.layout?.authorExpressions?.block?.data?.graph?.body?.some(statement => statement.module === 'math.add'))
    assert.equal(persistedCodeBlock.inputs.block.kind, 'output')
    await openSkill('fireball')
    const reopened = await readDraft()
    const reopenedCodeBlock = reopened.gameplayModules.entries.code.graph.body.find(statement => statement.id === codeBlockId)
    assert.equal(reopenedCodeBlock.module, 'code-block.invoke')
    assert.match(reopenedCodeBlock.layout?.authorExpressions?.block?.source || '', /ui-block-edited/)
    assert.equal(reopenedCodeBlock.layout?.authorExpressions?.block?.data?.graph?.body?.find(statement => statement.module === 'math.add')?.inputs?.left?.value, 3)
    assert.equal(reopenedCodeBlock.layout?.authorExpressions?.args?.source, '{"target": "piece-1"}')
    return { codeBlockId, blockType: decodeTypeParameter(reopenedCodeBlock.parameters.blockType), argsType: decodeTypeParameter(reopenedCodeBlock.parameters.argsType) }
  })

  await check('Creates a card from the blank authoring entry and composes choice, block, hand extension, target, damage and heal steps', async () => {
    const cardId = 'flat-ui-armor-assembly'
    await evaluate("document.querySelector('[data-tab=cards]').click()")
    await click('[data-new-document="cards"]')
    await until("document.querySelector('#create-dialog')?.open === true", 'new card dialog')
    await evaluate(`(()=>{
      const id=document.querySelector('#create-id');const name=document.querySelector('#create-name')
      if(!id||!name)throw new Error('new card fields are unavailable')
      id.value=${selector(cardId)};name.value='护甲组装 UI 验收'
      document.querySelector('#create-form')?.requestSubmit()
    })()`)
    await until("Boolean(document.querySelector('#cards-detail [data-sentence-editor]'))", 'blank card sentence editor')
    await until("Boolean(document.querySelector('#cards-detail [data-sentence-graph-summary]')||document.querySelector('#cards-detail [data-sentence-step]'))", 'blank card sentence projection')

    let draft = await readDraft('#cards-detail')
    assert.equal(draft.id, cardId)
    assert.equal(draft.gameplayModules.entries.code.graph.surface, 'card')
    const inserted = []
    const currentCardId = await addModule('#cards-detail', 'ref.current-card', '1')
    inserted.push(currentCardId)

    const choiceId = await addModule('#cards-detail', 'author.choice.option', '3')
    await applySlotExpression('#cards-detail', choiceId, 'options', '映射({"攻击", "防御"}, {1, 2})')
    draft = await readDraft('#cards-detail')
    let graph = draft.gameplayModules.entries.code.graph
    let choice = graph.body.find(statement => statement.id === choiceId)
    assert.equal(choice.version, '3')
    assert.deepEqual(decodeTypeParameter(choice.parameters.optionsType), { kind: 'map', key: 'string', value: 'number' })
    assert.equal(decodeTypeParameter(choice.parameters.valueType), 'number')

    const targetId = await addModule('#cards-detail', 'author.choice.target-piece', '1')

    const damageId = await addModule('#cards-detail', 'author.effect.damage', '2')
    await applySlotExpression('#cards-detail', damageId, 'source', '当前棋子')
    await applySlotExpression('#cards-detail', damageId, 'target', '目标')
    await applySlotExpression('#cards-detail', damageId, 'amount', '1')

    const healId = await addModule('#cards-detail', 'author.effect.heal', '2')
    await applySlotExpression('#cards-detail', healId, 'source', '当前棋子')
    await applySlotExpression('#cards-detail', healId, 'target', '目标')
    await applySlotExpression('#cards-detail', healId, 'amount', '2')

    // The ordinary unified extension module must accept the concrete current
    // hand instance.  The editor infers the hidden entityKind from this typed
    // reference; authors only fill the entity, name, type and initial value.
    const extensionId = await addModule('#cards-detail', 'extension.declare-instance', '1')
    const slot = `${extensionId}:input:entity`
    await click(`#cards-detail [data-sentence-slot-editor=${selector(slot)}]`)
    await until(`Boolean(document.querySelector(${selector(`#cards-detail [data-sentence-author-expression="entity"] .ei-editor`)}))`, 'current hand extension editor')
    await applyAuthorExpression('entity', '当前手牌', '#cards-detail')
    await click(`#cards-detail [data-sentence-module-editor=${selector(extensionId)}]`)
    await until(`Boolean(document.querySelector('#cards-detail [data-sentence-inline-editor=${selector(extensionId)}]'))`, 'instance extension inspector')
    await evaluate(`(()=>{const field=document.querySelector('#cards-detail [data-sentence-inline-editor=${selector(extensionId)}] [data-sentence-module-parameter="name"] input');if(!field)throw new Error('instance extension name field missing');field.value='armor';field.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await delay(120)
    await applySlotExpression('#cards-detail', extensionId, 'value', '1')
    draft = await readDraft('#cards-detail')
    graph = draft.gameplayModules.entries.code.graph
    const handStatement = graph.body.find(statement => statement.id === extensionId)
    const handExtension = {
      moduleId: extensionId,
      accepted: true,
      entityKind: handStatement?.parameters?.entityKind,
      entity: handStatement?.inputs?.entity,
      name: handStatement?.parameters?.name,
      valueType: handStatement?.parameters?.valueType,
    }
    await click(`#cards-detail [data-sentence-slot-editor=${selector(slot)}]`)
    await until(`Boolean(document.querySelector(${selector(`#cards-detail [data-sentence-author-expression="entity"] .ei-editor`)}))`, 'reopen current hand expression editor')
    const handTypeLabel = await evaluate(`document.querySelector('#cards-detail [data-sentence-author-expression="entity"] .sentence-author-expression-type')?.textContent || ''`)
    assert.equal(handTypeLabel, '手牌实例', handTypeLabel)
    await click('#cards-detail [data-sentence-apply-expression="entity"]')
    handExtension.typeLabel = handTypeLabel
    const handEntitySource = graph.body.find(statement => statement.id === handExtension.entity?.node)
    assert.equal(handExtension.entityKind, 'card', JSON.stringify(handExtension))
    assert.equal(handExtension.entity?.kind, 'output', JSON.stringify(handExtension))
    assert.equal(handExtension.entity?.port, 'card', JSON.stringify(handExtension))
    assert.equal(handEntitySource?.module, 'ref.current-card', JSON.stringify({ handExtension, handEntitySource }))
    fs.writeFileSync(path.join(evidence, 'author-card-hand-extension.json'), JSON.stringify(handExtension, null, 2) + '\n')
    screenshots.push(await screenshot('author-card-hand-extension.png'))

    const codeBlockId = await addModule('#cards-detail', 'code-block.invoke', '1')
    await click(`#cards-detail [data-sentence-slot-editor=${selector(`${codeBlockId}:input:block`)}]`)
    await until(`Boolean(document.querySelector('#cards-detail [data-sentence-code-block-definition=${selector(codeBlockId)}]'))`, 'card code block definition form')
    const definition = `#cards-detail [data-sentence-code-block-definition=${selector(codeBlockId)}]`
    await evaluate(`(()=>{const root=document.querySelector(${selector(definition)});const id=root?.querySelector('[data-sentence-code-block-id]');if(!id)throw new Error('card code block id field missing');id.value='ui-armor-block';id.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click(`${definition} [data-sentence-code-block-create]`)
    await applySlotExpression('#cards-detail', codeBlockId, 'args', '{"target": "piece-1"}')
    // Add a second return value while editing the existing typed definition.
    // Keeping creation and signature extension as two ordinary form actions
    // also mirrors how authors incrementally evolve a block in the workbench.
    await click(`#cards-detail [data-sentence-slot-editor=${selector(`${codeBlockId}:input:block`)}]`)
    await until(`Boolean(document.querySelector(${selector(definition)}))`, 'card code block edit definition form')
    await evaluate(`(()=>{const root=document.querySelector(${selector(definition)});root.querySelector('[data-sentence-code-block-add-output]')?.click();const outputs=[...root.querySelectorAll('[data-sentence-code-block-output]')];const second=outputs.at(-1)?.querySelector('[data-sentence-code-block-output-name]');if(!second)throw new Error('card code block second return field missing');second.value='detail';second.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click(`${definition} [data-sentence-code-block-create]`)
    await click(`#cards-detail [data-sentence-module-editor=${selector(codeBlockId)}]`)
    const bodyRoot = `#cards-detail [data-code-block-body-normal-editor=${selector(codeBlockId)}]`
    await until(`Boolean(document.querySelector(${selector(bodyRoot)}))`, 'card code block body editor')
    await click(`${bodyRoot} [data-sentence-add-structured="root:while"]`)
    await delay(160)

    draft = await readDraft('#cards-detail')
    graph = draft.gameplayModules.entries.code.graph
    const cardCodeBlock = graph.body.find(statement => statement.id === codeBlockId)
    const blockGraph = cardCodeBlock.layout?.authorExpressions?.block?.data?.graph
    assert.equal(cardCodeBlock.module, 'code-block.invoke')
    assert.ok(Array.isArray(blockGraph?.outputs) && blockGraph.outputs.length >= 2, 'code block must expose multiple return values')
    assert.ok(blockGraph.body.some(statement => statement.kind === 'while'), 'code block body must expose while through the normal editor')
    inserted.push(choiceId, targetId, damageId, healId, codeBlockId)
    await saveEditor('#cards-detail')
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'cards', `${cardId}.json`), 'utf8'))
    const exportedGraph = persisted.gameplayModules.entries.code.graph
    assert.equal(exportedGraph.surface, 'card')
    assert.ok(exportedGraph.body.some(statement => statement.id === damageId))
    assert.ok(exportedGraph.body.some(statement => statement.id === healId))
    const compiled = await evaluate(`(()=>{const value=JSON.parse(document.querySelector('#cards-detail [data-json-source]').value);const graph=window.ContentGraphCore.getGameplayModuleGraph(value,'code');const result=window.ContentGraphCore.compileGameplayModuleGraph(graph,window.ContentGraphCore.GAMEPLAY_MODULE_REGISTRY);return {surface:result.surface,codeLength:result.code.length,bodyLength:graph.body.length,blockOutputs:graph.body.find(statement=>statement.id===${selector(codeBlockId)})?.layout?.authorExpressions?.block?.data?.graph?.outputs?.length||0}})()`)
    assert.equal(compiled.surface, 'card')
    assert.ok(compiled.codeLength > 0)
    await openCard(cardId)
    const reopened = await readDraft('#cards-detail')
    const reopenedGraph = reopened.gameplayModules.entries.code.graph
    assert.equal(reopenedGraph.surface, 'card')
    assert.ok(reopenedGraph.body.some(statement => statement.id === choiceId))
    assert.ok(reopenedGraph.body.some(statement => statement.id === codeBlockId))
    screenshots.push(await screenshot('author-card-armor-assembly.png'))
    return { cardId, inserted, handExtension, compiled, persistedBodyLength: exportedGraph.body.length, reopened: true }
  })

  await check('Current skill references, module categories and status icon entry remain reachable', async () => {
    await openSkill('flat-sentence-module-version-smoke', { reuseCurrent: true })
    await click('#skills-detail [data-sentence-add-effect]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))", 'current skill module picker')
    const picker = await evaluate(`(()=>{
      const root=document.querySelector('#skills-detail [data-sentence-popover=module]')
      const current=[...root.querySelectorAll('[data-sentence-module]')].find(item=>item.dataset.sentenceModule==='ref.current-skill')
      const categories=[...root.querySelectorAll('[data-sentence-module-category]')].map(item=>({id:item.dataset.sentenceModuleCategory,disabled:item.disabled,pressed:item.getAttribute('aria-pressed')}))
      return {currentSkill:Boolean(current),currentSkillText:current?.textContent||'',categories}
    })()`)
    fs.writeFileSync(path.join(evidence, 'current-skill-category-picker-state.json'), JSON.stringify(picker, null, 2) + '\n')
    assert.equal(picker.currentSkill, true, JSON.stringify(picker))
    assert.ok(picker.categories.some(item => item.id === 'data' && !item.disabled), JSON.stringify(picker))
    await click('#skills-detail [data-sentence-popover=module] [data-sentence-module-category="data"]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module] [data-sentence-module=\"ref.current-skill\"]'))", 'current skill data category')
    await click('#skills-detail [data-sentence-popover=module] .sentence-popover-close')

    const statusTab = await evaluate(`(()=>{const tab=document.querySelector('#skills-detail [data-skill-cluster-member-tab="status"]');return {present:Boolean(tab),disabled:Boolean(tab?.disabled),label:tab?.textContent||''}})()`)
    assert.equal(statusTab.present, true, JSON.stringify(statusTab))
    assert.equal(statusTab.disabled, false, JSON.stringify(statusTab))
    await click('#skills-detail [data-skill-cluster-member-tab="status"]')
    await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-member=\"status:flat-ui-status\"]'))", 'status member row')
    await click('#skills-detail [data-skill-cluster-member="status:flat-ui-status"]')
    await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-status-field=iconPath]'))", 'status icon field')
    const status = await evaluate(`(()=>{const input=document.querySelector('#skills-detail [data-skill-cluster-status-field=iconPath]');const preview=document.querySelector('#skills-detail .skill-cluster-status-icon-preview');return {iconField:Boolean(input),iconValue:input?.value||'',placeholder:input?.getAttribute('placeholder')||'',preview:Boolean(preview),tab:document.querySelector('#skills-detail [data-skill-cluster-member-tab="status"]')?.textContent||''}})()`)
    assert.equal(status.iconField, true, JSON.stringify(status))
    assert.equal(status.preview, true, JSON.stringify(status))
    screenshots.push(await screenshot('current-skill-status-icon.png'))
    await click('#skills-detail [data-skill-cluster-member-tab="skill"]')
    return { picker, statusTab, status }
  })

  await check('The module picker writes generic piece field v2 while legacy field and comparison references survive', async () => {
    await openSkill('flat-sentence-module-version-smoke', { reuseCurrent: true })
    const seeded = await readDraft()
    const seededGraph = seeded.gameplayModules.entries.code.graph
    const seededComposite = seededGraph.composites.find(item => item.id === 'legacy-field-fixture')
    const seededLegacy = seededComposite?.body?.find(statement => statement.module === 'attribute.text')
    assert.equal(seededLegacy?.version, '1')
    assert.equal(seededLegacy?.parameters?.attribute, 'name')

    await click('#skills-detail [data-sentence-add-effect]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))", 'module picker')
    const pickerState = await evaluate(`(()=>{
      const picker=document.querySelector('#skills-detail [data-sentence-popover=module]')
      const options=[...picker?.querySelectorAll('[data-sentence-module]')||[]]
      return {
        textOptions:options.filter(item=>item.dataset.sentenceModule==='attribute.text').map(item=>({id:item.dataset.sentenceModule,text:item.textContent||''})),
        fieldOptions:options.filter(item=>item.dataset.sentenceModule==='piece.field').map(item=>({id:item.dataset.sentenceModule,text:item.textContent||'',title:item.title||''})),
        relationOptions:options.filter(item=>item.dataset.sentenceModule==='query.same-relation').map(item=>({id:item.dataset.sentenceModule,text:item.textContent||''})),
        alliedOptions:options.filter(item=>item.dataset.sentenceModule==='compare.allied-players').map(item=>({id:item.dataset.sentenceModule,text:item.textContent||''})),
      }
    })()`)
    fs.writeFileSync(path.join(evidence, 'module-version-picker-state.json'), JSON.stringify(pickerState, null, 2) + '\n')
    assert.equal(pickerState.textOptions.length, 0, JSON.stringify(pickerState))
    assert.ok(pickerState.fieldOptions.some(item => /存活/.test(item.title)), JSON.stringify(pickerState))
    assert.equal(pickerState.relationOptions.length, 0, JSON.stringify(pickerState))
    assert.equal(pickerState.alliedOptions.length, 0, JSON.stringify(pickerState))
    await evaluate(`(()=>{const options=[...document.querySelectorAll('#skills-detail [data-sentence-popover=module] [data-sentence-module="piece.field"]')];const item=options.find(node=>/存活/.test(node.title||''));if(!item)throw new Error('missing piece.field@2 picker option');item.scrollIntoView({block:'center',inline:'nearest'});item.click()})()`)

    const selected = await readDraft()
    const selectedGraph = selected.gameplayModules.entries.code.graph
    // The official Fireball also contains atomic field reads after migration.
    // Identify the newly inserted row by identity, not by assuming only the
    // two fixture fields existed before opening the picker.
    const seededFieldIds = new Set(seededGraph.body.filter(statement => statement.module === 'piece.field').map(statement => statement.id))
    const selectedV2 = selectedGraph.body.find(statement => statement.module === 'piece.field' && !seededFieldIds.has(statement.id))
    assert.equal(selectedV2?.version, '2', 'the visible standard picker option must insert piece.field@2')
    assert.ok(selectedV2, 'the picker must create a generic field read before its field is edited')
    // Generic insertion deliberately leaves ambiguous references unset. Pick
    // this parameter through the same shared expression slot the author uses
    // elsewhere in the flat sentence editor.
    await click(`#skills-detail [data-sentence-slot-editor=${JSON.stringify(`${selectedV2.id}:input:piece`)}]`)
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression=piece] .ei-editor'))", 'piece expression editor')
    await applyAuthorExpression('piece', 'source_piece')
    await click(`#skills-detail [data-sentence-module-editor=${JSON.stringify(selectedV2.id)}]`)
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=${JSON.stringify(selectedV2.id)}]'))`, 'piece field inspector')
    await setEnumParameter(selectedV2.id, 'field', 'faction')

    const selectedWithField = await readDraft()
    const selectedFieldGraph = selectedWithField.gameplayModules.entries.code.graph
    const selectedField = selectedFieldGraph.body.find(statement => statement.id === selectedV2.id)
    const selectedComparison = selectedFieldGraph.body.find(statement => statement.id === 'same-faction')
    assert.equal(selectedField?.version, '2')
    assert.deepEqual(selectedField?.parameters, { field: 'faction' })
    assert.deepEqual(selectedField?.inputs?.piece, { kind: 'output', node: 'source', port: 'piece' })
    assert.equal(selectedComparison?.module, 'compare.values')
    assert.deepEqual(selectedComparison?.parameters, { valueType: 'string', operator: '==' })
    assert.deepEqual(selectedComparison?.inputs, {
      left: output('source-faction', 'value'),
      right: output('target-faction', 'value'),
    })
    assert.equal(selectedFieldGraph.composites.find(item => item.id === 'legacy-field-fixture')?.body?.find(statement => statement.module === 'attribute.text')?.version, '1')

    screenshots.push(await screenshot('module-version-picker.png'))
    await saveCurrent()
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'flat-sentence-module-version-smoke.json'), 'utf8'))
    const persistedGraph = persisted.gameplayModules.entries.code.graph
    const persistedV2 = persistedGraph.body.find(statement => statement.id === selectedV2.id)
    const persistedLegacy = persistedGraph.composites.find(item => item.id === 'legacy-field-fixture')?.body?.find(statement => statement.module === 'attribute.text')
    assert.equal(persistedV2?.version, '2')
    assert.equal(persistedV2?.module, 'piece.field')
    assert.deepEqual(persistedV2?.parameters, { field: 'faction' })
    assert.deepEqual(persistedGraph.body.find(statement => statement.id === 'same-faction')?.inputs, {
      left: output('source-faction', 'value'),
      right: output('target-faction', 'value'),
    })
    assert.equal(persistedLegacy?.version, '1')
    assert.equal(persistedLegacy?.parameters?.attribute, 'name')
    assert.deepEqual(persisted.editorFlatSentenceUnknown, moduleVersionSmoke.editorFlatSentenceUnknown)

    await openSkill('flat-sentence-module-version-smoke')
    const reopened = await readDraft()
    const reopenedGraph = reopened.gameplayModules.entries.code.graph
    const reopenedV2 = reopenedGraph.body.find(statement => statement.id === selectedV2.id)
    const reopenedLegacy = reopenedGraph.composites.find(item => item.id === 'legacy-field-fixture')?.body?.find(statement => statement.module === 'attribute.text')
    assert.equal(reopenedV2?.module, 'piece.field', 'saved generic picker selection must survive reopen')
    assert.equal(reopenedV2?.version, '2', 'saved v2 picker selection must survive reopen')
    assert.deepEqual(reopenedV2?.parameters, { field: 'faction' }, 'saved field selection must survive reopen')
    assert.deepEqual(reopenedGraph.body.find(statement => statement.id === 'same-faction')?.inputs, {
      left: output('source-faction', 'value'),
      right: output('target-faction', 'value'),
    }, 'comparison references must survive reopen')
    assert.equal(reopenedLegacy?.version, '1', 'saved legacy v1 node must retain its stored version')
    assert.equal(reopenedLegacy?.parameters?.attribute, 'name', 'legacy field parameters must retain their stored value')
    assert.deepEqual(reopened.editorFlatSentenceUnknown, moduleVersionSmoke.editorFlatSentenceUnknown)
    const comparisonDisplay = await evaluate(`document.querySelector(${selector('#skills-detail [data-sentence-node="same-faction"]')})?.textContent || ''`)
    assert.match(comparisonDisplay, /当前棋子\.阵营\s*==\s*当前目标\.阵营/, comparisonDisplay)
    return {
      pickerState,
      selected: { id: selectedV2?.id, version: selectedField?.version, field: selectedField?.parameters?.field },
      persisted: { selectedModule: persistedV2?.module, selectedVersion: persistedV2?.version, selectedField: persistedV2?.parameters?.field, legacyVersion: persistedLegacy?.version },
      reopened: { selectedModule: reopenedV2?.module, selectedVersion: reopenedV2?.version, selectedField: reopenedV2?.parameters?.field, legacyVersion: reopenedLegacy?.version },
      comparisonDisplay,
    }
  })

  await check('A branch consumer can compose a typed expression without changing its root source', async () => {
    // Mount a second real editor in the browser with the production core. The
    // branch is deliberately built around Fireball's existing damage call so
    // its amount output is declared in the root scope and consumed from then.
    const source = JSON.stringify(readSkill('fireball'))
    const initial = await evaluate(`(()=>{
      const source=${source}
      const graph=JSON.parse(JSON.stringify(source.gameplayModules.entries.code.graph))
      const damageIndex=graph.body.findIndex(statement=>statement?.id==='damage')
      if(damageIndex<0)throw new Error('missing Fireball damage statement')
      // Keep the amount calculation at root, but move the complete suffix
      // beginning at damage into the same branch. The text/result/return
      // nodes after damage consume its output and must remain dominated by
      // the branch for the fixture to be a valid graph. Both branches return
      // the required action result so the editor's control-flow validator
      // does not reject the fixture as a possible fall-through.
      const branchBody=graph.body.splice(damageIndex)
      const branchIds=new Set(branchBody.map(statement=>statement.id))
      const elseBody=branchBody.map(statement=>{
        const clone=JSON.parse(JSON.stringify(statement))
        const rewrite=value=>{
          if(Array.isArray(value)){value.forEach(rewrite);return}
          if(!value||typeof value!=='object')return
          if(value.kind==='output'&&branchIds.has(value.node))value.node+='-else'
          Object.values(value).forEach(rewrite)
        }
        clone.id+='-else'
        rewrite(clone)
        return clone
      })
      graph.body.splice(damageIndex,0,{kind:'if',id:'lexical-if',condition:{kind:'literal',value:true},then:branchBody,else:elseBody})
      const draft={...source,id:'flat-lexical-fireball',gameplayModules:{...source.gameplayModules,entries:{...source.gameplayModules.entries,code:{...source.gameplayModules.entries.code,graph}}}}
      const host=document.createElement('div');host.id='red252-lexical-scope-fixture';host.style.width='900px';document.body.append(host)
      const state={draft,diagnostic:'',host,editor:null}
      state.editor=window.SkillSentenceEditor.mount(host,{core:window.ContentGraphCore,field:'code',root:{collection:'skills',id:draft.id},getDraft:()=>state.draft,onChange:next=>{state.draft=next},onDraftDiagnostic:message=>{state.diagnostic=message}})
      window.__red252LexicalFixture=state
      const branch=graph.body.find(statement=>statement?.id==='lexical-if')
      const amount=graph.body.find(statement=>statement?.id==='amount')
      const branchDamage=branch?.then?.find(statement=>statement?.id==='damage')
      return {branchIndex:graph.body.indexOf(branch),amountIndex:graph.body.indexOf(amount),amountInputs:amount?.inputs||null,damageAmount:branchDamage?.inputs?.amount||null,damageSlot:Boolean(host.querySelector('[data-sentence-slot-editor="damage:input:amount"]')),errors:[...host.querySelectorAll('.sentence-message.error')].map(node=>node.textContent||'')}
    })()`)
    assert.ok(initial.amountIndex >= 0 && initial.branchIndex > initial.amountIndex, JSON.stringify(initial))
    assert.deepEqual(initial.damageAmount, { kind: 'output', node: 'amount', port: 'value' })
    assert.equal(initial.damageSlot, true, JSON.stringify(initial))
    assert.deepEqual(initial.errors, [])

    try {
      await evaluate(`(()=>{const host=window.__red252LexicalFixture.host;const slot=host.querySelector('[data-sentence-slot-editor="damage:input:amount"]');if(!slot)throw new Error('missing branch damage amount slot');slot.click()})()`)
      await until("Boolean(window.__red252LexicalFixture.host.querySelector('[data-sentence-inspector] [data-sentence-inline-editor=\"damage\"]'))", 'branch damage amount editor')
      await until("Boolean(window.__red252LexicalFixture.host.querySelector('[data-sentence-author-expression=\"amount\"] .ei-editor'))", 'branch damage amount expression editor')
      await applyAuthorExpression('amount', 'amount_value + 2', '#red252-lexical-scope-fixture')
      const result = await evaluate(`(()=>{
        const state=window.__red252LexicalFixture
        const graph=state.draft.gameplayModules.entries.code.graph
        const branch=graph.body.find(statement=>statement?.id==='lexical-if')
        const amountIndex=graph.body.findIndex(statement=>statement?.id==='amount')
        const branchDamage=branch?.then?.find(statement=>statement?.id==='damage')
        const authored=branch?.then?.filter(statement=>statement?.layout?.authorExpression?.owner==='damage'&&statement.layout.authorExpression.input==='amount') || []
        const expression=authored.at(-1)
        return {bodyIds:graph.body.map(statement=>statement?.id||''),amountIndex,expressionIndex:expression ? branch.then.indexOf(expression) : -1,expression:expression?{id:expression.id,module:expression.module,owner:expression.layout?.authorExpression?.owner,input:expression.layout?.authorExpression?.input}:null,expressionModules:authored.map(statement=>statement.module),amountInputs:graph.body.find(statement=>statement?.id==='amount')?.inputs||null,damageAmount:branchDamage?.inputs?.amount||null,diagnostic:state.diagnostic||'',errors:[...state.host.querySelectorAll('.sentence-message.error')].map(node=>node.textContent||'')}
      })()`)
      assert.ok(result.expressionIndex >= 0, JSON.stringify(result))
      assert.ok(result.expressionModules.includes('math.add'), JSON.stringify(result))
      assert.equal(result.expression?.owner, 'damage')
      assert.equal(result.expression?.input, 'amount')
      assert.deepEqual(result.damageAmount, { kind: 'output', node: result.expression.id, port: 'value' })
      assert.deepEqual(result.amountInputs, initial.amountInputs)
      assert.equal(result.diagnostic, '', JSON.stringify(result))
      assert.deepEqual(result.errors, [], JSON.stringify(result))
      return { initial, result }
    } finally {
      try { await evaluate("(()=>{const state=window.__red252LexicalFixture;state?.editor?.destroy();state?.host?.remove();delete window.__red252LexicalFixture})()") } catch {}
    }
  })

  await check('Shadow Clone keeps complex authoring readable, supports nested collapse and horizontal scrolling', async () => {
    await openSkill('naruto-shadow-clone')
    const state = await evaluate(`(()=>{const root=document.querySelector('#skills-detail [data-sentence-editor]');const flow=document.querySelector('#skills-detail [data-sentence-horizontal-scroll]');const visible=node=>{if(!node)return false;const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0};return {editor:Boolean(root),inspectorCount:document.querySelectorAll('#skills-detail [data-sentence-inspector]').length,rows:document.querySelectorAll('#skills-detail [data-sentence-node]').length,visibleSteps:[...document.querySelectorAll('#skills-detail [data-sentence-node]')].filter(visible).map(node=>node.dataset.sentenceNode),collapses:document.querySelectorAll('#skills-detail [data-sentence-collapse-key]').length,flow:Boolean(flow),text:document.querySelector('#skills-detail [data-sentence-graph-summary]')?.textContent||'',machine:[...document.querySelectorAll('#skills-detail [data-sentence-graph-summary] .sentence-generic-semantic-list')].map(node=>node.textContent||'').join(' ')}})()`)
    fs.writeFileSync(path.join(evidence, 'shadow-clone-wide-state.json'), JSON.stringify(state, null, 2) + '\n')
    assert.equal(state.editor, true)
    assert.equal(state.inspectorCount, 1)
    assert.ok(state.rows > 0)
    assert.ok(state.collapses > 0, 'Shadow Clone must expose a nested branch collapse control')
    assert.equal(state.flow, true)
    assert.ok(state.text.includes('影分身') || state.text.includes('选择'), state.text)
    assert.equal(/source-present|math\.add|query\./.test(state.machine), false, state.machine)
    assert.equal(state.visibleSteps.includes('origin'), false, JSON.stringify(state.visibleSteps))
    assert.equal(state.visibleSteps.includes('is-teleport'), false, JSON.stringify(state.visibleSteps))
    screenshots.push(await screenshot('shadow-clone-wide.png'))

    const flowStyle = await evaluate(`(()=>{let style=document.getElementById('red252-flat-scroll-evidence');if(!style){style=document.createElement('style');style.id='red252-flat-scroll-evidence';document.head.append(style)}style.textContent='#skills-detail [data-sentence-horizontal-scroll]{width:380px !important;max-width:380px !important;overflow-x:auto !important}#skills-detail [data-sentence-horizontal-scroll] > *{min-width:900px !important}';const flow=document.querySelector('#skills-detail [data-sentence-horizontal-scroll]');if(flow)flow.scrollLeft=64;return {scrollLeft:flow?.scrollLeft||0,scrollWidth:flow?.scrollWidth||0,clientWidth:flow?.clientWidth||0,persistentStyle:Boolean(document.getElementById('red252-flat-scroll-evidence'))}})()`)
    assert.equal(flowStyle.scrollLeft, 64)
    assert.equal(flowStyle.persistentStyle, true)
    const toggleKey = await evaluate("document.querySelector('#skills-detail [data-sentence-collapse-key]')?.dataset.sentenceCollapseKey || ''")
    assert.ok(toggleKey)
    await click('#skills-detail [data-sentence-collapse-key]')
    const collapsed = await evaluate(`(()=>{const toggle=[...document.querySelectorAll('#skills-detail [data-sentence-collapse-key]')].find(node=>node.dataset.sentenceCollapseKey===${selector(toggleKey)});const nested=toggle?.closest('[data-sentence-node]')?.querySelector('[data-sentence-nested-block]');const flow=document.querySelector('#skills-detail [data-sentence-horizontal-scroll]');return {aria:toggle?.getAttribute('aria-expanded')||'',hidden:nested?.hidden===true,scrollLeft:flow?.scrollLeft||0,focusKey:document.activeElement?.dataset?.sentenceCollapseKey||''}})()`)
    assert.equal(collapsed.aria, 'false')
    assert.equal(collapsed.hidden, true)
    assert.ok(collapsed.scrollLeft >= 64, JSON.stringify(collapsed))
    assert.equal(collapsed.focusKey, toggleKey)
    screenshots.push(await screenshot('shadow-clone-narrow-collapsed.png'))

    // Verify a real parameter edit survives the normal save/reopen path on
    // this complex graph. The isolated project means the fixture change never
    // touches the user's working draft.
    await click('#skills-detail [data-sentence-module-editor="target"]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor=\"target\"]'))", 'Shadow Clone target inspector')
    await setParameter('target', 'range', '6')
    const edited = await readDraft()
    const editedTarget = edited.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'target')
    assert.equal(editedTarget.parameters.range, 6)
    assert.equal(edited.targeting.steps[1].range, 6)
    assert.equal(edited.targetText, '地格（6）')
    assert.match(edited.description, /地格（6）/)
    assert.deepEqual(edited.gameplayModules.targetBindings.targets, [{ node: 'target', stepIndex: 1, targetIndex: 0, type: 'cell' }])
    const editedPreview = edited.gameplayModules.entries.previewCode.graph.body.find(statement => statement.id === 'preview')
    assert.equal(editedPreview.inputs.description.value, edited.description)
    await saveCurrent()
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'naruto-shadow-clone.json'), 'utf8'))
    const persistedTarget = persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'target')
    assert.equal(persistedTarget.parameters.range, 6)
    assert.equal(persisted.targeting.steps[1].range, 6)
    assert.equal(persisted.targetText, '地格（6）')
    assert.match(persisted.description, /地格（6）/)
    assert.deepEqual(persisted.gameplayModules.targetBindings.targets, [{ node: 'target', stepIndex: 1, targetIndex: 0, type: 'cell' }])
    const persistedPreview = persisted.gameplayModules.entries.previewCode.graph.body.find(statement => statement.id === 'preview')
    assert.equal(persistedPreview.inputs.description.value, persisted.description)
    await openSkill('naruto-shadow-clone')
    const reopened = await readDraft()
    const reopenedTarget = reopened.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'target')
    assert.equal(reopenedTarget.parameters.range, 6)
    assert.equal(reopened.targeting.steps[1].range, 6)
    assert.equal(reopened.targetText, '地格（6）')
    assert.match(reopened.description, /地格（6）/)
    const reopenedPreview = reopened.gameplayModules.entries.previewCode.graph.body.find(statement => statement.id === 'preview')
    assert.equal(reopenedPreview.inputs.description.value, reopened.description)
    screenshots.push(await screenshot('shadow-clone-edit-reopen.png'))
    return { rows: state.rows, collapseKey: toggleKey, collapsed, flowStyle, targetRange: reopenedTarget.parameters.range, reopened: true }
  })

  await check('Keyboard more menu, Escape and focus restoration stay inside the inspector surface', async () => {
    await cdpCall('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })
    await openSkill('naruto-shadow-clone')
    const menuState = await evaluate(`(()=>{const menu=document.querySelector('#skills-detail [data-sentence-row-menu]');const summary=menu?.querySelector('summary');summary?.focus();return {menu:Boolean(menu),summaryFocused:document.activeElement===summary,open:menu?.open===true}})()`)
    assert.equal(menuState.summaryFocused, true)
    await dispatchKey('Enter', 'Enter', 13)
    const opened = await evaluate("(()=>{const menu=document.querySelector('#skills-detail [data-sentence-row-menu]');return {open:menu?.open===true,actionVisible:menu?.querySelector('.sentence-row-actions')?.getClientRects().length>0,active:document.activeElement?.tagName||''}})()")
    assert.equal(opened.open, true)
    assert.equal(opened.actionVisible, true)
    await click('#skills-detail [data-sentence-row-menu] [data-sentence-row-action="edit"]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor]'))", 'menu editor in inspector')
    const selected = await evaluate("(()=>{const editor=document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor]');return {editor:editor?.dataset.sentenceInlineEditor||'',inspectorCount:document.querySelectorAll('#skills-detail [data-sentence-inspector]').length,editors:document.querySelectorAll('#skills-detail [data-sentence-inline-editor]').length}})()")
    assert.equal(selected.inspectorCount, 1)
    assert.equal(selected.editors, 1)
    // HTMLElement.click() does not move focus like a real pointer click.
    // Focus a control inside the rendered inspector so the production shell
    // can receive the keyboard Escape event and restore focus to the row.
    await evaluate("document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor] button, #skills-detail [data-sentence-inspector] [data-sentence-inline-editor] input, #skills-detail [data-sentence-inspector] [data-sentence-inline-editor] select')?.focus()")
    await dispatchKey('Escape', 'Escape', 27)
    const closed = await evaluate("(()=>{const editor=document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor]');const active=document.activeElement;return {editor:Boolean(editor),activeDataset:{...(active?.dataset||{})},activeText:active?.textContent||''}})()")
    assert.equal(closed.editor, false)
    assert.ok(
      closed.activeDataset.sentenceModuleEditor
      || closed.activeDataset.sentenceStructuredEditor
      || closed.activeDataset.sentenceSlotEditor
      || closed.activeText === '更多操作',
      JSON.stringify(closed),
    )
    return { menuState, opened, selected, closed }
  })

  await check('Recall trigger projects the pure extension map read into the foreach expression and survives reopen', async () => {
    await openSkill('recall-move-trigger')
    const state = await evaluate(`(()=>{const visible=node=>{if(!node)return false;const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0};const loop=document.querySelector('#skills-detail [data-sentence-node="records-loop"]');return {rows:[...document.querySelectorAll('#skills-detail [data-sentence-node]')].filter(visible).map(node=>node.dataset.sentenceNode),loopText:loop?.textContent||'',editor:Boolean(document.querySelector('#skills-detail [data-sentence-editor]')),inspectorCount:document.querySelectorAll('#skills-detail [data-sentence-inspector]').length}})()`)
    fs.writeFileSync(path.join(evidence, 'recall-trigger-wide-state.json'), JSON.stringify(state, null, 2) + '\n')
    assert.equal(state.editor, true)
    assert.equal(state.inspectorCount, 1)
    assert.equal(state.rows.includes('records'), false, JSON.stringify(state.rows))
    assert.equal(state.rows.includes('records-loop'), true, JSON.stringify(state.rows))
    assert.match(state.loopText, /读取.*扩展映射/, state.loopText)
    await click('#skills-detail [data-sentence-slot-editor="records-loop:input:items"]')
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-author-expression="items"] .ei-editor'))`, 'recall map expression editor')
    const expression = await evaluate("document.querySelector('#skills-detail [data-sentence-author-expression=items] .ei-editor')?.textContent || ''")
    const typeLabel = await evaluate("document.querySelector('#skills-detail [data-sentence-author-expression=items] .sentence-author-expression-type')?.textContent || ''")
    const expressionEditorState = await evaluate("(()=>{const editor=document.querySelector('#skills-detail [data-sentence-author-expression=items] .ei-editor');const apply=document.querySelector('#skills-detail [data-sentence-apply-expression=items]');const status=document.querySelector('#skills-detail [data-sentence-author-expression=items] .sentence-author-expression-type');return {text:editor?.textContent||'',html:editor?.innerHTML||'',applyDisabled:apply?.disabled??null,status:status?.textContent||'',valid:status?.dataset?.valid||''}})()")
    fs.writeFileSync(path.join(evidence, 'recall-trigger-expression.json'), JSON.stringify(expressionEditorState, null, 2) + '\n')
    assert.ok(expression.trim(), JSON.stringify({ expression, typeLabel }))
    assert.ok(typeLabel.includes('元组') || typeLabel.includes('记录'), typeLabel)
    await applyAuthorExpression('items', expression)
    await saveCurrent()
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'recall-move-trigger.json'), 'utf8'))
    const persistedLoop = persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'records-loop')
    assert.equal(persistedLoop.items.kind, 'output')
    await openSkill('recall-move-trigger')
    const reopened = await readDraft()
    const reopenedLoop = reopened.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'records-loop')
    assert.deepEqual(reopenedLoop.items, persistedLoop.items)
    screenshots.push(await screenshot('recall-trigger-wide.png'))
    return { state, expression, typeLabel, persistedItems: persistedLoop.items, reopened: true }
  })

  await check('Flying Raijin exposes its linked rule through the Cluster sentence editor', async () => {
    await openSkill('minato-flying-raijin-passive')
    await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster]'))", 'Flying Raijin Cluster editor')
    const tabs = await evaluate("[...document.querySelectorAll('#skills-detail [data-skill-cluster-member-tab]')].map(node=>({kind:node.dataset.skillClusterMemberTab||'',text:node.textContent||'',disabled:node.disabled}))")
    const ruleTab = tabs.find(item => item.kind === 'rule')
    assert.ok(ruleTab, JSON.stringify(tabs))
    assert.equal(ruleTab.disabled, false, JSON.stringify(tabs))
    await click('#skills-detail [data-skill-cluster-member-tab="rule"]')
    await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-member=\"rule:rule-minato-flying-raijin-trigger\"]'))", 'Flying Raijin trigger rule member')
    await click('#skills-detail [data-skill-cluster-member="rule:rule-minato-flying-raijin-trigger"]')
    await until("Boolean(document.querySelector('#skills-detail .cluster-sentence-host [data-sentence-editor]'))", 'Flying Raijin rule sentence editor')
    await until("document.querySelectorAll('#skills-detail .cluster-sentence-host [data-sentence-inspector]').length === 1", 'Flying Raijin rule inspector')
    const state = await evaluate(`(()=>{const root=document.querySelector('#skills-detail .cluster-sentence-host');const visible=node=>{if(!node)return false;const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0};const nodes=[...root.querySelectorAll('[data-sentence-node]')];const slots=[...root.querySelectorAll('[data-sentence-slot-editor]')].filter(visible);return {tabs:[...document.querySelectorAll('#skills-detail [data-skill-cluster-member-tab]')].map(node=>({kind:node.dataset.skillClusterMemberTab||'',text:node.textContent||'',disabled:node.disabled})),nodes:nodes.map(node=>({id:node.dataset.sentenceNode||'',visible:visible(node),text:node.textContent||''})),visibleNodes:nodes.filter(visible).map(node=>node.dataset.sentenceNode),slotCount:slots.length,firstSlot:slots[0]?.dataset.sentenceSlotEditor||'',inspectorCount:root.querySelectorAll('[data-sentence-inspector]').length,text:root.textContent||''}})()`)
    fs.writeFileSync(path.join(evidence, 'flying-raijin-rule-state.json'), JSON.stringify(state, null, 2) + '\n')
    assert.ok(state.visibleNodes.length > 0, JSON.stringify(state))
    assert.equal(state.inspectorCount, 1)
    assert.ok(state.slotCount > 0, JSON.stringify(state))
    assert.equal(state.visibleNodes.includes('skill-id'), false, JSON.stringify(state.visibleNodes))
    if (state.firstSlot) {
      await click(`#skills-detail .cluster-sentence-host [data-sentence-slot-editor=${selector(state.firstSlot)}]`)
      await until("document.querySelectorAll('#skills-detail .cluster-sentence-host [data-sentence-inspector]').length === 1", 'Flying Raijin selected rule slot')
      const selected = await evaluate("(()=>{const inspector=document.querySelector('#skills-detail .cluster-sentence-host [data-sentence-inspector]');return {text:inspector?.textContent||'',typeLabels:[...inspector?.querySelectorAll('.sentence-author-expression-type')||[]].map(node=>node.textContent||'')}})()")
      assert.ok(selected.text.trim(), JSON.stringify(selected))
      await click('#skills-detail .cluster-sentence-host [data-sentence-popover] .sentence-popover-close')
    }
    await click('#skills-detail .cluster-sentence-host [data-sentence-module-editor="source-target-choice"]')
    await until("Boolean(document.querySelector('#skills-detail .cluster-sentence-host [data-sentence-inline-editor=\"source-target-choice\"]'))", 'Flying Raijin choice inspector')
    await setParameter('source-target-choice', 'title', '飞雷神触发（UI验收）')
    const editedRule = await evaluate("window.__editorDraftSessions?.get('rules:rule-minato-flying-raijin-trigger')?.draft||null")
    const editedChoice = findGraphStatement(editedRule?.gameplayModules?.entries?.skillCode?.graph, 'source-target-choice')
    fs.writeFileSync(path.join(evidence, 'flying-raijin-edit-debug.json'), JSON.stringify(await evaluate("(()=>{const sessions=[...(window.__editorDraftSessions?.entries?.()||[])];const session=sessions.find(([key])=>key==='rules:rule-minato-flying-raijin-trigger')?.[1];const input=document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor=\\\"source-target-choice\\\"] [data-sentence-module-parameter=\\\"title\\\"] input');return {keys:sessions.map(([key])=>key),sessionDraft:session?.draft||null,inputValue:input?.value||'',selectedDraft:document.querySelector('#skills-detail')?.getSelectedMemberDraft?.()?.value||null}})()"), null, 2) + '\n')
    assert.equal(editedChoice?.parameters?.title, '飞雷神触发（UI验收）', JSON.stringify(editedChoice))
    await evaluate("document.getElementById('studio-save')?.click()")
    await until("document.getElementById('studio-save')?.textContent==='保存'", 'Flying Raijin save completion')
    const persistedRule = JSON.parse(fs.readFileSync(path.join(project, 'data', 'rules', 'rule-minato-flying-raijin-trigger.json'), 'utf8'))
    const persistedChoice = findGraphStatement(persistedRule.gameplayModules.entries.skillCode.graph, 'source-target-choice')
    assert.equal(persistedChoice?.parameters?.title, '飞雷神触发（UI验收）')
    // Cluster members are cached independently from the owning skill panel.
    // Remove that clean cache entry so the following navigation really reads
    // the saved rule file instead of reusing the object edited above.
    await evaluate("window.__editorDraftSessions?.delete('rules:rule-minato-flying-raijin-trigger')")
    await openSkill('minato-flying-raijin-passive')
    await click('#skills-detail [data-skill-cluster-member-tab="rule"]')
    await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-member=\"rule:rule-minato-flying-raijin-trigger\"]'))", 'reopened Flying Raijin trigger rule member')
    await click('#skills-detail [data-skill-cluster-member="rule:rule-minato-flying-raijin-trigger"]')
    await until("Boolean(document.querySelector('#skills-detail .cluster-sentence-host [data-sentence-editor]'))", 'reopened Flying Raijin rule sentence editor')
    const reopenedRule = await evaluate("window.__editorDraftSessions?.get('rules:rule-minato-flying-raijin-trigger')?.draft||null")
    const reopenedChoice = findGraphStatement(reopenedRule?.gameplayModules?.entries?.skillCode?.graph, 'source-target-choice')
    fs.writeFileSync(path.join(evidence, 'flying-raijin-reopen.json'), JSON.stringify({
      reopenedChoice,
      persistedChoice,
      selectedMember: await evaluate("window.__editorDraftSessions?.get('rules:rule-minato-flying-raijin-trigger')||null"),
    }, null, 2) + '\n')
    assert.equal(reopenedChoice?.parameters?.title, '飞雷神触发（UI验收）', JSON.stringify(reopenedChoice))
    screenshots.push(await screenshot('flying-raijin-rule.png'))
    return { tabs, state: { visibleNodes: state.visibleNodes, slotCount: state.slotCount, firstSlot: state.firstSlot, inspectorCount: state.inspectorCount }, selectedRuleSlot: Boolean(state.firstSlot), choiceTitle: reopenedChoice.parameters.title, savedAndReopened: true }
  })

  await check('Extension custom access, schema, ports and declarations use the same modern inspector and survive save/reload', async () => {
    await openSkill('flat-sentence-extension-smoke')
    const projection = await evaluate(`(()=>{const visible=node=>{if(!node)return false;const style=getComputedStyle(node);return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0};return {visible:[...document.querySelectorAll('#skills-detail [data-sentence-node]')].filter(visible).map(node=>node.dataset.sentenceNode),writeText:document.querySelector('#skills-detail [data-sentence-node="flat-write-player"]')?.textContent||''}})()`)
    assert.equal(projection.visible.includes('flat-read-player'), false, JSON.stringify(projection))
    assert.equal(projection.visible.includes('flat-read-missing'), true, JSON.stringify(projection))
    assert.match(projection.writeText, /读取.*扩展/, projection.writeText)
    await click('#skills-detail [data-sentence-module-editor="flat-read-missing"]')
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor="flat-read-missing"]'))`, 'extension inspector')
    const initial = await evaluate(`(()=>{const inspector=document.querySelector('#skills-detail [data-sentence-inspector]');const panel=inspector?.querySelector('[data-sentence-inline-editor="flat-read-missing"]');return {inspectorCount:document.querySelectorAll('#skills-detail [data-sentence-inspector]').length,editorOutside:document.querySelectorAll('#skills-detail [data-sentence-inline-editor]').length-(inspector?inspector.querySelectorAll('[data-sentence-inline-editor]').length:0),name:panel?.querySelector('[data-sentence-module-parameter="name"] input')?.value||'',valueType:Boolean(panel?.querySelector('[data-sentence-module-parameter="valueType"]'))}})()`)
    assert.equal(initial.inspectorCount, 1)
    assert.equal(initial.editorOutside, 0)
    assert.equal(initial.name, 'missingState')
    assert.equal(initial.valueType, true)

    await setParameter('flat-read-missing', 'namespace', 'author-test')
    await setParameter('flat-read-missing', 'name', 'customRecord')
    await setParameter('flat-read-missing', 'path', 'state.hp')
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor="flat-read-missing"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]'))`, 'extension value type control')
    await evaluate(`(()=>{const select=document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor="flat-read-missing"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]');select.value='record';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await delay(120)
    const edited = await readDraft()
    const read = edited.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'flat-read-missing')
    assert.equal(read.parameters.namespace, 'author-test')
    assert.equal(read.parameters.name, 'customRecord')
    assert.equal(read.parameters.path, 'state.hp')
    assert.equal(read.parameters.valueType, 'record')
    const datalist = await evaluate(`(()=>{const input=document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor="flat-read-missing"] [data-sentence-module-parameter="name"] input');const list=input&&document.getElementById(input.getAttribute('list'));return [...(list?.options||[])].map(option=>option.value)})()`)
    assert.ok(datalist.includes('priorPlayer'), JSON.stringify(datalist))
    assert.equal(datalist.includes('laterPlayer'), false, JSON.stringify(datalist))

    // The write consumes the numeric `flat-read-player` value. Keep its
    // declared type consistent through the author-facing control instead of
    // weakening graph type validation.
    await click('#skills-detail [data-sentence-module-editor="flat-write-player"]')
    await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor="flat-write-player"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]'))`, 'dependent extension value type control')
    await evaluate(`(()=>{const select=document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor="flat-write-player"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]');select.value='number';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await until(`(()=>{const input=document.querySelector('#skills-detail [data-sentence-inspector] [data-sentence-inline-editor="flat-write-player"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]');return input?.value==='number'})()`, 'dependent extension numeric type')

    await click('#skills-detail [data-sentence-inspector] [data-sentence-popover] .sentence-popover-close')
    await click('#skills-detail [data-sentence-configuration]')
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-graph-configuration][open]'))", 'graph configuration details')
    const configBefore = await evaluate(`(()=>{const root=document.querySelector('#skills-detail');return {schemas:Boolean(root.querySelector('[data-sentence-schemas]')),ports:root.querySelectorAll('[data-sentence-ports]').length,declarations:Boolean(root.querySelector('[data-sentence-declarations]')),addSchema:Boolean(root.querySelector('[data-sentence-add-schema]')),addComposite:Boolean(root.querySelector('[data-sentence-add-composite]')),addContinuation:Boolean(root.querySelector('[data-sentence-add-continuation]'))}})()`)
    assert.equal(configBefore.schemas, true)
    assert.ok(configBefore.ports >= 2, JSON.stringify(configBefore))
    assert.equal(configBefore.declarations, true)
    assert.equal(configBefore.addSchema, true)
    assert.equal(configBefore.addComposite, true)
    assert.equal(configBefore.addContinuation, true)
    await click('#skills-detail [data-sentence-add-schema]')
    await until("document.querySelectorAll('#skills-detail [data-sentence-schema]').length >= 2", 'new schema card')
    await evaluate(`(()=>{const cards=[...document.querySelectorAll('#skills-detail [data-sentence-schemas] [data-sentence-schema]')];const button=cards.at(-1)?.querySelector('[data-sentence-add-schema-field]');if(!button)throw new Error('missing add-field button on newest schema card');button.scrollIntoView({block:'center',inline:'nearest'});button.click()})()`)
    await delay(80)
    await until("document.querySelectorAll('#skills-detail [data-sentence-schema-field]').length >= 3", 'new schema field')
    const schemaState = await evaluate("(()=>{const section=document.querySelector('#skills-detail [data-sentence-schemas]');const card=[...section.querySelectorAll('[data-sentence-schema]')].at(-1);return {card:card?.dataset.sentenceSchema||'',fields:card?.querySelectorAll('[data-sentence-schema-field]').length||0}})()")
    assert.equal(schemaState.fields >= 1, true)
    await click('#skills-detail [data-sentence-declarations] [data-sentence-add-composite]')
    await click('#skills-detail [data-sentence-declarations] [data-sentence-add-continuation]')
    await until("document.querySelectorAll('#skills-detail [data-sentence-composite]').length >= 1 && document.querySelectorAll('#skills-detail [data-sentence-continuation]').length >= 1", 'new composite and continuation declarations')
    const declarationState = await evaluate(`(()=>{const root=document.querySelector('#skills-detail');return {composites:[...root.querySelectorAll('[data-sentence-composite]')].map(node=>node.dataset.sentenceComposite),continuations:[...root.querySelectorAll('[data-sentence-continuation]')].map(node=>node.dataset.sentenceContinuation),portAddButtons:root.querySelectorAll('[data-sentence-composite] [data-sentence-add-port]').length}})()`)
    assert.ok(declarationState.composites.length >= 1)
    assert.ok(declarationState.continuations.length >= 1)
    assert.ok(declarationState.portAddButtons >= 2, JSON.stringify(declarationState))
    const inspectorScrollBefore = await evaluate(`(()=>{const inspector=document.querySelector('#skills-detail [data-sentence-inspector]');if(!inspector)throw new Error('missing inspector scroll surface');inspector.scrollTop=inspector.scrollHeight;return {top:inspector.scrollTop,max:inspector.scrollHeight-inspector.clientHeight}})()`)
    assert.ok(inspectorScrollBefore.max > 0, JSON.stringify(inspectorScrollBefore))
    await evaluate("document.querySelector('#skills-detail [data-sentence-composite] [data-sentence-add-port=\"inputs\"]').click()")
    await until(`document.querySelectorAll('#skills-detail [data-sentence-composite] [data-sentence-port^="inputs:"]').length >= 1`, 'composite input port')
    const inspectorScrollAfter = await evaluate("(()=>{const inspector=document.querySelector('#skills-detail [data-sentence-inspector]');return {top:inspector?.scrollTop||0,max:(inspector?.scrollHeight||0)-(inspector?.clientHeight||0)}})()")
    assert.ok(inspectorScrollAfter.top >= inspectorScrollBefore.top - 3, JSON.stringify({ before: inspectorScrollBefore, after: inspectorScrollAfter }))
    const configAfter = await evaluate(`(()=>{const root=document.querySelector('#skills-detail');return {schemas:root.querySelectorAll('[data-sentence-schemas] [data-sentence-schema]').length,fields:root.querySelectorAll('[data-sentence-schema-field]').length,composites:root.querySelectorAll('[data-sentence-composite]').length,continuations:root.querySelectorAll('[data-sentence-continuation]').length,ports:root.querySelectorAll('[data-sentence-ports]').length,inspectorCount:root.querySelectorAll('[data-sentence-inspector]').length}})()`)
    assert.ok(configAfter.schemas >= 2, JSON.stringify(configAfter))
    assert.ok(configAfter.fields >= 3, JSON.stringify(configAfter))
    assert.ok(configAfter.composites >= 1, JSON.stringify(configAfter))
    assert.ok(configAfter.continuations >= 1, JSON.stringify(configAfter))
    assert.equal(configAfter.inspectorCount, 1)
    screenshots.push(await screenshot('extension-config-inspector.png'))

    await saveCurrent()
    const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'flat-sentence-extension-smoke.json'), 'utf8'))
    const persistedRead = persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'flat-read-missing')
    assert.equal(persistedRead.parameters.name, 'customRecord')
    assert.deepEqual(persisted.editorFlatSentenceUnknown, extensionSmoke.editorFlatSentenceUnknown)
    await openSkill('flat-sentence-extension-smoke')
    const reopened = await readDraft()
    const reopenedRead = reopened.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'flat-read-missing')
    assert.deepEqual(reopenedRead.parameters, persistedRead.parameters)
    assert.deepEqual(reopened.editorFlatSentenceUnknown, extensionSmoke.editorFlatSentenceUnknown)
    return { projection, initial, edited: read.parameters, datalist, configBefore, schemaState, declarationState, configAfter, inspectorScrollBefore, inspectorScrollAfter, persisted: persistedRead.parameters }
  })

  await cdpCall('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false })
  await openSkill('fireball')
  const narrow = await evaluate(`(()=>{const layout=document.querySelector('#skills-detail .sentence-layout');const inspector=document.querySelector('#skills-detail [data-sentence-inspector]');const save=document.querySelector('#skills-detail [data-sentence-save]');const advanced=document.querySelector('#skills-detail [data-sentence-advanced]');const bounds=[save,advanced,inspector].filter(Boolean).map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});return {columns:getComputedStyle(layout).gridTemplateColumns,inspectorCount:document.querySelectorAll('#skills-detail [data-sentence-inspector]').length,bounds,bodyWidth:document.body.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`)
  fs.writeFileSync(path.join(evidence, 'fireball-narrow-state.json'), JSON.stringify(narrow, null, 2) + '\n')
  assert.equal(narrow.inspectorCount, 1)
  for (const bounds of narrow.bounds) {
    assert.ok(bounds.left >= 0, JSON.stringify(bounds))
    assert.ok(bounds.right <= 760, JSON.stringify(bounds))
  }
  assert.ok(narrow.overflow <= 2, JSON.stringify(narrow))
  screenshots.push(await screenshot('fireball-narrow.png'))

  report.ok = checks.every(item => item.ok)
  report.failureCount = checks.filter(item => !item.ok).length
  report.reportPath = path.join(evidence, 'sentence-flat-ui-smoke.json')
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2) + '\n')
  if (!report.ok) {
    const failures = checks.filter(item => !item.ok).map(item => `${item.name}: ${item.error}`).join('\n')
    throw new Error(`sentence flat UI smoke failed (${report.failureCount})\n${failures}`)
  }
  console.log(JSON.stringify({ ok: true, report: report.reportPath, project, screenshots }))
} catch (error) {
  report.ok = false
  report.failureCount = checks.filter(item => !item.ok).length || 1
  report.error = error?.stack || String(error)
  report.reportPath = path.join(evidence, 'sentence-flat-ui-smoke.json')
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2) + '\n')
  console.error(error?.stack || error)
  process.exitCode = 1
} finally {
  try { socket?.close() } catch {}
  child.kill()
}
