import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

/*
 * RED-252 first-version studio-shell smoke.
 *
 * This deliberately drives the shipped renderer through Electron's CDP
 * endpoint. It does not import UI modules into Node, mock editorAPI, or use
 * Playwright. Every document is created in an isolated temporary content
 * project and the only files written in the repository are QA evidence.
 */
const root = path.resolve(import.meta.dirname, '../..')
const evidence = path.resolve(process.env.RVB_STUDIO_SHELL_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-studio-v1'))
fs.mkdirSync(evidence, { recursive: true })

const require = createRequire(import.meta.url)
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const gameplayCore = require(path.join(root, 'electron-editor/gameplay-module-core.cjs'))
const AdmZip = require('adm-zip')

const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-studio-shell-smoke-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)

function writeJson(relative, value) {
  const filename = path.join(project, relative)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n')
}

// The workspace validator checks PNG signatures and dimensions. Keep these
// deterministic, small fixtures so the package assertion proves image bytes
// were copied rather than merely seeing an image path in JSON.
function png(red, green, blue) {
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes])
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4)
    const checksum = Buffer.alloc(4)
    size.writeUInt32BE(bytes.length)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(64, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc(64 * 193)
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      rows[y * 193 + 1 + x * 3] = red
      rows[y * 193 + 2 + x * 3] = green
      rows[y * 193 + 3 + x * 3] = blue
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const sourceSkill = JSON.parse(fs.readFileSync(path.join(root, 'data/skills/fireball.json'), 'utf8'))
sourceSkill.editorSmokeUnknown = { preserved: true, source: 'RED-252-studio-shell-smoke' }
sourceSkill.name = '工作台火球'
sourceSkill.description = '选择敌人（5），造成1.5倍伤害。'
sourceSkill.statusTag = {
  id: 'studio-skill-burning',
  type: 'skill-rule',
  name: '技能灼烧标记',
  description: '真实状态定义：由技能文档内联声明。',
  iconPath: 'images/status-old.png',
  visible: true,
  extension: { preserve: 'skill-status-extension' },
}
// A dedicated text call exercises the generic value editor independently of
// whichever calls the production Fireball currently needs.
const literalSkill = JSON.parse(JSON.stringify(sourceSkill))
literalSkill.id = 'studio-literal'
literalSkill.name = '工作台常量表达式'
literalSkill.description = '句式编辑器常量选项回归夹具。'
delete literalSkill.statusTag
literalSkill.cluster = { version: 'rvb-skill-cluster/v1', id: 'skills:studio-literal', links: [] }
literalSkill.editorSmokeUnknown = { preserved: true, source: 'RED-252-literal-expression-fixture' }
const literalGraph = literalSkill.gameplayModules.entries.code.graph
literalGraph.body.push({ kind: 'call', id: 'message-0', module: 'text.concat', version: '1', inputs: { left: { kind: 'literal', value: '常量前缀' }, right: { kind: 'literal', value: '文本后缀' } }, parameters: {} })
const literalCompilation = gameplayCore.compileGameplayModuleGraph(literalGraph, gameplayCore.GAMEPLAY_MODULE_REGISTRY)
literalSkill.code = literalCompilation.code
literalSkill.gameplayModules.entries.code.compilerVersion = literalCompilation.compilerVersion
literalSkill.contentGraph = JSON.parse(JSON.stringify(literalGraph))
literalSkill.contentGraphField = 'code'
literalSkill.contentGraphCompilerVersion = literalCompilation.compilerVersion
const piece = {
  id: 'studio-piece',
  name: '工作台试炼棋子',
  faction: 'good',
  description: 'RED-252 studio shell fixture',
  rarity: 'rare',
  image: 'studio-piece.png',
  stats: { maxHp: 20, attack: 6, defense: 2, moveRange: 3 },
  skills: [{ skillId: 'fireball', level: 1 }],
  rules: ['studio-rule'],
  initialStatusTags: [{
    id: 'studio-burning',
    type: 'skill-rule',
    name: '灼烧标记',
    description: '真实状态定义：由棋子初始状态声明。',
    iconPath: 'images/status-old.png',
    visible: true,
    extension: { preserve: 'status-extension' },
  }],
  cluster: { version: 'rvb-skill-cluster/v1', id: 'pieces:studio-piece', links: [] },
  editorSmokeUnknown: { preserved: true, source: 'piece-fixture' },
}
writeJson('data/skills/manifest.json', ['fireball', 'studio-literal'])
writeJson('data/pieces/manifest.json', ['studio-piece'])
writeJson('data/cards/manifest.json', [])
writeJson('data/rules/manifest.json', ['studio-rule'])
writeJson('data/rules/studio-rule.json', { id:'studio-rule', name:'工作台规则', trigger:{type:'afterMove'}, skillCode:'return { success: true };', statusTag:{ id:'studio-rule-status', name:'规则状态', visible:true, iconPath:'images/status-old.png', extension:{preserved:true} } })
writeJson('data/skills/fireball.json', sourceSkill)
writeJson('data/skills/studio-literal.json', literalSkill)
writeJson('data/pieces/studio-piece.json', piece)
fs.writeFileSync(path.join(project, 'images', 'studio-piece.png'), png(40, 90, 170))
fs.writeFileSync(path.join(project, 'images', 'status-old.png'), png(175, 65, 72))
fs.writeFileSync(path.join(project, 'images', 'status-new.png'), png(40, 150, 95))
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))

const executable = process.env.RVB_GRAPH_EDITOR_EXE
  || process.env.RVB_GRAPH_ELECTRON_BINARY
  || path.join(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [...args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--editor-smoke-hidden'], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childStderr = ''
child.stderr?.on('data', chunk => { childStderr += String(chunk) })
let startupError
child.on('error', error => { startupError = error })

let socket
let sequence = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function connect() {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
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
  throw new Error(`Editor startup timed out${childStderr ? `: ${childStderr.slice(-1200)}` : ''}`)
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`CDP timeout: ${method}`))
    }, 30000)
    const onMessage = event => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
  return result.result?.value
}

async function until(expression, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return
    } catch { /* the document may be between navigation and DOM creation */ }
    await delay(120)
  }
  throw new Error(`UI condition timed out: ${expression}`)
}

async function screenshot(name, width = 1487, height = 1058) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await delay(180)
  const result = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const filename = path.join(evidence, `${name}.png`)
  fs.writeFileSync(filename, Buffer.from(result.data, 'base64'))
  return filename
}

async function openDocument(collection, id) {
  await evaluate(`document.querySelector('[data-tab=${JSON.stringify(collection)}]').click()`)
  await until(`Boolean(document.querySelector('#${collection}-list .entity-item'))`)
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#${collection}-list .entity-item')].find(item => item.querySelector('.id')?.textContent === ${JSON.stringify(id)})
    if (!row) throw new Error('missing ${collection}/${id}')
    row.click()
  })()`)
  await until(`Boolean(document.querySelector('#${collection}-detail [data-json-source]'))`)
}

async function openDraftDocument(collection, id) {
  await evaluate('openCollectionDocument(' + JSON.stringify(collection) + ', ' + JSON.stringify(id) + ')')
  await until(`Boolean(document.querySelector('#${collection}-detail [data-json-source]'))`)
}

function readProjectJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(project, relative), 'utf8'))
}

let archiveEntries = []
let archiveManifest
let screenshots = []
let outcome
const mark = label => console.log(`[studio-shell-smoke] ${label}`)

try {
  mark('connect')
  await connect()
  // A navigation away from a dirty editor may raise the browser's native
  // before-unload confirmation. Resolve it through CDP so Runtime.evaluate
  // cannot remain blocked behind a hidden dialog.
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Page.javascriptDialogOpening') void call('Page.handleJavaScriptDialog', { accept: true })
  })
  await call('Page.enable')
  await call('Page.bringToFront')

  // The approved first view is piece-first and uses the light studio shell.
  mark('piece overview')
  await until("document.body.classList.contains('studio-surface') && document.querySelector('[data-tab=pieces].active')")
  await openDocument('pieces', 'studio-piece')
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-editor]'))")
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(255, 255, 255)')
  screenshots.push(await screenshot('piece-overview'))

  // Navigate to the sentence editor. The first-version surface intentionally
  // has no title icon or preview artwork; its preview is text and values.
  mark('skill overview')
  await openDocument('skills', 'fireball')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-editor]').dataset.sentenceKind"), 'active')
  assert.equal(await evaluate("document.querySelectorAll('#skills-detail [data-sentence-editor] img').length"), 0, 'skill title/preview artwork must not be rendered')
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-control=multiplier]'))"), true)
  // A non-canonical graph uses the sentence editor's generic projection. Its
  // blue registered-module token must open the sentence valueEditor, whose
  // source selector keeps the literal/constant choice available alongside
  // compatible graph references.
  mark('constant expression options')
  await openDocument('skills', 'studio-literal')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\"message-0\"] [data-sentence-module-editor=\"message-0\"]'))")
  await evaluate("document.querySelector('#skills-detail [data-sentence-node=\"message-0\"] [data-sentence-module-editor=\"message-0\"]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=\"statement:message-0\"] [data-sentence-value-source=\"left\"]'))")
  assert.equal(await evaluate("[...document.querySelectorAll('#skills-detail [data-sentence-popover=\"statement:message-0\"] [data-sentence-value-source=\"left\"] option')].some(option => option.value === 'literal' && option.textContent.includes('常量'))"), true)
  await evaluate("document.querySelector('#skills-detail [data-sentence-popover=\"statement:message-0\"] .sentence-popover-close').click()")
  await openDocument('skills', 'fireball')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))")
  screenshots.push(await screenshot('skill-overview'))

  await evaluate("document.querySelector('#skills-detail [data-sentence-control=multiplier]').click()")
  mark('expression inline')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=multiplier]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-popover=multiplier] [data-sentence-multiplier]').value"), '1.5')
  screenshots.push(await screenshot('expression-inline'))

  await evaluate("(() => { const input = document.querySelector('#skills-detail [data-sentence-popover=multiplier] [data-sentence-multiplier]'); input.value = '2.2'; input.dispatchEvent(new Event('change', { bubbles: true })); })()")
  await until("document.querySelector('#skills-detail [data-sentence-control=multiplier]')?.textContent.includes('2.2')")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).powerMultiplier"), 2.2)
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).editorSmokeUnknown.preserved"), true)

  // Exercise the shell-level document history, then persist the redone value.
  mark('undo redo save skill')
  await evaluate("document.querySelector('#studio-undo').click()")
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).powerMultiplier === 1.5")
  await evaluate("document.querySelector('#studio-redo').click()")
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).powerMultiplier === 2.2")
  await evaluate("document.querySelector('#skills-detail [data-sentence-save]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存'")
  assert.equal(readProjectJson('data/skills/fireball.json').powerMultiplier, 2.2)
  assert.deepEqual(readProjectJson('data/skills/fireball.json').editorSmokeUnknown, sourceSkill.editorSmokeUnknown)

  // Reopen the same file and verify the saved expression and unknown field.
  mark('reopen skill')
  await openDocument('skills', 'fireball')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-control=multiplier]').textContent.includes('2.2')"), true)
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).editorSmokeUnknown.source"), 'RED-252-studio-shell-smoke')

  // Global status navigation must project the actual definition and its real
  // owning document. This status is declared by the skill but is displayed
  // from the piece Cluster, which exercises the cross-document owner path.
  mark('global status')
  await evaluate("document.querySelector('[data-tab=statuses]').click()")
  await until("Boolean(document.querySelector('#statuses-list .studio-status-row'))")
  await evaluate("(() => { const row = [...document.querySelectorAll('#statuses-list .studio-status-row')].find(item => item.querySelector('.name')?.textContent === '技能灼烧标记'); if (!row) throw new Error('missing skill-owned status row'); row.click() })()")
  await until("document.querySelector('#statuses-detail')?.textContent.includes('技能灼烧标记')")
  const statusDetail = await evaluate("document.querySelector('#statuses-detail')?.textContent || ''")
  assert.match(statusDetail, /技能文档内联声明/)
  assert.match(statusDetail, /fireball/)
  screenshots.push(await screenshot('status-library'))
  await evaluate("(() => { const edit = [...document.querySelectorAll('#statuses-detail button')].find(button => button.textContent.includes('编辑状态与图标')); if (!edit) throw new Error('missing status directory edit action'); edit.click() })()")
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-status-field=iconPath]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-skill-cluster-status-field=iconPath]')?.value"), 'images/status-old.png')

  // Open the piece-first projection of the skill-owned status, choose an
  // asset, and verify the owning skill draft updates immediately. Save and
  // reopen the owning document to prove the extension field survives.
  mark('piece status edit')
  await openDocument('pieces', 'studio-piece')
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member-tab=status]').click()")
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-member=\\\"status:studio-skill-burning\\\"]'))")
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member=\\\"status:studio-skill-burning\\\"]').click()")
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-status-asset]'))")
  await until("[...document.querySelectorAll('#pieces-detail [data-skill-cluster-status-asset] option')].some(option => option.value === 'images/status-new.png')", 30000)
  assert.match(await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-detail=status]')?.textContent || ''"), /skills · fireball/)
  await evaluate("(() => { const select = document.querySelector('#pieces-detail [data-skill-cluster-status-asset]'); select.value = 'images/status-new.png'; select.dispatchEvent(new Event('change', { bubbles: true })); })()")
  await until("document.querySelector('#pieces-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")
  await until("document.querySelector('#pieces-detail [data-skill-cluster-detail=status]')?.textContent.includes('images/status-new.png')")
  screenshots.push(await screenshot('piece-status-editor'))

  await openDraftDocument('skills', 'fireball')
  await evaluate("document.querySelector('#skills-detail [data-skill-cluster-member-tab=status]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-member=\\\"status:studio-skill-burning\\\"]'))")
  await evaluate("document.querySelector('#skills-detail [data-skill-cluster-member=\\\"status:studio-skill-burning\\\"]').click()")
  await until("document.querySelector('#skills-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")
  await evaluate("document.querySelector('#skills-detail [data-save-json]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存'")
  const persistedSkill = readProjectJson('data/skills/fireball.json')
  assert.equal(persistedSkill.statusTag.iconPath, 'images/status-new.png')
  assert.deepEqual(persistedSkill.statusTag.extension, { preserve: 'skill-status-extension' })

  await openDocument('skills', 'fireball')
  await evaluate("document.querySelector('#skills-detail [data-skill-cluster-member-tab=status]').click()")
  await evaluate("document.querySelector('#skills-detail [data-skill-cluster-member=\\\"status:studio-skill-burning\\\"]').click()")
  await until("document.querySelector('#skills-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")
  assert.deepEqual(readProjectJson('data/skills/fireball.json').statusTag.extension, { preserve: 'skill-status-extension' })

  // Rule-owned statuses use the standalone editor rather than a skill Cluster.
  mark('standalone status lifecycle')
  await evaluate("document.querySelector('[data-tab=statuses]').click()")
  await evaluate("(() => { const row=[...document.querySelectorAll('#statuses-list .studio-status-row')].find(x=>x.querySelector('.name')?.textContent==='规则状态'); if(!row) throw new Error('missing rule status'); row.click(); document.querySelector('#statuses-detail button').click(); })()")
  await until("Boolean(document.querySelector('#rules-detail [data-skill-cluster-status-field=iconPath]'))")
  await evaluate("(() => { const input=document.querySelector('#rules-detail [data-skill-cluster-status-field=iconPath]'); input.value='images/status-new.png'; input.dispatchEvent(new Event('change',{bubbles:true})); })()")
  await until("document.querySelector('#rules-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")
  await evaluate("document.querySelector('#studio-undo').click()")
  await until("document.querySelector('#rules-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-old.png'")
  await evaluate("document.querySelector('#studio-redo').click()")
  await until("document.querySelector('#rules-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")
  await evaluate("document.querySelector('#studio-save').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]')?.textContent === '已保存'")
  assert.equal(readProjectJson('data/rules/studio-rule.json').statusTag.iconPath,'images/status-new.png')
  await evaluate("document.querySelector('[data-tab=statuses]').click()")
  await evaluate("(() => { [...document.querySelectorAll('#statuses-list .studio-status-row')].find(x=>x.querySelector('.name')?.textContent==='规则状态').click(); document.querySelector('#statuses-detail button').click(); })()")
  await until("document.querySelector('#rules-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")
  screenshots.push(await screenshot('rule-status-editor'))

  // A dirty draft must prevent staging/building. Use a distinct value so a
  // build accidentally using stale disk content cannot look like success.
  mark('dirty build block')
  await openDocument('skills', 'fireball')
  await evaluate("document.querySelector('#skills-detail [data-sentence-control=multiplier]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=multiplier]'))")
  await evaluate("(() => { const input = document.querySelector('#skills-detail [data-sentence-popover=multiplier] [data-sentence-multiplier]'); input.value = '3.3'; input.dispatchEvent(new Event('change', { bubbles: true })); })()")
  await until("document.querySelector('#skills-detail .dirty-state.dirty')?.textContent === '未保存'")
  await evaluate("document.querySelector('[data-tab=build]').click()")
  await evaluate("document.querySelector('[data-package-stage=generate]').click()")
  await until("document.querySelector('#build-btn') && document.querySelector('#build-btn').offsetParent !== null")
  await evaluate("document.querySelector('#build-output').value = 'archives/studio-shell-dirty.rvbpack'; document.querySelector('#build-btn').click()")
  await until("document.querySelector('#build-badge')?.textContent.includes('请先保存内容')")
  assert.equal(fs.existsSync(path.join(project, 'archives', 'studio-shell-dirty.rvbpack')), false)
  mark('dirty build blocked')

  // Save the draft, stage the actual workspace, and build an unsigned local
  // authoring pack. Publishing is intentionally outside this smoke.
  mark('saved build')
  mark('saved build save skill')
  // Keep the build tab active after the refusal and save the still-mounted
  // skill panel directly. Navigating back to the list would intentionally
  // accept the discard confirmation and lose the dirty 3.3 draft.
  await evaluate("document.querySelector('#studio-save').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存'")
  mark('saved build refresh workspace')
  await evaluate("document.querySelector('[data-package-stage=contents]').click()")
  await evaluate("document.querySelector('#refresh-workspace').click()")
  await until("document.querySelector('#workspace-diff')?.textContent.includes('与内置内容一致') || document.querySelector('#workspace-diff')?.textContent.includes('新增') || document.querySelector('#workspace-diff')?.textContent.includes('覆盖')", 60000)
  mark('saved build click')
  await evaluate("document.querySelector('[data-package-stage=generate]').click()")
  await evaluate("document.querySelector('#build-output').value = 'archives/studio-shell-smoke.rvbpack'; document.querySelector('#build-version').value = '0.1.252'; document.querySelector('#build-btn').click()")
  mark('saved build wait success')
  await until("document.querySelector('#build-badge')?.textContent.includes('成功')", 120000)
  screenshots.push(await screenshot('build-result'))
  const archive = path.join(project, 'archives', 'studio-shell-smoke.rvbpack')
  assert.equal(fs.existsSync(archive), true)
  const zip = new AdmZip(archive)
  archiveEntries = zip.getEntries().map(entry => entry.entryName).sort()
  assert.ok(archiveEntries.includes('data/pieces/studio-piece.json'), archiveEntries.join(', '))
  assert.ok(archiveEntries.includes('data/skills/fireball.json'), archiveEntries.join(', '))
  assert.ok(archiveEntries.includes('images/status-new.png'), archiveEntries.join(', '))
  const packedPiece = JSON.parse(zip.readAsText('data/pieces/studio-piece.json'))
  const packedSkill = JSON.parse(zip.readAsText('data/skills/fireball.json'))
  assert.equal(packedSkill.powerMultiplier, 3.3)
  assert.deepEqual(packedSkill.editorSmokeUnknown, sourceSkill.editorSmokeUnknown)
   assert.equal(packedSkill.statusTag.iconPath, 'images/status-new.png')
   assert.deepEqual(packedSkill.statusTag.extension, { preserve: 'skill-status-extension' })
   assert.equal(packedPiece.initialStatusTags[0].iconPath, 'images/status-old.png')
  assert.deepEqual(packedPiece.initialStatusTags[0].extension, { preserve: 'status-extension' })
  assert.deepEqual(zip.readFile('images/status-new.png'), fs.readFileSync(path.join(project, 'images', 'status-new.png')))
  assert.deepEqual(zip.readFile('images/studio-piece.png'), fs.readFileSync(path.join(project, 'images', 'studio-piece.png')))
  archiveManifest = JSON.parse(zip.readAsText('manifest.json'))
  assert.equal(archiveManifest.kind, 'snapshot')
  assert.equal(archiveManifest.publisher.keyId, null)

  // Keep a reviewable local artifact and a narrow viewport image. The main
  // evidence screenshots intentionally use the renderer's 1487x1058 capture
  // surface requested for this first-version visual review.
  fs.copyFileSync(archive, path.join(evidence, 'studio-shell-smoke.rvbpack'))
  mark('narrow screenshot')
  await openDocument('skills', 'fireball')
  assert.equal(await evaluate("document.querySelector('[data-tab=skills]')?.classList.contains('active')"), true)
  // Let the real shell notifications expire before capturing the compact
  // expression view; do not hide or remove them from the DOM in the test.
  await until("document.querySelectorAll('#toast .toast-item').length === 0", 15000)
  await evaluate("document.querySelector('#skills-detail [data-sentence-control=multiplier]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=multiplier]'))")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-popover=multiplier]')?.offsetParent !== null"), true)
  screenshots.push(await screenshot('expression-narrow', 1100, 800))
  outcome = {
    passed: true,
    executable,
    projectFixture: 'isolated temporary content project',
    firstView: 'piece-first/light-shell',
    skillNavigation: true,
    noSkillTitleOrPreviewArtwork: true,
    constantExpressionOptions: true,
    expressionScreenshot: true,
    multiplierSavedAndReopened: true,
    unknownSkillFieldPreserved: true,
    undoRedoPersisted: true,
    statusGlobalNavigationActualDefinition: true,
    statusCrossDocumentOwner: true,
    standaloneRuleStatusUndoRedoSaveReopen: true,
    statusIconChosenEditedSavedReopened: true,
    statusExtensionPreserved: true,
    dirtyBuildBlocked: true,
    buildSucceededAfterSave: true,
    buildPublished: false,
    archive: path.join(evidence, 'studio-shell-smoke.rvbpack'),
    archiveEntries,
    archiveManifest: { kind: archiveManifest.kind, version: archiveManifest.version, capabilities: archiveManifest.capabilities },
    screenshots,
  }
  fs.writeFileSync(path.join(evidence, 'studio-shell-smoke.json'), JSON.stringify(outcome, null, 2) + '\n')
  console.log(JSON.stringify(outcome))
} catch (error) {
  const failure = {
    passed: false,
    error: error instanceof Error ? error.stack || error.message : String(error),
    childStderr: childStderr.slice(-4000),
    project,
    screenshots,
  }
  try {
    if (socket) {
      failure.renderer = await evaluate(`({
        url: location.href,
        active: document.activeElement?.outerHTML?.slice(0, 600),
        status: document.querySelector('[role=status]')?.textContent || '',
        build: document.getElementById('build-console')?.innerText?.slice(-1200) || '',
        body: document.body?.innerText?.slice(0, 1800) || '',
      })`)
      failure.failureScreenshot = await screenshot('smoke-failure')
    }
  } catch (diagnosticError) {
    failure.diagnosticError = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
  }
  fs.writeFileSync(path.join(evidence, 'studio-shell-smoke.failure.json'), JSON.stringify(failure, null, 2) + '\n')
  throw error
} finally {
  if (socket) {
    try { await evaluate('window.close()') } catch { /* renderer may close before replying */ }
    socket.close()
  }
  child.kill()
  await delay(500)
  const resolved = path.resolve(temporary)
  if (resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('rvb-studio-shell-smoke-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch { /* leave an inspectable fixture if Windows holds a file */ }
  }
}
