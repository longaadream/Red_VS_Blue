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
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-gameplay-module-statement]').length"), 6)
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail .gameplay-module-composite-row').length"), 1)
  await click("[...document.querySelectorAll('#skills-detail .gameplay-module-statement-main')].find(e=>e.textContent.includes('math.add'))")
  assert.equal(await evaluate("(()=>{const e=document.querySelector('#skills-detail .gameplay-module-editor');return e.scrollWidth <= e.clientWidth+1})()"), true, 'module controls should fit the detail pane')
  await evaluate("document.querySelector('#skills-detail .gameplay-module-layout').scrollIntoView({block:'center'})")
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(evidence, 'gameplay-module-editor.png'), Buffer.from(screenshot.data, 'base64'))
  const report = {
    ok: true,
    startedAt, completedAt: new Date().toISOString(),
    checks: ['real Electron mount', 'registered palette', 'typed literal parameters', 'typed prior-output reference', 'composite navigation and persistence', 'module document save and reload', 'unknown fields preserved', 'controls fit detail pane'],
    screenshot: 'gameplay-module-editor.png',
  }
  fs.writeFileSync(path.join(evidence, 'smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  socket?.close()
  child.kill()
}
