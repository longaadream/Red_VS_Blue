import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

// Focused production Electron coverage for RED-252's unified author rows.
// The fixture is built with the same lowering helpers used by the UI, then
// the real sentence editor moves rows through its visible controls.  This
// keeps the regression small while still checking the compiled runtime value.
const require = createRequire(import.meta.url)
const root = process.cwd()
const core = require(path.join(root, 'electron-editor/gameplay-module-core.cjs'))
const { createContentProject } = require(path.join(root, 'electron-editor/dist/content-project.js'))

const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rvb-author-statements-ui-'))
const userData = path.join(temporary, 'user')
fs.mkdirSync(userData)
const project = createContentProject(temporary, 'blank', root)
const skillId = 'author-statements-ui-regression'

const localHandle = { kind: 'output', node: 'declare-x', port: 'handle' }
const bindings = { x: { local: true, type: 'number', value: localHandle } }
function loweredAssignment(idPrefix, targetSource, valueSource) {
  const lowered = core.lowerAuthorAssignment(targetSource, valueSource, {
    surface: 'skill', bindings, prefix: idPrefix,
  })
  const generatedIds = lowered.statements.map(statement => statement.id).filter(Boolean)
  const final = lowered.statements.at(-1)
  final.layout = {
    ...(final.layout || {}),
    authorStatement: {
      kind: 'assignment', targetSource, valueSource, valueType: 'number',
      generatedIds, prefix: idPrefix, version: 1,
    },
  }
  return lowered.statements
}

const declaration = {
  kind: 'call', id: 'declare-x', module: 'local.declare', version: '2',
  inputs: { initial: { kind: 'literal', value: 0 } },
  parameters: { valueType: 'number', name: 'x' },
}
const assignmentA = loweredAssignment('A', 'x', 'x + 1')
const assignmentB = loweredAssignment('B', 'x', '1')
const ordinary = {
  kind: 'call', id: 'ordinary-y', module: 'local.declare', version: '2',
  inputs: { initial: { kind: 'literal', value: 0 } },
  parameters: { valueType: 'number', name: 'y' },
}
const read = core.lowerAuthorExpression('x', {
  surface: 'skill', bindings, prefix: 'R', expectedType: 'number',
})
const graph = {
  version: 'rvb-gameplay-modules/v1', surface: 'skill', inputs: [],
  outputs: [{ name: 'value', type: 'number' }], composites: [], continuations: [],
  body: [
    declaration, ...assignmentA, ...assignmentB, ordinary, ...read.statements,
    { kind: 'return', id: 'return-value', values: { value: read.value } },
  ],
}
const initialCompiled = core.compileGameplayModuleGraph(graph, core.GAMEPLAY_MODULE_REGISTRY)
fs.writeFileSync(path.join(project, 'data/skills/manifest.json'), JSON.stringify([skillId]) + '\n')
fs.writeFileSync(path.join(project, 'data/skills', skillId + '.json'), JSON.stringify({
  id: skillId,
  name: '统一作者语句移动回归',
  description: '验证作者语句分组移动和编译结果。',
  kind: 'active',
  type: 'normal',
  code: initialCompiled.code,
  gameplayModules: { version: 'rvb-gameplay-module-document/v1', entries: { code: { graph } } },
}, null, 2) + '\n')
fs.writeFileSync(path.join(userData, 'content-project-selection.json'), JSON.stringify({ root: project }) + '\n')

const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const executable = process.env.RVB_GRAPH_EDITOR_EXE || process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.RVB_GRAPH_EDITOR_EXE ? [] : [path.join(root, 'electron-editor/dist/main.js')]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, args.concat([
  '--user-data-dir=' + userData,
  '--remote-debugging-port=' + port,
  '--editor-smoke-hidden',
]), { env, windowsHide: true, stdio: 'ignore' })

let startupError
child.on('error', error => { startupError = error })
let socket
let sequence = 0
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++sequence
    const timer = setTimeout(() => {
      socket?.removeEventListener('message', onMessage)
      reject(new Error('CDP timeout: ' + method))
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

async function until(expression, label = expression) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (startupError) throw startupError
    try {
      if (await evaluate(expression)) return
    } catch { /* renderer is still mounting */ }
    await delay(100)
  }
  throw new Error('UI condition timed out: ' + label)
}

async function click(selector) {
  await evaluate('(()=>{const element=document.querySelector(' + JSON.stringify(selector) + ');if(!element)throw new Error(' + JSON.stringify('missing ' + selector) + ');element.click()})()')
  await delay(100)
}

function bodyFromDocument(value) {
  return value?.gameplayModules?.entries?.code?.graph?.body || []
}

function visibleRelevantRows(value) {
  const ids = new Set(['declare-x', 'A_write', 'B_write', 'ordinary-y', 'return-value'])
  return [...bodyFromDocument(value)].filter(statement => ids.has(statement.id)).map(statement => statement.id)
}

function assertGroupsContiguous(value) {
  const body = bodyFromDocument(value)
  for (const facade of body.filter(statement => statement?.layout?.authorStatement)) {
    const ids = new Set(facade.layout.authorStatement.generatedIds || [])
    const indexes = body.map((statement, index) => ids.has(statement?.id) ? index : -1).filter(index => index >= 0)
    if (!indexes.length) continue
    assert.equal(indexes.at(-1) - indexes[0] + 1, indexes.length, `${facade.id} generated group stays contiguous`)
  }
}

function runCompiled(value) {
  const compiled = core.compileGameplayModuleGraph(bodyDocumentGraph(value), core.GAMEPLAY_MODULE_REGISTRY)
  let nextHandle = 0
  const values = new Map()
  const flow = { execution: {
    declare: (_type, _path, initial) => {
      const handle = { id: ++nextHandle }
      values.set(handle.id, initial)
      return { handle }
    },
    read: handle => ({ value: values.get(handle.id), success: true }),
    write: (handle, _type, _path, next) => { values.set(handle.id, next); return { success: true } },
  } }
  const execute = Function('flow', `${compiled.code}; return executeSkill;`)(flow)
  return execute({}).value
}

function bodyDocumentGraph(value) {
  return value?.gameplayModules?.entries?.code?.graph || value
}

try {
  let target
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) })).json()
      target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch { /* Electron is still starting */ }
    await delay(100)
  }
  if (!target) throw new Error('Editor startup timed out')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  await until("document.body.classList.contains('studio-surface') && Boolean(document.querySelector('#skills-list .entity-item'))", 'editor startup')
  await evaluate(`(()=>{
    document.querySelector('[data-tab=skills]').click()
    const item=[...document.querySelectorAll('#skills-list .entity-item')].find(node=>node.dataset.entityId===${JSON.stringify(skillId)} || node.querySelector('.id')?.textContent===${JSON.stringify(skillId)})
    if(!item)throw new Error('missing author statement regression skill')
    item.click()
  })()`)
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-editor]'))", 'sentence editor')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-node=\\\"A_write\\\"]')) && Boolean(document.querySelector('#skills-detail [data-sentence-node=\\\"B_write\\\"]'))", 'author rows')

  // The palette has exactly one entry for each author write surface. Pure
  // reads/math/comparison remain expression values, while effect modules stay.
  await click('#skills-detail [data-sentence-add-effect]')
  await until("Boolean(document.querySelector('#skills-detail [data-sentence-popover=module]'))", 'unified palette')
  const palette = await evaluate(`(()=>{
    const options=[...document.querySelectorAll('#skills-detail [data-sentence-popover=module] [data-sentence-module]')]
    return { ids:options.map(node=>node.dataset.sentenceModule), labels:options.map(node=>node.textContent||'') }
  })()`)
  for (const id of ['local.declare', 'author.extension.declare', 'author.assignment']) {
    assert.equal(palette.ids.filter(candidate => candidate === id).length, 1, `${id} has one unified palette entry`)
  }
  for (const id of palette.ids) {
    assert.equal(/^extension\.(?:read|write|map-)/.test(id) || ['local.read', 'local.write'].includes(id) || /^(?:math|compare|logic)\./.test(id), false, `${id} is not an exposed read/write/math entry`)
  }
  assert.ok(palette.ids.includes('author.effect.damage') || palette.ids.includes('author.choice.target-piece'), 'side effects remain available')
  await click('#skills-detail [data-sentence-popover=module] .sentence-popover-close')

  const readDocument = () => evaluate("JSON.parse(document.querySelector('#skills-detail [data-json-source]').value)")
  const visibleRows = () => evaluate(`(()=>[...document.querySelectorAll('#skills-detail [data-sentence-node]')].map(node=>node.dataset.sentenceNode))()`)
  const rowAction = async (id, operation) => {
    await click(`#skills-detail [data-sentence-row-menu="${id}"] > summary`)
    await click(`#skills-detail [data-sentence-row-menu="${id}"] [data-sentence-row-action="${operation}"]`)
    await delay(120)
  }
  const relevant = rows => rows.filter(id => ['declare-x', 'A_write', 'B_write', 'ordinary-y'].includes(id))
  assert.deepEqual(relevant(await visibleRows()), ['declare-x', 'A_write', 'B_write', 'ordinary-y'])

  await rowAction('B_write', 'up')
  let edited = await readDocument()
  assert.deepEqual(visibleRelevantRows(edited), ['declare-x', 'B_write', 'A_write', 'ordinary-y', 'return-value'])
  assertGroupsContiguous(edited)
  assert.equal(runCompiled(edited), 2, 'B before A evaluates to 2')

  await rowAction('B_write', 'down')
  edited = await readDocument()
  assert.deepEqual(visibleRelevantRows(edited), ['declare-x', 'A_write', 'B_write', 'ordinary-y', 'return-value'])
  assertGroupsContiguous(edited)
  assert.equal(runCompiled(edited), 1, 'A before B evaluates to 1')

  // A normal local declaration crossing an author group must move around the
  // whole generated A group rather than splitting its internal read/add/write.
  await rowAction('ordinary-y', 'up')
  await rowAction('ordinary-y', 'up')
  edited = await readDocument()
  assert.deepEqual(visibleRelevantRows(edited), ['declare-x', 'ordinary-y', 'A_write', 'B_write', 'return-value'])
  assertGroupsContiguous(edited)
  assert.equal(runCompiled(edited), 1, 'moving an ordinary row keeps assignment semantics intact')

  const beforeReturnMove = await readDocument()
  await rowAction('return-value', 'up')
  const afterReturnMove = await readDocument()
  assert.deepEqual(visibleRelevantRows(afterReturnMove), visibleRelevantRows(beforeReturnMove), 'return stays at the end when its move action is clicked')

  console.log('author-statements-ui: passed')
} finally {
  socket?.close()
  if (child.exitCode === null) child.kill()
  try { fs.rmSync(temporary, { recursive: true, force: true }) } catch { /* retain fixture for crash debugging */ }
}
