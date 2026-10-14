import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

/* Real Electron smoke for ordinary piece ability-group projection. */
const require = createRequire(import.meta.url)
const root = process.cwd()
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-piece-ability-groups-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'official', root)
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
  for (let attempt = 0; attempt < 180; attempt++) {
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

async function captureEvidenceScreenshot(name) {
  const output = process.env.RVB_ABILITY_GROUPS_SCREENSHOT
  if (!output) return
  fs.mkdirSync(output, { recursive: true })
  const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
}

async function until(expression) {
  for (let attempt = 0; attempt < 240; attempt++) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error(`UI condition timed out: ${expression}`)
}

async function openPiece(id) {
  await until('Boolean(window.openCollectionDocument && document.querySelector("#pieces-list .entity-item"))')
  await evaluate(`openCollectionDocument('pieces', ${JSON.stringify(id)})`)
  await until('Boolean(document.querySelector("#pieces-detail [data-skill-cluster-editor]"))')
  await until('document.querySelectorAll("#pieces-detail [data-skill-cluster-ability-group]").length > 0')
}

async function readGroups() {
  return evaluate(`(()=>[...document.querySelectorAll('#pieces-detail [data-skill-cluster-ability-group]')].map(card=>({id:card.dataset.skillClusterAbilityGroup,text:card.textContent})) )()`)
}

try {
  await connect()
  await openPiece('jaina')
  let groups = await readGroups()
  assert.deepEqual(groups.map(group => group.id), ['skills:frostbolt', 'skills:fireball', 'skills:blizzard'])
  assert.equal(groups.some(group => group.id.startsWith('rules:')), false, 'Jaina freeze rules stay in skill groups')
  const jainaMemberCounts = await evaluate(`(()=>[...document.querySelectorAll('#pieces-detail [data-skill-cluster-ability-group]')].map(card=>card.querySelectorAll('[data-skill-cluster-ability-member-edit]').length))()`)
  assert.equal(jainaMemberCounts.every(count => count > 0), true, 'each Jaina ability group exposes direct member editors')

  await openPiece('blue-watcher')
  groups = await readGroups()
  assert.deepEqual(groups.map(group => group.id), ['skills:watcher-form', 'skills:watcher-ultimate'])
  assert.match(groups.find(group => group.id === 'skills:watcher-ultimate').text, /卡牌 2/)
  const watcherCard = await evaluate(`document.querySelector('#pieces-detail [data-skill-cluster-ability-group="skills:watcher-ultimate"]')?.textContent || ''`)
  assert.match(watcherCard, /平静|暴怒/)
  await captureEvidenceScreenshot('piece-ability-groups-watcher')

  await openPiece('blue-naruto')
  groups = await readGroups()
  assert.equal(groups.some(group => group.id === 'skills:naruto-sage-mode'), true, 'Sage Mode owns the clone charge compatibility rule')
  assert.equal(groups.some(group => group.id.startsWith('rules:')), false, 'Naruto has no standalone direct-rule group')
  const narutoSageMode = await evaluate(`document.querySelector('#pieces-detail [data-skill-cluster-ability-group="skills:naruto-sage-mode"]')?.textContent || ''`)
  assert.match(narutoSageMode, /直接规则：.*影分身蓄力/)
  await captureEvidenceScreenshot('piece-ability-groups-naruto')

  // A normal piece save/reopen must leave its ability-group projection and
  // shared source links intact. The edit is isolated to the copied project.
  await openPiece('jaina')
  await evaluate('document.querySelector("#pieces-detail [data-editor-mode=json]")?.click()')
  await evaluate(`(()=>{const source=document.querySelector('#pieces-detail [data-json-source]');const value=JSON.parse(source.value);value.name='吉安娜·能力组回归';source.value=JSON.stringify(value,null,2);source.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await evaluate('document.querySelector("#pieces-detail [data-save-json]")?.click()')
  await until('document.querySelector("#pieces-detail [data-footer-state]")?.textContent === "已保存"')
  await evaluate('openCollectionDocument("pieces", "jaina")')
  await until('document.querySelector("#pieces-detail [data-skill-cluster-ability-group]")?.dataset.skillClusterAbilityGroup === "skills:frostbolt"')
  groups = await readGroups()
  assert.equal(groups.length, 3)
  const links = await evaluate(`(()=>{const catalog=window.__editorGetContentCatalog?.()||{};return catalog.skills?.frostbolt?.cluster?.links||[]})()`)
  assert.deepEqual(links.filter(link => link.collection === 'rules').map(link => link.id), ['rule-freeze-prevent-move', 'rule-freeze-prevent-skill'])
  console.log(JSON.stringify({ ok: true, groups: ['jaina', 'blue-watcher', 'blue-naruto'], saveReopen: true, sharedFreezeLinks: links.length, narutoStandaloneRuleGroup: false }))
} finally {
  socket?.close()
  child.kill()
}
