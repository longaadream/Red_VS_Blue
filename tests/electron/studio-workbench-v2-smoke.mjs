import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

/*
 * RED-252 Workbench v2 acceptance smoke.
 *
 * This is a real Electron/CDP test. It deliberately does not import renderer
 * modules into Node, mock editorAPI, or use Playwright. The temporary content
 * project contains every supported authoring collection, a rule-only passive
 * Cluster, a nested pure expression, unknown extension fields, and a real
 * portrait copied from the repository's image assets. Only evidence files are
 * written below docs/qa/RED-252-studio-v2.
 */
const root = path.resolve(import.meta.dirname, '../..')
const evidence = path.resolve(process.env.RVB_STUDIO_WORKBENCH_V2_EVIDENCE_DIR || path.join(root, 'docs/qa/RED-252-studio-v2'))
fs.mkdirSync(evidence, { recursive: true })

const require = createRequire(import.meta.url)
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const AdmZip = require('adm-zip')

const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-studio-workbench-v2-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)

function writeJson(relative, value) {
  const filename = path.join(project, relative)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n')
}

// Deterministic status fixtures are intentionally tiny; the portrait fixture
// below is copied from the real repository artwork for visual acceptance.
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
const sourceNarutoVanguard = JSON.parse(fs.readFileSync(path.join(root, 'data/skills/naruto-vanguard.json'), 'utf8'))
const studioSkill = JSON.parse(JSON.stringify(sourceSkill))
studioSkill.id = 'studio-skill'
studioSkill.name = '工作台主动能力组'
studioSkill.description = '主动能力组跨文档编辑回归夹具。'
studioSkill.cluster = {
  version: 'rvb-skill-cluster/v1',
  id: 'skills:studio-skill',
  links: [
    { collection: 'rules', id: 'studio-rule', relation: 'shared' },
    { collection: 'cards', id: 'studio-card', relation: 'related' },
  ],
}
studioSkill.statusTag = {
  id: 'studio-status',
  type: 'skill-rule',
  name: '工作台灼烧状态',
  description: '技能所属状态定义。',
  duration: 2,
  visible: true,
  iconPath: 'images/status-old.png',
  extension: { futureStatusField: { preserve: true } },
}
studioSkill.extension = { owner: 'skill', future: { preserve: true } }
studioSkill.editorSmokeUnknown = { preserved: true, source: 'RED-252-studio-workbench-v2' }

const expressionSkill = JSON.parse(JSON.stringify(sourceSkill))
expressionSkill.id = 'studio-expression'
expressionSkill.name = '工作台嵌套表达式'
expressionSkill.description = '纯表达式组合回归夹具。'
expressionSkill.cluster = { version: 'rvb-skill-cluster/v1', id: 'skills:studio-expression', links: [] }
delete expressionSkill.statusTag
expressionSkill.extension = { owner: 'expression', future: { preserve: true } }
expressionSkill.editorSmokeUnknown = { preserved: true, source: 'nested-pure-expression' }
const expressionMessage = expressionSkill.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'message-0')
expressionMessage.inputs.left.value = '表达式前缀'

const rule = {
  id: 'studio-rule',
  name: '工作台共享规则',
  description: '技能组共享的规则来源。',
  priority: 1,
  trigger: { type: 'gameStart' },
  skillCode: 'return { success: true };',
  extension: { owner: 'rule', future: { preserve: true } },
}
const ruleOnly = {
  id: 'studio-rule-only',
  name: '工作台独立被动规则',
  description: '没有主动 Skill 的规则根 Cluster。',
  kind: 'passive',
  type: 'passive',
  priority: 2,
  trigger: { type: 'gameStart' },
  skillCode: 'return { success: true };',
  cluster: { version: 'rvb-skill-cluster/v1', id: 'rules:studio-rule-only', links: [] },
  extension: { owner: 'rule-only', future: { preserve: true } },
}
const card = {
  id: 'studio-card',
  name: '工作台关联卡牌',
  description: '卡牌字段与未知字段保留夹具。',
  keywords: ['workbench'],
  targetText: '一名敌人',
  effectTags: ['测试'],
  type: 'active',
  cardType: 'neutral',
  actionPointCost: 1,
  icon: '🃏',
  image: '',
  isSample: false,
  trigger: null,
  targeting: null,
  code: 'function executeCard(context) { return { success: true }; }',
  extension: { owner: 'card', future: { preserve: true } },
}
const piece = {
  id: 'studio-piece',
  name: '工作台真实肖像棋子',
  faction: 'good',
  description: '跨目录与素材预览夹具。',
  rarity: 'rare',
  image: 'portrait-aizen.jpg',
  stats: { maxHp: 20, attack: 6, defense: 2, moveRange: 3 },
  skills: [{ skillId: 'studio-skill', level: 1 }, { skillId: 'studio-expression', level: 1 }],
  rules: ['studio-rule'],
  relatedCards: ['studio-card'],
  initialStatusTags: [{
    id: 'piece-status',
    type: 'piece-status',
    name: '棋子初始状态',
    description: '来自棋子文档的状态。',
    visible: true,
    iconPath: 'images/status-old.png',
    extension: { owner: 'piece-status', future: { preserve: true } },
  }],
  cluster: {
    version: 'rvb-skill-cluster/v1',
    id: 'pieces:studio-piece',
    links: [
      { collection: 'skills', id: 'studio-skill', relation: 'owned' },
      { collection: 'skills', id: 'studio-expression', relation: 'owned' },
      { collection: 'cards', id: 'studio-card', relation: 'related' },
    ],
  },
  extension: { owner: 'piece', future: { preserve: true } },
}

writeJson('data/skills/manifest.json', ['studio-skill', 'studio-expression', 'naruto-vanguard'])
writeJson('data/pieces/manifest.json', ['studio-piece'])
writeJson('data/cards/manifest.json', ['studio-card'])
writeJson('data/rules/manifest.json', ['studio-rule', 'studio-rule-only'])
writeJson('data/skills/studio-skill.json', studioSkill)
writeJson('data/skills/studio-expression.json', expressionSkill)
// Keep this production definition intact: it is a legacy passive Skill entry,
// used here to verify the compatibility label without inventing a new model.
writeJson('data/skills/naruto-vanguard.json', sourceNarutoVanguard)
writeJson('data/pieces/studio-piece.json', piece)
writeJson('data/cards/studio-card.json', card)
writeJson('data/rules/studio-rule.json', rule)
writeJson('data/rules/studio-rule-only.json', ruleOnly)
fs.copyFileSync(path.join(root, 'data/pages/images/adventure/aizen.jpg'), path.join(project, 'images/portrait-aizen.jpg'))
fs.writeFileSync(path.join(project, 'images/status-old.png'), png(175, 65, 72))
fs.writeFileSync(path.join(project, 'images/status-new.png'), png(40, 150, 95))
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
let childStdout = ''
let childStderr = ''
child.stdout?.on('data', chunk => { childStdout += String(chunk) })
child.stderr?.on('data', chunk => { childStderr += String(chunk) })
let startupError
child.on('error', error => { startupError = error })

let socket
let sequence = 0
const runtimeConsoleErrors = []
const runtimeConsoleNoise = []
const runtimeExceptions = []
const protocolLogErrors = []
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

function selector(value) { return JSON.stringify(value) }

async function screenshot(name, width = 1487, height = 1058) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await delay(180)
  const result = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const filename = path.join(evidence, `${name}.png`)
  const bytes = Buffer.from(result.data, 'base64')
  fs.writeFileSync(filename, bytes)
  assert.equal(bytes.readUInt32BE(16), width, `${name} screenshot width`)
  assert.equal(bytes.readUInt32BE(20), height, `${name} screenshot height`)
  return filename
}

async function openDocument(collection, id) {
  // Page.reload can expose the static tab markup before the renderer has
  // mounted its collection lists and click handlers. Wait for the initial
  // content list so route assertions exercise the real mounted surface.
  await until("Boolean(document.querySelector('#pieces-list .entity-item'))")
  await evaluate(`document.querySelector('[data-tab=${selector(collection)}]')?.click()`)
  await until(`document.querySelector('[data-tab=${selector(collection)}]')?.classList.contains('active') && document.querySelector('#tab-${collection}')?.classList.contains('active')`)
  await until(`Boolean(document.querySelector('#${collection}-list .entity-item'))`)
  await evaluate(`(() => {
    const row = document.querySelector('#${collection}-list [data-entity-id=${selector(id)}]')
      || [...document.querySelectorAll('#${collection}-list .entity-item')].find(item => item.querySelector('.id')?.textContent === ${selector(id)})
    if (!row) throw new Error('missing ${collection}/${id}')
    row.click()
  })()`)
  await until(`Boolean(document.querySelector('#${collection}-detail [data-json-source]'))`)
  await until(`Boolean(document.querySelector('#${collection}-detail')?.offsetParent)`)
  await until(`document.querySelector('[data-shell-breadcrumb]')?.dataset.route === ${selector(collection)} && document.querySelector('[data-shell-breadcrumb]')?.dataset.documentId === ${selector(id)}`)
}

async function openSkill(id) {
  await openDocument('skills', id)
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-editor]')?.offsetParent)`)
}

async function openDraftDocument(collection, id) {
  await evaluate(`openCollectionDocument(${selector(collection)}, ${selector(id)})`)
  await until(`document.querySelector('[data-tab=${selector(collection)}]')?.classList.contains('active') && document.querySelector('#tab-${collection}')?.classList.contains('active')`)
  await until(`Boolean(document.querySelector('#${collection}-detail [data-json-source]'))`)
  await until(`Boolean(document.querySelector('#${collection}-detail')?.offsetParent)`)
  await until(`document.querySelector('[data-shell-breadcrumb]')?.dataset.route === ${selector(collection)} && document.querySelector('[data-shell-breadcrumb]')?.dataset.documentId === ${selector(id)}`)
}

function visibleClusterMember(detailSelector, label) {
  return `(() => {
    const host = document.querySelector(${selector(detailSelector)})
    const leaf = [...(host?.querySelectorAll('*') || [])].find(node => node.offsetParent !== null && node.children.length === 0 && node.textContent?.trim() === ${selector(label)})
    const row = leaf?.closest('[data-skill-cluster-member], .skill-cluster-member, .skill-cluster-piece-related-row, .skill-cluster-piece-skill-row, article, button')
    return Boolean(row && row.offsetParent !== null)
  })()`
}

function clickVisibleClusterMember(detailSelector, label) {
  return `(() => {
    const host = document.querySelector(${selector(detailSelector)})
    const leaf = [...(host?.querySelectorAll('*') || [])].find(node => node.offsetParent !== null && node.children.length === 0 && node.textContent?.trim() === ${selector(label)})
    const row = leaf?.closest('[data-skill-cluster-member], .skill-cluster-member, .skill-cluster-piece-related-row, .skill-cluster-piece-skill-row, article, button')
    if (!row) throw new Error('missing visible Cluster member: ' + ${selector(label)})
    row.click()
  })()`
}

function clickVisibleButtonContaining(rootSelector, label) {
  return `(() => {
    const root = document.querySelector(${selector(rootSelector)}) || document
    const button = [...root.querySelectorAll('button')].find(node => node.offsetParent !== null && node.textContent?.includes(${selector(label)}))
    if (!button) throw new Error('missing visible button: ' + ${selector(label)})
    button.click()
  })()`
}

function readProjectJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(project, relative), 'utf8'))
}

function visible(selectorText) {
  return `(() => { const node = document.querySelector(${selector(selectorText)}); return Boolean(node && node.offsetParent !== null && getComputedStyle(node).visibility !== 'hidden') })()`
}

let screenshots = []
let archiveEntries = []
let archiveManifest = null
let controlStructureEdited = false
let expressionCopyVerified = false
let standaloneExpressionCopyVerified = false
let newPassiveRuleCreated = false
let legacyPassiveSkillLabelVerified = false
let crossDocumentSaveAllVerified = false
let selectedExpressionViewport = null
let clusterGroupMetadataVerified = false
let textParameterBindingVerified = false
let outcome
const mark = label => console.log(`[studio-workbench-v2-smoke] ${label}`)

try {
  mark('connect')
  await connect()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.consoleAPICalled') {
      const callData = message.params
      if (['error', 'assert'].includes(callData.type)) {
        const entry = { type: callData.type, args: callData.args?.map(arg => arg.value ?? arg.description ?? '') }
        const text = entry.args?.join('\n') || ''
        if (text.includes('Electron sandboxed_renderer.bundle.js script failed to run') || text.includes("Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null")) runtimeConsoleNoise.push(entry)
        else runtimeConsoleErrors.push(entry)
      }
    }
    if (message.method === 'Runtime.exceptionThrown') runtimeExceptions.push(message.params.exceptionDetails)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') protocolLogErrors.push(message.params.entry)
    if (message.method === 'Page.javascriptDialogOpening') void call('Page.handleJavaScriptDialog', { accept: true })
  })
  await call('Runtime.enable')
  await call('Log.enable')
  await call('Page.enable')
  await call('Page.bringToFront')

  mark('workbench shell and all routes')
  await until("document.body.classList.contains('studio-surface') && Boolean(document.querySelector('[data-tab=pieces].active'))")
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-shell-nav]')].map(node => node.dataset.shellNav)"), ['workbench', 'pieces', 'skills', 'cards', 'rules', 'assets', 'build'])
  assert.equal(await evaluate("document.querySelector('[data-tab=statuses]')?.getAttribute('aria-hidden')"), 'true')
  assert.equal(await evaluate(visible('[data-tab=statuses]')), false, 'status must not be a visible top-level route')
  for (const collection of ['pieces', 'skills', 'cards', 'rules', 'assets', 'build']) {
    await evaluate(`document.querySelector('[data-tab=${selector(collection)}]').click()`)
    await until(`document.querySelector('[data-tab=${selector(collection)}]')?.classList.contains('active') && document.querySelector('#tab-${collection}')?.classList.contains('active')`)
  }

  mark('piece overview and real portrait asset')
  await openDocument('pieces', 'studio-piece')
  await until("document.querySelector('[data-shell-breadcrumb]')?.textContent.includes('棋子 / studio-piece')")
  assert.equal(await evaluate("document.querySelector('[data-shell-breadcrumb]')?.textContent.includes('棋子 / studio-piece')"), true)
  await until("Boolean(document.querySelector('#pieces-detail [data-context-image-host] img'))")
  assert.equal(await evaluate("document.querySelector('#pieces-detail [data-context-image-host] img')?.src.startsWith('data:image/')"), true)
  assert.equal(await evaluate("document.querySelector('#pieces-detail [data-context-image-host] img')?.naturalWidth > 0"), true)
  assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, 'piece layout must not overflow horizontally')
  assert.equal(await evaluate(visibleClusterMember('#pieces-detail', '工作台主动能力组')), true)
  assert.equal(await evaluate("Boolean([...document.querySelectorAll('#pieces-detail .skill-cluster-linked-card')].find(card => card.offsetParent !== null && card.textContent.includes('工作台主动能力组') && card.textContent.includes('Rule 1') && card.textContent.includes('StatusTag 1') && card.textContent.includes('Card 1')) )"), true)
  screenshots.push(await screenshot('v2-piece-overview'))

  // Exercise an ordinary piece edit while the portrait and Cluster are open.
  await evaluate("document.querySelector('#pieces-detail [data-editor-mode=fields]').click()")
  await until("Boolean(document.querySelector('#pieces-detail [data-field-path=description]'))")
  await evaluate("(() => { const field = document.querySelector('#pieces-detail [data-field-path=description]'); field.value = '棋子说明已编辑'; field.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await until("document.querySelector('#pieces-detail [data-footer-state]')?.textContent === '未保存'")
  await evaluate("document.querySelector('#pieces-detail [data-save-json]').click()")
  await until("document.querySelector('#pieces-detail [data-footer-state]')?.textContent === '已保存'")
  assert.equal(readProjectJson('data/pieces/studio-piece.json').description, '棋子说明已编辑')
  assert.deepEqual(readProjectJson('data/pieces/studio-piece.json').extension, piece.extension)

  mark('rule-only passive Cluster menu')
  await evaluate("document.querySelector('[data-tab=skills]').click()")
  await until("Boolean(document.querySelector('#skills-list [data-entity-id=\"studio-rule-only\"]'))")
  assert.equal(await evaluate("document.querySelector('#skills-list [data-entity-id=\"studio-rule-only\"]')?.dataset.clusterId"), 'rules:studio-rule-only')
  assert.equal(await evaluate("document.querySelector('#skills-list [data-entity-id=\"studio-rule-only\"] .entity-badge')?.textContent"), '被动')
  assert.match(await evaluate("document.querySelector('#skills-list [data-entity-id=\"studio-rule-only\"] .entity-summary')?.textContent || ''"), /规则/)
  screenshots.push(await screenshot('v2-skills-cluster-list'))
  await evaluate("document.querySelector('#skills-list [data-entity-id=\"studio-rule-only\"]').click()")
  await until("Boolean(document.querySelector('#rules-detail [data-json-source]'))")
  assert.equal(await evaluate("document.querySelector('#rules-detail [data-document-title]')?.textContent"), ruleOnly.name)
  assert.equal(await evaluate("document.querySelector('#rules-detail [data-cluster-return]')?.textContent"), '返回能力组')
  await evaluate("document.querySelector('#rules-detail [data-editor-mode=fields]').click()")
  await until("Boolean(document.querySelector('#rules-detail [data-field-path=priority]'))")
  await evaluate("(() => { const field = document.querySelector('#rules-detail [data-field-path=priority]'); field.value = '4'; field.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await evaluate("document.querySelector('#rules-detail [data-save-json]').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]')?.textContent === '已保存'")
  assert.equal(readProjectJson('data/rules/studio-rule-only.json').priority, 4)
  assert.deepEqual(readProjectJson('data/rules/studio-rule-only.json').extension, ruleOnly.extension)

  mark('create passive Rule Cluster from Skills dialog')
  const createdPassiveRuleId = 'studio-created-passive'
  await evaluate("document.querySelector('[data-tab=skills]').click()")
  await until("document.querySelector('[data-tab=skills]')?.classList.contains('active') && document.querySelector('#tab-skills')?.classList.contains('active')")
  await evaluate("document.querySelector('[data-new-document=skills]').click()")
  await until("document.querySelector('#create-dialog')?.open === true")
  assert.equal(await evaluate("document.querySelector('#create-cluster-kind-field')?.hidden"), false)
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#create-cluster-kind option')].map(option => option.value)"), ['skills', 'rules'])
  await evaluate(`(() => {
    document.querySelector('#create-cluster-kind').value = 'rules'
    document.querySelector('#create-id').value = '${createdPassiveRuleId}'
    document.querySelector('#create-name').value = '工作台新建被动规则'
    document.querySelector('#create-form').requestSubmit()
  })()`)
  await until("document.querySelector('[data-tab=rules]')?.classList.contains('active') && document.querySelector('#tab-rules')?.classList.contains('active')")
  await until("document.querySelector('#rules-detail [data-footer-state]')?.textContent === '待创建'")
  assert.equal(await evaluate("document.querySelector('#rules-detail [data-document-title]')?.textContent"), '工作台新建被动规则')
  assert.equal(await evaluate("document.querySelector('#rules-detail [data-cluster-return]')?.textContent"), '返回能力组')
  await evaluate("document.querySelector('#rules-detail [data-editor-mode=fields]').click()")
  await until("Boolean(document.querySelector('#rules-detail [data-field-path=priority]')?.offsetParent)")
  await evaluate("(() => { const field = document.querySelector('#rules-detail [data-field-path=priority]'); field.value = '7'; field.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await until("JSON.parse(document.querySelector('#rules-detail [data-json-source]').value).priority === 7")
  await evaluate("document.querySelector('#rules-detail [data-save-json]').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]')?.textContent === '已保存'")
  await until("document.querySelector('#studio-save')?.textContent === '保存'")
  const createdPassive = readProjectJson(`data/rules/${createdPassiveRuleId}.json`)
  assert.equal(createdPassive.cluster?.id, `rules:${createdPassiveRuleId}`)
  assert.equal(createdPassive.priority, 7)
  assert.equal(fs.existsSync(path.join(project, 'data/skills', `${createdPassiveRuleId}.json`)), false, 'passive creation must not write a Skill document')
  await openDraftDocument('rules', createdPassiveRuleId)
  assert.equal(await evaluate("document.querySelector('#rules-detail [data-document-title]')?.textContent"), '工作台新建被动规则')
  assert.equal(await evaluate("JSON.parse(document.querySelector('#rules-detail [data-json-source]').value).cluster.id"), `rules:${createdPassiveRuleId}`)
  await evaluate("document.querySelector('[data-tab=skills]').click()")
  await until("document.querySelector('[data-tab=skills]')?.classList.contains('active') && document.querySelector('#tab-skills')?.classList.contains('active')")
  await until(`Boolean(document.querySelector('#skills-list [data-entity-id=${selector(createdPassiveRuleId)}]'))`)
  assert.equal(await evaluate(`document.querySelector('#skills-list [data-entity-id=${selector(createdPassiveRuleId)}] .entity-badge')?.textContent`), '被动')
  newPassiveRuleCreated = true

  mark('legacy passive Skill Cluster entry label')
  await openDocument('skills', 'naruto-vanguard')
  await until("Boolean(document.querySelector('#skills-detail [data-skill-cluster-member-tab=skill]')?.offsetParent)")
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-skill-cluster-member-tab=skill]')?.textContent?.trim()"), '被动入口（兼容） 1')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-skill-cluster-member-tab=skill]')?.getAttribute('aria-label')"), '被动入口（兼容）成员 1 项')
  legacyPassiveSkillLabelVerified = true

  mark('active Cluster members, related card, and owned status')
  await openSkill('studio-skill')
  assert.equal(await evaluate("document.querySelector('#skills-detail [data-sentence-editor]')?.dataset.sentenceKind"), 'active')
  // The passive piece root is the visible Cluster surface. This deliberately
  // enters the linked Skill Cluster through its visible card action, then
  // selects the visible member tabs rather than a hidden dependency panel.
  await openDocument('pieces', 'studio-piece')
  await until(visibleClusterMember('#pieces-detail', '工作台主动能力组'))
  await evaluate(clickVisibleButtonContaining('#pieces-detail .skill-cluster-linked-card', '在本 Cluster 中查看'))
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-member-tab=rule]'))")
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member-tab=rule]').click()")
  await until(visibleClusterMember('#pieces-detail', '工作台共享规则'))
  screenshots.push(await screenshot('v2-cluster-members'))
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member-tab=card]').click()")
  await until(visibleClusterMember('#pieces-detail', '工作台关联卡牌'))
  await evaluate(clickVisibleClusterMember('#pieces-detail', '工作台关联卡牌'))
  await evaluate("document.querySelector('#pieces-detail .skill-cluster-source-details summary')?.click()")
  await until("Boolean([...document.querySelectorAll('#pieces-detail button')].find(button => button.offsetParent !== null && button.textContent.includes('打开所属文档')))")
  await evaluate(clickVisibleButtonContaining('#pieces-detail', '打开所属文档'))
  await until("document.querySelector('#cards-detail [data-document-title]')?.textContent.includes('工作台关联卡牌')")
  assert.equal(await evaluate("document.querySelector('#cards-detail [data-cluster-return]')?.textContent"), '返回棋子')

  await evaluate("document.querySelector('#cards-detail [data-editor-mode=fields]').click()")
  await until("Boolean(document.querySelector('#cards-detail [data-field-path=description]'))")
  await evaluate("(() => { const field = document.querySelector('#cards-detail [data-field-path=description]'); field.value = '卡牌说明已编辑'; field.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await evaluate("document.querySelector('#cards-detail [data-save-json]').click()")
  await until("document.querySelector('#cards-detail [data-footer-state]')?.textContent === '已保存'")
  assert.equal(readProjectJson('data/cards/studio-card.json').description, '卡牌说明已编辑')
  assert.deepEqual(readProjectJson('data/cards/studio-card.json').extension, card.extension)
  await openDraftDocument('cards', 'studio-card')
  assert.equal(await evaluate("JSON.parse(document.querySelector('#cards-detail [data-json-source]').value).description"), '卡牌说明已编辑')
  screenshots.push(await screenshot('v2-card-owner'))
  // Start the cross-document save from a fresh renderer session so the Card
  // owner is genuinely unopened when its extension is edited from the Piece
  // Cluster surface.
  await call('Page.reload')
  await until("document.body.classList.contains('studio-surface') && Boolean(document.querySelector('[data-tab=pieces].active'))")
  // Unknown extension data is an explicit authoring field. Edit and add a
  // field through the visible Cluster extension editor projected from the
  // Piece root, save the actual Card owner, reopen it, then delete the added
  // field through that same editor. This deliberately avoids the advanced
  // JSON surface so the acceptance path exercises the authoring controls.
  await openDocument('pieces', 'studio-piece')
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-member-tab=\"extension\"]'))")
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member-tab=\"extension\"]').click()")
  await until("[...document.querySelectorAll('#pieces-detail [data-skill-cluster-member]')].some(row => row.offsetParent !== null && row.dataset.skillClusterMemberKey?.includes('studio-card') && row.dataset.skillClusterMemberKey?.includes('extension'))")
  await evaluate("(() => { const row = [...document.querySelectorAll('#pieces-detail [data-skill-cluster-member]')].find(item => item.offsetParent !== null && item.dataset.skillClusterMemberKey?.includes('studio-card') && item.dataset.skillClusterMemberKey?.includes('extension')); if (!row) throw new Error('missing visible Card extension member'); row.click() })()")
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-extension-editor]'))")
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"future.preserve\"]'))")
  await evaluate("(() => { const control = document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"future.preserve\"]'); control.value = 'false'; control.dispatchEvent(new Event('change', { bubbles: true })); })()")
  await until("document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"future.preserve\"]')?.value === 'false'")
  const extensionAdd = '#pieces-detail [data-skill-cluster-extension-add="extension"]'
  await until(`Boolean(document.querySelector(${selector(extensionAdd)}))`)
  await evaluate(`(() => { const input = document.querySelector(${selector(extensionAdd)}); input.value = 'editedBy'; const row = input.closest('.skill-cluster-structured-add'); const button = [...(row?.querySelectorAll('button') || [])].find(item => item.offsetParent !== null && item.textContent.includes('添加字段')); if (!button) throw new Error('missing visible extension add button'); button.click() })()`)
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"editedBy\"]'))")
  await evaluate("(() => { const control = document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"editedBy\"]'); control.value = 'visual-cluster'; control.dispatchEvent(new Event('change', { bubbles: true })); })()")
  // Keep the Card source document unopened. Edit a second member through the
  // same visible Cluster and prove the top-level save writes both owners.
  await openDocument('pieces', 'studio-piece')
  await evaluate(clickVisibleButtonContaining('#pieces-detail .skill-cluster-linked-card', '在本 Cluster 中查看'))
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-member-tab=status]'))")
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member-tab=status]').click()")
  await until(visibleClusterMember('#pieces-detail', '工作台灼烧状态'))
  await evaluate(clickVisibleClusterMember('#pieces-detail', '工作台灼烧状态'))
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-status-asset]'))")
  await until("[...document.querySelectorAll('#pieces-detail [data-skill-cluster-status-asset] option')].some(option => option.value === 'images/status-new.png')")
  await evaluate("(() => { const select = document.querySelector('#pieces-detail [data-skill-cluster-status-asset]'); select.value = 'images/status-new.png'; select.dispatchEvent(new Event('change', { bubbles: true })); })()")
  await until("document.querySelector('#pieces-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")
  await until("document.querySelector('#studio-save')?.textContent.includes('保存全部（2）')")
  await evaluate("document.querySelector('#studio-save').click()")
  await until("document.querySelector('#studio-save')?.textContent === '保存'")
  assert.deepEqual(readProjectJson('data/cards/studio-card.json').extension, { owner: 'card', future: { preserve: false }, editedBy: 'visual-cluster' })
  assert.equal(readProjectJson('data/skills/studio-skill.json').statusTag.iconPath, 'images/status-new.png')
  crossDocumentSaveAllVerified = true
  await openDraftDocument('cards', 'studio-card')
  assert.deepEqual(await evaluate("JSON.parse(document.querySelector('#cards-detail [data-json-source]').value).extension"), { owner: 'card', future: { preserve: false }, editedBy: 'visual-cluster' })

  // Delete the added extension field through the same visible editor, then
  // save/reopen the Card owner to prove replacement and deletion persist.
  await openDocument('pieces', 'studio-piece')
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member-tab=\"extension\"]').click()")
  await until("[...document.querySelectorAll('#pieces-detail [data-skill-cluster-member]')].some(row => row.offsetParent !== null && row.dataset.skillClusterMemberKey?.includes('studio-card') && row.dataset.skillClusterMemberKey?.includes('extension'))")
  await evaluate("(() => { const row = [...document.querySelectorAll('#pieces-detail [data-skill-cluster-member]')].find(item => item.offsetParent !== null && item.dataset.skillClusterMemberKey?.includes('studio-card') && item.dataset.skillClusterMemberKey?.includes('extension')); if (!row) throw new Error('missing visible Card extension member'); row.click() })()")
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"editedBy\"]'))")
  await evaluate("(() => { const control = document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"editedBy\"]'); const row = control.closest('.skill-cluster-structured-row'); const button = [...(row?.querySelectorAll('button') || [])].find(item => item.offsetParent !== null && item.textContent.includes('删除')); if (!button) throw new Error('missing visible extension delete button'); button.click() })()")
  await until("!Boolean(document.querySelector('#pieces-detail [data-skill-cluster-extension-path=\"editedBy\"]'))")
  await openDraftDocument('cards', 'studio-card')
  await until("JSON.parse(document.querySelector('#cards-detail [data-json-source]').value).extension.future.preserve === false")
  await evaluate("document.querySelector('#cards-detail [data-save-json]').click()")
  await until("document.querySelector('#cards-detail [data-footer-state]')?.textContent === '已保存'")
  assert.deepEqual(readProjectJson('data/cards/studio-card.json').extension, { owner: 'card', future: { preserve: false } })
  await openDraftDocument('cards', 'studio-card')
  assert.deepEqual(await evaluate("JSON.parse(document.querySelector('#cards-detail [data-json-source]').value).extension"), { owner: 'card', future: { preserve: false } })

  // Reopen the other owner after the cross-document save as well.
  await openDraftDocument('skills', 'studio-skill')
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).statusTag.iconPath === 'images/status-new.png'")
  const savedSkill = readProjectJson('data/skills/studio-skill.json')
  assert.equal(savedSkill.statusTag.iconPath, 'images/status-new.png')
  assert.deepEqual(savedSkill.statusTag.extension, studioSkill.statusTag.extension)
  assert.deepEqual(savedSkill.extension, studioSkill.extension)
  await call('Page.reload')
  await openDocument('pieces', 'studio-piece')
  await evaluate(clickVisibleButtonContaining('#pieces-detail .skill-cluster-linked-card', '在本 Cluster 中查看'))
  await until("Boolean(document.querySelector('#pieces-detail [data-skill-cluster-member-tab=status]'))")
  await evaluate("document.querySelector('#pieces-detail [data-skill-cluster-member-tab=status]').click()")
  await until(visibleClusterMember('#pieces-detail', '工作台灼烧状态'))
  await evaluate(clickVisibleClusterMember('#pieces-detail', '工作台灼烧状态'))
  await until("document.querySelector('#pieces-detail [data-skill-cluster-status-field=iconPath]')?.value === 'images/status-new.png'")

  mark('nested pure expression save and reopen')
  await openSkill('studio-expression')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\"message-0\"] [data-sentence-module-editor=\"message-0\"]'))")
  const expressionBefore = readProjectJson('data/skills/studio-expression.json')
  const bodyBefore = expressionBefore.gameplayModules.entries.code.graph.body.length
  await evaluate("document.querySelector('#skills-detail [data-sentence-node=\"message-0\"] [data-sentence-module-editor=\"message-0\"]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=\"statement:message-0\"] [data-sentence-create-expression=\"left\"]'))")
  await evaluate("document.querySelector('#skills-detail [data-sentence-popover=\"statement:message-0\"] [data-sentence-create-expression=\"left\"]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-expression-chooser=\"left\"]'))")
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-expression-chooser=\"left\"] [data-sentence-expression-module=\"text.concat\"]'))")
  await evaluate("document.querySelector('#skills-detail [data-sentence-expression-chooser=\"left\"] [data-sentence-expression-module=\"text.concat\"]').click()")
  await until(`JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.length > ${bodyBefore}`)
  const firstExpressionId = await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(statement => statement.layout?.sentenceExpression?.owner === 'message-0')?.id")
  assert.equal(typeof firstExpressionId, 'string')
  const firstExpressionPopover = `#skills-detail [data-sentence-popover=${selector(`statement:${firstExpressionId}`)}]`
  // Compose again inside the first pure expression. The compiler keeps both
  // calls as real ordered statements and rewires the first call's input to the
  // second output, so this is a true two-layer expression rather than two
  // unrelated insertions.
  await until(`Boolean(document.querySelector(${selector(`${firstExpressionPopover} [data-sentence-create-expression="left"]`)}))`)
  await evaluate(`document.querySelector(${selector(`${firstExpressionPopover} [data-sentence-create-expression="left"]`)}).click()`)
  await until(`Boolean(document.querySelector(${selector(`${firstExpressionPopover} [data-sentence-expression-chooser="left"] [data-sentence-expression-module="text.concat"]`)}))`)
  await evaluate(`document.querySelector(${selector(`${firstExpressionPopover} [data-sentence-expression-chooser="left"] [data-sentence-expression-module="text.concat"]`)}).click()`)
  await until(`JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.length > ${bodyBefore + 1}`)
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(statement => statement.id === 'message-0').inputs.left.kind"), 'output')
  assert.equal(await evaluate(`(() => { const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph; const first = graph.body.find(statement => statement.id === ${selector(firstExpressionId)}); const nested = graph.body.find(statement => statement.layout?.sentenceExpression?.owner === ${selector(firstExpressionId)}); return Boolean(first && nested && first.inputs?.left?.kind === 'output' && first.inputs.left.node === nested.id) })()`), true)
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).editorSmokeUnknown.source"), 'nested-pure-expression')

  const nestedExpressionId = await evaluate(`JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(statement => statement.layout?.sentenceExpression?.owner === ${selector(firstExpressionId)})?.id`)
  assert.equal(typeof nestedExpressionId, 'string')
  const nestedExpressionPopover = `#skills-detail [data-sentence-popover=${selector(`statement:${nestedExpressionId}`)}]`
  await call('Emulation.setDeviceMetricsOverride', { width: 1487, height: 1058, deviceScaleFactor: 1, mobile: false })
  await delay(180)
  await evaluate(`document.querySelector('#skills-detail [data-sentence-node=${selector(nestedExpressionId)}] [data-sentence-module-editor=${selector(nestedExpressionId)}]')?.click()`)
  await until(`Boolean(document.querySelector(${selector(nestedExpressionPopover)})?.offsetParent)`)
  selectedExpressionViewport = await evaluate(`(() => {
    const popover = document.querySelector(${selector(nestedExpressionPopover)})
    const rect = popover?.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    return {
      left: rect?.left ?? null, top: rect?.top ?? null,
      right: rect?.right ?? null, bottom: rect?.bottom ?? null,
      width: rect?.width ?? 0, height: rect?.height ?? 0,
      viewportWidth, viewportHeight,
      intersectsViewport: Boolean(rect && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight),
    }
  })()`)
  assert.equal(selectedExpressionViewport.intersectsViewport, true, `selected nested expression editor must intersect the viewport: ${JSON.stringify(selectedExpressionViewport)}`)
  screenshots.push(await screenshot('v2-expression-selected'))

  // Duplicate the visible consumer row. The editor must copy the entire
  // same-block pure-expression tree and remap every owner/output reference to
  // the new consumer and expression IDs; input slot names remain unchanged.
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-row-actions=\"message-0\"] [data-sentence-row-action=\"duplicate\"]')?.offsetParent)")
  await evaluate("document.querySelector('#skills-detail [data-sentence-row-actions=\"message-0\"] [data-sentence-row-action=\"duplicate\"]').click()")
  const draftCopy = await evaluate(`(() => {
    const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph
    const message = graph.body.find(statement => statement.id.startsWith('copy-message-0-'))
    const first = message && graph.body.find(statement => statement.layout?.sentenceExpression?.owner === message.id && statement.layout.sentenceExpression.input === 'left')
    const nested = first && graph.body.find(statement => statement.layout?.sentenceExpression?.owner === first.id && statement.layout.sentenceExpression.input === 'left')
    return { messageId: message?.id, firstId: first?.id, nestedId: nested?.id, messageInput: message?.inputs?.left?.node, firstInput: first?.inputs?.left?.node, originalOwnerCount: graph.body.filter(statement => statement.layout?.sentenceExpression?.owner === 'message-0').length }
  })()`)
  assert.equal(typeof draftCopy.messageId, 'string', 'duplicating message-0 must create a consumer copy')
  assert.equal(typeof draftCopy.firstId, 'string', 'consumer copy must include its owned first expression')
  assert.equal(typeof draftCopy.nestedId, 'string', 'consumer copy must include its nested expression')
  assert.equal(draftCopy.messageInput, draftCopy.firstId)
  assert.equal(draftCopy.firstInput, draftCopy.nestedId)
  assert.equal(draftCopy.originalOwnerCount, 1, 'original expression tree must retain its original owner')
  expressionCopyVerified = true
  // A pure-expression row copied by itself must become an independent
  // calculation row when its consumer is outside the copy range. It must not
  // remain falsely attached to the original consumer input.
  await until(`Boolean(document.querySelector('#skills-detail [data-sentence-row-actions=${selector(nestedExpressionId)}] [data-sentence-row-action="duplicate"]')?.offsetParent)`)
  await evaluate(`document.querySelector('#skills-detail [data-sentence-row-actions=${selector(nestedExpressionId)}] [data-sentence-row-action="duplicate"]').click()`)
  const standaloneExpressionCopyId = await evaluate(`(() => { const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph; return graph.body.find(statement => statement.id !== ${selector(nestedExpressionId)} && statement.id.startsWith('copy-' + ${selector(nestedExpressionId)} + '-'))?.id })()`)
  assert.equal(typeof standaloneExpressionCopyId, 'string', 'standalone pure-expression copy must get a new ID')
  assert.equal(await evaluate(`(() => { const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph; const copy = graph.body.find(statement => statement.id === ${selector(standaloneExpressionCopyId)}); return Boolean(copy && !copy.layout?.sentenceExpression) })()`), true, 'standalone expression copy must clear stale owner metadata')
  standaloneExpressionCopyVerified = true
  await evaluate("document.querySelector('#skills-detail [data-sentence-save], #skills-detail [data-save-json]').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存'")
  const savedExpression = readProjectJson('data/skills/studio-expression.json')
  assert.ok(savedExpression.gameplayModules.entries.code.graph.body.length > bodyBefore + 1)
  assert.equal(savedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'message-0').inputs.left.kind, 'output')
  const savedFirstExpression = savedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.id === firstExpressionId)
  const savedNestedExpression = savedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.layout?.sentenceExpression?.owner === firstExpressionId)
  assert.ok(savedFirstExpression && savedNestedExpression)
  assert.equal(savedFirstExpression.inputs.left.node, savedNestedExpression.id)
  const savedCopiedMessage = savedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.id === draftCopy.messageId)
  const savedCopiedFirst = savedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.id === draftCopy.firstId)
  const savedCopiedNested = savedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.id === draftCopy.nestedId)
  assert.ok(savedCopiedMessage && savedCopiedFirst && savedCopiedNested)
  assert.equal(savedCopiedMessage.inputs.left.node, savedCopiedFirst.id)
  assert.equal(savedCopiedFirst.inputs.left.node, savedCopiedNested.id)
  assert.deepEqual(savedCopiedFirst.layout.sentenceExpression, { owner: savedCopiedMessage.id, input: 'left' })
  assert.deepEqual(savedCopiedNested.layout.sentenceExpression, { owner: savedCopiedFirst.id, input: 'left' })
  const savedStandaloneExpressionCopy = savedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.id === standaloneExpressionCopyId)
  assert.ok(savedStandaloneExpressionCopy)
  assert.ok(!savedStandaloneExpressionCopy.layout?.sentenceExpression, 'standalone expression copy must not retain owner metadata')
  assert.deepEqual(savedExpression.extension, expressionSkill.extension)
  await call('Page.reload')
  await openSkill('studio-expression')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\"message-0\"]'))")
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(statement => statement.id === 'message-0').inputs.left.kind"), 'output')
  assert.equal(await evaluate(`(() => { const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph; const first = graph.body.find(statement => statement.id === ${selector(firstExpressionId)}); const nested = graph.body.find(statement => statement.layout?.sentenceExpression?.owner === ${selector(firstExpressionId)}); return Boolean(first && nested && first.inputs?.left?.node === nested.id) })()`), true)
  assert.equal(await evaluate(`(() => { const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph; const message = graph.body.find(statement => statement.id === ${selector(draftCopy.messageId)}); const first = graph.body.find(statement => statement.id === ${selector(draftCopy.firstId)}); const nested = graph.body.find(statement => statement.id === ${selector(draftCopy.nestedId)}); return Boolean(message && first && nested && message.inputs?.left?.node === first.id && first.inputs?.left?.node === nested.id && first.layout?.sentenceExpression?.owner === message.id && first.layout?.sentenceExpression?.input === 'left' && nested.layout?.sentenceExpression?.owner === first.id && nested.layout?.sentenceExpression?.input === 'left') })()`), true)
  assert.equal(await evaluate(`(() => { const graph = JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph; const copy = graph.body.find(statement => statement.id === ${selector(standaloneExpressionCopyId)}); return Boolean(copy && !copy.layout?.sentenceExpression) })()`), true)
  // A supported control row is required, not an optional coverage milestone.
  assert.equal(await evaluate("Boolean(document.querySelector('#skills-detail [data-sentence-node-kind=\"if\"] [data-sentence-module-editor]'))"), true)
  {
    await evaluate("document.querySelector('#skills-detail [data-sentence-node-kind=\"if\"] [data-sentence-module-editor]').click()")
    await until("Boolean(document.querySelector('#skills-detail [data-sentence-structured-editor=\"wait-or-cancel\"] [data-sentence-value-source=\"condition\"]'))")
    await evaluate("(() => { const source = document.querySelector('#skills-detail [data-sentence-structured-editor=\"wait-or-cancel\"] [data-sentence-value-source=\"condition\"]'); source.value = 'literal'; source.dispatchEvent(new Event('change', { bubbles: true })); })()")
    await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(statement => statement.id === 'wait-or-cancel').condition.kind === 'literal'")
    await evaluate("(() => { const source = document.querySelector('#skills-detail [data-sentence-structured-editor=\"wait-or-cancel\"] [data-sentence-value-source=\"condition\"]'); const literal = source.closest('.sentence-value-editor')?.querySelector('input[type=checkbox]'); if (!literal) throw new Error('missing editable boolean input'); literal.checked = true; literal.dispatchEvent(new Event('change', { bubbles: true })); })()")
    await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(statement => statement.id === 'wait-or-cancel').condition.value === true")
    await evaluate("document.querySelector('#skills-detail [data-save-json]').click()")
    await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存'")
    assert.equal(readProjectJson('data/skills/studio-expression.json').gameplayModules.entries.code.graph.body.find(statement => statement.id === 'wait-or-cancel').condition.value, true)
    await call('Page.reload')
    await openSkill('studio-expression')
    assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).gameplayModules.entries.code.graph.body.find(statement => statement.id === 'wait-or-cancel').condition.value"), true)
    controlStructureEdited = true
  }
  screenshots.push(await screenshot('v2-expression-narrow', 1100, 800))

  mark('description template and literal parameter binding')
  await evaluate("document.querySelector('#skills-detail .module-text-editor').open = true")
  await until(visible('#skills-detail [data-module-text-template=description]'))
  await evaluate(`(() => {
    const field = document.querySelector('#skills-detail [data-module-text-template=description]')
    field.value = '选择范围：'; field.dispatchEvent(new Event('input', { bubbles: true }))
    field.setSelectionRange(field.value.length, field.value.length)
    const source = document.querySelector('#skills-detail [data-module-text-source=description]')
    const range = [...source.options].find(option => option.dataset.moduleTextNode === 'choice' && option.dataset.moduleTextParameter === 'range')
    if (!range) throw new Error('missing real choice range parameter')
    source.value = range.value
    document.querySelector('#skills-detail [data-module-text-insert=description]').click()
  })()`)
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).description === '选择范围：5'")
  // Global Save must include text edits without a second local apply action.
  await evaluate("document.querySelector('#studio-save').click()")
  await until("document.querySelector('#studio-save')?.textContent === '保存'")
  assert.equal(readProjectJson('data/skills/studio-expression.json').description, '选择范围：5')
  await evaluate("document.querySelector('#skills-detail [data-sentence-node=choice] [data-sentence-module-editor]').click()")
  await until(visible('#skills-detail [data-sentence-inline-editor=choice]'))
  await evaluate(`(() => {
    const panel = document.querySelector('#skills-detail [data-sentence-inline-editor=choice]')
    const label = [...panel.querySelectorAll('label')].find(item => item.textContent.includes('范围') && item.querySelector('input[type=number]'))
    const field = label?.querySelector('input[type=number]')
    if (!field) throw new Error('missing editable choice range')
    field.value = '6'; field.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).description === '选择范围：6'")
  await evaluate("document.querySelector('#studio-save').click()")
  await until("document.querySelector('#studio-save')?.textContent === '保存'")
  await call('Page.reload')
  await openSkill('studio-expression')
  assert.equal(readProjectJson('data/skills/studio-expression.json').description, '选择范围：6')
  assert.equal(await evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value).description"), '选择范围：6')
  textParameterBindingVerified = true

  mark('standalone rule and assets routes')
  await openDocument('rules', 'studio-rule')
  await until("Boolean(document.querySelector('#rules-detail [data-skill-cluster-member-tab=overview]'))")
  await evaluate("document.querySelector('#rules-detail [data-skill-cluster-member-tab=overview]').click()")
  await until("Boolean(document.querySelector('#rules-detail [data-skill-cluster-group-field=name]'))")
  const clusterGroupName = '工作台独立规则分组'
  await evaluate(`(() => { const field = document.querySelector('#rules-detail [data-skill-cluster-group-field=name]'); field.value = ${selector(clusterGroupName)}; field.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await until(`JSON.parse(document.querySelector('#rules-detail [data-json-source]').value).cluster.name === ${selector(clusterGroupName)}`)
  await evaluate("document.querySelector('#studio-save').click()")
  await until("document.querySelector('#studio-save')?.textContent === '保存'")
  const savedRuleCluster = readProjectJson('data/rules/studio-rule.json')
  assert.equal(savedRuleCluster.name, rule.name, 'Cluster group rename must not rename the Rule root')
  assert.deepEqual(savedRuleCluster.cluster, { version: 'rvb-skill-cluster/v1', id: 'rules:studio-rule', links: [], name: clusterGroupName })
  await call('Page.reload')
  await openDocument('rules', 'studio-rule')
  await until("Boolean(document.querySelector('#rules-detail [data-skill-cluster-member-tab=overview]'))")
  await evaluate("document.querySelector('#rules-detail [data-skill-cluster-member-tab=overview]').click()")
  await until("Boolean(document.querySelector('#rules-detail [data-skill-cluster-group-field=name]'))")
  assert.equal(await evaluate("document.querySelector('#rules-detail [data-skill-cluster-group-field=name]')?.value"), clusterGroupName)
  assert.equal(await evaluate("JSON.parse(document.querySelector('#rules-detail [data-json-source]').value).name"), rule.name)
  clusterGroupMetadataVerified = true
  await evaluate("document.querySelector('#rules-detail [data-editor-mode=fields]').click()")
  await until("Boolean(document.querySelector('#rules-detail [data-field-path=priority]'))")
  await evaluate("(() => { const field = document.querySelector('#rules-detail [data-field-path=priority]'); field.value = '3'; field.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await evaluate("document.querySelector('#rules-detail [data-save-json]').click()")
  await until("document.querySelector('#rules-detail [data-footer-state]')?.textContent === '已保存'")
  assert.equal(readProjectJson('data/rules/studio-rule.json').priority, 3)
  assert.deepEqual(readProjectJson('data/rules/studio-rule.json').extension, rule.extension)
  screenshots.push(await screenshot('v2-rule-owner'))
  await evaluate("document.querySelector('[data-tab=assets]').click()")
  await until("document.querySelector('[data-tab=assets]')?.classList.contains('active') && document.querySelector('#tab-assets')?.classList.contains('active')")
  await until("Boolean(document.querySelector('#assets-list [data-asset-path=\"portrait-aizen.jpg\"]'))")
  await evaluate("document.querySelector('#assets-list [data-asset-path=\"portrait-aizen.jpg\"]').click()")
  await until("Boolean(document.querySelector('#assets-detail [data-asset-preview] img'))")
  assert.equal(await evaluate("document.querySelector('#assets-detail [data-asset-preview] img')?.src.startsWith('data:image/')"), true)
  assert.equal(await evaluate("document.querySelector('#assets-detail [data-asset-preview] img')?.naturalWidth > 0"), true)
  assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, 'asset layout must not overflow horizontally')
  screenshots.push(await screenshot('v2-asset-preview'))

  mark('dirty build block')
  await openSkill('studio-skill')
  await evaluate("document.querySelector('#skills-detail [data-editor-mode=fields]').click()")
  await until("Boolean(document.querySelector('#skills-detail [data-field-path=description]'))")
  await evaluate("(() => { const field = document.querySelector('#skills-detail [data-field-path=description]'); field.value = '主动能力组打包编辑'; field.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await until("document.querySelector('#skills-detail .dirty-state.dirty')?.textContent === '未保存'")
  // Keep a second collection draft dirty at the same time. Package generation
  // must account for every cached draft, including a document whose panel is
  // currently not active.
  await openDraftDocument('rules', 'studio-rule')
  await evaluate("document.querySelector('#rules-detail [data-editor-mode=fields]').click()")
  await until("Boolean(document.querySelector('#rules-detail [data-field-path=description]'))")
  await evaluate("(() => { const field = document.querySelector('#rules-detail [data-field-path=description]'); field.value = '规则存在另一个未保存草稿'; field.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await until("document.querySelector('#rules-detail .dirty-state.dirty')?.textContent === '未保存'")
  await evaluate("document.querySelector('[data-tab=build]').click()")
  await until("document.querySelector('[data-tab=build]')?.classList.contains('active') && document.querySelector('#tab-build')?.classList.contains('active')")
  await evaluate("document.querySelector('#technical-pipeline-tools > summary')?.click()")
  await until(visible('#build-btn'))
  await evaluate("document.querySelector('#build-output').value = 'archives/studio-workbench-v2-dirty.rvbpack'; document.querySelector('#build-btn').click()")
  await until("document.querySelector('#build-badge')?.textContent.includes('请先保存内容')")
  assert.equal(fs.existsSync(path.join(project, 'archives/studio-workbench-v2-dirty.rvbpack')), false)

  mark('saved package flow and archive verification')
  await evaluate("document.querySelector('#studio-save').click()")
  await until("document.querySelector('#skills-detail [data-footer-state]')?.textContent === '已保存' && document.querySelector('#rules-detail [data-footer-state]')?.textContent === '已保存'")
  await evaluate("document.querySelector('[data-package-stage=contents]').click()")
  await until("document.querySelector('#workspace-diff')?.textContent.includes('新增') || document.querySelector('#workspace-diff')?.textContent.includes('覆盖') || document.querySelector('#workspace-diff')?.textContent.includes('与内置内容一致')", 60000)
  await evaluate("document.querySelector('[data-package-next=settings]').click()")
  await until("document.querySelector('[data-package-stage=settings].active') && Boolean(document.querySelector('#build-btn'))")
  await evaluate("document.querySelector('[data-package-stage=generate]').click()")
  await until("document.querySelector('[data-package-stage=generate].active') && document.querySelector('#build-btn')?.offsetParent !== null")
  await evaluate("document.querySelector('#build-output').value = 'archives/studio-workbench-v2.rvbpack'; document.querySelector('#build-version').value = '0.2.252'; document.querySelector('#build-name').value = 'RED-252 Workbench v2'; document.querySelector('#build-package-id').value = 'rvb.studio-workbench-v2'; document.querySelector('#build-btn').click()")
  await until("document.querySelector('#build-badge')?.textContent.includes('成功')", 120000)
  await until("Boolean(document.querySelector('[data-package-stage=result].active'))", 30000)
  screenshots.push(await screenshot('v2-package-result'))
  const archive = path.join(project, 'archives', 'studio-workbench-v2.rvbpack')
  assert.equal(fs.existsSync(archive), true)
  const zip = new AdmZip(archive)
  archiveEntries = zip.getEntries().map(entry => entry.entryName).sort()
  for (const entry of [
    'data/pieces/studio-piece.json',
    'data/skills/studio-skill.json',
    'data/skills/studio-expression.json',
    'data/cards/studio-card.json',
    'data/rules/studio-rule.json',
    'data/rules/studio-rule-only.json',
    `data/rules/${createdPassiveRuleId}.json`,
    'images/portrait-aizen.jpg',
    'images/status-new.png',
  ]) assert.ok(archiveEntries.includes(entry), `missing archive entry ${entry}`)
  const packedPiece = JSON.parse(zip.readAsText('data/pieces/studio-piece.json'))
  const packedSkill = JSON.parse(zip.readAsText('data/skills/studio-skill.json'))
  const packedExpression = JSON.parse(zip.readAsText('data/skills/studio-expression.json'))
  const packedCard = JSON.parse(zip.readAsText('data/cards/studio-card.json'))
  const packedRule = JSON.parse(zip.readAsText('data/rules/studio-rule.json'))
  const packedCreatedPassive = JSON.parse(zip.readAsText(`data/rules/${createdPassiveRuleId}.json`))
  assert.equal(packedPiece.description, '棋子说明已编辑')
  assert.deepEqual(packedPiece.extension, piece.extension)
  assert.equal(packedSkill.description, '主动能力组打包编辑')
  assert.equal(packedSkill.statusTag.iconPath, 'images/status-new.png')
  assert.deepEqual(packedSkill.statusTag.extension, studioSkill.statusTag.extension)
  assert.deepEqual(packedSkill.extension, studioSkill.extension)
  assert.ok(packedExpression.gameplayModules.entries.code.graph.body.length > bodyBefore)
  assert.equal(packedExpression.gameplayModules.entries.code.graph.body.find(statement => statement.id === 'message-0').inputs.left.kind, 'output')
  assert.deepEqual(packedExpression.extension, expressionSkill.extension)
  assert.equal(packedExpression.description, '选择范围：6')
  assert.equal(packedCard.description, '卡牌说明已编辑')
  assert.deepEqual(packedCard.extension, { owner: 'card', future: { preserve: false } })
  assert.equal(packedRule.priority, 3)
  assert.deepEqual(packedRule.extension, rule.extension)
  assert.equal(packedCreatedPassive.cluster.id, `rules:${createdPassiveRuleId}`)
  assert.equal(packedCreatedPassive.priority, 7)
  assert.deepEqual(zip.readFile('images/portrait-aizen.jpg'), fs.readFileSync(path.join(project, 'images/portrait-aizen.jpg')))
  assert.deepEqual(zip.readFile('images/status-new.png'), fs.readFileSync(path.join(project, 'images/status-new.png')))
  archiveManifest = JSON.parse(zip.readAsText('manifest.json'))
  assert.equal(archiveManifest.kind, 'snapshot')
  assert.equal(archiveManifest.publisher.keyId, null)
  fs.copyFileSync(archive, path.join(evidence, 'studio-workbench-v2.rvbpack'))

  assert.deepEqual(runtimeConsoleErrors, [], `renderer console errors: ${JSON.stringify(runtimeConsoleErrors)}`)
  assert.deepEqual(runtimeExceptions, [], `renderer exceptions: ${JSON.stringify(runtimeExceptions)}`)
  assert.deepEqual(protocolLogErrors, [], `renderer protocol errors: ${JSON.stringify(protocolLogErrors)}`)
  outcome = {
    passed: true,
    executable,
    projectFixture: 'isolated temporary content project with all authoring collections',
    allRoutes: ['pieces', 'skills', 'cards', 'rules', 'assets', 'build'],
    noTopLevelStatus: true,
    ruleOnlyPassiveCluster: true,
    newPassiveRuleCreated,
    legacyPassiveSkillLabelVerified,
    activeClusterMembers: ['skill', 'rule', 'status', 'card'],
    controlStructureEdited,
    extensionEditedAndDeleted: true,
    crossDocumentSaveAllVerified,
    realPortraitPreview: true,
    nestedPureExpressionSavedAndReopened: true,
    expressionCopyVerified,
    standaloneExpressionCopyVerified,
    selectedExpressionViewport,
    clusterGroupMetadataVerified,
    textParameterBindingVerified,
    crossDocumentUnknownFieldsPreserved: true,
    dirtyBuildBlocked: true,
    packageGeneratedFromSavedContent: true,
    buildPublished: false,
    archive: path.join(evidence, 'studio-workbench-v2.rvbpack'),
    archiveEntries,
    archiveManifest: { kind: archiveManifest.kind, version: archiveManifest.version, capabilities: archiveManifest.capabilities },
    screenshots,
    runtimeConsoleErrors,
    runtimeConsoleNoise,
    runtimeExceptions,
    protocolLogErrors,
  }
  fs.writeFileSync(path.join(evidence, 'studio-workbench-v2-smoke.json'), JSON.stringify(outcome, null, 2) + '\n')
  console.log(JSON.stringify(outcome))
} catch (error) {
  const failure = {
    passed: false,
    error: error instanceof Error ? error.stack || error.message : String(error),
    project,
    screenshots,
    runtimeConsoleErrors,
    runtimeConsoleNoise,
    runtimeExceptions,
    protocolLogErrors,
    childStdout: childStdout.slice(-4000),
    childStderr: childStderr.slice(-4000),
  }
  try {
    if (socket) {
      failure.renderer = await evaluate(`({
        url: location.href,
        active: document.activeElement?.outerHTML?.slice(0, 800),
        route: document.body?.dataset?.shellRoute || '',
        status: document.querySelector('[role=status]')?.textContent || '',
        build: document.querySelector('#build-console')?.innerText?.slice(-1600) || '',
        body: document.body?.innerText?.slice(0, 2400) || '',
      })`)
      failure.failureScreenshot = await screenshot('v2-smoke-failure')
    }
  } catch (diagnosticError) {
    failure.diagnosticError = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
  }
  fs.writeFileSync(path.join(evidence, 'studio-workbench-v2-smoke.failure.json'), JSON.stringify(failure, null, 2) + '\n')
  throw error
} finally {
  if (socket) {
    try { await evaluate('window.close()') } catch { /* renderer may close before replying */ }
    socket.close()
  }
  child.kill()
  await delay(500)
  const resolved = path.resolve(temporary)
  if (resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('rvb-studio-workbench-v2-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch { /* leave an inspectable fixture if Windows holds a file */ }
  }
}
