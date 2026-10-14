import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/* Real Electron smoke for the graph-backed Chinese sentence editor. */
const require = createRequire(import.meta.url)
const root = process.cwd()
const evidence = process.env.RVB_SENTENCE_EDITOR_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-gameplay-module')
const skipTrial = process.env.RVB_SENTENCE_EDITOR_SKIP_TRIAL === '1'
const skipExtension = process.env.RVB_SENTENCE_EDITOR_SKIP_EXTENSION === '1'
fs.mkdirSync(evidence, { recursive: true })
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-sentence-editor-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
  const project = createContentProject(temporary, 'official', root)
const fireball = JSON.parse(fs.readFileSync(path.join(root, 'data/skills/fireball.json'), 'utf8'))
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
  extensionCall('ext-declare-player', 'extension.declare-player', {
    owner: output('smoke-player', 'player'), value: literal(1),
  }, { name: 'priorPlayer', valueType: 'number' }),
  extensionCall('ext-read-player', 'extension.read-player', {
    owner: output('smoke-player', 'player'),
  }, { namespace: 'content', name: 'savedPlayerState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('ext-write-player', 'extension.write-player', {
    owner: output('smoke-player', 'player'), value: output('ext-read-player', 'value'),
  }, { namespace: 'content', name: 'savedPlayerState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('ext-read-missing', 'extension.read-player', {
    owner: output('smoke-player', 'player'),
  }, { namespace: 'content', name: 'missingState', path: 'stats.hp', valueType: 'number' }),
  extensionCall('ext-declare-player-later', 'extension.declare-player', {
    owner: output('smoke-player', 'player'), value: literal(2),
  }, { namespace: 'content', name: 'laterPlayer', valueType: 'number' }),
  extensionCall('ext-declare-piece-root', 'extension.declare-piece', {
    owner: output('smoke-piece', 'piece'), value: literal(2),
  }, { name: 'rootPiece', valueType: 'number' }),
  extensionCall('ext-declare-piece-shared', 'extension.declare-piece', {
    owner: output('smoke-piece', 'piece'), value: literal(3),
  }, { name: 'priorPlayer', valueType: 'number' }),
  extensionCall('ext-declare-battle', 'extension.declare-battle', {
    value: literal(3),
  }, { namespace: 'content', name: 'battleState', valueType: 'number' }),
  extensionCall('ext-read-battle', 'extension.read-battle', {}, {
    namespace: 'content', name: 'battleState', path: '', valueType: 'number',
  }),
  extensionCall('ext-write-battle', 'extension.write-battle', {
    value: output('ext-read-battle', 'value'),
  }, { namespace: 'content', name: 'battleState', path: '', valueType: 'number' }),
  {
    kind: 'if',
    id: 'ext-scope',
    condition: literal(true),
    then: [
      extensionCall('ext-declare-piece-branch', 'extension.declare-piece', {
        owner: output('smoke-piece', 'piece'), value: literal(4),
      }, { namespace: 'content', name: 'branchPiece', valueType: 'number' }),
      extensionCall('ext-read-piece-then', 'extension.read-piece', {
        owner: output('smoke-piece', 'piece'),
      }, { namespace: 'content', name: 'branchPiece', path: 'stats.hp', valueType: 'number' }),
      extensionCall('ext-write-piece', 'extension.write-piece', {
        owner: output('smoke-piece', 'piece'), value: output('ext-read-piece-then', 'value'),
      }, { namespace: 'content', name: 'branchPiece', path: 'stats.hp', valueType: 'number' }),
    ],
    else: [
      extensionCall('ext-read-piece-else', 'extension.read-piece', {
        owner: output('smoke-piece', 'piece'),
      }, { namespace: 'content', name: 'branchPiece', path: 'stats.hp', valueType: 'number' }),
    ],
  },
]
const extensionReturnIndex = extensionGraph.body.findIndex(statement => statement?.kind === 'return')
extensionGraph.body.splice(extensionReturnIndex >= 0 ? extensionReturnIndex : extensionGraph.body.length, 0, ...extensionStatements)
  const jaina = JSON.parse(fs.readFileSync(path.join(root, 'data/pieces/jaina.json'), 'utf8'))
  fireball.editorSmokeUnknown = { preserved: true }
fs.writeFileSync(path.join(project, 'data', 'skills', 'fireball.json'), JSON.stringify(fireball, null, 2) + '\n')
fs.writeFileSync(path.join(project, 'data', 'skills', 'frostbolt.json'), JSON.stringify(frostbolt, null, 2) + '\n')
fs.writeFileSync(path.join(project, 'data', 'skills', 'extension-authoring-smoke.json'), JSON.stringify(extensionSmoke, null, 2) + '\n')
fs.writeFileSync(path.join(project, 'data', 'skills', 'manifest.json'), JSON.stringify(['fireball', 'frostbolt', 'extension-authoring-smoke']) + '\n')
  fs.writeFileSync(path.join(project, 'data', 'pieces', 'jaina.json'), JSON.stringify(jaina, null, 2) + '\n')
  fs.writeFileSync(path.join(project, 'data', 'pieces', 'manifest.json'), JSON.stringify(['jaina']) + '\n')
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
  if (process.env.RVB_SENTENCE_EDITOR_TRACE_CDP === '1') console.log(`cdp:evaluate ${expression.slice(0, 180)}`)
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt++) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error(`UI condition timed out: ${expression}`)
}

async function openSkill(id = 'fireball') {
  if (process.env.RVB_SENTENCE_EDITOR_TRACE_CDP === '1') console.log(`openSkill:start ${id}`)
  if (process.env.RVB_SENTENCE_EDITOR_TRACE_CDP === '1') console.log('openSkill:before-list')
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  if (process.env.RVB_SENTENCE_EDITOR_TRACE_CDP === '1') console.log('openSkill:before-click')
  await evaluate(`(()=>{document.querySelector('[data-tab=skills]').click();const e=[...document.querySelectorAll('#skills-list .entity-item')].find(x=>x.querySelector('.id').textContent===${JSON.stringify(id)});if(!e)throw new Error('missing '+${JSON.stringify(id)});e.click()})()`)
  if (process.env.RVB_SENTENCE_EDITOR_TRACE_CDP === '1') console.log('openSkill:before-editor')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))")
  if (process.env.RVB_SENTENCE_EDITOR_TRACE_CDP === '1') console.log(`openSkill:done ${id}`)
}

function draftExpression() {
  return `(()=>{const text=document.querySelector('#skills-detail [data-json-source]')?.value||'';return JSON.parse(text)})()`
}

async function changeControl(control, selector, value) {
  await evaluate(`(()=>{const button=document.querySelector('#skills-detail [data-sentence-control="${control}"]');if(!button)throw new Error('missing sentence control ${control}');button.click();const input=document.querySelector('#skills-detail ${selector}');if(!input)throw new Error('missing sentence input ${selector}');input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}

async function openStatementEditor(statementId) {
  await evaluate(`(()=>{const button=document.querySelector('#skills-detail [data-sentence-module-editor="${statementId}"]');if(!button)throw new Error('missing sentence module '+${JSON.stringify(statementId)});button.click()})()`)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"]'))`)
}

async function setModuleParameter(statementId, parameter, value) {
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-module-parameter="${parameter}"] input'))`)
  await evaluate(`(()=>{const field=document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-module-parameter="${parameter}"]');const details=field?.closest('details');if(details&&!details.open)details.querySelector('summary')?.click();const input=field?.querySelector('input');if(!input)throw new Error('missing module parameter '+${JSON.stringify(parameter)});input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}

async function setModuleValueType(statementId, mode) {
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]'))`)
  await evaluate(`(()=>{const select=document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]');if(!select)throw new Error('missing value type control');select.value=${JSON.stringify(mode)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}

async function setModuleRecordSchema(statementId, schema) {
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-record-type]'))`)
  await evaluate(`(()=>{const select=document.querySelector('#skills-detail [data-sentence-inline-editor="${statementId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-record-type]');if(!select)throw new Error('missing record schema control');select.value=${JSON.stringify(schema)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}

try {
  await connect()
  await openSkill()
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-editor]').dataset.sentenceKind"), 'active')
  assert.equal(await evaluate(`(()=>{const row=document.querySelector('#skills-list .entity-item.selected')?.getBoundingClientRect(), list=document.querySelector('#skills-list')?.getBoundingClientRect();return Boolean(row&&list&&row.top>=list.top-1&&row.bottom<=list.bottom+1)})()`), true, 'selected skill stays visible in its list')

  if (!skipTrial) {
    assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-trial]').textContent"), '试用技能')
    await evaluate("(()=>{const button=document.querySelector('#skills-detail [data-sentence-trial]');button.click();button.click();return button.disabled})()")
    assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-trial]')?.disabled"), true)
    await until("document.querySelector('#skills-detail [data-sentence-trial]')?.disabled===false")
    const trialMessage = await evaluate("document.querySelector('#skills-detail .sentence-message')?.textContent || ''")
    assert.match(trialMessage, /训练营已打开/, trialMessage)
    assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-step=\"1\"]').textContent.includes('使用时')"), true)
    assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"range\"]').textContent"), '5 格内')
    assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"target\"]').textContent"), '一名敌人')
    assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"multiplier\"]').textContent.includes('1.5')"), true)
    assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail .sentence-preview-image'))"), false)
    assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail .sentence-preview-icon'))"), false)
    assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail .sentence-title-icon'))"), false)
    assert.equal(await evaluate("document.querySelector('#skills-detail .sentence-preview h3')?.textContent"), '技能预览')
    assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail .sentence-preview-note'))"), false)
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })
  const defaultScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'sentence-editor-default.png'), Buffer.from(defaultScreenshot.data, 'base64'))
  await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"multiplier\"]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=\"multiplier\"]'))")
  const popupScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'sentence-editor-smoke.png'), Buffer.from(popupScreenshot.data, 'base64'))
  await evaluate("document.querySelector('#skills-detail [data-sentence-popover=\"multiplier\"] .sentence-popover-close').click()")

  await changeControl('range', '[data-sentence-range]', 7)
  let draft = await evaluate(draftExpression())
  const codeBody = draft.gameplayModules.entries.code.graph.body
  const choiceStatement = body => body.find(statement => statement.module === 'author.choice.target-piece' || statement.module === 'choice.target-piece' || statement.id === 'choice')
  const multiplierStatement = body => body.find(statement => statement.module === 'skill.power-multiplier' || statement.id === 'multiplier')
  assert.equal(choiceStatement(codeBody).parameters.range, 7)
  assert.equal(draft.targetText, '敌人（7）')
  assert.equal(draft.description, '选择敌人（7），造成1.5倍伤害。')
  assert.equal(draft.gameplayModules.entries.previewCode.graph.body.find(statement => statement.id === 'preview').inputs.description.value, draft.description)

  await changeControl('target', '[data-sentence-target]', 'ally')
  draft = await evaluate(draftExpression())
  assert.equal(choiceStatement(draft.gameplayModules.entries.code.graph.body).parameters.filter, 'ally')
  assert.equal(draft.description, '选择友军（7），造成1.5倍伤害。')

  await changeControl('multiplier', '[data-sentence-multiplier]', 2)
  draft = await evaluate(draftExpression())
  assert.equal(draft.powerMultiplier, 2)
  assert.equal(draft.description, '选择友军（7），造成2倍伤害。')
  assert.equal(multiplierStatement(draft.gameplayModules.entries.code.graph.body).module, 'skill.power-multiplier')
  assert.equal(draft.gameplayModules.entries.previewCode.graph.body.find(statement => statement.id === 'preview').inputs.description.value, draft.description)
  await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"multiplier\"]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=\"multiplier\"]'))")
  await evaluate("(()=>{const select=document.querySelector('#skills-detail [data-sentence-base-stat]');if(!select)throw new Error('missing base stat');select.value='defense';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  draft = await evaluate(draftExpression())
  assert.equal(draft.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'attack').parameters.attribute, 'defense')
  assert.equal(draft.gameplayModules.entries.previewCode.graph.body.find(statement => statement.id === 'attack').parameters.attribute, 'defense')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"multiplier\"]').textContent.includes('自身防御力')"), true)

  await evaluate("document.querySelector('#skills-detail [data-sentence-save]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存'")
  const persisted = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'fireball.json'), 'utf8'))
  assert.equal(persisted.powerMultiplier, 2)
  assert.equal(choiceStatement(persisted.gameplayModules.entries.code.graph.body).parameters.range, 7)
  assert.equal(choiceStatement(persisted.gameplayModules.entries.code.graph.body).parameters.filter, 'ally')
  assert.equal(persisted.description, '选择友军（7），造成2倍伤害。')
  assert.equal(persisted.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'attack').parameters.attribute, 'defense')
  assert.equal(persisted.gameplayModules.entries.previewCode.graph.body.find(statement => statement.id === 'attack').parameters.attribute, 'defense')

  await openSkill('fireball')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-sentence-step]').length"), 3, '火球迁移后保留三句效果投影')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-step=\"1\"]')?.textContent.includes('使用时')"), true)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-step=\"2\"]')?.textContent.includes('选择')"), true)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-step=\"3\"]')?.textContent.includes('造成')"), true)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"range\"]').textContent"), '7 格内')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"target\"]').textContent"), '一名友军')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"multiplier\"]').textContent.includes('2')"), true)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"multiplier\"]').textContent.includes('自身防御力')"), true)

  await openSkill('frostbolt')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-editor]').dataset.sentenceKind"), 'active')
  assert.equal(await evaluate(`(()=>{const row=document.querySelector('#skills-list .entity-item.selected')?.getBoundingClientRect(), list=document.querySelector('#skills-list')?.getBoundingClientRect();return Boolean(row&&list&&row.top>=list.top-1&&row.bottom<=list.bottom+1)})()`), true, 'selected skill stays visible in its list')

  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-graph-summary]'))"), true)
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-sentence-control]').length"), 0)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-graph-summary]').textContent.includes('选择棋子目标')"), true)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-graph-summary]').textContent.includes('造成伤害')"), true)
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-node-kind=if]'))"), true)
  const frostboltSummary = await evaluate("document.querySelector('#skills-detail [data-sentence-graph-summary]').textContent")
  assert.match(frostboltSummary, /状态|冰冻|冻结/, 'frostbolt status effect remains visible in the natural sentence projection')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-preview-description]')?.textContent"), frostbolt.description)

  const projectionShapes = await evaluate(`(()=>{
    const current=${draftExpression()};const source=current.gameplayModules.entries.code.graph;
    const graph={...source,body:[...source.body,
      {kind:'foreach',id:'smoke-loop',items:{kind:'literal',value:[]},body:[{kind:'return',id:'loop-return',values:{success:{kind:'literal',value:true}}}]},
      {kind:'while',id:'smoke-while',budget:2,condition:{body:[{kind:'return',id:'condition-return',value:{kind:'literal',value:false}}]},body:[{kind:'return',id:'while-return',values:{success:{kind:'literal',value:true}}}]},
      {kind:'defer-choice',id:'smoke-pending',graph:'smoke-cont',payload:{kind:'literal',value:null},title:{kind:'literal',value:'选择继续'}}],
      composites:[{id:'smoke-composite',version:'1',label:'可复用投影',inputs:[],outputs:[],body:[{kind:'return',id:'composite-return',values:{success:{kind:'literal',value:true}}}]}],
      continuations:[{id:'smoke-cont',version:'1',graph:{version:source.version,surface:'pending',body:[{kind:'return',id:'continuation-return',values:{success:{kind:'literal',value:true}}}]}}]};
    const draft={...current,gameplayModules:{...current.gameplayModules,entries:{...current.gameplayModules.entries,code:{...current.gameplayModules.entries.code,graph}}}};
    const host=document.createElement('div');host.style.width='320px';document.body.append(host);
    const core={getGameplayModuleGraph:()=>graph,getGameplayModuleCatalog:()=>window.ContentGraphCore.getGameplayModuleCatalog()};
    const editor=window.SkillSentenceEditor.mount(host,{core,field:'code',getDraft:()=>draft,openAdvanced:()=>{}});
     const text=host.textContent;const result={loop:text.includes('中的每一项'),while:text.includes('循环'),pending:text.includes('等待选择'),composite:text.includes('可复用投影'),continuation:text.includes('smoke-cont'),nodes:host.querySelectorAll('[data-sentence-node]').length};editor.destroy();return result;
  })()`)
  assert.equal(projectionShapes.loop, true)
  assert.equal(projectionShapes.while, true)
  assert.equal(projectionShapes.pending, true)
  assert.equal(projectionShapes.composite, true)
  assert.equal(projectionShapes.continuation, true)
  assert.ok(projectionShapes.nodes >= 20)

  const authoringUi = await evaluate(`(()=>{
    let draft=${draftExpression()};
    const host=document.createElement('div');host.style.width='320px';document.body.append(host);
    const graph={version:'rvb-gameplay-modules/v1',surface:'skill',inputs:[],outputs:[],body:[
       {kind:'call',id:'ui-existing',module:'ui.required',version:'1',inputs:{},parameters:{}},
       {kind:'if',id:'ui-condition',condition:{kind:'literal',value:true},then:[],else:[]},
       {kind:'record.create',id:'ui-record',schema:'ui-record@1',fields:{hp:{kind:'literal',value:3}}},
       {kind:'record.get',id:'ui-record-get',record:{kind:'output',node:'ui-record',port:'value'},field:'hp'}
     ],composites:[],schemas:[{id:'ui-record',version:'1',fields:[{name:'hp',label:'生命',type:'number'},{name:'label',label:'名称',type:'string'}]}],continuations:[]};
    draft={...draft,id:'sentence-editor-ui-fixture',gameplayModules:{version:'rvb-gameplay-module-document/v1',entries:{code:{graph}}}};
    const catalog=[
      {id:'ui.required',version:'1',label:'标准数据读取',description:'选择必要的数据输入后继续。',inputs:[{name:'target',label:'目标棋子',type:'piece'},{name:'amount',label:'数量',type:'number'},{name:'hint',label:'可选提示',type:'string',optional:true}],outputs:[{name:'value',type:'number'}],parameters:[{name:'mode',label:'模式',type:'string',enum:['safe','fast']},{name:'note',label:'备注',type:'string',optional:true}],allowedSurfaces:['skill'],effects:{pure:true},ui:{authoring:'standard',category:'data'}},
      {id:'ui.compat',version:'1',label:'兼容旧读取',description:'兼容入口。',inputs:[],outputs:[{name:'value',type:'number'}],allowedSurfaces:['skill'],effects:{pure:true},ui:{authoring:'compatibility',category:'query'}},
      {id:'ui.legacy',version:'1',label:'旧版来源',description:'无新元数据时仍可加入。',inputs:[],outputs:[{name:'value',type:'number'}],allowedSurfaces:['skill'],effects:{pure:true}}
    ];
    const core={getGameplayModuleGraph:()=>graph,getGameplayModuleCatalog:()=>catalog};
    const editor=window.SkillSentenceEditor.mount(host,{core,field:'code',root:{collection:'skills',id:draft.id},getDraft:()=>draft,onChange:next=>{draft=next}});
    const flow=()=>host.querySelector('[data-sentence-horizontal-scroll]')||host.querySelector('[data-sentence-scroll]');
    const toggle=host.querySelector('[data-sentence-collapse]');
    const nested=host.querySelector('[data-sentence-nested-block]');
    const beforeData=JSON.stringify(draft);
    const before={aria:toggle?.getAttribute('aria-expanded')||'',hidden:nested?.hidden===true,key:toggle?.dataset.sentenceCollapseKey||''};
    const scroll=flow();if(scroll)scroll.scrollLeft=37;
    toggle?.click();
    const afterToggle=host.querySelector('[data-sentence-collapse]');
    const afterNested=host.querySelector('[data-sentence-nested-block]');
    const afterFlow=flow();
    const collapsed={aria:afterToggle?.getAttribute('aria-expanded')||'',hidden:afterNested?.hidden===true,scrollLeft:afterFlow?.scrollLeft||0,dataUnchanged:JSON.stringify(draft)===beforeData,focusedKey:document.activeElement?.dataset?.sentenceCollapseKey||''};
    afterToggle?.click();
    host.querySelector('[data-sentence-add-effect]')?.click();
    const categories=[...host.querySelectorAll('.sentence-module-categories [data-sentence-module-category]')].map(node=>node.dataset.sentenceModuleCategory);
    const basicModules=[...host.querySelectorAll('[data-sentence-module]')].map(node=>node.dataset.sentenceModule);
    const compatibilityLabel=host.querySelector('.sentence-module-compatibility')?.textContent||'';
    const requiredOption=host.querySelector('[data-sentence-module="ui.required"]');requiredOption?.click();
    const inserted=(draft.gameplayModules.entries.code.graph.body||[]).find(node=>node?.id==='sentence-module-1');
    host.querySelector('[data-sentence-module-editor="ui-existing"]')?.click();
    const entryEditor=host.querySelector('[data-sentence-inline-editor]');
    const optionalDetails=entryEditor?.querySelector('.sentence-advanced-fields');
    const addDefaults={inputs:inserted?.inputs||{},parameters:inserted?.parameters||{},optionalOpen:optionalDetails?.open===true,missingInput:Boolean(entryEditor?.querySelector('[data-sentence-missing-input]')),compatibilitySelectable:[...(entryEditor?.querySelector('[data-sentence-module-select]')?.options||[])].some(option=>option.value.startsWith('ui.compat\0'))};
     const targetSlot=host.querySelector('[data-sentence-slot-editor="ui-existing:input:target"]');targetSlot?.click();
     const targetEditor=host.querySelector('[data-sentence-inline-editor="ui-existing"]');
     const focusedSlot={moduleSelect:Boolean(targetEditor?.querySelector('[data-sentence-module-select]')),inputs:[...targetEditor?.querySelectorAll('[data-sentence-module-input]')||[]].map(node=>node.dataset.sentenceModuleInput),parameters:[...targetEditor?.querySelectorAll('[data-sentence-module-parameter]')||[]].map(node=>node.dataset.sentenceModuleParameter),next:Boolean(targetEditor?.querySelector('[data-sentence-next-slot]'))};
     const recordSlot=host.querySelector('[data-sentence-slot-editor="ui-record-get:parameter:field"]')||host.querySelector('[data-sentence-slot-editor="ui-record-get:property:field"]');recordSlot?.click();
     const recordEditor=host.querySelector('[data-sentence-inline-editor="ui-record-get"]');
     const recordFocused={field:Boolean(recordEditor?.querySelector('[data-sentence-record-field]')),recordInputs:[...recordEditor?.querySelectorAll('[data-sentence-module-input]')||[]].map(node=>node.dataset.sentenceModuleInput)};
    editor.destroy();host.remove();
     return {before,collapsed,categories,basicModules,compatibilityLabel,addDefaults,focusedSlot,recordFocused};
  })()`)
  assert.equal(authoringUi.before.aria, 'true')
  assert.equal(authoringUi.before.hidden, false)
  assert.ok(authoringUi.before.key)
  assert.equal(authoringUi.collapsed.aria, 'false')
  assert.equal(authoringUi.collapsed.hidden, true)
  assert.equal(authoringUi.collapsed.scrollLeft, 37)
  assert.equal(authoringUi.collapsed.dataUnchanged, true)
  assert.equal(authoringUi.collapsed.focusedKey, authoringUi.before.key)
  assert.deepEqual(authoringUi.categories, ['all', 'data', 'calculation', 'selection', 'control', 'combat', 'board', 'status-rule', 'card-ability'])
  assert.deepEqual(authoringUi.basicModules, ['ui.required', 'ui.legacy'])
  assert.equal(authoringUi.compatibilityLabel, '')
  assert.deepEqual(authoringUi.addDefaults.inputs, {})
  assert.deepEqual(authoringUi.addDefaults.parameters, {})
  assert.equal(authoringUi.addDefaults.optionalOpen, false)
  assert.equal(authoringUi.addDefaults.missingInput, true)
  assert.equal(authoringUi.addDefaults.compatibilitySelectable, false)
  assert.equal(authoringUi.focusedSlot.moduleSelect, false)
  assert.deepEqual(authoringUi.focusedSlot.inputs, ['target'])
  assert.deepEqual(authoringUi.focusedSlot.parameters, [])
  assert.equal(authoringUi.focusedSlot.next, true)
  assert.equal(authoringUi.recordFocused.field, true)
  assert.deepEqual(authoringUi.recordFocused.recordInputs, [])

  if (!skipTrial) {
    await evaluate("(()=>{const button=document.querySelector('#skills-detail [data-sentence-trial]');if(!button)throw new Error('missing complex trial button');button.click()})()")
    await until("document.querySelector('#skills-detail [data-sentence-trial]')?.disabled===false")
    assert.match(await evaluate("document.querySelector('#skills-detail .sentence-message')?.textContent || ''"), /训练营已打开/)
  }
  await evaluate("document.querySelector('#skills-detail [data-sentence-advanced]').click()")
  await until("document.querySelector('#skills-detail [data-editor-pane=graph].active') && document.querySelector('#skills-detail [data-gameplay-modules]')")
  await evaluate("document.querySelector('#skills-detail [data-save-json]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存'")
  await evaluate("document.querySelector('#skills-detail [data-editor-mode=cluster]').click()")
  await until("document.querySelector('#skills-detail [data-sentence-graph-summary]')")

  await openSkill('fireball')
  await call('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#skills-detail .sentence-layout')).gridTemplateColumns.trim().split(/\\s+/).length"), 1)
  const narrowBounds = await evaluate("Array.from(document.querySelectorAll('#skills-detail .sentence-save, #skills-detail [data-sentence-advanced]')).map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; })")
  for (const bounds of narrowBounds) assert.ok(bounds.left >= 0 && bounds.right <= 760, JSON.stringify(bounds))
  await evaluate("document.querySelector('#skills-detail [data-sentence-control=\"multiplier\"]').click()")
  const narrowPopup = await evaluate("(() => { const r = document.querySelector('#skills-detail [data-sentence-popover=\"multiplier\"]').getBoundingClientRect(); return { left:r.left,right:r.right }; })()")
  assert.ok(narrowPopup.left >= 0 && narrowPopup.right <= 760, JSON.stringify(narrowPopup))
  await evaluate("document.querySelector('#skills-detail [data-sentence-popover=\"multiplier\"] .sentence-popover-close').click()")
  const narrowScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'sentence-editor-narrow.png'), Buffer.from(narrowScreenshot.data, 'base64'))
  await call('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })

  await evaluate("document.querySelector('#skills-detail [data-sentence-advanced]').click()")
  await until("document.querySelector('#skills-detail [data-editor-pane=graph].active') && document.querySelector('#skills-detail [data-gameplay-modules]')")
  await evaluate("document.querySelector('#skills-detail [data-editor-mode=cluster]').click()")
  await until("document.querySelector('#skills-detail [data-sentence-add-effect]')")
  await evaluate("document.querySelector('#skills-detail [data-sentence-add-condition]').click()")
  draft = await evaluate(draftExpression())
  assert.equal(draft.gameplayModules.entries.code.graph.body.some(statement => statement.kind === 'if' && statement.id.startsWith('sentence-condition-')), true)
  await evaluate("document.querySelector('#skills-detail [data-sentence-add-effect]').click()")
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))"), true)

  if (!skipTrial) {
  const capturedTrial = await evaluate(`(async()=>{
    const host=document.createElement('div');document.body.append(host);const current=${draftExpression()};const calls=[]
    const catalog={skills:{[current.id]:current},rules:{},pieces:{jaina:{id:'jaina',name:'吉安娜',faction:'good',editorSmokeUnknown:{preserved:true}}},cards:{}}
    const core={...window.ContentGraphCore,buildSkillCluster:()=>({members:{all:[{source:{collection:'skills',id:current.id}},{source:{collection:'pieces',id:'jaina'}},{source:{collection:'skills',id:'unrelated'}}]}})}
    const editor=window.SkillSentenceEditor.mount(host,{core,field:'code',root:{collection:'skills',id:current.id},getDraft:()=>current,getCatalog:()=>catalog,skillTrial:request=>{calls.push(request);return Promise.resolve({draft:{pieceId:'jaina',pieceFaction:'good',skillName:'火球术'}})}})
    await editor.startTrial();editor.destroy();return calls[0]
  })()`)
  assert.deepEqual(capturedTrial.drafts.map(item => `${item.collection}:${item.document.id}`), ['skills:fireball', 'pieces:jaina'])
  assert.deepEqual(capturedTrial.drafts[0].document.editorSmokeUnknown, { preserved: true })

  const errorTrial = await evaluate(`(async()=>{
    const host=document.createElement('div');document.body.append(host);const current=${draftExpression()};const notes=[]
    const editor=window.SkillSentenceEditor.mount(host,{core:window.ContentGraphCore,field:'code',root:{collection:'skills',id:current.id},getDraft:()=>current,getCatalog:()=>({skills:{[current.id]:current},rules:{},pieces:{},cards:{}}),skillTrial:()=>Promise.reject(new Error('测试训练营不可用')),notify:(text,kind)=>notes.push({text,kind})})
    await editor.startTrial();const output={text:host.textContent,notes};editor.destroy();return output
  })()`)
  assert.match(errorTrial.text, /试用失败：测试训练营不可用/)
  assert.equal(errorTrial.notes[0]?.kind, 'error')
  }

  if (!skipExtension) {
  // The condition-creation check leaves Fireball dirty. Save that valid
  // change before navigating; a native discard dialog otherwise blocks CDP.
  await evaluate("document.querySelector('#skills-detail [data-sentence-save]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存'")
  // Real extension descriptors: a custom access may be authored without a
  // declaration, while suggestions remain limited to prior declarations in
  // the active lexical scope.
  await openSkill('extension-authoring-smoke')
  let extensionDraft = await evaluate(draftExpression())
  const extensionBodyBeforeAdd = extensionDraft.gameplayModules.entries.code.graph.body
  const extensionIdsBeforeAdd = new Set(extensionBodyBeforeAdd.map(statement => statement?.id).filter(Boolean))
  await evaluate("document.querySelector('#skills-detail [data-sentence-add-effect]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))")
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-module=\"extension.read-battle\"]'))"), true)
  await evaluate("document.querySelector('#skills-detail [data-sentence-module=\"extension.read-battle\"]').click()")
  extensionDraft = await evaluate(draftExpression())
  const insertedExtension = extensionDraft.gameplayModules.entries.code.graph.body.find(statement => statement?.module === 'extension.read-battle' && !extensionIdsBeforeAdd.has(statement.id))
  assert.ok(insertedExtension?.id, 'adding a custom extension access creates a graph statement')
  const insertedId = insertedExtension.id
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"]'))`)
  await setModuleParameter(insertedId, 'namespace', 'author-test')
  await setModuleParameter(insertedId, 'name', 'customRecord')
  await setModuleParameter(insertedId, 'path', 'state.hp')
  await setModuleValueType(insertedId, 'record')
  extensionDraft = await evaluate(draftExpression())
  assert.equal(extensionDraft.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId).parameters.valueType, 'record')
  await setModuleValueType(insertedId, 'record-schema')
  await setModuleRecordSchema(insertedId, 'smoke-record@1')
  extensionDraft = await evaluate(draftExpression())
  const insertedAfterEdit = extensionDraft.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId)
  assert.equal(insertedAfterEdit.parameters.namespace, 'author-test')
  assert.equal(insertedAfterEdit.parameters.name, 'customRecord')
  assert.equal(insertedAfterEdit.parameters.path, 'state.hp')
  assert.deepEqual(JSON.parse(insertedAfterEdit.parameters.valueType), { kind: 'record', schema: 'smoke-record@1' })
  await evaluate("document.querySelector('#skills-detail [data-sentence-save]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存'")
  let persistedExtension = JSON.parse(fs.readFileSync(path.join(project, 'data', 'skills', 'extension-authoring-smoke.json'), 'utf8'))
  const persistedInserted = persistedExtension.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId)
  assert.equal(persistedInserted.parameters.namespace, 'author-test')
  assert.equal(persistedInserted.parameters.name, 'customRecord')
  assert.equal(persistedInserted.parameters.path, 'state.hp')
  assert.deepEqual(JSON.parse(persistedInserted.parameters.valueType), { kind: 'record', schema: 'smoke-record@1' })

  await openSkill('extension-authoring-smoke')
  extensionDraft = await evaluate(draftExpression())
  const reopenedInserted = extensionDraft.gameplayModules.entries.code.graph.body.find(statement => statement.id === insertedId)
  assert.deepEqual(reopenedInserted.parameters, persistedInserted.parameters)
  await openStatementEditor(insertedId)
  assert.equal(await evaluate(`document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"] [data-sentence-module-parameter="name"] input')?.value`), 'customRecord')
  assert.equal(await evaluate(`document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"] [data-sentence-value-type-parameter="valueType"] [data-sentence-type-kind]')?.value`), 'record-schema')
  assert.equal(await evaluate(`document.querySelector('#skills-detail [data-sentence-inline-editor="${insertedId}"] [data-sentence-record-type]')?.value`), 'smoke-record@1')

  await openStatementEditor('ext-read-player')
  const rootExtensionSuggestions = await evaluate(`(()=>{const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="ext-read-player"]');const input=panel?.querySelector('[data-sentence-module-parameter="name"] input');const list=input&&document.getElementById(input.getAttribute('list'));return [...(list?.options||[])].map(option=>option.value)})()`)
  assert.ok(rootExtensionSuggestions.includes('priorPlayer'), JSON.stringify(rootExtensionSuggestions))
  assert.equal(rootExtensionSuggestions.includes('laterPlayer'), false, JSON.stringify(rootExtensionSuggestions))
  assert.equal(rootExtensionSuggestions.includes('foreignSkill'), false, JSON.stringify(rootExtensionSuggestions))

  await openStatementEditor('ext-read-piece-then')
  const thenExtensionSuggestions = await evaluate(`(()=>{const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="ext-read-piece-then"]');const input=panel?.querySelector('[data-sentence-module-parameter="name"] input');const list=input&&document.getElementById(input.getAttribute('list'));return [...(list?.options||[])].map(option=>option.value)})()`)
  assert.ok(thenExtensionSuggestions.includes('rootPiece'), JSON.stringify(thenExtensionSuggestions))
  assert.ok(thenExtensionSuggestions.includes('branchPiece'), JSON.stringify(thenExtensionSuggestions))
  assert.ok(thenExtensionSuggestions.includes('priorPlayer'), JSON.stringify(thenExtensionSuggestions))
  await openStatementEditor('ext-read-piece-else')
  const elseExtensionSuggestions = await evaluate(`(()=>{const panel=document.querySelector('#skills-detail [data-sentence-inline-editor="ext-read-piece-else"]');const input=panel?.querySelector('[data-sentence-module-parameter="name"] input');const list=input&&document.getElementById(input.getAttribute('list'));return [...(list?.options||[])].map(option=>option.value)})()`)
  assert.ok(elseExtensionSuggestions.includes('rootPiece'), JSON.stringify(elseExtensionSuggestions))
  assert.ok(elseExtensionSuggestions.includes('priorPlayer'), JSON.stringify(elseExtensionSuggestions))
  assert.equal(elseExtensionSuggestions.includes('branchPiece'), false, JSON.stringify(elseExtensionSuggestions))

  await openStatementEditor('ext-read-missing')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-inline-editor=\"ext-read-missing\"] [data-sentence-module-parameter=\"name\"] input').value"), 'missingState')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-inline-editor=\"ext-read-missing\"] [data-sentence-module-parameter=\"fallback\"]'))"), false)
  const extensionScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'sentence-editor-extension-custom.png'), Buffer.from(extensionScreenshot.data, 'base64'))
  }

  console.log(JSON.stringify({ ok: true, screenshots: [path.join(evidence, 'sentence-editor-default.png'), path.join(evidence, 'sentence-editor-smoke.png')], project }))
} finally {
  try { socket?.close() } catch { /* ignore shutdown */ }
  child.kill()
}
