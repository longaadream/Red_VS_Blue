import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

// Isolated real-Electron acceptance for the description expression entry.
// The editor is driven through CDP so this does not import or mock renderer UI.
const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))
const evidence = path.resolve(process.env.RVB_DESCRIPTION_EXPRESSION_EVIDENCE_DIR || path.join(root, 'output', 'completion-description-expression-smoke'))
fs.mkdirSync(evidence, { recursive: true })
const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-description-expression-'))
const userData = path.join(temporary, 'user-data')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const card = {
  id: 'description-expression-card',
  name: '描述插值验收牌',
  description: '原始说明：',
  extension: { 伤害量: 3 },
  keywords: [],
  targetText: '',
  effectTags: [],
  type: 'active',
  cardType: 'neutral',
  actionPointCost: 1,
  icon: '',
  image: '',
  isSample: false,
  trigger: null,
  targeting: null,
  code: 'function executeCard(context) { return { success: true } }',
}
fs.writeFileSync(path.join(project, 'data/cards/manifest.json'), JSON.stringify([card.id]) + '\n')
fs.writeFileSync(path.join(project, 'data/cards', `${card.id}.json`), JSON.stringify(card, null, 2) + '\n')
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

let child = null
let socket = null
let sequence = 0
let port = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const selector = value => JSON.stringify(value)

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  return port
}

async function connect() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()
      const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) {
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
        await call('Runtime.enable')
        return
      }
    } catch { /* bounded startup retry */ }
    await delay(250)
  }
  throw new Error('EDITOR_STARTUP_TIMEOUT')
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error(`CDP_TIMEOUT:${method}`)) }, 30000)
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
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
  return result.result?.value
}

async function until(expression, label = expression) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  throw new Error(`UI_TIMEOUT:${label}`)
}

async function click(target, label = target) {
  await until(`Boolean(document.querySelector(${selector(target)}))`, label)
  await evaluate(`document.querySelector(${selector(target)}).click()`)
  await delay(150)
}

async function typeIntoExpression(value) {
  await evaluate(`document.querySelector('.description-expression-panel .ei-editor')?.focus()`)
  await call('Input.insertText', { text: value })
  await delay(180)
}

async function main() {
  await reservePort()
  const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
  const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [...args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--editor-smoke-hidden'], { env, windowsHide: true, stdio: 'ignore' })
  await connect()
  await until(`Boolean(document.querySelector('#cards-list .entity-item'))`, '卡牌列表')
  await evaluate(`document.querySelector('[data-tab="cards"]').click(); [...document.querySelectorAll('#cards-list .entity-item')].find(node => node.querySelector('.id')?.textContent === ${selector(card.id)})?.click()`)
  await until(`Boolean(document.querySelector('#cards-detail [data-description-input]'))`, '描述字段')
  await click('#cards-detail [data-editor-mode="fields"]', '卡牌属性')
  await evaluate(`(() => { const field = document.querySelector('#cards-detail [data-description-input]'); field.focus(); field.setSelectionRange(field.value.length, field.value.length) })()`)
  await click('#cards-detail [data-description-expression-open]', '插入表达式')
  await until(`Boolean(document.querySelector('.description-expression-panel:not([hidden]) .ei-editor'))`, '表达式输入框')
  await typeIntoExpression('当前手牌.扩展变量.')
  try {
    await until(`([...document.querySelectorAll('.ei-suggestions.ei-open .ei-candidate')].some(node => node.textContent.includes('伤害量')))`, '扩展声明候选')
  } catch (error) {
    const diagnostic = await evaluate(`(() => ({ text:document.querySelector('.description-expression-panel .ei-editor')?.textContent || '', candidates:[...document.querySelectorAll('.ei-suggestions.ei-open .ei-candidate')].map(node => node.textContent), draft:JSON.parse(document.querySelector('#cards-detail [data-json-source]')?.value || '{}').extension, core:ContentGraphCore.completeAuthorExpression('当前手牌.扩展变量.', { surface:'card', extensions:[{ scope:'card', namespace:'content', name:'伤害量', type:'number' }] }) }))()`)
    throw new Error(`${error.message}; diagnostic=${JSON.stringify(diagnostic)}`)
  }
  await evaluate(`(() => { const editor = document.querySelector('.description-expression-panel .ei-editor'); editor.replaceChildren(); editor.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await typeIntoExpression('当前手牌.扩展变量.伤害量 * 1.5 + 最大值(2, 1)')
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-description-expression-status][data-valid="true"]'))`), true, '复杂表达式应通过语法检查')
  await click('#cards-detail [data-description-expression-apply]', '插入到描述')
  const expected = '原始说明：{当前手牌.扩展变量.伤害量 * 1.5 + 最大值(2, 1)}'
  assert.equal(await evaluate(`document.querySelector('#cards-detail [data-description-input]').value`), expected)
  await click('#cards-detail [data-save-json]', '保存内容')
  await until(`document.querySelector('#cards-detail [data-footer-state]')?.textContent === '已保存'`, '保存完成')
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'data/cards', `${card.id}.json`), 'utf8')).description, expected)
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(evidence, 'description-expression-editor.png'), Buffer.from(screenshot.data, 'base64'))
  await call('Page.reload')
  await until(`Boolean(document.querySelector('[data-tab="cards"]'))`, '重开卡牌页签')
  await until(`Boolean(document.querySelector('#cards-list .entity-item'))`, '重开卡牌列表')
  await evaluate(`document.querySelector('[data-tab="cards"]').click(); [...document.querySelectorAll('#cards-list .entity-item')].find(node => node.querySelector('.id')?.textContent === ${selector(card.id)})?.click()`)
  await until(`document.querySelector('#cards-detail [data-description-input]')?.value === ${selector(expected)}`, '重开后描述')
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({
    status: 'passed',
    savedDescription: expected,
    evidence: [path.join(evidence, 'description-expression-editor.png')],
    trainingNumericRefresh: '未执行：本 smoke 只验证编辑器描述入口与保存重开。',
  }, null, 2) + '\n')
}

try {
  await main()
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ status: 'failed', error: error instanceof Error ? error.stack : String(error) }, null, 2) + '\n')
  throw error
} finally {
  try { socket?.close() } catch { /* best effort */ }
  if (child) { child.kill(); await delay(300) }
}
