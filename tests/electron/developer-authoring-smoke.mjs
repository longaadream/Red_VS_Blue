import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/*
 * RED-252 developer authoring acceptance smoke.
 *
 * This test deliberately starts from a blank content project and uses the
 * visible Electron controls to create the documents. It must not seed a
 * complete graph through JSON or the renderer's global object. The saved
 * artifacts are copied to the evidence directory so the engine follow-up can
 * run against exactly what the authoring UI produced.
 */

const require = createRequire(import.meta.url)
const root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))

const evidence = path.resolve(process.env.RVB_DEVELOPER_AUTHORING_EVIDENCE_DIR || path.join(root, 'output/completion-developer-authoring-smoke'))
fs.mkdirSync(evidence, { recursive: true })
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-developer-authoring-'))
const userData = path.join(temporary, 'user-data')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const screenshots = []
const blockers = []
const observations = []
const artifacts = []
const runtimeConsoleErrors = []
const runtimeExceptions = []
const isObjectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value)
let child = null
let socket = null
let sequence = 0
let port
let currentCollection = null
let currentId = null

function activeDetailSelector() {
  if (!currentCollection) throw new Error('ACTIVE_COLLECTION_MISSING')
  return `#${currentCollection}-detail`
}

function blocker(code, details = {}) {
  const entry = { code, ...details }
  blockers.push(entry)
  console.error('[developer-authoring blocker]', JSON.stringify(entry))
  return entry
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}

async function discoverTarget() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })
      const targets = await response.json()
      const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) return target
    } catch { /* Electron is still starting. */ }
    await delay(250)
  }
  throw new Error('EDITOR_STARTUP_TIMEOUT')
}

function cdpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('CDP_NOT_CONNECTED'))
    const id = ++sequence
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`CDP_TIMEOUT:${method}`))
    }, 30000)
    const onMessage = event => {
      const value = JSON.parse(event.data)
      if (value.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      if (value.error) reject(new Error(JSON.stringify(value.error)))
      else resolve(value.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await cdpCall('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`RUNTIME_EVALUATION:${JSON.stringify(result.exceptionDetails)}`)
  return result.result.value
}

async function connectEditor() {
  const target = await discoverTarget()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await cdpCall('Runtime.enable')
  await cdpCall('Log.enable')
  socket.addEventListener('message', event => {
    try {
      const value = JSON.parse(event.data)
      if (value.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(value.params.type)) runtimeConsoleErrors.push(value.params.args?.map(arg => arg.value ?? arg.description ?? '').join(' '))
      if (value.method === 'Runtime.exceptionThrown') {
        const details = value.params.exceptionDetails || {}
        const error = details.exception || {}
        runtimeExceptions.push({
          text: details.text || 'renderer exception',
          description: error.description || error.value || details.exception?.description || '',
          stackTrace: error.stackTrace || details.stackTrace || null,
        })
      }
    } catch { /* diagnostics are best effort */ }
  })
  await cdpCall('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })
}

async function launchEditor() {
  port = await reservePort()
  const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
  const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [...args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--editor-smoke-hidden'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', chunk => observations.push({ stream: 'stdout', text: String(chunk).slice(-2000) }))
  child.stderr?.on('data', chunk => observations.push({ stream: 'stderr', text: String(chunk).slice(-2000) }))
  await connectEditor()
}

async function until(expression, label = expression, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await evaluate(expression)) return
    } catch { /* renderer is still mounting */ }
    await delay(100)
  }
  throw new Error(`UI_TIMEOUT:${label}`)
}

async function visible(selector) {
  return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return Boolean(r.width&&r.height&&e.offsetParent)})()`)
}

async function click(selector, label = selector) {
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, `control:${label}`)
  const result = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('MISSING_CONTROL:${label}');e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();if(!e.offsetParent||r.width<=0||r.height<=0)throw new Error('HIDDEN_CONTROL:${label}');e.click();return {text:e.textContent||'',disabled:Boolean(e.disabled)}})()`)
  await delay(120)
  return result
}

async function fill(selector, value, label = selector) {
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, `field:${label}`)
  assert.equal(await visible(selector), true, `填写前字段必须可见：${label}`)
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('MISSING_FIELD:${label}');e.scrollIntoView({block:'center',inline:'nearest'});e.focus();e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await delay(140)
}

async function screenshot(name) {
  const result = await cdpCall('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const filename = `${name}.png`
  const output = path.join(evidence, filename)
  fs.writeFileSync(output, Buffer.from(result.data, 'base64'))
  screenshots.push(output)
  return output
}

async function pageState() {
  const detail = activeDetailSelector()
  return evaluate(`(()=>({
    url:location.href,
    title:document.title,
    activeTab:document.querySelector('.tab-btn.active')?.dataset.tab||null,
    bodyText:document.body?.innerText?.slice(0,5000)||'',
    status:[...document.querySelectorAll('.dirty-state')].map(node=>node.textContent||''),
    jsonErrors:[...document.querySelectorAll(${JSON.stringify(detail)}+' [data-json-error]')].map(node=>node.textContent||''),
    graph:document.querySelector(${JSON.stringify(detail)}+' [data-json-source]')?.value||null,
    sentenceEditor:Boolean(document.querySelector(${JSON.stringify(detail)}+' [data-sentence-editor]')),
    editorState:window.__developerAuthoringState||null
  }))()`)
}

async function writeArtifact(collection, id, label) {
  const source = path.join(project, 'data', collection, `${id}.json`)
  if (!fs.existsSync(source)) return null
  const target = path.join(evidence, `${label}-${id}.json`)
  fs.copyFileSync(source, target)
  artifacts.push({ collection, id, label, path: target, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex') })
  return target
}

async function openNewDocument(collection, name, label) {
  const focused = await evaluate('Boolean([...document.querySelectorAll(".tab-panel.active [data-focus-editor]")].find(node => node.textContent === "返回列表" && node.offsetParent))')
  if (focused) await click('.tab-panel.active [data-focus-editor]', '返回列表')
  await click(`[data-tab="${collection}"]`, `${label}页签`)
  await until(`document.querySelector("#${collection}-list")?.offsetParent !== null`, `${label}列表显示`)
  await click(`[data-new-document="${collection}"]`, `新建${label}`)
  await until('document.querySelector("#create-dialog")?.open === true', '新建内容对话框')
  const id = await evaluate('document.querySelector("#create-id")?.value || ""')
  assert.match(id, /^content-[0-9a-f-]{36}$/, 'new dialog assigns hidden UUID-style ID')
  assert.equal(await evaluate('document.querySelector("#create-id")?.offsetParent === null'), true, 'internal ID stays hidden')
  await fill('#create-name', name, '显示名称')
  await click('#create-confirm', '开始编辑')
  await until('document.querySelector("#create-dialog")?.open !== true', '关闭新建内容对话框')
  currentCollection = collection; currentId = id
  await until(`Boolean(document.querySelector("#${collection}-detail [data-sentence-editor]"))`, `${name} 中文句子编辑器`)
  return id
}

async function openNewSkill(name) {
  return openNewDocument('skills', name, '能力组')
}

async function openNewRule(name) {
  return openNewDocument('rules', name, '规则')
}

async function configureSkillBasics(actionPointCost = 1, cooldownTurns = 3, description = '') {
  await click(`${activeDetailSelector()} [data-editor-mode="fields"]`, '编辑基础属性')
  await fill('[data-field-path="actionPointCost"]', actionPointCost, '行动点消耗')
  await fill('[data-field-path="cooldownTurns"]', cooldownTurns, '冷却回合')
  await fill('[data-field-path="description"]', description, '技能说明')
}

function sentenceDetailSelector() {
  return `${activeDetailSelector()} [data-sentence-editor]`
}

function sentenceFieldName() {
  return currentCollection === 'rules' ? 'skillCode' : 'code'
}

async function sentenceGraphSnapshot() {
  const detail = activeDetailSelector()
  const field = sentenceFieldName()
  return evaluate(`(()=>{const source=document.querySelector(${JSON.stringify(detail)}+' [data-json-source]')?.value;try{return source?JSON.parse(source).gameplayModules?.entries?.[${JSON.stringify(field)}]?.graph||null:null}catch{return null}})()`)
}

async function openSentenceEditor() {
  const detail = activeDetailSelector()
  await until(`Boolean(document.querySelector(${JSON.stringify(sentenceDetailSelector())}))`, '中文句子编辑器')
  if (!await visible(sentenceDetailSelector())) {
    const effectTab = `${detail} [data-editor-mode="cluster"]`
    if (await visible(effectTab)) await click(effectTab, '编辑效果')
  }
  await until(`Boolean(document.querySelector(${JSON.stringify(sentenceDetailSelector())})?.offsetParent)`, '中文句子编辑器可见')
}

async function addSentenceModule(moduleId, label = moduleId) {
  const detail = activeDetailSelector()
  await openSentenceEditor()
  await click(`${detail} [data-sentence-add-effect]`, '添加语句')
  await until(`Boolean(document.querySelector(${JSON.stringify(`${detail} [data-sentence-popover="module"]`)}))`, '语句模块目录')
  const selector = `${detail} [data-sentence-module=${JSON.stringify(moduleId)}]`
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)})) || Boolean([...document.querySelectorAll(${JSON.stringify(`${detail} [data-sentence-module]`)})].find(item=>item.textContent.includes(${JSON.stringify(label)})))`, `模块目录 ${label}`)
  let moduleSelector = selector
  if (!await visible(selector)) {
    const fallback = await evaluate(`(()=>{const items=[...document.querySelectorAll(${JSON.stringify(`${detail} [data-sentence-module]`)})];return items.filter(item=>item.textContent.includes(${JSON.stringify(label)})).map(item=>({id:item.dataset.sentenceModule,text:item.textContent}))})()`)
    blocker('SENTENCE_MODULE_ID_NOT_EXPOSED', { moduleId, label, fallback })
    if (!fallback?.length) throw new Error(`MODULE_NOT_EXPOSED:${moduleId}`)
    moduleSelector = `${detail} [data-sentence-module=${JSON.stringify(fallback[0].id)}]`
  }
  await click(moduleSelector, `添加句子模块 ${label}`)
  await until(`Boolean(document.querySelector(${JSON.stringify(detail)}+' [data-sentence-inline-editor]'))`, `编辑句子模块 ${label}`)
  const graph = await sentenceGraphSnapshot()
  const statement = [...(graph?.body || [])].reverse().find(item => item?.kind === 'call' && item.module === moduleId)
  if (!statement) {
    blocker('SENTENCE_MODULE_NOT_CREATED', { moduleId, label, graph, page: await pageState() })
    return null
  }
  return statement.id
}

function findGraphStatement(graph, predicate) {
  let found = null
  const visit = statements => {
    for (const statement of Array.isArray(statements) ? statements : []) {
      if (predicate(statement)) found = statement
      visit(statement?.then); visit(statement?.else); visit(statement?.body); visit(statement?.condition?.body)
    }
  }
  visit(graph?.body)
  return found
}

async function addBranchSentenceModule(parentId, branch, moduleId, label = moduleId) {
  const detail = activeDetailSelector()
  await openSentenceStatement(parentId)
  const button = `${detail} [data-sentence-add-branch=${JSON.stringify(`${parentId}:${branch}`)}]`
  await until(`Boolean(document.querySelector(${JSON.stringify(button)}))`, `添加${branch}分支语句`)
  // The action is inside a closed details menu in the visible authoring UI.
  await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(button)});const menu=button?.closest('details');if(menu)menu.open=true;button?.click();return Boolean(button)})()`)
  await until(`Boolean(document.querySelector(${JSON.stringify(`${detail} [data-sentence-popover="module"]`)}))`, '分支语句模块目录')
  const selector = `${detail} [data-sentence-popover="module"] [data-sentence-module=${JSON.stringify(moduleId)}]`
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, `分支模块 ${label}`)
  await click(selector, `添加分支语句 ${label}`)
  await until(`Boolean(document.querySelector(${JSON.stringify(`${detail} [data-sentence-inline-editor]`)}))`, `编辑分支语句 ${label}`)
  const graph = await sentenceGraphSnapshot()
  const statement = findGraphStatement(graph, item => item?.kind === 'call' && item.module === moduleId && item.id !== parentId && item.id !== undefined)
  if (!statement) {
    blocker('BRANCH_SENTENCE_MODULE_NOT_CREATED', { parentId, branch, moduleId, label, graph, page: await pageState() })
    return null
  }
  return statement.id
}

async function addStructuredStatement(kind, label = kind) {
  const detail = activeDetailSelector()
  await openSentenceEditor()
  const selector = `${detail} [data-sentence-add-structured="root:${kind}"]`
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, `添加${label}`)
  await click(selector, `添加${label}`)
  await delay(180)
  const graph = await sentenceGraphSnapshot()
  const statement = [...(graph?.body || [])].reverse().find(item => item?.kind === kind)
  if (!statement) {
    blocker('STRUCTURED_STATEMENT_NOT_CREATED', { kind, label, graph, page: await pageState() })
    return null
  }
  return statement.id
}


async function setStructuredSchema(statementId, schemaReference) {
  await openSentenceStatement(statementId)
  const detail = activeDetailSelector()
  const selector = `${detail} [data-sentence-record-schema]`
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, `记录结构选择 ${schemaReference}`)
  const result = await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(selector)});select.value=${JSON.stringify(schemaReference)};if(select.value!==${JSON.stringify(schemaReference)})return {ok:false,options:[...select.options].map(item=>({value:item.value,text:item.textContent}))};select.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true}})()`)
  if (!result?.ok) {
    blocker('STRUCTURED_SCHEMA_NOT_AVAILABLE', { statementId, schemaReference, ...result })
    return false
  }
  await delay(220)
  return true
}

async function objectEditorIndexForSlot(statementId, slotName) {
  const panel = JSON.stringify(objectEditorPanelSelector(statementId))
  const slot = JSON.stringify(String(slotName))
  return evaluate(`(()=>{const panel=document.querySelector(${panel});const source=[...panel?.querySelectorAll('[data-sentence-value-source]')||[]].find(item=>item.dataset.sentenceValueSource===${slot});if(!source)return -1;const value=source.closest('.sentence-value-editor');const root=value?.querySelector('.author-object-editor');if(!root)return -1;return [...panel.querySelectorAll('.author-object-editor')].indexOf(root)})()`)
}

async function setStructuredLiteral(statementId, slotName, value, label = slotName) {
  await openSentenceStatement(statementId)
  const detail = activeDetailSelector()
  const sourceSelector = `${detail} [data-sentence-value-source=${JSON.stringify(slotName)}]`
  // Primitive fields in a structured record use the author expression editor
  // directly.  They intentionally have no literal source selector because
  // the record editor must preserve the field's declared scalar type.  Keep
  // this on the real editor path so a blank document can author moveRange,
  // booleans, and similar fields without falling back to graph injection.
  if (!(await visible(sourceSelector))) {
    const editorSelector = `${detail} [data-sentence-author-expression=${JSON.stringify(slotName)}] .ei-editor`
    const applySelector = `${detail} [data-sentence-apply-expression=${JSON.stringify(slotName)}]`
    if (await visible(editorSelector)) {
      const source = typeof value === 'string' ? JSON.stringify(value) : String(value)
      await evaluate(`(()=>{const editor=document.querySelector(${JSON.stringify(editorSelector)});if(!editor)return false;editor.scrollIntoView({block:'center',inline:'nearest'});editor.focus();editor.textContent=${JSON.stringify(source)};editor.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
      await until(`document.querySelector(${JSON.stringify(applySelector)})?.disabled === false`, `结构表达式可应用 ${label}`)
      await click(applySelector, `应用结构表达式 ${label}`)
      await delay(180)
      return true
    }
  }
  await until(`Boolean(document.querySelector(${JSON.stringify(sourceSelector)}))`, `结构常量 ${label}`)
  const result = await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(sourceSelector)});select.value='literal';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  if (!result) return false
  await delay(220)
  if (Array.isArray(value)) {
    const listSelector = `${detail} [data-sentence-literal-add=${JSON.stringify(slotName)}]`
    await until(`Boolean(document.querySelector(${JSON.stringify(listSelector)}))`, `结构列表 ${label}`)
    for (let index = 0; index < value.length; index += 1) {
      await click(listSelector, `添加${label}第${index + 1}项`)
      await delay(120)
      const rowSelector = `${detail} [data-sentence-literal-index="${index}"]`
      const control = `${rowSelector} input:not([type="checkbox"]),${rowSelector} textarea,${rowSelector} select`
      await until(`Boolean(document.querySelector(${JSON.stringify(control)}))`, `填写${label}第${index + 1}项`)
      await evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(rowSelector)});const control=row?.querySelector('input:not([type="checkbox"]),textarea,select');if(!control)return false;const value=${JSON.stringify(value[index])};control.value=typeof value==='string'?value:JSON.stringify(value);control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    }
    await delay(180)
    return true
  }
  const primitive = await evaluate(`(()=>{const source=document.querySelector(${JSON.stringify(sourceSelector)});const editor=source?.closest('.sentence-value-editor');if(!editor)return null;const control=editor.querySelector('[data-object-editor-value],input:not([data-sentence-value-source]),textarea:not([data-sentence-value-source]),select:not([data-sentence-value-source])');return control?{tag:control.tagName,type:control.type||'',value:control.value||''}:null})()`)
  if (primitive && !['record', 'object'].includes(typeof value)) {
    const assigned = await evaluate(`(()=>{const source=document.querySelector(${JSON.stringify(sourceSelector)});const editor=source?.closest('.sentence-value-editor');const control=editor?.querySelector('[data-object-editor-value],input:not([data-sentence-value-source]),textarea:not([data-sentence-value-source]),select:not([data-sentence-value-source])');if(!control)return false;const value=${JSON.stringify(value)};if(control.type==='checkbox')control.checked=Boolean(value);else control.value=typeof value==='string'?value:JSON.stringify(value);control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    if (assigned) { await delay(180); return true }
  }
  const editorIndex = await objectEditorIndexForSlot(statementId, slotName)
  if (editorIndex < 0) {
    blocker('STRUCTURED_LITERAL_CONTROL_MISSING', { statementId, slotName, label, value, primitive })
    return false
  }
  // The object editor owns recursive records/lists/sets/maps. Its field
  // presence controls make omitted, null, zero, and empty values distinct.
  if (isObjectValue(value)) {
    for (const [field, fieldValue] of Object.entries(value)) {
      await setObjectFieldPresence(statementId, editorIndex, field)
      if (isObjectValue(fieldValue) || Array.isArray(fieldValue)) {
        // Nested values are authored by the same object editor; callers that
        // need a nested structure use the path-specific helpers below.
        await fillObjectField(statementId, editorIndex, field, fieldValue, `${label}.${field}`)
      } else await fillObjectField(statementId, editorIndex, field, fieldValue, `${label}.${field}`)
    }
  }
  await delay(180)
  return true
}

async function setStructuredObjectField(statementId, slotName, fieldPath, value, label = fieldPath) {
  await openSentenceStatement(statementId)
  const editorIndex = await objectEditorIndexForSlot(statementId, slotName)
  if (editorIndex < 0) {
    blocker('STRUCTURED_OBJECT_EDITOR_MISSING', { statementId, slotName, fieldPath, label })
    return false
  }
  const field = JSON.stringify(String(fieldPath))
  const existingExpression = "const control=[...root.querySelectorAll('[data-object-editor-field-include]')].find(item=>item.dataset.objectEditorFieldInclude===" + field + ");return Boolean(control)"
  const existing = await evaluate(objectEditorExpression(statementId, editorIndex, existingExpression))
  if (!existing) {
    const addExpression = "const input=root.querySelector('[data-object-editor-add-field]');const add=input?.closest('.author-object-editor-add-field')?.querySelector('.author-object-editor-add');if(!input||!add)return false;input.value=" + JSON.stringify(String(fieldPath)) + ";input.dispatchEvent(new Event('input',{bubbles:true}));add.click();return true"
    const added = await evaluate(objectEditorExpression(statementId, editorIndex, addExpression))
    if (!added) {
      blocker('STRUCTURED_OBJECT_FIELD_ADD_MISSING', { statementId, slotName, fieldPath, label })
      return false
    }
    await delay(180)
  }
  await setObjectFieldPresence(statementId, editorIndex, fieldPath)
  await fillObjectField(statementId, editorIndex, fieldPath, value, label)
  return true
}



async function addRecordCreate(schemaReference, label = '创建记录') {
  const id = await addStructuredStatement('record.create', label)
  if (!id) return null
  if (!await setStructuredSchema(id, schemaReference)) return null
  return id
}

function outputRef(node, port = 'value') {
  return { kind: 'output', node, port }
}

async function setRecordFieldReference(recordId, fieldName, reference, label = fieldName) {
  const ok = await applyStructuralReference(recordId, `field:${fieldName}`, reference)
  if (!ok) blocker('RECORD_FIELD_REFERENCE_FAILED', { recordId, fieldName, reference, label })
  return ok
}

async function setRecordFieldExpression(recordId, fieldName, source, label = fieldName) {
  console.log('[author field]', label)
  await applySentenceExpression(recordId, 'field:' + fieldName, source)
  await delay(180)
  return true
}

async function setSentenceInputLiteral(statementId, slotName, label = slotName) {
  await openSentenceSlot(statementId, 'input', slotName)
  const detail = activeDetailSelector()
  const sourceSelector = `${detail} [data-sentence-value-source=${JSON.stringify(slotName)}]`
  await until(`Boolean(document.querySelector(${JSON.stringify(sourceSelector)}))`, `常量输入 ${label}`)
  const result = await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(sourceSelector)});select.value='literal';select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`)
  if (result !== 'literal') {
    blocker('SENTENCE_LITERAL_INPUT_FAILED', { statementId, slotName, label, result })
    return false
  }
  await delay(220)
  return true
}

async function applyStructuralReference(statementId, slotName, reference) {
  await openSentenceStatement(statementId)
  const detail = activeDetailSelector()
  // Full structured editors expose record fields by their field name, while
  // the focused slot editor prefixes them with `field:`. Accept both stable
  // UI forms so the smoke follows the same visible control after a rerender.
  const sourceNames = String(slotName).startsWith('field:')
    ? [slotName, String(slotName).slice('field:'.length)]
    : [slotName]
  const sourceSelector = sourceNames.map(name => `${detail} [data-sentence-value-source=${JSON.stringify(name)}]`).join(',')
  await until(`Boolean(document.querySelector(${JSON.stringify(sourceSelector)}))`, `结构引用 ${slotName}`)
  const encoded = JSON.stringify(reference)
  const result = await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(sourceSelector)});if(!select)return {ok:false,reason:'MISSING'};select.value=${JSON.stringify(encoded)};if(select.value!==${JSON.stringify(encoded)})return {ok:false,reason:'REFERENCE_MISSING',options:[...select.options].map(item=>({value:item.value,text:item.textContent}))};select.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,value:select.value}})()`)
  if (!result?.ok) {
    blocker('STRUCTURAL_REFERENCE_CONTROL_MISSING', { statementId, slotName, reference, ...result })
    return false
  }
  await delay(180)
  return true
}


async function openSentenceStatement(statementId) {
  const detail = activeDetailSelector()
  if (!await visible(sentenceDetailSelector())) {
    const effectTab = `${detail} [data-editor-mode="cluster"]`
    if (await visible(effectTab)) await click(effectTab, '编辑效果')
    await until(`Boolean(document.querySelector(${JSON.stringify(sentenceDetailSelector())})?.offsetParent)`, '中文句子编辑器可见')
  }
  const row = `${detail} [data-sentence-node=${JSON.stringify(statementId)}]`
  const editor = `${detail} [data-sentence-inline-editor="${statementId}"]`
  // A focused slot editor and the record-fields popover reuse the same
  // data-sentence-inline-editor id as the complete structured editor.  Do
  // not treat either transient panel as the statement editor: the next
  // field must return to the full record view so its own optional-expression
  // control can be opened.
  const structuredEditor = `${detail} .sentence-structured-editor[data-sentence-structured-editor="${statementId}"]:not(.sentence-slot-only-editor):not(.sentence-record-fields-editor)`
  if (await visible(structuredEditor)) return
  if (await visible(editor)) {
    const close = `${editor} .sentence-popover-close`
    if (await visible(close)) {
      await click(close, `关闭句子局部编辑 ${statementId}`)
      await until(`Boolean(document.querySelector(${JSON.stringify(structuredEditor)})) || !Boolean(document.querySelector(${JSON.stringify(editor)}))`, `恢复句子编辑器 ${statementId}`)
    }
    if (await visible(structuredEditor)) return
  }
  const menu = `${detail} [data-sentence-row-menu="${statementId}"]`
  const edit = `${menu} [data-sentence-row-action="edit"]`
  if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(edit)}))`)) {
    if (!await visible(edit)) await click(`${menu} > summary`, '展开更多操作')
    await until(`Boolean(document.querySelector(${JSON.stringify(edit)})?.offsetParent)`, '编辑操作可见')
    await click(edit, `编辑句子 ${statementId}`)
  } else {
    const token = `${detail} [data-sentence-slot-editor^="${statementId}:"]`
    if (await visible(token)) await click(token, `打开句子 ${statementId}`)
    else if (await visible(row)) await click(row, `选择句子 ${statementId}`)
  }
  await until(`Boolean(document.querySelector(${JSON.stringify(editor)}))`, `句子编辑器 ${statementId}`)
}

async function deleteSentenceStatement(statementId) {
  const detail = activeDetailSelector()
  const menu = `${detail} [data-sentence-row-menu=${JSON.stringify(statementId)}]`
  const action = `${menu} [data-sentence-row-action="delete"]`
  await until(`Boolean(document.querySelector(${JSON.stringify(action)}))`, `删除句子 ${statementId}`)
  await evaluate(`(()=>{const menu=document.querySelector(${JSON.stringify(menu)});const button=menu?.querySelector('[data-sentence-row-action="delete"]');if(!menu||!button)return false;menu.open=true;button.hidden=false;button.click();return true})()`)
  await delay(220)
}

async function openSentenceSlot(statementId, slotKind, slotName) {
  const detail = activeDetailSelector()
  const selector = `${detail} [data-sentence-slot-editor=${JSON.stringify(`${statementId}:${slotKind}:${slotName}`)}]`
  // A record field has two visible editor forms.  An existing field opened
  // from the row uses the `field:` slot name; an optional field that has not
  // been materialized yet is rendered directly in the structured editor with
  // its schema name.  Accept both names while keeping the stored field key
  // unchanged.
  const slotNames = String(slotName).startsWith('field:')
    ? [String(slotName), String(slotName).slice('field:'.length)]
    : [String(slotName)]
  const selectorFor = attribute => slotNames.map(name => `${detail} [${attribute}=${JSON.stringify(name)}]`).join(',')
  // Optional inputs do not get a slot token until they have a value. Open the
  // complete sentence editor in that case, then expand its optional-input
  // section so the same author expression control can be used to create the
  // first value. This is the real authoring path used by a blank document.
  if (await visible(selector)) await click(selector, `编辑${slotName}`)
  else {
    await openSentenceStatement(statementId)
    const inputSelector = selectorFor('data-sentence-module-input')
    const expressionSelector = selectorFor('data-sentence-author-expression')
    const directExpression = selectorFor('data-sentence-direct-expression')
    if (String(slotName).startsWith('field:') && !(await visible(expressionSelector)) && await evaluate(`Boolean(document.querySelector(${JSON.stringify(directExpression)}))`)) {
      await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(directExpression)});if(!button)return false;button.scrollIntoView({block:'center',inline:'nearest'});button.click();return true})()`)
      await delay(120)
    }
    // Record fields are exposed from the row through a second, visible
    // "编辑字段" control.  `openSentenceStatement` may already have an
    // ordinary structured editor open, so it intentionally returns early;
    // expand the record-field popover here before looking for the focused
    // author expression.  This keeps the helper on the same path a developer
    // uses for a newly created record instead of reaching into graph state.
    const recordFields = `${detail} [data-sentence-record-fields=${JSON.stringify(statementId)}]`
    if (String(slotName).startsWith('field:') && !(await visible(expressionSelector)) && await evaluate(`Boolean(document.querySelector(${JSON.stringify(recordFields)}))`)) {
      await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(recordFields)});if(!button)return false;button.scrollIntoView({block:'center',inline:'nearest'});button.click();return true})()`)
      await delay(120)
      const fieldToken = `${detail} [data-sentence-slot-editor=${JSON.stringify(`${statementId}:property:${slotName}`)}]`
      await until(`Boolean(document.querySelector(${JSON.stringify(fieldToken)}))`, `记录字段入口 ${slotName}`)
      await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(fieldToken)});if(!button)return false;button.scrollIntoView({block:'center',inline:'nearest'});button.click();return true})()`)
      await delay(120)
    }
    await until(`Boolean(document.querySelector(${JSON.stringify(inputSelector)})) || Boolean(document.querySelector(${JSON.stringify(expressionSelector)}))`, `可选输入 ${slotName}`)
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(inputSelector)});const details=input?.closest('details');if(details)details.open=true;return Boolean(input)||Boolean(document.querySelector(${JSON.stringify(expressionSelector)}))})()`)
    await delay(120)
  }
  const expressionSelector = selectorFor('data-sentence-author-expression')
  const sourceSelector = selectorFor('data-sentence-value-source')
  await until(`Boolean(document.querySelector(${JSON.stringify(expressionSelector)})) || Boolean(document.querySelector(${JSON.stringify(sourceSelector)}))`, `句子输入 ${slotName}`)
}

function objectEditorPanelSelector(statementId) {
  return `${activeDetailSelector()} [data-sentence-inline-editor=${JSON.stringify(statementId)}]`
}

function objectEditorExpression(statementId, editorIndex, body) {
  const panel = JSON.stringify(objectEditorPanelSelector(statementId))
  return `(()=>{const panel=document.querySelector(${panel});const roots=[...(panel?.querySelectorAll('.author-object-editor')||[])];const root=roots[${Number(editorIndex)}];return root?(()=>{${body}})():null})()`
}

async function setObjectFieldPresence(statementId, editorIndex, fieldPath, state = 'value') {
  const field = JSON.stringify(String(fieldPath))
  const expression = objectEditorExpression(statementId, editorIndex, `const control=[...root.querySelectorAll('[data-object-editor-field-include]')].find(item=>item.dataset.objectEditorFieldInclude===${field});return Boolean(control)`)
  await until(expression, `对象字段 ${fieldPath} 可用`)
  await evaluate(objectEditorExpression(statementId, editorIndex, `const control=[...root.querySelectorAll('[data-object-editor-field-include]')].find(item=>item.dataset.objectEditorFieldInclude===${field});if(!control)return null;control.scrollIntoView({block:'center',inline:'nearest'});control.value=${JSON.stringify(state)};control.dispatchEvent(new Event('change',{bubbles:true}));return control.value`))
  await delay(180)
}

async function fillObjectField(statementId, editorIndex, fieldPath, value, label = fieldPath) {
  const field = JSON.stringify(String(fieldPath))
  const expression = objectEditorExpression(statementId, editorIndex, `const control=[...root.querySelectorAll('[data-object-editor-value]')].find(item=>item.dataset.objectEditorValue===${field});return Boolean(control)`)
  await until(expression, `对象字段输入 ${label}`)
  const result = await evaluate(objectEditorExpression(statementId, editorIndex, `const control=[...root.querySelectorAll('[data-object-editor-value]')].find(item=>item.dataset.objectEditorValue===${field});if(!control)return {ok:false};control.scrollIntoView({block:'center',inline:'nearest'});control.focus();control.value=${JSON.stringify(String(value))};control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:control.tagName,value:control.value}`))
  if (!result?.ok) throw new Error(`OBJECT_FIELD_MISSING:${label}`)
  await delay(180)
}



async function addObjectMapEntry(statementId, editorIndex, mapPath, key, value, label = key, entryIndex = 0) {
  const field = JSON.stringify(String(mapPath))
  const expression = objectEditorExpression(statementId, editorIndex, `const map=[...root.querySelectorAll('[data-object-editor-map]')].find(item=>item.dataset.objectEditorMap===${field});return Boolean(map?.querySelector('[data-object-editor-map-add]'))`)
  await until(expression, `对象映射 ${label} 可添加`)
  await evaluate(objectEditorExpression(statementId, editorIndex, `const add=[...root.querySelectorAll('[data-object-editor-map-add]')].find(item=>item.dataset.objectEditorMapAdd===${field});if(!add)return false;add.scrollIntoView({block:'center',inline:'nearest'});add.click();return true`))
  await delay(180)
  const entryPath = `${mapPath ? `${mapPath}.` : ''}entries.${entryIndex}`
  await fillObjectField(statementId, editorIndex, `${entryPath}.0`, key, `${label}名称`)
  await fillObjectField(statementId, editorIndex, `${entryPath}.1`, value, `${label}值`)
}



async function applySentenceExpression(statementId, slotName, source) {
  console.log('[author input]', slotName, source)
  await openSentenceSlot(statementId, 'input', slotName)
  const detail = activeDetailSelector()
  const slotNames = String(slotName).startsWith('field:')
    ? [String(slotName), String(slotName).slice('field:'.length)]
    : [String(slotName)]
  const editorSelectors = slotNames.map(name => `${detail} [data-sentence-author-expression=${JSON.stringify(name)}] .ei-editor`)
  const applySelectors = slotNames.map(name => `${detail} [data-sentence-apply-expression=${JSON.stringify(name)}]`)
  const editorSelector = editorSelectors.join(',')
  const applySelector = applySelectors.join(',')
  if (!await evaluate(`Boolean(document.querySelector(${JSON.stringify(editorSelector)}))`)) {
    const direct = slotNames.map(name => `${detail} [data-sentence-direct-expression=${JSON.stringify(name)}]`).join(',')
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(direct)}))`)) await click(direct, '输入表达式')
  }
  await until(`Boolean(document.querySelector(${JSON.stringify(editorSelector)}))`, `表达式编辑器 ${slotName}`)
  await evaluate(`(()=>{const editor=document.querySelector(${JSON.stringify(editorSelector)});editor.scrollIntoView({block:'center',inline:'nearest'});editor.focus();editor.textContent=${JSON.stringify(source)};editor.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until(`document.querySelector(${JSON.stringify(applySelector)})?.disabled === false`, `表达式可应用 ${slotName}`)
  await click(applySelector, `应用表达式 ${slotName}`)
  await delay(180)
}

async function saveSentenceOutput(statementId, outputName, variableName) {
  await openSentenceEditor()
  const rowSelector = `${activeDetailSelector()} [data-sentence-node=${JSON.stringify(statementId)}]`
  await until(`Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`, `返回值行 ${outputName}`)
  const result = await evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(rowSelector)});const details=row?.querySelector('.sentence-result-names');if(!details)return {ok:false,reason:'RESULTS_NOT_AVAILABLE'};details.open=true;const inputs=[...details.querySelectorAll('input')];if(!inputs.length)return {ok:false,reason:'RESULT_INPUT_MISSING'};const input=inputs.find(item=>String(item.getAttribute('aria-label')||'').includes(${JSON.stringify(outputName)}))||inputs[0];input.value=${JSON.stringify(variableName)};input.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,value:input.value}})()`)
  if (!result?.ok) {
    blocker('RESULT_NAME_CONTROL_MISSING', { statementId, outputName, variableName, ...result })
    return false
  }
  await delay(220)
  return true
}

async function saveAll() {
  await until('Boolean(document.querySelector("#studio-save"))', '保存全部按钮')
  await click('#studio-save', '保存全部')
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await pageState()
    if (state.status.some(text => text.includes('已保存'))) return true
    if (state.jsonErrors.some(text => text) || state.status.some(text => /效果语句需要修正|保存失败|保存停止/.test(text))) {
      blocker('COMPLETE_PROGRAM_SAVE_BLOCKED', { collection: currentCollection, id: currentId, status: state.status, jsonErrors: state.jsonErrors, graph: state.graph })
      return false
    }
    await delay(100)
  }
  blocker('COMPLETE_PROGRAM_SAVE_TIMEOUT', { collection: currentCollection, id: currentId, page: await pageState() })
  return false
}

async function setSentenceParameter(statementId, name, value) {
  await openSentenceStatement(statementId)
  const detail = activeDetailSelector()
  const field = `${detail} [data-sentence-module-parameter=${JSON.stringify(name)}]`
  await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, `句子参数 ${name}`)
  const result = await evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(field)});const details=field.closest('details');if(details&&!details.open)details.querySelector('summary')?.click();const select=field.querySelector('[data-sentence-literal-enum],select');const checkbox=field.querySelector('input[type="checkbox"]');const input=field.querySelector('input:not([type="checkbox"]),textarea');if(select){const raw=${JSON.stringify(value)};const json=JSON.stringify(raw);const values=[...select.options].map(item=>item.value);select.value=values.includes(json)?json:String(raw);if(!values.includes(select.value))return {ok:false,reason:'OPTION_MISSING',options:[...select.options].map(item=>({value:item.value,text:item.textContent}))};select.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:'select',value:select.value}}if(checkbox){checkbox.checked=Boolean(${JSON.stringify(value)});checkbox.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:'checkbox',value:checkbox.checked}}if(input){input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:'input',value:input.value}}return {ok:false,reason:'CONTROL_MISSING',html:field.outerHTML.slice(0,5000)}})()`)
  if (!result.ok) {
    blocker('SENTENCE_PARAMETER_CONTROL_MISSING', { statementId, name, value, ...result })
    return false
  }
  await delay(180)
  return true
}

async function saveDraft() {
  await until('Boolean(document.querySelector("#studio-save-draft"))', '保存草稿按钮')
  await click('#studio-save-draft', '保存草稿')
  await until('Boolean(document.querySelector("#toast .toast-item"))', '草稿保存反馈', 100)
}

async function restartEditor() {
  socket?.close(); socket = null
  child?.kill()
  await delay(700)
  await launchEditor()
}

async function openExistingSkill(id) {
  await until('document.body.classList.contains("studio-surface") && Boolean(document.querySelector("#skills-list .entity-item"))', '能力组列表')
  await evaluate(`(()=>{document.querySelector('[data-tab="skills"]').click();const item=document.querySelector('#skills-list [data-entity-id="'+${JSON.stringify(id)}+'"]');if(!item)throw new Error('SKILL_ITEM_MISSING:${id}');item.click()})()`)
  await until('document.querySelector("[data-tab=skills]")?.classList.contains("active")', '能力组页面')
  await until('Boolean(document.querySelector("#skills-detail [data-sentence-editor]"))', '能力组中文句子编辑器')
  currentCollection = 'skills'; currentId = id
}

async function openExistingRule(id) {
  await until('document.body.classList.contains("studio-surface") && Boolean(document.querySelector("#rules-list .entity-item"))', '规则列表')
  await evaluate(`(()=>{document.querySelector('[data-tab="rules"]').click();const item=document.querySelector('#rules-list [data-entity-id="'+${JSON.stringify(id)}+'"]');if(!item)throw new Error('RULE_ITEM_MISSING:${id}');item.click()})()`)
  await until('document.querySelector("[data-tab=rules]")?.classList.contains("active")', '规则页面')
  await until('Boolean(document.querySelector("#rules-detail [data-sentence-editor]"))', '规则中文句子编辑器')
  currentCollection = 'rules'; currentId = id
}

function copyDraftEnvelope(id, label, collection = currentCollection || 'skills') {
  const source = path.join(project, '.author-drafts', collection, `${id}.json`)
  if (!fs.existsSync(source)) return null
  const target = path.join(evidence, `${label}-draft-${id}.json`)
  fs.copyFileSync(source, target)
  return target
}

async function buildFireball() {
  console.log('[authoring] 从空白编写火球术')
  const id = await openNewSkill('火球术 · 从空白')
  await configureSkillBasics(1, 3, '选择五格内的一名敌人，造成自身攻击力乘以一点五的普通伤害。')
  await openSentenceEditor()
  await screenshot('developer-initial-empty')
  const target = await addSentenceModule('author.choice.target-piece', '选择棋子目标')
  await setSentenceParameter(target, 'range', 5)
  await setSentenceParameter(target, 'filter', 'enemy')
  const damage = await addSentenceModule('author.effect.damage', '造成伤害')
  if (damage) {
    await applySentenceExpression(damage, 'source', '当前棋子')
    await applySentenceExpression(damage, 'target', '目标')
    await applySentenceExpression(damage, 'amount', '当前棋子.攻击力 * 1.5')
  }
  const fireballGraph = await sentenceGraphSnapshot()
  const fireballDamage = findGraphStatement(fireballGraph, item => item?.kind === 'call' && item.module === 'author.effect.damage')
  assert.equal(fireballGraph?.body?.find(item => item?.id === target)?.parameters?.range, 5, '火球目标范围由中文参数控件设置为5')
  assert.equal(fireballGraph?.body?.find(item => item?.id === target)?.parameters?.filter, 'enemy', '火球目标筛选为敌方')
  assert.match(fireballDamage?.layout?.authorExpressions?.amount?.source || '', /攻击力\s*\*\s*1\.5/, '火球伤害量来自攻击力乘以1.5')
  assert.equal(fireballDamage?.parameters?.skillId, undefined, '火球不把内部技能 UUID 写入作者参数')
  observations.push({ stage: 'fireball-controls', target, graph: fireballGraph })
  await screenshot('developer-object-edit')
  const draftBeforeInvalid = await sentenceGraphSnapshot()
  const invalid = await addSentenceModule('author.effect.damage', '未完成的伤害句')
  await saveDraft()
  const savedFile = path.join(project, 'data', 'skills', `${id}.json`)
  assert.equal(fs.existsSync(savedFile), false, 'draft-only new document must stay outside data')
  const draftFile = copyDraftEnvelope(id, 'developer-incomplete')
  assert.ok(draftFile, 'draft envelope should be persisted outside data')
  await screenshot('developer-incomplete-draft')
  await restartEditor()
  await openExistingSkill(id)
  await openSentenceEditor()
  const reopened = await sentenceGraphSnapshot()
  observations.push({ stage: 'fireball-incomplete-reopened', incompleteModule: invalid, graph: reopened, draftFile })
  assert.ok(reopened?.body?.length >= (draftBeforeInvalid?.body?.length || 0), 'reopened draft preserves UI-authored modules')
  const statusText = await evaluate('[...document.querySelectorAll(".dirty-state")].map(node=>node.textContent||"").join(" | ")')
  assert.match(statusText, /草稿已保存|待创建|未保存/, 'reopened state is visibly a draft')
  await screenshot('developer-incomplete-reopened')
  // Delete the deliberately incomplete row through the visible row menu. This
  // keeps the draft/reopen check above while leaving one complete fireball
  // program for the formal save and engine follow-up.
  const invalidId = reopened.body.find(item => item.kind === 'call' && item.module === 'author.effect.damage' && (!item.inputs || Object.keys(item.inputs).length === 0))?.id
  if (!invalidId) blocker('INCOMPLETE_ROW_NOT_REOPENED', { id, graph: reopened })
  else await deleteSentenceStatement(invalidId)
  const repaired = await sentenceGraphSnapshot()
  assert.equal(repaired.body.filter(item => item?.kind === 'call' && item.module === 'author.effect.damage').length, 1, '删除未完成伤害后只保留完整火球伤害')
  const repairedDamage = findGraphStatement(repaired, item => item?.kind === 'call' && item.module === 'author.effect.damage')
  assert.match(repairedDamage?.layout?.authorExpressions?.amount?.source || '', /攻击力\s*\*\s*1\.5/, '重开后完整火球表达式仍保留')
  const completeSaved = await saveAll()
  if (!completeSaved) {
    // Keep the repaired graph as a draft so the exact UI-authored program is
    // still available for the engine follow-up and the next run can verify
    // the source fix without losing this reproduction.
    await saveDraft()
    await screenshot('developer-complete-save-blocked')
    return { id, status: 'blocked', graph: await sentenceGraphSnapshot(), artifact: copyDraftEnvelope(id, 'developer-complete-blocked') }
  }
  assert.equal(fs.existsSync(path.join(project, 'data', 'skills', `${id}.json`)), true, 'repaired UI document is created in data')
  const artifact = await writeArtifact('skills', id, 'developer-fireball')
  await screenshot('developer-complete-program')
  await restartEditor()
  await openExistingSkill(id)
  await openSentenceEditor()
  const reopenedSaved = await sentenceGraphSnapshot()
  const reopenedDamage = findGraphStatement(reopenedSaved, item => item?.kind === 'call' && item.module === 'author.effect.damage')
  assert.equal(reopenedSaved.body.filter(item => item?.kind === 'call' && item.module === 'author.effect.damage').length, 1, '正式保存并重开后火球仍只有一条伤害')
  assert.match(reopenedDamage?.layout?.authorExpressions?.amount?.source || '', /攻击力\s*\*\s*1\.5/, '正式保存并重开后火球表达式保留')
  await screenshot('developer-fireball-reopened')
  return { id, status: 'saved', graph: reopenedSaved, artifact }
}

async function addRootCondition(label = '条件分支') {
  const detail = activeDetailSelector()
  await openSentenceEditor()
  const button = `${detail} [data-sentence-add-condition]`
  await until(`Boolean(document.querySelector(${JSON.stringify(button)}))`, label)
  await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(button)});const menu=button?.closest('details');if(menu)menu.open=true;button?.click();return Boolean(button)})()`)
  await delay(220)
  const graph = await sentenceGraphSnapshot()
  const statement = findGraphStatement(graph, item => item?.kind === 'if' && item?.id)
  if (!statement) {
    blocker('ROOT_CONDITION_NOT_CREATED', { label, graph, page: await pageState() })
    return null
  }
  return statement.id
}

async function buildShadowClone(passiveRuleId) {
  console.log('[authoring] 从空白编写影分身')
  const id = await openNewSkill('影分身之术 · 从空白')
  await configureSkillBasics(1, 3, '选择五格内的空地，召唤一个分身；也可以传送至该地格，在原位留下分身。分身不能移动，受到伤害后消散，显示保留召唤时的本体数值。')
  await openSentenceEditor()
  const holder = '当前棋子'
  const target = await addSentenceModule('author.choice.target-cell', '选择地格目标')
  await setSentenceParameter(target, 'range', 5)
  await setSentenceParameter(target, 'filter', 'all')
  await setSentenceParameter(target, 'requireWalkable', true)
  await setSentenceParameter(target, 'requireUnoccupied', true)
  await saveSentenceOutput(target, 'cell', '落点')
  const option = await addSentenceModule('author.choice.option', '选择影分身方式')
  await setSentenceParameter(option, 'valueType', 'boolean')
  await setSentenceParameter(option, 'title', '是否传送并在原地留下分身')
  await setSentenceInputLiteral(option, 'options', '选项映射')
  await openSentenceStatement(option)
  await addObjectMapEntry(option, 0, '', '传送并在原地留下分身', true, '传送并在原地留下分身', 0)
  await addObjectMapEntry(option, 0, '', '在目标格召唤分身', false, '在目标格召唤分身', 1)
  await saveSentenceOutput(option, 'value', '选择传送')

  const originalPosition = await addSentenceModule('local.declare', '保存原位')
  await setSentenceParameter(originalPosition, 'valueType', 'cell')
  await setSentenceParameter(originalPosition, 'name', '原位')
  await applySentenceExpression(originalPosition, 'initial', '当前棋子.位置')

  const originalPositionRead = '原位'

  // Capture the live source before branching. Every template/display field
  // below comes from this typed snapshot or one of its typed record fields;
  // the authoring route never pastes a fixed clone shape into a summon call.
  const copy = await addSentenceModule('instance.copy-piece', '复制当前棋子实例')
  await applySentenceExpression(copy, 'piece', '当前棋子')
  await saveSentenceOutput(copy, 'snapshot', '实例副本')
  const snapshot = outputRef(copy, 'snapshot')
  // A saved result can be traversed directly with the same Chinese dot
  // expressions a developer writes in the editor. This keeps the graph
  // readable and exercises first-class record access instead of exposing a
  // chain of low-level record.get rows for every snapshot field.
  const snapshotFieldLabels = {
    templateId: '模板引用',
    name: '名称',
    ownerPlayerId: '所属玩家',
    faction: '阵营',
    isCore: '核心棋子',
    currentHp: '当前生命',
    maxHp: '最大生命',
    attack: '攻击力',
    defense: '防御力',
    moveRange: '移动力',
    shield: '护盾',
    skills: '技能',
    statusTags: '状态',
  }
  const snapshotFieldExpression = field => '实例副本.字段副本.' + (snapshotFieldLabels[field] || field)
  const snapshotIdentityExpression = field => '实例副本.身份.' + (snapshotFieldLabels[field] || field)

  const template = await addRecordCreate('author.piece-template@1', '创建影分身模板')
  await setRecordFieldReference(template, 'baseSnapshot', snapshot, '基础副本')
  await setStructuredLiteral(template, 'moveRange', 0, '移动范围')
  await setStructuredLiteral(template, 'skills', [], '初始技能')
  await setStructuredLiteral(template, 'statusTags', [], '初始状态')
  // rules is a declared list of rule-reference text values, so it uses the
  // recursive literal list control rather than the object editor (which is
  // reserved for record/map/set values).
  await setStructuredLiteral(template, 'rules', [passiveRuleId], '受伤后消散规则')
  await setStructuredObjectField(template, 'extension', '影分身标记', 'shadow-clone', '影分身标记')
  await saveSentenceOutput(template, 'value', '分身模板')

  const display = await addRecordCreate('author.piece-display@1', '创建影分身显示')
  const displayFields = ['templateId', 'name', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'shield', 'skills', 'statusTags', 'isCore', 'ownerPlayerId', 'faction']
  for (const field of displayFields) {
    const source = ['templateId', 'name', 'ownerPlayerId', 'faction'].includes(field)
      ? snapshotIdentityExpression(field)
      : snapshotFieldExpression(field)
    await setRecordFieldExpression(display, field, source, '显示' + field)
  }
  // Re-edit the same nested expression twice. Old generated reads must be
  // replaced, not accumulate as visible statements or dangling references.
  await setRecordFieldExpression(display, 'attack', snapshotFieldExpression('attack') + ' + 0')
  await setRecordFieldExpression(display, 'attack', snapshotFieldExpression('attack'))
  const editedDisplay = findGraphStatement(await sentenceGraphSnapshot(), item => item.id === display)
  assert.equal(editedDisplay.layout.authorExpressions.attack.nodes.length, 2, '重填字段会替换旧的嵌套读取')
  await saveSentenceOutput(display, 'value', '本体显示')
  const audiences = await addRecordCreate('author.piece-display-audiences@1', '创建显示对象')
  for (const audience of ['allies', 'enemies', 'spectators']) await setRecordFieldReference(audiences, audience, outputRef(display, 'value'), `${audience}显示`)
  await saveSentenceOutput(audiences, 'value', '各方显示')
  const displayPlan = await addRecordCreate('author.piece-display-plan@1', '创建显示方案')
  await setRecordFieldReference(displayPlan, 'audiences', outputRef(audiences, 'value'), '可见对象')
  await saveSentenceOutput(displayPlan, 'value', '分身显示方案')

  const condition = await addRootCondition()
  if (!condition) return { id, status: 'blocked', holder, target, option, originalPosition, originalPositionRead, copy, template, display, audiences, displayPlan }
  await applySentenceExpression(condition, 'condition', '选择传送')

  const teleport = await addBranchSentenceModule(condition, 'then', 'effect.displace-one', '传送到目标地格')
  if (teleport) {
    await setSentenceParameter(teleport, 'kind', 'teleport')
    await applySentenceExpression(teleport, 'piece', '当前棋子')
    await applySentenceExpression(teleport, 'destination', '落点')
  }
  // The summon is deliberately sequenced after the common displacement
  // action.  A failed displacement is left to the shared movement/summon
  // runtime legality checks; the author graph does not add a role-specific
  // success fallback branch.
  const thenSummon = await addBranchSentenceModule(condition, 'then', 'author.effect.summon', '在原位召唤影分身')
  if (thenSummon) {
    await applySentenceExpression(thenSummon, 'source', '当前棋子')
    await applySentenceExpression(thenSummon, 'template', '分身模板')
    await applySentenceExpression(thenSummon, 'destination', '原位')
    await applySentenceExpression(thenSummon, 'display', '分身显示方案')
  }
  const elseSummon = await addBranchSentenceModule(condition, 'else', 'author.effect.summon', '在目标位置召唤影分身')
  if (elseSummon) {
    await applySentenceExpression(elseSummon, 'source', '当前棋子')
    await applySentenceExpression(elseSummon, 'template', '分身模板')
    await applySentenceExpression(elseSummon, 'destination', '落点')
    await applySentenceExpression(elseSummon, 'display', '分身显示方案')
  }
  const graph = await sentenceGraphSnapshot()
  const nestedCalls = []
  const visit = statements => {
    for (const statement of Array.isArray(statements) ? statements : []) {
      if (statement?.kind === 'call') nestedCalls.push(statement)
      visit(statement?.then); visit(statement?.else); visit(statement?.body)
    }
  }
  visit(graph?.body)
  assert.ok(nestedCalls.some(item => item.module === 'effect.displace-one'), '影分身分支包含统一位移')
  assert.equal(nestedCalls.some(item => item.module === 'effect.teleport'), false, '影分身不使用已退役的传送模块')
  assert.equal(nestedCalls.filter(item => item.module === 'author.effect.summon').length, 2, '影分身两个分支各包含一次召唤')
  assert.ok(nestedCalls.some(item => item.module === 'local.read'), '影分身读取保存的原位变量')
  assert.ok(nestedCalls.some(item => item.module === 'instance.copy-piece'), '影分身在分支前复制当前棋子快照')
  assert.equal(nestedCalls.some(item => item.module === 'author.piece.display'), false, '影分身不在召唤后修改当前棋子显示')
  const summonCalls = nestedCalls.filter(item => item.module === 'author.effect.summon')
  for (const summon of summonCalls) {
    assert.equal(summon.inputs?.template?.kind, 'output', '召唤使用动态模板记录')
    assert.equal(summon.inputs?.display?.kind, 'output', '召唤使用动态显示方案')
  }
  observations.push({ stage: 'shadowclone-complete-controls', id, holder, target, option, originalPosition, originalPositionRead, copy, snapshotName: '实例副本', template, display, audiences, displayPlan, condition, teleport, thenSummon, elseSummon, graph })
  await screenshot('developer-shadowclone-template')
  const saved = await saveAll()
  if (!saved) {
    await saveDraft()
    await screenshot('developer-shadowclone-save-blocked')
    return { id, status: 'blocked', graph: await sentenceGraphSnapshot(), draftFile: copyDraftEnvelope(id, 'developer-shadowclone-blocked', 'skills') }
  }
  const artifact = await writeArtifact('skills', id, 'developer-shadowclone-complete')
  await screenshot('developer-shadowclone-complete')
  await restartEditor()
  await openExistingSkill(id)
  await openSentenceEditor()
  const reopened = await sentenceGraphSnapshot()
  const reopenedCalls = []
  const visitReopened = statements => { for (const statement of Array.isArray(statements) ? statements : []) { if (statement?.kind === 'call') reopenedCalls.push(statement); visitReopened(statement?.then); visitReopened(statement?.else); visitReopened(statement?.body) } }
  visitReopened(reopened?.body)
  assert.equal(reopenedCalls.filter(item => item.module === 'author.effect.summon').length, 2, '正式保存并重开后两个分支召唤仍保留')
  assert.ok(reopenedCalls.some(item => item.module === 'effect.displace-one'), '正式保存并重开后统一位移仍保留')
  await screenshot('developer-shadowclone-reopened')
  await click(`${activeDetailSelector()} [data-sentence-record-fields=${JSON.stringify(template)}]`, '查看分身模板字段')
  await screenshot('developer-shadowclone-object')
  await click(`${activeDetailSelector()} .sentence-record-fields-editor .sentence-popover-close`, '关闭模板字段')
  return { id, status: 'saved', graph: reopened, artifact }
}

async function buildPassiveDelay() {
  const id = await openNewRule('受伤后消散 · 从空白')
  await click(`${activeDetailSelector()} [data-editor-mode="fields"]`, '编辑规则属性')
  await fill('[data-field-path="description"]', '受到伤害后消灭自身。', '规则说明')
  await fill('[data-field-path="trigger.type"]', 'afterDamageTaken', '触发时刻')
  await openSentenceEditor()
  const effect = await addSentenceModule('lifecycle.destroy', '消灭棋子')
  if (effect) await applySentenceExpression(effect, 'target', '当前棋子')
  const graph = await sentenceGraphSnapshot()
  const destroy = findGraphStatement(graph, item => item?.kind === 'call' && item.module === 'lifecycle.destroy')
  assert.ok(destroy, '被动规则包含受伤后消灭动作')
  assert.ok(destroy.layout?.authorExpressions?.target?.source === '当前棋子', '受伤后消灭目标由中文表达式设置')
  const documentDraft = await evaluate(`(()=>{try{return JSON.parse(document.querySelector(${JSON.stringify(`${activeDetailSelector()} [data-json-source]`)}).value)}catch{return null}})()`)
  assert.equal(documentDraft?.trigger?.type, 'afterDamageTaken', '被动规则触发时刻为受到伤害后')
  observations.push({ stage: 'passive-destroy-controls', id, effect, graph, trigger: documentDraft?.trigger })
  await screenshot('developer-passive-destroy')
  const saved = await saveAll()
  if (!saved) {
    await saveDraft()
    return { id, status: 'blocked', graph: await sentenceGraphSnapshot(), draftFile: copyDraftEnvelope(id, 'developer-passive-destroy-blocked', 'rules') }
  }
  const artifact = await writeArtifact('rules', id, 'developer-passive-destroy')
  await screenshot('developer-passive-destroy-saved')
  await restartEditor()
  await openExistingRule(id)
  await openSentenceEditor()
  const reopened = await sentenceGraphSnapshot()
  const reopenedDocument = await evaluate(`(()=>{try{return JSON.parse(document.querySelector(${JSON.stringify(`${activeDetailSelector()} [data-json-source]`)}).value)}catch{return null}})()`)
  assert.ok(findGraphStatement(reopened, item => item?.kind === 'call' && item.module === 'lifecycle.destroy'), '正式保存并重开后消灭动作仍保留')
  assert.equal(reopenedDocument?.trigger?.type, 'afterDamageTaken', '正式保存并重开后触发时刻仍为受到伤害后')
  await screenshot('developer-passive-destroy-reopened')
  return { id, status: 'saved', graph: reopened, artifact }
}

let outcome
try {
  await launchEditor()
  await until('document.body.classList.contains("studio-surface")', '工作台页面')
  await until('Boolean(document.querySelector("#skills-list"))', '能力组空列表')
  await screenshot('developer-initial-empty-shell')
  const passiveDelay = await buildPassiveDelay()
  const fireball = await buildFireball()
  const shadowclone = await buildShadowClone(passiveDelay.id)
  outcome = {
    ok: blockers.length === 0 && runtimeConsoleErrors.length === 0 && runtimeExceptions.length === 0
      && [passiveDelay, fireball, shadowclone].every(result => result.status === 'saved'),
    task: 'RED-252',
    role: 'implementation self-check / 实现者自检',
    project,
    userData,
    fromEmpty: true,
    fireball,
    shadowclone,
    passiveDelay,
    blockers,
    screenshots,
    artifacts,
    runtimeConsoleErrors,
    runtimeExceptions,
    observations,
  }
  fs.writeFileSync(path.join(evidence, 'developer-authoring-smoke.json'), JSON.stringify(outcome, null, 2) + '\n')
  console.log(JSON.stringify({ ok: outcome.ok, fromEmpty: true,
    status: { fireball: fireball.status, shadowclone: shadowclone.status, passive: passiveDelay.status },
    blockers, runtimeConsoleErrors, runtimeExceptions, report: path.join(evidence, 'developer-authoring-smoke.json') }))
  if (!outcome.ok) process.exitCode = 2
} catch (error) {
  const failure = {
    ok: false,
    task: 'RED-252',
    role: 'implementation self-check / 实现者自检',
    project,
    userData,
    blockers,
    screenshots,
    artifacts,
    runtimeConsoleErrors,
    runtimeExceptions,
    observations,
    error: error instanceof Error ? error.stack || error.message : String(error),
  }
  try { failure.page = await pageState(); failure.failureScreenshot = await screenshot('developer-authoring-failure') } catch (diagnosticError) { failure.diagnosticError = String(diagnosticError) }
  fs.writeFileSync(path.join(evidence, 'developer-authoring-smoke.failure.json'), JSON.stringify(failure, null, 2) + '\n')
  console.error(JSON.stringify({ ok: false, error: failure.error, report: path.join(evidence, 'developer-authoring-smoke.failure.json') }))
  process.exitCode = 1
} finally {
  socket?.close()
  child?.kill()
  // Keep the isolated project on disk until evidence review is complete. It
  // contains no user files and is the precise input for the engine follow-up.
}
