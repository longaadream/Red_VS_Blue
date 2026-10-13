import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/* Real Electron/CDP smoke for the author-facing semantic module editor. */
const require = createRequire(import.meta.url)
const root = process.cwd()
const startedAt = new Date().toISOString()
const evidence = process.env.RVB_GAMEPLAY_MODULE_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-gameplay-module')
fs.mkdirSync(evidence, { recursive: true })
fs.rmSync(path.join(evidence, 'smoke.json'), { force: true })
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const core = require(path.join(root, 'electron-editor/gameplay-module-core.cjs'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-gameplay-module-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)

const original = {
  id: 'gameplay-module-demo',
  name: '玩法模块编辑器冒烟技能',
  description: '保留普通字段的模块图测试',
  kind: 'active',
  type: 'normal',
  code: 'function executeSkill(context){return {success:true};}',
  cooldownTurns: 1,
  actionPointCost: 1,
  maxCharges: 0,
  powerMultiplier: 1,
  extension: { preserved: true, future: { value: 7 } },
}
const skillFile = path.join(project, 'data/skills', `${original.id}.json`)
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([original.id]) + '\n')
fs.writeFileSync(skillFile, JSON.stringify(original, null, 2) + '\n')
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
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
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
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  throw new Error(`UI condition timed out: ${expression}`)
}

async function click(expression) { await evaluate(`(${expression}).click()`) }
async function dispatchChange(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}

async function openSkill() {
  await until("Boolean(document.querySelector('#skills-list .entity-item'))")
  await evaluate("document.querySelector('[data-tab=skills]').click(); [...document.querySelectorAll('#skills-list .entity-item')].find(e=>e.querySelector('.id').textContent==='gameplay-module-demo').click(); document.querySelector('#skills-detail [data-editor-mode=graph]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-editor]'))")
}

async function addPaletteModule(id) {
  await click("document.querySelector('#skills-detail [data-gameplay-module-palette] [data-gameplay-module=" + JSON.stringify(id) + "]')")
  await until(`Boolean([...document.querySelectorAll('#skills-detail [data-gameplay-module-statement]')].find(e=>e.textContent.includes(${JSON.stringify(id)})))`)
}

async function selectStatement(id) {
  await click("document.querySelector('#skills-detail [data-gameplay-module-statement=" + JSON.stringify(id) + "] .gameplay-module-statement-main')")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-inspector] [data-gameplay-module-module]')) || Boolean(document.querySelector('#skills-detail [data-gameplay-module-inspector] h3'))")
}

async function chooseLiteralInput(index, value) {
  const selector = '#skills-detail [data-gameplay-module-inspector] [data-gameplay-module-value]'
  await evaluate(`(()=>{const values=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=values[${index}];if(!e)throw new Error('missing typed input '+${index});e.value='literal';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until(`document.querySelectorAll('#skills-detail [data-gameplay-module-inspector] .gameplay-module-literal').length>=${index + 1}`)
  await evaluate(`(()=>{const values=[...document.querySelectorAll('#skills-detail [data-gameplay-module-inspector] .gameplay-module-literal')];const e=values[${index}];e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
}

try {
  await connect()
  await openSkill()
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail textarea').length>=1"), true, 'the surrounding document editor remains available')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-gameplay-module-editor] textarea').length"), 0, 'module authoring has no JSON/code textarea')

  await click("document.querySelector('#skills-detail [data-gameplay-module-editor] .gameplay-module-button.primary')")
  await until("document.querySelectorAll('#skills-detail [data-gameplay-module-statement]').length===1")
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-gameplay-module-palette] [data-gameplay-module]').length>10"), true)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-gameplay-module-statement=return-1]') !== null"), true)
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-gameplay-module-category]').length>=2"), true, 'palette exposes real category filters')
  await click("document.querySelector('#skills-detail [data-gameplay-module-category=\"math\"]')")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-palette] [data-gameplay-module=\"math.add\"]'))")
  await click("document.querySelector('#skills-detail [data-gameplay-module-category=\"all\"]')")
  await click("document.querySelector('#skills-detail [data-gameplay-module-palette-group] summary')")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-gameplay-module-palette-group]').open"), false, 'palette categories can collapse')
  await click("document.querySelector('#skills-detail [data-gameplay-module-palette-group] summary')")
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-gameplay-module-text-template]').length"), 2, 'description and target text bindings have structured editors')

  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-module-palette] button')].find(e=>e.textContent==='新增逐项执行')")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-statement=foreach-1]'))")
  await selectStatement('foreach-1')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-gameplay-module-presentation]'))"), true, 'skill foreach exposes presentation batch control')
  assert.equal(await evaluate("[...document.querySelector('#skills-detail [data-gameplay-module-presentation]').options].map(e=>e.value).join(',')"), ',statusAdded,statusRemoved,tileEffectAdded,tileEffectRemoved')
  await dispatchChange('#skills-detail [data-gameplay-module-presentation]', 'statusAdded')
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(e=>e.id==='foreach-1').presentation"), 'statusAdded')

  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-module-palette] button')].find(e=>e.textContent==='新增条件循环')")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-statement=while-1]'))")
  await selectStatement('while-1')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-gameplay-module-inspector] input[type=number]'))"), true, 'while exposes its finite budget editor')
  assert.equal(await evaluate("[...document.querySelectorAll('#skills-detail [data-gameplay-module-inspector] button')].some(e=>e.textContent==='进入循环条件')"), true, 'while exposes condition navigation')
  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-module-inspector] button')].find(e=>e.textContent==='进入循环条件')")
  await until("document.querySelector('#skills-detail .gameplay-module-breadcrumbs').textContent.includes('循环条件')")
  await click("document.querySelector('#skills-detail .gameplay-module-breadcrumb')")
  await until("document.querySelector('#skills-detail .gameplay-module-breadcrumbs').textContent.includes('主流程') && !document.querySelector('#skills-detail .gameplay-module-breadcrumbs').textContent.includes('循环条件')")

  await addPaletteModule('math.add')
  await selectStatement('call-1')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-gameplay-module-inspector] [data-gameplay-module-value]').length"), 2)
  await chooseLiteralInput(0, 2)
  await chooseLiteralInput(1, 3)

  await addPaletteModule('math.add')
  await selectStatement('call-2')
  const outputRef = await evaluate("(()=>{const e=[...document.querySelectorAll('#skills-detail [data-gameplay-module-inspector] [data-gameplay-module-value]')][0];return [...e.options].find(o=>o.textContent.includes('输出 · call-1.value'))?.value||''})()")
  assert.ok(outputRef, 'second call should expose the previous call output as a typed reference')
  await dispatchChange('#skills-detail [data-gameplay-module-inspector] [data-gameplay-module-value]', outputRef)
  await chooseLiteralInput(1, 4)

  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-module-palette] button')].find(e=>e.textContent.includes('新增组合模块'))")
  await until("document.querySelectorAll('#skills-detail .gameplay-module-composite-row').length===1")
  await click("document.querySelector('#skills-detail .gameplay-module-composite-row .gameplay-module-button.secondary')")
  await until("document.querySelector('#skills-detail .gameplay-module-breadcrumbs').textContent.includes('组合')")
  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-graph-interface] button')].find(e=>e.textContent==='新增输入端口')")
  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-graph-interface] button')].find(e=>e.textContent==='新增输出端口')")
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail .gameplay-module-port-binding').length"), 0, 'composite inputs are supplied by calls, not root static bindings')
  await addPaletteModule('ref.holder')
  await click("[...document.querySelectorAll('#skills-detail .gameplay-module-palette button')].find(e=>e.textContent==='新增返回结果')")
  await until("document.querySelectorAll('#skills-detail [data-gameplay-module-statement]').length===2")
  await click("document.querySelector('#skills-detail .gameplay-module-breadcrumb')")
  await until("document.querySelector('#skills-detail .gameplay-module-breadcrumbs').textContent.includes('主流程') && !document.querySelector('#skills-detail .gameplay-module-breadcrumbs').textContent.includes('组合')")
  await addPaletteModule('composite-1')
  await chooseLiteralInput(0, '复用输入')
  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-module-palette] button')].find(e=>e.textContent==='新增条件分支')")
  await click("[...document.querySelectorAll('#skills-detail .gameplay-module-inspector button')].find(e=>e.textContent==='进入“条件成立”')")
  await addPaletteModule('ref.holder')
  await click("document.querySelector('#skills-detail .gameplay-module-breadcrumb')")
  await click("[...document.querySelectorAll('#skills-detail [data-gameplay-module-statement]')].find(e=>e.textContent.includes('条件分支')).querySelectorAll('.gameplay-module-icon-button')[2]")

  await until("document.querySelector('#skills-detail [data-save-json]').disabled===false")
  await click("document.querySelector('#skills-detail [data-save-json]')")
  await until("document.querySelector('#skills-detail [data-footer-state]').textContent==='已保存'")
  const saved = JSON.parse(fs.readFileSync(skillFile, 'utf8'))
  core.assertGameplayModuleDocument(saved)
  assert.equal(saved.gameplayModules.version, 'rvb-gameplay-module-document/v1')
  assert.equal(saved.gameplayModules.entries.code.graph.composites.length, 1)
  assert.equal(saved.gameplayModules.entries.code.graph.composites[0].inputs.length, 1)
  assert.equal(saved.gameplayModules.entries.code.graph.composites[0].outputs.length, 1)
  assert.equal(saved.gameplayModules.entries.code.graph.inputs.length, 0, 'editing composite ports must not mutate root ports')
  const branches = saved.gameplayModules.entries.code.graph.body.filter(node => node.kind === 'if')
  assert.equal(branches.length, 2)
  assert.notEqual(branches[0].then[0].id, branches[1].then[0].id, 'copying a subflow must allocate distinct nested node IDs')
  assert.equal(saved.gameplayModules.entries.code.graph.body.at(-1).kind, 'return', 'new calls must execute before the starter return')
  assert.equal(saved.extension.future.value, 7)
  assert.notEqual(saved.code, original.code, 'the module compiler should replace the old generated field')

  await call('Page.reload')
  await openSkill()
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-gameplay-module-statement]').length"), 8)
  await selectStatement('foreach-1')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-gameplay-module-presentation]').value"), 'statusAdded', 'presentation batch survives save and reload')
  await click("document.querySelector('#skills-detail [data-editor-mode=json]')")
  await evaluate("(()=>{const e=document.querySelector('#skills-detail [data-json-source]');const value=JSON.parse(e.value);value.gameplayModules.entries.code.graph.body.find(item=>item.id==='foreach-1').presentation='legacyBatch';e.value=JSON.stringify(value,null,2);e.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await click("document.querySelector('#skills-detail [data-editor-mode=graph]')")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-presentation-error]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-save-json]').disabled"), true, 'invalid presentation is surfaced and blocks save')
  await selectStatement('foreach-1')
  assert.equal(await evaluate("[...document.querySelector('#skills-detail [data-gameplay-module-presentation]').options].some(e=>e.value==='legacyBatch')"), true, 'invalid presentation remains visible for repair')
  await dispatchChange('#skills-detail [data-gameplay-module-presentation]', 'statusAdded')
  await until("document.querySelector('#skills-detail [data-save-json]').disabled===false")
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail .gameplay-module-composite-row').length"), 1)
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-gameplay-graph-interface]')?.open === false"), true, 'valid graph interface settings should start collapsed')
  assert.equal(await evaluate("document.querySelector('#skills-detail .gameplay-module-text-bindings')?.open === false"), true, 'valid text binding settings should start collapsed')
  assert.equal(await evaluate("document.querySelector('#skills-detail .gameplay-module-composites')?.open === false"), true, 'valid composite settings should start collapsed')
  await click("[...document.querySelectorAll('#skills-detail .gameplay-module-statement-main')].find(e=>e.textContent.includes('math.add'))")
  assert.equal(await evaluate("(()=>{const e=document.querySelector('#skills-detail .gameplay-module-editor');return e.scrollWidth <= e.clientWidth+1})()"), true, 'module controls should fit the detail pane')
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#skills-detail .gameplay-module-category-tabs')).overflowX === 'visible'"), true, 'categories should wrap without a horizontal scrollbar')

  const scrollBeforeExpand = await evaluate("(()=>{const e=document.querySelector('#skills-detail [data-gameplay-module-editor]');const host=e.closest('.detail-col')||e.parentElement;return {host:host?.scrollTop||0,window:window.scrollY||0}})()")
  await click("document.querySelector('#skills-detail [data-gameplay-module-expand]')")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-editor].is-expanded'))")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#skills-detail [data-gameplay-module-editor]')).position === 'fixed'"), true, 'expanded editor should use the available window')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-gameplay-module-save]'))"), true, 'expanded editor should keep a visible save entry')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-gameplay-module-save]')?.textContent === '保存 JSON'"), true)
  await click("document.querySelector('#skills-detail [data-gameplay-module-save]')")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent==='已保存'")
  await until("Boolean(document.querySelector('#skills-detail [data-gameplay-module-editor].is-expanded'))")
  await until("document.querySelectorAll('#toast .toast-item').length===0")
  await evaluate("document.querySelector('#skills-detail [data-gameplay-module-editor]').scrollTop=0")
  assert.equal(await evaluate("document.querySelector('#skills-detail .gameplay-module-layout')?.getBoundingClientRect().top <= 220"), true, 'expanded flow should start within the first 220px')
  const expandedScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'gameplay-module-editor-expanded.png'), Buffer.from(expandedScreenshot.data, 'base64'))
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await until("!document.querySelector('#skills-detail [data-gameplay-module-editor].is-expanded')")
  assert.equal(await evaluate("document.activeElement?.matches('#skills-detail [data-gameplay-module-expand]')"), true, 'Escape should restore focus to the workspace toggle')
  assert.deepEqual(await evaluate("(()=>{const e=document.querySelector('#skills-detail [data-gameplay-module-editor]');const host=e.closest('.detail-col')||e.parentElement;return {host:host?.scrollTop||0,window:window.scrollY||0}})()"), scrollBeforeExpand, 'Escape should restore the pre-expand scroll position')

  await call('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false })
  await delay(150)
  assert.equal(await evaluate("(()=>{const e=document.querySelector('#skills-detail .gameplay-module-editor');return e.scrollWidth <= e.clientWidth+1})()"), true, 'narrow editor has no horizontal overflow')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail .gameplay-module-inspector'))"), true, 'narrow editor keeps the inspector available')
  await call('Emulation.clearDeviceMetricsOverride')
  // CDP acknowledges the resize before Chromium paints the restored layout.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await evaluate("document.querySelector('#skills-detail [data-gameplay-module-editor]').scrollIntoView({block:'start'})")
  const layoutEvidence = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'gameplay-module-layout-check.png'), Buffer.from(layoutEvidence.data, 'base64'))
  assert.equal(await evaluate("document.querySelector('#skills-detail .gameplay-module-body')?.getBoundingClientRect().top < 260"), true, 'normal layout should put the flow before the long palette list')
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'gameplay-module-editor.png'), Buffer.from(screenshot.data, 'base64'))
  const report = {
    ok: true,
    startedAt, completedAt: new Date().toISOString(),
    checks: ['real Electron mount', 'registered palette', 'category filters and collapsible groups', 'structured text binding controls', 'typed literal parameters', 'typed prior-output reference', 'composite navigation and persistence', 'module document save and reload', 'unknown fields preserved', 'controls fit detail pane', 'normal flow before long palette list', 'wrapped categories without horizontal overflow', 'expanded flow starts within 220px', 'expanded workspace save entry forwarding with Escape focus and scroll restore', 'narrow layout without horizontal overflow'],
    screenshots: ['gameplay-module-editor.png', 'gameplay-module-editor-expanded.png'],
  }
  fs.writeFileSync(path.join(evidence, 'smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  socket?.close()
  child.kill()
}
