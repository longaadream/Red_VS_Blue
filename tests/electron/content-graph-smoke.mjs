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
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-content-graph-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const original = {
  id: 'graph-demo',
  name: '内容图冒烟技能',
  description: '保存边界测试',
  kind: 'active',
  type: 'normal',
  code: 'function executeSkill(context){return {success:true};}',
  cooldownTurns: 1,
  actionPointCost: 1,
  maxCharges: 0,
  powerMultiplier: 1,
  extension: { preserved: true, future: { value: 7 } },
}
const originalCard = {
  id: 'graph-demo-card',
  name: '内容图冒烟卡牌',
  description: '卡牌原描述必须保留',
  targeting: { mode: 'ally', preserved: true },
  type: 'active',
  cardType: 'neutral',
  actionPointCost: 1,
  code: 'function executeCard(context){return {success:true};}',
  extension: { preserved: true },
}
const originalRule = {
  id: 'graph-demo-rule',
  name: '内容图冒烟规则',
  description: '规则原描述必须保留',
  targeting: { mode: 'source', preserved: true },
  priority: 1,
  trigger: { type: 'beginTurn' },
  skillCode: 'return { success: true };',
  extension: { preserved: true },
}
const ashbringer = {
  ...JSON.parse(fs.readFileSync(path.join(root, 'data/skills/ashbringer.json'), 'utf8')),
  targeting: { mode: 'enemy', preserved: true },
}
const previewCreate = { ...ashbringer, id: 'preview-create', name: '预览创建技能' }
delete previewCreate.contentGraphEntries
const skillFile = path.join(project, 'data/skills/graph-demo.json')
const ashbringerFile = path.join(project, 'data/skills/ashbringer.json')
const previewCreateFile = path.join(project, 'data/skills/preview-create.json')
const cardFile = path.join(project, 'data/cards/graph-demo-card.json')
const ruleFile = path.join(project, 'data/rules/graph-demo-rule.json')
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([original.id, ashbringer.id, previewCreate.id]) + '\n')
fs.writeFileSync(path.join(project, 'data/cards/manifest.json'), JSON.stringify([originalCard.id]) + '\n')
fs.writeFileSync(path.join(project, 'data/rules/manifest.json'), JSON.stringify([originalRule.id]) + '\n')
fs.writeFileSync(skillFile, JSON.stringify(original, null, 2) + '\n')
fs.writeFileSync(ashbringerFile, JSON.stringify(ashbringer, null, 2) + '\n')
fs.writeFileSync(previewCreateFile, JSON.stringify(previewCreate, null, 2) + '\n')
fs.writeFileSync(cardFile, JSON.stringify(originalCard, null, 2) + '\n')
fs.writeFileSync(ruleFile, JSON.stringify(originalRule, null, 2) + '\n')
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

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const label = method === 'Runtime.evaluate' ? String(params.expression || '').slice(0, 180) : ''
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`CDP timeout: ${method}${label ? ` (${label})` : ''}`))
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
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function until(expression) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  throw new Error(`UI condition timed out: ${expression}`)
}

async function click(expression) {
  await evaluate(`(${expression}).click()`)
}

async function selectSkill() {
  await evaluate("document.querySelector('[data-tab=skills]').click(); [...document.querySelectorAll('#skills-list .entity-item')].find(e=>e.querySelector('.id').textContent==='graph-demo').click(); document.querySelector('#skills-detail [data-editor-mode=graph]').click()")
  await until("Boolean(document.querySelector('#skills-detail .content-graph-editor'))")
}

async function selectCollection(collection, id) {
  const detail = '#' + collection + '-detail'
  const tab = '[data-tab="' + collection + '"]'
  const list = '#' + collection + '-list .entity-item'
  await until("Boolean([...document.querySelectorAll(" + JSON.stringify(list) + ")].find(e=>e.querySelector('.id').textContent===" + JSON.stringify(id) + "))")
  await evaluate("document.querySelector(" + JSON.stringify(tab) + ").click(); [...document.querySelectorAll(" + JSON.stringify(list) + ")].find(e=>e.querySelector('.id').textContent===" + JSON.stringify(id) + ").click(); document.querySelector(" + JSON.stringify(detail + ' [data-editor-mode=graph]') + ").click()")
  await until("Boolean(document.querySelector(" + JSON.stringify(detail + ' .content-graph-editor') + "))")
}

async function selectNode(id, collection = 'skills') {
  const selector = '#' + collection + '-detail [data-content-graph-node="' + id + '"]'
  await click('document.querySelector(' + JSON.stringify(selector) + ')')
}

async function dragNode(id, dx, dy) {
  const expression = "(()=>{const card=document.querySelector('[data-content-graph-node=\"" + id + "\"]');const rect=card.getBoundingClientRect();const startX=rect.left+20;const startY=rect.top+20;card.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,clientX:startX,clientY:startY}));document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:startX+" + dx + ",clientY:startY+" + dy + "}));document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,clientX:startX+" + dx + ",clientY:startY+" + dy + "}))})()"
  await evaluate(expression)
}

async function editNode(id, value, collection = 'skills') {
  await selectNode(id, collection)
  const selector = '#' + collection + '-detail [aria-label="结构化节点参数 JSON"]'
  await evaluate("(()=>{const e=document.querySelector(" + JSON.stringify(selector) + ");e.value=" + JSON.stringify(JSON.stringify(value, null, 2)) + ";e.dispatchEvent(new Event('change',{bubbles:true}))})()")
}

async function connectNode(id, label, value, collection = 'skills') {
  await selectNode(id, collection)
  const detail = '#' + collection + '-detail'
  await evaluate("(()=>{const label=[...document.querySelectorAll(" + JSON.stringify(detail + ' .content-graph-inspector label') + ")].find(e=>e.textContent.trim().startsWith(" + JSON.stringify(label) + "));if(!label)throw new Error('missing graph port ' + " + JSON.stringify(label) + ");const e=label.querySelector('select');e.value=" + JSON.stringify(value) + ";e.dispatchEvent(new Event('change',{bubbles:true}))})()")
}

async function addNode(collection, kind) {
  const detail = '#' + collection + '-detail'
  await evaluate("(()=>{const select=document.querySelector(" + JSON.stringify(detail + ' .content-graph-toolbar select[aria-label="新增节点类型"]') + ");select.value=" + JSON.stringify(kind) + ";[...document.querySelectorAll(" + JSON.stringify(detail + ' .content-graph-toolbar button') + ")].find(e=>e.textContent==='新增节点').click()})()")
}

async function selectGraphField(collection, value) {
  const detail = '#' + collection + '-detail'
  const selector = detail + ' [aria-label="流程图入口"]'
  await evaluate("(()=>{const select=document.querySelector(" + JSON.stringify(selector) + ");select.value=" + JSON.stringify(value) + ";select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await until("document.querySelector(" + JSON.stringify(selector) + ").value===" + JSON.stringify(value))
}

async function exerciseSurface(collection, id, file, field, surface, originalDocument) {
  const detail = '#' + collection + '-detail'
  await selectCollection(collection, id)
  await click("[...document.querySelectorAll(" + JSON.stringify(detail + ' .content-graph-toolbar button') + ")].find(e=>e.textContent==='建立流程图')")
  await until("document.querySelectorAll(" + JSON.stringify(detail + ' [data-content-graph-node]') + ").length===2")
  await addNode(collection, 'set')
  await until("Boolean(document.querySelector(" + JSON.stringify(detail + ' [data-content-graph-node=set-1]') + "))")
  await connectNode('bind-1', '下一步', 'set-1', collection)
  await connectNode('set-1', '下一步', 'return-1', collection)
  await editNode('bind-1', { name: 'value', expr: { kind: 'literal', value: 2 }, next: 'set-1' }, collection)
  await editNode('set-1', {
    target: { kind: 'ref', name: 'value' },
    operator: '+=',
    value: { kind: 'literal', value: 3 },
    next: 'return-1',
  }, collection)
  await until("document.querySelector(" + JSON.stringify(detail + ' [data-save-json]') + ").disabled===false")
  await click("document.querySelector(" + JSON.stringify(detail + ' [data-save-json]') + ")")
  await until("document.querySelector(" + JSON.stringify(detail + ' [data-footer-state]') + ").textContent==='已保存'")
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.contentGraph.version, 'rvb-content-graph/v1')
  assert.equal(saved.contentGraph.surface, surface)
  assert.equal(saved.contentGraphField, field)
  assert.equal(saved.contentGraph.nodes.length, 3)
  assert.match(saved[field], /value \+= 3/)
  if (surface === 'card') assert.match(saved[field], /function executeCard/)
  assert.deepEqual(saved.description, originalDocument.description)
  assert.deepEqual(saved.targeting, originalDocument.targeting)

  await call('Page.reload')
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await selectCollection(collection, id)
  assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(detail + ' [data-content-graph-node]') + ").length"), 3)
  await click("document.querySelector(" + JSON.stringify(detail + ' [data-content-graph-node=set-1]') + ")")
  assert.equal(await evaluate("document.querySelector(" + JSON.stringify(detail + ' textarea[aria-label]') + ").value.includes('+=')"), true)
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'content-graph-' + collection + '.png'), Buffer.from(screenshot.data, 'base64'))
  return saved
}

const evidence = path.join(root, 'output/playwright')
fs.mkdirSync(evidence, { recursive: true })
let saved
try {
  await connect()
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await selectSkill()

  await click("[...document.querySelectorAll('#skills-detail .content-graph-toolbar button')].find(e=>e.textContent==='建立流程图')")
  await until("document.querySelectorAll('#skills-detail [data-content-graph-node]').length===2")
  assert.equal(await evaluate("document.querySelector('#skills-detail .content-graph-help').textContent.includes('结构化节点参数')"), true)
  await dragNode('bind-1', 45, 15)
  await until("document.querySelector('#skills-detail [data-content-graph-node=bind-1]').style.left==='85px'")
  const lockedPosition = await evaluate("document.querySelector('#skills-detail [data-content-graph-node=bind-1]').style.left")
  await evaluate("(()=>{const host=document.querySelector('#skills-detail [data-content-graph]');host.setAttribute('data-saving','true');const card=document.querySelector('#skills-detail [data-content-graph-node=bind-1]');const rect=card.getBoundingClientRect();card.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:2,clientX:rect.left+20,clientY:rect.top+20}));document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:2,clientX:rect.left+100,clientY:rect.top+100}));document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:2,clientX:rect.left+100,clientY:rect.top+100}));host.removeAttribute('data-saving')})()")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-content-graph-node=bind-1]').style.left"), lockedPosition)

  await evaluate("(()=>{const select=document.querySelector('#skills-detail .content-graph-toolbar [aria-label=新增节点类型]');select.value='call';[...document.querySelectorAll('#skills-detail .content-graph-toolbar button')].find(e=>e.textContent==='新增节点').click()})()")
  await until("Boolean(document.querySelector('#skills-detail [data-content-graph-node=call-1]'))")
  await connectNode('bind-1', '下一步', 'call-1')
  await connectNode('call-1', '下一步', 'return-1')

  await evaluate("(()=>{const select=document.querySelector('#skills-detail .content-graph-toolbar [aria-label=新增节点类型]');select.value='branch';[...document.querySelectorAll('#skills-detail .content-graph-toolbar button')].find(e=>e.textContent==='新增节点').click()})()")
  await until("Boolean(document.querySelector('#skills-detail [data-content-graph-node=branch-1]'))")
  await editNode('bind-1', { name: 'source', expr: { kind: 'literal', value: 7 }, next: 'call-1' })
  await connectNode('call-1', '下一步', 'branch-1')
  await connectNode('branch-1', 'yes', 'return-1')
  await connectNode('branch-1', 'no', 'branch-1-no')
  await editNode('bind-1', { name: 'source', expr: { kind: 'ref', name: 'missingBinding' }, next: 'call-1' })
  await until("document.querySelector('#skills-detail [data-save-json]').disabled===true")
  await editNode('bind-1', { name: 'source', expr: { kind: 'literal', value: 7 }, next: 'call-1' })
  await delay(300)
  await until("document.querySelector('#skills-detail [data-save-json]').disabled===false")

  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  saved = JSON.parse(fs.readFileSync(skillFile, 'utf8'))
  assert.equal(saved.contentGraph.version, 'rvb-content-graph/v1')
  assert.equal(saved.contentGraph.surface, 'skill')
  assert.equal(saved.contentGraph.nodes.length, 5)
  assert.match(saved.code, /flow\.event\.block/)
  assert.deepEqual(saved.extension, original.extension)

  await call('Page.reload')
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await selectSkill()
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-content-graph-node]').length"), 5)
  await evaluate("document.querySelector('#skills-detail [data-content-graph-node=call-1]').click()")
  assert.equal(await evaluate("document.querySelector('#skills-detail textarea[aria-label]').value.includes('flow.event.block')"), true)

  const beforeTamper = fs.readFileSync(skillFile, 'utf8')
  await evaluate(`(()=>{const value=JSON.parse(document.querySelector('#skills-detail [data-json-source]').value);value.code='tampered-by-smoke';const input=document.querySelector('#skills-detail [data-json-source]');input.value=JSON.stringify(value,null,2);input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until("document.querySelector('#skills-detail [data-save-json]').disabled===true")
  assert.equal(fs.readFileSync(skillFile, 'utf8'), beforeTamper)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-footer-state]').textContent==='流程图需要修正或重新生成'"), true)

  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'content-graph-tamper-rejected.png'), Buffer.from(screenshot.data, 'base64'))
  await click("document.querySelector('#skills-detail [data-reset-document]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  await click("document.querySelector('#skills-detail [data-editor-mode=graph]')")
  await until("document.querySelectorAll('#skills-detail [data-content-graph-node]').length===5")
  const validScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'content-graph-editor.png'), Buffer.from(validScreenshot.data, 'base64'))
  const ashBefore = JSON.parse(fs.readFileSync(ashbringerFile, 'utf8'))
  const previewGraph = ashBefore.contentGraphEntries.previewCode.graph
  const previewCompilerVersion = ashBefore.contentGraphEntries.previewCode.compilerVersion
  const previewBind = previewGraph.nodes.find(node => node.kind === 'bind')
  assert.ok(previewBind)
  await selectCollection('skills', ashbringer.id)
  assert.equal(await evaluate("document.querySelector('#skills-detail [aria-label=流程图入口]').value"), 'code')
  const mainCodeBeforePreview = JSON.parse(fs.readFileSync(ashbringerFile, 'utf8')).code
  await selectGraphField('skills', 'previewCode')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-content-graph-node]').length"), previewGraph.nodes.length)
  await editNode(previewBind.id, { name: previewBind.name, expr: { kind: 'ref', name: 'missingPreviewBinding' }, next: previewBind.next })
  await until("document.querySelector('#skills-detail [data-save-json]').disabled===true")
  await editNode(previewBind.id, {
    name: previewBind.name,
    expr: { kind: 'literal', value: 99 },
    next: previewBind.next,
  }, 'skills')
  await until("document.querySelector('#skills-detail [data-save-json]').disabled===false")
  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const previewSaved = JSON.parse(fs.readFileSync(ashbringerFile, 'utf8'))
  assert.equal(previewSaved.code, mainCodeBeforePreview)
  assert.match(previewSaved.previewCode, /99/)
  assert.deepEqual(previewSaved.description, ashBefore.description)
  assert.deepEqual(previewSaved.targeting, ashBefore.targeting)
  assert.equal(previewSaved.contentGraphEntries.previewCode.graph.nodes.find(node => node.id === previewBind.id).expr.value, 99)
  const previewScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'content-graph-preview.png'), Buffer.from(previewScreenshot.data, 'base64'))

  await call('Page.reload')
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await selectCollection('skills', ashbringer.id)
  assert.equal(await evaluate("document.querySelector('#skills-detail [aria-label=流程图入口]').value"), 'code')
  await selectGraphField('skills', 'code')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-content-graph-node]').length"), ashBefore.contentGraph.nodes.length)
  await click("[...document.querySelectorAll('#skills-detail .content-graph-toolbar button')].find(e=>e.textContent==='解除当前入口图，保留生成字段')")
  const promotedDraft = JSON.parse(await evaluate("document.querySelector('#skills-detail [data-json-source]').value"))
  assert.equal(promotedDraft.contentGraphField, 'previewCode')
  assert.equal(promotedDraft.contentGraphCompilerVersion, previewCompilerVersion)
  assert.equal(promotedDraft.contentGraphEntries, undefined)
  assert.equal(promotedDraft.contentGraph.nodes.length, previewGraph.nodes.length)
  assert.equal(promotedDraft.contentGraph.nodes.find(node => node.id === previewBind.id).expr.value, 99)
  assert.equal(promotedDraft.code, mainCodeBeforePreview)
  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const codeDetached = JSON.parse(fs.readFileSync(ashbringerFile, 'utf8'))
  assert.equal(codeDetached.code, mainCodeBeforePreview)
  assert.equal(codeDetached.previewCode, previewSaved.previewCode)
  assert.equal(codeDetached.contentGraphField, 'previewCode')
  assert.equal(codeDetached.contentGraphCompilerVersion, previewCompilerVersion)
  assert.equal(codeDetached.contentGraphEntries, undefined)
  assert.equal(codeDetached.contentGraph.nodes.find(node => node.id === previewBind.id).expr.value, 99)

  await call('Page.reload')
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await selectCollection('skills', ashbringer.id)
  assert.equal(await evaluate("document.querySelector('#skills-detail [aria-label=流程图入口]').value"), 'code')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-content-graph-node]').length"), 0)
  await selectGraphField('skills', 'previewCode')
  await click("document.querySelector('#skills-detail [data-content-graph-node=" + previewBind.id + "]')")
  assert.equal(await evaluate("document.querySelector('#skills-detail textarea[aria-label]').value.includes('99')"), true)
  await editNode(previewBind.id, {
    name: previewBind.name,
    expr: { kind: 'literal', value: 101 },
    next: previewBind.next,
  }, 'skills')
  await until("document.querySelector('#skills-detail [data-save-json]').disabled===false")
  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const promotedEdited = JSON.parse(fs.readFileSync(ashbringerFile, 'utf8'))
  assert.equal(promotedEdited.code, mainCodeBeforePreview)
  assert.equal(promotedEdited.contentGraphField, 'previewCode')
  assert.equal(promotedEdited.contentGraph.nodes.find(node => node.id === previewBind.id).expr.value, 101)
  assert.match(promotedEdited.previewCode, /101/)

  await call('Page.reload')
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await selectCollection('skills', ashbringer.id)
  assert.equal(await evaluate("document.querySelector('#skills-detail [aria-label=流程图入口]').value"), 'code')
  await selectGraphField('skills', 'previewCode')
  await click("document.querySelector('#skills-detail [data-content-graph-node=" + previewBind.id + "]')")
  assert.equal(await evaluate("document.querySelector('#skills-detail textarea[aria-label]').value.includes('101')"), true)
  await click("[...document.querySelectorAll('#skills-detail .content-graph-toolbar button')].find(e=>e.textContent==='解除当前入口图，保留生成字段')")
  const previewDetachedDraft = JSON.parse(await evaluate("document.querySelector('#skills-detail [data-json-source]').value"))
  assert.equal(previewDetachedDraft.contentGraph, undefined)
  assert.equal(previewDetachedDraft.contentGraphField, undefined)
  assert.equal(previewDetachedDraft.contentGraphEntries, undefined)
  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const detached = JSON.parse(fs.readFileSync(ashbringerFile, 'utf8'))
  assert.equal(detached.code, mainCodeBeforePreview)
  assert.equal(detached.previewCode, promotedEdited.previewCode)
  assert.equal(detached.contentGraph, undefined)
  assert.equal(detached.contentGraphField, undefined)
  assert.equal(detached.contentGraphEntries, undefined)
  const previewCreateBefore = JSON.parse(fs.readFileSync(previewCreateFile, 'utf8'))
  await selectCollection('skills', previewCreate.id)
  assert.equal(await evaluate("document.querySelector('#skills-detail [aria-label=流程图入口]').value"), 'code')
  await selectGraphField('skills', 'previewCode')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-content-graph-node]').length"), 0)
  await click("[...document.querySelectorAll('#skills-detail .content-graph-toolbar button')].find(e=>e.textContent==='建立流程图')")
  await until("document.querySelectorAll('#skills-detail [data-content-graph-node]').length===2")
  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const previewCreated = JSON.parse(fs.readFileSync(previewCreateFile, 'utf8'))
  assert.equal(previewCreated.code, previewCreateBefore.code)
  assert.match(previewCreated.previewCode, /function calculatePreview/)
  assert.equal(previewCreated.contentGraphEntries.previewCode.graph.nodes.length, 2)
  const cardSaved = await exerciseSurface('cards', originalCard.id, cardFile, 'code', 'card', originalCard)
  const ruleSaved = await exerciseSurface('rules', originalRule.id, ruleFile, 'skillCode', 'rule', originalRule)
  const report = {
    ok: true,
    surfaces: {
      skill: { nodeCount: saved.contentGraph.nodes.length, generatedField: saved.contentGraphField || 'code' },
      preview: { nodeCount: promotedEdited.contentGraph.nodes.length, generatedField: promotedEdited.contentGraphField, codeDetachPreservedPreview: codeDetached.contentGraphField === 'previewCode', editableAfterPromotion: promotedEdited.contentGraph.nodes.find(node => node.id === previewBind.id).expr.value === 101, finalDetached: detached.contentGraph === undefined },
      previewCreate: { nodeCount: previewCreated.contentGraphEntries.previewCode.graph.nodes.length, generatedField: 'previewCode', preservedMain: previewCreated.code === previewCreateBefore.code },
      card: { nodeCount: cardSaved.contentGraph.nodes.length, generatedField: cardSaved.contentGraphField },
      rule: { nodeCount: ruleSaved.contentGraph.nodes.length, generatedField: ruleSaved.contentGraphField },
    },
    checks: ['skill graph creation', 'node drag', 'save lock blocks drag', 'bind/call/branch/return connections', 'structured expression edit', 'invalid primary and preview drafts repair and save', 'skill atomic save and reload', 'generated-code tamper rejected without file mutation', 'preview field switch and independent edit', 'preview save preserves main code/description/targeting', 'primary code detach promotes preview graph', 'promoted preview reload, edit, and save', 'preview detach leaves no graph', 'preview graph creation when source exists', 'card set graph save and reload', 'rule set graph save and reload', 'card/rule description and targeting preserved'],
    screenshot: 'output/playwright/content-graph-editor.png',
    pageScreenshots: ['output/playwright/content-graph-preview.png', 'output/playwright/content-graph-cards.png', 'output/playwright/content-graph-rules.png'],
    project: project,
  }
  fs.writeFileSync(path.join(evidence, 'content-graph-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  socket?.close()
  child.kill()
}
