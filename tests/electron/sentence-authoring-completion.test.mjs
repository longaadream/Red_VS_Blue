import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/*
 * Real Electron coverage for the sentence authoring route. This deliberately
 * starts from a document without gameplayModules so the test exercises graph
 * creation, typed structured rows, declaration scopes, save/reopen, and a
 * save-blocking draft repair through the controls themselves.
 */
const require = createRequire(import.meta.url)
const root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const gameplayCore = require(path.join(root, 'electron-editor/gameplay-module-core.cjs'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-sentence-authoring-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const evidence = path.resolve(process.env.RVB_STUDIO_WORKBENCH_V2_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-studio-v2'))
fs.mkdirSync(evidence, { recursive: true })
const id = 'sentence-authoring-completion'
const original = {
  id,
  name: '结构化语句编辑验收',
  description: '由句子编辑器创建效果图',
  kind: 'active',
  type: 'normal',
  code: 'function executeSkill(context){ return { success: true }; }',
  extension: { preserveMe: true, nested: { value: 9 } },
}
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([id]) + '\n')
fs.writeFileSync(path.join(project, 'data/skills', `${id}.json`), JSON.stringify(original, null, 2) + '\n')
const cardId = `${id}-card`
fs.writeFileSync(path.join(project, 'data/cards/manifest.json'), JSON.stringify([cardId]) + '\n')
fs.writeFileSync(path.join(project, 'data/cards', `${cardId}.json`), JSON.stringify({ id: cardId, name: '空白卡牌效果', description: '从模块创建卡牌', type: 'active', actionPointCost: 1, code: 'function executeCard(context){ return { success: true }; }' }, null, 2) + '\n')
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

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++sequence
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`CDP timeout: ${method}`))
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
    try { if (await evaluate(expression)) return } catch { /* renderer is still mounting */ }
    await delay(100)
  }
  throw new Error(`UI condition timed out: ${expression}`)
}

async function click(selector) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing ${selector}');e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();if(!e.offsetParent||r.width<=0||r.height<=0)throw new Error('control is not visible: ${selector}');e.click()})()`)
  await delay(80)
}

async function change(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing ${selector}');e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();if(!e.offsetParent||r.width<=0||r.height<=0)throw new Error('control is not visible: ${selector}');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await delay(100)
}

async function applyAuthorExpression(name, source) {
  const editorSelector = `#skills-detail [data-sentence-author-expression=${JSON.stringify(name)}] .ei-editor`
  const applySelector = `#skills-detail [data-sentence-apply-expression=${JSON.stringify(name)}]`
  await evaluate(`(()=>{const editor=document.querySelector(${JSON.stringify(editorSelector)});if(!editor)throw new Error('missing author expression editor: ${name}');editor.scrollIntoView({block:'center',inline:'nearest'});editor.focus();editor.textContent=${JSON.stringify(source)};editor.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until(`document.querySelector(${JSON.stringify(applySelector)})?.disabled === false`)
  await click(applySelector)
  await delay(120)
}

async function openDetails(selector) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing ${selector}');if(!e.open)e.querySelector('summary')?.click()})()`)
  await delay(100)
}

async function openConfiguration(detailSelector) {
  const configuration = `${detailSelector} [data-sentence-graph-configuration]`
  const configurationAction = `${detailSelector} [data-sentence-configuration]`
  const alreadyRendered = await evaluate(`Boolean(document.querySelector(${JSON.stringify(configuration)}))`)
  if (alreadyRendered) await openDetails(configuration)
  else await click(configurationAction)
  await until(`Boolean(document.querySelector(${JSON.stringify(`${configuration}[open]`)}))`)
}

async function graph() {
  return evaluate(`JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules?.entries?.code?.graph || null`)
}

async function openSkillNamed(skillId = id) {
  await until("document.body.classList.contains('studio-surface') && Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate(`(()=>{
    document.querySelector('[data-tab=skills]').click()
    const item=document.querySelector('#skills-list [data-entity-id='+${JSON.stringify(skillId)}+']') || [...document.querySelectorAll('#skills-list .entity-item')].find(node=>node.querySelector('.id')?.textContent===${JSON.stringify(skillId)})
    if(!item)throw new Error('missing skill')
    item.scrollIntoView({block:'center',inline:'nearest'})
    item.click()
  })()`)
  await until("document.querySelector('[data-tab=skills]')?.classList.contains('active') && document.querySelector('#tab-skills')?.classList.contains('active')")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]')?.offsetParent)")
}

async function openSkill() {
  return openSkillNamed(id)
}

async function saveAll() {
  await until("Boolean(document.querySelector('#studio-save') && !document.querySelector('#studio-save').disabled)")
  await click('#studio-save')
  await until("document.querySelector('#studio-save')?.textContent === '保存'")
}

try {
  const targets = await (async () => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (startupError) throw startupError
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()
        const target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
        if (target) return target
      } catch {}
      await delay(250)
    }
    throw new Error('Editor startup timed out')
  })()
  socket = new WebSocket(targets.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await call('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })
  await openSkill()
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-empty-graph]'))"), true, 'a legacy document exposes graph creation controls')

  // The content-level summon declaration is created from the Chinese
  // configuration form, edited as structured fields, and remains visible
  // after the document is saved and reopened.  Empty required text keeps the
  // invalid draft visible and reports an immediate authoring error instead of
  // silently restoring the previous value.
  await click('#skills-detail [data-sentence-add-structured="root:record.create"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]'))")
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-add-summon-capability]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-summon-capability]'))")
  await change('#skills-detail [data-sentence-summon-max-summons]', '2')
  await click('#skills-detail [data-sentence-summon-mode="return-instance"]')
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).summonCapability.maxSummons"), 2, 'authored summon declaration keeps the edited maximum')
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).summonCapability.modes.includes('return-instance')"), true, 'authored summon declaration keeps the edited return mode')
  await change('#skills-detail [data-sentence-summon-recipe]', 'stored-or-declared-piece')
  await change('#skills-detail [data-sentence-summon-storage-key]', 'editor_stored_summon')
  await change('#skills-detail [data-sentence-summon-owner-storage-key]', 'editor_stored_summon_by_player')
  await change('#skills-detail [data-sentence-summon-unique-template]', '')
  await until("document.querySelector('#skills-detail .sentence-message.error')?.textContent.includes('唯一模板标识不能为空')")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).summonCapability.uniqueTemplateId"), '', 'required empty summon text remains in the draft')
  const rejectedSummonBytes = fs.readFileSync(path.join(project, 'data/skills', `${id}.json`))
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-save-json]').disabled"), true, 'invalid summon capability disables the document save action')
  await click('#studio-save')
  await until("Boolean(document.querySelector('#toast .toast-error'))")
  assert.deepEqual(fs.readFileSync(path.join(project, 'data/skills', `${id}.json`)), rejectedSummonBytes, 'invalid summon capability cannot overwrite the saved document')
  await change('#skills-detail [data-sentence-summon-unique-template]', 'editor-template')
  await change('#skills-detail [data-sentence-summon-fallback-prefix]', 'editor-piece-')
  await change('#skills-detail [data-sentence-summon-fallback-template]', 'editor-template-fallback')
  await change('#skills-detail [data-sentence-summon-fallback-name]', '')
  await until("document.querySelector('#skills-detail .sentence-message.error')?.textContent.includes('显示名称不能为空')")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).summonCapability.fallback.name"), '', 'required fallback text remains in the draft')
  await change('#skills-detail [data-sentence-summon-fallback-name]', '编辑器默认棋子')
  await change('#skills-detail [data-sentence-summon-fallback-max-hp]', '17')
  await change('#skills-detail [data-sentence-summon-fallback-attack]', '5')
  await change('#skills-detail [data-sentence-summon-fallback-defense]', '3')
  await change('#skills-detail [data-sentence-summon-fallback-move-range]', '2')
  await change('#skills-detail [data-sentence-summon-fallback-faction]', 'blue')
  await change('#skills-detail [data-sentence-summon-skill-id]', 'holy-smite')
  await change('#skills-detail [data-sentence-summon-skill-level]', '2')
  await change('#skills-detail [data-sentence-summon-skill-cooldown]', '1')
  await change('#skills-detail [data-sentence-summon-unique-template]', 'editor-template-final')
  const summonCapabilityDraft = await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).summonCapability")
  assert.deepEqual(summonCapabilityDraft, {
    version: 1,
    recipe: 'stored-or-declared-piece',
    maxSummons: 1,
    storageExtensionKey: 'editor_stored_summon',
    ownerScopedStorageExtensionKey: 'editor_stored_summon_by_player',
    uniqueTemplateId: 'editor-template-final',
    fallback: {
      instanceIdPrefix: 'editor-piece-',
      templateId: 'editor-template-final',
      name: '编辑器默认棋子',
      faction: 'blue',
      maxHp: 17,
      attack: 5,
      defense: 3,
      moveRange: 2,
      skills: [{ skillId: 'holy-smite', level: 2, currentCooldown: 1 }],
    },
  }, 'summon declaration fields persist as one structured capability')

  // Start from the sentence editor and declare a schema used by typed records.
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]'))")
  await delay(300)
  const firstDraftState = await evaluate(`({
    graph: Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]')),
    config: Boolean(document.querySelector('#skills-detail [data-sentence-graph-configuration]')),
    diagnostic: document.querySelector('#skills-detail [data-sentence-diagnostic]')?.textContent || '',
    saveDisabled: document.querySelector('#skills-detail [data-save-json]')?.disabled === true,
  })`)
  assert.equal(firstDraftState.graph, true)
  await click('#skills-detail [data-sentence-configuration]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-graph-configuration][open]'))")
  await click('#skills-detail [data-sentence-add-schema]')
  await click('#skills-detail [data-sentence-add-schema-field]')
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-schema-field="schema-1:field1"]'))`)
  await change('[data-sentence-schema-field="schema-1:field1"] [data-sentence-type-kind]', 'list')
  await change('[data-sentence-schema-field="schema-1:field1"] [data-sentence-nested-type] [data-sentence-type-kind]', 'number')
  await click('#skills-detail [data-sentence-node-kind="record.create"] [data-sentence-slot-editor][data-sentence-slot-name="schema"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-record-schema]'))")
  await change('#skills-detail [data-sentence-record-schema]', 'schema-1@v1')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.some(node=>node.kind==='record.create' && node.schema==='schema-1@v1')")
  await click('#skills-detail [data-sentence-record-fields]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-record-fields-editor]'))")
  const recordFieldState = await evaluate(`(()=>{const root=document.querySelector('#skills-detail');return {fieldsEditor:Boolean(root.querySelector('[data-sentence-record-fields-editor]')),expressions:root.querySelectorAll('[data-sentence-record-fields-editor] .sentence-author-expression').length,fieldPanels:[...root.querySelectorAll('[data-sentence-record-fields-editor] [data-sentence-slot-editor]')].map(node=>({slot:node.getAttribute('data-sentence-slot-editor'),name:node.dataset.sentenceSlotName,text:node.textContent})),html:root.querySelector('[data-sentence-record-fields-editor]')?.outerHTML?.slice(0,12000)||''}})()`)
  fs.writeFileSync(path.join(evidence, 'record-fields-after-schema.json'), JSON.stringify(recordFieldState, null, 2) + '\n')
  await click('#skills-detail [data-sentence-record-fields-editor] [data-sentence-slot-editor]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression=\"field:field1\"]'))")
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression=\"field:field1\"]'))"), true, 'record fields use the shared sentence expression editor')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression=\"field:field1\"] .sentence-literal-list'))"), false, 'record fields do not switch to a separate list form')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-author-expression=\"field:field1\"] .ei-editor')?.textContent"), '{}', 'an empty tuple starts as the expression {}')
  await evaluate(`(()=>{const editor=document.querySelector('#skills-detail [data-sentence-author-expression="field:field1"] .ei-editor');if(!editor)throw new Error('missing record field expression editor');editor.focus();editor.textContent='{1,2}';editor.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until("document.querySelector('#skills-detail [data-sentence-author-expression=\"field:field1\"] .sentence-author-expression-type')?.dataset.valid === 'true'")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-apply-expression=\"field:field1\"]')?.disabled"), false, 'a typed tuple expression can be applied')
  await click('#skills-detail [data-sentence-apply-expression="field:field1"]')
  await until(`(()=>{const graph=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph;const record=graph.body.find(node=>node.kind==='record.create');return record?.fields?.field1?.kind==='output' && Boolean(graph.body.find(node=>node.id===record.fields.field1.node))})()`)
  const authoredRecordGraph = await graph()
  const authoredRecord = authoredRecordGraph.body.find(node => node.kind === 'record.create')
  assert.equal(authoredRecord.fields.field1.kind, 'output', 'tuple expression lowers to a graph value')
  assert.ok(['collection.singleton', 'collection.concat'].includes(authoredRecordGraph.body.find(node => node.id === authoredRecord.fields.field1.node)?.module), 'tuple expression uses registered collection modules')

  const recordId = (await graph()).body.find(node => node.kind === 'record.create').id
  await click('#skills-detail [data-sentence-add-structured="root:collection.map"]')
  const collectionId = (await graph()).body.find(node => node.kind === 'collection').id
  await click(`#skills-detail [data-sentence-add-structured="${collectionId}:body:return"]`)
  await until(`JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(node=>node.id===${JSON.stringify(collectionId)})?.body?.some(node=>node.kind==='return')`)

  // Typed record.get/record.with rows can select the earlier record output.
  await click('#skills-detail [data-sentence-add-structured="root:record.get"]')
  const getId = (await graph()).body.find(node => node.kind === 'record.get').id
  const recordBinding = `${recordId}_value`.replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^(?=\d)/u, '_')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression]'))")
  await applyAuthorExpression('record', recordBinding)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-record-field]'))")
  await change('[data-sentence-record-field]', 'field1')
  await click('#skills-detail [data-sentence-add-structured="root:record.with"]')
  const withId = (await graph()).body.find(node => node.kind === 'record.with').id
  await applyAuthorExpression('record', recordBinding)

  // Declarations are edited in place and their child graphs have independent
  // scope navigation/ports.
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-add-composite]')
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-composite="composite-1@v1"]'))`)
  // Adding a declaration rerenders the inspector. Reopen its configuration
  // disclosure before navigating to controls in the newly rendered card.
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-composite="composite-1@v1"] [data-sentence-add-port="inputs"]')
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-composite="composite-1@v1"] [data-sentence-add-port="outputs"]')
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-enter-scope="composite:composite-1@v1"]')
  await until("document.querySelector('#skills-detail [data-sentence-scope-navigation]')?.textContent.includes('组合 · composite-1')")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-scope-navigation]').getAttribute('aria-label')"), '效果编辑范围')
  await click('#skills-detail [data-sentence-add-structured="root:return"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-scope-navigation]'))")
  await click('#skills-detail [data-sentence-scope="root"]')
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-add-continuation]')
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-continuation="continuation-1@v1"]'))`)
  await openConfiguration('#skills-detail')
  await change('#skills-detail [data-sentence-continuation="continuation-1@v1"] [data-sentence-type-kind]', 'record-schema')
  await openConfiguration('#skills-detail')
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-continuation="continuation-1@v1"] [data-sentence-record-type]'))`)
  await change('#skills-detail [data-sentence-continuation="continuation-1@v1"] [data-sentence-record-type]', 'schema-1@v1')
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-continuation="continuation-1@v1"] [data-sentence-add-port="inputs"]')
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-continuation="continuation-1@v1"] [data-sentence-add-port="outputs"]')
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-enter-scope="continuation:continuation-1@v1"]')
  await until("document.querySelector('#skills-detail [data-sentence-scope-navigation]')?.textContent.includes('续接 · continuation-1')")
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-add-port="inputs"]')
  await openConfiguration('#skills-detail')
  await click('#skills-detail [data-sentence-add-structured="root:return"]')
  await click('#skills-detail [data-sentence-scope="root"]')

  // Defer-choice is authored against the continuation and a typed record ref.
  await click('#skills-detail [data-sentence-add-structured="root:defer-choice"]')
  await change('[data-sentence-continuation-ref]', 'continuation-1@v1')
  await applyAuthorExpression('payload', recordBinding)
  try {
    await until("!document.querySelector('#skills-detail [data-sentence-diagnostic]')")
  } catch (error) {
    const deferDiagnostic = await evaluate(`(()=>({diagnostic:document.querySelector('#skills-detail [data-sentence-diagnostic]')?.textContent||'',html:document.querySelector('#skills-detail')?.innerHTML?.slice(0,24000)||'',draft:document.querySelector('#skills-detail [data-json-source]')?.value||''}))()`)
    fs.writeFileSync(path.join(evidence, 'defer-choice-diagnostic.json'), JSON.stringify(deferDiagnostic, null, 2) + '\n')
    throw error
  }
  const beforeSave = await graph()
  assert.ok(beforeSave.body.some(node => node.kind === 'defer-choice'))
  assert.ok(beforeSave.body.some(node => node.kind === 'record.get' && node.id === getId))
  assert.ok(beforeSave.body.some(node => node.kind === 'record.with' && node.id === withId))
  assert.equal(beforeSave.composites.length, 1)
  assert.equal(beforeSave.continuations.length, 1)
  const statementIds = await evaluate(`(() => {
    const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph
    const ids = []
    const visit = body => (Array.isArray(body) ? body : []).forEach(item => {
      if (item?.id) ids.push(item.id)
      visit(item?.then); visit(item?.else); visit(item?.body); visit(item?.condition?.body)
    })
    visit(graph.body)
    for (const composite of graph.composites || []) visit(composite.body)
    for (const continuation of graph.continuations || []) { visit(continuation.graph?.body); for (const composite of continuation.graph?.composites || []) visit(composite.body) }
    return ids
  })()`)
  assert.equal(new Set(statementIds).size, statementIds.length, 'nested scopes allocate globally unique statement IDs')

  await saveAll()
  const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', `${id}.json`), 'utf8'))
  assert.equal(persisted.extension.preserveMe, true)
  assert.equal(persisted.gameplayModules.entries.code.compilerVersion, 'rvb-gameplay-module-compiler/v3')
  assert.equal(persisted.gameplayModules.entries.code.graph.composites.length, 1)
  assert.equal(persisted.gameplayModules.entries.code.graph.continuations.length, 1)
  assert.deepEqual(persisted.summonCapability, summonCapabilityDraft, 'saved content retains the structured summon declaration')

  await call('Page.reload')
  await openSkill()
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]'))")
  const reopened = await graph()
  assert.deepEqual(reopened.body.map(node => node.kind), beforeSave.body.map(node => node.kind), 'saved structured rows survive reopen')
  assert.equal(reopened.composites.length, 1)
  assert.equal(reopened.continuations.length, 1)
  assert.deepEqual(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).summonCapability"), summonCapabilityDraft, 'summon declaration fields survive reopen')

  // Add an invalid row, observe the save gate, then repair it through typed
  // controls. This is the raw draft path; no JSON source editing is involved.
  await click('#skills-detail [data-sentence-add-structured="root:record.get"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-diagnostic]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-save-json]').disabled"), true)
  assert.equal(await evaluate("document.querySelector('#studio-save').disabled"), false)
  const invalidId = (await graph()).body.find(node => node.kind === 'record.get' && node.record?.kind === 'literal')?.id
  assert.ok(invalidId)
  const rejectedBytes = fs.readFileSync(path.join(project, 'data/skills', `${id}.json`))
  await click('#studio-save')
  await until("Boolean(document.querySelector('#toast .toast-error'))")
  assert.deepEqual(fs.readFileSync(path.join(project, 'data/skills', `${id}.json`)), rejectedBytes, 'top-level Save All must keep invalid drafts out of the file')
  await applyAuthorExpression('record', recordBinding)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-record-field]'))")
  await change('[data-sentence-record-field]', 'field1')
  await until("!document.querySelector('#skills-detail [data-sentence-diagnostic]')")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-save-json]').disabled"), false)
  await saveAll()
  const repaired = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', `${id}.json`), 'utf8'))
  const repairedNode = repaired.gameplayModules.entries.code.graph.body.find(node => node.id === invalidId)
  assert.equal(repairedNode.record.kind, 'output')
  assert.equal(repairedNode.field, 'field1')

  // Seed two valid entries, then use the visible field selector to make both
  // drafts invalid. Repairing the first entry must compile that entry while
  // the sibling remains invalid; saving is still rejected until the sibling
  // is repaired as well.
  const skillFixtureGraph = gameplayCore.createGameplayModuleGraph('skill')
  skillFixtureGraph.outputs = [{ name: 'value', type: 'boolean' }]
  skillFixtureGraph.body = [{ kind: 'return', id: 'fixture-skill-return', value: { kind: 'literal', value: true } }]
  const previewFixtureGraph = gameplayCore.createGameplayModuleGraph('preview')
  previewFixtureGraph.outputs = [{ name: 'value', type: 'boolean' }]
  previewFixtureGraph.body = [{ kind: 'return', id: 'fixture-preview-return', value: { kind: 'literal', value: true } }]
  const skillFixture = gameplayCore.compileGameplayModuleGraph(skillFixtureGraph, gameplayCore.GAMEPLAY_MODULE_REGISTRY)
  const previewFixture = gameplayCore.compileGameplayModuleGraph(previewFixtureGraph, gameplayCore.GAMEPLAY_MODULE_REGISTRY)
  const siblingSeed = JSON.parse(JSON.stringify(repaired))
  siblingSeed.code = skillFixture.code
  siblingSeed.previewCode = previewFixture.code
  siblingSeed.gameplayModules.entries.code = { graph: skillFixtureGraph, compilerVersion: skillFixture.compilerVersion }
  siblingSeed.gameplayModules.entries.previewCode = { graph: previewFixtureGraph, compilerVersion: previewFixture.compilerVersion }
  siblingSeed.contentGraph = JSON.parse(JSON.stringify(skillFixtureGraph))
  siblingSeed.contentGraphField = 'code'
  siblingSeed.contentGraphCompilerVersion = skillFixture.compilerVersion
  fs.writeFileSync(path.join(project, 'data/skills', `${id}.json`), JSON.stringify(siblingSeed, null, 2) + '\n')

  await call('Page.reload')
  await openSkill()
  const fieldSelector = '#skills-detail [data-sentence-entry]'
  const outputTypeSelector = '#skills-detail [data-sentence-port="outputs:value"] [data-sentence-type-kind]'
  await until(`document.querySelector(${JSON.stringify(fieldSelector)})?.value === 'code'`)
  await openConfiguration('#skills-detail')
  await until(`document.querySelector(${JSON.stringify(outputTypeSelector)})?.value === 'boolean'`)
  await change(outputTypeSelector, 'string')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.outputs[0].type === 'string'")
  await until("!JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.compilerVersion")

  await change(fieldSelector, 'previewCode')
  await until(`document.querySelector(${JSON.stringify(fieldSelector)})?.value === 'previewCode'`)
  await openConfiguration('#skills-detail')
  await until(`document.querySelector(${JSON.stringify(outputTypeSelector)})?.value === 'boolean'`)
  await change(outputTypeSelector, 'string')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.previewCode.graph.outputs[0].type === 'string'")
  await until("!JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.previewCode.compilerVersion")
  const bothInvalid = await evaluate(`(() => {
    const value = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries
    return { codeCompiler: value.code?.compilerVersion || null, previewCompiler: value.previewCode?.compilerVersion || null, codeType: value.code?.graph?.outputs?.[0]?.type, previewType: value.previewCode?.graph?.outputs?.[0]?.type }
  })()`)
  assert.deepEqual(bothInvalid, { codeCompiler: null, previewCompiler: null, codeType: 'string', previewType: 'string' })

  await change(fieldSelector, 'code')
  await until(`document.querySelector(${JSON.stringify(fieldSelector)})?.value === 'code'`)
  await openConfiguration('#skills-detail')
  await change(outputTypeSelector, 'boolean')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.compilerVersion === 'rvb-gameplay-module-compiler/v3'")
  assert.equal(await evaluate("Boolean(JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.previewCode.compilerVersion)"), false, 'first repair keeps the sibling invalid')
  assert.equal(await evaluate("Boolean(JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).contentGraph)"), false, 'repair removes the replaced legacy graph artifact')
  const siblingRejectedBytes = fs.readFileSync(path.join(project, 'data/skills', `${id}.json`))
  await click('#studio-save')
  await until("Boolean(document.querySelector('#toast .toast-error'))")
  assert.deepEqual(fs.readFileSync(path.join(project, 'data/skills', `${id}.json`)), siblingRejectedBytes, 'Save All remains blocked while a sibling entry is invalid')

  await change(fieldSelector, 'previewCode')
  await until(`document.querySelector(${JSON.stringify(fieldSelector)})?.value === 'previewCode'`)
  await openConfiguration('#skills-detail')
  await change(outputTypeSelector, 'boolean')
  await until(`(() => { const entries = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries; return entries.code.compilerVersion === 'rvb-gameplay-module-compiler/v3' && entries.previewCode.compilerVersion === 'rvb-gameplay-module-compiler/v3' })()`)
  await saveAll()
  const multiSaved = JSON.parse(fs.readFileSync(path.join(project, 'data/skills', `${id}.json`), 'utf8'))
  assert.equal(multiSaved.gameplayModules.entries.code.compilerVersion, 'rvb-gameplay-module-compiler/v3')
  assert.equal(multiSaved.gameplayModules.entries.previewCode.compilerVersion, 'rvb-gameplay-module-compiler/v3')
  assert.equal(multiSaved.gameplayModules.entries.code.graph.outputs[0].type, 'boolean')
  assert.equal(multiSaved.gameplayModules.entries.previewCode.graph.outputs[0].type, 'boolean')
  assert.equal(Object.hasOwn(multiSaved, 'contentGraph'), false)
  assert.equal(Object.hasOwn(multiSaved, 'contentGraphEntries'), false)

  await call('Page.reload')
  await openSkill()
  await until(`document.querySelector(${JSON.stringify(fieldSelector)})?.value === 'code'`)
  await change(fieldSelector, 'previewCode')
  await until(`document.querySelector(${JSON.stringify(fieldSelector)})?.value === 'previewCode'`)
  const reopenedEntries = await evaluate(`(() => { const entries = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries; return { codeCompiler: entries.code.compilerVersion, previewCompiler: entries.previewCode.compilerVersion, codeType: entries.code.graph.outputs[0].type, previewType: entries.previewCode.graph.outputs[0].type } })()`)
  assert.deepEqual(reopenedEntries, { codeCompiler: 'rvb-gameplay-module-compiler/v3', previewCompiler: 'rvb-gameplay-module-compiler/v3', codeType: 'boolean', previewType: 'boolean' }, 'both repaired entries survive reopen')

  // A legacy lowered graph may have no authorExpressions metadata for a
  // static coordinate tuple. The range picker must reconstruct that safe
  // literal tuple while continuing to reject dynamic references.
  const rangeId = `${id}-range`
  const center = gameplayCore.lowerAuthorExpression('坐标(3, 3)', { surface: 'skill', prefix: 'center' })
  const offsets = gameplayCore.lowerAuthorExpression('{坐标(0, 0)}', { surface: 'skill', prefix: 'offsets' })
  const rangeGraph = {
    version: 'rvb-gameplay-modules/v1', surface: 'skill', body: [
      ...center.statements,
      ...offsets.statements,
      { kind: 'call', id: 'range', module: 'spatial.relative-cells', version: '1', inputs: { center: center.value, offsets: offsets.value }, parameters: {} },
    ],
  }
  const rangeDraft = gameplayCore.applyGameplayModuleGraph({ id: rangeId, name: '变量与范围', kind: 'active', type: 'normal' }, rangeGraph)
  fs.writeFileSync(path.join(project, 'data/skills', `${rangeId}.json`), JSON.stringify(rangeDraft, null, 2) + '\n')
  fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([id, rangeId]) + '\n')
  await call('Page.reload')
  await openSkillNamed(rangeId)
  await click('#skills-detail [data-sentence-slot-editor="range:input:offsets"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression=\"offsets\"] .ei-editor'))")
  await evaluate(`(()=>{const button=[...document.querySelectorAll('#skills-detail [data-sentence-author-expression="offsets"] button')].find(item=>item.textContent==='绘制相对范围');if(!button)throw new Error('missing range picker');button.click()})()`)
  await until("Boolean(document.querySelector('#skills-detail .sentence-range-picker'))")
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail .sentence-range-picker [aria-pressed=\"true\"]').length"), 1, 'static lowered coordinate tuple restores its existing cell')
  await click('#skills-detail .sentence-range-picker [aria-label="坐标(0,0)"]')
  await click('#skills-detail .sentence-range-picker [aria-label="坐标(1,0)"]')
  await click('#skills-detail .sentence-range-picker [aria-label="坐标(1,1)"]')
  await click('#skills-detail .sentence-range-picker button.sentence-link-action')
  await click('#skills-detail .sentence-range-picker [aria-label="坐标(1,0)"]')
  await click('#skills-detail .sentence-range-picker .sentence-author-expression-apply')
  const restoredRangeText = await evaluate("document.querySelector('#skills-detail [data-sentence-author-expression=\"offsets\"] .ei-editor')?.textContent || ''")
  assert(restoredRangeText.includes('{坐标(0, 0), 坐标(0, 1)}'), `static lowered coordinate tuples reopen in the range picker: ${restoredRangeText}`)
  await click('#skills-detail [data-sentence-apply-expression="offsets"]')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(node=>node.id==='range')?.layout?.authorExpressions?.offsets?.source?.includes('坐标(0, 1)')")
  await saveAll()
  await call('Page.reload')
  await openSkillNamed(rangeId)
  await click('#skills-detail [data-sentence-slot-editor="range:input:offsets"]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-author-expression=\"offsets\"] .ei-editor'))")
  await evaluate(`(()=>{const button=[...document.querySelectorAll('#skills-detail [data-sentence-author-expression="offsets"] button')].find(item=>item.textContent==='绘制相对范围');if(!button)throw new Error('missing range picker after save');button.click()})()`)
  await until("Boolean(document.querySelector('#skills-detail .sentence-range-picker'))")
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail .sentence-range-picker [aria-pressed=\"true\"]').length"), 2, 'saved static coordinate tuple restores both selected cells')
  await openSkill()

  const summary = {
    ok: true,
    id,
    bodyKinds: repaired.gameplayModules.entries.code.graph.body.map(node => node.kind),
    declarations: { composites: repaired.gameplayModules.entries.code.graph.composites.length, continuations: repaired.gameplayModules.entries.code.graph.continuations.length },
    nestedStatementIds: statementIds,
    multiEntry: { route: 'sentence-editor', bothInvalid, reopened: reopenedEntries },
    summonCapability: { invalidSaveRejected: true, persisted: summonCapabilityDraft, reopened: await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).summonCapability") },
    staticRange: { restoredCells: 2, saved: true },
    saveBlockedUntilAllEntriesValid: true,
    legacyArtifactReconciled: true,
    project,
    screenshot: path.join(evidence, 'sentence-authoring-completion.png'),
  }
  await evaluate("document.querySelector('#skills-detail').scrollTop = 0")
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'sentence-authoring-completion.png'), Buffer.from(screenshot.data, 'base64'))
  await click('[data-tab="cards"]')
  await click(`#cards-list [data-entity-id="${cardId}"]`)
  await until("Boolean(document.querySelector('#cards-detail [data-sentence-editor]')?.offsetParent)")
  await click('#cards-detail [data-sentence-add-condition]')
  await openConfiguration('#cards-detail')
  await click('#cards-detail [data-sentence-add-port="outputs"]')
  await click('#cards-detail [data-sentence-add-structured="root:return"]')
  const cardDraft = await evaluate("JSON.parse(document.querySelector('#cards-detail [data-json-source]').value)")
  if (!cardDraft.gameplayModules.entries.code.compilerVersion) throw new Error(JSON.stringify({ graph: cardDraft.gameplayModules.entries.code.graph, diagnostic: await evaluate("document.querySelector('#cards-detail [data-sentence-diagnostic]')?.textContent") }))
  gameplayCore.assertGameplayModuleDocument(cardDraft)
  await saveAll()
  const cardSaved = JSON.parse(fs.readFileSync(path.join(project, 'data/cards', `${cardId}.json`), 'utf8'))
  assert.equal(cardSaved.gameplayModules.entries.code.graph.surface, 'card', 'blank card creation uses the card runtime surface')
  gameplayCore.assertGameplayModuleDocument(cardSaved)
  summary.blankCardSurface = cardSaved.gameplayModules.entries.code.graph.surface
  fs.writeFileSync(path.join(evidence, 'sentence-authoring-completion.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary))
} catch (error) {
  try { console.error(await evaluate("document.querySelector('#toast')?.textContent")) } catch {}
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  try { socket?.close() } catch {}
  child.kill()
}
