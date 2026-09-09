import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { createContentProject } = require('../../electron-editor/dist/content-project.js')
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-resource-workspace-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
for (const [relative, value] of Object.entries({
  'data/pieces/manifest.json': ['hero'], 'data/skills/manifest.json': ['drain'],
  'data/pieces/hero.json': { id: 'hero', name: '测试战士', skills: ['drain'], image: 'images/hero.png' },
  'data/skills/drain.json': { id: 'drain', name: '吸血', amount: 3 },
})) fs.writeFileSync(path.join(project, relative), JSON.stringify(value, null, 2))
function png(red, green, blue) {
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, data, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc(64 * 193)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { rows[y * 193 + 1 + x * 3] = red; rows[y * 193 + 2 + x * 3] = green; rows[y * 193 + 3 + x * 3] = blue }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const originalImage = png(174, 65, 70), newImage = png(65, 115, 174)
fs.writeFileSync(path.join(project, 'images/hero.png'), originalImage)
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }))
const server = net.createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const executable = path.join(root, 'dist/editor/win-unpacked/RED vs BLUE Editor.exe')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' })
const evidence = path.join(root, 'docs/qa/RED-200')
fs.mkdirSync(evidence, { recursive: true })
let socket, nextId = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('Timeout: ' + method)) }, 30000)
    const listener = event => {
      const value = JSON.parse(event.data)
      if (value.id !== id) return
      clearTimeout(timeout); socket.removeEventListener('message', listener)
      if (value.error) reject(new Error(JSON.stringify(value.error))); else resolve(value.result)
    }
    socket.addEventListener('message', listener); socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Renderer exception')
  return result.result?.value
}
async function until(expression) {
  const end = Date.now() + 45000
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(150) }
  throw new Error('Condition not met: ' + expression)
}
async function screenshot(name) {
  const result = await call('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(result.data, 'base64'))
}
try {
  const end = Date.now() + 90000
  while (!socket && Date.now() < end) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()
      const target = targets.find(value => value.type === 'page' && value.url.includes('index.html'))
      if (target) { socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) }) }
    } catch { /* bounded startup wait */ }
    if (!socket) await delay(250)
  }
  assert.ok(socket, 'Editor failed to start')
  socket.addEventListener('message', event => { if (JSON.parse(event.data).method === 'Page.javascriptDialogOpening') void call('Page.handleJavaScriptDialog', { accept: true }) })
  await call('Page.enable')
  await call('Page.bringToFront')
  await until(`!!document.querySelector('[data-wb="new"]:not(:disabled)')`)
  assert.equal(await evaluate(`typeof window.editorAPI.importProject === 'function' && document.getElementById('project-import').textContent === '导入资源包' && document.getElementById('project-import').getBoundingClientRect().width > 0`), true)
  await evaluate(`document.querySelector('[data-wb="new"]').click()`)
  await evaluate(`(() => { const f = document.querySelector('.wb-modal form'); f.elements.namedItem('title').value='资源修改验收'; f.elements.namedItem('brief').value='更换立绘并调整技能'; f.elements.namedItem('criteria').value='保留新立绘，撤销技能变化'; f.requestSubmit(); })()`)
  await until(`document.querySelector('.wb-topline h2')?.textContent === '资源修改验收'`)
  const tasks = await evaluate('window.editorAPI.workbenchList()'), id = tasks[0].id
  fs.writeFileSync(path.join(project, 'images/hero.png'), newImage)
  fs.writeFileSync(path.join(project, 'data/skills/drain.json'), '{"id":"drain","name":"吸血","amount":9}')
  await call('Page.bringToFront')
  await until(`document.querySelectorAll('[data-select-path]').length === 2`)
  await until(`document.querySelectorAll('.wb-image-pair img').length === 2`)
  await screenshot('pending-changes')
  await evaluate(`document.querySelector('.wb-image-pair').scrollIntoView({ block: 'center' })`)
  await screenshot('image-comparison')
  await evaluate(`document.querySelector('[data-select-path="images/hero.png"]').click(); document.querySelector('[data-wb="accept"]').click()`)
  await until(`document.querySelector('[role="status"]')?.textContent.includes('已接受选中修改')`)
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'data/skills/drain.json'), 'utf8')).amount, 9)
  await evaluate(`document.querySelector('[data-select-path="data/skills/drain.json"]').click(); document.querySelector('[data-wb="revert"]').click()`)
  await until(`document.querySelector('[role="status"]')?.textContent.includes('已撤销')`)
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'data/skills/drain.json'), 'utf8')).amount, 3)
  assert.deepEqual(fs.readFileSync(path.join(project, 'images/hero.png')), newImage)
  const state = await evaluate(`window.editorAPI.workbenchInspect(${JSON.stringify(id)})`)
  assert.equal(state.changes.length, 0)
  await evaluate(`document.querySelector('[data-section="versions"]').click()`)
  await screenshot('versions-and-publication')
  assert.equal(await evaluate(`document.querySelector('[data-wb="publish"]').disabled`), false)
  await evaluate(`document.querySelector('[data-wb="settings"]').click()`)
  await until(`!!document.querySelector('dialog[open] [name="repository"]')`)
  await screenshot('first-publication-settings')
  await evaluate(`document.querySelector('dialog[open] [data-close]').click(); document.querySelector('[data-tab="build"]').click()`)
  assert.equal(await evaluate(`document.getElementById('technical-pipeline-tools').open`), false)
  await screenshot('simple-resource-entry')
  const credentials = await evaluate('window.editorAPI.publicationSettings()')
  assert.equal(credentials.hasToken, false)
  assert.equal(credentials.trainingHandoffAvailable, false)
  const result = { passed: true, importEntryVisible: true, automaticDiff: true, imageComparison: true, acceptImageOnly: true, revertSkillOnly: true, advancedToolsCollapsed: true, publicationSeparate: true, credentialsUntouched: true, actualRuntime: executable, trainingHandoff: 'blocked: client interface absent', githubPublication: 'not executed', project }
  fs.writeFileSync(path.join(evidence, 'resource-workspace-smoke.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} catch (error) {
  if (socket) {
    try {
      await screenshot('smoke-failure')
      console.error(JSON.stringify(await evaluate(`({ hidden: document.hidden, active: document.activeElement?.outerHTML, modal: !!document.querySelector('dialog[open]'), status: document.querySelector('[role="status"]')?.textContent, text: document.getElementById('tab-workbench')?.innerText?.slice(0, 3000) })`)))
    } catch { /* retain the original smoke error */ }
  }
  throw error
} finally {
  if (socket) { try { await evaluate('window.close()') } catch { /* window may close before reply */ } socket.close() }
  child.kill()
  // Retain this isolated fixture alongside evidence for inspection; never touch user content.
}
